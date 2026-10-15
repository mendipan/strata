import { MODEL, bytesDigest, digest } from '../../../src/model.js';
import { createDriftHostProof } from '../../../src/source-drift.js';
import { executeDrift } from '../../../src/reconciliation.js';
import { createSourceHostProof, executeSourceBinding } from '../../../src/source-binding.js';
import type { R1CompletionReceipt, R1CompletionExpectation } from '../../../src/reconciliation-completion-r1.js';
import { changedObservation, sourceFixture } from '../../source-fixture.js';
import { recipe, proposal as layerProposal, demoLayers } from '../../../src/fixtures.js';
import { unitValidation, approvals } from '../../helpers.js';

// Entirely synthetic retained packets. No Git/app/runner operation occurs here.
// Literal criteria are independent of the completion validator's derivation.
export const R1_CRITERIA = [
  { criterion_ref: 'booking.hold/acceptance.expiry', check: 'booking.expiry', version: '1', fixture: 'expiry', method: 'mechanical' as const },
  { criterion_ref: 'booking.hold/acceptance.lifecycle', check: 'booking.lifecycle', version: '1', fixture: 'lifecycle', method: 'mechanical' as const },
];
export function r1Fixture(trust: 'local-fixed-fixture' | 'local-fixture-import' = 'local-fixed-fixture', reviewOnly = false, validatedRelease = false, withLayer = false) {
  const selected = reviewOnly ? 'app/purpose' : 'booking.hold/requirements.expiry';
  const f = sourceFixture(selected);
  if (validatedRelease) {
    const empty = recipe('C-synthetic-r1'); empty.proposals = []; empty.selected = []; empty.alternative_groups = [];
    if (withLayer) {
      const layer = layerProposal('L-synthetic-r1', f.author.principal_id);
      f.engine.layer(layer, layer.owner); f.engine.publish('L-synthetic-r1@1', layer.owner);
      empty.proposals = ['L-synthetic-r1@1']; empty.selected = ['L-synthetic-r1@1'];
    }
    const candidate = f.engine.compose(empty), { validation } = unitValidation(f.engine, candidate);
    const released = f.engine.release(candidate.ref, validation.ref, approvals(f.engine, candidate, validation.evidence_digest));
    f.payload = { ...f.payload, intent: { ...f.payload.intent, release_ref: released.ref, release_sha256: digest(f.engine.read(released.ref)), snapshot_sha256: digest(f.engine.target(released.ref).snapshot) }, basis: 'validated-release-association', limitations: ['Synthetic imported profile validation; no app execution occurred.'] };
  }
  if (!reviewOnly) {
    // The standalone lifecycle criterion is a selected obligation of its own;
    // its subjects alone do not add it to expiry's declared acceptance list.
    const scope = structuredClone(f.source.scope);
    scope.items.unshift('booking.hold/acceptance.lifecycle');
    scope.mapping.unshift({ item: 'booking.hold/acceptance.lifecycle', paths: ['src/app.txt'], criteria: ['booking.hold/acceptance.lifecycle'] });
    f.source = { ...f.source, scope, scope_sha256: digest(scope) };
    f.observation = { ...f.observation, scope_sha256: digest(scope) };
    f.sourceRef = executeSourceBinding(f.engine, 'source.capture', { repo_id: f.source.repo_id, scope }, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)).ref;
    f.payload = { ...f.payload, source_ref: f.sourceRef, source_sha256: digest(f.source) };
    f.bindingRef = executeSourceBinding(f.engine, 'source.bind', { ...f.bindInput, payload: f.payload, expected_payload_sha256: digest(f.payload) }, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)).ref;
  }
  if (validatedRelease && reviewOnly) {
    f.bindingRef = executeSourceBinding(f.engine, 'source.bind', { ...f.bindInput, payload: f.payload, expected_payload_sha256: digest(f.payload) }, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)).ref;
  }
  const observation = changedObservation(f);
  const releaseRef = f.payload.intent.release_ref;
  const target = { ref: releaseRef, record_sha256: digest(f.engine.read(releaseRef)), snapshot_sha256: digest(f.engine.target(releaseRef).snapshot), candidate_fingerprint: f.engine.target(releaseRef).fingerprint };
  const oracle = { format: 'synthetic-r1-oracle/1', expected: 600 };
  const checker = { id: 'synthetic-r1-checker', version: '1', sha256: digest('synthetic-checker-bytes'), fixture_sha256: digest('synthetic-fixture-bytes'), oracle_sha256: digest(oracle) };
  const criteria = reviewOnly ? [{ criterion_ref: 'app/acceptance.review', check: 'intent.review', version: '1', fixture: 'app', method: 'review' as const }] : R1_CRITERIA;
  const regressions = ['synthetic-preservation'];
  const acceptance_contract_sha256 = digest({ criteria, regressions, checker });
  const retain = (type: string, data: any) => { const ref = type + '@' + digest(data); f.engine.store(ref, type, data); return { ref, sha256: digest(data) }; };
  const plan = { format: 'git-change-plan/1', project_id: f.selector.project_id, repo_id: f.source.repo_id, binding_ref: f.bindingRef, base_source_ref: f.sourceRef, base_source_sha256: digest(f.source), target, write_paths: ['src/app.txt'], criteria, checker, oracle, regressions, acceptance_contract_sha256, owner: f.author.principal_id };
  const planPin = retain('git-change-plan', plan);
  const patch = 'diff --git a/src/app.txt b/src/app.txt\n--- a/src/app.txt\n+++ b/src/app.txt\n@@ -1 +1 @@\n-hello\n+changed\n';
  const stage = { format: 'git-patch-stage/1', project_id: plan.project_id, repo_id: plan.repo_id, plan_ref: planPin.ref, patch, patch_sha256: bytesDigest(patch),
    operations: [{ path: 'src/app.txt', before: { content: 'hello\n', sha256: bytesDigest('hello\n'), mode: '100644' }, after: { content: 'changed\n', sha256: bytesDigest('changed\n'), mode: '100644' } }],
    result_tree_oid: 'c'.repeat(40), result_manifest_sha256: observation.manifest_sha256, unchanged_outside_write_set: true, base_index_digest: observation.index_sha256, owner: f.author.principal_id };
  const stagePin = retain('git-patch-stage', stage);
  const producer = { principal: 'synthetic-r1-producer', trust, execution_authenticated: false as const };
  const evidence = { format: 'git-application-observation/1', project_id: plan.project_id, repo_id: plan.repo_id, plan_ref: planPin.ref, stage_ref: stagePin.ref, target, base_source_ref: f.sourceRef,
    result_tree_oid: stage.result_tree_oid, result_manifest_sha256: stage.result_manifest_sha256, acceptance_contract_sha256, checker,
    results: criteria.map(row => ({ ...row, passed: false, reviewer: row.method === 'review' ? 'synthetic-r1-reviewer' : null })), regressions: [{ id: regressions[0], passed: false }],
    producer, limitations: ['Synthetic retained observations; no application execution occurred.'], observations_sha256: digest('synthetic-before-observations') };
  const basis = retain('git-application-observation', evidence);
  const checked = executeDrift(f.engine, 'drift.check', { binding_ref: f.bindingRef, evidence_refs: [basis.ref] }, f.author, f.issuer, createDriftHostProof(observation));
  const report = f.engine.read(checked.ref, 'drift-report');
  const proposed = executeDrift(f.engine, 'drift.propose', { report_ref: checked.ref, expected_report_sha256: digest(report), action: 'revalidate', rationale: 'Recheck the named synthetic contract for exact changed bytes.', paths: ['src/app.txt'], items: [...f.source.scope.items], layer_refs: [], patch_refs: [], evidence_refs: [basis.ref], questions: [], supersedes: null }, f.author, f.issuer);
  const proposal = f.engine.read(proposed.ref, 'reconciliation-proposal');
  const reviewed = executeDrift(f.engine, 'drift.review', { proposal_ref: proposed.ref, expected_proposal_sha256: digest(proposal), decision: 'approve_plan', rationale: 'Approve the exact synthetic revalidation plan only.', questions: [] }, f.selector, f.issuer, createDriftHostProof(observation));
  const review = f.engine.read(reviewed.ref, 'reconciliation-review');
  const after = { ...evidence, results: evidence.results.map(row => ({ ...row, passed: true })), regressions: [{ id: regressions[0], passed: true }], observations_sha256: digest('synthetic-after-observations') };
  const fresh = retain('git-application-observation', after);
  const receipt: R1CompletionReceipt = { format: 'reconciliation-completion-receipt/1', model_version: MODEL, action: 'revalidate', project_id: plan.project_id, repo_id: plan.repo_id,
    proposal: { ref: proposed.ref, sha256: digest(proposal) }, review: { ref: reviewed.ref, sha256: digest(review) }, report: { ref: checked.ref, sha256: digest(report) }, binding: { ref: f.bindingRef, sha256: digest(f.engine.read(f.bindingRef)) }, target,
    basis_evidence: basis, evidence: fresh, observation, acceptance_contract_sha256, checker, producer, outcome: 'revalidated-selected-evidence', git_finalization_ref: null, successor_binding_ref: null };
  const expected: R1CompletionExpectation = { project_id: plan.project_id, repo_id: plan.repo_id, review: receipt.review, basis_evidence: basis, observation_sha256: digest(observation) };
  return { records: f.engine.records, receipt, expected, reviewed, planPin, stagePin, sourceRef: f.sourceRef };
}
export type R1Fixture = ReturnType<typeof r1Fixture>;

