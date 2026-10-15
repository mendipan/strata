import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT } from '../src/artifacts.js';
import { approveDemoActivationReview, confirmDemoActivationReview, createDemoActivationReview, createDemoActivationWorkerConfig,
  DEMO_ACTIVATION_LIMITS, readDemoActivationSource, validateDemoActivationGrant } from '../src/integrated-demo-activation.js';
import { reviewedDemoManagementPlan } from '../src/integrated-demo-management.js';
import { runDemoActivationCli } from '../scripts/integrated-demo-activation.js';
import { LOCAL_PROJECT } from '../src/security.js';
import { canonical, digest } from '../src/model.js';
import { runAttendedDemo } from '../src/integrated-demo-operator.js';
import { startReviewedDemoSession } from '../src/integrated-demo-live.js';
import { encodeDemoActivationGrant, decodeDemoActivationGrant, validateDemoActivationBindings,
  DEMO_BINDING_BYTES, DEMO_BINDING_COUNT } from '../src/integrated-demo-activation.js';

const target = { account_id: '1'.repeat(32), project_id: LOCAL_PROJECT, run_id: 'a1b2c3d4e5f60718',
  worker_name: 'strata-integrated-test', workflow_name: 'strata-integrated-flow', instance_id: 'run-a1b2c3d4e5f60718',
  namespace_id: 'strata-test-namespace', repository_name: 'strata-run-a1b2c3d4e5f60718' };

test('plain confirmation records the actual words, keeps exact bindings and refuses mixed or altered attendance', async () => {
  const { source, review, grant: legacy } = await attendedGrant();
  const attendance = { stdin_is_tty: true, stdout_is_tty: true, confirmation_text: 'START DEMO', operator_label: 'SYNTHETIC fixture' };
  const grant = confirmDemoActivationReview(review, source, attendance, legacy.started_at);
  assert.equal(grant.format, 'strata.integrated-demo-activation-grant/2');
  assert.equal(Object.hasOwn(grant.approval, 'typed_digest'), false);
  assert.equal(grant.approval.confirmed_review_sha256, review.review_sha256);
  const restored = decodeDemoActivationGrant(createDemoActivationWorkerConfig(grant).vars);
  validateDemoActivationGrant(restored, source, grant.started_at + 1);
  for (const changed of [{ confirmation_text: 'yes' }, { typed_digest: review.review_sha256 }, { stdin_is_tty: false }])
    assert.throws(() => confirmDemoActivationReview(review, source, { ...attendance, ...changed }, legacy.started_at));
  for (const changed of [{ confirmation_text: 'yes' }, { confirmed_review_sha256: '0'.repeat(64) }, { typed_digest: review.review_sha256 }]) {
    const altered = structuredClone(grant); Object.assign(altered.approval, changed);
    const { grant_sha256: _hash, ...body } = altered; altered.grant_sha256 = digest(body);
    assert.throws(() => validateDemoActivationGrant(altered, source, grant.started_at + 1));
  }
  const changedSource = structuredClone(source); changedSource.files['src/integrated-demo-activation.ts'] = '0'.repeat(64); changedSource.sha256 = digest(changedSource.files);
  assert.throws(() => confirmDemoActivationReview(review, changedSource, attendance, legacy.started_at));
});

