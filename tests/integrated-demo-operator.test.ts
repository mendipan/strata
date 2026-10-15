import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { approveBrowserDemoReview, approveDemoActivationReview, confirmDemoActivationReview, createDemoActivationReview, readDemoActivationSource } from '../src/integrated-demo-activation.js';
import { DEMO_LAB } from './demo-lab-fixture.js';
import { LOCAL_PROJECT } from '../src/security.js';
import { parseWorkflowSnapshot } from '../src/integrated-demo-visualization.js';
import { probeSubscriptionCli } from '../src/integrated-demo-operator.js';
import { CloudflareArtifactsAdapter } from '../src/artifacts.js';
import { RunBudget } from '../src/budget.js';

async function invoke(scenario: string, plainConfirmation = false, persistent = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-operator-command-'));
  const source = await readDemoActivationSource(process.cwd()), now = Date.now();
  const target = { account_id: '1'.repeat(32), project_id: LOCAL_PROJECT, run_id: '0a1b2c3d4e5f6789',
    worker_name: 'strata-integrated-test', workflow_name: 'strata-integrated-flow', instance_id: 'run-0a1b2c3d4e5f6789',
    namespace_id: 'strata-test-namespace', repository_name: 'strata-run-0a1b2c3d4e5f6789' };
  if (persistent) Object.assign(target, DEMO_LAB);
  const infrastructure = { policy: 'retain-private-worker-workflow' as const, workflow_id: '11111111-1111-4111-8111-111111111111',
    worker_version_id: '22222222-2222-4222-8222-222222222222', workflow_version_id: '33333333-3333-4333-8333-333333333333' };
  const review = createDemoActivationReview('operator-cli-' + scenario, target, source, persistent ? infrastructure : undefined, scenario === 'browser-repair');
  const attendance = { stdin_is_tty: true, stdout_is_tty: true, operator_label: 'SYNTHETIC TEST INPUT - no human/live consent' };
  const grant = persistent ? approveBrowserDemoReview(review, source, { action: 'begin-demo', operator_label: attendance.operator_label, review_sha256: review.review_sha256 }, now) : plainConfirmation
    ? confirmDemoActivationReview(review, source, { ...attendance, confirmation_text: 'START DEMO' }, now)
    : approveDemoActivationReview(review, source, { ...attendance, typed_digest: review.review_sha256 }, now);
  const grantFile = path.join(directory, 'grant.json'), proof = path.join(directory, 'proof.json'), output = path.join(directory, 'output');
  await writeFile(grantFile, JSON.stringify(grant)); await writeFile(path.join(directory, 'mock-codex.js'), '// no generation');
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.resolve('dist/tests/integrated-demo-operator-preload.js')).href,
    path.resolve(scenario.startsWith('browser') ? 'dist/tests/integrated-demo-dashboard-driver.js' : 'dist/scripts/integrated-demo-operator.js'), 'start', grantFile, output], {
    cwd: process.cwd(), windowsHide: true, env: { ...process.env, CODEX_CLI_ENTRYPOINT: path.join(directory, 'mock-codex.js'),
      STRATA_OPERATOR_TEST_SCENARIO: scenario, STRATA_OPERATOR_TEST_PROOF: proof }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Operator CLI test timeout: ' + stderr)); }, 20_000);
    child.once('error', reject); child.once('close', value => { clearTimeout(timer); resolve(value); });
  });
  const evidence = JSON.parse(await readFile(proof, 'utf8').catch(() => { throw new Error('CLI preload failed (' + code + '): ' + stderr); }));
  if (code !== 0 && scenario.startsWith('browser')) {
    // Include synthetic actor diagnostics before the fixture directory is removed.
    // Production refusals stay intact; this makes a harness failure attributable.
    for (const actor of ['a', 'b', 'c']) {
      const saved = JSON.parse(await readFile(path.join(output, 'actor-' + actor + '.json'), 'utf8').catch(() => 'null'));
      if (saved?.codex_stderr) stderr += '\nSynthetic actor ' + actor + ': ' + saved.codex_stderr;
    }
  }
  return { directory, output, code, stdout, stderr, evidence, grant };
}

