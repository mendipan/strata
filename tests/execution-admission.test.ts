import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AgentExecutionError, executionTaskRef, executionDigest, type ExecutionTask, type ExecutionSnapshot,
} from '../src/agent-execution.js';
import { ExecutionAdmissionJournal } from '../src/agent-execution-admission.js';
import { checkAgentExecutionKit } from '../scripts/agent-execution-conformance.js';
import { kitScenarios, type KitSubject } from './fixtures/agent-execution-kit.js';
import { syntheticExecutionTask } from './fixtures/agent-execution.js';
import { admissionFixture, AdmissionKitBridge, type SyntheticExecutionMetadata } from './fixtures/execution-admission.js';

function temporary(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-admission-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^strata-admission-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}
const fixture = (t: test.TestContext, options: Parameters<typeof admissionFixture>[1] = {}) => admissionFixture(temporary(t), options);
const rejected = (code: string, dispatch?: string) => (error: unknown) => {
  assert.ok(error instanceof AgentExecutionError); assert.equal(error.code, code);
  if (dispatch) assert.equal(error.dispatch, dispatch);
  assert.equal(error.message, 'Agent execution could not complete the requested operation.'); return true;
};
const stored = (f: Awaited<ReturnType<typeof admissionFixture>>) => f.storage.read()['strata-execution/1/' + f.ref.task_id] as {
  task: ExecutionTask; admission: unknown; snapshot: ExecutionSnapshot; native_handle?: string; result?: unknown;
};
function change(metadata: SyntheticExecutionMetadata, mutate: (state: NonNullable<ReturnType<SyntheticExecutionMetadata['read']>>) => void, notify = true) {
  const state = metadata.read()!; mutate(state); metadata.set(state, notify);
}

test('admission commits full strict request/ref/host permission BEFORE guarded adapter dispatch', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.counts(), { authCalls: 0, transports: 0 });
  f.runtime.onStart = () => {
    const record = stored(f);
    assert.deepEqual(record.task, f.task);
    assert.equal(record.native_handle, undefined);
    assert.deepEqual(record.admission, f.grant());
    const permission = f.storage.read()['strata-execution-host/1/' + f.ref.task_id] as { task: unknown; owner_id: string };
    assert.deepEqual(permission.task, f.ref); assert.equal(permission.owner_id, 'synthetic-owner');
  };
  assert.equal((await f.core.submit(f.task)).state, 'queued');
  assert.equal(f.runtime.read().starts, 1); assert.equal(f.metadata.waits, 0);
  const grant = await f.access.current(f.ref, 'status', new AbortController().signal);
  assert.deepEqual(grant, f.grant());
  grant!.session_generation = 999;
  assert.equal((await f.access.current(f.ref, 'status', new AbortController().signal))!.session_generation, 1);
});

test('concurrent exact duplicates dispatch once; canonical object order reuses; changed payload permanently conflicts', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.core.submit(f.task), f.core.submit(f.task), f.core.submit(f.task)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.ok(rejected('EXECUTION_UNAVAILABLE', 'unknown')(result.reason));
  assert.equal(f.runtime.read().starts, 1);
  const reordered = { limits: f.task.limits, instruction: f.task.instruction, repository_revision: f.task.repository_revision,
    binding: f.task.binding, task_id: f.task.task_id, connection_id: f.task.connection_id, format: f.task.format };
  assert.deepEqual(await executionTaskRef(reordered), f.ref);
  await f.core.submit(reordered);
  const before = fs.readFileSync(f.storage.filename, 'utf8');
  await assert.rejects(f.core.submit({ ...f.task, instruction: 'changed' }), rejected('EXECUTION_CONFLICT', 'not_dispatched'));
  assert.equal(fs.readFileSync(f.storage.filename, 'utf8'), before); assert.equal(f.runtime.read().starts, 1);
});

test('lost adapter reply retains uncertainty through restart; explicit original-ref status recovers', async t => {
  const f = await fixture(t); f.scripted.script('submit', { kind: 'lose-response' });
  await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE', 'unknown'));
  assert.equal(stored(f).native_handle, undefined);
  const restarted = await f.reconstruct();
  assert.deepEqual(restarted.counts(), { authCalls: 0, transports: 0 });
  await assert.rejects(restarted.core.submit(restarted.task), rejected('EXECUTION_UNAVAILABLE', 'unknown'));
  assert.deepEqual(restarted.counts(), { authCalls: 0, transports: 0 });
  assert.equal((await restarted.core.status(restarted.ref)).state, 'queued');
  await restarted.core.submit(restarted.task);
  assert.equal(restarted.runtime.read().starts, 1); assert.deepEqual(restarted.scripted.calls, ['status']);
});

