import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Engine } from '../src/core.js';
import { runCli, formatHuman } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer, LOCAL_PROJECT } from '../src/security.js';
import { executeAuthorized } from '../src/service.js';
import { personalContext, restoreLayer, type ContextMap } from '../src/recovery.js';
import { publishPrepared } from '../src/publication.js';
import { bootstrap, demoLayers, proposal, recipe } from '../src/fixtures.js';
import { MODEL, canonical, digest, StrataError } from '../src/model.js';
import { expiryRequirement } from '../src/profile.js';
import { prepared, unitValidation, approvals } from './helpers.js';

const error = (code: string) => (e: unknown) => e instanceof StrataError && e.code === code;
const workspace = 'a'.repeat(64);
function twoRevisions() {
  const engine = new Engine(); engine.init(bootstrap(), 'bootstrap');
  const a = demoLayers().a; engine.layer(a, 'author-a'); engine.publish('L-hold@1', 'author-a');
  const next = { ...structuredClone(a), revision: 2, changes: [] };
  engine.layer(next, 'author-a', 'L-hold@1');
  return { engine, a, next };
}
async function fixture(controls: Parameters<typeof startLocalBroker>[2] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'strata-recovery-'));
  const issuer = controls.issuer ?? new FixtureIssuer(); assert.ok(issuer instanceof FixtureIssuer);
  const broker = await startLocalBroker(path.join(root, 'state'), 0, { ...controls, issuer });
  const config = { schema_version: '1', model_version: MODEL, project_id: issuer.projectId, broker: broker.url, artifact_adapter: 'local-persistent-fake', profiles: ['booking-node/1'], identity_policy: 'trusted-local-fixture-sessions', network_policy: 'loopback-only' };
  await writeFile(path.join(root, 'strata.config.json'), JSON.stringify(config));
  const op = async (command: string, input: any = {}, session = 'fixture-reader', options: any = {}, project?: string): Promise<any> => (await fetch(broker.url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': session, 'x-strata-project': project ?? issuer.projectId }, body: JSON.stringify({ command, input, options }) })).json();
  const cli = (args: string[], session = 'fixture-reader', record?: any) => runCli([...args, '--project', root, '--json', '--non-interactive'], record === undefined ? undefined : JSON.stringify(record), { ...process.env, STRATA_SESSION: session });
  const index = async () => JSON.parse(await readFile(path.join(root, 'state/registry.json'), 'utf8'));
  await op('init', { record: bootstrap() }, 'fixture-bootstrap');
  return { root, issuer, broker, config, op, cli, index };
}
async function authorTwo(f: Awaited<ReturnType<typeof fixture>>) {
  const { a } = demoLayers();
  assert.equal((await f.op('layer.create', { record: a }, 'fixture-a')).ok, true);
  assert.equal((await f.op('layer.publish', { ref: 'L-hold@1' }, 'fixture-a')).ok, true);
  assert.equal((await f.op('layer.revise', { previous: 'L-hold@1', record: { ...a, revision: 2, changes: [] } }, 'fixture-a')).ok, true);
}

test('restore appends a private revision and preserves all published Release, proposal, approval and evidence bytes', () => {
  const p = prepared(), v = unitValidation(p.engine, p.candidate);
  const release = p.engine.release(p.candidate.ref, v.validation.ref, approvals(p.engine, p.candidate, v.validation.evidence_digest));
  p.engine.layer({ ...p.a, revision: 2, changes: [] }, 'author-a', 'L-hold@1'); p.engine.publish('L-hold@2', 'author-a');
  const before = structuredClone(p.engine.records);
  const result = restoreLayer(p.engine, { ref: 'L-hold@2', from: 'L-hold@1' }, 'author-a');
  assert.equal(result.ref, 'L-hold@3'); assert.equal(result.published, false); assert.equal(result.evidence_reused, false);
  assert.equal(result.recovery.source_fingerprint, digest(p.a));
  for (const [ref, record] of Object.entries(before)) assert.deepEqual(p.engine.records[ref], record);
  assert.deepEqual(p.engine.records[release.ref], before[release.ref]);
  assert.deepEqual(p.engine.records[result.ref].data, { ...p.a, revision: 3 });
  assert.deepEqual(p.engine.ownerHeads['L-hold'], { owner: 'author-a', head: 3 });
  assert.throws(() => p.engine.read(result.ref, 'layer'), error('REF_NOT_FOUND'));
});

test('restore rejects stale heads, peer/private sources, equal revisions, rebasing and unsupported content without state changes', () => {
  for (const [input, principal, code] of [
    [{ ref: 'L-hold@1', from: 'L-hold@1' }, 'author-a', 'RESTORE_SOURCE_MISMATCH'],
    [{ ref: 'L-hold@2', from: 'L-hold@2' }, 'author-a', 'RESTORE_SOURCE_MISMATCH'],
    [{ ref: 'L-hold@2', from: 'L-hold@1' }, 'author-b', 'REF_NOT_FOUND'],
    [{ ref: 'L-hold@2', from: 'missing@1' }, 'author-a', 'REF_NOT_FOUND'],
  ] as const) {
    const { engine } = twoRevisions(), before = canonical({ records: engine.records, heads: engine.ownerHeads });
    assert.throws(() => restoreLayer(engine, input, principal), error(code));
    assert.equal(canonical({ records: engine.records, heads: engine.ownerHeads }), before);
  }
  const { engine } = twoRevisions(); engine.layer({ ...demoLayers().a, revision: 3 }, 'author-a', 'L-hold@2');
  assert.throws(() => restoreLayer(engine, { ref: 'L-hold@2', from: 'L-hold@1' }, 'author-a'), error('STALE_REVISION'));
  engine.records['L-hold@1'].data.baseline = 'other@1';
  assert.throws(() => restoreLayer(engine, { ref: 'L-hold@3', from: 'L-hold@1' }, 'author-a'), error('MIXED_BASELINE'));
  engine.records['L-hold@1'].data.baseline = 'R0@1'; engine.records['L-hold@1'].data.changes[0].op = 'remove_item';
  assert.throws(() => restoreLayer(engine, { ref: 'L-hold@3', from: 'L-hold@1' }, 'author-a'), error('INVALID_RECORD'));
});

test('new restored candidate cannot borrow old evidence; supplied-proposal restoration needs a new exact draft review', () => {
  const p = prepared(), v = unitValidation(p.engine, p.candidate);
  p.engine.layer({ ...p.a, revision: 2 }, 'author-a', 'L-hold@1');
  const restored = restoreLayer(p.engine, { ref: 'L-hold@2', from: 'L-hold@1' }, 'author-a'); p.engine.publish(restored.ref, 'author-a');
  const r = recipe('C-restored'); r.proposals = [restored.ref]; r.selected = [restored.ref]; r.alternative_groups = []; r.resolutions = [];
  const candidate = p.engine.compose(r);
  assert.throws(() => p.engine.release(candidate.ref, v.validation.ref, []), error('STALE_EVIDENCE'));
  const { engine } = twoRevisions(); const distilled = proposal('L-distilled', 'author-a');
  distilled.derived_from = { kind: 'supplied_proposal', source_digest: 'a'.repeat(64), against: 'R0@1', traceability: [], questions: [] };
  engine.layer(distilled, 'author-a');
  const review = { source_digest: distilled.derived_from.source_digest, draft_digest: digest(distilled), reviewer: 'author-a', accepted: true };
  engine.publish('L-distilled@1', 'author-a', review); engine.layer({ ...distilled, revision: 2 }, 'author-a', 'L-distilled@1');
  const d = restoreLayer(engine, { ref: 'L-distilled@2', from: 'L-distilled@1' }, 'author-a');
  assert.equal(d.review_required, true); assert.throws(() => engine.publish(d.ref, 'author-a', review), error('DISTILL_REVIEW_REQUIRED'));
});

test('source writes are checked against current assigned scope, including when the current head has no writes', () => {
  const { engine } = twoRevisions(), input = { ref: 'L-hold@2', from: 'L-hold@1' };
  const scoped = new FixtureIssuer({ assignments: { 'fixture-a': { principal: 'author-a', operations: ['layer.restore'], layer_ids: ['L-hold'], write_block_ids: ['booking.reminder'] } } });
  assert.throws(() => executeAuthorized(engine, 'layer.restore', input, scoped.resolve('fixture-a'), scoped), error('BLOCK_SCOPE_FORBIDDEN'));
  const issuer = new FixtureIssuer();
  assert.throws(() => executeAuthorized(engine, 'layer.restore', input, issuer.resolve('fixture-reader'), issuer), error('OPERATION_FORBIDDEN'));
  const restricted = new FixtureIssuer({ assignments: { 'fixture-a': { principal: 'author-a', operations: ['layer.restore'], layer_ids: ['other'] } } });
  assert.throws(() => executeAuthorized(engine, 'layer.restore', input, restricted.resolve('fixture-a'), restricted), error('LAYER_SCOPE_FORBIDDEN'));
});

test('personal contexts isolate principals/workspaces, display blocked candidates, and reject tampered exact targets', () => {
  const p = prepared(), contexts: ContextMap = {}, before = canonical(p.engine.records);
  assert.equal(personalContext(p.engine, contexts, 'context.show', { workspace }, 'reader').state, 'unset');
  const selected = personalContext(p.engine, contexts, 'context.use', { workspace, target: 'R0@1', expected_generation: 0 }, 'reader');
  assert.equal(selected.baseline_ref, 'R0@1'); assert.equal(selected.generation, 1);
  assert.equal(personalContext(p.engine, contexts, 'context.show', { workspace }, 'author-a').state, 'unset');
  assert.equal(personalContext(p.engine, contexts, 'context.show', { workspace: 'b'.repeat(64) }, 'reader').state, 'unset');
  assert.throws(() => personalContext(p.engine, contexts, 'context.use', { workspace, target: p.candidate.ref, expected_generation: 0 }, 'reader'), error('STALE_CONTEXT'));
  const blocked = personalContext(p.engine, contexts, 'context.use', { workspace, target: p.blocked.ref, expected_generation: 1 }, 'reader');
  assert.equal(blocked.candidate_state, 'blocked'); assert.deepEqual(blocked.selected_layers, p.engine.read(p.blocked.ref, 'composition').selected);
  assert.equal(canonical(p.engine.records), before);
  p.engine.records[p.blocked.ref].data.scenario.id = 'tampered';
  assert.throws(() => personalContext(p.engine, contexts, 'context.show', { workspace }, 'reader'), error('CONTEXT_TARGET_CHANGED'));
});

test('ordinary parallel Layer publication preserves unrelated personal context metadata', () => {
  const a = demoLayers().a, contexts = { [workspace]: { generation: 1, target: 'R0@1', fingerprint: 'a'.repeat(64) } };
  const registry = { entries: {}, heads: {}, contexts };
  const next = publishPrepared(registry, { id: a.id, principal: a.owner, expected_head: null, refs: {}, ref: 'L-hold@1', entry: { type: 'layer', hash: digest(a), published: false }, record: { type: 'layer', data: a, published: false }, head: { owner: a.owner, head: 1 } });
  assert.deepEqual(next.contexts, contexts);
});

test('CLI personal navigation persists across restart, keeps mutation inputs explicit and leaves semantic artifacts unchanged', async () => {
  const f = await fixture();
  try {
    const before = await f.index(), artifactNames = await readdir(path.join(f.root, 'state/artifacts'));
    assert.equal((await f.cli(['context', 'show'])).data.state, 'unset');
    const use = await f.cli(['context', 'use', 'R0@1', '--expect-generation', '0']);
    assert.equal(use.exit_code, 0); assert.equal(use.data.project_id, LOCAL_PROJECT); assert.deepEqual(use.effects.created, []);
    assert.match(formatHuman(use), /generation: 1/); assert.match(formatHuman(use), /baseline ref: R0@1/);
    assert.deepEqual((await f.index()).entries, before.entries); assert.deepEqual((await f.index()).heads, before.heads);
    assert.deepEqual(await readdir(path.join(f.root, 'state/artifacts')), artifactNames);
    assert.equal((await f.cli(['context', 'show'], 'fixture-a')).data.state, 'unset');
    assert.equal((await f.cli(['materialize', '--profile', 'booking-node/1', '--out', '.strata/output'])).exit_code, 2);
    assert.equal((await f.cli(['context', 'use', 'R0@1', '--expect-generation', '1.0'])).exit_code, 2);
    const index = canonical(await f.index());
    const dry = await f.cli(['context', 'use', 'R0@1', '--expect-generation', '1', '--dry-run']); assert.equal(dry.data.generation, 2); assert.equal(canonical(await f.index()), index);
    await f.broker.close();
    const restarted = await startLocalBroker(path.join(f.root, 'state'), 0);
    try { await writeFile(path.join(f.root, 'strata.config.json'), JSON.stringify({ ...f.config, broker: restarted.url })); assert.equal((await f.cli(['context', 'show'])).data.generation, 1); }
    finally { await restarted.close(); }
  } finally { if (f.broker.server.listening) await f.broker.close(); }
});

test('simultaneous context updates and restores use CAS: exactly one wins, with no auto-retargeting or history loss', async () => {
  const f = await fixture();
  try {
    const selection = await Promise.all([0, 1].map(() => f.op('context.use', { workspace, target: 'R0@1', expected_generation: 0 })));
    assert.equal(selection.filter(r => r.ok).length, 1); assert.equal(selection.find(r => !r.ok).error.code, 'STALE_CONTEXT');
    await authorTwo(f); const before = await f.index();
    const result = await Promise.all(['a', 'b'].map(idempotency_key => f.op('layer.restore', { ref: 'L-hold@2', from: 'L-hold@1' }, 'fixture-a', { idempotency_key })));
    assert.equal(result.filter(r => r.ok).length, 1); assert.equal(result.find(r => !r.ok).error.code, 'STALE_REVISION');
    const after = await f.index(); assert.equal(after.heads['L-hold'].head, 3);
    for (const [ref, entry] of Object.entries(before.entries)) assert.deepEqual(after.entries[ref], entry);
    assert.equal(after.entries['L-hold@3'].published, false);
    assert.equal(after.commit_audit.at(-1).action, 'layer.restore');
    assert.deepEqual(after.commit_audit.at(-1).references, ['L-hold@2', 'L-hold@1', 'sha256:' + digest(demoLayers().a), 'L-hold@3']);
  } finally { await f.broker.close(); }
});

test('restore dry-run, denied/spoofed inputs and unavailable/foreign navigation targets do not commit', async () => {
  const f = await fixture();
  try {
    await authorTwo(f); const before = canonical(await f.index()), files = await readdir(path.join(f.root, 'state/artifacts'));
    const dry = await f.cli(['layer', 'restore', 'L-hold@2', '--from', 'L-hold@1', '--dry-run'], 'fixture-a');
    assert.equal(dry.exit_code, 0); assert.equal(dry.data.ref, 'L-hold@3'); assert.deepEqual(dry.effects.created, []);
    for (const [command, input, session, code] of [
      ['layer.restore', { ref: 'L-hold@2', from: 'L-hold@1' }, 'fixture-reader', 'OPERATION_FORBIDDEN'],
      ['layer.restore', { ref: 'L-hold@2', from: 'L-hold@1', record: demoLayers().a }, 'fixture-a', 'INVALID_ARGUMENT'],
      ['context.use', { workspace, target: 'HEAD', expected_generation: 0 }, 'fixture-reader', 'INVALID_ARGUMENT'],
      ['context.use', { workspace, target: 'L-hold@2', expected_generation: 0 }, 'fixture-reader', 'REF_NOT_FOUND'],
      ['context.use', { workspace, target: 'absent@1', expected_generation: 0 }, 'fixture-reader', 'REF_NOT_FOUND'],
      ['context.use', { workspace, target: 'R0@1', expected_generation: 0, principal: 'author-a' }, 'fixture-reader', 'INVALID_ARGUMENT'],
    ] as const) assert.equal((await f.op(command, input, session)).error.code, code);
    assert.equal((await f.op('context.show', { workspace }, 'fixture-reader', {}, 'another-project')).error.code, 'PROJECT_FORBIDDEN');
    assert.equal(canonical(await f.index()), before); assert.deepEqual(await readdir(path.join(f.root, 'state/artifacts')), files);
    await assert.rejects(access(path.join(f.root, '.strata/output')));
  } finally { await f.broker.close(); }
});

test('lost committed restoration response retries once; revocation and newly narrowed source scope block cached results', async () => {
  let fault: 'after-stage' | 'after-commit' | undefined;
  const f = await fixture({ faultForTest: () => fault });
  try {
    await authorTwo(f); const input = { ref: 'L-hold@2', from: 'L-hold@1' }, options = { idempotency_key: 'lost-restore' };
    fault = 'after-commit'; assert.equal((await f.op('layer.restore', input, 'fixture-a', options)).error.code, 'INJECTED_RESPONSE_LOSS'); fault = undefined;
    const retry = await f.op('layer.restore', input, 'fixture-a', options);
    assert.equal(retry.ok, true); assert.equal(retry.reused, true); assert.equal(retry.data.ref, 'L-hold@3');
    assert.equal((await f.index()).heads['L-hold'].head, 3);
    await f.broker.close();
    const scoped = new FixtureIssuer({ assignments: { 'fixture-a': { principal: 'author-a', operations: ['layer.restore'], layer_ids: ['L-hold'], write_block_ids: ['booking.reminder'] } } });
    const restarted = await startLocalBroker(path.join(f.root, 'state'), 0, { issuer: scoped });
    try {
      const result: any = await (await fetch(restarted.url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': 'fixture-a' }, body: JSON.stringify({ command: 'layer.restore', input, options }) })).json();
      assert.equal(result.error.code, 'BLOCK_SCOPE_FORBIDDEN');
    } finally { await restarted.close(); }
    f.issuer.suspendForTest('author-a');
    assert.throws(() => f.issuer.resolve('fixture-a'), error('ACCESS_REVOKED'));
  } finally { if (f.broker.server.listening) await f.broker.close(); }
});

test('revoked policy between restoration staging and commit preserves the prior publication index', async () => {
  const issuer = new FixtureIssuer(); let suspend = false;
  const f = await fixture({ issuer, afterStage: async () => { if (suspend) issuer.suspendForTest('author-a'); } });
  try {
    await authorTwo(f); const before = canonical(await f.index()); suspend = true;
    assert.equal((await f.op('layer.restore', { ref: 'L-hold@2', from: 'L-hold@1' }, 'fixture-a')).error.code, 'ACCESS_REVOKED');
    assert.equal(canonical(await f.index()), before);
  } finally { await f.broker.close(); }
});

test('local SDK broker supports navigation/restoration and preserves context through normal LayerAgent publication', { timeout: 65000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'strata-recovery-sdk-'));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string'); const port = address.port; await new Promise<void>(resolve => server.close(() => resolve()));
  const sdkConfig = { name: 'strata-recovery-test', main: path.join(repo, 'src/worker.ts'), compatibility_date: '2026-10-03', compatibility_flags: ['nodejs_compat'], durable_objects: { bindings: [{ name: 'PROJECT', class_name: 'ProjectAgent' }, { name: 'LAYERS', class_name: 'LayerAgent' }, { name: 'LOCAL_ARTIFACTS', class_name: 'LocalArtifactStore' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['ProjectAgent', 'LayerAgent', 'LocalArtifactStore'] }], vars: { LOCAL_FIXTURES: 'true' }, observability: { enabled: false } };
  await writeFile(path.join(root, 'wrangler.json'), JSON.stringify(sdkConfig));
  const child = spawn(process.execPath, [path.join(repo, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', path.join(root, 'wrangler.json'), '--ip', '127.0.0.1', '--port', String(port), '--persist-to', path.join(root, 'state')], { cwd: root, windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error', WRANGLER_LOG_PATH: path.join(root, 'wrangler.log'), XDG_CONFIG_HOME: path.join(root, 'wrangler-config'), CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const url = `http://127.0.0.1:${port}`;
  const op = async (command: string, input: any, session = 'fixture-reader', options: any = {}): Promise<any> => (await fetch(url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': session }, body: JSON.stringify({ command, input, options }), signal: AbortSignal.timeout(5000) })).json();
  try {
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline && child.exitCode === null) { try { ready = (await fetch(url + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert(ready, 'Isolated local SDK broker did not start; inspect the temporary runtime log.');
    assert.equal((await op('init', { record: bootstrap() }, 'fixture-bootstrap')).ok, true);
    assert.equal((await op('context.use', { workspace, target: 'R0@1', expected_generation: 0 })).data.generation, 1);
    const a = demoLayers().a; assert.equal((await op('layer.create', { record: a }, 'fixture-a')).ok, true);
    assert.equal((await op('layer.publish', { ref: 'L-hold@1' }, 'fixture-a')).ok, true);
    assert.equal((await op('layer.revise', { previous: 'L-hold@1', record: { ...a, revision: 2, changes: [] } }, 'fixture-a')).ok, true);
    const restored = await op('layer.restore', { ref: 'L-hold@2', from: 'L-hold@1' }, 'fixture-a', { idempotency_key: 'sdk-owned-restore' });
    assert.equal(restored.ok, true); assert.equal(restored.data.ref, 'L-hold@3'); assert.equal(restored.data.published, false);
    assert.equal((await op('layer.restore', { ref: 'L-hold@2', from: 'L-hold@1' }, 'fixture-a', { idempotency_key: 'sdk-owned-restore' })).reused, true);
    assert.equal((await op('layer.restore', { ref: 'L-hold@2', from: 'L-hold@1' }, 'fixture-a')).error.code, 'STALE_REVISION');
    assert.equal((await op('context.show', { workspace })).data.generation, 1);
    assert.equal((await op('context.show', { workspace }, 'fixture-a')).data.state, 'unset');
    assert.equal((await op('context.use', { workspace, target: 'R0@1', expected_generation: 0 })).error.code, 'STALE_CONTEXT');
    assert.equal((await op('layer.publish', { ref: 'L-hold@3' }, 'fixture-b')).error.code, 'OWNER_FORBIDDEN');
    const dry = await op('layer.restore', { ref: 'L-hold@3', from: 'L-hold@1' }, 'fixture-a', { dry_run: true }); assert.equal(dry.data.ref, 'L-hold@4'); assert.deepEqual(dry.created, []);
    assert.equal((await op('status', {}, 'fixture-a')).data.owned_heads['L-hold'].head, 3);
    const b = proposal('L-bootstrap-recovery', 'bootstrap');
    await op('layer.create', { record: b }, 'fixture-bootstrap'); await op('layer.revise', { previous: 'L-bootstrap-recovery@1', record: { ...b, revision: 2 } }, 'fixture-bootstrap');
    const input = { ref: 'L-bootstrap-recovery@2', from: 'L-bootstrap-recovery@1' }, options = { idempotency_key: 'sdk-lost-restore', fault: 'after-commit' };
    assert.equal((await op('layer.restore', input, 'fixture-bootstrap', options)).error.code, 'INJECTED_RESPONSE_LOSS');
    assert.equal((await op('layer.restore', input, 'fixture-bootstrap', { idempotency_key: options.idempotency_key })).data.ref, 'L-bootstrap-recovery@3');
    assert.equal((await op('context.show', { workspace })).data.target, 'R0@1');
  } finally {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    await writeFile(path.join(root, 'runtime.log'), log);
  }
});
