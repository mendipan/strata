import { ArtifactRegistryStore } from './artifact-registry.js';
import { ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT, CloudflareArtifactsAdapter, type ArtifactRepository, type ArtifactsNamespace } from './artifacts.js';
import type { FetchTransport } from './artifacts-git.js';
import { artifactsTestFixture } from './artifacts-test-fixture.js';
import { RunBudget } from './budget.js';
import { bytesDigest, canonical, StrataError } from './model.js';

export const TEST_LIMITS = Object.freeze({ dispatches: 50, final_removal_dispatches: 4, worker_dispatches: 46,
  work_dispatches: 42, transfer_bytes: 4 * 1024 * 1024, original_bytes: 131072,
  grant_ms: 600000, cleanup_ms: 30000, cpu_ms: 1000, subrequests: 50, planned_requests: 1,
  steps: 1, step_timeout_ms: 600000, input_bytes: 256, result_bytes: 32768, status_reads: 3, retention_ms: 3600000 });
// Preserve the original harness's authorization cutoff. It is not a current
// pricing claim, and repository cleanup must not reopen an expired run window.
export const BILLING_CUTOFF = Date.parse('2026-10-14T00:00:00Z');
export type TestGrant = {
  format: 'strata-artifacts-workflow-grant/1'; approved: boolean; approval_id: string | null;
  run_id: string; account_id: string; namespace: string; repository: string; worker: string;
  project_id: string; source_digest: string; fixture_digest: string;
  workflow: string; instance_id: string;
  starts_at: string | null; expires_at: string | null;
};
export interface TestNamespace extends ArtifactsNamespace {
  create(name: string): Promise<{ name: string; remote: string; token: string }>;
}
type BindingCompatible = Artifacts extends TestNamespace ? true : never;
const bindingCompatible: BindingCompatible = true;
void bindingCompatible;
export type TestEnv = { ARTIFACTS: TestNamespace; STRATA_TEST_GRANT: string };
function refuse(code: string, exit = 7): never { throw new StrataError(code, exit, 'Dedicated test refused or failed.'); }
const safeCodes = new Set(['GRANT_REQUIRED','GRANT_INVALID','GRANT_EXPIRED','WORKFLOW_EVENT_REFUSED','WORKFLOW_ATTEMPT_REFUSED','RESULT_LIMIT','REQUEST_REFUSED',
  'RUN_ALREADY_EXISTS','RUN_AMBIGUOUS','DISPATCH_LIMIT','TRANSFER_LIMIT','WORK_STOPPED','CLEANUP_FAILED',
  'FIXTURE_MISMATCH','ARTIFACT_REMOTE','ARTIFACT_DIGEST','ARTIFACT_UNAVAILABLE','ARTIFACT_CLEANUP',
  'BUDGET_DEADLINE','BUDGET_EXHAUSTED','RUN_STOPPED','STORE_BINDING_MISMATCH','ARTIFACT_PROTOCOL']);
function safeCode(error: unknown) { return error instanceof StrataError && safeCodes.has(error.code) ? error.code : 'TEST_FAILED'; }
export function validateGrant(text: string, now = Date.now()): TestGrant {
  let g: TestGrant; try { g = JSON.parse(text); } catch { refuse('GRANT_INVALID'); }
  if (!g! || g.format !== 'strata-artifacts-workflow-grant/1' || g.approved !== true || typeof g.approval_id !== 'string' || !g.approval_id.trim()) refuse('GRANT_REQUIRED');
  const fixture = artifactsTestFixture();
  const keys = ['format','approved','approval_id','run_id','account_id','namespace','repository','worker','project_id',
    'source_digest','fixture_digest','workflow','instance_id','starts_at','expires_at'].sort();
  if (canonical(Object.keys(g).sort()) !== canonical(keys) || !/^[a-f0-9]{16}$/.test(g.run_id) || !/^[a-f0-9]{32}$/.test(g.account_id) ||
    g.worker !== `strata-artifacts-test-${g.run_id}` || g.namespace !== `strata-test-${g.run_id}` || g.repository !== `run-${g.run_id}` ||
    g.workflow !== `strata-artifacts-flow-${g.run_id}` || g.instance_id !== `run-${g.run_id}` ||
    g.project_id !== fixture.projectId || !/^[a-f0-9]{64}$/.test(g.source_digest) || g.fixture_digest !== fixture.fixtureDigest ||
    typeof g.starts_at !== 'string' || typeof g.expires_at !== 'string') refuse('GRANT_INVALID');
  const start = Date.parse(g.starts_at!), end = Date.parse(g.expires_at!);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= TEST_LIMITS.cleanup_ms || end - start > TEST_LIMITS.grant_ms || end > BILLING_CUTOFF) refuse('GRANT_INVALID');
  if (now < start || now >= end - TEST_LIMITS.cleanup_ms) refuse('GRANT_EXPIRED');
  return Object.freeze({ ...g });
}