test('actual process crashes after admission/native/observation/lost reply retain ID with no automatic resubmit', async t => {
  for (const [mode, exit] of [['after-admission', 81], ['after-native', 72], ['after-host-observation', 83], ['lost-response', 84]] as const) {
    const directory = temporary(t);
    const child = spawnSync(process.execPath, ['--import', './tests/no-external-fetch.mjs',
      'dist/tests/fixtures/execution-admission.js', '--crash', directory, mode], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, exit, child.stderr);
    const f = await admissionFixture(directory, { initialize: false });
    assert.deepEqual(stored(f).task, f.task); assert.deepEqual(stored(f).snapshot.task, f.ref);
    const starts = mode === 'after-admission' ? 0 : 1;
    assert.equal(f.runtime.read().starts, starts);
    if (mode === 'after-host-observation') await f.core.submit(f.task);
    else await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE', 'unknown'));
    assert.equal(f.counts().transports, 0);
    if (mode === 'after-admission') {
      await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_NOT_FOUND', 'unknown'));
      await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE', 'unknown'));
    } else await f.core.status(f.ref);
    assert.equal(f.runtime.read().starts, starts);
  }
});

test('terminal observations and digest-bound results survive restart and never replenish expired output', async t => {
  const f = await fixture(t, { resultRetentionMs: 25 });
  await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded');
  const done = await f.core.status(f.ref), result = await f.core.result(f.ref);
  assert.equal(done.state, 'succeeded'); assert.equal(await executionDigest(result), done.state === 'succeeded' && done.result_sha256);
  const restarted = await f.reconstruct();
  assert.deepEqual(await restarted.core.result(f.ref), result); assert.equal(restarted.counts().transports, 0);
  f.tick(25); await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_RESULT_UNAVAILABLE'));
  assert.equal(stored(f).result, undefined); assert.equal(stored(f).snapshot.state, 'succeeded');
  assert.deepEqual(await f.core.status(f.ref), done); assert.equal(stored(f).result, undefined);
  await f.core.submit(f.task);
  await assert.rejects(f.core.submit({ ...f.task, instruction: 'new payload after expiry' }), rejected('EXECUTION_CONFLICT'));
  assert.equal(f.runtime.read().starts, 1);
});

test('actual process exit after immutable result commit preserves output and original task on restart', async t => {
  const directory = temporary(t);
  const child = spawnSync(process.execPath, ['--import', './tests/no-external-fetch.mjs',
    'dist/tests/fixtures/execution-admission.js', '--crash', directory, 'after-host-result'], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 85, child.stderr);
  const f = await admissionFixture(directory, { initialize: false });
  const original = stored(f).result;
  assert.deepEqual(await f.core.result(f.ref), original);
  assert.equal(f.counts().transports, 0); assert.equal(f.runtime.read().starts, 1);
  const done = await f.core.submit(f.task); assert.equal(done.state, 'succeeded');
  await assert.rejects(f.core.submit({ ...f.task, instruction: 'substituted after crash' }), rejected('EXECUTION_CONFLICT'));
});

test('missing/corrupt host journal fails closed without repair, adapter calls or raw failure persistence', async t => {
  for (const mode of ['missing', 'json', 'owner', 'permission', 'task'] as const) {
    const f = await fixture(t); await f.core.submit(f.task);
    if (mode === 'missing') fs.unlinkSync(f.storage.filename);
    else if (mode === 'json') fs.writeFileSync(f.storage.filename, 'private malformed state');
    else {
      const values = f.storage.read();
      if (mode === 'owner') (values['strata-execution-host/1/owner'] as { owner_id: string }).owner_id = 'another-owner';
      if (mode === 'permission') delete values['strata-execution-host/1/' + f.ref.task_id];
      if (mode === 'task') (values['strata-execution/1/' + f.ref.task_id] as { task: ExecutionTask }).task.instruction = 'tampered';
      fs.writeFileSync(f.storage.filename, JSON.stringify(values));
    }
    const before = fs.existsSync(f.storage.filename) ? fs.readFileSync(f.storage.filename, 'utf8') : undefined;
    const calls = f.counts().transports;
    await assert.rejects(f.core.status(f.ref), (error: unknown) => {
      assert.ok(error instanceof AgentExecutionError); assert.equal(error.dispatch, 'not_dispatched');
      assert.equal(JSON.stringify(error).includes('private malformed state'), false); return true;
    });
    assert.equal(f.counts().transports, calls);
    assert.equal(fs.existsSync(f.storage.filename) ? fs.readFileSync(f.storage.filename, 'utf8') : undefined, before);
  }
});

