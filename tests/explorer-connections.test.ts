import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { canonical, bytesDigest, MODEL } from '../src/model.js';
import { ExplorerError } from '../src/explorer/contract.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { ExplorerConnections } from '../src/explorer/connections.js';
import { startExplorer } from '../src/explorer/host.js';
import { RegistrySource, RestArtifactsReader } from '../src/explorer/source.js';
import { TestSource, sample, config, registry } from './explorer-fixture.js';

async function fixture() {
  const source = new TestSource(await sample()), reader = new ExplorerReader(source);
  await reader.refresh();
  const connections = new ExplorerConnections([{ reader, provider: 'sample' }]);
  const action = (name: string, extra = {}) => connections.action({ action: name, connection_id: source.connection.connection_id, revision: connections.status().revision, ...extra });
  return { source, reader, connections, action };
}
const hasCode = (code: string) => (e: any) => e.code === code;

test('settings project a read-only repository and honest unavailable agent service without reading providers', async () => {
  const f = await fixture(), status = f.connections.status();
  assert.equal(status.format, 'strata-explorer-settings/1');
  assert.equal(status.connections[0].state, 'read-only');
  assert.equal(status.connections[0].capabilities.publish, false);
  assert.equal(status.agent.agent_chat, false); assert.equal(status.agent.protocol, null);
  assert.equal(f.source.calls, 1);
  assert.equal((await f.action('test')).connections[0].last_test?.outcome, 'passed');
  assert.equal(f.source.calls, 2);
});

test('disconnect clears generation; test stays disconnected; reconnect requires a new verified read', async () => {
  const f = await fixture();
  assert.equal((await f.action('disconnect')).connections[0].state, 'disconnected');
  assert.equal(f.reader.connection().ready, false);
  assert.throws(() => f.connections.reader(), hasCode('CONNECTION_DISCONNECTED'));
  const tested = await f.action('test');
  assert.equal(tested.connections[0].state, 'disconnected'); assert.equal(tested.connections[0].last_test?.outcome, 'passed');
  assert.equal(f.reader.connection().ready, false);
  assert.equal((await f.action('connect')).connections[0].state, 'read-only');
  assert.equal(f.source.calls, 3);
});

test('malformed settings, endpoints, credentials, foreign bindings and stale revisions fail before source reads', async () => {
  const f = await fixture();
  for (const input of [null, [], {}, { action: 'test', connection_id: 'unknown', revision: 0 }, { action: 'test', connection_id: f.source.connection.connection_id, revision: 0, endpoint: 'https://evil.invalid' }, { action: 'connect', connection_id: f.source.connection.connection_id, revision: 0, token: 'synthetic-secret' }, { action: 'publish', connection_id: f.source.connection.connection_id, revision: 0 }, { action: 'test', connection_id: f.source.connection.connection_id, revision: -1 }]) await assert.rejects(f.connections.action(input), hasCode('INVALID_INPUT'));
  await f.action('disconnect'); await assert.rejects(f.action('connect', { revision: 0 }), hasCode('CONNECTION_CHANGED'));
  const foreign = new TestSource(await sample()); foreign.connection.project_id = 'foreign';
  assert.throws(() => new ExplorerConnections([{ reader: f.reader, provider: 'sample' }, { reader: new ExplorerReader(foreign), provider: 'sample' }]), hasCode('SOURCE_BINDING'));
  assert.equal(f.source.calls, 1);
});

test('host catalog selection shares binding and never silently connects another reader', async () => {
  const f = await fixture(), source2 = new TestSource(await sample()); source2.connection.connection_id = 'sample-two';
  const second = new ExplorerReader(source2);
  const manager = new ExplorerConnections([{ reader: f.reader, provider: 'sample' }, { reader: second, provider: 'sample' }]);
  const status = await manager.action({ action: 'select', connection_id: 'sample-two', revision: 0 });
  assert.equal(status.selected_connection_id, 'sample-two');
  assert.equal(f.reader.connection().ready, false); assert.equal(source2.calls, 0);
  assert.equal(status.connections[1].state, 'disconnected');
  assert.equal((await manager.action({ action: 'connect', connection_id: 'sample-two', revision: 1 })).connections[1].state, 'read-only');
});

