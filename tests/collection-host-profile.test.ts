import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BLOCK_MODEL, CONTENT_MODEL, MODEL, canonical, digest, normalizeSnapshot, write, type Snapshot } from '../src/model.js';
import { obligations, type Evaluation } from '../src/core.js';
import { profiles } from '../src/profiles.js';
import { hostCollectionProfile } from '../src/profiles/collection-host.js';
import { recognizeHostCollection, hostCollectionScenario } from '../src/profiles/collection-host-semantics.js';
import { HOST_COLLECTION_FIXTURE } from '../src/profiles/collection-host-checker.js';
import { collectionProfile } from '../src/profiles/collection.js';
import { treeDigest, type FixtureOracle } from '../src/profile-types.js';
import { hostCollectionFixture } from './collection-host-fixture.js';
import { runCompiledConformance, loadCompiledOutput } from './profile-conformance-harness.test.js';

const f = await hostCollectionFixture('profile');
function evaluation(snapshot: Snapshot): Evaluation {
  const normalized = normalizeSnapshot(snapshot), seed = f.engine.target('HostCollectionBaseline@1');
  return { ...seed, snapshot: normalized, fingerprint: digest(normalized), input_fingerprint: digest(normalized), obligations: obligations(normalized) };
}
const baseline = evaluation(f.baseline), changedSnapshot = structuredClone(f.baseline);
write(changedSnapshot.blocks.policy, 'requirements.count', f.extension.changes[0].value);
const changed = evaluation(changedSnapshot), auditedSnapshot = structuredClone(f.baseline);
auditedSnapshot.blocks.audit = structuredClone(f.audit.created_blocks[0]);
for (const change of f.audit.changes) write(auditedSnapshot.blocks[change.block], change.path, change.value);
for (const addition of f.audit.acceptance) write(auditedSnapshot.blocks[addition.block], 'acceptance.' + addition.id, addition.criterion);
const audited = evaluation(auditedSnapshot);
function oracle(e: Evaluation, lane: string): FixtureOracle {
  return { format: f.expectations.format, snapshot_sha256: digest(e.snapshot), expected: structuredClone(f.expectations[lane]), criteria: [...f.expectations.criteria, ...(lane === 'audited' ? f.expectations.audit_criteria : [])].sort((a, b) => canonical(a).localeCompare(canonical(b))) };
}
const cases = { baseline: { target: 'HostBaseline@1', evaluation: baseline, oracle: oracle(baseline, 'baseline') }, changed: { target: 'HostChanged@1', evaluation: changed, oracle: oracle(changed, 'changed') }, audited: { target: 'HostAudited@1', evaluation: audited, oracle: oracle(audited, 'audited') } };
const mutations: Record<string, (snapshot: Snapshot) => void> = {
  purpose: s => { s.blocks.items.purpose = 'Send email.'; },
  requirement: s => { s.blocks.policy.requirements.titles.statement = 'Blank titles are allowed.'; },
  interface: s => { s.blocks.collection.contract.inputs.operations.statement = 'Import arbitrary paths.'; },
  failure: s => { s.blocks.collection.contract.failures.rejected.statement = 'Clear state on rejection.'; },
  criterion: s => { s.blocks.policy.acceptance.limits.fixture = 'unknown'; },
  facet: s => { s.blocks.policy.requirements.count.facets = ['design']; },
  parameter: s => { s.blocks.policy.requirements.count.parameters.callback = true; },
  topology: s => { s.blocks.items.parent = 'policy'; },
  extra: s => { s.blocks.policy.requirements.extra = structuredClone(s.blocks.policy.requirements.titles); },
  missing: s => { delete s.blocks.items.requirements.detached; },
  asset: s => { s.blocks.policy.asset_refs!.background = { asset_ref: 'asset@' + 'a'.repeat(64), content_sha256: 'a'.repeat(64), role: 'background', subjects: [] }; }
};
runCompiledConformance({ name: 'collection-host/1 direct compiled adapter', adapter: hostCollectionProfile, baseline: cases.baseline, changed: cases.changed, evidenceTrust: 'authenticated-host', externalReview: true,
  unsupported: Object.entries(mutations).map(([name, mutate]) => { const e = structuredClone(baseline); mutate(e.snapshot); e.obligations = obligations(e.snapshot); return { name, evaluation: e }; }) });

test('host recognition, exact support and all v0.3 coverage include the optional audit without manufacturing review', async () => {
  for (const c of Object.values(cases)) {
    const realized = hostCollectionProfile.materialize(c.target, c.evaluation);
    assert.equal(realized.model_version, BLOCK_MODEL); assert.equal(canonical(realized.oracle), canonical(c.oracle));
    assert.deepEqual(realized.coverage.map(c => c.item).sort(), c.evaluation.obligations.map(o => o.item).sort());
    await loadCompiledOutput(realized, module => {
      const measured = hostCollectionProfile.checker.run(module, c.oracle);
      assert.equal(measured.checks['intent.review'], undefined);
      assert(Object.values(measured.checks).every(check => check.passed), canonical(measured));
      if (c.oracle.expected.audit) assert.deepEqual(measured.checks['collection.audit'].observations.events, f.expectations.audit_events);
    });
  }
  assert.deepEqual(HOST_COLLECTION_FIXTURE.audit_events, f.expectations.audit_events);
});

