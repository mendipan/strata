import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { digest, fail, StrataError } from '../model.js';
import { privateDir, readPrivate, optionalPrivate, withLease, writePrivate } from './owner-files.js';
import { repositoryGrantSchema, repositoryGrantDigest, assertGrantActive, workspaceHash, type RepositoryGrant } from './workspace-policy.js';
import type { WorkspaceStageJournal, WorkspaceStagePhase } from './workspace-ports.js';

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const phases = ['prepared', 'reserved', 'token_issue_unknown', 'token_owned', 'push_unknown', 'stage_verified',
  'cleanup_unconfirmed', 'publication_prepared', 'committed', 'cancelled_before_effect', 'reconciliation_required'] as const;
const detailSchema = z.object({
  command: z.string().max(64).optional(), input_sha256: workspaceHash.optional(), authority_sha256: workspaceHash.optional(),
  request_key_sha256:workspaceHash.optional(),
  commit: z.string().regex(/^[a-f0-9]{40}$/).optional(), branch: z.string().regex(/^refs\/heads\/strata\/artifacts\/[a-f0-9]{64}$/).optional(),
  hashes: z.array(workspaceHash).max(10000).optional(),
  token_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(), expires_at: z.string().datetime().optional(),
  locators: z.array(z.object({ ref: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().regex(/^[a-f0-9]{64}\.(json|bin)$/),
    hash: workspaceHash, size_bytes: counter.min(1).max(8 * 1024 ** 2) }).strict()).max(10000).optional(),
  reason: z.string().regex(/^[a-z0-9-]{1,128}$/).optional(), cleanup: z.enum(['confirmed', 'unconfirmed']).optional(),
  before_registry_sha256: workspaceHash.optional(), after_registry_sha256: workspaceHash.optional(),
  recovery_evidence_sha256: workspaceHash.optional(),
  provider_write_contract: z.enum(['immutable-id', 'development-name-addressed']).optional(),
  provider_write_contract_sha256: workspaceHash.optional(),
}).strict().superRefine((detail,ctx)=>{
  if((detail.provider_write_contract===undefined)!==(detail.provider_write_contract_sha256===undefined))
    ctx.addIssue({code:'custom',message:'Provider contract journal binding must be complete.'});
});
const operationSchema = z.object({ operation_id: workspaceHash,
  phase: z.enum(phases), detail: detailSchema,
  events: z.array(z.object({ phase: z.enum(phases), detail: detailSchema }).strict()).max(128) }).strict();
