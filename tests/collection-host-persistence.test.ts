import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BLOCK_MODEL, canonical, digest, bytesDigest } from '../src/model.js';
import { hostRunner } from '../src/auth/runner.js';
import { Engine } from '../src/core.js';
import { startLocalBroker } from '../src/local-broker.js';
import { runCli } from '../src/cli.js';
import { FixtureIssuer } from '../src/security.js';
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.js';
import { INACTIVE_MARKER } from '../src/node-state.js';
import { profileFingerprint, profileArchive } from '../src/profile.js';
import { validateRecords } from '../src/explorer/validate.js';
import { authorHostSchema } from '../scripts/studio-author.js';
import { hostCollectionFixture } from './collection-host-fixture.js';

const profile = 'collection-host/1', receipts: unknown[] = [];
const decode = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const code = (wanted: string) => (error: any) => { assert.equal(error.code, wanted); return true; };
after(async () => {
  await mkdir('.strata', { recursive: true });
  await writeFile('.strata/collection-host-persistence-evidence.json', JSON.stringify({ profile, profile_sha256: profileFingerprint(profile), trust: 'Synthetic authenticated loopback CLI; inactive template backup has no active authentication.', cases: receipts }, null, 2) + '\n');
});

test('public CLI and persistent authenticated broker retain audited Release closure across restart and independent rematerialization', async () => {
  const f = await hostCollectionFixture('persistent'), state = path.join(f.root, 'state');
  const slots = { audited: '.strata/audited', inherited: '.strata/inherited' };
  const controls: Parameters<typeof startLocalBroker>[2] = { issuer: f.issuer, model_version: BLOCK_MODEL, runner: hostRunner(f.root, slots, [profile]) };
  let broker = await startLocalBroker(state, 0, controls);
  async function bind() {
    await writeFile(path.join(f.root, 'strata.config.json'), JSON.stringify({ schema_version: '1', model_version: BLOCK_MODEL, project_id: f.issuer.projectId, broker: broker.url, artifact_adapter: 'local-persistent-fake', network_policy: 'loopback-only', profiles: [profile] }));
  }
  async function request(args: string[], record?: unknown, principal = 'runner') {
    return runCli([...args, '--project', f.root, '--json', '--offline', '--non-interactive'], record === undefined ? undefined : JSON.stringify(record), { STRATA_SESSION: f.tokens[principal] });
  }
  async function cli(args: string[], record?: unknown, principal?: string) { const result = await request(args, record, principal); assert.equal(result.ok, true, JSON.stringify(result.errors)); return result.data; }
  async function refused(wanted: string, args: string[], record?: unknown, principal?: string) { const result = await request(args, record, principal); assert.equal(result.ok, false); assert.equal(result.errors[0].code, wanted, JSON.stringify(result.errors)); }
  async function accept(target: any, slot: keyof typeof slots, baseline: string) {
    const output = await cli(['materialize', target.ref, '--profile', profile, '--out', slots[slot]]);
    const realization = (await decode(output.manifest)).record;
    assert.deepEqual(realization.oracle.expected, f.expectations.audited);
    const run = await cli(['evidence', 'run', '--file', '-'], { target: target.ref, slot, profile });
    assert.equal(run.checks_passed, true); assert.equal(run.review_pending, true);
    assert(run.run.results.every((result: any) => result.check !== 'intent.review'));
    const reviews = [];
    for (const criterion of realization.oracle.criteria.filter((c: any) => c.method === 'review')) reviews.push((await cli(['criterion', 'review', '--file', '-'], { realization: output.ref, criterion, accepted: true, rationale: 'Separate named synthetic reviewer checked the exact collection criterion.' }, 'reviewer')).ref);
    const assembled = await cli(['evidence', 'assemble', '--file', '-'], { realization: output.ref, run_ref: run.ref, review_refs: reviews });
    const validation = await cli(['validate', target.ref, '--realization', output.manifest, '--evidence', '-'], assembled.evidence);
    const seed = await cli(['inspect', 'release', baseline]);
    const generation = (await cli(['capabilities'])).mediation_generation;
    const shape = { format: 'approval/3', project_id: f.issuer.projectId, model_version: BLOCK_MODEL, baseline, authority_sha256: digest(seed.authorities), target: target.fingerprint, evidence_digest: validation.evidence_digest, generation, expires_at: null, binding: null };
    const approvals = [];
    for (const [kind, scope, principal] of [['scope', 'collection', 'scope-selector'], ['guardian', 'policy/requirements.atomic', 'safety-guardian'], ['release', null, 'release-manager']] as const) approvals.push((await cli(['approve', '--file', '-'], { ...shape, kind, scope }, principal)).ref);
    const released = await cli(['release', target.ref, '--validation', validation.ref, ...approvals.flatMap(ref => ['--approval', ref])], undefined, 'release-manager');
    const release = await cli(['inspect', 'release', released.ref]);
    assert.equal(release.trust, 'host-authenticated'); assert.equal(release.format, 'release/3');
    assert.equal(release.acceptance_manifest.length, target.obligations.length);
    return { output, realization, run, reviews, validation, approvals, released, release };
  }
  try {
    await bind(); await cli(['init', '--file', '-'], f.baseline, 'author-a');
    const seedBefore = canonical(await cli(['inspect', 'release', 'HostCollectionBaseline@1']));
    const draft = await cli(['layer', 'create', '--file', '-'], f.audit, 'author-a');
    await refused('REF_NOT_FOUND', ['inspect', 'layer', draft.ref], undefined, 'reader');
    const normalized = await cli(['inspect', 'layer', draft.ref], undefined, 'author-a');
    const review = await cli(['content', 'review', '--file', '-'], { draft: normalized, expected_digest: digest(normalized), accepted: true, rationale: 'Exact synthetic audit Block and collection links reviewed.' }, 'reviewer');
    await cli(['layer', 'publish', draft.ref, '--authoring-review', review.ref], undefined, 'author-a');
    const target = await cli(['compose', '--file', '-'], { ...f.recipe, id: 'HostPersistentAudit', proposals: [draft.ref], selected: [draft.ref] }, 'author-a');
    const first = await accept(target, 'audited', 'HostCollectionBaseline@1');
    await broker.close(); broker = await startLocalBroker(state, 0, controls); await bind();
    assert.equal(canonical(await cli(['inspect', 'release', first.released.ref])), canonical(first.release));
    assert.equal(canonical(await cli(['inspect', 'release', 'HostCollectionBaseline@1'])), seedBefore);
    const inherited = await cli(['compose', '--file', '-'], { ...f.recipe, id: 'HostPersistentInherited', baseline: first.released.ref, proposals: [], selected: [] }, 'author-a');
    assert.deepEqual(inherited.obligations, target.obligations); assert.deepEqual(inherited.provenance, target.provenance);
    const next = await accept(inherited, 'inherited', first.released.ref);
    assert.deepEqual(next.realization.files, first.realization.files); assert.equal(next.realization.output_tree, first.realization.output_tree);
    assert.notEqual(next.realization.candidate, first.realization.candidate);
    const registry = await decode(path.join(state, 'registry.json')), records: any = {};
    for (const [ref, entry] of Object.entries(registry.entries) as [string, any][]) records[ref] = { type: entry.type, published: entry.published, data: await decode(path.join(state, 'artifacts', entry.hash + '.json')) };
    validateRecords(records, f.issuer.projectId, BLOCK_MODEL);
    const freshScript = `
      const {readFile}=await import('node:fs/promises'), path=await import('node:path');
      const {Engine}=await import('./dist/src/core.js'); const {BLOCK_MODEL,digest}=await import('./dist/src/model.js');
      const {validateRecords}=await import('./dist/src/explorer/validate.js');
      const registry=JSON.parse(await readFile(path.join(process.argv[1],'registry.json'),'utf8')), records={};
      for(const [ref,entry] of Object.entries(registry.entries)) records[ref]={type:entry.type,published:entry.published,data:JSON.parse(await readFile(path.join(process.argv[1],'artifacts',entry.hash+'.json'),'utf8'))};
      validateRecords(records,process.argv[2],BLOCK_MODEL);
      const engine=new Engine(records,registry.heads,{projectId:process.argv[2],modelVersion:BLOCK_MODEL,checkerBackend:'node'});
      const output=engine.realize(process.argv[3],'collection-host/1');
      console.log(JSON.stringify({release_sha256:digest(engine.read(process.argv[3],'release')),output_tree:output.output_tree,records:Object.keys(records).length}));
    `;
    const fresh = spawnSync(process.execPath, ['--import', './tests/no-external-fetch.mjs', '--input-type=module', '-e', freshScript, state, f.issuer.projectId, next.released.ref], { encoding: 'utf8', timeout: 15000 });
    assert.equal(fresh.status, 0, fresh.stderr);
    const independent = JSON.parse(fresh.stdout); assert.equal(independent.release_sha256, digest(next.release)); assert.equal(independent.output_tree, next.realization.output_tree); assert.equal(independent.records, Object.keys(records).length);
    const ledger = await readFile(path.join(state, 'audit.jsonl'), 'utf8');
    for (const value of [...Object.values(f.keys), ...Object.values(f.tokens)]) assert.equal(ledger.includes(value), false);
    // The existing offline recovery contract excludes authenticated host records.
    // A compiled profile addition must not silently widen that contract or activate identities.
    await broker.close();
    await assert.rejects(createBackup({ state, out: path.join(f.root, 'host-backup-refused'), project: f.issuer.projectId, selector: 'fixture-backup', maxBytes: 8 * 1024 * 1024 }), code('BACKUP_INVALID'));
    receipts.push({ case: 'authenticated-cli-restart', release: first.released.ref, inherited_release: next.released.ref, output_tree: first.realization.output_tree, run: first.run.ref, separate_review_count: first.reviews.length, approvals: first.approvals, restart_exact: true, fresh_process_closure: independent, independent_rematerialization: true, authenticated_host_backup: 'BACKUP_INVALID under existing offline contract' });
  } finally { await broker.close(); }
});

