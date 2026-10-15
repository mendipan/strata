// Test-only preload: the production CLI is spawned unchanged. Replace native
// child-process/terminal boundaries, never the reviewed session or actor runner.
import childProcess from 'node:child_process';
import readline from 'node:readline/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { demoFixture } from './integrated-demo-fixture.js';
import { rehearsalLayer } from '../src/integrated-demo.js';
import { checkpointDigest } from '../src/integrated-demo.js';

const grant = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const scenario = process.env.STRATA_OPERATOR_TEST_SCENARIO ?? 'complete';
const fixture = demoFixture('controlled-private', grant.started_at);
const target = grant.target;
let instance = false, worker = !!grant.infrastructure, workflow = !!grant.infrastructure, repository = false, lastOutcome: unknown;
let active = 0, maximum = 0, launched = 0;
const calls: string[] = [], profiles: unknown[] = [], prompts: string[] = [];
const claim = { type: 'step', success: true, name: scenario === 'full-step' ? 'claim-run-1' : 'claim-run', output: structuredClone(fixture.checkpoint) };
const steps: any[] = [claim];
const proofPath = process.env.STRATA_OPERATOR_TEST_PROOF!;
process.on('exit', () => writeFileSync(proofPath, JSON.stringify({ scenario, calls, launched, maximum, profiles, prompts,
  checkpoint: fixture.checkpoint, events: fixture.events, resources: { instance, worker, workflow, repository },
  initial_repository_token: { issued: 1, revoked: 1 }, cleanup: fixture.storage().managementCleanupCounts() }, null, 2)));
Object.defineProperty(process.stdin, 'isTTY', { value: !grant.infrastructure }); Object.defineProperty(process.stdout, 'isTTY', { value: !grant.infrastructure });
const originalNow = Date.now; let timeOverride: number | undefined; Date.now = () => timeOverride ?? originalNow();
(readline as any).createInterface = () => ({ close() {}, async question(prompt: string) {
  prompts.push(prompt);
  if (prompt.includes('grant digest')) return scenario === 'bad-digest' ? 'bad' : grant.grant_sha256;
  if (prompt.startsWith('Conflict')) {
    if (scenario === 'interrupt') { process.emit('SIGINT'); return new Promise(() => {}); }
    if (scenario === 'cleanup-boundary') { timeOverride = grant.expires_at - 149_000; return '900'; }
    if (scenario === 'expired') { timeOverride = grant.expires_at; return '900'; }
    return scenario === 'repair' ? '1200' : '900';
  }
  if (prompt.startsWith('Separate Release')) return scenario === 'defer-release' ? 'defer' : 'approve-release';
  return 'Synthetic test operator decision; no actual consent or live provider.';
} });

