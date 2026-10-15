import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, digest } from '../src/model.js';
import { createDriftHostProof, buildDriftReport } from '../src/source-drift.js';
import { executeDrift, verifyDriftHistory } from '../src/reconciliation.js';
import { sourceFixture, changedObservation, proposalFixture } from './source-fixture.js';
import { demoLayers, recipe } from '../src/fixtures.js';
import { createSourceHostProof, executeSourceBinding } from '../src/source-binding.js';
import { executeAuthorized } from '../src/service.js';
const code = (value: string) => (error: any) => error.code === value;

test('byte-only source changes produce a real report and stable approved revalidation plan', () => {
  const f = sourceFixture(), release = canonical(f.engine.read('R0@1')), p = proposalFixture(f), beforeCount = Object.values(f.engine.records).filter(r => r.type === 'source-binding').length;
  assert.equal(p.report.source_changes[0].kind, 'bytes-changed'); assert.equal(p.report.behavior_status, 'unknown'); assert.equal(p.report.coverage.scope_complete, true); assert.equal(p.report.coverage.acceptance_complete, false);
  const review = executeDrift(f.engine, 'drift.review', p.reviewInput, f.selector, f.issuer, createDriftHostProof(p.observation)); assert.ok('state' in review && 'completion' in review); assert.equal(review.state, 'approved_plan'); assert.equal(review.completion, false);
  assert.equal(Object.values(f.engine.records).filter(r => r.type === 'source-binding').length, beforeCount); assert.equal(canonical(f.engine.read('R0@1')), release); verifyDriftHistory(f.engine.records, f.selector.project_id);
});
test('unchanged source, harmless whitespace and nontext have no inferred semantic verdict', () => {
  const f = sourceFixture(), same = buildDriftReport(f.engine, { binding_ref: f.bindingRef }, f.observation, f.author.principal_id); assert.equal(same.assessment, 'no-source-delta'); assert.equal(same.behavior_status, 'unknown');
  for (const bytes of ['hello\n\n', new Uint8Array([255, 0, 254])]) { const report = buildDriftReport(f.engine, { binding_ref: f.bindingRef }, changedObservation(f, bytes), f.author.principal_id); assert.equal(report.source_changes[0].kind, 'bytes-changed'); assert.equal(report.behavior_status, 'unknown'); }
});
test('intent-only and simultaneous changes retain exact item differences independently', () => {
  const f = sourceFixture(), layer = demoLayers().a; f.engine.layer(layer, layer.owner); f.engine.publish('L-hold@1', layer.owner);
  const composition = recipe('C-source-intent'); composition.proposals = ['L-hold@1']; composition.selected = ['L-hold@1']; composition.alternative_groups = []; const candidate = f.engine.compose(composition);
  const report = buildDriftReport(f.engine, { binding_ref: f.bindingRef, against: candidate.ref }, f.observation, f.author.principal_id);
  assert.equal(report.source_changes.length, 0); assert.ok(report.intent_changes.some(c => c.item === 'booking.hold/requirements.expiry')); assert.equal(report.behavior_status, 'unknown');
  const both = buildDriftReport(f.engine, { binding_ref: f.bindingRef, against: candidate.ref }, changedObservation(f), f.author.principal_id); assert.ok(both.source_changes.length && both.intent_changes.length);
});
test('exclusions are disclosed and changed ignored counts never certify hidden contents', () => {
  const f = sourceFixture(), o = structuredClone(f.observation); o.ignored_count = 1; o.excluded_count = 2;
  const report = buildDriftReport(f.engine, { binding_ref: f.bindingRef }, o, f.author.principal_id); assert.equal(report.observation.ignored_count, 1); assert.equal(report.behavior_status, 'unknown'); assert.ok(report.limitations.some(s => s.includes('Ignored')));
  assert.equal(JSON.stringify(report).includes('secret-contents-canary'), false);
});
test('missing/deleted artifacts, renamed paths and ambiguity are explicit coverage blockers', () => {
  const f = sourceFixture(), o = structuredClone(f.observation); o.entries[0] = { path: 'src/app.txt', presence: 'absent', kind: null, mode: null, byte_length: null, sha256: null }; o.entries.push({ ...f.source.entries[0], path: 'src/renamed.txt' }); o.manifest_sha256 = digest(o.entries);
  let report = buildDriftReport(f.engine, { binding_ref: f.bindingRef }, o, f.author.principal_id); assert.deepEqual(report.source_changes.map(c => c.kind), ['deleted', 'added']); assert.equal(report.possible_renames[0].ambiguous, false); assert.equal(report.coverage.scope_complete, false);
  o.entries.push({ ...f.source.entries[0], path: 'src/second.txt' }); o.entries.sort((a, b) => a.path < b.path ? -1 : 1); o.manifest_sha256 = digest(o.entries); report = buildDriftReport(f.engine, { binding_ref: f.bindingRef }, o, f.author.principal_id); assert.equal(report.possible_renames[0].ambiguous, true);
});
test('new watched paths, mode changes and unsupported types cannot disappear from report', () => {
  const f = sourceFixture(), o = structuredClone(f.observation); o.entries.push({ ...o.entries[0], path: 'src/new.txt', mode: null }); o.manifest_sha256 = digest(o.entries); const report = buildDriftReport(f.engine, { binding_ref: f.bindingRef }, o, f.author.principal_id); assert.deepEqual(report.coverage.unmapped_paths, ['src/new.txt']); assert.equal(report.assessment, 'blocked');
  const mode = structuredClone(f.observation); mode.entries[0].mode = '100755'; mode.manifest_sha256 = digest(mode.entries); assert.equal(buildDriftReport(f.engine, { binding_ref: f.bindingRef }, mode, f.author.principal_id).source_changes[0].kind, 'mode-changed');
});
test('staged, unstaged, untracked and unrelated dirty observations remain plan-only', () => {
  for (const flag of ['staged', 'unstaged', 'untracked'] as const) { const f = sourceFixture(), o = changedObservation(f); o.status[0] = { path: 'src/app.txt', staged: false, unstaged: false, untracked: false, [flag]: true }; o.outside_scope_dirty = true; const p = proposalFixture(f, o); assert.equal(p.report.observation.status[0][flag], true); const result = executeDrift(f.engine, 'drift.review', p.reviewInput, f.selector, f.issuer, createDriftHostProof(o)); assert.ok('completion' in result); assert.equal(result.completion, false); }
});
test('any byte, HEAD, index, inventory, ignore count or status change invalidates exact review', () => {
  const edits = [(o: any) => o.entries[0].sha256 = digest('later'), (o: any) => o.head_commit = 'f'.repeat(40), (o: any) => o.index_sha256 = digest('new-index'), (o: any) => o.ignored_count++, (o: any) => o.status[0].staged = true];
  for (const edit of edits) { const f = sourceFixture(), p = proposalFixture(f), o = structuredClone(p.observation); edit(o); o.manifest_sha256 = digest(o.entries); assert.throws(() => executeDrift(f.engine, 'drift.review', p.reviewInput, f.selector, f.issuer, createDriftHostProof(o)), code('SOURCE_SNAPSHOT_STALE')); assert.equal(Object.values(f.engine.records).some(r => r.type === 'reconciliation-review'), false); }
});
test('incoherent snapshots fail and partial coverage cannot get approved plan', () => {
  const f = sourceFixture(), o = structuredClone(f.observation); o.coherence = 'changed-during-read'; assert.throws(() => buildDriftReport(f.engine, { binding_ref: f.bindingRef }, o, f.author.principal_id), code('SOURCE_SNAPSHOT_STALE'));
  const partial = changedObservation(f); partial.entries = []; partial.manifest_sha256 = digest([]); const p = proposalFixture(f, partial); assert.throws(() => executeDrift(f.engine, 'drift.review', p.reviewInput, f.selector, f.issuer, createDriftHostProof(partial)), code('SOURCE_COVERAGE_INCOMPLETE'));
});
test('SDK imports cannot claim measurement or approve live-source plans', () => {
  const f = sourceFixture(), result = executeDrift(f.engine, 'drift.check', { binding_ref: f.bindingRef, imported_observation: changedObservation(f) }, f.author, f.issuer), report = f.engine.read(result.ref); assert.equal(report.producer.trust, 'imported-snapshot');
  assert.throws(() => executeDrift(f.engine, 'drift.check', { binding_ref: f.bindingRef }, f.author, f.issuer), code('UNSUPPORTED_SOURCE_BACKEND'));
  const p = proposalFixture(f); assert.throws(() => executeDrift(f.engine, 'drift.review', p.reviewInput, f.selector, f.issuer), code('UNSUPPORTED_SOURCE_BACKEND'));
});

