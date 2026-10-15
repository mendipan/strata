import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBrowserDemoLab, demoLabCleanupVerified } from '../src/demo-browser-lab.js';
import { DEMO_ACTIVATION_SOURCE_FILES, readDemoActivationSource, approveBrowserDemoReview, createDemoActivationReview,
  validateDemoActivationGrant, type DemoLabInfrastructure } from '../src/integrated-demo-activation.js';
import { DemoManagementAdmissionPort, FileDemoManagementJournal, reviewedDemoManagementPlan } from '../src/integrated-demo-management.js';
import { DEMO_LAB } from './demo-lab-fixture.js';
import { digest } from '../src/model.js';
import { pathToFileURL } from 'node:url';

const infrastructure: DemoLabInfrastructure = { policy: 'retain-private-worker-workflow', workflow_id: '11111111-1111-4111-8111-111111111111',
  worker_version_id: '22222222-2222-4222-8222-222222222222', workflow_version_id: '33333333-3333-4333-8333-333333333333' };
const target = { ...DEMO_LAB, project_id: 'strata-local-demo', run_id: '0a1b2c3d4e5f6789', instance_id: 'run-0a1b2c3d4e5f6789', repository_name: 'strata-run-0a1b2c3d4e5f6789' };
const clean = { terminal_instance_verified: true, local_dispatches_settled: true, repo_tokens_clean: true, handles_disposed: true,
  instance_absent: true, repository_absent: true, namespace_empty_verified: true, workflow_retained_verified: true, worker_retained_verified: true,
  worker_delete_requested: false, workflow_delete_requested: false };

test('reminder repair needs a new exact browser review and cannot expand any other fixed limit', async () => {
  const source = await readDemoActivationSource(process.cwd());
  const old = createDemoActivationReview('repair-budget-test', target, source, infrastructure);
  const review = createDemoActivationReview('repair-budget-test', target, source, infrastructure, true);
  assert.equal(old.limits.actor_processes, 3); assert.equal(review.limits.actor_processes, 4);
  assert.deepEqual({ ...review.limits, actor_processes: 3 }, old.limits);
  assert.notEqual(old.review_sha256, review.review_sha256);
  assert.throws(() => approveBrowserDemoReview(review, source, { action: 'begin-demo', review_sha256: old.review_sha256, operator_label: 'SYNTHETIC' }));
  const grant = approveBrowserDemoReview(review, source, { action: 'begin-demo', review_sha256: review.review_sha256, operator_label: 'SYNTHETIC' });
  validateDemoActivationGrant(grant, source);
  for (const limits of [{ ...grant.limits, actor_processes: 5 }, { ...grant.limits, total_actor_turns: 16 }]) {
    const changed = { ...grant, limits } as any;
    const { grant_sha256: _hash, ...body } = changed; changed.grant_sha256 = digest(body);
    assert.throws(() => validateDemoActivationGrant(changed, source));
  }
  assert.throws(() => createDemoActivationReview('repair-no-lab', target, source, undefined, true));
});