test('doctor and review CLI dependencies are pinned and invalidate an earlier activation approval when changed', async () => {
  const { source, review, grant } = await attendedGrant();
  for (const file of ['dist/src/cli-config.js', 'dist/src/doctor.js', 'dist/src/review.js']) {
    assert.match(source.files[file], /^[a-f0-9]{64}$/, file);
    const changed = structuredClone(source); changed.files[file] = '0'.repeat(64); changed.sha256 = digest(changed.files);
    assert.throws(() => validateDemoActivationGrant(grant, changed, grant.started_at + 1), (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_STALE');
    assert.throws(() => confirmDemoActivationReview(review, changed, { stdin_is_tty: true, stdout_is_tty: true, confirmation_text: 'START DEMO', operator_label: 'SYNTHETIC fixture' }, grant.started_at));
  }
});

test('guided confirmation asks once, cancels without a grant and starts the clock after the answer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-plain-confirm-'));
  try {
    const { review, source } = await attendedGrant(), reviewPath = path.join(directory, 'review.json'), output = path.join(directory, 'grant.json');
    await writeFile(reviewPath, JSON.stringify(review));
    let lastEntry = 0, text = ''; const prompts: string[] = [];
    const terminal = { stdin_is_tty: true, stdout_is_tty: true, write(value: string) { text += value; }, async ask(prompt: string) {
      prompts.push(prompt); lastEntry = Date.now(); return prompt.startsWith('Your name') ? 'SYNTHETIC fixture' : 'START DEMO'; } };
    await runDemoActivationCli(['confirm', reviewPath, output], undefined, terminal);
    const grant = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(grant.started_at >= lastEntry); validateDemoActivationGrant(grant, source, grant.started_at + 1);
    assert.equal(prompts.length, 2); assert.equal(prompts.filter(p => p.includes('START DEMO')).length, 1);
    assert.ok(!text.includes(review.review_sha256)); assert.ok(text.includes(target.worker_name)); assert.ok(text.includes('US$1'));
    const cancelled = path.join(directory, 'cancelled.json');
    await assert.rejects(runDemoActivationCli(['confirm', reviewPath, cancelled], undefined, { ...terminal, async ask() { return 'cancel'; } }));
    await assert.rejects(readFile(cancelled), (error: any) => error.code === 'ENOENT');
    await assert.rejects(readFile(cancelled + '.wrangler.json'), (error: any) => error.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('same-session confirmation skips only the duplicate prompt; a wrong grant is refused before provider I/O and deployment failure never retries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-confirm-admit-'));
  try {
    const { review, source } = await attendedGrant(), now = Date.now();
    const grant = confirmDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
      confirmation_text: 'START DEMO', operator_label: 'SYNTHETIC fixture' }, now);
    const calls: string[] = []; let prompts = 0;
    const provider = { mode: 'mock-only' as const, async call(request: any) {
      calls.push(request.action);
      if (request.action === 'preflight-full-step') return { accepted: true, account_id: target.account_id };
      if (request.action === 'preflight-namespace') return { namespace_id: target.namespace_id, repositories: [] };
      if (request.action === 'preflight-worker') return { found: false, worker_name: target.worker_name };
      if (request.action === 'preflight-workflow') return { found: false, workflow_name: target.workflow_name, page_complete: true };
      throw Object.assign(new Error('SYNTHETIC deployment failure'), { code: 'DEMO_WRANGLER_COMMAND_UNCERTAIN' });
    } };
    const options = { root: process.cwd(), grant, config_path: path.join(directory, 'config.json'), journal_path: path.join(directory, 'journal.json'),
      terminal: { stdin_is_tty: true, stdout_is_tty: true, write() {}, async ask() { prompts++; throw new Error('Duplicate confirmation'); } },
      signal: new AbortController().signal, provider, emit: async () => {},
      probe: async () => ({ entrypoint: 'SYNTHETIC-no-generation', version: '0.160.1', billing_mode: 'chatgpt-subscription', model_availability_verified: false }) };
    await assert.rejects(runAttendedDemo({ ...options, confirmed_grant_sha256: '0'.repeat(64) }), (error: any) => error.code === 'DEMO_ACTIVATION_ATTENDANCE_REQUIRED');
    assert.equal(calls.length, 0);
    await assert.rejects(startReviewedDemoSession({ project_directory: options.root, grant, config_path: options.config_path,
      journal_path: options.journal_path, provider, attendance: { stdin_is_tty: true, stdout_is_tty: true, operator_label: grant.approval.operator_label,
        confirmation_text: 'START DEMO', confirmed_grant_sha256: '0'.repeat(64) } }), (error: any) => error.code === 'DEMO_ACTIVATION_ATTENDANCE_REQUIRED');
    assert.equal(calls.length, 0);
    await assert.rejects(runAttendedDemo({ ...options, confirmed_grant_sha256: grant.grant_sha256 }), (error: any) => error.code === 'DEMO_WRANGLER_COMMAND_UNCERTAIN');
    assert.equal(prompts, 0); assert.equal(calls.filter(action => action === 'deploy-private').length, 1);
    assert.equal(calls.includes('create-instance'), false); assert.ok(!calls.some(action => action.startsWith('delete-')));
    const journal = JSON.parse(await readFile(options.journal_path, 'utf8'));
    assert.equal(journal.reconciliation_required, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function attendedGrant(root = process.cwd(), now = Date.now()) {
  const source = await readDemoActivationSource(root), review = createDemoActivationReview('review-live', target, source);
  const grant = approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
    typed_digest: review.review_sha256, operator_label: 'fixture operator' }, now);
  return { source, review, grant };
}