export const workspaceStateSchema = z.object({ format: z.literal('strata-studio-workspace-state/1'),
  grant_sha256: workspaceHash, origin_sha256: workspaceHash, revision: counter,
  desired_connected: z.boolean(), revoked: z.boolean(),
  actions: z.array(z.object({ request_id: z.string().uuid(), action: z.enum(['connect', 'disconnect', 'revoke','test-read','test-write']),
    expected_revision: counter, revision: counter }).strict()).max(20000),
  tests:z.array(z.object({request_id:z.string().uuid(),kind:z.enum(['test-read','test-write']),credential_generation:workspaceHash,
    completed_at:z.string().datetime(),repository_verified:z.boolean(),write_token_verified:z.boolean(),error:z.string().regex(/^[A-Z0-9_]{1,128}$/).nullable()}).strict()).max(20000),
  operations: z.array(operationSchema).max(20000) }).strict();
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export function initialWorkspaceState(grant: RepositoryGrant, originSha256: string): WorkspaceState {
  return workspaceStateSchema.parse({ format: 'strata-studio-workspace-state/1',
    grant_sha256: repositoryGrantDigest(grant), origin_sha256: workspaceHash.parse(originSha256),
    revision: 0, desired_connected: false, revoked: false, actions: [], tests:[], operations: [] });
}
export class FileWorkspaceState {
  private grant: RepositoryGrant;
  private directory: string;
  private epoch = 0;
  private queue:Promise<void>=Promise.resolve();private pending=0;
  private readonly binding: string;
  constructor(private file: string, grant: RepositoryGrant, private originSha256: string, private now = Date.now) {
    if (!path.isAbsolute(file) || path.resolve(file) !== file) this.unavailable();
    this.grant = repositoryGrantSchema.parse(grant); this.binding = repositoryGrantDigest(this.grant);
    workspaceHash.parse(originSha256); this.directory = path.dirname(file);
  }
  private unavailable(): never { return fail('WRITE_RECONCILIATION_REQUIRED', 9, 'Established workspace state needs authenticated operator reconciliation.'); }
  private async read() {
    if ((await lstat(this.file)).nlink !== 1) this.unavailable();
    const parsed = workspaceStateSchema.safeParse(await readPrivate(this.file, 16 * 1024 ** 2));
    if (!parsed.success || parsed.data.grant_sha256 !== this.binding || parsed.data.origin_sha256 !== this.originSha256)
      this.unavailable();
    const s = parsed.data;
    const tombstoneFile=path.join(this.directory,'revocation.json'),raw=await optionalPrivate(tombstoneFile);
    if(raw!==undefined){const tombstone=z.object({format:z.literal('strata-studio-workspace-revocation/1'),grant_sha256:workspaceHash,origin_sha256:workspaceHash,request_id:z.string().uuid(),revision:counter.min(1)}).strict().safeParse(raw);
      if(!tombstone.success||(await lstat(tombstoneFile)).nlink!==1||tombstone.data.grant_sha256!==this.binding||tombstone.data.origin_sha256!==this.originSha256)this.unavailable();
      if(!s.revoked||s.revision<tombstone.data.revision)fail('REPOSITORY_ACCESS_REVOKED',4,'A retained permanent revocation forbids restoring an older workspace control.');
    }else if(s.revoked)this.unavailable();
    if (new Set(s.operations.map(o => o.operation_id)).size !== s.operations.length ||
        new Set(s.actions.map(a => a.request_id)).size !== s.actions.length ||
        s.actions.some((a, i) => a.revision !== i + 1 || a.expected_revision !== i) || s.revision !== s.actions.length ||
        s.operations.length > this.grant.limits.max_journal_entries ||
        s.operations.some(o => !o.events.length || o.phase !== o.events.at(-1)!.phase || digest(o.detail) !== digest(o.events.at(-1)!.detail))) this.unavailable();
    if (s.actions.some(a => a.action === 'revoke') && !s.revoked) this.unavailable();
    return s;
  }
  private async protected<T>(operation: () => Promise<T>): Promise<T> {
    if(this.pending>=64)fail('WORKSPACE_BUSY',9,'Workspace state request capacity reached.');this.pending++;
    const task=this.queue.then(async()=>{try { await privateDir(this.directory); return await withLease(this.directory, operation); }
      catch (e) { if (e instanceof StrataError) throw e; return this.unavailable(); }});
    this.queue=task.then(()=>{},()=>{});try{return await task;}finally{this.pending--;}
  }
  changed() { this.epoch++; }
  generation() { return this.epoch; }
  assertEpoch(epoch: number) { if (epoch !== this.epoch) fail('ACCESS_REVOKED', 4, 'Workspace authority changed during this operation.'); }
  async snapshot() { return this.protected(() => this.read()); }
  async ready() { await this.snapshot(); }
  async assertCurrent(operationId?: string, writes = false) {
    assertGrantActive(this.grant, this.now()); const s = await this.snapshot();
    if (s.revoked) fail('REPOSITORY_ACCESS_REVOKED', 4, 'Repository access was permanently revoked.');
    if (!s.desired_connected) fail('CONNECTION_NOT_READY', 4, 'Connect the configured workspace explicitly.');
    if (writes && s.operations.some(o => o.operation_id !== operationId &&
        !['committed', 'cancelled_before_effect'].includes(o.phase)))
      this.unavailable();
    return s;
  }
  async action(value: unknown, authorize: (fresh: boolean) => Promise<void>) {
    const input = z.object({ request_id: z.string().uuid(), action: z.enum(['connect', 'disconnect', 'revoke','test-read','test-write']),
      revision: counter }).strict().parse(value);
    await authorize(input.action === 'revoke'||input.action.startsWith('test-'));
    // Linearize invalidation before the first durable-control await.
    this.changed();
    return this.protected(async () => {
      const s = await this.read(), old = s.actions.find(a => a.request_id === input.request_id);
      if (old) {
        if (old.action !== input.action || old.expected_revision !== input.revision)
          fail('IDEMPOTENCY_CONFLICT', 5, 'Request ID binds another workspace action.');
        return { revision: old.revision, replayed: true };
      }
      if (input.revision !== s.revision) fail('STALE_GENERATION', 5, 'Workspace control changed. Refresh Settings.');
      if (s.revoked) fail('REPOSITORY_ACCESS_REVOKED', 4, 'The retained repository grant is revoked.');
      if (input.action === 'connect'||input.action.startsWith('test-')) assertGrantActive(this.grant, this.now());
      if(input.action.startsWith('test-')&&(!s.desired_connected||s.operations.some(o=>!['committed','cancelled_before_effect'].includes(o.phase))))this.unavailable();
      if (s.actions.length >= this.grant.limits.max_journal_entries) this.unavailable();
      await authorize(input.action === 'revoke'||input.action.startsWith('test-'));
      const revision = s.revision + 1;
      if(input.action==='revoke')await writePrivate(path.join(this.directory,'revocation.json'),{format:'strata-studio-workspace-revocation/1',grant_sha256:this.binding,origin_sha256:this.originSha256,request_id:input.request_id,revision},true);
      await writePrivate(this.file, { ...s, revision, desired_connected: input.action.startsWith('test-')?s.desired_connected:input.action === 'connect',
        revoked: s.revoked||input.action === 'revoke', actions: [...s.actions,
          { request_id: input.request_id, action: input.action, expected_revision: input.revision, revision }] });
      return { revision, replayed: false };
    });
  }
  journal(operationId: string): WorkspaceStageJournal {
    workspaceHash.parse(operationId);
    return { record: async (phase: WorkspaceStagePhase, detail: Record<string, unknown>) => {
      const data = detailSchema.parse(detail);
      await this.protected(async () => {
        const s = await this.read(), old = s.operations.find(o => o.operation_id === operationId);
        if (old?.phase === 'committed' && phase !== 'committed') this.unavailable();
        if ((!old && s.operations.length >= this.grant.limits.max_journal_entries) || (old?.events.length ?? 0) >= 128) this.unavailable();
        const next = { operation_id: operationId, phase, detail: data, events: [...(old?.events ?? []), { phase, detail: data }] };
        await writePrivate(this.file, { ...s, operations: [...s.operations.filter(o => o.operation_id !== operationId), next] });
      });
    } };
  }
  async recordTest(value:WorkspaceState['tests'][number]) {
    const data=workspaceStateSchema.shape.tests.element.parse(value);
    return this.protected(async()=>{
      const s=await this.read(),old=s.tests.find(t=>t.request_id===data.request_id);
      if(old){if(digest(old)!==digest(data))this.unavailable();return;}
      if(s.tests.length>=this.grant.limits.max_journal_entries)this.unavailable();
      await writePrivate(this.file,{...s,tests:[...s.tests,data]});
    });
  }
}
