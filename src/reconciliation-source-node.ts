import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noLinks } from './node-state.js';
import { bytesDigest, digest, fail } from './model.js';
import { identifyGitHost, runGit, decodeGit, gitPath, gitOid, uniqueGitPaths, GIT_LIMITS } from './git-workspace.js';
import { validateSourceScope, validateSourceSnapshot, validateGitObservation, pathInScope, pathExcluded,
  type GitHost, type SourceScope, type SourceSnapshot, type GitObservation, type SourceEntry } from './source-binding.js';
import { RECONCILIATION_LIMITS as L, recordPin, readPinned, same, normalizePlanBody,
  type GitObject, type PlannedProof, type CommittedProof, type Plan, type Pin, type TypedRecordReader } from './reconciliation-records.js';
import { verifyRawGitObject, verifyPlannedSourceProof, verifyCommittedSourceProof, applyExactPatchSection,
  type TreeEntry } from './reconciliation-source-proof.js';

/** Generic source mechanics: no producer IDs, application recognition or counter semantics. */
export type AuthorizeSourcePath = (name: string, use: 'read' | 'inventory' | 'association' | 'restore' | 'add') => void;
const IDENTITY = Symbol('resolved-reconciliation-repository');
export type RepositoryIdentity = { readonly [IDENTITY]: true; root: string; gitDir: string; commonDir: string;
  identity: string; object_format: 'sha1' | 'sha256'; configuration_sha256: string };
export type ReconciliationSourceHost = { repositoryIdentity: RepositoryIdentity; projectId: string; repoId: string;
  read: TypedRecordReader; predecessor: Pin; report: Pin; boundSource: Pin; signal?: AbortSignal };
export type ImmutableSourceInput = { path: string; mode: '100644' | '100755'; blob: Pin; bytes: Buffer };
export type PreparedDesiredSource = { proof: PlannedProof; objectRecords: GitObject[]; immutableInputs: ImmutableSourceInput[];
  observation: GitObservation; repositoryIdentity: RepositoryIdentity };
/** Restore these pins from trusted preparation/auth state after restart, never from a public request. */
export type RepositoryIdentityPin = Pick<RepositoryIdentity, 'identity' | 'configuration_sha256'>;
export type VerifiedSourcePlan = { plan: Plan; prepared: PlannedProof; repositoryIdentity: RepositoryIdentityPin };
type Capture = { observation: GitObservation; snapshot: SourceSnapshot; tree: TreeEntry[];
  physical: Map<string, Buffer | null>; stamp: string };
