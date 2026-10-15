import { z } from 'zod';
import { Engine, snapshotFromRelease } from './core.js';
import { MODEL, parse, digest, bytesDigest, canonical, fail, type Records } from './model.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import { gitFinalizationBindingProof } from './git-finalization-proof.js';
export { gitFinalizationBindingProof } from './git-finalization-proof.js';
import { gitBridgeSchema, gitBridgeInputSchema, gitBridgeAuthoritySchema, deriveGitBridge, verifyGitBridge, isBridgedPlan, bridgeAuthority, authorizeGitBridge, authorizeGitBridgeEvidence, authorizeGitBridgeReviewer, verifyGitBridgeStage, gitBridgePrivateEdges, verifyGitBridgeEdges } from './adoption/git-bridge.js';

import { hash, ref, text, oid, targetSchema, gitCheckerSchema, resultSchema, fileStateSchema, operationSchema, common, gitPlanInputSchema, gitPlanRequestSchema, planSchema, gitPlanV2Schema, allPlanSchema, stageSchema, acceptanceSchema, gitAcceptanceV2Schema, allAcceptanceSchema, observationSchema, reviewTargetSchema, reviewTargetV2Schema, reviewSchema, gitReviewV2Schema, allReviewSchema, receiptSchema, finalizationSchema, GIT_ADOPTION_SCHEMAS } from './git-record-schemas.js';
export { gitCheckerSchema, gitPlanInputSchema, gitPlanRequestSchema, gitPlanV2Schema, gitAcceptanceV2Schema, gitReviewV2Schema, GIT_ADOPTION_SCHEMAS } from './git-record-schemas.js';
export const GIT_OPERATIONS = ['git.plan','git.stage','git.check','git.evidence','git.review','git.apply','git.finalize','git.transaction.inspect','git.transaction.recover'] as const;
export type GitPlan = z.infer<typeof allPlanSchema>;
export type GitStage = z.infer<typeof stageSchema>;
export type GitAcceptance = z.infer<typeof allAcceptanceSchema>;
export function readGitPlan(engine:Engine,ref:string):GitPlan {const plan=parse(allPlanSchema,engine.read(ref,'git-change-plan'));if(ref!=='git-change-plan@'+digest(plan))fail('STALE_SOURCE_BINDING',5,'Git plan reference differs from its immutable bytes.');verifyGitBridge(engine,plan);return plan;}
export function gitStore(engine: Engine, type: keyof typeof GIT_ADOPTION_SCHEMAS, input: unknown) {
  const record = parse(GIT_ADOPTION_SCHEMAS[type] as z.ZodType<any>, input);if(new TextEncoder().encode(canonical(record)).byteLength>768*1024)fail('GIT_LIMIT',8,'Encoded Git records exceed the bounded local transport size.');const ref = type + '@' + digest(record); engine.store(ref, type, record); return { ref, record };
}
export function gitBinding(engine: Engine, bindingRef: string) {
  const binding = engine.read(bindingRef, 'source-binding'), p = binding.payload, source = engine.read(p.source_ref, 'source-snapshot');
  if (digest(p) !== binding.payload_sha256 || digest(source) !== p.source_sha256 || !binding.acceptance?.accepted) fail('STALE_SOURCE_BINDING', 5, 'Source association is inconsistent.');
  if (source.project_id !== p.project_id || source.repo_id !== p.repo_id) fail('PROJECT_FORBIDDEN', 4, 'Source association identity differs.');
  return { binding, payload: p, source };
}
export function gitTarget(engine: Engine, target: string) {
  const evaluation = engine.target(target), record = engine.read(target);
  if (evaluation.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'Git planning requires eligible exact intent.');
  return { ref: target, record_sha256: digest(record), candidate_fingerprint: evaluation.fingerprint, snapshot_sha256: digest(evaluation.snapshot) };
}
export function createGitPlan(engine: Engine, input: unknown, context: SecurityContext, issuer: AuthorityIssuer, dry=false) {
  if (engine.modelVersion() !== MODEL) fail('UNSUPPORTED_MODEL_VERSION', 8, 'Git patch adoption v1 requires v0.1 intent.');
  const request = parse(gitPlanRequestSchema, input);
  if('adoption' in request){const publication=engine.records[request.adoption.publication_ref];if(publication?.type!=='adoption-publication'||publication.data.owner!==context.principal_id||!engine.canInspect(request.adoption.publication_ref,context.principal_id))fail('REF_NOT_FOUND',3,'Private adoption lineage is unavailable.');}
  const { payload, source } = gitBinding(engine, request.binding_ref), target = gitTarget(engine, request.target_ref), evaluation = engine.target(request.target_ref);
  if (payload.project_id !== context.project_id) fail('PROJECT_FORBIDDEN', 4, 'Source association belongs to another project.');
  const intended=engine.read(request.target_ref),baseline=engine.target(payload.intent.release_ref);
  if(request.target_ref!==payload.intent.release_ref&&intended.baseline!==payload.intent.release_ref)fail('MIXED_BASELINE',5,'Git change intent must descend from the exact accepted intent baseline.');
  if(context.write_block_ids!==null&&source.scope.items.some((i:string)=>!context.write_block_ids!.includes(i.split('/')[0])))fail('BLOCK_SCOPE_FORBIDDEN',4,'Git plan exceeds assigned Block scope.');
  const prior=new Map(baseline.obligations.map(o=>[o.item,o.value])),next=new Map(evaluation.obligations.map(o=>[o.item,o.value]));
  for(const item of new Set([...prior.keys(),...next.keys()]))if(canonical(prior.get(item)??null)!==canonical(next.get(item)??null)&&!source.scope.items.includes(item))fail('COVERAGE_INCOMPLETE',6,'Every changed intent item needs a reviewed source mapping.',{item});
  issuer.assertRepository(context, 'git.plan', payload.repo_id, request.write_paths, request.checker.id);
  const paths = [...new Set(request.write_paths)].sort(); if (paths.length !== request.write_paths.length) fail('INVALID_RECORD', 2, 'Duplicate write paths.');
  const mappedPaths: string[] = source.scope.mapping.flatMap((m: any) => m.paths);
  if (paths.some(p => !mappedPaths.includes(p) || !source.entries.some((e: any) => e.path === p))) fail('PATCH_SCOPE', 4, 'Each write path needs a reviewed scoped mapping and exact preimage.');
  const criterionRefs = [...new Set(evaluation.obligations.filter(o => source.scope.items.includes(o.item)).flatMap(o => o.criteria))].sort();
  if (!criterionRefs.length || source.scope.items.some((item: string) => !evaluation.obligations.some(o => o.item === item))) fail('COVERAGE_INCOMPLETE', 6, 'Declared intent scope must retain its complete acceptance coverage.');
  const criteria = criterionRefs.map(criterion_ref => { const [block, item] = criterion_ref.split('/acceptance.'); const c = evaluation.snapshot.blocks[block]?.acceptance[item]; if (!c) fail('COVERAGE_INCOMPLETE', 6, 'Unknown active criterion.'); return { criterion_ref, check: c.check, version: c.version, fixture: c.fixture, method: c.method }; });
  if (request.checker.oracle_sha256 !== digest(request.oracle)) fail('STALE_CHECKER_EVIDENCE', 6, 'Checker must pin the independent oracle.');
  const regressions = [...new Set(request.regressions)].sort(); if (regressions.length !== request.regressions.length) fail('INVALID_RECORD', 2, 'Duplicate regression obligations.');
  const acceptance_contract_sha256 = digest({ criteria, regressions, checker: request.checker });
  const base={ format: 'git-change-plan/1' as const, project_id: context.project_id, repo_id: payload.repo_id, binding_ref: request.binding_ref, base_source_ref: payload.source_ref, base_source_sha256: payload.source_sha256, target, write_paths: paths, criteria, checker: request.checker, oracle: request.oracle, regressions, acceptance_contract_sha256, owner: context.principal_id };
  if(!('adoption' in request))return {...gitStore(engine,'git-change-plan',base),bridge:'legacy-unbridged' as const};
  const adoption_bridge=deriveGitBridge(engine,base,request.adoption.publication_ref,{...bridgeAuthority(context,issuer),visibility:'project-visible-linkage',trust:'local-fixture'}),plan=parse(gitPlanV2Schema,{...base,format:'git-change-plan/2',adoption_bridge});
  authorizeGitBridge(engine,plan,context,issuer,true);const bridge_sha256=digest(adoption_bridge);
  if(dry)return {bridge:adoption_bridge,bridge_sha256,disclosure_required:true,execution_ready:false};
  if(request.adoption.expected_bridge_sha256!==bridge_sha256)fail('ADOPTION_DISCLOSURE_REQUIRED',6,'Owner must acknowledge the exact current public linkage projection digest.');
  return {...gitStore(engine,'git-change-plan',plan),bridge_sha256,bridge:'established' as const};
}
export function verifyGitAcceptance(engine: Engine, stageRef: string, record: Omit<GitAcceptance,'format'>&{format:string}, complete=true) {
  const stage: GitStage = engine.read(stageRef, 'git-patch-stage'), plan = readGitPlan(engine,stage.plan_ref);verifyGitBridgeStage(plan,stage);
  if (record.stage_ref !== stageRef || record.plan_ref !== stage.plan_ref || record.base_source_ref !== plan.base_source_ref || record.project_id !== plan.project_id || record.repo_id !== plan.repo_id || canonical(record.target) !== canonical(plan.target) || record.result_tree_oid !== stage.result_tree_oid || record.result_manifest_sha256 !== stage.result_manifest_sha256 || record.acceptance_contract_sha256 !== plan.acceptance_contract_sha256 || canonical(record.checker) !== canonical(plan.checker)) fail('STALE_EVIDENCE', 6, 'Application evidence does not bind this exact staged implementation.');
  const results = record.results.map(({passed,reviewer,...r}) => r).sort((a,b) => a.criterion_ref.localeCompare(b.criterion_ref));
  if(!complete){if(new Set(results.map(r=>r.criterion_ref)).size!==results.length||results.some(r=>!plan.criteria.some(c=>canonical(c)===canonical(r)))||new Set(record.regressions.map(r=>r.id)).size!==record.regressions.length||record.regressions.some(r=>!plan.regressions.includes(r.id)))fail('UNKNOWN_EVIDENCE',6,'Application observations may be incomplete or failed but cannot invent checks.');return {stage,plan};}
  if(isBridgedPlan(plan)!==(record.format==='git-acceptance/2'))fail('STALE_EVIDENCE',6,'Application acceptance format must match its immutable plan version.');
  if(isBridgedPlan(plan))parse(gitAcceptanceV2Schema,record);
  if (canonical(results) !== canonical(plan.criteria) || record.results.some(r => !r.passed || (r.method === 'review' ? !r.reviewer : r.reviewer !== null)) || canonical(record.regressions.map(r => r.id).sort()) !== canonical(plan.regressions) || record.regressions.some(r => !r.passed)) fail('VALIDATION_INCOMPLETE', 6, 'Every frozen application criterion and regression needs one passing result.');
  return { stage, plan };
}
export function registerGitAcceptance(engine: Engine, input: unknown, context: SecurityContext, issuer: AuthorityIssuer, trust: GitAcceptance['producer']['trust'] = 'local-fixture-import') {
  const value=input as any,observationOnly=value?.observation_only===true,{observation_only,...packet}=value??{};
  if(observation_only!==undefined&&typeof observation_only!=='boolean')fail('INVALID_RECORD',2,'observation_only must be an explicit boolean.');
  const request = parse(acceptanceSchema.omit({ producer: true }), packet),stage=engine.read(request.stage_ref,'git-patch-stage'),planForVersion=readGitPlan(engine,stage.plan_ref);
  if(isBridgedPlan(planForVersion)&&!observationOnly&&trust!=='local-fixed-fixture')fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'Imported evidence cannot complete a selected adoption bridge.');
  const record={ ...request,format:observationOnly?'git-application-observation/1' as const:isBridgedPlan(planForVersion)?'git-acceptance/2' as const:request.format, producer: { principal: context.principal_id, trust, execution_authenticated:false as const,...(isBridgedPlan(planForVersion)&&!observationOnly?bridgeAuthority(context,issuer):{}) } };
  const { plan } = verifyGitAcceptance(engine, record.stage_ref, record,!observationOnly);
  issuer.assertRepository(context, trust === 'local-fixed-fixture' ? 'git.check' : 'git.evidence', plan.repo_id, plan.write_paths, plan.checker.id);
  issuer.assertGitEvidence(context, record.results);
  authorizeGitBridge(engine,plan,context,issuer);
  return gitStore(engine, observationOnly?'git-application-observation':'git-acceptance', record);
}
export function gitReviewTarget(engine: Engine, request: { stage: string; acceptance: string; release: string }, context: SecurityContext, issuer: AuthorityIssuer) {
  const stage: GitStage = engine.read(request.stage, 'git-patch-stage'), plan = readGitPlan(engine,stage.plan_ref), acceptance: GitAcceptance = engine.read(request.acceptance, 'git-acceptance');
  verifyGitAcceptance(engine, request.stage, acceptance);
  authorizeGitBridge(engine,plan,context,issuer);authorizeGitBridgeEvidence(engine,plan,acceptance,issuer);
  const release = engine.read(request.release, 'release'), target = engine.target(request.release), originalTarget = engine.target(plan.target.ref);
  if (release.state !== 'validated' || release.candidate !== plan.target.candidate_fingerprint || digest(snapshotFromRelease(release)) !== plan.target.snapshot_sha256 || digest(engine.read(plan.target.ref)) !== plan.target.record_sha256 || originalTarget.fingerprint !== plan.target.candidate_fingerprint) fail('RELEASE_REQUIRED', 6, 'Implementation approval needs the exact matching validated semantic Release.');
  const baselineRef = engine.records[plan.target.ref].type === 'composition' ? engine.read(plan.target.ref).baseline : release.baseline, baseline = snapshotFromRelease(engine.read(baselineRef, 'release'));
  const scope = originalTarget.scope;
  if (!baseline.authorities.scopes.some(s => s.block === scope && s.selectors.includes(context.principal_id))) fail('AUTHORITY_FORBIDDEN', 4, 'Implementation approval requires the responsible baseline scope authority.');
  issuer.assertRepository(context, 'git.review', plan.repo_id, plan.write_paths);
  const data={ project_id: plan.project_id, repo_id: plan.repo_id, stage_ref: request.stage, stage_sha256: digest(stage), acceptance_ref: request.acceptance, acceptance_sha256: digest(acceptance), plan_ref: stage.plan_ref, binding_ref: plan.binding_ref, release_ref: request.release, release_sha256: digest(release), candidate: release.candidate, snapshot_sha256: digest(target.snapshot), responsible_scope: scope, policy_version: context.policy_version };
  if(!isBridgedPlan(plan))return parse(reviewTargetSchema,data);
  verifyGitBridgeRelease(engine,plan,request.release);const reviewer=bridgeAuthority(context,issuer);authorizeGitBridgeReviewer(engine,plan,reviewer,issuer);
  return parse(reviewTargetV2Schema,{...data,adoption_bridge_sha256:digest(plan.adoption_bridge),reviewer});
}
export function verifyGitBridgeRelease(engine:Engine,plan:GitPlan,releaseRef:string){
  if(!isBridgedPlan(plan))return;
  const release=engine.read(releaseRef,'release'),validation=engine.read(release.validation,'validation'),realization=engine.read(validation.realization,'realization');
  if(release.state!=='validated'||release.candidate!==plan.target.candidate_fingerprint||digest(snapshotFromRelease(release))!==plan.target.snapshot_sha256||validation.target!==plan.target.ref||realization.target!==plan.target.ref||realization.profile_id!=='counter-fixture/1'||realization.checker_sha256!==plan.checker.sha256||realization.fixture_sha256!==plan.checker.fixture_sha256||realization.oracle_sha256!==plan.checker.oracle_sha256)fail('RELEASE_REQUIRED',6,'Bridge requires the exact composition validation and recognized profile/checker/oracle Release.');
}
export function verifyGitBridgeReview(engine:Engine,plan:GitPlan,review:any,acceptance:any){
  if(!isBridgedPlan(plan)){if(review.format!=='git-apply-review/1')fail('STALE_APPROVAL',6,'Review format does not match its legacy plan.');return;}
  const value=parse(gitReviewV2Schema,review);
  verifyGitBridgeRelease(engine,plan,value.target.release_ref);
  const t=value.target,stage:GitStage=engine.read(t.stage_ref,'git-patch-stage'),release=engine.read(t.release_ref,'release');
  if(value.principal!==t.reviewer.principal||t.policy_version!==t.reviewer.policy_version||t.adoption_bridge_sha256!==digest(plan.adoption_bridge)||
      acceptance.format!=='git-acceptance/2'||t.snapshot_sha256!==plan.target.snapshot_sha256||value.target_sha256!==digest(t)||
      t.plan_ref!=='git-change-plan@'+digest(plan)||t.binding_ref!==plan.binding_ref||t.project_id!==plan.project_id||t.repo_id!==plan.repo_id||
      stage.plan_ref!==t.plan_ref||t.stage_sha256!==digest(stage)||acceptance.stage_ref!==t.stage_ref||
      t.acceptance_ref!=='git-acceptance@'+digest(acceptance)||t.acceptance_sha256!==digest(acceptance)||t.release_sha256!==digest(release)||
      t.candidate!==plan.target.candidate_fingerprint)fail('STALE_APPROVAL',6,'Review does not bind the exact bridge, actor and versioned acceptance.');
}
export function createGitReview(engine: Engine, input: unknown, context: SecurityContext, issuer: AuthorityIssuer, dry: boolean) {
  const request = parse(z.object({ stage: ref, acceptance: ref, release: ref, expected_target_sha256: hash.nullable(), accepted: z.boolean(), rationale: text }).strict(), input), target = gitReviewTarget(engine, request, context, issuer), target_sha256 = digest(target);
  if (dry) return { target, target_sha256, approval_required: true };
  if (request.expected_target_sha256 !== target_sha256) fail('STALE_APPROVAL', 6, 'Review must explicitly endorse the exact frozen review target digest.');
  return gitStore(engine, 'git-apply-review', { format: 'reviewer' in target?'git-apply-review/2':'git-apply-review/1', target, target_sha256, principal: context.principal_id, trust: 'local-fixture', accepted: request.accepted, rationale: request.rationale });
}
export function verifyGitApply(engine: Engine, stageRef: string, reviewRef: string, context: SecurityContext, issuer: AuthorityIssuer) {
  const review = parse(allReviewSchema, engine.read(reviewRef, 'git-apply-review')), stage: GitStage = engine.read(stageRef, 'git-patch-stage'), plan = readGitPlan(engine,stage.plan_ref), { source, payload } = gitBinding(engine, plan.binding_ref);
  if (!review.accepted || review.target.stage_ref !== stageRef || review.target.stage_sha256 !== digest(stage) || review.target.plan_ref !== stage.plan_ref || digest(review.target) !== review.target_sha256 || review.target.policy_version !== context.policy_version || !issuer.active(review.principal)) fail('STALE_APPROVAL', 6, 'Implementation review is rejected, revoked or stale.');
  const release = engine.read(review.target.release_ref, 'release');
  if (digest(release) !== review.target.release_sha256 || release.state !== 'validated' || release.candidate !== plan.target.candidate_fingerprint || digest(snapshotFromRelease(release)) !== plan.target.snapshot_sha256) fail('STALE_APPROVAL', 6, 'Reviewed semantic Release changed.');
  const acceptance = engine.read(review.target.acceptance_ref, 'git-acceptance'); verifyGitAcceptance(engine, stageRef, acceptance);
  verifyGitBridgeReview(engine,plan,review,acceptance);authorizeGitBridge(engine,plan,context,issuer);authorizeGitBridgeEvidence(engine,plan,acceptance,issuer);
  if(review.format==='git-apply-review/2')authorizeGitBridgeReviewer(engine,plan,review.target.reviewer,issuer);
  if(context.write_block_ids!==null&&source.scope.items.some((i:string)=>!context.write_block_ids!.includes(i.split('/')[0])))fail('BLOCK_SCOPE_FORBIDDEN',4,'Git apply exceeds assigned Block scope.');
  for(const approvalRef of release.approvals??[]){const approval=engine.read(approvalRef,'approval');if(!issuer.active(approval.principal))fail('ENDORSEMENT_REVOKED',6,'A semantic Release endorser is no longer active for this pending apply.');}
  if (digest(acceptance) !== review.target.acceptance_sha256 || !issuer.active(acceptance.producer.principal)) fail('ENDORSEMENT_REVOKED', 6, 'Evidence producer or evidence binding is stale.');
  issuer.assertRepository(context, 'git.apply', plan.repo_id, plan.write_paths);
  return { review, stage, plan, source, payload };
}
export function gitAdoptionArchiveReferences(type: string, data: any): string[] {
  switch (type) {
    case 'git-change-plan': return [data.binding_ref, data.base_source_ref, data.target.ref,...gitBridgePrivateEdges(data).map(e=>e.ref),...(isBridgedPlan(data)?[data.adoption_bridge.published_layer.ref,data.adoption_bridge.inventory_source.ref]:[])];
    case 'git-patch-stage': return [data.plan_ref];
    case 'git-acceptance': case 'git-application-observation': return [data.plan_ref, data.stage_ref, data.target.ref, data.base_source_ref];
    case 'git-apply-review': return [data.target.stage_ref, data.target.acceptance_ref, data.target.plan_ref, data.target.binding_ref, data.target.release_ref];
    case 'git-apply-receipt': return [data.plan_ref, data.stage_ref, data.review_ref, data.binding_ref];
    case 'git-finalization': return [data.receipt_ref, data.binding_ref, data.stage_ref, data.review_ref, data.acceptance_ref, data.release_ref];
    default: return [];
  }
}
export function verifyGitAdoptionHistory(records: Records, projectId: string) {
  for (const [ref, record] of Object.entries(records)) if (record.type in GIT_ADOPTION_SCHEMAS) {
    const data: any = parse(GIT_ADOPTION_SCHEMAS[record.type as keyof typeof GIT_ADOPTION_SCHEMAS] as z.ZodType<any>, record.data);
    if (ref !== record.type + '@' + digest(data) || (data.project_id ?? data.target.project_id) !== projectId || !record.published) fail('BACKUP_INVALID', 6, 'Git adoption history binding is inconsistent.');
    const privateEdges=record.type==='git-change-plan'?gitBridgePrivateEdges(data):[];verifyGitBridgeEdges(records,data);
    for (const needed of gitAdoptionArchiveReferences(record.type, data)) if (!records[needed]?.published&&!privateEdges.some(e=>e.ref===needed&&records[needed]?.type===e.type)) fail('BACKUP_MISSING_REFERENCE', 6, 'Git adoption history reference is missing.');
    if (record.type === 'git-patch-stage') { if (data.patch_sha256 !== bytesDigest(data.patch)) fail('BACKUP_INVALID', 6, 'Retained patch bytes changed.'); for (const op of data.operations) for (const state of [op.before, op.after]) if ((state.content === null ? null : bytesDigest(state.content)) !== state.sha256 || (state.content === null) !== (state.mode === null)) fail('BACKUP_INVALID', 6, 'Retained file pre/postimages changed.'); }
    if (record.type === 'git-acceptance'||record.type==='git-application-observation') verifyGitAcceptance(new Engine(records,{},{projectId}), data.stage_ref, data,record.type==='git-acceptance');
    const engine=new Engine(records,{},{projectId});
    if(record.type==='git-change-plan')verifyGitBridge(engine,data);
    if(record.type==='git-change-plan'){const {payload,source}=gitBinding(engine,data.binding_ref);if(payload.project_id!==data.project_id||payload.repo_id!==data.repo_id||data.base_source_ref!==payload.source_ref||data.base_source_sha256!==digest(source)||canonical(gitTarget(engine,data.target.ref))!==canonical(data.target)||data.acceptance_contract_sha256!==digest({criteria:data.criteria,regressions:data.regressions,checker:data.checker})||data.checker.oracle_sha256!==digest(data.oracle))fail('BACKUP_INVALID',6,'Historical Git plan closure differs.');}
    if(record.type==='git-patch-stage'){const plan=readGitPlan(engine,data.plan_ref);verifyGitBridgeStage(plan,data);const {source}=gitBinding(engine,plan.binding_ref);if(plan.project_id!==data.project_id||plan.repo_id!==data.repo_id||new Set(data.operations.map((o:any)=>o.path)).size!==data.operations.length)fail('BACKUP_INVALID',6,'Historical patch scope differs.');for(const op of data.operations){const pre=source.entries.find((e:any)=>e.path===op.path);if(!plan.write_paths.includes(op.path)||!pre||pre.sha256!==op.before.sha256||pre.mode!==op.before.mode)fail('BACKUP_INVALID',6,'Historical patch preimage differs from the bound source.');}const resulting=source.entries.map((pre:any)=>{const op=data.operations.find((o:any)=>o.path===pre.path);return !op?pre:{path:pre.path,presence:op.after.content===null?'absent':'present',kind:op.after.content===null?null:'regular',mode:op.after.mode,byte_length:op.after.content===null?null:new TextEncoder().encode(op.after.content).byteLength,sha256:op.after.sha256};});if(digest(resulting)!==data.result_manifest_sha256)fail('BACKUP_INVALID',6,'Historical resulting source manifest differs.');}
    if(record.type==='git-apply-review'){verifyGitBridgeReview(engine,readGitPlan(engine,data.target.plan_ref),data,engine.read(data.target.acceptance_ref,'git-acceptance'));const t=data.target,stage=engine.read(t.stage_ref,'git-patch-stage'),acceptance=engine.read(t.acceptance_ref,'git-acceptance'),release=engine.read(t.release_ref,'release'),plan=engine.read(t.plan_ref,'git-change-plan');if(digest(t)!==data.target_sha256||digest(stage)!==t.stage_sha256||digest(acceptance)!==t.acceptance_sha256||digest(release)!==t.release_sha256||release.candidate!==t.candidate||plan.target.candidate_fingerprint!==t.candidate||plan.binding_ref!==t.binding_ref||stage.plan_ref!==t.plan_ref||release.state!=='validated')fail('BACKUP_INVALID',6,'Historical implementation review closure differs.');}
    if(record.type==='git-apply-receipt'){const stage=engine.read(data.stage_ref,'git-patch-stage'),review=engine.read(data.review_ref,'git-apply-review'),plan=engine.read(data.plan_ref,'git-change-plan'),{source}=gitBinding(engine,data.binding_ref);if(!review.accepted||review.target.stage_ref!==data.stage_ref||stage.plan_ref!==data.plan_ref||plan.binding_ref!==data.binding_ref||source.head_commit!==data.base_commit||source.head_tree!==data.base_tree||stage.result_tree_oid!==data.result_tree_oid||canonical(stage.operations.map((o:any)=>o.path))!==canonical(data.paths))fail('BACKUP_INVALID',6,'Historical apply receipt closure differs.');}
    if(record.type==='git-finalization'){gitFinalizationBindingProof(records,ref);const receipt=engine.read(data.receipt_ref,'git-apply-receipt'),review=engine.read(data.review_ref,'git-apply-review');if(receipt.binding_ref!==data.binding_ref||receipt.stage_ref!==data.stage_ref||receipt.review_ref!==data.review_ref||receipt.result_tree_oid!==data.head_tree||receipt.base_commit!==data.base_commit||review.target.release_ref!==data.release_ref||review.target.release_sha256!==data.release_sha256||review.target.acceptance_ref!==data.acceptance_ref||review.target.candidate!==data.candidate||review.target.snapshot_sha256!==data.snapshot_sha256)fail('BACKUP_INVALID',6,'Historical Git finalization closure differs.');}
  }
}
