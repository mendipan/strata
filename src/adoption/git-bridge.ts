import { z } from 'zod';
import type { Engine } from '../core.js';
import { MODEL, canonical, digest, fail, parse, type Records } from '../model.js';
import type { AuthorityIssuer, SecurityContext } from '../security.js';
import { applicationCheckerPins } from '../git-application-checker.js';
import { readSourceBinding, readBindingSource, validateIntentPin, validateSourceSnapshot, validateSourceScope, sourceAuthorityScope, type SourceSnapshot } from '../source-binding.js';
import { adoptionContext, verifyAdoptionHistory } from './persistent.js';
import { publicationRecordSchema, adoptionReviewSchema } from './records.js';

import { gitBridgeSchema, isBridgedPlan, type GitBridge, type BridgeAuthority, type BridgedPlan } from './git-bridge-schema.js';
export * from './git-bridge-schema.js';
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sorted = (values: string[]) => [...new Set(values)].sort();
const requireSame = (a: unknown, b: unknown, message: string) => { if (!same(a,b)) fail('ADOPTION_BRIDGE_MISMATCH',6,message); };

function pin(engine: Engine, value: string, type: string, published: boolean) {
  const record = engine.records[value];
  if (!record || record.type !== type || record.published !== published) fail('ADOPTION_BRIDGE_MISMATCH',6,'Bridge requires exact typed lineage visibility.');
  if (type !== 'layer' && value !== type + '@' + digest(record.data)) fail('ADOPTION_BRIDGE_MISMATCH',6,'Bridge record must retain its content-addressed reference.');
  return { ref: value, sha256: digest(record.data) };
}
function finiteSource(source: SourceSnapshot) {
  if (source.entries.length > 256 || source.scope.paths.length > 256 || source.scope.items.length > 256 || source.scope.watch_roots.length || source.scope.exclusions.length || source.entries.some(e => e.presence !== 'present' || e.kind !== 'regular')) fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'The selected bridge supports at most 256 explicit present ordinary files without watched or excluded source paths.');
  requireSame(source.scope.paths, source.entries.map(e => e.path),'Bridge paths must be the exact captured entry set.');
}
export function bridgeBasePlan(plan: any) {
  const { adoption_bridge, ...base } = plan;
  return { ...base, format: 'git-change-plan/1' as const };
}

