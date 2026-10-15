import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, unlink, writeFile, chmod, symlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentDiscoveryError } from '../src/agent-discovery.js';
import { AgentConnections, unconfiguredAgentOwner } from '../src/explorer/agent-connection.js';
import { AgentConnectionStore, agentStateSchema, initialAgentState } from '../src/explorer/agent-connection-store.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { digest } from '../src/model.js';
import { agentFixture, deferred, errorCode } from './studio-agent-connection-fixture.js';

function subprocess(f: Awaited<ReturnType<typeof agentFixture>>, mode: string, request?: unknown) {
  const worker = fileURLToPath(new URL('../../tests/studio-agent-connection-process.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--unhandled-rejections=strict', worker], { stdio: ['pipe', 'pipe', 'pipe'] });
  const first = deferred<any>(); let output = '', errors = '';
  child.stdout.on('data', data => { output += String(data); if (output.includes('\n')) first.resolve(JSON.parse(output.split('\n')[0])); });
  child.stderr.on('data', data => { errors += String(data); });
  const done = new Promise<{ code: number | null; signal: string | null; lines: any[] }>((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => {
      if (errors) reject(new Error(errors)); else resolve({ code, signal, lines: output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) });
    });
  });
  child.stdin.end(JSON.stringify({ mode, request, directory: f.stateDirectory, scope: f.scope, owner: f.owner(), source: f.source(), approval: f.approval(), metadata: f.metadata() }));
  return { child, first: first.promise, done };
}

test('default denies target/auth/source and creates no state or authority', async () => {
  const f = await agentFixture(), manager = new AgentConnections(f.store);
  await assert.rejects(manager.status(unconfiguredAgentOwner), errorCode('OWNER_SESSION_REQUIRED'));
  const status = await manager.status(f.authority); assert.equal(status.management.state, 'unconfigured'); assert.equal(status.capabilities.configure, false);
  await assert.rejects(manager.action(f.authority, await f.input('configure')), errorCode('AGENT_SOURCE_UNCONFIGURED'));
  const sourceOnly = new AgentConnections(f.store, { source: f.sourcePort });
  await assert.rejects(sourceOnly.action(f.authority, await f.input('configure')), errorCode('AGENT_TARGET_UNCONFIGURED'));
  const noAuth = new AgentConnections(f.store, { source: f.sourcePort, targets: f.targets });
  await noAuth.action(f.authority, await f.input('configure'));
  await assert.rejects(noAuth.action(f.authority, await f.input('test')), errorCode('AGENT_AUTH_UNCONFIGURED'));
  assert.deepEqual(f.counts(), { contextLoads: 0, headers: 0, verifications: 0, dispatches: 0 });
});

test('configure/status/outcome/disconnect/remove/replay are local; strict input and stale CAS refuse', async () => {
  const f = await agentFixture(), request = await f.input('configure');
  const configured = await f.manager.action(f.authority, request); assert.equal(configured.connection?.state, 'disconnected');
  assert.equal((await f.manager.action(f.authority, request)).replayed, true); assert.equal((await f.manager.outcome(f.authority, request.request_id)).state, 'completed');
  await assert.rejects(f.manager.action(f.authority, { ...request, target_profile_id: 'other' }), errorCode('REQUEST_CONFLICT'));
  await assert.rejects(f.action('configure', { url: 'https://unapproved.example.test' }), errorCode('INVALID_INPUT'));
  await assert.rejects(f.action('configure', { target_profile_id: 'x'.repeat(257) }), errorCode('INVALID_INPUT'));
  await assert.rejects(f.action('disconnect', { revision: 0 }), errorCode('AGENT_CHANGED'));
  await f.action('disconnect'); await f.action('remove'); assert.equal((await f.state()).operations.length, 3); assert.equal((await f.manager.status(f.authority)).connection, null);
  assert.deepEqual(f.counts(), { contextLoads: 0, headers: 0, verifications: 0, dispatches: 0 });
});

