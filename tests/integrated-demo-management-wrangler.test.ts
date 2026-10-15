import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonical, digest } from '../src/model.js';
import { DemoManagementAdmissionPort, FileDemoManagementJournal, demoManagementPlan,
  reviewedDemoManagementPlan, type DemoManagementRequest, type DemoManagementTarget } from '../src/integrated-demo-management.js';
import { PINNED_WRANGLER_VERSION, WranglerCliDemoManagementProvider, describeWranglerCommand, sanitizedWranglerFailure,
  type WranglerProcessInvocation, type WranglerProcessResult } from '../src/integrated-demo-management-wrangler.js';
import { approveDemoActivationReview, createDemoActivationReview, createDemoActivationWorkerConfig, DEMO_ACTIVATION_SOURCE_FILES,
  readDemoActivationSource } from '../src/integrated-demo-activation.js';
import type { DemoEvent } from '../src/integrated-demo.js';
import { LOCAL_PROJECT } from '../src/security.js';

const target: DemoManagementTarget = { account_id: '1'.repeat(32), project_id: LOCAL_PROJECT, run_id: 'a1b2c3d4e5f60718',
  worker_name: 'strata-integrated-test', workflow_name: 'strata-integrated-flow', instance_id: 'run-a1b2c3d4e5f60718',
  namespace_id: 'strata-test-namespace', repository_name: 'strata-run-a1b2c3d4e5f60718' };

function event(): DemoEvent {
  const input = { prompt: 'Operator-selected test input' };
  return { format: 'strata-integrated-demo-event/1', run_id: target.run_id, project_id: target.project_id, sequence: 1,
    request_id: 'operator-1', previous_digest: 'a'.repeat(64), phase: 'selection', kind: 'selection', source: 'operator',
    input, input_digest: digest(input) };
}

function request(action: DemoManagementRequest['action'], additions: Partial<DemoManagementRequest> = {}): DemoManagementRequest {
  return { action, target, ...additions } as DemoManagementRequest;
}

async function activationFixture(directory: string) {
  const now = Date.now(), source = await readDemoActivationSource(process.cwd());
  const review = createDemoActivationReview('wrangler-mock', target, source);
  const grant = approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
    typed_digest: review.review_sha256, operator_label: 'mock Wrangler test' }, now);
  const plan = reviewedDemoManagementPlan(grant, source, now), configPath = path.join(directory, 'target.wrangler.json');
  await writeFile(configPath, JSON.stringify(createDemoActivationWorkerConfig(grant)));
  return { now, source, grant, plan, configPath };
}

