import { parse, fail, digest, canonical, type Records } from './model.js';
import { finalizationSchema, allPlanSchema, stageSchema, receiptSchema, allAcceptanceSchema, allReviewSchema, gitAcceptanceV2Schema, gitReviewV2Schema } from './git-record-schemas.js';
import { isBridgedPlan } from './adoption/git-bridge-schema.js';

// Pure legacy schema/proof seam: source bindings must not import the delivery
// module, which now verifies adoption through source bindings in the other direction.
export { finalizationSchema as gitFinalizationSchema } from './git-record-schemas.js';
export function gitFinalizationBindingProof(records: Records, ref: string) {
  const stored = records[ref]; if (stored?.type !== 'git-finalization' || !stored.published) fail('REF_NOT_FOUND', 3, 'Exact Git finalization is required.');
  const finalization = parse(finalizationSchema, stored.data);
  if (ref !== 'git-finalization@' + digest(finalization)) fail('SOURCE_COMPLETION_REQUIRED', 6, 'Completion requires its exact content-addressed finalization.');
  verifyBridgedFinalizationClosure(records, finalization);
  return finalization;
}

/** Historical transitive proof only. Host state and grants belong to active gates.
 * This module imports pure schemas, so source binding cannot form a delivery cycle. */
export function verifyBridgedFinalizationClosure(records: Records, c: any) {
  const read = (ref: string, type: string, published = true) => {
    const stored = records[ref];
    if (!stored || stored.type !== type || stored.published !== published ||
        (type.startsWith('git-') || type.startsWith('adoption-') || type === 'source-snapshot') && ref !== type + '@' + digest(stored.data))
      fail('SOURCE_COMPLETION_REQUIRED', 6, 'Completion requires its exact typed content-addressed closure.');
    return stored.data;
  };
  // Establish the predecessor before dispatching by version. Missing records or
  // raw v1-shaped substitutions are not evidence of a legacy delivery.
  const receipt = parse(receiptSchema, read(c.receipt_ref,'git-apply-receipt'));
  const plan = parse(allPlanSchema, read(receipt.plan_ref,'git-change-plan'));
  const stage = parse(stageSchema, read(c.stage_ref, 'git-patch-stage'));
  const retainedAcceptance = parse(allAcceptanceSchema, read(c.acceptance_ref, 'git-acceptance'));
  const retainedReview = parse(allReviewSchema, read(c.review_ref, 'git-apply-review'));
  if (stage.plan_ref !== receipt.plan_ref || retainedAcceptance.plan_ref !== receipt.plan_ref || retainedReview.target.plan_ref !== receipt.plan_ref)
    fail('SOURCE_COMPLETION_REQUIRED',6,'Completion predecessors do not retain the same exact plan.');
  if (!isBridgedPlan(plan)) {
    if (retainedAcceptance.format !== 'git-acceptance/1' || retainedReview.format !== 'git-apply-review/1')
      fail('SOURCE_COMPLETION_REQUIRED',6,'Versioned delivery endorsements cannot become a legacy completion.');
    return; // Genuine typed/content-addressed v1 predecessors retain their proof path.
  }
  const acceptance = parse(gitAcceptanceV2Schema, read(c.acceptance_ref, 'git-acceptance'));
  const review = parse(gitReviewV2Schema, read(c.review_ref, 'git-apply-review')), t = review.target, b = plan.adoption_bridge;
  const equal = (a: unknown, v: unknown) => canonical(a) === canonical(v);
  const {adoption_bridge, ...base} = plan;
  for (const [pin, type, published] of [[b.inventory_record,'adoption-inventory',false],[b.proposal_record,'adoption-proposal',false],
    [b.interpretation_review,'adoption-review',false],[b.publication,'adoption-publication',false],[b.published_layer,'layer',true],
    [b.inventory_source,'source-snapshot',true],[b.binding_source,'source-snapshot',true]] as const) {
    const data = read(pin.ref,type,published);
    if (digest(data) !== pin.sha256 || !published && data.owner !== plan.owner)
      fail('SOURCE_COMPLETION_REQUIRED',6,'Completion lineage hash or private owner differs.');
  }
  const release = read(c.release_ref,'release'), validation = read(release.validation,'validation'), realization = read(validation.realization,'realization');
  const candidate = read(plan.target.ref,'composition'), publication = read(b.publication.ref,'adoption-publication',false),
    interpretation = read(b.interpretation_review.ref,'adoption-review',false), proposal = read(b.proposal_record.ref,'adoption-proposal',false),
    inventory = read(b.inventory_record.ref,'adoption-inventory',false);
  const snapshot = Object.fromEntries(['id','revision','model_version','root','blocks','authorities','deleted_ids'].map(key=>[key,release[key]]));
  if ([receipt,stage,acceptance,t,plan,b.source_relation].some(data=>data.project_id!==c.project_id||data.repo_id!==c.repo_id) ||
      plan.target.record_sha256 !== digest(candidate) || !equal(candidate.proposals,[b.published_layer.ref]) || !equal(candidate.selected,[b.published_layer.ref]) ||
      publication.proposal_ref !== b.proposal_record.ref || publication.review_ref !== b.interpretation_review.ref || publication.draft_ref !== b.published_layer.ref ||
      interpretation.proposal_ref !== b.proposal_record.ref || interpretation.draft_ref !== b.published_layer.ref || !interpretation.accepted ||
      proposal.inventory_record_ref !== b.inventory_record.ref || proposal.draft_ref !== b.published_layer.ref || inventory.draft_ref !== b.published_layer.ref ||
      b.inventory_document_sha256 !== digest(inventory.inventory) || b.proposal_document_sha256 !== digest(proposal.proposal) ||
      plan.base_source_ref !== b.binding_source.ref || plan.base_source_sha256 !== b.binding_source.sha256 ||
      b.plan_contract_sha256 !== digest({...base,format:'git-change-plan/1'}) || stage.plan_ref !== receipt.plan_ref ||
      receipt.stage_ref !== c.stage_ref || receipt.review_ref !== c.review_ref || receipt.binding_ref !== c.binding_ref || receipt.result_tree_oid !== c.head_tree ||
      receipt.base_commit !== c.base_commit || plan.binding_ref !== c.binding_ref || stage.result_tree_oid !== c.head_tree ||
      acceptance.plan_ref !== stage.plan_ref || acceptance.stage_ref !== c.stage_ref || acceptance.result_tree_oid !== stage.result_tree_oid ||
      acceptance.result_manifest_sha256 !== stage.result_manifest_sha256 || acceptance.base_source_ref !== plan.base_source_ref ||
      acceptance.acceptance_contract_sha256 !== plan.acceptance_contract_sha256 || !equal(acceptance.target,plan.target) || !equal(acceptance.checker,plan.checker) ||
      t.plan_ref !== stage.plan_ref || t.stage_ref !== c.stage_ref || t.stage_sha256 !== digest(stage) || t.acceptance_ref !== c.acceptance_ref ||
      t.acceptance_sha256 !== digest(acceptance) || t.binding_ref !== c.binding_ref || t.release_ref !== c.release_ref || t.release_sha256 !== digest(release) ||
      t.adoption_bridge_sha256 !== digest(b) || review.target_sha256 !== digest(t) || !review.accepted || review.principal !== t.reviewer.principal ||
      t.policy_version !== t.reviewer.policy_version || t.candidate !== c.candidate || t.snapshot_sha256 !== c.snapshot_sha256 ||
      release.state !== 'validated' || release.candidate !== plan.target.candidate_fingerprint || digest(snapshot) !== plan.target.snapshot_sha256 ||
      c.release_sha256 !== digest(release) || c.snapshot_sha256 !== plan.target.snapshot_sha256 || validation.target !== plan.target.ref ||
      realization.target !== plan.target.ref || realization.profile_id !== 'counter-fixture/1' || realization.checker_sha256 !== plan.checker.sha256 ||
      realization.fixture_sha256 !== plan.checker.fixture_sha256 || realization.oracle_sha256 !== plan.checker.oracle_sha256)
    fail('SOURCE_COMPLETION_REQUIRED',6,'Completion does not retain the exact versioned bridge delivery proof.');
  const results = acceptance.results.map(({passed,reviewer,...result})=>result).sort((a,b)=>a.criterion_ref.localeCompare(b.criterion_ref));
  if (!equal(results,plan.criteria) || acceptance.results.some(result=>!result.passed || (result.method==='review'?!result.reviewer:result.reviewer!==null)) ||
      !equal(acceptance.regressions.map(result=>result.id).sort(),plan.regressions) || acceptance.regressions.some(result=>!result.passed))
    fail('SOURCE_COMPLETION_REQUIRED',6,'Completion lacks every passing frozen criterion and regression.');
}