/** Derive only retained facts. No grants, host reads, latest-head check or writes. */
export function deriveGitBridge(engine: Engine, base: any, publicationRef: string, disclosure: GitBridge['disclosure']): GitBridge {
  if (engine.modelVersion() !== MODEL) fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'The selected adoption bridge is local v0.1 only.');
  const publication = parse(publicationRecordSchema, engine.read(publicationRef,'adoption-publication',false));
  const prepared = adoptionContext(engine,publication.proposal_ref), inventory = prepared.inventory, layer = prepared.layer;
  verifyAdoptionHistory(engine,base.project_id);
  const review = parse(adoptionReviewSchema,engine.read(publication.review_ref,'adoption-review',false));
  const binding = readSourceBinding(engine,base.binding_ref), b = readBindingSource(engine,binding), a = validateSourceSnapshot(prepared.source);
  const { release: baselineRelease, snapshot: baseline } = validateIntentPin(engine,binding.payload.intent);
  if (base.project_id !== publication.project_id || base.project_id !== engine.options.projectId || publication.owner !== base.owner || disclosure.principal !== base.owner || layer.owner !== base.owner || review.principal !== base.owner || !review.accepted) fail('ADOPTION_BRIDGE_MISMATCH',6,'Bridge owner, project and accepted interpretation must agree.');
  if (inventory.mode !== 'incremental' || prepared.proposal.output_lane !== 'selected_git_patch' || !prepared.coverage.scope_accounted) fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'Bridge requires a completely accounted incremental interpretation.');
  if (baselineRelease.state !== 'validated' || binding.payload.basis !== 'validated-release-association') fail('ADOPTION_BRIDGE_MISMATCH',6,'Bridge requires a validated baseline source association.');
  requireSame(prepared.proposal.baseline_ref,binding.payload.intent.release_ref,'Adoption and binding must pin the exact same baseline Release.');
  requireSame(prepared.proposal.baseline_snapshot_sha256,digest(baseline),'Adoption baseline snapshot differs.');
  if (layer.baseline !== prepared.proposal.baseline_ref || base.base_source_ref !== binding.payload.source_ref || base.base_source_sha256 !== digest(b)) fail('ADOPTION_BRIDGE_MISMATCH',6,'Plan source/baseline differs from the association.');
  const candidate = engine.read(base.target.ref,'composition'), evaluation = engine.target(base.target.ref);
  if (candidate.model_version !== MODEL || candidate.baseline !== layer.baseline || evaluation.state === 'blocked' || candidate.resolutions.length || candidate.alternative_groups.length || layer.resolution_proposals.length) fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'Bridge requires one unmediated eligible v0.1 composition.');
  requireSame(candidate.proposals,[publication.draft_ref],'Bridge must retain exactly the adopted proposal as its considered set.');
  requireSame(candidate.selected,[publication.draft_ref],'Bridge must select the exact published adopted Layer.');
  requireSame(base.target,{ref:base.target.ref,record_sha256:digest(candidate),candidate_fingerprint:evaluation.fingerprint,snapshot_sha256:digest(evaluation.snapshot)},'Bridge target pins differ.');
  requireSame(base.write_paths,['counter.mjs'],'The finite bridge permits modifying the counter module only.');
  requireSame(base.regressions,['unrelated-byte-preservation'],'Bridge requires its exact finite preservation regression.');
  requireSame(base.checker,applicationCheckerPins(base.oracle),'Bridge checker and independent oracle pins differ.');
  engine.realize(base.target.ref,'counter-fixture/1'); // Exact profile recognition, not arbitrary code inference.
  finiteSource(a); finiteSource(b);
  requireSame([a.project_id,a.repo_id,a.object_format,a.head_commit,a.head_tree],[b.project_id,b.repo_id,b.object_format,b.head_commit,b.head_tree],'Inventory and binding must share exact repository/commit/tree identity.');
  requireSame([base.project_id,base.repo_id],[a.project_id,a.repo_id],'Plan repository identity differs.');
  validateSourceScope(a.scope,baseline); validateSourceScope(b.scope,baseline);
  const units = inventory.units.filter(u => u.scope === 'adopted'), items = sorted(units.flatMap(u=>u.items));
  const next = new Map(evaluation.obligations.map(o=>[o.item,o])), prior = new Map(engine.target(binding.payload.intent.release_ref).obligations.map(o=>[o.item,o]));
  const pathsFor = (u: typeof units[number]) => sorted([...u.files.map(f=>f.path),...u.dependency_paths]);
  const mapping = items.map(item => {
    const matched = units.filter(u=>u.items.includes(item)), obligation = next.get(item), before = prior.get(item);
    if (!obligation || !before || !obligation.criteria.length) fail('ADOPTION_BRIDGE_MISMATCH',6,'Bridge cannot delete or introduce mapped intent obligations.');
    requireSame(sorted(obligation.criteria),sorted(before.criteria),'Bridge cannot change criterion membership.');
    return {item,unit_ids:sorted(matched.map(u=>u.id)),paths:sorted(matched.flatMap(pathsFor)),criteria:sorted(obligation.criteria)};
  });
  const criteria=sorted(mapping.flatMap(row=>row.criteria)).map(criterion_ref=>{const [block,id]=criterion_ref.split('/acceptance.'),criterion=evaluation.snapshot.blocks[block].acceptance[id];return {criterion_ref,check:criterion.check,version:criterion.version,fixture:criterion.fixture,method:criterion.method};});
  requireSame(base.criteria,criteria,'Bridge plan must retain exact complete target criterion metadata.');
  requireSame(base.acceptance_contract_sha256,digest({criteria,regressions:base.regressions,checker:base.checker}),'Bridge acceptance contract differs from target coverage.');
  const adoptedPaths = sorted(units.flatMap(pathsFor));
  for (const unit of units) requireSame(unit.criteria,sorted(unit.items.flatMap(item=>next.get(item)?.criteria??[])),'Adopted unit must retain its complete target criterion set.');
  requireSame(b.scope.items,items,'Binding cannot omit or invent adopted items.');
  requireSame(b.scope.mapping,mapping.map(({unit_ids,...row})=>row),'Binding must preserve exact adopted file/dependency/criterion mapping.');
  requireSame(b.entries.map(e=>e.path),adoptedPaths,'Binding must contain exactly the adopted file/dependency subset.');
  for (const entry of b.entries) requireSame(entry,a.entries.find(e=>e.path===entry.path),'Narrow binding entry differs from broad source.');
  if (b.entries.some(e=>!b.scope.mapping.some(m=>m.paths.includes(e.path)))) fail('ADOPTION_BRIDGE_MISMATCH',6,'Every bound file needs a real adopted semantic mapping.');
  const forbidden = sorted([...inventory.protected_paths,...inventory.units.filter(u=>u.scope==='outside'||u.disposition==='excluded').flatMap(pathsFor)]);
  if (base.write_paths.some((name: string)=>forbidden.includes(name) || !adoptedPaths.includes(name))) fail('PATCH_SCOPE',4,'Bridge writes overlap protected/unadopted content or lack adopted mapping.');
  for (const item of new Set([...prior.keys(),...next.keys()])) if (!same(prior.get(item)?.value??null,next.get(item)?.value??null) && !items.includes(item)) fail('ADOPTION_BRIDGE_MISMATCH',6,'Every changed item needs an adopted mapping.');
  return parse(gitBridgeSchema,{
    format:'git-adoption-bridge/1',model_version:MODEL,lane:'selected_git_patch',plan_contract_sha256:digest(bridgeBasePlan(base)),
    inventory_record:pin(engine,prepared.record.inventory_record_ref,'adoption-inventory',false),inventory_document_sha256:digest(inventory),
    proposal_record:pin(engine,publication.proposal_ref,'adoption-proposal',false),proposal_document_sha256:digest(prepared.proposal),
    interpretation_review:pin(engine,publication.review_ref,'adoption-review',false),publication:pin(engine,publicationRef,'adoption-publication',false),
    published_layer:pin(engine,publication.draft_ref,'layer',true),inventory_source:pin(engine,publication.source.ref,'source-snapshot',true),binding_source:pin(engine,binding.payload.source_ref,'source-snapshot',true),
    source_relation:{project_id:a.project_id,repo_id:a.repo_id,object_format:a.object_format,head_commit:a.head_commit,head_tree:a.head_tree,inventory_scope_sha256:a.scope_sha256,binding_scope_sha256:b.scope_sha256,mapping,preserved_paths:a.entries.map(e=>e.path).filter(name=>!base.write_paths.includes(name))},disclosure
  });
}
export function verifyGitBridge(engine: Engine, plan: any) {
  if (!isBridgedPlan(plan)) return;
  const bridge = parse(gitBridgeSchema,plan.adoption_bridge);
  requireSame(deriveGitBridge(engine,bridgeBasePlan(plan),bridge.publication.ref,bridge.disclosure),bridge,'Retained bridge differs from its exact private and public closure.');
  return bridge;
}
export function gitBridgePrivateEdges(plan: any): { ref: string; type: string }[] {
  if (!isBridgedPlan(plan)) return [];
  const bridge = parse(gitBridgeSchema,plan.adoption_bridge);
  return [{ref:bridge.inventory_record.ref,type:'adoption-inventory'},{ref:bridge.proposal_record.ref,type:'adoption-proposal'},
    {ref:bridge.interpretation_review.ref,type:'adoption-review'},{ref:bridge.publication.ref,type:'adoption-publication'}];
}
export function verifyGitBridgeEdges(records: Records, plan: any) {
  for (const edge of gitBridgePrivateEdges(plan)) if (records[edge.ref]?.type !== edge.type || records[edge.ref].published) fail('BACKUP_MISSING_REFERENCE',6,'Bridge requires its original specifically typed private lineage.');
}
export function gitBridgeSources(engine: Engine, plan: any) {
  const bridge = verifyGitBridge(engine,plan);
  if (!bridge) return;
  return { inventory:validateSourceSnapshot(engine.read(bridge.inventory_source.ref,'source-snapshot')),binding:validateSourceSnapshot(engine.read(bridge.binding_source.ref,'source-snapshot')) };
}
export function bridgeAuthority(context: SecurityContext, issuer: AuthorityIssuer): BridgeAuthority {
  issuer.assertLive(context);
  return {principal:context.principal_id,grant_id:context.grant_id,policy_version:context.policy_version,authority_sha256:issuer.accessBinding()};
}
function exactGrant(issuer: AuthorityIssuer, authority: BridgeAuthority, project: string) {
  const context = issuer.resolve(authority.grant_id,project);
  const expiry = context.expires_at ? Date.parse(context.expires_at) : null;
  if (context.principal_id !== authority.principal || context.trust_mode !== 'local_fixture' || expiry !== null && (!Number.isFinite(expiry) || expiry <= issuer.time())) fail('ENDORSEMENT_REVOKED',6,'The exact retained fixture grant no longer resolves to its original live principal grant.');
  issuer.assertLive(context); return context;
}
function blocks(context: SecurityContext, plan: BridgedPlan) {
  if (context.write_block_ids !== null && plan.adoption_bridge.source_relation.mapping.some(m=>!context.write_block_ids!.includes(m.item.split('/')[0]))) fail('BLOCK_SCOPE_FORBIDDEN',4,'Bridge exceeds the current assigned Block scope.');
}
export function authorizeGitBridge(engine: Engine, plan: any, acting: SecurityContext, issuer: AuthorityIssuer, ownerOnly=false) {
  const bridge = verifyGitBridge(engine,plan); if (!bridge) return;
  if (acting.trust_mode !== 'local_fixture' || acting.project_id !== plan.project_id) fail('UNSUPPORTED_ADOPTION_BRIDGE',8,'Bridge delivery requires the configured local fixture project.');
  if (ownerOnly && acting.principal_id !== bridge.disclosure.principal) fail('REF_NOT_FOUND',3,'Private adoption lineage is unavailable.');
  const owner = exactGrant(issuer,bridge.disclosure,plan.project_id);
  const request = {binding_ref:plan.binding_ref,target_ref:plan.target.ref,write_paths:plan.write_paths,checker:plan.checker,oracle:plan.oracle,regressions:plan.regressions};
  issuer.authorize(owner,'git.plan',request,engine); issuer.assertRepository(owner,'git.plan',plan.repo_id,plan.write_paths,plan.checker.id); blocks(owner,plan);
  issuer.authorize(owner,'adoption.review',{proposal_ref:bridge.proposal_record.ref},engine);
  issuer.authorize(owner,'layer.publish',{ref:bridge.published_layer.ref},engine);
  const review = parse(adoptionReviewSchema,engine.read(bridge.interpretation_review.ref,'adoption-review',false));
  const interpreter = exactGrant(issuer,{principal:review.principal,grant_id:review.grant_id,policy_version:review.policy_version,authority_sha256:review.authority_sha256},plan.project_id);
  issuer.authorize(interpreter,'adoption.review',{proposal_ref:bridge.proposal_record.ref},engine);
  const paths = engine.read(bridge.inventory_source.ref,'source-snapshot').entries.map((e: any)=>e.path);
  for (const context of [owner,interpreter,acting]) issuer.assertRepository(context,'source.capture',plan.repo_id,paths);
}
export function authorizeGitBridgeEvidence(engine: Engine, plan: any, acceptance: any, issuer: AuthorityIssuer) {
  if (!isBridgedPlan(plan)) return;
  if (acceptance.format !== 'git-acceptance/2' || acceptance.producer.trust !== 'local-fixed-fixture') fail('STALE_EVIDENCE',6,'Bridge requires host fixed-fixture evidence with exact retained grant provenance.');
  const producer = exactGrant(issuer,acceptance.producer,plan.project_id);
  issuer.authorize(producer,'git.check',{stage:acceptance.stage_ref,checker:plan.checker.id,oracle:plan.oracle},engine);
  issuer.assertRepository(producer,'git.check',plan.repo_id,plan.write_paths,plan.checker.id); issuer.assertGitEvidence(producer,acceptance.results);
}
export function authorizeGitBridgeReviewer(engine: Engine, plan: any, reviewer: BridgeAuthority, issuer: AuthorityIssuer) {
  if (!isBridgedPlan(plan)) return;
  const context = exactGrant(issuer,reviewer,plan.project_id), binding = readSourceBinding(engine,plan.binding_ref), source = readBindingSource(engine,binding), {snapshot} = validateIntentPin(engine,binding.payload.intent);
  issuer.authorize(context,'git.review',{},engine); issuer.assertRepository(context,'git.review',plan.repo_id,plan.write_paths);
  const scopes = [sourceAuthorityScope(snapshot,source.scope),engine.target(plan.target.ref).scope];
  if (scopes.some(scope=>!snapshot.authorities.scopes.some(a=>a.block===scope&&a.selectors.includes(context.principal_id)))) fail('AUTHORITY_FORBIDDEN',4,'Bridge review requires both responsible source and target scopes.');
}
export function verifyGitBridgeStage(plan: any, stage: any) {
  if (!isBridgedPlan(plan)) return;
  const operation = stage.operations[0];
  if (stage.operations.length !== 1 || operation.path !== 'counter.mjs' || operation.before.content === null || operation.after.content === null || operation.before.mode !== operation.after.mode || same(operation.before,operation.after)) fail('PATCH_SCOPE',4,'Bridge stage must modify exactly the existing module without mode changes.');
}
