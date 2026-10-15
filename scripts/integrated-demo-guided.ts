import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, appendFile, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDemoActivationCli } from './integrated-demo-activation.js';
import { runDemoOperatorCli } from './integrated-demo-operator.js';
import { probeSubscriptionCli } from '../src/integrated-demo-operator.js';
import { createDemoDashboard } from '../src/integrated-demo-dashboard.js';
import { preflightDemoAccess } from '../src/integrated-demo-management-wrangler.js';
import { parseDemoLabTarget } from '../src/demo-lab-config.js';
import { fail } from '../src/model.js';

const exec = promisify(execFile);

export function guidedIdentityMatches(wrangler: any, cf: any, account: string): boolean {
  return wrangler.loggedIn === true && wrangler.authType === 'OAuth Token' && cf.authenticated === true && cf.tokenValid === true &&
    [wrangler, cf].every(auth => Array.isArray(auth.accounts) && auth.accounts.some((available: any) => available.id === account)) &&
    ['account:read', 'workers_scripts:write', 'artifacts:write'].every(scope => wrangler.tokenPermissions?.includes(scope)) &&
    ['account:read', 'workers-scripts.read'].every(scope => cf.scopes?.includes(scope));
}

async function checkIdentity(root: string, account: string) {
  const cli = await probeSubscriptionCli(root);
  const json = async (file: string, args: string[]) => {
    try { const result = await exec(process.execPath, [path.join(root, file), ...args], { cwd: root, windowsHide: true,
      timeout: 30_000, maxBuffer: 256 * 1024, env: { ...process.env, CI: 'true', CLOUDFLARE_ACCOUNT_ID: account } });
      return JSON.parse(result.stdout); }
    catch { fail('DEMO_GUIDED_AUTH_REQUIRED', 7, 'Cloudflare identity check failed. Run ./scripts/start-attended-demo.ps1 -SignIn; no grant created.'); }
  };
  const wrangler = await json('node_modules/wrangler/bin/wrangler.js', ['whoami', '--json']);
  const cf = await json('node_modules/cf/bin/cf', ['auth', 'whoami']);
  if (!guidedIdentityMatches(wrangler, cf, account))
    fail('DEMO_GUIDED_AUTH_REQUIRED', 7, 'Expected account and CLI OAuth permissions are unverified. Run the launcher with -SignIn before another check. No grant created.');
  // Keep only evidence of checks, never authSource, raw identity responses or credentials.
  return { checked_at: new Date().toISOString(), account_id: account, wrangler_oauth: true, cf_oauth: true,
    required_scopes_present: true, codex: { version: cli.version, billing_mode: cli.billing_mode, model_availability_verified: false } };
}