test('shared SDK dispatch retains imported reports and proposals without creating host authority', () => {
  const f = sourceFixture(), input = { binding_ref: f.bindingRef, imported_observation: changedObservation(f) };
  const checked = executeAuthorized(f.engine, 'drift.check', input, f.author, f.issuer), report = f.engine.read(checked.ref); assert.equal(report.producer.trust, 'imported-snapshot');
  const proposalInput = { ...proposalFixture(f).input, report_ref: checked.ref, expected_report_sha256: digest(report) }, proposed = executeAuthorized(f.engine, 'drift.propose', proposalInput, f.author, f.issuer), proposal = f.engine.read(proposed.ref);
  const review = { proposal_ref: proposed.ref, expected_proposal_sha256: digest(proposal), decision: 'approve_plan', rationale: 'Import does not establish a host proof.', questions: [] };
  assert.throws(() => executeAuthorized(f.engine, 'drift.review', review, f.selector, f.issuer), code('UNSUPPORTED_SOURCE_BACKEND'));
  assert.equal(executeAuthorized(f.engine, 'drift.review', { ...review, decision: 'defer' }, f.author, f.issuer).state, 'deferred');
});

test('supplied intent and patch handoffs cannot exceed exact mapped items or reuse another baseline', () => {
  const f = sourceFixture(), p = proposalFixture(f), initial = { id: 'DriftLayer', revision: 1, model_version: f.payload.intent.model_version, owner: f.author.principal_id, baseline: 'R0@1', intent: 'Explicit selected purpose edit.', changes: [{ op: 'set_item', block: 'app', path: 'purpose', expected: { kind: 'value', value: f.engine.target('R0@1').snapshot.blocks.app.purpose }, value: 'Explicit changed purpose.' }], requires_layers: [], read_set: [], assumptions: [], acceptance: [], resolution_proposals: [], derived_from: null };
  f.engine.layer(initial, f.author.principal_id); const proposed = executeDrift(f.engine, 'drift.propose', { ...p.input, action: 'update_intent', layer_refs: ['DriftLayer@1'] }, f.author, f.issuer); assert.ok('action' in proposed); assert.equal(proposed.action, 'update_intent');
  const criterion = f.engine.target('R0@1').snapshot.blocks.app.acceptance.review;
  f.engine.layer({ ...initial, id: 'UnscopedLayer', changes: [{ ...initial.changes[0], path: 'acceptance.review', expected: { kind: 'value', value: criterion }, value: { ...criterion, statement: 'Explicit unscoped criterion change.' } }] }, f.author.principal_id);
  assert.throws(() => executeDrift(f.engine, 'drift.propose', { ...p.input, action: 'update_intent', layer_refs: ['UnscopedLayer@1'] }, f.author, f.issuer), code('BLOCK_SCOPE_FORBIDDEN'));
  const planRef = 'git-change-plan@' + digest('wrong-binding'), stageRef = 'git-patch-stage@' + digest('wrong-binding-stage');
  f.engine.store(planRef, 'git-change-plan', { binding_ref: 'source-binding@other', target: p.report.observed_intent }); f.engine.store(stageRef, 'git-patch-stage', { project_id: f.selector.project_id, repo_id: f.source.repo_id, plan_ref: planRef, operations: [{ path: 'src/app.txt' }] });
  assert.throws(() => executeDrift(f.engine, 'drift.propose', { ...p.input, patch_refs: [stageRef] }, f.author, f.issuer), code('SOURCE_SNAPSHOT_STALE'));
});
test('review scope/owner/foreign repo/copied labels and revoked authorities are enforced', () => {
  const f = sourceFixture(), p = proposalFixture(f); assert.throws(() => executeDrift(f.engine, 'drift.review', p.reviewInput, f.author, f.issuer, createDriftHostProof(p.observation)), code('AUTHORITY_FORBIDDEN'));
  assert.throws(() => executeDrift(f.engine, 'drift.review', { ...p.reviewInput, reviewer: 'scope-selector' }, f.selector, f.issuer, createDriftHostProof(p.observation)), code('INVALID_RECORD'));
  const narrow = f.issuer.resolve('fixture-source-narrow'); assert.throws(() => executeDrift(f.engine, 'drift.propose', p.input, narrow, f.issuer), code('BLOCK_SCOPE_FORBIDDEN'));
  f.issuer.suspendForTest('scope-selector'); assert.throws(() => executeDrift(f.engine, 'drift.review', p.reviewInput, f.selector, f.issuer, createDriftHostProof(p.observation)), code('ACCESS_REVOKED'));
});
test('request changes, defer and rejection preserve inspectable plan history', () => {
  const f = sourceFixture(), p = proposalFixture(f);
  for (const [decision, state] of [['request_changes', 'changes_requested'], ['defer', 'deferred'], ['reject', 'rejected']]) { const r = executeDrift(f.engine, 'drift.review', { ...p.reviewInput, decision, questions: ['Behavior remains unverified.'] }, f.author, f.issuer); assert.ok('state' in r); assert.equal(r.state, state); }
  assert.equal(f.engine.read(p.proposalRef).state, 'proposed'); verifyDriftHistory(f.engine.records, f.selector.project_id);
});
test('unresolved questions, accept-code without evidence and supplied intent omissions fail closed', () => {
  const f = sourceFixture(), p = proposalFixture(f); assert.throws(() => executeDrift(f.engine, 'drift.review', { ...p.reviewInput, questions: ['Unknown'] }, f.selector, f.issuer, createDriftHostProof(p.observation)), code('SOURCE_COVERAGE_INCOMPLETE'));
  assert.throws(() => executeDrift(f.engine, 'drift.propose', { ...p.input, action: 'update_intent' }, f.author, f.issuer), code('RECONCILIATION_INPUT_REQUIRED'));
  const accept = executeDrift(f.engine, 'drift.propose', { ...p.input, action: 'accept_code' }, f.author, f.issuer), q = f.engine.read(accept.ref); assert.throws(() => executeDrift(f.engine, 'drift.review', { ...p.reviewInput, proposal_ref: accept.ref, expected_proposal_sha256: digest(q) }, f.selector, f.issuer, createDriftHostProof(p.observation)), code('ACCEPTANCE_REQUIRED'));
});
test('history rejects forged classification and re-signed review targets', () => {
  const f = sourceFixture(), p = proposalFixture(f), records = structuredClone(f.engine.records); records[p.reportRef].data.behavior_status = 'bounded-fixture-results'; assert.throws(() => verifyDriftHistory(records, f.selector.project_id), code('SOURCE_INTEGRITY'));
});
function evidenceFixture(f: ReturnType<typeof sourceFixture>, observation: ReturnType<typeof changedObservation>, passed: boolean, trust = 'local-fixture-import', oracle = digest('independent-oracle')) {
  const snapshot = f.engine.target('R0@1').snapshot, required = f.source.scope.mapping.flatMap(m => m.criteria);
  return { format: 'git-application-observation/1', project_id: f.selector.project_id, repo_id: f.source.repo_id, plan_ref: 'fixture-plan@1', stage_ref: 'fixture-stage@1', target: { ref: 'R0@1', record_sha256: digest(f.engine.read('R0@1')), snapshot_sha256: digest(snapshot), candidate_fingerprint: f.engine.target('R0@1').fingerprint }, base_source_ref: f.sourceRef, result_tree_oid: observation.head_tree, result_manifest_sha256: observation.manifest_sha256, acceptance_contract_sha256: digest('frozen-contract'), checker: { id: 'fixture-checker', version: '1', sha256: digest('checker'), fixture_sha256: digest('fixture'), oracle_sha256: oracle }, results: required.map(key => { const slash = key.indexOf('/'), c = snapshot.blocks[key.slice(0, slash)].acceptance[key.slice(slash + 12)]; return { criterion_ref: key, check: c.check, version: c.version, fixture: c.fixture, method: c.method, passed, reviewer: c.method === 'review' ? 'fixture-reviewer' : null }; }), regressions: [], producer: { principal: 'fixture-runner', trust, execution_authenticated: false }, limitations: ['In-process evidence fixture tests classification only.'], observations_sha256: digest('observations') };
}
test('comparable mechanical fixture changes, imported outcomes and altered oracles remain distinct', () => {
  for (const [trust, oracleChanged, expected] of [['local-fixed-fixture', false, 'demonstrated-fixture-outcome-change'], ['local-fixture-import', false, 'reported-outcome-change'], ['local-fixed-fixture', true, 'incomparable']] as const) {
    const f = sourceFixture('booking.hold/requirements.expiry'), current = changedObservation(f), before = evidenceFixture(f, f.observation, true, trust), beforeRef = 'git-application-observation@' + digest(before); f.engine.store(beforeRef, 'git-application-observation', before);
    const payload = { ...f.payload, acceptance_evidence_refs: [beforeRef] }, bindInput = { ...f.bindInput, payload, expected_payload_sha256: digest(payload) };
    const binding = executeSourceBinding(f.engine, 'source.bind', bindInput, f.selector, f.issuer, createSourceHostProof(f.source, f.observation));
    const after = evidenceFixture(f, current, false, trust, oracleChanged ? digest('changed-oracle') : before.checker.oracle_sha256), afterRef = 'git-application-observation@' + digest(after); f.engine.store(afterRef, 'git-application-observation', after);
    const report = buildDriftReport(f.engine, { binding_ref: binding.ref, evidence_refs: [afterRef] }, current, f.author.principal_id);
    assert.ok(report.acceptance_changes.length > 0); assert.equal(report.acceptance_changes[0].kind, expected); assert.equal(report.coverage.acceptance_complete, false);
    assert.equal(report.behavior_status, expected === 'incomparable' ? 'unknown' : expected);
  }
});
test('missing, duplicate, unknown, wrong-source and failed acceptance results fail completeness', () => {
  const changes = [(p: any) => p.results = [], (p: any) => p.results.push(p.results[0]), (p: any) => p.results[0].criterion_ref = 'app/unsupported.path', (p: any) => p.result_manifest_sha256 = digest('other-source'), (p: any) => p.results[0].passed = false];
  for (const change of changes) { const f = sourceFixture(), current = changedObservation(f), packet = evidenceFixture(f, current, true); change(packet); const ref = 'git-application-observation@' + digest(packet); f.engine.store(ref, 'git-application-observation', packet); const report = buildDriftReport(f.engine, { binding_ref: f.bindingRef, evidence_refs: [ref] }, current, f.author.principal_id); assert.equal(report.coverage.acceptance_complete, false); assert.equal(report.behavior_status, 'unknown'); assert.equal(report.assessment, 'blocked'); }
});
