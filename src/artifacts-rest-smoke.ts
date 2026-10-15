import { artifactBundle, pushArtifactBundle, type FetchTransport } from './artifacts-git.js';
import { bytesDigest, StrataError } from './model.js';

export const DIRECT_SMOKE_LIMITS = Object.freeze({ artifact_http_requests: 30, work_requests: 18, cleanup_requests: 12, oauth_refresh_requests: 1, transfer_reservation_bytes: 1048576, object_payload_bytes: 8192, duration_ms: 600000, request_timeout_ms: 5000, late_reply_grace_ms: 5000, delete_polls: 5, git_tokens: 2, revoke_requests: 3 });
export const SMOKE_OBJECTS = [1, 2].map(sequence => { const bytes = JSON.stringify({ kind: 'strata-provider-smoke', sequence }); return { bytes, hash: bytesDigest(bytes) }; });
export type SmokeTarget = { account_id: string; namespace: string; repository: string; run_id: string };
export type MockSmokeOptions = { mode: 'strict-mock'; target: SmokeTarget; transport: FetchTransport; now?: () => number; request_timeout_ms?: number; late_reply_grace_ms?: number; poll_delay_ms?: number };
export const directSmokePlan = {
  // Frozen legacy harness bound, not a statement about current provider pricing.
  state: 'mock-tested-preparation-live-transport-unavailable', expires_before_utc: '2026-10-14T00:00:00Z',
  transport: 'direct Artifacts REST and Git HTTPS; no Worker, Durable Object, remote proxy or AI',
  objects: SMOKE_OBJECTS.map(o => ({ hash: o.hash, bytes: Buffer.byteLength(o.bytes) })), limits: DIRECT_SMOKE_LIMITS,
  expected_artifact_http_requests: 21, expected_with_five_delete_polls: 25, hard_max_artifact_http_requests: 30,
  future_total_including_at_most_one_normal_oauth_refresh: 31,
  expected_sequence: ['namespace GET', 'new-name GET -> 404', 'repo POST', 'initial-token list GET', 'initial-token DELETE', '60s write-token POST', 'Git discovery GET', 'Git push POST', 'two file GETs', 'write-token DELETE', 'two cold file GETs', '60s write-token POST', 'Git discovery GET (reuse)', 'two file GETs', 'write-token DELETE', 'repo ID/marker GET', 'repo DELETE -> 202', 'repo GET -> 404'],
  live_auth_blocker: 'Pinned Wrangler CLI does not expose raw file reads/token revocation or a public authenticated raw-request API. No private-bundle patch, credential extraction or replacement account token is implemented.',
  approval_alone_is_insufficient: 'A supported, guarded normal-Wrangler transport must first be connected and verified with mocks. Current code has no live execution path.'
};
const issue = (code: string) => new StrataError(code, 9, 'Bounded provider smoke failed; see sanitized operation/residual evidence.');
type Trace = { method: string; path: string; phase: 'work' | 'cleanup'; status?: number; outcome: string };