test('test stays disconnected; connect exposes bounded verified discovery only; restart disconnects without replay', async () => {
  const f = await agentFixture(); await f.action('configure'); const tested = await f.action('test');
  assert.equal(tested.connection?.runtime_ready, false); assert.equal(tested.connection?.last_test?.outcome, 'passed');
  assert.equal(tested.connection?.current_discovery, null); assert.equal(f.counts().dispatches, 1);
  const request = await f.input('connect'), connected = await f.manager.action(f.authority, request);
  assert.equal(connected.connection?.state, 'connected-discovery'); assert.equal(connected.connection?.runtime_ready, true);
  assert.deepEqual(connected.engine_authority, { state: 'unconfigured', operations: [] }); assert.deepEqual(connected.effective, { authoring: false, execution: false, chat: false });
  assert.equal((await f.manager.action(f.authority, request)).replayed, true); assert.equal(f.counts().dispatches, 2);
  const restarted = f.make(); assert.equal((await restarted.status(f.authority)).connection?.state, 'disconnected'); assert.equal((await restarted.status(f.authority)).connection?.last_test?.outcome, 'passed');
  assert.equal((await restarted.action(f.authority, request)).replayed, true); assert.equal((await restarted.status(f.authority)).connection?.runtime_ready, false); assert.equal(f.counts().dispatches, 2);
  const persisted = await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'); assert.ok(!persisted.includes('public-fixture-only')); assert.ok(!persisted.includes('https://')); assert.ok(!JSON.stringify(connected).includes(f.directory));
});

test('owner identity/freshness/generation are current before dispatch and before completed replay', async () => {
  const f = await agentFixture(), request = await f.input('configure'); f.setOwner({ fresh: false });
  await assert.rejects(f.manager.action(f.authority, request), errorCode('OWNER_REAUTH_REQUIRED'));
  f.setOwner({ fresh: true, owner_id: randomUUID() }); await assert.rejects(f.manager.action(f.authority, request), errorCode('OWNER_SESSION_REQUIRED'));
  f.setOwner({ owner_id: f.scope.owner_id }); await f.manager.action(f.authority, request); await f.action('connect');
  f.setOwner({ authentication_generation: 2 }); await assert.rejects(f.manager.action(f.authority, request), errorCode('OWNER_SESSION_REQUIRED'));
  assert.equal((await f.manager.status(f.authority)).connection?.runtime_ready, false); assert.equal(f.counts().dispatches, 1);
});

test('unapproved profile, changed binding/target/declaration and absent/expired auth refuse before secret/transport', async () => {
  for (const mutation of ['profile', 'binding', 'target', 'declaration', 'expired-target', 'auth', 'expired-auth']) {
    const f = await agentFixture(); await f.action('configure'); const approval = f.approval()!;
    if (mutation === 'profile') approval.target.profile_id = 'different';
    if (mutation === 'binding') approval.target.binding.repository_id = 'different';
    if (mutation === 'target') approval.target.url += '?unapproved=1';
    if (mutation === 'declaration') approval.target.declaration_sha256 = '0'.repeat(64);
    if (mutation === 'expired-target') approval.target.valid_until = f.iso(-1);
    f.setApproval(approval);
    if (mutation === 'auth') f.setMetadata(undefined);
    if (mutation === 'expired-auth') f.setMetadata({ generation: 'auth-1', valid_until: f.iso(-1) });
    await assert.rejects(f.action('connect')); assert.equal(f.counts().contextLoads, 0, mutation); assert.equal(f.counts().dispatches, 0, mutation);
  }
});

test('active owner with source/target/auth revoked cannot see current cached discovery or replay', async () => {
  for (const kind of ['source', 'target', 'auth']) {
    const f = await agentFixture(); await f.action('configure'); const request = await f.input('connect'); await f.manager.action(f.authority, request);
    if (kind === 'source') f.setSource(undefined); if (kind === 'target') f.setApproval(undefined); if (kind === 'auth') f.setMetadata(undefined);
    const status = await f.manager.status(f.authority); assert.equal(status.connection?.runtime_ready, false, kind); assert.equal(status.connection?.current_discovery, null);
    await assert.rejects(f.manager.action(f.authority, request)); assert.equal(f.counts().dispatches, 1);
  }
});