test('errors are redacted; denied source clears reads; network failures show stale and retry recovers', async () => {
  const f = await fixture();
  f.source.failure = new ExplorerError('SOURCE_UNAVAILABLE', 503, 'synthetic-secret provider body endpoint', true);
  let status = await f.action('test');
  assert.equal(status.connections[0].state, 'stale');
  assert.equal(status.connections[0].error?.retryable, true);
  assert.ok(!JSON.stringify(status).includes('synthetic-secret'));
  f.source.failure = new ExplorerError('SOURCE_AUTH', 403, 'synthetic-secret');
  status = await f.action('test'); assert.equal(status.connections[0].state, 'denied'); assert.equal(f.reader.connection().ready, false);
  f.source.failure = null; assert.equal((await f.action('test')).connections[0].state, 'read-only');
});

test('missing host credentials are metadata only and refuse credential/provider dispatch', async () => {
  const c = config(); let credentialCalls = 0, providerCalls = 0;
  const port = new RestArtifactsReader(c, async () => { credentialCalls++; return 'synthetic-secret'; }, async () => { providerCalls++; return new Response(); });
  const reader = new ExplorerReader(new RegistrySource(c, port));
  const manager = new ExplorerConnections([{ reader, provider: 'artifacts-rest', authenticationAvailable: () => false }]);
  assert.equal(manager.status().connections[0].authentication, 'missing');
  const status = await manager.action({ action: 'test', connection_id: c.connection_id, revision: 0 });
  assert.equal(status.connections[0].state, 'denied'); assert.equal(credentialCalls, 0); assert.equal(providerCalls, 0);
  assert.ok(!JSON.stringify(status).includes(c.auth_provider.variable)); assert.ok(!JSON.stringify(status).includes(c.registry_path));
});

test('whole-operation timeout is bounded and disconnect defeats an in-flight successful source read', async () => {
  const f = await fixture(), load = f.source.load.bind(f.source);
  let release!: () => void;
  f.source.load = async () => { await new Promise<void>(resolve => { release = resolve; }); return load(); };
  const pending = f.action('test');
  await assert.rejects(f.action('test'), hasCode('REFRESH_BUSY'));
  await f.action('disconnect'); release();
  await assert.rejects(pending, hasCode('CONNECTION_CHANGED'));
  assert.equal(f.reader.connection().ready, false);
  const manager = new ExplorerConnections([{ reader: f.reader, provider: 'sample' }], 20);
  const started = Date.now();
  const timeout = await manager.action({ action: 'test', connection_id: f.source.connection.connection_id, revision: 0 });
  assert.ok(Date.now() - started < 1000); assert.equal(timeout.connections[0].last_test?.outcome, 'failed');
  assert.equal(timeout.connections[0].error?.code, 'SOURCE_UNAVAILABLE');
  release(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.reader.connection().ready, false);
});

test('unavailable provider requires owner setup and never falls back to sample', async () => {
  const f = await fixture(), manager = new ExplorerConnections([{ reader: f.reader, provider: 'unavailable' }]);
  assert.equal(manager.status().connections[0].state, 'unavailable');
  await assert.rejects(manager.action({ action: 'connect', connection_id: f.source.connection.connection_id, revision: 0 }), hasCode('CONNECTION_NOT_READY'));
  assert.equal(f.source.calls, 1);
});

test('settings routes preserve session/origin/method/body allowlists and disconnect denies the old read routes', async () => {
  const f = await fixture(), host = await startExplorer(f.reader, { assets: path.resolve('explorer'), connections: f.connections });
  const auth = { authorization: 'Bearer ' + host.capability }, json = { ...auth, origin: host.origin, 'content-type': 'application/json' };
  try {
    for (const [suffix, init, status] of [
      ['', {}, 401], ['?endpoint=https://evil.invalid', { headers: auth }, 400],
      ['', { method: 'PUT', headers: auth }, 405], ['', { headers: { ...auth, origin: 'https://evil.invalid' } }, 403],
      ['', { method: 'POST', headers: auth, body: '{}' }, 403],
      ['', { method: 'POST', headers: json, body: 'invalid' }, 400],
      ['', { method: 'POST', headers: json, body: 'x'.repeat(1025) }, 413],
      ['', { method: 'POST', headers: json, body: JSON.stringify({ action: 'test', connection_id: f.source.connection.connection_id, revision: 0, credential: 'synthetic-secret' }) }, 400],
    ] as [string, RequestInit, number][]) assert.equal((await fetch(host.origin + '/explorer/v1/settings' + suffix, init)).status, status);
    const response = await fetch(host.origin + '/explorer/v1/settings', { headers: auth });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const dto = await response.text(); assert.ok(!dto.includes(host.capability)); assert.ok(!dto.includes('synthetic-secret'));
    const post = (action: string) => fetch(host.origin + '/explorer/v1/settings', { method: 'POST', headers: json, body: JSON.stringify({ action, connection_id: f.source.connection.connection_id, revision: f.connections.status().revision }) });
    assert.equal((await post('disconnect')).status, 200);
    assert.equal((await fetch(host.origin + '/explorer/v1/connection', { headers: auth })).status, 409);
    assert.equal((await fetch(host.origin + '/explorer/v1/refresh', { method: 'POST', headers: json, body: '{}' })).status, 409);
    assert.equal((await post('connect')).status, 200);
    assert.equal((await fetch(host.origin + '/explorer/v1/connection', { headers: auth })).status, 200);
    assert.equal(f.source.calls, 2);
  } finally { await host.close(); }
});

