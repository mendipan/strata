import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createDemoDashboard } from '../src/integrated-demo-dashboard.js';
import { demoFixture, authorFixture } from './integrated-demo-fixture.js';
import { operatorPromptPacketFromCheckpoint } from '../src/integrated-demo-operator-reply.js';
import { preflightDemoAccess } from '../src/integrated-demo-management-wrangler.js';

async function selection() {
  const fixture = demoFixture('controlled-private', Date.now());
  await fixture.event('bootstrap', 'host', {});
  for (const actor of ['a', 'c', 'b'] as const) await authorFixture(fixture, actor);
  const prepared = await fixture.event('prepare', 'host', {});
  return operatorPromptPacketFromCheckpoint(fixture.checkpoint, prepared.outcome);
}

test('loopback browser decisions bind capability, origin, host, run, phase, digest, reason, expiry and one submission', async () => {
  const packet = await selection(), controller = new AbortController(); let stops = 0;
  const view = await createDemoDashboard(packet.run_id, () => { stops++; controller.abort(); });
  const url = new URL(view.url), auth = { authorization: 'Bearer ' + url.hash.slice(1) };
  const body = { run_id: packet.run_id, phase: packet.phase, packet_digest: packet.packet_digest, action: '900', reason: 'SYNTHETIC local test choice.' };
  const post = (input: unknown, extra = {}) => fetch(url.origin + '/decision', { method: 'POST',
    headers: { ...auth, origin: url.origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
  try {
    assert.equal((await fetch(url.origin + '/state')).status, 403);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url.origin + '/state', { headers: { ...auth, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(wrongHost, 403);
    const decision = view.decide(packet, controller.signal);
    assert.equal((await post(body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(body, { authorization: 'Bearer wrong' })).status, 403);
    for (const change of [{ run_id: 'other' }, { phase: 'endorsement' }, { packet_digest: '0'.repeat(64) }, { action: 'approve-release' }, { reason: '' }])
      assert.equal((await post({ ...body, ...change })).status, 409);
    const state: any = await (await fetch(url.origin + '/state', { headers: auth })).json();
    assert.equal(state.packet.packet_digest, packet.packet_digest); assert.ok(state.review_html.includes('900'));
    assert.equal((await post(body)).status, 200);
    assert.deepEqual(await decision, { action: '900', reason: body.reason, capture_method: 'local-browser' });
    assert.equal((await post(body)).status, 409);
    await assert.rejects(view.decide({ ...packet, expires_at: Date.now() - 1 }, controller.signal));
    const wait = view.decide(packet, controller.signal); const rejected = assert.rejects(wait, /interrupted/);
    assert.equal((await fetch(url.origin + '/stop', { method: 'POST', headers: { ...auth, origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ run_id: packet.run_id }) })).status, 200);
    await rejected; assert.equal(stops, 1);
    view.finish(); assert.equal((await post(body)).status, 409);
  } finally { await view.close(); }
});

test('before-grant access checks only dispatch reads, reject auth errors and nonempty namespaces without retry', async () => {
  const target = { account_id: '1'.repeat(32), project_id: 'strata-local-demo', run_id: '0a1b2c3d4e5f6789',
    worker_name: 'strata-demo-0a1b2c3d4e5f6789', workflow_name: 'strata-demo-flow-0a1b2c3d4e5f6789', instance_id: 'run-0a1b2c3d4e5f6789',
    namespace_id: 'strata-test-namespace', repository_name: 'strata-run-0a1b2c3d4e5f6789' };
  for (const scenario of ['pass', 'auth', 'nonempty']) {
    const calls: string[][] = [], records: any[] = [];
    const run = preflightDemoAccess(target, process.cwd(), 'wrangler.integrated-demo.json', async record => { records.push(record); }, async invocation => {
      calls.push(invocation.args);
      assert.equal(invocation.env.CLOUDFLARE_ACCOUNT_ID, target.account_id);
      if (scenario === 'auth') return { code: 1, stdout: '', stderr: 'Authentication error [code: 10000] private-token-must-not-leak' };
      if (invocation.args.includes('deployments')) return { code: 1, stdout: '', stderr: `Cloudflare API (/accounts/${target.account_id}/workers/scripts/${target.worker_name}/deployments) This Worker does not exist on your account. [code: 10007]` };
      return { code: 0, stdout: JSON.stringify(scenario === 'nonempty' && invocation.args.includes('artifacts') ? [{ name: 'retain-me' }] : []), stderr: '' };
    });
    if (scenario === 'pass') { await run; assert.equal(calls.length, 4); }
    else { await assert.rejects(run, /No grant|no grant/i); assert.equal(calls.length, scenario === 'auth' ? 1 : 2); }
    assert.ok(calls.every(args => !args.some(arg => ['deploy', 'trigger', 'delete', 'send-event', 'login'].includes(arg))));
    assert.ok(!JSON.stringify(records).includes('private-token'));
  }
});
