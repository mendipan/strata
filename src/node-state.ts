import { mkdir, open, readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BLOCK_MODEL, CONTENT_MODEL, MODEL, canonical, fail } from './model.js';

export const NODE_STATE_FORMAT = 'strata-node-state/1';
export const STATE_DESCRIPTOR = 'node-state.json';
export const STATE_LEASE = '.node-state.lock';
export const INACTIVE_MARKER = 'RECOVERY_INACTIVE.json';

// Cooperative local-process exclusion, not an identity or hostile-filesystem boundary.
export async function noLinks(requested: string): Promise<string> {
  const absolute = path.resolve(requested); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail('INVALID_PATH', 2, 'Recovery paths cannot traverse links or junctions.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return absolute;
}
export async function assertQuiesced(directory: string) {
  await noLinks(directory);
  try { await lstat(path.join(directory, STATE_LEASE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  fail('STATE_BUSY', 5, 'Node state is leased. Close its broker gracefully; stale leases require explicit operator reconciliation.');
}
export async function acquireStateLease(directory: string, role: 'broker' | 'backup') {
  await noLinks(directory);
  const file = path.join(directory, STATE_LEASE);
  let handle;
  try { handle = await open(file, 'wx'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('STATE_BUSY', 5, 'Node state is leased. Close its broker gracefully; stale leases require explicit operator reconciliation.'); throw error; }
  try { await handle.writeFile(canonical({ format: 'strata-node-lease/1', role })); }
  catch (error) { await handle.close(); await unlink(file); throw error; }
  let released = false;
  return async () => { if (!released) { released = true; await handle.close(); await unlink(file); } };
}
export async function bindNodeState(directory: string, project: string, modelVersion: typeof MODEL|typeof CONTENT_MODEL|typeof BLOCK_MODEL=MODEL) {
  await noLinks(directory);
  try { await lstat(path.join(directory, INACTIVE_MARKER)); fail('RECOVERY_INACTIVE', 4, 'This archive is inactive recovery data. A separate explicit trust/configuration binding is required.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(directory, { recursive: true });
  const release = await acquireStateLease(directory, 'broker');
  try {
    const file = path.join(directory, STATE_DESCRIPTOR); await noLinks(file);
    const descriptor = { format: NODE_STATE_FORMAT, model_version: modelVersion, project_id: project };
    try {
      const stats = await lstat(file);
      if (!stats.isFile() || stats.size > 4096 || canonical(JSON.parse(await readFile(file, 'utf8'))) !== canonical(descriptor)) fail('STATE_BINDING_MISMATCH', 4, 'Node state belongs to another project or unsupported format.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const handle = await open(file, 'wx'); try { await handle.writeFile(canonical(descriptor)); } finally { await handle.close(); }
    }
    return release;
  } catch (error) { await release(); throw error; }
}
