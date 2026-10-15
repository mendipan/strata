import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AgentExecutionError, executionTaskRef, executionDigest, type ExecutionContext, type ExecutionGrant,
} from '../src/agent-execution.js';
import { AgentExecutionClient } from '../src/agent-execution-client.js';
import { CloudflareExecutionAdapter } from '../src/agent-adapters/cloudflare-execution.js';
import { createCloudflareExecutionService } from '../src/agent-adapters/cloudflare-execution-service.js';
import { CloudflareExecutionJournal } from '../src/agent-adapters/cloudflare-execution-journal.js';
import { cloudflareFixture, SyntheticCloudflareStorage } from './fixtures/cloudflare-execution.js';

async function fixture(t: test.TestContext, options: Parameters<typeof cloudflareFixture>[1] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-cf-execution-'));
  t.after(() => removeFixtureDirectory(directory));
  return { directory, ...await cloudflareFixture(directory, options) };
}
function removeFixtureDirectory(directory: string) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^strata-cf-(execution|crash)-[A-Za-z0-9]+$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}
const errorCode = (code: string, dispatch?: string) => (error: unknown) => {
  assert.ok(error instanceof AgentExecutionError); assert.equal(error.code, code);
  if (dispatch) assert.equal(error.dispatch, dispatch);
  assert.equal(error.message, 'Agent execution could not complete the requested operation.'); return true;
};
const context = (grant: ExecutionGrant): ExecutionContext => ({ grant, signal: new AbortController().signal });

test('separate reference protocol: pure declaration, offline lifecycle and immutable terminal result', async t => {
  const f = await fixture(t); assert.equal(f.adapter.describe().runtime.name, 'synthetic-cloudflare-task-service');
  assert.deepEqual(f.counts(), { authCalls: 0, transports: 0 });
  const queued = await f.client.submit(f.task);
  await f.runtime.advance(f.ref, 'running'); const running = await f.client.status(f.ref, queued);
  await f.runtime.advance(f.ref, 'succeeded'); const done = await f.client.status(f.ref, running);
  const result = await f.client.result(f.task, done); assert.equal(result.trust, 'agent-output');
  assert.equal(await executionDigest(result), done.state === 'succeeded' && done.result_sha256);
  await f.runtime.advance(f.ref, 'failed'); // Service serves retained terminal result without recomputing.
  assert.deepEqual(await f.client.status(f.ref, done), done);
  assert.deepEqual(await f.client.result(f.task, done), result); assert.equal(f.runtime.read().starts, 1);
});

test('atomic concurrent duplicates reserve once; changed original request conflicts even when terminal', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.client.submit(f.task), f.client.submit(f.task), f.client.submit(f.task)]);
  assert.ok(results.some(result => result.status === 'fulfilled')); assert.equal(f.runtime.read().starts, 1);
  for (const result of results) if (result.status === 'rejected') assert.ok(errorCode('EXECUTION_UNAVAILABLE', 'unknown')(result.reason));
  await f.runtime.advance(f.ref, 'succeeded'); await f.client.status(f.ref);
  const changed = { ...f.task, instruction: 'Different payload' }; f.setGrant({ ...f.grant(), task: await executionTaskRef(changed) });
  await assert.rejects(f.client.submit(changed), errorCode('EXECUTION_CONFLICT', 'unknown'));
  assert.equal(f.runtime.read().starts, 1);
});

