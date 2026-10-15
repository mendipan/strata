import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentExecutionError, executionDeclarationSchema, executionTaskRef, executionDigest,
  assertExecutionTransition, type AgentExecutionAccess, type ExecutionGrant, type ExecutionSnapshot,
} from '../src/agent-execution.js';
import { AgentExecutionClient } from '../src/agent-execution-client.js';
import { SyntheticExecutionAdapter, syntheticExecutionTask } from './fixtures/agent-execution.js';

async function fixture() {
  const adapter = new SyntheticExecutionAdapter(), task = structuredClone(syntheticExecutionTask), ref = await executionTaskRef(task);
  let now = Date.parse('2026-01-01T00:00:00Z');
  let grant: ExecutionGrant | undefined = {
    format: 'strata-agent-execution-grant/1', task: ref, declaration_sha256: await executionDigest(adapter.describe()),
    service_id: 'synthetic-service', instance_id: 'synthetic-instance', subject: 'synthetic-verified-subject',
    consent: 'approved', enabled: true, approval_generation: 1, selection_generation: 1,
    session_generation: 1, credential_generation: 1, valid_until: '2026-01-01T00:01:00Z',
  };
  const access: AgentExecutionAccess = { current: async () => structuredClone(grant) };
  return { adapter, task, ref, access, client: new AgentExecutionClient(adapter, access, () => now),
    grant: () => grant!, setGrant: (next: ExecutionGrant | undefined) => { grant = next; }, tick: (ms: number) => { now += ms; } };
}
const rejectsCode = (code: string, dispatch?: string) => (error: unknown) => {
  assert.ok(error instanceof AgentExecutionError); assert.equal(error.code, code);
  if (dispatch) assert.equal(error.dispatch, dispatch);
  assert.equal(error.message, 'Agent execution could not complete the requested operation.');
  return true;
};

test('execution lifecycle binds submission, status and digest-checked result; outputs have no measured trust', async () => {
  const f = await fixture();
  const queued = await f.client.submit(f.task); assert.equal(queued.state, 'queued');
  await f.adapter.advance(f.ref, 'running'); const running = await f.client.status(f.ref, queued);
  await f.adapter.advance(f.ref, 'succeeded'); const done = await f.client.status(f.ref, running);
  const result = await f.client.result(f.task, done);
  assert.equal(result.trust, 'agent-output'); assert.equal(f.adapter.journal.starts, 1);
  assert.deepEqual(f.adapter.calls, ['submit', 'status', 'status', 'result']);
});

test('original task ID is idempotent across adapter reconstruction; changed payload conflicts', async () => {
  const f = await fixture(); await f.client.submit(f.task);
  const adapter = new SyntheticExecutionAdapter(f.adapter.journal), client = new AgentExecutionClient(adapter, f.access, () => Date.parse('2026-01-01T00:00:00Z'));
  await client.submit(f.task); assert.equal(adapter.journal.starts, 1);
  const changed = { ...f.task, instruction: 'Different instruction' };
  // Host approves the changed digest here so the adapter's duplicate boundary is tested.
  f.setGrant({ ...f.grant(), task: await executionTaskRef(changed) });
  await assert.rejects(client.submit(changed), rejectsCode('EXECUTION_CONFLICT', 'unknown'));
  assert.equal(adapter.journal.starts, 1);
});

test('lost submission response is unknown; status lookup recovers without a second submission', async () => {
  const f = await fixture(), submit = f.adapter.submit.bind(f.adapter);
  f.adapter.submit = async (...args) => { await submit(...args); throw new Error('private provider response'); };
  await assert.rejects(f.client.submit(f.task), rejectsCode('EXECUTION_UNAVAILABLE', 'unknown'));
  assert.equal((await f.client.status(f.ref)).state, 'queued');
  assert.equal(f.adapter.journal.starts, 1); assert.deepEqual(f.adapter.calls, ['submit', 'status']);
});

test('missing configuration, consent, expired session, wrong model and wrong binding refuse before adapter calls', async () => {
  const f = await fixture();
  await assert.rejects(new AgentExecutionClient().submit(f.task), rejectsCode('EXECUTION_UNCONFIGURED', 'not_dispatched'));
  f.setGrant(undefined); await assert.rejects(f.client.submit(f.task), rejectsCode('EXECUTION_AUTH', 'not_dispatched'));
  const fresh = await fixture(); fresh.tick(60000);
  await assert.rejects(fresh.client.submit(fresh.task), rejectsCode('EXECUTION_EXPIRED', 'not_dispatched'));
  await assert.rejects(f.client.submit({ ...f.task, binding: { ...f.task.binding, model_version: 'strata/unknown' } }), rejectsCode('EXECUTION_VERSION', 'not_dispatched'));
  const mismatch = await fixture(); mismatch.setGrant({ ...mismatch.grant(), task: { ...mismatch.ref, repository_revision: 'b'.repeat(40) } });
  await assert.rejects(mismatch.client.submit(mismatch.task), rejectsCode('EXECUTION_BINDING', 'not_dispatched'));
  assert.equal(f.adapter.calls.length + fresh.adapter.calls.length + mismatch.adapter.calls.length, 0);
});

