import path from 'node:path';
import { z } from 'zod';
import { MODEL, canonical, digest, fail } from '../model.js';
import {snapshotFromRelease} from '../core.js';
import { HostIssuer, accountStoreV2Schema, policyStoreV2Schema } from '../auth/host-issuer.js';
import { ActorAccess } from '../auth/access.js';
import { providerWriteContractSchema } from '../artifacts-node.js';
import type { FetchTransport } from '../artifacts-git.js';
import { startLocalBroker } from '../local-broker.js';
import { WORKFLOW_READS } from '../workflow.js';
import { STATE_DESCRIPTOR, NODE_STATE_FORMAT } from '../node-state.js';
import { BootstrapState } from './bootstrap-state.js';
import { OwnerAccess } from './owner-access.js';
import { FileWorkspaceBudget } from './workspace-budget.js';
import { FileWorkspaceState } from './workspace-state.js';
import { writerImportSchema, validateWriterImport, assertFreshWorkspacePrincipal } from './workspace-import.js';
import { canonicalDisjointPaths, readRootWorkspaceFile, repositoryGrantSchema, WORKSPACE_WRITES, lifetimeActive, assertGrantActive } from './workspace-policy.js';
import { WorkspaceRuntime } from './workspace-runtime.js';
import { StudioCommands } from './commands.js';
import { ExplorerConnections } from './connections.js';
import { ExplorerReader } from './read.js';
import { startExplorer } from './host.js';
import { privateDir, readPrivate } from './owner-files.js';
import type { HostedOptions } from './hosted.js';
import { registryPayloadDigest } from './workspace-broker.js';
const absolute=z.string().max(4096).refine(p=>path.isAbsolute(p)&&path.resolve(p)===p);
export const workspaceConfigSchema=z.object({grant_file:absolute,actor_accounts_file:absolute,actor_policy_file:absolute,
  provider_identity_file:absolute.optional(),import_file:absolute,broker_state_directory:absolute,
  budget_directory:absolute,control_directory:absolute}).strict();
