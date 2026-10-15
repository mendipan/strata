import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DemoFullStepOutputs, parseDemoFullStepResponse, describeDemoFullStepCommand } from '../src/integrated-demo-full-step.js';
import { DemoManagementAdmissionPort, FileDemoManagementJournal, demoManagementPlan, type DemoManagementTarget } from '../src/integrated-demo-management.js';
import { authoritativeDemoWorkflowOutput } from '../src/integrated-demo-workflow-description.js';

const target: DemoManagementTarget = { account_id: '1'.repeat(32), project_id: 'strata-local-demo', run_id: '0a1b2c3d4e5f6789',
  worker_name: 'strata-demo-0a1b2c3d4e5f6789', workflow_name: 'strata-demo-flow-0a1b2c3d4e5f6789', instance_id: 'run-0a1b2c3d4e5f6789',
  namespace_id: 'strata-test-namespace', repository_name: 'strata-run-0a1b2c3d4e5f6789' };
const spec = { name: 'apply-1-1', type: 'step', attempt: 1 } as const;
const preview = '{"checkpoint":{"format":"strata-integrated-demo-checkpoint/1"[truncated output]';
const raw = () => ({ id: target.instance_id, status: 'waiting', steps: [{ name: spec.name, type: 'step', success: true, output: preview }] });

test('full-step CLI pins exact endpoint inputs and complete JSON refuses redaction, streams, errors and incomplete states', () => {
  const command = describeDemoFullStepCommand(target, spec, process.cwd());
  assert.deepEqual(command.args.slice(1), ['workflows', 'instances', 'step', 'get', target.instance_id, '--workflow-name', target.workflow_name,
    '--name', 'apply-1-1', '--type', 'step', '--attempt', '1']);
  assert.equal(command.executable, process.execPath); assert.equal(command.interactive, false);
  const large = JSON.stringify({ large: 'x'.repeat(16000) });
  assert.equal(parseDemoFullStepResponse(JSON.stringify({ status: 'complete', error: null, output: large })), large);
  for (const output of [large, { large: 'x'.repeat(16000) }]) {
    assert.deepEqual(parseDemoFullStepResponse(JSON.stringify({ success: true, errors: [], messages: [],
      result: { status: 'complete', error: null, output } })), output);
  }
  for (const response of ['not JSON', JSON.stringify({ status: 'running', error: null, output: large }),
    JSON.stringify({ status: 'complete', error: { name: 'error' }, output: large }),
    JSON.stringify({ status: 'complete', error: null, output: '[REDACTED]' }),
    JSON.stringify({ status: 'complete', error: null, output: preview }),
    JSON.stringify({ success: false, result: { status: 'complete', error: null, output: large } })]) {
    assert.throws(() => parseDemoFullStepResponse(response), (e: any) => e.code === 'DEMO_FULL_STEP_REFUSED');
  }
  const valid = { success: true, errors: [], messages: [], result: { status: 'complete', error: null, output: large } };
  for (const response of [{ ...valid, success: false }, { ...valid, errors: [{ code: 10004 }] },
    { ...valid, errors: null }, { ...valid, messages: undefined }, { ...valid, result: null },
    { ...valid, status: 'complete', error: null, output: large }, { ...valid, result: { ...valid.result, status: 'running' } },
    { ...valid, result: { ...valid.result, error: { name: 'error' } } },
    { ...valid, result: { ...valid.result, output: '[REDACTED]' } },
    { ...valid, result: { ...valid.result, output: preview } }]) {
    assert.throws(() => parseDemoFullStepResponse(JSON.stringify(response)), (e: any) => e.code === 'DEMO_FULL_STEP_REFUSED');
  }
  assert.throws(() => describeDemoFullStepCommand(target, { ...spec, name: 'apply-1-2' }, process.cwd()));
});