test('current metadata requires owner, explicit execution consent, selected immutable source and live session', async t => {
  const changes: Array<(s: NonNullable<ReturnType<SyntheticExecutionMetadata['read']>>) => void> = [
    s => { s.owner.authenticated = false; }, s => { s.owner.id = 'another-owner'; }, s => { s.consent = undefined; },
    s => { s.enabled = false; }, s => { s.session.authenticated = false; }, s => { s.session.valid_until = '2025-01-01T00:00:00Z'; },
    s => { s.source.repository_revision = 'b'.repeat(40); }, s => { s.source.binding.repository_id = 'another-repository'; },
    s => { s.consent!.operations = ['status']; }, s => { s.consent!.limits.runtime_ms = 1; },
  ];
  for (const mutate of changes) {
    const f = await fixture(t); change(f.metadata, mutate);
    await assert.rejects(f.core.submit(f.task), error => { assert.ok(error instanceof AgentExecutionError); assert.equal(error.dispatch, 'not_dispatched'); return true; });
    assert.equal(f.counts().transports, 0); assert.equal(f.runtime.read().starts, 0);
    assert.equal(stored(f), undefined);
  }
  const f = await fixture(t);
  const discovery = { ...f.metadata.read()!, consent: { ...f.metadata.read()!.consent!, kind: 'discovery' } };
  f.metadata.set(discovery as unknown as NonNullable<ReturnType<SyntheticExecutionMetadata['read']>>);
  await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_INVALID'));
  await assert.rejects(f.core.submit({ ...f.task, grant: f.grant() } as ExecutionTask), rejected('EXECUTION_INVALID'));
  assert.equal(f.counts().transports, 0);
  f.metadata.read = () => { throw new Error('private metadata detail'); };
  await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE', 'not_dispatched'));
  assert.equal(f.metadata.waits, 0);
});

test('target/declaration replacement is refused; saved operations and limits cannot widen on resumed consent', async t => {
  for (const field of ['service_id', 'instance_id', 'subject', 'declaration_sha256'] as const) {
    const f = await fixture(t); await f.core.submit(f.task);
    change(f.metadata, s => { s.consent![field] = field === 'declaration_sha256' ? 'f'.repeat(64) : 'changed'; });
    await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_STALE', 'not_dispatched'));
    assert.equal(f.runtime.read().starts, 1);
  }
  const f = await fixture(t); change(f.metadata, s => { s.consent!.operations = ['submit', 'status', 'result']; });
  await f.core.submit(f.task);
  change(f.metadata, s => { s.consent!.operations.push('cancel'); });
  await assert.rejects(f.core.cancel(f.ref), rejected('EXECUTION_STALE', 'not_dispatched'));
  assert.equal(f.runtime.calls.includes('cancel'), false);
});

test('revoke/selection/session/credential invalidation aborts local waits and refuses late observations', async t => {
  for (const kind of ['revoke', 'approval', 'selection', 'session', 'credential'] as const) {
    const f = await fixture(t);
    f.scripted.script('submit', { kind: 'after-response', effect: () => change(f.metadata, s => {
      if (kind === 'revoke') s.consent = undefined;
      if (kind === 'approval') s.consent!.approval_generation++;
      if (kind === 'selection') s.source.selection_generation++;
      if (kind === 'session') s.session.generation++;
      if (kind === 'credential') s.credential_generation++;
    }) });
    await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_ABORTED', 'unknown'));
    assert.equal(stored(f).native_handle, undefined); assert.equal(f.runtime.read().starts, 1); assert.equal(f.metadata.waits, 0);
    const calls = f.counts().transports;
    if (kind === 'revoke') await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_AUTH', 'not_dispatched'));
    if (kind === 'approval' || kind === 'selection') await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_STALE', 'not_dispatched'));
    if (kind === 'revoke' || kind === 'approval' || kind === 'selection') assert.equal(f.counts().transports, calls);
  }
});