test('source/approval/auth generation changes and expiry invalidate readiness and require explicit new connect', async () => {
  for (const kind of ['source', 'target', 'auth', 'expiry']) {
    const f = await agentFixture(); await f.action('configure'); await f.action('connect');
    if (kind === 'source') f.setSource({ ...f.source()!, epoch: 2 });
    if (kind === 'target') f.setApproval({ ...f.approval()!, generation: 'approved-2' });
    if (kind === 'auth') f.setMetadata({ ...f.metadata()!, generation: 'auth-2' });
    if (kind === 'expiry') f.advance(60_001);
    assert.equal((await f.manager.status(f.authority)).connection?.runtime_ready, false, kind); assert.equal(f.counts().dispatches, 1);
    assert.equal((await f.manager.status(f.authority)).connection?.runtime_ready, false); await f.action('connect'); assert.equal(f.counts().dispatches, 2);
  }
});

test('disconnect/remove cancel local wait while the state lease is released; late response never reconnects', async () => {
  for (const action of ['disconnect', 'remove']) {
    const f = await agentFixture(); await f.action('configure'); const gate = deferred(); f.delay(gate.promise); const request = await f.input('connect');
    const running = f.manager.action(f.authority, request); await f.started.promise;
    const local = await f.action(action); assert.equal(local.connection?.runtime_ready ?? false, false); gate.resolve();
    const result = await running; assert.equal(result.outcome.state, 'failed'); assert.equal(result.outcome.code, 'AGENT_CHANGED'); assert.equal(result.connection?.runtime_ready ?? false, false); assert.equal(f.counts().dispatches, 1);
    assert.equal((await f.manager.action(f.authority, request)).replayed, true);
  }
});

test('selection/auth/approval revocation during an uncooperative probe cannot install late discovery', async () => {
  for (const kind of ['source', 'auth', 'target']) {
    const f = await agentFixture(); await f.action('configure'); const gate = deferred(); f.delay(gate.promise); const running = f.action('connect'); await f.started.promise;
    if (kind === 'source') f.setSource(undefined); if (kind === 'target') f.setApproval(undefined); if (kind === 'auth') f.setMetadata(undefined);
    gate.resolve(); const result = await running; assert.equal(result.outcome.state, 'failed'); assert.equal(result.connection?.runtime_ready, false); assert.equal(result.connection?.current_discovery, null);
  }
});

test('owner rotation during a probe preserves an interrupted receipt and never grants the new generation a replay', async () => {
  const f = await agentFixture(); await f.action('configure'); const gate = deferred(); f.delay(gate.promise); const request = await f.input('connect');
  const running = f.manager.action(f.authority, request); await f.started.promise; f.setOwner({ authentication_generation: 2 }); gate.resolve();
  await assert.rejects(running, errorCode('OWNER_SESSION_REQUIRED')); assert.equal((await f.state()).operations.at(-1)?.result, null);
  const restarted = f.make(); assert.equal((await restarted.outcome(f.authority, request.request_id)).state, 'interrupted'); await assert.rejects(restarted.action(f.authority, request), errorCode('OWNER_SESSION_REQUIRED'));
  assert.equal((await restarted.status(f.authority)).connection?.runtime_ready, false); assert.equal(f.counts().dispatches, 1);
});

test('pre-cancel and cancellation during credential loading/header preparation dispatch zero requests', async () => {
  for (const stage of ['pre', 'context', 'headers']) {
    const f = await agentFixture(); await f.action('configure'); const controller = new AbortController(), gate = deferred();
    if (stage === 'pre') controller.abort(); if (stage === 'context') f.contextDelay(gate.promise); if (stage === 'headers') f.headerDelay(gate.promise);
    const running = f.manager.action(f.authority, await f.input('connect'), controller.signal);
    if (stage !== 'pre') { while ((stage === 'context' ? f.counts().contextLoads : f.counts().headers) === 0) await new Promise(r => setTimeout(r, 2)); controller.abort(); }
    const result = await running; gate.resolve(); assert.equal(result.outcome.code, 'AGENT_CANCELLED'); assert.equal(f.counts().dispatches, 0);
  }
});