test('exact zero-step Worker lookup failure reports the provider error and retains uncertain cleanup without invented counts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-worker-lookup-'));
  try {
    const { grant, plan, configPath } = await activationFixture(directory);
    const calls: string[] = [];
    const cli = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      base_environment: {}, run_process: async invocation => {
        if (invocation.args.includes('trigger')) { calls.push('create'); return { code: 0, stdout: JSON.stringify({ id: target.instance_id }), stderr: '' }; }
        calls.push('describe'); return { code: 0, stdout: JSON.stringify({ id: target.instance_id, params: { run_id: target.run_id },
          status: 'errored', success: false, step_count: 0, steps: [], error: { message: 'Worker not found.', name: 'Error' } }), stderr: '' };
      } });
    const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(path.join(directory, 'journal.json')), cli);
    await port.createInstance();
    await assert.rejects(port.describeInstance(), (error: any) => error.code === 'DEMO_PROVIDER_WORKER_NOT_FOUND' && /before any application step/.test(error.message));
    const state = await port.snapshot();
    assert.equal(state.reconciliation_required, true);
    assert.equal(state.cleanup.terminal_instance_verified, false);
    await assert.rejects(port.cleanup('delete-instance'));
    assert.deepEqual(calls, ['create', 'describe']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('zero-step application refusal reports its safe code without inventing cleanup accounting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-application-startup-'));
  try {
    const { grant, plan, configPath } = await activationFixture(directory);
    const calls: string[] = [];
    const cli = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      base_environment: {}, run_process: async invocation => {
        if (invocation.args.includes('trigger')) { calls.push('create'); return { code: 0, stdout: JSON.stringify({ id: target.instance_id }), stderr: '' }; }
        calls.push('describe'); return { code: 0, stdout: JSON.stringify({ id: target.instance_id, status: 'complete', success: true,
          step_count: 0, steps: [], output: { ok: false, error: { code: 'DEMO_WORKFLOW_EVENT_REFUSED', message: 'private provider detail' } } }), stderr: '' };
      } });
    const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(path.join(directory, 'journal.json')), cli);
    await port.createInstance();
    await assert.rejects(port.describeInstance(), (error: any) => {
      assert.equal(error.code, 'DEMO_APPLICATION_STARTUP_REFUSED');
      assert.match(error.message, /DEMO_WORKFLOW_EVENT_REFUSED/);
      assert.ok(!error.message.includes('private provider detail'));
      return true;
    });
    const state = await port.snapshot();
    assert.equal(state.reconciliation_required, true);
    assert.equal(state.cleanup.terminal_instance_verified, false);
    await assert.rejects(port.cleanup('delete-instance'));
    assert.deepEqual(calls, ['create', 'describe']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Wrangler adapter builds exact shell-free commands and maps only mocked CLI responses', async () => {
  assert.equal(PINNED_WRANGLER_VERSION, '4.147.0');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-wrangler-adapter-'));
  try {
    const { grant, plan, configPath } = await activationFixture(directory);
    const invoke = (action: DemoManagementRequest['action'], additions: Partial<DemoManagementRequest> = {}) =>
      describeWranglerCommand(request(action, additions), process.cwd());
    const create = invoke('create-instance');
    assert.deepEqual(create.args.slice(1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'workflows', 'trigger',
      target.workflow_name, JSON.stringify({ run_id: target.run_id }), '--id', target.instance_id, '--json']);
    const instance = invoke('describe-instance');
    assert.deepEqual(instance.args.slice(1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'workflows', 'instances', 'describe',
      target.workflow_name, target.instance_id, '--json']);
    assert.equal(instance.executable, process.execPath); assert.equal(instance.interactive, false);
    assert.equal(instance.account_id, target.account_id); assert.equal(instance.telemetry_disabled_by_config, true);
    const sentEvent = event(), send = invoke('send-event', { event: sentEvent, event_type: 'strata-demo-1' });
    assert.deepEqual(send.args.slice(1, -1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'workflows', 'instances',
      'send-event', target.workflow_name, target.instance_id, '--type', 'strata-demo-1', '--payload', canonical(sentEvent)]);
    assert.equal(send.args.at(-1), '--json');
    assert.throws(() => invoke('send-event', { event: { ...sentEvent, input_digest: 'f'.repeat(64) }, event_type: 'strata-demo-1' }),
      (error: any) => error.code === 'DEMO_WRANGLER_EVENT_REFUSED');
    assert.equal(invoke('delete-instance').args.at(-1), '--json');
    assert.deepEqual(invoke('describe-workflow').args.slice(1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'workflows', 'list', '--per-page', '100', '--json']);
    assert.deepEqual(invoke('describe-worker').args.slice(1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'deployments', 'list', '--name', target.worker_name, '--json']);
    assert.equal(invoke('delete-worker').interactive, true);
    assert.deepEqual(invoke('delete-worker').args.slice(1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'delete', target.worker_name]);
    assert.equal(invoke('delete-worker').args.includes('--force'), false);
    assert.deepEqual(invoke('describe-repository').args.slice(1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'artifacts', 'repos', 'list', '--namespace', target.namespace_id, '--json']);
    assert.deepEqual(invoke('delete-repository').args.slice(1), ['--config', path.resolve('wrangler.integrated-demo.json'), 'artifacts', 'repos', 'delete',
      target.repository_name, '--namespace', target.namespace_id, '--force', '--json']);

    const calls: WranglerProcessInvocation[] = [];
    let stdout = '';
    const cli = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      base_environment: { PATH: process.env.PATH }, interactive_terminal: () => true,
      run_process: async invocation => { calls.push(invocation); return { code: 0, stdout, stderr: '' }; } });
    const invokeCli = async (action: DemoManagementRequest['action'], additions: Partial<DemoManagementRequest> = {}) => {
      cli.preflight(action, plan); return cli.call(request(action, additions));
    };
    stdout = JSON.stringify({ id: target.instance_id, status: 'complete', steps: [{}, {}], output: {
      checkpoint: { counters: { artifact_reserved: 7 } }, management_cleanup: { unsettled_dispatches: 0, repo_tokens_issued: 3, repo_tokens_revoked: 3, handles_open: 0 } } });
    assert.deepEqual(await invokeCli('describe-instance'), { found: true, status: 'complete', used_steps: 2, artifact_dispatches: 7,
      unsettled_dispatches: 0, repo_tokens_issued: 3, repo_tokens_revoked: 3, handles_open: 0 });
    assert.equal(calls[0].env.CLOUDFLARE_ACCOUNT_ID, target.account_id);
    assert.equal(Object.hasOwn(calls[0], 'shell'), false); assert.ok(calls[0].args.includes(configPath));
    stdout = JSON.stringify({ deleted: [{ id: target.instance_id }], errors: [] });
    assert.deepEqual(await invokeCli('delete-instance'), { accepted: true, deleted_instance_id: target.instance_id });
    stdout = JSON.stringify({ deleted: true, name: target.repository_name, namespace: target.namespace_id });
    assert.deepEqual(await invokeCli('delete-repository'), { accepted: true, repository_name: target.repository_name });
    stdout = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ name: 'workflow-' + index })));
    const fullPage = await invokeCli('describe-workflow') as any;
    assert.equal(fullPage.page_complete, false); assert.equal(fullPage.found, undefined);
    stdout = '[]';
    assert.deepEqual(await invokeCli('describe-worker'), { found: true, worker_name: target.worker_name, deployments_count: 0,
      verification: 'Wrangler deployment listing' });
    calls.length = 0;
    const absentCli = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      base_environment: { PATH: process.env.PATH }, run_process: async invocation => { calls.push(invocation); return { code: 1, stdout: '',
        stderr: `X [ERROR] A request to the Cloudflare API (/accounts/${target.account_id}/workers/scripts/${target.worker_name}/deployments) failed.\n\n  This Worker does not exist on your account. [code: 10007]\n` }; } });
    absentCli.preflight('describe-worker', plan);
    assert.deepEqual(await absentCli.call(request('describe-worker')), { found: false, worker_name: target.worker_name,
      verification: 'exact-target Workers API 10007 not-found response' });
    const otherName = { ...target, worker_name: 'another-worker' };
    await assert.rejects(absentCli.call({ action: 'describe-worker', target: otherName }),
      (error: any) => error.code === 'DEMO_WRANGLER_ACTIVATION_REQUIRED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('instance absence accepts the observed provider not_found code only at the exact target endpoint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-wrangler-instance-absence-'));
  try {
    const { grant, plan, configPath } = await activationFixture(directory);
    const endpoint = `/accounts/${target.account_id}/workflows/${target.workflow_name}/instances/${target.instance_id}`;
    const response = (path: string, error: string) => `X [ERROR] A request to the Cloudflare API (${path}) failed.\n\n  ${error}\n`;
    const notFound = 'workflows.api.error.instance.not_found [code: 10400]';
    let result: WranglerProcessResult = { code: 1, stdout: '', stderr: response(endpoint, notFound) };
    let invocations = 0;
    const cli = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath,
      activation_grant: grant, base_environment: {}, run_process: async () => { invocations++; return result; } });
    cli.preflight('describe-instance', plan);
    assert.deepEqual(await cli.call(request('describe-instance')), { found: false, instance_id: target.instance_id,
      verification: 'exact-target Workflow instance API not-found response' });
    const rejected = [
      response(endpoint.replace(target.account_id, '2'.repeat(32)), notFound),
      response(endpoint.replace(target.workflow_name, 'another-workflow'), notFound),
      response(endpoint.replace(target.instance_id, 'run-' + 'f'.repeat(16)), notFound),
      response(endpoint, 'workflows.api.error.instance.not_found [code: 99999]'),
      response(endpoint, 'workflows.api.error.instance.unavailable [code: 10400]'),
      `Unscoped ${notFound}`,
    ];
    for (const stderr of rejected) {
      result = { code: 1, stdout: '', stderr };
      await assert.rejects(cli.call(request('describe-instance')), (error: any) => error.code === 'DEMO_WRANGLER_COMMAND_UNCERTAIN');
    }
    result = { code: 2, stdout: '', stderr: response(endpoint, notFound) };
    await assert.rejects(cli.call(request('describe-instance')), (error: any) => error.code === 'DEMO_WRANGLER_COMMAND_UNCERTAIN');
    assert.equal(invocations, 8); // One invocation per explicit request, with no automatic retry.
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deploy failure retains only sanitized provider diagnostics and never retries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-wrangler-deploy-failure-'));
  try {
    const { grant, plan, configPath } = await activationFixture(directory);
    let invocations = 0;
    const privateOutput = `HTTP 400 [code: 10021] environment variable size limit\nAuthorization: Bearer secret-fixture\n${JSON.stringify(grant)}`;
    assert.equal(sanitizedWranglerFailure(privateOutput), ' Sanitized diagnostic: HTTP 400; provider code 10021; environment variable size/limit diagnostic.');
    assert.equal(sanitizedWranglerFailure('unknown sensitive output secret-fixture'), '');
    for (const throws of [false, true]) {
      const cli = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
        base_environment: {}, run_process: async () => {
          invocations++;
          if (throws) throw Object.assign(new Error('secret-fixture'), { stderr: privateOutput });
          return { code: 1, stdout: '', stderr: privateOutput };
        } });
      cli.preflight('deploy-private', plan);
      await assert.rejects(cli.call(request('deploy-private')), (error: any) => {
        assert.equal(error.code, 'DEMO_WRANGLER_COMMAND_UNCERTAIN');
        assert.match(error.message, /HTTP 400; provider code 10021/);
        assert.match(error.message, /do not retry automatically/);
        assert.ok(!error.message.includes('secret-fixture') && !error.message.includes(grant.grant_sha256));
        return true;
      });
    }
    assert.equal(invocations, 2);
    const supplied = createDemoActivationWorkerConfig(grant);
    Object.assign(supplied.vars, { EXTRA_OVERSIZED: 'x'.repeat(4097) });
    await writeFile(configPath, JSON.stringify(supplied));
    assert.throws(() => new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      run_process: async () => { invocations++; return { code: 0, stdout: '', stderr: '' }; } }));
    assert.equal(invocations, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('noninteractive cleanup preserves bounded failure metadata, uses CI and never retries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-cleanup-diagnostic-'));
  try {
    const { grant, plan, configPath } = await activationFixture(directory);
    let invocations = 0;
    const cli = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      base_environment: {}, run_process: async invocation => {
        invocations++; assert.equal(invocation.env.CI, 'true'); assert.equal(invocation.interactive, false);
        throw Object.assign(new Error('timed out credential-do-not-export'), { code: 1, killed: true, signal: 'SIGTERM' });
      } });
    cli.preflight('delete-repository', plan);
    await assert.rejects(cli.call(request('delete-repository')), (error: any) => {
      assert.equal(error.code, 'DEMO_WRANGLER_COMMAND_UNCERTAIN');
      assert.deepEqual(error.details, { stage: 'wrangler.delete-repository', category: 'timeout', code: 1, process_killed: true, signal: 'SIGTERM' });
      assert.ok(!JSON.stringify(error).includes('credential-do-not-export'));
      return true;
    });
    assert.equal(invocations, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Wrangler worker deletion requires an attended terminal and the admission port refuses all live dispatch', async () => {
  let invocations = 0;
  const run = async (_invocation: WranglerProcessInvocation): Promise<WranglerProcessResult> => { invocations++; return { code: 0, stdout: '', stderr: '' }; };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strata-wrangler-admission-'));
  try {
    const { grant, plan, configPath } = await activationFixture(dir);
    const unattended = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      run_process: run, interactive_terminal: () => false });
    assert.throws(() => unattended.preflight('delete-worker', plan), (error: any) => error.code === 'DEMO_WRANGLER_TTY_REQUIRED');
    assert.equal(invocations, 0);
    const liveProvider = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      run_process: run, interactive_terminal: () => true });
    const port = new DemoManagementAdmissionPort(demoManagementPlan(target, Date.now()),
      new FileDemoManagementJournal(path.join(dir, 'journal.json')), liveProvider);
    await assert.rejects(port.describeInstance(), (error: any) => error.code === 'DEMO_MANAGEMENT_LIVE_DISABLED');
    assert.equal(invocations, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Wrangler provider stops before dispatch when any reviewed source file changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-wrangler-stale-source-'));
  let invocations = 0;
  try {
    for (const name of DEMO_ACTIVATION_SOURCE_FILES) {
      const destination = path.join(directory, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(process.cwd(), name), destination);
    }
    const wranglerPackage = path.join(directory, 'node_modules', 'wrangler', 'package.json');
    await mkdir(path.dirname(wranglerPackage), { recursive: true });
    await writeFile(wranglerPackage, JSON.stringify({ version: PINNED_WRANGLER_VERSION }));
    const source = await readDemoActivationSource(directory), now = Date.now(), review = createDemoActivationReview('stale-source-test', target, source);
    const grant = approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
      typed_digest: review.review_sha256, operator_label: 'mock Wrangler test' }, now);
    const configPath = path.join(directory, 'target.wrangler.json');
    await writeFile(configPath, JSON.stringify(createDemoActivationWorkerConfig(grant, directory)));
    const plan = reviewedDemoManagementPlan(grant, source, now);
    const cli = new WranglerCliDemoManagementProvider({ project_directory: directory, config_path: configPath, activation_grant: grant,
      base_environment: { PATH: process.env.PATH }, run_process: async () => { invocations++; return { code: 0, stdout: '[]', stderr: '' }; } });
    cli.preflight('describe-instance', plan);
    await writeFile(path.join(directory, 'src', 'integrated-demo-worker-entry.ts'), '// changed after review');
    await assert.rejects(cli.call(request('describe-instance')), (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_STALE');
    assert.equal(invocations, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