test('revocation and each authority-generation change during dispatch reject late success', async () => {
  for (const field of [undefined, 'approval_generation', 'selection_generation', 'session_generation', 'credential_generation'] as const) {
    const f = await fixture(), submit = f.adapter.submit.bind(f.adapter);
    f.adapter.submit = async (...args) => {
      const result = await submit(...args);
      f.setGrant(field ? { ...f.grant(), [field]: 2 } : undefined);
      return result;
    };
    await assert.rejects(f.client.submit(f.task), rejectsCode(field ? 'EXECUTION_STALE' : 'EXECUTION_AUTH', 'unknown'));
    assert.equal(f.adapter.journal.starts, 1); // Refusal does not claim rollback.
  }
});

test('pre-abort dispatches nothing; abort after dispatch never reports remote cancellation', async () => {
  const f = await fixture(), pre = new AbortController(); pre.abort();
  await assert.rejects(f.client.submit(f.task, pre.signal), rejectsCode('EXECUTION_ABORTED', 'not_dispatched'));
  assert.equal(f.adapter.calls.length, 0);
  const cancel = new AbortController();
  f.adapter.submit = async () => { cancel.abort(); return new Promise(() => {}); };
  await assert.rejects(f.client.submit(f.task, cancel.signal), rejectsCode('EXECUTION_ABORTED', 'unknown'));
});

test('uncooperative metadata and adapter calls respect the total deadline', async () => {
  const f = await fixture(), declaration = f.adapter.describe(); declaration.limits.call_timeout_ms = 20;
  f.adapter.describe = () => declaration; f.setGrant({ ...f.grant(), declaration_sha256: await executionDigest(declaration) });
  // Keep Node alive while AbortSignal.timeout uses an unref timer.
  const heartbeat = setInterval(() => {}, 100);
  try {
    const hungAccess: AgentExecutionAccess = { current: async () => new Promise(() => {}) };
    await assert.rejects(new AgentExecutionClient(f.adapter, hungAccess).submit(f.task), rejectsCode('EXECUTION_TIMEOUT', 'not_dispatched'));
    f.adapter.submit = async () => new Promise(() => {});
    await assert.rejects(new AgentExecutionClient(f.adapter, f.access, () => Date.parse('2026-01-01T00:00:00Z')).submit(f.task), rejectsCode('EXECUTION_TIMEOUT', 'unknown'));
  } finally { clearInterval(heartbeat); }
});

test('cancellation is cooperative, terminal states are immutable, and a completion race may succeed', async () => {
  const f = await fixture(), queued = await f.client.submit(f.task);
  const requested = await f.client.cancel(f.ref, queued); assert.equal(requested.state, 'cancel_requested');
  await f.adapter.advance(f.ref, 'cancelled'); const cancelled = await f.client.status(f.ref, requested);
  assert.equal((await f.client.cancel(f.ref, cancelled)).state, 'cancelled');
  await assert.rejects(f.client.result(f.task, cancelled), rejectsCode('EXECUTION_RESULT_UNAVAILABLE', 'not_dispatched'));
  const race = await fixture(), q = await race.client.submit(race.task);
  await race.adapter.advance(race.ref, 'succeeded'); assert.equal((await race.client.cancel(race.ref, q)).state, 'succeeded');
  const unsupported = await fixture(), declaration = unsupported.adapter.describe(); declaration.capabilities.cancel = 'unsupported';
  unsupported.adapter.describe = () => declaration;
  await assert.rejects(new AgentExecutionClient(unsupported.adapter, unsupported.access).cancel(unsupported.ref), rejectsCode('EXECUTION_UNSUPPORTED', 'not_dispatched'));
  assert.equal(unsupported.adapter.calls.length, 0);
});

test('strict declarations cannot promote model APIs or discovery advertisements into execution', () => {
  const adapter = new SyntheticExecutionAdapter(), declaration = adapter.describe();
  for (const bad of [
    { ...declaration, protocol: 'strata-agent-discovery/1' },
    { ...declaration, runtime: { ...declaration.runtime, kind: 'model-api' } },
    { ...declaration, capabilities: { ...declaration.capabilities, submit: false } },
    { ...declaration, authority: 'engine' }, { ...declaration, protocol: 'strata-agent-execution/2' },
  ]) assert.equal(executionDeclarationSchema.safeParse(bad).success, false);
});

