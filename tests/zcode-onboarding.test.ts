import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer } from '../src/security.js';
import { normalizeSnapshot, parseLayer, parseComposition } from '../src/model.js';

// Clean-host onboarding reproducibility: every CLI invocation below is a real
// child process with an explicit argument array and a controlled environment,
// against a synthetic fixture project whose path contains spaces and Unicode.
// Setup/discovery blockers are asserted as host blockers, never auto-repaired.
const exec = promisify(execFile);
const PROJECT_ID = 'zcode-onboarding-synthetic';
const root = process.cwd();
const CLI = path.join(root, 'dist', 'src', 'cli.js');
const FIXTURE_CONFIG = path.join(root, 'tests', 'fixtures', 'zcode-onboarding', 'strata.config.json');

// A minimal allowlisted child environment: ambient STRATA_* variables are added
// explicitly per test; no credential-bearing variables are read or dumped.
const baseEnv: NodeJS.ProcessEnv = {};
for (const name of ['SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC']) {
  const value = process.env[name]; if (value !== undefined) baseEnv[name] = value;
}

let scratch: string, workspace: string, unrelated: string, deadPort: number;
let broker: Awaited<ReturnType<typeof startLocalBroker>>;
const exists = (target: string) => access(target).then(() => true, () => false);

async function cli(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...argv, '--json', '--non-interactive', '--offline'], { cwd: options.cwd ?? unrelated, env: options.env ?? baseEnv, timeout: 60000 });
    return { envelope: JSON.parse(stdout) as any, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    return { envelope: failure.stdout ? JSON.parse(failure.stdout) as any : null, stderr: failure.stderr ?? '', exitCode: typeof failure.code === 'number' ? failure.code : -1 };
  }
}
async function freeLoopbackPort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'zcode-onboarding-'));
  workspace = path.join(scratch, 'host workspace Ünïcode');
  unrelated = path.join(scratch, 'unrelated cwd');
  await mkdir(workspace, { recursive: true });
  await mkdir(unrelated, { recursive: true });
  const fixture = JSON.parse(await readFile(FIXTURE_CONFIG, 'utf8'));
  broker = await startLocalBroker(path.join(scratch, 'broker-state'), 0, { issuer: new FixtureIssuer({ project_id: PROJECT_ID }) });
  // The host copies the synthetic fixture config and points it at its own broker.
  await writeFile(path.join(workspace, 'strata.config.json'), JSON.stringify({ ...fixture, broker: broker.url }, null, 2));
  // A copied tracked lockfile represents the host's checked-out source; CLI runs must not touch it.
  await copyFile(path.join(root, 'package-lock.json'), path.join(workspace, 'package-lock.json'));
  deadPort = await freeLoopbackPort();
});
after(async () => {
  await broker?.close();
  if (!scratch) return;
  const resolved = await realpath(scratch).catch(() => null);
  const relative = resolved ? path.relative(os.tmpdir(), resolved) : '';
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('zcode-onboarding-')) await rm(scratch, { recursive: true, force: true });
  else throw new Error('Refusing to remove a scratch path outside the test temp directory: ' + relative);
});

test('version and help run as child processes from an unrelated cwd without a project', async () => {
  for (const flag of ['--version', '--help']) {
    const run = await cli([flag]);
    assert.equal(run.exitCode, 0, flag + ': ' + JSON.stringify(run.envelope?.errors));
    assert.equal(run.envelope.protocol_version, '1');
    assert.equal(run.envelope.data.capabilities.remote, false);
    assert.equal(run.envelope.data.capabilities.identity, 'trusted-local-fixture-sessions');
  }
  const help = await cli(['--help']);
  assert.ok(help.envelope.data.flags.includes('--project PATH'));
  assert.ok(help.envelope.data.commands.some((c: string) => c.startsWith('init --file')));
});

