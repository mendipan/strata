import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENAI|ANTHROPIC|CLOUDFLARE|CF_API|STRATA_|ARTIFACTS_|AWS_|CODEX_)/i.test(key)));
Object.assign(env, { NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/no-external-fetch.mjs')).href, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false', CI: 'true' });

async function fixture(invalidBootstrap: boolean) {
  const base = await mkdtemp(path.join(tmpdir(), 'strata-sdk-onboarding-test-'));
  // The historical checkout-relative SDK store would put SQLite journals beyond
  // Windows MAX_PATH here. Nothing in this fixture uses an existing user store.
  const directory = path.join(base, 'deep-checkout-'.repeat(7));
  await mkdir(path.join(directory, 'examples'), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
  config.main = path.join(root, 'src/worker.ts');
  await writeFile(path.join(directory, 'wrangler.jsonc'), JSON.stringify(config));
  await writeFile(path.join(directory, 'strata.config.json'), await readFile(path.join(root, 'strata.config.json')));
  const packet = JSON.parse(await readFile(path.join(root, 'examples/agent-session.json'), 'utf8'));
  if (invalidBootstrap) packet.steps.find((step: any) => step.id === 'bootstrap').stdin = { invalid: true };
  await writeFile(path.join(directory, 'examples/agent-session.json'), JSON.stringify(packet));
  const started = Date.now(); let stdout = '', stderr = '';
  const child = spawn(process.execPath, [path.join(root, 'dist/scripts/onboarding.js'), '--agents'], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const timer = setTimeout(() => child.kill(), 90000);
  const result = await new Promise<{ exit: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (exit, signal) => resolve({ exit, signal }));
  }).finally(() => clearTimeout(timer));
  await writeFile(path.join(base, 'process.json'), JSON.stringify({ invalidBootstrap, duration_ms: Date.now() - started, ...result, stdout, stderr }, null, 2));
  return { base, directory, stdout, stderr, ...result };
}

test('SDK onboarding completes the fixed CLI packet from a deep checkout using a separate retained short runtime', { timeout: 100000 }, async () => {
  const run = await fixture(false);
  assert.equal(run.exit, 0, run.stderr); assert.equal(run.signal, null);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.status, 'passed'); assert.equal(summary.cli_calls, 34);
  assert.equal(summary.runtime, 'local-workerd-cloudflare-agents-sdk');
  assert.equal(summary.model_calls, 0); assert.equal(summary.cloud_calls, 0);
  assert.equal(path.dirname(summary.runtime_directory), path.resolve(tmpdir()));
  assert.match(path.basename(summary.runtime_directory), /^strata-sdk-/);
  assert.ok(!summary.runtime_directory.startsWith(run.directory));
  const receipt = JSON.parse(await readFile(summary.result_file, 'utf8'));
  assert.equal(receipt.direct_api_checks.length, 9);
  assert.equal(receipt.assertions.release_retry_same_ref, true);
  assert.equal(receipt.observations.next_hold.accepted, true);
  const log = await readFile(path.join(summary.runtime_directory, 'runtime.log'), 'utf8');
  const url = log.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(url); await assert.rejects(fetch(url + '/health', { signal: AbortSignal.timeout(500) }));
  assert.ok((await readdir(path.join(summary.runtime_directory, 'state'))).length > 0);
});

test('SDK bootstrap refusal keeps a failed exit and closes cleanly instead of a top-level unhandled rejection', { timeout: 100000 }, async () => {
  const run = await fixture(true);
  assert.equal(run.exit, 1, run.stderr); assert.equal(run.signal, null);
  assert.match(run.stderr, /bootstrap:.*INVALID_RECORD/);
  assert.doesNotMatch(run.stderr, /UV_HANDLE_CLOSING|triggerUncaughtException/);
  assert.equal(run.stdout, '');
  const retained = JSON.parse(run.stderr.trim().split('\n').at(-1)!);
  assert.equal(retained.status, 'failed');
  const log = await readFile(path.join(retained.runtime_directory, 'runtime.log'), 'utf8');
  const url = log.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(url); await assert.rejects(fetch(url + '/health', { signal: AbortSignal.timeout(500) }));
});