test('revocation while authentication headers wait refuses before provider dispatch', async () => {
  const f = await agentFixture(); await f.action('configure'); const gate = deferred(); f.headerDelay(gate.promise); const running = f.action('connect');
  while (!f.counts().headers) await new Promise(r => setTimeout(r, 2)); f.setMetadata(undefined); gate.resolve();
  const result = await running; assert.equal(result.outcome.code, 'AGENT_AUTH_UNCONFIGURED'); assert.equal(f.counts().dispatches, 0);
});

test('one in flight, CAS races and exact pending retry have no duplicate probe; rate survives restart/remove', async () => {
  const f = await agentFixture(); await f.action('configure'); const gate = deferred(); f.delay(gate.promise); const request = await f.input('connect');
  const running = f.manager.action(f.authority, request); await f.started.promise;
  await assert.rejects(f.manager.action(f.authority, request), errorCode('AGENT_RECOVERY_REQUIRED'));
  await assert.rejects(f.action('test'), errorCode('AGENT_BUSY')); assert.equal((await f.manager.outcome(f.authority, request.request_id)).state, 'pending'); gate.resolve(); await running;
  f.delay(undefined); for (let i = 0; i < 4; i++) await f.action('test');
  const saved = await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'); await assert.rejects(f.action('test'), errorCode('AGENT_RATE_LIMIT')); assert.equal(await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'), saved);
  await f.action('remove'); await f.action('configure'); await assert.rejects(f.make().action(f.authority, await f.input('connect')), errorCode('AGENT_RATE_LIMIT')); assert.equal(f.counts().dispatches, 5);
  f.advance(60_001); await f.action('connect'); assert.equal(f.counts().dispatches, 6);
  const race = await f.input('disconnect'); const results = await Promise.allSettled([f.manager.action(f.authority, race), f.manager.action(f.authority, { ...race, request_id: randomUUID() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'AGENT_CHANGED');
});

test('provider/protocol/auth failures are sanitized, durable and replayed without dispatch or authority', async () => {
  for (const kind of ['raw', 'known', 'redirect', 'oversize', 'malformed', 'unknown', 'wrong-binding', 'wrong-identity', 'stale', 'too-long']) {
    const f = await agentFixture(); await f.action('configure');
    if (kind === 'raw') f.fail(new Error('PRIVATE_PROVIDER_TOKEN_DO_NOT_ECHO'));
    if (kind === 'known') f.fail(Object.assign(new AgentDiscoveryError('AGENT_AUTH'), { message: 'PRIVATE_PROVIDER_TOKEN_DO_NOT_ECHO' }));
    if (kind === 'redirect') f.response(() => new Response(null, { status: 302, headers: { location: 'https://unapproved.example.test' } }));
    if (kind === 'oversize') f.response(() => new Response('x'.repeat(32_769), { headers: { 'content-type': 'application/json' } }));
    if (kind === 'malformed') f.response(() => new Response('not-json', { headers: { 'content-type': 'application/json' } }));
    if (kind === 'unknown') f.response(m => Response.json({ ...m, extra: 'private-provider-field' }));
    if (kind === 'wrong-binding') f.response(m => Response.json({ ...m, binding: { ...m.binding, repository_id: 'different' } }));
    if (kind === 'wrong-identity') f.identity({ subject: 'self-asserted-foreign', expires_at: f.iso(60_000) });
    if (kind === 'stale') f.response(m => Response.json({ ...m, valid_until: f.iso(-1) }));
    if (kind === 'too-long') f.response(m => Response.json({ ...m, valid_until: f.iso(300_001) }));
    const request = await f.input('test'), result = await f.manager.action(f.authority, request); assert.equal(result.outcome.state, 'failed', kind); assert.equal(result.connection?.runtime_ready, false);
    assert.equal((await f.manager.action(f.authority, request)).replayed, true); assert.equal(f.counts().dispatches, 1);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER')); assert.ok(!(await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8')).includes('PRIVATE_PROVIDER'));
  }
});

