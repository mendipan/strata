import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Engine } from '../src/core.js';
import { BLOCK_MODEL, canonical, digest, bytesDigest, type Records } from '../src/model.js';
import { HostIssuer } from '../src/auth/host-issuer.js';
import { BuildProfileService, type ProfileServiceScope } from '../src/profile-service.js';
import { PROFILE_OPERATIONS, PROFILE_READS, verifyBuildHistory } from '../src/build-records.js';
import { openProfileRepository } from '../src/profile-node.js';
import { normalizeBuildProfile, type BuildPin } from '../src/build-contracts.js';
import { profileFor } from '../src/profiles.js';
import { hostCollectionFixture } from './collection-host-fixture.js';
import { runNodeCommand } from '../src/commands/node.js';
import { hostRunner } from '../src/auth/runner.js';
import { inspectReleasePublication } from '../src/build-publication.js';
import { validateRecords } from '../src/explorer/validate.js';
import { bindNodeState, INACTIVE_MARKER } from '../src/node-state.js';
import { createBackup, verifyBackup, restoreBackup, BUILD_BACKUP_FORMAT } from '../src/backup.js';
import { FixtureIssuer } from '../src/security.js';

const code = (expected: string) => (error: any) => error.code === expected;
const record = (revision = 1, rules: any[] = []) => ({ format: 'strata-repository-compatibility/1', id: 'Compatibility', revision, rules, preferences: [] });
const choices = { language: 'javascript', framework: 'none', runtime: 'node' };
const requestProfile = (contract: BuildPin, revision = 1, name = 'Local preview', id = 'LocalPreview') => ({ record: {
  id, revision, name, contract_ref: contract.ref, contract_sha256: contract.sha256, choices,
  materializer: { id: 'collection-host/1', archive_sha256: digest(profileFor('collection-host/1').archive()) }
}, expected_normalized_sha256: '' });
function profile(contract: BuildPin, revision = 1, name = 'Local preview', id = 'LocalPreview') {
  const request = requestProfile(contract, revision, name, id); request.expected_normalized_sha256 = digest(normalizeBuildProfile(request.record)); return request;
}
async function fixture(publication = false) {
  const f = await hostCollectionFixture('s1');
  let releaseRef: string | undefined;
  if (publication) {
    f.publish(f.extension);
    const target = f.call('author-a', 'compose', { record: { ...f.recipe, id: 'S1Publication' } }).ref;
    const exported = await runNodeCommand(f.root, (c, i) => f.call('runner', c, i), 'materialize', { target, profile: 'collection-host/1', out: '.strata/generated' });
    const realization = f.engine.read(exported.ref), request = { target, slot: 'generated', profile: 'collection-host/1' };
    f.call('runner', 'evidence.run', request);
    const run = await hostRunner(f.root, { generated: '.strata/generated' }, ['collection-host/1'])(f.engine, request, f.issuer.resolve(f.tokens.runner));
    const reviews = realization.oracle.criteria.filter((c: any) => c.method === 'review').map((criterion: any) => f.call('reviewer', 'criterion.review', { realization: exported.ref, criterion, accepted: true, rationale: 'Exact synthetic finite fixture review.' }).ref);
    const evidence = f.call('runner', 'evidence.assemble', { realization: exported.ref, run_ref: run.ref, review_refs: reviews }).evidence;
    const validation = f.call('runner', 'validate', { target, realization: exported.ref, evidence });
    const evaluation = f.engine.target(target), shape = { format: 'approval/3', project_id: f.issuer.projectId, model_version: BLOCK_MODEL, baseline: 'HostCollectionBaseline@1', authority_sha256: digest(f.baseline.authorities), target: evaluation.fingerprint, evidence_digest: validation.evidence_digest, generation: f.engine.mediation!.generation(), expires_at: null, binding: null };
    const scope = f.call('scope-selector', 'approve', { record: { ...shape, kind: 'scope', scope: evaluation.scope } });
    const approval = f.call('release-manager', 'approve', { record: { ...shape, kind: 'release', scope: null } });
    releaseRef = f.call('release-manager', 'release', { target, validation: validation.ref, approvals: [scope.ref, approval.ref] }).ref;
    // Retain old raw Release output before adoption, then verify recovery preserves it.
    f.call('runner', 'realization.register', { record: f.engine.realize(releaseRef!, 'collection-host/1') });
  }
  const policy: any = { ...f.policy, format: 'strata-host-policy/4', generation: 2, grants: f.policy.grants.map(g => {
    const { expires_at, ...old } = g;
    return { ...old, operations: [...new Set([...g.operations, ...(g.principal_id === 'reader' ? PROFILE_READS : PROFILE_OPERATIONS)])],
      lifetime: { mode: 'until', expires_at }, build_repository_ids: ['demo', 'other'] };
  }) };
  const issuer = new HostIssuer(f.accounts, policy);
  const tokens = Object.fromEntries(Object.keys(f.keys).map(name => [name, issuer.login(name, f.keys[name])]));
  const reviews = new Map<string, BuildPin>();
  const scope: ProfileServiceScope = { project_id: issuer.projectId, repository_id: 'demo', source_trust: 'local-fixture', authority_ref: 'HostCollectionBaseline@1', review: (action, sha) => reviews.get(action + ':' + sha) };
  const service = (name = 'author-a', override: Partial<ProfileServiceScope> = {}) => new BuildProfileService(f.engine, { ...scope, ...override }, issuer.resolve(tokens[name]), issuer);
  function review(command: 'repository.contract.import' | 'repository.contract.attach', input: any) {
    const result = service('release-manager').review(command, input); reviews.set(command + ':' + digest(input), result); return result;
  }
  const importContract = (revision = 1, rules: any[] = []) => {
    const previous = service().execute('repository.compatibility', {}).context?.contract.ref ?? null;
    const input = { record: record(revision, rules), previous }; review('repository.contract.import', input);
    return service().execute('repository.contract.import', input);
  };
  return { ...f, issuer, tokens, policy, scope, reviews, service, review, importContract, releaseRef };
}
async function indexFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const state = path.join(f.root, 'state'); const release = await bindNodeState(state, f.issuer.projectId, BLOCK_MODEL); await release();
  await mkdir(path.join(state, 'artifacts')); const entries: Record<string, any> = {};
  for (const [ref, r] of Object.entries(f.engine.records)) { const bytes = canonical(r.data), hash = bytesDigest(bytes); await writeFile(path.join(state, 'artifacts', hash + '.json'), bytes); entries[ref] = { hash, type: r.type, published: r.published }; }
  await writeFile(path.join(state, 'registry.json'), canonical({ entries, heads: f.engine.ownerHeads, requests: {}, commit_audit: [] }));
  return state;
}
async function indexedRecords(state: string): Promise<Records> {
  const registry = JSON.parse(await readFile(path.join(state, 'registry.json'), 'utf8')); const records: Records = {};
  for (const [ref, e] of Object.entries(registry.entries) as [string, any][]) records[ref] = { type: e.type, published: e.published, data: JSON.parse(await readFile(path.join(state, 'artifacts', e.hash + '.json'), 'utf8')) };
  return records;
}

