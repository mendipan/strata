import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, appendFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { isProviderDiagnostic } from './provider-diagnostic.js';
import { randomUUID } from 'node:crypto';
import { createDemoDashboard } from './integrated-demo-dashboard.js';
import { approveBrowserDemoReview, createDemoActivationReview, readDemoActivationSource, validateLabInfrastructure,
  type DemoActivationReview, type DemoLabInfrastructure } from './integrated-demo-activation.js';
import { probeSubscriptionCli } from './integrated-demo-operator.js';
import { findCodexEntrypoint } from './integrated-demo-actor-cli.js';
import { runDemoOperatorCli } from '../scripts/integrated-demo-operator.js';
import { parseDemoLabTarget, type DemoLabTarget } from './demo-lab-config.js';

const exec = promisify(execFile);
export type DemoLabProfile = { format: 'strata.browser-demo-lab/1'; target: DemoLabTarget; source_sha256: string; infrastructure: DemoLabInfrastructure;
  diagnostic_passed: true; diagnostic_instance_absent: true; evidence: string; recorded_at: string };
type Check = { label: string; passed: boolean; at: string };
type LabOptions = {
  presentation_mode?: 'synthetic-fixture';
  allow_reminder_repair?: boolean;
  check?: (root: string, profile: DemoLabProfile, record: (label: string) => Promise<void>) => Promise<void>;
  run?: typeof runDemoOperatorCli;
  now?: () => number;
};

export async function checkDemoLabReadiness(root: string, profile: DemoLabProfile, record: (label: string) => Promise<void>) {
  const labTarget = parseDemoLabTarget(profile.target);
  for (const [name, expected] of [['wrangler', '4.147.0'], ['cf', '1.0.0-beta.12']]) {
    const pkg = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (pkg.version !== expected) throw new Error(`Expected pinned ${name} ${expected}. Restore lockfile dependencies before checking.`);
  }
  const source = await readDemoActivationSource(root);
  if (source.sha256 !== profile.source_sha256) throw new Error('Local code changed since the verified lab deployment. The operator must review and redeploy this source before a demo.');
  await record('Exact local source matches the verified diagnostic');
  await probeSubscriptionCli(root);
  await record('Codex is signed in with ChatGPT; no API billing fallback');
  const json = async (cli: 'wrangler' | 'cf', args: string[]) => {
    const file = cli === 'wrangler' ? 'node_modules/wrangler/bin/wrangler.js' : 'node_modules/cf/bin/cf';
    try {
      const output = await exec(process.execPath, [path.join(root, file), ...args], { cwd: root, windowsHide: true, timeout: 30000,
        maxBuffer: 1024 * 1024, env: { ...process.env, CI: 'true', CLOUDFLARE_ACCOUNT_ID: labTarget.account_id } });
      return JSON.parse(output.stdout);
    } catch { throw new Error(`${cli} ${args.slice(0, 2).join(' ')} check failed. Renew its access if needed, then explicitly check again. No run started.`); }
  };
  const wrangler = await json('wrangler', ['whoami', '--json']);
  const cf = await json('cf', ['auth', 'whoami']);
  if (!wrangler.loggedIn || wrangler.authType !== 'OAuth Token' || !cf.authenticated || !cf.tokenValid ||
    ![wrangler, cf].every(a => a.accounts?.some((v: any) => v.id === labTarget.account_id)) ||
    !['account:read', 'workers_scripts:write', 'artifacts:write'].every(v => wrangler.tokenPermissions?.includes(v)) ||
    !['account:read', 'workers-scripts.read'].every(v => cf.scopes?.includes(v)))
    throw new Error('The intended Cloudflare account or required permissions are unverified. Use the corresponding sign-in button and check again.');
  await record('Both Cloudflare sign-ins and required account permissions verified');
  const worker = await json('wrangler', ['deployments', 'list', '--name', labTarget.worker_name, '--json']);
  const latest = Array.isArray(worker) && [...worker].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  if (!latest || latest.versions?.length !== 1 || latest.versions[0].percentage !== 100 || latest.versions[0].version_id !== profile.infrastructure.worker_version_id)
    throw new Error('Persistent Worker deployment differs from the verified version. Owner reconciliation is required.');
  const version = await json('wrangler', ['versions', 'view', profile.infrastructure.worker_version_id, '--name', labTarget.worker_name, '--json']);
  const bindings = version.resources?.bindings;
  if (version.id !== profile.infrastructure.worker_version_id || !Array.isArray(bindings) ||
    !bindings.some((b: any) => b.name === 'STRATA_LAB_SOURCE_SHA256' && b.text === profile.source_sha256) ||
    !bindings.some((b: any) => b.name === 'STRATA_LAB_TARGET' && b.text === JSON.stringify(labTarget)) ||
    !bindings.some((b: any) => b.type === 'artifacts' && b.name === 'ARTIFACTS' && b.namespace === labTarget.namespace_id))
    throw new Error('Deployed lab source or Artifacts binding is unverified.');
  await record('Exact persistent Worker version and source binding verified');
  const workflow = await json('wrangler', ['workflows', 'describe', labTarget.workflow_name, '--json']);
  if (workflow.id !== profile.infrastructure.workflow_id || workflow.latest_version?.id !== profile.infrastructure.workflow_version_id ||
    workflow.script_name !== labTarget.worker_name || workflow.class_name !== 'StrataIntegratedDemoWorkflow')
    throw new Error('Workflow identity or linked version changed. Owner reconciliation is required.');
  const instances = await json('wrangler', ['workflows', 'instances', 'list', labTarget.workflow_name, '--per-page', '100', '--json']);
  const repos = await json('wrangler', ['artifacts', 'repos', 'list', '--namespace', labTarget.namespace_id, '--json']);
  if (!Array.isArray(instances) || instances.length || !Array.isArray(repos) || repos.length)
    throw new Error('An instance or repository remains. Finish exact resource reconciliation before another demo.');
  await record('Workflow version verified; no previous instances or repositories remain');
  const access = await json('cf', ['workflows', 'list', '--page', '1', '--per-page', '1']);
  if (!Array.isArray(access) || access.length > 1) throw new Error('Full-step read access is unverified.');
  await record('Full Workflow output read access verified; model execution remains untested');
}

