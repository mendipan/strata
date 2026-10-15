import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bytesDigest, canonical } from '../src/model.js';
import { treeDigest } from '../src/profile-types.js';
import { COLLECTION_SURFACES, expectedCollection } from '../src/acceptance/collection-suite.js';
import { ORIGINAL_COLLECTION, trustedCollectionSource } from '../src/acceptance/collection-fixture.js';
import { DEFAULT_COLLECTION_DECLARATION, collectionCoverage, compareCollectionObservations, runCollectionAcceptance } from '../src/acceptance/collection.js';
import { prepareCollectionAcceptanceDemo } from '../scripts/collection-acceptance.js';

test('independent literal expectations require correct original and reconstruction, not agreement alone', () => {
  const before = expectedCollection(3), after = expectedCollection(5);
  const checks = compareCollectionObservations(before, structuredClone(before), after);
  assert.equal(checks.length, 14); assert(checks.every(row => row.passed));
  assert.equal(checks.filter(row => row.intent === 'intentional-count-3-to-5').length, 1);
  assert.equal(checks.find(row => row.intent === 'intentional-count-3-to-5')?.equal, null);
  const bothWrong = structuredClone(before); bothWrong.atomic = [];
  assert(compareCollectionObservations(bothWrong, bothWrong, after).some(row => !row.passed));
  const wrongDelta = structuredClone(after); wrongDelta.capacity = before.capacity;
  assert.equal(compareCollectionObservations(before, before, wrongDelta).find(row => row.id === 'changed/capacity')?.passed, false);
  for (const id of COLLECTION_SURFACES.filter(id => id !== 'capacity')) { const unwanted = structuredClone(after); unwanted[id] = []; assert.equal(compareCollectionObservations(before, before, unwanted).find(row => row.id === 'changed/' + id)?.passed, false); }
});

test('unknown, omitted, excluded-required and extra in-scope surfaces cannot count as covered', () => {
  const rows = collectionCoverage(DEFAULT_COLLECTION_DECLARATION); assert.equal(rows.length, 7); assert(rows.every(row => row.status === 'covered'));
  const missing = collectionCoverage(DEFAULT_COLLECTION_DECLARATION.slice(1)); assert.equal(missing.find(row => row.id === 'lifecycle')?.status, 'uncovered');
  const unknown = collectionCoverage([...DEFAULT_COLLECTION_DECLARATION, { id: 'persistence', disposition: 'unknown', rationale: 'State retention was not established.' }]); assert.equal(unknown.at(-1)?.status, 'unknown');
  const uncovered = collectionCoverage([...DEFAULT_COLLECTION_DECLARATION, { id: 'ui', disposition: 'in_scope', rationale: 'UI is required.' }]); assert.equal(uncovered.at(-1)?.status, 'uncovered');
  const excluded = collectionCoverage([...DEFAULT_COLLECTION_DECLARATION, { id: 'ui', disposition: 'excluded', rationale: 'No UI is part of this synthetic scope.' }]); assert.equal(excluded.at(-1)?.status, 'excluded');
  const required = structuredClone(DEFAULT_COLLECTION_DECLARATION); required[0].disposition = 'excluded'; assert.equal(collectionCoverage(required)[0].status, 'uncovered');
  assert.throws(() => collectionCoverage([...DEFAULT_COLLECTION_DECLARATION, DEFAULT_COLLECTION_DECLARATION[0]]), (error: any) => error.code === 'INVALID_RECORD');
  assert.throws(() => collectionCoverage([]));
});

test('worker refuses supplied executable bytes and caller loader environment never enters the fixed command', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'strata-acceptance-worker-'));
  try {
    const marker = path.join(root, 'executed.txt');
    const worker = fileURLToPath(new URL('../src/acceptance/collection-worker.js', import.meta.url));
    const result = spawnSync(process.execPath, ['--no-addons', worker], { cwd: root, input: JSON.stringify({ lane: 'original', source: "await import('node:fs').then(fs=>fs.writeFileSync('executed.txt','bad'));" }), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /UNSUPPORTED_SOURCE/); await assert.rejects(access(marker));
    assert.notEqual(bytesDigest(ORIGINAL_COLLECTION), bytesDigest(trustedCollectionSource('baseline')));
  } finally { assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert(path.basename(root).startsWith('strata-acceptance-worker-')); await rm(root, { recursive: true, force: true }); }
});