test('activation review is exact, disabled by default, and carries target-specific private Wrangler bindings', async () => {
  const { source, review, grant } = await attendedGrant();
  assert.equal(review.live_authorized, false); assert.equal(review.status, 'prepared-disabled');
  assert.equal(grant.approval.typed_digest, review.review_sha256);
  assert.equal(grant.expires_at - grant.started_at, 30 * 60 * 1000);
  assert.equal(DEMO_ACTIVATION_LIMITS.repo_tokens_issued, 25); assert.equal(ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT, 25);
  assert.equal(DEMO_ACTIVATION_LIMITS.actor_processes, 3); assert.equal(DEMO_ACTIVATION_LIMITS.max_concurrent_actor_turns, 2);
  assert.equal(DEMO_ACTIVATION_LIMITS.actors.a.reasoning_effort, 'medium');
  assert.equal(DEMO_ACTIVATION_LIMITS.actors.c.reasoning_effort, 'medium');
  assert.equal(DEMO_ACTIVATION_LIMITS.actors.b.reasoning_effort, 'high');
  validateDemoActivationGrant(grant, source, grant.started_at + 1);
  assert.equal(reviewedDemoManagementPlan(grant, source, grant.started_at + 1).live_authorized, true);

  const config = createDemoActivationWorkerConfig(grant);
  assert.equal(config.name, target.worker_name); assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.equal(Object.hasOwn(config, 'routes'), false); assert.equal(config.workflows[0].name, target.workflow_name);
  assert.equal(config.artifacts[0].namespace, target.namespace_id);
  assert.equal(config.vars.STRATA_DEMO_ACTIVATION_GRANT_SHA256, grant.grant_sha256);
  assert.equal(config.vars.STRATA_DEMO_SOURCE_SHA256, source.sha256);
  assert.equal(config.vars.STRATA_DEMO_TARGET_SHA256, grant.target_sha256);

  const staleSource = structuredClone(source); staleSource.files['src/integrated-demo-worker-entry.ts'] = 'f'.repeat(64);
  staleSource.sha256 = 'e'.repeat(64);
  assert.throws(() => validateDemoActivationGrant(grant, staleSource, grant.started_at + 1),
    (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_REFUSED' || error.code === 'DEMO_ACTIVATION_SOURCE_STALE');
  assert.throws(() => createDemoActivationReview('invalid-project', { ...target, project_id: 'another-project' }, source),
    (error: any) => error.code === 'DEMO_ACTIVATION_TARGET_REFUSED');
  assert.throws(() => approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
    typed_digest: '0'.repeat(64), operator_label: 'fixture operator' }, grant.started_at + 1),
    (error: any) => error.code === 'DEMO_ACTIVATION_DIGEST_REFUSED');
});

