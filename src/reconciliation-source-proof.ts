import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { bytesDigest, canonical, digest, fail, parse } from './model.js';
import { sourceBindingSchema, validateGitObservation, validateSourceSnapshot, validateSourceScope, pathInScope, pathExcluded } from './source-binding.js';
import { RECONCILIATION_LIMITS as L, gitObjectSchema, plannedProofSchema, committedProofSchema, planSchema,
  bindingSchema, recordPin, readPinned, same, orderedSet, reconciliationPath, normalizePlanBody,
  type GitObject, type PlannedProof, type CommittedProof, type Pin, type TypedRecordReader } from './reconciliation-records.js';

export type TreeEntry = { path: string; mode: '100644' | '100755'; oid: string };
type RawTreeEntry = { name: string; mode: '40000' | '100644' | '100755'; oid: string };
export type ParsedGitObject = { record: GitObject; bytes: Buffer } & (
  { kind: 'blob' } | { kind: 'tree'; entries: RawTreeEntry[] } | { kind: 'commit'; tree: string; parents: string[] });
function bad(message: string): never { fail('RECONCILIATION_GIT_PROOF', 6, message); }
function oid(value: string, format: 'sha1' | 'sha256'): string {
  if (!new RegExp(`^[a-f0-9]{${format === 'sha1' ? 40 : 64}}$`).test(value)) bad('Git OID has the wrong object-format length.');
  return value;
}
function utf8(bytes: Buffer): string {
  try { const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (value.includes('\0') || !Buffer.from(value).equals(bytes)) bad('Patch images must be exact UTF-8 without NUL.'); return value;
  } catch { return bad('Patch images must be exact UTF-8 without NUL.'); }
}
export function verifyRawGitObject(input: GitObject): ParsedGitObject {
  if (input.byte_length > L.rawObject || input.bytes_base64.length > Math.ceil(L.rawObject / 3) * 4)
    fail('RECONCILIATION_RAW_OBJECT_LIMIT', 8, 'Raw Git object exceeds 512 KiB.');
  const record = parse(gitObjectSchema, input), encoded = record.bytes_base64;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) bad('Git bytes require canonical base64.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length !== record.byte_length) bad('Git object base64 or raw length disagrees.');
  same(bytesDigest(bytes), record.raw_sha256, 'Raw Git SHA-256 disagrees.');
  const measured = createHash(record.object_format).update(`${record.kind} ${bytes.length}\0`).update(bytes).digest('hex');
  if (oid(record.oid, record.object_format) !== measured) bad('Raw bytes do not produce the declared Git OID.');
  if (record.kind === 'blob') return { record, bytes, kind: 'blob' };
  if (record.kind === 'commit') {
    const end = bytes.indexOf(Buffer.from('\n\n'));
    if (end < 0) bad('Commit has no complete header boundary.');
    const headers = bytes.subarray(0, end).toString('latin1').split('\n');
    if (!/^tree [a-f0-9]+$/.test(headers[0])) bad('Commit must begin with one raw tree header.');
    let tree = '', parents: string[] = [], previous = '', parentsEnded = false;
    const singular = new Set<string>();
    for (const row of headers) {
      if (row.startsWith(' ')) { if (!previous || ['tree', 'parent'].includes(previous)) bad('Invalid commit continuation.'); continue; }
      const match = /^([a-z][a-z0-9-]*) (.*)$/.exec(row);
      if (!match || row.includes('\r') || row.includes('\0')) bad('Malformed raw commit header.');
      const [_, key, value] = match; previous = key;
      if (key === 'tree') { if (tree) bad('Duplicate commit tree.'); tree = oid(value, record.object_format); }
      else if (key === 'parent') { if (parentsEnded) bad('Noncontiguous raw parent headers.'); parents.push(oid(value, record.object_format)); }
      else { parentsEnded = true; if (['author', 'committer'].includes(key)) {
        if (singular.has(key)) bad('Duplicate commit identity header.'); singular.add(key);
      } }
    }
    if (!singular.has('author') || !singular.has('committer') || new Set(parents).size !== parents.length) bad('Commit identity or parent headers are invalid.');
    return { record, bytes, kind: 'commit', tree, parents };
  }
  const entries: RawTreeEntry[] = [], width = record.object_format === 'sha1' ? 20 : 32;
  let offset = 0, prior: Buffer | null = null;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1);
    if (space < offset || nul < space || nul + 1 + width > bytes.length) bad('Truncated raw tree entry.');
    const modeBytes = bytes.subarray(offset, space), nameBytes = bytes.subarray(space + 1, nul);
    // ASCII decoding folds high bits; recognize only the exact canonical raw byte strings.
    const mode = (['40000', '100644', '100755'] as const).find(value => modeBytes.equals(Buffer.from(value, 'ascii')));
    if (!mode) bad('Tree contains an unsupported kind or noncanonical mode.');
    if (nameBytes.some((b: number) => b > 127)) bad('Tree names require portable ASCII.');
    const name = reconciliationPath(nameBytes.toString('ascii'));
    if (name.includes('/')) bad('A raw tree entry name must be a single component.');
    const order = Buffer.concat([nameBytes, Buffer.from(mode === '40000' ? '/' : '\0')]);
    if (prior && Buffer.compare(prior, order) >= 0) bad('Raw tree entries are duplicate or out of Git order.');
    prior = order;
    entries.push({ name, mode, oid: bytes.subarray(nul + 1, nul + 1 + width).toString('hex') });
    offset = nul + 1 + width;
    if (entries.length > L.endpointEntries) fail('RECONCILIATION_TREE_LIMIT', 8, 'Raw tree exceeds 5,000 entries.');
  }
  orderedSet(entries.map(e => e.name).sort(), 'Raw tree names', true);
  return { record, bytes, kind: 'tree', entries };
}
class Objects {
  byOid = new Map<string, { pin: Pin; object: ParsedGitObject }>();
  used = new Set<string>();
  rawBytes = 0;
  constructor(read: TypedRecordReader, pins: Pin[], format: 'sha1' | 'sha256') {
    orderedSet(pins.map(p => p.ref), 'Object pins');
    if (pins.length > L.objects) fail('RECONCILIATION_OBJECT_LIMIT', 8, 'Proof exceeds 8,192 distinct objects.');
    for (const pin of pins) {
      const object = verifyRawGitObject(readPinned(read, pin, 'reconciliation-git-object'));
      same(object.record.object_format, format, 'Mixed Git object formats.');
      if (this.byOid.has(object.record.oid)) bad('Duplicate raw Git OID.');
      this.rawBytes += object.bytes.length;
      if (this.rawBytes > L.rawBytes) fail('RECONCILIATION_OBJECT_BYTES', 8, 'Distinct raw Git objects exceed 16 MiB.');
      this.byOid.set(object.record.oid, { pin, object });
    }
  }
  get(id: string, kind: ParsedGitObject['kind']): ParsedGitObject {
    const row = this.byOid.get(id); if (!row || row.object.kind !== kind) bad(`Missing or wrong-kind retained ${kind} object.`);
    this.used.add(id); return row.object;
  }
  tree(id: string): TreeEntry[] {
    const result: TreeEntry[] = [], stack = new Set<string>(); let count = 0;
    const walk = (tree: string, prefix: string) => {
      if (stack.has(tree)) bad('Cyclic tree closure.'); stack.add(tree);
      const object = this.get(tree, 'tree'); if (object.kind !== 'tree') return bad('Wrong tree object.');
      if (prefix && !object.entries.length) bad('Empty nested tree directories cannot be ordinary source entries.');
      for (const row of object.entries) {
        if (++count > L.endpointEntries) fail('RECONCILIATION_TREE_LIMIT', 8, 'Endpoint tree exceeds 5,000 entries.');
        const path = reconciliationPath(prefix + row.name);
        if (row.mode === '40000') { if (path.split('/').length >= 120) bad('Tree nesting exceeds the portable path bound.'); walk(row.oid, path + '/'); }
        else result.push({ path, mode: row.mode, oid: row.oid });
      }
      stack.delete(tree);
    };
    walk(id, ''); result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    orderedSet(result.map(e => e.path), 'Endpoint paths', true); return result;
  }
  assertUsed() { if (this.used.size !== this.byOid.size) bad('Proof contains unused raw objects.'); }
}
type Entry = PlannedProof['selected']['bound'][number];
function sourceEntry(e: Entry) {
  return { path: e.path, presence: e.presence, kind: e.presence === 'present' ? 'regular' : null,
    mode: e.mode, byte_length: e.byte_length, sha256: e.sha256 };
}
function bindEntries(pool: Objects, entries: Entry[], tree: TreeEntry[]): void {
  for (const e of entries) {
    const row = tree.find(r => r.path === e.path);
    if (e.presence === 'absent') { if (row) bad('Absent selected entry exists in the endpoint tree.'); continue; }
    const raw = readBlob(pool, e.blob);
    if (!row || row.oid !== raw.record.oid || row.mode !== e.mode || e.byte_length !== raw.bytes.length || e.sha256 !== bytesDigest(raw.bytes)) bad('Selected raw bytes/mode/length/SHA do not match the tree.');
  }
}
function readBlob(pool: Objects, pin: Pin): ParsedGitObject & { kind: 'blob' } {
  const found = [...pool.byOid.values()].find(row => row.pin.ref === pin.ref);
  if (!found || canonical(found.pin) !== canonical(pin)) bad('Selected blob pin is missing.');
  const object = pool.get(found.object.record.oid, 'blob');
  if (object.kind !== 'blob') return bad('Selected object is not a blob.'); return object;
}
function delta(a: TreeEntry[], b: TreeEntry[]): string[] {
  const before = new Map(a.map(e => [e.path, e])), after = new Map(b.map(e => [e.path, e]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(p => canonical(before.get(p) ?? null) !== canonical(after.get(p) ?? null));
}
function projectBinding(read: TypedRecordReader, proof: PlannedProof) {
  const binding = readPinned(read, proof.predecessor, 'source-binding');
  if (binding.format === 'source-binding/2') {
    const b = parse(bindingSchema, binding); same(b.payload_sha256, digest(b.payload), 'Binding payload digest disagrees.');
    return { source: b.payload.source, project_id: b.payload.project_id, repo_id: b.payload.repo_id };
  }
  if (binding.format !== 'source-binding/1') bad('Unsupported predecessor binding version.');
  parse(sourceBindingSchema, binding);
  // Full legacy acceptance/semantic validation remains with the versioned history verifier.
  same(binding.payload_sha256, digest(binding.payload), 'Legacy binding payload digest disagrees.');
  return { source: { ref: binding.payload.source_ref, sha256: binding.payload.source_sha256 },
    project_id: binding.payload.project_id, repo_id: binding.payload.repo_id };
}
export function applyExactPatchSection(patch: string, before: string | null, path: string): string | null {
  reconciliationPath(path);
  if (path.split('/').some(p => p.toLowerCase().startsWith('.git'))) bad('Patches cannot modify Git metadata paths.');
  if (!patch || Buffer.byteLength(patch) > L.patchBytes || /[\r\0]/.test(patch)) bad('Patch section must be bounded LF UTF-8.');
  const lines = patch.split('\n'), header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[0]);
  if (!header || header[1] !== path || header[2] !== path) bad('Patch header destination disagrees.');
  let i = 1, added = false, deleted = false;
  while (i < lines.length && !lines[i].startsWith('--- ')) {
    const line = lines[i++];
    if (line === 'new file mode 100644' && !added) added = true;
    else if (/^deleted file mode 100(?:644|755)$/.test(line) && !deleted) deleted = true;
    else if (!/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100(?:644|755))?$/.test(line)) bad('Unsupported patch metadata.');
  }
  if (added && deleted || added !== (before === null) || lines[i++] !== `--- ${added ? '/dev/null' : 'a/' + path}` || lines[i++] !== `+++ ${deleted ? '/dev/null' : 'b/' + path}`) bad('Patch addition/deletion/header disagrees with exact preimage.');
  const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const source = split(before ?? ''), output: string[] = []; let cursor = 0, hunks = 0;
  while (i < lines.length && !(i === lines.length - 1 && lines[i] === '')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[i++]);
    if (!h) bad('Expected a unified diff hunk.');
    const oldCount = Number(h[2] ?? 1), newCount = Number(h[4] ?? 1), oldStart = Number(h[1]), newStart = Number(h[3]);
    if (![oldCount, newCount, oldStart, newStart].every(Number.isSafeInteger) || (oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) bad('Invalid hunk coordinates.');
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    if (start < cursor || start > source.length) bad('Hunk cannot apply at its exact coordinate.');
    output.push(...source.slice(cursor, start)); cursor = start;
    if ((newCount === 0 ? newStart : newStart - 1) !== output.length) bad('Hunk postimage coordinate disagrees.');
    const old: string[] = [], next: string[] = []; let context = 0, previous = '';
    while (i < lines.length && !lines[i].startsWith('@@ ') && !(i === lines.length - 1 && lines[i] === '')) {
      const line = lines[i++];
      if (line === '\\ No newline at end of file') {
        if (!previous || previous === '!') bad('Misplaced no-newline marker.');
        if (previous !== '+') old[old.length - 1] = old.at(-1)!.slice(0, -1);
        if (previous !== '-') next[next.length - 1] = next.at(-1)!.slice(0, -1);
        previous = '!'; continue;
      }
      if (![' ', '-', '+'].includes(line[0])) bad('Malformed hunk content.'); previous = line[0];
      if (line[0] !== '+') old.push(line.slice(1) + '\n');
      if (line[0] !== '-') next.push(line.slice(1) + '\n');
      if (line[0] === ' ') context++;
    }
    if (old.length !== oldCount || next.length !== newCount || !added && !deleted && !context) bad('Hunk counts or edit context disagree.');
    same(source.slice(cursor, cursor + old.length), old, 'Patch context/preimage differs at the exact hunk position.');
    output.push(...next); cursor += old.length; hunks++;
  }
  if (!hunks) bad('Patch has no hunks.'); output.push(...source.slice(cursor));
  if (output.slice(0, -1).some(line => !line.endsWith('\n'))) bad('No-newline marker must describe the end of the file.');
  const result = output.join(''); if (deleted && result !== '') bad('Deletion did not remove the complete preimage.');
  return deleted ? null : result;
}
function verifyPatch(pool: Objects, p: PlannedProof, observed: TreeEntry[], desired: TreeEntry[]) {
  if (p.patch === null) {
    if (p.action === 'restore_intent' || p.patch_sha256 !== null || p.operations.length || p.restore_paths.length) bad('Action/patch operations disagree.');
    same(observed, desired, 'Accept/update desired tree must equal physical observation tree.'); return;
  }
  if (p.action !== 'restore_intent' || !p.patch || Buffer.byteLength(p.patch) > L.patchBytes || /[\r\0]/.test(p.patch)) bad('Restoration requires one bounded LF UTF-8 patch.');
  same(bytesDigest(p.patch), p.patch_sha256, 'Patch digest disagrees.');
  const sections = p.patch.split(/(?=^diff --git )/m).filter(Boolean), names = sections.map(s => {
    const match = /^diff --git a\/(\S+) b\/(\S+)\n/.exec(s); if (!match || match[1] !== match[2]) bad('Patch renames/quoted paths/preamble are unsupported.');
    return reconciliationPath(match[1]);
  });
  if (!names.length || names.length > L.patchPaths || new Set(names).size !== names.length) bad('Patch must change one to 64 unique files.');
  const changed = delta(observed, desired); same(changed, [...names].sort(), 'Actual restored tree delta differs from patch operations.');
  same(p.restore_paths, changed, 'Restore paths must be exactly the supplied patch destinations.');
  same(p.operations.map(o => o.path), changed, 'Retained operations differ from patch delta.');
  let images = 0;
  for (const operation of p.operations) {
    if (!p.restore_paths.includes(operation.path)) bad('Patch operation is outside explicit restore paths.');
    same(operation.before, p.selected.observed.find(e => e.path === operation.path), 'Patch preimage binding differs.');
    same(operation.after, p.selected.desired.find(e => e.path === operation.path), 'Patch postimage binding differs.');
    const before = operation.before.presence === 'present' ? readBlob(pool, operation.before.blob).bytes : null;
    const after = operation.after.presence === 'present' ? readBlob(pool, operation.after.blob).bytes : null;
    images += (before?.length ?? 0) + (after?.length ?? 0);
    if (images > L.patchImages) fail('RECONCILIATION_PATCH_LIMIT', 8, 'Combined patch pre/postimages exceed 512 KiB.');
    const result = applyExactPatchSection(sections[names.indexOf(operation.path)], before === null ? null : utf8(before), operation.path);
    same(result, after === null ? null : utf8(after), 'Retained desired bytes differ from deterministic patch result.');
  }
}
export type VerifiedPlannedSource = { proof: PlannedProof; proof_pin: Pin; endpoint_trees: { bound: TreeEntry[]; head: TreeEntry[]; observed: TreeEntry[]; desired: TreeEntry[] };
  binding_delta_paths: string[]; preservation: { binding_delta_within_mapped_paths: { proof: Pin; from: string; to: string };
    observed_outside_patch_preserved: { proof: Pin; from: string; to: string } | null } };