test('actual synthetic process exits before start, after start and after mapping never duplicate native work', async t => {
  for (const [mode, expectedExit] of [['before-native', 71], ['after-native', 72], ['after-mapping', 73]] as const) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-cf-crash-'));
    t.after(() => removeFixtureDirectory(directory));
    const child = spawnSync(process.execPath, ['--import', './tests/no-external-fetch.mjs',
      'dist/tests/fixtures/cloudflare-execution.js', '--crash', directory, mode], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, expectedExit, child.stderr);
    const f = await cloudflareFixture(directory, { initialize: false });
    assert.equal(f.runtime.read().starts, mode === 'before-native' ? 0 : 1);
    if (mode === 'after-mapping') assert.equal((await f.client.submit(f.task)).state, 'queued');
    else await assert.rejects(f.client.submit(f.task), errorCode('EXECUTION_UNAVAILABLE', 'unknown'));
    if (mode === 'before-native') {
      await assert.rejects(f.client.status(f.ref), errorCode('EXECUTION_UNAVAILABLE', 'unknown'));
      await assert.rejects(f.client.submit(f.task), errorCode('EXECUTION_UNAVAILABLE', 'unknown'));
    } else assert.equal((await f.client.status(f.ref)).state, 'queued');
    assert.equal(f.runtime.read().starts, mode === 'before-native' ? 0 : 1);
  }
});

test('lost reply retains original mapping; explicit status recovers without resubmission', async t => {
  const f = await fixture(t);
  const adapter = new CloudflareExecutionAdapter({ target: f.target, authentication: f.authentication, now: f.now,
    transport: async (url, init) => { await f.transport(url, init); throw new Error('secret transport failure'); } });
  await assert.rejects(new AgentExecutionClient(adapter, f.access, f.now).submit(f.task), errorCode('EXECUTION_UNAVAILABLE', 'unknown'));
  assert.equal((await f.client.status(f.ref)).state, 'queued'); assert.equal(f.runtime.read().starts, 1);
});

test('cooperative cancellation is idempotent; success may win; only native confirmation reports cancelled', async t => {
  const f = await fixture(t); const queued = await f.client.submit(f.task);
  const requested = await f.client.cancel(f.ref, queued); assert.equal(requested.state, 'cancel_requested');
  assert.deepEqual(await f.client.cancel(f.ref, requested), requested);
  await f.runtime.advance(f.ref, 'cancelled'); const cancelled = await f.client.status(f.ref, requested);
  assert.equal(cancelled.state, 'cancelled'); assert.deepEqual(await f.client.cancel(f.ref, cancelled), cancelled);
  await assert.rejects(f.client.result(f.task, cancelled), errorCode('EXECUTION_RESULT_UNAVAILABLE', 'not_dispatched'));
  const race = await fixture(t); await race.client.submit(race.task); race.runtime.cancelOutcome = 'succeeded';
  const won = await race.client.cancel(race.ref); assert.equal(won.state, 'succeeded');
  assert.equal((await race.client.result(race.task, won)).trust, 'agent-output');
});

test('expiry and every authority-generation/revocation race reject late native output and prevent replay', async t => {
  for (const field of ['approval_generation', 'selection_generation', 'session_generation', 'credential_generation', 'revoke', 'expiry', 'invalidate'] as const) {
    const f = await fixture(t);
    f.runtime.onStart = () => {
      if (field === 'revoke') f.setGrant(undefined);
      else if (field === 'expiry') f.tick(300000);
      else if (field === 'invalidate') f.invalidate();
      else f.setGrant({ ...f.grant(), [field]: 2 });
    };
    const code = field === 'revoke' ? 'EXECUTION_AUTH' : field === 'expiry' ? 'EXECUTION_EXPIRED' : field === 'invalidate' ? 'EXECUTION_ABORTED' : 'EXECUTION_STALE';
    await assert.rejects(f.client.submit(f.task), errorCode(code, 'unknown'));
    assert.equal(f.runtime.read().starts, 1);
    const retained = await f.storage.transaction(tx => tx.get<{ native_handle?: string }>('strata-execution/1/' + f.ref.task_id));
    assert.equal(retained?.native_handle, undefined);
  }
  const revoked = await fixture(t); await revoked.client.submit(revoked.task);
  await revoked.runtime.advance(revoked.ref, 'succeeded'); const done = await revoked.client.status(revoked.ref);
  revoked.setGrant({ ...revoked.grant(), approval_generation: 2 });
  await assert.rejects(revoked.client.result(revoked.task, done), errorCode('EXECUTION_STALE', 'unknown'));
});

