import test from 'node:test';
import assert from 'node:assert/strict';
import { demoFixture, preparedFixture, authorFixture, requireDemoOk, localDemoHost, DEMO_NOW } from './integrated-demo-fixture.js';
import { IntegratedDemo, demoEvent, rehearsalLayer, checkpointDigest, DEMO_LIMITS } from '../src/integrated-demo.js';
import { FixtureIssuer } from '../src/security.js';
import { canonical } from '../src/model.js';
import { rehearseIntegratedDemo } from '../scripts/integrated-demo-rehearsal.js';
import { checkpointFromWorkflowDescription, modelAllocation, demoActorInstructions } from '../src/integrated-demo-host.js';

for (const choice of ['900', '1200'] as const) test('integrated booking rehearsal ' + choice + ': exact storage, measured app, Release and inherited acceptance', async () => {
  const result = await rehearseIntegratedDemo(choice);
  assert.equal(result.real_model_calls, 0); assert.equal(result.actual_human_replies, 0); assert.equal(result.provider_calls, 0);
  assert.equal(result.checkpoint.phase, 'complete'); assert.equal(result.release_replay_ref, result.released.ref);
  assert.ok(result.measured.evidence.results.every(result => result.passed));
  assert.equal(result.measured.observations.reminder.reminders[0].at, Number(choice) - 60);
  assert.equal(result.measured.observations.competing_hold.accepted, false);
  assert.equal(Object.keys(result.measured.observations.before_expiry.holds).length, 1);
  assert.equal(Object.keys(result.measured.observations.expired.holds).length, 0);
  assert.equal(result.measured.observations.repeat_tick.reminders.length, 1);
  assert.ok(result.inherited_acceptance_equal && result.inherited_observations_equal && result.fresh_release_read);
  assert.equal(result.readback.fresh_reader, true);
  assert.equal(result.readback.registry_sha256, (await import('../src/model.js')).digest(result.checkpoint.registry));
  assert.equal(Object.keys(result.readback.fresh_entries).length, 4);
  assert.equal(result.readback.evidence_digest, result.evidence_digest);
  assert.ok(result.checkpoint.registry.entries[result.released.ref].locator);
  assert.equal(result.pushes, result.tokens_revoked);
  assert.ok(result.counters.artifact_reserved <= DEMO_LIMITS.artifact_dispatches);
  assert.ok(result.counters.commands <= DEMO_LIMITS.commands);
  assert.ok(result.intervals.every(interval => interval.label === 'synthetic-turn'));
  if (choice === '1200') { assert.ok(result.secondPacket); assert.equal(result.checkpoint.receipts.length, 3);
    assert.equal(result.checkpoint.refs.case_revision, 2); assert.equal(result.checkpoint.refs.reminder, 'L-reminder@2'); }
});

test('private demonstration rejects synthetic receipt and publishes no semantic approval', async () => {
  const { fixture } = await preparedFixture('controlled-private');
  const registry = canonical(fixture.checkpoint.registry);
  const result = await fixture.event('selection', 'operator', fixture.receipt('900'));
  assert.equal(result.outcome.ok, false); assert.equal(result.outcome.error.code, 'DEMO_HUMAN_RECEIPT_REFUSED');
  assert.equal(canonical(fixture.checkpoint.registry), registry); assert.equal(fixture.checkpoint.phase, 'selection');
  assert.equal(fixture.checkpoint.receipts.length, 0);
});

test('operator source, packet, timestamp and explicit message are required; actor cannot approve', async () => {
  const { fixture } = await preparedFixture();
  for (const change of [{ packet_digest: 'f'.repeat(64) }, { message_id: '' }, { text: '' }, { received_at: new Date(DEMO_NOW + 1).toISOString() }]) {
    const result = await fixture.event('selection', 'operator', { ...fixture.receipt('900'), ...change });
    assert.equal(result.outcome.ok, false); assert.equal(result.outcome.error.code, 'DEMO_HUMAN_RECEIPT_REFUSED');
  }
  const result = await fixture.event('selection', 'actor:a', fixture.receipt('900'));
  assert.equal(result.outcome.ok, false); assert.equal(result.outcome.error.code, 'DEMO_SOURCE_REFUSED');
  const denied = await fixture.event('actor', 'actor:a', { command: 'approve', input: { record: {} } });
  assert.equal(denied.outcome.ok, false); assert.equal(denied.outcome.error.code, 'OPERATION_FORBIDDEN');
  assert.equal(fixture.checkpoint.phase, 'selection');
});