test('real Git original, separate baseline/change copies, fixed processes and retained incomplete/refusal outcomes', { timeout: 120000 }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'strata-acceptance-test-'));
  try {
    const input = await prepareCollectionAcceptanceDemo(path.join(parent, 'demo'));
    const sources = await Promise.all([input.original, input.baseline, input.changed].map(root => readFile(path.join(root, 'collection.mjs'), 'utf8')));
    const priorOptions = process.env.NODE_OPTIONS;
    let passed;
    try { process.env.NODE_OPTIONS = '--require=' + path.join(parent, 'unavailable-caller-loader.cjs'); passed = await runCollectionAcceptance(input); }
    finally { if (priorOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = priorOptions; }
    assert.equal(passed.status, 'passed_declared_scope'); assert.equal(passed.inputs_unchanged, true);
    assert.equal(passed.checks.length, 14); assert(passed.checks.every((row: any) => row.passed));
    assert.equal(passed.approval, false); assert.equal(passed.release, false); assert.equal(passed.reconciliation_complete, false); assert.equal(passed.equivalence, 'not-established');
    assert.equal(passed.runs.length, 3); assert(passed.runs.every((row: any) => row.exit_code === 0 && row.failure === null && row.elapsed_ms <= 5000));
    assert(passed.runs.every((row: any) => row.executable === process.execPath && row.argv[0] === '--no-addons' && row.argv[1] === '--max-old-space-size=64'));
    for (const row of passed.runs) assert.equal(row.stdout_sha256, bytesDigest(await readFile(path.join(input.output, row.lane, 'stdout.log'))));
    assert.equal(passed.inputs.original.head_commit, input.original_head); assert.equal(passed.inputs.original.branch, 'fixture'); assert.match(passed.runtime.executable_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(await readFile(path.join(input.output, 'receipt.json'), 'utf8')), passed);
    assert.deepEqual(await Promise.all([input.original, input.baseline, input.changed].map(root => readFile(path.join(root, 'collection.mjs'), 'utf8'))), sources);
    const incomplete = await runCollectionAcceptance({ ...input, output: path.join(parent, 'incomplete'), declared: [...input.declared, { id: 'persistence', disposition: 'unknown', rationale: 'Not established.' }, { id: 'ui', disposition: 'in_scope', rationale: 'Required but unsupported.' }] });
    assert.equal(incomplete.status, 'incomplete'); assert(incomplete.checks.every((row: any) => row.passed)); assert.equal(incomplete.coverage.find((row: any) => row.id === 'persistence').status, 'unknown'); assert.equal(incomplete.coverage.find((row: any) => row.id === 'ui').status, 'uncovered');
    assert.equal(canonical(incomplete.inputs), canonical(passed.inputs));
    await assert.rejects(runCollectionAcceptance(input), (error: any) => error.code === 'EEXIST');
    await assert.rejects(runCollectionAcceptance({ ...input, output: path.join(input.original, 'bad-output') }), (error: any) => error.code === 'INVALID_PATH');
    const manifestFile = path.join(input.baseline, 'realization.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeFile(path.join(input.baseline, 'collection.mjs'), sources[1] + '\n// supplied edit\n');
    const refused = await runCollectionAcceptance({ ...input, output: path.join(parent, 'refused') });
    assert.equal(refused.status, 'refused'); assert.equal(refused.failure.code, 'OUTPUT_TAMPERED'); assert.equal(refused.runs.length, 0); assert.equal(refused.approval, false);
    assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), manifest);
    manifest.files['collection.mjs'] = sources[1] + '\n// supplied edit\n'; manifest.output_tree = treeDigest(manifest.files);
    await writeFile(manifestFile, JSON.stringify(manifest));
    const rehashed = await runCollectionAcceptance({ ...input, output: path.join(parent, 'rehashed') });
    assert.equal(rehashed.status, 'refused'); assert.equal(rehashed.failure.code, 'UNSUPPORTED_ACCEPTANCE_INPUT'); assert.equal(rehashed.runs.length, 0);
  } finally { assert.equal(path.dirname(path.resolve(parent)), path.resolve(tmpdir())); assert(path.basename(parent).startsWith('strata-acceptance-test-')); await rm(parent, { recursive: true, force: true }); }
});
