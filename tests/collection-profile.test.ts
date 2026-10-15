import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Engine, obligations, type Evaluation } from '../src/core.js';
import { CONTENT_MODEL, canonical, digest, normalizeSnapshot, write, type Snapshot, type Layer, type Composition } from '../src/model.js';
import { profiles } from '../src/profiles.js';
import { treeDigest, type FixtureOracle } from '../src/profile-types.js';
import { collectionProfile } from '../src/profiles/collection.js';
import { collectionCountRequirement, collectionTitleRequirement, recognizeCollection, collectionScenario } from '../src/profiles/collection-semantics.js';
import { describeProfileSupport } from '../src/profile-capabilities.js';
import { runCompiledConformance, loadCompiledOutput } from './profile-conformance-harness.test.js';

const fixture = async (name: string) => JSON.parse(await readFile(path.resolve('tests/fixtures/collection', name + '.json'), 'utf8'));
const baseline: Snapshot = normalizeSnapshot(await fixture('bootstrap')), layer: Layer = await fixture('extend'), composition: Composition = await fixture('composition'), expectations = await fixture('expectations');
const code = (wanted: string) => (error: any) => error.code === wanted;
const receipts: unknown[] = [];
function evaluation(snapshot: Snapshot) { const engine = new Engine(); engine.init(snapshot, 'bootstrap'); return engine.target(`${snapshot.id}@${snapshot.revision}`); }
function oracle(e: Evaluation, expected: Record<string, unknown>): FixtureOracle {
  return { format: expectations.format, snapshot_sha256: digest(e.snapshot), expected: structuredClone(expected), criteria: structuredClone(expectations.criteria).sort((a: unknown, b: unknown) => canonical(a).localeCompare(canonical(b))) };
}
function mutate(e: Evaluation, change: (s: Snapshot) => void) { const copy = structuredClone(e); change(copy.snapshot); copy.obligations = obligations(copy.snapshot); return copy; }
const seedEngine = new Engine(); seedEngine.init(baseline, 'bootstrap'); const draft = seedEngine.layer(layer, 'author-a'); seedEngine.publish(draft.ref, 'author-a');
const normalizedLayer: Layer = seedEngine.read(draft.ref, 'layer');
const changedSnapshot = structuredClone(baseline); for (const change of normalizedLayer.changes) write(changedSnapshot.blocks[change.block], change.path, change.value);
const before = evaluation(baseline), changed = evaluation(changedSnapshot);
const baselineCase = { target: 'CollectionBaseline@1', evaluation: before, oracle: oracle(before, expectations.baseline) };
const changedCase = { target: 'CollectionCandidate@1', evaluation: changed, oracle: oracle(changed, expectations.changed) };
const mutations: Record<string, (s: Snapshot) => void> = {
  purpose: s => { s.blocks.items.purpose = 'Send email reminders.'; },
  requirement: s => { s.blocks.policy.requirements.titles.statement = 'Titles may be blank.'; },
  interface: s => { s.blocks.collection.contract.inputs.operations.statement = 'Expose import(path).'; },
  failure: s => { s.blocks.collection.contract.failures.rejected.statement = 'Failed operations clear all items.'; },
  criterion: s => { s.blocks.policy.acceptance.limits.check = 'collection.unbounded'; },
  fixture: s => { s.blocks.policy.acceptance.limits.fixture = 'unreviewed'; },
  subject: s => { s.blocks.policy.acceptance.limits.subjects = ['policy/requirements.titles']; },
  topology: s => { s.blocks.items.parent = 'policy'; },
  relationship: s => { s.blocks.collection.relationships.items.target = 'policy'; },
  parameter: s => { s.blocks.policy.requirements.count.parameters.callback = 'run()'; },
  facet: s => { s.blocks.policy.requirements.count.facets = ['design']; },
  unknown: s => { s.blocks.items.requirements.extra = structuredClone(s.blocks.items.requirements.detached); },
  missing: s => { delete s.blocks.items.requirements.detached; },
  audit: s => { s.blocks.audit = { ...structuredClone(s.blocks.items), id: 'audit', parent: 'collection' }; }
};
runCompiledConformance({ name: 'collection-node/1 direct compiled adapter', adapter: collectionProfile, baseline: baselineCase, changed: changedCase,
  unsupported: Object.entries(mutations).map(([name, change]) => ({ name, evaluation: mutate(before, change) }))
});