test('browser approval binds deployment policy and current source, and persistent deletion/deployment are refused before dispatch', async () => {
  const source = await readDemoActivationSource(process.cwd()), review = createDemoActivationReview('browser-test', target, source, infrastructure);
  const grant = approveBrowserDemoReview(review, source, { action: 'begin-demo', review_sha256: review.review_sha256, operator_label: 'SYNTHETIC test' });
  validateDemoActivationGrant(grant, source);
  assert.equal(grant.approval.capture_method, 'local-browser'); assert.equal('typed_digest' in grant.approval, false);
  for (const property of ['worker_version_id', 'workflow_id', 'workflow_version_id', 'policy']) {
    const changed = structuredClone(grant); (changed.infrastructure as any)[property] = 'tampered';
    const { grant_sha256: _hash, ...body } = changed; changed.grant_sha256 = digest(body);
    assert.throws(() => validateDemoActivationGrant(changed, source));
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-lab-policy-')); let calls = 0;
  try {
    const port = new DemoManagementAdmissionPort(reviewedDemoManagementPlan(grant, source), new FileDemoManagementJournal(path.join(directory, 'journal.json')),
      { mode: 'mock-only', async call() { calls++; throw Error('must not dispatch'); } });
    for (const action of ['delete-worker', 'delete-workflow', 'deploy-private'] as const) await assert.rejects(port.cleanup(action), /retains/);
    await assert.rejects(port.createInstance(), /after its exact preflights/);
    assert.equal(calls, 0);
    for (const key of ['repo_tokens_clean', 'instance_absent', 'worker_retained_verified', 'workflow_retained_verified'])
      assert.equal(demoLabCleanupVerified({ cleanup: { ...clean, [key]: false } }), false);
    assert.equal(demoLabCleanupVerified({ cleanup: clean, in_flight: { action: 'describe' } }), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('persistent Worker refuses ungranted, stale-source, wrong-version, wrong-instance and expired browser parameters without provider I/O', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-lab-worker-'));
  const runtimeFile = path.resolve('dist/src', path.basename(directory) + '-runtime.mjs');
  const entry = path.resolve('dist/src', path.basename(directory) + '-entry.mjs');
  try {
    const platform = "import { WorkflowEntrypoint } from 'cloudflare:workers';";
    await writeFile(runtimeFile, (await readFile('dist/src/integrated-demo-worker-entry.js', 'utf8')).replace(platform, 'class WorkflowEntrypoint {}'));
    await writeFile(entry, (await readFile('dist/src/demo-lab-worker.js', 'utf8')).replace(platform, 'class WorkflowEntrypoint {}')
      .replace("'./integrated-demo-worker-entry.js'", JSON.stringify('./' + path.basename(runtimeFile))));
    const { labActivatedEnvironment, StrataIntegratedDemoWorkflow } = await import(pathToFileURL(entry).href);
    const source = await readDemoActivationSource(process.cwd()), review = createDemoActivationReview('worker-lab-test', target, source, infrastructure);
    const grant = approveBrowserDemoReview(review, source, { action: 'begin-demo', review_sha256: review.review_sha256, operator_label: 'SYNTHETIC worker test' });
    let calls = 0;
    const env = { ARTIFACTS: new Proxy({}, { get() { calls++; throw Error('Provider access forbidden'); } }),
      STRATA_LAB_TARGET: JSON.stringify(DEMO_LAB), STRATA_LAB_SOURCE_SHA256: source.sha256, STRATA_LAB_VERSION: { id: infrastructure.worker_version_id } };
    const event = { payload: { run_id: target.run_id, activation_grant: grant }, instanceId: target.instance_id };
    assert.equal(labActivatedEnvironment(env, event).STRATA_DEMO_ACTIVATION_GRANT_SHA256, grant.grant_sha256);
    assert.throws(() => labActivatedEnvironment(env, { ...event, payload: { run_id: target.run_id } }));
    assert.throws(() => labActivatedEnvironment({ ...env, STRATA_LAB_SOURCE_SHA256: '0'.repeat(64) }, event));
    assert.throws(() => labActivatedEnvironment({ ...env, STRATA_LAB_VERSION: { id: infrastructure.workflow_id } }, event));
    assert.throws(() => labActivatedEnvironment(env, { ...event, instanceId: 'run-other' }));
    assert.throws(() => labActivatedEnvironment(env, event, grant.expires_at));
    for (const key of ['account_id', 'namespace_id', 'worker_name', 'workflow_name']) {
      const changed = { ...DEMO_LAB, [key]: key === 'account_id' ? 'b'.repeat(32) : 'other-resource' };
      assert.throws(() => labActivatedEnvironment({ ...env, STRATA_LAB_TARGET: JSON.stringify(changed) }, event), /deployed source, version and exact run/);
    }
    assert.throws(() => labActivatedEnvironment({ ...env, STRATA_LAB_TARGET: undefined }, event));
    assert.throws(() => labActivatedEnvironment({ ...env, STRATA_LAB_TARGET: '{}' }, event));
    const workflow = new StrataIntegratedDemoWorkflow(); workflow.env = env;
    const entered: string[] = [];
    const start = await workflow.run(event, { do: async (name: string) => { entered.push(name); throw Error('SYNTHETIC stop before provider callback'); } });
    assert.deepEqual(entered, ['claim-run'], 'The actual valid browser envelope must reach the core claim step; approval metadata must not leak into its strict payload.');
    assert.notEqual(start.error?.code, 'DEMO_WORKFLOW_EVENT_REFUSED');
    assert.equal(calls, 0, 'This regression probe stops before invoking the provider callback.');
    const probe = 'a'.repeat(32);
    const output = await workflow.run({ payload: { probe }, instanceId: 'probe-' + probe }, { do: async (_name: any, _cfg: any, cb: any) => cb() });
    assert.equal(output.source_sha256, source.sha256); assert.equal(output.worker_version_id, infrastructure.worker_version_id);
    assert.equal(output.diagnostic, 'browser-lab-private-workflow'); assert.equal(calls, 0);
  } finally { await rm(entry, { force: true }); await rm(runtimeFile, { force: true }); await rm(directory, { recursive: true, force: true }); }
});

async function copiedRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-browser-control-'));
  for (const file of DEMO_ACTIVATION_SOURCE_FILES) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await copyFile(file, path.join(root, file)); }
  await mkdir(path.join(root, '.strata'));
  const source = await readDemoActivationSource(root);
  await writeFile(path.join(root, '.strata/demo-lab-profile.json'), JSON.stringify({ format: 'strata.browser-demo-lab/1', target: DEMO_LAB,
    source_sha256: source.sha256, infrastructure, diagnostic_passed: true, diagnostic_instance_absent: true, evidence: 'SYNTHETIC', recorded_at: new Date().toISOString() }));
  return root;
}

test('browser controller checks without grants, refuses stale/duplicate clicks, fresh run needs new approval and cleanup blocks replay', async () => {
  const root = await copiedRoot(); let launches = 0, failCleanup = false;
  const lab = await createBrowserDemoLab(root, { check: async (_r, _p, record) => { await record('SYNTHETIC read-only checks'); },
    run: async (args, overrides) => {
      launches++; await new Promise(resolve => setTimeout(resolve, 120));
      const grant = JSON.parse(await readFile(args[1], 'utf8')); assert.equal(overrides?.browser_approval?.grant_sha256, grant.grant_sha256);
      await mkdir(args[2]);
      await writeFile(path.join(args[2], 'management-journal.json'), JSON.stringify({ in_flight: null, reconciliation_required: failCleanup,
        cleanup: clean, history: [], instance_create_requested: true }));
      if (failCleanup) throw Error('SYNTHETIC uncertain cleanup');
      return { cleanup: { cleanup: clean }, released: null, live_authorized: true, model_availability_verified: false };
    } });
  const url = new URL(lab.url), headers = { authorization: 'Bearer ' + url.hash.slice(1), origin: url.origin, 'content-type': 'application/json' };
  const post = (action: string, body: unknown = {}, extra = {}) => fetch(url.origin + '/lab/' + action, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    await assert.rejects(createBrowserDemoLab(root), /already owns/);
    assert.equal((await post('check', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('check')).status, 200); await lab.settled();
    assert.equal(launches, 0); let state = lab.state(); assert.equal(state.can_begin, true);
    await assert.rejects(readFile(path.join(state.evidence, 'grant.json')), (e: any) => e.code === 'ENOENT');
    const firstRun = state.review!.target.run_id;
    const input = { run_id: firstRun, review_sha256: state.review!.review_sha256, operator_label: 'SYNTHETIC browser', action: 'begin-demo', consent: true };
    const responses = await Promise.all([post('begin', input), post('begin', input)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); await lab.settled(); assert.equal(launches, 1);
    assert.equal(lab.state().can_fresh, true); assert.equal((await post('begin', input)).status, 409);
    assert.equal((await post('fresh')).status, 200); await lab.settled(); state = lab.state();
    assert.notEqual(state.review!.target.run_id, firstRun); assert.equal(launches, 1);
    await writeFile(path.join(root, 'scripts/start-demo-browser.ps1'), '# Changed after review');
    assert.equal((await post('begin', { ...input, run_id: state.review!.target.run_id, review_sha256: state.review!.review_sha256 })).status, 409);
    assert.equal(launches, 1);
    await copyFile('scripts/start-demo-browser.ps1', path.join(root, 'scripts/start-demo-browser.ps1'));
    await post('fresh'); await lab.settled(); state = lab.state(); failCleanup = true;
    await post('begin', { ...input, run_id: state.review!.target.run_id, review_sha256: state.review!.review_sha256 }); await lab.settled();
    assert.equal(launches, 2); assert.equal(lab.state().can_fresh, false); assert.equal(lab.state().can_begin, false);
    assert.equal((await post('fresh')).status, 200); await lab.settled(); assert.equal(launches, 2); assert.match(lab.state().message, /cleanup reconciliation/);
    assert.ok(await readFile(path.join(root, '.strata/attended-demo-active.json')));
  } finally { await lab.close(); await rm(root, { recursive: true, force: true }); }
});