test('profile persistence requires exact authorized review and saves immutable revisions/CAS without runtime grants', async () => {
  const f = await fixture(), service = f.service();
  const input = { record: record(), previous: null }, before = canonical(f.engine.records);
  assert.throws(() => service.execute('repository.contract.import', input), code('BUILD_REVIEW_REQUIRED')); assert.equal(canonical(f.engine.records), before);
  assert.throws(() => f.service().review('repository.contract.import', input), code('AUTHORITY_FORBIDDEN'));
  const contract = f.importContract(), p = profile(contract), saved = service.execute('profile.create', p);
  assert.equal(saved.report.materialization_supported, null); assert.equal(saved.report.runnable_here, null);
  assert(!f.issuer.resolve(f.tokens['author-a']).allowed_operations.includes('build.start'));
  assert.throws(() => service.execute('profile.create', p), code('BUILD_PROFILE_EXISTS'));
  const oldBytes = canonical(saved.record), newer = profile(contract, 2, 'Renamed');
  const revised = service.execute('profile.revise', { previous: saved.ref, ...newer });
  assert.equal(canonical(f.engine.read(saved.ref)), oldBytes); assert.equal(revised.record.previous.ref, saved.ref); assert.equal(revised.record.derived_from.ref, saved.ref);
  assert.throws(() => service.execute('profile.revise', { previous: saved.ref, ...profile(contract, 3) }), code('STALE_REVISION'));
  assert.throws(() => service.execute('profile.create', { ...profile(contract, 1, 'Other', 'Other'), expected_normalized_sha256: 'f'.repeat(64) }), code('BUILD_PROFILE_DIGEST_MISMATCH'));
  assert.throws(() => service.execute('profile.create', { ...profile(contract, 1, 'Python', 'Python'), record: { ...p.record, id: 'Python', choices: { ...choices, language: 'python' } }, expected_normalized_sha256: digest({ ...p.record, id: 'Python', choices: { ...choices, language: 'python' } }) }), code('BUILD_PROFILE_INVALID'));
  assert.throws(() => f.service('reader').execute('profile.create', profile(contract, 1, 'Denied', 'Denied')), code('OPERATION_FORBIDDEN'));
  assert.throws(() => f.service('author-a', { repository_id: 'unassigned' }).execute('profile.inspect', { ref: saved.ref }), code('REPOSITORY_FORBIDDEN'));
  assert.throws(() => f.service('author-a', { repository_id: 'other' }).execute('profile.inspect', { ref: saved.ref }), code('BUILD_SOURCE_UNAVAILABLE'));
  assert.throws(() => f.service('author-a', { visible: ref => ref !== contract.ref }).execute('repository.compatibility', {}), code('BUILD_SOURCE_UNAVAILABLE'));
  service.execute('profile.archive', { ref: revised.ref }); assert.equal(service.execute('profile.list', {}).profiles.length, 0);
  assert.equal(service.execute('profile.inspect', { ref: saved.ref }).ref, saved.ref);
  assert.throws(() => service.execute('profile.revise', { previous: revised.ref, ...profile(contract, 3) }), code('BUILD_PROFILE_ARCHIVED'));
  verifyBuildHistory(f.engine.records, f.issuer.projectId); validateRecords(f.engine.records, f.issuer.projectId, BLOCK_MODEL);
});

