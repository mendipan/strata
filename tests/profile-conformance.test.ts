import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine, obligations, type Evaluation } from '../src/core.js';
import { CONTENT_MODEL, canonical, digest, StrataError, type Snapshot } from '../src/model.js';
import { profileFingerprint, treeDigest } from '../src/profile.js';
import { profiles } from '../src/profiles.js';
import { counterProfile } from '../src/profiles/counter-fixture.js';
import { bookingProfiles } from '../src/profiles/booking.js';
import { bootstrap } from '../src/fixtures.js';
import { describeProfileSupport, inspectProfileSupport } from '../src/profile-capabilities.js';
import { runCompiledConformance } from './profile-conformance-harness.test.js';
import type { FixtureOracle, ProfileAdapter } from '../src/profile-types.js';

const counterBaseline: Snapshot = JSON.parse(await readFile(path.resolve('tests/fixtures/counter/bootstrap.json'), 'utf8'));
function target(snapshot: Snapshot) { const engine = new Engine(); engine.init(snapshot, 'bootstrap'); return engine.target(`${snapshot.id}@${snapshot.revision}`); }
function mutation(evaluation: Evaluation, mutate: (snapshot: Snapshot) => void) { const e = structuredClone(evaluation); mutate(e.snapshot); e.obligations = obligations(e.snapshot); return e; }
function literalOracle(evaluation: Evaluation, adapter: ProfileAdapter, expected: Record<string, unknown>): FixtureOracle {
  const criteria = [...new Map(Object.values(evaluation.snapshot.blocks).flatMap(b => Object.values(b.acceptance)).map(c => { const row = { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; return [canonical(row), row] as const; })).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { format: adapter.checker.oracleFormat, snapshot_sha256: digest(evaluation.snapshot), expected, criteria };
}
const before = target(counterBaseline), changed = structuredClone(counterBaseline);
changed.blocks.counter.requirements.limit.statement = 'The total starts at zero and cannot exceed 12.'; changed.blocks.counter.requirements.limit.parameters.maximum = 12;
const after = target(changed);
runCompiledConformance({ name: 'existing counter adapter', adapter: counterProfile,
  golden: { profile: 'aa2aedc43a2b8289992087f5a428a73e723c1846a3ffdeefd1d65a23cee55411', baseline_output: '2d67baed2bf74cf1e1b614444b8940e3f7c4fd2d9b6f446b127e1bd8a20f365b', changed_output: '292c4b90bef4fc2e6e201061ff1a256bfe1bdf6198b0260b5586c00e6d1cfe59' },
  baseline: { target: 'CounterBaseline@1', evaluation: before, oracle: literalOracle(before, counterProfile, { maximum: 6 }) },
  changed: { target: 'CounterBaseline@1', evaluation: after, oracle: literalOracle(after, counterProfile, { maximum: 12 }) },
  unsupported: Object.entries({
    purpose: (s: Snapshot) => { s.blocks.counter.purpose = 'Charge money.'; },
    requirement: (s: Snapshot) => { s.blocks.counter.requirements.limit.parameters.reset = true; },
    contract: (s: Snapshot) => { s.blocks.counter.contract.failures.ceiling.statement = 'Accept all additions.'; },
    criterion: (s: Snapshot) => { s.blocks.counter.acceptance.limit.check = 'unknown'; },
    topology: (s: Snapshot) => { s.blocks.extra = { ...structuredClone(s.blocks.counter), id: 'extra', parent: 'counter' }; }
  }).map(([name, mutate]) => ({ name, evaluation: mutation(before, mutate) }))
});
const bookingAdapter = bookingProfiles.find(p => p.id === 'booking-node/3')!;
const bookingBefore = target(bootstrap()), bookingChanged = structuredClone(bookingBefore.snapshot);
bookingChanged.blocks['booking.hold'].requirements.expiry.statement = 'A hold expires exactly 900 seconds after it starts.'; bookingChanged.blocks['booking.hold'].requirements.expiry.parameters.seconds = 900;
const bookingAfter = target(bookingChanged);
runCompiledConformance({ name: 'existing bound booking adapter', adapter: bookingAdapter,
  golden: { profile: '6399b1a73c4dac314ea45832436213a4c9506bb858e3c7cc0e3d4122b6e37c7a', baseline_output: 'f0806ca8617e0751c41f49479613292bcf29b9abe07a904119d3deb7a3010e6d', changed_output: '6860a8b0f225aa0bd2afc9480ac426c90ca252d3d7f93703b8580ce4d957fb1a' },
  baseline: { target: 'R0@1', evaluation: bookingBefore, oracle: literalOracle(bookingBefore, bookingAdapter, { seconds: 600, enabled: false, lead_seconds: 60 }) },
  changed: { target: 'R0@1', evaluation: bookingAfter, oracle: literalOracle(bookingAfter, bookingAdapter, { seconds: 900, enabled: false, lead_seconds: 60 }) },
  unsupported: Object.entries({
    purpose: (s: Snapshot) => { s.blocks.app.purpose = 'Charge money.'; },
    requirement: (s: Snapshot) => { s.blocks['booking.hold'].requirements.expiry.parameters.extra = true; },
    interface: (s: Snapshot) => { s.blocks['booking.hold'].contract.inputs.hold.statement = 'Import a program.'; },
    criterion: (s: Snapshot) => { s.blocks['booking.hold'].acceptance.expiry.check = 'unknown'; },
    topology: (s: Snapshot) => { s.blocks.extra = { ...structuredClone(s.blocks.app), id: 'extra', parent: 'app' }; }
  }).map(([name, mutate]) => ({ name, evaluation: mutation(bookingBefore, mutate) }))
});

test('finite support descriptions preserve historical profile identities and return fresh metadata', () => {
  const historical = {
    'booking-node/1': '082c69b5420253378ae65ba450aa26be9e791921c50a9f7acca2a9c8345e13e5',
    'booking-node/2': '1d3733faf4753ad6d7a0d17640715d5479a28a7797909100e0f2aa2b66dfa2ee',
    'booking-node/3': '6399b1a73c4dac314ea45832436213a4c9506bb858e3c7cc0e3d4122b6e37c7a',
    'booking-node/4': 'fac3dd30e161d78d0f48d18dfdc05432584d63e2aedd8032b378bde6e43b9c8f'
  };
  for (const [id, pin] of Object.entries(historical)) assert.equal(profileFingerprint(id), pin);
  for (const adapter of profiles) {
    const detail = describeProfileSupport(adapter); assert.equal(detail.archive_sha256, profileFingerprint(adapter.id)); assert.deepEqual(detail.models, adapter.models);
    assert.deepEqual(detail.scenario, { id: adapter.scenario.id, version: adapter.scenario.version }); assert.equal(detail.evidence.checker_bound, adapter.boundEvidence);
    (detail.source as string[]).push('mutated'); assert(!describeProfileSupport(adapter).source.includes('mutated'));
    assert.equal(adapter.models.includes(CONTENT_MODEL), detail.runtime.outputs.includes('assets.json'));
  }
  for (const id of ['unreviewed/1', 'constructor', 'toString', '__proto__']) assert.throws(() => describeProfileSupport({ ...counterProfile, id }), (e: any) => e.code === 'UNSUPPORTED_PROFILE');
});
test('support provider delegates actual core/backend/target predicates and preserves exact first blockers', () => {
  for (const backend of ['node', 'none'] as const) {
    const engine = new Engine({}, {}, { checkerBackend: backend }); engine.init(counterBaseline, 'bootstrap');
    const report = inspectProfileSupport(counterProfile, () => engine.realize('CounterBaseline@1', counterProfile.id));
    assert.equal(report.materialization.supported, backend === 'node');
    if (!report.materialization.supported) assert.equal(report.materialization.first_blocker.code, 'UNSUPPORTED_CHECKER_BACKEND');
  }
  const engine = new Engine(); engine.init(counterBaseline, 'bootstrap');
  const refused = inspectProfileSupport(counterProfile, () => engine.realize('missing@1', counterProfile.id));
  assert(!refused.materialization.supported); if (!refused.materialization.supported) assert.equal(refused.materialization.first_blocker.code, 'REF_NOT_FOUND');
  assert.throws(() => inspectProfileSupport(counterProfile, () => { throw new Error('implementation bug'); }), /implementation bug/);
  const wrong = inspectProfileSupport(counterProfile, () => ({ ...engine.realize('CounterBaseline@1', counterProfile.id), profile_id: 'wrong/1' }));
  assert(!wrong.materialization.supported); if (!wrong.materialization.supported) assert.equal(wrong.materialization.first_blocker.code, 'STALE_REALIZATION');
  const bad = new StrataError('OWNER_FORBIDDEN', 4, 'Exact refusal.', { principal: 'synthetic' });
  const report = inspectProfileSupport(counterProfile, () => { throw bad; });
  assert(!report.materialization.supported); if (!report.materialization.supported) assert.deepEqual(report.materialization.first_blocker, { code: bad.code, exit: bad.exit, message: bad.message, details: bad.details });
});
test('existing compiled core registration rejects changed, extra and missing output despite recalculated tree pins', () => {
  const engine = new Engine(); engine.init(counterBaseline, 'bootstrap'); const original = engine.realize('CounterBaseline@1', counterProfile.id);
  for (const mutate of [
    (files: Record<string, string>) => { files['counter.mjs'] += '\nexport const extra = true;\n'; },
    (files: Record<string, string>) => { files['extra.txt'] = 'extra'; },
    (files: Record<string, string>) => { delete files['README.md']; }
  ]) {
    const modified = structuredClone(original); mutate(modified.files); modified.output_tree = treeDigest(modified.files);
    assert.throws(() => engine.registerRealization(modified), (e: any) => e.code === 'STALE_REALIZATION');
  }
});