type SourceGuard = { stamp: string; observation_sha256: string; projectId: string; repoId: string; authorize: AuthorizeSourcePath };
// Equal serialized observations can have different ignored inventories or file identities.
// Each live capture owns its guard; neither recapture nor parsing a record can refresh it.
const guards = new WeakMap<RepositoryIdentity, WeakMap<GitObservation, SourceGuard>>();
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const config = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullDevice}`, '-c', 'core.pager=cat',
  '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', '-c', `core.attributesFile=${nullDevice}`,
  '-c', `core.excludesFile=${nullDevice}`,
  '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'core.sparseCheckout=false'];
function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullDevice, GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat' };
}
function git(root: string, args: string[], input?: Buffer | string, maximum = GIT_LIMITS.treeBytes): Buffer {
  const r = spawnSync('git', [...config, '-C', root, '--no-replace-objects', ...args],
    { env: gitEnvironment(), shell: false, windowsHide: true, input, timeout: 15000, maxBuffer: maximum });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS' && args[0] === 'cat-file') {
    if (maximum === L.rawObject + 1) fail('RECONCILIATION_RAW_OBJECT_LIMIT', 8, 'Raw Git object exceeds 512 KiB.');
    fail('RECONCILIATION_SOURCE_BYTES', 8, 'Raw blob capture exceeds the 64 MiB tree bound.');
  }
  if (r.error || r.status !== 0) fail('RECONCILIATION_GIT_CAPTURE', 5, 'Bounded read-only Git capture failed.',
    { command: args[0], reason: r.error?.message ?? decodeGit(r.stderr).slice(0, 512) });
  return r.stdout;
}
const text = (root: string, args: string[]) => new TextDecoder('utf-8', { fatal: true }).decode(git(root, args)).trim();
function ordinary(file: string, maximum: number, absent = false): Buffer | null {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail('RECONCILIATION_SOURCE_KIND', 8, 'Source paths cannot traverse links or junctions.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.nlink > 1) fail('RECONCILIATION_SOURCE_KIND', 8, 'Source requires ordinary files without hard links.');
    if (before.size > maximum) fail('RECONCILIATION_SOURCE_BYTES', 8, 'Source file exceeds its byte bound.');
    const bytes = readFileSync(file), after = lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size)
      fail('SOURCE_SNAPSHOT_STALE', 5, 'Source changed during an ordinary-file read.');
    return bytes;
  } catch (e) { if (absent && (e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
function configuration(identity: Pick<RepositoryIdentity, 'root' | 'gitDir' | 'commonDir'>, inspectConfig = false): string {
  const { root, gitDir, commonDir } = identity;
  for (const directory of [root, gitDir, commonDir]) {
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) fail('REPOSITORY_BINDING', 4, 'Canonical repository identity changed.');
  }
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'AUTO_MERGE', 'BISECT_START',
    'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock'])
    if (existsSync(path.join(gitDir, name))) fail('GIT_OPERATION_PENDING', 5, 'Pending Git operations and index locks are unsupported.');
  for (const file of [path.join(commonDir, 'shallow'), path.join(commonDir, 'info', 'grafts'), path.join(commonDir, 'objects', 'info', 'alternates')])
    if (existsSync(file)) fail('RECONCILIATION_GIT_HISTORY', 8, 'Shallow, graft and alternate object repositories are unsupported.');
  if (text(root, ['for-each-ref', '--format=%(refname)', 'refs/replace'])) fail('RECONCILIATION_GIT_HISTORY', 8, 'Replacement refs are unsupported.');
  if (inspectConfig) {
    const common = text(root, ['config', '--local', '--no-includes', '--list']);
    const local = common + (/^extensions\.worktreeconfig(?:=(?:true|yes|on|1)?|)$/mi.test(common)
      ? '\n' + text(root, ['config', '--worktree', '--no-includes', '--list']) : '');
    if (/^(?:include\.|includeif\.|core\.excludesfile(?:=|$)|(?:core\.sparsecheckout|index\.sparse)(?:=(?:true|yes|on|1)?|$)|core\.autocrlf(?:=(?:true|input|yes|on|1)?|$)|core\.eol=(?:crlf|native)|extensions\.partialclone(?:=|$)|remote\.[^=]+\.promisor(?:=|$))/mi.test(local))
      fail('RECONCILIATION_GIT_CONFIG', 8, 'Includes, configured excludes files, sparse indexes, transforms and lazy-fetch object repositories are unsupported.');
  }
  const files = [...new Set([path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree'), path.join(commonDir, 'info', 'attributes'),
    path.join(commonDir, 'info', 'exclude')])].sort();
  const dotGit = path.join(root, '.git'); if (lstatSync(dotGit).isFile()) files.push(dotGit);
  return digest({ directories: [root, gitDir, commonDir].map(directory => {
    const s = lstatSync(directory); return { directory, dev: s.dev, ino: s.ino };
  }), files: files.map(file => {
    const bytes = ordinary(file, GIT_LIMITS.source, true);
    return { file, presence: bytes === null ? 'absent' : 'present', byte_length: bytes?.length ?? null,
      sha256: bytes === null ? null : bytesDigest(bytes) };
  }) });
}
/** Host setup only. Requests cannot provide roots, record readers or this nonserializable identity. */
export async function resolveReconciliationRepository(host: GitHost): Promise<RepositoryIdentity> {
  // Refuse external config inclusion before Git can implicitly open an included file.
  const root = realpathSync(await noLinks(host.root)), dotGit = path.join(root, '.git'), stat = lstatSync(dotGit);
  const pointer = stat.isDirectory() ? null : ordinary(dotGit, GIT_LIMITS.source);
  const match = pointer === null ? null : /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(decodeGit(pointer));
  if (pointer !== null && !match) fail('REPOSITORY_BINDING', 4, 'Unsupported Git directory pointer.');
  const gitDir = pointer === null ? dotGit : path.resolve(root, match![1]);
  const commonPointer = ordinary(path.join(gitDir, 'commondir'), GIT_LIMITS.source, true);
  if (commonPointer && !/^[^\r\n\0]+\r?\n?$/.test(decodeGit(commonPointer))) fail('REPOSITORY_BINDING', 4, 'Unsupported common Git directory pointer.');
  const common = commonPointer === null ? gitDir : path.resolve(gitDir, decodeGit(commonPointer).trim());
  for (const file of [...new Set([path.join(common, 'config'), path.join(gitDir, 'config.worktree')])]) {
    const bytes = ordinary(file, GIT_LIMITS.source, true);
    if (bytes && /^\s*\[\s*include(?:if)?(?:[.\s\]])/mi.test(decodeGit(bytes)))
      fail('RECONCILIATION_GIT_CONFIG', 8, 'External Git config includes are unsupported.');
  }
  const resolved = await identifyGitHost(host);
  const commonDir = realpathSync(text(resolved.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const identity: RepositoryIdentity = { [IDENTITY]: true, ...resolved, commonDir,
    object_format: resolved.object_format as RepositoryIdentity['object_format'], configuration_sha256: '' };
  identity.configuration_sha256 = configuration(identity, true); guards.set(identity, new WeakMap()); return Object.freeze(identity);
}
function checkIdentity(identity: RepositoryIdentity) {
  if (!identity?.[IDENTITY] || !guards.has(identity)) fail('REPOSITORY_BINDING', 4, 'A trusted resolved repository identity is required.');
  same(configuration(identity), identity.configuration_sha256, 'Repository configuration/identity changed.');
  const pins = text(identity.root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-object-format']).split('\n');
  if (path.resolve(pins[0]) !== identity.root || realpathSync(pins[1]) !== identity.gitDir || realpathSync(pins[2]) !== identity.commonDir || pins[3] !== identity.object_format)
    fail('REPOSITORY_BINDING', 4, 'Repository roots or object format changed.');
}
function treeEntries(root: string, oid: string): TreeEntry[] {
  const rows = decodeGit(git(root, ['ls-tree', '-rz', '--full-tree', oid])).split('\0').filter(Boolean).map(row => {
    const m = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(row);
    if (!m) fail('RECONCILIATION_SOURCE_KIND', 8, 'Full trees require ordinary files, with no symlinks or Gitlinks.');
    return { path: gitPath(m[3]), mode: m[1] as TreeEntry['mode'], oid: m[2] };
  });
  if (rows.length > L.endpointEntries) fail('RECONCILIATION_TREE_LIMIT', 8, 'Endpoint tree exceeds 5,000 entries.');
  uniqueGitPaths(rows.map(e => e.path)); return rows;
}
function readBlobs(root: string, rows: TreeEntry[], format: RepositoryIdentity['object_format']): Map<string, Buffer> {
  const ids = [...new Set(rows.map(e => gitOid(e.oid, format)))], result = new Map<string, Buffer>();
  if (!ids.length) return result;
  const bytes = git(root, ['cat-file', '--batch'], ids.join('\n') + '\n', GIT_LIMITS.treeBytes + 1024 * 1024);
  let offset = 0, total = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, offset), header = decodeGit(bytes.subarray(offset, end));
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (end < offset || !match || match[1] !== id) fail('RECONCILIATION_GIT_CAPTURE', 5, 'Missing/wrong-kind raw blob in bounded capture.');
    const size = Number(match[2]); total += size;
    if (!Number.isSafeInteger(size) || size > GIT_LIMITS.file || total > GIT_LIMITS.treeBytes)
      fail('RECONCILIATION_SOURCE_BYTES', 8, 'Raw blob capture exceeds the 4 MiB/file or 64 MiB/tree bound.');
    offset = end + 1;
    if (offset + size >= bytes.length || bytes[offset + size] !== 10) fail('RECONCILIATION_GIT_CAPTURE', 5, 'Truncated raw blob capture.');
    result.set(id, Buffer.from(bytes.subarray(offset, offset + size))); offset += size + 1;
  }
  if (offset !== bytes.length) fail('RECONCILIATION_GIT_CAPTURE', 5, 'Unexpected bytes after bounded blob capture.');
  return result;
}
function capture(host: Pick<ReconciliationSourceHost, 'repositoryIdentity' | 'projectId' | 'repoId'>, input: SourceScope,
  authorize: AuthorizeSourcePath): Capture {
  const scope = validateSourceScope(input), identity = host.repositoryIdentity, root = identity.root;
  authorize('.', 'inventory'); checkIdentity(identity);
  const heads = text(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']).split('\n');
  const head_commit = gitOid(heads[0], identity.object_format), head_tree = gitOid(heads[1], identity.object_format);
  const indexPath = text(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const index_sha256 = bytesDigest(ordinary(indexPath, GIT_LIMITS.source)!);
  const tree = treeEntries(root, head_tree);
  if (decodeGit(git(root, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean).some(row => row[0] !== 'H'))
    fail('UNSUPPORTED_GIT_INDEX', 8, 'Unmerged, sparse, skip-worktree and assume-unchanged entries are unsupported.');
  const indexed = decodeGit(git(root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean).map(row => {
    const m = /^(100644|100755) ([a-f0-9]+) 0\t(.+)$/.exec(row);
    if (!m) fail('UNSUPPORTED_GIT_INDEX', 8, 'Index must contain ordinary stage-zero entries.');
    return { path: gitPath(m[3]), mode: m[1] as TreeEntry['mode'], oid: m[2] };
  });
  const included = (name: string) => pathInScope(scope, name) && !pathExcluded(scope, name);
  // Do not let Git consume .gitignore contents while discovering those very inputs.
  // This first inventory deliberately applies no exclude rules and opens no rule files.
  const rawOthers = decodeGit(git(root, ['ls-files', '--others', '-z'], undefined, GIT_LIMITS.source)).split('\0').filter(Boolean);
  if (rawOthers.length > L.endpointEntries) fail('RECONCILIATION_TREE_LIMIT', 8, 'Unfiltered inventory exceeds 5,000 entries.');
  const rawInventory = uniqueGitPaths([...new Set([...tree.map(e => e.path), ...indexed.map(e => e.path), ...rawOthers])]);
  for (const name of rawInventory) authorize(name, 'inventory');
  const ignoreInputs = rawInventory.filter(name => name.split('/').at(-1)!.toLowerCase() === '.gitignore').map(name => {
    authorize(name, 'read');
    // Grant first, then refuse hidden/new rule files without opening their contents.
    if (name.split('/').at(-1) !== '.gitignore' || !tree.some(e => e.path === name) || !indexed.some(e => e.path === name))
      fail('RECONCILIATION_GIT_CONFIG', 8, 'Untracked or case-aliased ignore rule files are unsupported; their contents are uninspected.');
    const bytes = ordinary(path.join(root, name), GIT_LIMITS.file, true);
    return { path: name, presence: bytes === null ? 'absent' : 'present', byte_length: bytes?.length ?? null,
      sha256: bytes === null ? null : bytesDigest(bytes) };
  });
  const untracked = decodeGit(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  // Ignored content is never opened; only scoped ignored names participate in inventory.
  const ignored = decodeGit(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], undefined, GIT_LIMITS.source))
    .split('\0').filter(name => name && pathInScope(scope, name));
  if ([indexed.length, untracked.length, ignored.length].some(n => n > L.endpointEntries)) fail('RECONCILIATION_TREE_LIMIT', 8, 'Inventory exceeds 5,000 entries.');
  const all = uniqueGitPaths([...new Set([...tree.map(e => e.path), ...indexed.map(e => e.path), ...untracked])]);
  for (const name of [...all, ...ignored]) authorize(name, 'inventory');
  const selected = uniqueGitPaths([...new Set([...scope.paths, ...scope.mapping.flatMap(m => m.paths), ...all.filter(included)])]);
  const mapped = new Set(scope.mapping.flatMap(m => m.paths));
  if (selected.length > GIT_LIMITS.entries) fail('RECONCILIATION_SOURCE_ENTRIES', 8, 'Selected inventory exceeds 256 entries.');
  if (selected.some(p => !mapped.has(p))) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Every watched source entry must already be mapped.');
  if (selected.some(p => ignored.includes(p) && !tree.some(e => e.path === p))) fail('IGNORED_SOURCE_PATH', 5, 'Ignored additions cannot be measured.');
  const names = uniqueGitPaths([...new Set([...all, ...selected])]);
  for (const name of names) authorize(name, 'read');
  // check-attr reads ancestor attribute files implicitly. Grant each such read first,
  // and refuse ignored/untracked attribute files without opening their contents.
  const attributes = new Set(['.gitattributes']);
  for (const name of names) {
    const parts = name.split('/'); for (let i = 1; i < parts.length; i++) attributes.add(parts.slice(0, i).join('/') + '/.gitattributes');
  }
  for (const name of attributes) if (existsSync(path.join(root, name))) {
    authorize(name, 'inventory');
    if (!tree.some(e => e.path === name)) fail('RECONCILIATION_GIT_CONFIG', 8, 'Untracked attribute files are unsupported.');
    authorize(name, 'read'); ordinary(path.join(root, name), GIT_LIMITS.file);
  }
  const attributeNames = ['filter', 'text', 'eol', 'working-tree-encoding', 'ident'];
  const attr = decodeGit(git(root, ['check-attr', '-z', '--stdin', ...attributeNames], names.join('\0') + '\0'))
    .split('\0');
  const expectedAttributes = names.flatMap(name => attributeNames.map(attribute => ({ name, attribute })));
  if (attr.length !== expectedAttributes.length * 3 + 1 || attr.at(-1) !== '')
    fail('RECONCILIATION_GIT_CAPTURE', 5, 'Attribute capture does not cover the exact source inventory.');
  for (let i = 0; i < expectedAttributes.length; i++) same([attr[i * 3], attr[i * 3 + 1]],
    [expectedAttributes[i].name, expectedAttributes[i].attribute], 'Attribute capture path/field differs.');
  for (let i = 0; i + 2 < attr.length; i += 3) if (!['unspecified', 'unset'].includes(attr[i + 2]))
    fail('UNSUPPORTED_CHECKOUT_TRANSFORM', 8, 'Checkout transforms are unsupported.', { path: attr[i], attribute: attr[i + 1] });
  const blobs = readBlobs(root, [...tree, ...indexed], identity.object_format);
  const physical = new Map<string, Buffer | null>(), entries: SourceEntry[] = [], committed: SourceEntry[] = [], status: GitObservation['status'] = [];
  const directoryNames = new Map<string, string[]>();
  const assertSpelling = (name: string) => {
    let directory = root;
    for (const component of name.split('/')) {
      let names = directoryNames.get(directory);
      if (!names) {
        try { names = readdirSync(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
        directoryNames.set(directory, names);
      }
      const aliases = names.filter(value => value.toLowerCase() === component.toLowerCase());
      if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== component)
        fail('RECONCILIATION_SOURCE_KIND', 8, 'Physical source names contain a case alias.');
      directory = path.join(directory, component);
      // Check directory links before the next listing can traverse them.
      if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) fail('RECONCILIATION_SOURCE_KIND', 8, 'Source paths cannot traverse links or junctions.');
    }
  };
  const files: unknown[] = []; let total = 0, selectedBytes = 0, outside_scope_dirty = false;
  for (const name of names) {
    authorize(name, 'read'); assertSpelling(name);
    const components = name.split('/');
    for (let i = 1; i < components.length; i++) if (existsSync(path.join(root, ...components.slice(0, i), '.git')))
      fail('RECONCILIATION_SOURCE_KIND', 8, 'Nested repositories are unsupported.');
    const base = tree.find(e => e.path === name), idx = indexed.find(e => e.path === name);
    const raw = base ? blobs.get(base.oid)! : null;
    const actual = ordinary(path.join(root, name), GIT_LIMITS.file, true);
    if (actual && process.platform !== 'win32' && base && (((lstatSync(path.join(root, name)).mode & 0o111) !== 0) !== (base.mode === '100755')))
      fail('RECONCILIATION_SOURCE_MODE', 8, 'Physical executable mode changed.');
    if (base && idx && base.mode !== idx.mode) fail('RECONCILIATION_SOURCE_MODE', 8, 'Existing index mode changes are unsupported.');
    const indexBytes = idx ? blobs.get(idx.oid)! : null;
    total += (raw?.length ?? 0) + (actual?.length ?? 0) + (indexBytes?.length ?? 0);
    if (total > GIT_LIMITS.treeBytes) fail('RECONCILIATION_SOURCE_BYTES', 8, 'Full-tree capture exceeds 64 MiB.');
    const hash = (bytes: Buffer | null) => bytes === null ? null : bytesDigest(bytes);
    const staged = (base?.oid ?? null) !== (idx?.oid ?? null) || (base?.mode ?? null) !== (idx?.mode ?? null), unstaged = hash(indexBytes) !== hash(actual);
    if (staged || unstaged || untracked.includes(name)) {
      if (included(name)) status.push({ path: name, staged, unstaged, untracked: untracked.includes(name) }); else outside_scope_dirty = true;
    }
    physical.set(name, actual);
    const s = actual === null ? null : lstatSync(path.join(root, name));
    files.push({ path: name, sha256: hash(actual), dev: s?.dev ?? null, ino: s?.ino ?? null, mode: s?.mode ?? null });
    if (!selected.includes(name)) continue;
    selectedBytes += (raw?.length ?? 0) + (actual?.length ?? 0) + (indexBytes?.length ?? 0);
    if (selectedBytes > GIT_LIMITS.source) fail('RECONCILIATION_SOURCE_BYTES', 8, 'Selected capture exceeds 16 MiB.');
    const absent: SourceEntry = { path: name, presence: 'absent', kind: null, mode: null, byte_length: null, sha256: null };
    entries.push(actual === null ? absent : { path: name, presence: 'present', kind: 'regular', mode: base?.mode ?? idx?.mode ?? null, byte_length: actual.length, sha256: hash(actual) });
    committed.push(raw === null ? absent : { path: name, presence: 'present', kind: 'regular', mode: base!.mode, byte_length: raw.length, sha256: hash(raw) });
  }
  const observation = validateGitObservation({ format: 'git-observation/1', project_id: host.projectId, repo_id: host.repoId,
    object_format: identity.object_format, head_commit, head_tree, index_sha256, scope_sha256: digest(scope), entries,
    manifest_sha256: digest(entries), status, outside_scope_dirty, ignored_count: ignored.length,
    excluded_count: tree.filter(e => pathInScope(scope, e.path) && pathExcluded(scope, e.path)).length,
    unsupported: [], coherence: 'stable', trust: 'local-measurement' }, scope);
  const snapshot = validateSourceSnapshot({ format: 'source-snapshot/1', project_id: host.projectId, repo_id: host.repoId,
    object_format: identity.object_format, head_commit, head_tree, scope, scope_sha256: digest(scope), entries: committed, manifest_sha256: digest(committed) });
  checkIdentity(identity);
  same([text(root, ['rev-parse', '--verify', 'HEAD']), bytesDigest(ordinary(indexPath, GIT_LIMITS.source)!)], [head_commit, index_sha256], 'HEAD/index changed during capture.');
  return { observation, snapshot, tree, physical, stamp: digest({ observation, tree, indexed, untracked, ignored, files, ignoreInputs, rawInventory }) };
}
function stableCapture(host: Pick<ReconciliationSourceHost, 'repositoryIdentity' | 'projectId' | 'repoId'>, scope: SourceScope, authorize: AuthorizeSourcePath) {
  const first = capture(host, scope, authorize), second = capture(host, scope, authorize);
  same(first.stamp, second.stamp, 'Source/index/inventory changed during capture.');
  guards.get(host.repositoryIdentity)!.set(second.observation, { stamp: second.stamp, observation_sha256: digest(second.observation),
    projectId: host.projectId, repoId: host.repoId, authorize });
  return second;
}
/** For the /2 report producer: read-only coherent observation using the same host guards. */
export function captureReconciliationObservation(host: Pick<ReconciliationSourceHost, 'repositoryIdentity' | 'projectId' | 'repoId'>,
  scope: SourceScope, authorize: AuthorizeSourcePath): { observation: GitObservation; sourceSnapshot: SourceSnapshot } {
  const c = stableCapture(host, scope, authorize); return { observation: c.observation, sourceSnapshot: c.snapshot };
}
export function assertLateSourceSynchronously(hostIdentity: RepositoryIdentity, expectedObservation: GitObservation, scope: SourceScope): void {
  const guard = guards.get(hostIdentity)?.get(expectedObservation);
  if (!guard) fail('RECONCILIATION_SOURCE_GUARD', 6, 'Late source guard requires an observation captured by this host.');
  same(digest(expectedObservation), guard.observation_sha256, 'The exact captured observation was mutated.');
  const fresh = capture({ repositoryIdentity: hostIdentity, projectId: guard.projectId, repoId: guard.repoId }, scope, guard.authorize);
  same(fresh.stamp, guard.stamp, 'Source/index/inventory changed after the exact capture.');
  const again = capture({ repositoryIdentity: hostIdentity, projectId: guard.projectId, repoId: guard.repoId }, scope, guard.authorize);
  same(again.stamp, guard.stamp, 'Source/index/inventory changed during the late guard.');
}
function rawObject(kind: GitObject['kind'], bytes: Buffer, object_format: GitObject['object_format']): GitObject {
  if (bytes.length > L.rawObject) fail('RECONCILIATION_RAW_OBJECT_LIMIT', 8, 'Raw Git object exceeds 512 KiB.');
  const record: GitObject = { format: 'reconciliation-git-object/1', object_format, kind,
    oid: createHash(object_format).update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex'), byte_length: bytes.length,
    raw_sha256: bytesDigest(bytes), bytes_base64: Buffer.from(bytes).toString('base64') };
  verifyRawGitObject(record); return record;
}
class Pool {
  objects = new Map<string, GitObject>(); bytes = 0;
  constructor(readonly identity: RepositoryIdentity) {}
  add(record: GitObject) {
    if (!this.objects.has(record.oid)) {
      this.bytes += record.byte_length;
      if (this.bytes > L.rawBytes) fail('RECONCILIATION_OBJECT_BYTES', 8, 'Raw object union exceeds 16 MiB.');
      if (this.objects.size >= L.objects) fail('RECONCILIATION_OBJECT_LIMIT', 8, 'Raw object union exceeds 8,192 objects.');
      this.objects.set(record.oid, record);
    }
    return record;
  }
  load(id: string, kind: GitObject['kind']) {
    const existing = this.objects.get(id); if (existing) { if (existing.kind !== kind) fail('RECONCILIATION_GIT_PROOF', 6, 'Object kind mismatch.'); return existing; }
    const value = this.add(rawObject(kind, git(this.identity.root, ['cat-file', kind, id], undefined, L.rawObject + 1), this.identity.object_format));
    same(value.oid, id, 'Captured raw Git object identity differs.'); return value;
  }
  tree(id: string): TreeEntry[] {
    const result: TreeEntry[] = []; let count = 0;
    const walk = (oid: string, prefix: string) => {
      const parsed = verifyRawGitObject(this.load(oid, 'tree')); if (parsed.kind !== 'tree') throw Error('Tree expected');
      for (const entry of parsed.entries) {
        if (++count > L.endpointEntries) fail('RECONCILIATION_TREE_LIMIT', 8, 'Endpoint tree exceeds 5,000 entries.');
        const name = gitPath(prefix + entry.name);
        if (entry.mode === '40000') { if (name.split('/').length >= 120) fail('RECONCILIATION_TREE_LIMIT', 8, 'Tree nesting exceeds 120 components.'); walk(entry.oid, name + '/'); }
        else result.push({ path: name, mode: entry.mode, oid: entry.oid });
      }
    };
    walk(id, ''); return result.sort((a, b) => a.path < b.path ? -1 : 1);
  }
  build(entries: TreeEntry[]): string {
    uniqueGitPaths(entries.map(e => e.path));
    const build = (prefix: string): string => {
      const rows: { name: string; mode: string; oid: string }[] = [], directories = new Set<string>();
      for (const e of entries.filter(e => e.path.startsWith(prefix))) {
        const rest = e.path.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) rows.push({ name: rest, mode: e.mode, oid: e.oid }); else directories.add(rest.slice(0, slash));
      }
      for (const name of directories) rows.push({ name, mode: '40000', oid: build(prefix + name + '/') });
      rows.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '\0')), Buffer.from(b.name + (b.mode === '40000' ? '/' : '\0'))));
      return this.add(rawObject('tree', Buffer.concat(rows.map(r => Buffer.concat([Buffer.from(`${r.mode} ${r.name}\0`), Buffer.from(r.oid, 'hex')]))), this.identity.object_format)).oid;
    };
    return build('');
  }
  records() { return [...this.objects.values()].sort((a, b) => recordPin('reconciliation-git-object', a).ref < recordPin('reconciliation-git-object', b).ref ? -1 : 1); }
}
function reader(host: ReconciliationSourceHost, records: GitObject[], extras: { type: string; data: unknown }[] = []): TypedRecordReader {
  const rows = [...records.map(data => ({ type: 'reconciliation-git-object', data })), ...extras];
  return (pin, type) => rows.find(r => r.type === type && recordPin(type, r.data).ref === pin.ref)?.data ?? host.read(pin, type);
}
function inputs(pool: Pool, entries: PlannedProof['selected']['desired']): ImmutableSourceInput[] {
  return entries.flatMap(e => e.presence === 'absent' ? [] : [{ path: e.path, mode: e.mode, blob: { ...e.blob },
    bytes: Buffer.from([...pool.objects.values()].find(o => recordPin('reconciliation-git-object', o).ref === e.blob.ref)!.bytes_base64, 'base64') }]);
}
function cancelled(host: ReconciliationSourceHost) { host.signal?.throwIfAborted(); }
function proofEntry(pool: Pool, name: string, row?: TreeEntry): PlannedProof['selected']['desired'][number] {
  if (!row) return { path: name, presence: 'absent', mode: null, byte_length: null, sha256: null, blob: null };
  const raw = pool.load(row.oid, 'blob'); return { path: name, presence: 'present', mode: row.mode,
    byte_length: raw.byte_length, sha256: raw.raw_sha256, blob: recordPin('reconciliation-git-object', raw) };
}
export async function prepareDesiredSource(host: ReconciliationSourceHost, sourceScope: SourceScope, observation: GitObservation,
  action: PlannedProof['action'], patch: string | null, newModes: PlannedProof['new_file_modes'], authorize: AuthorizeSourcePath): Promise<PreparedDesiredSource> {
  cancelled(host); const scope = validateSourceScope(sourceScope), identity = host.repositoryIdentity;
  const before = stableCapture(host, scope, authorize); same(before.observation, observation, 'Reviewed observation is stale.');
  const reviewedGuard = guards.get(identity)?.get(observation);
  if (reviewedGuard) same(before.stamp, reviewedGuard.stamp, 'Reviewed capture inventory/identity is stale.');
  // The public reviewed record may be deserialized; retain this preparation's live capture.
  observation = before.observation;
  if (before.observation.outside_scope_dirty) fail('DIRTY_GIT_WORKTREE', 5, 'Outside-scope edits cannot ride along with reconciliation.');
  const source = validateSourceSnapshot(readPinned(host.read, host.boundSource, 'source-snapshot'));
  same([source.scope, source.project_id, source.repo_id], [scope, host.projectId, host.repoId], 'Predecessor source scope/identity differs.');
  const pool = new Pool(identity), ancestry: string[] = []; let id = before.observation.head_commit;
  while (true) {
    cancelled(host); const commit = verifyRawGitObject(pool.load(id, 'commit')); if (commit.kind !== 'commit') throw Error('Commit expected');
    if (commit.parents.length > 1) fail('RECONCILIATION_GIT_HISTORY', 8, 'Merge commits are unsupported.');
    ancestry.unshift(id); if (id === source.head_commit) break;
    if (ancestry.length > L.ancestryEdges) fail('RECONCILIATION_ANCESTRY_LIMIT', 8, 'Ancestry exceeds 256 edges.');
    if (commit.parents.length !== 1) fail('RECONCILIATION_GIT_HISTORY', 5, 'Observed HEAD is not a single-parent descendant of B.');
    id = commit.parents[0];
  }
  const boundTree = pool.tree(source.head_tree), headTree = pool.tree(before.observation.head_tree);
  const names = source.entries.map(e => e.path); same(names, before.observation.entries.map(e => e.path), 'Observed inventory differs from the bound inventory.');
  const modes = new Map(newModes.map(m => [m.path, m.mode]));
  const observedTree = new Map(headTree.map(e => [e.path, e]));
  for (const name of names) {
    const bytes = before.physical.get(name) ?? null, head = headTree.find(e => e.path === name);
    if (bytes === null) observedTree.delete(name);
    else {
      if (!head && modes.get(name) !== '100644') fail('RECONCILIATION_SOURCE_MODE', 2, 'Previously absent additions require explicit 100644 mode.');
      if (!head) authorize(name, 'add');
      const blob = pool.add(rawObject('blob', bytes, identity.object_format));
      observedTree.set(name, { path: name, mode: head?.mode ?? '100644', oid: blob.oid });
    }
  }
  const desiredTree = new Map(observedTree), restore_paths: string[] = [];
  if (action === 'restore_intent') {
    if (!patch || Buffer.byteLength(patch) > L.patchBytes || /[\r\0]/.test(patch)) fail('RECONCILIATION_PATCH_LIMIT', 2, 'Restoration requires one bounded LF patch.');
    const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
    if (sections.length > L.patchPaths) fail('RECONCILIATION_PATCH_LIMIT', 8, 'Patch exceeds 64 paths.');
    for (const section of sections) {
      const match = /^diff --git a\/(\S+) b\/(\S+)\n/.exec(section);
      if (!match || match[1] !== match[2]) fail('RECONCILIATION_PATCH', 2, 'Patch paths must be exact, with no renames/preamble.');
      const name = gitPath(match[1]);
      if (!names.includes(name) || restore_paths.includes(name)) fail('RECONCILIATION_PATCH', 2, 'Patch must use unique previously mapped paths.');
      authorize(name, 'restore'); authorize(name, 'read'); restore_paths.push(name);
      const raw = before.physical.get(name) ?? null;
      const beforeText = raw === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
      if (raw && (beforeText!.includes('\0') || !Buffer.from(beforeText!).equals(raw))) fail('RECONCILIATION_PATCH', 2, 'Patch preimage must be exact UTF-8 without NUL.');
      const after = applyExactPatchSection(section, beforeText, name);
      if (after === null) desiredTree.delete(name);
      else {
        const head = headTree.find(e => e.path === name);
        if (!head && modes.get(name) !== '100644') fail('RECONCILIATION_SOURCE_MODE', 2, 'Patch additions require explicit 100644 mode.');
        if (!head) authorize(name, 'add');
        const blob = pool.add(rawObject('blob', Buffer.from(after), identity.object_format));
        desiredTree.set(name, { path: name, mode: observedTree.get(name)?.mode ?? '100644', oid: blob.oid });
      }
    }
  } else if (patch !== null) fail('RECONCILIATION_PATCH', 2, 'Accept/update cannot supply a patch.');
  if ([...desiredTree.values()].some(e => !boundTree.some(b => b.path === e.path) && e.mode !== '100644'))
    fail('RECONCILIATION_SOURCE_MODE', 8, 'New association additions support 100644 only.');
  const selected = { bound: names.map(name => proofEntry(pool, name, boundTree.find(e => e.path === name))),
    observed: names.map(name => proofEntry(pool, name, observedTree.get(name))), desired: names.map(name => proofEntry(pool, name, desiredTree.get(name))) };
  const proof: PlannedProof = { format: 'reconciliation-source-proof/1', phase: 'planned', project_id: host.projectId, repo_id: host.repoId,
    object_format: identity.object_format, predecessor: host.predecessor, report: host.report, bound_source: host.boundSource,
    action, scope, association_paths: [...new Set(scope.mapping.flatMap(m => m.paths))].sort(), restore_paths: restore_paths.sort(), new_file_modes: newModes,
    observation, observation_sha256: digest(observation), base_commit_oid: source.head_commit, observed_head_oid: observation.head_commit,
    ancestry_oids: ancestry, trees: { bound: source.head_tree, head: observation.head_tree,
      observed: pool.build([...observedTree.values()]), desired: pool.build([...desiredTree.values()]) }, objects: [], selected,
    patch, patch_sha256: patch === null ? null : bytesDigest(patch), operations: restore_paths.map(name => ({ path: name,
      before: selected.observed.find(e => e.path === name)!, after: selected.desired.find(e => e.path === name)! })) };
  proof.objects = pool.records().map(o => recordPin('reconciliation-git-object', o));
  for (const name of proof.association_paths) authorize(name, 'association');
  // This must pass before any final commit is introduced, including the exact-use object invariant.
  verifyPlannedSourceProof(reader(host, pool.records()), proof);
  const scratch = await mkdtemp(path.join(tmpdir(), 'strata-reconciliation-source-'));
  const ownedScratch = lstatSync(scratch);
  const assertScratch = () => {
    const current = lstatSync(scratch);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedScratch.dev || current.ino !== ownedScratch.ino || realpathSync(scratch) !== scratch)
      fail('RECONCILIATION_SCRATCH', 6, 'Private scratch identity changed; refusing access or cleanup.');
  };
  try {
    cancelled(host); assertScratch(); await runGit(scratch, ['init', '--quiet', '--object-format=' + identity.object_format]);
    // Standalone private object staging; no original object, index, worktree or ref writes.
    for (const record of pool.records()) {
      cancelled(host); assertScratch(); const oid = decodeGit(await runGit(scratch, ['hash-object', '-w', '-t', record.kind, '--stdin'], Buffer.from(record.bytes_base64, 'base64'))).trim();
      same(oid, record.oid, 'Private raw object staging changed identity.');
    }
  } finally {
    if (path.dirname(path.resolve(scratch)) !== path.resolve(tmpdir()) || !path.basename(scratch).startsWith('strata-reconciliation-source-'))
      fail('RECONCILIATION_SCRATCH', 6, 'Refusing cleanup of an unowned scratch path.');
    assertScratch();
    await rm(scratch, { recursive: true, force: true });
  }
  cancelled(host); assertLateSourceSynchronously(identity, observation, scope);
  return { proof, objectRecords: pool.records(), immutableInputs: inputs(pool, proof.selected.desired), observation, repositoryIdentity: identity };
}
export async function captureCompletionSource(host: ReconciliationSourceHost, verifiedPlan: VerifiedSourcePlan, exactOwnerCommit: string,
  authorize: AuthorizeSourcePath): Promise<{ sourceSnapshot: SourceSnapshot; observation: GitObservation; proof: CommittedProof;
    newObjectRecords: GitObject[]; immutableInputs: ImmutableSourceInput[] }> {
  cancelled(host); const { plan, prepared } = verifiedPlan, identity = host.repositoryIdentity;
  same(verifiedPlan.repositoryIdentity, { identity: identity.identity, configuration_sha256: identity.configuration_sha256 },
    'Completion repository identity/configuration differs from preparation.');
  const verified = verifyPlannedSourceProof(host.read, prepared), body = normalizePlanBody(plan.body);
  same(body.source_proof, verified.proof_pin, 'Plan does not reference the exact prepared proof.');
  gitOid(exactOwnerCommit, identity.object_format);
  const final = stableCapture(host, body.scope, authorize);
  if (final.observation.head_commit !== exactOwnerCommit || final.observation.status.length || final.observation.outside_scope_dirty)
    fail('DIRTY_GIT_WORKTREE', 5, 'Owner commit must be current HEAD of a clean whole repository.');
  if (final.snapshot.head_tree !== prepared.trees.desired) fail('RECONCILIATION_OWNER_COMMIT', 5, 'Owner commit tree differs from the desired complete tree.');
  const pool = new Pool(identity);
  for (const pin of prepared.objects) pool.add(readPinned(host.read, pin, 'reconciliation-git-object'));
  const commit = pool.load(exactOwnerCommit, 'commit'), parsed = verifyRawGitObject(commit);
  if (parsed.kind !== 'commit') throw Error('Commit expected');
  const sameHead = exactOwnerCommit === prepared.observed_head_oid;
  if (sameHead ? prepared.observation.status.length > 0 || prepared.observation.outside_scope_dirty || prepared.trees.head !== prepared.trees.desired
    : parsed.parents.length !== 1 || parsed.parents[0] !== prepared.observed_head_oid)
    fail('RECONCILIATION_OWNER_COMMIT', 5, 'Owner commit must be reviewed clean H or exactly one single-parent child of H.');
  const preparedIds = new Set(prepared.objects.map(pin => readPinned(host.read, pin, 'reconciliation-git-object').oid));
  const newObjectRecords = pool.records().filter(record => !preparedIds.has(record.oid));
  const proof: CommittedProof = { format: 'reconciliation-source-proof/1', phase: 'committed', project_id: host.projectId, repo_id: host.repoId,
    object_format: identity.object_format, prepared: verified.proof_pin, plan: recordPin('reconciliation-proposal', plan),
    source_snapshot: recordPin('source-snapshot', final.snapshot), observation: final.observation, observation_sha256: digest(final.observation),
    owner_commit_oid: exactOwnerCommit, tree_oid: final.snapshot.head_tree, transition: sameHead ? 'same-reviewed-clean-head' : 'direct-child',
    additional_objects: newObjectRecords.map(record => recordPin('reconciliation-git-object', record)) };
  verifyCommittedSourceProof(reader(host, newObjectRecords, [{ type: 'source-snapshot', data: final.snapshot },
    { type: 'reconciliation-proposal', data: plan }, { type: 'reconciliation-source-proof', data: prepared }]), proof);
  cancelled(host); assertLateSourceSynchronously(identity, final.observation, body.scope);
  return { sourceSnapshot: final.snapshot, observation: final.observation, proof, newObjectRecords,
    immutableInputs: inputs(pool, prepared.selected.desired) };
}
