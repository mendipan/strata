import { WranglerCliDemoManagementProvider } from '../src/integrated-demo-management-wrangler.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { demoFixture, preparedFixture } from './integrated-demo-fixture.js';
import { checkpointDigest, DEMO_LIMITS } from '../src/integrated-demo.js';
import { authoritativeDemoWorkflowOutput, decodeDemoStepOutput } from '../src/integrated-demo-workflow-description.js';
import { operatorPromptPacket } from '../src/integrated-demo-operator-reply.js';
import { parseWorkflowSnapshot } from '../src/integrated-demo-visualization.js';
import { startReviewedDemoSession, waitForReviewedDemoStartup } from '../src/integrated-demo-live.js';
import { demoManagementPlan, type DemoManagementAdmissionPort } from '../src/integrated-demo-management.js';
import { runAttendedDemo } from '../src/integrated-demo-operator.js';
import { readDemoActivationSource, createDemoActivationReview, approveDemoActivationReview, createDemoActivationWorkerConfig } from '../src/integrated-demo-activation.js';

const providerFixture = JSON.parse(await readFile('tests/fixtures/demo-provider-running.json', 'utf8'));
const initial = JSON.parse(providerFixture.steps[0].output);
const target = { account_id: '1'.repeat(32), project_id: initial.project_id, run_id: initial.run_id,
  worker_name: 'strata-contract-test', workflow_name: 'strata-contract-flow', instance_id: providerFixture.id,
  namespace_id: 'strata-contract-namespace', repository_name: 'strata-contract-repository' };

test('synthetic provider running fixture accepts first-occurrence suffix and one JSON layer; exact object form is identical', () => {
  assert.deepEqual(authoritativeDemoWorkflowOutput(providerFixture).checkpoint, initial);
  const exact = structuredClone(providerFixture); exact.steps[0].name = 'claim-run'; exact.steps[0].output = initial;
  assert.equal(checkpointDigest(authoritativeDemoWorkflowOutput(exact).checkpoint), checkpointDigest(initial));
  const detached = authoritativeDemoWorkflowOutput(exact).checkpoint; detached.phase = 'failed';
  assert.equal(exact.steps[0].output.phase, 'new');
  const missingCounts = structuredClone(exact); delete missingCounts.steps[0].output.management_cleanup;
  assert.throws(() => authoritativeDemoWorkflowOutput(missingCounts));
  missingCounts.steps[0].output.mode = 'local-rehearsal';
  assert.equal(authoritativeDemoWorkflowOutput(missingCounts).checkpoint.mode, 'local-rehearsal');
  for (const value of ['{', 'null', '[]', JSON.stringify(JSON.stringify(initial)), 'x'.repeat(DEMO_LIMITS.checkpoint_bytes * 2 + 1), null, []])
    assert.throws(() => decodeDemoStepOutput(value));
});

