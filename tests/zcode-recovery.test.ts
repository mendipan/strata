import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/core.js';
import { runCli } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer, LOCAL_PROJECT, auditEvent } from '../src/security.js';
import { personalContext, restoreLayer, type ContextMap } from '../src/recovery.js';
import { bootstrap, demoLayers, proposal } from '../src/fixtures.js';
import { MODEL, CONTENT_MODEL, canonical, digest, bytesDigest } from '../src/model.js';
import { prepared, unitValidation, approvals } from './helpers.js';

// Focused additive recovery coverage recorded in docs/LOCAL_RECOVERY.md.
// All state is synthetic and local: loopback brokers on port 0, mkdtemp scratch
// directories, no child processes, no model/provider/cloud calls. Existing
// recovery/backup/acceptance suites are the regression references; these cases
// only add gaps named in the audit's coverage map.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const code = (value: string) => (error: any) => { assert.equal(error.code, value); return true; };
const workspace = 'c'.repeat(64);
const pathExists = async (target: string) => { try { await access(target); return true; } catch { return false; } };
const backupEnv = { ...process.env, STRATA_SESSION: 'fixture-backup' };
const backupCli = (args: string[]) => runCli([...args, '--json'], undefined, backupEnv);

async function fileHashes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), name);
      else result[name] = bytesDigest(await readFile(path.join(current, entry.name)));
    }
  }
  await visit(directory);
  return result;
}

async function brokerProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-zcode-recovery-'));
  const broker = await startLocalBroker(path.join(root, 'state'), 0);
  const config = { schema_version: '1', model_version: MODEL, project_id: LOCAL_PROJECT, broker: broker.url, artifact_adapter: 'local-persistent-fake', profiles: ['booking-node/1'], identity_policy: 'trusted-local-fixture-sessions', network_policy: 'loopback-only' };
  await writeFile(path.join(root, 'strata.config.json'), JSON.stringify(config));
  const cli = (args: string[], session = 'fixture-reader') => runCli([...args, '--project', root, '--json', '--non-interactive'], undefined, { ...process.env, STRATA_SESSION: session });
  const op = async (command: string, input: any = {}, session = 'fixture-reader'): Promise<any> => (await fetch(broker.url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': session }, body: JSON.stringify({ command, input, options: {} }) })).json();
  const registryFile = () => readFile(path.join(root, 'state/registry.json'), 'utf8');
  await op('init', { record: bootstrap() }, 'fixture-bootstrap');
  return { root, broker, cli, op, registryFile };
}
async function authorTwoRevisions(f: Awaited<ReturnType<typeof brokerProject>>) {
  const a = demoLayers().a;
  assert.equal((await f.op('layer.create', { record: a }, 'fixture-a')).ok, true);
  assert.equal((await f.op('layer.publish', { ref: 'L-hold@1' }, 'fixture-a')).ok, true);
  assert.equal((await f.op('layer.revise', { previous: 'L-hold@1', record: { ...a, revision: 2, changes: [] } }, 'fixture-a')).ok, true);
}

// A quiesced Node state holding a real accepted Release plus one private draft,
// persisted exactly like the engine would have committed it.
async function quiescedAcceptedProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-zcode-recovery-bk-'));
  const projectRoot = path.join(root, 'project');
  const state = path.join(projectRoot, 'state');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'strata.config.json'), JSON.stringify({ schema_version: '1', model_version: MODEL, project_id: LOCAL_PROJECT, broker: 'http://127.0.0.1:1', artifact_adapter: 'local-persistent-fake', profiles: ['booking-node/1'], identity_policy: 'trusted-local-fixture-sessions', network_policy: 'loopback-only' }));
  const broker = await startLocalBroker(state, 0); await broker.close();
  return { root, projectRoot, state };
}
async function persistEngine(state: string, engine: Engine, extra: { commitAudit?: any[]; requests?: Record<string, any>; contexts?: Record<string, any>; auditLines?: string[] } = {}) {
  const entries: Record<string, any> = {};
  for (const [ref, record] of Object.entries(engine.records)) {
    const text = canonical(record.data); const hash = bytesDigest(text);
    await writeFile(path.join(state, 'artifacts', hash + '.json'), text);
    entries[ref] = { hash, type: record.type, published: record.published };
  }
  await writeFile(path.join(state, 'registry.json'), canonical({ entries, heads: engine.ownerHeads, requests: extra.requests ?? {}, ...(extra.commitAudit ? { commit_audit: extra.commitAudit } : {}), ...(extra.contexts ? { contexts: extra.contexts } : {}) }));
  if (extra.auditLines?.length) await writeFile(path.join(state, 'audit.jsonl'), extra.auditLines.join('\n') + '\n');
}

