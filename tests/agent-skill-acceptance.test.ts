import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer } from '../src/security.js';
import { bootstrap, demoLayers } from '../src/fixtures.js';

// Focused acceptance for the portable agent skill's documented discovery and
// refusal contract: status security_context, the backup-only operator's read
// boundary, the null-versus-empty assigned-scope distinction, and the rule
// that refusals/dry runs leave semantic state untouched while denials are audited.
// All state is synthetic and test-owned; no skill sentence grants authority.
let root: string, scopedRoot: string, broker: Awaited<ReturnType<typeof startLocalBroker>>, scoped: Awaited<ReturnType<typeof startLocalBroker>>;
const env = (session: string) => ({ ...process.env, STRATA_SESSION: session });
async function cli(args: string[], record: unknown, session: string, project = root) {
  return runCli([...args, '--project', project, '--json', '--non-interactive', '--offline'], record === undefined ? undefined : JSON.stringify(record), env(session));
}
async function semanticStateOf(project: string) {
  const state = path.join(project, 'state');
  const files: Record<string, string> = {};
  async function visit(directory: string, relative = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (name === 'audit.jsonl' || name === '.node-state.lock') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, name);
      else if (entry.isFile()) files[name] = Buffer.from(await readFile(file)).toString('hex');
    }
  }
  await visit(state);
  return files;
}
const auditEventsOf = async (project: string) => (await readFile(path.join(project, 'state', 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const deniedCount = (events: any[], action: string, reason: string) => events.filter(event => event.action === action && event.outcome === 'denied' && event.reason === reason).length;

before(async () => {
  root = path.resolve('.strata/skill-acceptance-' + Date.now());
  broker = await startLocalBroker(path.join(root, 'state'), 0);
  const config = JSON.parse(await readFile('strata.config.json', 'utf8')); config.broker = broker.url;
  await writeFile(path.join(root, 'strata.config.json'), JSON.stringify(config));
  assert.equal((await cli(['init', '--file', '-'], bootstrap(), 'fixture-bootstrap')).exit_code, 0);
  const hold = demoLayers().a;
  await cli(['layer', 'create', '--file', '-'], hold, 'fixture-a');
  assert.equal((await cli(['layer', 'publish', 'L-hold@1'], undefined, 'fixture-a')).exit_code, 0);
  // A constructor-configured test-only assignment: the skill documents that an
  // empty assigned list denies those writes while null means no extra restriction.
  scopedRoot = path.resolve(root + '-scoped');
  await mkdir(scopedRoot, { recursive: true });
  scoped = await startLocalBroker(path.join(scopedRoot, 'state'), 0, { issuer: new FixtureIssuer({ assignments: { 'fixture-b': { principal: 'author-b', operations: ['status', 'inspect', 'layer.create', 'layer.revise', 'layer.publish'], layer_ids: [], write_block_ids: [] } } }) });
  const scopedConfig = { ...config, broker: scoped.url };
  await writeFile(path.join(scopedRoot, 'strata.config.json'), JSON.stringify(scopedConfig));
  assert.equal((await cli(['init', '--file', '-'], bootstrap(), 'fixture-bootstrap', scopedRoot)).exit_code, 0);
});
after(async () => {
  const closing = await Promise.allSettled([...(broker ? [broker.close()] : []), ...(scoped ? [scoped.close()] : [])]);
  await Promise.all([...(root ? [rm(root, { recursive: true, force: true })] : []), ...(scopedRoot ? [rm(scopedRoot, { recursive: true, force: true })] : [])]);
  const failure = closing.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});

test('skill discovery: version/help need no project and status exposes the server-resolved security context', async () => {
  const version = await runCli(['--version'], undefined, env('fixture-backup'));
  assert.equal(version.exit_code, 0); assert.equal(version.protocol_version, '1');
  assert.deepEqual(version.data.capabilities.profiles, ['booking-node/1', 'booking-node/2', 'booking-node/3', 'booking-node/4', 'counter-fixture/1', 'counter-host/1', 'collection-node/1', 'collection-host/1']);
  assert.equal(version.data.flags.includes('--offline'), true);
  const help = await runCli(['--help'], undefined, env('fixture-backup'));
  assert.equal(help.exit_code, 0); assert.equal(help.command, 'help');
  assert.deepEqual(help.data.capabilities.profiles, version.data.capabilities.profiles);
  assert.equal(help.data.commands.includes('materialize TARGET --profile PROFILE_ID --out DIR'), true);
  const config = await cli(['config', 'show'], undefined, 'fixture-b');
  assert.equal(config.exit_code, 0); assert.equal(config.data.sources.session, 'environment (redacted)');
  assert.equal(JSON.stringify(config).includes('fixture-b'), false);
  const status = await cli(['status'], undefined, 'fixture-b');
  assert.equal(status.exit_code, 0);
  const context = status.data.security_context;
  assert.equal(context.trust_mode, 'local_fixture'); assert.equal(context.principal_id, 'author-b');
  assert.equal(context.project_id, 'strata-local-demo');
  assert.equal(context.layer_ids, null); assert.equal(context.write_block_ids, null);
  for (const allowed of ['layer.create', 'layer.publish']) assert.equal(context.allowed_operations.includes(allowed), true);
  for (const forbidden of ['approve', 'release', 'backup.create', 'validate']) assert.equal(context.allowed_operations.includes(forbidden), false);
});

test('backup-only operator has no status grant and the refusal leaves semantic state unchanged', async () => {
  const before = await semanticStateOf(root);
  const auditBefore = await auditEventsOf(root);
  const denied = await cli(['status'], undefined, 'fixture-backup');
  assert.equal(denied.exit_code, 4); assert.equal(denied.ok, false);
  assert.equal(denied.errors[0].code, 'OPERATION_FORBIDDEN');
  assert.deepEqual(await semanticStateOf(root), before);
  const auditAfter = await auditEventsOf(root);
  assert.equal(deniedCount(auditAfter, 'status', 'OPERATION_FORBIDDEN'), deniedCount(auditBefore, 'status', 'OPERATION_FORBIDDEN') + 1);
});

test('null assigned scope permits owned authoring while an empty list denies it, even as a dry run', async () => {
  const reminder = demoLayers().b;
  const draft = await cli(['layer', 'create', '--file', '-'], reminder, 'fixture-b');
  assert.equal(draft.exit_code, 0); assert.equal(draft.data.published, false);
  assert.equal((await cli(['layer', 'publish', 'L-reminder@1'], undefined, 'fixture-b')).exit_code, 0);
  const scopedBefore = await semanticStateOf(scopedRoot);
  const auditBefore = await auditEventsOf(scopedRoot);
  for (const extra of [[], ['--dry-run']] as const) {
    const refused = await cli(['layer', 'create', ...extra, '--file', '-'], reminder, 'fixture-b', scopedRoot);
    assert.equal(refused.exit_code, 4); assert.equal(refused.errors[0].code, 'LAYER_SCOPE_FORBIDDEN');
  }
  assert.deepEqual(await semanticStateOf(scopedRoot), scopedBefore);
  const auditAfter = await auditEventsOf(scopedRoot);
  assert.equal(deniedCount(auditAfter, 'layer.create', 'LAYER_SCOPE_FORBIDDEN'), deniedCount(auditBefore, 'layer.create', 'LAYER_SCOPE_FORBIDDEN') + 2);
  assert.equal((await cli(['inspect', 'layer', 'L-reminder@1'], undefined, 'fixture-reader', scopedRoot)).exit_code, 3);
});

test('cross-owner revision is refused with OWNER_FORBIDDEN and leaves peer and semantic state bytes unchanged', async () => {
  const before = await semanticStateOf(root);
  const auditBefore = await auditEventsOf(root);
  const peerBefore = (await cli(['inspect', 'layer', 'L-hold@1'], undefined, 'fixture-reader')).data;
  const takeover = { ...demoLayers().a, revision: 2, owner: 'author-b' };
  const refused = await cli(['layer', 'revise', 'L-hold@1', '--file', '-'], takeover, 'fixture-b');
  assert.equal(refused.exit_code, 4); assert.equal(refused.ok, false);
  assert.equal(refused.errors[0].code, 'OWNER_FORBIDDEN');
  assert.deepEqual(await semanticStateOf(root), before);
  assert.deepEqual((await cli(['inspect', 'layer', 'L-hold@1'], undefined, 'fixture-reader')).data, peerBefore);
  const auditAfter = await auditEventsOf(root);
  assert.equal(deniedCount(auditAfter, 'layer.revise', 'OWNER_FORBIDDEN'), deniedCount(auditBefore, 'layer.revise', 'OWNER_FORBIDDEN') + 1);
});