test('pre-abort, unsupported cancellation, version and identity mismatch refuse without dispatch', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.submit(f.task, controller.signal), errorCode('EXECUTION_ABORTED', 'not_dispatched'));
  for (const update of [{ subject: 'wrong-subject' }, { service_id: 'wrong-service' }, { instance_id: 'wrong-instance' }, { declaration_sha256: 'f'.repeat(64) }]) {
    await assert.rejects(f.adapter.submit(f.task, context({ ...f.grant(), ...update })), errorCode('EXECUTION_BINDING', 'not_dispatched'));
  }
  const declaration = f.adapter.describe(); declaration.capabilities.cancel = 'unsupported';
  const target = { ...f.target, declaration_sha256: await executionDigest(declaration) };
  const adapter = new CloudflareExecutionAdapter({ target, declaration, transport: f.transport, authentication: f.authentication, now: f.now });
  await assert.rejects(adapter.cancel(f.ref, context({ ...f.grant(), declaration_sha256: target.declaration_sha256 })), errorCode('EXECUTION_UNSUPPORTED', 'not_dispatched'));
  await assert.rejects(new CloudflareExecutionAdapter().submit(f.task, context(f.grant())), errorCode('EXECUTION_UNCONFIGURED'));
  assert.equal(f.counts().transports, 0);
});

test('only exact canonical routes accept requests; no URL-selected scope or task options', async t => {
  const f = await fixture(t);
  for (const suffix of ['/tasks?target=elsewhere', '/tasks/' + f.ref.task_id.replace(/^0/, 'A'), '/tasks/%30' + f.ref.task_id.slice(1),
    '/tasks/' + f.ref.task_id + '/result/extra', '/agents/arbitrary/instance', '/tasks/' + f.ref.task_id + '/cancel?x=1']) {
    const response = await f.service(new Request('https://synthetic.invalid/execution' + suffix)); assert.equal(response.status, 400);
  }
  const invalid = await f.service(new Request(f.target.base_url + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f.task, provider_options: { model: 'arbitrary' } }) }));
  assert.equal(invalid.status, 400); assert.equal(f.runtime.read().starts, 0);
  const before = f.counts().authCalls;
  await f.service(new Request(f.target.base_url + '/tasks/' + f.ref.task_id + '/cancel', { method: 'POST', body: '{}' }));
  assert.equal(f.counts().authCalls, before);
});

