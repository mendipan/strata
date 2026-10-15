import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesDigest, digest } from '../src/model.js';
import { applyExactPatchSection, verifyRawGitObject, verifyPlannedSourceProof, verifyCommittedSourceProof } from '../src/reconciliation-source-proof.js';
import { RECONCILIATION_LIMITS, recordPin } from '../src/reconciliation-records.js';
import { rawObject, rawTree, rawCommit, s1Fixture } from './fixtures/reconciliation-s1/fixtures.js';

for (const format of ['sha1', 'sha256'] as const) {
  test(`${format}: raw mode bytes cannot acquire an allowed mode through ASCII folding`, () => {
    const blob = rawObject('blob', 'selected\n', format);
    for (const mode of ['40000', '100644', '100755']) for (let i = 0; i < mode.length; i++) {
      const modeBytes = Buffer.from(mode); modeBytes[i] |= 0x80;
      const malformed = rawObject('tree', Buffer.concat([modeBytes, Buffer.from(' selected.txt\0'), Buffer.from(blob.oid, 'hex')]), format);
      assert.throws(() => verifyRawGitObject(malformed), /mode/);
    }
  });
  test(`${format}: complete rehashed source proof refuses high-bit endpoint mode bytes`, () => {
    const f = s1Fixture({ format, clean: true }), bytes = Buffer.from(f.boundTree.bytes_base64, 'base64');
    const offset = bytes.indexOf(Buffer.from('100644 selected.txt\0')); assert.ok(offset >= 0); bytes[offset] |= 0x80;
    const malformedTree = rawObject('tree', bytes, format), treePin = f.retain('reconciliation-git-object', malformedTree),
      commit = rawCommit(malformedTree.oid, [], format, 'Malformed endpoint'), commitPin = f.retain('reconciliation-git-object', commit);
    f.proof.objects = f.proof.objects.filter(pin => ![f.boundTree.oid, f.base.oid].includes(f.records[pin.ref].data.oid))
      .concat(treePin, commitPin).sort((a, b) => a.ref < b.ref ? -1 : 1);
    for (const endpoint of ['bound', 'head', 'observed', 'desired'] as const) f.proof.trees[endpoint] = malformedTree.oid;
    f.proof.base_commit_oid = commit.oid; f.proof.observed_head_oid = commit.oid; f.proof.ancestry_oids = [commit.oid];
    f.source.head_commit = commit.oid; f.source.head_tree = malformedTree.oid;
    f.proof.bound_source = f.retain('source-snapshot', f.source);
    const predecessor = structuredClone(f.records[f.proof.predecessor.ref].data);
    predecessor.payload.source_ref = f.proof.bound_source.ref; predecessor.payload.source_sha256 = f.proof.bound_source.sha256;
    predecessor.payload_sha256 = digest(predecessor.payload); f.proof.predecessor = f.retain('source-binding', predecessor);
    f.proof.observation.head_commit = commit.oid; f.proof.observation.head_tree = malformedTree.oid;
    f.proof.observation_sha256 = digest(f.proof.observation);
    f.proof.report = f.retain('drift-report', { format: 'source-drift-report/2', project_id: f.proof.project_id, repo_id: f.proof.repo_id,
      binding_ref: f.proof.predecessor.ref, binding_sha256: f.proof.predecessor.sha256,
      observation: f.proof.observation, observation_sha256: f.proof.observation_sha256 });
    assert.throws(() => verifyPlannedSourceProof(f.read, f.proof), /mode/);
  });
  test(`${format}: committed verification preserves the prepared pool's independent exact-use invariant`, () => {
    const f = s1Fixture({ format });
    f.proof.objects.push(recordPin('reconciliation-git-object', f.finalCommit)); f.proof.objects.sort((a, b) => a.ref < b.ref ? -1 : 1);
    const prepared = f.retain('reconciliation-source-proof', f.proof);
    assert.throws(() => verifyPlannedSourceProof(f.read, f.proof), /unused raw objects/);
    f.body.source_proof = prepared; f.plan.body_sha256 = digest(f.body);
    const auth = structuredClone(f.records[f.plan.auth.ref].data);
    auth.action_input.plan_body_sha256 = digest(f.body); auth.action_input_sha256 = digest(auth.action_input);
    f.plan.auth = f.retain('reconciliation-auth', auth); f.committed.plan = f.retain('reconciliation-proposal', f.plan);
    f.committed.prepared = prepared; f.committed.additional_objects = [];
    assert.throws(() => verifyCommittedSourceProof(f.read, f.committed), /unused raw objects/);
  });
  test(`${format}: raw objects and dirty accept to direct child verify from retained bytes`, () => {
    const f = s1Fixture({ format });
    for (const row of Object.values(f.records).filter(r => r.type === 'reconciliation-git-object')) verifyRawGitObject(row.data);
    const planned = verifyPlannedSourceProof(f.read, f.proof), final = verifyCommittedSourceProof(f.read, f.committed);
    assert.deepEqual(planned.binding_delta_paths, ['selected.txt']);
    assert.equal(final.source_snapshot.head_commit, f.finalCommit.oid);
    assert.equal(final.live_source_checked, false); assert.equal(final.live_authority_checked, false);
  });
  test(`${format}: already clean H needs no fake receipt or empty commit`, () => {
    const f = s1Fixture({ format, clean: true, sameHead: true });
    assert.deepEqual(verifyPlannedSourceProof(f.read, f.proof).binding_delta_paths, []);
    assert.equal(verifyCommittedSourceProof(f.read, f.committed).proof.owner_commit_oid, f.head.oid);
  });
  test(`${format}: restore committed drift preserves a mapped physical edit outside patch`, () => {
    const f = s1Fixture({ format, action: 'restore_intent', edges: 2 });
    const result = verifyPlannedSourceProof(f.read, f.proof);
    assert.deepEqual(result.binding_delta_paths, ['secondary.txt', 'selected.txt']);
    assert.ok(result.preservation.observed_outside_patch_preserved);
    assert.equal(result.endpoint_trees.observed.find(e => e.path === 'secondary.txt')!.oid,
      result.endpoint_trees.desired.find(e => e.path === 'secondary.txt')!.oid);
    verifyCommittedSourceProof(f.read, f.committed);
  });
}
test('raw identity refuses malformed lengths/types/base64/OIDs/SHA and object-format substitution', () => {
  const valid = rawObject('blob', 'plain\n');
  for (const edit of [
    (v: any) => v.byte_length++, (v: any) => v.kind = 'tree', (v: any) => v.kind = 'tag',
    (v: any) => v.bytes_base64 += '\n', (v: any) => v.bytes_base64 = 'AB==',
    (v: any) => v.oid = 'a'.repeat(40), (v: any) => v.raw_sha256 = 'b'.repeat(64),
    (v: any) => v.object_format = 'sha256', (v: any) => v.claimed_verified = true,
  ]) { const value = structuredClone(valid); edit(value); assert.throws(() => verifyRawGitObject(value)); }
  assert.throws(() => verifyRawGitObject(rawObject('blob', Buffer.alloc(RECONCILIATION_LIMITS.rawObject + 1))));
});
test('raw trees refuse aliases, duplicates, traversal, metadata, reserved names, unsupported kinds and truncation', () => {
  const blob = rawObject('blob', 'a');
  for (const rows of [
    ['same', 'same'], ['Name', 'name'], ['b', 'a'], ['../x'], ['dir/file'], ['.git'], ['NUL'], ['trailing.'],
  ]) assert.throws(() => verifyRawGitObject(rawTree(rows.map(name => ({ name, mode: '100644', oid: blob.oid })) )));
  for (const mode of ['040000', '100664', '120000', '160000']) assert.throws(() => verifyRawGitObject(rawTree([{ name: 'file', mode, oid: blob.oid }])));
  assert.throws(() => verifyRawGitObject(rawObject('tree', Buffer.from('100644 file\0short'))));
  assert.throws(() => verifyRawGitObject(rawObject('tree', Buffer.concat([Buffer.from('100644 café\0'), Buffer.from(blob.oid, 'hex')]))));
});
test('raw commit parser refuses duplicate tree, duplicate identity, malformed parents and continuations', () => {
  const tree = '1'.repeat(40);
  for (const raw of [
    `tree ${tree}\ntree ${tree}\nauthor X\ncommitter X\n\nx`,
    `tree ${tree}\nparent 123\nauthor X\ncommitter X\n\nx`,
    `tree ${tree}\n continuation\nauthor X\ncommitter X\n\nx`,
    `tree ${tree}\nauthor X\nauthor X\ncommitter X\n\nx`,
    `tree ${tree}\nauthor X\nparent ${tree}\ncommitter X\n\nx`,
    `tree ${tree}\nno boundary`,
  ]) assert.throws(() => verifyRawGitObject(rawObject('commit', raw)));
});
test('missing tree/blob, duplicate/unused object and forged selected SHA refuse', () => {
  for (const kind of ['tree', 'blob']) {
    const f = s1Fixture(); const pin = f.proof.objects.find(p => f.records[p.ref].data.kind === kind)!;
    delete f.records[pin.ref]; assert.throws(() => verifyPlannedSourceProof(f.read, f.proof));
  }
  const duplicate = s1Fixture(); duplicate.proof.objects.push(duplicate.proof.objects[0]);
  assert.throws(() => verifyPlannedSourceProof(duplicate.read, duplicate.proof));
  const unused = s1Fixture(); unused.proof.objects.push(unused.retain('reconciliation-git-object', rawObject('blob', 'unused')));
  unused.proof.objects.sort((a, b) => a.ref < b.ref ? -1 : 1); assert.throws(() => verifyPlannedSourceProof(unused.read, unused.proof), /unused/);
  const forged = s1Fixture(); forged.proof.selected.desired[1].sha256 = digest('forged');
  assert.throws(() => verifyPlannedSourceProof(forged.read, forged.proof), /Selected raw/);
});
test('raw ancestry refuses altered parent, merge, unrelated root and 257 edges; 256 passes', () => {
  const unrelated = 'e'.repeat(40);
  for (const parents of [[unrelated], [unrelated, 'f'.repeat(40)], []]) {
    const f = s1Fixture({ edges: 1, headParents: parents });
    assert.throws(() => verifyPlannedSourceProof(f.read, f.proof), /single-parent chain|Merge commits/);
  }
  const max = s1Fixture({ edges: 256 }); verifyPlannedSourceProof(max.read, max.proof);
  const over = s1Fixture({ edges: 257 }); assert.throws(() => verifyPlannedSourceProof(over.read, over.proof));
});
test('outside mapping/tree alteration and mismatched patch result refuse after hashes are recomputed', () => {
  const outside = s1Fixture({ outsideChange: true });
  assert.throws(() => verifyPlannedSourceProof(outside.read, outside.proof), /full-tree change/);
  const patch = s1Fixture({ action: 'restore_intent' });
  patch.proof.patch = patch.proof.patch!.replace('+value=0', '+value=9'); patch.proof.patch_sha256 = bytesDigest(patch.proof.patch);
  assert.throws(() => verifyPlannedSourceProof(patch.read, patch.proof), /patch result/);
  const context = s1Fixture({ action: 'restore_intent' });
  context.proof.patch = context.proof.patch!.replace(' anchor', ' incorrect'); context.proof.patch_sha256 = bytesDigest(context.proof.patch);
  assert.throws(() => verifyPlannedSourceProof(context.read, context.proof), /preimage/);
  const coordinate = s1Fixture({ action: 'restore_intent' });
  coordinate.proof.patch = coordinate.proof.patch!.replace('@@ -1,2 +1,2 @@', '@@ -2,2 +2,2 @@'); coordinate.proof.patch_sha256 = bytesDigest(coordinate.proof.patch);
  assert.throws(() => verifyPlannedSourceProof(coordinate.read, coordinate.proof));
});
test('proof object/raw aggregate, tree-entry and path-closure limits refuse without truncation', () => {
  const bytes = s1Fixture();
  for (let i = 0; i < 33; i++) bytes.proof.objects.push(bytes.retain('reconciliation-git-object', rawObject('blob', Buffer.alloc(512 * 1024, i))));
  bytes.proof.objects.sort((a, b) => a.ref < b.ref ? -1 : 1);
  assert.throws(() => verifyPlannedSourceProof(bytes.read, bytes.proof), /16 MiB/);
  const count = s1Fixture(); count.proof.objects = Array.from({ length: 8193 }, (_, i) => ({ ref: `reconciliation-git-object@${i.toString(16).padStart(64, '0')}`, sha256: i.toString(16).padStart(64, '0') }));
  assert.throws(() => verifyPlannedSourceProof(count.read, count.proof));
  const blob = rawObject('blob', 'x'), huge = rawTree(Array.from({ length: 5001 }, (_, i) => ({ name: `file${i.toString().padStart(5, '0')}`, mode: '100644', oid: blob.oid })));
  assert.throws(() => verifyRawGitObject(huge), /5,000 entries/);
});
test('final transition refuses dirty same-head, wrong parent/tree, extra objects and altered selected snapshot', () => {
  const dirty = s1Fixture({ sameHead: true }); assert.throws(() => verifyCommittedSourceProof(dirty.read, dirty.committed));
  for (const parents of [[], ['d'.repeat(40)], ['d'.repeat(40), 'e'.repeat(40)]]) {
    const f = s1Fixture({ finalParents: parents }); assert.throws(() => verifyCommittedSourceProof(f.read, f.committed));
  }
  const wrong = s1Fixture(); const altered = rawCommit(wrong.boundTree.oid, [wrong.head.oid]);
  const pin = wrong.retain('reconciliation-git-object', altered); wrong.committed.additional_objects = [pin]; wrong.committed.owner_commit_oid = altered.oid;
  assert.throws(() => verifyCommittedSourceProof(wrong.read, wrong.committed), /desired full tree/);
  const extra = s1Fixture(); extra.committed.additional_objects.push(extra.retain('reconciliation-git-object', rawObject('blob', 'unrelated')));
  extra.committed.additional_objects.sort((a, b) => a.ref < b.ref ? -1 : 1); assert.throws(() => verifyCommittedSourceProof(extra.read, extra.committed), /unused/);
  const snapshot = s1Fixture(), source = structuredClone(snapshot.records[snapshot.committed.source_snapshot.ref].data);
  source.entries[0].sha256 = digest('fake'); source.manifest_sha256 = digest(source.entries);
  snapshot.committed.source_snapshot = snapshot.retain('source-snapshot', source);
  assert.throws(() => verifyCommittedSourceProof(snapshot.read, snapshot.committed), /Final snapshot/);
});
test('changed index/final observation cannot substitute the approved construction', () => {
  const f = s1Fixture(); f.committed.observation.entries[0].sha256 = digest('other bytes');
  f.committed.observation.manifest_sha256 = digest(f.committed.observation.entries); f.committed.observation_sha256 = digest(f.committed.observation);
  assert.throws(() => verifyCommittedSourceProof(f.read, f.committed));
  assert.equal(recordPin('reconciliation-source-proof', s1Fixture().proof).ref.startsWith('reconciliation-source-proof@'), true);
});
test('exact patch reconstruction supports additions, deletions, no newline and multiple hunks without fuzz', () => {
  assert.equal(applyExactPatchSection('diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1,2 @@\n+added\n+anchor\n', null, 'file.txt'), 'added\nanchor\n');
  assert.equal(applyExactPatchSection('diff --git a/file.txt b/file.txt\ndeleted file mode 100644\n--- a/file.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-old\n-anchor\n', 'old\nanchor\n', 'file.txt'), null);
  assert.equal(applyExactPatchSection('diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n anchor\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', 'anchor\nold', 'file.txt'), 'anchor\nnew');
  assert.equal(applyExactPatchSection('diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -4,2 +4,2 @@\n-d\n+D\n e\n', 'a\nb\nc\nd\ne\n', 'file.txt'), 'A\nb\nc\nD\ne\n');
  assert.throws(() => applyExactPatchSection('diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n anchor\n-old\n+new\n', 'prefix\nanchor\nold\n', 'file.txt'));
});
test('a verified /2 binding can supply the next planned proof without live predecessor endorsement lookup', () => {
  const first = s1Fixture(), next = s1Fixture({ clean: true }); const p = next.proof;
  p.predecessor = first.bindingPin; p.bound_source = first.committed.source_snapshot;
  p.base_commit_oid = first.finalCommit.oid; p.observed_head_oid = first.finalCommit.oid; p.ancestry_oids = [first.finalCommit.oid];
  p.observation.head_commit = first.finalCommit.oid; p.observation_sha256 = digest(p.observation);
  p.objects = p.objects.filter(pin => next.records[pin.ref].data.oid !== next.base.oid);
  p.objects.push(recordPin('reconciliation-git-object', first.finalCommit)); p.objects.sort((a, b) => a.ref < b.ref ? -1 : 1);
  p.report = next.retain('drift-report', { format: 'source-drift-report/2', project_id: p.project_id, repo_id: p.repo_id,
    binding_ref: first.bindingPin.ref, binding_sha256: first.bindingPin.sha256, observation: p.observation, observation_sha256: p.observation_sha256 });
  const records = { ...first.records, ...next.records };
  const result = verifyPlannedSourceProof((pin, type) => { assert.equal(records[pin.ref].type, type); return records[pin.ref].data; }, p);
  assert.deepEqual(result.binding_delta_paths, []);
});