// Re-sign mutated evidence so semantic failures cannot hide behind a stale digest.
export function replaceEvidence(f: R1Fixture, edit: (data: any) => void) {
  const old = f.receipt.evidence.ref, data = structuredClone(f.records[old].data); edit(data);
  const type = f.records[old].type, exact = type + '@' + digest(data);
  f.records[exact] = { type, published: true, data }; delete f.records[old];
  f.receipt.evidence = { ref: exact, sha256: digest(data) };
}
export function replaceReview(f: R1Fixture, edit: (data: any) => void) {
  const old = f.receipt.review.ref, data = structuredClone(f.records[old].data); edit(data);
  const exact = 'reconciliation-review@' + digest(data);
  f.records[exact] = { type: 'reconciliation-review', published: true, data }; delete f.records[old];
  f.receipt.review = { ref: exact, sha256: digest(data) }; f.expected.review = f.receipt.review;
}
export function replaceProposal(f: R1Fixture, edit: (data: any) => void) {
  const old = f.receipt.proposal.ref, data = structuredClone(f.records[old].data); edit(data);
  const exact = 'reconciliation-proposal@' + digest(data);
  f.records[exact] = { type: 'reconciliation-proposal', published: true, data }; delete f.records[old];
  f.receipt.proposal = { ref: exact, sha256: digest(data) };
  replaceReview(f, review => { review.proposal_ref = exact; review.proposal_sha256 = digest(data); });
}

