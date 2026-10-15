import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { runMockDirectSmoke, SMOKE_OBJECTS, directSmokePlan, type SmokeTarget } from '../src/artifacts-rest-smoke.js';
import { artifactBundle, packetLines } from '../src/artifacts-git.js';
import { StrataError } from '../src/model.js';

const NOW = Date.parse('2026-10-04T01:00:00Z');
const target: SmokeTarget = { account_id: 'a'.repeat(32), namespace: 'default', repository: 'strata-smoke-mocked-20261004', run_id: 'fixture-run-20261004' };
const envelope = (result: any, status = 200, extra: any = {}) => new Response(JSON.stringify({ success: status < 400, result, errors: [], ...extra }), { status });
const packet = (s: string) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
class RestFixture {
  exists = false; description = ''; branchExists = false; active = new Map<string, any>();
  calls: { method: string; url: string }[] = []; tokenPosts = 0; deleteRequests = 0; polls = 0; pushes = 0;
  existing = false; missingNamespace = false; foreignCreate = false; loseCreate = false; loseMint = false; losePush = false;
  wrongRemote = false; corruptRead = false; revokeFail = false; deletionNever = false; replacedBeforeDelete = false; pollNeeded = 1; lateCreateMs = 0; oversized = false; redirected = false;
  gitRedirect: 'discovery' | 'push' | null = null;
  readonly repoPath = `/client/v4/accounts/${target.account_id}/artifacts/namespaces/default/repos/${target.repository}`;
  readonly base = `/client/v4/accounts/${target.account_id}/artifacts/namespaces/default`;
  readonly remote = `https://${target.account_id}.artifacts.cloudflare.net/git/default/${target.repository}.git`;
  readonly bundle = artifactBundle(SMOKE_OBJECTS);
  metadata = () => ({ id: this.replacedBeforeDelete && this.tokenPosts === 2 ? 'repo-another-writer' : 'repo-fixture', name: target.repository, description: this.description, remote: this.remote });
  transport = async (request: Request) => {
    const u = new URL(request.url); assert.equal(request.redirect, u.origin === 'https://api.cloudflare.com' ? 'error' : 'manual'); this.calls.push({ method: request.method, url: request.url });
    assert.ok(u.origin === 'https://api.cloudflare.com' || u.origin === new URL(this.remote).origin, 'No Worker, DO, proxy, telemetry or OAuth endpoint.');
    if (u.origin !== 'https://api.cloudflare.com') {
      assert.match(request.headers.get('authorization')!, /^Bearer art_v1_[a-f0-9]{40}\?expires=\d+$/);
      if (request.method === 'GET') {
        assert.equal(request.url, this.remote + '/info/refs?service=git-receive-pack');
        if (this.gitRedirect === 'discovery') return new Response(null, { status: 302, headers: { location: 'https://example.com/sink' } });
        return new Response(packet('# service=git-receive-pack\n') + '0000' + packet(`${this.branchExists ? this.bundle.commit + ' ' + this.bundle.branch : '0'.repeat(40) + ' capabilities^{}'}\0report-status\n`) + '0000');
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, this.remote + '/git-receive-pack');
      if (this.gitRedirect === 'push') return new Response(null, { status: 307, headers: { location: 'https://example.com/sink' } });
      const payload = Buffer.from(await request.arrayBuffer()), length = parseInt(payload.subarray(0, 4).toString(), 16);
      assert.equal(packetLines(payload.subarray(0, length))[0], `${'0'.repeat(40)} ${this.bundle.commit} ${this.bundle.branch}\0report-status\n`);
      assert.deepEqual(payload.subarray(length + 4), this.bundle.pack); // Existing independent adapter suite validates this shared Git writer's pack.
      assert.equal(this.branchExists, false); this.branchExists = true; this.pushes++;
      if (this.losePush) throw Error('unsafe-canary art_v1_' + 'f'.repeat(40) + '?expires=1');
      return new Response(packet('unpack ok\n') + packet('ok ' + this.bundle.branch + '\n') + '0000');
    }
    assert.ok(u.pathname.startsWith(this.base));
    if (request.method === 'GET' && u.pathname === this.base) return envelope({ namespace: 'default' }, this.missingNamespace ? 404 : 200);
    if (request.method === 'GET' && u.pathname === this.repoPath) {
      if (this.existing && !this.exists) return envelope({ ...this.metadata(), description: 'pre-existing' });
      if (this.deleteRequests) { this.polls++; if (!this.deletionNever && this.polls >= this.pollNeeded) this.exists = false; }
      return envelope(this.exists ? this.metadata() : null, this.exists ? 200 : 404);
    }
    if (request.method === 'POST' && u.pathname === this.base + '/repos') {
      const input: any = await request.json(); assert.deepEqual(input, { name: target.repository, description: 'strata-smoke:' + target.run_id, default_branch: 'main', read_only: false });
      if (this.lateCreateMs) await new Promise(resolve => setTimeout(resolve, this.lateCreateMs));
      this.exists = true; this.description = this.foreignCreate ? 'another-owner-marker' : input.description;
      this.active.set('initial-token', { id: 'initial-token', state: 'active', scope: 'write' });
      if (this.loseCreate) throw Error('create response lost');
      return envelope({ ...this.metadata(), remote: this.wrongRemote ? 'https://example.com/sink' : this.remote, token: 'art_v1_' + 'b'.repeat(40) + '?expires=' + Math.floor((NOW + 86400000) / 1000) });
    }
    if (request.method === 'GET' && u.pathname === this.repoPath + '/tokens') {
      assert.equal(u.search, '?state=active&per_page=3&page=1'); return envelope([...this.active.values()], 200, { result_info: { page: 1, total_count: this.active.size } });
    }
    if (request.method === 'POST' && u.pathname === this.base + '/tokens') {
      assert.deepEqual(await request.json(), { repo: target.repository, scope: 'write', ttl: 60 }); this.tokenPosts++;
      const id = 'write-token-' + this.tokenPosts; this.active.set(id, { id, state: 'active', scope: 'write' });
      if (this.loseMint) throw Error('mint reply lost');
      return envelope({ id, plaintext: 'art_v1_' + 'c'.repeat(40) + '?expires=' + Math.floor((NOW + 60000) / 1000), expires_at: new Date(NOW + 60000).toISOString() });
    }
    if (request.method === 'DELETE' && u.pathname.startsWith(this.base + '/tokens/')) {
      if (this.revokeFail) return envelope(null, 500); this.active.delete(u.pathname.split('/').at(-1)!); return envelope({ id: u.pathname.split('/').at(-1) });
    }
    if (request.method === 'GET' && u.pathname === this.repoPath + '/file') {
      assert.equal(u.searchParams.get('ref'), this.bundle.commit); const object = SMOKE_OBJECTS.find(o => o.hash + '.json' === u.searchParams.get('path')); assert.ok(object);
      if (this.redirected) return new Response('', { status: 302, headers: { location: 'https://example.com/sink' } });
      return new Response(this.oversized ? 'x'.repeat(8193) : this.corruptRead ? 'corrupt' : object.bytes);
    }
    if (request.method === 'DELETE' && u.pathname === this.repoPath) { this.deleteRequests++; return envelope({ id: 'repo-fixture' }, 202); }
    throw Error('Unexpected fixture endpoint');
  };
  run(extra: Partial<Parameters<typeof runMockDirectSmoke>[0]> = {}) { return runMockDirectSmoke({ mode: 'strict-mock', target, transport: this.transport, now: () => NOW, poll_delay_ms: 0, ...extra }); }
}
const caseEvidence: any[] = [];
const assertBounded = (r: any) => { assert.ok(r.counts.artifact_http_requests <= 30); assert.ok(r.counts.work_requests <= 18); assert.ok(r.counts.cleanup_requests <= 12); assert.ok(r.counts.token_posts <= 2); assert.ok(r.counts.token_delete_attempts <= 3); assert.ok(r.counts.delete_polls <= 5); assert.ok(r.reserved_transfer_bytes <= 1048576); assert.ok(!JSON.stringify(r).includes('art_v1_')); caseEvidence.push(r); };
after(async () => { await mkdir('.strata', { recursive: true }); await writeFile('.strata/direct-artifacts-smoke-cases.json', JSON.stringify(caseEvidence, null, 2) + '\n'); });

