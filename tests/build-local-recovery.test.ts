import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/model.js';
import { LocalBuildCoordinator } from '../src/build.js';
import { LocalBuildOutput, LOCAL_OUTPUT_LIMITS } from '../src/build-output.js';
import { localBuildFixture } from './build-local-fixture.js';

const code = (wanted: string) => (e: any) => e.code === wanted;

test('one parent journal failure after registration remains pending and startup reads the original committed receipt', async () => {
  const f = await localBuildFixture('recovery-journal'), p = await f.coordinator.prepare(f.selection);
  const request = { selection: f.selection, expected_plan_sha256: p.plan_sha256 };
  let failedOnce = false;
  f.store.failReplace = next => {
    if (!failedOnce && next.phase === 'exporting' && next.realization !== null) { failedOnce = true; return true; }
    return false;
  };
  const pending = await f.coordinator.start(request, 'registration-journal-lost');
  assert(failedOnce); assert.equal(pending.phase, 'exporting'); assert.equal(pending.realization, null);
  assert.equal(pending.error!.code, 'BUILD_RECONCILIATION_REQUIRED');
  const childKey = digest({ build: pending.build_id, step: 'realization.register' }), committed = f.registrations.get(childKey)!;
  assert(committed); assert.equal(f.engine.read(committed.ref).target, f.release.ref);
  const lookup = f.dependencies.lookupRegistration!, observed: string[] = [];
  f.dependencies.lookupRegistration = async input => { observed.push(input.child_key); return lookup(input); };
  const restarted = new LocalBuildCoordinator(f.dependencies);
  const dispatches = f.operations.filter(command => command !== 'inspect').length;
  assert.equal(await restarted.reconcile(), 1);
  const recovered = await restarted.inspect(pending.build_id);
  assert.equal(recovered.phase, 'interrupted'); assert.equal(recovered.realization!.ref, committed.ref);
  assert.equal(recovered.output_tree, f.engine.read(committed.ref).output_tree);
  assert.deepEqual(observed, [childKey]); assert.equal(f.operations.filter(c => c === 'realization.register').length, 1);
  assert.equal(f.operations.filter(command => command !== 'inspect').length, dispatches);
  assert.deepEqual(await readdir(path.join(f.root, pending.allocation!.relative)), []);
  assert.equal((await restarted.start(request, 'registration-journal-lost')).phase, 'interrupted');
});

test('lost committed child response remains unknown through unavailable lookup and later reconciles without dispatch', async () => {
  const f = await localBuildFixture('recovery-response'), p = await f.coordinator.prepare(f.selection), dispatch = f.dependencies.operation;
  f.dependencies.operation = async (...args) => {
    const result = await dispatch(...args);
    if (args[0] === 'realization.register') throw new Error('Lost response after committed registration.');
    return result;
  };
  const request = { selection: f.selection, expected_plan_sha256: p.plan_sha256 }, pending = await f.coordinator.start(request, 'committed-response-lost');
  assert.equal(pending.phase, 'exporting'); assert.equal(pending.realization, null);
  const childKey = digest({ build: pending.build_id, step: 'realization.register' }), receipt = f.registrations.get(childKey)!;
  assert(receipt);
  const lookup = f.dependencies.lookupRegistration;
  f.dependencies.lookupRegistration = undefined;
  const restarted = new LocalBuildCoordinator(f.dependencies);
  assert.equal(await restarted.reconcile(), 0); assert.equal((await restarted.inspect(pending.build_id)).phase, 'exporting');
  f.dependencies.lookupRegistration = async () => ({ state: 'unknown' });
  assert.equal(await restarted.reconcile(), 0);
  const beforeReplay = f.operations.length; assert.equal((await restarted.start(request, 'committed-response-lost')).phase, 'exporting'); assert.equal(f.operations.length, beforeReplay);
  f.dependencies.lookupRegistration = lookup;
  assert.equal(await restarted.reconcile(), 1);
  const recovered = await restarted.inspect(pending.build_id);
  assert.equal(recovered.phase, 'interrupted'); assert.equal(recovered.realization!.ref, receipt.ref);
  assert.equal(f.operations.filter(c => c === 'realization.register').length, 1);
  assert.equal(f.operations.filter(c => c === 'evidence.run').length, 0);
});

