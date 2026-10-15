import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BLOCK_MODEL, CONTENT_MODEL, MODEL, canonical, digest, parseLayer } from '../src/model.js';
import { hostRunner } from '../src/auth/runner.js';
import { hostCollectionProfile } from '../src/profiles/collection-host.js';
import { runNodeCommand } from '../src/commands/node.js';
import { validateRecords } from '../src/explorer/validate.js';
import { hostCollectionFixture } from './collection-host-fixture.js';
import { loadCompiledOutput } from './profile-conformance-harness.test.js';

type Fixture = Awaited<ReturnType<typeof hostCollectionFixture>>;
const receipts: any[] = [];
const profile = 'collection-host/1';
const code = (wanted: string) => (error: any) => error.code === wanted;
async function measure(f: Fixture, target: string, slot: string) {
  const out = '.strata/' + slot;
  const materialized = await runNodeCommand(f.root, (c, i) => f.call('runner', c, i), 'materialize', { target, profile, out });
  const record = f.engine.read(materialized.ref, 'realization');
  const request = { target, slot, profile };
  f.call('runner', 'evidence.run', request);
  const measured = await hostRunner(f.root, { [slot]: out }, [profile])(f.engine, request, f.issuer.resolve(f.tokens.runner));
  assert.equal(measured.checks_passed, true); assert.equal(measured.review_pending, true);
  assert(measured.run.results.every((r: any) => r.check !== 'intent.review'));
  return { materialized, record, measured, request, out };
}
function attest(f: Fixture, observed: Awaited<ReturnType<typeof measure>>) {
  return observed.record.oracle.criteria.filter((c: any) => c.method === 'review').map((criterion: any) => f.call('reviewer', 'criterion.review', { realization: observed.materialized.ref, criterion, accepted: true, rationale: 'Reviewed exact finite synthetic collection criterion.' }).ref);
}
function validate(f: Fixture, target: string, observed: Awaited<ReturnType<typeof measure>>, reviews = attest(f, observed)) {
  const assembled = f.call('runner', 'evidence.assemble', { realization: observed.materialized.ref, run_ref: observed.measured.ref, review_refs: reviews });
  assert.equal(assembled.validated, false);
  const validation = f.call('runner', 'validate', { target, realization: observed.materialized.ref, evidence: assembled.evidence });
  assert.equal(validation.approvals_pending, true); assert.equal(validation.state, 'eligible_for_validation');
  return { assembled, validation, reviews };
}
function approvals(f: Fixture, target: string, validation: any) {
  const composition = f.engine.read(target, 'composition'), candidate = f.engine.target(target), baseline = f.engine.read(composition.baseline, 'release');
  const shape = { format: 'approval/3', project_id: f.issuer.projectId, model_version: BLOCK_MODEL, baseline: composition.baseline, authority_sha256: digest(baseline.authorities), target: candidate.fingerprint, evidence_digest: validation.evidence_digest, generation: f.engine.mediation!.generation(), expires_at: null, binding: null };
  const scope = f.call('scope-selector', 'approve', { record: { ...shape, kind: 'scope', scope: candidate.scope } });
  const guardian = f.call('safety-guardian', 'approve', { record: { ...shape, kind: 'guardian', scope: 'policy/requirements.atomic' } });
  assert.throws(() => f.call('reviewer', 'approve', { record: { ...shape, kind: 'release', scope: null } }));
  assert.throws(() => f.call('release-manager', 'release', { target, validation: validation.ref, approvals: [scope.ref, guardian.ref] }), code('RELEASE_APPROVAL_REQUIRED'));
  const release = f.call('release-manager', 'approve', { record: { ...shape, kind: 'release', scope: null } });
  return [scope.ref, guardian.ref, release.ref];
}
async function accept(f: Fixture, target: string, slot: string, expected: any) {
  const observed = await measure(f, target, slot);
  assert.deepEqual(observed.record.oracle.expected, expected);
  assert.throws(() => validate(f, target, observed, []), code('VALIDATION_INCOMPLETE'));
  const checked = validate(f, target, observed);
  const endorsements = approvals(f, target, checked.validation);
  const released = await runNodeCommand(f.root, (c, i) => f.call('release-manager', c, i), 'release', { target, validation: checked.validation.ref, approvals: endorsements });
  const release = f.engine.read(released.ref, 'release'); assert.equal(release.trust, 'host-authenticated'); assert.equal(release.format, 'release/3');
  assert.equal(release.acceptance_manifest.length, f.engine.target(target).obligations.length);
  const rematerialized = f.engine.realize(released.ref, profile); assert.deepEqual(rematerialized.files, observed.record.files);
  validateRecords(f.engine.records, f.issuer.projectId, BLOCK_MODEL);
  receipts.push({ case: slot, candidate: observed.record.candidate, profile: observed.record.profile, output_tree: observed.record.output_tree, oracle: observed.record.oracle_sha256, checker: observed.record.checker_sha256, fixture: observed.record.fixture_sha256, run: observed.measured.ref, run_trust: observed.measured.run.trust, review_refs: checked.reviews, validation: checked.validation.ref, approvals: endorsements, release: released.ref, release_trust: release.trust, literal_expected: expected });
  return { ...observed, ...checked, endorsements, released, release };
}