test('CLI recovery boundaries: malformed refs/options, truncated JSON and unsupported reset/rollback spellings refuse without mutation', async () => {
  const f = await brokerProject();
  try {
    await authorTwoRevisions(f);
    const registry = await f.registryFile(), artifacts = (await readdir(path.join(f.root, 'state/artifacts'))).sort();
    const truncatedDraft = await readFile(path.join(repoRoot, 'tests/fixtures/zcode-recovery/truncated-layer-draft.json'), 'utf8');
    const boundaries: { args: string[]; session: string; exit: number; errorCode: string; stdin?: string }[] = [
      { args: ['layer', 'restore', 'L-hold@abc', '--from', 'L-hold@1'], session: 'fixture-a', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['layer', 'restore', 'L-hold@2', '--from', 'L-hold@02'], session: 'fixture-a', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['layer', 'restore', 'L-hold@2'], session: 'fixture-a', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['layer', 'restore', 'L-hold@2', '--from', 'L-hold@1', '--from', 'L-hold@2'], session: 'fixture-a', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['layer', 'restore', 'L-hold@2', '--from', 'L-hold@1', '--force'], session: 'fixture-a', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['context', 'use', 'R0@1', '--expect-generation', '-1'], session: 'fixture-reader', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['context', 'use', 'R0@1', '--expect-generation', '007'], session: 'fixture-reader', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['context', 'use', 'R0@1'], session: 'fixture-reader', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['context', 'use', 'R0@1', '--expect-generation', '0', '--expect-generation', '1'], session: 'fixture-reader', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['context', 'use', 'R0@1', '--expect-generation', '0', '--human'], session: 'fixture-reader', exit: 2, errorCode: 'INVALID_ARGUMENT' },
      { args: ['layer', 'create', '--file', '-'], session: 'fixture-a', exit: 2, errorCode: 'INVALID_RECORD', stdin: truncatedDraft },
      { args: ['context', 'use', 'R0@1', '--expect-generation', '0'], session: 'fixture-backup', exit: 4, errorCode: 'OPERATION_FORBIDDEN' },
      { args: ['reset'], session: 'fixture-bootstrap', exit: 8, errorCode: 'UNSUPPORTED_CAPABILITY' },
      { args: ['rollback', 'R0@1'], session: 'fixture-bootstrap', exit: 8, errorCode: 'UNSUPPORTED_CAPABILITY' },
      { args: ['revert', 'L-hold@2'], session: 'fixture-a', exit: 8, errorCode: 'UNSUPPORTED_CAPABILITY' },
      { args: ['checkout', 'R0@1'], session: 'fixture-reader', exit: 8, errorCode: 'UNSUPPORTED_CAPABILITY' },
      { args: ['layer', 'abandon', 'L-hold@2', '--expect-generation', '1'], session: 'fixture-a', exit: 8, errorCode: 'UNSUPPORTED_CAPABILITY' },
      { args: ['backup', 'mirror', '--out', 'mirror'], session: 'fixture-backup', exit: 8, errorCode: 'UNSUPPORTED_CAPABILITY' },
      { args: ['context', 'set', 'R0@1'], session: 'fixture-reader', exit: 8, errorCode: 'UNSUPPORTED_CAPABILITY' },
    ];
    for (const boundary of boundaries) {
      const result = await runCli([...boundary.args, '--project', f.root, '--json', '--non-interactive'], boundary.stdin, { ...process.env, STRATA_SESSION: boundary.session });
      assert.equal(result.ok, false, boundary.args.join(' '));
      assert.equal(result.exit_code, boundary.exit, boundary.args.join(' '));
      assert.equal(result.errors.length, 1, boundary.args.join(' '));
      assert.equal(result.errors[0].code, boundary.errorCode, boundary.args.join(' '));
      assert.equal(result.data, null, boundary.args.join(' '));
      assert.deepEqual(result.effects.created, [], boundary.args.join(' '));
      assert.deepEqual(result.effects.paths, [], boundary.args.join(' '));
    }
    const version = await runCli(['--version'], undefined, { ...process.env, STRATA_SESSION: 'fixture-reader' });
    assert.deepEqual(version.data.capabilities.recovery, ['personal-context', 'owned-same-baseline-layer-restoration', 'quiesced-node-backup', 'offline-verification', 'isolated-inactive-restore']);
    for (const spelling of ['reset', 'rollback', 'revert', 'checkout', 'abandon', 'mirror']) assert.equal(version.data.commands.some((c: string) => c.includes(spelling)), false);
    // Denials may append audit events; semantic records, heads and artifacts stay byte-identical.
    assert.equal(await f.registryFile(), registry);
    assert.deepEqual((await readdir(path.join(f.root, 'state/artifacts'))).sort(), artifacts);
  } finally { await f.broker.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('failed-then-valid backup recovery: corrupt bundle fails stably, clean bundle restores into a distinct output', async () => {
  const q = await quiescedAcceptedProject();
  try {
    const p = prepared(), v = unitValidation(p.engine, p.candidate);
    p.engine.release(p.candidate.ref, v.validation.ref, approvals(p.engine, p.candidate, v.validation.evidence_digest));
    p.engine.layer(proposal('L-private', 'author-b'), 'author-b');
    await persistEngine(q.state, p.engine);
    const registryBefore = await readFile(path.join(q.state, 'registry.json'), 'utf8');
    const createA = await backupCli(['backup', 'create', '--project', q.projectRoot, '--state-dir', 'state', '--out', 'bundle-a', '--max-bytes', '4194304']);
    const createB = await backupCli(['backup', 'create', '--project', q.projectRoot, '--state-dir', 'state', '--out', 'bundle-b', '--max-bytes', '4194304']);
    assert.equal(createA.exit_code, 0); assert.equal(createB.exit_code, 0);
    assert.equal(createB.data.manifest_sha256, createA.data.manifest_sha256);
    const cleanHashes = await fileHashes(createA.data.output);
    assert.deepEqual(await fileHashes(createB.data.output), cleanHashes);
    // Corrupt only the test-owned first bundle's manifest.
    const manifestFile = path.join(createA.data.output, 'manifest.json');
    await writeFile(manifestFile, (await readFile(manifestFile)).subarray(0, 100));
    const verifyArgs = ['backup', 'verify', createA.data.output, '--expect-project', LOCAL_PROJECT, '--expect-digest', createA.data.manifest_sha256];
    const first = await backupCli(verifyArgs);
    assert.equal(first.ok, false); assert.equal(first.exit_code, 6); assert.equal(first.errors[0].code, 'BACKUP_INVALID'); assert.equal(first.data, null);
    assert.deepEqual((await backupCli(verifyArgs)).errors, first.errors);
    assert.equal((await backupCli(['backup', 'inspect', createA.data.output, '--expect-project', LOCAL_PROJECT, '--ref', 'L-private@1'])).errors[0].code, 'BACKUP_INVALID');
    for (const dry of [true, false]) {
      const out = path.join(q.root, dry ? 'out-dry' : 'out-apply');
      const argv = ['backup', 'restore', createA.data.output, '--out', out, '--expect-project', LOCAL_PROJECT, '--expect-digest', createA.data.manifest_sha256];
      if (dry) argv.push('--dry-run');
      const result = await backupCli(argv);
      assert.equal(result.exit_code, 6); assert.equal(result.errors[0].code, 'BACKUP_INVALID');
      assert.equal(await pathExists(out), false);
    }
    const after = await fileHashes(createA.data.output);
    for (const [name, hash] of Object.entries(cleanHashes)) if (name !== 'manifest.json') assert.equal(after[name], hash);
    // The retained first failure does not block a clean, byte-identical bundle from restoring into a distinct output.
    const verifyB = await backupCli(['backup', 'verify', createB.data.output, '--expect-project', LOCAL_PROJECT, '--expect-digest', createB.data.manifest_sha256]);
    assert.equal(verifyB.exit_code, 0); assert.equal(verifyB.data.verified, true);
    const outClean = path.join(q.root, 'inactive-clean');
    const restored = await backupCli(['backup', 'restore', createB.data.output, '--out', outClean, '--expect-project', LOCAL_PROJECT, '--expect-digest', createB.data.manifest_sha256]);
    assert.equal(restored.exit_code, 0); assert.equal(restored.data.restored, true); assert.equal(restored.data.inactive, true);
    assert.equal(await pathExists(path.join(outClean, 'COMPLETE.json')), true);
    const cold = await backupCli(['backup', 'inspect', outClean, '--expect-project', LOCAL_PROJECT, '--expect-digest', createB.data.manifest_sha256, '--ref', 'L-private@1']);
    assert.equal(cold.exit_code, 0); assert.equal(cold.data.record.data.owner, 'author-b'); assert.equal(cold.data.record.published, false);
    // Complete record bytes: every indexed artifact is byte-identical across the source state, the clean bundle and the inactive copy.
    const checkpoint = JSON.parse(await readFile(path.join(createB.data.output, 'checkpoint.json'), 'utf8'));
    for (const entry of Object.values(checkpoint.entries) as any[]) {
      const bundled = await readFile(path.join(createB.data.output, 'artifacts', entry.hash + '.json'));
      assert.equal(bytesDigest(bundled), entry.hash);
      assert.equal(bytesDigest(await readFile(path.join(q.state, 'artifacts', entry.hash + '.json'))), entry.hash, entry.hash);
      assert.equal(bytesDigest(await readFile(path.join(outClean, 'artifacts', entry.hash + '.json'))), entry.hash, entry.hash);
    }
    assert.deepEqual(await fileHashes(outClean), await fileHashes(createB.data.output));
    await assert.rejects(startLocalBroker(outClean, 0), code('RECOVERY_INACTIVE'));
    assert.equal(await readFile(path.join(q.state, 'registry.json'), 'utf8'), registryBefore);
  } finally { await rm(q.root, { recursive: true, force: true }); }
});

test('truncated completion marker and checkpoint bytes, and a re-signed nested malformed record, fail closed', async () => {
  const q = await quiescedAcceptedProject();
  try {
    const p = prepared(), v = unitValidation(p.engine, p.candidate);
    p.engine.release(p.candidate.ref, v.validation.ref, approvals(p.engine, p.candidate, v.validation.evidence_digest));
    p.engine.layer(proposal('L-private', 'author-b'), 'author-b');
    await persistEngine(q.state, p.engine);
    const created = await backupCli(['backup', 'create', '--project', q.projectRoot, '--state-dir', 'state', '--out', 'bundle', '--max-bytes', '4194304']);
    assert.equal(created.exit_code, 0);
    const copy = async (label: string) => { const target = path.join(q.root, label); await cp(created.data.output, target, { recursive: true, errorOnExist: true }); return target; };
    const expectFailure = async (bundle: string, errorCode: string, expectedDigest: string = created.data.manifest_sha256) => {
      const result = await backupCli(['backup', 'verify', bundle, '--expect-project', LOCAL_PROJECT, '--expect-digest', expectedDigest]);
      assert.equal(result.ok, false); assert.equal(result.exit_code, 6); assert.equal(result.errors[0].code, errorCode);
    };
    const badComplete = await copy('truncated-complete');
    await writeFile(path.join(badComplete, 'COMPLETE.json'), (await readFile(path.join(badComplete, 'COMPLETE.json'))).subarray(0, 20));
    await expectFailure(badComplete, 'BACKUP_INVALID');
    const badCheckpoint = await copy('truncated-checkpoint');
    await writeFile(path.join(badCheckpoint, 'checkpoint.json'), (await readFile(path.join(badCheckpoint, 'checkpoint.json'))).subarray(0, 40));
    await expectFailure(badCheckpoint, 'BACKUP_HASH_MISMATCH');
    // A self-consistent re-signed bundle whose nested artifact bytes are not a record object.
    // The artifact store is content-addressed, so the corrupted record moves to its new hash name.
    const nested = await copy('nested-malformed');
    const manifest = JSON.parse(await readFile(path.join(nested, 'manifest.json'), 'utf8'));
    const checkpoint = JSON.parse(await readFile(path.join(nested, 'checkpoint.json'), 'utf8'));
    const artifactItem = manifest.inventory.find((i: any) => i.path.startsWith('artifacts/'));
    const nestedBytes = Buffer.from('[]');
    const nestedHash = bytesDigest(nestedBytes);
    const nestedRef = Object.keys(checkpoint.entries).find(ref => checkpoint.entries[ref].hash === artifactItem.sha256)!;
    checkpoint.entries[nestedRef].hash = nestedHash;
    await rm(path.join(nested, artifactItem.path));
    await writeFile(path.join(nested, 'artifacts', nestedHash + '.json'), nestedBytes);
    const checkpointText = canonical(checkpoint);
    await writeFile(path.join(nested, 'checkpoint.json'), checkpointText);
    artifactItem.path = 'artifacts/' + nestedHash + '.json';
    for (const item of manifest.inventory) { const bytes = await readFile(path.join(nested, item.path)); item.sha256 = bytesDigest(bytes); item.bytes = bytes.length; }
    manifest.checkpoint_sha256 = bytesDigest(checkpointText);
    const manifestText = canonical(manifest); const manifestDigest = bytesDigest(manifestText);
    await writeFile(path.join(nested, 'manifest.json'), manifestText);
    await writeFile(path.join(nested, 'COMPLETE.json'), canonical({ format: 'strata-backup-complete/1', manifest_sha256: manifestDigest }));
    const markerFile = path.join(nested, 'RECOVERY_INACTIVE.json');
    const marker = JSON.parse(await readFile(markerFile, 'utf8')); marker.manifest_sha256 = manifestDigest;
    await writeFile(markerFile, canonical(marker));
    await expectFailure(nested, 'BACKUP_INVALID', manifestDigest);
    const outNested = path.join(q.root, 'out-nested');
    const nestedRestore = await backupCli(['backup', 'restore', nested, '--out', outNested, '--expect-project', LOCAL_PROJECT, '--expect-digest', manifestDigest]);
    assert.equal(nestedRestore.exit_code, 6); assert.equal(await pathExists(outNested), false);
    // The untouched original bundle still verifies after all sibling corruption experiments.
    const reverify = await backupCli(['backup', 'verify', created.data.output, '--expect-project', LOCAL_PROJECT, '--expect-digest', created.data.manifest_sha256]);
    assert.equal(reverify.exit_code, 0); assert.equal(reverify.data.verified, true);
  } finally { await rm(q.root, { recursive: true, force: true }); }
});

test('stale requests before and after an accepted restore never erase it; the accepted draft is cold-readable from a restored archive', async () => {
  const f = await brokerProject();
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'strata-zcode-recovery-scratch-'));
  try {
    await authorTwoRevisions(f);
    const staleBefore = await f.cli(['context', 'use', 'R0@1', '--expect-generation', '3']);
    assert.equal(staleBefore.exit_code, 5); assert.equal(staleBefore.errors[0].code, 'STALE_CONTEXT');
    const malformedBefore = await f.cli(['layer', 'restore', 'L-hold@2', '--from', 'L-hold@2'], 'fixture-a');
    assert.equal(malformedBefore.exit_code, 2); assert.equal(malformedBefore.errors[0].code, 'RESTORE_SOURCE_MISMATCH');
    const use = await f.cli(['context', 'use', 'R0@1', '--expect-generation', '0']);
    assert.equal(use.exit_code, 0); assert.equal(use.data.generation, 1); assert.equal(use.data.baseline_ref, 'R0@1');
    const restore = await f.cli(['layer', 'restore', 'L-hold@2', '--from', 'L-hold@1', '--idempotency-key', 'zcode-recovery-1'], 'fixture-a');
    assert.equal(restore.exit_code, 0); assert.equal(restore.data.ref, 'L-hold@3'); assert.equal(restore.data.published, false);
    const accepted = await f.registryFile();
    const acceptedArtifacts = await fileHashes(path.join(f.root, 'state/artifacts'));
    const staleContextAfter = await f.cli(['context', 'use', 'R0@1', '--expect-generation', '0']);
    assert.equal(staleContextAfter.exit_code, 5); assert.equal(staleContextAfter.errors[0].code, 'STALE_CONTEXT');
    const staleHeadAfter = await f.cli(['layer', 'restore', 'L-hold@2', '--from', 'L-hold@1'], 'fixture-a');
    assert.equal(staleHeadAfter.exit_code, 5); assert.equal(staleHeadAfter.errors[0].code, 'STALE_REVISION');
    assert.equal(await f.registryFile(), accepted);
    assert.deepEqual(await fileHashes(path.join(f.root, 'state/artifacts')), acceptedArtifacts);
    const contextStill = await f.cli(['context', 'show']);
    assert.equal(contextStill.exit_code, 0); assert.equal(contextStill.data.generation, 1); assert.equal(contextStill.data.target, 'R0@1');
    await f.broker.close();
    const created = await backupCli(['backup', 'create', '--project', f.root, '--state-dir', 'state', '--out', path.join(scratch, 'bundle'), '--max-bytes', '4194304']);
    assert.equal(created.exit_code, 0);
    const pin = created.data.manifest_sha256;
    const coldBundle = await backupCli(['backup', 'inspect', created.data.output, '--expect-project', LOCAL_PROJECT, '--expect-digest', pin, '--ref', 'L-hold@3']);
    assert.equal(coldBundle.exit_code, 0); assert.equal(coldBundle.data.record.data.revision, 3); assert.equal(coldBundle.data.record.published, false);
    const inactive = path.join(scratch, 'inactive');
    const restored = await backupCli(['backup', 'restore', created.data.output, '--out', inactive, '--expect-project', LOCAL_PROJECT, '--expect-digest', pin]);
    assert.equal(restored.exit_code, 0); assert.equal(restored.data.restored, true); assert.equal(restored.data.identities_active, false);
    const coldArchive = await backupCli(['backup', 'inspect', inactive, '--expect-project', LOCAL_PROJECT, '--expect-digest', pin, '--ref', 'L-hold@3']);
    assert.equal(coldArchive.exit_code, 0);
    assert.equal(coldArchive.data.record.data.revision, 3); assert.equal(coldArchive.data.record.published, false);
    assert.equal(coldArchive.data.heads['L-hold'].head, 3);
    assert.equal(await pathExists(path.join(inactive, 'registry.json')), false);
    assert.equal(await pathExists(path.join(inactive, 'strata.config.json')), false);
    await assert.rejects(startLocalBroker(inactive, 0), code('RECOVERY_INACTIVE'));
    assert.equal(await f.registryFile(), accepted);
    assert.deepEqual(await fileHashes(path.join(f.root, 'state/artifacts')), acceptedArtifacts);
  } finally { if (f.broker.server.listening) await f.broker.close(); await rm(scratch, { recursive: true, force: true }); await rm(f.root, { recursive: true, force: true }); }
});

test('accepted Release bytes, obligations and provenance survive navigation, append-only restoration and backup/restore cold reads', async () => {
  const engine0 = prepared(); const v = unitValidation(engine0.engine, engine0.candidate);
  const approvalRefs = approvals(engine0.engine, engine0.candidate, v.validation.evidence_digest);
  const release = engine0.engine.release(engine0.candidate.ref, v.validation.ref, approvalRefs);
  const engine = engine0.engine; const releaseRef = release.ref;
  const pinnedRelease = canonical(engine.records[releaseRef].data);
  const pinnedObligations = canonical(engine.target(releaseRef).obligations);
  const pinnedFingerprint = engine.target(releaseRef).fingerprint;
  assert.equal(engine.records[releaseRef].data.blocks['booking.hold'].requirements.expiry.parameters.seconds, 900);
  assert.equal(engine.records[releaseRef].data.blocks['booking.reminder'].requirements.timing.parameters.enabled, true);
  assert.deepEqual(engine.records[releaseRef].data.provenance['booking.hold/requirements.expiry'], ['L-hold@1']);
  assert.ok((engine.read(engine0.resolution.ref, 'resolution') as any).payload.outcome.rejected.includes('L-alternative@1'));
  assert.deepEqual(engine.records[releaseRef].data.approvals, [...approvalRefs].sort());
  const contexts: ContextMap = {};
  const selected = personalContext(engine, contexts, 'context.use', { workspace, target: releaseRef, expected_generation: 0 }, 'reader');
  assert.equal(selected.baseline_ref, releaseRef); assert.equal(selected.generation, 1); assert.equal(selected.candidate_state, 'validated');
  engine.layer({ ...engine0.a, revision: 2, changes: [] }, 'author-a', 'L-hold@1');
  engine.publish('L-hold@2', 'author-a');
  const restored = restoreLayer(engine, { ref: 'L-hold@2', from: 'L-hold@1' }, 'author-a');
  assert.equal(restored.ref, 'L-hold@3'); assert.equal(restored.published, false); assert.equal(restored.evidence_reused, false);
  assert.equal(restored.recovery.source_fingerprint, digest(engine0.a));
  assert.equal(canonical(engine.records[releaseRef].data), pinnedRelease);
  assert.equal(canonical(engine.target(releaseRef).obligations), pinnedObligations);
  assert.equal(engine.target(releaseRef).fingerprint, pinnedFingerprint);
  assert.deepEqual(engine.ownerHeads['L-hold'], { owner: 'author-a', head: 3 });
  assert.throws(() => engine.read(restored.ref, 'layer'), code('REF_NOT_FOUND'));
  const pinnedRecords = Object.fromEntries(Object.entries(engine.records).map(([ref, record]) => [ref, { type: record.type, published: record.published, data: canonical(record.data) }])) as Record<string, { type: string; published: boolean; data: string }>;
  const q = await quiescedAcceptedProject();
  try {
    const issuer = new FixtureIssuer();
    const event = auditEvent(issuer.resolve('fixture-a'), 'layer.restore', 'zcode-drill-restore', 'committed');
    event.references = ['L-hold@2', 'L-hold@1', 'sha256:' + digest(engine0.a), restored.ref];
    await persistEngine(q.state, engine, {
      commitAudit: [event],
      requests: { 'local-fixture:strata-local-demo:author-a:zcode-drill': { digest: digest('zcode-drill-restore'), result: { ok: true, data: { ...restored }, created: [restored.ref], operation_id: 'zcode-drill-restore', dry_run: false } } },
      contexts: { [digest({ principal: 'reader', workspace })]: { generation: 1, target: releaseRef, fingerprint: digest(engine.records[releaseRef].data) } },
      auditLines: [canonical(event)],
    });
    const created = await backupCli(['backup', 'create', '--project', q.projectRoot, '--state-dir', 'state', '--out', 'bundle', '--max-bytes', '4194304']);
    assert.equal(created.exit_code, 0);
    const pin = created.data.manifest_sha256;
    const verified = await backupCli(['backup', 'verify', created.data.output, '--expect-project', LOCAL_PROJECT, '--expect-digest', pin]);
    assert.equal(verified.exit_code, 0); assert.equal(verified.data.verified, true);
    const inactive = path.join(q.root, 'inactive');
    const restoredArchive = await backupCli(['backup', 'restore', created.data.output, '--out', inactive, '--expect-project', LOCAL_PROJECT, '--expect-digest', pin]);
    assert.equal(restoredArchive.exit_code, 0); assert.equal(restoredArchive.data.restored, true);
    const inspectRef = (ref: string) => backupCli(['backup', 'inspect', inactive, '--expect-project', LOCAL_PROJECT, '--expect-digest', pin, '--ref', ref]);
    const releaseView = await inspectRef(releaseRef);
    assert.equal(releaseView.exit_code, 0);
    assert.equal(canonical(releaseView.data.record.data), pinnedRelease);
    assert.equal(canonical(releaseView.data.record.data.acceptance_manifest), pinnedObligations);
    assert.equal(releaseView.data.record.data.blocks['booking.hold'].requirements.expiry.parameters.seconds, 900);
    assert.deepEqual(releaseView.data.record.data.provenance['booking.hold/requirements.expiry'], ['L-hold@1']);
    assert.ok(releaseView.data.record.data.lineage.includes('L-hold@1'));
    const considered = await inspectRef('C-demo@1');
    assert.equal(considered.exit_code, 0); assert.ok(considered.data.record.data.proposals.includes('L-alternative@1'));
    const rejected = await inspectRef('L-alternative@1');
    assert.equal(rejected.exit_code, 0); assert.equal(rejected.data.record.type, 'layer'); assert.equal(rejected.data.record.published, true);
    const draftView = await inspectRef(restored.ref);
    assert.equal(draftView.exit_code, 0); assert.equal(draftView.data.record.data.revision, 3); assert.equal(draftView.data.record.published, false);
    const validationView = await inspectRef(v.validation.ref);
    assert.equal(validationView.exit_code, 0); assert.equal(validationView.data.record.data.evidence_digest, v.validation.evidence_digest);
    const checkpoint = JSON.parse(await readFile(path.join(inactive, 'checkpoint.json'), 'utf8'));
    assert.equal('contexts' in checkpoint, false); assert.equal('requests' in checkpoint, false);
    assert.equal(JSON.stringify(checkpoint).includes(workspace), false);
    // Complete record bytes: every indexed record in the restored archive matches the live engine exactly.
    assert.deepEqual(Object.keys(checkpoint.entries).sort(), Object.keys(pinnedRecords).sort());
    for (const [ref, pinned] of Object.entries(pinnedRecords)) {
      const entry = checkpoint.entries[ref];
      assert.equal(entry.type, pinned.type, ref); assert.equal(entry.published, pinned.published, ref);
      const bytes = await readFile(path.join(inactive, 'artifacts', entry.hash + '.json'));
      assert.equal(bytesDigest(bytes), entry.hash, ref);
      assert.equal(canonical(JSON.parse(bytes.toString())), pinned.data, ref);
    }
    assert.equal(canonical(engine.records[releaseRef].data), pinnedRelease);
    await assert.rejects(startLocalBroker(inactive, 0), code('RECOVERY_INACTIVE'));
  } finally { await rm(q.root, { recursive: true, force: true }); }
});

// Synthetic v0.2 project with one owned content Layer draft (content/1 construction
// reused from the existing content-assets suite; no mediation installation needed
// because these Layers carry no resolution proposals).
function contentProject(layerId: string) {
  const base = bootstrap(); base.model_version = CONTENT_MODEL;
  for (const block of Object.values(base.blocks)) { block.description = { format: 'plain-text/1', text: 'Synthetic v0.2 recovery fixture background.' }; block.asset_refs = {}; }
  const engine = new Engine({}, {}, { projectId: LOCAL_PROJECT, assetBytes: new Map(), modelVersion: CONTENT_MODEL });
  engine.init(base, 'bootstrap');
  const layerRecord = proposal(layerId, 'author-a', [{ op: 'set_item', block: 'booking.hold', path: 'description', expected: { kind: 'value', value: structuredClone(base.blocks['booking.hold'].description) }, value: { format: 'plain-text/1', text: 'Explain the hold lifecycle to reviewers.' } }]);
  layerRecord.model_version = CONTENT_MODEL;
  engine.layer(layerRecord, 'author-a');
  return { engine, layerRecord };
}

test('ZR-D1 regression: owned same-model v0.2 content Layer restoration appends a private revision', () => {
  const { engine } = contentProject('L-content');
  engine.layer({ ...structuredClone(engine.records['L-content@1'].data), revision: 2, intent: 'Changed exact intent for the second revision.' }, 'author-a', 'L-content@1');
  const before = structuredClone(engine.records);
  const restored = restoreLayer(engine, { ref: 'L-content@2', from: 'L-content@1' }, 'author-a');
  assert.equal(restored.ref, 'L-content@3');
  assert.equal(restored.published, false);
  assert.equal(restored.evidence_reused, false);
  assert.equal(restored.recovery.source, 'L-content@1');
  assert.equal(restored.recovery.previous, 'L-content@2');
  assert.equal(restored.recovery.result, 'L-content@3');
  assert.equal(restored.recovery.source_fingerprint, digest(engine.records['L-content@1'].data));
  assert.deepEqual(engine.records['L-content@3'].data, { ...structuredClone(engine.records['L-content@1'].data), revision: 3 });
  assert.deepEqual(engine.ownerHeads['L-content'], { owner: 'author-a', head: 3 });
  for (const [ref, record] of Object.entries(before)) assert.deepEqual(engine.records[ref], record);
  assert.throws(() => engine.read(restored.ref, 'layer'), code('REF_NOT_FOUND'));
});

test('restored v0.2 content Layers need a fresh exact authoring review before publication', () => {
  const { engine } = contentProject('L-review');
  const reviewOf = (ref: string) => engine.contentReview({ draft: engine.read(ref, 'layer', false), expected_digest: digest(engine.read(ref, 'layer', false)), accepted: true, rationale: `Exact intent-authoring/1 review of ${ref}; synthetic fixture rationale.` }, 'content-reviewer');
  const firstReview = reviewOf('L-review@1');
  engine.publish('L-review@1', 'author-a', undefined, firstReview.ref);
  engine.layer({ ...structuredClone(engine.records['L-review@1'].data), revision: 2, intent: 'Second revision with changed exact intent.' }, 'author-a', 'L-review@1');
  const restored = restoreLayer(engine, { ref: 'L-review@2', from: 'L-review@1' }, 'author-a');
  assert.equal(restored.ref, 'L-review@3');
  const pinned = structuredClone({ first: engine.records['L-review@1'], review: engine.records[firstReview.ref], second: engine.records['L-review@2'] });
  assert.throws(() => engine.publish(restored.ref, 'author-a'), code('AUTHORING_REVIEW_REQUIRED'));
  assert.throws(() => engine.publish(restored.ref, 'author-a', undefined, firstReview.ref), code('STALE_AUTHORING_REVIEW'));
  const fresh = reviewOf(restored.ref);
  assert.equal(engine.publish(restored.ref, 'author-a', undefined, fresh.ref).published, true);
  assert.deepEqual(engine.records['L-review@1'], pinned.first);
  assert.deepEqual(engine.records[firstReview.ref], pinned.review);
  assert.deepEqual(engine.records['L-review@2'], pinned.second);
  assert.equal(engine.records[restored.ref].published, true);
});