test('SAME production operator command: reviewed start, three actors, real conflict, synthetic decisions, separate Release, viewer, cleanup', async () => {
  const run = await invoke('complete');
  try {
    assert.equal(run.code, 0, run.stderr);
    const e = run.evidence;
    assert.equal(e.launched, 3); assert.equal(e.maximum, 2);
    assert.deepEqual(e.profiles.map((p: any) => p.actor).sort(), ['a', 'b', 'c']);
    for (const p of e.profiles) {
      assert.ok(p.args.includes('forced_login_method="chatgpt"'));
      assert.ok(p.args.includes('model_reasoning_effort="' + (p.actor === 'b' ? 'high' : 'medium') + '"'));
    }
    assert.equal(e.checkpoint.phase, 'complete');
    assert.deepEqual(e.checkpoint.receipts.map((r: any) => r.action), ['900', 'approve-release']);
    assert.ok(e.checkpoint.receipts.every((r: any) => r.source === 'operator-supplied-artifact' && r.operator_label.startsWith('SYNTHETIC')));
    assert.equal(e.prompts.filter((p: string) => p.startsWith('Conflict')).length, 1);
    assert.equal(e.prompts.filter((p: string) => p.startsWith('Separate Release')).length, 1);
    assert.deepEqual(e.resources, { instance: false, worker: false, workflow: false, repository: false });
    assert.equal(e.cleanup.repo_tokens_issued, e.cleanup.repo_tokens_revoked);
    const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
    assert.ok(result.released.ref); assert.equal(result.cleanup.cleanup.namespace_empty_verified, true);
    assert.equal(result.ok, true); assert.equal(result.readback.fresh_reader, true);
    assert.equal(result.readback.released_ref, result.released.ref);
    assert.equal(Object.keys(result.readback.fresh_entries).length, 4);
    assert.equal(result.observed.intervals.length, 3);
    assert.ok(result.observed.operations.every((span: any) => span.received <= span.executing && span.executing <= span.completed));
    for (const role of ['a', 'b', 'c']) {
      const saved = JSON.parse(await readFile(path.join(run.output, 'actor-' + role + '.json'), 'utf8'));
      assert.equal(saved.command.shell, false); assert.equal(saved.command.environment_values_retained, false);
      assert.ok(saved.invocation.duration_ms >= 0); assert.ok(saved.process.duration_ms >= 0);
      assert.equal(saved.process.child_close_observed, true);
      assert.equal(saved.command.environment_keys.includes('OPENAI_API_KEY'), false);
    }
    assert.ok(result.cleanup.counters.calls <= 180); assert.ok(result.cleanup.counters.status_reads <= 160);
    const events = (await readFile(path.join(run.output, 'viewer-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.filter(e => e.type === 'operator-pause').map(e => e.packet.phase), ['selection', 'endorsement']);
    assert.ok(events.find(e => e.type === 'operator-pause').packet.decision.considered.includes('L-alternative@1'));
    const viewer = parseWorkflowSnapshot(JSON.parse(await readFile(path.join(run.output, 'workflow-export.json'), 'utf8')));
    assert.equal(viewer.phase, 'complete'); assert.ok(viewer.release_ref);
    await mkdir('.strata/test-results', { recursive: true });
    await writeFile(path.resolve('.strata/test-results/integrated-demo-operator-mock-e2e.json'), JSON.stringify({
      label: 'Production CLI spawned with TEST-ONLY native subprocess/terminal mocks; zero live calls or human consent',
      command: 'node dist/scripts/integrated-demo-operator.js start <grant> <new-directory>',
      sequence: events.map(e => ({ type: e.type, phase: e.phase ?? e.packet?.phase ?? null, kind: e.kind ?? null })),
      actors: e.profiles.map((p: any) => ({ actor: p.actor, model: 'gpt-6-luna', reasoning: p.actor === 'b' ? 'high' : 'medium' })),
      launched: e.launched, max_concurrent: e.maximum, released: result.released,
      cleanup: result.cleanup.cleanup, counters: result.cleanup.counters, viewer: { phase: viewer.phase, release_ref: viewer.release_ref },
      token_counts: { issued: Number(e.cleanup.repo_tokens_issued) + 1, revoked: Number(e.cleanup.repo_tokens_revoked) + 1 },
      native_initial_token_test: 'separate native adapter test verifies initial creation/revocation; preload models this boundary'
    }, null, 2) + '\n');
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test('persistent browser grant runs the production operator with three mocked actors, two browser decisions and retained infrastructure', async () => {
  const run = await invoke('browser', false, true);
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.evidence.prompts.length, 0); assert.equal(run.evidence.launched, 3); assert.equal(run.evidence.maximum, 2);
    assert.deepEqual(run.evidence.resources, { instance: false, repository: false, worker: true, workflow: true });
    assert.deepEqual(run.evidence.checkpoint.receipts.map((r: any) => [r.action, r.capture_method]), [['900', 'local-browser'], ['approve-release', 'local-browser']]);
    const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
    assert.equal(result.cleanup.cleanup.repo_tokens_clean, true); assert.equal(result.cleanup.cleanup.namespace_empty_verified, true);
    assert.equal(result.cleanup.cleanup.worker_retained_verified, true); assert.equal(result.cleanup.cleanup.workflow_retained_verified, true);
    assert.equal(result.cleanup.cleanup.worker_absent, false); assert.equal(result.cleanup.cleanup.workflow_absent, false);
    assert.ok(!run.evidence.calls.some((c: string) => c === 'delete-worker' || c.startsWith('deploy ') || c.startsWith('workflows delete ')));
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test('reviewed reminder repair uses exactly four processes, fresh browser consent, measured 1200 Release and verified cleanup', async () => {
  const run = await invoke('browser-repair', false, true);
  try {
    assert.equal(run.code, 0, run.stderr);
    const e = run.evidence;
    assert.equal(run.grant.limits.actor_processes, 4);
    assert.equal(e.launched, 4); assert.equal(e.maximum, 2); assert.equal(e.prompts.length, 0);
    assert.deepEqual(e.profiles.slice(0, 2).map((p: any) => p.actor).sort(), ['a', 'c']);
    assert.deepEqual(e.profiles.slice(2).map((p: any) => p.actor), ['b', 'b']);
    assert.equal(e.checkpoint.phase, 'complete');
    assert.deepEqual(e.checkpoint.receipts.map((r: any) => r.action), ['1200', '1200', 'approve-release']);
    assert.ok(e.checkpoint.receipts.every((r: any) => r.capture_method === 'local-browser'));
    assert.equal(e.checkpoint.heads['L-reminder'].head, 2);
    assert.ok(e.checkpoint.counters.tools.b <= 20);
    const first = JSON.parse(await readFile(path.join(run.output, 'actor-b.json'), 'utf8'));
    const repair = JSON.parse(await readFile(path.join(run.output, 'actor-b-repair.json'), 'utf8'));
    assert.equal(first.assigned_revision, 1); assert.equal(repair.assigned_revision, 2);
    assert.equal(repair.reasoning_effort, 'high'); assert.equal(repair.thread, first.thread);
    assert.ok(first.turn_starts + repair.turn_starts <= 4);
    const events = (await readFile(path.join(run.output, 'viewer-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const pauses = events.filter(e => e.type === 'operator-pause');
    assert.deepEqual(pauses.map(e => e.packet.phase), ['selection', 'selection', 'endorsement']);
    assert.notEqual(pauses[0].packet.packet_digest, pauses[1].packet.packet_digest);
    assert.deepEqual(pauses[1].packet.allowed_actions, ['1200', 'defer']);
    const realized = events.find(e => e.kind === 'realize');
    assert.equal(realized.outcome.data.selected_seconds, 1200);
    assert.equal(events.find(e => e.type === 'release-verified').inherited_observations_equal, true);
    const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
    assert.equal(result.cleanup.cleanup.namespace_empty_verified, true);
    assert.equal(result.cleanup.cleanup.repo_tokens_clean, true);
    assert.ok(result.cleanup.counters.calls <= 180 && result.cleanup.counters.status_reads <= 160 && result.cleanup.counters.event_sends <= 60);
    assert.deepEqual(e.resources, { instance: false, repository: false, worker: true, workflow: true });
    assert.equal(e.cleanup.repo_tokens_issued, e.cleanup.repo_tokens_revoked);
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test('production operator retrieves truncated step outputs with separately admitted cached reads through Release and cleanup', async () => {
  const run = await invoke('full-step');
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.evidence.launched, 3);
    assert.deepEqual(run.evidence.resources, { instance: false, worker: false, workflow: false, repository: false });
    const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
    const reads = run.evidence.calls.filter((call: string) => call.startsWith('full-step:'));
    assert.ok(reads.length > 10);
    assert.equal(new Set(reads).size, reads.length, 'Completed historical outputs must be cached within the grant');
    assert.equal(result.cleanup.history.filter((entry: any) => entry.action === 'describe-step').length, reads.length);
    assert.equal(result.cleanup.counters.calls, run.evidence.calls.filter((call: string) => !call.startsWith('cli:')).length);
    assert.ok(result.cleanup.counters.calls <= 180);
    assert.ok(result.cleanup.counters.status_reads <= 160);
    assert.equal(result.cleanup.reconciliation_required, false);
    assert.equal(result.cleanup.cleanup.namespace_empty_verified, true);
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

for (const plainConfirmation of [false, true]) test('browser choices with ' + (plainConfirmation ? 'plain confirmation' : 'legacy digest') + ' run through the production operator, separate Release and cleanup', async () => {
  const run = await invoke('browser', plainConfirmation);
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.evidence.launched, 3); assert.equal(run.evidence.maximum, 2);
    if (plainConfirmation) {
      assert.equal(run.evidence.prompts.length, 0, 'The guided same-session handoff must not ask for another hash or start confirmation.');
      assert.equal(run.grant.format, 'strata.integrated-demo-activation-grant/2');
      assert.equal(Object.hasOwn(run.grant.approval, 'typed_digest'), false);
    }
    assert.deepEqual(run.evidence.checkpoint.receipts.map((r: any) => [r.action, r.capture_method]), [['900', 'local-browser'], ['approve-release', 'local-browser']]);
    assert.deepEqual(run.evidence.resources, { instance: false, worker: false, workflow: false, repository: false });
    const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
    assert.equal(result.cleanup.cleanup.namespace_empty_verified, true);
    assert.equal(result.cleanup.cleanup.repo_tokens_clean, true);
    const viewer = parseWorkflowSnapshot(JSON.parse(await readFile(path.join(run.output, 'workflow-export.json'), 'utf8')));
    assert.equal(viewer.phase, 'complete');
    assert.ok(viewer.decision_receipts.every(receipt => receipt.capture_method === 'local-browser'));
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

for (const scenario of ['actor-failure', 'actor-no-tools', 'interrupt', 'cleanup-boundary', 'repair', 'defer-release']) {
  test('production operator CLI handles ' + scenario + ' with bounded stop/cleanup and no extra actor', async () => {
    const run = await invoke(scenario);
    try {
      assert.equal(run.code, scenario === 'defer-release' ? 0 : 7, run.stderr);
      assert.ok(run.evidence.launched <= 3); assert.ok(run.evidence.maximum <= 2);
      assert.equal(run.evidence.checkpoint.phase, 'aborted', run.stderr + JSON.stringify(run.evidence.calls));
      assert.deepEqual(run.evidence.resources, { instance: false, worker: false, workflow: false, repository: false }, run.stderr + run.stdout);
      assert.equal(run.evidence.cleanup.repo_tokens_issued, run.evidence.cleanup.repo_tokens_revoked);
      const summary = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
      assert.equal(summary.ok, scenario === 'defer-release');
      assert.ok(summary.observed); assert.equal(summary.observed.type, 'execution-observed');
      assert.ok(summary.observed.intervals.length >= 2);
      if (scenario !== 'defer-release') assert.equal(summary.observed.ok, false);
      if (scenario === 'actor-no-tools' || scenario === 'actor-failure') {
        assert.equal(run.evidence.launched, 2, 'A failed initial actor must never start the dependent actor');
        const actor = JSON.parse(await readFile(path.join(run.output, 'actor-a.json'), 'utf8'));
        assert.equal(actor.exit_code, scenario === 'actor-no-tools' ? 0 : 1);
        assert.ok(actor.codex_event_stream.includes('turn.completed'));
        if (scenario === 'actor-no-tools') {
          assert.equal(run.evidence.launched, 2);
          assert.equal(actor.tool_calls.length, 0);
          assert.equal(actor.codex_stderr, 'Mock startup diagnostic [redacted-capability]');
          assert.ok(run.stderr.includes('DEMO_ACTOR_NO_PUBLICATION'));
          assert.ok(!run.evidence.events.some((e: any) => e.kind === 'prepare'));
        }
      }
      if (scenario !== 'defer-release') assert.ok(run.evidence.events.some((e: any) => e.kind === 'stop'));
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  });
}
for (const scenario of ['bad-digest', 'auth-mismatch', 'full-step-auth-missing', 'provider-failure', 'deploy-failure', 'expired']) {
  test('production operator CLI fails closed for ' + scenario + ' without unsafe deletion or retry', async () => {
    const run = await invoke(scenario);
    try {
      assert.equal(run.code, 7, run.stderr);
      assert.equal(run.evidence.calls.some((c: string) => c.includes('delete')), false);
      if (scenario === 'full-step-auth-missing') {
        assert.equal(run.evidence.launched, 0);
        assert.equal(run.evidence.calls.some((call: string) => call.startsWith('deploy') || call.includes('trigger')), false);
        assert.deepEqual(run.evidence.resources, { instance: false, worker: false, workflow: false, repository: false });
      }
      if (scenario === 'bad-digest' || scenario === 'auth-mismatch') {
        assert.equal(run.evidence.launched, 0); assert.ok(run.evidence.calls.every((c: string) => c.startsWith('cli:')));
      } else assert.ok((await readFile(path.join(run.output, 'viewer-events.jsonl'), 'utf8')).includes('cleanup-blocked'));
      if (scenario === 'deploy-failure') {
        const events = await readFile(path.join(run.output, 'viewer-events.jsonl'), 'utf8');
        assert.match(events, /underlying_deploy_diagnostic/); assert.match(events, /HTTP 400; provider code 10021/);
        assert.ok(!events.includes('secret-fixture') && !events.includes(run.grant.grant_sha256));
        assert.equal(run.evidence.launched, 0);
        assert.equal(run.evidence.calls.filter((c: string) => c.startsWith('deploy ')).length, 1);
        assert.ok(!run.evidence.calls.some((c: string) => c.includes('trigger')));
        const journal = JSON.parse(await readFile(path.join(run.output, 'management-journal.json'), 'utf8'));
        assert.equal(journal.reconciliation_required, true);
        assert.match(run.stderr, /DEMO_WRANGLER_COMMAND_UNCERTAIN/); assert.match(run.stderr, /"cleanup_code":"DEMO_OPERATOR_RECONCILE_REQUIRED"/);
      }
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  });
}
test('missing executable and API billing mismatch are refused without generation', async () => {
  let probes = 0;
  await assert.rejects(probeSubscriptionCli(process.cwd(), { CODEX_CLI_ENTRYPOINT: path.resolve('missing-cli.js') }, async () => { probes++; throw new Error('must not probe'); }),
    (e: any) => e.code === 'DEMO_ACTOR_CLI_MISSING');
  assert.equal(probes, 0);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-operator-api-refusal-'));
  try {
    const entrypoint = path.join(directory, 'mock-cli.js'); await writeFile(entrypoint, '// subprocess boundary only');
    const argumentsSeen: string[] = [];
    await assert.rejects(probeSubscriptionCli(process.cwd(), { CODEX_CLI_ENTRYPOINT: entrypoint, OPENAI_API_KEY: 'must-not-forward' },
      async (_entry, args, env) => {
        assert.equal(env.OPENAI_API_KEY, undefined); argumentsSeen.push(args.join(' '));
        return { code: 0, stderr: '', stdout: args.includes('--version') ? 'codex-cli 0.160.1' : args.includes('--help')
          ? '--model --sandbox --ephemeral --json --ignore-user-config --skip-git-repo-check' : 'Logged in using an API key' };
      }), (e: any) => e.code === 'DEMO_OPERATOR_AUTH_REQUIRED');
    assert.deepEqual(argumentsSeen, ['--version', 'exec --help', 'login status']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native disposable creation revokes the initial token and spends the same fixed adapter token allowance', async () => {
  const calls: string[] = [], now = Date.now();
  const repository = { async info() { return { remote: '' }; }, async readFile() { return null; },
    async createToken() { throw new Error('No second token allowed'); }, async revokeToken(token: string) {
      assert.equal(token, 'mock-initial-token'); calls.push('revoke-initial-token'); return { revoked: true };
    }, [Symbol.dispose]() { calls.push('dispose'); } };
  const adapter = new CloudflareArtifactsAdapter({ mode: 'remote', repository: 'disposable-demo',
    identity: { account: '1'.repeat(32), namespace: 'retained-test' },
    namespace: { async create(name) { assert.equal(name, 'disposable-demo'); calls.push('create'); return { name, token: 'mock-initial-token' }; },
      async get(name) { assert.equal(name, 'disposable-demo'); calls.push('get'); return repository; } },
    approval: { approved: true, repository: 'disposable-demo', approval_id: 'native-mock-only', project_id: LOCAL_PROJECT,
      expires_at: new Date(now + 60_000).toISOString() }, max_repo_tokens: 1,
    budget: new RunBudget({ operations: 10, attempts: 10, bytes: 100_000, duration_ms: 60_000, input_tokens: 0, output_tokens: 0 }),
    transport: async () => { throw new Error('No external transport permitted'); } });
  assert.equal(await adapter.provisionDisposableRepository(), 3);
  assert.deepEqual(calls, ['create', 'get', 'revoke-initial-token', 'dispose']);
  assert.deepEqual(adapter.managementCleanupCounts(), { unsettled_dispatches: 0, repo_tokens_issued: 1, repo_tokens_revoked: 1, handles_open: 0 });
  await assert.rejects(adapter.provisionDisposableRepository(), (e: any) => e.code === 'ARTIFACT_PROVISION_REFUSED');
  assert.equal(calls.length, 4);
});
