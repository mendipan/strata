import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer } from '../src/security.js';
import { BLOCK_MODEL, MODEL } from '../src/model.js';
import { runAuthorStudio } from '../scripts/studio-author.js';
import { presentOperationEffects } from '../src/commands/replay-effects.js';
import { WORKFLOW_READS } from '../src/workflow.js';
import { decodeGit, runGit } from '../src/git-workspace.js';

async function retainEvidence(lane: string, cases: unknown) {
  await mkdir('.strata', { recursive: true });
  const source = decodeGit(await runGit(process.cwd(), ['rev-parse', 'HEAD'])).trim();
  const clientBytes = await readFile(new URL('../src/commands/client.js', import.meta.url));
  const hostedBytes = await readFile(new URL('../src/commands/host-client.js', import.meta.url));
  await writeFile('.strata/operation-replay-effects-' + lane + '.json', JSON.stringify({ format: 'operation-replay-effects-evidence/1',
    source_sha: source, lane, trust: 'disposable-synthetic-fixture', runtime: { node: process.version, platform: process.platform },
    compiled_clients: { local: createHash('sha256').update(clientBytes).digest('hex'), hosted: createHash('sha256').update(hostedBytes).digest('hex') }, cases }, null, 2) + '\n');
}

async function removeFixture(root: string) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('strata-replay-effects-'));
  assert(!(await lstat(root)).isSymbolicLink());
  await rm(root, { recursive: true, force: true });
}
const fixture = async (name: string) => JSON.parse(await readFile('tests/fixtures/counter/' + name + '.json', 'utf8'));

test('replay projection preserves receipt bytes and does not infer operation reuse from result flags', () => {
  const retained = Object.freeze({ ok: true, reused: true, created: Object.freeze(['draft@1', 'review@2']),
    data: Object.freeze({ ref: 'review@2', reused: false }), operation_id: 'exact-operation' });
  const before = JSON.stringify(retained), replay = presentOperationEffects(retained as any);
  assert.deepEqual(replay.created, []); assert.equal(replay.data, retained.data);
  assert.equal(replay.operation_id, retained.operation_id); assert.equal(replay.reused, true);
  assert.equal(JSON.stringify(retained), before); assert.notEqual(replay, retained);
  const fresh = { created: ['draft@1'], data: { reused: true } };
  assert.equal(presentOperationEffects(fresh), fresh);
});

