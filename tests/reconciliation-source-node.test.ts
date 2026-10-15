import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, unlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bytesDigest, digest, type Records } from '../src/model.js';
import { runGit, decodeGit } from '../src/git-workspace.js';
import { recordPin, contractDigest, type Plan, type PlannedProof, type Pin, type TypedRecordReader } from '../src/reconciliation-records.js';
import { verifyPlannedSourceProof, verifyCommittedSourceProof } from '../src/reconciliation-source-proof.js';
import { resolveReconciliationRepository, captureReconciliationObservation, prepareDesiredSource, captureCompletionSource,
  assertLateSourceSynchronously, type ReconciliationSourceHost, type AuthorizeSourcePath } from '../src/reconciliation-source-node.js';
import { s1Fixture } from './fixtures/reconciliation-s1/fixtures.js';

const allow: AuthorizeSourcePath = () => {};
const scratchRoot = path.resolve('.strata', 'reconciliation-source-node-tests');
async function fixture(options: { format?: 'sha1' | 'sha256'; clean?: boolean; addition?: boolean; binary?: boolean; executable?: boolean; largeBound?: boolean; action?: PlannedProof['action'] } = {}) {
  await mkdir(scratchRoot, { recursive: true }); const root = await mkdtemp(path.join(scratchRoot, 'repo-'));
  const git = async (...args: string[]) => decodeGit(await runGit(root, ['-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic',
    '-c', 'user.email=test@example.invalid', ...args])).trim();
  const write = (name: string, bytes: string | Buffer) => writeFile(path.join(root, name), bytes);
  await git('init', '--quiet', '--object-format=' + (options.format ?? 'sha1'));
  await write('selected.txt', options.largeBound ? 'x'.repeat(512 * 1024 + 10) : 'value=1\nanchor\n');
  await write('secondary.txt', options.binary ? Buffer.from([0, 255, 3]) : 'separate\n'); await write('unselected.bin', Buffer.from([0, 255, 3]));
  await git('add', '--', 'selected.txt', 'secondary.txt', 'unselected.bin');
  if (options.executable) await git('update-index', '--chmod=+x', 'secondary.txt');
  await git('commit', '-qm', 'Synthetic B');
  const f = s1Fixture({ format: options.format, action: options.action }), records: Records = f.records;
  const scope = structuredClone(f.source.scope);
  if (options.addition) {
    scope.paths.push('new.txt'); scope.paths.sort(); scope.mapping[0].paths.push('new.txt'); scope.mapping[0].paths.sort();
  }
  const repositoryIdentity = await resolveReconciliationRepository({ root, projectId: 'synthetic', repoId: 'repo' });
  const baseHost = { repositoryIdentity, projectId: 'synthetic', repoId: 'repo' };
  const base = captureReconciliationObservation(baseHost, scope, allow);
  const retain = (type: string, data: unknown): Pin => { const pin = recordPin(type, data); records[pin.ref] = { type, data, published: true }; return pin; };
  const read: TypedRecordReader = (pin, type) => { const r = records[pin.ref]; assert.ok(r, `Missing ${pin.ref}`); assert.equal(r.type, type); return r.data; };
  const boundSource = retain('source-snapshot', base.sourceSnapshot);
  const binding = structuredClone(f.records[f.proof.predecessor.ref].data);
  binding.payload.source_ref = boundSource.ref; binding.payload.source_sha256 = boundSource.sha256; binding.payload_sha256 = digest(binding.payload);
  const predecessor = retain('source-binding', binding);
  if (!options.clean) await write('selected.txt', options.action === 'restore_intent' ? 'value=2\nanchor\n' : 'value=0\nanchor\n');
  const refresh = () => {
    const observed = captureReconciliationObservation(baseHost, scope, allow);
    const report = retain('drift-report', { format: 'source-drift-report/2', project_id: 'synthetic', repo_id: 'repo',
      binding_ref: predecessor.ref, binding_sha256: predecessor.sha256, observation: observed.observation, observation_sha256: digest(observed.observation) });
    host.report = report; return observed.observation;
  };
  const host: ReconciliationSourceHost = { ...baseHost, read, predecessor, boundSource, report: f.proof.report };
  let observation = refresh();
  const prepare = async (action = options.action ?? 'accept_code', patch: string | null = null, modes: PlannedProof['new_file_modes'] = [], authorize = allow) =>
    prepareDesiredSource(host, scope, observation, action, patch, modes, authorize);
  const planFor = (proof: PlannedProof): Plan => {
    retain('reconciliation-source-proof', proof);
    const verified = verifyPlannedSourceProof(read, proof), body = structuredClone(f.body);
    Object.assign(body, { predecessor, report: host.report, action: proof.action, old_scope: scope, scope, observation: proof.observation,
      observation_sha256: proof.observation_sha256, source_proof: verified.proof_pin, observed_tree_oid: proof.trees.observed,
      desired_tree_oid: proof.trees.desired, desired_entries: proof.selected.desired, binding_delta_paths: verified.binding_delta_paths,
      patch: proof.patch, patch_sha256: proof.patch_sha256, operations: proof.operations, association_paths: proof.association_paths,
      restore_paths: proof.restore_paths, new_file_modes: proof.new_file_modes });
    body.historical_bridge.predecessor = predecessor;
    Object.assign(body.successor_template, { predecessor, scope, desired_tree_oid: proof.trees.desired, desired_manifest_sha256: digest(proof.selected.desired), limitations: scope.limitations });
    body.contract_sha256 = contractDigest(body);
    const plan = { ...f.plan, body, body_sha256: digest(body) }; retain('reconciliation-proposal', plan); return plan;
  };
  const retainPrepared = (prepared: Awaited<ReturnType<typeof prepare>>) => {
    for (const o of prepared.objectRecords) retain('reconciliation-git-object', o);
    return { plan: planFor(prepared.proof), prepared: prepared.proof,
      repositoryIdentity: { identity: prepared.repositoryIdentity.identity, configuration_sha256: prepared.repositoryIdentity.configuration_sha256 } };
  };
  const close = async () => {
    assert.equal(path.dirname(path.resolve(root)), scratchRoot); assert.ok(path.basename(root).startsWith('repo-'));
    await rm(root, { recursive: true, force: true });
  };
  return { root, host, scope, git, write, records, read, retain, prepare, retainPrepared, base, close,
    get observation() { return observation; }, refresh() { observation = refresh(); return observation; } };
}
async function repositoryBytes(root: string) {
  const rows: { path: string; sha256: string }[] = [];
  const walk = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const full = path.join(directory, name), stat = await lstat(full);
      if (stat.isDirectory()) await walk(full); else rows.push({ path: path.relative(root, full).replaceAll('\\', '/'), sha256: bytesDigest(await readFile(full)) });
    }
  };
  await walk(root); return rows;
}
const restorePatch = 'diff --git a/selected.txt b/selected.txt\n--- a/selected.txt\n+++ b/selected.txt\n@@ -1,2 +1,2 @@\n-value=2\n+value=0\n anchor\n';