test('unsupported audit meaning, topology, parameter, criterion, interface and missing links fail the shared predicates', () => {
  const changes: [(snapshot: Snapshot) => void, string][] = [
    [s => { s.blocks.audit.parent = 'items'; }, 'UNSUPPORTED_OBLIGATION'],
    [s => { s.blocks.audit.purpose = 'Send audit to a network service.'; }, 'UNSUPPORTED_OBLIGATION'],
    [s => { s.blocks.audit.requirements.sequence.parameters.start = 0; }, 'UNSUPPORTED_OBLIGATION'],
    [s => { s.blocks.audit.contract.outputs.events.statement = 'Return mutable history.'; }, 'UNSUPPORTED_OBLIGATION'],
    [s => { s.blocks.audit.acceptance.events.check = 'arbitrary'; }, 'UNSUPPORTED_OBLIGATION'],
    [s => { delete s.blocks.collection.relationships.audit; }, 'DANGLING_REFERENCE'],
    [s => { delete s.blocks.collection.contract.outputs.audit; }, 'DANGLING_REFERENCE'],
    [s => { delete s.blocks.collection.acceptance.audit; }, 'DANGLING_REFERENCE'],
    [s => { s.blocks.audit.requirements.copies.kind = 'invariant'; }, 'UNSUPPORTED_OBLIGATION']
  ];
  for (const [mutate, expected] of changes) {
    const e = structuredClone(audited); mutate(e.snapshot); e.obligations = obligations(e.snapshot);
    const refusal = (error: any) => error.code === expected;
    assert.throws(() => recognizeHostCollection(e.snapshot), refusal);
    assert.throws(() => hostCollectionProfile.materialize('Unsupported@1', e), refusal);
    assert.equal(hostCollectionScenario.evaluate({ snapshot: e.snapshot, baseline: f.baseline, composition: f.recipe, proposals: new Map() })[0].code, expected);
  }
});

test('host audit checker rejects no-op/rejection logging, mutable history, missing audit and skipped sequences', async () => {
  const realized = hostCollectionProfile.materialize(cases.audited.target, audited);
  const mutations = [
    ['no-op logging', ' && before.accepted && !before.item.completed', ''],
    ['wrong sequence', 'sequence: events.length + 1', 'sequence: events.length + 2'],
    ['mutable history', 'return events.map(event => ({ ...event, item: { ...event.item } }));', 'return events;'],
    ['rejection logging', "return result.accepted ? record('add', result) : result;", "return record('add', {...result, item: result.item ?? {id, title, completed:false}});"],
    ['missing audit', 'audit() { return events.map', 'absentAudit() { return events.map']
  ];
  for (const [name, from, to] of mutations) {
    const wrong = structuredClone(realized); assert(wrong.files['collection.mjs'].includes(from)); wrong.files['collection.mjs'] = wrong.files['collection.mjs'].replace(from, to); wrong.output_tree = treeDigest(wrong.files);
    await loadCompiledOutput(wrong, module => { assert.equal(hostCollectionProfile.checker.run(module, cases.audited.oracle).checks['collection.audit'].passed, false, name); });
  }
});

test('finite boundary parameters, Unicode code points and audit remain meaningful at minimum and maximum bounds', async () => {
  for (const [count, length] of [[1, 1], [1000, 200]]) {
    const snapshot = structuredClone(audited.snapshot);
    const { collectionCountRequirement, collectionTitleRequirement } = await import('../src/profiles/collection-semantics.js');
    write(snapshot.blocks.policy, 'requirements.count', collectionCountRequirement(count)); write(snapshot.blocks.policy, 'requirements.title_length', collectionTitleRequirement(length));
    const e = evaluation(snapshot), expected = { ...cases.audited.oracle, snapshot_sha256: digest(e.snapshot), expected: { max_items: count, max_title_length: length, audit: true } };
    await loadCompiledOutput(hostCollectionProfile.materialize('Boundary@1', e), module => { assert(Object.values(hostCollectionProfile.checker.run(module, expected).checks).every(c => c.passed)); });
  }
});

test('new profile never widens old models or historical compiled archives', async () => {
  for (const model of [MODEL, CONTENT_MODEL] as const) { const wrong = structuredClone(baseline); wrong.snapshot.model_version = model; assert.throws(() => hostCollectionProfile.materialize('WrongModel@1', wrong), (e: any) => e.code === 'UNSUPPORTED_PROFILE'); }
  assert.throws(() => collectionProfile.materialize('Host@1', baseline), (e: any) => e.code === 'UNSUPPORTED_PROFILE');
  const oldPins = JSON.parse(await readFile('tests/fixtures/collection-host/historical-profiles.json', 'utf8'));
  for (const [id, pin] of Object.entries(oldPins.profiles)) assert.equal(digest(profiles.find(p => p.id === id)!.archive()), pin, id);
  assert.equal(digest(collectionProfile.archive()), '49b66a242d694a2b10f0e27fdaa20c41b439fc2378240271599b9c6ae5ab226e');
  const archive: any = hostCollectionProfile.archive(), pin = digest(archive);
  for (const mutate of [(a: any) => { a.audit_wrapper += '// changed'; }, (a: any) => { a.semantics.sources.recognition += '// changed'; }, (a: any) => { a.checker.source += '// changed'; }, (a: any) => { a.checker.fixture.audit_events[0].sequence = 9; }]) { const changed = structuredClone(archive); mutate(changed); assert.notEqual(digest(changed), pin); }
});
