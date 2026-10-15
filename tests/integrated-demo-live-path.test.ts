import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { demoFixture, DEMO_NOW } from './integrated-demo-fixture.js';
import { approveDemoActivationReview, createDemoActivationReview, readDemoActivationSource } from '../src/integrated-demo-activation.js';
import { CodexSubscriptionActorRunner, type DemoActorProcessInvocation } from '../src/integrated-demo-actor-cli.js';
import { checkpointDigest, rehearsalLayer, type DemoActor, type DemoCheckpoint, type DemoEvent } from '../src/integrated-demo.js';
import { DemoHost } from '../src/integrated-demo-host.js';
import { digest } from '../src/model.js';
import { cleanupReviewedDemoSession, startReviewedDemoSession } from '../src/integrated-demo-live.js';
import { type DemoManagementRequest, type DemoManagementTarget, type MockDemoManagementProvider } from '../src/integrated-demo-management.js';
import { operatorPromptPacketFromCheckpoint } from '../src/integrated-demo-operator-reply.js';
import { LOCAL_PROJECT } from '../src/security.js';

const target: DemoManagementTarget = { account_id: '1'.repeat(32), project_id: LOCAL_PROJECT, run_id: '0a1b2c3d4e5f6789',
  worker_name: 'strata-integrated-test', workflow_name: 'strata-integrated-flow', instance_id: 'run-0a1b2c3d4e5f6789',
  namespace_id: 'strata-test-namespace', repository_name: 'strata-run-0a1b2c3d4e5f6789' };

async function grant(root: string) {
  const source = await readDemoActivationSource(root), review = createDemoActivationReview('live-path-mock', target, source);
  return approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
    typed_digest: review.review_sha256, operator_label: 'mock E2E fixture' }, DEMO_NOW);
}

function mockWorkflowProvider(fixture: ReturnType<typeof demoFixture>) {
  const calls: DemoManagementRequest[] = [], state = { created: false, instance_deleted: false, workflow_exists: true,
    worker_exists: true, repository_exists: true };
  let lastOutcome: unknown;
  const mock: MockDemoManagementProvider = { mode: 'mock-only', async call(request) {
    calls.push(structuredClone(request));
    switch (request.action) {
      case 'create-instance':
        assert.equal(state.created, false); state.created = true;
        return { accepted: true, workflow_name: request.target.workflow_name, instance_id: request.target.instance_id };
      case 'describe-instance': {
        if (state.instance_deleted) return { found: false };
        const cp = fixture.checkpoint;
        const status = ['aborted', 'complete', 'failed'].includes(cp.phase) ? 'complete' : 'waiting';
        const cleanup = fixture.storage().managementCleanupCounts();
        return { found: true, status, checkpoint: structuredClone(cp), ...(lastOutcome === undefined ? {} : { outcome: lastOutcome }), used_steps: 1 + cp.sequence * 3,
          artifact_dispatches: cp.counters.artifact_reserved, unsettled_dispatches: 0,
          repo_tokens_issued: cleanup.repo_tokens_issued, repo_tokens_revoked: cleanup.repo_tokens_revoked,
          handles_open: cleanup.handles_open };
      }
      case 'send-event': {
        assert.equal(state.created, true); const result = await fixture.sendEvent(request.event!); lastOutcome = result.outcome;
        return { accepted: true, event_type: request.event_type, instance_id: target.instance_id };
      }
      case 'delete-instance': state.instance_deleted = true; return { accepted: true, deleted_instance_id: target.instance_id };
      case 'describe-workflow': return { found: state.workflow_exists, workflow_name: target.workflow_name, page_complete: true };
      case 'delete-workflow': state.workflow_exists = false; return { accepted: true, workflow_name: target.workflow_name };
      case 'describe-worker': return { found: state.worker_exists, worker_name: target.worker_name, verification: 'mock exact target' };
      case 'delete-worker': state.worker_exists = false; return { accepted: true, worker_name: target.worker_name };
      case 'describe-repository': return { found: state.repository_exists, repository_name: target.repository_name, namespace_id: target.namespace_id };
      case 'delete-repository': state.repository_exists = false; return { accepted: true, repository_name: target.repository_name };
      case 'list-namespace': return { namespace_id: target.namespace_id, repositories: [] };
    }
  } };
  return { mock, calls, state };
}

