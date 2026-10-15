import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/model.js';
import { DEMO_MANAGEMENT_LIMITS, DemoManagementAdmissionPort, FileDemoManagementJournal, mockDemoManagementPlan,
  type DemoManagementRequest, type DemoManagementTarget, type MockDemoManagementProvider } from '../src/integrated-demo-management.js';
import type { DemoEvent } from '../src/integrated-demo.js';
import { cleanupReviewedDemoSession } from '../src/integrated-demo-live.js';

const start = Date.parse('2026-10-05T00:00:00Z');
const target: DemoManagementTarget = { account_id: '1'.repeat(32), project_id: 'strata-local-prototype', run_id: 'a1b2c3d4e5f60718',
  worker_name: 'strata-integrated-test', workflow_name: 'strata-integrated-flow', instance_id: 'run-a1b2c3d4e5f60718',
  namespace_id: 'strata-test-namespace', repository_name: 'strata-run-a1b2c3d4e5f60718' };
function event(sequence: number): DemoEvent {
  const input = {};
  return { format: 'strata-integrated-demo-event/1', run_id: target.run_id, project_id: target.project_id, sequence,
    request_id: 'boot-' + sequence, previous_digest: 'a'.repeat(64), phase: 'new', kind: 'bootstrap', source: 'host', input, input_digest: digest(input) };
}
function provider(call: (request: DemoManagementRequest) => unknown | Promise<unknown>) {
  const calls: DemoManagementRequest[] = [];
  const mock: MockDemoManagementProvider = { mode: 'mock-only', async call(request) { calls.push(structuredClone(request)); return call(request); } };
  return { mock, calls };
}
function normalMock(responses: Partial<Record<DemoManagementRequest['action'], unknown>> = {}) {
  const observed = provider(request => responses[request.action] ?? ({ accepted: true, found: true, status: 'complete', unsettled_dispatches: 0,
    used_steps: 76, artifact_dispatches: 1022, repo_tokens_issued: 2, repo_tokens_revoked: 2, handles_open: 0,
    repositories: [], namespace_id: target.namespace_id }));
  return observed;
}
async function withJournal<T>(run: (filePath: string, now: () => number) => Promise<T>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strata-demo-admission-'));
  try { return await run(path.join(dir, 'ledger.json'), () => start + 1000); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('management port reserves exact-target event calls before dispatch and retains budgets across host reconstruction', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start), observed = normalMock();
  const first = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 1000);
  const sent = await first.sendEvent(event(1));
  assert.equal((sent as any).accepted, true); assert.equal(observed.calls[0].action, 'send-event');
  assert.equal(observed.calls[0].event_type, 'strata-demo-1'); assert.equal(observed.calls[0].target.instance_id, target.instance_id);

  const restarted = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 2000);
  await assert.rejects(restarted.sendEvent(event(1)), (error: any) => error.code === 'DEMO_MANAGEMENT_SEQUENCE');
  await restarted.sendEvent(event(2));
  const state = await restarted.snapshot();
  assert.equal(state.counters.calls, 2); assert.equal(state.counters.event_sends, 2); assert.equal(state.next_event_sequence, 3);
  assert.equal(restarted.live_authorized, false); assert.equal(observed.calls.length, 2);
}));

test('admission snapshots the exact workflow target and keeps plan ceilings immutable', async () => withJournal(async file => {
  const plan = { ...mockDemoManagementPlan(target, start), target: { ...target }, limits: { ...DEMO_MANAGEMENT_LIMITS } };
  const observed = normalMock(), port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 1000);
  plan.target.workflow_name = 'retargeted-workflow'; plan.target.instance_id = 'run-deadbeefdeadbeef'; Object.assign(plan.limits, { event_sends: 1 });
  await port.sendEvent(event(1));
  assert.equal(observed.calls[0].target.workflow_name, target.workflow_name);
  assert.equal(observed.calls[0].target.instance_id, target.instance_id);
  assert.equal(port.plan.limits.event_sends, DEMO_MANAGEMENT_LIMITS.event_sends);
  assert.throws(() => Object.assign(port.plan.target, { workflow_name: 'other-workflow' }), TypeError);
}));