const result = (callback: any, code: number, stdout: string, stderr = '') => {
  const error = code ? Object.assign(new Error('mock subprocess failure'), { code }) : null;
  callback(error, stdout, stderr);
};
(childProcess as any).execFile = (exe: string, args: string[], options: any, callback: any) => {
  void (async () => {
    if (args[0].endsWith('node_modules/cf/bin/cf') || args[0].endsWith('node_modules\\cf\\bin\\cf')) {
      if (args[1] === 'workflows' && args[2] === 'list') {
        if (options.env.CLOUDFLARE_ACCOUNT_ID !== target.account_id || options.env.CI !== 'true') throw new Error('Unexpected cf access target');
        calls.push('full-step-preflight');
        return result(callback, scenario === 'full-step-auth-missing' ? 1 : 0, '[]', '');
      }
      if (scenario !== 'full-step' || options.env.CLOUDFLARE_ACCOUNT_ID !== target.account_id || options.env.CI !== 'true' ||
          args[5] !== target.instance_id || args[args.indexOf('--workflow-name') + 1] !== target.workflow_name ||
          args[args.indexOf('--type') + 1] !== 'step' || args[args.indexOf('--attempt') + 1] !== '1') throw new Error('Unexpected full-step target');
      const name = args[args.indexOf('--name') + 1], step = steps.find(step => step.name === name);
      if (!step) throw new Error('Unexpected full-step name');
      calls.push('full-step:' + name);
      return result(callback, 0, JSON.stringify({ success: true, errors: [], messages: [],
        result: { status: 'complete', error: null, output: step.output } }));
    }
    if (!args[0].includes('wrangler')) {
      calls.push('cli:' + args.slice(1).join(' '));
      if (args.includes('--version')) return result(callback, 0, 'codex-cli 0.160.1\n');
      if (args.includes('--help')) return result(callback, 0, '--model --sandbox --ephemeral --json --ignore-user-config --skip-git-repo-check');
      return result(callback, scenario === 'auth-mismatch' ? 1 : 0, '', scenario === 'auth-mismatch' ? 'Not logged in' : 'Logged in using ChatGPT');
    }
    const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
    if (config.account_id !== target.account_id || config.workers_dev !== false || config.preview_urls !== false || config.name !== target.worker_name)
      throw new Error('Exact private target/config mismatch');
    const command = args.slice(3), first = command[0];
    calls.push(command.join(' ').split('{')[0].trim());
    if (first === 'deployments') {
      if (grant.infrastructure) return result(callback, 0, JSON.stringify([{ created_on: new Date().toISOString(), versions: [{ version_id: grant.infrastructure.worker_version_id, percentage: 100 }] }]));
      if (worker) return result(callback, 0, '[]');
      return result(callback, 1, '', `Cloudflare API (/accounts/${target.account_id}/workers/scripts/${target.worker_name}/deployments) This Worker does not exist on your account. [code: 10007]`);
    }
    if (first === 'deploy') {
      if (scenario === 'deploy-failure') return result(callback, 1, '', 'HTTP 400 [code: 10021] environment variable size limit Authorization: Bearer secret-fixture');
      worker = workflow = repository = true; return result(callback, 0, 'mock deployment accepted');
    }
    if (first === 'artifacts') {
      if (command[2] === 'delete') { repository = false; return result(callback, 0, JSON.stringify({ deleted: true, name: target.repository_name, namespace: target.namespace_id })); }
      return result(callback, 0, JSON.stringify(repository ? [{ name: target.repository_name }] : []));
    }
    if (first !== 'workflows') throw new Error('Unexpected subprocess');
    if (command[1] === 'describe' && grant.infrastructure) return result(callback, 0, JSON.stringify({ name: target.workflow_name,
      id: grant.infrastructure.workflow_id, script_name: target.worker_name, class_name: 'StrataIntegratedDemoWorkflow', latest_version: { id: grant.infrastructure.workflow_version_id } }));
    if (command[2] === 'list' && grant.infrastructure) return result(callback, 0, JSON.stringify(instance ? [{ id: target.instance_id }] : []));
    if (command[1] === 'list') return result(callback, 0, JSON.stringify(workflow ? [{ name: target.workflow_name }] : []));
    if (command[1] === 'delete') { workflow = false; return result(callback, 0, '{}'); }
    if (command[1] === 'trigger') {
      if (grant.infrastructure && JSON.parse(command[3]).activation_grant?.grant_sha256 !== grant.grant_sha256) throw new Error('Missing exact browser grant parameter');
      instance = true; repository = true; return result(callback, 0, JSON.stringify({ id: target.instance_id })); }
    if (command[2] === 'delete') { instance = false; return result(callback, 0, JSON.stringify({ deleted: [target.instance_id] })); }
    if (command[2] === 'send-event') {
      if (scenario === 'provider-failure') return result(callback, 1, '', 'uncertain provider');
      const event = JSON.parse(command[command.indexOf('--payload') + 1]);
      fixture.setNow(Date.now());
      const applied = await fixture.sendEvent(event); lastOutcome = applied.outcome;
      steps.push({ type: 'step', success: true, name: 'apply-' + event.sequence + (scenario === 'full-step' ? '-1' : ''), output: applied });
      return result(callback, 0, '{}');
    }
    if (command[2] === 'describe') {
      if (!instance) return result(callback, 1, '', `Cloudflare API (/accounts/${target.account_id}/workflows/${target.workflow_name}/instances/${target.instance_id}) not found`);
      const cp = fixture.checkpoint, counts = fixture.storage().managementCleanupCounts();
      const status = ['complete', 'aborted', 'failed'].includes(cp.phase) ? 'complete' : 'waiting';
      const described = scenario === 'full-step' ? steps.map(step => ({ ...step,
        output: JSON.stringify(step.output).slice(0, 1024) + '[truncated output]' })) : steps;
      return result(callback, 0, JSON.stringify({ id: target.instance_id, status, steps: described, output: {
        checkpoint: { ...cp, counters: { ...cp.counters, artifact_reserved: cp.counters.artifact_reserved + 3 } },
        management_cleanup: { ...counts, repo_tokens_issued: Number(counts.repo_tokens_issued) + 1,
          repo_tokens_revoked: Number(counts.repo_tokens_revoked) + 1 } }, outcome: lastOutcome }));
    }
    throw new Error('Unsupported mocked command');
  })().catch(error => result(callback, 1, '', error.message));
  return { kill() {} };
};
(childProcess as any).spawn = (exe: string, args: string[], options: any) => {
  const child: any = new EventEmitter(); child.pid = undefined;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', 1); child.emit('close', 1, null); return true; };
  if (args[0].includes('wrangler')) {
    calls.push('delete-worker'); worker = false; queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0, null); }); return child;
  }
  launched++; active++; maximum = Math.max(maximum, active);
  if (options.env.OPENAI_API_KEY || options.env.CLOUDFLARE_API_TOKEN || args.includes('--dangerously-bypass-approvals-and-sandbox')) throw new Error('Credential/security boundary violated');
  let input = ''; child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
  child.stdin.on('finish', () => { void (async () => {
    const actor = input.includes('"id":"L-hold"') ? 'a' : input.includes('"id":"L-alternative"') ? 'c' : 'b';
    profiles.push({ actor, args, prompt_bytes: Buffer.byteLength(input) });
    child.stdout.write('{"type":"turn.started"}\n');
    await new Promise(resolve => setTimeout(resolve, 10)); // AC overlap is observable
    if (scenario === 'actor-no-tools') {
      child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Mock: tool unavailable.' } }) + '\n');
      child.stderr.write('Mock startup diagnostic ' + options.env.STRATA_DEMO_ACTOR_CAPABILITY);
      child.stdout.write('{"type":"turn.completed"}\n'); active--; child.emit('exit', 0); child.emit('close', 0, null); return;
    }
    const repaired = actor === 'b' && fixture.checkpoint.phase === 'repair';
    const record = rehearsalLayer(actor, repaired);
    const operations = [{ command: 'status', input: {} }, { command: 'inspect', input: { type: 'release', ref: 'R0@1' } },
      ...(actor === 'b' ? ['L-hold@1', 'L-alternative@1'].map(ref => ({ command: 'inspect', input: { type: 'layer', ref } })) : []),
      { command: repaired ? 'layer.revise' : 'layer.create', input: { record, ...(repaired ? { previous: 'L-reminder@1' } : {}) } },
      { command: 'layer.publish', input: { ref: record.id + '@' + record.revision } }];
    for (const operation of operations) {
      const response = await fetch(options.env.STRATA_DEMO_ACTOR_ENDPOINT, { method: 'POST',
        headers: { authorization: 'Bearer ' + options.env.STRATA_DEMO_ACTOR_CAPABILITY, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
      const body = await response.json() as any;
      if (body.result?.outcome?.ok !== true) throw new Error('Mock actor operation failed: ' + JSON.stringify(body));
    }
    // Fail the named actor deterministically: two concurrent failures otherwise race
    // to cancel each other before actor-a's expected diagnostics can be saved.
    child.stdout.write('{"type":"turn.completed"}\n'); active--;
    const code = scenario === 'actor-failure' && actor === 'a' ? 1 : 0; child.emit('exit', code); child.emit('close', code, null);
  })().catch(error => { active--; child.stderr.write(error.message); child.emit('exit', 1); child.emit('close', 1, null); }); });
  return child;
};
(childProcess.execFile as any)[promisify.custom] = (exe: string, args: string[], options: any) => new Promise((resolve, reject) => {
  (childProcess.execFile as any)(exe, args, options, (error: unknown, stdout: string, stderr: string) => {
    if (error) reject(error); else resolve({ stdout, stderr });
  });
});
syncBuiltinESMExports();
