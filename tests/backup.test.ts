import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, cp, unlink, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackup, verifyBackup, restoreBackup, BACKUP_LIMITS } from '../src/backup.js';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer, LOCAL_PROJECT, auditEvent } from '../src/security.js';
import { STATE_LEASE, STATE_DESCRIPTOR, INACTIVE_MARKER, assertQuiesced } from '../src/node-state.js';
import { canonical, digest, bytesDigest, MODEL } from '../src/model.js';
import { runCli, formatHuman } from '../src/cli.js';
import { restoreLayer } from '../src/recovery.js';
import { execute } from '../src/service.js';
import { proposal } from '../src/fixtures.js';
import { prepared, unitValidation, approvals } from './helpers.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'strata-backup-drill-'));
after(async () => { await rm(temp, { recursive: true, force: true }); });
let sequence = 0;
const newPath = (name: string) => path.join(temp, `${++sequence}-${name}`);
const selector = 'fixture-backup'; const project = LOCAL_PROJECT;
const exists = async (file: string) => { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
const decode = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const expectCode = (code: string) => (error: any) => { assert.equal(error.code, code); return true; };

async function fixture() {
  const root = newPath('project'); const state = path.join(root, 'state');
  await mkdir(root); await writeFile(path.join(root, 'strata.config.json'), canonical({ schema_version: '1', model_version: MODEL, project_id: project, broker: 'http://127.0.0.1:1', artifact_adapter: 'local-persistent-fake', profiles: ['booking-node/1'], identity_policy: 'trusted-local-fixture-sessions', network_policy: 'loopback-only' }));
  const broker = await startLocalBroker(state, 0); await broker.close();
  const { engine, candidate } = prepared(); const evidence = unitValidation(engine, candidate);
  const release = engine.release(candidate.ref, evidence.validation.ref, approvals(engine, candidate, evidence.validation.evidence_digest));
  const privateLayer = proposal('L-private', 'author-b'); engine.layer(privateLayer, 'author-b');
  const revised = structuredClone(privateLayer); revised.revision = 2; revised.intent = 'Private replacement proposal'; engine.layer(revised, 'author-b', 'L-private@1');
  const recovered = restoreLayer(engine, { ref: 'L-private@2', from: 'L-private@1' }, 'author-b');
  // A later interaction blocker must not invalidate an already retained historical Release.
  execute(engine, 'conflicts.report', { target: candidate.ref, report: { message: 'Retained interaction history after the release.' } }, 'interaction-reviewer');
  const issuer = new FixtureIssuer(); const event = auditEvent(issuer.resolve('fixture-b'), 'layer.restore', 'historical-operation', 'committed');
  event.references = ['L-private@2', 'L-private@1', 'sha256:' + digest(privateLayer), recovered.ref];
  const navigation = auditEvent(issuer.resolve('fixture-reader'), 'context.use', 'personal-navigation', 'committed'); navigation.references = ['R0@1'];
  const entries: Record<string, any> = {};
  for (const [ref, record] of Object.entries(engine.records)) { const text = canonical(record.data); const hash = bytesDigest(text); await writeFile(path.join(state, 'artifacts', hash + '.json'), text); entries[ref] = { hash, type: record.type, published: record.published }; }
  const registry = { entries, heads: engine.ownerHeads, requests: {
    'local-fixture:strata-local-demo:author-b:do-not-export-request-key': { digest: digest('restore-request'), result: { ok: true, data: recovered, created: [recovered.ref], operation_id: 'historical-operation', dry_run: false } },
    'local-fixture:strata-local-demo:reader:personal-key': { digest: digest('navigation-request'), result: { ok: true, data: { workspace: 'personal-workspace-canary', generation: 1, target: 'R0@1' }, created: [], operation_id: 'personal-navigation', dry_run: false } }
  }, commit_audit: [event, navigation], contexts: { personal: { generation: 1, target: 'R0@1', fingerprint: digest(engine.records['R0@1'].data), workspace: 'personal-workspace-canary' } } };
  await writeFile(path.join(state, 'registry.json'), canonical(registry)); await writeFile(path.join(state, 'audit.jsonl'), canonical(event) + '\n' + canonical(navigation) + '\n');
  await writeFile(path.join(state, 'artifacts', 'orphan.json'), 'unindexed-staging-canary');
  for (const name of ['.env', 'credentials.json', 'issuer-assignments.json', 'runtime.json']) await writeFile(path.join(state, name), 'excluded-local-secret-canary');
  return { root, state, engine, registry, release, evidence };
}
async function backed() { const source = await fixture(); const out = newPath('bundle'); const result = await createBackup({ state: source.state, out, project, selector, maxBytes: 4 * 1024 * 1024 }); return { ...source, out, result }; }
const verify = (bundle: string, expectedDigest?: string) => verifyBackup({ bundle, project, selector, expectedDigest });
async function copyBundle(bundle: string) { const output = newPath('tampered'); await cp(bundle, output, { recursive: true, errorOnExist: true }); return output; }
async function resign(bundle: string, change?: (manifest: any) => void) {
  const manifest = await decode(path.join(bundle, 'manifest.json'));
  for (const item of manifest.inventory) { const bytes = await readFile(path.join(bundle, item.path)); item.sha256 = bytesDigest(bytes); item.bytes = bytes.length; }
  manifest.checkpoint_sha256 = bytesDigest(await readFile(path.join(bundle, 'checkpoint.json'))); change?.(manifest);
  const text = canonical(manifest); await writeFile(path.join(bundle, 'manifest.json'), text); await writeFile(path.join(bundle, 'COMPLETE.json'), canonical({ format: 'strata-backup-complete/1', manifest_sha256: bytesDigest(text) }));
  const marker = path.join(bundle, INACTIVE_MARKER); if (await exists(marker)) { const inactive = await decode(marker); inactive.manifest_sha256 = bytesDigest(text); await writeFile(marker, canonical(inactive)); } return bytesDigest(text);
}

test('complete Node restore drill retains exact history, private drafts, evidence, outputs and inert receipts', async () => {
  const f = await backed(); const before = await readFile(path.join(f.state, 'registry.json'), 'utf8');
  const checked = await verify(f.out, f.result.manifest_sha256); assert.equal(checked.records, Object.keys(f.engine.records).length); assert.equal(checked.authors_authenticated, false); assert.equal(f.result.unindexed_orphans, 1);
  const checkpoint = await decode(path.join(f.out, 'checkpoint.json')); assert.deepEqual(checkpoint.heads, f.engine.ownerHeads); assert.equal(checkpoint.commit_audit.length, 1); assert.deepEqual(checkpoint.commit_audit[0].references, f.registry.commit_audit[0].references); assert.equal(checkpoint.historical_requests.length, 1);
  assert.equal('requests' in checkpoint, false); assert.equal('contexts' in checkpoint, false);
  const serialized = canonical(checkpoint); for (const canary of ['personal-workspace-canary', 'personal-key', 'do-not-export-request-key', 'excluded-local-secret-canary']) assert.equal(serialized.includes(canary), false);
  const out = newPath('isolated-restore'); const restored = await restoreBackup({ bundle: f.out, out, project, selector, expectedDigest: f.result.manifest_sha256 }); assert.equal(restored.inactive, true); assert.equal(restored.identities_active, false); assert.equal(restored.requests_active, false);
  assert.equal(await exists(path.join(out, 'registry.json')), false); assert.equal(await exists(path.join(out, 'strata.config.json')), false); assert.equal(await exists(path.join(out, STATE_DESCRIPTOR)), false); assert.equal(await exists(path.join(out, INACTIVE_MARKER)), true);
  const again = await verify(out, f.result.manifest_sha256); assert.equal(again.checkpoint_sha256, checked.checkpoint_sha256);
  for (const [ref, record] of Object.entries(f.engine.records)) { const entry = checkpoint.entries[ref]; const copy = await readFile(path.join(out, 'artifacts', entry.hash + '.json')); assert.equal(bytesDigest(copy), entry.hash); assert.equal(copy.toString(), canonical(record.data)); }
  const privateView = await verifyBackup({ bundle: out, project, selector, ref: 'L-private@3' }); assert.equal(privateView.record!.data.owner, 'author-b'); assert.equal(privateView.record!.published, false);
  assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), before); assert.equal(await exists(path.join(f.state, STATE_LEASE)), false);
  assert.equal(await readdir(path.join(out, 'profiles')).then(files => files.length), 1); assert.equal((await decode(path.join(out, 'checkpoint.json'))).entries[f.release.ref].type, 'release');
  await assert.rejects(startLocalBroker(out, 0), expectCode('RECOVERY_INACTIVE')); assert.equal(await exists(path.join(out, STATE_LEASE)), false);
});