test('authoring freeze, peer ownership and fixed role input preserve exact published state', async () => {
  const { fixture } = await preparedFixture();
  const registry = canonical(fixture.checkpoint.registry), heads = canonical(fixture.checkpoint.heads);
  const denied = await fixture.event('actor', 'actor:a', { command: 'layer.revise', input: { record: { ...rehearsalLayer('a'), revision: 2 }, previous: 'L-hold@1' } });
  assert.equal(denied.outcome.ok, false); assert.equal(denied.outcome.error.code, 'DEMO_PHASE_REFUSED');
  assert.equal(canonical(fixture.checkpoint.registry), registry); assert.equal(canonical(fixture.checkpoint.heads), heads);
  const principalInput = await fixture.event('actor', 'actor:a', { command: 'status', input: { principal: 'release-manager' } });
  assert.equal(principalInput.outcome.ok, false); assert.equal(principalInput.outcome.error.code, 'DEMO_INPUT_REFUSED');
  const event = demoEvent(fixture.checkpoint, 'actor', 'actor:a', { command: 'status', input: {}, principal: 'release-manager' }, 'spoof');
  await assert.rejects(fixture.sendEvent(event), (error: any) => error.code === 'INVALID_ARGUMENT');
  const host = localDemoHost(fixture); assert.throws(() => host.actorOperation('unknown-thread', { command: 'status', input: {} }));
});

test('1200 preference never creates selection approval before owner repair and fresh confirmation', async () => {
  const { fixture, packet } = await preparedFixture();
  const response = requireDemoOk(await fixture.event('selection', 'operator', fixture.receipt('1200')));
  assert.equal(response.repair_required, true); assert.equal(fixture.checkpoint.phase, 'repair');
  assert.equal(Object.values(fixture.checkpoint.registry.entries).filter(entry => entry.type === 'approval').length, 0);
  const early = await fixture.event('realize', 'host', {}); assert.equal(early.outcome.ok, false);
  await authorFixture(fixture, 'b', true); const fresh = requireDemoOk(await fixture.event('prepare', 'host', {}));
  assert.notEqual(fresh.packet_digest, packet.packet_digest);
  const stale = await fixture.event('selection', 'operator', { ...fixture.receipt('1200'), packet_digest: packet.packet_digest });
  assert.equal(stale.outcome.ok, false); assert.equal(stale.outcome.error.code, 'DEMO_HUMAN_RECEIPT_REFUSED');
  requireDemoOk(await fixture.event('selection', 'operator', fixture.receipt('1200'))); assert.equal(fixture.checkpoint.phase, 'runner');
});

test('defer stops without Release and keeps explicit synthetic provenance', async () => {
  const { fixture } = await preparedFixture();
  requireDemoOk(await fixture.event('selection', 'operator', fixture.receipt('defer')));
  assert.equal(fixture.checkpoint.phase, 'aborted'); assert.equal(fixture.checkpoint.receipts[0].source, 'synthetic-rehearsal');
  assert.equal(Object.values(fixture.checkpoint.registry.entries).filter(entry => entry.type === 'release').length, 1);
  await assert.rejects(fixture.event('realize', 'host', {}), (error: any) => error.code === 'DEMO_RUN_STOPPED');
});

test('same request replay performs no reads or writes; altered and stale events refuse', async () => {
  const { fixture } = await preparedFixture(); const request = fixture.events.at(-1)!;
  const beforeCalls = fixture.strict.calls.length, beforeDigest = checkpointDigest(fixture.checkpoint);
  const replay = await fixture.sendEvent(request); assert.equal(replay.reused, true);
  assert.equal(fixture.strict.calls.length, beforeCalls); assert.equal(checkpointDigest(fixture.checkpoint), beforeDigest);
  const changed = { ...request, source: 'operator' as const };
  await assert.rejects(fixture.sendEvent(changed), (error: any) => error.code === 'DEMO_REQUEST_CONFLICT');
  await assert.rejects(fixture.sendEvent({ ...request, request_id: 'different-old-event' }), (error: any) => error.code === 'DEMO_STALE_EVENT');
});

test('durable reservation survives reconstruction; forged reservation refuses before dispatch', async () => {
  const fixture = demoFixture(), event = demoEvent(fixture.checkpoint, 'bootstrap', 'host', {}, 'start');
  const controller = new IntegratedDemo(fixture.storage(), () => DEMO_NOW), reservation = controller.reserve(fixture.checkpoint, event);
  assert.ok(reservation.counters.artifact_reserved > 0); assert.equal(fixture.strict.calls.length, 0);
  const restored = JSON.parse(canonical(reservation));
  const result = await new IntegratedDemo(fixture.storage(), () => DEMO_NOW).apply(fixture.checkpoint, event, restored);
  assert.equal(result.outcome.ok, true); assert.equal(result.checkpoint.counters.artifact_reserved, reservation.counters.artifact_reserved);
  await assert.rejects(controller.apply(fixture.checkpoint, event, { ...reservation, counters: { ...reservation.counters, artifact_reserved: 0 } }), (error: any) => error.code === 'DEMO_RESERVATION_REFUSED');
});