async function nextRpc(child: ReturnType<typeof spawn>, id: number, method: string, params?: unknown) {
  const request = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  const stdin = child.stdin!, stdout = child.stdout!;
  return new Promise<any>((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('Mock MCP server response timed out.')); }, 5000);
    const onData = (chunk: Buffer) => {
      pending += Buffer.from(chunk).toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) return;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any; try { message = JSON.parse(line); } catch { cleanup(); reject(new Error('Mock MCP response is invalid JSON.')); return; }
      if (message.id === id) { cleanup(); resolve(message); return; }
      }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); stdout.off('data', onData); child.off('error', onError); };
    stdout.on('data', onData); child.once('error', onError);
    stdin.write(JSON.stringify(request) + '\n');
  });
}

async function runToolServer(invocation: DemoActorProcessInvocation, actor: DemoActor, failAfterTools = false, repaired = false) {
  const entrypoint = path.join(process.cwd(), 'dist', 'src', 'integrated-demo-actor-mcp.js');
  const child = spawn(process.execPath, [entrypoint], { cwd: invocation.cwd, env: invocation.env, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += Buffer.from(chunk).toString('utf8'); });
  try {
    const initialized = await nextRpc(child, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-codex-process', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'strata-demo-local-actor');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await nextRpc(child, 2, 'tools/list');
    assert.deepEqual(tools.result.tools.map((tool: any) => tool.name), ['strata_operation']);
    const record = rehearsalLayer(actor, repaired);
    const calls = actor === 'b' ? [
      { command: 'status', input: {} },
      { command: repaired ? 'layer.revise' : 'layer.create', input: { record, ...(repaired ? { previous: 'L-reminder@1' } : {}) } },
      { command: 'layer.publish', input: { ref: record.id + '@' + record.revision } }
    ] : [
      { command: 'status', input: {} },
      { command: 'layer.create', input: { record } },
      { command: 'layer.publish', input: { ref: record.id + '@' + record.revision } }
    ];
    for (let index = 0; index < calls.length; index++) {
      const response = await nextRpc(child, 10 + index, 'tools/call', { name: 'strata_operation', arguments: calls[index] });
      assert.equal(response.result.isError, undefined, response.result.content?.[0]?.text);
      assert.equal(response.result.structuredContent.ok, true);
    }
    await nextRpc(child, 20, 'shutdown');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'exit' }) + '\n'); child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Mock MCP process did not exit.')); }, 5000);
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Mock MCP process exited ' + code + ': ' + stderr)); });
    });
    return { code: failAfterTools ? 1 : 0, stdout: '{"type":"turn.started"}\n{"type":"turn.completed"}\n',
      stderr, turn_starts: 1 };
  } catch (error) { child.kill(); throw error; }
}