test('a spaces-and-Unicode workspace resolves through explicit --project and cwd discovery, preserving tracked files', async () => {
  const lockBytes = await readFile(path.join(workspace, 'package-lock.json'), 'utf8');
  const reader = { ...baseEnv, STRATA_SESSION: 'fixture-reader' };
  const explicit = await cli(['config', 'show', '--project', workspace], { env: reader });
  assert.equal(explicit.exitCode, 0, JSON.stringify(explicit.envelope?.errors));
  assert.equal(explicit.envelope.data.project_id, PROJECT_ID);
  assert.equal(explicit.envelope.data.sources.project, path.join(workspace, 'strata.config.json'));
  assert.equal(explicit.envelope.data.sources.session, 'environment (redacted)');
  // Discovery from inside the workspace (no --project) finds the same config in cwd.
  const discovered = await cli(['config', 'show'], { cwd: workspace, env: reader });
  assert.equal(discovered.exitCode, 0);
  assert.equal(discovered.envelope.data.project_id, PROJECT_ID);
  assert.equal(await readFile(path.join(workspace, 'package-lock.json'), 'utf8'), lockBytes);
});

test('the documented quick-start round trip works over the spaces workspace as child processes', async () => {
  const lockBytes = await readFile(path.join(workspace, 'package-lock.json'), 'utf8');
  const configBytes = await readFile(path.join(workspace, 'strata.config.json'), 'utf8');
  const bootstrapFile = path.join(root, 'examples', 'bootstrap.json');
  const holdFile = path.join(root, 'examples', 'L-hold.json');
  const reader = { ...baseEnv, STRATA_SESSION: 'fixture-reader' };
  const author = { ...baseEnv, STRATA_SESSION: 'fixture-a' };
  // Explicit --project from the project cwd itself.
  const init = await cli(['init', '--file', bootstrapFile, '--project', workspace], { cwd: workspace, env: { ...baseEnv, STRATA_SESSION: 'fixture-bootstrap' } });
  assert.equal(init.exitCode, 0, JSON.stringify(init.envelope?.errors));
  const status = await cli(['status', '--project', workspace], { env: reader });
  assert.equal(status.exitCode, 0, JSON.stringify(status.envelope?.errors));
  assert.equal(status.envelope.data.identity_policy, 'trusted-local-fixture-sessions');
  const baseline = await cli(['inspect', 'release', 'R0@1', '--project', workspace], { env: reader });
  assert.equal(baseline.exitCode, 0, JSON.stringify(baseline.envelope?.errors));
  // Explicit --project from the unrelated cwd; the tracked example file is passed by absolute path.
  const draft = await cli(['layer', 'create', '--file', holdFile, '--project', workspace], { env: author });
  assert.equal(draft.exitCode, 0, JSON.stringify(draft.envelope?.errors));
  assert.equal(draft.envelope.data.published, false);
  assert.equal((await cli(['layer', 'publish', 'L-hold@1', '--project', workspace], { env: author })).exitCode, 0);
  const inspected = await cli(['inspect', 'layer', 'L-hold@1', '--project', workspace], { env: reader });
  assert.equal(inspected.exitCode, 0);
  assert.equal(inspected.envelope.data.owner, 'author-a');
  assert.equal(await readFile(path.join(workspace, 'package-lock.json'), 'utf8'), lockBytes);
  assert.equal(await readFile(path.join(workspace, 'strata.config.json'), 'utf8'), configBytes);
});

test('missing project, subfolder project, and config-less cwd are host blockers (exit 3)', async () => {
  const reader = { ...baseEnv, STRATA_SESSION: 'fixture-reader' };
  const noProject = await cli(['config', 'show', '--project', path.join(scratch, 'no-config-here')], { env: reader });
  assert.equal(noProject.exitCode, 3);
  assert.equal(noProject.envelope.errors[0].code, 'PROJECT_NOT_FOUND');
  // An explicit --project must name the folder holding strata.config.json; it does not walk up.
  await mkdir(path.join(workspace, 'nested'));
  const subfolder = await cli(['config', 'show', '--project', path.join(workspace, 'nested')], { env: reader });
  assert.equal(subfolder.exitCode, 3);
  assert.equal(subfolder.envelope.errors[0].code, 'PROJECT_NOT_FOUND');
  const walked = await cli(['config', 'show'], { cwd: unrelated, env: reader });
  assert.equal(walked.exitCode, 3);
  assert.equal(walked.envelope.errors[0].code, 'PROJECT_NOT_FOUND');
});

