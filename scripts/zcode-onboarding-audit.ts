import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Bounded offline onboarding audit driver. No live mode exists: it never
// installs or fetches dependencies, starts brokers, contacts providers, or
// mutates tracked files. Only node: builtins are imported above; every
// dependency-bearing import (src/model.js pulls zod) happens dynamically
// AFTER the fail-closed prerequisite gates, so a machine without installed
// dependencies or a build exits 2 with the exact blocker instead of a
// module-load crash. It writes its JSON summary under the caller's .strata
// scratch. Operational broker commands are intentionally out of scope, so no
// broker prerequisite is exercised. Run: node dist/scripts/zcode-onboarding-audit.js
const exec = promisify(execFile);
const root = process.cwd();
const results: { check: string; status: 'passed' | 'failed'; detail?: string }[] = [];
async function record(check: string, run: () => Promise<string | void>) {
  try { const detail = await run(); results.push({ check, status: 'passed', ...(detail ? { detail } : {}) }); }
  catch (error) { results.push({ check, status: 'failed', detail: (error as Error).message }); }
}
const exists = (target: string) => access(target).then(() => true, () => false);
function failClosed(message: string): never {
  process.stderr.write('BLOCKED: ' + message + '\n');
  process.exit(2);
}

const [major] = process.versions.node.split('.');
if (Number(major) < 22) failClosed('Node 22+ is required; found ' + process.versions.node + '.');
if (!await exists(path.join(root, 'node_modules'))) failClosed('Dependencies are not installed; run npm ci --ignore-scripts (the offline variant needs the pinned packages already cached).');
if (!await exists(path.join(root, 'dist/src/cli.js'))) failClosed('The CLI is not built; run npm run build.');

const { MODEL, SUPPORTED_MODELS, normalizeSnapshot, parseLayer, parseComposition } = await import('../src/model.js');

const CLI = path.join(root, 'dist/src/cli.js');
await record('node-version', async () => process.versions.node);
for (const flag of ['--version', '--help']) {
  await record('cli ' + flag, async () => {
    const { stdout } = await exec(process.execPath, [CLI, flag], { timeout: 30000 });
    const envelope = JSON.parse(stdout);
    if (envelope.exit_code !== 0 || envelope.protocol_version !== '1') throw new Error('unexpected envelope for ' + flag);
    return 'protocol ' + envelope.protocol_version;
  });
}
await record('tracked examples parse against current schemas', async () => {
  normalizeSnapshot(JSON.parse(await readFile(path.join(root, 'examples/bootstrap.json'), 'utf8')));
  for (const name of ['L-hold.json', 'L-reminder.json', 'L-alternative.json']) parseLayer(JSON.parse(await readFile(path.join(root, 'examples', name), 'utf8')));
  parseComposition(JSON.parse(await readFile(path.join(root, 'examples/composition-conflict.json'), 'utf8')));
  const packet = JSON.parse(await readFile(path.join(root, 'examples/agent-session.json'), 'utf8'));
  if (packet.onboarding_version !== '1' || !Array.isArray(packet.steps)) throw new Error('agent-session packet shape changed');
  return 'bootstrap, three Layers, composition, packet';
});
await record('owned onboarding documents resolve local links', async () => {
  const documents = ['README.md', 'agent/strata/SKILL.md', 'docs/AGENT_ONBOARDING_PLAN.md'];
  let links = 0;
  for (const document of documents) {
    const text = await readFile(path.join(root, document), 'utf8');
    for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?: "[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:)/.test(target) || target.startsWith('#')) continue;
      if (!await exists(path.resolve(root, path.dirname(document), decodeURIComponent(target.split('#')[0])))) throw new Error(document + ' links to missing ' + target);
      links++;
    }
  }
  return links + ' local links across ' + documents.length + ' owned documents';
});
await record('synthetic fixture config matches a supported model', async () => {
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/zcode-onboarding/strata.config.json'), 'utf8'));
  if (!SUPPORTED_MODELS.includes(fixture.model_version)) throw new Error('fixture model_version is not supported');
  return fixture.model_version === MODEL ? 'v0.1 default model' : 'v0.2 content model';
});

const failed = results.filter(result => result.status === 'failed');
const summary = { status: failed.length ? 'failed' : 'passed', node: process.versions.node, offline_only: true, model_calls: 0, cloud_calls: 0, checks: results };
const outputDirectory = path.join(root, '.strata', 'zcode-onboarding');
await mkdir(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, 'audit-' + Date.now() + '.json');
await writeFile(outputFile, JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify({ status: summary.status, failed: failed.map(f => f.check), output: outputFile }, null, 2) + '\n');
if (failed.length) process.exitCode = 1;
