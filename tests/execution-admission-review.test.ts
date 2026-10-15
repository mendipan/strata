import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentExecutionError, executionDigest, type AgentExecutionAdapterV1, type ExecutionSnapshot, type ExecutionResult,
} from '../src/agent-execution.js';
import { AgentExecutionClient } from '../src/agent-execution-client.js';
import { ExecutionAdmissionCore } from '../src/agent-execution-admission.js';
import { admissionFixture } from './fixtures/execution-admission.js';
import { ScriptedKitAdapter } from './fixtures/agent-execution-kit.js';

async function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-admission-review-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^strata-admission-review-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return admissionFixture(directory);
}
const reject = (code: string, dispatch?: string) => (error: unknown) => {
  assert.ok(error instanceof AgentExecutionError); assert.equal(error.code, code);
  if (dispatch) assert.equal(error.dispatch, dispatch);
  return true;
};
const record = (f: Awaited<ReturnType<typeof admissionFixture>>) => f.storage.read()['strata-execution/1/' + f.ref.task_id] as {
  native_handle?: string; snapshot: ExecutionSnapshot; result?: ExecutionResult;
};
function core(f: Awaited<ReturnType<typeof admissionFixture>>, adapter: AgentExecutionAdapterV1) {
  return new ExecutionAdmissionCore(f.journal, f.access, new AgentExecutionClient(adapter, f.access, f.now), f.now);
}
async function zeroFixture(f: Awaited<ReturnType<typeof admissionFixture>>, state: 'running' | 'succeeded') {
  const result: ExecutionResult = { format: 'strata-agent-task-result/1', task: f.ref,
    summary: 'Synthetic sequence-zero output', artifacts: [], trust: 'agent-output' };
  const snapshot: ExecutionSnapshot = state === 'succeeded'
    ? { format: 'strata-agent-task-status/1', task: f.ref, state, sequence: 0, result_sha256: await executionDigest(result) }
    : { format: 'strata-agent-task-status/1', task: f.ref, state, sequence: 0 };
  let reply: ExecutionSnapshot = snapshot;
  let starts = 0;
  const adapter: AgentExecutionAdapterV1 = {
    describe: () => f.scripted.describe(),
    submit: async () => { starts++; return structuredClone(reply); },
    status: async () => structuredClone(reply), result: async () => structuredClone(result),
    cancel: async () => { throw new AgentExecutionError('EXECUTION_UNSUPPORTED'); },
  };
  return { adapter, snapshot, result, starts: () => starts, reply: (next: ExecutionSnapshot) => { reply = next; } };
}

test('missed authority change after reservation is sealed through client-derived signals BEFORE dispatch', async t => {
  for (const field of ['session', 'credential', 'limits'] as const) {
    const f = await fixture(t);
    let changed = false;
    f.storage.afterCommit = values => {
      if (changed || !values['strata-execution-host/1/' + f.ref.task_id]) return;
      changed = true;
      const state = f.metadata.read()!;
      if (field === 'session') state.session.generation++;
      else if (field === 'credential') state.credential_generation++;
      else state.consent!.limits.output_bytes++;
      f.metadata.set(state, false);
      // Independently allow the changed fixture session at the service, proving
      // refusal comes from the original HOST seal rather than remote auth.
      f.setGrant({ ...f.grant(), session_generation: state.session.generation, credential_generation: state.credential_generation });
    };
    await assert.rejects(f.core.submit(f.task), reject('EXECUTION_STALE', 'not_dispatched'));
    assert.deepEqual(f.scripted.calls, []); assert.equal(f.counts().transports, 0); assert.equal(f.runtime.read().starts, 0);
    assert.equal(record(f).native_handle, undefined); assert.deepEqual(record(f).snapshot.task, f.ref);
    assert.equal(f.metadata.waits, 0);
    // A new explicit operation gets fresh facts, but cannot resubmit this ID.
    await assert.rejects(f.core.submit(f.task), reject('EXECUTION_UNAVAILABLE', 'unknown'));
    assert.deepEqual(f.scripted.calls, []); assert.equal(f.runtime.read().starts, 0);
  }
});

