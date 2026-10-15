import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { canonical, digest, StrataError } from '../src/model.js';
import { r1CompletionReceiptSchema, validateR1CompletionReceipt } from '../src/reconciliation-completion-r1.js';
import { R1_CRITERIA, R1_NEGATIVE_FIXTURES, R1_SEMANTIC_NEGATIVE_FIXTURES, r1Fixture, replaceEvidence, replaceReview } from './fixtures/reconciliation-r1/fixtures.js';

const code = (expected: string) => (e: unknown) => e instanceof StrataError && e.code === expected;

test('R1 accepts exact synthetic mechanical revalidation while retaining planning/runtime boundaries', () => {
  const f = r1Fixture(), before = canonical(f.records), count = Object.keys(f.records).length;
  assert.ok('completion' in f.reviewed); assert.equal(f.reviewed.completion, false);
  assert.deepEqual(f.records[f.receipt.basis_evidence.ref].data.results.map((r: any) => r.criterion_ref), ['booking.hold/acceptance.expiry', 'booking.hold/acceptance.lifecycle']);
  assert.deepEqual(f.records[f.planPin.ref].data.criteria, R1_CRITERIA);
  assert.equal(f.records[f.receipt.basis_evidence.ref].data.results.every((r: any) => !r.passed), true);
  const result = validateR1CompletionReceipt(f.receipt, f.records, f.expected);
  assert.equal(result.valid, true); assert.equal(result.validation_only, true);
  assert.equal(result.completion, false); assert.equal(result.behavior_verified, false);
  assert.equal(result.source_binding_advanced, false);
  assert.equal(result.receipt_sha256, digest(f.receipt));
  assert.deepEqual(result.producer, { principal: 'synthetic-r1-producer', trust: 'local-fixed-fixture', execution_authenticated: false });
  assert.equal(canonical(f.records), before); assert.equal(Object.keys(f.records).length, count);
  assert.deepEqual(validateR1CompletionReceipt(f.receipt, f.records, f.expected), result);
  result.producer.principal = 'caller-edit'; assert.equal(canonical(f.records), before);
});

test('R1 preserves imported trust, review attestations and both existing v1 application packet types', () => {
  for (const imported of [false, true]) for (const accepted of [false, true]) {
    const f = r1Fixture(imported ? 'local-fixture-import' : 'local-fixed-fixture', true);
    if (accepted) {
      const old = f.receipt.evidence.ref, data = { ...f.records[old].data, format: 'git-acceptance/1' };
      const exact = 'git-acceptance@' + digest(data); f.records[exact] = { type: 'git-acceptance', data, published: true };
      delete f.records[old]; f.receipt.evidence = { ref: exact, sha256: digest(data) };
    }
    const result = validateR1CompletionReceipt(f.receipt, f.records, f.expected);
    assert.equal(result.valid, true); assert.equal(result.completion, false);
    assert.equal(result.producer.trust, imported ? 'local-fixture-import' : 'local-fixed-fixture');
    assert.equal(result.producer.execution_authenticated, false);
  }
});

test('R1 fixture generator is deterministic and its standalone schema is reproducible', async () => {
  assert.equal(canonical(r1Fixture()), canonical(r1Fixture()));
  const exported = JSON.parse(await readFile('schemas/reconciliation-completion-r1.schema.json', 'utf8'));
  assert.deepEqual(exported, z.toJSONSchema(r1CompletionReceiptSchema));
});

test('R1 retains validated Release closure without reinterpreting it as application execution', () => {
  const f = r1Fixture('local-fixture-import', false, true), release = f.records[f.receipt.target.ref].data;
  assert.equal(release.state, 'validated');
  assert.equal(validateR1CompletionReceipt(f.receipt, f.records, f.expected).completion, false);
  const missing = structuredClone(f); delete missing.records[release.validation];
  assert.throws(() => validateR1CompletionReceipt(missing.receipt, missing.records, missing.expected), code('R1_CLOSURE_REQUIRED'));
  const typed = structuredClone(f); typed.records[release.validation].type = 'unrelated';
  assert.throws(() => validateR1CompletionReceipt(typed.receipt, typed.records, typed.expected), code('R1_CLOSURE_REQUIRED'));
  const changed = structuredClone(f); changed.records[release.validation].data.evidence.results[0].passed = false;
  assert.throws(() => validateR1CompletionReceipt(changed.receipt, changed.records, changed.expected), code('R1_PIN_MISMATCH'));
});

for (const fixture of R1_NEGATIVE_FIXTURES) test('R1 refuses ' + fixture.name, () => {
  const f = r1Fixture(); fixture.edit(f);
  const before = canonical(f.records), input = canonical(f.receipt), expected = canonical(f.expected);
  assert.throws(() => validateR1CompletionReceipt(f.receipt, f.records, f.expected), code(fixture.code));
  assert.equal(canonical(f.records), before); assert.equal(canonical(f.receipt), input); assert.equal(canonical(f.expected), expected);
});

