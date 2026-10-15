import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonical, digest, StrataError, type Records } from '../src/model.js';
import { Engine } from '../src/core.js';
import { profiles, profileFor } from '../src/profiles.js';
import { describeBuildOptions } from '../src/build-options.js';
import { resolveBuildProfile, checkRepositoryChoices, assertRepositoryChoices, type ContractContext } from '../src/build-compatibility.js';
import { BUILD_DESTINATION_KINDS, buildSupportingRef, buildProfileInputSchema, compatibilityReportSchema, normalizeRepositoryContract, releaseBuildBindingSchema, buildSelectionSchema } from '../src/build-contracts.js';
import { inspectReleasePublication } from '../src/build-publication.js';
import { hostCollectionFixture } from './collection-host-fixture.js';
import { runNodeCommand } from '../src/commands/node.js';
import { hostRunner } from '../src/auth/runner.js';

const code = (wanted: string) => (e: any) => e.code === wanted;
const pin = (ref: string) => ({ ref, sha256: 'a'.repeat(64) });
function context(rules: any[] = [], preferences: any[] = []): ContractContext {
  const record = { ...normalizeRepositoryContract({ format: 'strata-repository-compatibility/1', id: 'Compatibility', revision: 1, rules, preferences }),
    project_id: 'synthetic-collection-host', repository_id: 'demo', previous: null, author: 'contract-author', auth_receipt: pin('auth-receipt@aa'), review: pin('contract-review@bb') };
  return { project_id: record.project_id, repository_id: record.repository_id, contract: { ref: buildSupportingRef(record), sha256: digest(record), record } };
}
const choices = { language: 'javascript', framework: 'none', runtime: 'node' };
function profile(c: ContractContext) { return { id: 'LocalPreview', revision: 1, name: 'Local preview', contract_ref: c.contract.ref, contract_sha256: c.contract.sha256, choices,
  materializer: { id: 'collection-host/1', archive_sha256: digest(profileFor('collection-host/1').archive()) } }; }

test('strict V1 choices refuse authority, executable and connection fields; ordered text remains exact', () => {
  const input = { format: 'strata-repository-compatibility/1', id: 'Compatibility', revision: 1, rules: [{ id: 'languages', field: 'language', allowed: ['python', 'javascript'], rationale: '  Deliberate choice.  ' }], preferences: [] };
  const normalized = normalizeRepositoryContract(input);
  assert.deepEqual(normalized.rules[0].allowed, ['javascript', 'python']); assert.equal(normalized.rules[0].rationale, input.rules[0].rationale);
  assert.equal(canonical(input.rules[0].allowed), '["python","javascript"]');
  assert.throws(() => normalizeRepositoryContract({ ...input, rules: [{ ...input.rules[0], allowed: ['python', 'python'] }] }), code('INVALID_RECORD'));
  for (const field of ['operator', 'extractor', 'source', 'auth_receipt', 'runtime_minimum']) assert.throws(() => normalizeRepositoryContract({ ...input, rules: [{ ...input.rules[0], [field]: 'unreviewed' }] }), code('INVALID_RECORD'));
  assert.throws(() => normalizeRepositoryContract({ ...input, format: 'strata-repository-compatibility/2' }), code('INVALID_RECORD'));
  const c = context();
  assert.deepEqual(BUILD_DESTINATION_KINDS, ['local', 'cloudflare-worker']);
  for (const field of ['credentials', 'connection_id', 'path', 'environment', 'script', 'options', 'author', 'format']) assert.equal(buildProfileInputSchema.safeParse({ ...profile(c), [field]: 'forbidden' }).success, false);
  assert.equal(buildSelectionSchema.safeParse({ release_ref: 'Release@1', profile_ref: 'Local@1', destination: { kind: 'server', slot_id: 'out' } }).success, false);
  assert.equal(buildSelectionSchema.safeParse({ release_ref: 'Release@1', profile_ref: 'Local@1', destination: { kind: 'cloudflare-worker', connection_id: 'account' } }).success, false);
  const binding = { format: 'strata-release-build-binding/1', project_id: c.project_id, repository_id: c.repository_id, release: pin('release@aa'), contract: pin(c.contract.ref), provenance: 'post_publication_adoption', author: 'adopter', auth_receipt: pin('auth-receipt@aa'), review: pin('review@aa') };
  assert(releaseBuildBindingSchema.safeParse(binding).success);
  assert(!releaseBuildBindingSchema.safeParse({ ...binding, provenance: 'original_release_approval' }).success);
});

