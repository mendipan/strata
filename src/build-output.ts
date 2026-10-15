import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, opendir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bytesDigest, canonical, digest, fail } from './model.js';
import type { Realization } from './profile.js';
import { verifyOutput } from './commands/node.js';

export const LOCAL_OUTPUT_LIMITS = Object.freeze({ files: 32, file_bytes: 1048576, total_bytes: 4194304, attempts_per_root: 1024 });
export type DirectoryProtection = { safe: boolean; fingerprint: string };
/** Installation-owned adapter. No client can provide this callback or a filesystem path. */
export type ProtectionInspector = (directory: string) => Promise<DirectoryProtection>;
export type OutputSlot = {
  id: string; label: string; root: string;
  // Complete installation inventory, including source, registry, credentials and document roots.
  excluded_roots: readonly string[]; protection: ProtectionInspector;
};
export type OutputRootReceipt = { identity: string; protection_sha256: string };
export type OutputAllocation = { relative: string; identity: string };
export type OutputFile = { file_id: string; name: string; bytes: number; sha256: string };
export type WindowsProtectionItem = { reparse: boolean; owner: string; rules: Array<{ sid: string; allow: boolean; inherit_only: boolean; rights: number }> };
export function assessWindowsOutputProtection(items: WindowsProtectionItem[], serviceSid: string): boolean {
  const allowed = [serviceSid, 'S-1-5-18', 'S-1-5-32-544'];
  // TrustedInstaller is an installation administrator; callers cannot add arbitrary trusted SIDs.
  const installer = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
  return items.length > 0 && items.every((i, n) => !i.reparse && [...allowed, installer].includes(i.owner) && i.rules.every(r => !r.allow || allowed.includes(r.sid) || r.sid === installer || (n > 0 && (r.inherit_only || (r.rights & 0xD0140) === 0))));
}
export function assessUnixOutputProtection(root: { uid: number; mode: number }, ancestors: Array<{ uid: number; mode: number }>, uid: number): boolean {
  return root.uid === uid && (root.mode & 0o077) === 0 && ancestors.every(s => (s.uid === uid || s.uid === 0) && (!(s.mode & 0o022) || (s.uid === 0 && !!(s.mode & 0o1000))));
}
const safeId = /^[a-f0-9]{64}$/;