test('provider apply outputs bind sequence, instance, chain and outcome across exact and suffixed formats', async () => {
  const f = demoFixture('controlled-private'); await f.event('bootstrap', 'host', {});
  const description = { id: providerFixture.id, steps: [
    { name: 'claim-run-1', type: 'step', success: true, output: JSON.stringify(f.initialCheckpoint) },
    { name: 'receive-1-1', type: 'waitForEvent', event_type: 'strata-demo-1', finished: true },
    { name: 'reserve-1-1', type: 'step', success: true, output: '{}' },
    { name: 'apply-1-1', type: 'step', success: true, output: JSON.stringify(f.outputs[0]) }
  ] };
  const result = authoritativeDemoWorkflowOutput(description);
  assert.deepEqual(result.checkpoint, f.checkpoint); assert.deepEqual(result.apply.output.outcome, f.outputs[0].outcome);
  const mutate = (change: (d: any) => void) => { const d = structuredClone(description); change(d); assert.throws(() => authoritativeDemoWorkflowOutput(d)); };
  for (const name of ['apply-1-2', 'apply-01-1', 'apply-1-1-extra', 'claim-run-2', 'apply-61-1']) mutate(d => { d.steps[3].name = name; });
  mutate(d => { d.id = 'run-' + 'f'.repeat(16); });
  mutate(d => { d.steps.push({ ...d.steps[3], name: 'apply-1' }); });
  mutate(d => { d.steps.reverse(); });
  mutate(d => { d.steps[3].success = false; });
  mutate(d => { d.steps[3].type = 'waitForEvent'; });
  mutate(d => { d.steps[3].output = '{'; });
  for (const change of [(cp: any) => { cp.sequence = 2; }, (cp: any) => { cp.previous_digest = '0'.repeat(64); },
    (cp: any) => { cp.run_id = 'f'.repeat(16); }, (cp: any) => { cp.mode = 'local-rehearsal'; },
    (cp: any) => { cp.started_at++; cp.expires_at++; }, (cp: any) => { cp.phase = 'invented'; }])
    mutate(d => { const output = JSON.parse(d.steps[3].output); change(output.checkpoint); d.steps[3].output = JSON.stringify(output); });
  // A changed earlier checkpoint invalidates the successor's pinned digest.
  mutate(d => { const cp = JSON.parse(d.steps[0].output); cp.counters.artifact_reserved++; d.steps[0].output = JSON.stringify(cp); });
});

test('suffixed JSON apply steps preserve exact operator packet and viewer gates; tampered packet fails closed', async () => {
  const { fixture: f } = await preparedFixture('controlled-private');
  const description = { id: providerFixture.id, status: 'running', steps: [
    { name: 'claim-run-1', type: 'step', success: true, output: JSON.stringify(f.initialCheckpoint) },
    ...f.outputs.map((output, i) => ({ name: 'apply-' + (i + 1) + '-1', type: 'step', success: true, output: JSON.stringify(output) }))
  ] };
  assert.equal(operatorPromptPacket(description).packet_digest, f.checkpoint.pending!.digest);
  assert.equal(parseWorkflowSnapshot(description).pending_packet!.digest, f.checkpoint.pending!.digest);
  const last = description.steps.at(-1)!, output = JSON.parse(last.output);
  output.outcome.data.packet_digest = '0'.repeat(64); last.output = JSON.stringify(output);
  assert.throws(() => operatorPromptPacket(description)); assert.throws(() => parseWorkflowSnapshot(description));
});

function startupPort(responses: any[], counters = { calls: 1, status_reads: 0 }, start = initial.started_at) {
  let now = start, reads = 0;
  const waits: number[] = [];
  const port = { plan: demoManagementPlan(target, initial.started_at),
    async snapshot() { return { counters }; }, async describeInstance() { reads++; return responses[Math.min(reads - 1, responses.length - 1)]; }
  } as unknown as DemoManagementAdmissionPort;
  return { port, now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; }, waits, reads: () => reads, advance: (ms: number) => { now += ms; } };
}

test('startup polling tolerates queued and running without checkpoint, then verifies exact readiness with spaced reads', async () => {
  const s = startupPort([{ found: true, status: 'queued' }, { found: true, status: 'running' },
    { found: true, status: 'running', checkpoint: initial }]);
  assert.deepEqual((await waitForReviewedDemoStartup(s.port, s.now, s.sleep)).checkpoint, initial);
  assert.deepEqual(s.waits, [5000, 5000]); assert.equal(s.reads(), 3);
  for (const field of ['run_id', 'project_id', 'mode', 'started_at', 'expires_at']) {
    const bad = { ...initial, [field]: typeof initial[field] === 'number' ? initial[field] + 1 : 'wrong' };
    const refused = startupPort([{ found: true, status: 'running', checkpoint: bad }]);
    await assert.rejects(waitForReviewedDemoStartup(refused.port, refused.now, refused.sleep), (e: any) => e.code === 'DEMO_MANAGEMENT_INSTANCE_STATE_REFUSED');
  }
});