test('admission rejects malformed or cross-run event envelopes before management dispatch', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start), observed = normalMock();
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 1000);
  await assert.rejects(port.sendEvent({ ...event(1), run_id: 'f'.repeat(16) }), (error: any) => error.code === 'DEMO_MANAGEMENT_EVENT_REFUSED');
  await assert.rejects(port.sendEvent(null as any), (error: any) => error.code === 'DEMO_MANAGEMENT_EVENT_REFUSED');
  await assert.rejects(port.sendEvent({ ...event(1), format: 'other' } as any), (error: any) => error.code === 'DEMO_MANAGEMENT_EVENT_REFUSED');
  await assert.rejects(port.sendEvent({ ...event(1), extra: true } as any), (error: any) => error.code === 'DEMO_MANAGEMENT_EVENT_REFUSED');
  assert.equal(observed.calls.length, 0);
}));

test('management port enforces 30-minute window, 2-minute no-send reserve, and 60-event maximum', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start), observed = normalMock(), now = { value: start + 1000 };
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => now.value);
  for (let sequence = 1; sequence <= DEMO_MANAGEMENT_LIMITS.event_sends; sequence++) await port.sendEvent(event(sequence));
  await assert.rejects(port.sendEvent(event(61)), (error: any) => error.code === 'DEMO_MANAGEMENT_EVENT_LIMIT');
  assert.equal(observed.calls.length, 60);

  const lateFile = file + '.late', late = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(lateFile), observed.mock,
    () => plan.expires_at - DEMO_MANAGEMENT_LIMITS.cleanup_ms + 1);
  await assert.rejects(late.sendEvent(event(1)), (error: any) => error.code === 'DEMO_MANAGEMENT_CLEANUP_WINDOW');
  assert.equal(observed.calls.length, 60);
  now.value = plan.expires_at;
  await assert.rejects(port.describeInstance(), (error: any) => error.code === 'DEMO_MANAGEMENT_DEADLINE');
}));

test('management status reads stop at their independent fixed ceiling', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start), observed = normalMock();
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 1000);
  for (let read = 0; read < DEMO_MANAGEMENT_LIMITS.status_reads; read++) await port.describeInstance();
  await assert.rejects(port.describeInstance(), (error: any) => error.code === 'DEMO_MANAGEMENT_READ_LIMIT');
  const state = await port.snapshot();
  assert.equal(state.counters.status_reads, DEMO_MANAGEMENT_LIMITS.status_reads);
  assert.equal(state.counters.calls, DEMO_MANAGEMENT_LIMITS.status_reads);
}));

test('cleanup is ordered, bounded, and verifies absence while retaining an empty namespace', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start), calls = new Map<DemoManagementRequest['action'], number>();
  const observed = provider(request => {
    calls.set(request.action, (calls.get(request.action) ?? 0) + 1);
    if (request.action === 'describe-instance') return calls.get(request.action) === 1
      ? { found: true, status: 'complete', unsettled_dispatches: 0, repo_tokens_issued: 2, repo_tokens_revoked: 2, handles_open: 0, used_steps: 76, artifact_dispatches: 1022 }
      : { found: false };
    if (request.action.startsWith('describe-')) return { found: false };
    if (request.action === 'list-namespace') return { namespace_id: target.namespace_id, repositories: [] };
    return { accepted: true };
  });
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 1000);
  await port.describeInstance(); await port.beginCleanup();
  await assert.rejects(port.cleanup('delete-repository'), (error: any) => error.code === 'DEMO_MANAGEMENT_CLEANUP_ORDER');
  await port.cleanup('delete-instance'); await port.cleanup('describe-instance');
  await port.cleanup('delete-workflow'); await port.cleanup('describe-workflow');
  await port.cleanup('delete-worker'); await port.cleanup('describe-worker');
  await port.cleanup('delete-repository'); await port.cleanup('describe-repository');
  await port.cleanup('list-namespace');
  const state = await port.snapshot();
  assert.equal(state.cleanup.namespace_empty_verified, true); assert.equal(state.cleanup.worker_absent, true);
  assert.equal(state.counters.cleanup_calls, 8); assert.equal(state.counters.status_reads, 6);
  assert.equal(observed.calls.some(request => (request.action as string).includes('delete-namespace')), false);
  await assert.rejects(port.cleanup('delete-worker' as any), (error: any) => error.code === 'DEMO_MANAGEMENT_CLEANUP_ORDER');
}));

test('cleanup refuses instance deletion when the exact Workflow output omits resource cleanup counts', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start);
  const observed = provider(() => ({ found: true, status: 'complete', used_steps: 76, artifact_dispatches: 1022 }));
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 1000);
  await port.describeInstance(); await port.beginCleanup();
  await assert.rejects(port.cleanup('delete-instance'), (error: any) => error.code === 'DEMO_MANAGEMENT_CLEANUP_ORDER');
  const state = await port.snapshot();
  assert.equal(state.cleanup.terminal_instance_verified, true);
  assert.equal(state.cleanup.local_dispatches_settled, false);
  assert.equal(state.cleanup.repo_tokens_clean, false);
  assert.equal(state.cleanup.handles_disposed, false);
  assert.equal(observed.calls.length, 1);
}));