after(async () => {
  await mkdir(path.resolve('.strata'), { recursive: true });
  await writeFile(path.resolve('.strata/collection-local-evidence.json'), JSON.stringify({ base: '01f90c7740f96846cdee380e8552362173994b6c', profile: digest(collectionProfile.archive()), trust: 'direct compiled adapter measurement and synthetic fixture review; no hosted authentication or Release claim', cases: receipts }, null, 2) + '\n');
});

test('literal local Layer is owned, normalized and eligible through the registered collection scenario', () => {
  assert.equal(normalizedLayer.owner, 'author-a'); assert.equal(canonical(normalizedLayer.changes[0].value), canonical(changed.snapshot.blocks.policy.requirements.count));
  assert.throws(() => new Engine().layer(layer, 'wrong-author'), code('OWNER_FORBIDDEN'));
  assert(profiles.some(p => p.id === collectionProfile.id));
  const candidate = seedEngine.compose(composition);
  assert.equal(candidate.state, 'eligible_for_validation'); assert.equal(candidate.scope, 'collection');
  assert.equal(seedEngine.realize(candidate.ref, collectionProfile.id).output_tree, collectionProfile.materialize(candidate.ref, candidate).output_tree);
  const detail = describeProfileSupport(collectionProfile); assert.deepEqual(detail.models, [baseline.model_version]); assert(detail.limitations.some(s => s.includes('collection-host/1')));
});

test('shared recognition and scenario refusal agree for every unsupported semantic/topology mutation', () => {
  for (const change of Object.values(mutations)) {
    const e = mutate(before, change); let error: any;
    try { recognizeCollection(e.snapshot); } catch (caught) { error = caught; }
    assert(error);
    const diagnostics = collectionScenario.evaluate({ snapshot: e.snapshot, baseline, composition, proposals: new Map() });
    assert.deepEqual(diagnostics, [{ code: error.code, message: error.message, details: error.details }]);
    assert.throws(() => collectionProfile.materialize(baselineCase.target, e), (caught: any) => caught.code === error.code && canonical(caught.details) === canonical(error.details));
  }
});

test('collection refuses missing, extra, forged value/facet/criterion obligations and blocked candidates', () => {
  for (const change of [
    (e: Evaluation) => { e.obligations.pop(); },
    (e: Evaluation) => { e.obligations.push(structuredClone(e.obligations[0])); },
    (e: Evaluation) => { e.obligations[0].criteria = []; },
    (e: Evaluation) => { e.obligations[0].facets = ['safety']; },
    (e: Evaluation) => { e.obligations[0].value = { forged: true }; }
  ]) { const e = structuredClone(before); change(e); assert.throws(() => collectionProfile.materialize(baselineCase.target, e), code('OBLIGATION_CONSERVATION')); }
  assert.throws(() => collectionProfile.materialize(baselineCase.target, { ...before, state: 'blocked', diagnostics: [{ code: 'EXACT_BLOCKER', message: 'blocked' }] }), code('BLOCKED_CANDIDATE'));
});

