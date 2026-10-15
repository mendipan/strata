import path from 'node:path';
import { z } from 'zod';
import { canonical, digest, fail, type Records } from '../model.js';
import { MUTATIONS } from '../service.js';
import { ArtifactRegistryStore } from '../artifact-registry.js';
import { HostIssuer, type OwnerAuthentication } from '../auth/host-issuer.js';
import { NodeArtifactsAdapter, type NodeArtifactOperation, type ProviderWriteContract } from '../artifacts-node.js';
import type { FetchTransport } from '../artifacts-git.js';
import type { SecurityContext } from '../security.js';
import { FileWorkspaceBudget } from './workspace-budget.js';
import { FileWorkspaceState } from './workspace-state.js';
import { CachedWorkspaceArtifacts, writerRegistrySchema, validateWriterImport, type WriterImport } from './workspace-import.js';
import { registryPayloadDigest, type WorkspaceBrokerControls } from './workspace-broker.js';
import { readPrivate, privateDir, writePrivate, optionalPrivate } from './owner-files.js';
import { recoverablePermissionChecks } from './workspace-permission-recovery.js';
import type { NamespaceProvider } from './namespace-provider.js';
import { syncDirectory } from './owner-files.js';
import { assertGrantActive, repositoryGrantDigest, workspaceHash, type RepositoryGrant } from './workspace-policy.js';
import { validateRecords } from './validate.js';
import { buildRecordType } from '../build-records.js';
import { attemptRecordType } from '../build-attempt-records.js';
const commitSchema=z.object({format:z.literal('strata-studio-write-commit/1'),operation_id:workspaceHash,
  account_id:z.string(),principal_id:z.string(),credential_epoch:z.number().int().positive(),authentication_sha256:workspaceHash,
  project_id:z.string(),model_version:z.string(),grant_sha256:workspaceHash,policy_generation:z.string(),
  control_revision:z.number().int().min(0),credential_generation:workspaceHash,input_sha256:workspaceHash,
  before_registry_payload_sha256:workspaceHash,after_registry_payload_sha256:workspaceHash,result_sha256:workspaceHash,
  created_refs:z.array(z.string().max(256)).max(10000),published_refs:z.array(z.string().max(256)).max(10000),
  artifact_stage_sha256:workspaceHash.nullable(),io_receipt:z.object({binding_sha256:workspaceHash,origin_sha256:workspaceHash,
    generation:z.number().int().min(0),reservation_ids:z.array(z.string().uuid()).max(100),reserved_requests:z.number().int().min(0).max(100),
    reserved_bytes:z.number().int().min(0),reservations_sha256:workspaceHash}).strict(),
}).strict();
export class WorkspaceRuntime {
  readonly store:ArtifactRegistryStore;
  readonly adapter:NodeArtifactsAdapter;
  private active:NodeArtifactOperation|undefined;
  private admission=false;
  private readonly initialDigest:string;
  private runtimeUncertain=false;
  constructor(readonly grant:RepositoryGrant,readonly imported:WriterImport,readonly issuer:HostIssuer,
    readonly budget:Pick<FileWorkspaceBudget,'ready'|'snapshot'|'reserve'|'operationReceipt'>,readonly state:FileWorkspaceState,readonly directory:string,
    private credentialGeneration:()=>Promise<string>,private credential:()=>Promise<string>,
    proof?:ProviderWriteContract,transport?:FetchTransport,private now=Date.now){
    const validated=validateWriterImport(imported,grant);
    this.initialDigest=validated.initial_registry_payload_sha256;
    this.supportingScope(validated.records);
    this.adapter=new NodeArtifactsAdapter(grant,()=>{if(!this.active)fail('WORKSPACE_NOT_CONFIGURED',4,'No authorized workspace operation is admitted.');return this.active;},proof,transport,now);
    this.store=new ArtifactRegistryStore(new CachedWorkspaceArtifacts(path.join(directory,'verified-artifacts'),this.adapter),grant.project_id);
  }
  private supportingScope(records:Records){
    for(const r of Object.values(records))if(buildRecordType(r.type)||attemptRecordType(r.type)){
      if(r.data.project_id!==this.grant.project_id||r.data.repository_id!==this.grant.storage.expected_repository_id)
        fail('BUILD_REPOSITORY_MISMATCH',4,'Namespace supporting history must belong to the exact admitted repository.');
    }
  }
  async validateIndex(value:unknown){
    const registry=writerRegistrySchema.parse(value);this.store.assertBinding(registry);
    for(const [ref,entry]of Object.entries(this.imported.registry.entries)){
      const current=registry.entries[ref];
      if(!current||current.hash!==entry.hash||current.type!==entry.type||entry.published&&!current.published||
          canonical(current.locator)!==canonical(entry.locator))fail('WRITER_IMPORT_REQUIRED',4,'Imported immutable history differs from its sealed lineage.');
    }
    const commits=Object.entries(registry.workspace_commits??{}).map(([id,v])=>{const c=commitSchema.parse(v);
      if(id!==c.operation_id||c.grant_sha256!==repositoryGrantDigest(this.grant)||c.project_id!==this.grant.project_id||c.model_version!==this.grant.model_version)
        fail('WRITE_RECONCILIATION_REQUIRED',9,'Writer receipt binding differs.');return c;});
    const after=registryPayloadDigest(registry);
    let cursor=this.initialDigest;const retained=new Set(commits);
    while(retained.size){const next=[...retained].filter(c=>c.before_registry_payload_sha256===cursor);if(next.length!==1)fail('WRITE_RECONCILIATION_REQUIRED',9,'Writer receipt lineage is incomplete or ambiguous.');cursor=next[0].after_registry_payload_sha256;retained.delete(next[0]);}
    if(cursor!==after)fail('WRITE_RECONCILIATION_REQUIRED',9,'Canonical index does not match its retained commit lineage.');
    const loaded=await this.store.load(registry);validateRecords(loaded.records,this.grant.project_id,this.grant.model_version);
    this.supportingScope(loaded.records);
    return {registry,...loaded};
  }
  async ready(){await this.budget.ready();await this.state.ready();await this.validateIndex(await readPrivate(path.join(this.directory,'registry.json'),16*1024**2));}
  async recoverPermissionCheck(authorize:()=>Promise<OwnerAuthentication>,verify:()=>ReturnType<NamespaceProvider['noLiveTokens']>){
    if(this.admission)fail('WORKSPACE_BUSY',9,'Wait for the current repository operation.');this.admission=true;
    try{
      const parent=await authorize();parent.assertLive();await parent.refresh();
      if(parent.owner_id!==this.grant.owner_id||parent.installation_id!==this.grant.installation_id)fail('OWNER_FORBIDDEN',4,'This repository belongs to another owner.');
      const state=await this.state.assertCurrent(),checks=recoverablePermissionChecks(state,this.grant);
      if(!checks)fail('WRITE_RECONCILIATION_REQUIRED',9,'A saved draft operation needs separate recovery. Its data and history have been preserved.');
      if(!checks.length)return {recovered:0};
      const filename=path.join(this.directory,'registry.json'),index=await readPrivate(filename,16*1024**2);await this.validateIndex(index);
      const epoch=this.state.generation(),proof=await verify();
      if(proof.repository_id!==this.grant.storage.expected_repository_id||!Number.isFinite(Date.parse(proof.verified_at))||Math.abs(this.now()-Date.parse(proof.verified_at))>30000)
        fail('WRITE_RECONCILIATION_REQUIRED',9,'Refresh repository recovery status before trying again.');
      await parent.refresh();parent.assertLive();this.state.assertEpoch(epoch);
      if(canonical(await readPrivate(filename,16*1024**2))!==canonical(index)||canonical(await this.state.snapshot())!==canonical(state))fail('STALE_GENERATION',5,'Repository state changed during recovery. Try again.');
      const directory=path.join(this.directory,'permission-recovery');await privateDir(directory,true);
      for(const check of checks){
        const evidence={format:'strata-studio-permission-recovery/1',operation_id:check.operation_id,grant_sha256:repositoryGrantDigest(this.grant),before_operation_sha256:digest(check),registry_sha256:digest(index),proof};
        const hash=digest(evidence),file=path.join(directory,hash+'.json');
        if(await optionalPrivate(file)===undefined)await writePrivate(file,evidence,true);
        await parent.refresh();parent.assertLive();this.state.assertEpoch(epoch);
        await this.state.journal(check.operation_id).record('cancelled_before_effect',{reason:'permission-test-inactive-tokens-confirmed',cleanup:'confirmed',recovery_evidence_sha256:hash});
      }
      this.state.changed();return {recovered:checks.length};
    }finally{this.admission=false;}
  }
  // Explicit operator reconciliation, never invoked at startup or by replay.
  // The canonical index is the sole authority; the journal cannot publish it.
  async reconcileCommitted(operationId:string,authorize:()=>Promise<OwnerAuthentication>){
    workspaceHash.parse(operationId);if(this.admission)fail('WORKSPACE_BUSY',9,'Wait for the current bounded operation.');this.admission=true;
    try{
      const parent=await authorize();parent.assertLive();if(parent.owner_id!==this.grant.owner_id||parent.installation_id!==this.grant.installation_id)fail('OWNER_FORBIDDEN',4,'Workspace belongs to another owner.');
      const index=await readPrivate(path.join(this.directory,'registry.json'),16*1024**2),validated=await this.validateIndex(index),receipt=validated.registry.workspace_commits?.[operationId];
      if(!receipt)fail('WRITE_RECONCILIATION_REQUIRED',9,'No canonical committed receipt proves this operation.');
      const parsed=commitSchema.parse(receipt),state=await this.state.snapshot(),journal=state.operations.find(o=>o.operation_id===operationId);
      if(!journal||!journal.events.some(e=>e.phase==='publication_prepared'&&e.detail.after_registry_sha256===parsed.after_registry_payload_sha256))fail('WRITE_RECONCILIATION_REQUIRED',9,'Retained publication intent differs.');
      await parent.refresh();parent.assertLive();
      if(canonical(await readPrivate(path.join(this.directory,'registry.json'),16*1024**2))!==canonical(index))fail('STALE_GENERATION',5,'Canonical writer state changed.');
      await syncDirectory(this.directory);await this.state.journal(operationId).record('committed',{after_registry_sha256:parsed.after_registry_payload_sha256});
      this.runtimeUncertain=false;this.state.changed();return {operation_id:operationId,state:'committed',provider_requests:0};
    }finally{this.admission=false;}
  }
  async test(input:unknown,authorize:()=>Promise<OwnerAuthentication>){
    const value=z.object({request_id:z.string().uuid(),action:z.enum(['test-read','test-write']),revision:z.number().int().min(0)}).strict().parse(input);
    if(this.admission)fail('WORKSPACE_BUSY',9,'Wait for the current bounded workspace operation.');
    this.admission=true;
    let operation:NodeArtifactOperation|undefined;
    try{
      const parent=await authorize();parent.assertLive();
      if(parent.owner_id!==this.grant.owner_id||parent.installation_id!==this.grant.installation_id)fail('OWNER_FORBIDDEN',4,'Workspace belongs to another installation owner.');
      const action=await this.state.action(value,async()=>{await parent.refresh();parent.assertLive();});
      if(action.replayed)return {replayed:true};
      const epoch=this.state.generation(),state=await this.state.assertCurrent(undefined,true),generation=await this.credentialGeneration();
      const operationId=digest({domain:'strata-studio-permission-test/1',grant:repositoryGrantDigest(this.grant),request_id:value.request_id});
      const signal=AbortSignal.timeout(30_000);
      const assertSync=()=>{this.state.assertEpoch(epoch);parent.assertLive();assertGrantActive(this.grant,this.now());if(signal.aborted)fail('ACCESS_REVOKED',4,'Permission test expired.');};
      const refresh=async()=>{assertSync();await parent.refresh();assertSync();const s=await this.state.assertCurrent(operationId,true);assertSync();
        if(s.revision!==state.revision||await this.credentialGeneration()!==generation)fail('ACCESS_REVOKED',4,'Workspace or saved credential changed.');assertSync();};
      const journal=this.state.journal(operationId);
      operation={lease:{operation_id:operationId,signal,assertSync,refresh},budget:this.budget,journal,credential:async()=>{assertSync();const result=await this.credential();await refresh();return result;}};
      await refresh();this.active=operation;
      try{
        const result=value.action==='test-write'?await this.adapter.testWriteAccess():await this.adapter.testReadAccess();
        await refresh();await this.state.recordTest({request_id:value.request_id,kind:value.action,credential_generation:generation,completed_at:new Date(this.now()).toISOString(),...result,error:null});
        await journal.record('cancelled_before_effect',{reason:'permission-test-no-payload-mutation'});
        return {replayed:false};
      }catch(e:any){
        await this.state.recordTest({request_id:value.request_id,kind:value.action,credential_generation:generation,completed_at:new Date(this.now()).toISOString(),repository_verified:false,write_token_verified:false,error:/^[A-Z0-9_]{1,128}$/.test(e.code??'')?e.code:'WORKSPACE_PROVIDER_UNAVAILABLE'});
        const s=await this.state.snapshot(),op=s.operations.find(o=>o.operation_id===operationId);
        if(!op||['prepared','reserved'].includes(op.phase))await journal.record('cancelled_before_effect',{reason:'permission-test-no-provider-mutation'});
        throw e;
      }
    }finally{if(this.active===operation)this.active=undefined;this.admission=false;}
  }
  brokerControls():WorkspaceBrokerControls{return {status:async(context,key)=>{
    await this.issuer.refreshContext(context);this.issuer.authorize(context,'operation.inspect',{key});
    const s=await this.state.assertCurrent(),binding=digest(`${context.tenant_id}:${context.project_id}:${context.principal_id}:${key}`),
      op=s.operations.find(o=>o.events.some(e=>e.detail.request_key_sha256===binding));
    return {key,state:op?op.phase==='cancelled_before_effect'?'not_committed':'reconciliation_required':'not_found',operation_id:op?.operation_id??null,phase:op?.phase??null,result:null};
  },begin:async(context,command,input,key,operationId,value,interrupted,dryRun)=>{
    if(this.admission)fail('WORKSPACE_BUSY',9,'Workspace operations must use the single bounded broker queue.');
    this.admission=true;try{
    // A dry run executes with current authority but cannot stage or publish a
    // mutation. It neither qualifies a writer nor creates a durable intent.
    const registry=writerRegistrySchema.parse(value),mutation=MUTATIONS.has(command)&&!dryRun;
    if(mutation&&(!key||typeof key!=='string'||key.length>100))fail('IDEMPOTENCY_REQUIRED',4,'Hosted mutations require a retained request key.');
    await this.issuer.refreshContext(context);this.issuer.authorize(context,command,input);
    const epoch=this.state.generation(),state=await this.state.assertCurrent(undefined,false);
    const cachedKey=key?`${context.tenant_id}:${context.project_id}:${context.principal_id}:${key}`:undefined;
    const cached=!!(cachedKey&&registry.requests[cachedKey]);
    const prior=mutation&&cachedKey?state.operations.find(o=>o.events.some(e=>e.detail.request_key_sha256===digest(cachedKey))):undefined;
    if(prior&&prior.events.find(e=>e.detail.input_sha256)?.detail.input_sha256!==digest({command,input}))
      fail('IDEMPOTENCY_CONFLICT',5,'The retained request key binds different input.');
    if(mutation&&!cached){
      if(this.runtimeUncertain||state.operations.some(o=>!['committed','cancelled_before_effect'].includes(o.phase)))
        fail('WRITE_RECONCILIATION_REQUIRED',9,'An earlier operation needs explicit reconciliation before another mutation.');
    }
    const credentialGeneration=await this.credentialGeneration(),before=registryPayloadDigest(registry);
    if(mutation&&!cached&&!state.tests.some(t=>t.kind==='test-write'&&t.error===null&&t.write_token_verified&&t.credential_generation===credentialGeneration))
      fail('WRITE_PERMISSION_UNVERIFIED',4,'Explicitly test write-token issue and owned cleanup for the current saved credential.');
    const signal=AbortSignal.any([interrupted,AbortSignal.timeout(60_000)]);let closed=false;
    const assertSync=()=>{if(closed||signal.aborted)fail('ACCESS_REVOKED',4,'The bounded operation is no longer admitted.');
      this.state.assertEpoch(epoch);assertGrantActive(this.grant,this.now());this.issuer.assertLive(context);};
    const refresh=async()=>{
      assertSync();await this.issuer.refreshContext(context);assertSync();
      const current=await this.state.assertCurrent(undefined,false);assertSync();
      if(current.revision!==state.revision||current.revoked)fail('ACCESS_REVOKED',4,'Workspace control changed.');
      if(await this.credentialGeneration()!==credentialGeneration)fail('ACCESS_REVOKED',4,'The encrypted credential generation changed.');assertSync();
      const index=await readPrivate(path.join(this.directory,'registry.json'),16*1024**2);assertSync();
      if(registryPayloadDigest(index)!==before)fail('STALE_GENERATION',5,'The canonical writer index changed.');
    };
    const journal=this.state.journal(operationId),operation:NodeArtifactOperation={lease:{operation_id:operationId,signal,refresh,assertSync},budget:this.budget,journal,
      credential:async()=>{assertSync();const value=await this.credential();await refresh();return value;}};
    await refresh();this.active=operation;
    if(mutation&&!cached)try{await journal.record('prepared',{command,input_sha256:digest({command,input}),authority_sha256:digest(context),request_key_sha256:digest(cachedKey!)});await refresh();}
      catch(e){this.active=undefined;throw e;}
    return {verifyPreparedRecords:records=>{assertSync();validateRecords(records,this.grant.project_id,this.grant.model_version);this.supportingScope(records);},load:async()=>{await refresh();const loaded=await this.validateIndex(registry);await refresh();return loaded;},refresh,assertSync,
      provenance:async(old,next,result)=>{
        await refresh();const journalState=await this.state.snapshot(),staged=journalState.operations.find(o=>o.operation_id===operationId)?.events.filter(e=>e.phase==='stage_verified'&&e.detail.cleanup==='confirmed').at(-1),io=await this.budget.operationReceipt(operationId);
        await refresh();const receipt=commitSchema.parse({format:'strata-studio-write-commit/1',operation_id:operationId,
          account_id:context.account_id,principal_id:context.principal_id,credential_epoch:context.credential_epoch,
          authentication_sha256:context.authentication_id,project_id:this.grant.project_id,model_version:this.grant.model_version,
          grant_sha256:repositoryGrantDigest(this.grant),policy_generation:context.policy_version,control_revision:state.revision,
          credential_generation:credentialGeneration,input_sha256:digest({command,input}),before_registry_payload_sha256:before,
          after_registry_payload_sha256:registryPayloadDigest(next),result_sha256:digest(result),
          created_refs:(result as any).created??[],published_refs:Object.entries((next as any).entries).filter(([ref,e])=>(e as any).published&&!(old as any).entries[ref]?.published).map(([ref])=>ref),
          artifact_stage_sha256:staged?digest(staged.detail):null,io_receipt:io});
        await journal.record('publication_prepared',{before_registry_sha256:receipt.before_registry_payload_sha256,after_registry_sha256:receipt.after_registry_payload_sha256});return receipt;
      },
      committed:async(next,result)=>{await journal.record('committed',{after_registry_sha256:registryPayloadDigest(next)});},
      failed:async(renamed,error)=>{
        if(cached||!mutation)return;
        const current=await this.state.snapshot(),old=current.operations.find(o=>o.operation_id===operationId);
        if(renamed){this.runtimeUncertain=true;this.state.changed();await journal.record('reconciliation_required',{reason:'renamed-durability-uncertain'});}
        else if(!old||['prepared','reserved'].includes(old.phase))await journal.record('cancelled_before_effect',{reason:'no-mutation-dispatch-admitted'});
      },
      close:()=>{closed=true;if(this.active===operation)this.active=undefined;this.admission=false;},
    };
    }catch(e){this.admission=false;throw e;}
  }};}
}