test('request bytes, native bytes, original output budget and stored capacity are bounded', async t => {
  const f = await fixture(t, { capacity: 1 });
  const raw = await f.service(new Request(f.target.base_url + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' }, body: ' '.repeat(32769) }));
  assert.equal(raw.status, 413); assert.equal(f.runtime.read().starts, 0);
  const small = { ...f.task, limits: { ...f.task.limits, output_bytes: 700 } }; f.setGrant({ ...f.grant(), task: await executionTaskRef(small) });
  await f.client.submit(small); await f.runtime.advance(f.grant().task, 'succeeded', 'x'.repeat(1000));
  await assert.rejects(f.client.status(f.grant().task), errorCode('EXECUTION_LIMIT', 'unknown'));
  const second = { ...f.task, task_id: '00000000-0000-4000-8000-000000000002' }; f.setGrant({ ...f.grant(), task: await executionTaskRef(second) });
  await assert.rejects(f.client.submit(second), errorCode('EXECUTION_LIMIT', 'unknown')); assert.equal(f.runtime.read().starts, 1);
  const huge = await fixture(t); huge.runtime.start = async () => new Response(' '.repeat(100000), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(huge.client.submit(huge.task), errorCode('EXECUTION_LIMIT', 'unknown'));
});

test('result retention expires permanently; tombstone rejects changed payload and prevents restart', async t => {
  const f = await fixture(t, { retentionMs: 10 }); await f.client.submit(f.task);
  await f.runtime.advance(f.ref, 'succeeded'); const done = await f.client.status(f.ref);
  f.tick(11); await assert.rejects(f.client.result(f.task, done), errorCode('EXECUTION_RESULT_UNAVAILABLE', 'unknown'));
  assert.deepEqual(await f.client.status(f.ref, done), done); assert.deepEqual(await f.client.submit(f.task), done);
  await assert.rejects(f.client.result(f.task, done), errorCode('EXECUTION_RESULT_UNAVAILABLE', 'unknown'));
  const changed = { ...f.task, repository_revision: 'b'.repeat(40) }; f.setGrant({ ...f.grant(), task: await executionTaskRef(changed) });
  await assert.rejects(f.client.submit(changed), errorCode('EXECUTION_CONFLICT', 'unknown')); assert.equal(f.runtime.read().starts, 1);
});

test('missing initialization, corrupt/missing indexed records and incompatible runtime fail closed', async t => {
  const f = await fixture(t, { initialize: false });
  await assert.rejects(f.client.submit(f.task), errorCode('EXECUTION_UNCONFIGURED', 'unknown'));
  await f.journal.initializeEmpty(); await f.client.submit(f.task);
  await f.storage.transaction(tx => tx.put('strata-execution/1/' + f.ref.task_id, undefined));
  await assert.rejects(f.client.submit(f.task), errorCode('EXECUTION_PROTOCOL', 'unknown')); assert.equal(f.runtime.read().starts, 1);
  const incompatible = createCloudflareExecutionService({ target: f.target, journal: f.journal,
    authorize: async () => ({ grant: f.grant(), invalidated: new AbortController().signal }), runtime: { ...f.runtime,
      identity: { name: 'agents', version: '0.26.0' }, start: f.runtime.start.bind(f.runtime), lookup: f.runtime.lookup.bind(f.runtime), cancel: f.runtime.cancel.bind(f.runtime) }, now: f.now });
  assert.equal((await incompatible(new Request(f.target.base_url + '/tasks', { method: 'POST' }))).status, 400);
  // Compile-time compatibility with the installed Cloudflare transaction type.
  const acceptsCloudflareStorage = (storage: Pick<DurableObjectStorage, 'transaction'>) => new CloudflareExecutionJournal(storage, 'compile-only');
  assert.equal(typeof acceptsCloudflareStorage, 'function');
  assert.ok(f.storage instanceof SyntheticCloudflareStorage);
});

test('unavailable native, malformed/changed observations and dishonest cancellation do not become terminal success', async t => {
  const f = await fixture(t); await f.client.submit(f.task);
  f.runtime.lookup = async () => undefined;
  await assert.rejects(f.client.status(f.ref), errorCode('EXECUTION_UNAVAILABLE', 'unknown'));
  f.runtime.cancelOutcome = 'running'; await assert.rejects(f.client.cancel(f.ref), errorCode('EXECUTION_PROTOCOL', 'unknown'));
  assert.equal((await f.journal.get(f.ref, f.grant())).snapshot.state, 'queued');
  const hostile = await fixture(t); await hostile.client.submit(hostile.task);
  hostile.runtime.lookup = async () => Response.json({ handle: 'different-native-handle', snapshot: {
    format: 'strata-agent-task-status/1', task: hostile.ref, sequence: 0, state: 'running' } });
  await assert.rejects(hostile.client.status(hostile.ref), errorCode('EXECUTION_BINDING', 'unknown'));
});

test('explicit session/credential reconnection retains approved mapping without another start', async t => {
  const f = await fixture(t); await f.client.submit(f.task);
  f.setGrant({ ...f.grant(), session_generation: 2, credential_generation: 2, valid_until: '2026-01-01T00:06:00Z' });
  assert.equal((await f.client.status(f.ref)).state, 'queued');
  await f.runtime.advance(f.ref, 'succeeded'); const done = await f.client.status(f.ref);
  assert.equal((await f.client.result(f.task, done)).trust, 'agent-output'); assert.equal(f.runtime.read().starts, 1);
});

test('local timeout/abort keeps uncertain reservation and never performs remote cancellation', async t => {
  const f = await fixture(t, { timeoutMs: 20 }); f.runtime.start = async () => new Promise(() => {});
  await assert.rejects(f.client.submit(f.task), errorCode('EXECUTION_TIMEOUT', 'unknown'));
  assert.deepEqual(f.runtime.calls, []); assert.equal(f.storage.read()['strata-execution/1/journal'] !== undefined, true);
  const aborted = await fixture(t), controller = new AbortController();
  aborted.runtime.onStart = () => controller.abort();
  await assert.rejects(aborted.client.submit(aborted.task, controller.signal), errorCode('EXECUTION_ABORTED', 'unknown'));
  assert.equal(aborted.runtime.read().starts, 1); assert.equal(aborted.runtime.calls.includes('cancel'), false);
  assert.equal((await aborted.client.status(aborted.ref)).state, 'queued');
});

test('transport refuses redirects, independent-identity failure and oversized/error JSON; errors are redacted', async t => {
  const f = await fixture(t);
  for (const [response, code] of [[new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } }), 'EXECUTION_PROTOCOL'],
    [Response.json({ error: { code: 'EXECUTION_UNAVAILABLE', secret: 'private-provider-data' } }, { status: 503 }), 'EXECUTION_PROTOCOL'],
    [new Response(' '.repeat(40000), { headers: { 'content-type': 'application/json' } }), 'EXECUTION_LIMIT']] as const) {
    const adapter = new CloudflareExecutionAdapter({ target: f.target, now: f.now,
      authentication: { headers: async () => ({}), verify: async () => ({ subject: f.target.subject, service_id: f.target.service_id, instance_id: f.target.instance_id, expires_at: f.grant().valid_until }) },
      transport: async (_url, init) => { assert.equal(init.redirect, 'manual'); return response; } });
    await assert.rejects(adapter.submit(f.task, context(f.grant())), errorCode(code, 'unknown'));
  }
  const denied = new CloudflareExecutionAdapter({ target: f.target, now: f.now, authentication: f.authentication, transport: async () => Response.json({}) });
  await assert.rejects(denied.submit(f.task, context(f.grant())), errorCode('EXECUTION_UNAVAILABLE', 'unknown'));
  f.runtime.start = async () => { throw new Error('private-provider-data'); };
  const response = await f.service(new Request(f.target.base_url + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.task) }));
  assert.deepEqual(await response.json(), { error: { code: 'EXECUTION_UNAVAILABLE' } });
});