export type WorkspaceConfig=z.infer<typeof workspaceConfigSchema>;
export async function runWorkspaceStudio(state:BootstrapState,configuration:WorkspaceConfig,options:HostedOptions,
  port:number,assets:string,transport?:FetchTransport){
  const config=workspaceConfigSchema.parse(configuration);
  canonicalDisjointPaths([...Object.values(config),...Object.values(state.config)]);
  const grant=repositoryGrantSchema.parse(await readRootWorkspaceFile(config.grant_file));
  const imported=writerImportSchema.parse(await readRootWorkspaceFile(config.import_file,8*1024**2));
  const validated=validateWriterImport(imported,grant),accountStore=accountStoreV2Schema.parse(await readRootWorkspaceFile(config.actor_accounts_file)),
    policy=policyStoreV2Schema.parse(await readRootWorkspaceFile(config.actor_policy_file));
  const ownerRecord=await state.owner(true,false);
  if(!ownerRecord||ownerRecord.owner_id!==grant.owner_id||ownerRecord.manifest.installation_id!==grant.installation_id)
    fail('WORKSPACE_NOT_CONFIGURED',4,'The sealed installation owner does not match this workspace.');
  if(digest({accounts:accountStore,policy})!==grant.actor_binding_sha256||policy.project_id!==grant.project_id||
    accountStore.accounts.length!==1||policy.grants.length!==1)
    fail('WORKSPACE_NOT_CONFIGURED',4,'The exact single-actor policy binding is missing.');
  const account=accountStore.accounts[0],actorGrant=policy.grants[0];
  assertFreshWorkspacePrincipal(validated.records,account.principal_id);
  const reads=[...WORKFLOW_READS,'inspect','status','diff','conflicts','context.show'];
  if(!account.active||account.principal_kind!=='person'||account.credential.method!=='installation-owner'||
      account.credential.owner_id!==grant.owner_id||account.credential.installation_id!==grant.installation_id||
      actorGrant.principal_id!==account.principal_id||actorGrant.approvals.length||actorGrant.create_under_block_ids.length||actorGrant.profiles.length||
      actorGrant.operations.some(o=>![...reads,...WORKSPACE_WRITES].includes(o as any))||
      canonical(actorGrant.lifetime)!==canonical(grant.lifetime))
    fail('WORKSPACE_NOT_CONFIGURED',4,'Workspace actor authority must be explicit and limited to compatible draft authoring.');
  for(const block of actorGrant.write_block_ids)if(!Object.values(validated.records).some(r=>r.type==='release'&&Object.hasOwn(snapshotFromRelease(r.data).blocks,block)))
    fail('WORKSPACE_NOT_CONFIGURED',4,'A writable Block is absent from the complete imported project.');
  for(const directory of [config.broker_state_directory,config.budget_directory,config.control_directory])await privateDir(directory);
  const descriptor=await readPrivate(path.join(config.broker_state_directory,STATE_DESCRIPTOR),4096);
  if(canonical(descriptor)!==canonical({format:NODE_STATE_FORMAT,model_version:MODEL,project_id:grant.project_id}))
    fail('WRITER_IMPORT_REQUIRED',4,'The preprovisioned broker state descriptor differs.');
  const budget=new FileWorkspaceBudget(path.join(config.budget_directory,'budget.json'),grant,imported.origin),
    control=new FileWorkspaceState(path.join(config.control_directory,'workspace.json'),grant,digest(imported.origin));
  const proof=config.provider_identity_file?providerWriteContractSchema.parse(await readRootWorkspaceFile(config.provider_identity_file)):undefined;
  const credentialStore=state.store(ownerRecord.manifest);
  let owner:OwnerAccess;
  const issuer=new HostIssuer(accountStore,policy,Date.now,async input=>owner.actorAuthentication(input as import('node:http').IncomingMessage));
  const runtime=new WorkspaceRuntime(grant,imported,issuer,budget,control,config.broker_state_directory,
    ()=>credentialStore.encryptedGeneration(),()=>credentialStore.withCredential(async value=>{if(!value)fail('WRITE_PERMISSION_UNVERIFIED',4,'The saved provider credential is unavailable.');return value;}),proof,transport);
  await runtime.ready();
  const sessions=new Map<string,{commands:StudioCommands;connections:ExplorerConnections}>();
  const readEpochs=new Map<string,number>();
  let access:ActorAccess;
  owner=new OwnerAccess(state,options,Date.now,{metadataOnly:true,workspaceMode:true,invalidated:()=>{control.changed();for(const s of sessions.values())s.commands.close();sessions.clear();},
    workspaceConnections:async(req,input,operation)=>{
      const authority=owner.sourceAuthority(req),identity=await authority.current(false);
      if(identity.owner_id!==grant.owner_id||identity.installation_id!==grant.installation_id)fail('OWNER_FORBIDDEN',4,'Workspace belongs to another installation owner.');
      if(operation)fail('UNSUPPORTED_CAPABILITY',8,'Use the exact workspace control receipt in current Settings.');
      if(req.method==='POST'){
        if(input&&typeof input==='object'&&'action'in input&&['test-read','test-write'].includes(String(input.action)))await runtime.test(input,()=>owner.actorAuthentication(req));
        else await control.action(input,async fresh=>{await authority.current(fresh);});
      }
      const s=await control.snapshot(),usage=await budget.snapshot();
      let credentialConfigured=false;try{credentialConfigured=(await credentialStore.status()).credentials[0].configured;}catch{}
      const credentialGeneration=await credentialStore.encryptedGeneration(),lastTest=s.tests.at(-1)??null,
        writeVerified=s.tests.some(t=>t.kind==='test-write'&&t.write_token_verified&&!t.error&&t.credential_generation===credentialGeneration),
        pending=s.operations.find(o=>!['committed','cancelled_before_effect'].includes(o.phase)),actorState=access.metadata(req),
        grantActive=!s.revoked&&lifetimeActive(grant.lifetime,Date.now())&&Date.parse(grant.not_before)<=Date.now();
      return {format:'strata-studio-owner-connections/2',mode:'workspace',revision:s.revision,connection_id:grant.grant_id,
        project:grant.project_id,repository_id:grant.storage.expected_repository_id,model_version:MODEL,
        desired_connected:s.desired_connected,runtime_ready:grantActive&&s.desired_connected&&actorState.authenticated,
        actor_state:actorState,grant:{id:grant.grant_id,lifetime:grant.lifetime,state:s.revoked?'revoked':grantActive?'active':'expired'},usage,
        capabilities:{operations:[...WORKSPACE_WRITES],authenticated_release:false,hosted_git:false,provider_identity_verified:runtime.adapter.providerIdentityVerified(),
          provider_write_contract_accepted:runtime.adapter.providerWriteContractAccepted(),provider_write_contract:runtime.adapter.providerWriteContract(),
          write_token_verified:writeVerified,write_ready:grantActive&&s.desired_connected&&credentialConfigured&&actorState.authenticated&&writeVerified&&runtime.adapter.providerWriteContractAccepted()&&!pending&&usage.remaining.requests>0&&usage.remaining.bytes>0},
        last_test:lastTest,pending_operation:pending?.operation_id??null};
    }});
  access=new ActorAccess(issuer,options);
  const broker=await startLocalBroker(config.broker_state_directory,0,{issuer,model_version:MODEL,artifacts:runtime.store,workspace:runtime.brokerControls(),max_pending:4});
  const session=(req:import('node:http').IncomingMessage)=>{
    access.require(req);const token=access.token(req);issuer.resolve(token);
    for(const [key,s]of sessions)try{issuer.resolve(key);}catch{s.commands.close();sessions.delete(key);}
    let current=sessions.get(token);if(!current){
      const commands=new StudioCommands({project_id:grant.project_id,model_version:MODEL,broker:broker.url,
        artifact_adapter:'cloudflare-artifacts-remote'},token,config.broker_state_directory,[...WORKSPACE_WRITES],{},
        'legacy-history-authenticated-authoring',()=>{assertGrantActive(grant,Date.now());const epoch=readEpochs.get(token);if(epoch===undefined)fail('CONNECTION_NOT_READY',4,'Current workspace read authorization is required.');control.assertEpoch(epoch);const c=issuer.resolve(token);issuer.authorize(c,'studio.snapshot',{});return c.policy_version+'/'+epoch;},
        requestOptions=>async(command,input)=>{
          await issuer.refreshSession(token);
          const response=await fetch(new URL('/v1/operation',broker.url),{method:'POST',headers:{'content-type':'application/json',
            'x-strata-session':token,'x-strata-project':grant.project_id,'x-strata-artifact-adapter':'cloudflare-artifacts-remote',
            ...(requestOptions.expected_generation?{'x-strata-expected-generation':requestOptions.expected_generation}:{}),
            ...(requestOptions.expected_policy?{'x-strata-expected-policy':requestOptions.expected_policy}:{})},
            body:JSON.stringify({command,input,options:{dry_run:requestOptions.dry_run,idempotency_key:requestOptions.idempotency_key}}),signal:AbortSignal.timeout(60_000),redirect:'error'});
          const result=await response.json() as any;if(!result.ok)fail(result.error.code,result.error.exit,result.error.message,result.error.details);
          if(command==='capabilities'){const state=await control.snapshot(),generation=await credentialStore.encryptedGeneration(),qualified=runtime.adapter.providerWriteContractAccepted()&&!state.operations.some(o=>!['committed','cancelled_before_effect'].includes(o.phase))&&state.tests.some(t=>t.kind==='test-write'&&t.write_token_verified&&!t.error&&t.credential_generation===generation);
            result.data.trust='legacy-history-authenticated-authoring';
            if(!qualified)result.data.operations=result.data.operations.map((o:any)=>WORKSPACE_WRITES.includes(o.operation)?{...o,supported:false,reason:'Write-token qualification or reconciliation is required.'}:o);}
          return result;
        });
      current={commands,connections:new ExplorerConnections([{reader:commands.reader,provider:'local-broker',authenticationAvailable:()=>{try{issuer.resolve(token);return true;}catch{return false;}}}])};sessions.set(token,current);
    }return current;
  };
  const shell=new ExplorerReader({connection:{connection_id:'workspace',project_id:grant.project_id,display_name:'Strata workspace',model_version:MODEL},
    assertAuthorized(){},async load(){fail('AUTHENTICATION_REQUIRED',4,'Use the separately approved named author session.');}});
  const current=async(req:import('node:http').IncomingMessage)=>{access.require(req);const token=access.token(req),epoch=control.generation();
    await issuer.refreshSession(token);await control.assertCurrent();await budget.ready();control.assertEpoch(epoch);assertGrantActive(grant,Date.now());issuer.resolve(token);readEpochs.set(token,epoch);};
  let host;try{host=await startExplorer(shell,{port,assets,workspace:{owner,current,actor:{access,commands:req=>session(req).commands,connections:req=>session(req).connections}}});}
  catch(e){await broker.close();throw e;}
  return {...host,issuer,runtime,close:async()=>{for(const s of sessions.values())s.commands.close();access.clear();owner.clear();await host.close();await broker.close();}};
}