export const R1_NEGATIVE_FIXTURES: { name: string; code: string; edit: (f: R1Fixture) => void }[] = [
  { name: 'plan-only completion', code: 'R1_FRESH_EVIDENCE_REQUIRED', edit: f => { f.receipt.evidence = f.receipt.basis_evidence; } },
  { name: 'reused observation bytes with a changed packet', code: 'R1_FRESH_EVIDENCE_REQUIRED', edit: f => replaceEvidence(f, d => { d.observations_sha256 = f.records[f.receipt.basis_evidence.ref].data.observations_sha256; }) },
  { name: 'wrong target Release ref', code: 'R1_PIN_MISMATCH', edit: f => { f.receipt.target.ref = 'Other@1'; } },
  { name: 'changed target record pin', code: 'R1_PIN_MISMATCH', edit: f => { f.receipt.target.record_sha256 = digest('substituted'); } },
  { name: 'stale proposal pin', code: 'R1_PIN_MISMATCH', edit: f => { f.receipt.proposal.sha256 = digest('substituted'); } },
  { name: 'changed HEAD after approval', code: 'R1_PIN_MISMATCH', edit: f => { f.receipt.observation.head_commit = 'd'.repeat(40); } },
  { name: 'changed index after approval', code: 'R1_PIN_MISMATCH', edit: f => { f.receipt.observation.index_sha256 = digest('new-index'); } },
  { name: 'changed ignored inventory', code: 'R1_PIN_MISMATCH', edit: f => { f.receipt.observation.ignored_count++; } },
  { name: 'imported evidence upgraded to measured', code: 'INVALID_RECORD', edit: f => { (f.receipt.producer as any).trust = 'host-measured'; } },
  { name: 'fabricated authenticated execution', code: 'INVALID_RECORD', edit: f => { (f.receipt.producer as any).execution_authenticated = true; } },
  { name: 'fabricated Git finalization association', code: 'INVALID_RECORD', edit: f => { (f.receipt as any).git_finalization_ref = 'git-finalization@' + digest('fabricated'); } },
  { name: 'fabricated successor binding', code: 'INVALID_RECORD', edit: f => { (f.receipt as any).successor_binding_ref = 'source-binding@' + digest('fabricated'); } },
  { name: 'fabricated owner commit', code: 'INVALID_RECORD', edit: f => { (f.receipt as any).owner_commit = 'd'.repeat(40); } },
  { name: 'unsupported action', code: 'INVALID_RECORD', edit: f => { (f.receipt as any).action = 'accept_code'; } },
  { name: 'v0.3 record reinterpretation', code: 'INVALID_RECORD', edit: f => { (f.receipt as any).model_version = 'strata/0.3-block-lifecycle-experimental'; } },
  { name: 'missing source closure', code: 'R1_CLOSURE_REQUIRED', edit: f => { delete f.records[f.sourceRef]; } },
  { name: 'missing staged closure', code: 'R1_CLOSURE_REQUIRED', edit: f => { delete f.records[f.stagePin.ref]; } },
  { name: 'missing frozen checker contract', code: 'R1_CLOSURE_REQUIRED', edit: f => { delete f.records[f.planPin.ref]; } },
  { name: 'unpublished evidence', code: 'R1_CLOSURE_REQUIRED', edit: f => { f.records[f.receipt.evidence.ref].published = false; } },
  { name: 'missing active criterion', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.results.pop(); }) },
  { name: 'duplicate active criterion', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.results.push(d.results[0]); }) },
  { name: 'unknown active criterion', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.results[0].criterion_ref = 'app/acceptance.review'; }) },
  { name: 'failed result', code: 'R1_ACCEPTANCE_INCOMPLETE', edit: f => replaceEvidence(f, d => { d.results[0].passed = false; }) },
  { name: 'failed regression', code: 'R1_ACCEPTANCE_INCOMPLETE', edit: f => replaceEvidence(f, d => { d.regressions[0].passed = false; }) },
  { name: 'missing regression', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.regressions = []; }) },
  { name: 'checker substitution', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.checker.sha256 = digest('other-checker'); }) },
  { name: 'fixture substitution', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.checker.fixture_sha256 = digest('other-fixture'); }) },
  { name: 'oracle substitution', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.checker.oracle_sha256 = digest('other-oracle'); }) },
  { name: 'recorded trust substitution', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.producer.trust = 'local-fixture-import'; }) },
  { name: 'recorded producer substitution', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.producer.principal = 'other-producer'; }) },
  { name: 'source manifest substitution', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.result_manifest_sha256 = digest('other-source'); }) },
  { name: 'source tree substitution', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.result_tree_oid = 'd'.repeat(40); }) },
  { name: 'foreign repository evidence', code: 'R1_PIN_MISMATCH', edit: f => replaceEvidence(f, d => { d.repo_id = 'other-repository'; }) },
  { name: 'deferred review', code: 'R1_APPROVED_ACTION_REQUIRED', edit: f => replaceReview(f, d => { d.decision = 'defer'; d.state = 'deferred'; d.fresh_observation_sha256 = null; }) },
  { name: 'copied reviewer label', code: 'SOURCE_INTEGRITY', edit: f => replaceReview(f, d => { d.reviewer = 'author-a'; }) },
  { name: 'unresolved review question', code: 'SOURCE_INTEGRITY', edit: f => replaceReview(f, d => { d.questions = ['Still unresolved.']; }) },
  { name: 'checker evidence not named in approved proposal', code: 'R1_REVIEWED_EVIDENCE_REQUIRED', edit: f => replaceProposal(f, d => { d.evidence_refs = []; }) },
  { name: 'subset completion presented as full selected coverage', code: 'R1_PIN_MISMATCH', edit: f => replaceProposal(f, d => { d.items = ['booking.hold/requirements.expiry']; }) },
];