test('synthetic native deadline is separate from control timeout and produces failed task metadata', async t => {
  const f = await fixture(t); await f.client.submit(f.task); f.tick(60001);
  const snapshot = await f.client.status(f.ref); assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.state === 'failed' && snapshot.failure, 'TASK_DEADLINE');
  await assert.rejects(f.client.result(f.task, snapshot), errorCode('EXECUTION_RESULT_UNAVAILABLE', 'not_dispatched'));
});

test('durable admission rate and active-task budgets refuse before native start', async t => {
  const f = await fixture(t, { admissionLimits: { activeTasks: 1, startsPerMinute: 1 } });
  await f.client.submit(f.task);
  await f.runtime.advance(f.ref, 'succeeded'); await f.client.status(f.ref);
  const second = { ...f.task, task_id: '00000000-0000-4000-8000-000000000002' }, secondRef = await executionTaskRef(second);
  f.setGrant({ ...f.grant(), task: secondRef });
  await assert.rejects(f.client.submit(second), errorCode('EXECUTION_LIMIT', 'unknown'));
  assert.equal(f.runtime.read().starts, 1);
  f.tick(60000); await f.client.submit(second);
  const third = { ...f.task, task_id: '00000000-0000-4000-8000-000000000003' }; f.setGrant({ ...f.grant(), task: await executionTaskRef(third) });
  f.tick(60000); await assert.rejects(f.client.submit(third), errorCode('EXECUTION_LIMIT', 'unknown'));
  assert.equal(f.runtime.read().starts, 2);
});