test('backup entitlement is separate from read, author and bootstrap permissions', async () => {
  const f = await fixture();
  for (const denied of ['fixture-reader', 'fixture-a', 'fixture-bootstrap']) { const out = newPath('denied'); await assert.rejects(createBackup({ state: f.state, out, project, selector: denied, maxBytes: 4 * 1024 * 1024 }), expectCode('OPERATION_FORBIDDEN')); assert.equal(await exists(out), false); }
  const issuer = new FixtureIssuer(); await assert.rejects(async () => issuer.authorize(issuer.resolve(selector), 'init', {}), expectCode('OPERATION_FORBIDDEN'));
});

test('dry runs do not create output, lease, context, requests or other source writes', async () => {
  const f = await fixture(); const before = await readFile(path.join(f.state, 'registry.json'), 'utf8'); const out = newPath('dry-create');
  const dry = await createBackup({ state: f.state, out, project, selector, maxBytes: 4 * 1024 * 1024, dryRun: true }); assert.equal(dry.complete, false); assert.equal(await exists(out), false); assert.equal(await exists(path.join(f.state, STATE_LEASE)), false);
  const created = await createBackup({ state: f.state, out, project, selector, maxBytes: 4 * 1024 * 1024 }); const restore = newPath('dry-restore'); const result = await restoreBackup({ bundle: out, out: restore, project, selector, expectedDigest: created.manifest_sha256, dryRun: true }); assert.equal(result.restored, false); assert.equal(await exists(restore), false); assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), before);
});