test('real local CLI replay preserves history across restart and still refuses changed input and revoked actor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-replay-effects-local-')), issuer = new FixtureIssuer();
  let broker = await startLocalBroker(path.join(root, 'state'), 0, { issuer });
  const configure = async () => writeFile(path.join(root, 'strata.config.json'), JSON.stringify({ schema_version: '1', model_version: MODEL,
    project_id: issuer.projectId, broker: broker.url, artifact_adapter: 'local-persistent-fake', profiles: ['counter-fixture/1'],
    identity_policy: 'trusted-local-fixture-sessions', network_policy: 'loopback-only' }));
  const cli = (args: string[], input?: any, actor = 'fixture-a') => runCli([...args, '--project', root, '--json', '--offline', '--non-interactive'],
    input === undefined ? undefined : JSON.stringify(input), { STRATA_SESSION: actor });
  try {
    await configure(); assert.equal((await cli(['init', '--file', '-'], await fixture('bootstrap'), 'fixture-bootstrap')).ok, true);
    const layer = await fixture('extend'), args = ['layer', 'create', '--file', '-', '--idempotency-key', 'local-replay'];
    const first = await cli(args, layer); assert.equal(first.ok, true, JSON.stringify(first.errors));
    assert(first.effects.created.includes(first.data.ref)); assert.deepEqual(first.effects.reused, []);
    const history = await readFile(path.join(root, 'state/registry.json'), 'utf8');
    const replay = await cli(args, layer); assert.equal(replay.ok, true, JSON.stringify(replay.errors));
    assert.deepEqual(replay.data, first.data); assert.equal(replay.operation_id, first.operation_id);
    assert.deepEqual(replay.effects.created, []); assert.deepEqual(replay.effects.reused, [first.data.ref]);
    assert.deepEqual(replay.effects.network, ['loopback-broker']); assert.deepEqual(replay.effects.usage, []);
    assert.equal(await readFile(path.join(root, 'state/registry.json'), 'utf8'), history);
    const inspected = await cli(['operation', 'inspect', 'local-replay']);
    assert.equal(inspected.data.state, 'committed'); assert.deepEqual(inspected.data.result.created, first.effects.created);
    assert.deepEqual(inspected.data.result.data, first.data);
    const conflict = await cli(args, { ...layer, intent: 'Different exact input.' });
    assert.equal(conflict.exit_code, 5); assert.equal(conflict.errors[0].code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(conflict.effects.created, []); assert.deepEqual(conflict.effects.reused, []);
    const dry = await cli(['layer', 'create', '--file', '-', '--idempotency-key', 'local-dry', '--dry-run'], { ...layer, id: 'ReplayDryLayer' }); assert.equal(dry.ok, true, JSON.stringify(dry.errors));
    assert.deepEqual(dry.effects.created, []); assert.deepEqual(dry.effects.reused, []);
    await broker.close(); broker = await startLocalBroker(path.join(root, 'state'), 0, { issuer }); await configure();
    const restarted = await cli(args, layer); assert.equal(restarted.ok, true);
    assert.deepEqual(restarted.data, first.data); assert.deepEqual(restarted.effects.created, []);
    assert.deepEqual(restarted.effects.reused, [first.data.ref]);
    assert.equal(await readFile(path.join(root, 'state/registry.json'), 'utf8'), history);
    issuer.suspendForTest(layer.owner);
    const denied = await cli(args, layer); assert.equal(denied.exit_code, 4); assert.equal(denied.errors[0].code, 'ACCESS_REVOKED');
    assert.deepEqual(denied.effects.created, []); assert.deepEqual(denied.effects.reused, []);
    assert.equal(await readFile(path.join(root, 'state/registry.json'), 'utf8'), history);
    await retainEvidence('local', { first, replay, historical_inspection: inspected, conflict, dry_run: dry, restarted, denied,
      semantic_registry_bytes_unchanged: true });
  } finally { await broker.close(); await removeFixture(root); }
});