test('activation CLI writes a new disabled review, then a separate exact-digest grant/config only with terminal attendance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-demo-activation-'));
  try {
    const targetPath = path.join(directory, 'target.json'), reviewPath = path.join(directory, 'review.json'), grantPath = path.join(directory, 'grant.json');
    await writeFile(targetPath, JSON.stringify(target));
    const prepared = await runDemoActivationCli(['prepare', targetPath, reviewPath, 'activation-one'], Date.now(), undefined, process.cwd());
    assert.equal(prepared.live_authorized, false); assert.equal(prepared.dispatches, 0);
    const review = JSON.parse(await readFile(reviewPath, 'utf8'));
    assert.equal(review.status, 'prepared-disabled'); assert.equal(review.live_authorized, false);

    await assert.rejects(runDemoActivationCli(['attend', reviewPath, grantPath], Date.now(), {
      stdin_is_tty: false, stdout_is_tty: true, write() {}, async ask() { return review.review_sha256; }
    }, process.cwd()), (error: any) => error.code === 'DEMO_ACTIVATION_TTY_REQUIRED');
    let lastEntry = 0;
    const result = await runDemoActivationCli(['attend', reviewPath, grantPath], undefined, {
      stdin_is_tty: true, stdout_is_tty: true, write() {}, async ask(prompt) {
        await new Promise(resolve => setTimeout(resolve, 15)); lastEntry = Date.now();
        return prompt.startsWith('Type') ? review.review_sha256 : 'fixture operator'; }
    }, process.cwd());
    assert.equal(result.live_authorized, true); assert.equal(result.dispatches, 0);
    const grant = JSON.parse(await readFile(grantPath, 'utf8'));
    assert.ok(grant.started_at >= lastEntry, 'The clock must begin after the final attendance input.');
    const config = JSON.parse(await readFile(grantPath + '.wrangler.json', 'utf8'));
    assert.equal(grant.approval.typed_digest, review.review_sha256);
    assert.equal(config.name, target.worker_name); assert.equal(config.workflows[0].name, target.workflow_name);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('chunked config roundtrips the full exact grant offline with conservative binding limits', async () => {
  const { grant, source } = await attendedGrant();
  const config = createDemoActivationWorkerConfig(grant);
  const restored = decodeDemoActivationGrant(config.vars);
  assert.deepEqual(restored, grant);
  assert.equal(JSON.stringify(restored), JSON.stringify(grant));
  validateDemoActivationGrant(restored, source, grant.started_at + 1);
  assert.ok(Buffer.byteLength(JSON.stringify(grant)) > 5120);
  assert.ok(Object.keys(config.vars).length <= DEMO_BINDING_COUNT);
  assert.ok(Object.values(config.vars).every(value => Buffer.byteLength(value) <= DEMO_BINDING_BYTES));
  assert.equal(Object.hasOwn(config.vars, 'STRATA_DEMO_ACTIVATION_GRANT'), false);
});

test('chunk boundaries preserve multibyte UTF-8 and exact 4 KiB values', async () => {
  const { grant, review, source } = await attendedGrant();
  for (const label of ['é'.repeat(128), '界'.repeat(128), '😀'.repeat(64)]) {
    const unicodeGrant = approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
      typed_digest: review.review_sha256, operator_label: label }, grant.started_at);
    const vars = encodeDemoActivationGrant(unicodeGrant);
    assert.deepEqual(decodeDemoActivationGrant(vars), unicodeGrant);
    assert.ok(Object.values(vars).every(value => Buffer.byteLength(value) <= 4096));
    assert.ok(Object.values(vars).every(value => !value.includes('\ufffd')));
  }
  validateDemoActivationBindings({ boundary: 'é'.repeat(2048) });
  // Put a four-byte code point directly across the nominal byte boundary.
  const boundaryGrant = { boundary: 'x'.repeat(4096 - Buffer.byteLength('{"boundary":"') - 1) + '😀界é', ...structuredClone(grant) };
  const boundaryVars = encodeDemoActivationGrant(boundaryGrant);
  assert.deepEqual(decodeDemoActivationGrant(boundaryVars), boundaryGrant);
  assert.ok(Object.values(boundaryVars).every(value => Buffer.byteLength(value) <= 4096));
  assert.throws(() => validateDemoActivationBindings({ boundary: 'é'.repeat(2048) + 'a' }));
  validateDemoActivationBindings(Object.fromEntries(Array.from({ length: 64 }, (_, index) => [String(index), 'x'])));
  assert.throws(() => validateDemoActivationBindings(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [String(index), 'x']))));
});

test('chunk parser refuses missing, changed, extra, legacy, malformed and ambiguous encodings', async () => {
  const { grant } = await attendedGrant(), original = encodeDemoActivationGrant(grant);
  const manifestKey = 'STRATA_DEMO_ACTIVATION_GRANT_MANIFEST';
  const first = 'STRATA_DEMO_ACTIVATION_GRANT_CHUNK_000';
  const manifest = JSON.parse(original[manifestKey]);
  const missing = { ...original }; delete missing[first];
  const mutations = [missing, { ...original, [first]: original[first] + 'x' },
    { ...original, STRATA_DEMO_ACTIVATION_GRANT_CHUNK_999: 'extra' },
    { ...original, STRATA_DEMO_ACTIVATION_GRANT: JSON.stringify(grant) },
    { STRATA_DEMO_ACTIVATION_GRANT: JSON.stringify(grant) },
    { ...original, [first]: 1 }, { ...original, [manifestKey]: '{' },
    ...[0, -1, 64, 1.5, '3'].map(count => ({ ...original, [manifestKey]: JSON.stringify({ ...manifest, count }) })),
    { ...original, [manifestKey]: JSON.stringify({ ...manifest, extra: true }) },
    { ...original, [manifestKey]: JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }) },
    { ...original, [manifestKey]: JSON.stringify({ ...manifest, utf8_bytes: manifest.utf8_bytes + 1 }) }];
  for (const vars of mutations) assert.throws(() => decodeDemoActivationGrant(vars),
    (error: any) => error.code === 'DEMO_ACTIVATION_GRANT_REFUSED');
  // Matching concatenation and transport hash are insufficient: partitions must be exact.
  const repartitioned = { ...original }, second = 'STRATA_DEMO_ACTIVATION_GRANT_CHUNK_001';
  repartitioned[second] = repartitioned[first].slice(-1) + repartitioned[second];
  repartitioned[first] = repartitioned[first].slice(0, -1);
  assert.throws(() => decodeDemoActivationGrant(repartitioned));
});