test('failed initial/final state writes never install readiness or automatically dispatch after restart', async () => {
  for (const phase of ['initial', 'final']) {
    const f = await agentFixture(); await f.action('configure'); const transaction = f.store.transaction.bind(f.store);
    f.store.transaction = (operation) => transaction((state, save) => operation(state, async () => {
      if (state.operations.at(-1)?.action === 'connect' && (phase === 'initial' ? !state.operations.at(-1)?.result : !!state.operations.at(-1)?.result)) throw new Error('PRIVATE_DISK_FAILURE');
      await save();
    }));
    const request = await f.input('connect'); await assert.rejects(f.manager.action(f.authority, request), errorCode('AGENT_STATE_UNAVAILABLE'));
    assert.equal(f.counts().dispatches, phase === 'initial' ? 0 : 1); assert.equal((await f.manager.status(f.authority)).connection?.runtime_ready, false);
    f.store.transaction = transaction;
    if (phase === 'final') { const restart = f.make(); assert.equal((await restart.outcome(f.authority, request.request_id)).state, 'interrupted'); await assert.rejects(restart.action(f.authority, await f.input('connect')), errorCode('AGENT_RECOVERY_REQUIRED')); }
  }
});

test('invalidation while final fsync/save waits and during final status authorization refuses readiness', async () => {
  const f = await agentFixture(); await f.action('configure'); const gate = deferred(), reached = deferred(), transaction = f.store.transaction.bind(f.store);
  f.store.transaction = operation => transaction((state, save) => operation(state, async () => {
    if (state.operations.at(-1)?.action === 'connect' && state.operations.at(-1)?.result) { reached.resolve(); await gate.promise; }
    await save();
  }));
  const running = f.action('connect'); await reached.promise; f.manager.changed(); gate.resolve(); await running; assert.equal((await f.manager.status(f.authority)).connection?.runtime_ready, false);
  f.store.transaction = transaction; await f.action('connect'); const current = f.authority.current; let calls = 0;
  f.authority.current = async fresh => { if (++calls === 4) f.manager.changed(); return current(fresh); };
  const result = await f.manager.status(f.authority); assert.ok(calls >= 4); assert.equal(result.connection?.runtime_ready, false); assert.equal(result.connection?.current_discovery, null);
});

test('invalidation during the initial pending save is retained before authentication or dispatch starts', async () => {
  const f = await agentFixture(); await f.action('configure'); const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = operation => transaction((state, save) => operation(state, async () => {
    await save(); if (state.operations.at(-1)?.action === 'connect' && !state.operations.at(-1)?.result) f.manager.changed();
  }));
  const result = await f.action('connect'); assert.equal(result.outcome.code, 'AGENT_CHANGED'); assert.equal(result.connection?.runtime_ready, false);
  assert.equal(f.counts().contextLoads, 0); assert.equal(f.counts().dispatches, 0);
});

test('expiry during final asynchronous status authorization refuses current discovery', async () => {
  const f = await agentFixture(); await f.action('configure'); await f.action('connect'); const current = f.authority.current; let calls = 0;
  f.authority.current = async fresh => { if (++calls === 4) f.advance(60_001); return current(fresh); };
  const status = await f.manager.status(f.authority); assert.equal(status.connection?.runtime_ready, false); assert.equal(status.connection?.current_discovery, null); assert.equal(status.connection?.error?.code, 'AGENT_EXPIRED'); assert.equal(f.counts().dispatches, 1);
});

