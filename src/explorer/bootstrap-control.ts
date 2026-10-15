import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { noLinks } from '../node-state.js';
import { safeJson } from './contract.js';
import { trustedFile } from './source.js';
import { recovery, writePrivate } from './owner-files.js';

const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const ownerBindingSchema = z.object({ installation_id: id, initialization_id: id, owner_id: id, key_id: id, initial_manifest_sha256: hash }).strict();
export const controlSchema = z.object({
  format: z.literal('strata-studio-bootstrap-control/1'), installation_id: id, enrollment_epoch: id,
  control_generation: generation, origin: z.string().url(), purpose: z.enum(['enroll-owner','resume-owner-enrollment','recover-owner-password']),
  expected_owner_generation: generation, issued_at: z.string().datetime(), expires_at: z.string().datetime(), state: z.enum(['armed','approved','closed']),
  owner_binding: ownerBindingSchema.optional(),
  approval: z.object({ approval_id: id, pending_id: id, browser_cookie_sha256: hash, reservation_sha256: hash, scope: z.literal('installation-owner'), expires_at: z.string().datetime() }).strict().optional(),
  resume: z.object({ initialization_id: id, initial_manifest_sha256: hash }).strict().optional(),
  recovery: z.object({ owner_id: id, authentication_generation: generation }).strict().optional(),
}).strict().superRefine((c, ctx) => {
  const origin = new URL(c.origin);
  if (origin.protocol !== 'https:' || origin.origin !== c.origin || c.state === 'approved' !== !!c.approval || Date.parse(c.expires_at) - Date.parse(c.issued_at) > 30 * 60_000 || Date.parse(c.expires_at) <= Date.parse(c.issued_at) ||
      (c.approval && Date.parse(c.approval.expires_at) > Date.parse(c.expires_at)) ||
      (!!c.resume !== (c.purpose === 'resume-owner-enrollment')) || (!!c.recovery !== (c.purpose === 'recover-owner-password')) ||
      (c.owner_binding && c.owner_binding.installation_id !== c.installation_id)) ctx.addIssue({ code: 'custom', message: 'Invalid control binding.' });
});
export type BootstrapControl = z.infer<typeof controlSchema>;
export type OwnerBinding = z.infer<typeof ownerBindingSchema>;

export async function readControl(filename: string, origin: string): Promise<BootstrapControl | undefined> {
  if (!path.isAbsolute(filename)) recovery();
  await noLinks(filename);
  // This is an independent administrator anchor, never service-owned state.
  let current = filename;
  try {
    for (;;) {
      const meta = await lstat(current);
      if (meta.isSymbolicLink() || (process.platform !== 'win32' && (meta.uid !== 0 || (meta.mode & 0o022)))) recovery();
      if (current === filename && (!meta.isFile() || meta.size > 4096)) recovery();
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    const parsed = controlSchema.safeParse(safeJson(await trustedFile(filename, 4096), 4096));
    if (!parsed.success || parsed.data.origin !== origin) recovery();
    return parsed.data;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
// Operator-only primitives. No HTTP handler imports a control writer.
export async function publishControl(filename: string, value: BootstrapControl) {
  if (process.platform !== 'win32' && process.getuid?.() !== 0) throw new Error('Authenticated root management is required.');
  const parsed = controlSchema.parse(value); if (Buffer.byteLength(JSON.stringify(parsed)) > 4096) throw new Error('Control exceeds its bound.');
  await noLinks(filename);
  const parent = await lstat(path.dirname(filename));
  if (!parent.isDirectory() || (process.platform !== 'win32' && (parent.uid !== 0 || (parent.mode & 0o022)))) throw new Error('Control directory is not root protected.');
  await writePrivate(filename, parsed, false, 0o644);
}
export function armControl(origin: string, installation_id:string = randomUUID(), now = Date.now()): BootstrapControl {
  return controlSchema.parse({ format: 'strata-studio-bootstrap-control/1', installation_id, enrollment_epoch: randomUUID(), control_generation: 0, origin, purpose: 'enroll-owner', expected_owner_generation: 0, issued_at: new Date(now).toISOString(), expires_at: new Date(now + 30 * 60_000).toISOString(), state: 'armed' });
}