// No default/global fetch and no credential loading. Only an explicitly injected mock
// transport is supported; a live bridge is not implemented.
export async function runMockDirectSmoke(options: MockSmokeOptions) {
  if (options.mode !== 'strict-mock') throw new StrataError('REMOTE_TRANSPORT_UNAVAILABLE', 7, 'No approved live Wrangler transport is connected.');
  const target = { ...options.target }; const now = options.now ?? Date.now;
  if (now() + DIRECT_SMOKE_LIMITS.duration_ms >= Date.parse(directSmokePlan.expires_before_utc)) throw new StrataError('PREBILLING_WINDOW_CLOSED', 7, 'A complete ten-minute cleanup margin is required before the billing date.');
  if (!/^[a-f0-9]{32}$/.test(target.account_id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(target.namespace) || !/^strata-smoke-[a-z0-9-]{8,40}$/.test(target.repository) || !/^[a-z0-9-]{8,64}$/.test(target.run_id)) throw new StrataError('INVALID_ARGUMENT', 2, 'Provide an exact account, existing namespace, new smoke name and run marker.');
  const requestMs = options.request_timeout_ms ?? DIRECT_SMOKE_LIMITS.request_timeout_ms;
  const lateMs = options.late_reply_grace_ms ?? DIRECT_SMOKE_LIMITS.late_reply_grace_ms;
  if (requestMs <= 0 || requestMs > 5000 || lateMs < 0 || lateMs > 5000 || (options.poll_delay_ms ?? 250) > 1000) throw new StrataError('INVALID_ARGUMENT', 2, 'Test timings cannot increase the approved bounds.');
  const started = now(), end = started + DIRECT_SMOKE_LIMITS.duration_ms, workEnd = end - 60000;
  const base = `https://api.cloudflare.com/client/v4/accounts/${target.account_id}/artifacts/namespaces/${target.namespace}`;
  const repo = `${base}/repos/${target.repository}`, remote = `https://${target.account_id}.artifacts.cloudflare.net/git/${target.namespace}/${target.repository}.git`;
  const marker = 'strata-smoke:' + target.run_id, bundle = artifactBundle(SMOKE_OBJECTS);
  const tokens = new Map<string, { attempted: boolean; revoked: boolean }>();
  const pending = new Set<Promise<void>>(), trace: Trace[] = [], residuals: string[] = [];
  let work = 0, cleanup = 0, reserved = 0, bodyBytes = 0, minted = 0, revoked = 0, polls = 0;
  let createSent = false, owned = false, repoId: string | null = null, initialUnknown = false, mintUnknown = false, deleted = false, failure: string | null = null, success = false;
  const idOk = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const track = (id: unknown) => { if (!idOk(id)) throw issue('TOKEN_ID_UNAVAILABLE'); if (!tokens.has(id)) tokens.set(id, { attempted: false, revoked: false }); return id; };
  function captureCreate(data: any) {
    if (data?.name !== target.repository || data?.description !== marker || !idOk(data?.id)) throw issue('CREATION_OWNERSHIP_UNPROVEN');
    owned = true; repoId = data.id; initialUnknown = true;
  }
  function allowed(request: Request) {
    const u = new URL(request.url), m = request.method, path = u.pathname;
    if (u.username || u.password || u.hash) return false;
    const b = new URL(base).pathname, r = new URL(repo).pathname;
    if (u.origin === 'https://api.cloudflare.com') {
      if (request.redirect !== 'error') return false;
      if (m === 'GET' && (path === b || path === r) && !u.search) return true;
      if (m === 'POST' && (path === b + '/repos' || path === b + '/tokens') && !u.search) return true;
      if (m === 'DELETE' && (path === r || (path.startsWith(b + '/tokens/') && tokens.has(path.slice((b + '/tokens/').length)))) && !u.search) return true;
      if (m === 'GET' && path === r + '/tokens' && u.search === '?state=active&per_page=3&page=1') return true;
      if (m === 'GET' && path === r + '/file' && u.searchParams.size === 2 && u.searchParams.get('ref') === bundle.commit && SMOKE_OBJECTS.some(o => u.searchParams.get('path') === o.hash + '.json')) return true;
    }
    if (u.origin === new URL(remote).origin) {
      // The shared Git writer rejects non-success responses with manual redirect
      // handling for workerd portability. Accept it only on these exact Git routes.
      if (request.redirect !== 'manual') return false;
      if (m === 'GET' && request.url === remote + '/info/refs?service=git-receive-pack') return true;
      if (m === 'POST' && request.url === remote + '/git-receive-pack') return true;
    }
    return false;
  }
  async function boundedBody(response: Response, maximum: number, signal: AbortSignal) {
    const chunks: Uint8Array[] = []; let bytes = 0; const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    try { while (true) { if (signal.aborted) throw issue('REQUEST_TIMEOUT'); const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > maximum) throw issue('RESPONSE_TOO_LARGE'); chunks.push(item.value); } }
    finally { await reader.cancel().catch(() => {}); }
    bodyBytes += bytes; return new Uint8Array(Buffer.concat(chunks));
  }
  async function send(request: Request, phase: 'work' | 'cleanup', cap = 8192, onLate?: (r: Response) => Promise<void>) {
    if (!allowed(request)) throw issue('ENDPOINT_FORBIDDEN');
    if (now() >= (phase === 'work' ? workEnd : end) || now() >= Date.parse(directSmokePlan.expires_before_utc)) throw issue('RUN_DEADLINE');
    if (work + cleanup >= 30 || (phase === 'work' ? work >= 18 : cleanup >= 12)) throw issue('REQUEST_BUDGET_EXHAUSTED');
    const payload = request.body ? new Uint8Array(await request.clone().arrayBuffer()) : new Uint8Array();
    if (payload.byteLength > 16384) throw issue('PAYLOAD_TOO_LARGE');
    // Reserve response maximum plus 8 KiB protocol/header allowance before dispatch.
    if (reserved + payload.byteLength + cap + 8192 > 1048576) throw issue('TRANSFER_BUDGET_EXHAUSTED');
    reserved += payload.byteLength + cap + 8192; bodyBytes += payload.byteLength;
    if (phase === 'work') work++; else cleanup++;
    const event: Trace = { method: request.method, path: new URL(request.url).pathname, phase, outcome: 'dispatched' }; trace.push(event);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const operation = Promise.resolve().then(() => options.transport(new Request(request, { signal: controller.signal }))).then(async response => {
      const bytes = await boundedBody(response, cap, controller.signal); event.status = response.status;
      const safe = new Response(bytes, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' } });
      if (timedOut && onLate) await onLate(safe.clone());
      return safe;
    });
    const settled = operation.then(() => {}, () => {}); pending.add(settled); void settled.finally(() => pending.delete(settled));
    try {
      const response = await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); event.outcome = 'timeout-unknown'; reject(issue('REQUEST_TIMEOUT')); }, Math.max(1, Math.min(requestMs, (phase === 'work' ? workEnd : end) - now()))); })]);
      event.outcome = 'received'; return response;
    } catch (e) { if (!timedOut) event.outcome = 'failed-unknown'; throw e instanceof StrataError ? e : issue('TRANSPORT_FAILURE'); }
    finally { clearTimeout(timer); }
  }
  const request = (url: string, method = 'GET', input?: any) => new Request(url, { method, redirect: 'error', ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) });
  async function jsonResponse(response: Response) { const data: any = await response.json(); if (!response.ok || data?.success !== true) throw issue('REST_FAILURE'); return data; }
  async function rest(url: string, method = 'GET', input?: any, phase: 'work' | 'cleanup' = 'work', late?: (data: any) => void) {
    return jsonResponse(await send(request(url, method, input), phase, 8192, late ? async r => { try { late((await jsonResponse(r)).result); } catch {} } : undefined));
  }
  async function listTokens(phase: 'work' | 'cleanup') {
    const data = await rest(repo + '/tokens?state=active&per_page=3&page=1', 'GET', undefined, phase);
    if (!Array.isArray(data.result) || data.result.length > 3 || (data.result_info?.total_count ?? data.result.length) > 3 || (data.result_info?.page ?? 1) !== 1) throw issue('TOKEN_LIST_BOUND');
    return data.result;
  }
  async function revoke(id: string) {
    const token = tokens.get(id)!; if (token.attempted) return;
    if (revoked >= 3) throw issue('REVOKE_BOUND'); token.attempted = true; revoked++;
    await rest(base + '/tokens/' + id, 'DELETE', undefined, 'cleanup'); token.revoked = true;
  }
  async function batch(expectReuse: boolean) {
    if (minted >= 2) throw issue('TOKEN_MINT_BOUND'); minted++; mintUnknown = true;
    const mintedToken = (await rest(base + '/tokens', 'POST', { repo: target.repository, scope: 'write', ttl: 60 }, 'work', data => { track(data?.id); })).result;
    const id = track(mintedToken?.id); mintUnknown = false;
    const expiry = Date.parse(mintedToken.expires_at);
    if (typeof mintedToken.plaintext !== 'string' || !/^art_v1_[a-f0-9]{40}\?expires=\d+$/.test(mintedToken.plaintext) || !Number.isFinite(expiry) || expiry <= now() || expiry - now() > 65000) throw issue('TOKEN_CONTRACT');
    try {
      const result = await pushArtifactBundle(remote, mintedToken.plaintext, bundle, r => send(r, 'work', 65536), AbortSignal.timeout(Math.max(1, Math.min(60000, workEnd - now()))));
      if (result.reused !== expectReuse) throw issue('UNEXPECTED_BRANCH_STATE');
      for (const object of SMOKE_OBJECTS) await read(object);
    } finally { mintedToken.plaintext = undefined; await revoke(id); }
  }
  async function read(object: typeof SMOKE_OBJECTS[number]) {
    const response = await send(request(repo + '/file?ref=' + bundle.commit + '&path=' + object.hash + '.json'), 'work');
    const body = await response.text(); if (!response.ok || bytesDigest(body) !== object.hash || body !== object.bytes) throw issue('READBACK_DIGEST');
  }
  try {
    await rest(base); // Existing namespace only; no namespace-creation route exists.
    if ((await send(request(repo), 'work')).status !== 404) throw issue('REPO_NAME_IN_USE');
    createSent = true;
    const created = (await rest(base + '/repos', 'POST', { name: target.repository, description: marker, default_branch: 'main', read_only: false }, 'work', captureCreate)).result;
    captureCreate(created);
    if (created.remote !== remote || typeof created.token !== 'string' || !/^art_v1_[a-f0-9]{40}\?expires=\d+$/.test(created.token)) throw issue('CREATION_CONTRACT');
    created.token = undefined;
    const initial = await listTokens('work'); if (initial.length !== 1 || initial[0]?.scope !== 'write' || initial[0]?.state !== 'active') throw issue('INITIAL_TOKEN_MAPPING');
    const initialId = track(initial[0].id); initialUnknown = false; await revoke(initialId);
    await batch(false);
    for (const object of SMOKE_OBJECTS) await read(object); // Fresh, exact-commit cold reads; no in-memory store fallback.
    await batch(true); success = true;
  } catch (e) { failure = e instanceof StrataError ? e.code : 'UNEXPECTED_FAILURE'; }
  finally {
    if (pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, lateMs); })]); clearTimeout(timer);
    }
    // An ambiguous create is never repeated. A matching unpredictable run marker
    // may prove ownership; another repo at that name is NEVER adopted or deleted.
    if (createSent && !owned) {
      try { const response = await send(request(repo), 'cleanup'); if (response.ok) captureCreate((await jsonResponse(response)).result); }
      catch { residuals.push('creation-ownership-unproven'); }
      if (!owned) residuals.push('creation-ownership-unproven');
    }
    if (owned) {
      if (initialUnknown || mintUnknown || pending.size) {
        try { for (const token of await listTokens('cleanup')) track(token.id); initialUnknown = false; mintUnknown = false; }
        catch { residuals.push('token-inventory-unknown'); }
      }
      for (const [id, token] of tokens) if (!token.attempted) { try { await revoke(id); } catch { residuals.push('token-revocation-unconfirmed:' + id); } }
      try {
        const current = await send(request(repo), 'cleanup');
        if (current.status === 404) deleted = true;
        else {
        const metadata = (await jsonResponse(current)).result;
        if (metadata.id !== repoId || metadata.description !== marker) throw issue('DELETE_OWNERSHIP_CHANGED');
        const response = await send(request(repo, 'DELETE'), 'cleanup');
        if (![202, 404].includes(response.status)) throw issue('DELETE_NOT_ACCEPTED');
        for (let i = 0; i < 5; i++) {
          if (i) await new Promise(resolve => setTimeout(resolve, options.poll_delay_ms ?? 250));
          polls++; const check = await send(request(repo), 'cleanup');
          if (check.status === 404) { deleted = true; break; }
          if (!check.ok || (await jsonResponse(check)).result.id !== repoId) throw issue('DELETE_OWNERSHIP_CHANGED');
        }
        }
        if (!deleted) residuals.push('repository-deletion-unconfirmed');
      } catch { residuals.push('repository-deletion-unconfirmed'); }
    }
    if (pending.size) residuals.push('inflight-request-outcome-unknown; late mutations may outlive observed deletion');
    for (const [id, token] of tokens) if (!token.revoked) residuals.push('token-revocation-unconfirmed:' + id);
    if (initialUnknown || mintUnknown) residuals.push('token-issuance-outcome-unknown');
  }
  return {
    status: success && deleted && residuals.length === 0 ? 'passed' : 'failed-or-cleanup-unresolved', failure,
    mode: 'strict-mock', target, commit: bundle.commit, branch: bundle.branch,
    counts: { artifact_http_requests: work + cleanup, work_requests: work, cleanup_requests: cleanup, token_posts: minted, token_delete_attempts: revoked, delete_polls: polls, git_pushes: trace.filter(t => t.method === 'POST' && t.path.endsWith('/git-receive-pack')).length, oauth_refresh_requests: 0, worker_calls: 0, durable_object_calls: 0, proxy_calls: 0, ai_calls: 0 },
    reserved_transfer_bytes: reserved, measured_application_body_bytes: bodyBytes, deadline_ms: 600000,
    cleanup: { ownership_proven: owned, repository_absent: deleted, token_ids_revoked: [...tokens].filter(([, t]) => t.revoked).map(([id]) => id), residuals: [...new Set(residuals)] },
    trace, live_execution: false, new_account_credentials: false,
    limitations: ['No actual provider interoperability or normal-Wrangler auth bridge is connected.', 'Application/protocol reservation is not a packet-level transfer meter or provider billing cap.', 'Abort/deadline does not prove provider cancellation; unsettled requests remain explicit residuals.']
  };
}
