// Bounded local acceptance for the documented demo, doctor and recorded replay.
// Does not install dependencies, start models or use provider configuration.
import '../tests/no-external-fetch.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const output = path.join(root, '.strata/local-acceptance');
const guard = pathToFileURL(path.join(root, 'tests/no-external-fetch.mjs')).href;
const env = { ...process.env, CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' };
// Children need no provider credentials or inherited fixture selector.
for (const key of Object.keys(env)) {
  if (/^(OPENAI|ANTHROPIC|CLOUDFLARE_API|CF_API|STRATA_SESSION|STRATA_CONFIG)/i.test(key)) delete env[key];
}
const report = { format: 'strata-local-acceptance/1',
  checked_at: new Date().toISOString(), environment: { node: process.version,
    platform: process.platform, os_release: os.release(), arch: process.arch },
  scope: 'Local fixture demo, offline diagnostics and synthetic read-only replay; no live provider execution.',
  checks: [], status: 'running' };
const record = (name, details) => report.checks.push({ name, ...details });
const sha = text => createHash('sha256').update(text).digest('hex');
const relative = file => path.relative(root, file).split(path.sep).join('/');

function start(args) {
  const child = spawn(process.execPath, ['--import', guard, ...args],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  // Attach immediately so early exits and spawn failures cannot be missed.
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  closed.catch(() => {});
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}
async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
async function run(name, args) {
  const started = performance.now(), task = start(args);
  try {
    const result = await bounded(task.closed, 60000, name + ' exceeded 60 seconds');
    record(name, { command: ['node', '--import', './tests/no-external-fetch.mjs', ...args].join(' '),
      exit: result.code, duration_ms: Math.round(performance.now() - started) });
    assert.equal(result.code, 0, name + ': ' + task.stderr());
    return JSON.parse(task.stdout());
  } finally {
    if (task.child.exitCode === null && task.child.signalCode === null) {
      task.child.kill(); await bounded(task.closed, 5000, name + ' did not stop');
    }
  }
}

try {
  for (const file of ['node_modules/typescript/package.json', 'dist/src/cli.js',
    'dist/scripts/demo.js', 'dist/scripts/integrated-demo-browser.js']) {
    await access(path.join(root, file)).catch(() => { throw Error('Missing ' + file + '; run npm ci --ignore-scripts and npm run build first.'); });
  }
  await mkdir(output, { recursive: true });
  const configBefore = await readFile('strata.config.json');
  const doctor = await run('offline doctor', ['dist/src/cli.js', 'doctor', '--offline', '--json']);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.data.configuration_healthy, true);
  assert.deepEqual(doctor.effects.network, []);
  assert.equal(doctor.data.checks.find(check => check.id === 'broker_health').status, 'not_checked');
  await writeFile(path.join(output, 'doctor.json'), JSON.stringify(doctor, null, 2) + '\n');
  const demo = await run('local demo', ['dist/scripts/demo.js']);
  const full = JSON.parse(await readFile(demo.result_file, 'utf8'));
  assert.equal(full.trust, 'local-fixture');
  assert.equal(full.cloudflare_agents_exercised, false);
  assert.equal(full.inherited_duration, 900);
  assert.equal(full.retry_same_release, true);
  assert.equal(full.inherited_layer_acceptance, true);
  assert.equal(full.inherited_reminders, true);
  assert.ok(full.trace.some(step => step.exit_code === 5), 'Expected conflict refusal missing');
  assert.ok(full.trace.every(step => step.exit_code === 0 || step.exit_code === 5));
  const observed = full.observations;
  assert.equal(observed.first_hold.expires, 900);
  assert.equal(observed.competing_hold.accepted, false);
  assert.equal(observed.before_reminder.reminders.length, 0);
  assert.equal(observed.reminder.reminders[0].at, 840);
  assert.equal(observed.repeat_tick.reminders.length, 1);
  assert.deepEqual(observed.expired.holds, {});
  assert.equal(observed.expired.now, 900);
  assert.equal(observed.next_hold.accepted, true);
  assert.ok(Object.values(observed.checks).every(check => check.passed));
  record('demo outcome', { release: full.release, inherited_duration: 900,
    retry_same_release: true, inherited_layer_acceptance: true,
    expected_conflict_refusal: true, result: relative(demo.result_file),
    result_sha256: sha(await readFile(demo.result_file)), observations: {
      first_expiry: 900, competing_hold_accepted: false, reminder_at: 840,
      reminder_count_after_repeat: 1, holds_at_expiry: 0, next_hold_accepted: true } });
  const replayBytes = await readFile('examples/replay/synthetic-run.json');
  const { parseRunReplay } = await import(pathToFileURL(path.join(root, 'dist/src/demo-run-replay.js')).href);
  const replay = parseRunReplay(JSON.parse(replayBytes));
  const started = performance.now(), task = start(['dist/scripts/integrated-demo-browser.js', '--replay']);
  let url;
  try {
    await bounded((async () => {
      while (!(url = task.stdout().match(/http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]+/)?.[0])) {
        if (task.child.exitCode !== null || task.child.signalCode !== null || task.child.killed) throw Error('Replay stopped before startup: ' + task.stderr());
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })(), 15000, 'Replay did not print a loopback URL within 15 seconds');
    const startupMs = Math.round(performance.now() - started), parsed = new URL(url);
    const headers = { authorization: 'Bearer ' + parsed.hash.slice(1) };
    const request = (route, options = {}) => fetch(parsed.origin + route,
      { ...options, signal: AbortSignal.timeout(5000), headers: { ...headers, ...options.headers } });
    assert.equal((await request('/')).status, 200);
    const state = await (await request('/state')).json();
    assert.equal(state.replay, true);
    assert.equal(state.view.source_mode, 'recorded-replay');
    assert.equal(state.packet, null);
    const served = await (await request('/replay')).json();
    assert.equal(served.bundle_sha256, replay.bundle_sha256);
    for (const route of ['/decision', '/stop', '/lab/begin', '/lab/check', '/lab/fresh']) {
      assert.equal((await request(route, { method: 'POST', headers: {
        origin: parsed.origin, 'content-type': 'application/json' }, body: '{}' })).status, 409);
    }
    assert.equal(replay.chapters.filter(c => c.recorded_choice).length, 3);
    assert.equal(replay.chapters.at(-1).view.release.state, 'validated');
    assert.equal(replay.chapters.at(-1).view.inherited_equal, true);
    record('recorded replay', { command: 'node --import ./tests/no-external-fetch.mjs dist/scripts/integrated-demo-browser.js --replay', shortcut: 'npm run demo:replay', startup_ms: startupMs,
      source: 'synthetic-fixture', run_id: replay.run_id, chapters: replay.chapters.length,
      bundle_file_sha256: sha(replayBytes), source_mode: 'recorded-replay',
      loopback_http: true, mutation_routes_refused: 5, recorded_choices: 3 });
  } finally {
    task.child.kill(); await bounded(task.closed, 5000, 'Replay did not stop');
  }
  await assert.rejects(fetch(new URL(url).origin, { signal: AbortSignal.timeout(1000) }));
  record('replay stopped', { loopback_endpoint_closed: true });
  assert.deepEqual(await readFile('strata.config.json'), configBefore);
  record('project configuration preserved', { sha256: sha(configBefore) });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message; process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
