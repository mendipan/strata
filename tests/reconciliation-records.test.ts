import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { canonical, digest } from '../src/model.js';
import { RECONCILIATION_V2_SCHEMAS, normalizePlanBody, deriveApprovalSubject, requiredRoleKeys, normalizeRoleKeys,
  exactRoleCoverage, parseReconciliationRecord, recordPin, prepareRequestSchema, checkRequestSchema, approveRequestSchema, completeRequestSchema,
  contractDigest, exactCriterionCoverage, type ReconciliationType } from '../src/reconciliation-records.js';
import { reconciliationProposalSchema, reconciliationReviewSchema } from '../src/reconciliation.js';
import { sourceBindingSchema } from '../src/source-binding.js';
import { reconciliationCompletionSchema as oldCompletionSchema } from '../src/revalidation.js';
import { r1CompletionReceiptSchema } from '../src/reconciliation-completion-r1.js';
import { s1Fixture } from './fixtures/reconciliation-s1/fixtures.js';

test('strict new formats have deterministic bodies distinct from their auth envelopes', () => {
  const f = s1Fixture(); assert.deepEqual(normalizePlanBody(f.body), f.body);
  assert.equal(f.plan.body_sha256, digest(f.body)); assert.notEqual(f.plan.body_sha256, recordPin('reconciliation-proposal', f.plan).sha256);
  assert.deepEqual(deriveApprovalSubject(f.plan, f.evidence), f.subject);
  const clone = structuredClone(f.plan); clone.author = 'another issuer';
  assert.equal(digest(clone.body), f.plan.body_sha256); assert.notEqual(digest(clone), digest(f.plan));
  for (const type of Object.keys(RECONCILIATION_V2_SCHEMAS) as ReconciliationType[]) {
    const values = Object.values(f.records).filter(r => r.type === type && RECONCILIATION_V2_SCHEMAS[type].safeParse(r.data).success);
    if (type === 'reconciliation-criterion-review') continue;
    assert.ok(values.length, type); for (const row of values) {
      parseReconciliationRecord(type, row.data); assert.equal(RECONCILIATION_V2_SCHEMAS[type].safeParse({ ...row.data, trust_override: 'host-authenticated' }).success, false);
    }
    assert.equal(z.toJSONSchema(RECONCILIATION_V2_SCHEMAS[type]).type, type === 'reconciliation-source-proof' ? undefined : 'object');
  }
});
test('criterion review is strict and duplicate/out-of-order assertions refuse', () => {
  const f = s1Fixture(), auth = Object.values(f.records).find(r => r.type === 'reconciliation-auth')!;
  const value = { format: 'reconciliation-criterion-review/1', project_id: 'synthetic', repo_id: 'repo', plan: f.planPin, desired_tree_oid: f.body.desired_tree_oid,
    target: f.body.target, criteria_sha256: digest(f.body.criteria), assertions: [{ criterion_ref: 'App/acceptance.rule', accepted: true, rationale: 'Synthetic assertion.' }],
    actor: 'synthetic-author', auth: recordPin('reconciliation-auth', auth.data), valid_until: '2026-10-12T12:00:00.000Z' };
  assert.ok(RECONCILIATION_V2_SCHEMAS['reconciliation-criterion-review'].safeParse(value).success);
  assert.equal(RECONCILIATION_V2_SCHEMAS['reconciliation-criterion-review'].safeParse({ ...value, assertions: [...value.assertions, ...value.assertions] }).success, false);
});
test('requests reject actor/root/results/proof/regressions and action-specific substitutions', () => {
  const f = s1Fixture(), request = f.records[f.plan.auth.ref].data.action_input.request;
  assert.ok(prepareRequestSchema.safeParse(request).success);
  for (const property of ['actor', 'trust', 'root', 'results', 'proof', 'regressions']) assert.equal(prepareRequestSchema.safeParse({ ...request, [property]: [] }).success, false);
  assert.equal(prepareRequestSchema.safeParse({ ...request, patch: 'supplied' }).success, false);
  assert.equal(prepareRequestSchema.safeParse({ ...request, action: 'restore_intent', patch: null }).success, false);
  assert.equal(checkRequestSchema.safeParse({ plan: f.planPin }).success, false);
  assert.equal(checkRequestSchema.safeParse({ plan: f.planPin, criterion_reviews: [], results: [] }).success, false);
  assert.ok(approveRequestSchema.safeParse({ plan: f.planPin, evidence: f.evidencePin, expected_subject_sha256: digest(f.subject), roles: ['source'], accepted: true, rationale: 'Review.' }).success);
  assert.equal(approveRequestSchema.safeParse({ plan: f.planPin, evidence: f.evidencePin, expected_subject_sha256: digest(f.subject), roles: ['source', 'source'], accepted: true, rationale: 'Review.' }).success, false);
  assert.equal(completeRequestSchema.safeParse({ plan: f.planPin, evidence: f.evidencePin, approvals: [], owner_commit: 'main' }).success, false);
});
test('role normalization and exact once-only coverage preserve distinct scopes and fixed guardians', () => {
  const context = { source_scope: 'App', target_scope: 'Branch', changed_target: true, guardians: ['App/requirements.value'] };
  const required = requiredRoleKeys(context); assert.deepEqual(required, ['guardian:App/requirements.value', 'release', 'scope:Branch', 'source:App']);
  assert.deepEqual(normalizeRoleKeys(['source', { guardian: 'App/requirements.value' }], context), ['guardian:App/requirements.value', 'source:App']);
  exactRoleCoverage(required, [['source:App'], ['guardian:App/requirements.value', 'release', 'scope:Branch']]);
  assert.throws(() => exactRoleCoverage(required, [required, ['source:App']]));
  assert.throws(() => exactRoleCoverage(required, [['source:App']]));
  assert.throws(() => normalizeRoleKeys(['release'], { ...context, changed_target: false }));
  assert.throws(() => requiredRoleKeys({ ...context, guardians: [...context.guardians, ...context.guardians] }));
});
test('accept may use a semantically equal successor; update alone requires a normative delta; bootstrap cannot retain its target', () => {
  normalizePlanBody(s1Fixture({ changedTarget: true, normative: false }).body);
  normalizePlanBody(s1Fixture({ bootstrap: true, changedTarget: true, normative: false }).body);
  assert.throws(() => normalizePlanBody(s1Fixture({ bootstrap: true }).body), /bootstrap/);
  assert.throws(() => s1Fixture({ action: 'update_intent', normative: false }), /normative delta/);
  normalizePlanBody(s1Fixture({ action: 'update_intent' }).body);
});
test('scope, contract, source, sets and successor substitutions invalidate the plan/approval subject', () => {
  const f = s1Fixture();
  for (const edit of [
    (b: any) => b.scope.paths.push('new.txt'), (b: any) => b.required_roles.push('source:App'),
    (b: any) => b.criteria.push(b.criteria[0]), (b: any) => b.successor_template.desired_tree_oid = '1'.repeat(40),
    (b: any) => b.regressions = [], (b: any) => b.oracle.expected++,
  ]) { const body = structuredClone(f.body); edit(body); assert.throws(() => normalizePlanBody(body)); }
  const evidence = structuredClone(f.evidence); evidence.producer_id = 'copied-authenticated-label';
  assert.throws(() => deriveApprovalSubject(f.plan, evidence), /contract\/source/);
  const plan = structuredClone(f.plan); plan.body.producer_id = 'unregistered'; plan.body.contract_sha256 = contractDigest(plan.body); plan.body_sha256 = digest(plan.body);
  assert.throws(() => deriveApprovalSubject(plan, f.evidence));
  // No shape parser authenticates a producer; live registration and historical execution are later gates.
  assert.ok(RECONCILIATION_V2_SCHEMAS['reconciliation-evidence'].safeParse(evidence).success);
});
test('auth intervals distinguish issuance session from bounded durable endorsement', () => {
  const f = s1Fixture(), auth = structuredClone(Object.values(f.records).find(r => r.type === 'reconciliation-auth' && r.data.action_input.action === 'reconciliation.role-approval')!.data);
  assert.ok(Date.parse(auth.endorsement_valid_until) > Date.parse(auth.session.expires_at));
  parseReconciliationRecord('reconciliation-auth', auth);
  for (const edit of [
    (a: any) => a.endorsement_valid_until = '2026-10-14T00:00:00.000Z',
    (a: any) => a.endorsement_valid_until = null, (a: any) => a.action_finished_at = '2026-10-12T02:00:00.000Z',
    (a: any) => a.action_input_sha256 = digest('forged action'),
  ]) { const value = structuredClone(auth); edit(value); assert.throws(() => parseReconciliationRecord('reconciliation-auth', value)); }
});
test('criterion IDs/subjects cannot enlarge selected scope and each method has exact result coverage', () => {
  const f = s1Fixture(); exactCriterionCoverage(f.body.criteria, 'mechanical', [{ criterion_ref: 'App/acceptance.rule' }]);
  exactCriterionCoverage(f.body.criteria, 'review', []);
  assert.throws(() => exactCriterionCoverage(f.body.criteria, 'mechanical', []));
  assert.throws(() => exactCriterionCoverage(f.body.criteria, 'review', [{ criterion_ref: 'App/acceptance.rule' }]));
  for (const edit of [(b: any) => b.criteria[0].subjects.push('Outside/requirements.value'),
    (b: any) => { b.criteria[0].criterion_ref = 'App/acceptance.new'; b.scope.mapping.forEach((m: any) => m.criteria = ['App/acceptance.new']); }]) {
    const body = structuredClone(f.body); edit(body); body.contract_sha256 = contractDigest(body); assert.throws(() => normalizePlanBody(body));
  }
});
test('unchanged old parsers accept old golden objects and reject every /2 substitution', async () => {
  const old = JSON.parse(await readFile('tests/fixtures/reconciliation-s1/legacy-r1.json', 'utf8')), f = s1Fixture();
  assert.ok(r1CompletionReceiptSchema.safeParse(JSON.parse(canonical(old.receipt))).success);
  const oldTypes = { 'source-binding': sourceBindingSchema, 'reconciliation-proposal': reconciliationProposalSchema, 'reconciliation-review': reconciliationReviewSchema };
  for (const [type, schema] of Object.entries(oldTypes)) {
    const rows = Object.values(old.records as Record<string, any>).filter(r => r.type === type); assert.ok(rows.length); rows.forEach(r => assert.ok(schema.safeParse(JSON.parse(canonical(r.data))).success));
    const newValue = Object.values(f.records).find(r => r.type === type && r.data.format.endsWith('/2'))!.data;
    assert.equal(schema.safeParse(newValue).success, false);
  }
  assert.equal(oldCompletionSchema.safeParse(f.records[f.completionPin.ref].data).success, false);
  assert.equal(r1CompletionReceiptSchema.safeParse(f.records[f.completionPin.ref].data).success, false);
});
test('published fixture bytes and JSON schemas match their canonical generators', async () => {
  for (const [name, options] of [['sha1', { format: 'sha1' }], ['sha256', { format: 'sha256' }], ['review-only', { reviewCriterion: true }]] as const) {
    const bytes = await readFile(`tests/fixtures/reconciliation-s1/${name}.json`, 'utf8');
    const fixture = s1Fixture(options); assert.equal(bytes, canonical({ records: fixture.records, planned: fixture.proofPin, committed: fixture.committedPin, completion: fixture.completionPin, binding: fixture.bindingPin, publication: fixture.publication }) + '\n');
  }
  for (const [type, schema] of Object.entries(RECONCILIATION_V2_SCHEMAS)) {
    assert.deepEqual(JSON.parse(await readFile(`schemas/reconciliation-s1/${type}.schema.json`, 'utf8')), z.toJSONSchema(schema));
  }
});