test('cleanup observes delayed absence without repeating any delete and stops if absence never settles', async () => {
  for (const neverSettles of [false, true]) await withJournal(async file => {
    const plan = mockDemoManagementPlan(target, Date.now());
    const deleted = new Set<string>(), observations = new Map<string, number>();
    const observed = provider(request => {
      const action = request.action;
      if (action.startsWith('delete-')) { deleted.add(action.slice(7)); return { accepted: true }; }
      if (action === 'list-namespace') return { namespace_id: target.namespace_id, repositories: [] };
      const resource = action.slice(9);
      if (deleted.has(resource)) {
        const count = (observations.get(resource) ?? 0) + 1; observations.set(resource, count);
        if (!neverSettles && count > 1) return { found: false };
      }
      return { found: true, status: 'complete', used_steps: 20, artifact_dispatches: 100, unsettled_dispatches: 0,
        repo_tokens_issued: 2, repo_tokens_revoked: 2, handles_open: 0 };
    });
    const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock);
    await port.describeInstance();
    if (neverSettles) await assert.rejects(cleanupReviewedDemoSession(port, async () => undefined), (error: any) => error.code === 'DEMO_OPERATOR_CLEANUP_PENDING');
    else assert.equal((await cleanupReviewedDemoSession(port, async () => undefined)).cleanup.namespace_empty_verified, true);
    for (const name of deleted) assert.equal(observed.calls.filter(call => call.action === 'delete-' + name).length, 1);
    if (neverSettles) assert.deepEqual([...deleted], ['instance']);
    assert.ok((await port.snapshot()).counters.calls < 180);
  });
});

test('uncertain provider outcome is charged once and stops all automatic retries', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start), observed = provider(() => { throw new Error('mock transport lost response'); });
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 1000);
  await assert.rejects(port.sendEvent(event(1)), /lost response/);
  const restarted = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), observed.mock, () => start + 2000);
  await assert.rejects(restarted.sendEvent(event(1)), (error: any) => error.code === 'DEMO_MANAGEMENT_RECONCILIATION_REQUIRED');
  const state = await restarted.snapshot();
  assert.equal(state.counters.event_sends, 1); assert.equal(state.reconciliation_required, true); assert.equal(observed.calls.length, 1);
}));

test('request and response transfer limits are enforced and oversized responses require reconciliation', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start), journal = new FileDemoManagementJournal(file);
  await assert.rejects(journal.reserve(plan, 'describe-instance', digest({}), DEMO_MANAGEMENT_LIMITS.max_request_bytes_per_call + 1,
    start + 1000), (error: any) => error.code === 'DEMO_MANAGEMENT_REQUEST_BYTES_LIMIT');
  const observed = provider(() => ({ payload: 'x'.repeat(DEMO_MANAGEMENT_LIMITS.max_response_bytes_per_call + 1) }));
  const port = new DemoManagementAdmissionPort(plan, journal, observed.mock, () => start + 1000);
  await assert.rejects(port.describeInstance(), (error: any) => error.code === 'DEMO_MANAGEMENT_RESPONSE_BYTES_LIMIT');
  const state = await port.snapshot();
  assert.equal(state.counters.calls, 1); assert.ok(state.counters.response_bytes > DEMO_MANAGEMENT_LIMITS.max_response_bytes_per_call);
  assert.equal(state.reconciliation_required, true); assert.equal(observed.calls.length, 1);
}));

test('provider without the mock-only mode is refused and admission remains unauthorized', async () => withJournal(async file => {
  const plan = mockDemoManagementPlan(target, start);
  assert.throws(() => new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), { mode: 'cloudflare' } as any),
    (error: any) => error.code === 'DEMO_MANAGEMENT_LIVE_DISABLED');
  const changedTarget = { ...target, workflow_name: 'other-workflow' };
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(file), normalMock().mock, () => start + 1000);
  const changedPlan = mockDemoManagementPlan(changedTarget, start);
  // A newly constructed plan cannot silently reuse a journal already bound to
  // another target, even though this particular path has not yet been written.
  await port.describeInstance();
  const wrong = new DemoManagementAdmissionPort(changedPlan, new FileDemoManagementJournal(file), normalMock().mock, () => start + 1000);
  await assert.rejects(wrong.describeInstance(), (error: any) => error.code === 'DEMO_MANAGEMENT_TARGET_CONFLICT');
}));
