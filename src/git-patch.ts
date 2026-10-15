import { TextDecoder } from 'node:util';
import { Buffer } from 'node:buffer';
import { canonical, bytesDigest, digest, fail } from './model.js';
import { GIT_LIMITS, decodeGit, gitPath, uniqueGitPaths, requireCleanGit, createGitSandbox, runGit, readGitTree, blobBytes, sourceEntry, type GitHost, type GitEntry } from './git-workspace.js';

export type FileState = { content: string | null; sha256: string | null; mode: string | null };
export type FileOperation = { path: string; before: FileState; after: FileState };
export function utf8(bytes: Buffer) { try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (value.includes('\0') || !Buffer.from(value).equals(bytes)) fail('UNSUPPORTED_PATCH', 8, 'Patch files must contain exact UTF-8 text without NUL.'); return value; } catch { fail('UNSUPPORTED_PATCH', 8, 'Binary and invalid UTF-8 patches are unsupported.'); } }
export function parseGitPatch(patch: string): string[] {
  if (!patch || Buffer.byteLength(patch) > GIT_LIMITS.patch || patch.includes('\0') || patch.includes('\r')) fail('UNSUPPORTED_PATCH', 8, 'Supply a bounded LF UTF-8 Git unified patch.');
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean), paths: string[] = [];
  for (const section of sections) {
    const lines = section.split('\n'), head = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[0]);
    if (!head || head[1] !== head[2]) fail('UNSUPPORTED_PATCH', 8, 'Renames, copies and quoted paths are unsupported.');
    const name = gitPath(head[1]); if (name.split('/').some(p => p.toLowerCase().startsWith('.git'))) fail('INVALID_PATH', 2, 'Patches cannot modify Git configuration or metadata.'); paths.push(name);
    let i = 1, added = false, deleted = false;
    while (i < lines.length && !lines[i].startsWith('--- ')) {
      const row = lines[i++];
      if (row === 'new file mode 100644') added = true;
      else if (/^deleted file mode 100(?:644|755)$/.test(row)) deleted = true;
      else if (!/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100(?:644|755))?$/.test(row)) fail('UNSUPPORTED_PATCH', 8, 'Unsupported patch metadata.');
    }
    if (added && deleted || lines[i++] !== `--- ${added ? '/dev/null' : 'a/' + name}` || lines[i++] !== `+++ ${deleted ? '/dev/null' : 'b/' + name}`) fail('UNSUPPORTED_PATCH', 8, 'Patch header paths must match exact destinations.');
    let hunks = 0;
    while (i < lines.length) {
      if (i === lines.length - 1 && lines[i] === '') break;
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[i++]);
      if (!h) fail('UNSUPPORTED_PATCH', 8, 'Expected ordinary unified diff hunks.');
      let old = 0, next = 0, context = 0;
      while (i < lines.length && !lines[i].startsWith('@@ ')) {
        const row = lines[i]; if (i === lines.length - 1 && row === '') break;
        i++;
        if (row === '\\ No newline at end of file') continue;
        if (row[0] === ' ') { old++; next++; context++; }
        else if (row[0] === '-') old++;
        else if (row[0] === '+') next++;
        else fail('UNSUPPORTED_PATCH', 8, 'Malformed unified diff content.');
      }
      if (old !== Number(h[2] ?? 1) || next !== Number(h[4] ?? 1) || (!added && !deleted && !context)) fail('UNSUPPORTED_PATCH', 8, 'Hunk counts or required edit context are invalid.');
      hunks++;
    }
    if (!hunks) fail('UNSUPPORTED_PATCH', 8, 'Empty patch sections are unsupported.');
  }
  if (!paths.length || paths.length > GIT_LIMITS.changed) fail('GIT_LIMIT', 8, 'Patch must change between one and 64 files.');
  return uniqueGitPaths(paths);
}
export async function stageGitPatch(host: GitHost, base: { head_commit: string; head_tree: string; index_digest?: string }, writePaths: string[], patch: string, directory: string) {
  const paths = parseGitPatch(patch), allowed = uniqueGitPaths(writePaths);
  if (paths.some(p => !allowed.includes(p))) fail('PATCH_SCOPE', 4, 'A patch writes outside its exact path allowlist.');
  const before = await requireCleanGit(host, base), sandbox = await createGitSandbox(host, base.head_tree, directory);
  try { await runGit(sandbox, ['apply', '--cached', '--check', '--whitespace=nowarn', '-'], patch); await runGit(sandbox, ['apply', '--cached', '--whitespace=nowarn', '-'], patch); }
  catch { fail('PATCH_CONFLICT', 5, 'Patch cannot apply cleanly to the exact base.'); }
  const result_tree_oid = decodeGit(await runGit(sandbox, ['write-tree'])).trim(), result = await readGitTree(sandbox, result_tree_oid);
  const operations: FileOperation[] = []; const entries: GitEntry[] = []; let retained = 0;
  for (const name of uniqueGitPaths([...new Set([...before.tree.map(e => e.path), ...result.map(e => e.path)])])) {
    const a = before.tree.find(e => e.path === name), b = result.find(e => e.path === name);
    if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
    if (!paths.includes(name) || !allowed.includes(name)) fail('PATCH_SCOPE', 4, 'Measured changes exceed the authorized patch paths.');
    if (a && b && a.mode !== b.mode || b && !['100644', '100755'].includes(b.mode)) fail('UNSUPPORTED_PATCH', 8, 'Mode, symlink and submodule changes are unsupported.');
    const pre = a ? (await blobBytes(before.pins.root, a))! : null, post = b ? (await blobBytes(sandbox, b))! : null;
    retained += (pre?.length ?? 0) + (post?.length ?? 0); if (retained > GIT_LIMITS.retained) fail('GIT_LIMIT', 8, 'Retained patch pre/postimages exceed the bound.');
    const state = (bytes: Buffer | null, mode: string | null): FileState => ({ content: bytes ? utf8(bytes) : null, sha256: bytes ? bytesDigest(bytes) : null, mode });
    operations.push({ path: name, before: state(pre, a?.mode ?? null), after: state(post, b?.mode ?? null) });
    entries.push(sourceEntry(b, post, name));
  }
  if (canonical(operations.map(o => o.path)) !== canonical(paths)) fail('UNSUPPORTED_PATCH', 8, 'Every patch section must change exactly one measured file.');
  await requireCleanGit(host, before.pins);
  return { sandbox, patch, patch_sha256: bytesDigest(patch), operations, result_tree_oid, result_manifest_sha256: digest(entries), unchanged_outside_write_set: true as const, base_index_digest: before.pins.index_digest };
}