test('startup deadline, read budget, cleanup reserve and slow provider response stop observation without replay', async () => {
  const timeout = startupPort([{ found: true, status: 'queued' }]);
  await assert.rejects(waitForReviewedDemoStartup(timeout.port, timeout.now, timeout.sleep), (e: any) => e.code === 'DEMO_MANAGEMENT_INSTANCE_NOT_READY');
  assert.equal(timeout.now() - initial.started_at, 30_000); assert.equal(timeout.reads(), 6);
  const limited = startupPort([{ found: true, status: 'running' }], { calls: 169, status_reads: 149 });
  await assert.rejects(waitForReviewedDemoStartup(limited.port, limited.now, limited.sleep)); assert.equal(limited.reads(), 1);
  const boundary = startupPort([], undefined, initial.expires_at - DEMO_LIMITS.cleanup_ms - 30_000);
  await assert.rejects(waitForReviewedDemoStartup(boundary.port, boundary.now, boundary.sleep)); assert.equal(boundary.reads(), 0);
  const slow = startupPort([{ found: true, status: 'running', checkpoint: initial }]);
  const original = slow.port.describeInstance.bind(slow.port);
  slow.port.describeInstance = async () => { slow.advance(31_000); return original(); };
  await assert.rejects(waitForReviewedDemoStartup(slow.port, slow.now, slow.sleep)); assert.equal(slow.reads(), 1);
});