// These mutate only retained semantic predecessors. Receipt and expectation pins
// stay byte-identical, as in the independent review's P2 reproducer.
const ancestors = (f: R1Fixture) => {
  const release = f.records[f.receipt.target.ref].data, validation = f.records[release.validation].data;
  return { bootstrap: f.records[release.baseline].data, composition: f.records[validation.target].data };
};
export const R1_SEMANTIC_NEGATIVE_FIXTURES: { name: string; code: string; edit: (f: R1Fixture) => void }[] = [
  { name: 'changed ancestor bootstrap', code: 'R1_PIN_MISMATCH', edit: f => { ancestors(f).bootstrap.blocks.app.purpose = 'Tampered ancestor'; } },
  { name: 'changed frozen Composition scenario', code: 'R1_PIN_MISMATCH', edit: f => { ancestors(f).composition.scenario.checks = []; } },
  { name: 'v0.3 Composition predecessor', code: 'UNSUPPORTED_MODEL_VERSION', edit: f => { ancestors(f).composition.model_version = 'strata/0.3-block-lifecycle-experimental'; } },
  { name: 'unknown Composition predecessor field', code: 'INVALID_RECORD', edit: f => { ancestors(f).composition.claimed_authority = true; } },
  { name: 'v0.3 bootstrap predecessor', code: 'UNSUPPORTED_MODEL_VERSION', edit: f => { ancestors(f).bootstrap.model_version = 'strata/0.3-block-lifecycle-experimental'; } },
  { name: 'unknown bootstrap predecessor field', code: 'INVALID_RECORD', edit: f => { ancestors(f).bootstrap.claimed_authority = true; } },
  { name: 'substituted Composition identity', code: 'R1_PIN_MISMATCH', edit: f => { ancestors(f).composition.revision++; } },
  { name: 'substituted bootstrap identity', code: 'R1_PIN_MISMATCH', edit: f => { ancestors(f).bootstrap.id = 'OtherBootstrap'; } },
  { name: 'v0.3 Layer predecessor', code: 'UNSUPPORTED_MODEL_VERSION', edit: f => { f.records['L-synthetic-r1@1'].data.model_version = 'strata/0.3-block-lifecycle-experimental'; } },
  { name: 'unknown Layer predecessor field', code: 'INVALID_RECORD', edit: f => { f.records['L-synthetic-r1@1'].data.claimed_authority = true; } },
  { name: 'substituted Layer identity', code: 'R1_PIN_MISMATCH', edit: f => { f.records['L-synthetic-r1@1'].data.revision++; } },
  { name: 'changed retained Layer behavior', code: 'R1_PIN_MISMATCH', edit: f => { f.records['L-synthetic-r1@1'].data.changes = demoLayers().a.changes; } },
];
