import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { LocalExecutionStorage } from '../src/agent-adapters/local-execution-storage.js';
import { AgentExecutionError, executionCanonical, executionTaskRef } from '../src/agent-execution.js';
import { digest } from '../src/explorer/owner-files.js';
import { CloudflareExecutionJournal, type CloudflareExecutionStorage, type CloudflareExecutionTransaction } from '../src/agent-adapters/cloudflare-execution-journal.js';
import { localStorage, provisionLocal, localBinding, localFile, localValues, localExecutionFixture, syntheticLocalCustody } from './fixtures/local-execution-storage.js';

function temporary(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-local-execution-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^strata-local-execution-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}
const rejected = (code: string) => (error: unknown) => {
  assert.ok(error instanceof AgentExecutionError); assert.equal(error.code, code);
  assert.equal(error.message, 'Agent execution could not complete the requested operation.'); return true;
};
const recordKey = (f: Awaited<ReturnType<typeof localExecutionFixture>>) => 'strata-execution/1/' + f.ref.task_id;
const hostRecord = (f: Awaited<ReturnType<typeof localExecutionFixture>>) => localValues(f.hostDirectory)[recordKey(f)];
function editEnvelope(directory: string, edit: (value: any) => void, checksum = true) {
  const envelope = JSON.parse(fs.readFileSync(localFile(directory), 'utf8')); edit(envelope);
  if (checksum) { const { sha256: _sha256, ...body } = envelope; envelope.sha256 = digest(executionCanonical(body)); }
  fs.writeFileSync(localFile(directory), JSON.stringify(envelope));
}
async function store(t: test.TestContext) {
  return provisionLocal(path.join(temporary(t), 'host'), 'host');
}
const driver = 'dist/tests/fixtures/local-execution-storage.js';
function crash(directory: string, mode: string, exit: number) {
  const child = spawnSync(process.execPath, ['--import', './tests/no-external-fetch.mjs', driver, mode, directory],
    { encoding: 'utf8', timeout: 15000, cwd: process.cwd() });
  assert.equal(child.status, exit, child.stderr); assert.equal(child.error, undefined);
}

test('local transaction clones values, sorts bounded lists, closes handles and atomically rolls back exceptions', async t => {
  const s = await store(t), original = fs.readFileSync(localFile(s.directory));
  let escaped: CloudflareExecutionTransaction | undefined;
  await assert.rejects(s.transaction(async tx => {
    escaped = tx; await tx.put('a', { private: 'synthetic' }); await tx.put('b', [1, 2]);
    throw new AgentExecutionError('EXECUTION_ABORTED');
  }), rejected('EXECUTION_ABORTED'));
  assert.deepEqual(fs.readFileSync(localFile(s.directory)), original);
  await assert.rejects(escaped!.put('late', 1), rejected('EXECUTION_INVALID'));
  const value = { nested: { n: 1 } };
  await s.transaction(async tx => { await tx.put('z', value); value.nested.n = 99; await tx.put('a', 2); });
  await s.transaction(async tx => {
    const clone = await tx.get<any>('z'); clone.nested.n = 100;
    assert.equal((await tx.get<any>('z')).nested.n, 1);
    assert.deepEqual([...await tx.list({ prefix: '', limit: 1 })], [['a', 2]]);
  });
  assert.deepEqual(localValues(s.directory), { z: { nested: { n: 1 } }, a: 2 });
  await assert.rejects(s.provisionEmpty(), rejected('EXECUTION_CONFLICT'));
  for (const value of [undefined, NaN, new Date(), new Map(), [undefined]])
    await assert.rejects(s.transaction(tx => tx.put('lossy', value)), rejected('EXECUTION_INVALID'));
  assert.equal(localValues(s.directory).lossy, undefined);
});

test('aggregate snapshot bounds refuse before publication and remain readable on reconstruction', async t => {
  const s = await store(t), before = fs.readFileSync(localFile(s.directory));
  const array = Array(100000).fill(0);
  await assert.rejects(s.transaction(async tx => { await tx.put('first', array); await tx.put('second', array); }), rejected('EXECUTION_LIMIT'));
  assert.deepEqual(fs.readFileSync(localFile(s.directory)), before);
  // Body has exactly 200,000 nodes; the envelope's checksum adds one more.
  const edge = Array(199991).fill(0);
  await assert.rejects(s.transaction(tx => tx.put('edge', edge)), rejected('EXECUTION_LIMIT'));
  assert.deepEqual(fs.readFileSync(localFile(s.directory)), before);
  assert.deepEqual(await localStorage(s.directory, 'host').transaction(tx => tx.list({ prefix: '', limit: 1 })), new Map());
});