test('R1 caller-selected review pins prevent substitution with another valid approved review', () => {
  const f = r1Fixture(), selected = structuredClone(f.expected);
  replaceReview(f, d => { d.rationale = 'A different exact approved review.'; });
  assert.throws(() => validateR1CompletionReceipt(f.receipt, f.records, selected), code('R1_PIN_MISMATCH'));
  assert.equal(validateR1CompletionReceipt(f.receipt, f.records, f.expected).valid, true);
});

test('R1 independently selected current observation still must equal the reviewed observation', () => {
  const f = r1Fixture(); f.receipt.observation.entries[0].sha256 = digest('changed after approval');
  f.receipt.observation.manifest_sha256 = digest(f.receipt.observation.entries);
  f.expected.observation_sha256 = digest(f.receipt.observation);
  assert.throws(() => validateR1CompletionReceipt(f.receipt, f.records, f.expected), code('R1_PIN_MISMATCH'));
});

test('R1 cannot hide missing evidence by re-signing the receipt and its disclosure fields', () => {
  const f = r1Fixture(); replaceEvidence(f, d => { d.checker.fixture_sha256 = digest('replacement-fixture'); });
  f.receipt.checker = f.records[f.receipt.evidence.ref].data.checker;
  assert.throws(() => validateR1CompletionReceipt(f.receipt, f.records, f.expected), code('R1_PIN_MISMATCH'));
});

test('R1 requires review labels and rejects mechanical rows with an invented reviewer', () => {
  const reviewed = r1Fixture('local-fixture-import', true);
  replaceEvidence(reviewed, d => { d.results[0].reviewer = null; });
  assert.throws(() => validateR1CompletionReceipt(reviewed.receipt, reviewed.records, reviewed.expected), code('R1_ACCEPTANCE_INCOMPLETE'));
  const mechanical = r1Fixture(); replaceEvidence(mechanical, d => { d.results[0].reviewer = 'fabricated-reviewer'; });
  assert.throws(() => validateR1CompletionReceipt(mechanical.receipt, mechanical.records, mechanical.expected), code('R1_ACCEPTANCE_INCOMPLETE'));
});

test('R1 rejects tampered retained source and forged Git provenance even with passing packet results', () => {
  const source = r1Fixture(); source.records[source.sourceRef].data.entries[0].sha256 = digest('tampered-source');
  assert.throws(() => validateR1CompletionReceipt(source.receipt, source.records, source.expected), code('R1_PIN_MISMATCH'));
  const stage = r1Fixture(); stage.records[stage.stagePin.ref].data.operations[0].after.content = 'other bytes\n';
  assert.throws(() => validateR1CompletionReceipt(stage.receipt, stage.records, stage.expected), code('R1_PIN_MISMATCH'));
});

test('R1 does not mistake unrelated missing history for this selected contract closure', () => {
  const f = r1Fixture(); f.records['unrelated@1'] = { type: 'unrelated', published: true, data: { missing_ref: 'absent@1' } };
  assert.equal(validateR1CompletionReceipt(f.receipt, f.records, f.expected).valid, true);
});

test('R1 strict receipt rejects asserted completion and caller-supplied authority fields', () => {
  const f = r1Fixture();
  for (const field of ['completion', 'reconciled', 'execution_ready', 'reviewer', 'authority'])
    assert.throws(() => validateR1CompletionReceipt({ ...f.receipt, [field]: true }, f.records, f.expected), code('INVALID_RECORD'));
});

test('R1 refuses a versioned Git plan rather than reinterpret its passing legacy outcomes', () => {
  const f = r1Fixture(), changed = { ...f.records[f.planPin.ref].data, format: 'git-change-plan/2' };
  const exact = 'git-change-plan@' + digest(changed);
  f.records[exact] = { type: 'git-change-plan', published: true, data: changed };
  replaceEvidence(f, data => { data.plan_ref = exact; });
  assert.throws(() => validateR1CompletionReceipt(f.receipt, f.records, f.expected), code('R1_UNSUPPORTED_CONTRACT'));
});

test('R1 accepts unchanged retained semantic history with a published Layer without writing any records', () => {
  const f = r1Fixture('local-fixture-import', false, true, true), before = canonical(f.records);
  const result = validateR1CompletionReceipt(f.receipt, f.records, f.expected);
  assert.equal(result.valid, true); assert.equal(result.completion, false);
  assert.equal(result.validation_only, true); assert.equal(result.source_binding_advanced, false);
  assert.equal(canonical(f.records), before);
});

for (const fixture of R1_SEMANTIC_NEGATIVE_FIXTURES) test('R1 refuses semantic closure: ' + fixture.name, () => {
  const f = r1Fixture('local-fixture-import', false, true, true), selected = canonical([f.receipt, f.expected]);
  assert.equal(validateR1CompletionReceipt(f.receipt, f.records, f.expected).valid, true);
  fixture.edit(f); const before = canonical(f.records);
  assert.equal(canonical([f.receipt, f.expected]), selected);
  assert.throws(() => validateR1CompletionReceipt(f.receipt, f.records, f.expected), code(fixture.code));
  assert.equal(canonical([f.receipt, f.expected]), selected); assert.equal(canonical(f.records), before);
});
