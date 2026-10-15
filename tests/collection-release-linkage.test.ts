import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/core.js';
import { BLOCK_MODEL, bytesDigest, canonical, digest } from '../src/model.js';
import { prepareCollectionReleaseLinkageDemo } from '../scripts/collection-release-linkage.js';
import { runLinkedCollectionAcceptance, verifyCollectionReleaseLinkage } from '../src/acceptance/collection-release-linkage.js';

let root: string, fixture: Awaited<ReturnType<typeof prepareCollectionReleaseLinkageDemo>>;
before(async () => { root = await mkdtemp(path.join(tmpdir(), 'strata-release-linkage-')); fixture = await prepareCollectionReleaseLinkageDemo(path.join(root, 'demo')); });
after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert(path.basename(root).startsWith('strata-release-linkage-')); await rm(root, { recursive: true, force: true }); });
const fork = () => new Engine(structuredClone(fixture.engine.records), structuredClone(fixture.engine.ownerHeads), { ...fixture.engine.options });
const code = (wanted: string) => (error: any) => { assert.equal(error.code, wanted); return true; };
const runInput = (name: string) => ({ ...fixture.input, output: path.join(root, name), declared: structuredClone(fixture.input.declared) });

test('fresh finite observations bind two separately accepted Releases and registered independent exports without writing semantic records', async () => {
  const engine = fork(), before = digest({ records: engine.records, heads: engine.ownerHeads });
  const input = runInput('passed'), report = await runLinkedCollectionAcceptance(engine, fixture.pins, input);
  assert.equal(report.status, 'passed_declared_scope'); assert.equal(report.records_verified, true); assert.equal(report.store_unchanged, true);
  assert.equal(report.semantic_baseline.release_ref, fixture.pins.baseline.ref); assert.equal(report.semantic_change.baseline_ref, fixture.pins.baseline.ref);
  assert.equal(report.semantic_change.selected_layers.length, 1); assert.notEqual(report.semantic_baseline.validation_ref, report.semantic_change.validation_ref);
  assert.equal(report.semantic_baseline.approvals.length, 2); assert.equal(report.semantic_change.approvals.length, 2);
  assert.equal(report.semantic_baseline.output_tree, JSON.parse(await readFile(path.join(input.baseline, 'realization.json'), 'utf8')).record.output_tree);
  assert.equal(report.acceptance_elevated, false); assert.equal(report.approval, false); assert.equal(report.release_created, false); assert.equal(report.reconciliation_complete, false); assert.equal(report.execution_authenticated, false);
  assert.equal(report.original_source_intent_association, 'not-established'); assert.equal(report.adoption_publication_linkage, 'not-established');
  assert.equal(digest({ records: engine.records, heads: engine.ownerHeads }), before);
  const comparison = JSON.parse(await readFile(path.join(input.output, 'receipt.json'), 'utf8'));
  assert.equal(comparison.checks.length, 14); assert(comparison.checks.every((row: any) => row.passed)); assert.equal(report.comparison_sha256, digest(comparison));
  for (const lane of ['baseline', 'changed'] as const) assert.deepEqual(report.exports[lane].measurement, comparison.inputs[lane]);
  assert.deepEqual(JSON.parse(await readFile(path.join(input.output, 'release-linkage.json'), 'utf8')), report);
  await assert.rejects(runLinkedCollectionAcceptance(engine, fixture.pins, input), (error: any) => error.code === 'EEXIST');
});

test('bootstrap, wrong project/hash, absent closure and serialized/inactive/SDK/hosted contexts cannot substitute accepted local intent', () => {
  const pins = structuredClone(fixture.pins), engine = fork();
  const seed = engine.read('CollectionBaseline@1', 'release'), seedHash = digest(seed), seedRef = 'release@' + seedHash.slice(0, 24);
  engine.store(seedRef, 'release', seed);
  assert.throws(() => verifyCollectionReleaseLinkage(engine, { ...pins, baseline: { ref: seedRef, sha256: seedHash } }), code('ACCEPTED_RELEASE_REQUIRED'));
  assert.throws(() => verifyCollectionReleaseLinkage(engine, { ...pins, project_id: 'other' }), code('PROJECT_FORBIDDEN'));
  assert.throws(() => verifyCollectionReleaseLinkage(engine, { ...pins, changed: { ...pins.changed, sha256: '0'.repeat(64) } }), code('STALE_INTENT'));
  const absent = fork(); delete absent.records[absent.read(pins.baseline.ref, 'release').validation];
  assert.throws(() => verifyCollectionReleaseLinkage(absent, pins), code('REF_NOT_FOUND'));
  assert.throws(() => verifyCollectionReleaseLinkage(JSON.parse(JSON.stringify(engine)) as Engine, pins), code('UNSUPPORTED_ACCEPTANCE_LINKAGE'));
  for (const options of [{ ...engine.options, historical: true }, { ...engine.options, checkerBackend: 'none' as const }]) assert.throws(() => verifyCollectionReleaseLinkage(new Engine(engine.records, engine.ownerHeads, options), pins), code('UNSUPPORTED_ACCEPTANCE_LINKAGE'));
  assert.throws(() => verifyCollectionReleaseLinkage(new Engine({}, {}, { projectId: pins.project_id, modelVersion: BLOCK_MODEL, checkerBackend: 'node' }), pins), code('UNSUPPORTED_ACCEPTANCE_LINKAGE'));
});

