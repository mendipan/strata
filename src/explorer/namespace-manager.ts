import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, fail, BLOCK_MODEL } from '../model.js';
import type { OwnerAuthentication } from '../auth/host-issuer.js';
import { workspaceId } from './workspace-policy.js';
import { NAMESPACE_JOURNAL_CAPACITY, namespacePolicyDigest, type NamespaceProject } from './namespace-policy.js';
import { NamespaceStore } from './namespace-store.js';
import { NamespaceProvider, type NamespaceLease } from './namespace-provider.js';
import { repositoryIndexSchema, admitIndex, type RepositoryIndex } from './namespace-import.js';
const common={request_id:z.string().uuid(),revision:z.number().int().min(0)};
const actions=z.discriminatedUnion('action',[
  z.object({...common,action:z.literal('approve'),scope_sha256:z.string(),acknowledgment:z.literal('until-revoked-development-namespace'),project_authority_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),
  ...(['pause','resume','revoke'] as const).map(action=>z.object({...common,action:z.literal(action)}).strict()),
  z.object({...common,action:z.literal('discover'),search:z.string().max(128),cursor:z.string().max(512).nullable()}).strict(),
  z.object({...common,action:z.literal('select'),repository_id:workspaceId}).strict(),
  z.object({...common,action:z.literal('import'),repository_id:workspaceId,name:workspaceId,index:repositoryIndexSchema.optional(),acknowledgment:z.literal('open-snapshot-and-save-new-drafts')}).strict(),
  z.object({...common,action:z.literal('create'),name:workspaceId,purpose:z.string().min(1).max(500)}).strict(),
  z.object({...common,action:z.literal('inspect-create'),source_request_id:z.string().uuid()}).strict(),
  z.object({...common,action:z.literal('recover-create'),source_request_id:z.string().uuid(),repository_id:workspaceId,purpose:z.string().min(1).max(500),acknowledgment:z.literal('initialize-empty-repository')}).strict(),
  z.object({...common,action:z.literal('resume-drafts'),repository_id:workspaceId}).strict(),
]);
export class NamespaceManager {
  private epoch=0;private busy=false;
  constructor(readonly store:NamespaceStore,readonly provider:NamespaceProvider,
    private credentialGeneration:()=>Promise<string>,private policyCurrent:()=>Promise<void>,
    private initialize:(project:NamespaceProject,purpose:string,parent:OwnerAuthentication)=>Promise<string>,
    private invalidated:()=>void,private indexes:()=>Promise<RepositoryIndex[]>=async()=>[],
    private importProject?:(project:NamespaceProject,index:RepositoryIndex,lease:NamespaceLease)=>Promise<string>,
    private resumeDrafts?:(project:NamespaceProject,parent:OwnerAuthentication,lease:NamespaceLease)=>Promise<void>){}
  changed(){this.epoch++;this.invalidated();}
  generation(){return this.epoch;}
  assertEpoch(epoch:number){if(epoch!==this.epoch)fail('ACCESS_REVOKED',4,'The repository context changed. Open the selected project again.');}
  private assertFirstProjectAuthority(){const spec=this.store.policy.first_project;
    if(spec&&Date.parse(spec.lifetime.expires_at)<=Date.now())
      fail('ACCESS_REVOKED',4,'The first-project human authority expired; no new initialization is authorized.');
  }
  async authority(parent:OwnerAuthentication,projectId?:string,creating=false){
    parent.assertLive();await parent.refresh();await this.policyCurrent();
    const p=this.store.policy,s=await this.store.snapshot();
    if(parent.owner_id!==p.owner_id||parent.installation_id!==p.installation_id||!s.approved||s.revoked||!s.connected)
      fail('ACCESS_REVOKED',4,'Namespace access is paused, unapproved or revoked.');
    if(projectId&&!s.projects.some(r=>r.project_id===projectId&&(creating?r.state==='created':r.state==='ready'&&r.id===s.selected_repository_id)))
      fail('PROJECT_FORBIDDEN',4,'This actor belongs to another repository selection.');
    return s;
  }
  async lease(parent:OwnerAuthentication,operationId:string,projectId?:string,creating=false,firstProject=false):Promise<NamespaceLease&{assertSync():void}>{
    const state=await this.authority(parent,projectId,creating),epoch=this.epoch,generation=await this.credentialGeneration();
    const signal=AbortSignal.timeout(60_000),assertSync=()=>{parent.assertLive();if(firstProject)this.assertFirstProjectAuthority();if(epoch!==this.epoch||signal.aborted)fail('ACCESS_REVOKED',4,'Namespace authority changed during this operation.');};
    return {operation_id:operationId,signal,assertSync,refresh:async()=>{assertSync();const s=await this.authority(parent,projectId,creating);
      if(s.selection_epoch!==state.selection_epoch||generation!==await this.credentialGeneration())fail('ACCESS_REVOKED',4,'Repository selection or saved credential changed.');assertSync();}};
  }
  async status(){const s=await this.store.snapshot(),p=this.store.policy;return {
    format:'strata-studio-owner-connections/3',mode:'namespace',revision:s.revision,scope_sha256:namespacePolicyDigest(p),
    scope:{account:p.account,namespace:p.namespace,permissions:p.permissions,lifetime:p.lifetime,
      ...(p.first_project?{first_project:{...p.first_project,principal_id:p.principal_id,account_id:p.account_id,authority_sha256:digest(p.first_project)}}:{})},
    approved:s.approved,revoked:s.revoked,connected:s.connected,selected_repository_id:s.selected_repository_id,
    selected_connection_id:s.selected_repository_id,selection_epoch:s.selection_epoch,
    projects:s.projects.map(({id,name,read_only,project_id,creation_id,state,automatic_token_expires_at,model_version,origin})=>
      ({id,name,read_only,project_id,creation_id,state,automatic_token_expires_at,model_version:model_version??BLOCK_MODEL,origin:origin??'created'})),
    importable:(await this.indexes()).map(i=>({id:i.repository_id,name:i.registry.storage.repository,model_version:i.model_version})),
    operations:s.operations.slice(-20),usage:await this.store.usageSnapshot(),
    capabilities:{discover:s.approved&&!s.revoked&&s.connected,create:s.approved&&!s.revoked&&s.connected,
      draft:true,authenticated_release:!!p.first_project,existing_repository_import:!!this.importProject},
    provider_contract:p.provider_contract,automatic_creation_token:p.automatic_creation_token,automatic_token_max_lifetime_seconds:p.automatic_token_max_lifetime_seconds,
  };}
  async outcome(id:string){z.string().uuid().parse(id);return {format:'strata-studio-namespace-outcome/1',operation:(await this.store.snapshot()).operations.find(o=>o.request_id===id)??null};}
  async action(input:unknown,parent:OwnerAuthentication,fresh:()=>Promise<void>){
    const parsed=actions.safeParse(input);
    if(!parsed.success){
      if((input as any)?.action==='create'&&!workspaceId.safeParse((input as any).name).success)
        fail('INVALID_REPOSITORY_NAME',2,'Use letters, numbers, hyphens or underscores for the repository name, with no spaces.');
      fail('INVALID_INPUT',2,'Check the repository name and project purpose, then try again.');
    }
    const a=parsed.data,hash=digest(a),p=this.store.policy;let epoch=this.epoch;
    if(a.action==='approve'&&(p.first_project?a.project_authority_sha256!==digest(p.first_project):a.project_authority_sha256!==undefined))
      fail('SCOPE_MISMATCH',4,'Confirm the exact displayed first-project human authority.');
    const assertLive=()=>{parent.assertLive();this.assertEpoch(epoch);};
    const publication={assertLive,refresh:async()=>{assertLive();await parent.refresh();await this.policyCurrent();
      if(['approve','revoke'].includes(a.action))await fresh();assertLive();}};
    assertLive();await parent.refresh();await this.policyCurrent();assertLive();
    if(parent.owner_id!==p.owner_id||parent.installation_id!==p.installation_id)fail('OWNER_FORBIDDEN',4,'Namespace belongs to another owner.');
    const old=(await this.store.snapshot()).operations.find(o=>o.request_id===a.request_id);
    assertLive();
    if(old){if(old.input_sha256!==hash)fail('IDEMPOTENCY_CONFLICT',5,'The request ID binds different input.');return {...await this.status(),outcome:old,replayed:true};}
    if(['create','recover-create'].includes(a.action))this.assertFirstProjectAuthority();
    // Claim the local action slot before yielding. Pause/revoke remain able to interrupt.
    const exclusive=['create','select','discover','import','inspect-create','recover-create','resume-drafts'].includes(a.action);
    if(exclusive&&this.busy)fail('WORKSPACE_BUSY',9,'Wait for the active namespace action.');
    if(exclusive)this.busy=true;
    try{
    if(['approve','revoke'].includes(a.action))await fresh();
    if(!['approve','revoke','pause','resume'].includes(a.action))await this.authority(parent);
    assertLive();if(['pause','revoke'].includes(a.action)){this.changed();epoch=this.epoch;}
    await this.store.update(s=>{
      assertLive();
      if(s.revision!==a.revision)fail('STALE_GENERATION',5,'Namespace changed. Refresh repository status.');
      if(s.revoked)fail('ACCESS_REVOKED',4,'This namespace authorization was permanently revoked.');
      const full=s.operations.length>=NAMESPACE_JOURNAL_CAPACITY;
      const terminal=a.action==='revoke'&&(s.operations.length===NAMESPACE_JOURNAL_CAPACITY||
        s.operations.length===NAMESPACE_JOURNAL_CAPACITY+1&&s.operations.at(-1)!.action==='pause');
      if(full&&!terminal&&!(a.action==='pause'&&s.operations.length===NAMESPACE_JOURNAL_CAPACITY))
        fail('NAMESPACE_STATE_UNAVAILABLE',9,'Namespace outcome history is full. Pause or revoke remains available; other work needs operator reconciliation.');
      if(a.action==='resume'&&!s.approved)fail('ACCESS_REVOKED',4,'Approve namespace access first.');
      if(a.action==='approve'&&(s.approved||a.scope_sha256!==namespacePolicyDigest(p)))fail('SCOPE_MISMATCH',4,'Approve the exact displayed namespace scope once.');
      if((a.action==='create'||a.action==='import')&&(s.projects.length>=p.max_projects||s.projects.some(r=>r.name===a.name)||s.operations.some(o=>o.action==='create'&&o.repository_name===a.name&&o.phase!=='failed')))
        fail('PROJECT_EXISTS',5,'That repository name is already retained or capacity is full. Inspect its outcome.');
      if(a.action==='select'&&!s.projects.some(r=>r.id===a.repository_id&&r.state==='ready'))
        fail('WRITER_IMPORT_REQUIRED',4,'This repository has no complete Studio project state on this installation. Choose Open and import in the repository selector first.');
      s.operations.push({request_id:a.request_id,input_sha256:hash,action:a.action,phase:exclusive?'pending':'completed',code:null,
        repository_id:['select','import'].includes(a.action)?(a as any).repository_id:null,repository_name:['create','import'].includes(a.action)?(a as any).name:null});s.revision++;
      if(a.action==='approve'){s.approved=true;s.connected=true;}
      if(a.action==='pause')s.connected=false;
      if(a.action==='resume')s.connected=true;
      if(a.action==='revoke'){s.revoked=true;s.connected=false;}
      if(!exclusive)s.selection_epoch++;
    },publication);
    if(!exclusive)this.changed();
    let discovered:Awaited<ReturnType<NamespaceProvider['list']>>|undefined;
    let recovery:{source_request_id:string;repository:Awaited<ReturnType<NamespaceProvider['unfinished']>>;can_finish:boolean}|undefined;
    try{
      const operationId=digest({lineage:p.lineage_id,request:a.request_id});
      if(a.action==='discover')discovered=await this.provider.list(await this.lease(parent,operationId),a.search,a.cursor);
      if(a.action==='resume-drafts'){
        const current=await this.store.snapshot(),project=current.projects.find(r=>r.id===a.repository_id&&r.state==='ready'&&r.id===current.selected_repository_id);
        if(!project||!this.resumeDrafts)fail('PROJECT_FORBIDDEN',4,'Open this repository before resuming draft saving.');
        await this.resumeDrafts(project,parent,await this.lease(parent,operationId,project.project_id));
      }
      if(a.action==='inspect-create'||a.action==='recover-create'){
        const current=await this.store.snapshot(),original=current.operations.find(o=>o.request_id===a.source_request_id&&o.action==='create');
        if(!original||original.phase!=='uncertain'||!original.repository_name)
          fail('CREATION_CHANGED',5,'Refresh repository status. This creation no longer needs recovery.');
        const lease=await this.lease(parent,operationId,undefined,false,a.action==='recover-create'),repository=await this.provider.unfinished(lease,original.repository_name);
        const registered=current.projects.some(r=>r.creation_id===original.request_id||r.name===original.repository_name);
        recovery={source_request_id:original.request_id,repository,can_finish:!!repository?.empty&&!repository.read_only&&!registered&&(!original.repository_id||original.repository_id===repository.id)};
        if(a.action==='inspect-create'&&!repository){await lease.refresh();await this.store.update(s=>{lease.assertSync();const o=s.operations.find(o=>o.request_id===original.request_id)!;o.phase='failed';o.code='REPOSITORY_NOT_FOUND';s.revision++;},{assertLive:lease.assertSync,refresh:lease.refresh});}
        if(a.action==='recover-create'){
          if(!recovery.can_finish||!repository||repository.id!==a.repository_id||current.projects.length>=p.max_projects)
            fail('CREATION_CHANGED',5,'The repository is no longer empty or its identity changed. Refresh its status; existing content is preserved.');
          const {empty,...metadata}=repository;
          const project:NamespaceProject={...metadata,project_id:'project-'+randomUUID(),creation_id:original.request_id,state:'created',genesis_sha256:null,automatic_token_expires_at:null};
          await lease.refresh();await this.store.update(s=>{lease.assertSync();s.projects.push(project);s.operations.find(o=>o.request_id===original.request_id)!.repository_id=project.id;},{assertLive:lease.assertSync,refresh:lease.refresh});
          await lease.refresh();lease.assertSync();
          const genesis=await this.initialize(project,a.purpose,{...parent,assertLive:lease.assertSync,refresh:lease.refresh});
          await lease.refresh();await this.store.update(s=>{lease.assertSync();const retained=s.projects.find(r=>r.id===project.id)!;retained.state='ready';retained.genesis_sha256=genesis;
            const o=s.operations.find(o=>o.request_id===original.request_id)!;o.phase='completed';o.code=null;
            s.selected_repository_id=project.id;s.selection_epoch++;s.revision++;},{assertLive:lease.assertSync,refresh:lease.refresh});this.changed();
        }
      }
      if(a.action==='select'){
        const project=(await this.store.snapshot()).projects.find(r=>r.id===a.repository_id)!;
        const lease=await this.lease(parent,operationId),verified=await this.provider.info(lease,project.name);
        if(verified.id!==project.id||verified.name!==project.name||verified.read_only){this.changed();fail('REPOSITORY_ID_MISMATCH',4,'Selected repository identity or writable state changed.');}
        await lease.refresh();await this.store.update(s=>{lease.assertSync();s.selected_repository_id=project.id;s.selection_epoch++;this.changed();});
      }
      if(a.action==='import'){
        if(!this.importProject)fail('UNSUPPORTED_CAPABILITY',8,'Repository import is unavailable.');
        const lease=await this.lease(parent,operationId),repository=await this.provider.info(lease,a.name);
        if(repository.id!==a.repository_id||repository.read_only)fail('REPOSITORY_ID_MISMATCH',4,'Repository identity changed or Cloudflare marks the repository read only.');
        const supplied=a.index??(await this.indexes()).find(i=>i.repository_id===repository.id);
        if(!supplied)fail('WRITER_IMPORT_REQUIRED',4,'Choose a Strata project index JSON file for this repository.');
        const index=admitIndex(supplied,repository,p);
        const project:NamespaceProject={...repository,project_id:index.registry.storage.project_id,creation_id:a.request_id,state:'ready',automatic_token_expires_at:null,model_version:index.model_version,origin:'import',genesis_sha256:null};
        const genesis=await this.importProject(project,index,lease);
        const verified=await this.provider.info(lease,a.name);
        if(verified.id!==repository.id||verified.read_only)fail('REPOSITORY_ID_MISMATCH',4,'Repository identity changed during import.');
        await lease.refresh();await this.store.update(s=>{lease.assertSync();
          if(s.projects.some(r=>r.id===project.id||r.project_id===project.project_id))fail('PROJECT_EXISTS',5,'That project is already open in Studio. Select it from the repository list.');
          project.genesis_sha256=genesis;s.projects.push(project);s.selected_repository_id=project.id;s.selection_epoch++;s.revision++;
        },{assertLive:lease.assertSync,refresh:lease.refresh});this.changed();
      }
      if(a.action==='create'){
        const lease=await this.lease(parent,operationId,undefined,false,true);
        const created=await this.provider.create({...lease,beforeCreateDispatch:()=>this.store.update(s=>{s.operations.find(o=>o.request_id===a.request_id)!.phase='uncertain';})},a.name);
        const project:NamespaceProject={...created,project_id:'project-'+randomUUID(),creation_id:a.request_id,state:'created',genesis_sha256:null};
        await lease.refresh();await this.store.update(s=>{lease.assertSync();
          if(s.projects.some(r=>r.id===project.id))fail('REPOSITORY_ID_MISMATCH',4,'Creation returned an already registered repository identity. Inspect the retained outcome.');
          s.projects.push(project);s.operations.find(o=>o.request_id===a.request_id)!.repository_id=project.id;});
        await lease.refresh();lease.assertSync();
        const genesis=await this.initialize(project,a.purpose,{...parent,assertLive:lease.assertSync,refresh:lease.refresh});
        await lease.refresh();await this.store.update(s=>{lease.assertSync();const retained=s.projects.find(r=>r.id===project.id)!;retained.state='ready';retained.genesis_sha256=genesis;
          s.selected_repository_id=project.id;s.selection_epoch++;s.revision++;});this.changed();
      }
      if(exclusive)await this.store.update(s=>{s.operations.find(o=>o.request_id===a.request_id)!.phase='completed';});
    }catch(e:any){await this.store.update(s=>{const receipt=s.operations.find(o=>o.request_id===a.request_id)!;
      receipt.phase=a.action==='create'&&receipt.phase==='uncertain'?'uncertain':'failed';receipt.code=/^[A-Z_]{1,128}$/.test(e?.code??'')?e.code:'NAMESPACE_ACTION_FAILED';});throw e;
    }
    return {...await this.status(),...(discovered?{discovery:discovered}:{}),...(recovery?{recovery}:{}),outcome:(await this.store.snapshot()).operations.find(o=>o.request_id===a.request_id),replayed:false};
    }finally{if(exclusive)this.busy=false;}
  }
}
