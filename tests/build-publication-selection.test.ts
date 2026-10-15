import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Engine, snapshotFromRelease } from '../src/core.js';
import { canonical, digest, set } from '../src/model.js';
import { inspectReleasePublication } from '../src/build-publication.js';
import { assertSelectionApprovalBinding, assertSelectionSealBinding } from '../src/mediation-bindings.js';
import { setup, prepare, select, release, FIXTURE_NOW } from './mediation-helpers.js';

const stale = (error: any) => error.code === 'MEDIATION_STALE';
function storeApproval(engine: Engine, data: any): string {
  const { ref, ...unsigned } = data;
  const newRef = 'approval@' + digest(unsigned).slice(0, 24);
  engine.store(newRef, 'approval', { ...unsigned, ref: newRef });
  return newRef;
}

test('complete rehashed selection histories with nonexistent option or wrong case revision refuse historical Build eligibility', async () => {
  const f = setup(false), p = prepare(f), chosen = select(f, p, 'fixture-selector', '900');
  const done = await release(f, chosen.candidate);
  const context = { project_id: f.engine.options.projectId!, records: f.engine.records, source_trust: 'local-fixture' as const };
  const before = canonical(f.engine.records);
  const original = inspectReleasePublication(context, done.released.ref);
  assert.equal(original.state, 'approved'); assert.equal(original.execution_authorized, null);
  f.setNow(FIXTURE_NOW + 7200001);
  assert.equal(inspectReleasePublication(context, done.released.ref).state, 'approved');
  f.setNow(FIXTURE_NOW);
  const fixtures = JSON.parse(await readFile('tests/fixtures/build-publication/selection-binding-cases.json', 'utf8'));
  for (const fixture of fixtures) {
    // Reproduce the review's complete altered history rather than breaking an old
    // hash: every affected immutable identity and publication pin is recomputed.
    const engine = new Engine(structuredClone(f.engine.records), {}, { ...f.engine.options, historical: true });
    const endorsement = engine.read(chosen.endorsement.ref, 'approval');
    Object.assign(endorsement.binding, fixture.binding_patch);
    const endorsementRef = storeApproval(engine, endorsement);
    const resolution = engine.read(chosen.resolved.ref, 'resolution'); resolution.approvals = [endorsementRef];
    const resolutionRef = 'resolution@' + digest(resolution).slice(0, 24); engine.store(resolutionRef, 'resolution', resolution);
    const composition = engine.read(chosen.candidate.ref, 'composition'); composition.id = 'Forged-' + fixture.id; composition.resolutions = [resolutionRef];
    const compositionRef = composition.id + '@' + composition.revision; engine.store(compositionRef, 'composition', composition);
    const evaluation = engine.target(compositionRef); assert.equal(evaluation.state, 'eligible_for_validation');
    const realization = engine.realize(compositionRef, done.r.profile_id), registered = engine.registerRealization(realization);
    const input = structuredClone(done.actual.evidence);
    Object.assign(input, { candidate: evaluation.fingerprint, profile: realization.profile, output_tree: realization.output_tree, checker_sha256: realization.checker_sha256, fixture_sha256: realization.fixture_sha256, oracle_sha256: realization.oracle_sha256 });
    const validation = engine.validate(compositionRef, registered.ref, input);
    const approvals = [done.scope.ref, done.project.ref].map(ref => storeApproval(engine, { ...engine.read(ref, 'approval'), target: evaluation.fingerprint, evidence_digest: validation.evidence_digest }));
    const old = engine.read(done.released.ref, 'release'), baseline = engine.read(composition.baseline, 'release');
    const data = { ...snapshotFromRelease(old), baseline: composition.baseline, candidate: evaluation.fingerprint, provenance: evaluation.provenance, lineage: set([...(baseline.lineage ?? []), ...composition.selected]), resolutions: composition.resolutions, acceptance_manifest: evaluation.obligations, validation: validation.ref, approvals: set(approvals), state: 'validated', trust: 'local-fixture' };
    const releaseRef = 'release@' + digest(data).slice(0, 24); engine.store(releaseRef, 'release', data);
    assert.throws(() => f.engine.mediation!.approval(endorsement, endorsement.principal), (e: any) => e.code === fixture.expected_live_error);
    const retained = canonical(engine.records), result = inspectReleasePublication({ ...context, records: engine.records }, releaseRef);
    assert.equal(result.state, fixture.expected_historical_state, fixture.id); assert.equal(result.historically_approved, false);
    assert.equal(result.release, null); assert.deepEqual(result.closure, []); assert.equal(canonical(engine.records), retained);
  }
  assert.equal(canonical(f.engine.records), before);
});

test('shared structural predicate binds exact option, case, packet, response and historical expiry without a current clock', () => {
  const f = setup(false), p = prepare(f), chosen = select(f, p, 'fixture-selector', '900');
  const endorsement = f.engine.read(chosen.endorsement.ref, 'approval');
  const basis = f.engine.read(endorsement.binding.basis_ref, 'mediation-basis'), packet = f.engine.read(endorsement.binding.packet_ref, 'decision-packet'), receipt = f.engine.read(endorsement.binding.receipt_ref, 'mediation-receipt');
  assertSelectionApprovalBinding(endorsement, endorsement.principal, basis, packet, receipt);
  f.setNow(FIXTURE_NOW + 7200001);
  assert.throws(() => f.engine.mediation!.approval(endorsement, endorsement.principal), stale);
  // A valid old response remains structurally valid after present-day expiry.
  assertSelectionApprovalBinding(endorsement, endorsement.principal, basis, packet, receipt);
  for (const patch of [{ generation: 'other' }, { target: 'a'.repeat(64) }, { expires_at: new Date(FIXTURE_NOW + 1).toISOString() }]) assert.throws(() => assertSelectionApprovalBinding({ ...endorsement, ...patch }, endorsement.principal, basis, packet, receipt), stale);
  for (const patch of [{ packet_ref: 'decision-packet@wrong' }, { basis_ref: 'mediation-basis@wrong' }, { case_revision: 99 }, { option_id: 'does-not-exist' }, { action: 'defer' }, { principal: 'other' }, { generation: 'other' }, { target: 'a'.repeat(64) }, { partition_sha256: 'a'.repeat(64) }, { created_at: basis.expires_at }, { created_at: new Date(Date.parse(basis.expires_at) + 1).toISOString() }]) assert.throws(() => assertSelectionApprovalBinding(endorsement, endorsement.principal, basis, packet, { ...receipt, ...patch }), stale);
  for (const patch of [{ basis_ref: 'mediation-basis@wrong' }, { basis_sha256: 'a'.repeat(64) }]) assert.throws(() => assertSelectionApprovalBinding(endorsement, endorsement.principal, basis, { ...packet, ...patch }, receipt), stale);
  const resolution = f.engine.read(chosen.resolved.ref, 'resolution'), composition = f.engine.read(chosen.candidate.ref, 'composition'), evaluation = f.engine.target(chosen.candidate.ref);
  assertSelectionSealBinding(resolution.payload, composition, basis, () => evaluation.input_fingerprint);
  const unneeded = () => { throw new Error('Fingerprint computation must preserve live short-circuit order.'); };
  assert.throws(() => assertSelectionSealBinding({ ...resolution.payload, basis_sha256: 'a'.repeat(64) }, composition, basis, unneeded), stale);
  assert.throws(() => assertSelectionSealBinding(resolution.payload, { ...composition, baseline: 'R0@wrong' }, basis, unneeded), stale);
});