export function assertFlatOutputNames(files: Record<string, string>): void {
  const names = Object.keys(files), folded = new Set<string>();
  if (!names.length || names.length > LOCAL_OUTPUT_LIMITS.files) fail('OUTPUT_LIMIT', 2, 'Generated output exceeds the file bound.');
  let bytes = 0;
  for (const name of [...names, 'realization.json']) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name === '.' || name === '..' || folded.has(name.toLowerCase())) fail('OUTPUT_NAME_UNSAFE', 2, 'Only unique portable flat output filenames are supported.');
    folded.add(name.toLowerCase());
    if (name !== 'realization.json') {
      if (typeof files[name] !== 'string') fail('OUTPUT_NAME_UNSAFE', 2, 'Only text output is supported.');
      const size = Buffer.byteLength(files[name]); bytes += size;
      if (size > LOCAL_OUTPUT_LIMITS.file_bytes) fail('OUTPUT_LIMIT', 2, 'Generated file exceeds the byte bound.');
    }
  }
  if (bytes > LOCAL_OUTPUT_LIMITS.total_bytes) fail('OUTPUT_LIMIT', 2, 'Generated output exceeds the byte bound.');
}
function contained(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function identity(stat: Awaited<ReturnType<typeof lstat>>): string { return digest({ dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs }); }
async function noLinks(directory: string): Promise<void> {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    const resolved = path.resolve(await realpath(current));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === 'win32' ? resolved.toLowerCase() !== current.toLowerCase() : resolved !== current)) fail('OUTPUT_ROOT_UNSAFE', 4, 'Output paths through links, junctions or aliases are refused.');
  }
}
async function canonicalExclusion(requested: string): Promise<string> {
  let ancestor = path.resolve(requested);
  const tail: string[] = [];
  for (;;) {
    try { await lstat(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === path.dirname(ancestor)) fail('OUTPUT_ROOT_UNSAFE', 4, 'Excluded location cannot be qualified.');
      tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); continue;
    }
    // A dangling link is an existing unsafe ancestor, not a missing lexical component.
    let resolved: string;
    try { resolved = await realpath(ancestor); }
    catch { fail('OUTPUT_ROOT_UNSAFE', 4, 'Excluded location has an unresolved existing ancestor.'); }
    if (tail.length && !(await lstat(resolved)).isDirectory()) fail('OUTPUT_ROOT_UNSAFE', 4, 'Excluded location has a non-directory ancestor.');
    return path.join(resolved, ...tail);
  }
}
/** Linux service root and ancestors must be protected from untrusted replacement. */
export function unixOutputProtection(uid = process.getuid?.()): ProtectionInspector {
  return async directory => {
    if (process.platform !== 'linux' || uid === undefined) return { safe: false, fingerprint: digest('unix-unavailable') };
    const stat = await lstat(directory), chain: Array<{ dev: number; ino: number; uid: number; mode: number }> = [];
    for (let current = directory; ; current = path.dirname(current)) {
      const s = await lstat(current); chain.push({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode });
      if (current === path.dirname(current)) break;
    }
    return { safe: assessUnixOutputProtection(stat, chain, uid), fingerprint: digest(chain) };
  };
}
/** Compiled, bounded Windows ACL/reparse inspection using the configured system executable. */
export function windowsOutputProtection(powershell: string, serviceSid: string): ProtectionInspector {
  if (!path.win32.isAbsolute(powershell) || !/^S-1-5-[0-9-]+$/.test(serviceSid)) fail('OUTPUT_PROTECTION_UNSUPPORTED', 8, 'Configure the trusted system PowerShell and service SID.');
  return async directory => {
    if (process.platform !== 'win32') return { safe: false, fingerprint: digest('windows-unavailable') };
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    // All ancestors are checked for reparse attributes and rights allowing replacement.
    const script = `$ErrorActionPreference='Stop'; $p=${quote(directory)}; $items=@(); while($p) { $i=Get-Item -LiteralPath $p -Force; $a=Get-Acl -LiteralPath $p; $items+=@{path=$p; reparse=(($i.Attributes -band 1024) -ne 0); owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; allow=($_.AccessControlType -eq 'Allow'); inherit_only=(($_.PropagationFlags -band 2) -ne 0); rights=[int]$_.FileSystemRights} })}; $next=[IO.Path]::GetDirectoryName($p.TrimEnd('\\')); if(!$next -or $next -eq $p){break}; $p=$next }; ConvertTo-Json -InputObject @($items) -Depth 6 -Compress`;
    const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 5000, maxBuffer: 65536,
      // No inherited credentials or repository-supplied module search path.
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PSModulePath: path.win32.join(path.win32.dirname(powershell), 'Modules') }
    });
    const items = JSON.parse(stdout) as WindowsProtectionItem[];
    const safe = assessWindowsOutputProtection(items, serviceSid);
    // Root is private, including read access. Ancestors may allow creation but not deletion/replacement.
    return { safe, fingerprint: digest(items) };
  };
}