test('failed push/read corruption never publishes a locator or silently falls back', async () => {
  const fixture = demoFixture(); requireDemoOk(await fixture.event('bootstrap', 'host', {}));
  const registry = canonical(fixture.checkpoint.registry); fixture.strict.failPush = true;
  const result = await fixture.event('actor', 'actor:a', { command: 'layer.create', input: { record: rehearsalLayer('a') } });
  assert.equal(result.outcome.ok, false); assert.equal(fixture.checkpoint.phase, 'failed');
  assert.equal(canonical(fixture.checkpoint.registry), registry); assert.equal(fixture.strict.revoked, 2);
  const corrupt = demoFixture(); requireDemoOk(await corrupt.event('bootstrap', 'host', {})); corrupt.strict.corruptRead = true;
  const bad = await corrupt.event('actor', 'actor:a', { command: 'status', input: {} });
  assert.equal(bad.outcome.ok, false); assert.equal(bad.outcome.error.code, 'ARTIFACT_DIGEST'); assert.equal(corrupt.checkpoint.phase, 'failed');
});

test('successful push/lost reply leaves a charged orphan and stops without automatic mutation retry', async () => {
  const fixture = demoFixture(); fixture.strict.loseResponse = true;
  const result = await fixture.event('bootstrap', 'host', {});
  assert.equal(result.outcome.ok, false); assert.equal(result.outcome.error.code, 'ARTIFACT_UNAVAILABLE');
  assert.equal(fixture.strict.pushes, 1); assert.equal(fixture.strict.files.size, 1); assert.equal(fixture.strict.revoked, 1);
  assert.equal(fixture.checkpoint.phase, 'failed'); assert.equal(Object.keys(fixture.checkpoint.registry.entries).length, 0);
  assert.ok(fixture.checkpoint.counters.artifact_reserved > 0);
  const calls = fixture.strict.calls.length; const replay = await fixture.sendEvent(fixture.events[0]);
  assert.equal(replay.reused, true); assert.equal(fixture.strict.calls.length, calls);
});

test('deadline and conservative reservation limits refuse before any provider dispatch', async () => {
  const fixture = demoFixture(); fixture.setNow(DEMO_NOW + DEMO_LIMITS.duration_ms - DEMO_LIMITS.cleanup_ms);
  await assert.rejects(fixture.event('bootstrap', 'host', {}), (error: any) => error.code === 'DEMO_RUN_STOPPED'); assert.equal(fixture.strict.calls.length, 0);
  const another = demoFixture(), checkpoint = structuredClone(another.checkpoint); checkpoint.counters.artifact_reserved = DEMO_LIMITS.artifact_dispatches;
  const controller = new IntegratedDemo(another.storage(), () => DEMO_NOW);
  assert.throws(() => controller.reserve(checkpoint, demoEvent(checkpoint, 'bootstrap', 'host', {}, 'over-budget')), (error: any) => error.code === 'DEMO_ARTIFACT_LIMIT');
  assert.equal(another.strict.calls.length, 0);
  const perApply = structuredClone(another.checkpoint);
  // Local locator metadata only: admission must refuse this operation before a
  // provider handle/read is obtained, regardless of the aggregate headroom.
  perApply.registry.entries = Object.fromEntries(Array.from({ length: 34 }, (_, index) => ['fixture-' + index, { type: 'layer', hash: 'a'.repeat(64), published: true,
    locator: { ref: 'b'.repeat(40), path: 'a'.repeat(64) + '.json', hash: 'a'.repeat(64), size_bytes: 1 } }]));
  assert.throws(() => controller.reserve(perApply, demoEvent(perApply, 'actor', 'actor:a', { command: 'status', input: {} }, 'per-apply-over')), (error: any) => error.code === 'DEMO_ARTIFACT_LIMIT');
  assert.equal(another.strict.calls.length, 0);
});

test('unsupported event kinds and prototype request identifiers refuse before dispatch', async () => {
  const fixture = demoFixture(), valid = demoEvent(fixture.checkpoint, 'bootstrap', 'host', {}, 'start');
  for (const event of [{ ...valid, kind: 'toString' }, { ...valid, request_id: '__proto__' }, { ...valid, sequence: 1.5 }]) {
    await assert.rejects(fixture.sendEvent(event as any), (error: any) => error.code === 'DEMO_EVENT_REFUSED');
  }
  assert.equal(fixture.strict.calls.length, 0);
});