test('real synthetic hosted CLI replay preserves raw receipt and rejects a narrowed grant', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-replay-effects-host-')), origin = 'https://replay.example';
  // Disposable synthetic account only; no real account/configuration is read.
  const key = Buffer.from(randomBytes(32)).toString('base64url'), projectId = 'synthetic-replay-effects';
  const reads = [...new Set([...WORKFLOW_READS, 'inspect', 'operation.inspect', 'status', 'diff', 'conflicts'])];
  const accounts = { format: 'strata-host-accounts/1', generation: 1, accounts: [{ account_id: 'author', principal_id: 'author',
    principal_kind: 'person', active: true, credential_epoch: 1, key_sha256: createHash('sha256').update(key).digest('hex') }] };
  const policy = { format: 'strata-host-policy/1', project_id: projectId, generation: 1, grants: [{ grant_id: 'author', principal_id: 'author',
    operations: [...reads, 'init', 'layer.create'], layer_ids: null, write_block_ids: ['app'], create_under_block_ids: [],
    approvals: [], profiles: [], expires_at: new Date(Date.now() + 3600000).toISOString() }] };
  const config = { format: 'strata-studio-author-host/1', project_id: projectId, project_directory: root,
    state_directory: path.join(root, 'state'), accounts_file: path.join(root, 'accounts.json'), policy_file: path.join(root, 'policy.json'),
    public_origin: origin, trusted_proxy_addresses: ['127.0.0.1'], port: 0, operations: ['init', 'layer.create'], output_slots: {}, runner_profiles: [] };
  for (const [name, value] of [['accounts', accounts], ['policy', policy], ['host', config]] as const)
    await writeFile(path.join(root, name + '.json'), JSON.stringify(value), { mode: 0o600 });
  await writeFile(path.join(root, 'strata.config.json'), JSON.stringify({ schema_version: '1', model_version: BLOCK_MODEL,
    project_id: projectId, broker: origin, artifact_adapter: 'hosted-local-state', identity_policy: 'host-accounts/1', network_policy: 'configured-https', profiles: [] }));
  const host = await runAuthorStudio(path.join(root, 'host.json'), path.resolve('explorer')), originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) {
      assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Test permits only synthetic-origin proxy and loopback broker calls.');
      return originalFetch(input, init);
    }
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(host.origin + url.pathname + url.search, { method: init.method ?? 'GET',
        headers: { ...init.headers, host: 'replay.example', 'x-forwarded-proto': 'https' } }, response => {
        const chunks: Buffer[] = []; response.on('data', data => chunks.push(data));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as any })));
      });
      request.on('error', reject); request.end(init.body);
    });
  };
  const cli = (args: string[], input?: any) => runCli([...args, '--project', root, '--json', '--non-interactive'],
    input === undefined ? undefined : JSON.stringify(input), { STRATA_HOST_ACCOUNT: 'author', STRATA_HOST_KEY: key });
  try {
    const baseline = { id: 'ReplayBaseline', revision: 1, model_version: BLOCK_MODEL, root: 'app', blocks: { app: { id: 'app', parent: null,
      purpose: 'Retain synthetic items.', description: { format: 'plain-text/1', text: '' }, asset_refs: {}, requirements: {}, acceptance: {},
      relationships: {}, contract: { inputs: {}, outputs: {}, failures: {} } } },
      authorities: { scopes: [{ block: 'app', selectors: ['author'] }], release: ['author'], guardians: [] }, deleted_ids: [] };
    const initialized = await cli(['init', '--file', '-'], baseline); assert.equal(initialized.ok, true, JSON.stringify(initialized.errors));
    const layer = { id: 'ReplayLayer', revision: 1, model_version: BLOCK_MODEL, owner: 'author', baseline: 'ReplayBaseline@1', intent: 'Clarify synthetic items.',
      created_blocks: [], changes: [{ op: 'set_item', block: 'app', path: 'purpose', expected: { kind: 'value', value: baseline.blocks.app.purpose }, value: 'Retain checked synthetic items.' }],
      acceptance: [], read_set: [], requires_layers: [], assumptions: [], resolution_proposals: [], derived_from: null };
    const args = ['layer', 'create', '--file', '-', '--idempotency-key', 'host-replay'];
    const first = await cli(args, layer); assert.equal(first.ok, true, JSON.stringify(first.errors)); assert(first.effects.created.includes(first.data.ref));
    const replay = await cli(args, layer); assert.equal(replay.ok, true, JSON.stringify(replay.errors));
    assert.deepEqual(replay.data, first.data); assert.equal(replay.operation_id, first.operation_id);
    assert.deepEqual(replay.effects.created, []); assert.deepEqual(replay.effects.reused, [first.data.ref]);
    assert.deepEqual(replay.effects.network, ['configured-https-studio']); assert.equal(JSON.stringify(replay).includes(key), false);
    const inspected = await cli(['operation', 'inspect', 'host-replay']); assert.equal(inspected.ok, true, JSON.stringify(inspected.errors));
    assert.deepEqual(inspected.data.result.created, first.effects.created); assert.deepEqual(inspected.data.result.data, first.data);
    const conflict = await cli(args, { ...layer, intent: 'Different exact input.' }); assert.equal(conflict.exit_code, 5);
    assert.deepEqual(conflict.effects.created, []); assert.deepEqual(conflict.effects.reused, []);
    policy.generation++; policy.grants[0].operations = [...reads];
    await writeFile(path.join(root, 'policy.json'), JSON.stringify(policy));
    const denied = await cli(args, layer); assert.equal(denied.exit_code, 4); assert.equal(denied.errors[0].code, 'OPERATION_FORBIDDEN');
    assert.deepEqual(denied.effects.created, []); assert.deepEqual(denied.effects.reused, []);
    assert.equal((await cli(['inspect', 'layer', first.data.ref])).ok, true);
    const cases = { first, replay, historical_inspection: inspected, conflict, denied };
    assert.equal(JSON.stringify(cases).includes(key), false); await retainEvidence('hosted', cases);
  } finally { globalThis.fetch = originalFetch; await host.close(); await removeFixture(root); }
});