test('synthetic cf success envelope restores the exact running truncated checkpoint without reconstructing output', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/integrated-demo-cf-full-step.json', 'utf8'));
  const complete = parseDemoFullStepResponse(JSON.stringify(fixture.full_step)) as any;
  const cp = complete.checkpoint, run = cp.run_id;
  const liveTarget: DemoManagementTarget = { account_id: cp.registry.storage.account, project_id: cp.project_id, run_id: run,
    worker_name: 'strata-demo-' + run, workflow_name: 'strata-demo-flow-' + run, instance_id: 'run-' + run,
    namespace_id: cp.registry.storage.namespace, repository_name: cp.registry.storage.repository };
  assert.throws(() => authoritativeDemoWorkflowOutput(fixture.running), (e: any) => e.code === 'DEMO_STATUS_REFUSED');
  const cache = new DemoFullStepOutputs(); let reads = 0;
  const hydrated = await cache.hydrate(fixture.running, liveTarget, async step => {
    assert.deepEqual(step, spec); reads++; return complete;
  });
  const parsed = authoritativeDemoWorkflowOutput(hydrated);
  assert.deepEqual(parsed.checkpoint, cp); assert.equal(parsed.checkpoint.sequence, 1); assert.equal(reads, 1);
  assert.deepEqual(cp.management_cleanup, { unsettled_dispatches: 0, repo_tokens_issued: 2, repo_tokens_revoked: 2, handles_open: 0 });
  await cache.hydrate(fixture.running, liveTarget, async () => { throw new Error('Historical output must not be refetched'); });
});

test('hydration caches exact completed output while rejecting descriptor changes, duplicates and foreign instances before reads', async () => {
  const cache = new DemoFullStepOutputs(); let reads = 0;
  const output = { checkpoint: { sequence: 1, content: 'x'.repeat(12000) } };
  const read = async () => { reads++; return output; };
  assert.deepEqual((await cache.hydrate(raw(), target, read)).steps[0].output, output);
  assert.deepEqual((await cache.hydrate(raw(), target, read)).steps[0].output, output); assert.equal(reads, 1);
  for (const changed of [{ ...raw(), id: 'run-0000000000000000' }, { ...raw(), steps: [raw().steps[0], raw().steps[0]] },
    { ...raw(), steps: [{ ...raw().steps[0], name: 'apply-1-2' }] },
    { ...raw(), steps: [{ ...raw().steps[0], output: 'different' + preview }] },
    { ...raw(), steps: [{ ...raw().steps[0], attempts: [{ success: false }, { success: true }] }] }]) {
    await assert.rejects(cache.hydrate(changed, target, read));
  }
  assert.equal(reads, 1);
});

test('supplemental read is charged before dispatch and a failed read blocks all further activity without retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-full-step-admission-'));
  try {
    const now = Date.now(), plan = demoManagementPlan(target, now), journal = new FileDemoManagementJournal(path.join(directory, 'journal.json'));
    let dispatched = 0;
    const port = new DemoManagementAdmissionPort(plan, journal, { mode: 'mock-only', async call(_request, admitted) {
      return admitted!(spec, async () => {
        const state = await journal.snapshot(plan);
        assert.equal(state.counters.calls, 2); assert.equal(state.counters.status_reads, 2);
        assert.equal(state.history.at(-1)?.result, 'reserved'); dispatched++; throw new Error('provider unavailable');
      });
    } }, () => now);
    await assert.rejects(port.describeInstance(), /provider unavailable/);
    const state = await port.snapshot();
    assert.equal(state.reconciliation_required, true); assert.equal(state.in_flight, null);
    assert.deepEqual(state.history.map(h => h.result), ['uncertain', 'uncertain']);
    await assert.rejects(port.describeInstance(), (e: any) => e.code === 'DEMO_MANAGEMENT_RECONCILIATION_REQUIRED');
    assert.equal(dispatched, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a single trailing in-progress apply preserves only the verified completed prefix and never fetches partial output', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/integrated-demo-cf-full-step.json', 'utf8'));
  const complete = parseDemoFullStepResponse(JSON.stringify(fixture.full_step)) as any;
  const cp = complete.checkpoint;
  const liveTarget = { ...target, run_id: cp.run_id, instance_id: 'run-' + cp.run_id };
  const pending = { name: 'apply-2-1', type: 'step', success: null, output: null, attempts: [{ success: null, error: null }] };
  const description = { ...structuredClone(fixture.running), status: 'running', steps: [...structuredClone(fixture.running.steps), pending] };
  let reads = 0;
  const hydrate = async (raw: any) => new DemoFullStepOutputs().hydrate(raw, liveTarget, async step => {
    assert.equal(step.name, 'apply-1-1'); reads++; return complete;
  });
  const hydrated = await hydrate(description);
  assert.deepEqual(authoritativeDemoWorkflowOutput(hydrated).checkpoint, cp);
  assert.equal(reads, 1);
  const reject = async (mutate: (d: any) => void) => {
    const d = structuredClone(description); mutate(d);
    await assert.rejects(async () => authoritativeDemoWorkflowOutput(await hydrate(d)));
  };
  await reject(d => { d.status = 'complete'; });
  await reject(d => { d.steps.at(-1).success = false; });
  await reject(d => { d.steps.at(-1).end = '2026-10-07T15:38:00Z'; });
  await reject(d => { d.steps.at(-1).output = '{partial'; });
  await reject(d => { d.steps.at(-1).attempts[0].error = { message: 'failed' }; });
  await reject(d => { d.steps.at(-1).attempts.push({ success: null }); });
  await reject(d => { d.steps.at(-1).name = 'apply-3-1'; });
  await reject(d => { d.steps.push({ ...pending }); });
  await reject(d => { d.steps.push({ ...pending, name: 'apply-3-1', success: true, output: {} }); });
});