test('rehashed failed evidence, omitted authority and forged ancestry still fail ordinary Core Release replay', () => {
  function replaced(engine: Engine, mutate: (release: any) => void) {
    const release = engine.read(fixture.pins.baseline.ref, 'release'); mutate(release);
    const sha256 = digest(release), ref = 'release@' + sha256.slice(0, 24); engine.store(ref, 'release', release);
    return { ...structuredClone(fixture.pins), baseline: { ref, sha256 } };
  }
  const failed = fork(), failedPins = replaced(failed, release => {
    const validation = failed.read(release.validation, 'validation'); validation.evidence.results[0].passed = false; validation.evidence_digest = digest(validation.evidence);
    release.validation = 'validation@' + digest(validation).slice(0, 24); failed.store(release.validation, 'validation', validation);
  });
  assert.throws(() => verifyCollectionReleaseLinkage(failed, failedPins), code('VALIDATION_INCOMPLETE'));
  const noScope = fork(), noScopePins = replaced(noScope, release => { release.approvals = release.approvals.filter((ref: string) => noScope.read(ref, 'approval').kind !== 'scope'); });
  assert.throws(() => verifyCollectionReleaseLinkage(noScope, noScopePins), code('ENDORSEMENT_REQUIRED'));
  const ancestry = fork(), ancestryPins = replaced(ancestry, release => { release.baseline = fixture.pins.changed.ref; });
  assert.throws(() => verifyCollectionReleaseLinkage(ancestry, ancestryPins), code('STALE_INTENT'));
  const metadata = fork(), metadataPins = replaced(metadata, release => {
    const validation = metadata.read(release.validation, 'validation'); validation.evidence_digest = '0'.repeat(64);
    release.validation = 'validation@' + digest(validation).slice(0, 24); metadata.store(release.validation, 'validation', validation);
  });
  assert.throws(() => verifyCollectionReleaseLinkage(metadata, metadataPins), code('STALE_EVIDENCE'));
  const alias = fork(), aliasPins = replaced(alias, release => {
    const validation = alias.read(release.validation, 'validation'), realization = alias.read(validation.realization, 'realization');
    validation.realization = 'realization@' + 'a'.repeat(24); alias.store(validation.realization, 'realization', realization);
    release.validation = 'validation@' + digest(validation).slice(0, 24); alias.store(release.validation, 'validation', validation);
  });
  assert.throws(() => verifyCollectionReleaseLinkage(alias, aliasPins), code('STALE_REALIZATION'));
});

test('supplied candidate labels and tampered registered exports refuse before measurement or evidence creation', async () => {
  const file = path.join(fixture.input.baseline, 'realization.json'), original = await readFile(file, 'utf8');
  try {
    const manifest = JSON.parse(original); manifest.record.target = fixture.pins.changed.ref;
    await writeFile(file, JSON.stringify(manifest));
    const input = runInput('wrong-label'); await assert.rejects(runLinkedCollectionAcceptance(fork(), fixture.pins, input), code('STALE_REALIZATION')); await assert.rejects(access(input.output));
    await writeFile(file, original);
    const moduleFile = path.join(fixture.input.baseline, 'collection.mjs'), module = await readFile(moduleFile, 'utf8');
    try { await writeFile(moduleFile, module + '\n// altered\n'); await assert.rejects(runLinkedCollectionAcceptance(fork(), fixture.pins, runInput('wrong-bytes')), code('OUTPUT_TAMPERED')); }
    finally { await writeFile(moduleFile, module); }
  } finally { await writeFile(file, original); }
});