export function demoLabCleanupVerified(journal: any): boolean {
  const c = journal?.cleanup;
  return !!c && !journal.in_flight && !journal.reconciliation_required && c.terminal_instance_verified === true &&
    c.local_dispatches_settled === true && c.repo_tokens_clean === true && c.handles_disposed === true && c.instance_absent === true &&
    c.repository_absent === true && c.namespace_empty_verified === true && c.workflow_retained_verified === true && c.worker_retained_verified === true &&
    c.worker_delete_requested === false && c.workflow_delete_requested === false;
}

export async function createBrowserDemoLab(root: string, options: LabOptions = {}) {
  root = path.resolve(root);
  const now = options.now ?? Date.now, base = path.join(root, '.strata');
  await mkdir(base, { recursive: true });
  const lockPath = path.join(base, 'demo-browser-host.json'), activePath = path.join(base, 'attended-demo-active.json');
  try { await writeFile(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('A browser controller already owns this checkout. Use its existing link and terminal.');
    await rename(lockPath, lockPath + '.stale-' + randomUUID());
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  }
  let status = 'Check readiness to prepare your demo', message = '', checks: Check[] = [], busy = false, running = false;
  let review: DemoActivationReview | undefined, profile: DemoLabProfile, evidence = '', preparedAt = 0, checkCount = 0, controller: AbortController | undefined;
  let currentWork: Promise<unknown> | undefined, closed = false, pendingCleanup = false;
  const exists = async (file: string) => readFile(file, 'utf8').then(() => true).catch((e: any) => { if (e.code === 'ENOENT') return false; throw e; });
  pendingCleanup = await exists(activePath);
  const save = (name: string, value: unknown) => writeFile(path.join(evidence, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  const state = () => ({ status, message, checks, busy, running, evidence, reminder_repair_enabled: options.allow_reminder_repair === true,
    can_begin: !!review && !busy && !running && !pendingCleanup && now() - preparedAt < 300000,
    can_fresh: !running && !busy && !pendingCleanup, review: review ? { target: review.target, limits: review.limits,
      infrastructure: review.infrastructure, source_sha256: review.source.sha256, review_sha256: review.review_sha256 } : null });
  const runCheck = async () => {
    review = undefined; checks = []; preparedAt = 0;
    if (await exists(activePath)) throw new Error('A previous run needs cleanup reconciliation. Preserve .strata/attended-demo-active.json; no new grant will be created.');
    if (++checkCount > 8) throw new Error('This controller reached its eight readiness-check limit. No run started.');
    status = 'Checking readiness'; message = 'Read-only checks. No grant, coding actor or repository token is created.';
    const runId = randomUUID().replaceAll('-', '').slice(0, 16);
    evidence = path.join(base, 'browser-' + runId); await mkdir(evidence, { mode: 0o700 });
    dashboard.resetRun(runId); dashboard.finish();
    profile = JSON.parse(await readFile(path.join(base, 'demo-lab-profile.json'), 'utf8'));
    const target = { ...parseDemoLabTarget(profile.target), project_id: 'strata-local-demo', run_id: runId, instance_id: 'run-' + runId, repository_name: 'strata-run-' + runId };
    if (profile.format !== 'strata.browser-demo-lab/1' || profile.diagnostic_passed !== true || profile.diagnostic_instance_absent !== true)
      throw new Error('The persistent lab has no verified diagnostic profile. Ask the operator to finish its setup.');
    validateLabInfrastructure(profile.infrastructure, target);
    await (options.check ?? checkDemoLabReadiness)(root, profile, async label => {
      checks.push({ label, passed: true, at: new Date(now()).toISOString() });
      await appendFile(path.join(evidence, 'readiness.jsonl'), JSON.stringify(checks.at(-1)) + '\n', { mode: 0o600 });
    });
    const source = await readDemoActivationSource(root);
    if (source.sha256 !== profile.source_sha256) throw new Error('Source changed during the checks. Prepare again after the operator verifies the deployed code.');
    review = createDemoActivationReview('browser-' + runId, target, source, profile.infrastructure, options.allow_reminder_repair === true);
    await save('review.json', review); preparedAt = now(); pendingCleanup = false;
    status = 'Ready — you can begin one demo'; message = 'Review the limits, enter your name and click Begin demo. Readiness is valid for five minutes; the run clock starts on Begin.';
  };
  const completeRun = async (grantPath: string, grant: ReturnType<typeof approveBrowserDemoReview>) => {
    controller = new AbortController(); running = true; status = 'Demo running'; message = 'Watch the timeline. You will be asked for the conflict choice and a separate Release decision.';
    dashboard.resetRun(grant.target.run_id);
    const terminal = { stdin_is_tty: false, stdout_is_tty: false, write: (text: string) => process.stdout.write(text),
      ask: async () => { throw new Error('This run requires its browser decision.'); } };
    try {
      await (options.run ?? runDemoOperatorCli)(['start', grantPath, path.join(evidence, 'run')], { root, terminal,
        signal: controller.signal, browser_approval: { action: 'begin-demo', grant_sha256: grant.grant_sha256 },
        emit: record => dashboard.emit(record), decide: (packet, signal) => dashboard.decide(packet, signal) });
      status = 'Demo ended'; message = 'Inspect the result and cleanup below.';
    } catch (error: any) {
      status = 'Demo stopped'; message = (error.code ?? 'DEMO_FAILED') + ': ' + error.message;
      await save('failure.json', { code: error.code ?? 'DEMO_FAILED', message: error.message, cleanup_code: error.cleanup_error?.code ?? null,
        ...(isProviderDiagnostic(error.details) ? { diagnostic: error.details } : {}),
        ...(isProviderDiagnostic(error.cleanup_error?.details) ? { cleanup_diagnostic: error.cleanup_error.details } : {}),
        automatic_retry: false, costs_verified: false });
      await dashboard.emit({ type: 'run-failed', code: error.code ?? 'DEMO_FAILED', message, startup_failed: error.code === 'DEMO_PROVIDER_WORKER_NOT_FOUND' });
    } finally {
      const journal = await readFile(path.join(evidence, 'run/management-journal.json'), 'utf8').then(JSON.parse).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
      const noDispatch = journal === null || (!journal.instance_create_requested && !journal.in_flight && !journal.reconciliation_required &&
        journal.history.every((h: any) => h.action.startsWith('preflight-') && h.result === 'complete'));
      const cleaned = demoLabCleanupVerified(journal);
      if (cleaned || noDispatch) {
        await rename(activePath, path.join(evidence, 'completed-active-marker.json')); pendingCleanup = false;
        message += cleaned ? ' Cleanup verified. The private test pair and local evidence are retained.' : ' No remote mutation was dispatched; the consumed grant is retained.';
      } else { pendingCleanup = true; message += ' Cleanup is not verified. Preserve the evidence; owner reconciliation is required before another demo.'; }
      running = false; busy = false; controller = undefined; dashboard.finish();
    }
  };
  const launch = (work: () => Promise<unknown>) => {
    busy = true;
    currentWork = work().catch((error: any) => { status = 'Attention needed'; message = error.message; review = undefined; console.error(message); })
      .finally(() => { busy = false; });
    return { accepted: true };
  };
  const dashboard = await createDemoDashboard('not-started', () => controller?.abort(), { state, handle: async (action, input) => {
    if (closed || busy || running) throw new Error('The current action is still running. Wait for its result.');
    if (['check', 'fresh'].includes(action)) return launch(runCheck);
    if (action === 'signin') {
      if (pendingCleanup) throw new Error('Reconcile the unfinished run before changing this controller’s access.');
      if (!['wrangler', 'cf', 'codex'].includes(input.provider)) throw new Error('Unknown sign-in provider.');
      review = undefined;
      return launch(async () => {
        status = 'Complete sign-in in the provider page'; message = 'Your terminal shows any device code. This does not begin a demo.';
        const entry = input.provider === 'codex' ? await findCodexEntrypoint(process.env) : path.join(root, input.provider === 'cf' ? 'node_modules/cf/bin/cf' : 'node_modules/wrangler/bin/wrangler.js');
        const args = input.provider === 'cf' ? ['auth', 'login', '--scopes', 'user:read', 'account:read', 'workers-scripts.read', 'offline'] : ['login'];
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [entry, ...args], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
          const timer = setTimeout(() => { child.kill(); reject(new Error('Sign-in timed out. No demo started.')); }, 300000);
          child.once('error', e => { clearTimeout(timer); reject(e); });
          child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Sign-in did not complete. No demo started.')); });
        });
        status = 'Sign-in finished — check readiness'; message = 'Click Check readiness to verify actual permissions.';
      });
    }
    if (action !== 'begin' || !state().can_begin || !review || input.consent !== true || input.run_id !== review.target.run_id)
      throw new Error('Prepare a fresh, current review and explicitly approve it before Begin.');
    busy = true; // Reserve immediately, before any await; duplicate clicks cannot create grants.
    try {
      const source = await readDemoActivationSource(root);
      const grant = approveBrowserDemoReview(review, source, input, now());
      if (await exists(activePath)) throw new Error('Another run claimed this checkout. No new run may start.');
      await save('grant.json', grant);
      await writeFile(activePath, JSON.stringify({ run_id: grant.target.run_id, target: grant.target, evidence, grant_sha256: grant.grant_sha256 }), { flag: 'wx', mode: 0o600 });
      pendingCleanup = true; review = undefined;
      currentWork = completeRun(path.join(evidence, 'grant.json'), grant).catch(error => {
        status = 'Cleanup needs operator attention'; message = String(error); running = false; busy = false; pendingCleanup = true; dashboard.finish();
      });
      return { accepted: true, run_id: grant.target.run_id };
    } catch (error) { busy = false; review = undefined; throw error; }
  } }, { source_mode: options.presentation_mode });
  dashboard.finish();
  return { url: dashboard.url, state,
    check: () => { if (busy || running) throw new Error('Busy'); return launch(runCheck); },
    async settled() { await currentWork; },
    async close() { closed = true; controller?.abort(); await currentWork; await dashboard.close(); await unlink(lockPath); }
  };
}