test('unknown fields, arbitrary transport options, mutable revisions and exceeded request limits refuse', async () => {
  const f = await fixture();
  for (const bad of [{ ...f.task, token: 'private' }, { ...f.task, url: 'https://unapproved.example.test' },
    { ...f.task, repository_revision: 'main' }, { ...f.task, format: 'strata-agent-task/2' }]) {
    await assert.rejects(f.client.submit(bad as typeof f.task), rejectsCode('EXECUTION_INVALID', 'not_dispatched'));
  }
  await assert.rejects(f.client.submit({ ...f.task, limits: { ...f.task.limits, runtime_ms: 60001 } }), rejectsCode('EXECUTION_LIMIT', 'not_dispatched'));
  await assert.rejects(f.client.submit({ ...f.task, instruction: '🌐'.repeat(8192) }), rejectsCode('EXECUTION_LIMIT', 'not_dispatched'));
  assert.equal(f.adapter.calls.length, 0);
});

test('foreign tasks, stale/reversed snapshots and inconsistent sequence are refused', async () => {
  const f = await fixture(), queued = await f.client.submit(f.task);
  await f.adapter.advance(f.ref, 'running'); const running = await f.client.status(f.ref, queued);
  assert.throws(() => assertExecutionTransition(running, queued), rejectsCode('EXECUTION_PROTOCOL'));
  assert.throws(() => assertExecutionTransition(queued, { ...running, sequence: 0 }), rejectsCode('EXECUTION_PROTOCOL'));
  await f.adapter.advance(f.ref, 'failed'); const failed = await f.client.status(f.ref, running);
  assert.throws(() => assertExecutionTransition(failed, { ...running, sequence: 99 }), rejectsCode('EXECUTION_PROTOCOL'));
  f.adapter.status = async () => ({ ...running, task: { ...f.ref, task_id: '00000000-0000-4000-8000-000000000002' } });
  await assert.rejects(f.client.status(f.ref, running), rejectsCode('EXECUTION_BINDING', 'unknown'));
  const unknown = await fixture(); await assert.rejects(unknown.client.status(unknown.ref), rejectsCode('EXECUTION_NOT_FOUND', 'unknown'));
});

test('result substitution, forged evidence, extra provider errors and oversized output fail closed', async () => {
  const f = await fixture(); await f.client.submit(f.task); await f.adapter.advance(f.ref, 'succeeded');
  const done = await f.client.status(f.ref), original = await f.client.result(f.task, done);
  f.adapter.result = async () => ({ ...original, summary: 'substituted' });
  await assert.rejects(f.client.result(f.task, done), rejectsCode('EXECUTION_BINDING', 'unknown'));
  f.adapter.result = async () => ({ ...original, trust: 'host-measured' } as unknown as typeof original);
  await assert.rejects(f.client.result(f.task, done), rejectsCode('EXECUTION_PROTOCOL', 'unknown'));
  f.adapter.result = async () => ({ ...original, summary: '🌐'.repeat(8192) });
  await assert.rejects(f.client.result(f.task, done), rejectsCode('EXECUTION_LIMIT', 'unknown'));
  f.adapter.status = async () => ({ ...done, raw_error: 'private provider error' } as unknown as ExecutionSnapshot);
  await assert.rejects(f.client.status(f.ref), rejectsCode('EXECUTION_PROTOCOL', 'unknown'));
});

test('mutating supplied task/context cannot change the retained admission proof', async () => {
  const f = await fixture(), submit = f.adapter.submit.bind(f.adapter);
  f.adapter.submit = async (task, context) => { context.grant.credential_generation++; return submit(task, context); };
  assert.equal((await f.client.submit(f.task)).state, 'queued'); assert.equal(f.grant().credential_generation, 1);
});

test('declaration exceptions and missing completion snapshots produce only safe contract errors', async () => {
  const f = await fixture();
  f.adapter.describe = () => { throw new Error('private configuration'); };
  assert.throws(() => new AgentExecutionClient(f.adapter, f.access), rejectsCode('EXECUTION_INVALID', 'not_dispatched'));
  await assert.rejects(f.client.result(f.task, undefined as unknown as ExecutionSnapshot), rejectsCode('EXECUTION_INVALID', 'not_dispatched'));
  assert.equal(f.adapter.calls.length, 0);
});
