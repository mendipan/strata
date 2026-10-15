import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { digest, fail, StrataError } from '../model.js';
import { privateDir, readPrivate, withLease, writePrivate } from './owner-files.js';
import { assertGrantActive, repositoryGrantSchema, repositoryGrantDigest, workspaceHash,
  type RepositoryGrant } from './workspace-policy.js';
import { WORKSPACE_PROVIDER_OPERATIONS } from './workspace-policy.js';
import type { WorkspaceDispatchKind, WorkspaceIoReservations } from './workspace-ports.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const workspaceBudgetSchema = z.object({
  format: z.literal('strata-studio-io-budget/2'), binding_sha256: workspaceHash,
  origin_sha256: workspaceHash, generation: count, reserved_requests: count, reserved_bytes: count,
  reservations: z.array(z.object({ id: z.string().uuid(), operation: workspaceHash,
    kind: z.enum(WORKSPACE_PROVIDER_OPERATIONS), maximum_bytes: count,
    requests_after: count, bytes_after: count }).strict()).max(20_000),
}).strict();
export type WorkspaceBudget = z.infer<typeof workspaceBudgetSchema>;
export type BudgetOrigin = { format: 'strata-studio-budget-carry/1'; old_lineage_sha256: string;
  reserved_requests: number; reserved_bytes: number };
export const budgetOriginSchema = z.object({ format: z.literal('strata-studio-budget-carry/1'),
  old_lineage_sha256: workspaceHash, reserved_requests: count, reserved_bytes: count }).strict();
// Pure operator preparation. Startup/reserve/snapshot never call this function.
export function initialWorkspaceBudget(grant: RepositoryGrant, origin: BudgetOrigin): WorkspaceBudget {
  const g = repositoryGrantSchema.parse(grant), o = budgetOriginSchema.parse(origin);
  if (o.reserved_requests > g.limits.requests || o.reserved_bytes > g.limits.bytes)
    fail('WORKSPACE_BUDGET_EXHAUSTED', 4, 'Carried usage exceeds the approved workspace allowance.');
  return workspaceBudgetSchema.parse({ format: 'strata-studio-io-budget/2',
    binding_sha256: repositoryGrantDigest(g), origin_sha256: digest(o), generation: 0,
    reserved_requests: o.reserved_requests, reserved_bytes: o.reserved_bytes, reservations: [] });
}
export class FileWorkspaceBudget implements WorkspaceIoReservations {
  private queue:Promise<void>=Promise.resolve();private pending=0;
  private readonly directory: string;
  private readonly binding: string;
  private readonly grant: RepositoryGrant;
  private readonly origin: BudgetOrigin;
  constructor(private readonly filename: string, grant: RepositoryGrant, origin: BudgetOrigin, private now = Date.now) {
    if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) this.unavailable();
    this.directory = path.dirname(filename); this.grant = structuredClone(repositoryGrantSchema.parse(grant));
    this.origin = budgetOriginSchema.parse(origin); this.binding = initialWorkspaceBudget(this.grant, this.origin).binding_sha256;
  }
  private unavailable(): never { return fail('WORKSPACE_ACCOUNTING_UNAVAILABLE', 9,
    'Protected workspace accounting requires authenticated operator reconciliation.'); }
  private async read() {
    const meta = await lstat(this.filename);
    if (meta.nlink !== 1) this.unavailable();
    const parsed = workspaceBudgetSchema.safeParse(await readPrivate(this.filename, 8 * 1024 ** 2));
    if (!parsed.success) this.unavailable();
    const b = parsed.data;
    if (b.binding_sha256 !== this.binding || b.origin_sha256 !== digest(this.origin) ||
        b.reservations.length > this.grant.limits.max_journal_entries || b.generation !== b.reservations.length ||
        b.reserved_requests > this.grant.limits.requests || b.reserved_bytes > this.grant.limits.bytes ||
        new Set(b.reservations.map(r => r.id)).size !== b.reservations.length) this.unavailable();
    let requests = this.origin.reserved_requests, bytes = this.origin.reserved_bytes;
    for (const r of b.reservations) {
      requests++; bytes += r.maximum_bytes;
      if (r.requests_after !== requests || r.bytes_after !== bytes || !Number.isSafeInteger(bytes)) this.unavailable();
    }
    if (b.reserved_requests !== requests || b.reserved_bytes !== bytes) this.unavailable();
    return b;
  }
  private async protected<T>(operation: () => Promise<T>): Promise<T> {
    if(this.pending>=64)fail('WORKSPACE_BUSY',9,'Workspace accounting request capacity reached.');this.pending++;
    const task=this.queue.then(async()=>{try { await privateDir(this.directory); return await withLease(this.directory, operation); }
      catch (e) {if (e instanceof StrataError) throw e;return this.unavailable();}});
    this.queue=task.then(()=>{},()=>{});try{return await task;}finally{this.pending--;}
  }
  async ready() { await this.protected(async () => { await this.read(); }); }
  async operationReceipt(operation:string){workspaceHash.parse(operation);return this.protected(async()=>{
    const b=await this.read(),reservations=b.reservations.filter(r=>r.operation===operation);
    return {binding_sha256:b.binding_sha256,origin_sha256:b.origin_sha256,generation:b.generation,
      reservation_ids:reservations.map(r=>r.id),reserved_requests:reservations.length,
      reserved_bytes:reservations.reduce((n,r)=>n+r.maximum_bytes,0),reservations_sha256:digest(reservations)};
  });}
  async snapshot() { return this.protected(async () => {
    const b = await this.read();
    return { generation: b.generation, limits: { requests: this.grant.limits.requests, bytes: this.grant.limits.bytes },
      reserved: { requests: b.reserved_requests, bytes: b.reserved_bytes },
      remaining: { requests: this.grant.limits.requests - b.reserved_requests, bytes: this.grant.limits.bytes - b.reserved_bytes } };
  }); }
  async reserve(id: string, operation: string, kind: WorkspaceDispatchKind, maximumBytes: number) {
    if (!z.string().uuid().safeParse(id).success || !workspaceHash.safeParse(operation).success ||
        !WORKSPACE_PROVIDER_OPERATIONS.includes(kind) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      this.unavailable();
    assertGrantActive(this.grant, this.now());
    await this.protected(async () => {
      assertGrantActive(this.grant, this.now()); const b = await this.read();
      // Never return successful admission for an already-persisted dispatch ID.
      if (b.reservations.some(r => r.id === id)) fail('WORKSPACE_DISPATCH_REPLAY', 5, 'Dispatch reservation was already consumed.');
      const requests = b.reserved_requests + 1, bytes = b.reserved_bytes + maximumBytes;
      if (requests > this.grant.limits.requests || bytes > this.grant.limits.bytes)
        fail('WORKSPACE_BUDGET_EXHAUSTED', 4, 'Workspace request or reserved-transfer allowance is exhausted.');
      if (b.reservations.length >= this.grant.limits.max_journal_entries)
        this.unavailable();
      await writePrivate(this.filename, { ...b, generation: b.generation + 1, reserved_requests: requests,
        reserved_bytes: bytes, reservations: [...b.reservations, { id, operation, kind, maximum_bytes: maximumBytes,
          requests_after: requests, bytes_after: bytes }] });
    });
  }
}