test('contract head changes do not bind old Releases; first adoption remains separate and raw materialize cannot bypass it', async () => {
  const f = await fixture(true), service = f.service(), release = f.releaseRef!, bytes = canonical(f.engine.read(release));
  const old = f.importContract(); service.execute('profile.create', profile(old));
  const storedProfile = service.execute('profile.list', {}).profiles[0];
  assert.equal((await service.compatibility(release)).contract_binding, 'missing');
  const c = f.importContract(2, [{ id: 'python', field: 'language', allowed: ['python'], rationale: 'Explicit test policy.' }]);
  assert.equal((await service.compatibility()).context!.contract.ref, c.ref);
  assert.equal(service.execute('profile.validate', { record: profile(old).record }).report.repository_valid, false);
  assert.equal(service.execute('profile.inspect', { ref: storedProfile.ref }).report.repository_valid, false);
  assert.deepEqual(Object.keys(await service.profile(storedProfile.ref)).sort(), ['record', 'ref', 'sha256']);
  assert.equal((await service.compatibility(release)).contract_binding, 'missing');
  const priorOutput = f.engine.realize(release, 'collection-host/1');
  const attach = { release_ref: release, contract_ref: c.ref, expected_release_sha256: digest(f.engine.read(release)) };
  f.review('repository.contract.attach', attach); const binding = service.execute('repository.contract.attach', attach);
  assert.equal(binding.record.provenance, 'post_publication_adoption'); assert.equal(canonical(f.engine.read(release)), bytes);
  assert.equal((await service.compatibility(release)).context!.contract.ref, c.ref);
  assert.throws(() => f.engine.realize(release, 'collection-host/1'), code('BUILD_CHOICE_FORBIDDEN'));
  assert.throws(() => new Engine(f.engine.records, {}, { projectId: f.issuer.projectId, historical: true }).realize(release, 'collection-host/1'), code('BUILD_CHOICE_FORBIDDEN'));
  assert.throws(() => f.engine.registerRealization(priorOutput), code('BUILD_CHOICE_FORBIDDEN'));
  assert.throws(() => service.execute('repository.contract.attach', { ...attach, contract_ref: old.ref }), code('BUILD_BINDING_CONFLICT'));
  assert.throws(() => service.execute('repository.contract.attach', { ...attach, expected_release_sha256: 'f'.repeat(64) }), code('BUILD_PIN_MISMATCH'));
  assert.throws(() => service.execute('repository.contract.attach', { ...attach, release_ref: 'HostCollectionBaseline@1' }), code('BUILD_BOOTSTRAP_EXCLUDED'));
  assert.equal(inspectReleasePublication({ records: f.engine.records, project_id: f.issuer.projectId, source_trust: 'local-fixture' }, release).state, 'approved');
});