test('all finite count/title extremes are measured and out-of-range, noninteger and executable parameters refuse', async () => {
  for (const [max_items, max_title_length] of [[1, 1], [1000, 200]]) {
    const s = structuredClone(baseline); s.blocks.policy.requirements.count = collectionCountRequirement(max_items); s.blocks.policy.requirements.title_length = collectionTitleRequirement(max_title_length);
    const e = evaluation(s), realization = collectionProfile.materialize('CollectionBoundary@1', e), expected = oracle(e, { max_items, max_title_length });
    await loadCompiledOutput(realization, module => {
      const measured = collectionProfile.checker.run(module, expected); assert(Object.values(measured.checks).every(c => c.passed), canonical(measured.checks));
      receipts.push({ case: 'finite-boundary', expected: expected.expected, output: realization.output_tree, measured: measured.observations });
    });
  }
  for (const [key, values] of [['count', [0, 1001, 1.5, NaN, Infinity, '3', null, { execute: 'code' }]], ['title_length', [0, 201, 1.5, '20', null]]] as const) {
    for (const value of values) {
      const s = structuredClone(baseline); s.blocks.policy.requirements[key].parameters[key === 'count' ? 'max_items' : 'max_title_length'] = value;
      assert.throws(() => recognizeCollection(s), code('UNSUPPORTED_OBLIGATION'));
    }
  }
  const oldModel = structuredClone(baseline); oldModel.model_version = CONTENT_MODEL;
  assert.throws(() => recognizeCollection(oldModel), code('UNSUPPORTED_PROFILE'));
});

test('baseline rejects item four; changed intent accepts four and five but rejects six, with literal oracle receipts', async () => {
  for (const c of [baselineCase, changedCase]) {
    const realization = collectionProfile.materialize(c.target, c.evaluation);
    const output = path.resolve('.strata/collection-local', c === baselineCase ? 'baseline' : 'changed');
    await mkdir(output, { recursive: true });
    for (const [name, body] of Object.entries(realization.files)) await writeFile(path.join(output, name), body);
    await writeFile(path.join(output, 'realization.json'), JSON.stringify({ record: realization, registration: 'direct adapter test; registered CLI flow is measured separately' }, null, 2) + '\n');
    await loadCompiledOutput(realization, module => {
      const app = module.createCollection(), trace = [];
      for (let n = 1; n <= 6; n++) { const result = app.add('i' + n, 'a'); trace.push(result); assert.equal(result.accepted, n <= (c.oracle.expected.max_items as number)); }
      const measured = collectionProfile.checker.run(module, c.oracle); assert(Object.values(measured.checks).every(c => c.passed));
      receipts.push({ case: c.target, candidate: realization.candidate, output: realization.output_tree, checker: realization.checker_sha256, fixture: realization.fixture_sha256, oracle: realization.oracle_sha256, expected: c.oracle.expected, trace, measured: measured.observations });
    });
  }
});

test('checker catches always-accepting, state-changing-on-error, mutable, UTF-16-length and shared-instance implementations', async () => {
  const original = collectionProfile.materialize(baselineCase.target, before);
  const alterations = [
    ['always accepts above limit', "if (items.size >= config.max_items) return failure('limit');", ''],
    ['changes on error', 'const failure = reason => ({ accepted: false, reason });', 'const failure = reason => { items.clear(); return { accepted: false, reason }; };'],
    ['leaks reads', 'item: { ...item }', 'item'],
    ['UTF-16 length', '[...title].length', 'title.length'],
    ['shared instances', 'export function createCollection() {\n  const items = new Map();', 'const items = new Map();\nexport function createCollection() {'],
    ['order depends on insertion', ".sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)", ''],
    ['multiline ID match admits line terminators', '$/.exec(id)?.[0] === id', '$/m.test(id)']
  ];
  for (const [name, from, to] of alterations) {
    const modified = structuredClone(original); assert(modified.files['collection.mjs'].includes(from)); modified.files['collection.mjs'] = modified.files['collection.mjs'].replace(from, to); modified.output_tree = treeDigest(modified.files);
    await loadCompiledOutput(modified, module => { const measured = collectionProfile.checker.run(module, baselineCase.oracle); assert(Object.values(measured.checks).some(c => !c.passed), name); receipts.push({ case: 'wrong-implementation', name, measured: measured.observations }); });
  }
  await loadCompiledOutput(original, () => { const wrong = { config: expectations.baseline, createCollection: () => ({ list: () => [], add: () => ({ accepted: true }) }) }; assert(Object.values(collectionProfile.checker.run(wrong, baselineCase.oracle).checks).some(c => !c.passed)); });
});