test('hard rules intersect with both source pins; advisory preferences do not impose or override policy', () => {
  const c = context([{ id: 'only-python', field: 'language', allowed: ['python'], rationale: 'Reviewed Python policy.' }, { id: 'only-js', field: 'language', allowed: ['javascript'], rationale: 'Reviewed JS policy.' }], [{ field: 'language', value: 'javascript', rationale: 'Advisory.' }]);
  const checks = checkRepositoryChoices(c, choices), conflict = checks.find(v => v.code === 'BUILD_RULE_CONFLICT')!;
  assert.deepEqual(conflict.sources.map(v => v.item), ['only-python', 'only-js']);
  assert(conflict.sources.every(v => v.ref === c.contract.ref && v.sha256 === c.contract.sha256));
  assert.throws(() => assertRepositoryChoices(c, choices), code('BUILD_RULE_CONFLICT'));
  const noRules = context([], [{ field: 'language', value: 'python', rationale: 'Suggestion only.' }]);
  assert.deepEqual(checkRepositoryChoices(noRules, choices), []);
  const resolved = resolveBuildProfile(noRules, profile(noRules));
  assert.equal(resolved.report.repository_valid, true); assert.equal(resolved.report.materialization_supported, null); assert.equal(resolved.report.runnable_here, null);
  compatibilityReportSchema.parse(resolved.report);
});

test('repository permission, materializer tuple/archive and target support are independent', async () => {
  const c = context(), p = profile(c);
  const python = resolveBuildProfile(c, { ...p, choices: { ...choices, language: 'python' } });
  assert(python.report.repository_valid); assert(python.report.checks.some(v => v.code === 'BUILD_CHOICES_UNSUPPORTED'));
  assert(resolveBuildProfile(c, { ...p, materializer: { ...p.materializer, archive_sha256: 'f'.repeat(64) } }).report.checks.some(v => v.code === 'BUILD_MATERIALIZER_PIN_MISMATCH'));
  assert(resolveBuildProfile(c, { ...p, contract_sha256: 'f'.repeat(64) }).report.checks.some(v => v.code === 'BUILD_CONTRACT_PIN_MISMATCH'));
  assert(resolveBuildProfile(c, { ...p, materializer: { ...p.materializer, id: 'counter-host/1' } }).report.checks.some(v => v.code === 'UNSUPPORTED_BUILD_OPTIONS'));
  assert.throws(() => resolveBuildProfile({ ...c, repository_id: 'other' }, p), code('BUILD_REPOSITORY_MISMATCH'));
  assert.throws(() => resolveBuildProfile({ ...c, contract: { ...c.contract, sha256: 'f'.repeat(64) } }, p), code('BUILD_CONTRACT_PIN_MISMATCH'));
  assert.throws(() => resolveBuildProfile({ ...c, contract: { ...c.contract, ref: 'Compatibility@1' } }, p), code('BUILD_CONTRACT_PIN_MISMATCH'));
  const unknown = structuredClone(c);
  (unknown.contract.record as any).rules = [{ id: 'new-rule', field: 'language', allowed: ['javascript'], rationale: 'Must not be silently ignored.', operator: 'future-operator' }];
  unknown.contract.sha256 = digest(unknown.contract.record); unknown.contract.ref = buildSupportingRef(unknown.contract.record);
  const unprocessed = resolveBuildProfile(unknown, p).report;
  assert.equal(unprocessed.repository_valid, false); assert.equal(unprocessed.checks[0].state, 'unsupported');
  assert.equal(unprocessed.checks[0].sources[0].ref, unknown.contract.ref); assert.equal(unprocessed.checks[0].sources[0].sha256, unknown.contract.sha256);
  const f = await hostCollectionFixture('build-support');
  const target = f.call('author-a', 'compose', { record: { ...f.recipe, id: 'BuildSupport', proposals: [], selected: [] } }).ref;
  const before = canonical(f.engine.records), r = resolveBuildProfile(c, p, { engine: f.engine, ref: target });
  assert.equal(r.report.materialization_supported, true); assert.equal(r.report.target_sha256, digest(f.engine.read(target))); assert.equal(r.report.runnable_here, null); assert.equal(canonical(f.engine.records), before);
  // An independent stronger intent survives authoring but the finite materializer refuses it.
  const changed = structuredClone(f.engine.read(target)); changed.id = 'Unsupported';
  const base = structuredClone(f.baseline); base.id = 'PersistentBaseline'; base.blocks.collection.purpose = 'Retain every item after process restart.';
  const raw: Records = { 'PersistentBaseline@1': { type: 'release', data: base, published: true }, 'Unsupported@1': { type: 'composition', data: { ...changed, baseline: 'PersistentBaseline@1' }, published: true } };
  const engine = new Engine(raw, {}, { projectId: c.project_id, modelVersion: base.model_version, historical: true });
  let expected: StrataError | null = null; try { engine.realize('Unsupported@1', 'collection-host/1'); } catch (e) { expected = e as StrataError; }
  const unsupported = resolveBuildProfile(c, p, { engine, ref: 'Unsupported@1' });
  assert(expected); assert.equal(unsupported.report.materialization_supported, false);
  assert.deepEqual(unsupported.support!.materialization, { supported: false, first_blocker: { code: expected.code, exit: expected.exit, message: expected.message, details: expected.details } });
  assert.equal(canonical(raw), canonical(engine.records));
});

