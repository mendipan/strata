import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, type Records } from '../src/model.js';
import { recordPin, type TypedEdge } from '../src/reconciliation-records.js';
import { collectReconciliationClosure, reconciliationReferences, completionBindingConsumers, verifyCompletionBindingEdge } from '../src/reconciliation-history.js';
import { rawObject, s1Fixture } from './fixtures/reconciliation-s1/fixtures.js';

test('completion root traverses its verified unique reverse binding edge with a visited set', () => {
  const f = s1Fixture(), root = { pin: f.completionPin, type: 'reconciliation-completion' };
  const closure = collectReconciliationClosure(f.records, [root], () => [], [f.publication]);
  assert.ok(closure.records[f.bindingPin.ref]); assert.ok(closure.records[f.proofPin.ref]); assert.ok(closure.records[f.committedPin.ref]);
  assert.equal(closure.live_authority_checked, false); assert.equal(closure.live_source_checked, false);
  const serialized = reconciliationReferences('reconciliation-completion', f.records[f.completionPin.ref].data);
  assert.ok(!serialized.some(e => e.pin.ref === f.bindingPin.ref));
  assert.ok(reconciliationReferences('source-binding', f.records[f.bindingPin.ref].data).some(e => e.pin.ref === f.completionPin.ref));
});
test('a published binding cannot retain an unpublished new completion from either closure root', () => {
  for (const type of ['source-binding', 'reconciliation-completion']) {
    const f = s1Fixture(); f.records[f.completionPin.ref].published = false;
    assert.throws(() => completionBindingConsumers(f.records), /published/);
    const pin = type === 'source-binding' ? f.bindingPin : f.completionPin;
    assert.throws(() => collectReconciliationClosure(f.records, [{ pin, type }], () => [], [f.publication]), /published/);
  }
});
test('unpublished standalone new association records refuse without imposing visibility on auth or legacy records', () => {
  const f = s1Fixture(); f.records[f.bindingPin.ref].published = false; f.records[f.completionPin.ref].published = false;
  assert.throws(() => collectReconciliationClosure(f.records, [{ pin: f.completionPin, type: 'reconciliation-completion' }], () => [], [f.publication]), /published/);
  assert.throws(() => collectReconciliationClosure(f.records, [{ pin: f.bindingPin, type: 'source-binding' }], () => [], [f.publication]), /published/);
  const permitted = s1Fixture();
  for (const row of Object.values(permitted.records)) if (row.type === 'reconciliation-auth') row.published = false;
  const legacy = permitted.retain('legacy-private-fixture', { value: 'Private legacy data.' }); permitted.records[legacy.ref].published = false;
  const closure = collectReconciliationClosure(permitted.records, [{ pin: permitted.bindingPin, type: 'source-binding' }, { pin: legacy, type: 'legacy-private-fixture' }], () => [], [permitted.publication]);
  assert.ok(closure.records[legacy.ref]); assert.ok(Object.values(closure.records).some(row => row.type === 'reconciliation-auth' && !row.published));
});
test('missing/ambiguous indexed consumers and mismatched atomic result/audit refuse', () => {
  const missing = s1Fixture(); delete missing.records[missing.bindingPin.ref];
  assert.throws(() => collectReconciliationClosure(missing.records, [{ pin: missing.completionPin, type: 'reconciliation-completion' }], () => [], [missing.publication]), /exactly one indexed/);
  const ambiguous = s1Fixture(), other = structuredClone(ambiguous.records[ambiguous.bindingPin.ref].data);
  other.payload.limitations.push('Other branch.'); other.payload.limitations.sort(); other.payload_sha256 = digest(other.payload); ambiguous.retain('source-binding', other);
  assert.throws(() => collectReconciliationClosure(ambiguous.records, [{ pin: ambiguous.completionPin, type: 'reconciliation-completion' }], () => [], [ambiguous.publication]), /exactly one indexed/);
  const audit = s1Fixture(); audit.publication.commit_audit.source_binding = audit.evidencePin;
  assert.throws(() => verifyCompletionBindingEdge(audit.read, audit.completionPin, [audit.bindingPin], [audit.publication]), /Commit audit/);
  const empty = s1Fixture(); assert.throws(() => verifyCompletionBindingEdge(empty.read, empty.completionPin, [empty.bindingPin], []), /result\/commit-audit/);
});
test('indexed binding digest/payload and source approval are checked without accepting labels as authority', () => {
  const f = s1Fixture(); f.records[f.bindingPin.ref].data.payload.source = f.evidencePin;
  assert.throws(() => completionBindingConsumers(f.records));
  const g = s1Fixture(); const value = structuredClone(g.records[g.bindingPin.ref].data);
  value.acceptance.source_approval = g.planPin; const substituted = g.retain('source-binding', value);
  assert.throws(() => verifyCompletionBindingEdge(g.read, g.completionPin, [substituted], [g.publication]), /source approval/);
});
test('mixed-version typed traversal cannot fall back from a malformed new /1 or /2 format', () => {
  const f = s1Fixture(); const d = structuredClone(f.records[f.evidencePin.ref].data); d.extra = true;
  const pin = f.retain('reconciliation-evidence', d);
  assert.throws(() => collectReconciliationClosure(f.records, [{ pin, type: 'reconciliation-evidence' }], () => [], []), /legacy parser/);
  const wrong = structuredClone(f.records[f.bindingPin.ref].data); wrong.format = 'source-binding/3';
  const wrongPin = f.retain('source-binding', wrong); assert.throws(() => collectReconciliationClosure(f.records, [{ pin: wrongPin, type: 'source-binding' }], () => [], []));
});
test('new collector has separate exact 16,384 record, 64 MiB closure and 768 KiB record budgets', () => {
  const records: Records = {}, roots: TypedEdge[] = [];
  for (let i = 0; i < 16385; i++) { const data = { i }, pin = recordPin('legacy-synthetic', data); records[pin.ref] = { type: 'legacy-synthetic', published: true, data }; roots.push({ pin, type: 'legacy-synthetic' }); }
  const exact = collectReconciliationClosure(records, roots.slice(0, 16384), () => [], []); assert.equal(Object.keys(exact.records).length, 16384);
  assert.throws(() => collectReconciliationClosure(records, roots, () => [], []), /16,384/);
  const large: Records = {}, largeRoots: TypedEdge[] = [];
  for (let i = 0; i < 129; i++) { const data = rawObject('blob', Buffer.alloc(400 * 1024, i)); const pin = recordPin('reconciliation-git-object', data);
    large[pin.ref] = { type: 'reconciliation-git-object', data, published: true }; largeRoots.push({ pin, type: 'reconciliation-git-object' }); }
  assert.throws(() => collectReconciliationClosure(large, largeRoots, () => [], []), /64 MiB/);
  const tooBig = { text: 'x'.repeat(768 * 1024) }, pin = recordPin('legacy-synthetic', tooBig);
  assert.throws(() => collectReconciliationClosure({ [pin.ref]: { type: 'legacy-synthetic', data: tooBig, published: true } }, [{ pin, type: 'legacy-synthetic' }], () => [], []), /768 KiB/);
});
