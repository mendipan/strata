import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { BLOCK_MODEL, CONTENT_MODEL } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { createSourceHostProof } from '../src/source-binding.js';
import { executeAdoption, publicationGate, verifyAdoptionHistory } from '../src/adoption/persistent.js';
import { adoptionRequired } from '../src/adoption/guard.js';
import { adoptionFixture } from './adoption-fixture.js';

// Trusted synthetic host proof exercises gate logic; it claims no filesystem measurement.
async function setup() {
  const f = await adoptionFixture(), engine = new Engine({}, {}, { projectId: f.source.project_id });
  engine.init(f.baseline, 'bootstrap'); engine.store(f.inventory.source.ref, 'source-snapshot', f.source);
  const assignment = { principal: 'author-a', operations: ['adoption.prepare', 'adoption.review', 'layer.publish'], repositories: [f.source.repo_id], git_paths: f.source.scope.paths };
  const issuer = new FixtureIssuer({ project_id: f.source.project_id, assignments: { 'fixture-a': assignment } }), context = issuer.resolve('fixture-a');
  const proof = (index = 'f'.repeat(64)) => createSourceHostProof(f.source, { format: 'git-observation/1', project_id: f.source.project_id, repo_id: f.source.repo_id, object_format: f.source.object_format, head_commit: f.source.head_commit, head_tree: f.source.head_tree, index_sha256: index, scope_sha256: f.source.scope_sha256, entries: f.source.entries, manifest_sha256: f.source.manifest_sha256, status: [], outside_scope_dirty: false, ignored_count: 0, excluded_count: 0, unsupported: [], coherence: 'stable', trust: 'local-measurement' });
  const prepare = (layer = f.layer, previous?: string) => {
    const result = executeAdoption(engine, 'adoption.prepare', { inventory: f.inventory, layer, ...(previous ? { previous } : {}) }, context, issuer);
    assert.ok(result.draft_ref);
    return { ...result, draft_ref: result.draft_ref };
  };
  const review = (proposal: ReturnType<typeof prepare>) => executeAdoption(engine, 'adoption.review', { proposal_ref: proposal.ref, expected_proposal_sha256: proposal.proposal_sha256, accepted: true, rationale: 'Synthetic exact owner interpretation review; no behavior execution.' }, context, issuer);
  return { ...f, engine, issuer, context, assignment, proof, prepare, review };
}
test('A2 retained review refuses changed assignment binding even at the same fixture policy epoch', async () => {
  const f = await setup(), proposal = f.prepare(), review = f.review(proposal);
  const changed = new FixtureIssuer({ project_id: f.source.project_id, assignments: { 'fixture-a': { ...f.assignment, operations: ['layer.publish'] } } }), current = changed.resolve('fixture-a');
  assert.equal(current.policy_version, f.context.policy_version); assert.notEqual(changed.accessBinding(), f.issuer.accessBinding());
  assert.throws(() => publicationGate(f.engine, proposal.draft_ref, review.ref, current, changed, f.proof()), { code: 'STALE_ADOPTION_REVIEW' });
});
test('A2 gate refuses index-only changes between measurements and reviews of a prior head', async () => {
  const f = await setup(), proposal = f.prepare(), review = f.review(proposal), retained = publicationGate(f.engine, proposal.draft_ref, review.ref, f.context, f.issuer, f.proof());
  assert.throws(() => publicationGate(f.engine, proposal.draft_ref, review.ref, f.context, f.issuer, f.proof('e'.repeat(64)), retained), { code: 'SOURCE_SNAPSHOT_STALE' });
  f.engine.layer({ ...f.layer, revision: 2 }, 'author-a', proposal.draft_ref);
  assert.throws(() => publicationGate(f.engine, proposal.draft_ref, review.ref, f.context, f.issuer, f.proof()), { code: 'STALE_REVISION' });
});
test('A2 review denies a differently owned actor even with an assigned review/repository operation', async () => {
  const f = await setup(), proposal = f.prepare();
  const other = new FixtureIssuer({ project_id: f.source.project_id, assignments: { 'fixture-b': { ...f.assignment, principal: 'author-b' } } });
  assert.throws(() => executeAdoption(f.engine, 'adoption.review', { proposal_ref: proposal.ref, expected_proposal_sha256: proposal.proposal_sha256, accepted: true, rationale: 'Wrong owner' }, other.resolve('fixture-b'), other), { code: 'OWNER_FORBIDDEN' });
});
test('A2 rejects unsupported model/hosted authority and preserves pre-adoption published revisions', async () => {
  const f = await setup();
  for (const modelVersion of [CONTENT_MODEL, BLOCK_MODEL] as const) assert.throws(() => executeAdoption(new Engine({}, {}, { projectId: f.source.project_id, modelVersion }), 'adoption.prepare', {}, f.context, f.issuer), { code: 'UNSUPPORTED_SOURCE_BACKEND' });
  assert.throws(() => executeAdoption(f.engine, 'adoption.prepare', {}, { ...f.context, trust_mode: 'host_authenticated' }, f.issuer), { code: 'UNSUPPORTED_SOURCE_BACKEND' });
  f.engine.layer(f.layer, 'author-a'); f.engine.publish('CounterExtension@1', 'author-a');
  const proposal = f.prepare({ ...f.layer, revision: 2 }, 'CounterExtension@1');
  assert.equal(adoptionRequired(f.engine.records, f.layer), false); assert.equal(adoptionRequired(f.engine.records, f.engine.read(proposal.draft_ref, 'layer', false)), true);
  assert.equal(f.engine.records['CounterExtension@1'].published, true); verifyAdoptionHistory(f.engine, f.source.project_id);
});