test('recovery rejects a different registration receipt key and preserves the original pending attempt', async () => {
  const f = await localBuildFixture('recovery-key'), p = await f.coordinator.prepare(f.selection), dispatch = f.dependencies.operation;
  f.dependencies.operation = async (...args) => {
    const result = await dispatch(...args);
    if (args[0] === 'realization.register') throw new Error('Committed response lost.');
    return result;
  };
  const pending = await f.coordinator.start({ selection: f.selection, expected_plan_sha256: p.plan_sha256 }, 'wrong-receipt-key');
  const receipt = f.registrations.get(digest({ build: pending.build_id, step: 'realization.register' }))!;
  f.dependencies.lookupRegistration = async () => ({ ...receipt, child_key: digest('another-registration') });
  const restarted = new LocalBuildCoordinator(f.dependencies);
  await assert.rejects(restarted.reconcile(), code('BUILD_CHILD_RECEIPT_MISMATCH'));
  f.dependencies.lookupRegistration = async () => ({ ...receipt, input_sha256: digest('another-input') });
  await assert.rejects(restarted.reconcile(), code('BUILD_CHILD_RECEIPT_MISMATCH'));
  assert.equal((await restarted.inspect(pending.build_id)).phase, 'exporting'); assert.equal(f.operations.filter(c => c === 'realization.register').length, 1);
});

test('missing child response data after a committed registration remains recoverable', async () => {
  const f = await localBuildFixture('recovery-missing-data'), p = await f.coordinator.prepare(f.selection), dispatch = f.dependencies.operation;
  f.dependencies.operation = async (...args) => { const result = await dispatch(...args); return args[0] === 'realization.register' ? undefined : result; };
  const pending = await f.coordinator.start({ selection: f.selection, expected_plan_sha256: p.plan_sha256 }, 'missing-response-data');
  assert.equal(pending.phase, 'exporting'); assert.equal(pending.realization, null);
  const restarted = new LocalBuildCoordinator(f.dependencies);
  assert.equal(await restarted.reconcile(), 1); assert((await restarted.inspect(pending.build_id)).realization);
  assert.equal(f.operations.filter(c => c === 'realization.register').length, 1);
});

test('root reservation is atomic across allocator instances and repositories at 1023 ownership entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-s2-capacity-regression-'));
  const slot = { id: 'capacity', label: 'Isolated mocked custody', root, excluded_roots: [process.cwd()], protection: async () => ({ safe: true, fingerprint: digest('mock-only') }) };
  const first = new LocalBuildOutput(slot), second = new LocalBuildOutput({ ...slot, id: 'another-alias-for-same-root' });
  const receipt = await first.preflight(), journal = path.join(root, '.build-ownership'); await mkdir(journal);
  for (let start = 0; start < LOCAL_OUTPUT_LIMITS.attempts_per_root - 1; start += 32) {
    await Promise.all(Array.from({ length: Math.min(32, LOCAL_OUTPUT_LIMITS.attempts_per_root - 1 - start) }, (_, n) => writeFile(path.join(journal, digest('seed-' + (start + n)) + '.json'), '{}', { flag: 'wx' })));
  }
  const results = await Promise.allSettled([first.allocate('repository-a', digest('reservation-a'), receipt), second.allocate('repository-b', digest('reservation-b'), receipt)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert(['OUTPUT_ALLOCATION_BUSY', 'OUTPUT_CAPACITY'].includes(rejected.reason.code));
  assert.equal((await readdir(journal)).length, 1024);
  await assert.rejects(second.allocate('repository-b', digest('another-after-full'), receipt), code('OUTPUT_CAPACITY'));
  assert(!(await readdir(root)).includes('.build-allocation.lock'));
});

test('absent exclusion resolves its existing junction ancestor and refuses overlap before the final directory exists', async () => {
  const container = await mkdtemp(path.join(os.tmpdir(), 'strata-s2-exclusion-regression-')), root = path.join(container, 'controlled-output');
  await mkdir(root);
  const alias = path.join(container, 'excluded-parent-alias'); await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const slot = { id: 'exclusions', label: 'Path-only mocked custody', root, excluded_roots: [path.join(alias, 'future-registry', 'state')], protection: async () => ({ safe: true, fingerprint: digest('mock-only') }) };
  await assert.rejects(new LocalBuildOutput(slot).preflight(), code('OUTPUT_ROOT_UNSAFE'));
  assert.deepEqual(await readdir(root), []);
  // An absent path with a qualified non-overlapping ancestor remains supported.
  await new LocalBuildOutput({ ...slot, excluded_roots: [path.join(container, 'future-source', 'repository')] }).preflight();
});