test('host fixes thread identities, bounds turns/tools and cancels further dispatch', async () => {
  const fixture = demoFixture(), host = localDemoHost(fixture);
  assert.equal(modelAllocation('a').reasoningEffort, 'medium'); assert.equal(modelAllocation('b').reasoningEffort, 'high'); assert.equal(modelAllocation('b').hard_token_cap_verified, false);
  assert.ok(Buffer.byteLength(demoActorInstructions('b', true)) < 12000); assert.match(demoActorInstructions('b', true), /L-alternative@1/);
  assert.throws(() => host.bindThread('fourth', 'a'));
  for (let turn = 0; turn < 4; turn++) { host.beginTurn('synthetic-a'); host.endTurn('synthetic-a'); }
  assert.throws(() => host.beginTurn('synthetic-a'), (error: any) => error.code === 'DEMO_TURN_LIMIT');
  host.beginTurn('synthetic-b'); host.cancel(); assert.equal(host.intervals.at(-1)!.cancelled, true);
  assert.throws(() => host.actorOperation('synthetic-b', { command: 'status', input: {} })); assert.equal(host.usage().real_model_calls, 0);
});

test('incorrect finite draft can be corrected without immutable bad revision or silent scripted replacement', async () => {
  const fixture = demoFixture(); requireDemoOk(await fixture.event('bootstrap', 'host', {}));
  const bad = rehearsalLayer('a'); (bad.changes[0].value as any).parameters.seconds = 901;
  const refused = await fixture.event('actor', 'actor:a', { command: 'layer.create', input: { record: bad } });
  assert.equal(refused.outcome.ok, false); assert.equal(refused.outcome.error.code, 'DEMO_AUTHORING_REVIEW_REFUSED');
  const before = structuredClone(fixture.checkpoint);
  assert.equal(before.registry.entries['L-hold@1'], undefined); assert.equal(before.heads['L-hold'], undefined);
  await authorFixture(fixture, 'a'); assert.equal(fixture.checkpoint.registry.entries['L-hold@1'].published, true);
});

test('no app/evidence/release shortcut can pass before explicit selection and measured passing checks', async () => {
  const { fixture } = await preparedFixture();
  const early = await fixture.event('realize', 'host', {}); assert.equal(early.outcome.ok, false);
  requireDemoOk(await fixture.event('selection', 'operator', fixture.receipt('900')));
  const { realization } = requireDemoOk(await fixture.event('realize', 'host', {}));
  const { measureDemoApp } = await import('../src/integrated-demo-runner.js');
  await assert.rejects(measureDemoApp(realization, 1200), (error: any) => error.code === 'DEMO_MEASUREMENT_FAILED');
  const measured = await measureDemoApp(realization, 900), bad = structuredClone(measured.evidence); bad.results[0].passed = false;
  const refused = await fixture.event('evidence', 'runner', { evidence: bad, observations_digest: measured.observations_digest });
  assert.equal(refused.outcome.ok, false); assert.equal(refused.outcome.error.code, 'VALIDATION_INCOMPLETE');
  assert.equal(fixture.checkpoint.phase, 'runner'); assert.equal(fixture.checkpoint.refs.validation, undefined);
});

test('structured Workflow checkpoint extraction rejects missing/truncated output', async () => {
  const fixture = demoFixture(); const output = await fixture.event('bootstrap', 'host', {});
  const description = { steps: [{ name: 'apply-1', type: 'step', success: true, output }] };
  assert.equal(checkpointDigest(checkpointFromWorkflowDescription(description)), checkpointDigest(fixture.checkpoint));
  assert.throws(() => checkpointFromWorkflowDescription({ steps: [{ name: 'apply-1', type: 'step', success: true, output: 'truncated...' }] }));
});

test('existing hosted fixture refusal and checker backend guard remain in force', async () => {
  assert.throws(() => new FixtureIssuer({ hosted: true }).resolve('fixture-a'), (error: any) => error.code === 'HOSTED_IDENTITY_UNAVAILABLE');
  const { fixture } = await preparedFixture(); requireDemoOk(await fixture.event('selection', 'operator', fixture.receipt('900')));
  const loaded = await fixture.storage().load(fixture.checkpoint.registry);
  const { Engine } = await import('../src/core.js'); const engine = new Engine(loaded.records, fixture.checkpoint.heads, { checkerBackend: 'none' });
  assert.throws(() => engine.realize(fixture.checkpoint.refs.candidate!, 'booking-node/4'), (error: any) => error.code === 'UNSUPPORTED_CHECKER_BACKEND');
});