for (const state of ['running', 'succeeded'] as const) {
  test(`first accepted ${state}/0 is legal; its retained marker preserves later sequence and terminal checks`, async t => {
    const f = await fixture(t), native = await zeroFixture(f, state), host = core(f, native.adapter);
    assert.deepEqual(await host.submit(f.task), native.snapshot);
    assert.deepEqual(record(f).snapshot, native.snapshot); assert.ok(record(f).native_handle);
    assert.deepEqual(await host.status(f.ref), native.snapshot);
    assert.deepEqual(await host.submit(f.task), native.snapshot); assert.equal(native.starts(), 1);
    const restarted = await f.reconstruct(), restored = core(restarted, native.adapter);
    assert.deepEqual(await restored.status(f.ref), native.snapshot);
    if (state === 'succeeded') assert.deepEqual(await restored.result(f.ref), native.result);
    // The accepted sequence zero is now a REAL observation; same-sequence
    // mutation must refuse, unlike the original uncertain placeholder.
    native.reply({ format: 'strata-agent-task-status/1', task: f.ref, state: 'queued', sequence: 0 });
    await assert.rejects(restored.status(f.ref), reject('EXECUTION_PROTOCOL', 'unknown'));
    assert.deepEqual(record(f).snapshot, native.snapshot); assert.equal(native.starts(), 1);
    if (state === 'succeeded') {
      native.reply({ format: 'strata-agent-task-status/1', task: f.ref, state: 'failed', sequence: 1, failure: 'TASK_FAILED' });
      await assert.rejects(restored.status(f.ref), reject('EXECUTION_PROTOCOL', 'unknown'));
      assert.deepEqual(record(f).result, native.result);
    }
    await assert.rejects(restored.submit({ ...f.task, instruction: 'changed original input' }), reject('EXECUTION_CONFLICT', 'not_dispatched'));
    assert.equal(native.starts(), 1);
  });
}

test('explicit recovery accepts the first running/0 or succeeded/0 after a lost submit response without resubmission', async t => {
  for (const state of ['running', 'succeeded'] as const) {
    const f = await fixture(t), native = await zeroFixture(f, state), adapter = new ScriptedKitAdapter(native.adapter);
    const host = core(f, adapter); adapter.script('submit', { kind: 'lose-response' });
    await assert.rejects(host.submit(f.task), reject('EXECUTION_UNAVAILABLE', 'unknown'));
    assert.equal(record(f).native_handle, undefined); assert.equal(record(f).snapshot.state, 'queued');
    await assert.rejects(host.submit(f.task), reject('EXECUTION_UNAVAILABLE', 'unknown'));
    assert.deepEqual(adapter.calls, ['submit']);
    assert.deepEqual(await host.status(f.ref), native.snapshot);
    assert.deepEqual(await host.submit(f.task), native.snapshot);
    if (state === 'succeeded') assert.deepEqual(await host.result(f.ref), native.result);
    assert.equal(native.starts(), 1);
    assert.deepEqual(adapter.calls, state === 'succeeded' ? ['submit', 'status', 'result'] : ['submit', 'status']);
  }
});

test('unmarked non-reservation records fail during retained reads before adapter contact and preserve terminal history', async t => {
  for (const corruption of ['succeeded', 'running', 'queued-sequence', 'cancel-intent', 'result-expiry'] as const) {
    const f = await fixture(t);
    let original: ExecutionSnapshot;
    if (corruption === 'cancel-intent' || corruption === 'result-expiry') {
      f.scripted.script('submit', { kind: 'lose-response' });
      await assert.rejects(f.core.submit(f.task), reject('EXECUTION_UNAVAILABLE', 'unknown'));
      original = record(f).snapshot;
    } else {
      await f.core.submit(f.task);
      await f.runtime.advance(f.ref, corruption === 'queued-sequence' ? 'queued' : corruption);
      original = await f.core.status(f.ref);
    }
    // In particular, succeeded/1 has NOT retrieved host output. Removing only
    // its observation marker must never let failed/2 replace immutable success.
    assert.equal(record(f).result, undefined);
    const key = 'strata-execution/1/' + f.ref.task_id, values = f.storage.read();
    const corrupted = values[key] as { native_handle?: string; cancel_intent?: true; result_expires_at?: number };
    delete corrupted.native_handle;
    if (corruption === 'cancel-intent') corrupted.cancel_intent = true;
    if (corruption === 'result-expiry') corrupted.result_expires_at = f.now() + 1;
    fs.writeFileSync(f.storage.filename, JSON.stringify(values));
    const bytes = fs.readFileSync(f.storage.filename, 'utf8'), calls = [...f.scripted.calls], transports = f.counts().transports;
    f.scripted.script('status', { kind: 'return', value: { format: 'strata-agent-task-status/1', task: f.ref,
      state: 'failed', sequence: original.sequence + 1, failure: 'TASK_FAILED' } });
    await assert.rejects(f.core.status(f.ref), reject('EXECUTION_PROTOCOL', 'not_dispatched'));
    await assert.rejects(f.core.submit(f.task), reject('EXECUTION_PROTOCOL', 'not_dispatched'));
    await assert.rejects(f.core.result(f.ref), reject('EXECUTION_PROTOCOL', 'not_dispatched'));
    await assert.rejects(f.core.cancel(f.ref), reject('EXECUTION_PROTOCOL', 'not_dispatched'));
    assert.deepEqual(f.scripted.calls, calls); assert.equal(f.counts().transports, transports);
    assert.equal(fs.readFileSync(f.storage.filename, 'utf8'), bytes); assert.deepEqual(record(f).snapshot, original);
  }
});