test('live broker and stale leases block export without stopping or purging anything', async () => {
  const f = await fixture(); const broker = await startLocalBroker(f.state, 0);
  try { await assert.rejects(createBackup({ state: f.state, out: newPath('live'), project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('STATE_BUSY')); assert.equal((await fetch(broker.url + '/health')).status, 200); await assert.rejects(startLocalBroker(f.state, 0), expectCode('STATE_BUSY')); }
  finally { await broker.close(); }
  await writeFile(path.join(f.state, STATE_LEASE), 'stale'); await assert.rejects(createBackup({ state: f.state, out: newPath('stale'), project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('STATE_BUSY')); assert.equal(await readFile(path.join(f.state, STATE_LEASE), 'utf8'), 'stale');
});

test('graceful close retains the lease until pending commits and request handlers finish', async () => {
  const f = await fixture(); let staged!: () => void; const reached = new Promise<void>(resolve => staged = resolve); let resume!: () => void; const paused = new Promise<void>(resolve => resume = resolve);
  const broker = await startLocalBroker(f.state, 0, { afterStage: async () => { staged(); await paused; } });
  const response = fetch(broker.url + '/v1/operation', { method: 'POST', headers: { 'x-strata-session': 'fixture-a', 'content-type': 'application/json' }, body: JSON.stringify({ command: 'layer.create', input: { record: proposal('L-pending', 'author-a') } }) }).catch(() => null);
  await reached; const close = broker.close(); await assert.rejects(assertQuiesced(f.state), expectCode('STATE_BUSY')); resume(); await close; await response; await assertQuiesced(f.state); assert.ok((await decode(path.join(f.state, 'registry.json'))).entries['L-pending@1']);
});

test('legacy/unbound, foreign-project and unsupported storage descriptors fail closed', async () => {
  const f = await fixture(); const descriptor = path.join(f.state, STATE_DESCRIPTOR); const original = await decode(descriptor);
  await unlink(descriptor); await assert.rejects(createBackup({ state: f.state, out: newPath('legacy'), project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('STATE_BINDING_REQUIRED'));
  await writeFile(descriptor, canonical({ ...original, project_id: 'another-project' })); await assert.rejects(createBackup({ state: f.state, out: newPath('foreign'), project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('BACKUP_PROJECT_MISMATCH'));
  await assert.rejects(startLocalBroker(f.state, 0), expectCode('STATE_BINDING_MISMATCH')); assert.equal(await exists(path.join(f.state, STATE_LEASE)), false);
  await writeFile(descriptor, canonical({ ...original, format: 'sdk-sqlite/unknown' })); await assert.rejects(createBackup({ state: f.state, out: newPath('sdk'), project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('BACKUP_INVALID'));
});

test('corruption and interrupted bundles fail before restore writes', async () => {
  const f = await backed(); const bad = await copyBundle(f.out); const manifest = await decode(path.join(bad, 'manifest.json')); await writeFile(path.join(bad, manifest.inventory.find((i: any) => i.path.startsWith('artifacts/')).path), '{}');
  await assert.rejects(verify(bad), expectCode('BACKUP_HASH_MISMATCH')); const out = newPath('corrupt-restore'); await assert.rejects(restoreBackup({ bundle: bad, out, project, selector, expectedDigest: f.result.manifest_sha256 }), expectCode('BACKUP_HASH_MISMATCH')); assert.equal(await exists(out), false);
  const incomplete = await copyBundle(f.out); await unlink(path.join(incomplete, 'COMPLETE.json')); const result = await runCli(['backup', 'verify', incomplete, '--expect-project', project, '--json'], undefined, { STRATA_SESSION: selector }); assert.equal(result.ok, false); assert.equal(result.errors[0].code, 'BACKUP_UNAVAILABLE'); await assert.rejects(startLocalBroker(incomplete, 0), expectCode('RECOVERY_INACTIVE'));
});

test('missing record closure and required template assets reject self-consistent inventories', async () => {
  const f = await backed(); const missing = await copyBundle(f.out); const checkpoint = await decode(path.join(missing, 'checkpoint.json')); delete checkpoint.entries['L-alternative@1']; await writeFile(path.join(missing, 'checkpoint.json'), canonical(checkpoint)); await resign(missing, manifest => manifest.roots = Object.keys(checkpoint.entries).sort()); await assert.rejects(verify(missing), expectCode('BACKUP_MISSING_REFERENCE'));
  const profile = await copyBundle(f.out); const manifest = await decode(path.join(profile, 'manifest.json')); const item = manifest.inventory.find((i: any) => i.path.startsWith('profiles/')); await unlink(path.join(profile, item.path)); await writeFile(path.join(profile, 'manifest.json'), canonical({ ...manifest, inventory: manifest.inventory.filter((i: any) => i.path !== item.path) })); await resign(profile); await assert.rejects(verify(profile), expectCode('BACKUP_MISSING_PROFILE'));
});

test('conflicting immutable refs and mismatched owner heads reject recomputed hashes', async () => {
  const f = await backed(); const changed = await copyBundle(f.out); const checkpoint = await decode(path.join(changed, 'checkpoint.json')); checkpoint.heads['L-private'].owner = 'forged-owner'; await writeFile(path.join(changed, 'checkpoint.json'), canonical(checkpoint)); await resign(changed); await assert.rejects(verify(changed), expectCode('BACKUP_OWNERSHIP_MISMATCH'));
  const conflict = await copyBundle(f.out); const index = await decode(path.join(conflict, 'checkpoint.json')); index.entries['L-contradictory@3'] = index.entries['L-private@3']; delete index.entries['L-private@3']; index.commit_audit = []; index.historical_requests = []; await writeFile(path.join(conflict, 'checkpoint.json'), canonical(index)); await writeFile(path.join(conflict, 'audit.jsonl'), ''); await resign(conflict, m => m.roots = Object.keys(index.entries).sort()); await assert.rejects(verify(conflict), expectCode('BACKUP_REFERENCE_MISMATCH'));
});

test('recovery provenance cannot be forged and executable grant/cache metadata is not accepted', async () => {
  const f = await backed(); const bad = await copyBundle(f.out); const checkpoint = await decode(path.join(bad, 'checkpoint.json')); checkpoint.commit_audit[0].references[2] = 'sha256:' + '0'.repeat(64); await writeFile(path.join(bad, 'checkpoint.json'), canonical(checkpoint)); await resign(bad); await assert.rejects(verify(bad), expectCode('BACKUP_INVALID'));
  const cached = await copyBundle(f.out); const history = await decode(path.join(cached, 'checkpoint.json')); history.historical_requests[0].result.data.recovery.source = 'missing-source@1'; await writeFile(path.join(cached, 'checkpoint.json'), canonical(history)); await resign(cached); await assert.rejects(verify(cached), expectCode('BACKUP_MISSING_REFERENCE'));
  const grant = await copyBundle(f.out); const executable = await decode(path.join(grant, 'checkpoint.json')); executable.requests = {}; executable.issuer_assignments = { restored: { allowed_operations: ['release'] } }; await writeFile(path.join(grant, 'checkpoint.json'), canonical(executable)); await resign(grant); await assert.rejects(verify(grant), expectCode('BACKUP_INVALID'));
});

test('unsupported manifest versions, duplicate paths, traversal, links and unmanifested secrets are refused', async () => {
  const f = await backed();
  for (const field of ['format', 'model_version', 'storage_format']) { const changed = await copyBundle(f.out); await resign(changed, manifest => manifest[field] = 'future/unknown'); await assert.rejects(verify(changed), expectCode('BACKUP_INVALID')); }
  const duplicate = await copyBundle(f.out); await resign(duplicate, m => m.inventory.push(m.inventory[0])); await assert.rejects(verify(duplicate), expectCode('BACKUP_INVALID'));
  const traversal = await copyBundle(f.out); await resign(traversal, m => m.inventory[0].path = '../outside-secret'); await assert.rejects(verify(traversal), expectCode('INVALID_PATH'));
  const extra = await copyBundle(f.out); await writeFile(path.join(extra, '.env'), 'secret-canary'); await assert.rejects(verify(extra), expectCode('BACKUP_INCOMPLETE'));
  const linked = newPath('junction'); await symlink(f.out, linked, 'junction'); await assert.rejects(verify(linked), expectCode('INVALID_PATH'));
});

test('restore requires explicit trusted project/digest, refuses occupied or overlapping directories', async () => {
  const f = await backed(); const out = newPath('untrusted');
  await assert.rejects(restoreBackup({ bundle: f.out, out, project: 'different-project', selector, expectedDigest: f.result.manifest_sha256 }), expectCode('BACKUP_PROJECT_MISMATCH')); await assert.rejects(restoreBackup({ bundle: f.out, out, project, selector, expectedDigest: '0'.repeat(64) }), expectCode('BACKUP_HASH_MISMATCH')); assert.equal(await exists(out), false);
  const occupied = newPath('occupied'); await mkdir(occupied); await writeFile(path.join(occupied, 'preserve.txt'), 'existing project'); await assert.rejects(restoreBackup({ bundle: f.out, out: occupied, project, selector, expectedDigest: f.result.manifest_sha256 }), expectCode('OUTPUT_EXISTS')); assert.equal(await readFile(path.join(occupied, 'preserve.txt'), 'utf8'), 'existing project');
  await assert.rejects(restoreBackup({ bundle: f.out, out: path.join(f.out, 'nested'), project, selector, expectedDigest: f.result.manifest_sha256 }), expectCode('INVALID_PATH'));
  await assert.rejects(restoreBackup({ bundle: f.out, out: path.join(f.root, 'recovery-inside-project'), project, selector, expectedDigest: f.result.manifest_sha256 }), expectCode('INVALID_PATH')); assert.equal(await exists(path.join(f.root, 'recovery-inside-project')), false);
  await assert.rejects(createBackup({ state: f.state, out: path.join(f.state, 'nested'), project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('INVALID_PATH'));
});

test('detected secrets and explicit byte/time bounds never produce a complete backup', async () => {
  const f = await fixture(); const tooSmall = newPath('small'); await assert.rejects(createBackup({ state: f.state, out: tooSmall, project, selector, maxBytes: 20 }), expectCode('BACKUP_LIMIT')); assert.equal(await exists(path.join(tooSmall, 'COMPLETE.json')), false);
  const registry = await decode(path.join(f.state, 'registry.json')); const entry = registry.entries['L-private@1']; const record = await decode(path.join(f.state, 'artifacts', entry.hash + '.json')); record.intent = 'art_v1_synthetic_secret_canary'; const text = canonical(record); entry.hash = bytesDigest(text); await writeFile(path.join(f.state, 'artifacts', entry.hash + '.json'), text); await writeFile(path.join(f.state, 'registry.json'), canonical(registry)); const secretOut = newPath('secret'); await assert.rejects(createBackup({ state: f.state, out: secretOut, project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('BACKUP_SECRET_DETECTED')); assert.equal(await exists(secretOut), false); assert.equal(await exists(path.join(f.state, STATE_LEASE)), false);
  const originalNow = Date.now; let calls = 0; Date.now = () => ++calls === 1 ? 0 : BACKUP_LIMITS.milliseconds + 1;
  try { await assert.rejects(createBackup({ state: f.state, out: newPath('timeout'), project, selector, maxBytes: 4 * 1024 * 1024 }), expectCode('BACKUP_LIMIT')); } finally { Date.now = originalNow; }
});

test('CLI create uses explicit configured state and offline verify/inspect/restore need no original project or broker', async () => {
  const f = await fixture(); const created = await runCli(['backup', 'create', '--project', f.root, '--state-dir', 'state', '--out', 'recovery-copy', '--max-bytes', '4194304', '--json'], undefined, { STRATA_SESSION: selector }); assert.equal(created.ok, true); assert.deepEqual(created.effects.network, []); assert.deepEqual(created.effects.usage, []);
  const bundle = created.data.output; const inspection = await runCli(['backup', 'inspect', bundle, '--expect-project', project, '--expect-digest', created.data.manifest_sha256, '--ref', 'L-private@1', '--project', path.join(temp, 'no-project'), '--json'], undefined, { STRATA_SESSION: selector }); assert.equal(inspection.ok, true); assert.equal(inspection.data.record.data.owner, 'author-b'); assert.deepEqual(inspection.effects.network, []);
  const dryOut = newPath('cli-dry'); const restored = await runCli(['backup', 'restore', bundle, '--out', dryOut, '--expect-project', project, '--expect-digest', created.data.manifest_sha256, '--dry-run', '--json'], undefined, { STRATA_SESSION: selector }); assert.equal(restored.ok, true); assert.equal(restored.data.restored, false); assert.equal(await exists(dryOut), false);
  const missingPin = await runCli(['backup', 'restore', bundle, '--out', newPath('no-pin'), '--expect-project', project, '--json'], undefined, { STRATA_SESSION: selector }); assert.equal(missingPin.ok, false); assert.equal(missingPin.errors[0].code, 'INVALID_ARGUMENT');
});

test('backup CLI integrity failures keep nonzero errors in dry runs and never create restore output', async () => {
  const f = await backed(); const bad = await copyBundle(f.out);
  const manifest = await decode(path.join(bad, 'manifest.json'));
  await writeFile(path.join(bad, manifest.inventory.find((i: any) => i.path.startsWith('artifacts/')).path), '{}');
  const before = await readFile(path.join(f.state, 'registry.json'), 'utf8');
  for (const command of ['verify', 'inspect', 'restore']) {
    for (const dry of [false, true]) {
      const out = newPath('failed-cli-restore');
      const argv = ['backup', command, bad, '--expect-project', project, '--expect-digest', f.result.manifest_sha256, '--json'];
      if (command === 'restore') argv.push('--out', out);
      if (dry) argv.push('--dry-run');
      const result = await runCli(argv, undefined, { STRATA_SESSION: selector });
      assert.equal(result.ok, false); assert.equal(result.exit_code, 6);
      assert.equal(result.errors[0].code, 'BACKUP_HASH_MISMATCH'); assert.equal(result.data, null);
      assert.deepEqual(result.effects, { created: [], reused: [], paths: [], network: [], usage: [] });
      assert.equal(await exists(out), false);
    }
  }
  assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), before);
});

test('verified backup dry runs stay read-only and human output retains integrity and inactive-state fields', async () => {
  const f = await backed(); const before = await readFile(path.join(f.state, 'registry.json'), 'utf8');
  for (const command of ['verify', 'inspect']) {
    const argv = ['backup', command, f.out, '--expect-project', project, '--expect-digest', f.result.manifest_sha256, '--dry-run', '--json'];
    if (command === 'inspect') argv.push('--ref', 'L-private@1');
    const result = await runCli(argv, undefined, { STRATA_SESSION: selector });
    assert.equal(result.ok, true); assert.equal(result.exit_code, 0); assert.equal(result.data.verified, true);
    const human = formatHuman(result); assert.match(human, /verified: true/); assert.ok(human.includes(f.result.manifest_sha256));
    if (command === 'inspect') assert.match(human, /Historical record:[\s\S]*L-private/);
    assert.deepEqual(result.effects.paths, []); assert.deepEqual(result.effects.network, []);
  }
  const out = newPath('verified-cli-dry-restore');
  const restored = await runCli(['backup', 'restore', f.out, '--expect-project', project, '--expect-digest', f.result.manifest_sha256, '--out', out, '--dry-run', '--json'], undefined, { STRATA_SESSION: selector });
  assert.equal(restored.ok, true); assert.equal(restored.data.verified, true); assert.equal(restored.data.restored, false);
  assert.equal(await exists(out), false); assert.match(formatHuman(restored), /restored: false/);
  assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), before);
});