test('all historical archives remain literal and the new tuple is metadata only', async () => {
  const old = JSON.parse(await readFile('tests/fixtures/collection-host/historical-profiles.json', 'utf8'));
  for (const [id, sha] of Object.entries(old.profiles)) assert.equal(digest(profileFor(id).archive()), sha);
  const before = profiles.map(p => digest(p.archive())), descriptor = describeBuildOptions(profileFor('collection-host/1'));
  assert.equal(descriptor.archive_sha256, 'dfea54f47996ccd4fa974b7320731ca6deb225481a1fc2dc09e67d32f2599d01');
  assert.deepEqual(descriptor.choices, choices); assert.deepEqual(descriptor.destinations, ['local']); assert.equal(descriptor.run_application, false); assert.equal(descriptor.serve_application, false);
  assert.deepEqual(descriptor.requirements.map(v => [v.stage, v.subject, v.id, v.version]), [['build', 'host', 'node', { min_major: 22 }], ['verify', 'host', 'node', { min_major: 22 }], ['run', 'target', 'node', { min_major: 22 }]]);
  assert.deepEqual(profiles.map(p => digest(p.archive())), before);
});

async function published() {
  const f = await hostCollectionFixture('build-publication');
  f.publish(f.extension);
  const target = f.call('author-a', 'compose', { record: { ...f.recipe, id: 'BuildPublication' } }).ref;
  const materialized = await runNodeCommand(f.root, (c, i) => f.call('runner', c, i), 'materialize', { target, profile: 'collection-host/1', out: '.strata/generated' });
  const realization = f.engine.read(materialized.ref), request = { target, slot: 'generated', profile: 'collection-host/1' };
  f.call('runner', 'evidence.run', request);
  const run = await hostRunner(f.root, { generated: '.strata/generated' }, ['collection-host/1'])(f.engine, request, f.issuer.resolve(f.tokens.runner));
  const reviews = realization.oracle.criteria.filter((c: any) => c.method === 'review').map((criterion: any) => f.call('reviewer', 'criterion.review', { realization: materialized.ref, criterion, accepted: true, rationale: 'Reviewed finite synthetic source.' }).ref);
  const evidence = f.call('runner', 'evidence.assemble', { realization: materialized.ref, run_ref: run.ref, review_refs: reviews }).evidence;
  const validation = f.call('runner', 'validate', { target, realization: materialized.ref, evidence });
  const evaluation = f.engine.target(target), shape = { format: 'approval/3', project_id: f.issuer.projectId, model_version: f.baseline.model_version, baseline: 'HostCollectionBaseline@1', authority_sha256: digest(f.baseline.authorities), target: evaluation.fingerprint, evidence_digest: validation.evidence_digest, generation: f.engine.mediation!.generation(), expires_at: null, binding: null };
  const scope = f.call('scope-selector', 'approve', { record: { ...shape, kind: 'scope', scope: evaluation.scope } });
  const approval = f.call('release-manager', 'approve', { record: { ...shape, kind: 'release', scope: null } });
  const release = f.call('release-manager', 'release', { target, validation: validation.ref, approvals: [scope.ref, approval.ref] });
  return { ...f, target, release, validation, scope, approval, run, reviews };
}