test('verified semantic closure does not complete unknown or uncovered application scope', async () => {
  const input = runInput('incomplete'); input.declared.push({ id: 'persistence', disposition: 'unknown', rationale: 'No state migration evidence.' }, { id: 'ui', disposition: 'in_scope', rationale: 'No supported UI checks.' });
  const running = runLinkedCollectionAcceptance(fork(), fixture.pins, input);
  input.declared.splice(fixture.input.declared.length); // Caller cannot erase frozen unknown/uncovered scope.
  const report = await running;
  assert.equal(report.status, 'incomplete'); assert.equal(report.records_verified, true); assert.equal(report.approval, false); assert.equal(report.reconciliation_complete, false);
  const measured = JSON.parse(await readFile(path.join(input.output, 'receipt.json'), 'utf8')); assert(measured.checks.every((row: any) => row.passed)); assert(measured.coverage.some((row: any) => row.status === 'unknown')); assert(measured.coverage.some((row: any) => row.status === 'uncovered'));
});

test('retained intent mutation during a fresh comparison refuses linkage and preserves the separate measurement', async () => {
  const engine = fork(), input = runInput('store-drift');
  const mutation = (async () => {
    for (let i = 0; i < 400; i++) {
      if (await access(path.join(input.output, 'original', 'stdout.log')).then(() => true, () => false)) { engine.records[fixture.pins.changed.ref].data.approvals = []; return true; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  })();
  const report = await runLinkedCollectionAcceptance(engine, fixture.pins, input); assert.equal(await mutation, true);
  assert.equal(report.status, 'refused'); assert.equal(report.failure.code, 'STALE_INTENT'); assert.equal(report.records_verified, false); assert.equal(report.store_unchanged, false);
  const measured = JSON.parse(await readFile(path.join(input.output, 'receipt.json'), 'utf8')); assert.equal(measured.status, 'passed_declared_scope'); assert.equal(report.comparison_sha256, digest(measured)); assert.equal(report.approval, false); assert.equal(report.reconciliation_complete, false);
});

for (const trial of [{ lane: 'baseline', labels: true }, { lane: 'changed', labels: true }, { lane: 'baseline', labels: false }] as const) {
  test(`${trial.lane} manifest ${trial.labels ? 'label' : 'byte-only'} mutation and restoration cannot misbind a passing comparison`, async () => {
    const engine = fork(), beforeStore = digest({ records: engine.records, heads: engine.ownerHeads }), input = runInput(`aba-${trial.lane}-${trial.labels ? 'labels' : 'bytes'}`);
    const file = path.join(input[trial.lane], 'realization.json'), original = await readFile(file, 'utf8'), altered = JSON.parse(original);
    if (trial.labels) { altered.record.target = fixture.pins[trial.lane === 'baseline' ? 'changed' : 'baseline'].ref; altered.record.candidate = '0'.repeat(64); }
    const alteredText = JSON.stringify(altered, null, 2) + '\n'; assert.notEqual(alteredText, original);
    let injected = false, restored = false, receiptWatcher: ReturnType<typeof watch> | undefined;
    let injectPromise = Promise.resolve(), restorePromise = Promise.resolve();
    const outputWatcher = watch(root, { persistent: false }, (_event, name) => {
      if (String(name) !== path.basename(input.output) || injected) return;
      injected = true;
      receiptWatcher = watch(input.output, { persistent: false }, (_receiptEvent, name) => {
        if (String(name) !== 'receipt.json' || restored) return;
        restored = true; restorePromise = writeFile(file, original);
      });
      injectPromise = writeFile(file, alteredText);
    });
    let report;
    try { report = await runLinkedCollectionAcceptance(engine, fixture.pins, input); }
    finally { outputWatcher.close(); receiptWatcher?.close(); await injectPromise; await restorePromise; await writeFile(file, original); }
    const measured = JSON.parse(await readFile(path.join(input.output, 'receipt.json'), 'utf8'));
    assert(injected && restored); assert.equal(await readFile(file, 'utf8'), original); assert.equal(digest({ records: engine.records, heads: engine.ownerHeads }), beforeStore);
    assert.equal(measured.status, 'passed_declared_scope'); assert.equal(measured.inputs[trial.lane].candidate, altered.record.candidate);
    assert.equal(measured.inputs[trial.lane].target, altered.record.target); assert.equal(measured.inputs[trial.lane].manifest_sha256, bytesDigest(Buffer.from(alteredText, 'utf8')));
    assert.notEqual(measured.inputs[trial.lane].manifest_sha256, report.exports[trial.lane].measurement.manifest_sha256);
    assert.equal(report.status, 'refused'); assert.equal(report.failure.code, 'STALE_REALIZATION'); assert.match(report.failure.message, new RegExp(`Measured ${trial.lane} input pins`));
    assert.equal(report.comparison_sha256, digest(measured)); assert.equal(report.records_verified, false); assert.equal(report.store_unchanged, false);
    assert.equal(report.semantic_baseline, null); assert.equal(report.semantic_change, null);
    for (const flag of ['execution_authenticated', 'acceptance_elevated', 'approval', 'release_created', 'reconciliation_complete']) assert.equal(report[flag], false);
  });
}
