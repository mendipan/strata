import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { noLinks } from '../node-state.js';
import { problem, safeJson } from './contract.js';
import { trustedFile } from './source.js';

export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const secret = () => Buffer.from(randomBytes(32)).toString('base64url');
export function recovery():never { return problem('SETUP_RECOVERY_REQUIRED', 503, 'Protected owner state needs authenticated operator reconciliation.'); }
export async function privateDir(directory: string, create = false) {
  await noLinks(directory);
  if (create) {
    const parent = await lstat(path.dirname(directory));
    if (!parent.isDirectory() || (process.platform !== 'win32' && (parent.mode & 0o077))) recovery();
    try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await syncDirectory(path.dirname(directory));
  }
  const meta = await lstat(directory);
  if (!meta.isDirectory() || meta.isSymbolicLink() || (process.platform !== 'win32' && ((meta.mode & 0o077) || meta.uid !== process.getuid?.()))) recovery();
}
export async function readPrivate(filename: string, max = 16384): Promise<unknown> {
  const meta = await lstat(filename);
  if (!meta.isFile() || meta.isSymbolicLink() || (process.platform !== 'win32' && ((meta.mode & 0o077) || (process.getuid?.()!==0 && meta.uid !== process.getuid?.())))) recovery();
  return safeJson(await trustedFile(filename, max), max);
}
export async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function writePrivate(filename: string, value: unknown, exclusive = false, mode = 0o600) {
  await noLinks(filename);
  const temp = exclusive ? filename : filename + '.' + Buffer.from(randomBytes(16)).toString('hex');
  const handle = await open(temp, 'wx', mode);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) { try { await rename(temp, filename); } catch (e) { await unlink(temp).catch(() => {}); throw e; } }
  await syncDirectory(path.dirname(filename));
}
export async function optionalPrivate(filename: string): Promise<unknown | undefined> {
  try { return await readPrivate(filename); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function withLease<T>(directory: string, operation: () => Promise<T>) {
  await privateDir(directory);
  const filename = path.join(directory, '.owner.lock'); await noLinks(filename);
  let handle;
  try { handle = await open(filename, 'wx', 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') problem('SETUP_BUSY', 409, 'Owner state is busy. An interrupted lease needs operator reconciliation.');
    throw e;
  }
  try { await handle.writeFile(JSON.stringify({ format: 'strata-owner-lease/1', pid: process.pid })); await handle.sync(); return await operation(); }
  finally { await handle.close(); await unlink(filename); }
}