test('host permission, original reservation and journal index roll back as one transaction', async t => {
  let enabled = false;
  const wrap = (storage: CloudflareExecutionStorage, role: 'host' | 'service'): CloudflareExecutionStorage => ({
    transaction: closure => storage.transaction(tx => closure({ ...tx, put: async (key, value) => {
      await tx.put(key, value);
      if (enabled && role === 'host' && key.startsWith('strata-execution-host/1/') && !key.endsWith('/owner'))
        throw new AgentExecutionError('EXECUTION_ABORTED');
    } })),
  });
  const f = await localExecutionFixture(temporary(t), true, undefined, wrap);
  const before = fs.readFileSync(localFile(f.hostDirectory)); enabled = true;
  await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_ABORTED'));
  assert.deepEqual(fs.readFileSync(localFile(f.hostDirectory)), before);
  assert.equal(hostRecord(f), undefined); assert.equal(f.runtime.read().starts, 0); assert.equal(f.counts().transports, 0);
});

test('final commit guard rejects invalidation after closure completion and preserves exact history', async t => {
  const s = await store(t), before = fs.readFileSync(localFile(s.directory)); let current = true;
  await assert.rejects(s.transaction(async tx => {
    tx.beforeCommit!(() => { if (!current) throw new AgentExecutionError('EXECUTION_STALE'); });
    await tx.put('reserved', true);
    assert.equal(current, true); queueMicrotask(() => { current = false; });
  }), rejected('EXECUTION_STALE'));
  assert.deepEqual(fs.readFileSync(localFile(s.directory)), before);
  assert.deepEqual(fs.readdirSync(s.directory), ['execution.json']);
});

test('late host admission invalidation rolls back the request, permission and index before any dispatch', async t => {
  let invalidate: (() => void) | undefined;
  const wrap = (s: CloudflareExecutionStorage, role: 'host' | 'service'): CloudflareExecutionStorage => ({
    transaction: closure => s.transaction(async tx => {
      const result = await closure(tx); if (role === 'host') invalidate?.(); return result;
    }),
  });
  const f = await localExecutionFixture(temporary(t), true, undefined, wrap);
  const before = fs.readFileSync(localFile(f.hostDirectory));
  invalidate = () => { const state = f.metadata.read()!; state.enabled = false; f.metadata.set(state); };
  await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_ABORTED'));
  invalidate = undefined; await f.hostStorage.transaction(async () => {});
  assert.deepEqual(fs.readFileSync(localFile(f.hostDirectory)), before);
  assert.equal(f.runtime.read().starts, 0); assert.equal(f.counts().transports, 0);
});

test('service reservation, mapping/result, cancel intent and expiry deletion each fence final publication', async t => {
  const f = await localExecutionFixture(temporary(t)); let current = true, flip = true;
  const s: CloudflareExecutionStorage = { transaction: closure => f.serviceStorage.transaction(async tx => {
    const result = await closure(tx); if (flip) current = false; return result;
  }) };
  const journal = new CloudflareExecutionJournal(s, f.task.connection_id, undefined, 25);
  const guard = () => { if (!current) throw new AgentExecutionError('EXECUTION_STALE'); };
  let before = fs.readFileSync(localFile(f.serviceDirectory));
  await assert.rejects(journal.reserve(f.task, f.grant(), f.now(), guard), rejected('EXECUTION_STALE'));
  assert.deepEqual(fs.readFileSync(localFile(f.serviceDirectory)), before);
  flip = false; current = true; await journal.reserve(f.task, f.grant(), f.now(), guard);
  const raw = await f.runtime.start(f.task, f.ref, f.now() + f.task.limits.runtime_ms), initial = await raw.json() as any;
  before = fs.readFileSync(localFile(f.serviceDirectory)); flip = true;
  await assert.rejects(journal.observe(f.ref, f.grant(), initial, f.now(), guard), rejected('EXECUTION_STALE'));
  assert.deepEqual(fs.readFileSync(localFile(f.serviceDirectory)), before);
  current = true; flip = false; await journal.observe(f.ref, f.grant(), initial, f.now(), guard);
  before = fs.readFileSync(localFile(f.serviceDirectory)); flip = true;
  await assert.rejects(journal.requestCancel(f.ref, f.grant(), guard), rejected('EXECUTION_STALE'));
  assert.deepEqual(fs.readFileSync(localFile(f.serviceDirectory)), before);
  current = true; await f.runtime.advance(f.ref, 'succeeded');
  const success = await (await f.runtime.lookup(f.ref, initial.handle))!.json() as any;
  await assert.rejects(journal.observe(f.ref, f.grant(), success, f.now(), guard), rejected('EXECUTION_STALE'));
  assert.deepEqual(fs.readFileSync(localFile(f.serviceDirectory)), before);
  current = true; flip = false; await journal.observe(f.ref, f.grant(), success, f.now(), guard);
  before = fs.readFileSync(localFile(f.serviceDirectory)); f.tick(25); flip = true;
  await assert.rejects(journal.result(f.ref, f.grant(), f.now, guard), rejected('EXECUTION_STALE'));
  assert.deepEqual(fs.readFileSync(localFile(f.serviceDirectory)), before);
  assert.ok(localValues(f.serviceDirectory)[recordKey(f)].result);
});

