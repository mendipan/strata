import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonical, bytesDigest, digest } from '../src/model.js';
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.js';
import { NODE_STATE_FORMAT, STATE_DESCRIPTOR } from '../src/node-state.js';
import { executeDrift } from '../src/reconciliation.js';
import { createDriftHostProof } from '../src/source-drift.js';
import { sourceFixture, proposalFixture } from './source-fixture.js';
import { gitStore } from '../src/git-adoption.js';

async function stored(extend?: (f: ReturnType<typeof sourceFixture>, p: ReturnType<typeof proposalFixture>) => void) {
  const f = sourceFixture(), p = proposalFixture(f); executeDrift(f.engine, 'drift.review', p.reviewInput, f.selector, f.issuer, createDriftHostProof(p.observation));
  extend?.(f, p);
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-source-backup-')), state = path.join(root, 'state'); await mkdir(path.join(state, 'artifacts'), { recursive: true });
  await writeFile(path.join(state, STATE_DESCRIPTOR), canonical({ format: NODE_STATE_FORMAT, model_version: f.engine.modelVersion(), project_id: f.selector.project_id }));
  const entries: Record<string, any> = {};
  for (const [ref, record] of Object.entries(f.engine.records)) { const body = canonical(record.data), hash = bytesDigest(body); entries[ref] = { hash, type: record.type, published: record.published }; await writeFile(path.join(state, 'artifacts', hash + '.json'), body); }
  await writeFile(path.join(state, 'registry.json'), canonical({ entries, heads: f.engine.ownerHeads, requests: {}, commit_audit: [] }));
  await writeFile(path.join(state, 'audit.jsonl'), '');
  return { ...f, ...p, root, state, entries };
}
test('portable source/drift backup round trip verifies without Git checkout or live authority', async () => {
  const f = await stored(), input = { state: f.state, out: path.join(f.root, 'bundle'), project: f.selector.project_id, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 }, result = await createBackup(input);
  const check = await verifyBackup({ bundle: input.out, project: input.project, selector: input.selector, expectedDigest: result.manifest_sha256 }); assert.equal(check.records, Object.keys(f.engine.records).length);
  const out = path.join(f.root, 'inactive'), restored = await restoreBackup({ bundle: input.out, out, project: input.project, selector: input.selector, expectedDigest: result.manifest_sha256 }); assert.equal(restored.inactive, true); assert.equal(restored.identities_active, false);
  const checkpoint = JSON.parse(await readFile(path.join(out, 'checkpoint.json'), 'utf8')); assert.equal(checkpoint.entries[f.reportRef].type, 'drift-report'); assert.equal(checkpoint.entries[f.bindingRef].type, 'source-binding'); assert.equal('contexts' in checkpoint, false);
});