test('foreign ref, same-sequence mutation, tampered digest and malformed raw UTF-8 refuse before retention', async t => {
  for (const kind of ['foreign', 'sequence', 'digest', 'utf8'] as const) {
    const f = await fixture(t); await f.client.submit(f.task);
    f.runtime.lookup = async () => {
      const native = f.runtime.read().records[f.ref.task_id];
      if (kind === 'utf8') return new Response(new Uint8Array([0xff, 0xff]), { headers: { 'content-type': 'application/json' } });
      if (kind === 'foreign') return Response.json({ handle: native.handle, snapshot: { ...native.snapshot, task: { ...f.ref, repository_revision: 'b'.repeat(40) } } });
      if (kind === 'sequence') return Response.json({ handle: native.handle, snapshot: { ...native.snapshot, state: 'running' } });
      return Response.json({ handle: native.handle, snapshot: { ...native.snapshot, sequence: 1, state: 'succeeded', result_sha256: 'b'.repeat(64) },
        result: { format: 'strata-agent-task-result/1', task: f.ref, summary: 'Unbound output', artifacts: [], trust: 'agent-output' } });
    };
    await assert.rejects(f.client.status(f.ref), errorCode(kind === 'foreign' || kind === 'digest' ? 'EXECUTION_BINDING' : 'EXECUTION_PROTOCOL', 'unknown'));
    const record = await f.journal.get(f.ref, f.grant()); assert.equal(record.snapshot.state, 'queued'); assert.equal(record.result, undefined);
  }
});

test('queued result retrieval checks retention after the transaction read', async t => {
  const f = await fixture(t, { retentionMs: 10 }); await f.client.submit(f.task);
  await f.runtime.advance(f.ref, 'succeeded'); const done = await f.client.status(f.ref);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = f.storage.transaction(async () => { await gate; });
  let entered!: () => void;
  const journalEntered = new Promise<void>(resolve => { entered = resolve; });
  const originalResult = f.journal.result.bind(f.journal);
  f.journal.result = (...args) => { entered(); return originalResult(...args); };
  const pending = assert.rejects(f.client.result(f.task, done), errorCode('EXECUTION_RESULT_UNAVAILABLE', 'unknown'));
  await journalEntered; f.tick(11); release(); await holding; await pending;
  const retained = await f.journal.get(f.ref, f.grant());
  assert.equal(retained.result, undefined); assert.deepEqual(retained.snapshot, done);
  assert.equal(f.runtime.read().starts, 1);
});

test('indexed integrity corruption cannot hide an active task from admission accounting', async t => {
  for (const field of ['snapshot', 'admission', 'task'] as const) {
    const f = await fixture(t, { admissionLimits: { activeTasks: 1, startsPerMinute: 16 } });
    await f.client.submit(f.task);
    const key = 'strata-execution/1/' + f.ref.task_id;
    await f.storage.transaction(async tx => {
      const record = (await tx.get<Awaited<ReturnType<typeof f.journal.get>>>(key))!;
      record.snapshot = { format: 'strata-agent-task-status/1', task: structuredClone(f.ref),
        state: 'failed', failure: 'TASK_FAILED', sequence: 1 };
      const foreignId = '00000000-0000-4000-8000-000000000099';
      if (field === 'snapshot') record.snapshot.task.task_id = foreignId;
      else if (field === 'admission') record.admission.task.request_sha256 = 'f'.repeat(64);
      else record.task.task_id = foreignId;
      await tx.put(key, record);
    });
    const next = { ...f.task, task_id: '00000000-0000-4000-8000-000000000002' };
    f.setGrant({ ...f.grant(), task: await executionTaskRef(next) });
    await assert.rejects(f.client.submit(next), errorCode('EXECUTION_PROTOCOL', 'unknown'));
    assert.equal(f.runtime.read().starts, 1);
    assert.equal(f.runtime.read().records[f.ref.task_id].snapshot.state, 'queued');
    assert.equal(f.storage.read()['strata-execution/1/' + next.task_id], undefined);
  }
});
