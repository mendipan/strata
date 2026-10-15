import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { MODEL, BLOCK_MODEL, digest, fail } from '../model.js';
import { noLinks } from '../node-state.js';
import { safeJson } from './contract.js';
import { trustedFile } from './source.js';

export const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const workspaceHash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const lifetimeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('until-revoked'), expires_at: z.null() }).strict(),
  z.object({ mode: z.literal('until'), expires_at: z.string().datetime() }).strict(),
]);
export type GrantLifetime = z.infer<typeof lifetimeSchema>;
export function lifetimeActive(lifetime: GrantLifetime, now: number) {
  return lifetime.mode === 'until-revoked' || now < Date.parse(lifetime.expires_at);
}
export const workspaceLimitsSchema = z.object({
  requests: integer.min(1).max(100_000), bytes: integer.min(1).max(10 * 1024 ** 3),
  max_operation_requests: integer.min(1).max(50), max_operation_bytes: integer.min(1).max(16 * 1024 ** 2),
  max_payload_bytes: integer.min(1).max(4 * 1024 ** 2), max_journal_entries: integer.min(1).max(20_000),
}).strict();
export const DEFAULT_WORKSPACE_LIMITS = { requests: 10_000, bytes: 1024 ** 3,
  max_operation_requests: 50, max_operation_bytes: 16 * 1024 ** 2,
  max_payload_bytes: 4 * 1024 ** 2, max_journal_entries: 20_000 };
export const WORKSPACE_PROVIDER_OPERATIONS = ['repository.info', 'file.read', 'token.issue',
  'git.discover', 'git.immutable-batch', 'token.revoke-owned'] as const;
export const WORKSPACE_WRITES = ['layer.create', 'layer.revise', 'layer.restore', 'layer.publish',
  'compose', 'conflicts.report', 'context.use'] as const;
export const repositoryGrantSchema = z.object({
  format: z.literal('strata-studio-repository-grant/1'), installation_id: z.string().uuid(), owner_id: z.string().uuid(),
  lineage_id: z.string().uuid(), grant_id: z.string().uuid(), policy_generation: integer.min(1),
  issued_at: z.string().datetime(), not_before: z.string().datetime(), lifetime: lifetimeSchema,
  project_id: workspaceId, model_version: z.enum([MODEL, BLOCK_MODEL]),
  storage: z.object({ account: z.string().regex(/^[a-f0-9]{32}$/), namespace: workspaceId,
    repository: workspaceId, expected_repository_id: workspaceId,
    remote: z.string().url().refine(s => {
      const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash &&
        u.port === '' && u.hostname.endsWith('.artifacts.cloudflare.net');
    }) }).strict(),
  import_manifest_sha256: workspaceHash, credential_id: z.literal('artifacts-api-token'),
  actor_binding_sha256: workspaceHash, access: z.literal('read-write'),
  // Omission preserves the stronger existing prerequisite and digest. A weaker
  // development contract changes the full grant/ledger binding explicitly.
  provider_contract: z.enum(['immutable-id', 'development-name-addressed']).optional(),
  provider_operations: z.tuple(WORKSPACE_PROVIDER_OPERATIONS.map(o => z.literal(o)) as
    [z.ZodLiteral<'repository.info'>, z.ZodLiteral<'file.read'>, z.ZodLiteral<'token.issue'>,
     z.ZodLiteral<'git.discover'>, z.ZodLiteral<'git.immutable-batch'>, z.ZodLiteral<'token.revoke-owned'>]),
  limits: workspaceLimitsSchema,
}).strict().superRefine((g, ctx) => {
  if (Date.parse(g.issued_at) > Date.parse(g.not_before) ||
      g.lifetime.mode === 'until' && Date.parse(g.not_before) >= Date.parse(g.lifetime.expires_at))
    ctx.addIssue({ code: 'custom', message: 'Grant dates must form an ordered authorization interval.' });
  const u = new URL(g.storage.remote);
  if (g.storage.remote !== `https://${g.storage.account}.artifacts.cloudflare.net/git/${g.storage.namespace}/${g.storage.repository}.git`)
    ctx.addIssue({ code: 'custom', message: 'Repository remote must bind the exact configured name.' });
});
export type RepositoryGrant = z.infer<typeof repositoryGrantSchema>;
export const repositoryGrantDigest = (grant: RepositoryGrant) => digest(repositoryGrantSchema.parse(grant));
export function assertGrantActive(grant: RepositoryGrant, now = Date.now()) {
  if (now < Date.parse(grant.not_before) || !lifetimeActive(grant.lifetime, now))
    fail('REPOSITORY_ACCESS_REVOKED', 4, 'Repository access is not currently authorized.');
}
export function canonicalDisjointPaths(paths: string[]) {
  if (paths.some(p => !path.isAbsolute(p) || path.resolve(p) !== p))
    fail('WORKSPACE_NOT_CONFIGURED', 2, 'Workspace paths must be canonical absolute paths.');
  const contains = (a: string, b: string) => {
    const r = path.relative(a, b); return r === '' || !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep);
  };
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++)
    if (contains(paths[i], paths[j]) || contains(paths[j], paths[i]))
      fail('WORKSPACE_NOT_CONFIGURED', 2, 'Workspace state and protected inputs must be distinct and disjoint.');
}
// Root policy is never synthesized or made writable by the service.
export async function readRootWorkspaceFile(filename: string, maximum = 256 * 1024) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename)
    fail('WORKSPACE_NOT_CONFIGURED', 2, 'Protected configuration needs a canonical path.');
  await noLinks(filename);
  for (let current = filename;;) {
    const meta = await lstat(current);
    if (meta.isSymbolicLink() || current === filename && (!meta.isFile() || meta.nlink !== 1 || meta.size > maximum) ||
        process.platform !== 'win32' && (meta.uid !== 0 || (meta.mode & 0o022)))
      fail('WORKSPACE_NOT_CONFIGURED', 4, 'Workspace policy requires protected root-controlled custody.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return safeJson(await trustedFile(filename, maximum), maximum);
}