test('offline backup accepts exact new compiled template assets, remains inactive and refuses rehashed unknown profiles', async () => {
  const f = await hostCollectionFixture('template-backup'), project = 'synthetic-template-archive', state = path.join(f.root, 'state');
  const issuer = new FixtureIssuer({ project_id: project }), broker = await startLocalBroker(state, 0, { issuer, model_version: BLOCK_MODEL });
  await broker.close();
  // Construct only an unvalidated historical template archive using the existing
  // offline backup fixture seam. No fixture actor obtains v0.3 host authority.
  const engine = new Engine({}, {}, { projectId: project, modelVersion: BLOCK_MODEL, checkerBackend: 'node' });
  engine.init(structuredClone(f.baseline), 'bootstrap');
  const target = engine.compose({ ...f.recipe, id: 'TemplateOnly', proposals: [], selected: [] });
  const realization = engine.registerRealization(engine.realize(target.ref, profile)), entries: Record<string, any> = {};
  for (const [ref, record] of Object.entries(engine.records)) {
    const text = canonical(record.data), hash = bytesDigest(text);
    await writeFile(path.join(state, 'artifacts', hash + '.json'), text); entries[ref] = { hash, type: record.type, published: record.published };
  }
  await writeFile(path.join(state, 'registry.json'), canonical({ entries, heads: engine.ownerHeads, requests: {}, commit_audit: [] }));
  await writeFile(path.join(state, 'audit.jsonl'), '');
  const bundle = path.join(f.root, 'template-bundle'), backup = await createBackup({ state, out: bundle, project, selector: 'fixture-backup', maxBytes: 8 * 1024 * 1024 });
  const verified = await verifyBackup({ bundle, project, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256, ref: realization.ref });
  assert.equal(verified.verified, true); assert.equal(verified.authors_authenticated, false);
  assert.equal(verified.record!.data.profile_id, profile);
  assert.deepEqual(await decode(path.join(bundle, 'profiles', profileFingerprint(profile) + '.json')), profileArchive(profile));
  const restoredPath = path.join(path.dirname(f.root), path.basename(f.root) + '-inactive');
  const restored = await restoreBackup({ bundle, out: restoredPath, project, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  assert.equal(restored.identities_active, false); assert.equal(restored.requests_active, false);
  await assert.rejects(startLocalBroker(restoredPath, 0, { issuer, model_version: BLOCK_MODEL }), code('RECOVERY_INACTIVE'));
  assert.equal((await verifyBackup({ bundle: restoredPath, project, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 })).checkpoint_sha256, verified.checkpoint_sha256);
  const bad = path.join(f.root, 'unknown-template'); await cp(bundle, bad, { recursive: true });
  const checkpoint = await decode(path.join(bad, 'checkpoint.json'));
  const entry = checkpoint.entries[realization.ref], oldHash = entry.hash, record = await decode(path.join(bad, 'artifacts', oldHash + '.json'));
  record.profile_id = 'collection-unknown/1'; const text = canonical(record); entry.hash = bytesDigest(text);
  await writeFile(path.join(bad, 'artifacts', entry.hash + '.json'), text); await unlink(path.join(bad, 'artifacts', oldHash + '.json'));
  await writeFile(path.join(bad, 'checkpoint.json'), canonical(checkpoint));
  const manifest = await decode(path.join(bad, 'manifest.json'));
  for (const item of manifest.inventory) { if (item.path === 'artifacts/' + oldHash + '.json') item.path = 'artifacts/' + entry.hash + '.json'; const bytes = await readFile(path.join(bad, item.path)); item.sha256 = bytesDigest(bytes); item.bytes = bytes.length; }
  manifest.checkpoint_sha256 = bytesDigest(await readFile(path.join(bad, 'checkpoint.json')));
  const manifestText = canonical(manifest), manifestHash = bytesDigest(manifestText);
  await writeFile(path.join(bad, 'manifest.json'), manifestText); await writeFile(path.join(bad, 'COMPLETE.json'), canonical({ format: 'strata-backup-complete/1', manifest_sha256: manifestHash }));
  const marker = await decode(path.join(bad, INACTIVE_MARKER)); marker.manifest_sha256 = manifestHash; await writeFile(path.join(bad, INACTIVE_MARKER), canonical(marker));
  await assert.rejects(verifyBackup({ bundle: bad, project, selector: 'fixture-backup' }), code('BACKUP_INVALID'));
  receipts.push({ case: 'inactive-template-backup', profile: profileFingerprint(profile), manifest: backup.manifest_sha256, checkpoint: verified.checkpoint_sha256, no_validation_or_accepted_release: true, identities_active: false, unknown_profile_refused: true });
});

test('author-host runner configuration stays explicit and finite without synthesizing slots or grants', async () => {
  const f = await hostCollectionFixture('allowlist');
  const config = { format: 'strata-studio-author-host/1', project_id: f.issuer.projectId, project_directory: f.root, state_directory: path.join(f.root, 'state'), accounts_file: path.join(f.root, 'accounts.json'), policy_file: path.join(f.root, 'policy.json'), public_origin: 'https://studio.example', trusted_proxy_addresses: ['127.0.0.1'], port: 0, operations: [], output_slots: {}, runner_profiles: [] };
  assert.deepEqual(authorHostSchema.parse(config).runner_profiles, []);
  for (const runner_profiles of [['counter-host/1'], [profile], ['counter-host/1', profile]]) {
    const parsed = authorHostSchema.parse({ ...config, runner_profiles }); assert.deepEqual(parsed.runner_profiles, runner_profiles); assert.deepEqual(parsed.output_slots, {});
  }
  for (const runner_profiles of [[profile, profile], ['collection-node/1'], ['collection-unknown/1'], ['counter-host/1', profile, profile]]) assert.equal(authorHostSchema.safeParse({ ...config, runner_profiles }).success, false);
});