test('generated config is immutable; ASCII boundaries, Unicode code points and blank titles follow the documented contract', async () => {
  const realization = collectionProfile.materialize(baselineCase.target, before);
  await loadCompiledOutput(realization, module => {
    assert(Object.isFrozen(module.config)); assert.throws(() => { module.config.max_items = 1000; }, TypeError);
    const app = module.createCollection();
    assert.deepEqual(app.add('A', 'e\u0301'.repeat(10)), { accepted: true, item: { id: 'A', title: 'e\u0301'.repeat(10), completed: false } });
    assert.deepEqual(app.add('a', '😀'.repeat(20)), { accepted: true, item: { id: 'a', title: '😀'.repeat(20), completed: false } });
    assert.deepEqual(app.add('0', ' a '), { accepted: true, item: { id: '0', title: ' a ', completed: false } });
    assert.deepEqual(app.list().map((i: any) => i.id), ['0', 'A', 'a']);
    const prior = app.list(); assert.deepEqual(app.add('a', '\u2003'), { accepted: false, reason: 'invalid' }); assert.deepEqual(app.add('overflow', '😀'.repeat(21)), { accepted: false, reason: 'title_too_long' }); assert.deepEqual(app.list(), prior);
  });
});

test('portable ID grammar rejects trailing line terminators rather than accepting a prefix match', async () => {
  const realization = collectionProfile.materialize(baselineCase.target, before);
  await loadCompiledOutput(realization, module => {
    const app = module.createCollection(); app.add('kept', 'title');
    for (const id of ['a\n', 'a\r', 'a\r\n', 'a\u2028', 'a\u2029', 'a'.repeat(32) + '\n']) {
      for (const operation of [() => app.add(id, 'title'), () => app.get(id), () => app.complete(id), () => app.remove(id)]) {
        const prior = app.list(); assert.deepEqual(operation(), { accepted: false, reason: 'invalid' }); assert.deepEqual(app.list(), prior);
      }
    }
  });
});

test('fresh Node processes begin empty and execute the flat ordinary module without package/runtime dependencies', async () => {
  const realization = collectionProfile.materialize(baselineCase.target, before);
  await loadCompiledOutput(realization, (_module, directory) => {
    const args = ['--input-type=module', '-e', "import {createCollection} from './collection.mjs'; const app=createCollection(); console.log(JSON.stringify({initial:app.list(),added:app.add('a','title'),final:app.list()}));"];
    const first = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 5000 }), second = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 5000 });
    assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr); assert.equal(first.stdout, second.stdout);
    assert.deepEqual(JSON.parse(second.stdout).initial, []);
    assert.doesNotMatch(realization.files['collection.mjs'], /\bimport\b|fetch\(|require\(|process\.|Date\b|Math\.random|node:/);
    receipts.push({ case: 'process-restart', first: JSON.parse(first.stdout), second: JSON.parse(second.stdout) });
  });
});

test('collection archive pins runtime, semantic recognizer, checker and fixed fixture implementation independently of candidate inputs', () => {
  const archive: any = collectionProfile.archive();
  assert.equal(archive.semantics.format, 'collection-semantics/1');
  assert(archive.semantics.sources.recognition.includes('recognizeCollection'));
  const original = digest(archive);
  for (const change of [
    (a: any) => { a.template += '\n// changed runtime\n'; },
    (a: any) => { a.semantics.sources.blocks += '\n// changed meaning\n'; },
    (a: any) => { a.checker.source += '\n// changed checker\n'; },
    (a: any) => { a.checker.fixture.valid_ids.push('new-case'); }
  ]) { const copy = structuredClone(archive); change(copy); assert.notEqual(digest(copy), original); }
  assert.equal(collectionProfile.materialize(baselineCase.target, before).profile, collectionProfile.materialize(changedCase.target, changed).profile);
});
