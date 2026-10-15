import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentFixture, deferred, errorCode } from './studio-agent-connection-fixture.js';
import { agentSettingsFixture } from './studio-agent-settings-fixture.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { createPersistentAgentHost } from '../src/explorer/persistent-agent-host.js';

async function durableFixture() {
  const f = await agentFixture();
  f.setSource({ ...f.source()!, valid_until: null });
  f.setApproval({ ...f.approval()!, target: { ...f.approval()!.target, valid_until: null } });
  return f;
}
function processStatus(f: Awaited<ReturnType<typeof agentFixture>>, mode = 'status', request?: unknown) {
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', fileURLToPath(new URL('../../tests/studio-agent-connection-process.mjs', import.meta.url))], {
    input: JSON.stringify({ mode, request, directory: f.stateDirectory, scope: f.scope, owner: f.owner(), source: f.source(), approval: f.approval(), metadata: f.metadata() }),
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(child.stderr, ''); assert.equal(child.signal, null);
  return { exit: child.status, ...JSON.parse(child.stdout) };
}

test('durable consent and enabled intent survive actual process restart; historical discovery is not health', async () => {
  const f = await durableFixture(); await f.action('configure'); const connected = await f.action('connect');
  assert.equal(connected.integration.state, 'approved'); assert.equal(connected.integration.consent, 'until-revoked');
  assert.equal(connected.integration.enabled, true); assert.equal(connected.health.state, 'connected');
  const bytes = await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8');
  const restarted = processStatus(f);
  assert.equal(restarted.exit, 0); assert.deepEqual(restarted.status.integration, connected.integration);
  assert.equal(restarted.status.health.state, 'disconnected'); assert.equal(restarted.status.connection.current_discovery, null);
  assert.equal(restarted.status.connection.last_test.outcome, 'passed'); assert.deepEqual(restarted.counts, { contextLoads: 0, dispatches: 0 });
  assert.equal(await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'), bytes);
  f.setOwner({ fresh: false });
  const retry = await f.make().action(f.authority, await f.input('retry'));
  assert.equal(retry.health.state, 'connected'); assert.equal(retry.integration.approved_at, connected.integration.approved_at);
  assert.deepEqual(retry.effective, { authoring: false, execution: false, chat: false });
});

test('session expiry blocks secrets and dispatch without revoking consent or inventing renewal', async () => {
  const f = await durableFixture(); await f.action('configure'); await f.action('connect'); f.advance(3_600_001);
  const before = f.counts(), status = await f.make().status(f.authority);
  assert.equal(status.integration.state, 'approved'); assert.equal(status.integration.enabled, true);
  assert.equal(status.health.state, 'unavailable'); assert.equal(status.service_session.state, 'expired');
  assert.equal(status.service_session.renewal, 'unsupported');
  await assert.rejects(f.make().action(f.authority, await f.input('retry')), errorCode('AGENT_SESSION_EXPIRED'));
  assert.deepEqual(f.counts(), before);
  // Fixture changes public metadata, representing a separately authenticated
  // provider renewal. Studio does not manufacture or dispatch such a renewal.
  f.setMetadata({ generation: 'synthetic-auth-renewed', valid_until: f.iso(3_600_000) });
  const retried = await f.make().action(f.authority, await f.input('retry'));
  assert.equal(retried.integration.state, 'approved'); assert.equal(retried.health.state, 'connected');
});

test('pause retains consent; retry reports sanitized provider errors and can recover without setup', async () => {
  const f = await durableFixture(); await f.action('configure'); await f.action('connect');
  const paused = await f.action('disconnect'); assert.equal(paused.integration.state, 'approved'); assert.equal(paused.integration.enabled, false);
  f.fail(new Error('PRIVATE_PROVIDER_SECRET_MUST_NOT_APPEAR'));
  const failed = await f.action('retry'); assert.equal(failed.integration.enabled, true);
  assert.equal(failed.health.state, 'unavailable'); assert.equal(failed.health.code, 'AGENT_UNAVAILABLE');
  assert.equal(failed.capabilities.retry, true); assert.equal(JSON.stringify(failed).includes('PRIVATE_PROVIDER'), false);
  assert.equal((await f.state()).connection?.authorization?.state, 'approved');
  f.fail(undefined); assert.equal((await f.action('retry')).health.state, 'connected');
});

test('revocation survives process restart and denies new dispatch and old successful replay', async () => {
  const f = await durableFixture(); await f.action('configure'); const request = await f.input('connect');
  await f.manager.action(f.authority, request); const revoke = await f.action('revoke');
  assert.equal(revoke.integration.state, 'revoked'); assert.equal(revoke.integration.enabled, false);
  assert.equal(revoke.health.state, 'revoked'); assert.ok(revoke.integration.revoked_at);
  const restarted = processStatus(f); assert.equal(restarted.status.integration.state, 'revoked'); assert.equal(restarted.counts.dispatches, 0);
  for (const action of ['retry', 'connect', 'test']) await assert.rejects(f.make().action(f.authority, await f.input(action)), errorCode('AGENT_REVOKED'));
  await assert.rejects(f.manager.action(f.authority, request), errorCode('AGENT_REVOKED'));
  assert.equal((await f.manager.outcome(f.authority, request.request_id)).state, 'completed'); assert.equal(f.counts().dispatches, 1);
  assert.equal((await f.state()).probe_times.length, 1);
  f.setOwner({ fresh: false }); await assert.rejects(f.action('configure'), errorCode('OWNER_REAUTH_REQUIRED'));
  f.setOwner({ fresh: true }); await f.action('configure'); assert.equal((await f.action('retry')).health.state, 'connected');
});

test('revocation while headers wait aborts before network; service completion cannot restore revoked health', async () => {
  for (const stage of ['headers', 'network']) {
    const f = await durableFixture(); await f.action('configure'); const gate = deferred();
    if (stage === 'headers') f.headerDelay(gate.promise); else f.delay(gate.promise);
    const waiting = f.action('connect');
    if (stage === 'headers') { while (!f.counts().headers) await new Promise(resolve => setTimeout(resolve, 2)); }
    else await f.started.promise;
    await f.action('revoke'); gate.resolve(); await waiting;
    const status = await f.make().status(f.authority); assert.equal(status.integration.state, 'revoked'); assert.equal(status.connection?.runtime_ready, false);
    assert.equal(f.counts().dispatches, stage === 'headers' ? 0 : 1);
  }
});

test('consent binds exact service and target; finite approvals cannot become durable implicitly', async () => {
  for (const key of ['url', 'service_id', 'instance_id', 'expected_subject'] as const) {
    const f = await durableFixture(); await f.action('configure'); const approval = f.approval()!;
    approval.target[key] = key === 'url' ? 'https://other.example.test/discovery' : 'other'; f.setApproval(approval);
    await assert.rejects(f.action('retry'), errorCode('AGENT_APPROVAL_REQUIRED')); assert.equal(f.counts().contextLoads, 0);
  }
  const f = await agentFixture(); await f.action('configure'); const old = f.approval()!;
  old.target.valid_until = f.iso(-1); f.setApproval(old);
  await assert.rejects(f.action('retry'), errorCode('AGENT_EXPIRED')); assert.equal(f.counts().dispatches, 0);
  assert.equal((await f.make().status(f.authority)).integration.state, 'approved');
});

test('legacy state needs fresh explicit consent; missing state never reconstructs revoked integration', async () => {
  const f = await durableFixture(); await f.action('configure'); const legacy = await f.state();
  delete legacy.connection!.authorization; await writePrivate(path.join(f.stateDirectory, 'state.json'), legacy);
  assert.equal((await f.make().status(f.authority)).integration.state, 'legacy');
  assert.equal((await f.make().status(f.authority)).capabilities.connect, false);
  for (const action of ['test', 'connect']) await assert.rejects(f.action(action), errorCode('AGENT_APPROVAL_REQUIRED'));
  await assert.rejects(f.action('retry'), errorCode('AGENT_APPROVAL_REQUIRED'));
  await f.action('configure'); await f.action('revoke'); await unlink(path.join(f.stateDirectory, 'state.json'));
  await assert.rejects(f.make().status(f.authority), errorCode('AGENT_STATE_UNAVAILABLE'));
});

test('legacy finite configuration cannot inherit a newly durable source or target policy', async () => {
  for (const kind of ['source', 'target']) {
    const f = await agentFixture(); await f.action('configure'); const state = await f.state();
    delete state.connection!.authorization; await writePrivate(path.join(f.stateDirectory, 'state.json'), state);
    if (kind === 'source') f.setSource({ ...f.source()!, valid_until: null });
    else f.setApproval({ ...f.approval()!, target: { ...f.approval()!.target, valid_until: null } });
    for (const action of ['test', 'connect']) await assert.rejects(f.action(action), errorCode('AGENT_APPROVAL_REQUIRED'));
    assert.equal(f.counts().contextLoads, 0); assert.equal(f.counts().dispatches, 0);
    await f.action('configure'); assert.equal((await f.action('retry')).health.state, 'connected');
  }
});

test('legacy finite configuration retains bounded probes without acquiring persistent consent', async () => {
  const f = await agentFixture(); await f.action('configure'); const state = await f.state();
  delete state.connection!.authorization; await writePrivate(path.join(f.stateDirectory, 'state.json'), state);
  const result = await f.action('connect'); assert.equal(result.health.state, 'connected');
  assert.equal(result.integration.state, 'legacy'); assert.equal(result.integration.consent, null);
  assert.equal((await f.state()).connection?.authorization, undefined);
  f.advance(3_600_001); await assert.rejects(f.action('connect'), errorCode('AGENT_EXPIRED'));
  assert.equal(f.counts().dispatches, 1);
});

test('full normal history retains a terminal revocation slot and every prior receipt', async () => {
  const f = await durableFixture(); await f.action('configure'); const state = await f.state();
  const template = state.operations[0];
  while (state.operations.length < 256) state.operations.push({ ...template, request_id: randomUUID(), action: 'disconnect', proof: null });
  const ids = state.operations.map(o => o.request_id);
  await writePrivate(path.join(f.stateDirectory, 'state.json'), state);
  await assert.rejects(f.action('retry'), errorCode('AGENT_CAPACITY'));
  const revoked = await f.action('revoke'); assert.equal(revoked.integration.state, 'revoked');
  assert.deepEqual((await f.state()).operations.slice(0, 256).map(o => o.request_id), ids);
  assert.equal((await f.state()).operations.length, 257); assert.equal(f.counts().dispatches, 0);
});

test('owner HTTP logout/login retains consent, revocation requires fresh owner and valid CSRF', async () => {
  const f = await agentSettingsFixture();
  try {
    let session = await f.login();
    const action = async (name: string, csrf = session.csrf) => {
      const status = await f.status(); return f.b.send('/studio/v1/owner/agents', 'POST', { action: name, revision: status.data.revision, request_id: randomUUID(), ...(name === 'configure' ? { target_profile_id: 'synthetic' } : {}) }, csrf);
    };
    assert.equal((await action('configure')).status, 200); assert.equal((await action('connect')).status, 200);
    await f.b.send('/studio/owner/logout', 'POST', {}, session.csrf); assert.equal((await f.status()).status, 401);
    session = await f.login(); const status = await f.status();
    assert.equal(status.data.integration.state, 'approved'); assert.equal(status.data.integration.enabled, true);
    assert.equal(status.data.connection.runtime_ready, false); assert.equal(f.agent.counts().dispatches, 1);
    assert.equal((await action('revoke', 'invalid-csrf')).status, 403);
    assert.equal((await action('revoke')).data.integration.state, 'revoked');
    const revoked = await f.status(); assert.equal(revoked.data.health.state, 'revoked'); assert.equal(revoked.data.capabilities.configure, true);
    assert.equal((await action('retry')).data.error.code, 'AGENT_REVOKED'); assert.equal(f.agent.counts().dispatches, 1);
  } finally { await f.server.close(); }
});

test('trusted host composition validates existing owner/scope/state and remains unavailable without service ports', async () => {
  const f = await agentSettingsFixture();
  try {
    const options = { directory: f.agent.stateDirectory, scope: f.agentStore.scope, ownerState: f.bootstrapState, source: f.agent.sourcePort, profileIds: ['synthetic'], protectedPaths: [], now: () => Date.parse(f.agent.iso()) };
    const bridge = await createPersistentAgentHost(options);
    const session = await f.login();
    const authority = { current: async () => ({ installation_id: options.scope.installation_id, owner_id: options.scope.owner_id, authentication_generation: session.authentication_generation, fresh: true }) };
    const status = await bridge.settings.status(authority); assert.equal(status.capabilities.connect, false);
    assert.equal(f.agent.counts().contextLoads, 0); bridge.dispose();
    await assert.rejects(createPersistentAgentHost({ ...options, scope: { ...options.scope, owner_id: randomUUID() } }), errorCode('AGENT_STATE_UNAVAILABLE'));
    await assert.rejects(createPersistentAgentHost({ ...options, protectedPaths: [options.directory] }), errorCode('AGENT_STATE_UNAVAILABLE'));
  } finally { await f.server.close(); }
});