test('host observation and result attachment recheck original authority at local publication', async t => {
  let invalidate: (() => void) | undefined;
  const wrap = (s: CloudflareExecutionStorage, role: 'host' | 'service'): CloudflareExecutionStorage => ({
    transaction: closure => s.transaction(async tx => {
      let writes = false;
      const result = await closure({ ...tx, put: async (key, value) => { writes = true; await tx.put(key, value); } });
      if (writes && role === 'host') invalidate?.();
      return result;
    }),
  });
  const f = await localExecutionFixture(temporary(t), true, undefined, wrap);
  const revoke = () => { const state = f.metadata.read()!; state.enabled = false; f.metadata.set(state); };
  await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded');
  let before = fs.readFileSync(localFile(f.hostDirectory)); invalidate = revoke;
  await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_ABORTED'));
  // executionWait may stop waiting before file staging finishes; drain its queue.
  invalidate = undefined; await f.hostStorage.transaction(async () => {});
  assert.deepEqual(fs.readFileSync(localFile(f.hostDirectory)), before);
  f.metadata.set({ ...f.metadata.read()!, enabled: true });
  await f.core.status(f.ref); before = fs.readFileSync(localFile(f.hostDirectory)); invalidate = revoke;
  await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_ABORTED'));
  invalidate = undefined; await f.hostStorage.transaction(async () => {});
  assert.deepEqual(fs.readFileSync(localFile(f.hostDirectory)), before); assert.equal(hostRecord(f).result, undefined);
  assert.equal(f.runtime.read().starts, 1);
});

test('invalidation after the atomic rename retains the valid committed admission without dispatch', async t => {
  const f = await localExecutionFixture(temporary(t)), original = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    original(from, to);
    if (String(to) === localFile(f.hostDirectory)) { const state = f.metadata.read()!; state.enabled = false; f.metadata.set(state); }
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_ABORTED')); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  await f.hostStorage.transaction(async () => {});
  assert.deepEqual(hostRecord(f).task, f.task); assert.equal(hostRecord(f).native_handle, undefined);
  assert.ok(localValues(f.hostDirectory)['strata-execution-host/1/' + f.ref.task_id]);
  assert.equal(f.runtime.read().starts, 0); assert.equal(f.counts().transports, 0);
});