test('failed and incomplete Git application observations retain exact closure in offline backup', async () => {
  for (const incomplete of [false, true]) {
    let observationRef = '';
    const f = await stored((fixture, p) => {
      const evaluation = fixture.engine.target('R0@1'), criterion = evaluation.snapshot.blocks.app.acceptance.review;
      const criteria = [{ criterion_ref: 'app/acceptance.review', check: criterion.check, version: criterion.version, fixture: criterion.fixture, method: criterion.method }], oracle = { bounded: 'synthetic-import-assertion' }, checker = { id: 'external-fixture', version: '1', sha256: digest('checker'), fixture_sha256: digest('fixture'), oracle_sha256: digest(oracle) }, target = { ref: 'R0@1', record_sha256: digest(fixture.engine.read('R0@1')), candidate_fingerprint: evaluation.fingerprint, snapshot_sha256: digest(evaluation.snapshot) };
      const plan = gitStore(fixture.engine, 'git-change-plan', { format: 'git-change-plan/1', project_id: fixture.selector.project_id, repo_id: fixture.source.repo_id, binding_ref: fixture.bindingRef, base_source_ref: fixture.sourceRef, base_source_sha256: digest(fixture.source), target, write_paths: ['src/app.txt'], criteria, checker, oracle, regressions: [], acceptance_contract_sha256: digest({ criteria, regressions: [], checker }), owner: fixture.author.principal_id });
      const patch = '--- a/src/app.txt\n+++ b/src/app.txt\n@@ -1 +1 @@\n-hello\n+changed\n', stage = gitStore(fixture.engine, 'git-patch-stage', { format: 'git-patch-stage/1', project_id: fixture.selector.project_id, repo_id: fixture.source.repo_id, plan_ref: plan.ref, patch, patch_sha256: bytesDigest(patch), operations: [{ path: 'src/app.txt', before: { content: 'hello\n', sha256: bytesDigest('hello\n'), mode: '100644' }, after: { content: 'changed\n', sha256: bytesDigest('changed\n'), mode: '100644' } }], result_tree_oid: 'c'.repeat(40), result_manifest_sha256: p.observation.manifest_sha256, unchanged_outside_write_set: true, base_index_digest: fixture.observation.index_sha256, owner: fixture.author.principal_id });
      const observed = gitStore(fixture.engine, 'git-application-observation', { format: 'git-application-observation/1', project_id: fixture.selector.project_id, repo_id: fixture.source.repo_id, plan_ref: plan.ref, stage_ref: stage.ref, target, base_source_ref: fixture.sourceRef, result_tree_oid: stage.record.result_tree_oid, result_manifest_sha256: stage.record.result_manifest_sha256, acceptance_contract_sha256: plan.record.acceptance_contract_sha256, checker, results: incomplete ? [] : [{ ...criteria[0], passed: false, reviewer: 'fixture-reviewer' }], regressions: [], producer: { principal: 'fixture-runner', trust: 'local-fixture-import', execution_authenticated: false }, limitations: ['Synthetic retained assertion; no application execution.'], observations_sha256: digest('reported-observations') }); observationRef = observed.ref;
      const checked = executeDrift(fixture.engine, 'drift.check', { binding_ref: fixture.bindingRef, evidence_refs: [observed.ref] }, fixture.author, fixture.issuer, createDriftHostProof(p.observation));
      assert.equal(fixture.engine.read(checked.ref).coverage.acceptance_complete, false);
    });
    const bundle = path.join(f.root, 'bundle'), exported = await createBackup({ state: f.state, out: bundle, project: f.selector.project_id, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 });
    await verifyBackup({ bundle, project: f.selector.project_id, selector: 'fixture-backup', expectedDigest: exported.manifest_sha256 }); const out = path.join(f.root, 'inactive'); await restoreBackup({ bundle, out, project: f.selector.project_id, selector: 'fixture-backup', expectedDigest: exported.manifest_sha256 });
    const checkpoint = JSON.parse(await readFile(path.join(out, 'checkpoint.json'), 'utf8')); assert.equal(checkpoint.entries[observationRef].type, 'git-application-observation');
  }
});
test('portable backup refuses unresolved Git filesystem transaction before export', async () => {
  const f = await stored(); await writeFile(path.join(f.state, 'GIT_APPLY_PENDING.json'), '{}');
  await assert.rejects(() => createBackup({ state: f.state, out: path.join(f.root, 'blocked'), project: f.selector.project_id, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 }), (e: any) => e.code === 'STATE_BUSY');
});
test('backup rejects missing binding source and tampered report classification', async () => {
  for (const mutation of ['missing', 'classification']) {
    const f = await stored(), registry = JSON.parse(await readFile(path.join(f.state, 'registry.json'), 'utf8'));
    if (mutation === 'missing') delete registry.entries[f.sourceRef];
    else { const ref = f.reportRef, entry = registry.entries[ref], data = JSON.parse(await readFile(path.join(f.state, 'artifacts', entry.hash + '.json'), 'utf8')); data.behavior_status = 'bounded-fixture-results'; const body = canonical(data), hash = bytesDigest(body); registry.entries[ref].hash = hash; await writeFile(path.join(f.state, 'artifacts', hash + '.json'), body); }
    await writeFile(path.join(f.state, 'registry.json'), canonical(registry)); await assert.rejects(() => createBackup({ state: f.state, out: path.join(f.root, 'blocked'), project: f.selector.project_id, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 }));
  }
});
