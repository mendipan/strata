import { bytesDigest, fail, StrataError } from './model.js';
import { artifactBundle, artifactBatchBranch, pushArtifactBundle, MAX_GIT_RESPONSE_BYTES, type FetchTransport } from './artifacts-git.js';
import { RunBudget } from './budget.js';
import { providerDiagnostic } from './provider-diagnostic.js';

export interface ArtifactStore { put(hash: string, bytes: string): Promise<void>; get(hash: string): Promise<string | null>; }
export type ArtifactObject = { hash: string; bytes: string };
export type ArtifactBinary = { hash: string; bytes: Uint8Array };
export type ArtifactLocator = { ref: string; path: string; hash: string; size_bytes?: number };
export type ArtifactIdentity = { account: string; namespace: string; repository: string; mode: 'strict-mock' | 'remote' };
export type ArtifactCleanupCounts = { unsettled_dispatches: number; repo_tokens_issued: number | null; repo_tokens_revoked: number | null; handles_open: number };
export const ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT = 25;
export interface ArtifactRepository {
  info(): Promise<{ remote: string }>;
  readFile(input: { ref: string; path: string }): Promise<Blob | null>;
  createToken(mode: 'read' | 'write', ttlSeconds: number): Promise<{ plaintext: string; expiresAt: string | number }>;
  revokeToken(token: string): Promise<unknown>;
  [Symbol.dispose](): void;
}
export interface ArtifactsNamespace { get(name: string): Promise<ArtifactRepository>; create?(name: string): Promise<{ name: string; token: string }>; }
type Assert<T extends true> = T;
type BindingCompatible = Assert<Artifacts extends ArtifactsNamespace ? true : false>;
export type ArtifactSetup = { namespace: ArtifactsNamespace; repository: string; budget: RunBudget; transport: FetchTransport; max_repo_tokens?: number } & (
  { mode: 'strict-mock'; identity?: { account: string; namespace: string } } |
  { mode: 'remote'; identity: { account: string; namespace: string }; approval: { approved: true; repository: string; approval_id: string; project_id: string; expires_at: string } }
);
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
export class CloudflareArtifactsAdapter implements ArtifactStore {
  private locators = new Map<string, ArtifactLocator>();
  private unsettledDispatches = 0;
  private repoTokensIssued = 0;
  private repoTokensRevoked = 0;
  private tokenIssuesPending = 0;
  private tokenRevokesPending = 0;
  private tokenCountsUncertain = false;
  private handlesOpen = 0;
  constructor(private readonly setup?: ArtifactSetup) {}
  managementCleanupCounts(): ArtifactCleanupCounts {
    const tokenCountsKnown = !this.tokenCountsUncertain && this.tokenIssuesPending === 0 && this.tokenRevokesPending === 0;
    return { unsettled_dispatches: this.unsettledDispatches,
      repo_tokens_issued: tokenCountsKnown ? this.repoTokensIssued : null,
      repo_tokens_revoked: tokenCountsKnown ? this.repoTokensRevoked : null,
      handles_open: this.handlesOpen };
  }
  private trackDispatch<T>(operation: () => Promise<T>): Promise<T> {
    this.unsettledDispatches++;
    return Promise.resolve().then(operation).finally(() => { this.unsettledDispatches--; });
  }
  private disposeHandle(repository: ArtifactRepository) {
    try { repository[Symbol.dispose](); this.handlesOpen--; }
    catch (error) { throw error; }
  }
  private issueToken(repository: ArtifactRepository) {
    const setup = this.enabled(), limit = setup.max_repo_tokens ?? ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT;
    if (this.tokenCountsUncertain || !Number.isSafeInteger(limit) || limit < 0 || limit > ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT ||
        this.repoTokensIssued + this.tokenIssuesPending >= limit)
      fail('ARTIFACT_TOKEN_LIMIT', 7, 'The fixed repository token issuance ceiling is exhausted, uncertain, or invalid; no token was requested.');
    this.tokenIssuesPending++;
    return this.trackDispatch(() => repository.createToken('write', 60)).then(issued => {
      this.tokenIssuesPending--;
      if (typeof issued?.plaintext !== 'string' || !issued.plaintext) this.tokenCountsUncertain = true;
      else this.repoTokensIssued++;
      return issued;
    }, error => { this.tokenIssuesPending--; this.tokenCountsUncertain = true; throw error; });
  }
  private revokeToken(repository: ArtifactRepository, token: string) {
    this.tokenRevokesPending++;
    return this.trackDispatch(() => repository.revokeToken(token)).then(result => {
      this.tokenRevokesPending--;
      if (result !== false) this.repoTokensRevoked++;
      return result;
    }, error => { this.tokenRevokesPending--; this.tokenCountsUncertain = true; throw error; });
  }
  private enabled(): ArtifactSetup {
    if (!this.setup) fail('COST_APPROVAL_REQUIRED', 7, 'Remote Cloudflare Artifacts use is disabled until separately authorized.');
    const s = this.setup;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s.repository)) fail('INVALID_ARGUMENT', 2, 'Invalid Artifacts repository name.');
    if (s.identity && (!/^[a-zA-Z0-9_-]{1,64}$/.test(s.identity.namespace) || !/^[a-zA-Z0-9-]{1,64}$/.test(s.identity.account))) fail('INVALID_ARGUMENT', 2, 'Invalid Artifacts account or namespace.');
    if (s.max_repo_tokens !== undefined && (!Number.isSafeInteger(s.max_repo_tokens) || s.max_repo_tokens < 0 || s.max_repo_tokens > ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT)) fail('COST_APPROVAL_REQUIRED', 7, 'Repository token allowance must be an explicit integer from zero through 25.');
    if (s.mode === 'remote' && s.max_repo_tokens === undefined) fail('COST_APPROVAL_REQUIRED', 7, 'Remote Artifacts runs require an explicit fail-closed repository token ceiling.');
    if (s.mode === 'remote' && (!s.identity || !/^[a-f0-9]{32}$/.test(s.identity.account) || !s.approval?.approved || s.approval.repository !== s.repository || !s.approval.approval_id || !s.approval.project_id || !Number.isFinite(Date.parse(s.approval.expires_at)) || Date.parse(s.approval.expires_at) <= Date.now())) fail('COST_APPROVAL_REQUIRED', 7, 'An unexpired exact repository/project run approval is required.');
    s.budget.check(); return s;
  }
  identity(projectId: string): ArtifactIdentity {
    const s = this.enabled();
    if (!s.identity) fail('STORE_BINDING_REQUIRED', 4, 'Registry storage requires an exact account and namespace.');
    if (s.mode === 'remote' && s.approval.project_id !== projectId) fail('STORE_BINDING_MISMATCH', 4, 'Run approval belongs to another project.');
    return { ...s.identity, repository: s.repository, mode: s.mode };
  }
  private checkedRemote(value: string, s: ArtifactSetup) {
    const remote = new URL(value), expected = s.identity ? `https://${s.identity.account}.artifacts.cloudflare.net/git/${s.identity.namespace}/${s.repository}.git` : null;
    if (remote.protocol !== 'https:' || !/^[a-zA-Z0-9-]+\.artifacts\.cloudflare\.net$/.test(remote.hostname) || remote.username || remote.password || remote.search || remote.hash || !/^\/git\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.git$/.test(remote.pathname) || remote.pathname.split('/').at(-1) !== s.repository + '.git' || (expected && remote.href !== expected)) fail('ARTIFACT_REMOTE', 7, 'Binding returned an unexpected Artifacts Git remote.');
    return remote;
  }
  async put(hash: string, bytes: string) { await this.putMany([{ hash, bytes }]); }
  async putMany(objects: ArtifactObject[]) { return this.putBatch(objects, []); }
  async putBatch(records: ArtifactObject[], assets: ArtifactBinary[]) {
    const s = this.enabled();
    const objects = [...records.map(o => ({ ...o, path: o.hash + '.json' })), ...assets.map(o => ({ ...o, path: o.hash + '.bin' }))];
    if (!objects.length || objects.length > 10000 || new Set(objects.map(o => o.path)).size !== objects.length) fail('INVALID_ARGUMENT', 2, 'Supply a nonempty bounded batch with unique artifact addresses.');
    for (const o of objects) if (!/^[a-f0-9]{64}$/.test(o.hash) || bytesDigest(o.bytes) !== o.hash) fail('ARTIFACT_DIGEST', 9, 'Artifact digest does not match its bytes.');
    const size = (bytes: string | Uint8Array) => typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
    if (objects.some(o => size(o.bytes) > MAX_OBJECT_BYTES) || objects.reduce((n, o) => n + size(o.bytes), 0) > 2 * MAX_OBJECT_BYTES) fail('INVALID_ARGUMENT', 2, 'Artifact batch exceeds the bounded bytes limit.');
    const bundle = artifactBundle(objects);
    s.budget.reserve({ operations: 6 + objects.length, attempts: 1, bytes: bundle.pack.byteLength + 1024 + 2 * MAX_GIT_RESPONSE_BYTES + objects.reduce((n, o) => n + size(o.bytes), 0) });
    let repository: ArtifactRepository | undefined, token: string | undefined, cleanupFailed = false;
    let repositoryRequest: Promise<ArtifactRepository> | undefined, tokenRequest: Promise<unknown> | undefined;
    let stage = 'batch.get';
    try {
      repositoryRequest = this.trackDispatch(() => s.namespace.get(s.repository)).then(handle => { repository = handle; this.handlesOpen++; return handle; });
      await s.budget.bounded(() => repositoryRequest!);
      stage = 'batch.info';
      const remote = this.checkedRemote((await s.budget.bounded(() => this.trackDispatch(() => repository!.info()))).remote, s);
      this.enabled();
      stage = 'batch.create-token';
      tokenRequest = this.issueToken(repository!).then(issued => { token = issued.plaintext; });
      await s.budget.bounded(() => tokenRequest!);
      if (!token) fail('ARTIFACT_PROTOCOL', 9, 'Binding did not return a write token.');
      this.enabled();
      stage = 'batch.push';
      const result = await s.budget.bounded(() => this.trackDispatch(() => pushArtifactBundle(remote.href, token!, bundle, s.transport, AbortSignal.timeout(s.budget.remainingMs()))));
      const locators: ArtifactLocator[] = [];
      for (const o of objects) {
        this.enabled();
        stage = 'batch.read-back';
        const blob = await s.budget.bounded(() => this.trackDispatch(() => repository!.readFile({ ref: bundle.commit, path: o.path })));
        if (!blob || blob.size !== size(o.bytes) || bytesDigest(new Uint8Array(await s.budget.bounded(() => blob.arrayBuffer()))) !== o.hash) fail('ARTIFACT_DIGEST', 9, 'Complete batch read-back did not match the pinned artifact digests.');
        locators.push({ ref: bundle.commit, path: o.path, hash: o.hash, size_bytes: size(o.bytes) });
      }
      // Publication consumes only returned locators after finally/cleanup has succeeded.
      for (const locator of locators) this.locators.set(locator.path, locator);
      return { ...result, commit: bundle.commit, branch: bundle.branch, artifacts: objects.length, locators };
    } catch (error) {
      if (error instanceof StrataError) throw error;
      fail('ARTIFACT_UNAVAILABLE', 9, 'Artifacts batch failed; no automatic retry was attempted.', providerDiagnostic(stage, error));
    } finally {
      // A deadline does not cancel capability/token issuance. Keep the handle alive
      // for one bounded cleanup reconciliation; no mutation retry is dispatched.
      for (const pending of [repositoryRequest, tokenRequest]) if (pending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { if (await Promise.race([pending!.then(() => true, () => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]) === false) cleanupFailed = true; }
        finally { clearTimeout(timer); }
      }
      if (repository && token) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const cleanup = await Promise.race([this.revokeToken(repository, token), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
          if (cleanup === false) cleanupFailed = true;
        } catch { cleanupFailed = true; } finally { clearTimeout(timer); }
      }
      try { if (repository) this.disposeHandle(repository); } catch { cleanupFailed = true; }
      token = undefined;
      if (cleanupFailed) { s.budget.stop(); fail('ARTIFACT_CLEANUP', 9, 'Artifact credential cleanup failed; stop this run and inspect the approved repository before continuing.'); }
    }
  }
  // Single attended demo bootstrap. Native create returns an initial token: revoke
  // it immediately and count it in the SAME 25-token adapter budget.
  async provisionDisposableRepository() {
    const s = this.enabled();
    if (s.mode !== 'remote' || !s.namespace.create || this.repoTokensIssued !== 0 || this.handlesOpen !== 0)
      fail('ARTIFACT_PROVISION_REFUSED', 7, 'Only a fresh approved native remote adapter may provision this disposable repository.');
    s.budget.reserve({ operations: 3, attempts: 3, bytes: 16 * 1024 });
    if ((s.max_repo_tokens ?? 0) < 1) fail('ARTIFACT_TOKEN_LIMIT', 7, 'No initial repository token allowance remains.');
    this.repoTokensIssued++; // reserve before dispatch; ambiguity is never retried
    let repository: ArtifactRepository | undefined;
    try {
      const created = await s.budget.bounded(() => this.trackDispatch(() => s.namespace.create!(s.repository)));
      if (created.name !== s.repository || typeof created.token !== 'string' || !created.token)
        fail('ARTIFACT_PROVISION_REFUSED', 7, 'Native repository creation did not return the exact repository and initial token.');
      repository = await s.budget.bounded(() => this.trackDispatch(() => s.namespace.get(s.repository)));
      this.handlesOpen++;
      const revoked = await s.budget.bounded(() => this.revokeToken(repository!, created.token));
      if (revoked === false) fail('ARTIFACT_CLEANUP', 9, 'Initial repository token revocation was refused.');
      created.token = ''; // never export the plaintext
      return 3;
    } catch (error) {
      this.tokenCountsUncertain = true; s.budget.stop(); throw error;
    } finally { if (repository) this.disposeHandle(repository); }
  }
  async get(hash: string) { return this.getAt(this.locators.get(hash + '.json') ?? { ref: artifactBatchBranch([hash]), path: hash + '.json', hash }); }
  async getAt(locator: ArtifactLocator) {
    return (await this.getManyAt([locator]))[0];
  }
  async getManyAt(locators: ArtifactLocator[]) {
    const results = await this.readManyAt(locators, 'json');
    return results.map(bytes => {
      if (bytes === null) return null;
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('ARTIFACT_DIGEST', 9, 'Record bytes are not valid UTF-8.'); }
    });
  }
  async getBytesAt(locator: ArtifactLocator) { return (await this.readManyAt([locator], 'bin'))[0]; }
  private async readManyAt(locators: ArtifactLocator[], extension: 'json' | 'bin') {
    const s = this.enabled();
    if (!Array.isArray(locators) || locators.length > 10000) fail('INVALID_ARGUMENT', 2, 'Artifact read batch exceeds its record bound.');
    let totalBytes = 0;
    for (const locator of locators) {
      if (!/^[a-f0-9]{64}$/.test(locator.hash) || locator.path !== locator.hash + '.' + extension || !/^([a-f0-9]{40}|refs\/heads\/strata\/artifacts\/[a-f0-9]{64})$/.test(locator.ref)) fail('INVALID_ARGUMENT', 2, 'Invalid immutable artifact locator.');
      const maxBytes = locator.size_bytes ?? 65536;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_OBJECT_BYTES) fail('INVALID_ARGUMENT', 2, 'Invalid artifact size.');
      totalBytes += maxBytes;
    }
    if (!locators.length) return [];
    // Keep the original conservative per-object reservation even though handle
    // acquisition and identity validation now happen once per bounded batch.
    s.budget.reserve({ operations: (s.identity ? 3 : 2) * locators.length, attempts: locators.length, bytes: totalBytes });
    let repository: ArtifactRepository | undefined, request: Promise<ArtifactRepository> | undefined;
    let stage = 'read.get';
    try {
      request = this.trackDispatch(() => s.namespace.get(s.repository)).then(handle => { repository = handle; this.handlesOpen++; return handle; });
      await s.budget.bounded(() => request!);
      this.enabled();
      stage = 'read.info';
      if (s.identity) this.checkedRemote((await s.budget.bounded(() => this.trackDispatch(() => repository!.info()))).remote, s);
      const results: (Uint8Array | null)[] = [];
      for (const locator of locators) {
        this.enabled(); stage = 'read.file';
        const blob = await s.budget.bounded(() => this.trackDispatch(() => repository!.readFile({ ref: locator.ref, path: locator.path })));
        if (!blob) { results.push(null); continue; }
        if (blob.size > (locator.size_bytes ?? 65536) || (locator.size_bytes !== undefined && blob.size !== locator.size_bytes)) fail('ARTIFACT_DIGEST', 9, 'Artifact size does not match its reserved bound.');
        stage = 'read.body';
        const bytes = new Uint8Array(await s.budget.bounded(() => blob.arrayBuffer()));
        if (bytes.byteLength !== blob.size || bytesDigest(bytes) !== locator.hash) fail('ARTIFACT_DIGEST', 9, 'Artifacts returned bytes that do not match the pinned digest.');
        results.push(bytes);
      }
      return results;
    } catch (error) {
      if (error instanceof StrataError) throw error;
      fail('ARTIFACT_UNAVAILABLE', 9, 'Artifact read failed.', providerDiagnostic(stage, error));
    } finally {
      let cleanupFailed = false, timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (request && await Promise.race([request!.then(() => true, () => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]) === false) cleanupFailed = true;
      } finally { clearTimeout(timer); }
      try { if (repository) this.disposeHandle(repository); } catch { cleanupFailed = true; }
      if (cleanupFailed) { s.budget.stop(); fail('ARTIFACT_CLEANUP', 9, 'Artifact capability cleanup failed; this run has stopped.'); }
    }
  }
}