test('a missing broker is a host blocker (exit 9) while config show still resolves the project', async () => {
  const offlineWorkspace = path.join(scratch, 'offline workspace');
  await mkdir(offlineWorkspace);
  const fixture = JSON.parse(await readFile(FIXTURE_CONFIG, 'utf8'));
  await writeFile(path.join(offlineWorkspace, 'strata.config.json'), JSON.stringify({ ...fixture, broker: `http://127.0.0.1:${deadPort}` }));
  const reader = { ...baseEnv, STRATA_SESSION: 'fixture-reader' };
  const config = await cli(['config', 'show', '--project', offlineWorkspace], { env: reader });
  assert.equal(config.exitCode, 0, JSON.stringify(config.envelope?.errors));
  const status = await cli(['status', '--project', offlineWorkspace], { env: reader });
  assert.equal(status.exitCode, 9);
  assert.equal(status.envelope.errors[0].code, 'BROKER_UNAVAILABLE');
  assert.match(status.envelope.errors[0].message, /Start the local broker/);
  assert.match(status.envelope.errors[0].message, /does not start servers/);
  assert.deepEqual(status.envelope.effects.created, []);
});

test('an invalid project configuration is a host blocker (exit 8)', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_CONFIG, 'utf8'));
  const reader = { ...baseEnv, STRATA_SESSION: 'fixture-reader' };
  for (const [label, mutate] of [
    ['unsupported-model-version', (c: any) => { c.model_version = 'strata/9-unknown'; }],
    ['unknown-config-key', (c: any) => { c.extra = true; }],
  ] as const) {
    const broken = path.join(scratch, 'broken-' + label);
    await mkdir(broken);
    const config = { ...fixture, broker: broker.url };
    mutate(config);
    await writeFile(path.join(broken, 'strata.config.json'), JSON.stringify(config));
    const run = await cli(['status', '--project', broken], { env: reader });
    assert.equal(run.exitCode, 8, label);
    assert.equal(run.envelope.errors[0].code, 'UNSUPPORTED_MODEL_VERSION', label);
    assert.equal(run.envelope.ok, false);
  }
});

test('a missing build is a host blocker reported by Node, with no bootstrap', async () => {
  const unbuiltWorkspace = path.join(scratch, 'unbuilt workspace');
  const unbuiltCli = path.join(unbuiltWorkspace, 'dist', 'src', 'cli.js');
  await mkdir(path.dirname(unbuiltCli), { recursive: true });
  let stderr = '', exitCode = 0;
  try { await exec(process.execPath, [unbuiltCli, '--version'], { cwd: unbuiltWorkspace, env: baseEnv, timeout: 30000 }); }
  catch (error) { const failure = error as { stderr?: string; code?: number | string }; stderr = failure.stderr ?? ''; exitCode = typeof failure.code === 'number' ? failure.code : -1; }
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /Cannot find module/);
  assert.match(stderr, /dist.*src.*cli\.js/);
  assert.equal(await exists(unbuiltCli), false);
  assert.equal(await exists(path.join(unbuiltWorkspace, 'node_modules')), false);
});

test('ambient STRATA_* variables do not change discovery, config resolution, or identity', async () => {
  const clean = await cli(['--version'], { env: { ...baseEnv } });
  const polluted = await cli(['--version'], {
    env: {
      ...baseEnv,
      STRATA_BROKER: 'https://example.invalid', STRATA_PROJECT: 'attacker-project', STRATA_PROFILE: 'booking-node/9',
      STRATA_MODEL_VERSION: 'bogus', STRATA_STATE_DIR: path.join(scratch, 'state-dir-honeypot'), STRATA_SESSION: 'not-a-fixture',
    },
  });
  assert.equal(polluted.exitCode, 0);
  assert.equal(JSON.stringify(polluted.envelope), JSON.stringify(clean.envelope));
  const config = await cli(['config', 'show', '--project', workspace], {
    env: {
      ...baseEnv, STRATA_SESSION: 'fixture-reader',
      STRATA_BROKER: 'https://example.invalid', STRATA_PROJECT: 'attacker-project', STRATA_MODEL_VERSION: 'bogus',
      STRATA_STATE_DIR: path.join(scratch, 'state-dir-honeypot'),
    },
  });
  assert.equal(config.exitCode, 0, JSON.stringify(config.envelope?.errors));
  assert.equal(config.envelope.data.project_id, PROJECT_ID);
  assert.equal(config.envelope.data.broker.startsWith('http://127.0.0.1:'), true);
  assert.equal(await exists(path.join(scratch, 'state-dir-honeypot')), false);
  const unknown = await cli(['status', '--project', workspace], { env: { ...baseEnv, STRATA_SESSION: 'not-a-fixture', STRATA_PROJECT: 'attacker-project' } });
  assert.equal(unknown.exitCode, 4);
  assert.equal(unknown.envelope.errors[0].code, 'AUTHENTICATION_REQUIRED');
});