for (const format of ['sha1', 'sha256'] as const) {
  test(`${format}: dirty tracked accept uses physical source and accepts one exact owner child`, async () => {
    const f = await fixture({ format });
    try {
      const before = await repositoryBytes(f.root), prepared = await f.prepare();
      assert.deepEqual(await repositoryBytes(f.root), before, 'Preparation changed original files/index/objects/refs.');
      const plan = f.retainPrepared(prepared); verifyPlannedSourceProof(f.read, prepared.proof);
      await f.git('add', '--', 'selected.txt'); await f.git('commit', '-qm', 'Owner C'); const C = await f.git('rev-parse', 'HEAD');
      const final = await captureCompletionSource(f.host, plan, C, allow);
      assert.equal(final.proof.transition, 'direct-child'); assert.equal(final.proof.additional_objects.length, 1);
      assert.equal(final.immutableInputs.find(e => e.path === 'selected.txt')!.bytes.toString(), 'value=0\nanchor\n');
      for (const object of final.newObjectRecords) f.retain('reconciliation-git-object', object);
      f.retain('source-snapshot', final.sourceSnapshot); verifyCommittedSourceProof(f.read, final.proof);
      assertLateSourceSynchronously(f.host.repositoryIdentity, final.observation, f.scope);
    } finally { await f.close(); }
  });
  test(`${format}: already clean source completes at reviewed HEAD without empty commit`, async () => {
    const f = await fixture({ format, clean: true });
    try {
      const prepared = await f.prepare(), plan = f.retainPrepared(prepared), before = await repositoryBytes(f.root);
      const final = await captureCompletionSource(f.host, plan, f.observation.head_commit, allow);
      assert.equal(final.proof.transition, 'same-reviewed-clean-head'); assert.deepEqual(final.newObjectRecords, []);
      assert.deepEqual(await repositoryBytes(f.root), before);
    } finally { await f.close(); }
  });
}
test('restore B -> H -> C preserves a separately mapped dirty sibling outside the supplied patch', async () => {
  const f = await fixture({ action: 'restore_intent' });
  try {
    await f.git('add', '--', 'selected.txt'); await f.git('commit', '-qm', 'Committed drift H');
    await f.write('secondary.txt', 'preserved sibling edit\n'); f.refresh();
    const before = await repositoryBytes(f.root), prepared = await f.prepare('restore_intent', restorePatch), plan = f.retainPrepared(prepared);
    assert.equal(prepared.proof.ancestry_oids.length, 2); assert.deepEqual(await repositoryBytes(f.root), before);
    assert.equal(prepared.immutableInputs.find(e => e.path === 'secondary.txt')!.bytes.toString(), 'preserved sibling edit\n');
    assert.deepEqual(prepared.proof.restore_paths, ['selected.txt']);
    await f.write('selected.txt', 'value=0\nanchor\n'); await f.git('add', '--', 'selected.txt', 'secondary.txt'); await f.git('commit', '-qm', 'Owner restored C');
    const final = await captureCompletionSource(f.host, plan, await f.git('rev-parse', 'HEAD'), allow);
    assert.equal(final.sourceSnapshot.head_tree, prepared.proof.trees.desired);
    assert.equal(await readFile(path.join(f.root, 'secondary.txt'), 'utf8'), 'preserved sibling edit\n');
  } finally { await f.close(); }
});
test('staged bytes are not substituted for reviewed physical bytes', async () => {
  const f = await fixture();
  try {
    await f.write('selected.txt', 'staged-only\nanchor\n'); await f.git('add', '--', 'selected.txt'); await f.write('selected.txt', 'physical\nanchor\n'); f.refresh();
    const before = await repositoryBytes(f.root), prepared = await f.prepare();
    assert.equal(prepared.immutableInputs.find(e => e.path === 'selected.txt')!.bytes.toString(), 'physical\nanchor\n');
    assert.deepEqual(prepared.observation.status.find(e => e.path === 'selected.txt'), { path: 'selected.txt', staged: true, unstaged: true, untracked: false });
    assert.deepEqual(await repositoryBytes(f.root), before);
  } finally { await f.close(); }
});
test('explicit previously mapped addition and deletion are retained; mode is never inferred', async () => {
  const f = await fixture({ addition: true });
  try {
    await f.write('new.txt', 'added\n'); await unlink(path.join(f.root, 'secondary.txt')); f.refresh();
    await assert.rejects(f.prepare(), /explicit 100644/);
    const prepared = await f.prepare('accept_code', null, [{ path: 'new.txt', mode: '100644' }]);
    assert.equal(prepared.proof.selected.desired.find(e => e.path === 'secondary.txt')!.presence, 'absent');
    const plan = f.retainPrepared(prepared); await f.git('add', '-A'); await f.git('commit', '-qm', 'Owner addition and deletion');
    await captureCompletionSource(f.host, plan, await f.git('rev-parse', 'HEAD'), allow);
  } finally { await f.close(); }
});
test('restore can add a mapped absent destination and delete a selected file privately', async () => {
  const f = await fixture({ addition: true });
  try {
    const patch = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n' +
      'diff --git a/secondary.txt b/secondary.txt\ndeleted file mode 100644\n--- a/secondary.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-separate\n';
    const before = await repositoryBytes(f.root), prepared = await f.prepare('restore_intent', patch, [{ path: 'new.txt', mode: '100644' }]);
    assert.deepEqual(prepared.proof.restore_paths, ['new.txt', 'secondary.txt']); assert.deepEqual(await repositoryBytes(f.root), before);
    assert.equal(prepared.immutableInputs.find(e => e.path === 'new.txt')!.bytes.toString(), 'new\n');
  } finally { await f.close(); }
});
test('full committed B -> desired comparison refuses outside mapping drift even when current source is clean', async () => {
  const f = await fixture({ clean: true });
  try {
    await f.write('unselected.bin', 'unapproved'); await f.git('add', '--', 'unselected.bin'); await f.git('commit', '-qm', 'Outside committed drift'); f.refresh();
    const before = await repositoryBytes(f.root); await assert.rejects(f.prepare(), /full-tree change/); assert.deepEqual(await repositoryBytes(f.root), before);
  } finally { await f.close(); }
});
test('outside-scope dirty paths, unmapped watched files and ignored additions refuse without reading ignored bytes', async () => {
  const f = await fixture({ addition: true });
  try {
    await f.write('unselected.bin', 'dirty'); f.refresh(); await assert.rejects(f.prepare(), /Outside-scope/);
    await f.write('unselected.bin', Buffer.from([0, 255, 3])); await f.write('unmapped.txt', 'unmapped'); assert.throws(() => f.refresh(), /mapped/);
    await unlink(path.join(f.root, 'unmapped.txt'));
    await writeFile(path.join(f.host.repositoryIdentity.commonDir, 'info', 'exclude'), 'new.txt\n');
    f.host.repositoryIdentity = await resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' });
    // refresh's report host retains the original identity, so invoke the new host explicitly.
    await f.write('new.txt', 'secret'); const reads: string[] = [];
    assert.throws(() => captureReconciliationObservation(f.host, f.scope, (p, use) => { if (use === 'read') reads.push(p); }), /Ignored additions/);
    assert.ok(!reads.includes('new.txt'));
  } finally { await f.close(); }
});
test('new source paths and all ordinary outside-tree reads require exact authorization before content access', async () => {
  const f = await fixture();
  try {
    const before = await repositoryBytes(f.root);
    await assert.rejects(f.prepare('accept_code', null, [], (p, use) => { if (p === 'unselected.bin' && use === 'read') throw Error('denied outside exact path'); }), /denied outside/);
    assert.deepEqual(await repositoryBytes(f.root), before);
  } finally { await f.close(); }
});
test('before/late source, index, inventory and configuration races invalidate exact observations', async () => {
  for (const mutation of ['source', 'index', 'inventory', 'config', 'empty-config', 'head']) {
    const f = await fixture();
    try {
      const prepared = await f.prepare();
      if (mutation === 'source') await f.write('selected.txt', 'race\n');
      if (mutation === 'index') await f.git('add', '--', 'selected.txt');
      if (mutation === 'inventory') await f.write('intruder.txt', 'race\n');
      if (mutation === 'config') await f.git('config', 'user.name', 'Changed');
      if (mutation === 'empty-config') await writeFile(path.join(f.host.repositoryIdentity.commonDir, 'info', 'attributes'), '');
      if (mutation === 'head') { await f.git('add', '--', 'selected.txt'); await f.git('commit', '-qm', 'Unexpected owner advance'); }
      assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, prepared.observation, f.scope));
      await assert.rejects(f.prepare());
    } finally { await f.close(); }
  }
});
test('changes made by an authorization callback during capture are detected', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    await assert.rejects(f.prepare('accept_code', null, [], (name, use) => {
      if (name === 'selected.txt' && use === 'read' && ++reads === 3) {
        // Deliberately race a prior file after it was measured in the first pass.
        writeFileSync(path.join(f.root, 'secondary.txt'), 'raced sibling\n');
      }
    }), /changed during capture/);
  } finally { await f.close(); }
});
test('completion refuses extra commit, wrong full tree, dirty final bytes and selected index races; edits remain intact', async () => {
  for (const mutation of ['extra-commit', 'tree', 'dirty', 'staged', 'untracked']) {
    const f = await fixture();
    try {
      const prepared = await f.prepare(), plan = f.retainPrepared(prepared);
      await f.git('add', '--', 'selected.txt'); await f.git('commit', '-qm', 'Owner C');
      if (mutation === 'extra-commit') await f.git('commit', '--allow-empty', '-qm', 'Extra owner commit');
      if (mutation === 'tree') { await f.write('secondary.txt', 'wrong desired tree\n'); await f.git('add', '--', 'secondary.txt'); await f.git('commit', '--amend', '--no-edit'); }
      if (mutation === 'dirty') await f.write('selected.txt', 'new owner edit\n');
      if (mutation === 'staged') { await f.write('secondary.txt', 'staged edit\n'); await f.git('add', '--', 'secondary.txt'); }
      if (mutation === 'untracked') await f.write('untracked.txt', 'owner inventory edit\n');
      const before = await repositoryBytes(f.root); await assert.rejects(captureCompletionSource(f.host, plan, await f.git('rev-parse', 'HEAD'), allow));
      assert.deepEqual(await repositoryBytes(f.root), before, mutation);
    } finally { await f.close(); }
  }
});
test('pre/post worker final guards detect source and raw index changes after successful completion capture', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare(), plan = f.retainPrepared(prepared);
    await f.git('add', '--', 'selected.txt'); await f.git('commit', '-qm', 'Owner C');
    const final = await captureCompletionSource(f.host, plan, await f.git('rev-parse', 'HEAD'), allow);
    await f.write('selected.txt', 'edit during worker\n'); assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, final.observation, f.scope));
    await f.write('selected.txt', 'value=0\nanchor\n'); await f.git('update-index', '--refresh');
    assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, final.observation, f.scope));
  } finally { await f.close(); }
});
test('hooks/filter/fsmonitor/aliases/network sentinels cannot execute during source mechanics', async () => {
  const f = await fixture();
  try {
    const sentinel = path.join(f.root, 'executed.txt'), hooks = path.join(f.host.repositoryIdentity.gitDir, 'hooks');
    const command = `node -e "require('fs').writeFileSync('${sentinel.replaceAll('\\', '/')}', 'EXECUTED')"`;
    await f.git('config', 'core.fsmonitor', command); await f.git('config', 'filter.hostile.clean', command);
    await f.git('config', 'filter.hostile.smudge', command); await f.git('config', 'alias.status', '!' + command);
    await f.git('config', 'diff.external', command); await f.git('config', 'remote.origin.url', 'https://provider.invalid/repo');
    await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\n' + command + '\n');
    f.host.repositoryIdentity = await resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' });
    const observed = captureReconciliationObservation(f.host, f.scope, allow).observation;
    f.host.report = f.retain('drift-report', { format: 'source-drift-report/2', project_id: 'synthetic', repo_id: 'repo',
      binding_ref: f.host.predecessor.ref, binding_sha256: f.host.predecessor.sha256, observation: observed, observation_sha256: digest(observed) });
    const before = await repositoryBytes(f.root);
    await prepareDesiredSource(f.host, f.scope, observed, 'accept_code', null, [], allow);
    assert.deepEqual(await repositoryBytes(f.root), before); await assert.rejects(readFile(sentinel), /ENOENT/);
  } finally { await f.close(); }
});
test('hardlinked source, checkout transforms, pending operations and replacement/graft/alternate semantics refuse', async () => {
  for (const mutation of ['hardlink', 'transform', 'pending', 'replace', 'graft', 'alternate', 'sparse', 'assume']) {
    const f = await fixture();
    try {
      const gitDir = f.host.repositoryIdentity.gitDir;
      if (mutation === 'hardlink') await link(path.join(f.root, 'selected.txt'), path.join(f.root, 'linked.txt'));
      if (mutation === 'transform') { await f.write('.gitattributes', 'selected.txt filter=hostile\n'); await f.git('add', '--', '.gitattributes'); }
      if (mutation === 'pending') await writeFile(path.join(gitDir, 'MERGE_HEAD'), f.observation.head_commit);
      if (mutation === 'replace') await f.git('update-ref', 'refs/replace/' + f.observation.head_commit, f.observation.head_commit);
      if (mutation === 'graft') await writeFile(path.join(gitDir, 'info', 'grafts'), f.observation.head_commit);
      if (mutation === 'alternate') await writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), gitDir);
      if (mutation === 'sparse') await f.git('config', 'core.sparseCheckout', 'true');
      if (mutation === 'assume') await f.git('update-index', '--assume-unchanged', 'selected.txt');
      await assert.rejects(f.prepare(), mutation);
    } finally { await f.close(); }
  }
});
test('cancellation during private staging removes only its owned scratch and leaves source untouched', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); f.host.signal = controller.signal;
    const before = await repositoryBytes(f.root);
    const beforeScratch = (await readdir(tmpdir())).filter(name => name.startsWith('strata-reconciliation-source-')).sort();
    const pending = f.prepare(); queueMicrotask(() => controller.abort(new Error('Synthetic cancellation')));
    await assert.rejects(pending, /Synthetic cancellation/); assert.deepEqual(await repositoryBytes(f.root), before);
    assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('strata-reconciliation-source-')).sort(), beforeScratch);
  } finally { await f.close(); }
});
test('unchanged selected binary and executable entries retain exact raw bytes and modes', async () => {
  const f = await fixture({ binary: true, executable: process.platform === 'win32' });
  try {
    const prepared = await f.prepare(), entry = prepared.immutableInputs.find(e => e.path === 'secondary.txt')!;
    assert.deepEqual(entry.bytes, Buffer.from([0, 255, 3]));
    assert.equal(entry.mode, process.platform === 'win32' ? '100755' : '100644');
    const plan = f.retainPrepared(prepared); await f.git('add', '--', 'selected.txt'); await f.git('commit', '-qm', 'Owner C');
    await captureCompletionSource(f.host, plan, await f.git('rev-parse', 'HEAD'), allow);
  } finally { await f.close(); }
});
test('missing objects, unrelated roots and merge ancestry refuse using raw parents', async () => {
  for (const mutation of ['root', 'merge', 'missing']) {
    const f = await fixture({ clean: true });
    try {
      const B = f.observation.head_commit, tree = f.observation.head_tree;
      if (mutation === 'root') await f.git('update-ref', 'HEAD', await f.git('commit-tree', tree, '-m', 'Unrelated root'));
      if (mutation === 'merge') {
        const peer = await f.git('commit-tree', tree, '-p', B, '-m', 'Synthetic peer');
        await f.git('update-ref', 'HEAD', await f.git('commit-tree', tree, '-p', B, '-p', peer, '-m', 'Synthetic merge'));
      }
      if (mutation !== 'missing') f.refresh();
      else await unlink(path.join(f.host.repositoryIdentity.commonDir, 'objects', B.slice(0, 2), B.slice(2)));
      const before = await repositoryBytes(f.root); await assert.rejects(f.prepare()); assert.deepEqual(await repositoryBytes(f.root), before);
    } finally { await f.close(); }
  }
});
test('an edit during awaited private staging is detected and preserved', async () => {
  const f = await fixture();
  try {
    const pending = f.prepare();
    const timer = setTimeout(() => writeFileSync(path.join(f.root, 'secondary.txt'), 'owner edit during private stage\n'), 0);
    try { await assert.rejects(pending, /changed after the exact capture/); } finally { clearTimeout(timer); }
    assert.equal(await readFile(path.join(f.root, 'secondary.txt'), 'utf8'), 'owner edit during private stage\n');
  } finally { await f.close(); }
});
test('transform refusal never invokes a configured source filter', async () => {
  const f = await fixture();
  try {
    const sentinel = path.join(f.root, 'filter-executed.txt');
    await f.git('config', 'filter.hostile.smudge', `node -e "require('fs').writeFileSync('${sentinel.replaceAll('\\', '/')}', 'EXECUTED')"`);
    await writeFile(path.join(f.host.repositoryIdentity.commonDir, 'info', 'attributes'), 'selected.txt filter=hostile\n');
    const repositoryIdentity = await resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' });
    assert.throws(() => captureReconciliationObservation({ ...f.host, repositoryIdentity }, f.scope, allow), /Checkout transforms/);
    await assert.rejects(readFile(sentinel), /ENOENT/);
  } finally { await f.close(); }
});
test('reviewed dirty index cannot complete at the same HEAD even when physical desired bytes match H', async () => {
  const f = await fixture({ clean: true });
  try {
    await f.write('selected.txt', 'staged-only\n'); await f.git('add', '--', 'selected.txt'); await f.write('selected.txt', 'value=1\nanchor\n'); f.refresh();
    const prepared = await f.prepare(), plan = f.retainPrepared(prepared);
    assert.equal(prepared.proof.trees.desired, prepared.proof.trees.head);
    await f.git('read-tree', 'HEAD');
    const before = await repositoryBytes(f.root);
    await assert.rejects(captureCompletionSource(f.host, plan, await f.git('rev-parse', 'HEAD'), allow), /reviewed clean H/);
    assert.deepEqual(await repositoryBytes(f.root), before);
  } finally { await f.close(); }
});
test('physical case aliases and mode-only index edits refuse without normalization', async () => {
  for (const mutation of ['case', 'mode']) {
    const f = await fixture();
    try {
      if (mutation === 'case') { await rename(path.join(f.root, 'selected.txt'), path.join(f.root, 'temporary.txt')); await rename(path.join(f.root, 'temporary.txt'), path.join(f.root, 'Selected.txt')); }
      else await f.git('update-index', '--chmod=+x', 'selected.txt');
      const before = await repositoryBytes(f.root); await assert.rejects(f.prepare()); assert.deepEqual(await repositoryBytes(f.root), before);
    } finally { await f.close(); }
  }
});
test('a linked owner worktree retains its common objects, refs, hooks and registration bytes', async () => {
  const f = await fixture({ clean: true }), linked = path.join(scratchRoot, 'linked-' + path.basename(f.root));
  try {
    await f.git('worktree', 'add', '--quiet', '--detach', linked, f.observation.head_commit);
    const repositoryIdentity = await resolveReconciliationRepository({ root: linked, projectId: 'synthetic', repoId: 'repo' });
    await writeFile(path.join(linked, 'selected.txt'), 'linked physical edit\nanchor\n');
    const host = { ...f.host, repositoryIdentity }, observation = captureReconciliationObservation(host, f.scope, allow).observation;
    host.report = f.retain('drift-report', { format: 'source-drift-report/2', project_id: 'synthetic', repo_id: 'repo',
      binding_ref: host.predecessor.ref, binding_sha256: host.predecessor.sha256, observation, observation_sha256: digest(observation) });
    const originalBefore = await repositoryBytes(f.root), linkedBefore = await repositoryBytes(linked);
    await prepareDesiredSource(host, f.scope, observation, 'accept_code', null, [], allow);
    assert.deepEqual(await repositoryBytes(f.root), originalBefore); assert.deepEqual(await repositoryBytes(linked), linkedBefore);
  } finally {
    assert.equal(path.dirname(path.resolve(linked)), scratchRoot);
    await f.git('worktree', 'remove', '--force', linked); await f.close();
  }
});
test('late guard refuses a moved canonical root or Git directory and never repairs it', async () => {
  for (const mutation of ['root', 'gitDir']) {
    const f = await fixture();
    try {
      const prepared = await f.prepare(), from = mutation === 'root' ? f.root : f.host.repositoryIdentity.gitDir, to = from + '-moved';
      await rename(from, to);
      try {
        assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, prepared.observation, f.scope));
        assert.ok((await lstat(to)).isDirectory()); await assert.rejects(lstat(from), /ENOENT/);
      }
      finally {
        // Do not repair the moved test source. Remove only its confirmed owned location.
        if (mutation === 'root') { assert.equal(path.dirname(path.resolve(to)), scratchRoot);
          assert.equal(to, f.root + '-moved'); await rm(to, { recursive: true, force: true }); }
      }
    } finally { await f.close(); }
  }
});
test('retained raw-object and patch-image limits refuse explicitly without truncation or original writes', async () => {
  const f = await fixture();
  try {
    await f.write('selected.txt', 'x'.repeat(512 * 1024 + 1)); f.refresh();
    const before = await repositoryBytes(f.root); await assert.rejects(f.prepare(), /512 KiB/); assert.deepEqual(await repositoryBytes(f.root), before);
    await f.write('selected.txt', 'line\n'.repeat(60000) + 'value=2\nanchor\n'); f.refresh();
    const patch = 'diff --git a/selected.txt b/selected.txt\n--- a/selected.txt\n+++ b/selected.txt\n@@ -60001,2 +60001,2 @@\n-value=2\n+value=0\n anchor\n';
    await assert.rejects(f.prepare('restore_intent', patch), /pre\/postimages exceed 512 KiB/);
  } finally { await f.close(); }
});
test('completion restarts with trusted preparation identity pins and refuses substituted pins', async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare(), plan = f.retainPrepared(prepared);
    await f.git('add', '--', 'selected.txt'); await f.git('commit', '-qm', 'Owner C');
    f.host.repositoryIdentity = await resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' });
    const C = await f.git('rev-parse', 'HEAD'), before = await repositoryBytes(f.root);
    await assert.rejects(captureCompletionSource(f.host, { ...plan, repositoryIdentity: { ...plan.repositoryIdentity, identity: digest('substituted root') } }, C, allow), /differs from preparation/);
    const final = await captureCompletionSource(f.host, plan, C, allow);
    assert.equal(final.proof.transition, 'direct-child'); assert.deepEqual(await repositoryBytes(f.root), before);
    assertLateSourceSynchronously(f.host.repositoryIdentity, final.observation, f.scope);
  } finally { await f.close(); }
});
test('host setup refuses external config includes and noncanonical true sparse/promisor settings', async () => {
  for (const mutation of ['include', 'sparse-yes', 'promisor-on']) {
    const f = await fixture();
    try {
      if (mutation === 'include') await f.git('config', 'include.path', path.join(f.root, 'not-authorized.config'));
      if (mutation === 'sparse-yes') await f.git('config', 'core.sparseCheckout', 'yes');
      if (mutation === 'promisor-on') await f.git('config', 'remote.origin.promisor', 'on');
      const before = await repositoryBytes(f.root);
      await assert.rejects(resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' }), /unsupported/i);
      assert.deepEqual(await repositoryBytes(f.root), before);
    } finally { await f.close(); }
  }
});
test('an oversized bound raw blob reports the retained-object limit even when its observed replacement is small', async () => {
  const f = await fixture({ largeBound: true });
  try {
    const before = await repositoryBytes(f.root);
    await assert.rejects(f.prepare(), error => (error as { code: string }).code === 'RECONCILIATION_RAW_OBJECT_LIMIT');
    assert.deepEqual(await repositoryBytes(f.root), before);
  } finally { await f.close(); }
});
test('implicit ignored or untracked rule inputs receive an exact grant before refusal, with no hidden content reads', async () => {
  const f = await fixture({ clean: true });
  try {
    await writeFile(path.join(f.host.repositoryIdentity.commonDir, 'info', 'exclude'), '.gitignore\n');
    await f.write('.gitignore', 'private.txt\n'); await f.write('private.txt', 'synthetic ignored canary\n');
    const repositoryIdentity = await resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' });
    const host = { ...f.host, repositoryIdentity }, before = await repositoryBytes(f.root);
    const calls: { name: string; use: string }[] = [];
    assert.throws(() => captureReconciliationObservation(host, f.scope, (name, use) => {
      calls.push({ name, use }); if (name === '.gitignore' && use === 'read') throw Error('Denied exact ignore read');
    }), /Denied exact ignore read/);
    assert.ok(calls.some(c => c.name === '.gitignore' && c.use === 'read'));
    assert.ok(!calls.some(c => c.name === 'private.txt' && c.use === 'read'));
    calls.length = 0;
    assert.throws(() => captureReconciliationObservation(host, f.scope, (name, use) => calls.push({ name, use })), /Untracked.*ignore rule/);
    assert.ok(!calls.some(c => c.name === 'private.txt' && c.use === 'read'));
    assert.deepEqual(await repositoryBytes(f.root), before);
  } finally { await f.close(); }
});
test('tracked root and nested ignore rules require exact reads and retain coherent pins', async () => {
  const f = await fixture({ clean: true });
  try {
    await mkdir(path.join(f.root, 'rules'));
    await f.write('.gitignore', 'root-private.txt\n'); await f.write('rules/.gitignore', 'nested-private.txt\n');
    await f.git('add', '--', '.gitignore', 'rules/.gitignore'); await f.git('commit', '-qm', 'Owner tracked ignore rules');
    await f.write('root-private.txt', 'root hidden canary\n'); await f.write('rules/nested-private.txt', 'nested hidden canary\n');
    const scope = structuredClone(f.scope);
    scope.exclusions.push({ path: '.gitignore', kind: 'file', reason: 'Tracked inventory configuration.' },
      { path: 'rules/.gitignore', kind: 'file', reason: 'Tracked inventory configuration.' });
    scope.exclusions.sort((a, b) => a.path < b.path ? -1 : 1);
    for (const denied of ['.gitignore', 'rules/.gitignore']) assert.throws(() => captureReconciliationObservation(f.host, scope, (name, use) => {
      if (name === denied && use === 'read') throw Error('Denied tracked ignore read');
    }), /Denied tracked ignore read/);
    const before = await repositoryBytes(f.root), calls: { name: string; use: string }[] = [];
    const authorize: AuthorizeSourcePath = (name, use) => {
      calls.push({ name, use }); if (name.endsWith('private.txt') && use === 'read') throw Error('Hidden canary read');
    };
    const captured = captureReconciliationObservation(f.host, scope, authorize);
    assert.equal(captured.observation.ignored_count, 2);
    assert.ok(['.gitignore', 'rules/.gitignore'].every(name => calls.some(c => c.name === name && c.use === 'read')));
    assertLateSourceSynchronously(f.host.repositoryIdentity, captured.observation, scope);
    await f.write('rules/.gitignore', '# same inventory, changed rule bytes\nnested-private.txt\n');
    assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, captured.observation, scope));
    // Only the owner's intentional rule edit changed; capture did not write the source/index/objects/refs.
    assert.deepEqual((await repositoryBytes(f.root)).filter(e => e.path !== 'rules/.gitignore'), before.filter(e => e.path !== 'rules/.gitignore'));
  } finally { await f.close(); }
});
test('external core.excludesFile configuration is rejected before its contents can be consumed', async () => {
  const f = await fixture(), outside = path.join(scratchRoot, path.basename(f.root) + '-outside-ignore');
  try {
    await writeFile(outside, 'private.txt\n'); await f.git('config', 'core.excludesFile', outside); await f.write('private.txt', 'hidden canary\n');
    const before = await repositoryBytes(f.root);
    await assert.rejects(resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' }), /configured excludes files.*unsupported/);
    assert.deepEqual(await repositoryBytes(f.root), before);
  } finally { assert.equal(path.dirname(path.resolve(outside)), scratchRoot); await rm(outside, { force: true }); await f.close(); }
});
test('recapture with equal serialized observations cannot refresh an older ignored-inventory guard', async () => {
  const f = await fixture({ clean: true });
  try {
    await writeFile(path.join(f.host.repositoryIdentity.commonDir, 'info', 'exclude'), 'ignored-*.txt\n');
    await f.write('ignored-old.txt', 'synthetic ignored contents\n');
    f.host.repositoryIdentity = await resolveReconciliationRepository({ root: f.root, projectId: 'synthetic', repoId: 'repo' });
    const first = captureReconciliationObservation(f.host, f.scope, allow);
    await rename(path.join(f.root, 'ignored-old.txt'), path.join(f.root, 'ignored-new.txt'));
    assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, first.observation, f.scope));
    const second = captureReconciliationObservation(f.host, f.scope, allow);
    assert.deepEqual(first.observation, second.observation);
    assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, first.observation, f.scope));
    assertLateSourceSynchronously(f.host.repositoryIdentity, second.observation, f.scope);
    assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, structuredClone(second.observation), f.scope), /captured by this host/);
    second.observation.ignored_count++;
    assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, second.observation, f.scope), /captured observation was mutated/);
  } finally { await f.close(); }
});
test('equal recaptures retain each original authorization callback and preparation returns its live guard', async () => {
  const f = await fixture({ clean: true });
  try {
    let denyOld = false;
    const first = captureReconciliationObservation(f.host, f.scope, (name, use) => {
      if (denyOld && name === 'selected.txt' && use === 'read') throw Error('Old capture read revoked');
    });
    denyOld = true;
    const second = captureReconciliationObservation(f.host, f.scope, allow);
    assert.deepEqual(first.observation, second.observation);
    assert.throws(() => assertLateSourceSynchronously(f.host.repositoryIdentity, first.observation, f.scope), /Old capture read revoked/);
    assertLateSourceSynchronously(f.host.repositoryIdentity, second.observation, f.scope);
    const reviewed = structuredClone(f.observation);
    const prepared = await prepareDesiredSource(f.host, f.scope, reviewed, 'accept_code', null, [], allow);
    assert.deepEqual(prepared.observation, reviewed); assert.notEqual(prepared.observation, reviewed);
    assertLateSourceSynchronously(f.host.repositoryIdentity, prepared.observation, f.scope);
  } finally { await f.close(); }
});
