import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { artifactTokenSchema } from './artifacts-token.js';
import { bytesDigest, digest, fail, StrataError } from './model.js';
import { artifactBundle, pushArtifactBundle, MAX_GIT_RESPONSE_BYTES, type FetchTransport } from './artifacts-git.js';
import type { ArtifactBinary, ArtifactLocator, ArtifactObject } from './artifacts.js';
import { repositoryGrantSchema, repositoryGrantDigest, workspaceHash, type RepositoryGrant } from './explorer/workspace-policy.js';
import type { ArtifactBatchPort, WorkspaceAuthorityLease, WorkspaceIoReservations,
  WorkspaceStageJournal, WorkspaceDispatchKind } from './explorer/workspace-ports.js';

export const providerIdentityProofSchema = z.object({
  format: z.literal('strata-studio-provider-identity/1'), grant_sha256: workspaceHash,
  expected_repository_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  guarantee: z.literal('repository-token-bound-to-immutable-id'),
  evidence_kind: z.enum(['provider-confirmation', 'approved-disposable-test']), evidence_sha256: workspaceHash,
}).strict();
export type ProviderIdentityProof = z.infer<typeof providerIdentityProofSchema>;
export const developmentProviderContractSchema = z.object({
  format: z.literal('strata-studio-development-provider-contract/1'), grant_sha256: workspaceHash,
  expected_repository_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  environment: z.literal('development'), contract: z.literal('repository-addressed-by-name'),
  operator_rule: z.literal('no-delete-recreate-or-rebind-during-write-or-reconciliation'),
  evidence_kind: z.literal('owner-acknowledgment'), evidence_sha256: workspaceHash,
}).strict();
export const providerWriteContractSchema = z.union([providerIdentityProofSchema, developmentProviderContractSchema]);
export type ProviderWriteContract = z.infer<typeof providerWriteContractSchema>;
export interface NodeArtifactOperation {
  lease: WorkspaceAuthorityLease; budget: WorkspaceIoReservations; journal: WorkspaceStageJournal;
  credential(): Promise<string>;
}
const metadataSchema = z.object({ id: z.string(), name: z.string(), remote: z.string(), read_only: z.boolean() }).passthrough();
const issueSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  plaintext: artifactTokenSchema,
  scope: z.literal('write'), expires_at: z.string().datetime() }).passthrough();
const locatorSchema = z.object({ ref: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().regex(/^[a-f0-9]{64}\.(json|bin)$/), hash: workspaceHash,
  size_bytes: z.number().int().min(1).max(8 * 1024 ** 2) }).strict();