export async function runGuidedDemo(args: string[]) {
  if (!['check', 'start'].includes(args[0]) || args.slice(1).some(arg => arg !== '--no-browser') || args.length > 2)
    fail('DEMO_GUIDED_USAGE', 2, 'Use scripts/start-attended-demo.ps1 [-CheckOnly] [-SignIn] [-NoBrowser].');
  if (args[0] === 'start' && (!process.stdin.isTTY || !process.stdout.isTTY)) fail('DEMO_ACTIVATION_TTY_REQUIRED', 7, 'Open an ordinary PowerShell terminal. Redirected attendance is refused.');
  const binding = parseDemoLabTarget({ account_id: process.env.STRATA_DEMO_ACCOUNT_ID, namespace_id: process.env.STRATA_DEMO_NAMESPACE, worker_name: 'guided-placeholder', workflow_name: 'guided-placeholder' });
  const account = binding.account_id, namespace = binding.namespace_id;
  const root = process.cwd(), run = randomUUID().replaceAll('-', '').slice(0, 16);
  const activeFile = path.join(root, '.strata', 'attended-demo-active.json');
  if (args[0] === 'start') {
    const active = await readFile(activeFile, 'utf8').catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
    if (active) fail('DEMO_GUIDED_RECONCILE_REQUIRED', 7, 'An earlier guided run has not verified cleanup. Preserve ' + activeFile + ' and reconcile its exact target before starting another run.');
  }
  const target = { account_id: account, project_id: 'strata-local-demo', run_id: run,
    worker_name: 'strata-demo-' + run, workflow_name: 'strata-demo-flow-' + run, instance_id: 'run-' + run,
    namespace_id: namespace, repository_name: 'strata-run-' + run };
  const directory = path.join(root, '.strata', 'guided-' + run);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Evidence directory: ' + directory);
  console.log('1/4 Checking ChatGPT authentication, both Cloudflare identities and actual account access. No grant exists yet.');
  try {
    await save('identity-checks.json', await checkIdentity(root, account));
    await save('exact-target.json', target);
    const config = JSON.parse(await readFile(path.join(root, 'wrangler.integrated-demo.json'), 'utf8'));
    await save('preflight.wrangler.json', { ...config, account_id: account, name: target.worker_name,
      main: path.join(root, 'src/integrated-demo-worker-entry.ts'), workflows: [{ ...config.workflows[0], name: target.workflow_name }] });
    await preflightDemoAccess(target, root, path.join(directory, 'preflight.wrangler.json'), async record => {
      await appendFile(path.join(directory, 'access-checks.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
      const check = record as { action: string; status: string };
      if (check.status === 'passed') console.log('Access check passed: ' + check.action.replace('preflight-', '') + '.');
    });
    await runDemoActivationCli(['prepare', path.join(directory, 'exact-target.json'), path.join(directory, 'review.json'), 'guided-' + run], undefined, undefined, root);
    if (args[0] === 'check') { console.log('CHECK PASSED. No grant, deployment, actor, repository token or event was created. Model execution remains unverified.'); return; }
    const controller = new AbortController();
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); readline.on('SIGINT', interrupt);
    const terminal = { stdin_is_tty: process.stdin.isTTY === true, stdout_is_tty: process.stdout.isTTY === true,
      write: (text: string) => process.stdout.write(text), ask: (prompt: string) => readline.question(prompt, { signal: controller.signal }) };
    const dashboard = await createDemoDashboard(run, () => controller.abort());
    try {
      console.log('\n2/4 Browser progress page: ' + dashboard.url);
      if (!args.includes('--no-browser') && process.platform === 'win32') {
        // A user-requested visible browser; the helper itself has no visible window.
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $env:STRATA_DEMO_BROWSER_URL'],
          { windowsHide: true, stdio: 'ignore', env: { ...process.env, STRATA_DEMO_BROWSER_URL: dashboard.url } });
        child.on('error', () => console.log('Open the browser link above manually.'));
      }
      console.log('Review the resources and limits below, enter your name, then type START DEMO once. No numbers to copy.');
      console.log('The 30-minute clock starts after that confirmation.');
      console.log('US$1 is a stop target, not a guaranteed billing cap; costs cannot currently be metered here.');
      console.log('In the browser, a 15-minute booking hold can complete this demo. A 20-minute hold stops at the additional-actor repair gate.');
      if (controller.signal.aborted) throw new Error('Stopped before grant creation.');
      const approval = await runDemoActivationCli(['confirm', path.join(directory, 'review.json'), path.join(directory, 'grant.json')], undefined, terminal, root);
      if (controller.signal.aborted) throw new Error('Stopped; grant was not launched. Do not reuse it.');
      console.log('\n3/4 Starting your confirmed run. Keep this terminal open; watch the browser.');
      console.log('After this: watch the browser, provide your conflict reason/choice, then review the separate Release gate.');
      await writeFile(activeFile, JSON.stringify({ run_id: run, target, evidence: directory }), { flag: 'wx', mode: 0o600 });
      try {
        const result: any = await runDemoOperatorCli(['start', path.join(directory, 'grant.json'), path.join(directory, 'run')],
          { root, terminal, signal: controller.signal, confirmed_grant_sha256: (approval as any).grant_sha256,
            emit: record => dashboard.emit(record), decide: (packet, signal) => dashboard.decide(packet, signal) });
        console.log('\n4/4 Finished. ' + JSON.stringify({ released: result.released, cleanup: result.cleanup?.cleanup, counters: result.cleanup?.counters }));
        console.log('Evidence: ' + directory + '\nProvider costs remain unverified. Namespace and local evidence were retained.');
      } catch (error: any) {
        const failedBeforeEntry = error.code === 'DEMO_PROVIDER_WORKER_NOT_FOUND';
        await dashboard.emit({ type: 'run-failed', code: error.code ?? 'DEMO_GUIDED_FAILED', cleanup_code: error.cleanup_error?.code,
          startup_failed: failedBeforeEntry,
          message: failedBeforeEntry
            ? 'Cloudflare could not load the Worker. No application step, coding agent, conflict choice or Release ran. Your confirmation was accepted. No automatic retry.'
            : 'The run stopped. Your terminal has the specific error. Keep the evidence; no automatic retry or new grant.' });
        console.error('Run stopped: ' + (error.code ?? 'DEMO_GUIDED_FAILED') + '. ' + error.message);
        console.error('Evidence: ' + directory + '. Keep all files; no retry will occur.');
        dashboard.finish();
        if (!controller.signal.aborted) await terminal.ask('Review the browser result and terminal error. Press Enter to close the viewer: ');
        throw error;
      } finally {
        dashboard.finish();
        const journalPath = path.join(directory, 'run', 'management-journal.json');
        const journal = await readFile(journalPath, 'utf8').then(JSON.parse).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
        if (journal === null || (journal.cleanup?.namespace_empty_verified === true && !journal.reconciliation_required && !journal.in_flight))
          await unlink(activeFile);
      }
      await terminal.ask('Review the final browser/terminal result. Press Enter to close the local viewer: ');
    } finally { dashboard.finish(); await dashboard.close(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); readline.close(); }
  } catch (error: any) {
    await save('launcher-failure.json', { code: error.code ?? 'DEMO_GUIDED_FAILED', cleanup_code: error.cleanup_error?.code ?? null,
      recorded_at: new Date().toISOString(), evidence: directory, costs_verified: false, automatic_retry: false });
    console.error('STOPPED: ' + (error.code ?? 'DEMO_GUIDED_FAILED') + '. ' + error.message);
    console.error('Evidence: ' + directory);
    if (['DEMO_GUIDED_AUTH_REQUIRED', 'DEMO_ACCESS_REFUSED'].includes(error.code)) console.error('Preparation failed before grant creation. No deployment, repository token or coding actor was started.');
    else console.error('If run/management-journal.json exists and cleanup is not verified, preserve everything and ask the operator to reconcile this exact target. Do not start another run.');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await runGuidedDemo(process.argv.slice(2)); }
  catch (error: any) {
    console.error((error.code ?? 'DEMO_GUIDED_FAILED') + ': ' + error.message);
    process.exitCode = error.code === 'DEMO_GUIDED_AUTH_REQUIRED' ? 10 : error.code === 'DEMO_ACCESS_REFUSED' ? 11 : 7;
  }
}
