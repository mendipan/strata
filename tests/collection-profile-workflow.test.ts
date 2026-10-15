import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine, snapshotFromRelease, type Evaluation } from '../src/core.js';
import { canonical, digest, bytesDigest, normalizeSnapshot, type Snapshot, type Layer, type Composition } from '../src/model.js';
import { profileFingerprint, treeDigest, type FixtureOracle } from '../src/profile.js';
import { runFixtureEvidence } from '../src/runner.js';
import { startLocalBroker } from '../src/local-broker.js';
import { runCli, HELP } from '../src/cli.js';
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.js';
import { INACTIVE_MARKER } from '../src/node-state.js';
import { COLLECTION_PROFILE } from '../src/profiles/collection-semantics.js';

const fixture = async (name: string) => JSON.parse(await readFile(path.resolve('tests/fixtures/collection', name + '.json'), 'utf8'));
const baseline: Snapshot = normalizeSnapshot(await fixture('bootstrap')), layer: Layer = await fixture('extend'), recipe: Composition = await fixture('composition'), expectations = await fixture('expectations');
await mkdir('.strata', { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'strata-collection-workflow-'));
const receipts: unknown[] = [];
after(async () => {
  await writeFile('.strata/collection-workflow-evidence.json', JSON.stringify({ accepted_base: '1f254140fa88c8b9eb001b67f328a96698205e7d', profile_id: COLLECTION_PROFILE, archive_sha256: profileFingerprint(COLLECTION_PROFILE), trust: 'synthetic local fixture measurement and review; separate fixture approvals; no hosted authentication', cases: receipts }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
});
const code = (wanted: string) => (e: any) => { assert.equal(e.code, wanted); return true; };
const decode = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
function oracle(e: Pick<Evaluation, 'snapshot'>, changed = true): FixtureOracle {
  // Literal independently checked-in expectations, not values read from generated config/oracle.
  return { format: expectations.format, snapshot_sha256: digest(e.snapshot), expected: structuredClone(changed ? expectations.changed : expectations.baseline), criteria: structuredClone(expectations.criteria).sort((a: unknown, b: unknown) => canonical(a).localeCompare(canonical(b))) };
}
function candidate(snapshot = baseline) {
  const engine = new Engine(); engine.init(structuredClone(snapshot), 'bootstrap'); engine.layer(structuredClone(layer), 'author-a'); engine.publish('CollectionExtension@1', 'author-a');
  return { engine, target: engine.compose(structuredClone(recipe)) };
}
async function exported(engine: Engine, target: Evaluation & { ref: string }, name: string) {
  const record = engine.realize(target.ref, COLLECTION_PROFILE), registered = engine.registerRealization(record), directory = path.join(root, name);
  await mkdir(directory); for (const [file, body] of Object.entries(record.files)) await writeFile(path.join(directory, file), body);
  await writeFile(path.join(directory, 'realization.json'), JSON.stringify({ record, realization_ref: registered.ref }));
  return { record, registered, directory };
}

test('registered collection conserves all three Blocks and refuses substituted outputs, oracles and evidence', async () => {
  const { engine, target } = candidate(); assert.equal(target.state, 'eligible_for_validation'); assert.equal(target.scope, 'collection');
  assert.deepEqual(Object.keys(target.snapshot.blocks).sort(), ['collection', 'items', 'policy']);
  assert.deepEqual(target.provenance['policy/requirements.count'], ['CollectionExtension@1']);
  const out = await exported(engine, target, 'negative'), measured = await runFixtureEvidence(out.directory, out.record, oracle(target));
  assert(measured.evidence.results.every(r => r.passed)); assert.equal(out.record.coverage.length, target.obligations.length);
  await assert.rejects(() => runFixtureEvidence(out.directory, out.record), code('ORACLE_REQUIRED'));
  await assert.rejects(() => runFixtureEvidence(out.directory, out.record, oracle(target, false)), code('ORACLE_MISMATCH'));
  const refusals: Record<string, string> = {};
  for (const [name, mutate, expected] of [
    ['candidate', (e: any) => { e.candidate = '0'.repeat(64); }, 'STALE_EVIDENCE'],
    ['output', (e: any) => { e.output_tree = '0'.repeat(64); }, 'STALE_EVIDENCE'],
    ['checker', (e: any) => { e.checker_sha256 = '0'.repeat(64); }, 'STALE_CHECKER_EVIDENCE'],
    ['fixture', (e: any) => { e.fixture_sha256 = '0'.repeat(64); }, 'STALE_CHECKER_EVIDENCE'],
    ['oracle', (e: any) => { e.oracle_sha256 = '0'.repeat(64); }, 'STALE_CHECKER_EVIDENCE'],
    ['missing criterion', (e: any) => { e.results.pop(); }, 'VALIDATION_INCOMPLETE'],
    ['false result', (e: any) => { e.results[0].passed = false; }, 'VALIDATION_INCOMPLETE'],
    ['criterion substitution', (e: any) => { e.results[0].fixture = 'unmeasured'; }, 'UNKNOWN_EVIDENCE']
  ] as const) {
    const changed = structuredClone(measured.evidence); mutate(changed); assert.throws(() => engine.validate(target.ref, out.registered.ref, changed), code(expected)); refusals[name] = expected;
  }
  for (const mutate of [
    (r: typeof out.record) => { r.files['collection.mjs'] += '\nexport const substituted = true;\n'; r.output_tree = treeDigest(r.files); },
    (r: typeof out.record) => { r.files['extra.txt'] = 'extra'; r.output_tree = treeDigest(r.files); },
    (r: typeof out.record) => { delete r.files['README.md']; r.output_tree = treeDigest(r.files); },
    (r: typeof out.record) => { r.coverage.pop(); },
    (r: typeof out.record) => { r.oracle!.expected.max_items = 1000; r.oracle_sha256 = digest(r.oracle); }
  ]) assert.throws(() => { const changed = structuredClone(out.record); mutate(changed); engine.registerRealization(changed); }, (e: any) => ['STALE_REALIZATION', 'STALE_CHECKER_EVIDENCE'].includes(e.code));
  await writeFile(path.join(out.directory, 'collection.mjs'), out.record.files['collection.mjs'] + '\n// changed bytes\n');
  await assert.rejects(() => runFixtureEvidence(out.directory, out.record, oracle(target)), code('OUTPUT_TAMPERED'));
  assert.equal(Object.values(engine.records).filter(r => r.type === 'validation').length, 0);
  receipts.push({ case: 'bound-measurement-refusals', candidate: target.fingerprint, obligations: target.obligations.map(o => o.item), refusals });
});

test('unsupported collection topology and semantics refuse through real Composition gates', () => {
  const missing = structuredClone(baseline); delete missing.blocks.items.requirements.detached;
  assert.throws(() => new Engine().init(missing, 'bootstrap'), code('DANGLING_REFERENCE'));
  for (const [name, mutate] of Object.entries({
    unknown: (s: Snapshot) => { s.blocks.policy.requirements.extra = structuredClone(s.blocks.policy.requirements.atomic); },
    unbounded: (s: Snapshot) => { s.blocks.policy.requirements.count.parameters.max_items = 1001; },
    audit: (s: Snapshot) => { s.blocks.audit = { ...structuredClone(s.blocks.items), id: 'audit', parent: 'collection' }; },
    reparent: (s: Snapshot) => { s.blocks.items.parent = 'policy'; }
  })) {
    const s = structuredClone(baseline); mutate(s); const engine = new Engine(); engine.init(s, 'bootstrap');
    const target = engine.compose({ ...recipe, id: name, proposals: [], selected: [] });
    assert.equal(target.state, 'blocked'); assert(target.diagnostics.some(d => d.code === 'UNSUPPORTED_OBLIGATION'));
    assert.throws(() => engine.realize(target.ref, COLLECTION_PROFILE), code('BLOCKED_CANDIDATE'));
    assert.equal(Object.values(engine.records).filter(r => r.type === 'release').length, 1);
  }
});

test('collection collisions use ordinary owned whole-Layer selection and the declared root authority', () => {
  const { engine } = candidate(), alternate = structuredClone(layer); alternate.id = 'CollectionAlternative'; alternate.owner = 'author-c';
  alternate.changes[0].value = { ...structuredClone(layer.changes[0].value as object), statement: 'At most 4 items exist per collection instance.', parameters: { max_items: 4 } };
  engine.layer(alternate, 'author-c'); engine.publish('CollectionAlternative@1', 'author-c');
  const considered = ['CollectionExtension@1', 'CollectionAlternative@1'];
  const blocked = engine.compose({ ...recipe, id: 'CollectionConflict', proposals: considered, selected: considered });
  assert.equal(blocked.state, 'blocked'); assert(blocked.diagnostics.some(d => d.code === 'ITEM_COLLISION')); assert.equal(blocked.scope, 'collection');
  const decision: Layer = { ...structuredClone(layer), id: 'CollectionDecision', owner: 'scope-selector', changes: [], resolution_proposals: [{ input_fingerprint: blocked.input_fingerprint, scope: 'collection', impact: blocked.impact, outcome: { kind: 'select', selected: ['CollectionExtension@1'], rejected: ['CollectionAlternative@1'] } }] };
  engine.layer(decision, 'scope-selector'); engine.publish('CollectionDecision@1', 'scope-selector');
  const request = { layer: 'CollectionDecision@1', proposal_index: 0, composition: blocked.ref, approvals: [] as string[] };
  const unsigned = engine.resolution(request, 'scope-selector', true) as any;
  assert.throws(() => engine.resolution(request, 'scope-selector'), code('ENDORSEMENT_REQUIRED'));
  request.approvals.push(engine.approve({ kind: 'resolution', target: unsigned.target, scope: 'collection', evidence_digest: null }, 'scope-selector').ref);
  const resolution = engine.resolution(request, 'scope-selector') as any;
  const selected = engine.compose({ ...recipe, id: 'CollectionSelected', proposals: considered, selected: ['CollectionExtension@1'], resolutions: [resolution.ref] });
  assert.equal(selected.state, 'eligible_for_validation'); assert.equal(engine.realize(selected.ref, COLLECTION_PROFILE).oracle!.expected.max_items, 5);
  const stale = engine.compose({ ...recipe, id: 'CollectionStaleSelection', resolutions: [resolution.ref] });
  assert(stale.diagnostics.some(d => d.code === 'STALE_RESOLUTION'));
});

test('public local CLI measures independent intent, obtains separate approvals, reuses Release after restart and verifies inactive backup closure', async () => {
  assert(HELP.capabilities.profiles.includes(COLLECTION_PROFILE));
  const project = path.join(root, 'project'), state = path.join(project, 'state'); await mkdir(project);
  let broker = await startLocalBroker(state, 0);
  const config = await decode('strata.config.json'); config.profiles = [COLLECTION_PROFILE];
  async function bind() { config.broker = broker.url; await writeFile(path.join(project, 'strata.config.json'), JSON.stringify(config)); }
  await bind();
  async function request(args: string[], record?: unknown, session = 'fixture-preparer') {
    return runCli([...args, '--project', project, '--json', '--offline', '--non-interactive'], record === undefined ? undefined : JSON.stringify(record), { ...process.env, STRATA_SESSION: session });
  }
  async function cli(args: string[], record?: unknown, session?: string) { const r = await request(args, record, session); assert.equal(r.exit_code, 0, JSON.stringify(r.errors)); return r.data; }
  async function refused(expected: string, args: string[], record?: unknown, session?: string) { const r = await request(args, record, session); assert.equal(r.ok, false); assert.equal(r.errors[0].code, expected, JSON.stringify(r.errors)); }
  async function measure(target: any, slot: string, changed = true) {
    const output = await cli(['materialize', target.ref, '--profile', COLLECTION_PROFILE, '--out', '.strata/' + slot]);
    const manifest = await decode(output.manifest), directory = path.dirname(output.manifest), run = await runFixtureEvidence(directory, manifest.record, oracle(target, changed));
    assert(run.evidence.results.every(r => r.passed));
    const app: any = (await import(pathToFileURL(path.join(directory, 'collection.mjs')).href)).createCollection();
    const trace = Array.from({ length: 6 }, (_, n) => app.add('i' + (n + 1), 'literal'));
    assert.deepEqual(trace.map(r => r.accepted), changed ? [true, true, true, true, true, false] : [true, true, true, false, false, false]);
    const evidence = path.join(project, slot + '-evidence.json'); await writeFile(evidence, JSON.stringify(run.evidence));
    return { output, manifest, directory, run, evidence, trace };
  }
  let released: any, inherited: any, first: any, next: any;
  try {
    await cli(['init', '--file', '-'], baseline, 'fixture-bootstrap');
    await measure({ ref: 'CollectionBaseline@1', snapshot: baseline }, 'baseline', false);
    const draft = await cli(['layer', 'create', '--file', '-'], layer, 'fixture-a');
    await refused('REF_NOT_FOUND', ['capabilities', '--target', draft.ref], undefined, 'fixture-reader');
    await cli(['layer', 'publish', draft.ref], undefined, 'fixture-a');
    const target = await cli(['compose', '--file', '-'], recipe);
    assert.equal(target.scope, 'collection'); assert.equal(target.state, 'eligible_for_validation');
    const capabilities = await cli(['capabilities', '--target', target.ref], undefined, 'fixture-reader');
    assert(capabilities.target_support.profiles.find((r: any) => r.profile.id === COLLECTION_PROFILE).materialization.supported);
    await refused('OPERATION_FORBIDDEN', ['materialize', target.ref, '--profile', COLLECTION_PROFILE, '--out', '.strata/denied'], undefined, 'fixture-reader');
    first = await measure(target, 'changed');
    await refused('OPERATION_FORBIDDEN', ['validate', target.ref, '--realization', first.output.manifest, '--evidence', first.evidence], undefined, 'fixture-preparer');
    const validation = await cli(['validate', target.ref, '--realization', first.output.manifest, '--evidence', first.evidence], undefined, 'fixture-runner');
    assert.equal(validation.approvals_pending, true);
    const releaseArgs = ['release', target.ref, '--validation', validation.ref];
    await refused('ENDORSEMENT_REQUIRED', releaseArgs, undefined, 'fixture-release');
    await refused('OPERATION_FORBIDDEN', ['approve', '--file', '-'], { kind: 'scope', target: target.fingerprint, scope: 'collection', evidence_digest: validation.evidence_digest }, 'fixture-a');
    await refused('AUTHORITY_FORBIDDEN', ['approve', '--file', '-'], { kind: 'scope', target: target.fingerprint, scope: 'collection', evidence_digest: validation.evidence_digest }, 'fixture-release');
    const scope = await cli(['approve', '--file', '-'], { kind: 'scope', target: target.fingerprint, scope: 'collection', evidence_digest: validation.evidence_digest }, 'fixture-selector');
    await refused('RELEASE_APPROVAL_REQUIRED', [...releaseArgs, '--approval', scope.ref], undefined, 'fixture-release');
    const releaseApproval = await cli(['approve', '--file', '-'], { kind: 'release', target: target.fingerprint, scope: null, evidence_digest: validation.evidence_digest }, 'fixture-release');
    await writeFile(path.join(first.directory, 'collection.mjs'), first.manifest.record.files['collection.mjs'] + '\n// tampered after validation\n');
    await refused('OUTPUT_TAMPERED', [...releaseArgs, '--approval', scope.ref, '--approval', releaseApproval.ref], undefined, 'fixture-release');
    await writeFile(path.join(first.directory, 'collection.mjs'), first.manifest.record.files['collection.mjs']);
    released = await cli([...releaseArgs, '--approval', scope.ref, '--approval', releaseApproval.ref], undefined, 'fixture-release');
    const releasedRecord = await cli(['inspect', 'release', released.ref]);
    assert.equal(canonical(snapshotFromRelease(releasedRecord).blocks), canonical(target.snapshot.blocks));
    await broker.close(); broker = await startLocalBroker(state, 0); await bind();
    assert.equal(canonical(await cli(['inspect', 'release', released.ref])), canonical(releasedRecord));
    inherited = await cli(['compose', '--file', '-'], { ...recipe, id: 'CollectionInherited', baseline: released.ref, proposals: [], selected: [] });
    assert.equal(inherited.state, 'eligible_for_validation'); assert.deepEqual(inherited.obligations, target.obligations); assert.deepEqual(inherited.provenance, target.provenance);
    assert.deepEqual((await cli(['inspect', 'composition', inherited.ref])).proposals, []);
    next = await measure(inherited, 'inherited');
    assert.equal(next.manifest.record.output_tree, first.manifest.record.output_tree);
    assert.equal(next.manifest.record.checker_sha256, first.manifest.record.checker_sha256);
    const nextValidation = await cli(['validate', inherited.ref, '--realization', next.output.manifest, '--evidence', next.evidence], undefined, 'fixture-runner');
    const nextApprovals = [];
    for (const [kind, principal, scopeValue] of [['scope', 'fixture-selector', 'collection'], ['release', 'fixture-release', null]] as const) nextApprovals.push((await cli(['approve', '--file', '-'], { kind, target: inherited.fingerprint, scope: scopeValue, evidence_digest: nextValidation.evidence_digest }, principal)).ref);
    await cli(['release', inherited.ref, '--validation', nextValidation.ref, ...nextApprovals.flatMap(ref => ['--approval', ref])], undefined, 'fixture-release');
    receipts.push({ case: 'cli-release-and-empty-considered-reuse', candidate: target.fingerprint, release: released.ref, authority: { scope: scope.ref, release: releaseApproval.ref }, profile: first.manifest.record.profile, output_tree: first.manifest.record.output_tree, checker: first.manifest.record.checker_sha256, fixture: first.manifest.record.fixture_sha256, oracle: first.manifest.record.oracle_sha256, checks: first.run.observations.checks, changed_trace: first.trace, inherited: { candidate: inherited.fingerprint, obligations: inherited.obligations.map((o: any) => o.item), output_tree: next.manifest.record.output_tree, trace: next.trace }, restart_exact: true });
  } finally { await broker.close(); }
  const bundle = path.join(root, 'bundle'), backup = await createBackup({ state, out: bundle, project: config.project_id, selector: 'fixture-backup', maxBytes: 8 * 1024 * 1024 });
  const verified = await verifyBackup({ bundle, project: config.project_id, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256, ref: released.ref });
  assert.equal(verified.verified, true); assert.equal(verified.authors_authenticated, false);
  const restore = path.join(root, 'inactive'), restored = await restoreBackup({ bundle, out: restore, project: config.project_id, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  assert.equal(restored.inactive, true); assert.equal(restored.identities_active, false); assert.equal(restored.requests_active, false);
  const reverified = await verifyBackup({ bundle: restore, project: config.project_id, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  assert.equal(reverified.checkpoint_sha256, verified.checkpoint_sha256);
  await assert.rejects(() => startLocalBroker(restore, 0), code('RECOVERY_INACTIVE'));
  assert(await decode(path.join(restore, INACTIVE_MARKER)));
  const manifest = await decode(path.join(bundle, 'manifest.json'));
  assert(manifest.profile_assets.includes(profileFingerprint(COLLECTION_PROFILE)));
  assert.deepEqual(await decode(path.join(bundle, 'profiles', profileFingerprint(COLLECTION_PROFILE) + '.json')), await import('../src/profiles/collection.js').then(m => m.collectionProfile.archive()));
  // Recompute all container hashes: the compiled registry must still refuse an unknown profile ID.
  const bad = path.join(root, 'unsupported-profile'); await cp(bundle, bad, { recursive: true });
  const checkpoint = await decode(path.join(bad, 'checkpoint.json'));
  const entry = Object.values(checkpoint.entries).find((e: any) => e.type === 'realization') as any;
  const oldArtifact = path.join(bad, 'artifacts', entry.hash + '.json'), record = await decode(oldArtifact); record.profile_id = 'collection-unknown/1';
  const text = canonical(record), newHash = bytesDigest(text); await writeFile(path.join(bad, 'artifacts', newHash + '.json'), text); await unlink(oldArtifact); const oldHash = entry.hash; entry.hash = newHash;
  await writeFile(path.join(bad, 'checkpoint.json'), canonical(checkpoint));
  const badManifest = await decode(path.join(bad, 'manifest.json'));
  for (const item of badManifest.inventory) { if (item.path === 'artifacts/' + oldHash + '.json') item.path = 'artifacts/' + newHash + '.json'; const bytes = await readFile(path.join(bad, item.path)); item.sha256 = bytesDigest(bytes); item.bytes = bytes.length; }
  badManifest.checkpoint_sha256 = bytesDigest(await readFile(path.join(bad, 'checkpoint.json')));
  const manifestText = canonical(badManifest); await writeFile(path.join(bad, 'manifest.json'), manifestText); await writeFile(path.join(bad, 'COMPLETE.json'), canonical({ format: 'strata-backup-complete/1', manifest_sha256: bytesDigest(manifestText) }));
  const inactive = await decode(path.join(bad, INACTIVE_MARKER)); inactive.manifest_sha256 = bytesDigest(manifestText); await writeFile(path.join(bad, INACTIVE_MARKER), canonical(inactive));
  await assert.rejects(() => verifyBackup({ bundle: bad, project: config.project_id, selector: 'fixture-backup' }), code('BACKUP_INVALID'));
  receipts.push({ case: 'backup-closure-and-inactive-restore', manifest_sha256: backup.manifest_sha256, checkpoint_sha256: verified.checkpoint_sha256, exact_profile_asset: true, inactive: true, authors_authenticated: false, unknown_profile_refused: true });
});