test('authenticated baseline and count change use real measured runs, separate criterion review and distinct approvals', async () => {
  const f = await hostCollectionFixture('accepted');
  assert.throws(() => f.issuer.resolve('fixture-a'), code('AUTHENTICATION_REQUIRED'));
  const seedBefore = canonical(f.engine.read('HostCollectionBaseline@1'));
  const first = f.call('author-a', 'compose', { record: { ...f.recipe, id: 'HostBaselineCandidate', proposals: [], selected: [] } });
  const baseline = await accept(f, first.ref, 'baseline', f.expectations.baseline);
  const oldRelease = canonical(f.engine.read(baseline.released.ref));
  f.extension.baseline = baseline.released.ref; f.publish(f.extension);
  const next = f.call('author-a', 'compose', { record: { ...f.recipe, baseline: baseline.released.ref } });
  const changed = await accept(f, next.ref, 'changed', f.expectations.changed);
  assert.equal(changed.release.baseline, baseline.released.ref);
  assert.notEqual(changed.record.oracle_sha256, baseline.record.oracle_sha256); assert.notEqual(changed.record.output_tree, baseline.record.output_tree);
  assert.throws(() => f.call('runner', 'validate', { target: next.ref, realization: changed.materialized.ref, evidence: baseline.assembled.evidence }), code('STALE_EVIDENCE'));
  for (const c of [baseline, changed]) await loadCompiledOutput(c.record, module => { const app = module.createCollection(); for (let n = 1; n <= 6; n++) assert.equal(app.add('i' + n, 'a').accepted, n <= c.record.oracle.expected.max_items); });
  assert.equal(canonical(f.engine.read('HostCollectionBaseline@1')), seedBefore); assert.equal(canonical(f.engine.read(baseline.released.ref)), oldRelease);
});

test('real v0.3 audit Block creation, duplicate-ID collision and authenticated whole-Layer selection conserve old Releases', async () => {
  const f = await hostCollectionFixture('audit');
  const seedBefore = canonical(f.engine.read('HostCollectionBaseline@1'));
  for (const model_version of [MODEL, CONTENT_MODEL]) assert.throws(() => parseLayer({ ...f.audit, model_version }), code('INVALID_RECORD'));
  const invariant = structuredClone(f.audit); invariant.id = 'AuditInvariant'; invariant.created_blocks[0].requirements.copies.kind = 'invariant';
  assert.throws(() => f.call('author-a', 'layer.create', { record: invariant }), code('GUARDIAN_ASSIGNMENT_REQUIRED'));
  const noCreate = await hostCollectionFixture('audit-no-create', false);
  assert.throws(() => noCreate.call('author-a', 'layer.create', { record: noCreate.audit }), code('BLOCK_SCOPE_FORBIDDEN'));
  const other = structuredClone(f.audit); other.id = 'CollectionAuditOther'; other.owner = 'author-b'; other.created_blocks[0].description.text = 'Another reviewed whole-Layer proposal for the same finite audit.';
  f.publish(f.audit); f.publish(other);
  const record = { ...f.recipe, id: 'HostAuditCollision', proposals: ['CollectionAudit@1', 'CollectionAuditOther@1'], selected: ['CollectionAudit@1', 'CollectionAuditOther@1'] };
  const collision = f.call('author-a', 'compose', { record });
  assert.equal(collision.state, 'blocked'); assert(collision.diagnostics.some((d: any) => d.code === 'BLOCK_CREATION_COLLISION'));
  assert.throws(() => f.engine.realize(collision.ref, profile), code('BLOCKED_CANDIDATE'));
  const hypothetical = hostCollectionProfile.materialize(collision.ref, collision);
  assert.throws(() => f.engine.registerRealization(hypothetical), code('BLOCKED_CANDIDATE'));
  const basis = f.call('author-a', 'mediation.prepare', { target: collision.ref, case_id: 'choose-audit', case_revision: 1, expires_at: new Date(Date.now() + 600000).toISOString(), goal: 'Select one existing complete audit Layer.', partitions: [{ id: 'audit-a', selected: ['CollectionAudit@1'], rejected: ['CollectionAuditOther@1'] }], supersedes: null });
  assert.equal(basis.basis.alternatives[0].eligible, true);
  const decision = { ...f.extension, id: 'AuditDecision', intent: 'Choose the complete author-a audit Layer.', changes: [], created_blocks: [], resolution_proposals: [basis.decision_proposals[0].payload] };
  f.call('author-a', 'layer.create', { record: decision }); f.call('author-a', 'layer.publish', { ref: 'AuditDecision@1' });
  const packet = f.call('author-a', 'mediation.prepare', { basis_ref: basis.ref, decisions: [{ option_id: 'audit-a', layer: 'AuditDecision@1', proposal_index: 0 }] });
  const response = { packet_ref: packet.ref, packet_sha256: packet.packet_sha256, case_revision: 1, action: 'approve_selection', option_id: 'audit-a', message: 'Select one whole reviewed audit proposal.' };
  assert.throws(() => f.call('reviewer', 'mediation.respond', response), code('AUTHORITY_FORBIDDEN'));
  const selection = f.call('scope-selector', 'mediation.respond', response);
  const sealed = f.call('author-a', 'resolve', { record: { layer: 'AuditDecision@1', proposal_index: 0, composition: collision.ref, approvals: [selection.ref] } });
  const selected = f.call('author-a', 'compose', { record: { ...record, revision: 2, selected: ['CollectionAudit@1'], resolutions: [sealed.ref] } });
  assert.equal(selected.state, 'eligible_for_validation'); assert.deepEqual(selected.provenance['audit/purpose'], ['CollectionAudit@1']);
  const accepted = await accept(f, selected.ref, 'audit', f.expectations.audited);
  assert.equal(accepted.record.coverage.filter((c: any) => c.item.startsWith('audit/')).length, selected.obligations.filter((o: any) => o.item.startsWith('audit/')).length);
  assert.equal(accepted.reviews.length, 4); assert.equal(canonical(f.engine.read('HostCollectionBaseline@1')), seedBefore);
  const reuse = f.call('author-a', 'compose', { record: { ...record, id: 'HostAuditReuse', revision: 1, baseline: accepted.released.ref, proposals: [], selected: [], resolutions: [] } });
  assert.equal(reuse.state, 'eligible_for_validation'); assert.deepEqual(reuse.obligations, selected.obligations);
  assert.deepEqual(f.engine.realize(reuse.ref, profile).files, accepted.record.files);
});