function verifyPlanned(read: TypedRecordReader, input: PlannedProof, pool: Objects): VerifiedPlannedSource {
  const p = parse(plannedProofSchema, input); validateSourceScope(p.scope);
  const source = validateSourceSnapshot(readPinned(read, p.bound_source, 'source-snapshot')), binding = projectBinding(read, p);
  same([binding.project_id, binding.repo_id, binding.source], [p.project_id, p.repo_id, p.bound_source], 'Predecessor source association disagrees.');
  same([source.project_id, source.repo_id, source.object_format, source.scope, source.head_commit, source.head_tree],
    [p.project_id, p.repo_id, p.object_format, p.scope, p.base_commit_oid, p.trees.bound], 'Bound snapshot differs from proof.');
  const report = readPinned(read, p.report, 'drift-report');
  if (report.format !== 'source-drift-report/2') bad('New preparation requires an explicit /2 drift report.');
  same([report.project_id, report.repo_id, report.binding_ref, report.binding_sha256, report.observation, report.observation_sha256],
    [p.project_id, p.repo_id, p.predecessor.ref, p.predecessor.sha256, p.observation, p.observation_sha256], 'Report observation/predecessor differs from source proof.');
  const o = validateGitObservation(p.observation, p.scope);
  same([o.project_id, o.repo_id, o.object_format, o.head_commit, o.head_tree, digest(o)],
    [p.project_id, p.repo_id, p.object_format, p.observed_head_oid, p.trees.head, p.observation_sha256], 'Physical observation identity disagrees.');
  if (o.coherence !== 'stable' || o.outside_scope_dirty || o.unsupported.length || o.trust !== 'local-measurement') bad('Source observation is incomplete or unsupported.');
  for (const id of [p.base_commit_oid, p.observed_head_oid, ...p.ancestry_oids, ...Object.values(p.trees)]) oid(id, p.object_format);
  if (p.ancestry_oids[0] !== p.base_commit_oid || p.ancestry_oids.at(-1) !== p.observed_head_oid || new Set(p.ancestry_oids).size !== p.ancestry_oids.length) bad('Ancestry endpoints/order disagree.');
  p.ancestry_oids.forEach((id, i) => {
    const c = pool.get(id, 'commit'); if (c.kind !== 'commit') return bad('Wrong commit object.');
    if (c.parents.length > 1) bad('Merge commits are unsupported in retained reconciliation ancestry.');
    if (i > 0 && (c.parents.length !== 1 || c.parents[0] !== p.ancestry_oids[i - 1])) bad('Observed ancestry must be a bounded raw single-parent chain from B.');
    if (i === 0) same(c.tree, p.trees.bound, 'B tree differs.');
    if (i === p.ancestry_oids.length - 1) same(c.tree, p.trees.head, 'H tree differs.');
  });
  const trees = { bound: pool.tree(p.trees.bound), head: pool.tree(p.trees.head), observed: pool.tree(p.trees.observed), desired: pool.tree(p.trees.desired) };
  const selectedPaths = p.selected.bound.map(e => e.path), mapped = [...new Set(p.scope.mapping.flatMap(m => m.paths))].sort();
  same(p.selected.bound.map(sourceEntry), source.entries, 'Bound selected manifest differs from predecessor snapshot.');
  for (const phase of ['bound', 'observed', 'desired'] as const) {
    same(p.selected[phase].map(e => e.path), selectedPaths, 'All selected phases must retain the exact path inventory.');
    bindEntries(pool, p.selected[phase], trees[phase]);
    if (p.selected[phase].some(e => !pathInScope(p.scope, e.path) || pathExcluded(p.scope, e.path))) bad('Selected path is outside the exact predecessor scope.');
    const included = trees[phase].filter(e => pathInScope(p.scope, e.path) && !pathExcluded(p.scope, e.path));
    if (included.some(e => !selectedPaths.includes(e.path) || !mapped.includes(e.path))) bad('Unmapped watched file or incomplete tree inventory.');
  }
  if ([...p.scope.paths, ...mapped].some(path => !selectedPaths.includes(path))) bad('Selected inventory omits a declared destination.');
  const observedProjection = p.selected.observed.map(e => {
    const measured = o.entries.find(r => r.path === e.path), projected = sourceEntry(e);
    if (measured?.presence === 'present' && measured.mode === null && !trees.head.some(r => r.path === e.path)) return { ...projected, mode: null };
    return projected;
  });
  same(observedProjection, o.entries, 'Physical measured bytes differ from T0 bindings.');
  const reconstructed = new Map(trees.head.map(e => [e.path, e]));
  for (const e of p.selected.observed) {
    if (e.presence === 'absent') reconstructed.delete(e.path);
    else reconstructed.set(e.path, { path: e.path, mode: e.mode, oid: readBlob(pool, e.blob).record.oid });
  }
  same([...reconstructed.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), trees.observed, 'T0 must equal H overlaid with exact selected physical entries.');
  orderedSet(p.association_paths, 'Association paths', true); orderedSet(p.restore_paths, 'Restore paths', true);
  if ([...p.association_paths, ...p.restore_paths].some(path => !mapped.includes(path))) bad('Association or restore paths enlarge the existing mapping.');
  const binding_delta_paths = delta(trees.bound, trees.desired);
  if (binding_delta_paths.some(path => !mapped.includes(path) || !p.association_paths.includes(path))) bad('B to desired full-tree change exceeds mapped association paths.');
  for (const [before, after] of [[trees.head, trees.observed], [trees.observed, trees.desired], [trees.bound, trees.desired]]) {
    if (before.some(e => after.some(r => r.path === e.path && r.mode !== e.mode))) bad('Existing file mode changes are unsupported.');
  }
  const changedInputs = new Set([...binding_delta_paths, ...delta(trees.head, trees.observed), ...delta(trees.observed, trees.desired)]);
  for (const phase of ['bound', 'observed', 'desired'] as const) for (const e of p.selected[phase])
    if (changedInputs.has(e.path) && e.presence === 'present') utf8(readBlob(pool, e.blob).bytes);
  const additions = [...new Set([...trees.observed, ...trees.desired].filter(e => !trees.head.some(r => r.path === e.path)).map(e => e.path))].sort();
  same(p.new_file_modes.map(e => e.path), additions, 'Every previously absent addition requires exactly one explicit mode.');
  if ([...trees.observed, ...trees.desired].some(e => additions.includes(e.path) && e.mode !== '100644')) bad('Only explicit 100644 additions are supported.');
  verifyPatch(pool, p, trees.observed, trees.desired);
  if (p.scope.mapping.some(m => !m.paths.some(path => p.selected.desired.some(e => e.path === path && e.presence === 'present')))) bad('Desired source lacks an artifact for a selected obligation.');
  const proof_pin = recordPin('reconciliation-source-proof', p);
  return { proof: p, proof_pin, endpoint_trees: trees, binding_delta_paths,
    preservation: { binding_delta_within_mapped_paths: { proof: proof_pin, from: p.trees.bound, to: p.trees.desired },
      observed_outside_patch_preserved: p.action === 'restore_intent' ? { proof: proof_pin, from: p.trees.observed, to: p.trees.desired } : null } };
}
export function verifyPlannedSourceProof(read: TypedRecordReader, input: PlannedProof): VerifiedPlannedSource {
  if (input.ancestry_oids.length > L.ancestryEdges + 1) fail('RECONCILIATION_ANCESTRY_LIMIT', 8, 'Ancestry exceeds 256 edges.');
  if (input.objects.length > L.objects) fail('RECONCILIATION_OBJECT_LIMIT', 8, 'Proof exceeds 8,192 distinct objects.');
  const p = parse(plannedProofSchema, input), pool = new Objects(read, p.objects, p.object_format);
  const result = verifyPlanned(read, p, pool); pool.assertUsed(); return result;
}
export type VerifiedCommittedSource = { proof: CommittedProof; prepared: VerifiedPlannedSource; final_tree: TreeEntry[];
  source_snapshot: ReturnType<typeof validateSourceSnapshot>; live_source_checked: false; live_authority_checked: false };
