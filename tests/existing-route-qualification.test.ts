import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { qualifyExistingRoute, type ExistingRoute } from '../src/qualification/existing-routes.js';

let root: string;
before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'strata-q1-test-')); });
after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('strata-q1-test-')); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true, force: true }); });

test('qualification refuses existing output and output inside a Git repository before creating fixtures', async () => {
  const existing = path.join(root, 'existing'); await mkdir(existing); await writeFile(path.join(existing, 'sentinel.txt'), 'preserve');
  await assert.rejects(qualifyExistingRoute('incremental', existing), (error: any) => error.code === 'EEXIST');
  assert.equal(await readFile(path.join(existing, 'sentinel.txt'), 'utf8'), 'preserve');
  const repository = path.join(root, 'existing-repo'); await mkdir(repository); await mkdir(path.join(repository, '.git'));
  await assert.rejects(qualifyExistingRoute('incremental', path.join(repository, 'new-trial')), /outside existing Git repositories/);
  await assert.rejects(access(path.join(repository, 'new-trial')));
});

for (const route of ['incremental', 'reconstruct_declared_scope'] as ExistingRoute[]) {
  test(`real subprocess CLI qualifies ${route} with retained evidence, explicit local trust and separate completion limits`, async () => {
    const trial = path.join(root, route), report = await qualifyExistingRoute(route, trial);
    assert.equal(report.status, 'qualified_fixture_lane', report.failure); assert.equal(report.host_closed, true);
    assert(report.commands.length > 25); assert(report.commands.every((command: any) => typeof command.exit === 'number' && command.log_prefix && command.stdin_sha256 && command.stdout_sha256 && !command.bounded_failure));
    assert.notEqual(report.refs.baseline_release, report.refs.changed_release); assert(report.refs.inventory && report.refs.publication && report.refs.proposal && report.refs.interpretation_review);
    assert.equal(report.model, 'strata/0.1-facets-experimental'); assert.equal(report.profile, 'counter-fixture/1'); assert.equal(report.checker, 'counter-application/1');
    assert.equal(report.execution_authenticated, false); assert.equal(report.automatic_extraction, false); assert.equal(report.adoption_delivery_bridge_established, false); assert.equal(report.reconciliation_complete, false);
    assert.equal(report.restart.accepted_release_visible, true); assert.equal(report.restart.exact_binding_visible, true); assert.equal(report.backup.inactive, true); assert.equal(report.backup.verified, true);
    for (const name of ['.gitattributes', 'counter.test.mjs', 'image.bin', 'unrelated.txt']) assert.equal(report.original.bytes[name], report.original_after.bytes[name]);
    assert.deepEqual(JSON.parse(await readFile(path.join(trial, 'report.json'), 'utf8')), report);
    if (route === 'incremental') {
      assert.equal(report.delivery.state, 'owner-committed-and-natively-finalized'); assert.equal(report.delivery.engine_implicitly_committed, false);
      assert.notEqual(report.original.git.head_commit, report.delivery.owner_commit); assert.equal(report.original_after.git.head_commit, report.delivery.owner_commit);
      assert.equal(report.delivery.before_owner_commit_head_and_index_preserved, true); assert.equal(report.delivery.untouched_paths_preserved, true);
      assert(report.refs.native_finalization && report.refs.successor_binding); assert.equal(report.rollback.original_bytes_and_git_restored, true);
      assert.equal(report.rollback.fixed_post_write_fault_triggered, true); assert.equal(report.rollback.state, 'rolled_back');
      assert.deepEqual(report.refusals, [{ label: 'wrong-actor', code: 'OPERATION_FORBIDDEN', exit: 4 }, { label: 'dirty-protected-source', code: 'UNSUPPORTED_CHECKOUT_TRANSFORM', exit: 5 }, { label: 'fixed-write-failure', code: 'STORE_UNAVAILABLE', exit: 9 }, { label: 'no-owner-commit', code: 'UNSUPPORTED_CHECKOUT_TRANSFORM', exit: 5 }]);
      assert.equal(report.original_after.git.branch, report.original.git.branch); assert(report.original_after.git.refs.includes('refs/heads/untouched-history ' + report.original.git.head_commit));
    } else {
      assert.equal(report.delivery.state, 'independent-reconstruction-qualified'); assert.equal(report.delivery.cutover_performed, false); assert.equal(report.delivery.native_apply_performed, false);
      assert.deepEqual(report.original_after, report.original && { git: report.original.git, bytes: report.original.bytes });
      assert.equal(report.refs.native_finalization, undefined); assert.equal(report.refs.successor_binding, undefined); assert.equal(report.refusals.length, 0);
    }
  });
}