test('MCP publishes the Layer contract and diagnoses malformed records only after counted host refusal', async () => {
  const forwarded: any[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const envelope = JSON.parse(body); forwarded.push(envelope);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result: { outcome: envelope.command === 'status'
      ? { ok: true, data: { principal: 'mock-actor' } } : { ok: false, error: { code: 'INVALID_RECORD' } } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/src/integrated-demo-actor-mcp.js')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      STRATA_DEMO_ACTOR_ENDPOINT: `http://127.0.0.1:${address.port}/strata_operation`, STRATA_DEMO_ACTOR_CAPABILITY: 'mock-only' }
  });
  try {
    const listing = await nextRpc(child, 1, 'tools/list');
    const schema = z.fromJSONSchema(listing.result.tools[0].inputSchema);
    for (const actor of ['a', 'b', 'c'] as const)
      assert.equal(schema.safeParse({ command: 'layer.create', input: { record: rehearsalLayer(actor) } }).success, true);
    const bad = { ...rehearsalLayer('a'), assumptions: ['The final hold duration is 900 seconds.'], acceptance: ['expiry'] };
    const request = { command: 'layer.create', input: { record: bad } };
    assert.equal(schema.safeParse(request).success, false);
    const refusal = await nextRpc(child, 2, 'tools/call', { name: 'strata_operation', arguments: request });
    assert.equal(refusal.result.isError, true);
    assert.equal(refusal.result.structuredContent.error.code, 'INVALID_RECORD');
    const issues = refusal.result.structuredContent.error.validation;
    assert.deepEqual(issues.map((issue: any) => issue.path).sort(), ['acceptance.0', 'assumptions.0']);
    assert.ok(issues.every((issue: any) => issue.message.length <= 160));
    assert.deepEqual(forwarded, [request], 'Malformed model input reaches the host unchanged for authorization and accounting.');
    const status = await nextRpc(child, 3, 'tools/call', { name: 'strata_operation', arguments: { command: 'status', input: {} } });
    assert.deepEqual(status.result.structuredContent, { ok: true, data: { principal: 'mock-actor' } });
    assert.equal(forwarded.length, 2);
  } finally {
    child.kill(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('reviewed local session runs the exact mocked Workflow, MCP actor, and digest-handoff path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-demo-live-mock-e2e-'));
  try {
    const activation = await grant(process.cwd()), fixture = demoFixture('controlled-private'), observed = mockWorkflowProvider(fixture);
    await assert.rejects(startReviewedDemoSession({ project_directory: process.cwd(), journal_path: path.join(directory, 'journal.json'),
      config_path: path.join(directory, 'generated.wrangler.json'), grant: activation, attendance: { stdin_is_tty: true, stdout_is_tty: true,
        typed_digest: '0'.repeat(64), operator_label: 'mock operator' }, provider: observed.mock, now: () => DEMO_NOW + 1000 }),
      (error: any) => error.code === 'DEMO_ACTIVATION_ATTENDANCE_REQUIRED');
    assert.equal(observed.calls.length, 0);
    const session = await startReviewedDemoSession({ project_directory: process.cwd(), journal_path: path.join(directory, 'journal.json'),
      config_path: path.join(directory, 'generated.wrangler.json'), grant: activation, attendance: { stdin_is_tty: true, stdout_is_tty: true,
        typed_digest: activation.grant_sha256, operator_label: 'mock operator' }, provider: observed.mock,
      now: () => DEMO_NOW + 1000, sleep: async () => undefined });
    assert.equal(session.initial_checkpoint.sequence, 0); assert.equal(observed.calls[0].action, 'create-instance');
    assert.equal(observed.calls[0].target.instance_id, target.instance_id);
    const host = new DemoHost(session.initial_checkpoint, session.dispatch, () => performance.now(), 'model-turn');
    host.bindThread('actor-a', 'a'); host.bindThread('actor-c', 'c'); host.bindThread('actor-b', 'b');
    const bootstrap = await host.event('bootstrap', 'host', {});
    assert.equal((bootstrap.outcome as any).ok, true); assert.equal(host.checkpoint.phase, 'authors');

    let activeProcesses = 0, maximumProcesses = 0, bothProcessesStarted!: () => void;
    const invocations: DemoActorProcessInvocation[] = [];
    const processBarrier = new Promise<void>(resolve => { bothProcessesStarted = resolve; });
    const processRunner = async (invocation: DemoActorProcessInvocation, _signal: AbortSignal, maxTurns: number) => {
      assert.equal(maxTurns, 4); assert.equal(invocation.shell, false);
      assert.equal(invocation.env.OPENAI_API_KEY, undefined); assert.equal(invocation.env.CLOUDFLARE_API_TOKEN, undefined);
      invocations.push(invocation);
      assert.equal(invocation.args[1], 'exec'); assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'gpt-6-luna');
      assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'read-only');
      assert.ok(invocation.args.includes('--ephemeral')); assert.ok(invocation.args.includes('--json'));
      assert.ok(invocation.args.includes('--ignore-user-config')); assert.ok(invocation.args.includes('features.shell_tool=false'));
      assert.ok(invocation.args.some(argument => argument.includes('mcp_servers.strata_demo.enabled_tools=["strata_operation"]')));
      assert.ok(invocation.args.includes('mcp_servers.strata_demo.tools.strata_operation.approval_mode="approve"'));
      assert.ok(invocation.args.includes('approval_policy="never"'));
      assert.ok(invocation.args.includes('mcp_servers.strata_demo.default_tools_approval_mode="auto"'));
      assert.equal(invocation.args.includes('--dangerously-bypass-approvals'), false);
      activeProcesses++; maximumProcesses = Math.max(maximumProcesses, activeProcesses);
      if (activeProcesses === 2) bothProcessesStarted();
      try {
        await Promise.race([processBarrier, new Promise(resolve => setTimeout(resolve, 200))]);
        const actor = invocation.stdin.includes('"id":"L-hold"') ? 'a' : invocation.stdin.includes('"id":"L-alternative"') ? 'c' : 'b';
        return await runToolServer(invocation, actor);
      } finally { activeProcesses--; }
    };
    const runner = new CodexSubscriptionActorRunner(host, { project_directory: process.cwd(), codex_entrypoint: path.join(directory, 'mock-codex.js'),
      tool_server_entrypoint: path.join(process.cwd(), 'dist', 'src', 'integrated-demo-actor-mcp.js'),
      base_environment: { PATH: process.env.PATH, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE,
        CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: 'must-not-forward', CLOUDFLARE_API_TOKEN: 'must-not-forward' },
      run_expires_at: activation.expires_at, now: () => DEMO_NOW + 1000, run_process: processRunner, process_label: 'mock-codex-process' });
    const [a, c] = await Promise.all([runner.run('a', 'actor-a'), runner.run('c', 'actor-c')]);
    const b = await runner.run('b', 'actor-b');
    assert.equal(maximumProcesses, 2); assert.equal(a.reasoning_effort, 'medium'); assert.equal(c.reasoning_effort, 'medium');
    assert.equal(b.reasoning_effort, 'high'); assert.equal(a.model, 'gpt-6-luna'); assert.equal(b.model, 'gpt-6-luna');
    assert.equal(a.label, 'mock-codex-process'); assert.equal(a.tool_calls.length, 3);
    assert.ok(a.prompt_sha256.match(/^[a-f0-9]{64}$/)); assert.ok(b.prompt_sha256.match(/^[a-f0-9]{64}$/));
    assert.equal(invocations.length, 3); assert.deepEqual(host.usage().turns, { a: 1, b: 1, c: 1 });
    assert.throws(() => runner.run('a', 'actor-a'), (error: any) => error.code === 'DEMO_ACTOR_PROCESS_LIMIT');
    assert.equal(host.checkpoint.sequence, 10); assert.deepEqual(Object.keys(host.checkpoint.heads).sort(), ['L-alternative', 'L-hold', 'L-reminder']);

    const prepared = await host.event('prepare', 'host', {});
    const packet = operatorPromptPacketFromCheckpoint(host.checkpoint, prepared.outcome);
    assert.equal(packet.packet_digest, host.checkpoint.pending?.digest);
    assert.equal(packet.run_id, target.run_id); assert.deepEqual(packet.allowed_actions, ['900', '1200', 'defer']);
    assert.equal((await session.port.snapshot()).counters.event_sends, 11);
    assert.ok(observed.calls.every(call => call.target.account_id === target.account_id && call.target.workflow_name === target.workflow_name));
    assert.equal(observed.calls.some(call => call.action === 'delete-worker' || call.action === 'delete-repository'), false);
    assert.equal(session.plan.live_authorized, true); assert.equal(host.usage().real_model_calls, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('optional repair launcher reserves a single B invocation and carries remaining inference allowance across processes', async () => {
  const fixture = demoFixture(), host = new DemoHost(fixture.checkpoint, fixture.sendEvent, () => DEMO_NOW);
  for (const actor of ['a', 'b', 'c'] as const) host.bindThread('actor-' + actor, actor);
  await host.event('bootstrap', 'host', {});
  let invocations = 0;
  const runner = new CodexSubscriptionActorRunner(host, { project_directory: process.cwd(), codex_entrypoint: 'mock-codex.js',
    run_expires_at: DEMO_NOW + 1800000, now: () => DEMO_NOW, actor_process_limit: 4, process_label: 'mock-codex-process',
    run_process: async (invocation, _signal, maxTurns) => {
      invocations++;
      const actor = invocation.stdin.includes('"id":"L-hold"') ? 'a' : invocation.stdin.includes('"id":"L-alternative"') ? 'c' : 'b';
      const repaired = host.checkpoint.phase === 'repair';
      assert.equal(maxTurns, repaired ? 1 : 4);
      const result = await runToolServer(invocation, actor, false, repaired);
      return { ...result, turn_starts: actor === 'b' && !repaired ? 3 : 1 };
    } });
  assert.throws(() => runner.run('b', 'actor-b', true), (e: any) => e.code === 'DEMO_ACTOR_PROCESS_LIMIT');
  await Promise.all([runner.run('a', 'actor-a'), runner.run('c', 'actor-c')]);
  await runner.run('b', 'actor-b');
  assert.throws(() => runner.run('b', 'actor-b', true), (e: any) => e.code === 'DEMO_ACTOR_PROCESS_LIMIT');
  await host.event('prepare', 'host', {}); await host.syntheticReply(fixture.receipt('1200'));
  assert.throws(() => runner.run('a', 'actor-a', true), (e: any) => e.code === 'DEMO_ACTOR_PROCESS_LIMIT');
  const evidence = await runner.run('b', 'actor-b', true);
  assert.equal(evidence.assigned_revision, 2); assert.equal(host.checkpoint.heads['L-reminder'].head, 2);
  assert.equal(invocations, 4); assert.deepEqual(host.usage().turns, { a: 1, b: 2, c: 1 });
  assert.throws(() => runner.run('b', 'actor-b', true), (e: any) => e.code === 'DEMO_ACTOR_PROCESS_LIMIT');
  assert.equal(invocations, 4);
  await runner.cancelAndStopWorkflow(); assert.equal(host.checkpoint.phase, 'aborted');
});

test('mock CLI failure cancels local actors, records a stop event, then permits ordered cleanup only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-demo-live-mock-failure-'));
  try {
    const activation = await grant(process.cwd()), fixture = demoFixture('controlled-private'), observed = mockWorkflowProvider(fixture);
    const session = await startReviewedDemoSession({ project_directory: process.cwd(), journal_path: path.join(directory, 'journal.json'),
      config_path: path.join(directory, 'generated.wrangler.json'), grant: activation, attendance: { stdin_is_tty: true, stdout_is_tty: true,
        typed_digest: activation.grant_sha256, operator_label: 'mock operator' }, provider: observed.mock,
      now: () => DEMO_NOW + 1000, sleep: async () => undefined });
    const host = new DemoHost(session.initial_checkpoint, session.dispatch, () => performance.now(), 'model-turn');
    host.bindThread('actor-a', 'a');
    await host.event('bootstrap', 'host', {});
    const runner = new CodexSubscriptionActorRunner(host, { project_directory: process.cwd(),
      codex_entrypoint: path.join(directory, 'mock-codex.js'), tool_server_entrypoint: path.join(process.cwd(), 'dist', 'src', 'integrated-demo-actor-mcp.js'),
      base_environment: { PATH: process.env.PATH, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE },
      run_expires_at: activation.expires_at, now: () => DEMO_NOW + 1000,
      run_process: async invocation => runToolServer(invocation, 'a', true), process_label: 'mock-codex-process' });
    await assert.rejects(runner.run('a', 'actor-a'), (error: any) => error.code === 'DEMO_ACTOR_PROCESS_FAILED');
    assert.equal(host.usage().cancelled, true);
    await runner.cancelAndStopWorkflow();
    assert.equal(host.checkpoint.phase, 'aborted'); assert.equal(host.checkpoint.trace.at(-1)?.kind, 'stop');
    const beforeDelete = await session.port.cleanup('describe-instance').then(() => session.port.snapshot());
    assert.equal(beforeDelete.cleanup.terminal_instance_verified, true);
    assert.equal(beforeDelete.cleanup.repo_tokens_clean, true); assert.equal(beforeDelete.cleanup.handles_disposed, true);
    const final = await cleanupReviewedDemoSession(session.port);
    assert.equal(final.cleanup.namespace_empty_verified, true);
    assert.equal(final.cleanup.worker_absent, true); assert.equal(final.cleanup.repository_absent, true);
    assert.equal(final.counters.event_sends, 5);
    assert.equal(observed.state.instance_deleted && !observed.state.workflow_exists && !observed.state.worker_exists && !observed.state.repository_exists, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live journal protects a complete cleanup reserve under the fixed call and status budgets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-demo-live-budget-'));
  try {
    const activation = await grant(process.cwd()), fixture = demoFixture('controlled-private'), calls: DemoManagementRequest[] = [];
    const provider: MockDemoManagementProvider = { mode: 'mock-only', async call(request) {
      calls.push(structuredClone(request));
      if (request.action === 'create-instance') return { accepted: true, workflow_name: target.workflow_name, instance_id: target.instance_id };
      if (request.action === 'describe-instance') return { found: true, status: 'waiting', checkpoint: fixture.checkpoint };
      if (request.action === 'send-event') return { accepted: true, event_type: request.event_type, instance_id: target.instance_id };
      throw new Error('Unexpected management action in budget test: ' + request.action);
    } };
    const session = await startReviewedDemoSession({ project_directory: process.cwd(), journal_path: path.join(directory, 'journal.json'),
      config_path: path.join(directory, 'generated.wrangler.json'), grant: activation, attendance: { stdin_is_tty: true, stdout_is_tty: true,
        typed_digest: activation.grant_sha256, operator_label: 'mock operator' }, provider,
      now: () => DEMO_NOW + 1000, sleep: async () => undefined });
    while ((await session.port.snapshot()).counters.status_reads <
      session.plan.limits.status_reads - session.plan.limits.cleanup_reserve_status_reads) await session.port.describeInstance();
    for (let sequence = 1; sequence <= session.plan.limits.cleanup_reserve_calls + 10; sequence++) {
      const input = {};
      const event: DemoEvent = { format: 'strata-integrated-demo-event/1', run_id: target.run_id, project_id: target.project_id, sequence,
        request_id: 'reserve-' + sequence, previous_digest: 'a'.repeat(64), phase: 'new' as const, kind: 'bootstrap' as const,
        source: 'host' as const, input, input_digest: digest(input) };
      if (sequence === session.plan.limits.cleanup_reserve_calls + 10) {
        await assert.rejects(session.port.sendEvent(event), (error: any) => error.code === 'DEMO_MANAGEMENT_CLEANUP_RESERVE');
      } else await session.port.sendEvent(event);
    }
    const state = await session.port.snapshot();
    assert.equal(state.counters.status_reads, session.plan.limits.status_reads - session.plan.limits.cleanup_reserve_status_reads);
    assert.equal(state.counters.calls, session.plan.limits.calls - session.plan.limits.cleanup_reserve_calls);
    assert.equal(state.counters.event_sends, session.plan.limits.cleanup_reserve_calls + 9);
    assert.equal(state.cleanup_started, false);
    assert.equal(calls.length, state.counters.calls);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