test('copied fixture evidence, tampered pins/output, wrong principal, runner allowlist and revoked retained reviews fail closed', async () => {
  const f = await hostCollectionFixture('refusal');
  const target = f.call('author-a', 'compose', { record: { ...f.recipe, proposals: [], selected: [] } });
  assert.throws(() => f.call('reader', 'materialize', { target: target.ref, profile }), code('OPERATION_FORBIDDEN'));
  assert.throws(() => f.call('reviewer', 'materialize', { target: target.ref, profile }), code('PROFILE_FORBIDDEN'));
  const observed = await measure(f, target.ref, 'refusals');
  assert.throws(() => f.call('runner', 'validate', { target: target.ref, realization: observed.materialized.ref, evidence: { format: 'strata-evidence/2', results: observed.measured.run.results } }), code('INVALID_RECORD'));
  await assert.rejects(hostRunner(f.root, { refusals: observed.out }, [])(f.engine, observed.request, f.issuer.resolve(f.tokens.runner)), code('PROFILE_FORBIDDEN'));
  for (const key of ['candidate', 'profile', 'output_tree', 'checker_sha256', 'fixture_sha256', 'oracle_sha256']) {
    const checked = validate(f, target.ref, observed); const wrong = structuredClone(checked.assembled.evidence); wrong[key] = '0'.repeat(64);
    assert.throws(() => f.call('runner', 'validate', { target: target.ref, realization: observed.materialized.ref, evidence: wrong }), code('STALE_EVIDENCE'));
  }
  const checked = validate(f, target.ref, observed), endorsements = approvals(f, target.ref, checked.validation);
  const directory = path.join(f.root, observed.out), manifest = await readFile(path.join(directory, 'realization.json'), 'utf8');
  await writeFile(path.join(directory, 'collection.mjs'), observed.record.files['collection.mjs'] + '\n// changed output\n');
  await assert.rejects(hostRunner(f.root, { refusals: observed.out }, [profile])(f.engine, observed.request, f.issuer.resolve(f.tokens.runner)), code('OUTPUT_TAMPERED'));
  await assert.rejects(runNodeCommand(f.root, (c, i) => f.call('release-manager', c, i), 'release', { target: target.ref, validation: checked.validation.ref, approvals: endorsements }), code('OUTPUT_TAMPERED'));
  await writeFile(path.join(directory, 'collection.mjs'), observed.record.files['collection.mjs']); assert.equal(await readFile(path.join(directory, 'realization.json'), 'utf8'), manifest);
  const revoked = structuredClone(f.policy); revoked.generation = 2; revoked.grants.find(g => g.principal_id === 'reviewer')!.operations = ['inspect'];
  f.issuer.reload(f.accounts, revoked);
  assert.throws(() => f.call('runner', 'validate', { target: target.ref, realization: observed.materialized.ref, evidence: checked.assembled.evidence }), code('ENDORSEMENT_REVOKED'));
  assert.equal(Object.values(f.engine.records).filter(r => r.type === 'release' && r.data.state === 'validated').length, 0);
});

after(async () => { await mkdir('.strata', { recursive: true }); await writeFile('.strata/collection-host-workflow-evidence.json', JSON.stringify({ base: 'caf5ee31957e2b4e7bb83a0cc5cc96d9464db4ab', synthetic_only: true, deployed: false, cases: receipts }, null, 2) + '\n'); });