// No namespace binding, gateway JWT, process credential environment or shell Git
// is required. The saved API credential travels only to the fixed REST origin.
export class NodeArtifactsAdapter implements ArtifactBatchPort {
  private readonly grant: RepositoryGrant;
  private readonly base: string;
  private identityVerified: boolean;
  private readonly developmentAccepted: boolean;
  private readonly contractDigest: string | null;
  private pending = 0;
  private issued = 0;
  private revoked = 0;
  private uncertain = false;
  private operationRequests = new WeakMap<NodeArtifactOperation, { requests: number; cleanup: number; bytes: number }>();
  private cleanupDispatches = new WeakMap<NodeArtifactOperation, number>();
  constructor(grant: RepositoryGrant, private operation: () => NodeArtifactOperation,
    proof?: ProviderWriteContract, private transport: FetchTransport = request => fetch(request), private now = Date.now) {
    this.grant = repositoryGrantSchema.parse(grant);
    const s = this.grant.storage;
    this.base = `https://api.cloudflare.com/client/v4/accounts/${s.account}/artifacts/namespaces/${encodeURIComponent(s.namespace)}`;
    const parsed = providerWriteContractSchema.safeParse(proof);
    const matches = parsed.success && parsed.data.grant_sha256 === repositoryGrantDigest(this.grant) &&
      parsed.data.expected_repository_id === s.expected_repository_id;
    this.identityVerified = matches && parsed.data.format === 'strata-studio-provider-identity/1' &&
      this.grant.provider_contract !== 'development-name-addressed';
    this.developmentAccepted = matches && parsed.data.format === 'strata-studio-development-provider-contract/1' &&
      this.grant.provider_contract === 'development-name-addressed';
    this.contractDigest = this.providerWriteContractAccepted() && parsed.success ? digest(parsed.data) : null;
  }
  identity(project: string) {
    if (project !== this.grant.project_id) fail('STORE_BINDING_MISMATCH', 4, 'Workspace store belongs to another project.');
    const s = this.grant.storage; return { account: s.account, namespace: s.namespace, repository: s.repository, mode: 'remote' as const };
  }
  managementCleanupCounts() { return { unsettled_dispatches: this.pending,
    repo_tokens_issued: this.uncertain ? null : this.issued, repo_tokens_revoked: this.uncertain ? null : this.revoked, handles_open: 0 }; }
  providerIdentityVerified() { return this.identityVerified; }
  providerWriteContractAccepted() { return this.identityVerified || this.developmentAccepted; }
  providerWriteContract() { return this.identityVerified ? 'immutable-id' : this.developmentAccepted ? 'development-name-addressed' : 'unconfigured'; }
  private safeFailure(): never { return fail('WORKSPACE_PROVIDER_UNAVAILABLE', 9, 'The bounded repository request could not be verified.'); }
  private proof() { if (!this.providerWriteContractAccepted()) fail('PROVIDER_IDENTITY_GUARANTEE_REQUIRED', 4,
    'The exact grant requires its protected provider identity evidence or development owner acknowledgment before writes.'); }
  private async bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    // Consume the already-started promise even if cancellation happened first.
    void work.catch(() => {});
    if (signal.aborted) this.safeFailure();
    let cancel: (() => void) | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      cancel = () => reject(new StrataError('WORKSPACE_PROVIDER_UNAVAILABLE', 9, 'The bounded repository request was interrupted.'));
      signal.addEventListener('abort', cancel, { once: true });
    })]); } finally { if (cancel) signal.removeEventListener('abort', cancel); }
  }
  private async reserve(op: NodeArtifactOperation, kind: WorkspaceDispatchKind, outgoing: number, incoming: number) {
    await op.lease.refresh(); op.lease.assertSync('before-reservation');
    const usage = this.operationRequests.get(op) ?? { requests: 0, cleanup: 0, bytes: 0 };
    const cleanup = kind === 'token.revoke-owned';
    if (cleanup ? usage.cleanup >= 2 : usage.requests + 1 > this.grant.limits.max_operation_requests)
      fail('WORKSPACE_OPERATION_LIMIT', 4, 'The operation exceeds its bounded request plan.');
    if (
        usage.bytes + outgoing + incoming > this.grant.limits.max_operation_bytes)
      fail('WORKSPACE_OPERATION_LIMIT', 4, 'The operation exceeds its declared request or transfer bound.');
    await op.budget.reserve(randomUUID(), op.lease.operation_id, kind, outgoing + incoming);
    if (cleanup) usage.cleanup++; else usage.requests++;
    usage.bytes += outgoing + incoming; this.operationRequests.set(op, usage);
    await op.lease.refresh(); op.lease.assertSync('after-reservation');
  }
  private async request(op: NodeArtifactOperation, kind: WorkspaceDispatchKind, url: string, method: string,
    incoming: number, body?: Uint8Array, bearer?: string, cleanup?: { credential: string; ownedId: string }, prepaid = false) {
    const git = kind.startsWith('git.');
    if (git ? !(url === this.grant.storage.remote + '/info/refs?service=git-receive-pack' && method === 'GET' ||
        url === this.grant.storage.remote + '/git-receive-pack' && method === 'POST') : !url.startsWith(this.base + '/')) this.safeFailure();
    if (!cleanup && !prepaid) await this.reserve(op, kind, body?.byteLength ?? 0, incoming);
    const signal = cleanup ? AbortSignal.timeout(5000) : AbortSignal.any([op.lease.signal, AbortSignal.timeout(10_000)]);
    const credential = bearer ?? cleanup?.credential ?? await op.credential();
    if (!credential || /[\r\n]/.test(credential)) this.safeFailure();
    if (!cleanup) { await op.lease.refresh(); op.lease.assertSync('provider-dispatch'); }
    else {
      const consumed = this.cleanupDispatches.get(op) ?? 0;
      if (kind !== 'token.revoke-owned' || url !== this.base + '/tokens/' + encodeURIComponent(cleanup.ownedId) ||
          consumed >= (this.operationRequests.get(op)?.cleanup ?? 0)) this.safeFailure();
      this.cleanupDispatches.set(op, consumed + 1);
    }
    const headers = { authorization: 'Bearer ' + credential,
      ...(git ? { 'content-type': 'application/x-git-receive-pack-request' } : { 'content-type': 'application/json' }) };
    this.pending++; let transportWork:Promise<Response>|undefined, transportSettled=false;
    try {
      let started:Promise<Response>;try{started=this.transport(new Request(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal, redirect: 'manual' }));}catch{this.safeFailure();}
      const work=started.catch(()=>this.safeFailure());
      transportWork=work;void work.then(()=>{transportSettled=true;},()=>{transportSettled=true;});
      // The transport may still settle after cancellation; it is consumed and its
      // uncertain phase remains durable. No retry is made here.
      const response = await this.bounded(work, signal);
      if (response.status >= 300 && response.status < 400) this.safeFailure();
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        if (reader) for (;;) {
          const next = await this.bounded(reader.read().catch(()=>this.safeFailure()), signal); if (next.done) break;
          size += next.value.byteLength; if (size > incoming) this.safeFailure(); chunks.push(next.value);
          if (!cleanup) { await op.lease.refresh(); op.lease.assertSync('provider-response'); }
        }
      } finally { void reader?.cancel().catch(() => {}); }
      if (!cleanup) { await op.lease.refresh(); op.lease.assertSync('after-provider-response'); }
      return { status: response.status, bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') ?? '' };
    } catch (e) { if (e instanceof StrataError) throw e; this.safeFailure(); }
    finally { if(!transportWork||transportSettled)this.pending--;else void transportWork.then(()=>{this.pending--;},()=>{this.pending--;}); }
  }
  private async json(op: NodeArtifactOperation, kind: WorkspaceDispatchKind, route: string, method = 'GET',
    body?: unknown, cleanup?: { credential: string; ownedId: string }) {
    const r = await this.request(op, kind, this.base + route, method, cleanup ? 4096 : 8192,
      body === undefined ? undefined : Buffer.from(JSON.stringify(body)), undefined, cleanup);
    if (r.status < 200 || r.status >= 300 || !r.contentType.toLowerCase().includes('application/json')) this.safeFailure();
    let result: any; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes)); } catch { this.safeFailure(); }
    if (result?.success !== true || result.result === undefined) this.safeFailure();
    return result.result;
  }
  private async metadata(op: NodeArtifactOperation) {
    const parsed = metadataSchema.safeParse(await this.json(op, 'repository.info', '/repos/' + encodeURIComponent(this.grant.storage.repository)));
    const s = this.grant.storage;
    if (!parsed.success || parsed.data.id !== s.expected_repository_id || parsed.data.name !== s.repository ||
        parsed.data.remote !== s.remote || parsed.data.read_only)
      fail('REPOSITORY_ID_MISMATCH', 4, 'The exact writable repository identity could not be verified.');
  }
  private locator(value: ArtifactLocator) {
    const l = locatorSchema.parse(value);
    if (l.path !== l.hash + (l.path.endsWith('.json') ? '.json' : '.bin')) fail('STORE_BINDING_MISMATCH', 4, 'Immutable locator differs.');
    return l;
  }
  private async file(op: NodeArtifactOperation, locator: ArtifactLocator) {
    const l = this.locator(locator);
    const query = new URLSearchParams({ ref: l.ref, path: l.path });
    const r = await this.request(op, 'file.read', this.base + '/repos/' + encodeURIComponent(this.grant.storage.repository) + '/file?' + query, 'GET', l.size_bytes);
    if (r.status === 404) return null;
    if (r.status !== 200 || r.bytes.byteLength !== l.size_bytes || bytesDigest(r.bytes) !== l.hash)
      fail('STORE_UNAVAILABLE', 9, 'Immutable repository content failed exact verification.');
    return new Uint8Array(r.bytes);
  }
  async getManyAt(locators: ArtifactLocator[]) {
    for (const l of locators) this.locator(l);
    const op = this.operation(); await this.metadata(op); const output: (string | null)[] = [];
    for (const l of locators) { const bytes = await this.file(op, l); if (!bytes) output.push(null);
      else try { output.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { this.safeFailure(); } }
    await this.metadata(op); return output;
  }
  async getBytesAt(locator: ArtifactLocator) {
    this.locator(locator); const op = this.operation(); await this.metadata(op);
    const result = await this.file(op, locator); await this.metadata(op); return result;
  }
  async putBatch(objects: ArtifactObject[], binary: ArtifactBinary[] = []) {
    this.proof(); const op = this.operation();
    const files = [...objects.map(o => ({ ...o, path: o.hash + '.json' })), ...binary.map(o => ({ ...o, path: o.hash + '.bin' }))];
    if (!files.length || files.reduce((n, f) => n + Buffer.byteLength(f.bytes), 0) > this.grant.limits.max_payload_bytes ||
        files.some(f => !workspaceHash.safeParse(f.hash).success || bytesDigest(f.bytes) !== f.hash) ||
        new Set(files.map(f => f.path)).size !== files.length) fail('WORKSPACE_OPERATION_LIMIT', 4, 'Artifact payload exceeds its exact immutable admission plan.');
    if (8 + files.length > this.grant.limits.max_operation_requests)
      fail('WORKSPACE_OPERATION_LIMIT', 4, 'The exact batch cannot fit the bounded read-back plan.');
    const bundle = artifactBundle(files);
    if (bundle.pack.byteLength + 512 + files.reduce((n,f)=>n+Buffer.byteLength(f.bytes),0) +
        6*8192 + 2*MAX_GIT_RESPONSE_BYTES + 8192 > this.grant.limits.max_operation_bytes)
      fail('WORKSPACE_OPERATION_LIMIT', 4, 'The exact batch cannot fit the bounded transfer plan.');
    const locators = files.map(f => ({ ref: bundle.commit, path: f.path, hash: f.hash, size_bytes: Buffer.byteLength(f.bytes) }));
    await this.metadata(op);
    await op.journal.record('prepared', { commit: bundle.commit, branch: bundle.branch, hashes: files.map(f => f.hash), locators,
      provider_write_contract: this.providerWriteContract(), provider_write_contract_sha256: this.contractDigest });
    // Cleanup has its own prepaid reservations; never borrow exhausted ordinary
    // authority after a token has been issued. At most one dispatch consumes each.
    await this.reserve(op, 'token.revoke-owned', 0, 4096);
    await this.reserve(op, 'token.revoke-owned', 0, 4096);
    let token: z.infer<typeof issueSchema> | undefined, heldCredential: string | undefined, cleanupOk = false;
    try {
      heldCredential = await op.credential(); await op.lease.refresh(); op.lease.assertSync('before-token-issue');
      await op.journal.record('token_issue_unknown', { commit: bundle.commit, branch: bundle.branch });
      const result = await this.json(op, 'token.issue', '/tokens', 'POST', { repo: this.grant.storage.repository, scope: 'write', ttl: 60 });
      const parsed = issueSchema.safeParse(result);
      if (!parsed.success || Date.parse(parsed.data.expires_at) <= this.now() + 5000 || Date.parse(parsed.data.expires_at) > this.now() + 65_000 ||
          Math.abs(Number(parsed.data.plaintext.split('?expires=')[1])*1000-Date.parse(parsed.data.expires_at))>=1000) this.safeFailure();
      token = parsed.data; this.issued++;
      await op.journal.record('token_owned', { token_id: token.id, expires_at: token.expires_at, commit: bundle.commit, branch: bundle.branch });
      await this.metadata(op);
      const pushed = await pushArtifactBundle(this.grant.storage.remote, token.plaintext, bundle, async request => {
        const post = request.method === 'POST';
        if (post) {
          await this.metadata(op); await op.lease.refresh(); op.lease.assertSync('actual-receive-pack');
          if (Date.parse(token!.expires_at) <= this.now() + 5000) this.safeFailure();
          await op.journal.record('push_unknown', { commit: bundle.commit, branch: bundle.branch, token_id: token!.id });
        }
        const body = post ? new Uint8Array(await request.arrayBuffer()) : undefined;
        const result = await this.request(op, post ? 'git.immutable-batch' : 'git.discover', request.url,
          request.method, MAX_GIT_RESPONSE_BYTES, body, token!.plaintext);
        return new Response(new Uint8Array(result.bytes), { status: result.status });
      }, op.lease.signal);
      await this.metadata(op);
      for (const l of locators) if (!await this.file(op, l)) fail('STORE_UNAVAILABLE', 9, 'Staged artifact read-back is absent.');
      await this.metadata(op);
      await op.journal.record('stage_verified', { commit: bundle.commit, branch: bundle.branch, locators });
      const revoked = await this.json(op, 'token.revoke-owned', '/tokens/' + encodeURIComponent(token.id), 'DELETE', undefined,
        { credential: heldCredential, ownedId: token.id });
      if (revoked?.id !== token.id) this.safeFailure();
      cleanupOk = true; this.revoked++;
      await op.journal.record('stage_verified', { commit: bundle.commit, branch: bundle.branch, locators, cleanup: 'confirmed', token_id: token.id });
      await op.lease.refresh(); op.lease.assertSync('after-owned-token-cleanup');
      return { commit: bundle.commit, branch: bundle.branch, reused: pushed.reused, locators };
    } catch (e) {
      if (!token) this.uncertain = true;
      if (token && !cleanupOk && heldCredential) {
        try {
          const r = await this.json(op, 'token.revoke-owned', '/tokens/' + encodeURIComponent(token.id), 'DELETE', undefined,
            { credential: heldCredential, ownedId: token.id });
          if (r?.id === token.id) { cleanupOk = true; this.revoked++; }
        } catch { this.uncertain = true; }
      }
      await op.journal.record(cleanupOk ? 'reconciliation_required' : 'cleanup_unconfirmed', {
        commit: bundle.commit, branch: bundle.branch, ...(token ? { token_id: token.id, expires_at: token.expires_at } : {}),
        reason: token ? 'staged-operation-not-committed' : 'token-issue-not-confirmed', cleanup: cleanupOk ? 'confirmed' : 'unconfirmed',
      });
      if (e instanceof StrataError) throw e;
      return this.safeFailure();
    }
  }
  // Explicit permission test: no Git discovery, push or fabricated payload. A
  // passed read test is deliberately distinct from issue/revoke verification.
  async testReadAccess() {
    const op=this.operation(); await op.journal.record('prepared',{reason:'read-permission-test'});
    await this.metadata(op); return {repository_verified:true,write_token_verified:false};
  }
  async testWriteAccess() {
    this.proof(); const op=this.operation();
    await op.journal.record('prepared',{reason:'write-permission-test',provider_write_contract:this.providerWriteContract(),provider_write_contract_sha256:this.contractDigest});
    await this.metadata(op);
    await this.reserve(op,'token.revoke-owned',0,4096); await this.reserve(op,'token.revoke-owned',0,4096);
    let owned:z.infer<typeof issueSchema>|undefined,held:string|undefined,clean=false;
    try {
      // The issue reservation precedes acquisition, including the cleanup copy.
      const body=Buffer.from(JSON.stringify({repo:this.grant.storage.repository,scope:'write',ttl:60}));
      await this.reserve(op,'token.issue',body.byteLength,8192);
      held=await op.credential();await op.lease.refresh();op.lease.assertSync('permission-test-issue');
      await op.journal.record('token_issue_unknown',{reason:'write-permission-test'});
      const r=await this.request(op,'token.issue',this.base+'/tokens','POST',8192,body,held,undefined,true);
      let result:any;try {result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.bytes));}catch{this.safeFailure();}
      const parsed=issueSchema.safeParse(result?.success===true?result.result:undefined);
      if(r.status<200||r.status>=300||!r.contentType.toLowerCase().includes('application/json')||!parsed.success||
          Date.parse(parsed.data.expires_at)<=this.now()+5000||Date.parse(parsed.data.expires_at)>this.now()+65000||
          Math.abs(Number(parsed.data.plaintext.split('?expires=')[1])*1000-Date.parse(parsed.data.expires_at))>=1000)this.safeFailure();
      owned=parsed.data;this.issued++;
      await op.journal.record('token_owned',{token_id:owned.id,expires_at:owned.expires_at,reason:'write-permission-test'});
      await this.metadata(op);
      const revoked=await this.json(op,'token.revoke-owned','/tokens/'+encodeURIComponent(owned.id),'DELETE',undefined,{credential:held,ownedId:owned.id});
      if(revoked?.id!==owned.id)this.safeFailure(); clean=true;this.revoked++;
      await op.journal.record('stage_verified',{token_id:owned.id,cleanup:'confirmed',reason:'write-permission-test'});
      await op.lease.refresh();op.lease.assertSync('permission-test-complete');
      return {repository_verified:true,write_token_verified:true};
    } catch(e) {
      if(owned&&!clean&&held)try{const r=await this.json(op,'token.revoke-owned','/tokens/'+encodeURIComponent(owned.id),'DELETE',undefined,{credential:held,ownedId:owned.id});if(r?.id===owned.id){clean=true;this.revoked++;}}catch{}
      this.uncertain=!clean;
      await op.journal.record(clean?'reconciliation_required':'cleanup_unconfirmed',{reason:owned?'permission-test-interrupted':'token-issue-not-confirmed',
        ...(owned?{token_id:owned.id,expires_at:owned.expires_at}:{}),cleanup:clean?'confirmed':'unconfirmed'});
      if(e instanceof StrataError)throw e;this.safeFailure();
    }
  }
}