test('direct mock smoke uses exactly 21 allowed HTTP calls, one push, explicit token cleanup and no Worker/DO/OAuth/global fetch', async () => {
  const fixture = new RestFixture(), previous = globalThis.fetch; globalThis.fetch = async () => { throw Error('Forbidden live network'); };
  try {
    const result = await fixture.run(); assert.equal(result.status, 'passed'); assertBounded(result);
    assert.equal(result.counts.artifact_http_requests, 21); assert.equal(result.counts.work_requests, 15); assert.equal(result.counts.cleanup_requests, 6);
    assert.equal(result.counts.token_posts, 2); assert.equal(result.counts.token_delete_attempts, 3); assert.equal(fixture.pushes, 1); assert.equal(fixture.exists, false); assert.equal(fixture.active.size, 0);
    assert.equal(result.counts.worker_calls + result.counts.durable_object_calls + result.counts.proxy_calls + result.counts.oauth_refresh_requests, 0);
    // Evidence is retained in ignored state; never copy run receipts into tracked documentation.
    await mkdir('.strata', { recursive: true }); await writeFile('.strata/direct-artifacts-smoke-mock.json', JSON.stringify({ ...result, plan: directSmokePlan }, null, 2) + '\n');
  } finally { globalThis.fetch = previous; }
});
test('async deletion polls are counted: five polls yield 25 calls, never more than five', async () => {
  const fixture = new RestFixture(); fixture.pollNeeded = 5; const result = await fixture.run(); assert.equal(result.status, 'passed'); assert.equal(result.counts.artifact_http_requests, 25); assert.equal(result.counts.delete_polls, 5); assertBounded(result);
  const stuck = new RestFixture(); stuck.deletionNever = true; const incomplete = await stuck.run(); assert.equal(incomplete.status, 'failed-or-cleanup-unresolved'); assert.equal(incomplete.counts.delete_polls, 5); assert.ok(incomplete.cleanup.residuals.includes('repository-deletion-unconfirmed')); assertBounded(incomplete);
});
test('existing repo or missing namespace prevents all creation/token/deletion requests', async () => {
  for (const key of ['existing', 'missingNamespace'] as const) { const fixture = new RestFixture(); fixture[key] = true; const result = await fixture.run(); assert.equal(result.status, 'failed-or-cleanup-unresolved'); assert.equal(fixture.tokenPosts + fixture.deleteRequests, 0); assert.ok(fixture.calls.every(c => c.method === 'GET')); assertBounded(result); }
});
test('calendar margin, unsafe identifiers and unconnected live mode make zero calls', async () => {
  const fixture = new RestFixture();
  for (const now of [Date.parse('2026-10-14T00:00:00Z'), Date.parse('2026-10-13T23:55:00Z')]) await assert.rejects(fixture.run({ now: () => now }), (e: any) => e.code === 'PREBILLING_WINDOW_CLOSED');
  await assert.rejects(fixture.run({ target: { ...target, namespace: '../workers/scripts' } }));
  await assert.rejects(fixture.run({ mode: 'remote' as any }), (e: any) => e.code === 'REMOTE_TRANSPORT_UNAVAILABLE'); assert.equal(fixture.calls.length, 0);
});
test('lost successful push is not retried; bounded cleanup and errors contain no provider token/canary', async () => {
  const fixture = new RestFixture(); fixture.losePush = true; const result = await fixture.run(); assert.equal(result.status, 'failed-or-cleanup-unresolved'); assert.equal(fixture.pushes, 1); assert.equal(fixture.tokenPosts, 1); assert.equal(fixture.deleteRequests, 1); assert.equal(fixture.active.size, 0); assert.ok(!JSON.stringify(result).includes('unsafe-canary')); assertBounded(result);
});
test('ambiguous create requires exact marker ownership; foreign race is never adopted or deleted', async () => {
  const ours = new RestFixture(); ours.loseCreate = true; const result = await ours.run(); assert.equal(result.cleanup.ownership_proven, true); assert.equal(ours.deleteRequests, 1); assert.equal(ours.active.size, 0); assertBounded(result);
  const foreign = new RestFixture(); foreign.foreignCreate = true; foreign.loseCreate = true; const denied = await foreign.run(); assert.equal(denied.cleanup.ownership_proven, false); assert.equal(foreign.deleteRequests, 0); assert.equal(foreign.tokenPosts, 0); assert.ok(denied.cleanup.residuals.includes('creation-ownership-unproven')); assertBounded(denied);
});
test('lost token reply is reconciled once through bounded inventory, revoked and never minted again', async () => {
  const fixture = new RestFixture(); fixture.loseMint = true; const result = await fixture.run(); assert.equal(fixture.tokenPosts, 1); assert.equal(fixture.active.size, 0); assert.equal(fixture.deleteRequests, 1); assertBounded(result);
});
test('late mutation remains an explicit residual and never triggers background cleanup/retry after return', async () => {
  const fixture = new RestFixture(); fixture.lateCreateMs = 50; const result = await fixture.run({ request_timeout_ms: 2, late_reply_grace_ms: 1 });
  const count = fixture.calls.length; assert.equal(result.status, 'failed-or-cleanup-unresolved'); assert.ok(result.cleanup.residuals.some(s => s.startsWith('inflight-request-outcome-unknown'))); assertBounded(result);
  await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(fixture.calls.length, count); assert.equal(fixture.deleteRequests, 0); assert.equal(fixture.exists, true);
});
test('wrong remote, digest mismatch, redirect and oversized response stop data work and delete only the owned repo', async () => {
  for (const key of ['wrongRemote', 'corruptRead', 'redirected', 'oversized'] as const) { const fixture = new RestFixture(); fixture[key] = true; const result = await fixture.run(); assert.equal(result.status, 'failed-or-cleanup-unresolved'); assert.equal(fixture.deleteRequests, 1); assert.ok(fixture.tokenPosts <= 1); assert.ok(fixture.calls.every(c => !c.url.includes('example.com'))); assertBounded(result); }
});
test('revoke failure is never retried and remains explicit even after repository absence', async () => {
  const fixture = new RestFixture(); fixture.revokeFail = true; const result = await fixture.run(); assert.equal(result.status, 'failed-or-cleanup-unresolved'); assert.equal(result.counts.token_delete_attempts, 1); assert.equal(fixture.tokenPosts, 0); assert.equal(result.cleanup.repository_absent, true); assert.ok(result.cleanup.residuals.some(s => s.startsWith('token-revocation-unconfirmed'))); assertBounded(result);
});
test('a replaced repository identity is refused before deletion', async () => {
  const fixture = new RestFixture(); fixture.replacedBeforeDelete = true; const result = await fixture.run(); assert.equal(result.status, 'failed-or-cleanup-unresolved'); assert.equal(fixture.deleteRequests, 0); assert.ok(result.cleanup.residuals.includes('repository-deletion-unconfirmed')); assertBounded(result);
});

test('Git discovery and push redirects fail closed without following or retrying, then clean only the owned repository', async () => {
  for (const stage of ['discovery', 'push'] as const) {
    const fixture = new RestFixture(); fixture.gitRedirect = stage;
    const result = await fixture.run();
    assert.equal(result.status, 'failed-or-cleanup-unresolved');
    assert.equal(result.failure, 'ARTIFACT_PROTOCOL');
    assert.equal(fixture.pushes, 0); assert.equal(fixture.tokenPosts, 1);
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.url.endsWith('/git-receive-pack')).length, stage === 'push' ? 1 : 0);
    assert.ok(fixture.calls.every(c => !c.url.includes('example.com')));
    assert.equal(fixture.active.size, 0); assert.equal(fixture.deleteRequests, 1);
    assert.equal(result.cleanup.repository_absent, true); assertBounded(result);
  }
});