test('an authenticated reconnection permits explicit inspection, while new approval/selection cannot replay old output', async t => {
  const f = await fixture(t); await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded'); await f.core.status(f.ref);
  change(f.metadata, s => { s.session.generation++; s.credential_generation++; });
  f.setGrant({ ...f.grant(), session_generation: 2, credential_generation: 2 });
  assert.equal((await f.core.status(f.ref)).state, 'succeeded'); assert.equal((await f.core.result(f.ref)).trust, 'agent-output');
  const before = fs.readFileSync(f.storage.filename, 'utf8');
  change(f.metadata, s => { s.consent!.approval_generation++; });
  await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_STALE'));
  assert.equal(fs.readFileSync(f.storage.filename, 'utf8'), before);
});

test('unreported generation/permission changes still fail before persistence', async t => {
  for (const kind of ['session', 'limits'] as const) {
    const f = await fixture(t);
    f.scripted.script('submit', { kind: 'after-response', effect: () => change(f.metadata, s => {
      if (kind === 'session') s.session.generation++;
      else s.consent!.limits.output_bytes = 1;
    }, false) });
    await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_STALE', 'unknown'));
    assert.equal(stored(f).native_handle, undefined);
  }
});

test('invalidation DURING terminal storage put rolls back the host observation', async t => {
  const f = await fixture(t); await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded');
  const original = f.storage.transaction.bind(f.storage);
  f.storage.transaction = closure => original(tx => closure({ ...tx, put: async (key, value) => {
    await tx.put(key, value);
    if (key === 'strata-execution/1/' + f.ref.task_id && (value as { snapshot?: ExecutionSnapshot }).snapshot?.state === 'succeeded')
      change(f.metadata, s => { s.credential_generation++; });
  } }));
  await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_ABORTED', 'unknown'));
  assert.equal(stored(f).snapshot.state, 'queued'); assert.equal(stored(f).result, undefined);
});

test('substituted result/trust/ref/sequence failures never enter the host journal', async t => {
  for (const mode of ['summary', 'trust', 'ref', 'sequence'] as const) {
    const f = await fixture(t); await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded');
    const native = f.runtime.read().records[f.ref.task_id];
    if (mode === 'sequence') f.scripted.script('status', { kind: 'return', value: { ...native.snapshot, sequence: 0 } });
    else f.scripted.script('result', { kind: 'return', value: {
      ...native.result, ...(mode === 'summary' ? { summary: 'substituted' } : mode === 'trust' ? { trust: 'host-measured' } :
        { task: { ...f.ref, task_id: '00000000-0000-4000-8000-000000000099' } }),
    } });
    if (mode === 'sequence') await assert.rejects(f.core.status(f.ref), rejected('EXECUTION_PROTOCOL', 'unknown'));
    else {
      await f.core.status(f.ref);
      await assert.rejects(f.core.result(f.ref), rejected(mode === 'trust' ? 'EXECUTION_PROTOCOL' : 'EXECUTION_BINDING', 'unknown'));
    }
    assert.equal(stored(f).snapshot.state, mode === 'sequence' ? 'queued' : 'succeeded'); assert.equal(stored(f).result, undefined);
  }
});

test('successful status needs only status permission; output retrieval remains a separate explicit operation', async t => {
  const f = await fixture(t);
  change(f.metadata, s => { s.consent!.operations = ['submit', 'status']; });
  await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded');
  assert.equal((await f.core.status(f.ref)).state, 'succeeded');
  assert.deepEqual(f.scripted.calls, ['submit', 'status']); assert.equal(stored(f).result, undefined);
  await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_AUTH', 'not_dispatched'));
  change(f.metadata, s => { s.consent!.operations.push('result'); });
  await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_STALE', 'not_dispatched'));
  assert.equal(stored(f).result, undefined);
});

test('invalidation after result response or during result put prevents private output persistence', async t => {
  for (const phase of ['response', 'put'] as const) {
    const f = await fixture(t); await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded'); await f.core.status(f.ref);
    if (phase === 'response') f.scripted.script('result', { kind: 'after-response', effect: () => change(f.metadata, s => { s.consent = undefined; }) });
    else {
      const original = f.storage.transaction.bind(f.storage);
      f.storage.transaction = closure => original(tx => closure({ ...tx, put: async (key, value) => {
        await tx.put(key, value);
        if (key === 'strata-execution/1/' + f.ref.task_id && (value as { result?: unknown }).result)
          change(f.metadata, s => { s.session.generation++; });
      } }));
    }
    await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_ABORTED', 'unknown'));
    assert.equal(stored(f).snapshot.state, 'succeeded'); assert.equal(stored(f).result, undefined);
  }
});

