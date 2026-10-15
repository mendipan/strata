import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { MODEL, BLOCK_MODEL, canonical, digest, fail, blockSnapshotSchema } from '../model.js';
import { snapshotFromRelease } from '../core.js';
import { HostIssuer, accountStoreV2Schema, policyStoreV2Schema, policyStoreV4Schema, type OwnerAuthentication } from '../auth/host-issuer.js';
import { ActorAccess } from '../auth/access.js';
import { startLocalBroker } from '../local-broker.js';
import { acquireStateLease } from '../node-state.js';
import { WORKFLOW_READS } from '../workflow.js';
import type { FetchTransport } from '../artifacts-git.js';
import { BootstrapState } from './bootstrap-state.js';
import { OwnerAccess } from './owner-access.js';
import type { OwnerAgentSettings } from './agent-settings.js';
import { StudioCommands } from './commands.js';
import { ExplorerReader } from './read.js';
import { ExplorerConnections } from './connections.js';
import { startExplorer } from './host.js';
import type { HostedOptions } from './hosted.js';
import { privateDir, readPrivate, writePrivate } from './owner-files.js';
import { canonicalDisjointPaths, readRootWorkspaceFile, repositoryGrantSchema, repositoryGrantDigest, WORKSPACE_PROVIDER_OPERATIONS, WORKSPACE_WRITES } from './workspace-policy.js';
import { writerImportSchema, validateWriterImport, assertFreshWorkspacePrincipal } from './workspace-import.js';
import { importCatalogSchema, fetchIndex, type RepositoryIndex } from './namespace-import.js';
import { FileWorkspaceState, initialWorkspaceState } from './workspace-state.js';
import { WorkspaceRuntime } from './workspace-runtime.js';
import { recoverablePermissionChecks } from './workspace-permission-recovery.js';
import { namespaceConfigSchema, namespacePolicySchema, namespacePolicyDigest, type NamespaceConfig, type NamespaceProject } from './namespace-policy.js';
import { NamespaceStore } from './namespace-store.js';
import { NamespaceProvider, type NamespaceLease } from './namespace-provider.js';
import { NamespaceManager } from './namespace-manager.js';
import { createStudioAgentHub, type StudioAgentsHostConfig } from '../studio-agents/host.js';
import { StudioAgentHttp } from '../studio-agents/http.js';
import { contextSchema, AgentHubError } from '../studio-agents/protocol.js';
import { BUILD_OPERATIONS } from '../build-operations.js';
import { createNamespaceBuildRepository, namespaceBuildOutput, namespaceBuildHost, namespaceBuildStudioPort, type NamespaceLocalBuildConfiguration } from './namespace-build.js';
import { PROFILE_MUTATIONS, PROFILE_OPERATIONS } from '../build-records.js';
import type { ProfileServiceScope } from '../profile-service.js';
import { namespaceProfilesSchema, NamespaceProfilesStudioAdapter } from './namespace-profiles.js';
import { firstProjectSchema, provisionFirstProject, FIRST_PROJECT_OPERATIONS, FIRST_PROJECT_OUTPUT_SLOTS } from './first-project.js';
import { hostRunner } from '../auth/runner.js';
import { MUTATIONS } from '../service.js';

export const namespaceManifestSchema=z.object({grant:repositoryGrantSchema,imported:writerImportSchema,
  accounts:accountStoreV2Schema,policy:z.union([policyStoreV2Schema,policyStoreV4Schema]),baseline:blockSnapshotSchema.nullable(),
  profiles:namespaceProfilesSchema.optional(),first_project:firstProjectSchema.optional()}).strict();
const manifestSchema=namespaceManifestSchema;
type ProjectHost={access:ActorAccess;runtime:WorkspaceRuntime;issuer:HostIssuer;manifest:z.infer<typeof manifestSchema>;
  commands:(req:IncomingMessage,parentReq?:IncomingMessage)=>StudioCommands;connections:(req:IncomingMessage)=>ExplorerConnections;
  call:(token:string,command:string,input:unknown,options?:unknown)=>Promise<any>;close:()=>Promise<void>};