test('independent instances and processes exclude competing reservations and invoke one synthetic native start', { timeout: 20000 }, async t => {
  const directory = temporary(t), f = await localExecutionFixture(directory);
  const children = [0, 1].map(() => spawn(process.execPath,
    ['--import', './tests/no-external-fetch.mjs', driver, 'compete', directory], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const outcomes: any[] = [], ready: Promise<void>[] = [], finished: Promise<void>[] = [];
  for (const child of children) {
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
    ready.push(new Promise((resolve, reject) => {
      child.on('message', message => { if (message === 'ready') resolve(); else outcomes.push(message); });
      child.on('error', reject);
      child.on('exit', code => { if (code !== 0) reject(new Error(stderr)); });
    }));
    finished.push(new Promise((resolve, reject) => {
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
    }));
  }
  await Promise.all(ready); for (const child of children) child.send('go'); await Promise.all(finished);
  assert.equal(outcomes.filter(result => result.fresh).length, 1);
  assert.ok(outcomes.every(result => result.fresh !== undefined || result.code === 'EXECUTION_UNAVAILABLE'));
  assert.equal(f.runtime.read().starts, 1);
  const second = localStorage(f.serviceDirectory, 'service', f.task.connection_id);
  const journal = new CloudflareExecutionJournal(second, f.task.connection_id);
  assert.equal((await journal.reserve(f.task, f.grant(), f.now(), () => {})).fresh, false);
  await assert.rejects(journal.reserve({ ...f.task, instruction: 'different' }, f.grant(), f.now(), () => {}), rejected('EXECUTION_CONFLICT'));
  assert.equal(f.runtime.read().starts, 1);
});

test('independent storage instances refuse a held lease and never retry a closure or steal it', async t => {
  const s = await store(t), other = localStorage(s.directory, 'host'); let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  const pending = s.transaction(async tx => { calls++; entered(); await held; await tx.put('x', 1); });
  await enteredPromise;
  await assert.rejects(other.transaction(async () => { calls++; }), rejected('EXECUTION_UNAVAILABLE'));
  release(); await pending; assert.equal(calls, 1);
  assert.equal(await other.transaction(tx => tx.get('x')), 1);
});

test('admission/native/result process crashes preserve original identity and permit only explicit recovery', async t => {
  for (const [mode, exit] of [['admission-crash', 93], ['native-crash', 72], ['result-crash', 94]] as const) {
    const directory = temporary(t); await localExecutionFixture(directory); crash(directory, mode, exit);
    const f = await localExecutionFixture(directory, false);
    assert.equal(f.counts().transports, 0); assert.deepEqual(hostRecord(f).task, f.task);
    if (mode === 'result-crash') {
      assert.deepEqual(await f.core.result(f.ref), hostRecord(f).result); assert.equal(f.counts().transports, 0);
    } else {
      await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE'));
      assert.equal(f.counts().transports, 0);
      if (mode === 'admission-crash') await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_NOT_FOUND'));
      else assert.equal((await f.core.status(f.ref)).state, 'queued');
    }
    assert.equal(f.runtime.read().starts, mode === 'admission-crash' ? 0 : 1);
  }
});

test('crashes before/after rename quarantine interrupted files and leases without automatic repair', async t => {
  for (const [mode, exit] of [['stage-crash', 91], ['rename-crash', 92]] as const) {
    const directory = temporary(t), first = await localExecutionFixture(directory), before = fs.readFileSync(localFile(first.hostDirectory));
    crash(directory, mode, exit);
    const f = await localExecutionFixture(directory, false), committed = fs.readFileSync(localFile(f.hostDirectory));
    assert.equal(f.runtime.read().starts, 0);
    await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE'));
    assert.deepEqual(fs.readFileSync(localFile(f.hostDirectory)), committed); assert.equal(f.counts().transports, 0);
    if (mode === 'stage-crash') assert.deepEqual(committed, before);
    else assert.deepEqual(hostRecord(f).task, f.task);
    // Explicit synthetic operator reconciliation ONLY after confirmed child exit.
    fs.unlinkSync(path.join(f.hostDirectory, '.owner.lock'));
    if (mode === 'stage-crash') {
      await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_PROTOCOL'));
      assert.deepEqual(fs.readFileSync(localFile(f.hostDirectory)), before);
    } else {
      await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE'));
      assert.equal(f.runtime.read().starts, 0);
    }
  }
});

test('missing, truncated, checksum-invalid, oversized and semantically incomplete state refuse unchanged', async t => {
  for (const mode of ['missing', 'truncated', 'checksum', 'oversized', 'missing-permission', 'missing-index', 'missing-marker']) {
    const f = await localExecutionFixture(temporary(t)); await f.core.submit(f.task);
    if (mode === 'missing') fs.unlinkSync(localFile(f.hostDirectory));
    else if (mode === 'truncated') fs.writeFileSync(localFile(f.hostDirectory), '{');
    else if (mode === 'checksum') editEnvelope(f.hostDirectory, value => { value.revision++; }, false);
    else if (mode === 'oversized') { const fd = fs.openSync(localFile(f.hostDirectory), 'r+'); fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd); }
    else editEnvelope(f.hostDirectory, value => {
      if (mode === 'missing-permission') delete value.values['strata-execution-host/1/' + f.ref.task_id];
      else if (mode === 'missing-index') delete value.values['strata-execution/1/journal'];
      else { value.values[recordKey(f)].snapshot.state = 'running'; delete value.values[recordKey(f)].native_handle; }
    });
    const before = fs.existsSync(localFile(f.hostDirectory)) ? fs.readFileSync(localFile(f.hostDirectory)) : undefined;
    const restarted = await f.reconstruct();
    await assert.rejects(restarted.core.status(f.ref), rejected(['missing', 'missing-index'].includes(mode) ? 'EXECUTION_UNCONFIGURED' : 'EXECUTION_PROTOCOL'));
    assert.equal(restarted.counts().transports, 0); assert.equal(restarted.runtime.read().starts, 1);
    assert.deepEqual(fs.existsSync(localFile(f.hostDirectory)) ? fs.readFileSync(localFile(f.hostDirectory)) : undefined, before);
  }
});

test('storage role, owner and connection bindings prevent shared host/service custody', async t => {
  const s = await store(t), before = fs.readFileSync(localFile(s.directory));
  for (const binding of [localBinding('service'), { ...localBinding('host'), owner_id: 'other' }, localBinding('host', 'other')]) {
    const substituted = new LocalExecutionStorage(s.directory, binding, syntheticLocalCustody);
    await assert.rejects(substituted.transaction(async () => {}), rejected('EXECUTION_BINDING'));
  }
  assert.deepEqual(fs.readFileSync(localFile(s.directory)), before);
  if (process.platform === 'win32') assert.throws(() => new LocalExecutionStorage(s.directory, localBinding('host')), rejected('EXECUTION_UNCONFIGURED'));
});

test('hardlinked files and platform custody refusals preserve state', async t => {
  const s = await store(t), extra = path.join(path.dirname(s.directory), 'synthetic-hardlink');
  fs.linkSync(localFile(s.directory), extra);
  await assert.rejects(s.transaction(async () => {}), rejected('EXECUTION_PROTOCOL'));
  fs.unlinkSync(extra);
  if (process.platform === 'win32') {
    const unavailable = new LocalExecutionStorage(s.directory, localBinding('host'), {
      assertWindowsCustody: async () => { throw new Error('synthetic unsafe custody'); },
    });
    await assert.rejects(unavailable.transaction(async () => {}), rejected('EXECUTION_UNAVAILABLE'));
  } else {
    fs.chmodSync(localFile(s.directory), 0o644);
    await assert.rejects(s.transaction(async () => {}), rejected('EXECUTION_PROTOCOL'));
    fs.chmodSync(localFile(s.directory), 0o600); fs.chmodSync(s.directory, 0o755);
    await assert.rejects(s.transaction(async () => {}), rejected('EXECUTION_UNAVAILABLE'));
  }
});

test('separate retained host/service results expire atomically and permanent IDs never replenish or conflict-reset', async t => {
  const f = await localExecutionFixture(temporary(t), true, 25);
  await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded'); await f.core.status(f.ref);
  const result = await f.core.result(f.ref), terminal = structuredClone(hostRecord(f).snapshot);
  assert.notEqual(hostRecord(f).native_handle, localValues(f.serviceDirectory)[recordKey(f)].native_handle);
  const restarted = await f.reconstruct(); assert.deepEqual(await restarted.core.result(f.ref), result);
  assert.equal(restarted.counts().transports, 0);
  f.tick(25);
  await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_RESULT_UNAVAILABLE'));
  await assert.rejects(f.serviceJournal.result(f.ref, f.grant(), f.now, () => {}), rejected('EXECUTION_RESULT_UNAVAILABLE'));
  for (const dir of [f.hostDirectory, f.serviceDirectory]) {
    const retained = localValues(dir)[recordKey(f)]; assert.equal(retained.result, undefined);
    assert.deepEqual(retained.snapshot, terminal); assert.ok(retained.result_expires_at);
    assert.ok(localValues(dir)['strata-execution/1/journal'].ids.includes(f.ref.task_id));
  }
  const before = fs.readFileSync(localFile(f.hostDirectory));
  await assert.rejects(f.core.submit({ ...f.task, instruction: 'after expiry' }), rejected('EXECUTION_CONFLICT'));
  assert.deepEqual(fs.readFileSync(localFile(f.hostDirectory)), before); assert.equal(f.runtime.read().starts, 1);
});

test('active and rate admission limits survive reconstruction without dropping reservations', async t => {
  const f = await localExecutionFixture(temporary(t));
  const journal = new CloudflareExecutionJournal(f.serviceStorage, f.task.connection_id, 2, undefined, { activeTasks: 1, startsPerMinute: 1 });
  await journal.reserve(f.task, f.grant(), f.now(), () => {});
  const other = { ...f.task, task_id: '22222222-2222-4222-8222-222222222222' }, grant = { ...f.grant(), task: await executionTaskRef(other) };
  const restarted = new CloudflareExecutionJournal(localStorage(f.serviceDirectory, 'service', f.task.connection_id), f.task.connection_id, 2,
    undefined, { activeTasks: 1, startsPerMinute: 1 });
  const before = fs.readFileSync(localFile(f.serviceDirectory));
  await assert.rejects(restarted.reserve(other, grant, f.now(), () => {}), rejected('EXECUTION_LIMIT'));
  await assert.rejects(restarted.reserve(other, grant, f.now() + 60001, () => {}), rejected('EXECUTION_LIMIT'));
  assert.deepEqual(fs.readFileSync(localFile(f.serviceDirectory)), before);
});