test('synchronous success is retained without a second status call; explicit result verifies the original budget', async t => {
  const f = await fixture(t);
  const original = f.runtime.start.bind(f.runtime);
  f.runtime.start = async (task, ref, deadline) => {
    await original(task, ref, deadline); await f.runtime.advance(ref, 'succeeded');
    return f.runtime.reply(f.runtime.read().records[ref.task_id]);
  };
  assert.equal((await f.core.submit(f.task)).state, 'succeeded');
  assert.deepEqual(f.scripted.calls, ['submit']); assert.equal(stored(f).result, undefined);
  assert.equal((await f.core.result(f.ref)).trust, 'agent-output'); assert.equal(f.runtime.read().starts, 1);
  await f.core.submit(f.task); assert.deepEqual(f.scripted.calls, ['submit', 'result']);
});

test('a local read failure after dispatched result retrieval preserves unknown certainty and immutable output', async t => {
  const f = await fixture(t); await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded'); await f.core.status(f.ref);
  let failRead = false;
  f.storage.afterCommit = values => {
    if ((values['strata-execution/1/' + f.ref.task_id] as { result?: unknown } | undefined)?.result) failRead = true;
  };
  const original = f.storage.transaction.bind(f.storage);
  f.storage.transaction = closure => {
    if (failRead) return Promise.reject(new Error('private storage failure'));
    return original(closure);
  };
  await assert.rejects(f.core.result(f.ref), rejected('EXECUTION_UNAVAILABLE', 'unknown'));
  assert.ok(stored(f).result);
  f.storage.transaction = original; f.storage.afterCommit = undefined;
  assert.equal((await f.core.result(f.ref)).trust, 'agent-output');
  assert.deepEqual(f.scripted.calls, ['submit', 'status', 'result']);
});

test('local abort and finite call timeout retain uncertain admission and stop waiting without remote-stop claims', async t => {
  const f = await fixture(t, { timeoutMs: 25 });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(f.core.submit(f.task, pre.signal), rejected('EXECUTION_ABORTED', 'not_dispatched'));
  assert.equal(stored(f), undefined);
  f.scripted.script('submit', { kind: 'hang' });
  const heartbeat = setInterval(() => {}, 50);
  try { await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_TIMEOUT', 'unknown')); }
  finally { clearInterval(heartbeat); }
  assert.equal(stored(f).native_handle, undefined); assert.equal(f.metadata.waits, 0);
  await assert.rejects(f.core.submit(f.task), rejected('EXECUTION_UNAVAILABLE', 'unknown'));
  assert.equal(f.runtime.read().starts, 0);
});

test('existing active/rate/capacity budgets are enforced at host reservation and survive reconstruction', async t => {
  for (const limits of [{ capacity: 1 }, { admissionLimits: { activeTasks: 1, startsPerMinute: 16 } },
    { admissionLimits: { activeTasks: 4, startsPerMinute: 1 } }]) {
    const f = await fixture(t, limits); await f.core.submit(f.task);
    const restarted = await f.reconstruct();
    await assert.rejects(restarted.core.submit({ ...f.task, task_id: '00000000-0000-4000-8000-000000000098' }), rejected('EXECUTION_LIMIT'));
    assert.equal(restarted.counts().transports, 0); assert.equal(restarted.runtime.read().starts, 1);
  }
  const f = await fixture(t);
  const otherOwner = new ExecutionAdmissionJournal(f.storage, 'other-owner', f.task.connection_id);
  await assert.rejects(otherOwner.read(f.ref, f.grant()), rejected('EXECUTION_BINDING'));
});

test('published 12-scenario KIT runs the admission core / guarded client / CF adapter-service pair', async t => {
  const roots: string[] = [];
  const subject: KitSubject<string> = {
    name: 'synthetic', task: structuredClone(syntheticExecutionTask),
    shared: () => { const root = temporary(t); roots.push(root); return root; },
    create: root => {
      const bridge = new AdmissionKitBridge(root);
      return { adapter: bridge, advance: (ref, state) => bridge.advance(ref, state) };
    },
    starts: root => {
      const filename = path.join(root, 'service', 'native.json');
      return fs.existsSync(filename) ? (JSON.parse(fs.readFileSync(filename, 'utf8')) as { starts: number }).starts : 0;
    },
  };
  const receipt = await checkAgentExecutionKit(subject);
  assert.equal(receipt.checks.length, kitScenarios.length);
  assert.deepEqual(receipt.checks.filter(check => !check.ok), []);
  assert.equal(receipt.failures, 0); assert.ok(roots.length >= 12);
});
