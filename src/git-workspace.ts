import { spawn,spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFile, writeFile, mkdir, mkdtemp, lstat, realpath, readlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { bytesDigest, digest, canonical, fail } from './model.js';
import { noLinks } from './node-state.js';
import { validateSourceScope, validateSourceSnapshot, validateGitObservation, pathInScope, pathExcluded, type SourceScope, type SourceEntry, type SourceSnapshot, type GitObservation, type Verification, type GitHost } from './source-binding.js';
export type { GitHost } from './source-binding.js';

export const GIT_LIMITS = { entries: 256, roots: 64, file: 4 * 1024 * 1024, source: 16 * 1024 * 1024, treeFiles: 5000, treeBytes: 64 * 1024 * 1024, patch: 256 * 1024, changed: 64, retained: 512 * 1024 };
export const decodeGit = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export type GitEntry = SourceEntry;
export type GitTreeEntry = { path: string; mode: string; oid: string; type: string };

export function gitPath(value: string): string {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(value)) fail('INVALID_PATH', 2, 'Git paths use the bounded portable ASCII path subset.');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.endsWith('.') || /^\.git(?:$|\.)/i.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('INVALID_PATH', 2, 'Git paths cannot traverse aliases, metadata or reserved names.');
  return value;
}
export function uniqueGitPaths(paths: string[]) {
  const seen = new Set<string>();
  const components = new Map<string,string>();
  for (const p of paths) { gitPath(p); const key = p.toLowerCase(); if (seen.has(key)) fail('INVALID_PATH', 2, 'Duplicate or case-aliased Git paths.'); seen.add(key); }
  for(const p of paths){const parts=p.split('/');for(let i=1;i<=parts.length;i++){const prefix=parts.slice(0,i).join('/'),key=prefix.toLowerCase(),prior=components.get(key);if(prior&&prior!==prefix)fail('INVALID_PATH',2,'Case-aliased directory components are unsupported.');components.set(key,prefix);}}
  const ordered = [...paths].sort();
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) if (ordered[j].toLowerCase().startsWith(ordered[i].toLowerCase() + '/')) fail('INVALID_PATH', 2, 'File/directory path collisions are unsupported.');
  return ordered;
}
export function gitOid(value: string, format: string) { if (!new RegExp(`^[a-f0-9]{${format === 'sha256' ? 64 : 40}}$`).test(value)) fail('INVALID_RECORD', 2, 'Expected a full Git object ID.'); return value; }
const GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'core.sparseCheckout=false'];
function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat' });
  return env;
}
export function assertGitHeadSync(host:GitHost,head:string,tree:string) {
  // Fixed read-only commands with hardened environment; never caller script arguments.
  for(const [ref,expected]of [['HEAD',head],['HEAD^{tree}',tree]]) {
    const result=spawnSync('git',[...GIT_CONFIG,'-C',host.root,'rev-parse','--verify',ref],{env:gitEnvironment(),shell:false,windowsHide:true,timeout:5000,maxBuffer:4096});
    if(result.status!==0||result.error||decodeGit(result.stdout).trim()!==expected)fail('REVALIDATION_MISMATCH',6,'Git HEAD/tree changed after late capture.');
  }
}
export async function runGit(root: string, args: string[], input?: Uint8Array | string, maximum = GIT_LIMITS.treeBytes): Promise<Buffer> {
  const env=gitEnvironment();
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_CONFIG, '-C', root, ...args], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = []; let size = 0, errorSize = 0, finished = false;
    const stop = (error: unknown) => { if (finished) return; finished = true; child.kill(); clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => stop(new Error('Git operation timed out.')), 15000);
    child.on('error', stop);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximum) stop(new Error('Git output exceeds the byte bound.')); else output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errorSize += chunk.length; if (errorSize <= 4096) errors.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('close', code => { if (finished) return; finished = true; clearTimeout(timer); if (code !== 0) reject(new Error(`Git operation failed (${code}): ${Buffer.concat(errors).toString('utf8').slice(0, 1024)}`)); else resolve(Buffer.concat(output)); });
    child.stdin.end(input);
  });
}
const gitText = async (root: string, args: string[]) => decodeGit(await runGit(root, args)).trim();
export async function identifyGitHost(host: GitHost) {
  const root = await realpath(await noLinks(host.root));
  if (await gitText(root, ['rev-parse', '--show-toplevel']) !== root.replaceAll('\\', '/') && path.resolve(await gitText(root, ['rev-parse', '--show-toplevel'])) !== root) fail('REPOSITORY_BINDING', 4, 'Host must bind the repository top-level checkout.');
  const gitDir = await realpath(await noLinks(await gitText(root, ['rev-parse', '--absolute-git-dir'])));
  const stats = await lstat(gitDir), identity = digest({ root, gitDir, dev: stats.dev, ino: stats.ino });
  if (host.identity && host.identity !== identity) fail('REPOSITORY_BINDING', 4, 'Configured repository identity changed.');
  const object_format = await gitText(root, ['rev-parse', '--show-object-format']);
  if (!['sha1', 'sha256'].includes(object_format)) fail('UNSUPPORTED_GIT_FORMAT', 8, 'Unsupported Git object format.');
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) { try { await lstat(path.join(gitDir, name)); fail('GIT_OPERATION_PENDING', 5, 'Complete the pending Git operation first.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  if ((await gitText(root, ['config', '--local', '--get', 'core.sparseCheckout']).catch(() => 'false')) === 'true') fail('UNSUPPORTED_GIT_INDEX', 8, 'Sparse checkouts are unsupported.');
  return { root, gitDir, identity, object_format };
}
export async function gitPins(host: GitHost) {
  const repo = await identifyGitHost(host), head_commit = gitOid(await gitText(repo.root, ['rev-parse', '--verify', 'HEAD']), repo.object_format), head_tree = gitOid(await gitText(repo.root, ['rev-parse', 'HEAD^{tree}']), repo.object_format);
  const indexFile = await gitText(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  await noLinks(indexFile);
  if((await lstat(indexFile)).size>GIT_LIMITS.source)fail('GIT_LIMIT',8,'Git index exceeds the metadata byte bound.');
  const index_digest = bytesDigest(await readFile(indexFile));
  const flags = decodeGit(await runGit(repo.root, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean);
  if (flags.some(row => row[0] !== 'H')) fail('UNSUPPORTED_GIT_INDEX', 8, 'Unmerged, sparse, skip-worktree and assume-unchanged index entries are unsupported.');
  return { ...repo, head_commit, head_tree, index_digest };
}
export async function readGitTree(root: string, tree: string): Promise<GitTreeEntry[]> {
  const result = decodeGit(await runGit(root, ['ls-tree', '-rz', '--full-tree', tree])).split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t(.+)$/.exec(row); if (!match) fail('INVALID_GIT_TREE', 5, 'Unrepresentable Git tree entry.');
    return { mode: match[1], type: match[2], oid: match[3], path: gitPath(match[4]) };
  });
  if (result.length > GIT_LIMITS.treeFiles) fail('GIT_LIMIT', 8, 'Repository exceeds the full-tree entry bound.');
  uniqueGitPaths(result.map(e => e.path)); return result;
}
export async function blobBytes(root: string, entry: GitTreeEntry) {
  if (entry.mode === '160000') return null;
  const bytes = await runGit(root, ['cat-file', 'blob', entry.oid], undefined, GIT_LIMITS.file);
  return bytes;
}
export function sourceEntry(entry: GitTreeEntry | undefined, bytes: Buffer | null, name: string): GitEntry {
  if (!entry) return { path: name, presence: 'absent', kind: null, mode: null, byte_length: null, sha256: null };
  return { path: name, presence: 'present', kind: entry.mode === '120000' ? 'symlink' : entry.mode === '160000' ? 'gitlink' : 'regular', mode: entry.mode as SourceEntry['mode'], byte_length: bytes?.length ?? null, sha256: bytes ? bytesDigest(bytes) : null };
}
export async function worktreeBytes(root: string, name: string): Promise<Buffer | null> {
  gitPath(name); const file = await noLinks(path.join(root, name));
  try { const stats = await lstat(file); if (!stats.isFile() || stats.nlink > 1) fail('UNSUPPORTED_GIT_FILE', 8, 'Expected an ordinary unlinked regular file.'); if (stats.size > GIT_LIMITS.file) fail('GIT_LIMIT', 8, 'Working file exceeds the byte bound.'); return await readFile(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function requireCleanGit(host: GitHost, expected?: { head_commit: string; head_tree: string; index_digest?: string }) {
  const before = await gitPins(host), tree = await readGitTree(before.root, before.head_tree);
  if (expected && (before.head_commit !== expected.head_commit || before.head_tree !== expected.head_tree || (expected.index_digest && before.index_digest !== expected.index_digest))) fail('STALE_SOURCE', 5, 'HEAD, tree or index differs from the exact reviewed base.');
  const index = decodeGit(await runGit(before.root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean).map(row => { const m = /^(\d+) ([a-f0-9]+) 0\t(.+)$/.exec(row); if (!m) fail('UNSUPPORTED_GIT_INDEX', 8, 'Unmerged index is unsupported.'); return { path: m[3], mode: m[1], oid: m[2], type: m[1] === '160000' ? 'commit' : 'blob' }; });
  if (canonical(index) !== canonical(tree)) fail('DIRTY_GIT_WORKTREE', 5, 'Staged changes are present.');
  const untracked = decodeGit(await runGit(before.root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  if (untracked.length) fail('DIRTY_GIT_WORKTREE', 5, 'Untracked changes are present.');
  let total = 0;
  for (const entry of tree) {
    if (!['100644', '100755'].includes(entry.mode)) fail('UNSUPPORTED_GIT_FILE', 8, 'Symlinks and submodules are unsupported for patch adoption.');
    const raw = (await blobBytes(before.root, entry))!, actual = await worktreeBytes(before.root, entry.path); total += raw.length;
    if (total > GIT_LIMITS.treeBytes) fail('GIT_LIMIT', 8, 'Repository exceeds the full-tree byte bound.');
    if (!actual || bytesDigest(raw) !== bytesDigest(actual)) fail('UNSUPPORTED_CHECKOUT_TRANSFORM', 5, 'Working bytes differ from raw committed bytes; edits and checkout transformations must be resolved explicitly.', { path: entry.path });
    // A nested .git directory would otherwise be omitted as ignored content.
    const components = entry.path.split('/');
    for (let i = 1; i < components.length; i++) { try { await lstat(path.join(before.root, ...components.slice(0, i), '.git')); fail('UNSUPPORTED_GIT_FILE', 8, 'Nested repositories are unsupported.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  }
  const after = await gitPins(host); if (canonical(before) !== canonical(after)) fail('STALE_SOURCE', 5, 'Repository changed during capture.');
  return { pins: before, tree };
}
export async function captureGitSource(host: GitHost, input: SourceScope, options: { expectedHead?: string; mode: 'baseline' | 'observation'; authorizePath?:(name:string)=>void; authorizeOutsidePath?:(name:string)=>void; authorizeInventory?:(name:string)=>void }): Promise<{snapshot: SourceSnapshot; observation: GitObservation}> {
  const scope = validateSourceScope(input), paths = uniqueGitPaths(scope.paths);
  options.authorizeInventory?.('.');
  const before = await gitPins(host); if (options.expectedHead && before.head_commit !== options.expectedHead) fail('STALE_SOURCE', 5, 'Expected HEAD changed.');
  const tree = await readGitTree(before.root, before.head_tree), selected = new Set(paths);
  const included = (name: string) => pathInScope(scope, name) && !pathExcluded(scope, name);
  tree.filter(e => included(e.path)).forEach(e => selected.add(e.path));
  const indexRows = decodeGit(await runGit(before.root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
  const indexed = new Map(indexRows.map(row => { const m = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/.exec(row)!; return [m[4], { mode: m[1], oid: m[2], stage: m[3] }] as const; }));
  [...indexed.keys()].filter(included).forEach(name=>selected.add(gitPath(name)));
  const allUntracked = decodeGit(await runGit(before.root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const untracked = allUntracked.filter(included);
  untracked.forEach(p => selected.add(gitPath(p)));
  const ignored = decodeGit(await runGit(before.root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], undefined, GIT_LIMITS.source)).split('\0').filter(Boolean).filter(p => pathInScope(scope,p));
  if (allUntracked.length > 5000 || ignored.length > 5000 || indexed.size > 5000) fail('GIT_LIMIT',8,'Git inventory exceeds the path bound.');
  for(const name of [...new Set([...tree.map(e=>e.path),...indexed.keys(),...allUntracked,...ignored])]) options.authorizeInventory?.(name);
  if (selected.size > GIT_LIMITS.entries) fail('GIT_LIMIT', 8, 'Scope inventory exceeds its entry bound.');
  uniqueGitPaths([...selected]);
  for(const name of selected)if(ignored.includes(name)&&!tree.some(e=>e.path===name))fail('IGNORED_SOURCE_PATH',5,'An explicit untracked source path is ignored; its contents are not measured.',{path:name});
  for(const name of selected)options.authorizePath?.(name);
  if(options.mode==='baseline')await requireCleanGit(host,before);
  const entries: GitEntry[] = [], observed: GitEntry[] = [], statuses: { path: string; staged: boolean; unstaged: boolean; untracked: boolean }[] = [], unsupported: {path:string;reason:string}[] = []; let read = 0;
  for (const name of [...selected].sort()) {
    options.authorizePath?.(name);
    const entry = tree.find(e => e.path === name), raw = entry ? await blobBytes(before.root, entry) : null;
    read += raw?.length ?? 0;
    entries.push(sourceEntry(entry, raw, name));
    let actual: Buffer | null = null, kind: GitEntry['kind'] = 'regular';
    try { const full = path.join(before.root, name); await noLinks(path.dirname(full)); const stat = await lstat(full); if (stat.isSymbolicLink()) { kind = 'symlink'; actual = Buffer.from(await readlink(full)); unsupported.push({path:name,reason:'Symlink content is link metadata; referent uninspected.'}); } else if (stat.isDirectory()) { kind = entry?.mode==='160000'?'gitlink':null; unsupported.push({path:name,reason:'Directory or Gitlink contents are uninspected.'}); } else actual = await worktreeBytes(before.root, name); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    read += actual?.length ?? 0; if (read > GIT_LIMITS.source) fail('GIT_LIMIT', 8, 'Scope read budget exceeded.');
    const index = indexed.get(name), staged = (entry?.oid ?? null) !== (index?.oid ?? null) || (entry?.mode ?? null) !== (index?.mode ?? null);
    const trackedMode=index?.mode??entry?.mode??null;
    if(actual&&kind==='regular'&&trackedMode&&!['100644','100755'].includes(trackedMode))unsupported.push({path:name,reason:'Physical regular file differs from opaque Git mode; mode unrepresentable.'});
    observed.push(actual ? { path: name, presence: 'present', kind, mode: kind==='symlink'?'120000':(trackedMode&&['100644','100755'].includes(trackedMode)?trackedMode:null) as SourceEntry['mode'], byte_length: actual.length, sha256: bytesDigest(actual) } : { path: name, presence: kind === 'gitlink' ? 'present' : 'absent', kind: kind === 'gitlink' ? kind : null, mode: kind === 'gitlink' ? '160000' : null, byte_length: null, sha256: null });
    const indexBytes = index && index.mode!=='160000' ? await blobBytes(before.root,{path:name,mode:index.mode,oid:index.oid,type:'blob'}) : null;
    read+=indexBytes?.length??0;if(read>GIT_LIMITS.source)fail('GIT_LIMIT',8,'Scope read budget exceeded.');
    const unstaged = (indexBytes ? bytesDigest(indexBytes) : null) !== (actual ? bytesDigest(actual) : null);
    if (staged || unstaged || untracked.includes(name)) statuses.push({ path: name, staged, unstaged, untracked: untracked.includes(name) });
  }
  const after = await gitPins(host); if (canonical(before) !== canonical(after)) fail('STALE_SOURCE', 5, 'Repository changed during capture.');
  // Reopen selected physical bytes and inventory before accepting a coherent observation.
  for(const e of observed) {if(e.kind==='regular'){const bytes=await worktreeBytes(before.root,e.path);if(!bytes || bytesDigest(bytes)!==e.sha256)fail('SOURCE_SNAPSHOT_STALE',5,'Source changed during observation.');}else if(e.kind==='symlink'){const file=path.join(before.root,e.path);if(!(await lstat(file)).isSymbolicLink()||bytesDigest(await readlink(file))!==e.sha256)fail('SOURCE_SNAPSHOT_STALE',5,'Link metadata changed during observation.');}else if(e.presence==='absent'){try{await lstat(path.join(before.root,e.path));fail('SOURCE_SNAPSHOT_STALE',5,'Absent path appeared during observation.');}catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;}}}
  const again=decodeGit(await runGit(before.root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);if(canonical(again)!==canonical(allUntracked))fail('SOURCE_SNAPSHOT_STALE',5,'Source inventory changed during observation.');
  let outside_scope_dirty=allUntracked.some(p=>!included(p))||[...indexed.keys()].some(p=>!included(p)&&!tree.some(e=>e.path===p)),outsideRead=0;
  for(const entry of tree.filter(e=>!included(e.path))) {const idx=indexed.get(entry.path);if(idx?.oid!==entry.oid || idx.mode!==entry.mode){outside_scope_dirty=true;continue;}if(['100644','100755'].includes(entry.mode)){options.authorizeOutsidePath?.(entry.path);const bytes=await worktreeBytes(before.root,entry.path);const raw=await blobBytes(before.root,entry);outsideRead+=(bytes?.length??0)+(raw?.length??0);if(outsideRead>GIT_LIMITS.treeBytes)fail('GIT_LIMIT',8,'Outside-scope verification exceeds its byte bound.');if(!bytes||!raw||bytesDigest(bytes)!==bytesDigest(raw))outside_scope_dirty=true;}}
  const excluded_count=tree.filter(e=>pathInScope(scope,e.path)&&pathExcluded(scope,e.path)).length;
  const snapshot=validateSourceSnapshot({format:'source-snapshot/1',project_id:host.projectId,repo_id:host.repoId,object_format:before.object_format,head_commit:before.head_commit,head_tree:before.head_tree,scope,scope_sha256:digest(scope),entries,manifest_sha256:digest(entries)});
  const observation=validateGitObservation({format:'git-observation/1',project_id:host.projectId,repo_id:host.repoId,object_format:before.object_format,head_commit:before.head_commit,head_tree:before.head_tree,index_sha256:before.index_digest,scope_sha256:digest(scope),entries:observed,manifest_sha256:digest(observed),status:statuses,outside_scope_dirty,ignored_count:ignored.length,excluded_count,unsupported,coherence:'stable',trust:'local-measurement'},scope);
  return {snapshot,observation};
}
export async function verifyGitSource(host: GitHost, expected: SourceSnapshot, options: { requireClean: boolean }): Promise<Verification> {
  const fresh=await captureGitSource(host,expected.scope,{expectedHead:expected.head_commit,mode:options.requireClean?'baseline':'observation'});
  const matches=digest(fresh.snapshot)===digest(expected)&&fresh.snapshot.manifest_sha256===fresh.observation.manifest_sha256;
  return {matches,clean:!fresh.observation.status.length&&!fresh.observation.outside_scope_dirty,observation:fresh.observation,blockers:matches?[]:[{code:'SOURCE_SNAPSHOT_STALE'}]};
}
export async function verifyGitObservation(host: GitHost, expected: GitObservation, scope: SourceScope): Promise<Verification> {
  const fresh=await captureGitSource(host,scope,{mode:'observation'}), matches=digest(fresh.observation)===digest(expected);
  return {matches,clean:!fresh.observation.status.length&&!fresh.observation.outside_scope_dirty,observation:fresh.observation,blockers:matches?[]:[{code:'SOURCE_SNAPSHOT_STALE'}]};
}
export async function createGitSandbox(host: GitHost, tree: string, directory: string) {
  await noLinks(directory); await mkdir(directory, { recursive: true }); const root = await mkdtemp(path.join(directory, 'git-stage-'));
  const source = await identifyGitHost(host); await runGit(root, ['init', '--quiet', '--object-format=' + source.object_format]);
  const rows = decodeGit(await runGit(source.root, ['ls-tree', '-rtz', '--full-tree', tree])).split('\0').filter(Boolean);
  const objects = new Map<string, string>([[tree, 'tree']]); let total = 0;
  for (const row of rows) { const m = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t(.+)$/.exec(row)!; gitPath(m[4]); if (!['040000', '100644', '100755'].includes(m[1])) fail('UNSUPPORTED_GIT_FILE', 8, 'Private checkout supports regular files only.'); objects.set(m[3], m[2]); }
  if (objects.size > GIT_LIMITS.treeFiles * 2) fail('GIT_LIMIT', 8, 'Sandbox object limit exceeded.');
  for (const [oid, type] of objects) { const bytes = await runGit(source.root, ['cat-file', type, oid], undefined, type === 'blob' ? GIT_LIMITS.file : GIT_LIMITS.treeBytes); total += bytes.length; if (total > GIT_LIMITS.treeBytes) fail('GIT_LIMIT', 8, 'Sandbox byte limit exceeded.'); const copied = decodeGit(await runGit(root, ['hash-object', '-w', '-t', type, '--stdin'], bytes)).trim(); if (copied !== oid) fail('INVALID_GIT_TREE', 6, 'Copied object identity differs.'); }
  await runGit(root, ['read-tree', tree]); return root;
}
export async function materializeGitTree(root: string, tree: string) {
  const entries = await readGitTree(root, tree);
  for (const entry of entries) { if (!['100644', '100755'].includes(entry.mode)) fail('UNSUPPORTED_GIT_FILE', 8, 'Private checkout supports regular files only.'); const file = await noLinks(path.join(root, entry.path)); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, (await blobBytes(root, entry))!, { flag: 'wx' }); }
  return entries;
}
