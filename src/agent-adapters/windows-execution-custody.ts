import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentExecutionError } from '../agent-execution.js';
import { noLinks } from '../node-state.js';
import { queryWindowsCustody, windowsCustodyOutputLimit } from './windows-execution-custody-query.js';
import type { LocalExecutionStorageCustody } from './local-execution-storage.js';

const diagnostics = {
  platform: 'Windows custody requires a supported local Windows host.',
  path: 'Windows custody requires an ordinary directory and singly linked files at their exact paths.',
  query: 'Windows custody metadata query is unavailable.',
  response: 'Windows custody metadata response is incomplete or invalid.',
  descriptor: 'Windows custody descriptor semantics are unsupported.',
  owner: 'Windows custody requires current process user ownership.',
  access: 'Windows custody refuses an access grant to another principal.',
  inheritance: 'Windows custody requires private owner access inherited by files.',
  changed: 'Windows custody metadata or path identity changed during verification.',
} as const;
export type WindowsCustodyReason = keyof typeof diagnostics;
type Entry = 'directory' | 'journal' | 'lease' | 'stage';
export class WindowsExecutionCustodyError extends AgentExecutionError {
  constructor(readonly reason: WindowsCustodyReason, readonly entry?: Entry) {
    super('EXECUTION_UNAVAILABLE'); this.name = 'WindowsExecutionCustodyError';
    this.message = diagnostics[reason];
  }
}
function refuse(reason: WindowsCustodyReason, entry?: Entry): never {
  throw new WindowsExecutionCustodyError(reason, entry);
}
const sid = z.string().max(184).regex(/^S-1-\d+(?:-\d+){1,15}$/);
const uint = z.number().int().min(0).max(0xffffffff);
const itemSchema = z.object({ requestedPath: z.string().max(1024), finalPath: z.string().max(1028),
  fileId: z.string().regex(/^[a-f0-9]{16}$/), volume: uint, attributes: uint, links: uint,
  ownerSid: sid, revision: uint, control: uint, aclRevision: uint,
  aces: z.array(z.object({ type: uint, flags: uint, mask: uint, sid, callback: z.boolean() }).strict()).max(128),
}).strict();
const responseSchema = z.object({ version: z.literal(1), nonce: z.string().uuid(), processSid: sid,
  items: z.array(itemSchema).min(1).max(4) }).strict();
type Item = z.infer<typeof itemSchema>;
const fullControl = 0x1f01ff;
const genericAll = 0x10000000;
function descriptor(item: Item, processSid: string, entry: Entry) {
  if (item.ownerSid !== processSid) refuse('owner', entry);
  // OWNER/GROUP/DACL only. Present/self-relative DACL required; defaulted owner/DACL,
  // pending inheritance, resource-manager, SACL and unknown flags refuse.
  if (item.revision !== 1 || item.aclRevision !== 2 ||
      (item.control & 0x8004) !== 0x8004 || (item.control & ~0x9406) !== 0) refuse('descriptor', entry);
  let current = false, inherited = false;
  for (const ace of item.aces) {
    // Plain allow ACEs only. No deny-order/effective-group solver, object ACEs,
    // callbacks, conditional ACEs, or permissive fallback for unknown rights.
    if (ace.type !== 0 || ace.callback || (ace.flags & ~0x1f) !== 0 ||
        (ace.mask & ~(fullControl | genericAll)) !== 0) refuse('descriptor', entry);
    if (ace.mask && ace.sid !== processSid) refuse('access', entry);
    const full = (ace.mask & fullControl) === fullControl || (ace.mask & genericAll) !== 0;
    if (ace.sid === processSid && full) {
      if (!(ace.flags & 8)) current = true; // INHERIT_ONLY is not current access.
      if (entry === 'directory' ? !!(ace.flags & 1) : !!(ace.flags & 16) && !(ace.flags & 8)) inherited = true;
    }
  }
  if (!current || !inherited || (entry !== 'directory' && (item.control & 0x1000))) refuse('inheritance', entry);
}
function classify(name: string): Entry {
  if (name === 'execution.json') return 'journal';
  if (name === '.owner.lock') return 'lease';
  if (/^execution\.json\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(name)) return 'stage';
  return refuse('path');
}
async function capture(directory: string) {
  await noLinks(directory);
  const names = (await readdir(directory)).sort();
  if (names.length > 3) refuse('path');
  const entries = [{ filename: directory, entry: 'directory' as Entry },
    ...names.map(name => ({ filename: path.join(directory, name), entry: classify(name) }))];
  return Promise.all(entries.map(async item => {
    await noLinks(item.filename);
    const stat = await lstat(item.filename, { bigint: true });
    if (stat.isSymbolicLink() || (item.entry === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
        stat.ino <= 0n || stat.dev <= 0n) refuse('path', item.entry);
    return { ...item, ino: stat.ino, dev: stat.dev, links: stat.nlink, ctime: stat.ctimeNs };
  }));
}

/** Explicit trusted-constructor callback; never installed or configured here.
 * Conservatively supports local NTFS, current-user-only plain allow DACLs and
 * inherited owner full control. Even SYSTEM/admin/group grants are refused:
 * there is no trust allowlist. This does not isolate a hostile same-user process,
 * privileged administrator, or mutable ancestor, or close all path/ACL races.
 */
export const assertWindowsCustody: NonNullable<LocalExecutionStorageCustody['assertWindowsCustody']> = async directory => {
  if (process.platform !== 'win32') refuse('platform');
  if (!/^[A-Za-z]:\\/.test(directory) || directory.length > 950 || directory.includes('\0') ||
      directory.slice(2).includes(':') || path.resolve(directory) !== directory) refuse('path');
  try {
    const before = await capture(directory), nonce = randomUUID();
    let output: Buffer;
    try { output = await queryWindowsCustody({ version: 1, nonce, paths: before.map(item => item.filename) }); }
    catch { return refuse('query'); }
    let response: z.infer<typeof responseSchema>;
    try {
      if (!Buffer.isBuffer(output) || output.length > windowsCustodyOutputLimit) refuse('response');
      response = responseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)));
    } catch { return refuse('response'); }
    if (response.nonce !== nonce || response.items.length !== before.length) refuse('response');
    for (const [index, expected] of before.entries()) {
      const item = response.items[index];
      if (item.requestedPath !== expected.filename || !item.finalPath.startsWith('\\\\?\\') ||
          item.finalPath.slice(4).toLowerCase() !== expected.filename.toLowerCase() ||
          BigInt('0x' + item.fileId) !== expected.ino || BigInt(item.volume) !== expected.dev ||
          (item.attributes & 0x400) || !!(item.attributes & 0x10) !== (expected.entry === 'directory') ||
          (expected.entry !== 'directory' && BigInt(item.links) !== expected.links)) refuse('path', expected.entry);
      descriptor(item, response.processSid, expected.entry);
    }
    const after = await capture(directory);
    if (after.length !== before.length || after.some((item, index) => {
      const old = before[index];
      return item.filename !== old.filename || item.ino !== old.ino || item.dev !== old.dev ||
        item.links !== old.links || item.ctime !== old.ctime;
    })) refuse('changed');
  } catch (error) {
    if (error instanceof WindowsExecutionCustodyError) throw error;
    refuse('path'); // No OS error, caller path, journal prose, or helper output.
  }
};