// Charges are conservative application reservations, not a billable-operation count.
// Four final repo delete/absence dispatches are reserved for the external operator.
export class TestDispatchLedger {
  counts: Record<string, number> = {}; dispatches = 0; reservedBytes = 0; unsettled = 0;
  handles = 0; disposed = 0; issued = 0; revoked = 0; stopped = false;
  constructor(readonly grant: TestGrant, readonly now: () => number = Date.now) {}
  check(cleanup = false) {
    const deadline = Date.parse(this.grant.expires_at!) - (cleanup ? 0 : TEST_LIMITS.cleanup_ms);
    if ((!cleanup && this.stopped) || this.now() >= deadline) refuse('WORK_STOPPED');
  }
  async settle<T>(pending: Promise<T>, cleanup = false): Promise<T> {
    const remaining = Date.parse(this.grant.expires_at!) - (cleanup ? 0 : TEST_LIMITS.cleanup_ms) - this.now();
    if (remaining <= 0) { this.stopped = true; refuse('WORK_STOPPED'); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.stopped = true; reject(new StrataError('RUN_AMBIGUOUS', 7, 'Provider completion is unconfirmed.')); }, Math.min(cleanup ? 5000 : 30000, remaining));
    })]); } finally { clearTimeout(timer); }
  }
  // Retain the original promise so cleanup can reconcile late issuance without retry.
  dispatch<T>(kind: string, bytes: number, cleanup: boolean, operation: () => Promise<T>): Promise<T> {
    this.check(cleanup);
    if (this.dispatches >= (cleanup ? TEST_LIMITS.worker_dispatches : TEST_LIMITS.work_dispatches)) refuse('DISPATCH_LIMIT');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.reservedBytes + bytes > TEST_LIMITS.transfer_bytes) refuse('TRANSFER_LIMIT');
    this.dispatches++; this.reservedBytes += bytes; this.counts[kind] = (this.counts[kind] ?? 0) + 1; this.unsettled++;
    return Promise.resolve().then(operation).finally(() => { this.unsettled--; });
  }
  snapshot() { return { dispatches: this.dispatches, counts: { ...this.counts }, reserved_transfer_bytes: this.reservedBytes,
    unsettled_dispatches: this.unsettled, handles: this.handles, disposed: this.disposed,
    tokens_observed: this.issued, tokens_revoked: this.revoked, stopped: this.stopped,
    final_removal_dispatches_reserved: TEST_LIMITS.final_removal_dispatches, provider_hard_cap: false }; }
}

