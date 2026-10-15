import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Engine } from '../src/core.js';
import { BLOCK_MODEL, canonical, type Snapshot, type Composition } from '../src/model.js';
import { profiles } from '../src/profiles.js';
import { workflow } from '../src/workflow.js';
import { describeProfileSupport } from '../src/profile-capabilities.js';
import { FixtureIssuer } from '../src/security.js';

const baseline: Snapshot = JSON.parse(await readFile('tests/fixtures/collection/bootstrap.json', 'utf8'));
const recipe: Composition = JSON.parse(await readFile('tests/fixtures/collection/composition.json', 'utf8'));
function setup(backend: 'node' | 'none' = 'node') {
  const engine = new Engine({}, {}, { checkerBackend: backend }); engine.init(structuredClone(baseline), 'bootstrap');
  return { engine, target: engine.compose({ ...recipe, proposals: [], selected: [] }) };
}
function reports(engine: Engine, target: string) {
  const result = workflow(engine, 'capabilities', { target }, 'reader') as any;
  assert.equal(result.format, 'strata-capabilities/1');
  return result;
}

test('finite registry and Engine import independently in either ESM entry order with stable public obligations', () => {
  for (const first of ['profiles', 'core', 'profile']) {
    const script = `await import('./dist/src/${first}.js'); const {profiles}=await import('./dist/src/profiles.js'); const core=await import('./dist/src/core.js'); const pure=await import('./dist/src/obligations.js'); const {profileFingerprint}=await import('./dist/src/profile.js'); console.log(JSON.stringify({same:core.obligations===pure.obligations,ids:profiles.map(p=>p.id),collection:profileFingerprint('collection-node/1')}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); const observed = JSON.parse(result.stdout);
    assert.equal(observed.same, true); assert.deepEqual(observed.ids, profiles.map(p => p.id));
    assert.equal(observed.collection, '49b66a242d694a2b10f0e27fdaa20c41b439fc2378240271599b9c6ae5ab226e');
  }
});

test('capability projection adds source-grounded details while retaining finite IDs and existing fields', async () => {
  assert.deepEqual(profiles.map(p => p.id), ['booking-node/1', 'booking-node/2', 'booking-node/3', 'booking-node/4', 'counter-fixture/1', 'counter-host/1', 'collection-node/1', 'collection-host/1']);
  const { engine, target } = setup(), issuer = new FixtureIssuer(), context = issuer.resolve('fixture-reader');
  const before = canonical({ records: engine.records, heads: engine.ownerHeads });
  const inventory = workflow(engine, 'capabilities', {}, 'reader', context) as any;
  assert.equal(inventory.target_support, null); assert.equal(inventory.trust, 'local-fixture');
  assert.equal(inventory.operations.some((o: any) => o.operation === 'materialize'), false);
  assert.deepEqual(inventory.profile_details.map((p: any) => p.id), inventory.profiles);
  for (const detail of inventory.profile_details) for (const source of detail.source) await access(source);
  const projected = reports(engine, target.ref);
  assert.deepEqual(projected.profiles, inventory.profiles); assert.equal(projected.target_support.target, target.ref);
  const collection = projected.target_support.profiles.find((r: any) => r.profile.id === 'collection-node/1');
  assert.deepEqual(collection.materialization, { supported: true });
  assert.equal(collection.profile.evidence.trust, 'synthetic-local-fixture');
  assert.equal(canonical({ records: engine.records, heads: engine.ownerHeads }), before);
  assert.equal(Object.values(engine.records).some(r => ['realization', 'validation', 'approval'].includes(r.type)), false);
});

test('target support preserves each real Engine first blocker, including backend and scenario failures', () => {
  for (const backend of ['node', 'none'] as const) {
    const { engine, target } = setup(backend);
    const wrong = engine.compose({ ...recipe, id: 'CollectionWrongCheck', proposals: [], selected: [], scenario: { id: 'unknown', checks: [{ id: 'unknown', version: '1' }] } });
    for (const ref of [target.ref, wrong.ref]) {
      for (const report of reports(engine, ref).target_support.profiles) {
        let error: any; try { engine.realize(ref, report.profile.id); } catch (caught) { error = caught; }
        if (!error) assert.deepEqual(report.materialization, { supported: true });
        else assert.deepEqual(report.materialization, { supported: false, first_blocker: { code: error.code, exit: error.exit, message: error.message, details: error.details } });
      }
    }
  }
});

test('capability target reads refuse private or absent records and preserve host/local trust distinctions', () => {
  const { engine } = setup();
  const layer = JSON.parse(JSON.stringify({ id: 'PrivateCollection', revision: 1, model_version: baseline.model_version, owner: 'author-a', baseline: 'CollectionBaseline@1', intent: 'Private proposal', changes: [], acceptance: [], read_set: [], requires_layers: [], assumptions: [], resolution_proposals: [], derived_from: null }));
  engine.layer(layer, 'author-a');
  for (const target of ['PrivateCollection@1', 'Absent@1']) assert.throws(() => reports(engine, target), (e: any) => e.code === 'REF_NOT_FOUND');
  const host = new Engine({}, {}, { modelVersion: BLOCK_MODEL });
  const result = workflow(host, 'capabilities', {}, 'reader') as any;
  assert.deepEqual(result.profiles, ['counter-host/1', 'collection-host/1']);
  assert(result.scenarios.some((s: any) => s.id === 'intent-structure' && s.version === '1'));
  const detail = describeProfileSupport(profiles.find(p => p.id === 'counter-host/1')!);
  assert.equal(detail.evidence.trust, 'authenticated-host');
  assert.equal(detail.evidence.review, 'authenticated-criterion-attestation');
  assert.equal(detail.evidence.approvals, 'separate-required');
  assert.equal(result.profiles.includes('collection-node/1'), false);
  assert.throws(() => engine.realize('CollectionBaseline@1', 'collection-host/1'), (e: any) => e.code === 'UNSUPPORTED_PROFILE');
});