test('historical approved Release follows original Composition, preserves trust and does not refresh authority', async () => {
  const f = await published(), before = canonical(f.engine.records);
  const ctx = { project_id: f.issuer.projectId, records: f.engine.records, source_trust: 'local-fixture' as const };
  assert.equal(inspectReleasePublication(ctx, 'HostCollectionBaseline@1').code, 'BUILD_BOOTSTRAP_EXCLUDED');
  assert.equal(inspectReleasePublication(ctx, f.target).code, 'BUILD_RELEASE_REQUIRED');
  const report = inspectReleasePublication(ctx, f.release.ref);
  assert.equal(report.state, 'approved'); assert.equal(report.composition!.ref, f.target); assert.equal(report.validation!.ref, f.validation.ref);
  assert.equal(report.release!.sha256, digest(f.engine.read(f.release.ref))); assert.equal(report.execution_authorized, null);
  assert.equal(report.record_trust, 'host-authenticated'); assert.equal(report.source_trust, 'local-fixture');
  f.advance();
  assert.equal(inspectReleasePublication(ctx, f.release.ref).state, 'approved'); assert.equal(canonical(f.engine.records), before);
  const hidden = inspectReleasePublication({ ...ctx, visible: ref => ref !== f.approval.ref }, f.release.ref);
  assert.equal(hidden.state, 'unavailable'); assert.deepEqual(hidden.closure, []); assert.equal(hidden.release, null);
  assert.equal(inspectReleasePublication({ ...ctx, project_id: 'different' }, f.release.ref).state, 'corrupt');
  const wrongAction = structuredClone(f.engine.records);
  const review = Object.values(wrongAction).find(r => r.type === 'authoring-review')!;
  review.data.auth_receipt = f.engine.read(f.reviews[0]).auth_receipt;
  const reviewRef = 'authoring-review@' + digest(review.data);
  for (const [ref, r] of Object.entries(wrongAction)) if (r.type === 'authoring-review') delete wrongAction[ref];
  wrongAction[reviewRef] = review;
  assert.equal(inspectReleasePublication({ ...ctx, records: wrongAction }, f.release.ref).state, 'corrupt');
});

test('forged state, broken identity/closure and missing publication approvals cannot enter Build', async () => {
  const f = await published();
  for (const mutate of [
    (r: Records) => { delete r[f.approval.ref]; },
    (r: Records) => { delete r[f.run.ref]; },
    (r: Records) => { for (const [ref, record] of Object.entries(r)) if (record.type === 'authoring-review') delete r[ref]; },
    (r: Records) => { r[f.release.ref].data.acceptance_manifest = []; },
    (r: Records) => { r[f.release.ref].data.provenance = { fabricated: [] }; },
    (r: Records) => { r[f.validation.ref].data.evidence.results[0].passed = false; }
  ]) { const records = structuredClone(f.engine.records); mutate(records); assert.equal(inspectReleasePublication({ project_id: f.issuer.projectId, records, source_trust: 'local-fixture' }, f.release.ref).state, 'corrupt'); }
  // Rehashing does not repair missing Release approval or obligation conservation.
  for (const mutate of [(d: any) => { d.approvals = [f.scope.ref]; }, (d: any) => { d.acceptance_manifest = []; }, (d: any) => { d.state = 'validated'; d.validation = 'validation@missing'; }]) {
    const records = structuredClone(f.engine.records), data = structuredClone(records[f.release.ref].data); mutate(data);
    const ref = 'release@' + digest(data).slice(0, 24); records[ref] = { type: 'release', data, published: true };
    assert.equal(inspectReleasePublication({ project_id: f.issuer.projectId, records, source_trust: 'local-fixture' }, ref).state, 'corrupt');
  }
});