test('existing Node registry survives restart, competing head updates, response loss and current-authority replay', async () => {
  const f = await fixture(), state = await indexFixture(f); let fault: 'after-stage' | 'after-commit' | undefined;
  let repository = await openProfileRepository(state, f.issuer, f.scope, { faultForTest: () => fault });
  const ctx = () => f.issuer.resolve(f.tokens['author-a']), reviewContext = () => f.issuer.resolve(f.tokens['release-manager']);
  const input = { record: record(), previous: null };
  const review = await repository.execute('repository.contract.import', input, reviewContext(), { key: 'review-contract', review: true }); f.reviews.set('repository.contract.import:' + digest(input), review.data);
  const imported = await repository.execute('repository.contract.import', input, ctx(), { key: 'import-contract' });
  const p = profile(imported.data), before = await readFile(path.join(state, 'registry.json'), 'utf8');
  fault = 'after-stage'; await assert.rejects(repository.execute('profile.create', p, ctx(), { key: 'create' }), code('INJECTED_STAGE_FAILURE'));
  assert.equal(await readFile(path.join(state, 'registry.json'), 'utf8'), before);
  fault = 'after-commit'; await assert.rejects(repository.execute('profile.create', p, ctx(), { key: 'create' }), code('INJECTED_RESPONSE_LOSS'));
  fault = undefined; await repository.close(); repository = await openProfileRepository(state, f.issuer, f.scope);
  try {
    const replay = await repository.execute('profile.create', p, ctx(), { key: 'create' }); assert.equal(replay.reused, true);
    assert.equal((await repository.execute('profile.inspect', { ref: replay.data.ref }, ctx())).data.record.name, 'Local preview');
    await assert.rejects(repository.execute('profile.create', profile(imported.data, 1, 'Different'), ctx(), { key: 'create' }), code('IDEMPOTENCY_CONFLICT'));
    const revised = { previous: replay.data.ref, ...profile(imported.data, 2, 'Revised') };
    const results = await Promise.allSettled([repository.execute('profile.revise', revised, ctx(), { key: 'revise-a' }), repository.execute('profile.revise', revised, ctx(), { key: 'revise-b' })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'STALE_REVISION');
    await assert.rejects(repository.execute('profile.create', profile(imported.data, 1, 'New', 'New'), ctx(), { key: 'stale', expected_generation: 'f'.repeat(64) }), code('STALE_GENERATION'));
    // A cached successful request must not revive revoked authority.
    const changed = structuredClone(f.policy); changed.generation++; changed.grants.find((g: any) => g.principal_id === 'author-a').operations = [...PROFILE_READS];
    f.issuer.reload(f.accounts, changed);
    await assert.rejects(repository.execute('profile.create', p, ctx(), { key: 'create' }), code('OPERATION_FORBIDDEN'));
  } finally { await repository.close(); }
});

test('v0.3 host publication and supporting closure backup/restore preserves bytes with inactive authority', async () => {
  const f = await fixture(true), contract = f.importContract(), service = f.service(), p = service.execute('profile.create', profile(contract));
  service.execute('profile.revise', { previous: p.ref, ...profile(contract, 2, 'New name') });
  const restrictive = f.importContract(2, [{ id: 'python', field: 'language', allowed: ['python'], rationale: 'Recovery test restriction.' }]);
  const attach = { release_ref: f.releaseRef!, contract_ref: restrictive.ref, expected_release_sha256: digest(f.engine.read(f.releaseRef!)) };
  f.review('repository.contract.attach', attach); service.execute('repository.contract.attach', attach);
  const state = await indexFixture(f), bundle = path.join(f.root, 'bundle'), restored = path.join(f.root, 'restored');
  const backup = await createBackup({ state, out: bundle, project: f.issuer.projectId, selector: 'fixture-backup', maxBytes: 8 * 1024 ** 2 });
  assert.equal(backup.format, BUILD_BACKUP_FORMAT);
  const checked = await verifyBackup({ bundle, project: f.issuer.projectId, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  assert.equal(checked.authors_authenticated, false); assert.equal(checked.inactive, true);
  await restoreBackup({ bundle, out: restored, project: f.issuer.projectId, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  assert.equal(JSON.parse(await readFile(path.join(restored, INACTIVE_MARKER), 'utf8')).identities_active, false);
  const checkpoint = JSON.parse(await readFile(path.join(restored, 'checkpoint.json'), 'utf8'));
  for (const [ref, r] of Object.entries(f.engine.records)) assert.equal(await readFile(path.join(restored, 'artifacts', checkpoint.entries[ref].hash + '.json'), 'utf8'), canonical(r.data));
  await assert.rejects(openProfileRepository(restored, f.issuer, f.scope), code('RECOVERY_INACTIVE'));
  const broken = structuredClone(f.engine.records); delete broken[Object.keys(broken).find(ref => broken[ref].type === 'build-contract-review')!];
  assert.throws(() => verifyBuildHistory(broken, f.issuer.projectId), code('BUILD_PIN_MISMATCH'));
  const records = await indexedRecords(state); assert.equal(canonical(records), canonical(f.engine.records));
});

test('old host policies never acquire new repository authority and foreign/forged supporting histories refuse', async () => {
  const f = await fixture(), original = new HostIssuer(f.accounts, { ...f.policy, format: 'strata-host-policy/1', generation: 1, grants: f.policy.grants.map((g: any) => {
    const { lifetime, build_repository_ids, ...rest } = g; return { ...rest, operations: rest.operations.filter((op: any) => !PROFILE_OPERATIONS.includes(op)), expires_at: lifetime.expires_at };
  }) });
  const token = original.login('author-a', f.keys['author-a']);
  assert.throws(() => new BuildProfileService(f.engine, f.scope, original.resolve(token), original).execute('profile.list', {}), code('OPERATION_FORBIDDEN'));
  const c = f.importContract(), p = f.service().execute('profile.create', profile(c)), changed = structuredClone(f.engine.records);
  const d = structuredClone(changed[p.ref].data); d.contract_sha256 = 'f'.repeat(64); delete changed[p.ref]; changed['build-profile@' + digest(d)] = { type: 'build-profile', data: d, published: true };
  assert.throws(() => verifyBuildHistory(changed, f.issuer.projectId), code('BUILD_PIN_MISMATCH'));
  assert.throws(() => f.service().execute('profile.create', { ...profile(c, 1, 'Malformed', 'Malformed'), record: { ...profile(c).record, script: 'forbidden' } }), code('INVALID_RECORD'));
});

test('current authority changes between staging and registry publication leave the prior registry intact', async () => {
  const f = await fixture(), contract = f.importContract(), state = await indexFixture(f);
  const before = await readFile(path.join(state, 'registry.json'), 'utf8');
  const repository = await openProfileRepository(state, f.issuer, f.scope, { beforeCommit: async () => {
    const changed = structuredClone(f.policy); changed.generation++;
    changed.grants.find((g: any) => g.principal_id === 'author-a').build_repository_ids = [];
    f.issuer.reload(f.accounts, changed);
  } });
  try { await assert.rejects(repository.execute('profile.create', profile(contract), f.issuer.resolve(f.tokens['author-a']), { key: 'late-revocation' }), code('STALE_POLICY')); }
  finally { await repository.close(); }
  assert.equal(await readFile(path.join(state, 'registry.json'), 'utf8'), before);
  assert.equal(Object.values(await indexedRecords(state)).filter(r => r.type === 'build-profile').length, 0);
});

test('synthetic operation receipts retain fixture trust and list paging/status never relabels exact history', async () => {
  const f = await fixture();
  const issuer = new FixtureIssuer({ project_id: f.issuer.projectId, assignments: {
    'synthetic-author': { principal: 'synthetic-author', operations: [...PROFILE_OPERATIONS], repositories: ['demo'] },
    'synthetic-reviewer': { principal: 'release-manager', operations: [...PROFILE_OPERATIONS], repositories: ['demo'], approvals: ['release'] }
  } });
  const service = new BuildProfileService(f.engine, f.scope, issuer.resolve('synthetic-author'), issuer);
  const reviewer = new BuildProfileService(f.engine, f.scope, issuer.resolve('synthetic-reviewer'), issuer);
  const input = { record: record(), previous: null }, reviewed = reviewer.review('repository.contract.import', input);
  f.reviews.set('repository.contract.import:' + digest(input), reviewed);
  const c = service.execute('repository.contract.import', input);
  assert.equal(f.engine.read(c.record.auth_receipt.ref).trust, 'local-fixture');
  const a = service.execute('profile.create', profile(c)), b = service.execute('profile.create', profile(c, 1, 'Second', 'Second'));
  const page = service.execute('profile.list', { limit: 1 }); assert.equal(page.profiles.length, 1); assert(page.cursor);
  const next = service.execute('profile.list', { limit: 1, cursor: page.cursor });
  assert.equal(next.profiles.length, 1); assert.equal(next.cursor, null); assert.notEqual(page.profiles[0].ref, next.profiles[0].ref);
  assert.equal(next.profiles[0].report.runnable_here, null);
  const changed = service.execute('profile.revise', { previous: a.ref, ...profile(c, 2, 'Renamed') });
  assert.equal(f.engine.read(b.ref).name, 'Second'); assert.notEqual(changed.ref, a.ref);
});

test('host backup refuses well-hashed missing measured publication closure before producing a complete archive', async () => {
  const f = await fixture(true), c = f.importContract(), attach = { release_ref: f.releaseRef!, contract_ref: c.ref, expected_release_sha256: digest(f.engine.read(f.releaseRef!)) };
  f.review('repository.contract.attach', attach); f.service().execute('repository.contract.attach', attach);
  const state = await indexFixture(f), filename = path.join(state, 'registry.json'), registry = JSON.parse(await readFile(filename, 'utf8'));
  const runRef = Object.keys(f.engine.records).find(ref => f.engine.records[ref].type === 'host-run')!; delete registry.entries[runRef];
  await writeFile(filename, canonical(registry));
  await assert.rejects(createBackup({ state, out: path.join(f.root, 'invalid-bundle'), project: f.issuer.projectId, selector: 'fixture-backup', maxBytes: 8 * 1024 ** 2 }), code('BACKUP_INVALID'));
});

test('contract revision review cannot be replayed for different bytes and raw input byte bounds refuse before admission', async () => {
  const f = await fixture(), c = f.importContract();
  const input = { record: record(2), previous: c.ref }; f.review('repository.contract.import', input);
  assert.throws(() => f.service().execute('repository.contract.import', { ...input, record: { ...input.record, preferences: [{ field: 'language', value: 'python', rationale: 'Changed after review.' }] } }), code('BUILD_REVIEW_REQUIRED'));
  const oversized = { record: record(2, Array.from({ length: 32 }, (_, i) => ({ id: 'r' + i, field: 'language', allowed: ['javascript'], rationale: 'x'.repeat(4096) }))), previous: c.ref };
  assert.throws(() => f.service().execute('repository.contract.import', oversized), code('BUILD_CONTRACT_LIMIT'));
  assert.throws(() => f.service().execute('profile.list', { limit: 101 }), code('INVALID_RECORD'));
});

for (const stage of ['open', 'writeFile', 'sync', 'close'] as const) for (const retryKey of ['original', 'new'] as const) {
  test(`temporary index ${stage} failure permits ${retryKey} key retry after reopen without publishing partial state`, async () => {
    const f = await fixture(), contract = f.importContract(), state = await indexFixture(f);
    const before = await readFile(path.join(state, 'registry.json'), 'utf8'), input = profile(contract);
    const context = () => f.issuer.resolve(f.tokens['author-a']);
    let repository = await openProfileRepository(state, f.issuer, f.scope), injected = false;
    const nativeOpen = fsp.open;
    mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
      const temporary = String(args[0]).includes('registry-profile-') && args[1] === 'wx';
      if (temporary && stage === 'open') { injected = true; throw Object.assign(new Error('Synthetic temporary open failure'), { code: 'EIO' }); }
      const handle = await nativeOpen(...args);
      if (temporary && stage !== 'open') {
        const writePartial = handle.writeFile.bind(handle), close = handle.close.bind(handle);
        mock.method(handle, stage, async () => {
          injected = true;
          if (stage === 'writeFile') await writePartial('partial uncommitted index');
          if (stage === 'close') await close();
          throw Object.assign(new Error('Synthetic temporary ' + stage + ' failure'), { code: 'EIO' });
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try { await assert.rejects(repository.execute('profile.create', input, context(), { key: 'failed-save' }), code('EIO')); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); await repository.close(); }
    assert(injected); assert.equal(await readFile(path.join(state, 'registry.json'), 'utf8'), before);
    assert.deepEqual((await readdir(state)).filter(name => name.startsWith('registry-profile-')), []);
    const uncommitted = JSON.parse(before); assert.equal(Object.keys(uncommitted.requests).length, 0);
    repository = await openProfileRepository(state, f.issuer, f.scope);
    try {
      const key = retryKey === 'original' ? 'failed-save' : 'retry-save';
      const retried = await repository.execute('profile.create', input, context(), { key });
      assert.equal(retried.ok, true); assert.equal(retried.data.sha256, digest(retried.data.record));
      assert.equal((await repository.execute('profile.create', input, context(), { key })).reused, true);
      const committed = JSON.parse(await readFile(path.join(state, 'registry.json'), 'utf8'));
      assert.equal(Object.keys(committed.requests).length, 1); assert.equal(Object.values(await indexedRecords(state)).filter(r => r.type === 'build-profile').length, 1);
      assert.equal(committed.entries[contract.ref].hash, uncommitted.entries[contract.ref].hash);
    } finally { await repository.close(); }
  });
}

test('reopened repository uses a fresh exclusive stage instead of legacy or interrupted uncommitted snapshots', async () => {
  const f = await fixture(), contract = f.importContract(), state = await indexFixture(f), input = profile(contract);
  const context = f.issuer.resolve(f.tokens['author-a']), before = await readFile(path.join(state, 'registry.json'), 'utf8');
  const request = digest({ command: 'profile.create', input, principal: context.principal_id }).slice(0, 24);
  // Simulate stages left after process interruption and explicit lease reconciliation.
  const legacy = 'registry-profile-' + request + '.tmp';
  const interrupted = 'registry-profile-' + request + '-00000000-0000-4000-8000-000000000000.tmp';
  const poisoned = canonical({ ...JSON.parse(before), entries: {}, requests: { abandoned: { digest: '0'.repeat(64), result: { ok: true } } } });
  for (const name of [legacy, interrupted]) await writeFile(path.join(state, name), poisoned);
  let freshStage = '';
  const repository = await openProfileRepository(state, f.issuer, f.scope, { beforeCommit: async () => {
    assert.equal(await readFile(path.join(state, 'registry.json'), 'utf8'), before);
    const stages = (await readdir(state)).filter(name => name.startsWith('registry-profile-') && ![legacy, interrupted].includes(name));
    assert.equal(stages.length, 1); freshStage = stages[0];
  } });
  let saved: any;
  try {
    saved = await repository.execute('profile.create', input, context, { key: 'interrupted-save' });
    assert.equal(saved.ok, true); assert.notEqual(freshStage, legacy); assert.notEqual(freshStage, interrupted);
    assert.equal((await repository.execute('profile.create', input, context, { key: 'interrupted-save' })).reused, true);
  } finally { await repository.close(); }
  const committed = JSON.parse(await readFile(path.join(state, 'registry.json'), 'utf8'));
  assert.equal(committed.entries[contract.ref].hash, JSON.parse(before).entries[contract.ref].hash);
  assert.equal(committed.requests.abandoned, undefined); assert(committed.entries[saved.data.ref]);
  for (const name of [legacy, interrupted]) assert.equal(await readFile(path.join(state, name), 'utf8'), poisoned);
  assert.deepEqual((await readdir(state)).filter(name => name.startsWith('registry-profile-')).sort(), [legacy, interrupted].sort());
});

test('review and mutation expected-policy errors have identical taxonomy and policy-first precedence', async () => {
  const f = await fixture(), state = await indexFixture(f), before = await readFile(path.join(state, 'registry.json'), 'utf8');
  const repository = await openProfileRepository(state, f.issuer, f.scope), context = f.issuer.resolve(f.tokens['release-manager']);
  const input = { record: record(), previous: null };
  try {
    for (const [index, stale] of [
      { expected_policy: 'outdated', code: 'STALE_POLICY' },
      { expected_generation: 'outdated', code: 'STALE_GENERATION' },
      { expected_policy: 'outdated', expected_generation: 'outdated', code: 'STALE_POLICY' }
    ].entries()) {
      const { code: expected, ...guards } = stale;
      for (const review of [false, true]) await assert.rejects(repository.execute('repository.contract.import', input, context, { ...guards, key: 'stale-' + index + '-' + review, review }), code(expected));
    }
  } finally { await repository.close(); }
  assert.equal(await readFile(path.join(state, 'registry.json'), 'utf8'), before);
});

test('unsupported-choice validation and save refusal retain identical normalized digest/report without writing history', async () => {
  const f = await fixture(), contract = f.importContract(), service = f.service(), input = profile(contract);
  input.record.choices.language = 'python'; input.expected_normalized_sha256 = digest(input.record);
  const before = canonical(f.engine.records), validated = service.execute('profile.validate', { record: input.record });
  assert.equal(validated.report.normalized_sha256, input.expected_normalized_sha256);
  assert(validated.report.checks.some((c: any) => c.category === 'materializer' && c.state === 'unsupported'));
  assert.throws(() => service.execute('profile.create', input), (error: any) => error.code === 'BUILD_PROFILE_INVALID' && canonical(error.details) === canonical(validated.report));
  assert.equal(canonical(f.engine.records), before);
});