test('startup failure before runner preserves primary and cleanup errors and emits explicit exact-target reconciliation without deletion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strata-startup-contract-'));
  try {
    const source = await readDemoActivationSource(process.cwd()), start = Date.now(); let now = start;
    const review = createDemoActivationReview('synthetic-startup-contract', target, source);
    const grant = approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
      typed_digest: review.review_sha256, operator_label: 'SYNTHETIC mock only' }, start);
    const calls: string[] = [], records: any[] = [];
    await assert.rejects(runAttendedDemo({ root: process.cwd(), grant, config_path: path.join(dir, 'unused.json'),
      journal_path: path.join(dir, 'journal.json'), signal: new AbortController().signal, now: () => now,
      sleep: async ms => { now += ms; }, emit: async r => { records.push(r); },
      terminal: { stdin_is_tty: true, stdout_is_tty: true, write() {}, async ask() { return grant.grant_sha256; } },
      probe: (async () => ({ entrypoint: 'unused', version: '0.160.1', billing_mode: 'chatgpt-subscription', model_availability_verified: false })) as any,
      provider: { mode: 'mock-only', async call(r) {
        calls.push(r.action);
        if (r.action === 'preflight-namespace') return { namespace_id: target.namespace_id, repositories: [] };
        if (r.action === 'preflight-full-step') return { accepted: true, account_id: target.account_id };
        if (r.action.startsWith('preflight-')) return { found: false };
        if (r.action === 'create-instance') return { accepted: true, workflow_name: target.workflow_name, instance_id: target.instance_id };
        if (r.action === 'describe-instance') return { found: true, status: 'running' };
        if (r.action === 'deploy-private') return { accepted: true };
        throw new Error('Unexpected mutation');
      } } }), (e: any) => e.code === 'DEMO_MANAGEMENT_INSTANCE_NOT_READY' && e.cleanup_error?.code === 'DEMO_OPERATOR_CLEANUP_PENDING');
    assert.equal(calls.filter(c => c === 'create-instance').length, 1);
    assert.ok(!calls.some(c => c === 'send-event' || c.startsWith('delete')));
    const reconciliation = records.find(r => r.type === 'startup-reconciliation-required');
    assert.deepEqual(reconciliation.target, target); assert.match(reconciliation.instruction, /explicitly terminate/);
    assert.equal(records.find(r => r.type === 'cleanup-blocked').original_failure_code, 'DEMO_MANAGEMENT_INSTANCE_NOT_READY');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('actual Wrangler adapter and admitted event dispatch consume suffixed JSON outputs and retain instance identity checks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strata-wrangler-contract-'));
  try {
    const start = Date.now(), source = await readDemoActivationSource(process.cwd());
    const review = createDemoActivationReview('synthetic-wrangler-contract', target, source);
    const grant = approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
      typed_digest: review.review_sha256, operator_label: 'SYNTHETIC mock only' }, start);
    const config = path.join(dir, 'mock-config.json');
    await writeFile(config, JSON.stringify(createDemoActivationWorkerConfig(grant, process.cwd())));
    const f = demoFixture('controlled-private', start), calls: string[] = [];
    let wrongId = false, pendingClaim = true, pendingApply = false;
    const provider = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: config,
      activation_grant: grant, run_process: async invocation => {
        const args = invocation.args;
        if (args.includes('trigger')) { calls.push('create'); return { code: 0, stdout: JSON.stringify({ id: target.instance_id }), stderr: '' }; }
        if (args.includes('send-event')) {
          calls.push('event'); await f.sendEvent(JSON.parse(args[args.indexOf('--payload') + 1]!)); pendingApply = true;
          return { code: 0, stdout: '{}', stderr: '' };
        }
        assert.ok(args.includes('describe')); calls.push('read');
        if (pendingClaim) { pendingClaim = false; return { code: 0, stderr: '', stdout: JSON.stringify({ id: target.instance_id, status: 'running', steps: [
          { name: 'claim-run-1', type: 'step', success: null, output: null, attempts: [{ success: null, error: null }] }
        ] }) }; }
        const pending = pendingApply; pendingApply = false;
        return { code: 0, stderr: '', stdout: JSON.stringify({ id: wrongId ? 'run-' + 'f'.repeat(16) : target.instance_id, status: 'running', steps: [
          { name: 'claim-run-1', type: 'step', success: true, output: JSON.stringify(f.initialCheckpoint) },
          ...f.outputs.map((output, i) => pending && i === f.outputs.length - 1
            ? { name: 'apply-' + (i + 1) + '-1', type: 'step', success: null, output: null, attempts: [{ success: null, error: null }] }
            : { name: 'apply-' + (i + 1) + '-1', type: 'step', success: true, output: JSON.stringify(output) }),
          { name: 'receive-' + (f.checkpoint.sequence + 1) + '-1', type: 'waitForEvent', finished: false, event_type: 'strata-demo-' + (f.checkpoint.sequence + 1) }
        ] }) };
      } });
    const session = await startReviewedDemoSession({ project_directory: process.cwd(), grant, config_path: config,
      journal_path: path.join(dir, 'journal.json'), provider, now: () => start, sleep: async () => {},
      attendance: { stdin_is_tty: true, stdout_is_tty: true, typed_digest: grant.grant_sha256, operator_label: 'SYNTHETIC' } });
    const { demoEvent } = await import('../src/integrated-demo.js');
    const result = await session.dispatch(demoEvent(session.initial_checkpoint, 'bootstrap', 'host', {}, 'contract-bootstrap'));
    assert.equal((result.outcome as any).ok, true); assert.equal(result.checkpoint.sequence, 1);
    assert.deepEqual(result.outcome, f.outputs[0].outcome); assert.equal(calls.filter(c => c === 'event').length, 1);
    assert.equal(calls.filter(c => c === 'read').length, 5, 'Two startup reads, one pre-send read and two post-send observations; never resend.');
    wrongId = true;
    await assert.rejects(session.port.describeInstance(), (e: any) => e.code === 'DEMO_WRANGLER_INSTANCE_REFUSED');
    assert.equal((await session.port.snapshot()).reconciliation_required, true);
    assert.equal(calls.filter(c => c === 'create').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
