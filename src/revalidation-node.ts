import { verifyRetainedRevalidation } from './revalidation-producers.js';
import { randomUUID } from 'node:crypto';
import { lstatSync,readFileSync,realpathSync } from 'node:fs';
import path from 'node:path';
import { Engine } from './core.js';
import { MODEL,canonical,digest,bytesDigest,fail,parse } from './model.js';
import { HostIssuer } from './auth/host-issuer.js';
import type { SecurityContext,AuthorityIssuer } from './security.js';
import type { GitNodeAdapter } from './git-adoption-node.js';
import { captureGitSource,identifyGitHost,assertGitHeadSync } from './git-workspace.js';
import { normalizeRevalidationRequest,revalidationContext,deriveRevalidationBridge,revalidationRegressions,revalidationSame as same,
  revalidationMeasuredInput,recordPin,revalidationRunSchema,revalidationCriterionReviewSchema,reconciliationCompletionSchema,
  completionProjection,type RevalidationContext,type RevalidatorDescriptor } from './revalidation.js';
import { revalidationAuthorityIdentity } from './revalidation.js';
import type { GitHost } from './source-binding.js';

export interface TrustedRevalidator<Packet=unknown> {
  readonly id:string;
  prepare(context:RevalidationContext,host:GitHost):Promise<{descriptor:RevalidatorDescriptor;packet:Packet}>;
  run(prepared:{descriptor:RevalidatorDescriptor;packet:Packet},signal?:AbortSignal):Promise<{results:unknown;observations:Record<string,unknown>}>;
}
const proofs=new WeakSet<object>();
export type RevalidationPublication={data:any;lateCheck:()=>Promise<void>;publishGuard:()=>void};
const configDigest=(git:GitNodeAdapter)=>digest({project_id:git.projectId,repositories:git.config.repositories,repository_identities:git.config.repositories.map(r=>({repo_id:r.repoId,identity:git.host(r.repoId).identity})),enabled_checkers:git.config.enabledCheckers??[]});
export async function startRevalidation<Packet>(engine:Engine,input:unknown,context:SecurityContext,authorityIssuer:AuthorityIssuer,
  git:GitNodeAdapter|undefined,producer:TrustedRevalidator<Packet>,refresh:()=>void,signal:AbortSignal,dry=false,cached?:any):Promise<RevalidationPublication> {
  if(!(authorityIssuer instanceof HostIssuer)||context.trust_mode!=='host_authenticated')fail('REVALIDATION_AUTHORITY_REQUIRED',4,'A configured live named HostIssuer account is required.');
  const issuer=authorityIssuer;
  if(!git||engine.modelVersion()!==MODEL||engine.options.checkerBackend==='none')fail('REVALIDATION_UNSUPPORTED',8,'Revalidation requires local Node v0.1 Git/artifact state.');
  const request=normalizeRevalidationRequest(input),c=revalidationContext(engine.records,request,context.project_id);
  const host=git.host(c.review.repo_id),rootStats=lstatSync(host.root);
  const repositoryConfiguration=()=>{const stats=lstatSync(host.root);if(stats.isSymbolicLink()||stats.dev!==rootStats.dev||stats.ino!==rootStats.ino)fail('REPOSITORY_BINDING',4,'Configured root changed since admission.');
    return digest({configuration:configDigest(git),root_dev:stats.dev,root_ino:stats.ino});};
  const configuration=repositoryConfiguration();
  if(!git.config.enabledCheckers?.includes(c.plan.checker.id))fail('REVALIDATION_UNSUPPORTED',8,'The exact checker is not enabled on this host.');
  await issuer.refreshContext(context);refresh();
  const authority=issuer.revalidationAuthority(context,c,configuration),bridge=deriveRevalidationBridge(c,authority,producer.id),bridgeDigest=digest(bridge);
  const assert=()=>{
    if(signal.aborted)fail('REVALIDATION_INTERRUPTED',5,'Revalidation was interrupted before publication.');
    same(repositoryConfiguration(),configuration,'Repository/checker configuration changed after admission.');
    same(issuer.revalidationAuthority(context,c,configuration),authority,'Account/policy/scoped authority changed after admission.');
  };
  const measure=async()=>{
    assert();
    const fresh=await captureGitSource(host,c.source.scope,{mode:'observation',authorizePath:name=>issuer.assertRevalidationPath(context,c.review.repo_id,name),
      authorizeOutsidePath:name=>issuer.assertRevalidationPath(context,c.review.repo_id,name),authorizeInventory:name=>issuer.assertRevalidationPath(context,c.review.repo_id,name,true)});
    same(fresh.observation,c.report.observation,'The complete Git observation changed since approved review.');
    refresh();await issuer.refreshContext(context);assert();return fresh.observation;
  };
  const pre=await measure();assert();
  // Preparation recognizes measured bytes and the reviewed contract, but never executes.
  const prepared=await producer.prepare(c,host);assert();
  if(cached) {
    verifyRetainedRevalidation(engine.records,context.project_id);
    const completed=parse(reconciliationCompletionSchema,engine.read(cached.ref,'reconciliation-completion'));
    same(completed.request,request);same(completed.final_observation,pre);
    if(canonical(revalidationAuthorityIdentity(completed.bridge.authority))!==canonical(revalidationAuthorityIdentity(authority)))
      fail('REVALIDATION_AUTHORITY_CHANGED',5,'Committed revalidation authority changed; use historical inspection.');
    await measure();assert();
    return {data:{...completionProjection(cached.ref,completed),live_source_checked:true},lateCheck:async()=>{await measure();assert();},publishGuard:assert};
  }
  if(dry)return {data:{state:'eligible',completion:false,execution_checked:false,execution_authenticated:false,source_binding_advanced:false,release_changed:false,
    review:request.review,scope:c.source.scope,producer_id:producer.id,observation_sha256:digest(pre)},lateCheck:async()=>{},publishGuard:()=>fail('REVALIDATION_PROOF_REQUIRED',6,'Dry run cannot publish.')};
  assert();const attemptId=randomUUID(),started=new Date(issuer.time()).toISOString();
  const measured=await producer.run(prepared,signal);const finished=new Date(issuer.time()).toISOString();
  refresh();await issuer.refreshContext(context);assert();
  const post=await measure();assert();
  const mechanical=c.criteria.filter(r=>r.method==='mechanical');
  const results=parse(revalidationRunSchema.shape.results,measured.results);
  same(results.map(({passed,reviewer,...row})=>row),mechanical,'Worker must return exactly the selected mechanical criterion identities.');
  if(results.some(r=>!r.passed||r.reviewer!==null))fail('REVALIDATION_FAILED',6,'Selected mechanical checks failed.');
  if(Buffer.byteLength(canonical(measured.observations))>262144)fail('REVALIDATION_WORKER_FAILED',6,'Measured observations exceed the retained IPC bound.');
  const proof=Object.freeze({attemptId,bridgeDigest});proofs.add(proof);
  const put=(type:string,data:unknown)=>{const ref=type+'@'+digest(data);engine.store(ref,type,data);return recordPin(ref,data);};
  const issue=(actionInput:unknown)=>put('revalidation-auth',issuer.issueRevalidationAuth(context,c,authority,attemptId,bridgeDigest,actionInput));
  const common={model_version:MODEL,project_id:context.project_id,repo_id:c.review.repo_id,attempt_id:attemptId,bridge_sha256:bridgeDigest};
  const inputDigest=revalidationMeasuredInput(c);
  const runAuth=issue({action:'revalidation.run',attempt_id:attemptId,bridge_sha256:bridgeDigest,checker_sha256:c.plan.checker.sha256,measured_input_sha256:inputDigest});
  const run=put('git-revalidation-run',parse(revalidationRunSchema,{...common,format:'git-revalidation-run/1',bridge,pre_observation:pre,post_observation:post,
    pre_observation_sha256:digest(pre),post_observation_sha256:digest(post),descriptor:prepared.descriptor,descriptor_sha256:digest(prepared.descriptor),measured_input_sha256:inputDigest,
    results,observations:measured.observations,observations_sha256:digest(measured.observations),regressions:revalidationRegressions(c),started_at:started,finished_at:finished,
    producer:context.principal_id,auth:runAuth,execution_authenticated:true}));
  let review=null;
  if(request.criterion_reviews.length){const auth=issue({action:'revalidation.criterion-review',attempt_id:attemptId,bridge_sha256:bridgeDigest,assertions:request.criterion_reviews});
    review=put('revalidation-criterion-review',parse(revalidationCriterionReviewSchema,{...common,format:'revalidation-criterion-review/1',target:c.target,observation_sha256:digest(pre),
      checker:c.plan.checker,assertions:request.criterion_reviews,reviewer:context.principal_id,auth}));}
  const completionAuth=issue({action:'drift.revalidate',request,bridge_sha256:bridgeDigest});
  const limitations=[...new Set([...c.basis.limitations,...c.binding.payload.limitations,...c.source.scope.limitations,
    'Only the full declared selected scope and pinned finite checks were verified; whole-application behavior is unverified.',
    'Cooperative bounded filesystem observations certify the measured source at publication, not future checkout state.',
    'Local authenticated provenance is not independent cryptographic proof against an untrusted host.'])];
  const completion=parse(reconciliationCompletionSchema,{...common,format:'reconciliation-completion/1',action:'revalidate',request,bridge,
    final_observation:post,observation_sha256:digest(post),run,criterion_review:review,auth:completionAuth,selected_checks_passed:true,outcome:'revalidated-selected-checks',
    completed_at:new Date(issuer.time()).toISOString(),git_finalization_ref:null,successor_binding_ref:null,source_binding_advanced:false,release_changed:false,behavior_verified:false,limitations});
  const completionPin=put('reconciliation-completion',completion);
  verifyRetainedRevalidation(engine.records,context.project_id);
  const committedPins=Object.entries(engine.records).filter(([,r])=>r.data.attempt_id===attemptId).map(([ref,r])=>({ref,sha256:digest(r.data)}));
  let finalIdentity:{root:string;gitDir:string;rootDev:number;rootIno:number;gitDev:number;gitIno:number}|undefined;
  return {data:{...completionProjection(completionPin.ref,completion),live_source_checked:true},
    lateCheck:async()=>{
      await measure();
      const identity=await identifyGitHost(host);const root=lstatSync(identity.root),dir=lstatSync(identity.gitDir);
      finalIdentity={root:identity.root,gitDir:identity.gitDir,rootDev:root.dev,rootIno:root.ino,gitDev:dir.dev,gitIno:dir.ino};
      refresh();await issuer.refreshContext(context);assert();
    },
    publishGuard:()=>{
      assert();if(!finalIdentity||!proofs.has(proof))fail('REVALIDATION_PROOF_REQUIRED',6,'A fresh single-use runtime proof and late source verification are required.');
      const root=lstatSync(finalIdentity.root),dir=lstatSync(finalIdentity.gitDir);
      if(root.isSymbolicLink()||dir.isSymbolicLink()||root.dev!==finalIdentity.rootDev||root.ino!==finalIdentity.rootIno||dir.dev!==finalIdentity.gitDev||dir.ino!==finalIdentity.gitIno)
        fail('REPOSITORY_BINDING',4,'Repository root identity changed before publication.');
      const index=path.join(finalIdentity.gitDir,'index');
      assertGitHeadSync(host,post.head_commit,post.head_tree);
      if(lstatSync(index).isSymbolicLink()||bytesDigest(readFileSync(index))!==post.index_sha256)fail('REVALIDATION_MISMATCH',6,'Raw index changed after late capture.');
      for(const entry of post.entries){const file=path.join(finalIdentity.root,entry.path);
        if(entry.presence==='absent'){try{lstatSync(file);fail('REVALIDATION_MISMATCH',6,'An absent measured path appeared.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
        else {const stats=lstatSync(file);if(!stats.isFile()||stats.isSymbolicLink()||stats.size!==entry.byte_length||realpathSync(path.dirname(file))!==path.dirname(file)||bytesDigest(readFileSync(file))!==entry.sha256)fail('REVALIDATION_MISMATCH',6,'Selected bytes or path identity changed after late capture.');}
      }
      for(const p of committedPins)same(digest(engine.records[p.ref]?.data),p.sha256,'Prepared completion records changed before publication.');
      // Synchronous native reads can consume time; repeat expiry/live authority at the rename boundary.
      assert();
      proofs.delete(proof);
    }};
}
