import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewRecord } from '../src/review.js';
import { digest, canonical } from '../src/model.js';
import { prepared, unitValidation } from './helpers.js';

test('review preserves exact evidence bindings and separates imported mechanical results from review assertions', () => {
  const { engine, candidate } = prepared();
  const { registration, evidence, validation } = unitValidation(engine, candidate);
  const before = canonical(engine.records);
  const record = engine.inspect('validation', validation.ref);
  const review = reviewRecord('validation', validation.ref, record);
  assert.equal(review.subject.record_sha256, digest(record));
  const mechanical = review.observations.filter(r => r.kind === 'imported_check_result');
  assert.equal(mechanical.length, evidence.results.filter(r => r.method === 'mechanical').length);
  assert(review.assertions.every(r => r.kind === 'fixture_review_attestation' && r.method === 'review'));
  for (const result of [...mechanical, ...review.assertions]) {
    assert.equal(result.target_ref, candidate.ref);
    assert.equal(result.candidate, candidate.fingerprint);
    assert.equal(result.realization_ref, registration.ref);
    assert.equal(result.output_tree, evidence.output_tree);
    assert.equal(result.evidence_digest, digest(evidence));
    assert.equal(result.execution_authenticated, false);
  }
  assert.match(review.unverified.join(' '), /do not prove a test ran/);
  assert.equal(review.execution_checked, false);
  assert.equal(canonical(engine.records), before);
});

test('author supplied observed traceability stays an assertion and changed revisions retain separate provenance', () => {
  const { engine, a } = prepared();
  const first = engine.inspect('layer', 'L-hold@1');
  const next = { ...structuredClone(a), revision: 2, intent: 'A robust, world-class proposal; tests pass according to the author.' };
  next.derived_from = { kind: 'supplied_proposal', source_digest: 'a'.repeat(64), against: 'R0@1', traceability: [{ item: 'booking.hold/requirements.expiry', classification: 'observed', rationale: 'Author reports observing it.', files: ['note.txt'] }], questions: ['Other timing sequences are unverified.'] };
  // Use the already normalized proposal to exercise the existing exact-head revision path.
  const revised = engine.layer(next, a.owner, 'L-hold@1');
  const record = engine.inspect('layer', revised.ref, a.owner);
  const review = reviewRecord('layer', revised.ref, record);
  assert.equal(review.subject.ref, 'L-hold@2');
  assert.equal(review.observations[0].baseline, a.baseline);
  assert.equal(review.observations[0].revision, 2);
  assert(review.assertions.some(r => r.kind === 'supplied_traceability' && r.classification === 'observed'));
  assert(!review.observations.some(r => r.classification === 'observed'));
  assert.notEqual(review.subject.record_sha256, reviewRecord('layer', 'L-hold@1', first).subject.record_sha256);
  assert.deepEqual(engine.inspect('layer', 'L-hold@1'), first);
});

test('checker pins are retained and authoring acceptance remains a fixture assertion', () => {
  const { engine, candidate } = prepared();
  const { validation } = unitValidation(engine, candidate);
  const record = engine.inspect('validation', validation.ref);
  // This projection never validates or promotes the supplied imported record to authenticated execution.
  record.evidence = { ...record.evidence, format: 'strata-fixture-evidence/2', checker_sha256: 'c'.repeat(64), fixture_sha256: 'f'.repeat(64), oracle_sha256: 'a'.repeat(64) };
  const review = reviewRecord('validation', validation.ref, record);
  assert(review.observations.every(r => r.checker_sha256 === record.evidence.checker_sha256 && r.oracle_sha256 === record.evidence.oracle_sha256));
  assert.equal(review.execution_checked, false);
  const draft = { draft_ref: 'L-draft@2', draft_digest: 'b'.repeat(64), checklist: 'intent-authoring/1', accepted: true, reviewer: 'fixture-reviewer', rationale: 'Accepted for authoring.', trust: 'local-fixture' };
  const authoring = reviewRecord('authoring-review', 'authoring-review@abc', draft);
  assert.equal(authoring.assertions[0].accepted, true);
  assert.equal(authoring.observations[0].draft_ref, draft.draft_ref);
  assert.equal(authoring.observations[0].draft_digest, draft.draft_digest);
  assert.match(authoring.unverified[0], /without authenticating human consent/);
});