function exactRemote(g: TestGrant) { return `https://${g.account_id}.artifacts.cloudflare.net/git/${g.namespace}/${g.repository}.git`; }
export function boundedNamespace(raw: TestNamespace, ledger: TestDispatchLedger): ArtifactsNamespace {
  return { get: async name => {
    if (name !== ledger.grant.repository) refuse('REQUEST_REFUSED');
    const rawRepo = await ledger.dispatch('get', 1024, false, () => raw.get(name)); ledger.handles++;
    let disposed = false;
    const repo: ArtifactRepository = {
      info: () => ledger.dispatch('info', 4096, false, () => rawRepo.info()),
      createToken: (mode, ttl) => {
        if (mode !== 'write' || ttl !== 60 || (ledger.counts.createToken ?? 0) >= 2) refuse('DISPATCH_LIMIT');
        return ledger.dispatch('createToken', 4096, false, () => rawRepo.createToken(mode, ttl)).then(token => {
          ledger.issued++; if (!token.plaintext || token.plaintext.length > 4096) refuse('ARTIFACT_PROTOCOL'); return token;
        });
      },
      revokeToken: token => ledger.settle(ledger.dispatch('revokeToken', 1024, true, () => rawRepo.revokeToken(token)), true).then(result => {
        if (result !== true) refuse('CLEANUP_FAILED'); ledger.revoked++; return true;
      }),
      readFile: input => ledger.dispatch('readFile', TEST_LIMITS.original_bytes, false, () => rawRepo.readFile(input)).then(blob => {
        if (blob && blob.size > TEST_LIMITS.original_bytes) refuse('TRANSFER_LIMIT'); return blob;
      }),
      [Symbol.dispose]: () => { if (!disposed) { disposed = true; rawRepo[Symbol.dispose](); ledger.disposed++; } }
    };
    return repo;
  } };
}
function boundedTransport(raw: FetchTransport, ledger: TestDispatchLedger): FetchTransport {
  return async request => {
    ledger.check(); const url = new URL(request.url), root = exactRemote(ledger.grant);
    if (request.redirect !== 'manual' || !((request.method === 'GET' && url.href === root + '/info/refs?service=git-receive-pack') ||
      (request.method === 'POST' && url.href === root + '/git-receive-pack' && !ledger.counts.gitPush))) refuse('REQUEST_REFUSED');
    const body = request.method === 'POST' ? await request.clone().arrayBuffer() : null;
    if ((body?.byteLength ?? 0) > TEST_LIMITS.original_bytes) refuse('TRANSFER_LIMIT');
    const response = await ledger.dispatch(request.method === 'POST' ? 'gitPush' : 'gitDiscovery', (body?.byteLength ?? 0) + 65536, false, () => raw(request));
    // Bound response consumption too; the adapter retains its independent protocol bound.
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { if (reader) while (true) { const part = await ledger.settle(reader.read()); if (part.done) break;
      size += part.value.byteLength; if (size > 65536) refuse('TRANSFER_LIMIT'); chunks.push(part.value); }
    } finally { if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
}

export async function executeTest(grant: TestGrant, raw: TestNamespace, rawTransport: FetchTransport, now = Date.now) {
  const ledger = new TestDispatchLedger(grant, now), started = now();
  const phases = { claimed: false, initial_token_revoked: false, staged: false, fresh_instance_read: false, identical_retry_reused: false };
  let registry: Awaited<ReturnType<ArtifactRegistryStore['stage']>> | undefined;
  let created: Awaited<ReturnType<TestNamespace['create']>> | undefined, claim: Promise<Awaited<ReturnType<TestNamespace['create']>>> | undefined;
  let initialClean = false, initialRepo: ArtifactRepository | undefined;
  let initialGet: Promise<ArtifactRepository> | undefined, initialRevoke: Promise<unknown> | undefined;
  const cleanInitial = async () => {
    if (!created || initialClean) return;
    if (created.name !== grant.repository || created.remote !== exactRemote(grant) || typeof created.token !== 'string' || !created.token || created.token.length > 4096) refuse('CLEANUP_FAILED');
    initialGet ??= ledger.dispatch('getInitial', 1024, true, () => raw.get(grant.repository)).then(handle => { initialRepo = handle; ledger.handles++; return handle; });
    await ledger.settle(initialGet, true);
    initialRevoke ??= ledger.dispatch('revokeInitial', 1024, true, () => initialRepo!.revokeToken(created!.token));
    const revoked = await ledger.settle(initialRevoke, true);
    if (revoked !== true) refuse('CLEANUP_FAILED'); ledger.revoked++; initialClean = true; created.token = ''; phases.initial_token_revoked = true;
  };
  let code: string | undefined;
  try {
    claim = ledger.dispatch('create', 4096, false, () => raw.create(grant.repository)).then(result => { created = result; ledger.issued++; phases.claimed = true; return result; });
    try { await ledger.settle(claim); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && [10201, 'ALREADY_EXISTS'].includes(error.code as number | string)) refuse('RUN_ALREADY_EXISTS');
      if (!(error instanceof StrataError)) refuse('RUN_AMBIGUOUS'); throw error; }
    await cleanInitial();
    if (initialRepo) { initialRepo[Symbol.dispose](); ledger.disposed++; initialRepo = undefined; }
    const fixture = artifactsTestFixture();
    if (fixture.originalBytes > TEST_LIMITS.original_bytes || fixture.fixtureDigest !== grant.fixture_digest) refuse('FIXTURE_MISMATCH');
    const duration = Math.floor(Date.parse(grant.expires_at!) - TEST_LIMITS.cleanup_ms - now());
    const budget = new RunBudget({ operations: 50, bytes: TEST_LIMITS.transfer_bytes, attempts: 10, input_tokens: 0, output_tokens: 0, duration_ms: Math.max(1, duration) });
    const namespace = boundedNamespace(raw, ledger), transport = boundedTransport(rawTransport, ledger);
    const store = () => new ArtifactRegistryStore(new CloudflareArtifactsAdapter({ mode: 'remote', namespace, repository: grant.repository,
      identity: { account: grant.account_id, namespace: grant.namespace }, approval: { approved: true, repository: grant.repository,
        approval_id: grant.approval_id!, project_id: grant.project_id, expires_at: new Date(Date.parse(grant.expires_at!) - TEST_LIMITS.cleanup_ms).toISOString() }, budget, transport,
      max_repo_tokens: ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT }), grant.project_id);
    registry = await store().stage(fixture.records, fixture.bytes, { entries: {} }); phases.staged = true;
    const persisted = JSON.parse(canonical(registry));
    const cold = await store().load(persisted);
    if (canonical(cold.records) !== canonical(fixture.records) || bytesDigest(cold.assetBytes.get(fixture.binaryHash)!) !== fixture.binaryHash || cold.assetBytes.get(fixture.binaryHash)!.byteLength !== fixture.bytes.get(fixture.binaryHash)!.byteLength) refuse('FIXTURE_MISMATCH');
    phases.fresh_instance_read = true;
    const retry = await store().stage(fixture.records, fixture.bytes, { entries: {} });
    if (!retry.receipt?.reused || canonical(retry.entries) !== canonical(registry.entries) || canonical(retry.asset_locators) !== canonical(registry.asset_locators) || canonical(retry.storage) !== canonical(registry.storage) || ledger.counts.gitPush !== 1) refuse('FIXTURE_MISMATCH');
    phases.identical_retry_reused = true;
  } catch (error) { ledger.stopped = true; code = safeCode(error); }
  finally {
    if (claim && !created && code !== 'RUN_ALREADY_EXISTS') { try { await ledger.settle(claim, true); } catch { code = code ?? 'RUN_AMBIGUOUS'; } }
    if (created && !initialClean) { try { await cleanInitial(); } catch { code = 'CLEANUP_FAILED'; } }
    if (initialRepo) { try { initialRepo[Symbol.dispose](); ledger.disposed++; } catch { code = 'CLEANUP_FAILED'; } }
  }
  const tokenCleanup = ledger.issued === ledger.revoked && ledger.handles === ledger.disposed && ledger.unsettled === 0;
  if (!tokenCleanup) code = 'CLEANUP_FAILED';
  const fixture = artifactsTestFixture();
  return { format: 'strata-artifacts-workflow-receipt/1', ok: code === undefined, ...(code ? { error: { code } } : {}),
    run_id: grant.run_id, source_digest: grant.source_digest, fixture_digest: fixture.fixtureDigest,
    resource: { account: grant.account_id, namespace: grant.namespace, repository: grant.repository, worker: grant.worker },
    objects: 4, original_bytes: fixture.originalBytes, elapsed_ms: Math.max(0, now() - started), phases,
    ...(phases.staged ? { registry } : {}), ledger: ledger.snapshot(),
    cleanup: { observed_tokens_and_handles_clean: tokenCleanup, repository_retained_as_claim: phases.claimed,
      repository_creation_confirmed: phases.claimed, claim_outcome: phases.claimed ? 'created' : code === 'RUN_ALREADY_EXISTS' ? 'preexisting-refused' : 'unconfirmed',
      worker_removed: false, repository_removed: false, namespace_removed: false, workflow_removed: false, instance_removed: false,
      external_cleanup_required: true, provider_cancellation_proven: false } };
}

// No HTTP handler. Only the provider's authenticated Workflow control plane can
// invoke the exported class; no caller-supplied URLs, bindings or grants.
export const TEST_STEP_CONFIG = Object.freeze({ retries: Object.freeze({ limit: 0, delay: 1000, backoff: 'constant' as const }),
  timeout: TEST_LIMITS.step_timeout_ms });
export type PrivateTestEvent = { instanceId: string; workflowName: string; timestamp: Date; payload: unknown; schedule?: unknown };
export type PrivateTestStep = Pick<import('cloudflare:workers').WorkflowStep, 'do'>;
export async function runPrivateTest(event: PrivateTestEvent, step: PrivateTestStep, env: TestEnv,
  transport: FetchTransport = request => fetch(request), now = Date.now) {
  return step.do('synthetic-artifacts-once', TEST_STEP_CONFIG, async context => {
    try {
      // Defense against a replayed callback even when the engine retry count is zero.
      if (context.attempt !== 1 || context.step.count !== 1) refuse('WORKFLOW_ATTEMPT_REFUSED');
      const g = validateGrant(env.STRATA_TEST_GRANT, now());
      const input = canonical(event.payload), createdAt = event.timestamp.getTime();
      if (event.schedule !== undefined || event.workflowName !== g.workflow || event.instanceId !== g.instance_id ||
        Buffer.byteLength(input) > TEST_LIMITS.input_bytes || input !== canonical({run_id:g.run_id}) ||
        !Number.isFinite(createdAt) || createdAt < Date.parse(g.starts_at!) || createdAt >= Date.parse(g.expires_at!) - TEST_LIMITS.cleanup_ms)
        refuse('WORKFLOW_EVENT_REFUSED');
      const result = await executeTest(g, env.ARTIFACTS, transport, now);
      if (Buffer.byteLength(JSON.stringify(result)) > TEST_LIMITS.result_bytes) refuse('RESULT_LIMIT');
      return result;
    } catch (error) {
      return { format:'strata-artifacts-workflow-receipt/1', ok:false, error:{code:safeCode(error)},
        cleanup:{external_cleanup_required:true,provider_cancellation_proven:false} };
    }
  });
}