test('synthetic provider truncation is refused until hydrated from an explicitly synthetic complete terminal checkpoint fixture', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/integrated-demo-provider-truncation.json', 'utf8'));
  const liveTarget = { ...target, account_id: fixture.terminal.checkpoint.registry.storage.account,
    namespace_id: fixture.terminal.checkpoint.registry.storage.namespace };
  assert.throws(() => authoritativeDemoWorkflowOutput(fixture.running), (e: any) => e.code === 'DEMO_STATUS_REFUSED');
  const cache = new DemoFullStepOutputs(); let reads = 0;
  const complete = { checkpoint: fixture.terminal.checkpoint, outcome: fixture.terminal.checkpoint.requests['host-1'].outcome, reused: false };
  const hydrated = await cache.hydrate(fixture.running, liveTarget, async step => {
    assert.equal(step.name, 'apply-1-1'); reads++;
    return parseDemoFullStepResponse(JSON.stringify({ status: 'complete', error: null, output: JSON.stringify(complete) }));
  });
  const parsed = authoritativeDemoWorkflowOutput(hydrated);
  assert.equal(parsed.checkpoint.sequence, 1); assert.equal(parsed.checkpoint.run_id, target.run_id); assert.equal(reads, 1);
});

test('supplemental fetch cannot overrun fixed read budget or deadline and refusal occurs before its process dispatch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-full-step-budget-'));
  try {
    const now = Date.now(), plan = demoManagementPlan(target, now), file = path.join(directory, 'journal.json');
    const journal = new FileDemoManagementJournal(file); let clock = now, fetch = false, dispatched = 0;
    const port = new DemoManagementAdmissionPort(plan, journal, { mode: 'mock-only', async call(_request, admitted) {
      if (!fetch) return { found: true, status: 'waiting' };
      return admitted!(spec, async () => { dispatched++; return {}; });
    } }, () => clock);
    // Seed only the existing public journal format in this synthetic test.
    await port.describeInstance();
    const state = JSON.parse(await readFile(file, 'utf8')); state.counters.status_reads = 159;
    const { writeFile } = await import('node:fs/promises'); await writeFile(file, JSON.stringify(state));
    fetch = true;
    await assert.rejects(port.describeInstance(), (e: any) => e.code === 'DEMO_MANAGEMENT_CLEANUP_RESERVE');
    assert.equal(dispatched, 0); assert.equal((await port.snapshot()).counters.status_reads, 160);

    const expiredJournal = new FileDemoManagementJournal(path.join(directory, 'expired.json'));
    const expired = new DemoManagementAdmissionPort(plan, expiredJournal, { mode: 'mock-only', async call(_request, admitted) {
      clock = plan.expires_at;
      return admitted!(spec, async () => { dispatched++; return {}; });
    } }, () => clock);
    clock = now;
    await assert.rejects(expired.describeInstance(), (e: any) => e.code === 'DEMO_MANAGEMENT_DEADLINE');
    assert.equal(dispatched, 0); assert.equal((await expired.snapshot()).reconciliation_required, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
