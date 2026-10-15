import { z } from 'zod';
import { readFile, mkdir, open, rename, unlink, rmdir, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from './core.js';
import { parse, digest, bytesDigest, canonical, fail } from './model.js';
import { noLinks } from './node-state.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import { createSourceHostProof, executeSourceBinding, type SourceScope } from './source-binding.js';
import { createDriftHostProof, type DriftHostProof } from './source-drift.js';
import { executeDrift } from './reconciliation.js';
import { gitPins, gitOid, gitPath, uniqueGitPaths, requireCleanGit, captureGitSource, verifyGitSource, worktreeBytes, readGitTree, blobBytes, runGit, decodeGit, identifyGitHost, materializeGitTree, type GitHost } from './git-workspace.js';
import { stageGitPatch, type FileOperation, type FileState } from './git-patch.js';
import { GIT_ADOPTION_SCHEMAS, GIT_OPERATIONS, createGitPlan, createGitReview, registerGitAcceptance, verifyGitApply, verifyGitAcceptance, verifyGitBridgeReview, readGitPlan, gitBinding, gitStore, type GitPlan, type GitStage } from './git-adoption.js';
import { isBridgedPlan, authorizeGitBridge, authorizeGitBridgeEvidence, authorizeGitBridgeReviewer, verifyGitBridgeStage, type GitBridge } from './adoption/git-bridge.js';
import { checkGitApplication } from './git-application-checker.js';
import { executeAuthorized } from './service.js';
import { executeAdoption, adoptionContext, publicationGate } from './adoption/persistent.js';
import { adoptionRequired, exactAdoptionProposal } from './adoption/records.js';
import { validateCommandInput } from './commands/contract.js';

export type GitNodeConfig = { repositories: GitHost[]; directory: string; enabledCheckers?: string[]; afterWriteForTest?: (count:number,root:string)=>Promise<void>; afterJournalForTest?:()=>Promise<void> };
type Journal = { format:'git-transaction/1';transaction_id:string;repo_id:string;host_identity:string;stage_ref:string;review_ref:string;receipt_ref:string|null;state:'writing'|'written'|'committed'|'rollback'|'rolled_back'|'recovery_required';operations:FileOperation[];created_directories:string[];base_commit:string;base_tree:string;base_index_digest:string };
const ref=z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema=z.object({format:z.literal('git-transaction/1'),transaction_id:hash,repo_id:z.string().min(1),host_identity:hash,stage_ref:ref,review_ref:ref,receipt_ref:ref.nullable(),state:z.enum(['writing','written','committed','rollback','rolled_back','recovery_required']),operations:GIT_ADOPTION_SCHEMAS['git-patch-stage'].shape.operations,created_directories:z.array(z.string()).max(256),base_commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),base_tree:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),base_index_digest:hash}).strict();
async function exists(file:string){try{await lstat(file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function durableJson(file:string,value:unknown){await noLinks(file);const tmp=file+'.tmp';await noLinks(tmp);const h=await open(tmp,'w');try{await h.writeFile(canonical({sha256:digest(value),journal:value}));await h.sync();}finally{await h.close();}await rename(tmp,file);}
function stateMatches(bytes:Uint8Array|null,state:FileState){return (bytes===null?null:bytesDigest(bytes))===state.sha256;}
async function replaceFile(root:string,name:string,state:FileState,transaction:string){
  gitPath(name);
  const file=await noLinks(path.join(root,name));
  if(state.content===null){await unlink(file);return;}
  const tmp=file+'.strata-'+transaction.slice(0,12)+'.tmp';await noLinks(tmp);
  const old=await lstat(file).catch(()=>null),h=await open(tmp,'wx',old?.mode??(state.mode==='100755'?0o755:0o644));
  try{await h.writeFile(state.content);await h.sync();}finally{await h.close();}
  try{await rename(tmp,file);}catch(e){await unlink(tmp).catch(()=>{});throw e;}
}
export class GitNodeAdapter {
  private readonly hosts=new Map<string,GitHost>();
  private readonly leases=new Map<string,{repo:string;file:string}>();
  constructor(readonly config:GitNodeConfig,readonly projectId:string,readonly stateDirectory?:string){for(const host of config.repositories){if(host.projectId!==projectId||this.hosts.has(host.repoId))fail('REPOSITORY_BINDING',4,'Host repositories must be unique and project-bound.');this.hosts.set(host.repoId,{...host});}}
  async initialize(){await noLinks(this.config.directory);await mkdir(this.config.directory,{recursive:true});for(const [id,host] of this.hosts){const identity=await identifyGitHost(host);for(const location of [this.config.directory,this.stateDirectory].filter(Boolean) as string[]){const relative=path.relative(identity.root,path.resolve(location));if(!relative.startsWith('..')&&!path.isAbsolute(relative))fail('REPOSITORY_BINDING',4,'Intent state, Git state and private checkouts must be outside the application repository.');}this.hosts.set(id,{...host,root:identity.root,identity:identity.identity});}}
  host(repoId:string){const host=this.hosts.get(repoId);if(!host)fail('REPOSITORY_FORBIDDEN',4,'Repository is not configured on this Node host.');return host;}
  journalPath(repo:string){return path.join(this.config.directory,'transaction-'+digest({project:this.projectId,repo})+'.json');}
  async journal(repo:string):Promise<Journal|null>{const file=this.journalPath(repo);await noLinks(file);try{const stats=await lstat(file);if(stats.size>1024*1024)fail('GIT_RECOVERY_REQUIRED',5,'Journal exceeds its byte bound.');const envelope=JSON.parse(await readFile(file,'utf8'));const j:Journal=parse(journalSchema,envelope.journal);if(!j||digest(j)!==envelope.sha256||j.format!=='git-transaction/1'||j.repo_id!==repo||!Array.isArray(j.operations)||j.operations.length>64||!hash.safeParse(j.transaction_id).success)fail('GIT_RECOVERY_REQUIRED',5,'Journal is corrupt or incompatible.');uniqueGitPaths(j.operations.map(o=>o.path));j.created_directories.forEach(name=>{gitPath(name);if(!j.operations.some(o=>o.path.startsWith(name+'/')))fail('GIT_RECOVERY_REQUIRED',5,'Journal directories must be ancestors of changed paths.');});let size=0;for(const o of j.operations)for(const s of [o.before,o.after]){size+=s.content===null?0:Buffer.byteLength(s.content);if((s.content===null?null:bytesDigest(s.content))!==s.sha256)fail('GIT_RECOVERY_REQUIRED',5,'Journal file state hash differs.');}if(size>512*1024)fail('GIT_RECOVERY_REQUIRED',5,'Journal exceeds retained content bounds.');return j;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
  async acquire(repo:string,operation:string){const file=this.journalPath(repo)+'.lock';await noLinks(file);let handle;try{handle=await open(file,'wx');}catch{fail('GIT_BUSY',5,'Another Strata transaction holds this repository lease.');}try{await handle.writeFile(canonical({transaction_id:operation,pid:process.pid}));await handle.sync();}finally{await handle.close();}this.leases.set(operation,{repo,file});}
  async release(operation:string){const lease=this.leases.get(operation);if(lease){await unlink(lease.file);this.leases.delete(operation);}}
  async assertIdle(repo:string){const j=await this.journal(repo);if(j&&!['committed','rolled_back'].includes(j.state))fail('GIT_RECOVERY_REQUIRED',5,'An unfinished filesystem transaction requires explicit recovery.',{transaction_id:j.transaction_id,state:j.state});}
  journalStage(engine:Engine,j:Journal){const stage:GitStage=engine.read(j.stage_ref,'git-patch-stage'),plan:GitPlan=engine.read(stage.plan_ref,'git-change-plan'),{source}=gitBinding(engine,plan.binding_ref),review=engine.read(j.review_ref,'git-apply-review');if(stage.project_id!==this.projectId||stage.repo_id!==j.repo_id||j.base_commit!==source.head_commit||j.base_tree!==source.head_tree||j.base_index_digest!==stage.base_index_digest||canonical(stage.operations)!==canonical(j.operations)||!review.accepted||review.target.stage_ref!==j.stage_ref||review.target.stage_sha256!==digest(stage)||digest(review.target)!==review.target_sha256)fail('GIT_RECOVERY_REQUIRED',5,'Journal differs from immutable reviewed source and stage closure.');return stage;}
  async pendingMarker(){if(!this.stateDirectory)return;const pending=[];for(const repo of this.hosts.keys()){const j=await this.journal(repo);if(j&&!['committed','rolled_back'].includes(j.state))pending.push({repo_id:repo,transaction_id:j.transaction_id,state:j.state});}const file=path.join(this.stateDirectory,'GIT_APPLY_PENDING.json');if(pending.length)await durableJson(file,{pending});else await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  async sourceProof(engine:Engine,command:string,input:any,context:SecurityContext,issuer:AuthorityIssuer){
    const repo=command==='source.capture'?input.repo_id:input.payload?.repo_id,host=this.host(repo),scope:SourceScope=command==='source.capture'?input.scope:engine.read(input.payload.source_ref,'source-snapshot').scope;
    issuer.assertRepository(context,command,repo,scope.paths);
    const fresh=await captureGitSource(host,scope,{mode:'baseline',expectedHead:command==='source.capture'?input.expected_head:engine.read(input.payload.source_ref,'source-snapshot').head_commit,authorizePath:name=>issuer.assertRepository(context,command,repo,[name])});
    return createSourceHostProof(fresh.snapshot,fresh.observation);
  }
  async verifyApplied(host:GitHost,stage:GitStage,base:{head_commit:string;head_tree:string;index_digest:string}){
    const pins=await gitPins(host);if(pins.head_commit!==base.head_commit||pins.head_tree!==base.head_tree||pins.index_digest!==base.index_digest)fail('STALE_SOURCE',5,'HEAD or index changed during apply.');
    const tree=await readGitTree(host.root,base.head_tree);
    for(const entry of tree){const op=stage.operations.find(o=>o.path===entry.path),bytes=await worktreeBytes(host.root,entry.path);if(op){if(!stateMatches(bytes,op.after))fail('SOURCE_SNAPSHOT_STALE',5,'Applied file changed.',{path:entry.path});}else{const raw=await blobBytes(host.root,entry);if(!bytes||!raw||bytesDigest(bytes)!==bytesDigest(raw))fail('SOURCE_SNAPSHOT_STALE',5,'Unrelated file changed during apply.',{path:entry.path});}}
    for(const op of stage.operations)if(!stateMatches(await worktreeBytes(host.root,op.path),op.after))fail('SOURCE_SNAPSHOT_STALE',5,'Applied file postimage differs.',{path:op.path});
    const untracked=decodeGit(await runGit(host.root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean),allowed=stage.operations.filter(o=>o.before.content===null&&o.after.content!==null).map(o=>o.path);
    if(untracked.some(p=>!allowed.includes(p)))fail('SOURCE_SNAPSHOT_STALE',5,'Unrelated untracked files appeared during apply.');
  }
  async rollback(repo:string){
    const journal=await this.journal(repo);if(!journal||journal.state==='committed'||journal.state==='rolled_back')return;
    const host=this.host(repo);if((await identifyGitHost(host)).identity!==journal.host_identity)fail('REPOSITORY_BINDING',4,'Recovery repository identity changed.');
    journal.state='rollback';await durableJson(this.journalPath(repo),journal);const blockers:string[]=[];
    for(const op of [...journal.operations].reverse()){
      try{const tmp=path.join(host.root,op.path)+'.strata-'+journal.transaction_id.slice(0,12)+'.tmp';if(await exists(tmp)){await noLinks(tmp);const stats=await lstat(tmp);if(!stats.isFile()||stats.size>512*1024||!stateMatches(await readFile(tmp),op.after)){blockers.push(op.path);continue;}await unlink(tmp);}const bytes=await worktreeBytes(host.root,op.path);if(stateMatches(bytes,op.before))continue;if(!stateMatches(bytes,op.after)){blockers.push(op.path);continue;}if(op.before.content!==null)await mkdir(path.dirname(path.join(host.root,op.path)),{recursive:true});await replaceFile(host.root,op.path,op.before,journal.transaction_id);}
      catch{blockers.push(op.path);}
    }
    for(const name of [...journal.created_directories].reverse())await rmdir(path.join(host.root,name)).catch(()=>{});
    journal.state=blockers.length?'recovery_required':'rolled_back';await durableJson(this.journalPath(repo),journal);await this.pendingMarker();
    if(blockers.length)fail('GIT_RECOVERY_REQUIRED',5,'Rollback preserved files changed by another writer; reconcile them explicitly.',{paths:blockers});
  }
  async committed(operationId:string,engine:Engine){try{for(const repo of this.hosts.keys()){const j=await this.journal(repo);if(j?.transaction_id===operationId&&j.state==='written'){const receipt=Object.entries(engine.records).find(([,r])=>r.type==='git-apply-receipt'&&r.data.transaction_id===operationId);if(!receipt)fail('GIT_RECOVERY_REQUIRED',5,'Durable apply receipt is missing.');j.receipt_ref=receipt[0];j.state='committed';await durableJson(this.journalPath(repo),j);}}await this.pendingMarker();}finally{await this.release(operationId);}}
  async abort(operationId:string){if(!this.leases.has(operationId))return;try{for(const repo of this.hosts.keys()){const j=await this.journal(repo);if(j?.transaction_id===operationId&&j.state!=='committed')await this.rollback(repo);}}finally{await this.release(operationId);}}
  async adoptionProof(engine:Engine,draftRef:string,context:SecurityContext,issuer:AuthorityIssuer){
    const layer=engine.read(draftRef,'layer',false),prepared=adoptionContext(engine,exactAdoptionProposal(engine.records,layer).ref),source=prepared.source;
    issuer.assertRepository(context,'layer.publish',source.repo_id,source.entries.map(entry=>entry.path));
    const fresh=await captureGitSource(this.host(source.repo_id),source.scope,{mode:'baseline',expectedHead:source.head_commit,authorizePath:name=>issuer.assertRepository(context,'layer.publish',source.repo_id,[name])});
    return createSourceHostProof(fresh.snapshot,fresh.observation);
  }
  bridgePlan(engine:Engine,command:string,input:any,data?:any):GitPlan|undefined{
    let planRef:string|undefined;
    if(command==='git.plan')return data?.record;
    if(command==='git.stage')planRef=input.plan;
    else if(['git.check','git.evidence','git.review','git.apply'].includes(command))planRef=engine.read(input.stage??input.stage_ref,'git-patch-stage').plan_ref;
    else if(command==='git.finalize')planRef=engine.read(input.receipt,'git-apply-receipt').plan_ref;
    else if(command==='source.bind'&&input.payload?.completion_ref){const completion=engine.read(input.payload.completion_ref,'git-finalization');planRef=engine.read(completion.receipt_ref,'git-apply-receipt').plan_ref;}
    return planRef?readGitPlan(engine,planRef):undefined;
  }
  async bridgeBaseline(engine:Engine,bridge:GitBridge,context:SecurityContext,issuer:AuthorityIssuer){
    for(const pin of [bridge.inventory_source,bridge.binding_source]){
      const source=engine.read(pin.ref,'source-snapshot');issuer.assertRepository(context,'source.capture',source.repo_id,source.scope.paths);
      const fresh=await captureGitSource(this.host(source.repo_id),source.scope,{mode:'baseline',expectedHead:source.head_commit,authorizePath:name=>issuer.assertRepository(context,'source.capture',source.repo_id,[name])});
      if(digest(fresh.snapshot)!==pin.sha256||fresh.observation.manifest_sha256!==source.manifest_sha256)fail('SOURCE_SNAPSHOT_STALE',5,'Bridge baseline source moved before delivery advancement.');
      if(pin.ref===bridge.binding_source.ref)for(const entry of source.entries){
        issuer.assertRepository(context,'source.capture',source.repo_id,[entry.path]);
        const bytes=await worktreeBytes(this.host(source.repo_id).root,entry.path);
        if(!bytes||bytesDigest(bytes)!==entry.sha256)fail('SOURCE_SNAPSHOT_STALE',5,'Adopted source changed during its finite text proof.');
        let text:string;try{text=decodeGit(bytes);}catch{fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'Adopted files and dependencies must be UTF-8 text.');}
        if(text.includes('\0'))fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'Binary adopted files or dependencies are outside the finite bridge.');
        issuer.assertLive(context);
      }
      issuer.assertLive(context);
    }
  }
  async bridgePostimage(engine:Engine,plan:GitPlan,stage:GitStage,context:SecurityContext,issuer:AuthorityIssuer,commit?:string){
    if(!isBridgedPlan(plan))return;
    const source=engine.read(plan.adoption_bridge.inventory_source.ref,'source-snapshot'),expected=source.entries.map((entry:any)=>{const op=stage.operations.find(o=>o.path===entry.path);return op?{...entry,mode:op.after.mode,byte_length:Buffer.byteLength(op.after.content!),sha256:op.after.sha256}:entry;});
    issuer.assertRepository(context,'source.capture',plan.repo_id,source.scope.paths);
    const fresh=await captureGitSource(this.host(plan.repo_id),source.scope,{mode:commit?'baseline':'observation',expectedHead:commit??source.head_commit,authorizePath:name=>issuer.assertRepository(context,'source.capture',plan.repo_id,[name])});
    if(canonical(fresh.observation.entries)!==canonical(expected)||fresh.observation.coherence!=='stable'||fresh.observation.unsupported.length||fresh.observation.outside_scope_dirty||fresh.observation.status.some(row=>row.path!=='counter.mjs'||row.staged))fail('SOURCE_SNAPSHOT_STALE',5,'Bridge broad source must retain the exact module postimage and every preserved file.');
    if(commit&&fresh.snapshot.head_tree!==stage.result_tree_oid)fail('FINALIZATION_MISMATCH',5,'Bridge owner commit differs from the reviewed full result tree.');
    issuer.assertLive(context);
  }
  /** No awaits: repeat original retained grants and the acting assignment at the
   * caller's final native/publication boundary without rewriting provenance. */
  bridgeAuthorityGate(engine:Engine,command:string,input:any,context:SecurityContext,issuer:AuthorityIssuer,data?:any){
    const plan=this.bridgePlan(engine,command,input,data);if(!plan||!isBridgedPlan(plan))return false;
    const actingExpiry=context.expires_at?Date.parse(context.expires_at):null;
    if(actingExpiry!==null&&(!Number.isFinite(actingExpiry)||actingExpiry<=issuer.time()))fail('ACCESS_REVOKED',4,'The exact acting bridge grant has expired.');
    issuer.authorize(context,command,input,engine);
    authorizeGitBridge(engine,plan,context,issuer,command==='git.plan');
    if(data?.record?.format==='git-acceptance/2')authorizeGitBridgeEvidence(engine,plan,data.record,issuer);
    if(command==='git.review'){
      const acceptance=engine.read(input.acceptance,'git-acceptance');verifyGitAcceptance(engine,input.stage,acceptance);
      authorizeGitBridgeEvidence(engine,plan,acceptance,issuer);
      if(data?.record?.format==='git-apply-review/2'){verifyGitBridgeReview(engine,plan,data.record,acceptance);authorizeGitBridgeReviewer(engine,plan,data.record.target.reviewer,issuer);}
    }
    if(command==='git.apply'||command==='git.finalize'||command==='source.bind'){
      const receipt=command==='git.finalize'?engine.read(input.receipt,'git-apply-receipt'):command==='source.bind'?engine.read(engine.read(input.payload.completion_ref,'git-finalization').receipt_ref,'git-apply-receipt'):undefined;
      const stageRef=receipt?.stage_ref??input.stage,reviewRef=receipt?.review_ref??input.review,stage:GitStage=engine.read(stageRef,'git-patch-stage'),review=engine.read(reviewRef,'git-apply-review'),acceptance=engine.read(review.target.acceptance_ref,'git-acceptance');
      verifyGitAcceptance(engine,stageRef,acceptance);verifyGitBridgeReview(engine,plan,review,acceptance);
      if(!review.accepted||review.target.stage_ref!==stageRef||review.target.plan_ref!==stage.plan_ref||review.target.stage_sha256!==digest(stage)||review.target.acceptance_sha256!==digest(acceptance)||review.target_sha256!==digest(review.target)||review.target.policy_version!==context.policy_version)fail('STALE_APPROVAL',6,'Bridge delivery review is stale or differs from its exact stage and acceptance.');
      authorizeGitBridgeEvidence(engine,plan,acceptance,issuer);authorizeGitBridgeReviewer(engine,plan,review.target.reviewer,issuer);
      const release=engine.read(review.target.release_ref,'release');for(const ref of release.approvals??[])if(!issuer.active(engine.read(ref,'approval').principal))fail('ENDORSEMENT_REVOKED',6,'A semantic Release endorser is no longer active for bridge delivery.');
    }
    return true;
  }
  async bridgeGate(engine:Engine,command:string,input:any,context:SecurityContext,issuer:AuthorityIssuer,data?:any,applied=false){
    const plan=this.bridgePlan(engine,command,input,data);if(!plan||!isBridgedPlan(plan))return;
    this.bridgeAuthorityGate(engine,command,input,context,issuer,data);
    if(!applied&&['git.stage','git.apply'].includes(command))await this.assertIdle(plan.repo_id);
    if(command==='git.apply'||command==='git.finalize'||command==='source.bind'){
      const receipt=command==='git.finalize'?engine.read(input.receipt,'git-apply-receipt'):command==='source.bind'?engine.read(engine.read(input.payload.completion_ref,'git-finalization').receipt_ref,'git-apply-receipt'):undefined;
      const stage:GitStage=engine.read(receipt?.stage_ref??input.stage,'git-patch-stage');
      if(command==='git.finalize'||command==='source.bind')await this.bridgePostimage(engine,plan,stage,context,issuer,command==='git.finalize'?input.commit:engine.read(input.payload.completion_ref,'git-finalization').head_commit);
      else if(applied)await this.bridgePostimage(engine,plan,stage,context,issuer);
      else await this.bridgeBaseline(engine,plan.adoption_bridge,context,issuer);
    }else await this.bridgeBaseline(engine,plan.adoption_bridge,context,issuer);
    this.bridgeAuthorityGate(engine,command,input,context,issuer,data);
  }
  async recheck(engine:Engine,command:string,input:any,context:SecurityContext,issuer:AuthorityIssuer,data?:any){
    await this.bridgeGate(engine,command,input,context,issuer,data,command==='git.apply');
    if(command==='layer.publish'&&adoptionRequired(engine.records,engine.read(input.ref,'layer',false))){
      if(!data?.adoption_publication_ref)fail('ADOPTION_REVIEW_REQUIRED',6,'Publication lacks its retained gate receipt.');
      publicationGate(engine,input.ref,input.adoption_review,context,issuer,await this.adoptionProof(engine,input.ref,context,issuer),engine.read(data.adoption_publication_ref,'adoption-publication',false));
    }
    if(command==='source.capture'||command==='source.bind'){executeSourceBinding(engine,command,input,context,issuer,await this.sourceProof(engine,command,input,context,issuer));}
    if(command==='git.apply'){const {stage,source}=verifyGitApply(engine,input.stage,input.review,context,issuer);await this.verifyApplied(this.host(stage.repo_id),stage,{head_commit:source.head_commit,head_tree:source.head_tree,index_digest:stage.base_index_digest});}
    if(command==='git.finalize')await this.execute(engine,command,input,context,issuer,false,'');
    if(command==='git.stage'){const stage=Object.values(engine.records).find(r=>r.type==='git-patch-stage'&&r.data.plan_ref===input.plan&&r.data.patch===input.patch)?.data;if(stage){const plan=engine.read(input.plan,'git-change-plan'),{source}=gitBinding(engine,plan.binding_ref);if(!(await verifyGitSource(this.host(plan.repo_id),source,{requireClean:true})).matches)fail('SOURCE_SNAPSHOT_STALE',5,'Source moved before stage publication.');}}
    if(command==='drift.review'&&input.decision==='approve_plan')executeDrift(engine,command,input,context,issuer,await this.driftProof(engine,command,input,context,issuer));
    this.bridgeAuthorityGate(engine,command,input,context,issuer,data);
  }
  async driftProof(engine:Engine,command:string,input:any,context:SecurityContext,issuer:AuthorityIssuer):Promise<DriftHostProof|undefined>{
    if(command==='drift.check'&&input.imported_observation)return undefined;
    if(command==='drift.review'&&input.decision!=='approve_plan')return undefined;
    let bindingRef=input.binding_ref;if(command==='drift.review'){const proposal=engine.read(input.proposal_ref,'reconciliation-proposal');bindingRef=proposal.binding_ref;}if(command==='drift.propose')return undefined;
    const {source}=gitBinding(engine,bindingRef);issuer.assertRepository(context,command,source.repo_id,source.scope.paths);const fresh=await captureGitSource(this.host(source.repo_id),source.scope,{mode:'observation',authorizePath:name=>issuer.assertRepository(context,command,source.repo_id,[name])});return createDriftHostProof(fresh.observation);
  }
  async cached(command:string,input:any,data:any,engine:Engine,context:SecurityContext,issuer:AuthorityIssuer){
    await this.checkCached(command,input,data,engine,context,issuer);
    this.bridgeAuthorityGate(engine,command,input,context,issuer,data);
  }
  private async checkCached(command:string,input:any,data:any,engine:Engine,context:SecurityContext,issuer:AuthorityIssuer){
    await this.bridgeGate(engine,command,input,context,issuer,data,command==='git.apply');
    if(command==='layer.publish'){await this.recheck(engine,command,input,context,issuer,data);return;}
    if(command==='adoption.prepare'){const prepared=adoptionContext(engine,data.ref);issuer.assertRepository(context,command,prepared.source.repo_id,prepared.source.entries.map(entry=>entry.path));if(engine.ownerHeads[prepared.layer.id]?.head!==prepared.layer.revision||prepared.layer.owner!==context.principal_id)fail('STALE_REVISION',5,'Cached adoption proposal is no longer the current owned head.');return;}
    if(command==='adoption.review'){const review=engine.read(data.ref,'adoption-review',false),prepared=adoptionContext(engine,review.proposal_ref);issuer.assertRepository(context,command,prepared.source.repo_id,prepared.source.entries.map(entry=>entry.path));if(review.policy_version!==context.policy_version||review.authority_sha256!==issuer.accessBinding()||engine.ownerHeads[prepared.layer.id]?.head!==prepared.layer.revision||prepared.layer.owner!==context.principal_id)fail('STALE_ADOPTION_REVIEW',6,'Cached interpretation review is no longer current.');return;}
    if(command.startsWith('drift.')){const fresh=executeDrift(engine,command,input,context,issuer,await this.driftProof(engine,command,input,context,issuer));if(command==='drift.check'&&digest(fresh)!==digest(data))fail('SOURCE_SNAPSHOT_STALE',5,'Cached drift report differs from current source observations.');return;}
    if(command==='source.bind'||command==='git.finalize'){await this.recheck(engine,command,input,context,issuer);return;}
    if(command==='source.capture'){const snapshot=engine.read(data.ref,'source-snapshot'),fresh=await this.sourceProof(engine,command,input,context,issuer);const captured=executeSourceBinding(engine,command,input,context,issuer,fresh);if(captured.ref!==data.ref)fail('SOURCE_SNAPSHOT_STALE',5,'Cached source capture no longer matches current bytes.');return;}
    if(command==='git.plan'){if(!isBridgedPlan(data?.record))createGitPlan(engine,input,context,issuer);return;}
    if(command==='git.evidence'){registerGitAcceptance(engine,input,context,issuer);return;}
    if(command==='git.review'){
      if(data?.record?.format==='git-apply-review/2'){
        const review=engine.read(data.ref,'git-apply-review'),plan=readGitPlan(engine,review.target.plan_ref),acceptance=engine.read(review.target.acceptance_ref,'git-acceptance');
        verifyGitAcceptance(engine,review.target.stage_ref,acceptance);verifyGitBridgeReview(engine,plan,review,acceptance);
        authorizeGitBridgeEvidence(engine,plan,acceptance,issuer);authorizeGitBridgeReviewer(engine,plan,review.target.reviewer,issuer);
        if(review.principal!==context.principal_id||review.target.policy_version!==context.policy_version||review.target_sha256!==input.expected_target_sha256)fail('STALE_APPROVAL',6,'Cached bridge review requires its exact original target and current policy.');
      }else createGitReview(engine,input,context,issuer,false);
      return;
    }
    if(command==='git.stage'||command==='git.check'){const stage:GitStage=engine.read(command==='git.stage'?data.ref:input.stage,'git-patch-stage'),plan:GitPlan=engine.read(stage.plan_ref,'git-change-plan'),{source}=gitBinding(engine,plan.binding_ref);issuer.assertRepository(context,command,plan.repo_id,plan.write_paths,command==='git.check'?plan.checker.id:undefined);if(command==='git.stage'&&!(await verifyGitSource(this.host(plan.repo_id),source,{requireClean:true})).matches)fail('SOURCE_SNAPSHOT_STALE',5,'Cached patch stage no longer matches current source.');if(command==='git.check')issuer.assertGitEvidence(context,engine.read(data.ref,'git-acceptance').results);return;}
    if(command==='git.transaction.recover'){issuer.assertRepository(context,command,input.repo_id,data.paths);const j=await this.journal(input.repo_id);if(j?.transaction_id!==data.transaction_id||j?.state!==data.state)fail('GIT_RECOVERY_REQUIRED',5,'Cached recovery receipt no longer describes this transaction.');return;}
    if(command!=='git.apply')return;
    verifyGitApply(engine,input.stage,input.review,context,issuer);
    const receipt=engine.read(data.ref,'git-apply-receipt'),stage:GitStage=engine.read(receipt.stage_ref,'git-patch-stage');issuer.assertRepository(context,command,receipt.repo_id,receipt.paths);
    const j=await this.journal(receipt.repo_id);if(!j||j.transaction_id!==receipt.transaction_id)fail('GIT_RECOVERY_REQUIRED',5,'Apply retry has no matching local transaction journal.');
    this.journalStage(engine,j);if(j.stage_ref!==receipt.stage_ref||j.review_ref!==receipt.review_ref)fail('GIT_RECOVERY_REQUIRED',5,'Cached receipt differs from the journal review.');
    await this.verifyApplied(this.host(receipt.repo_id),stage,{head_commit:j.base_commit,head_tree:j.base_tree,index_digest:j.base_index_digest});
    this.bridgeAuthorityGate(engine,command,input,context,issuer,data);
    if(j.state==='written'){j.state='committed';j.receipt_ref=data.ref;await durableJson(this.journalPath(receipt.repo_id),j);}if(j.state!=='committed')fail('GIT_RECOVERY_REQUIRED',5,'Apply retry requires recovery.');await this.pendingMarker();
  }
  async execute(engine:Engine,command:string,input:any,context:SecurityContext,issuer:AuthorityIssuer,dry:boolean,operationId:string):Promise<any>{
    const data=await this.executeNative(engine,command,input,context,issuer,dry,operationId);
    this.bridgeAuthorityGate(engine,command,input,context,issuer,data);
    return data;
  }
  private async executeNative(engine:Engine,command:string,input:any,context:SecurityContext,issuer:AuthorityIssuer,dry:boolean,operationId:string):Promise<any>{
    issuer.authorize(context,command,input,engine);
    validateCommandInput(command,input);
    if(command!=='git.plan')await this.bridgeGate(engine,command,input,context,issuer);
    if(command.startsWith('adoption.'))return executeAdoption(engine,command,input,context,issuer);
    if(command==='layer.publish'){
      const layer=engine.read(input.ref,'layer',false);
      if(adoptionRequired(engine.records,layer)){
        const proof=await this.adoptionProof(engine,input.ref,context,issuer);
        engine.adoptionPublication=(draftRef,principal,review)=>{
          if(principal!==context.principal_id)fail('OWNER_FORBIDDEN',4,'Publication actor differs from the server-resolved assignment.');
          const data=publicationGate(engine,draftRef,review,context,issuer,proof),ref='adoption-publication@'+digest(data);
          engine.store(ref,'adoption-publication',data,false);return {ref};
        };
      }
      try{return executeAuthorized(engine,command,input,context,issuer,dry);}finally{engine.adoptionPublication=undefined;}
    }
    if(command==='source.capture'||command==='source.bind')return executeSourceBinding(engine,command,input,context,issuer,await this.sourceProof(engine,command,input,context,issuer));
    if(command.startsWith('drift.'))return executeDrift(engine,command,input,context,issuer,await this.driftProof(engine,command,input,context,issuer));
    if(command==='git.plan'){
      const data:any=createGitPlan(engine,input,context,issuer,dry);
      if(data.bridge&&typeof data.bridge==='object'){await this.bridgeBaseline(engine,data.bridge,context,issuer);return createGitPlan(engine,input,context,issuer,dry);}else await this.bridgeGate(engine,command,input,context,issuer,data);
      return data;
    }
    if(command==='git.evidence')return registerGitAcceptance(engine,input,context,issuer);
    if(command==='git.review')return createGitReview(engine,input,context,issuer,dry);
    if(command==='git.transaction.inspect'||command==='git.transaction.recover'){
      const request=parse(z.object({repo_id:z.string().min(1)}).strict(),input);issuer.assertRepository(context,command,request.repo_id,[]);
      if(command==='git.transaction.recover'&&!dry){const j=await this.journal(request.repo_id);if(j){issuer.assertRepository(context,command,request.repo_id,j.operations.map(o=>o.path));const stage=this.journalStage(engine,j);const lock=this.journalPath(request.repo_id)+'.lock';if(await exists(lock)){const value=JSON.parse(await readFile(lock,'utf8'));let live=false;try{process.kill(value.pid,0);live=true;}catch{}if(live)fail('GIT_BUSY',5,'Recovery requires the previous transaction process to be stopped.');}if(Object.values(engine.records).some(r=>r.type==='git-apply-receipt'&&r.data.transaction_id===j.transaction_id)){await this.verifyApplied(this.host(request.repo_id),stage,{head_commit:j.base_commit,head_tree:j.base_tree,index_digest:j.base_index_digest});j.state='committed';await durableJson(this.journalPath(request.repo_id),j);}else await this.rollback(request.repo_id);await unlink(lock).catch(()=>{});await this.pendingMarker();}}
      const j=await this.journal(request.repo_id);return {transaction_id:j?.transaction_id??null,state:j?.state??'idle',paths:j?.operations.map(o=>o.path)??[]};
    }
    if(command==='git.stage'){
      const request=parse(z.object({plan:ref,patch:z.string().max(256*1024)}).strict(),input),plan:GitPlan=engine.read(request.plan,'git-change-plan'),{source}=gitBinding(engine,plan.binding_ref);issuer.assertRepository(context,command,plan.repo_id,plan.write_paths);await this.assertIdle(plan.repo_id);
      const verified=await verifyGitSource(this.host(plan.repo_id),source,{requireClean:true});if(!verified.matches)fail('SOURCE_SNAPSHOT_STALE',5,'Bound source differs from current checkout.');
      if(dry)return {state:'stage-ready',plan:request.plan,source_sha256:digest(source)};
      const staged=await stageGitPatch(this.host(plan.repo_id),source,plan.write_paths,request.patch,this.config.directory);
      const {sandbox,...record}=staged;
      verifyGitBridgeStage(plan,staged);
      const resultManifest=source.entries.map((entry:any)=>{const op=staged.operations.find(o=>o.path===entry.path);return !op?entry:{path:entry.path,presence:op.after.content===null?'absent':'present',kind:op.after.content===null?null:'regular',mode:op.after.mode,byte_length:op.after.content===null?null:Buffer.byteLength(op.after.content),sha256:op.after.sha256};});
      return gitStore(engine,'git-patch-stage',{format:'git-patch-stage/1',project_id:plan.project_id,repo_id:plan.repo_id,plan_ref:request.plan,...record,result_manifest_sha256:digest(resultManifest),owner:context.principal_id});
    }
    if(command==='git.check'){
      const request=parse(z.object({stage:ref,checker:z.string().min(1),oracle:z.unknown()}).strict(),input),stage:GitStage=engine.read(request.stage,'git-patch-stage'),plan:GitPlan=engine.read(stage.plan_ref,'git-change-plan'),{source}=gitBinding(engine,plan.binding_ref);issuer.assertRepository(context,command,plan.repo_id,plan.write_paths,request.checker);
      if(!this.config.enabledCheckers?.includes(request.checker)||request.checker!==plan.checker.id||digest(request.oracle)!==plan.checker.oracle_sha256)fail('UNSUPPORTED_CHECKER',8,'Checker or oracle is not explicitly enabled and pinned.');
      if(dry)return {state:'check-ready',stage:request.stage,execution_checked:false};
      const restaged=await stageGitPatch(this.host(plan.repo_id),source,plan.write_paths,stage.patch,this.config.directory);if(restaged.result_tree_oid!==stage.result_tree_oid)fail('STALE_EVIDENCE',6,'Recreated staged tree differs.');
      await materializeGitTree(restaged.sandbox,restaged.result_tree_oid);
      const measured=await checkGitApplication(engine,plan,stage,restaged.sandbox,this.config.directory);
      return registerGitAcceptance(engine,{format:'git-acceptance/1',project_id:plan.project_id,repo_id:plan.repo_id,plan_ref:stage.plan_ref,stage_ref:request.stage,target:plan.target,base_source_ref:plan.base_source_ref,result_tree_oid:stage.result_tree_oid,result_manifest_sha256:stage.result_manifest_sha256,acceptance_contract_sha256:plan.acceptance_contract_sha256,checker:plan.checker,...measured},context,issuer,'local-fixed-fixture');
    }
    if(command==='git.apply'){
      const request=parse(z.object({stage:ref,review:ref}).strict(),input),{stage,plan,source}=verifyGitApply(engine,request.stage,request.review,context,issuer),host=this.host(plan.repo_id);await this.assertIdle(plan.repo_id);
      const clean=await requireCleanGit(host,{...source,index_digest:stage.base_index_digest});
      for(const op of stage.operations){if(op.before.content===null&&await exists(await noLinks(path.join(host.root,op.path))))fail('STALE_SOURCE',5,'Addition destination appeared; its contents were not read.');if(!stateMatches(await worktreeBytes(host.root,op.path),op.before))fail('STALE_SOURCE',5,'Patch preimage or absence claim changed.');}
      if(dry)return {state:'apply-ready',paths:stage.operations.map(o=>o.path),head_unchanged:true,index_unchanged:true};
      await this.acquire(plan.repo_id,operationId);
      const journal:Journal={format:'git-transaction/1',transaction_id:operationId,repo_id:plan.repo_id,host_identity:clean.pins.identity,stage_ref:request.stage,review_ref:request.review,receipt_ref:null,state:'writing',operations:stage.operations,created_directories:[],base_commit:source.head_commit,base_tree:source.head_tree,base_index_digest:stage.base_index_digest};
      await durableJson(this.journalPath(plan.repo_id),journal);await this.pendingMarker();await this.config.afterJournalForTest?.();
      try{let count=0;for(const op of stage.operations){issuer.authorize(context,command,input,engine);authorizeGitBridge(engine,plan,context,issuer);if(op.before.content===null&&await exists(await noLinks(path.join(host.root,op.path))))fail('SOURCE_SNAPSHOT_STALE',5,'Addition destination appeared; its contents were not read.');if(!stateMatches(await worktreeBytes(host.root,op.path),op.before))fail('SOURCE_SNAPSHOT_STALE',5,'Preimage changed during apply.');const components=op.path.split('/');for(let i=1;i<components.length;i++){const name=components.slice(0,i).join('/');if(!await exists(path.join(host.root,name))){await mkdir(await noLinks(path.join(host.root,name)));journal.created_directories.push(name);await durableJson(this.journalPath(plan.repo_id),journal);}}await replaceFile(host.root,op.path,op.after,operationId);await this.config.afterWriteForTest?.(++count,host.root);}
        await this.verifyApplied(host,stage,{head_commit:source.head_commit,head_tree:source.head_tree,index_digest:stage.base_index_digest});journal.state='written';await durableJson(this.journalPath(plan.repo_id),journal);
        return gitStore(engine,'git-apply-receipt',{format:'git-apply-receipt/1',project_id:plan.project_id,repo_id:plan.repo_id,transaction_id:operationId,plan_ref:stage.plan_ref,stage_ref:request.stage,review_ref:request.review,binding_ref:plan.binding_ref,base_commit:source.head_commit,base_tree:source.head_tree,result_tree_oid:stage.result_tree_oid,paths:stage.operations.map(o=>o.path),state:'applied-awaiting-owner-commit',principal:context.principal_id});
      }catch(e){await this.rollback(plan.repo_id);throw e;}
    }
    if(command==='git.finalize'){
      const request=parse(z.object({receipt:ref,commit:z.string().min(1)}).strict(),input),receipt=engine.read(request.receipt,'git-apply-receipt'),stage:GitStage=engine.read(receipt.stage_ref,'git-patch-stage'),review=engine.read(receipt.review_ref,'git-apply-review'),host=this.host(receipt.repo_id);
      issuer.assertRepository(context,command,receipt.repo_id,receipt.paths);await this.assertIdle(receipt.repo_id);
      const clean=await requireCleanGit(host),commit=gitOid(request.commit,clean.pins.object_format);if(clean.pins.head_commit!==commit||clean.pins.head_tree!==stage.result_tree_oid)fail('FINALIZATION_MISMATCH',5,'Owner commit must contain exactly the reviewed full result tree.');
      const parents=decodeGit(await runGit(host.root,['rev-list','--parents','-n','1',commit])).trim().split(' ');if(parents.length!==2||parents[1]!==receipt.base_commit)fail('FINALIZATION_MISMATCH',5,'Owner commit must be a direct child of the reviewed base.');
      const release=engine.read(review.target.release_ref,'release'),acceptance=engine.read(review.target.acceptance_ref,'git-acceptance');if(digest(release)!==review.target.release_sha256||digest(acceptance)!==review.target.acceptance_sha256||!review.accepted||digest(review.target)!==review.target_sha256||review.target.policy_version!==context.policy_version||!issuer.active(review.principal)||!issuer.active(acceptance.producer.principal))fail('STALE_APPROVAL',6,'Finalization review or evidence is stale.');for(const ref of release.approvals??[])if(!issuer.active(engine.read(ref,'approval').principal))fail('ENDORSEMENT_REVOKED',6,'A semantic Release endorser is no longer active for finalization.');
      return gitStore(engine,'git-finalization',{format:'git-finalization/1',project_id:receipt.project_id,repo_id:receipt.repo_id,receipt_ref:request.receipt,binding_ref:receipt.binding_ref,stage_ref:receipt.stage_ref,review_ref:receipt.review_ref,acceptance_ref:review.target.acceptance_ref,release_ref:review.target.release_ref,release_sha256:review.target.release_sha256,snapshot_sha256:review.target.snapshot_sha256,candidate:review.target.candidate,head_commit:commit,head_tree:clean.pins.head_tree,base_commit:receipt.base_commit,principal:context.principal_id});
    }
    fail('UNSUPPORTED_CAPABILITY',8,'Unknown Node Git operation.');
  }
}