test('transport hash cannot bypass pinned grant, review, source, target, approval or budget validation', async () => {
  const { grant, source } = await attendedGrant();
  for (const change of [(g: typeof grant) => { g.review_sha256 = '0'.repeat(64); },
    (g: typeof grant) => { g.approval.typed_digest = '0'.repeat(64); },
    (g: typeof grant) => { g.target.worker_name = 'changed-worker'; },
    (g: typeof grant) => { g.source.files['src/integrated-demo-activation.ts'] = '0'.repeat(64); },
    (g: typeof grant) => { Object.assign(g.limits, { status_reads: 161 }); }]) {
    const altered = structuredClone(grant); change(altered);
    const restored = decodeDemoActivationGrant(encodeDemoActivationGrant(altered));
    assert.throws(() => validateDemoActivationGrant(restored, source, grant.started_at + 1));
  }
  const changedSource = structuredClone(source);
  changedSource.files['src/integrated-demo-activation.ts'] = '0'.repeat(64);
  changedSource.sha256 = digest(changedSource.files);
  assert.notEqual(canonical(changedSource), canonical(source));
  assert.throws(() => validateDemoActivationGrant(grant, changedSource, grant.started_at + 1),
    (error: any) => error.code === 'DEMO_ACTIVATION_SOURCE_STALE');
});

test('compiled Worker reassembles chunks and preserves exact binding/instance refusal before provider I/O', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-worker-chunks-'));
  const entry = path.resolve('dist/src', path.basename(directory) + '.mjs');
  try {
    // Stub only the platform base; execute the actual compiled parser/runtime.
    const compiled = await readFile('dist/src/integrated-demo-worker-entry.js', 'utf8');
    const platformImport = "import { WorkflowEntrypoint } from 'cloudflare:workers';";
    assert.ok(compiled.includes(platformImport));
    await writeFile(entry, compiled.replace(platformImport, 'class WorkflowEntrypoint {}'), { flag: 'wx' });
    const { createActivatedDemoRuntime } = await import(pathToFileURL(entry).href);
    const { grant, review, source } = await attendedGrant(), vars = createDemoActivationWorkerConfig(grant).vars;
    let calls = 0;
    const env = { ...vars, ARTIFACTS: new Proxy({}, { get() { calls++; throw new Error('provider access refused'); } }) };
    const event = { payload: { run_id: target.run_id }, instanceId: target.instance_id };
    assert.deepEqual(createActivatedDemoRuntime(env, event, grant.started_at + 1).grant, grant);
    const confirmed = confirmDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
      confirmation_text: 'START DEMO', operator_label: 'SYNTHETIC fixture' }, grant.started_at);
    assert.deepEqual(createActivatedDemoRuntime({ ...env, ...createDemoActivationWorkerConfig(confirmed).vars }, event,
      confirmed.started_at + 1).grant, confirmed);
    assert.throws(() => createActivatedDemoRuntime({ ...env, STRATA_DEMO_WORKER_NAME: 'changed-worker' }, event, grant.started_at + 1),
      (error: any) => error.code === 'DEMO_ACTIVATION_TARGET_MISMATCH');
    assert.throws(() => createActivatedDemoRuntime(env, { ...event, instanceId: 'run-other' }, grant.started_at + 1),
      (error: any) => error.code === 'DEMO_ACTIVATION_TARGET_MISMATCH');
    assert.throws(() => createActivatedDemoRuntime({ ...env, STRATA_DEMO_ACTIVATION_GRANT_CHUNK_000: 'tamper' }, event, grant.started_at + 1),
      (error: any) => error.code === 'DEMO_ACTIVATION_GRANT_REFUSED');
    assert.throws(() => createActivatedDemoRuntime(env, event, grant.expires_at - DEMO_ACTIVATION_LIMITS.cleanup_ms),
      (error: any) => error.code === 'DEMO_ACTIVATION_CLEANUP_WINDOW');
    assert.equal(calls, 0);
  } finally { await rm(entry, { force: true }); await rm(directory, { recursive: true, force: true }); }
});