export class LocalBuildOutput {
  constructor(readonly slot: OutputSlot) {}
  async preflight(): Promise<OutputRootReceipt> {
    if (!path.isAbsolute(this.slot.root) || !this.slot.excluded_roots.length || this.slot.excluded_roots.some(p => !path.isAbsolute(p))) fail('OUTPUT_ROOT_UNSAFE', 4, 'An absolute isolated installation output root and exclusion inventory are required.');
    if (process.platform === 'win32' && path.parse(this.slot.root).root.startsWith('\\\\')) fail('OUTPUT_ROOT_UNSAFE', 4, 'Network output roots are unsupported.');
    await noLinks(this.slot.root);
    const root = await realpath(this.slot.root);
    for (const excluded of this.slot.excluded_roots) {
      // Resolve the nearest existing ancestor before appending an absent path tail.
      // Existing junctions cannot conceal future source/registry/credential locations.
      const resolved = await canonicalExclusion(excluded);
      if (contained(resolved, root) || contained(root, resolved)) fail('OUTPUT_ROOT_UNSAFE', 4, 'Output root overlaps a source, registry, credential or document root.');
    }
    const protection = await this.slot.protection(root);
    if (!protection.safe || !safeId.test(protection.fingerprint)) fail('OUTPUT_ROOT_UNSAFE', 4, 'Installation output protections could not be established.');
    return { identity: identity(await lstat(root)), protection_sha256: protection.fingerprint };
  }
  async allocate(repository: string, buildId: string, expected: OutputRootReceipt): Promise<OutputAllocation> {
    if (!safeId.test(buildId)) fail('INVALID_RECORD', 2, 'Build ID must be a full digest.');
    if (canonical(await this.preflight()) !== canonical(expected)) fail('OUTPUT_ROOT_CHANGED', 6, 'Output root identity or protections changed.');
    // The OS exclusive claim covers the entire root across instances/repositories/processes.
    // A stale claim after process death refuses; only stopped-host installation recovery may clear it.
    const lockPath = path.join(this.slot.root, '.build-allocation.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('OUTPUT_ALLOCATION_BUSY', 5, 'Output allocation is owned by another attempt or requires stopped-host reconciliation.'); throw error; }
    const lockIdentity = identity(await lock.stat());
    try {
      if (canonical(await this.preflight()) !== canonical(expected)) fail('OUTPUT_ROOT_CHANGED', 6, 'Output root changed before allocation reservation.');
      return await this.allocateReserved(repository, buildId, expected);
    } finally {
      await lock.close();
      const retained = await lstat(lockPath);
      if (!retained.isFile() || retained.isSymbolicLink() || identity(retained) !== lockIdentity) fail('OUTPUT_ROOT_CHANGED', 6, 'Allocation claim was replaced; it was not removed.');
      await unlink(lockPath);
    }
  }
  private async allocateReserved(repository: string, buildId: string, expected: OutputRootReceipt): Promise<OutputAllocation> {
    const parent = path.join(this.slot.root, digest(repository));
    // Bounded I/O ownership journal only: no repository/profile records or execution authority.
    const journal = path.join(this.slot.root, '.build-ownership');
    try { await mkdir(journal, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await noLinks(journal);
    if (!(await this.slot.protection(journal)).safe) fail('OUTPUT_ROOT_UNSAFE', 4, 'Build ownership journal is not protected.');
    let count = 0;
    for await (const entry of await opendir(journal)) {
      if (++count >= LOCAL_OUTPUT_LIMITS.attempts_per_root) fail('OUTPUT_CAPACITY', 8, 'Build output ownership capacity is full; preserve history and configure another reviewed slot.');
    }
    const relative = path.join(digest(repository), buildId);
    const ownership = await open(path.join(journal, buildId + '.json'), 'wx', 0o600);
    try {
      await ownership.writeFile(canonical({ format: 'strata-build-output-ownership/1', build_id: buildId, repository_sha256: digest(repository), relative, root_identity: expected.identity }));
      await ownership.sync();
    } finally { await ownership.close(); }
    try { await mkdir(parent, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await noLinks(parent);
    if (!(await this.slot.protection(parent)).safe) fail('OUTPUT_ROOT_UNSAFE', 4, 'Repository output directory is not protected.');
    const full = path.join(this.slot.root, relative);
    // Never adopt an earlier directory after an unknown outcome.
    await mkdir(full, { mode: 0o700 });
    await noLinks(full);
    if (!(await this.slot.protection(full)).safe) fail('OUTPUT_ROOT_UNSAFE', 4, 'Build output directory is not protected.');
    return { relative, identity: identity(await lstat(full)) };
  }
  async directory(allocation: OutputAllocation): Promise<string> {
    if (!/^[a-f0-9]{64}[\\/][a-f0-9]{64}$/.test(allocation.relative)) fail('OUTPUT_LOCATOR_INVALID', 4, 'Unknown output locator.');
    await this.preflight();
    const full = path.join(this.slot.root, allocation.relative); await noLinks(full);
    if (identity(await lstat(full)) !== allocation.identity || !(await this.slot.protection(full)).safe) fail('OUTPUT_ROOT_CHANGED', 6, 'Output directory changed.');
    return full;
  }
  async inventory(allocation: OutputAllocation, buildId: string, realizationRef: string, record: Realization): Promise<OutputFile[]> {
    assertFlatOutputNames(record.files);
    const directory = await this.directory(allocation);
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder().decode(await this.readRegular(path.join(directory, 'realization.json')))); }
    catch { fail('OUTPUT_TAMPERED', 6, 'Output manifest is unreadable.'); }
    if (canonical(decoded) !== canonical({ realization_ref: realizationRef, record })) fail('OUTPUT_TAMPERED', 6, 'Output manifest differs from the retained realization.');
    const manifest = await verifyOutput(this.slot.root, path.join(directory, 'realization.json'));
    if (manifest.realization_ref !== realizationRef || canonical(manifest.record) !== canonical(record)) fail('OUTPUT_TAMPERED', 6, 'Output manifest does not match the retained build realization.');
    const files: OutputFile[] = [];
    for (const name of [...Object.keys(record.files), 'realization.json'].sort()) {
      const body = await this.readRegular(path.join(directory, name));
      if (name !== 'realization.json' && (body.length !== Buffer.byteLength(record.files[name], 'utf8') || bytesDigest(body) !== bytesDigest(record.files[name]))) fail('OUTPUT_TAMPERED', 6, 'Output bytes do not match the retained realization.');
      files.push({ file_id: digest({ build_id: buildId, name }), name, bytes: body.length, sha256: bytesDigest(body) });
    }
    if (files.reduce((n, f) => n + f.bytes, 0) > LOCAL_OUTPUT_LIMITS.total_bytes * 2) fail('OUTPUT_LIMIT', 2, 'Output inventory exceeds the byte bound.');
    return files;
  }
  private async readRegular(full: string): Promise<Buffer> {
    const before = await lstat(full);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > LOCAL_OUTPUT_LIMITS.total_bytes) fail('OUTPUT_TAMPERED', 6, 'Output requires bounded regular files without links.');
    if (process.platform === 'win32' && !(await this.slot.protection(full)).safe) fail('OUTPUT_TAMPERED', 6, 'Output file protections or reparse attributes changed.');
    const file = await open(full, constants.O_RDONLY | (process.platform === 'linux' ? constants.O_NOFOLLOW : 0));
    try {
      const stat = await file.stat();
      if (identity(stat) !== identity(before)) fail('OUTPUT_TAMPERED', 6, 'Output file was replaced.');
      const bytes = await file.readFile();
      const after = await lstat(full);
      if (identity(after) !== identity(before) || after.size !== stat.size || after.mtimeMs !== before.mtimeMs) fail('OUTPUT_TAMPERED', 6, 'Output changed during the read.');
      return bytes;
    } finally { await file.close(); }
  }
  async read(allocation: OutputAllocation, expected: OutputFile): Promise<Buffer> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(expected.name)) fail('OUTPUT_LOCATOR_INVALID', 4, 'Unknown output file.');
    const directory = await this.directory(allocation), bytes = await this.readRegular(path.join(directory, expected.name));
    if (bytes.length !== expected.bytes || bytesDigest(bytes) !== expected.sha256) fail('OUTPUT_TAMPERED', 6, 'Download bytes changed since verification.');
    return bytes;
  }
}