test('committed-but-reported-failed preparation/finalization preserves durable identity without reset or duplicate dispatch', async () => {
  for (const phase of ['initial', 'final']) {
    const f = await agentFixture(); await f.action('configure'); const transaction = f.store.transaction.bind(f.store);
    f.store.transaction = operation => transaction((state, save) => operation(state, async () => {
      await save();
      if (state.operations.at(-1)?.action === 'connect' && (phase === 'initial' ? !state.operations.at(-1)?.result : !!state.operations.at(-1)?.result)) throw new Error('PRIVATE_AMBIGUOUS_WRITE');
    }));
    const request = await f.input('connect'); await assert.rejects(f.manager.action(f.authority, request), errorCode('AGENT_STATE_UNAVAILABLE')); f.store.transaction = transaction;
    const restart = f.make(), outcome = await restart.outcome(f.authority, request.request_id);
    assert.equal(outcome.state, phase === 'initial' ? 'interrupted' : 'completed'); assert.equal((await restart.status(f.authority)).connection?.runtime_ready, false);
    if (phase === 'initial') await assert.rejects(restart.action(f.authority, request), errorCode('AGENT_RECOVERY_REQUIRED'));
    else assert.equal((await restart.action(f.authority, request)).replayed, true);
    assert.equal(f.counts().dispatches, phase === 'initial' ? 0 : 1); assert.equal((await f.state()).probe_times.length, 1);
  }
});

test('auth/source/target revocation while final durable save waits cannot install usable cache', async () => {
  for (const kind of ['source', 'auth', 'target']) {
    const f = await agentFixture(); await f.action('configure'); const gate = deferred(), reached = deferred(), transaction = f.store.transaction.bind(f.store);
    f.store.transaction = operation => transaction((state, save) => operation(state, async () => {
      if (state.operations.at(-1)?.action === 'connect' && state.operations.at(-1)?.result) { reached.resolve(); await gate.promise; }
      await save();
    }));
    const request = await f.input('connect'), running = f.manager.action(f.authority, request); await reached.promise;
    if (kind === 'source') f.setSource(undefined); if (kind === 'auth') f.setMetadata(undefined); if (kind === 'target') f.setApproval(undefined); gate.resolve(); await assert.rejects(running);
    const status = await f.manager.status(f.authority); assert.equal(status.connection?.runtime_ready, false, kind); assert.equal(status.connection?.current_discovery, null); assert.equal(f.counts().dispatches, 1);
    // The old verified exchange really completed before revocation; its saved
    // receipt remains historical and cannot authorize replay/readiness now.
    assert.equal((await f.manager.outcome(f.authority, request.request_id)).state, 'completed'); await assert.rejects(f.manager.action(f.authority, request));
  }
});