test('actual REST adapter uses only pinned GETs and retains the cumulative grant across reconnect', async () => {
  const c = config(), records = await sample(), index = registry(records, c);
  const files = new Map(Object.values(records).map(r => { const text = canonical(r.data); return [bytesDigest(text) + '.json', text]; }));
  let calls = 0;
  const port = new RestArtifactsReader(c, async () => 'synthetic-test-only-secret', async (url, init) => {
    calls++; assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'manual');
    const u = new URL(String(url)); assert.equal(u.hostname, 'api.cloudflare.com');
    if (u.pathname.endsWith('/file')) return new Response(files.get(u.searchParams.get('path')!)!);
    return Response.json({ success: true, result: { name: c.storage.repository, remote: `https://${c.storage.account}.artifacts.cloudflare.net/git/${c.storage.namespace}/${c.storage.repository}.git` } });
  });
  const source = new RegistrySource(c, port, async () => canonical(index));
  const manager = new ExplorerConnections([{ reader: new ExplorerReader(source), provider: 'artifacts-rest', authenticationAvailable: () => true }]);
  const action = (action: string) => manager.action({ action, connection_id: c.connection_id, revision: manager.status().revision });
  assert.equal((await action('test')).connections[0].state, 'read-only');
  const used = calls; c.read_authorization.max_requests = used;
  await action('disconnect'); const status = await action('connect');
  assert.equal(status.connections[0].error?.code, 'READ_SESSION_LIMIT'); assert.equal(calls, used);
  assert.equal(status.connections[0].capabilities.write, false);
});

test('ordinary refresh recovery clears a prior settings error and whole-test cancellation reaches the REST transport', async () => {
  const f = await fixture(); f.source.failure = new ExplorerError('SOURCE_UNAVAILABLE', 503, 'synthetic-secret');
  const failed = await f.action('test'); assert.equal(failed.connections[0].capabilities.read, true);
  f.source.failure = null; await f.reader.refresh();
  assert.equal(f.connections.status().connections[0].error, null);
  const c = config(), index = registry(await sample(), c); let calls = 0, aborted = false;
  const port = new RestArtifactsReader(c, async () => 'synthetic-secret', async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic-secret')); }, { once: true }); });
  });
  const manager = new ExplorerConnections([{ reader: new ExplorerReader(new RegistrySource(c, port, async () => canonical(index))), provider: 'artifacts-rest' }], 20);
  const status = await manager.action({ action: 'test', connection_id: c.connection_id, revision: 0 });
  assert.equal(status.connections[0].error?.code, 'SOURCE_UNAVAILABLE');
  assert.equal(aborted, true); assert.equal(calls, 1); assert.ok(!JSON.stringify(status).includes('synthetic-secret'));
});

test('a concurrent ordinary refresh refuses settings verification without changing its revision or outcome', async () => {
  const f = await fixture(), load = f.source.load.bind(f.source); let release!: () => void;
  f.source.load = async () => { await new Promise<void>(resolve => { release = resolve; }); return load(); };
  const refresh = f.reader.refresh();
  await assert.rejects(f.action('test'), hasCode('REFRESH_BUSY'));
  assert.equal(f.connections.status().revision, 0); assert.equal(f.connections.status().connections[0].last_test, null);
  release(); await refresh; assert.equal(f.connections.status().connections[0].state, 'read-only');
});
