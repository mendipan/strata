import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrictArtifacts } from './artifacts-fixture.js';
import { CloudflareArtifactsAdapter } from '../src/artifacts.js';
import { artifactBundle } from '../src/artifacts-git.js';
import { RunBudget } from '../src/budget.js';
import { bytesDigest, StrataError } from '../src/model.js';

const error = (code: string) => (e: unknown) => e instanceof StrataError && e.code === code;
const objects = ['{"a":1}', '{"b":2}'].map(bytes => ({ bytes, hash: bytesDigest(bytes) }));
const budget = (operations = 100, bytes = 4 * 1024 * 1024) => new RunBudget({ operations, bytes, attempts: 20, input_tokens: 0, output_tokens: 0, duration_ms: 60000 });

// Contract fixture interprets the actual smart-HTTP packets and decompresses the pack.
// It exposes ONLY documented capability methods: no invented putBlob/putRelease.

test('disabled adapter and exhausted budget make zero capability or network calls', async () => {
  await assert.rejects(new CloudflareArtifactsAdapter().put(objects[0].hash, objects[0].bytes), error('COST_APPROVAL_REQUIRED'));
  await assert.rejects(new CloudflareArtifactsAdapter().get(objects[0].hash), error('COST_APPROVAL_REQUIRED'));
  const fixture = new StrictArtifacts(); await assert.rejects(fixture.adapter(budget(1)).putMany(objects), error('BUDGET_EXHAUSTED')); assert.deepEqual(fixture.calls, []);
  await assert.rejects(fixture.adapter(budget(100, 100)).putMany(objects), error('BUDGET_EXHAUSTED')); assert.deepEqual(fixture.calls, []);
});
test('strict binding/Git fixture verifies one batch push, exact-commit read-back and fresh-instance reads', async () => {
  const fixture = new StrictArtifacts(), adapter = fixture.adapter(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected real network call.'); };
  try {
    const result = await adapter.putMany(objects); assert.equal(fixture.pushes, 1); assert.equal(result.artifacts, 2); assert.equal(result.reused, false);
    assert.equal(await adapter.get(objects[0].hash), objects[0].bytes);
    const fresh = fixture.adapter(); assert.equal(await fresh.getAt(result.locators[1]), objects[1].bytes);
    const again = await fresh.putMany([...objects].reverse()); assert.equal(again.commit, result.commit); assert.equal(again.reused, true); assert.equal(fixture.pushes, 1);
    assert.equal(fixture.revoked, 2); assert.equal(fixture.disposed, 4); assert.ok(!JSON.stringify(result).includes('mock-only-token'));
  } finally { globalThis.fetch = originalFetch; }
});
test('invalid bytes and duplicate hashes are rejected before calls; different data cannot change an immutable branch', async () => {
  const fixture = new StrictArtifacts(); await assert.rejects(fixture.adapter().put(objects[0].hash, 'different'), error('ARTIFACT_DIGEST'));
  await assert.rejects(fixture.adapter().putMany([objects[0], objects[0]]), error('INVALID_ARGUMENT')); assert.deepEqual(fixture.calls, []);
  fixture.refs.set(artifactBundle(objects).branch, 'f'.repeat(40)); await assert.rejects(fixture.adapter().putMany(objects), error('ARTIFACT_COLLISION')); assert.equal(fixture.pushes, 0); assert.equal(fixture.revoked, 1);
});
test('failed push is not retried and cleans up capability/token', async () => {
  const fixture = new StrictArtifacts(); fixture.failPush = true;
  await assert.rejects(fixture.adapter().putMany(objects), error('ARTIFACT_PROTOCOL')); assert.equal(fixture.pushes, 1); assert.equal(fixture.refs.size, 0); assert.equal(fixture.revoked, 1); assert.equal(fixture.disposed, 1);
});
test('successful push with lost response is recovered by an explicit deterministic retry, without duplicate push', async () => {
  const fixture = new StrictArtifacts(); fixture.loseResponse = true;
  await assert.rejects(fixture.adapter().putMany(objects), e => e instanceof StrataError && e.code === 'ARTIFACT_UNAVAILABLE' && !e.message.includes('mock-only-token'));
  const retry = await fixture.adapter().putMany(objects); assert.equal(retry.reused, true); assert.equal(fixture.pushes, 1); assert.equal(fixture.refs.size, 1); assert.equal(fixture.revoked, 2);
});
test('missing/corrupt read-back yields no publishable locator; independently missing reads return null', async () => {
  for (const kind of ['missingRead', 'corruptRead'] as const) {
    const fixture = new StrictArtifacts(); fixture[kind] = true;
    await assert.rejects(fixture.adapter().putMany(objects), error('ARTIFACT_DIGEST')); assert.equal(fixture.revoked, 1); assert.equal(fixture.disposed, 1);
  }
  const fixture = new StrictArtifacts(); assert.equal(await fixture.adapter().get(objects[0].hash), null);
  const result = await fixture.adapter().putMany(objects); fixture.corruptRead = true; await assert.rejects(fixture.adapter().getAt(result.locators[0]), error('ARTIFACT_DIGEST'));
});
test('unexpected binding remote and failed token cleanup stop the adapter', async () => {
  const fixture = new StrictArtifacts(); fixture.wrongRemote = true;
  await assert.rejects(fixture.adapter().putMany(objects), error('ARTIFACT_REMOTE')); assert.equal(fixture.pushes, 0); assert.equal(fixture.revoked, 0); assert.equal(fixture.disposed, 1);
  const cleanup = new StrictArtifacts(); cleanup.cleanupFailure = true;
  await assert.rejects(cleanup.adapter().putMany(objects), error('ARTIFACT_CLEANUP')); assert.equal(cleanup.disposed, 1);
});

test('bounded immutable batch uses one verified handle, reserves all reads and disposes once', async () => {
  const fixture = new StrictArtifacts(), writer = fixture.adapter();
  const stored = await writer.putMany(objects), runBudget = budget(), reader = fixture.adapter(runBudget);
  fixture.calls.length = 0;
  assert.deepEqual(await reader.getManyAt(stored.locators), objects.map(object => object.bytes));
  assert.deepEqual(fixture.calls, ['get', 'info', 'readFile', 'readFile', 'dispose']);
  assert.equal(runBudget.snapshot().reserved.operations, objects.length * 3);
  assert.equal(runBudget.snapshot().reserved.bytes, objects.reduce((n, o) => n + Buffer.byteLength(o.bytes), 0));
  assert.deepEqual(reader.managementCleanupCounts(), { unsettled_dispatches: 0, repo_tokens_issued: 0, repo_tokens_revoked: 0, handles_open: 0 });
  fixture.calls.length = 0;
  await assert.rejects(fixture.adapter(budget(5)).getManyAt(stored.locators), error('BUDGET_EXHAUSTED'));
  assert.deepEqual(fixture.calls, [], 'The complete batch reservation precedes all dispatches.');
  await assert.rejects(reader.getManyAt([stored.locators[0], { ...stored.locators[1], hash: 'wrong' }]), error('INVALID_ARGUMENT'));
  assert.deepEqual(fixture.calls, []);
});

test('failed batch read retains safe stage diagnostics, returns no partial result and never retries', async () => {
  const fixture = new StrictArtifacts(), stored = await fixture.adapter().putMany(objects);
  const get = fixture.get.bind(fixture); let reads = 0;
  fixture.get = async name => { const handle = await get(name), read = handle.readFile;
    handle.readFile = async input => { if (++reads === 2) throw new Error('Too many subrequests. Bearer mock-secret-credential'); return read(input); };
    return handle;
  };
  const runBudget = budget(), reader = fixture.adapter(runBudget);
  await assert.rejects(reader.getManyAt(stored.locators), (e: any) => {
    assert.equal(e.code, 'ARTIFACT_UNAVAILABLE');
    assert.deepEqual(e.details, { stage: 'read.file', category: 'subrequest-limit' });
    assert.equal(JSON.stringify(e).includes('mock-secret'), false); return true;
  });
  assert.equal(reads, 2); assert.equal(runBudget.snapshot().reserved.operations, 6);
  assert.equal(reader.managementCleanupCounts().handles_open, 0);
  assert.equal(reader.managementCleanupCounts().unsettled_dispatches, 0);
});