test('the offline audit driver fails closed before dependency-bearing imports when dependencies are absent', async () => {
  // An isolated copy of the compiled driver with no node_modules resolvable from it:
  // a static zod-dependent import would crash at module load; the prerequisite
  // gates must exit 2 with the named blocker first, installing and fetching nothing.
  const isolated = path.join(scratch, 'isolated-driver-copy');
  await mkdir(isolated);
  await copyFile(path.join(root, 'dist', 'scripts', 'zcode-onboarding-audit.js'), path.join(isolated, 'zcode-onboarding-audit.js'));
  let stderr = '', exitCode = 0;
  try { await exec(process.execPath, [path.join(isolated, 'zcode-onboarding-audit.js')], { cwd: isolated, env: baseEnv, timeout: 30000 }); }
  catch (error) { const failure = error as { stderr?: string; code?: number | string }; stderr = failure.stderr ?? ''; exitCode = typeof failure.code === 'number' ? failure.code : -1; }
  assert.equal(exitCode, 2, 'expected fail-closed exit 2, stderr: ' + stderr);
  assert.match(stderr, /BLOCKED: Dependencies are not installed/);
  assert.doesNotMatch(stderr, /Error \[?ERR_MODULE_NOT_FOUND|Cannot find module/);
  assert.equal(await exists(path.join(isolated, 'node_modules')), false);
  assert.equal(await exists(path.join(isolated, 'dist')), false);
  assert.equal(await exists(path.join(isolated, '.strata')), false);
});

test('owned onboarding documents carry resolvable local links, anchors, and schema-valid referenced examples', async () => {
  const documents = [
    path.join(root, 'README.md'),
    path.join(root, 'agent', 'strata', 'SKILL.md'),
    path.join(root, 'docs', 'AGENT_ONBOARDING_PLAN.md'),
  ];
  const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  const anchorsOf = (text: string) => new Set((text.match(/^#{1,6}\s+(.+)$/gm) ?? []).map(line => slug(line.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').replace(/`/g, ''))));
  for (const document of documents) {
    const text = await readFile(document, 'utf8');
    const anchors = anchorsOf(text);
    const links = [...text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?: "[^"]*")?\)/g)].map(match => match[1]);
    assert.ok(links.length > 0, document + ' has no local links to check');
    for (const link of links) {
      if (/^(https?:|mailto:)/.test(link)) continue;
      const [target, anchor] = link.split('#');
      let anchorPool = anchors;
      if (target) {
        const resolved = path.resolve(path.dirname(document), decodeURIComponent(target));
        assert.equal(await exists(resolved), true, document + ' links to missing ' + link);
        if (anchor && resolved.endsWith('.md')) anchorPool = anchorsOf(await readFile(resolved, 'utf8'));
      }
      if (anchor) assert.ok(anchorPool.has(anchor), document + ' anchor #' + anchor + ' (' + link + ') not found');
    }
  }
  // The quick start and the skill point hosts and agents at these tracked example files.
  normalizeSnapshot(JSON.parse(await readFile(path.join(root, 'examples', 'bootstrap.json'), 'utf8')));
  for (const name of ['L-hold.json', 'L-reminder.json', 'L-alternative.json']) parseLayer(JSON.parse(await readFile(path.join(root, 'examples', name), 'utf8')));
  parseComposition(JSON.parse(await readFile(path.join(root, 'examples', 'composition-conflict.json'), 'utf8')));
  const packet = JSON.parse(await readFile(path.join(root, 'examples', 'agent-session.json'), 'utf8'));
  assert.equal(packet.onboarding_version, '1');
  assert.equal(packet.manifest.project_root, '$PROJECT_ROOT');
  assert.equal(packet.manifest.session.trust_mode, 'local_fixture');
  assert.equal(packet.process_contract.common_argv.join(' '), '--project $PROJECT_ROOT --json --non-interactive --offline');
  assert.ok(Array.isArray(packet.steps) && packet.steps.length === 35);
});