export function verifyCommittedSourceProof(read: TypedRecordReader, input: CommittedProof): VerifiedCommittedSource {
  const c = parse(committedProofSchema, input), p = parse(plannedProofSchema, readPinned(read, c.prepared, 'reconciliation-source-proof'));
  same([c.project_id, c.repo_id, c.object_format], [p.project_id, p.repo_id, p.object_format], 'Committed repository identity differs.');
  // Final objects cannot supply a missing prepared object or consume an unused prepared object.
  const prepared = verifyPlannedSourceProof(read, p);
  const pins = [...p.objects, ...c.additional_objects].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  const pool = new Objects(read, pins, p.object_format), preparedRefs = new Set(p.objects.map(pin => pin.ref));
  for (const [id, row] of pool.byOid) if (preparedRefs.has(row.pin.ref)) pool.used.add(id);
  const plan = parse(planSchema, readPinned(read, c.plan, 'reconciliation-proposal')), body = normalizePlanBody(plan.body);
  same(plan.body_sha256, digest(body), 'Plan body digest differs.');
  same(body.old_intent, readPinned(read, p.predecessor, 'source-binding').payload.intent, 'Plan intent differs from its predecessor.');
  same([body.source_proof, body.predecessor, body.report, body.action, body.old_scope, body.observation, body.observed_tree_oid, body.desired_tree_oid, body.desired_entries,
    body.binding_delta_paths, body.patch, body.patch_sha256, body.operations, body.association_paths, body.restore_paths, body.new_file_modes],
    [c.prepared, p.predecessor, p.report, p.action, p.scope, p.observation, p.trees.observed, p.trees.desired, p.selected.desired,
      prepared.binding_delta_paths, p.patch, p.patch_sha256, p.operations, p.association_paths, p.restore_paths, p.new_file_modes], 'Committed proof differs from approved plan construction.');
  const commit = pool.get(oid(c.owner_commit_oid, c.object_format), 'commit'); if (commit.kind !== 'commit') return bad('Missing final commit.');
  same([commit.tree, c.tree_oid], [p.trees.desired, p.trees.desired], 'Owner commit must have the exact desired full tree.');
  if (c.transition === 'same-reviewed-clean-head') {
    if (c.owner_commit_oid !== p.observed_head_oid || p.observation.status.length || p.observation.outside_scope_dirty || p.trees.head !== p.trees.desired) bad('Same-head completion requires an already-clean reviewed desired tree.');
  } else if (c.owner_commit_oid === p.observed_head_oid || commit.parents.length !== 1 || commit.parents[0] !== p.observed_head_oid) bad('Final commit must be exactly one single-parent child of H.');
  const final_tree = pool.tree(c.tree_oid), source = validateSourceSnapshot(readPinned(read, c.source_snapshot, 'source-snapshot'));
  same([source.project_id, source.repo_id, source.object_format, source.head_commit, source.head_tree, source.scope, source.entries],
    [c.project_id, c.repo_id, c.object_format, c.owner_commit_oid, c.tree_oid, body.scope, p.selected.desired.map(sourceEntry)], 'Final snapshot differs from desired bytes/new mapping.');
  const observation = validateGitObservation(c.observation, body.scope);
  same([observation.project_id, observation.repo_id, observation.object_format, observation.head_commit, observation.head_tree, observation.entries, digest(observation)],
    [c.project_id, c.repo_id, c.object_format, c.owner_commit_oid, c.tree_oid, source.entries, c.observation_sha256], 'Final observation differs from committed snapshot.');
  if (observation.status.length || observation.outside_scope_dirty || observation.unsupported.length || observation.coherence !== 'stable' || observation.trust !== 'local-measurement') bad('Final recorded observation must be clean, stable and complete.');
  pool.assertUsed(); return { proof: c, prepared, final_tree, source_snapshot: source, live_source_checked: false, live_authority_checked: false };
}