export async function runNamespaceStudio(state:BootstrapState,configuration:NamespaceConfig,options:HostedOptions,
  port:number,assets:string,transport?:FetchTransport,agents?:OwnerAgentSettings,credentialFence?:()=>Promise<void>,agentConfiguration?:StudioAgentsHostConfig,localBuildConfiguration?:NamespaceLocalBuildConfiguration){
  const config=namespaceConfigSchema.parse(configuration);canonicalDisjointPaths([...Object.values(config).filter((p):p is string=>typeof p==='string'),...Object.values(state.config)]);
  const policy=namespacePolicySchema.parse(await readRootWorkspaceFile(config.policy_file));
  const policyCurrent=async()=>{if(namespacePolicyDigest(namespacePolicySchema.parse(await readRootWorkspaceFile(config.policy_file)))!==namespacePolicyDigest(policy))
    fail('ACCESS_REVOKED',4,'Namespace policy changed. Restart with a reviewed matching lineage.');};
  const sealed=await state.owner(true,false);
  if(!sealed||sealed.owner_id!==policy.owner_id||sealed.manifest.installation_id!==policy.installation_id)
    fail('OWNER_FORBIDDEN',4,'Namespace policy belongs to another sealed owner.');
  const agentHost=agentConfiguration??{format:'strata-studio-agent-host/1' as const,directory:path.join(path.dirname(state.config.state_directory),'studio-agents-'+digest({installation:policy.installation_id,owner:policy.owner_id}).slice(0,24)),bundle_file:path.resolve(assets,'..','dist','studio-agent-worker','worker.mjs')};
  const hub=createStudioAgentHub(agentHost,policy.installation_id,policy.owner_id,[...Object.values(state.config),config.projects_directory,config.catalog_directory,config.policy_file],undefined,async(context,ownerGeneration)=>{
    await policyCurrent();const active=await state.owner(true,false),snapshot=await store.snapshot(),project=snapshot.projects.find(p=>p.id===snapshot.selected_repository_id);
    if(!active||active.owner_id!==policy.owner_id||active.authentication_generation!==ownerGeneration||!snapshot.approved||snapshot.revoked||!snapshot.connected||snapshot.selection_epoch!==context.selection_epoch||project?.id!==context.binding.repository_id||project?.project_id!==context.binding.project_id||project?.state!=="ready"||(project.model_version??BLOCK_MODEL)!==context.binding.model_version)throw new AgentHubError("AGENT_SOURCE_UNAVAILABLE");
  });
  const buildOutput=localBuildConfiguration?namespaceBuildOutput(localBuildConfiguration,[...Object.values(state.config),config.projects_directory,config.catalog_directory,config.policy_file,assets,agentHost.directory]):undefined;
  await privateDir(config.projects_directory);
  const store=new NamespaceStore(config.catalog_directory,policy);await store.ready();
  const releaseCatalog=await acquireStateLease(config.catalog_directory,'broker');
  try{
  await store.recoverInterrupted();
  const credentials=state.store(sealed.manifest),generation=async()=>{await credentialFence?.();return credentials.encryptedGeneration();};
  const credential=async()=>{await credentialFence?.();const secret=await credentials.withCredential(async value=>{if(!value)fail('SOURCE_AUTH',4,'Save the Artifacts API token in Settings.');return value;});await credentialFence?.();return secret;};
  const provider=new NamespaceProvider(policy,store,credential,transport),projects=new Map<string,ProjectHost>();
  let owner:OwnerAccess,manager:NamespaceManager;
  const parents=new WeakMap<object,{parent:OwnerAuthentication;project:string;creating:boolean}>();
  const changed=()=>{hub?.changed();agents?.changed();for(const host of projects.values()){host.access.clear();host.runtime.state.changed();}};
  const directory=(project:NamespaceProject)=>path.join(config.projects_directory,digest({repository_id:project.id,...(project.origin==='import'?{import_id:project.creation_id}:{})}));
  async function guardedParent(parent:OwnerAuthentication,project:string,creating=false):Promise<OwnerAuthentication>{
    const epoch=manager.generation(),s=await manager.authority(parent,project,creating),credentialGeneration=await generation();
    const assertLive=()=>{parent.assertLive();manager.assertEpoch(epoch);};
    return {...parent,assertLive,refresh:async()=>{assertLive();const current=await manager.authority(parent,project,creating);
      if(current.selection_epoch!==s.selection_epoch||await generation()!==credentialGeneration)fail('ACCESS_REVOKED',4,'Repository context or credential changed.');assertLive();}};
  }
  async function load(project:NamespaceProject):Promise<ProjectHost>{
    const previous=projects.get(project.id);if(previous)return previous;
    const root=directory(project);await privateDir(root);
    const manifest=manifestSchema.parse(await readPrivate(path.join(root,'genesis.json'),16*1024**2));
    if(project.genesis_sha256!==null&&digest(manifest)!==project.genesis_sha256)fail('WRITER_IMPORT_REQUIRED',4,'Project genesis differs from its catalog.');
    const {grant,imported,accounts,policy:actorPolicy}=manifest;
    if(manifest.first_project&&grant.model_version!==BLOCK_MODEL)fail('WRITER_IMPORT_REQUIRED',4,'Finite first-project execution requires v0.3.');
    const outputSlots=manifest.first_project?{...FIRST_PROJECT_OUTPUT_SLOTS}:{};
    const retained=imported.format==='strata-studio-owner-snapshot/1'?validateWriterImport(imported,grant).records:undefined;
    if(grant.project_id!==project.project_id||grant.storage.expected_repository_id!==project.id||grant.storage.repository!==project.name||
      grant.storage.account!==policy.account||grant.storage.namespace!==policy.namespace||grant.owner_id!==policy.owner_id||
      grant.installation_id!==policy.installation_id||grant.lineage_id!==policy.lineage_id||digest({accounts,policy:actorPolicy})!==grant.actor_binding_sha256)
      fail('WRITER_IMPORT_REQUIRED',4,'Repository project binding differs.');
    const issuer=new HostIssuer(accounts,actorPolicy,Date.now,async input=>{
      const trusted=parents.get(input as object);if(trusted){if(trusted.project!==project.project_id)fail('PROJECT_FORBIDDEN',4,'Project exchange differs.');return guardedParent(trusted.parent,project.project_id,trusted.creating);}
      return guardedParent(await owner.actorAuthentication(input as IncomingMessage,false),project.project_id);
    });
    const control=new FileWorkspaceState(path.join(root,'control','workspace.json'),grant,digest(imported.origin));
    const proof={format:'strata-studio-development-provider-contract/1' as const,grant_sha256:repositoryGrantDigest(grant),expected_repository_id:project.id,
      environment:'development' as const,contract:'repository-addressed-by-name' as const,operator_rule:policy.operator_rule,
      evidence_kind:'owner-acknowledgment' as const,evidence_sha256:namespacePolicyDigest(policy)};
    const runtime=new WorkspaceRuntime(grant,imported,issuer,store.budget(),control,path.join(root,'broker'),generation,credential,proof,transport);
    // Opening a verified project is a read. A write-token probe must never
    // prevent browsing or destroy the actor session after selection succeeded.
    const profileScope:ProfileServiceScope|undefined=manifest.profiles?{project_id:project.project_id,repository_id:project.id,
      authority_ref:manifest.profiles.authority_ref,source_trust:grant.model_version===MODEL?'legacy-history-authenticated-authoring':'host-authenticated'}:undefined;
    const buildConfigured=!!(buildOutput&&profileScope&&grant.model_version===BLOCK_MODEL&&
      (!localBuildConfiguration?.repository_ids||localBuildConfiguration.repository_ids.includes(project.id)));
    const mountedWrites=[...new Set([...WORKSPACE_WRITES,...(manifest.first_project?FIRST_PROJECT_OPERATIONS.filter(op=>MUTATIONS.has(op)||op==='materialize'):[]),...(profileScope?PROFILE_MUTATIONS:[]),...(buildConfigured?['build.start']:[])])];
    let builds:ReturnType<typeof createNamespaceBuildRepository>|undefined;
    await runtime.ready();const access=new ActorAccess(issuer,options),broker=await startLocalBroker(path.join(root,'broker'),0,
      {issuer,model_version:grant.model_version,artifacts:runtime.store,workspace:runtime.brokerControls(),max_pending:4,
        ...(manifest.first_project?{runner:hostRunner(path.join(root,'broker'),outputSlots,['collection-host/1'])}:{}),
        ...(profileScope?{repository:{scope:profileScope,...(buildConfigured?{build:(command:string,input:unknown,context:any,opts:any)=>{
          if(!builds)fail('BUILD_RECOVERY_REQUIRED',9,'Local Build startup is not complete.');return builds.execute(command,input,context,opts);
        }}:{})}}:{})});
    if(buildConfigured&&profileScope&&buildOutput&&localBuildConfiguration) {
      builds=createNamespaceBuildRepository({issuer,scope:profileScope,model_version:grant.model_version,output:buildOutput,
        host:namespaceBuildHost(localBuildConfiguration),transaction:broker.repositoryTransaction});
      if(localBuildConfiguration.startupRecovery) {
        try { await builds.reconcile(await localBuildConfiguration.startupRecovery(project.id,issuer)); }
        catch(error) { await builds.close();await broker.close();throw error; }
      }
    }
    const sessions=new Map<string,{commands:StudioCommands;connections:ExplorerConnections}>();
    const call=async(token:string,command:string,input:unknown,opts:any={})=>{
      await issuer.refreshSession(token);
      const res=await fetch(broker.url+'/v1/operation',{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-strata-session':token,
        'x-strata-project':project.project_id,'x-strata-artifact-adapter':'cloudflare-artifacts-remote',
        ...(opts.expected_generation?{'x-strata-expected-generation':opts.expected_generation}:{}),...(opts.expected_policy?{'x-strata-expected-policy':opts.expected_policy}:{})},
        body:JSON.stringify({command,input,options:{idempotency_key:opts.idempotency_key,dry_run:opts.dry_run}}),signal:AbortSignal.timeout(65_000)});
      const result=await res.json() as any;if(!result.ok)fail(result.error.code,result.error.exit,result.error.message);
      return result;
    };
    const session=(req:IncomingMessage,parentReq=req)=>{
      access.require(req);const token=access.token(req);issuer.resolve(token);
      for(const [key,s]of sessions)try{issuer.resolve(key);}catch{s.commands.close();sessions.delete(key);}
      let s=sessions.get(token);if(!s){
        const profiles=profileScope?new NamespaceProfilesStudioAdapter(project.id,async(command,input,opts={})=>{
          if(PROFILE_MUTATIONS.includes(command as any)&&!opts.dry_run)
            await qualify(runtime,await guardedParent(await owner.actorAuthentication(parentReq,false),project.project_id));
          return call(token,command,input,opts);
        }):undefined;
        const profilesBuild=builds&&profiles?namespaceBuildStudioPort(builds,()=>issuer.resolve(token),profiles,async()=>{
          const context=issuer.resolve(token);issuer.authorize(context,'build.start',{});issuer.assertRepository(context,'build.start',project.id,[]);
          await qualify(runtime,await guardedParent(await owner.actorAuthentication(parentReq,false),project.project_id));
        }):profiles;
        const commands=new StudioCommands({project_id:project.project_id,model_version:grant.model_version,artifact_adapter:'cloudflare-artifacts-remote'},token,
          path.join(root,'broker'),[...mountedWrites,...(profileScope?PROFILE_OPERATIONS:[]),...(buildConfigured?BUILD_OPERATIONS:[])],outputSlots,grant.model_version===MODEL?'legacy-history-authenticated-authoring':'host-authenticated',()=>{issuer.resolve(token);return issuer.accessBinding()+'/'+manager.generation();},opts=>async(command,input)=>{
            if(MUTATIONS.has(command)&&!opts.dry_run)
              await qualify(runtime,await guardedParent(await owner.actorAuthentication(parentReq,false),project.project_id));
            const result=await call(token,command,input,opts);
            if(command==='capabilities'){
              if(manifest.first_project){
                result.data.profiles=['collection-host/1'];
                result.data.profile_details=result.data.profile_details.filter((p:any)=>p.id==='collection-host/1');
                result.data.scenarios=[{id:'collection.compatibility',version:'1'}];
              }
              const current=await runtime.state.snapshot(),blocked=current.operations.some(o=>!['committed','cancelled_before_effect'].includes(o.phase));
              result.data.write_blocked=blocked;
              result.data.write_recovery_available=blocked&&recoverablePermissionChecks(current,grant)!==null;
              result.data.write_message=blocked?'Draft saving is paused because an earlier writing-access check did not finish. You can still browse this repository.':null;
              if(blocked)result.data.operations=result.data.operations.map((o:any)=>mountedWrites.includes(o.operation)?{...o,supported:false,reason:result.data.write_message}:o);
            }
            return result;
          },retained,profilesBuild);
        commands.source.connection.connection_id=project.id;commands.source.connection.display_name=project.name;
        s={commands,connections:new ExplorerConnections([{reader:commands.reader,provider:'local-broker',authenticationAvailable:()=>true}])};sessions.set(token,s);
      }return s;
    };
    const host:ProjectHost={access,runtime,issuer,manifest,commands:(req,parentReq)=>session(req,parentReq).commands,connections:req=>session(req).connections,call,
      close:async()=>{for(const s of sessions.values())s.commands.close();access.clear();await builds?.close();await broker.close();}};
    projects.set(project.id,host);return host;
  }
  async function qualify(runtime:WorkspaceRuntime,parent:OwnerAuthentication){
    const s=await runtime.state.snapshot(),g=await generation();
    if(!s.tests.some(t=>t.kind==='test-write'&&t.credential_generation===g&&t.write_token_verified&&!t.error))
      await runtime.test({action:'test-write',revision:s.revision,request_id:randomUUID()},()=>Promise.resolve(parent));
  }
  async function initialize(project:NamespaceProject,purpose:string,parent:OwnerAuthentication){
    await parent.refresh();parent.assertLive();
    const p=policy,root=directory(project);await privateDir(root,true);
    for(const sub of ['broker','control'])await privateDir(path.join(root,sub),true);
    await privateDir(path.join(root,'broker','verified-artifacts'),true);
    const provisioned=p.first_project?provisionFirstProject(p,project.project_id,purpose):undefined;
    const accounts=provisioned?.accounts??accountStoreV2Schema.parse({format:'strata-host-accounts/2',generation:1,accounts:[{account_id:p.account_id,principal_id:p.principal_id,
      principal_kind:'person',active:true,credential_epoch:1,credential:{method:'installation-owner',installation_id:p.installation_id,owner_id:p.owner_id}}]});
    const actorPolicy=provisioned?.policy??policyStoreV2Schema.parse({format:'strata-host-policy/2',project_id:project.project_id,generation:1,grants:[{grant_id:'namespace-author',principal_id:p.principal_id,
      operations:[...WORKFLOW_READS,'inspect','status','diff','conflicts','context.show','init',...WORKSPACE_WRITES],layer_ids:null,write_block_ids:['root'],create_under_block_ids:['root'],approvals:[],profiles:[],lifetime:p.lifetime}]});
    const imported=writerImportSchema.parse({format:'strata-studio-empty-genesis/1',project_id:project.project_id,model_version:BLOCK_MODEL,expected_repository_id:project.id,
      complete_private_state:true,quiesced_at:new Date().toISOString(),source_writer:'namespace-new-project',source_generation:digest({creation_id:project.creation_id}),
      closure_verification:{kind:'new-empty-repository',receipt_sha256:digest(project)},
      registry:{entries:{},storage:{format:'strata-artifacts-registry/1',project_id:project.project_id,account:p.account,namespace:p.namespace,repository:project.name,mode:'remote'},heads:{},requests:{},contexts:{}},
      record_bytes:{},origin:{format:'strata-studio-budget-carry/1',old_lineage_sha256:namespacePolicyDigest(p),reserved_requests:0,reserved_bytes:0}});
    const grant=repositoryGrantSchema.parse({format:'strata-studio-repository-grant/1',installation_id:p.installation_id,owner_id:p.owner_id,lineage_id:p.lineage_id,
      grant_id:randomUUID(),policy_generation:1,issued_at:new Date().toISOString(),not_before:new Date().toISOString(),lifetime:p.lifetime,
      project_id:project.project_id,model_version:BLOCK_MODEL,storage:{account:p.account,namespace:p.namespace,repository:project.name,expected_repository_id:project.id,remote:project.remote},
      import_manifest_sha256:digest(imported),credential_id:'artifacts-api-token',actor_binding_sha256:digest({accounts,policy:actorPolicy}),access:'read-write',
      provider_contract:p.provider_contract,provider_operations:WORKSPACE_PROVIDER_OPERATIONS,limits:p.limits});
    const baseline=provisioned?.baseline??blockSnapshotSchema.parse({id:'ProjectBaseline',revision:1,model_version:BLOCK_MODEL,root:'root',blocks:{root:{id:'root',parent:null,purpose,
      description:{format:'plain-text/1',text:''},asset_refs:{},requirements:{},acceptance:{},relationships:{},contract:{inputs:{},outputs:{},failures:{}}}},
      authorities:{scopes:[{block:'root',selectors:[]}],release:[],guardians:[]},deleted_ids:[]});
    const manifest=manifestSchema.parse({grant,imported,accounts,policy:actorPolicy,baseline,...(provisioned?{first_project:provisioned.first_project}:{})});
    await writePrivate(path.join(root,'genesis.json'),manifest,true);
    await writePrivate(path.join(root,'broker','node-state.json'),{format:'strata-node-state/1',project_id:project.project_id,model_version:BLOCK_MODEL},true);
    await writePrivate(path.join(root,'broker','registry.json'),imported.registry,true);
    await writePrivate(path.join(root,'control','workspace.json'),initialWorkspaceState(grant,digest(imported.origin)),true);
    const host=await load(project);await host.runtime.state.action({action:'connect',revision:0,request_id:randomUUID()},async()=>{await manager.authority(parent,project.project_id,true);});
    const context={};parents.set(context,{parent,project:project.project_id,creating:true});
    const token=await host.issuer.loginOwner(context);
    try{await qualify(host.runtime,await guardedParent(parent,project.project_id,true));
      await parent.refresh();parent.assertLive();
      await host.call(token,'init',{record:baseline},{idempotency_key:project.creation_id});
    }finally{host.issuer.logout(token);parents.delete(context);}
    return digest(manifest);
  }
  const indexes=async()=>config.import_catalog_file?importCatalogSchema.parse(await readRootWorkspaceFile(config.import_catalog_file,256*1024)).indexes:[];
  async function importProject(project:NamespaceProject,index:RepositoryIndex,lease:NamespaceLease){
    const fetched=await fetchIndex(index,provider,lease),p=policy,principal='studio-import-'+project.creation_id.replaceAll('-','');
    assertFreshWorkspacePrincipal(fetched.records,principal);
    const blocks=[...new Set(Object.values(fetched.records).filter(r=>r.type==='release'&&r.published).flatMap(r=>Object.keys(snapshotFromRelease(r.data).blocks)))];
    const accounts=accountStoreV2Schema.parse({format:'strata-host-accounts/2',generation:1,accounts:[{account_id:p.account_id,principal_id:principal,principal_kind:'person',active:true,credential_epoch:1,credential:{method:'installation-owner',installation_id:p.installation_id,owner_id:p.owner_id}}]});
    const actorPolicy=policyStoreV2Schema.parse({format:'strata-host-policy/2',project_id:project.project_id,generation:1,grants:[{grant_id:'namespace-author',principal_id:principal,operations:[...WORKFLOW_READS,'inspect','status','diff','conflicts','context.show',...WORKSPACE_WRITES],layer_ids:null,write_block_ids:blocks,create_under_block_ids:[],approvals:[],profiles:[],lifetime:p.lifetime}]});
    const imported=writerImportSchema.parse({format:'strata-studio-owner-snapshot/1',project_id:project.project_id,model_version:index.model_version,expected_repository_id:project.id,complete_private_state:false,quiesced_at:new Date().toISOString(),source_writer:'owner-imported-snapshot',source_generation:fetched.source_generation,closure_verification:{kind:'owner-approved-snapshot',receipt_sha256:digest(index)},
      registry:{entries:index.registry.entries,storage:index.registry.storage,asset_locators:index.registry.asset_locators,heads:{},requests:{},contexts:{}},record_bytes:fetched.record_bytes,binary_bytes:fetched.binary_bytes,origin:{format:'strata-studio-budget-carry/1',old_lineage_sha256:namespacePolicyDigest(p),reserved_requests:0,reserved_bytes:0}});
    const grant=repositoryGrantSchema.parse({format:'strata-studio-repository-grant/1',installation_id:p.installation_id,owner_id:p.owner_id,lineage_id:p.lineage_id,grant_id:randomUUID(),policy_generation:1,issued_at:new Date().toISOString(),not_before:new Date().toISOString(),lifetime:p.lifetime,project_id:project.project_id,model_version:index.model_version,storage:{account:p.account,namespace:p.namespace,repository:project.name,expected_repository_id:project.id,remote:project.remote},import_manifest_sha256:digest(imported),credential_id:'artifacts-api-token',actor_binding_sha256:digest({accounts,policy:actorPolicy}),access:'read-write',provider_contract:p.provider_contract,provider_operations:WORKSPACE_PROVIDER_OPERATIONS,limits:p.limits});
    validateWriterImport(imported,grant);await lease.refresh();
    const root=directory(project);await privateDir(root,true);for(const sub of ['broker','control'])await privateDir(path.join(root,sub),true);
    const cache=path.join(root,'broker','verified-artifacts');await privateDir(cache,true);
    // The original index is retained intact. Historical heads and receipts never
    // become the new author's writer state, and immutable remote files are untouched.
    await writePrivate(path.join(root,'source-index.json'),index,true);
    for(const [ref,text]of Object.entries(fetched.record_bytes)){const h=await open(path.join(cache,index.registry.entries[ref].hash+'.json'),'wx',0o600);try{await h.writeFile(text);await h.sync();}finally{await h.close();}}
    for(const [hash,text]of Object.entries(fetched.binary_bytes)){const h=await open(path.join(cache,hash+'.bin'),'wx',0o600);try{await h.writeFile(Buffer.from(text,'base64'));await h.sync();}finally{await h.close();}}
    const manifest=manifestSchema.parse({grant,imported,accounts,policy:actorPolicy,baseline:null});
    await writePrivate(path.join(root,'genesis.json'),manifest,true);
    await writePrivate(path.join(root,'broker','node-state.json'),{format:'strata-node-state/1',project_id:project.project_id,model_version:index.model_version},true);
    await writePrivate(path.join(root,'broker','registry.json'),imported.registry,true);
    const control=initialWorkspaceState(grant,digest(imported.origin));control.desired_connected=true;
    await writePrivate(path.join(root,'control','workspace.json'),control,true);await lease.refresh();return digest(manifest);
  }
  manager=new NamespaceManager(store,provider,generation,policyCurrent,initialize,changed,indexes,importProject,async(project,parent,lease)=>{
    const host=await load(project),authorize=()=>guardedParent(parent,project.project_id);
    await host.runtime.recoverPermissionCheck(authorize,()=>provider.noLiveTokens(lease,project.name,project.id));
    await qualify(host.runtime,await authorize());
  });
  owner=new OwnerAccess(state,options,Date.now,{metadataOnly:true,workspaceMode:true,namespaceMode:true,agents,
    invalidated:()=>manager.changed(),workspaceConnections:async(req,input,operation)=>{
      await policyCurrent();if(operation)return manager.outcome(operation);
      if(req.method==='GET')return manager.status();
      return manager.action(input,await owner.actorAuthentication(req,false),async()=>{await owner.sourceAuthority(req).current(true);});
    }});
  // Lazy construction is serialized per repository so two tabs cannot acquire
  // competing writer leases. Loading metadata never contacts the provider.
  const loading=new Map<string,Promise<ProjectHost>>();
  const selected=async(req:IncomingMessage)=>{
    if(!(await owner.status(req,true)).authenticated)fail('OWNER_SESSION_REQUIRED',4,'Sign in to Studio.');
    await policyCurrent();const s=await store.snapshot();if(!s.approved||s.revoked||!s.connected)fail('ACCESS_REVOKED',4,'Namespace access is paused or revoked.');
    const project=s.projects.find(r=>r.id===s.selected_repository_id&&r.state==='ready');if(!project)fail('CONNECTION_NOT_READY',4,'Choose or create a Strata repository.');
    if(!req.url?.startsWith('/studio/actor/')&&req.headers['x-strata-repository']!==project.id)fail('PROJECT_FORBIDDEN',4,'Refresh the repository context before reading or writing.');
    let pending=loading.get(project.id);if(!pending){pending=load(project);loading.set(project.id,pending);void pending.catch(()=>loading.delete(project.id));}
    return pending;
  };
  const shell=new ExplorerReader({connection:{connection_id:'namespace',project_id:'unselected',display_name:'Choose repository',model_version:BLOCK_MODEL},assertAuthorized(){},async load(){fail('CONNECTION_NOT_READY',4,'Choose a repository.');}});
  const placeholder=new ActorAccess(new HostIssuer({format:'strata-host-accounts/2',generation:1,accounts:[]},
    {format:'strata-host-policy/2',project_id:'unselected',generation:1,grants:[]}),options);
  const agentHttp=hub?new StudioAgentHttp(hub,owner,async req=>{
    const host=await selected(req);
    // The owner API checked owner CSRF. Independently check actor CSRF before
    // resolving the existing project command port; keep owner refresh bound to
    // the original request rather than substituting either token's authority.
    const actorRequest=Object.create(req) as IncomingMessage;
    Object.defineProperty(actorRequest,'headers',{value:{...req.headers,'x-studio-csrf':req.headers['x-studio-actor-csrf']}});
    const commands=host.commands(actorRequest,req);
    return {context:async baseline=>{
      const current=await owner.actorAuthentication(req,false),selectedState=await manager.authority(current,host.manifest.grant.project_id);
      const caps=await commands.read('capabilities'),record=await commands.read('inspect',{type:'release',ref:baseline});
      const release=record?.data??record;if(!release?.blocks)throw new AgentHubError('AGENT_SOURCE_UNAVAILABLE');
      return contextSchema.parse({binding:{project_id:host.manifest.grant.project_id,model_version:host.manifest.grant.model_version,repository_id:host.manifest.grant.storage.expected_repository_id},baseline,baseline_sha256:digest(release),generation:caps.generation,policy:caps.policy_generation,principal_id:caps.principal_id,selection_epoch:selectedState.selection_epoch,snapshot_metadata:{id:release.id,revision:release.revision,root:release.root,authorities:release.authorities,deleted_ids:release.deleted_ids},blocks:release.blocks});
    },inspectSave:async requestId=>{
      const receipt=await commands.read('operation.inspect',{key:requestId});
      if(receipt.state!=='committed')return {committed:false,result:null,draft_sha256:null};
      const result=receipt.result;if(!result?.data?.ref)throw new AgentHubError('AGENT_STALE');
      const record=await commands.read('inspect',{type:'layer',ref:result.data.ref});
      return {committed:true,draft_sha256:digest(record),result:{data:result.data,operation_id:result.operation_id,created:result.created??[],reused:true,refresh_error:null}};
    },save:async(draft,requestId,context)=>commands.operation({command:'layer.create',input:{record:draft},idempotency_key:requestId,expected_generation:context.generation,expected_policy:context.policy})};
  },path.resolve(path.dirname(agentHost.bundle_file),'..','studio-agent-runner.zip')):undefined;
  const server=await startExplorer(shell,{port,assets,agentHttp,workspace:{owner,actor:{access:placeholder,commands(){fail('CONNECTION_NOT_READY',4,'Choose a repository.');},connections(){fail('CONNECTION_NOT_READY',4,'Choose a repository.');}},
    resolveActor:async req=>{try{return await selected(req);}catch(e:any){if(req.method==='GET'&&req.url==='/studio/actor/session'&&['ACCESS_REVOKED','CONNECTION_NOT_READY'].includes(e.code))return {access:placeholder,commands(){fail('CONNECTION_NOT_READY',4,'Choose a repository.');},connections(){fail('CONNECTION_NOT_READY',4,'Choose a repository.');}};throw e;}},current:async req=>{const h=await selected(req);await h.issuer.refreshSession(h.access.token(req));}}});
  return {...server,manager,store,owner,selectedSource:{current:async()=>{
    await policyCurrent();const s=await store.snapshot(),r=s.projects.find(r=>r.id===s.selected_repository_id&&r.state==='ready');
    if(!r||!s.approved||s.revoked||!s.connected)return undefined;
    return {selection_id:r.id,epoch:s.selection_epoch,binding:{project_id:r.project_id,model_version:r.model_version??BLOCK_MODEL,repository_id:r.id},valid_until:null};
  }},close:async()=>{owner.clear();placeholder.clear();await server.close();try{for(const host of projects.values())await host.close();}finally{await releaseCatalog();}}};
  }catch(e){await releaseCatalog();throw e;}
}
