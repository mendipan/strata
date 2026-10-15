import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { bytesDigest, digest } from '../src/model.js';
import { LOCAL_PROJECT } from '../src/security.js';
import { confirmDemoActivationReview, createDemoActivationReview, createDemoActivationWorkerConfig,
  decodeDemoActivationGrant, DEMO_ACTIVATION_SOURCE_FILES, DEMO_BINDING_BYTES, DEMO_BINDING_COUNT,
  encodeDemoActivationGrant, readDemoActivationSource, validateDemoActivationGrant } from '../src/integrated-demo-activation.js';

const target = { account_id: '1'.repeat(32), project_id: LOCAL_PROJECT, run_id: 'a1b2c3d4e5f60718',
  worker_name: 'strata-integrated-test', workflow_name: 'strata-integrated-flow', instance_id: 'run-a1b2c3d4e5f60718',
  namespace_id: 'strata-test-namespace', repository_name: 'strata-run-a1b2c3d4e5f60718' };
const attendance = { stdin_is_tty: true, stdout_is_tty: true, confirmation_text: 'START DEMO', operator_label: 'SYNTHETIC fixture' };
const now = 123456789;
const newlyRequired = ['dist/src/native-support.js', 'dist/src/git-workspace.js', 'dist/src/source-binding.js',
  'dist/src/profiles/collection-host.js', 'dist/src/explorer/connection-manager.js', 'dist/src/workflow.js'];

test('every static local activation dependency and its source counterpart are explicitly pinned', async () => {
  const selected = new Set(DEMO_ACTIVATION_SOURCE_FILES);
  assert.equal(selected.size, DEMO_ACTIVATION_SOURCE_FILES.length, 'Duplicate source pins');
  const compiled = [...selected].filter(name => name.startsWith('dist/') && name.endsWith('.js'));
  assert.ok(compiled.length > 0);
  for (const roots of [compiled, ['dist/scripts/integrated-demo-operator.js'], ['dist/src/integrated-demo-worker-entry.js']]) {
    // Parse the real build graph. No bundled output is written or executed;
    // external packages/tools and computed imports need separate qualification.
    const result = await build({ absWorkingDir: process.cwd(), entryPoints: roots,
      outdir: path.join(process.cwd(), '.strata/unwritten-activation-closure'), bundle: true,
      platform: 'node', format: 'esm', packages: 'external', metafile: true, write: false, logLevel: 'silent' });
    assert.deepEqual(result.warnings, [], 'Activation graph must be statically inspectable');
    const localModules = Object.keys(result.metafile!.inputs).map(name => name.replaceAll('\\', '/')).sort();
    assert.ok(localModules.length >= roots.length);
    for (const name of localModules) {
      assert.match(name, /^dist\/.+\.js$/, 'Unexpected local dependency outside the built source');
      assert.ok(selected.has(name), `Unreviewed compiled dependency: ${name}`);
      const source = name.slice(5, -3) + '.ts';
      assert.ok(selected.has(source), `Unreviewed source dependency: ${source}`);
      assert.ok((await readFile(source)).length > 0, source);
    }
  }
});

async function syntheticSource() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-source-pins-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const bytes = Buffer.from([0, 0xff, 13, 10, 0xc3, 0xa9]);
  for (const name of DEMO_ACTIVATION_SOURCE_FILES) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  }
  return { root, bytes, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

test('source capture measures new transitive source and compiled bytes; changes invalidate the exact review', async () => {
  const fixture = await syntheticSource();
  try {
    const source = await readDemoActivationSource(fixture.root);
    const review = createDemoActivationReview('synthetic-source-change', target, source);
    const grant = confirmDemoActivationReview(review, source, attendance, now);
    for (const compiled of newlyRequired) for (const name of [compiled, compiled.slice(5, -3) + '.ts']) {
      assert.equal(source.files[name], bytesDigest(fixture.bytes), name);
      const changedBytes = Buffer.concat([fixture.bytes, Buffer.from([1])]);
      await writeFile(path.join(fixture.root, name), changedBytes);
      const changed = await readDemoActivationSource(fixture.root);
      assert.equal(changed.files[name], bytesDigest(changedBytes));
      assert.notEqual(changed.sha256, source.sha256);
      assert.throws(() => confirmDemoActivationReview(review, changed, attendance, now),
        (error: any) => error.code === 'DEMO_ACTIVATION_REVIEW_REFUSED');
      assert.throws(() => validateDemoActivationGrant(grant, changed, now + 1),
        (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_STALE');
      await writeFile(path.join(fixture.root, name), fixture.bytes);
    }
  } finally { await fixture.cleanup(); }
});

test('a missing newly required compiled dependency refuses source capture before review', async () => {
  const fixture = await syntheticSource();
  try {
    for (const name of newlyRequired) {
      await rm(path.join(fixture.root, name));
      await assert.rejects(readDemoActivationSource(fixture.root),
        (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_MISSING' && error.message.includes(name));
      await writeFile(path.join(fixture.root, name), fixture.bytes);
    }
  } finally { await fixture.cleanup(); }
});

test('a rehashed partial manifest cannot authorize a review or survive grant validation', async () => {
  const source = await readDemoActivationSource(process.cwd());
  const review = createDemoActivationReview('synthetic-partial-source', target, source);
  const grant = confirmDemoActivationReview(review, source, attendance, now);
  const partial = structuredClone(source);
  for (const name of newlyRequired) delete partial.files[name];
  partial.sha256 = digest(partial.files);
  assert.throws(() => createDemoActivationReview('synthetic-partial-source', target, partial),
    (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_REFUSED');
  const alteredReview = { ...review, source: partial };
  const { review_sha256: _reviewHash, ...reviewBody } = alteredReview;
  alteredReview.review_sha256 = digest(reviewBody);
  const altered = { ...grant, source: partial, review_sha256: alteredReview.review_sha256,
    approval: { ...grant.approval, confirmed_review_sha256: alteredReview.review_sha256 } };
  const { grant_sha256: _grantHash, ...grantBody } = altered;
  altered.grant_sha256 = digest(grantBody);
  // Recompute both transport and record hashes, preserving an internally
  // consistent incomplete inventory. Exact required keys still refuse it.
  const restored = decodeDemoActivationGrant(encodeDemoActivationGrant(altered));
  assert.throws(() => validateDemoActivationGrant(restored, source, now + 1),
    (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_REFUSED');
});

test('expanded source review fits unchanged transport bounds and roundtrips exact hashes offline', async () => {
  const source = await readDemoActivationSource(process.cwd());
  const review = createDemoActivationReview('synthetic-transport', target, source);
  assert.equal(review.live_authorized, false);
  const grant = confirmDemoActivationReview(review, source, attendance, now);
  const config = createDemoActivationWorkerConfig(grant);
  assert.ok(Object.keys(config.vars).length <= DEMO_BINDING_COUNT);
  assert.ok(Object.values(config.vars).every(value => Buffer.byteLength(value) <= DEMO_BINDING_BYTES));
  const restored = decodeDemoActivationGrant(config.vars);
  assert.deepEqual(restored, grant);
  validateDemoActivationGrant(restored, source, now + 1);
  for (const name of DEMO_ACTIVATION_SOURCE_FILES) {
    const changed = structuredClone(source);
    changed.files[name] = source.files[name] === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    changed.sha256 = digest(changed.files);
    assert.throws(() => validateDemoActivationGrant(grant, changed, now + 1),
      (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_STALE', name);
  }
});