test('missing/genesis/malformed/binding/duplicate/leased state is never recreated; canonical paths are required', async () => {
  for (const kind of ['missing', 'genesis', 'malformed', 'binding', 'duplicate', 'lease']) {
    const f = await agentFixture(); await f.action('configure'); const file = path.join(f.stateDirectory, 'state.json');
    if (kind === 'missing') await unlink(file);
    if (kind === 'genesis') await unlink(path.join(f.stateDirectory, 'genesis.json'));
    if (kind === 'malformed') await writeFile(file, '{invalid', { mode: 0o600 });
    if (kind === 'binding') { const s = await f.state(); s.scope.owner_id = randomUUID(); await writePrivate(file, s); }
    if (kind === 'duplicate') { const s = await f.state(); s.operations.push(s.operations[0]); await writePrivate(file, s); }
    if (kind === 'lease') await writeFile(path.join(f.stateDirectory, '.owner.lock'), 'stale-interrupted-lease', { mode: 0o600 });
    await assert.rejects(f.manager.status(f.authority), errorCode('AGENT_STATE_UNAVAILABLE')); assert.equal(f.counts().dispatches, 0);
    if (kind === 'missing') await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
  const f = await agentFixture(); assert.throws(() => new AgentConnectionStore(f.stateDirectory + path.sep + '..' + path.sep + 'agent', f.scope), errorCode('AGENT_STATE_UNAVAILABLE'));
  assert.equal(agentStateSchema.safeParse({ ...initialAgentState(f.scope), unexpected: true }).success, false);
});

test('capacity preserves old receipts and revocation remains required for replay', async () => {
  const f = await agentFixture(), request = await f.input('configure'); await f.manager.action(f.authority, request); const state = await f.state();
  while (state.operations.length < 256) state.operations.push({ ...state.operations[0], request_id: randomUUID(), payload_sha256: digest({ synthetic: state.operations.length }) });
  await writePrivate(path.join(f.stateDirectory, 'state.json'), state); const before = await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8');
  await assert.rejects(f.action('disconnect'), errorCode('AGENT_CAPACITY')); assert.equal((await f.manager.action(f.authority, request)).replayed, true); assert.equal(await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'), before);
  f.setApproval(undefined); await assert.rejects(f.manager.action(f.authority, request), errorCode('AGENT_APPROVAL_REQUIRED')); assert.equal(f.counts().dispatches, 0);
});

test('real subprocess connect/restart/replay retain receipts but never restore runtime or dispatch implicitly', async () => {
  const f = await agentFixture(); await f.action('configure'); const request = await f.input('connect');
  const connected = await subprocess(f, 'connect', request).done; assert.equal(connected.code, 0); assert.equal(connected.lines[0].result.connection.runtime_ready, true); assert.equal(connected.lines[0].counts.dispatches, 1);
  const restarted = await subprocess(f, 'status').done; assert.equal(restarted.code, 0); assert.equal(restarted.lines[0].status.connection.runtime_ready, false); assert.deepEqual(restarted.lines[0].counts, { contextLoads: 0, dispatches: 0 });
  const replay = await subprocess(f, 'replay', request).done; assert.equal(replay.code, 0); assert.equal(replay.lines[0].result.replayed, true); assert.equal(replay.lines[0].result.connection.runtime_ready, false); assert.deepEqual(replay.lines[0].counts, { contextLoads: 0, dispatches: 0 });
});

for (const stage of ['headers', 'verify']) test(`synchronous invalidation during authentication ${stage} is a durable failure, not a strict-process crash`, async () => {
  const f = await agentFixture(); await f.action('configure'); const request = await f.input('connect');
  const process = await subprocess(f, 'sync-' + stage, request).done;
  assert.equal(process.code, 0); assert.equal(process.signal, null); const result = process.lines[0];
  assert.equal(result.invalidation_fired, true); assert.equal(result.result.outcome.state, 'failed'); assert.equal(result.result.outcome.code, 'AGENT_CHANGED');
  assert.equal(result.result.connection.runtime_ready, false); assert.equal(result.result.connection.current_discovery, null);
  assert.equal(result.counts.contextLoads, 1); assert.equal(result.counts.dispatches, stage === 'headers' ? 0 : 1);
  const state = await f.state(); assert.equal(state.operations.at(-1)?.result?.state, 'failed'); assert.equal(state.operations.at(-1)?.result?.code, 'AGENT_CHANGED'); assert.equal(state.probe_times.length, 1);
  // A crashed pending request would instead require reconciliation. The saved
  // terminal failure can be inspected and replayed without another exchange.
  const replay = await subprocess(f, 'replay', request).done; assert.equal(replay.code, 0); assert.equal(replay.lines[0].result.replayed, true); assert.equal(replay.lines[0].counts.dispatches, 0);
});

test('real killed subprocess leaves pending identity/rate reservation; restart does not retry or recreate state', async () => {
  const f = await agentFixture(); await f.action('configure'); const request = await f.input('connect');
  const pending = subprocess(f, 'pending', request); assert.equal((await pending.first).phase, 'dispatched'); pending.child.kill('SIGKILL'); await pending.done;
  const before = await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8');
  const restart = await subprocess(f, 'outcome', request).done; assert.equal(restart.code, 0); assert.equal(restart.lines[0].outcome.state, 'interrupted'); assert.equal(restart.lines[0].status.connection.runtime_ready, false); assert.equal(restart.lines[0].counts.dispatches, 0);
  const retry = await subprocess(f, 'replay', request).done; assert.equal(retry.code, 1); assert.equal(retry.lines[0].error.code, 'AGENT_RECOVERY_REQUIRED'); assert.equal(retry.lines[0].counts.dispatches, 0);
  assert.equal(await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'), before); assert.equal((await f.state()).probe_times.length, 1);
});

test('real process crash under the exclusive state lease requires reconciliation, never automatic lock reclaim', async () => {
  const f = await agentFixture(), process = subprocess(f, 'lease'); assert.equal((await process.first).phase, 'leased'); process.child.kill('SIGKILL'); await process.done;
  const before = await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'); const restarted = await subprocess(f, 'status').done;
  assert.equal(restarted.code, 1); assert.equal(restarted.lines[0].error.code, 'AGENT_STATE_UNAVAILABLE'); assert.equal(restarted.lines[0].counts.dispatches, 0);
  assert.equal(await readFile(path.join(f.stateDirectory, 'state.json'), 'utf8'), before); assert.ok(await readFile(path.join(f.stateDirectory, '.owner.lock'), 'utf8'));
});

test('uncooperative network is limited to ten seconds and leaves a failed inspectable receipt without readiness', async () => {
  const f = await agentFixture(); await f.action('configure'); f.delay(new Promise(() => {})); const started = Date.now(); let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 25);
  try {
    const result = await f.action('connect'); assert.equal(result.outcome.code, 'AGENT_TIMEOUT'); assert.equal(result.connection?.runtime_ready, false); assert.equal(f.counts().dispatches, 1);
    assert.ok(Date.now() - started >= 9900); assert.ok(Date.now() - started < 12_000); assert.ok(ticks > 100);
  } finally { clearInterval(heartbeat); }
});

test('two instances use the same durable epoch; a second instance disconnect refuses the original late cache', async () => {
  const f = await agentFixture(); await f.action('configure'); const gate = deferred(); f.delay(gate.promise); const request = await f.input('connect'); const running = f.manager.action(f.authority, request); await f.started.promise;
  const other = f.make(new AgentConnectionStore(f.stateDirectory, f.scope)); await other.action(f.authority, await f.input('disconnect')); gate.resolve();
  const result = await running; assert.equal(result.outcome.state, 'failed'); assert.equal(result.connection?.current_discovery, null); assert.equal(result.connection?.runtime_ready, false);
});

test('discovery cannot outlive current source or authentication metadata, or enable execution features', async () => {
  for (const kind of ['source', 'auth']) {
    const f = await agentFixture(); await f.action('configure');
    if (kind === 'source') f.setSource({ ...f.source()!, valid_until: f.iso(30_000) }); else f.setMetadata({ ...f.metadata()!, valid_until: f.iso(30_000) });
    const result = await f.action('connect'); assert.equal(result.outcome.code, 'AGENT_EXPIRED'); assert.equal(result.connection?.runtime_ready, false); assert.deepEqual(result.effective, { authoring: false, execution: false, chat: false });
  }
});

test('Linux private permissions and symlink refusal protect isolated agent state', { skip: process.platform === 'win32' }, async () => {
  const f = await agentFixture(), stateFile = path.join(f.stateDirectory, 'state.json'); await chmod(stateFile, 0o644);
  await assert.rejects(f.manager.status(f.authority), errorCode('AGENT_STATE_UNAVAILABLE')); await chmod(stateFile, 0o600);
  const outside = path.join(f.directory, 'linked'); await mkdir(outside, { mode: 0o700 }); const link = path.join(f.directory, 'unsafe'); await symlink(outside, link, 'dir');
  await assert.rejects(new AgentConnections(new AgentConnectionStore(link, f.scope)).status(f.authority), errorCode('AGENT_STATE_UNAVAILABLE'));
});
