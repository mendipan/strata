import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DemoRunPresentation, projectSelection } from '../src/demo-run-presentation.js';
import { parseRunReplay } from '../src/demo-run-replay.js';
import { createDemoDashboard } from '../src/integrated-demo-dashboard.js';
import { demoFixture } from './integrated-demo-fixture.js';
import { rehearsalLayer } from '../src/integrated-demo.js';
import { operatorPromptPacketFromCheckpoint } from '../src/integrated-demo-operator-reply.js';
import { measureDemoApp } from '../src/integrated-demo-runner.js';
import { digest } from '../src/model.js';

function fixture(startedAt?: number) {
  const f = demoFixture('local-rehearsal', startedAt), v = new DemoRunPresentation(f.checkpoint.run_id, 'synthetic-fixture');
  const records: any[] = [];
  async function event(kind: any, source: any, input: any) {
    const result = await f.event(kind, source, input), record = { type: 'workflow-event', kind, source, sequence: result.checkpoint.sequence,
      phase: result.checkpoint.phase, checkpoint_digest: digest(result.checkpoint), outcome: result.outcome,
      ...(kind === 'actor' ? { command: input.command, proposal: input.input.record } : {}) };
    records.push(record); v.accept(record); return result;
  }
  async function author(a: any, repaired = false) {
    const layer = rehearsalLayer(a, repaired);
    await event('actor', 'actor:' + a, { command: repaired ? 'layer.revise' : 'layer.create', input: { record: layer, ...(repaired ? { previous: 'L-reminder@1' } : {}) } });
    await event('actor', 'actor:' + a, { command: 'layer.publish', input: { ref: layer.id + '@' + layer.revision } });
  }
  async function prepare() { const r = await event('prepare', 'host', {}); const p = operatorPromptPacketFromCheckpoint(f.checkpoint, r.outcome); v.review(p); return p; }
  return { f, v, records, event, author, prepare };
}

test('A01,A04-A08: invocation is not publication; accepted command identity and real facets drive graphics', async () => {
  const { v, event, author } = fixture(); assert.equal(v.snapshot().release, null); assert.deepEqual(v.snapshot().proposals, {});
  v.accept({ type: 'actor-launching', actor: 'a', assigned_revision: 1 });
  v.accept({ type: 'actor-finished', actor: 'a', assigned_revision: 1, execution: 'mock-codex-process' });
  assert.equal(v.snapshot().actors['a@1'].completion_observed, true); assert.deepEqual(v.snapshot().proposals, {});
  await event('bootstrap', 'host', {});
  const refused = await event('actor', 'actor:a', { command: 'layer.publish', input: { ref: 'L-hold@1' } });
  assert.equal(refused.outcome.ok, false); assert.deepEqual(v.snapshot().proposals, {});
  await author('a'); assert.equal(v.snapshot().proposals['L-hold@1'].publication, 'published');
  await event('actor', 'actor:a', { command: 'inspect', input: { type: 'release', ref: 'R0@1' } });
  assert.deepEqual(v.snapshot().blocks.find((b: any) => b.id === 'booking.hold').facets, ['behavior', 'data', 'safety']);
  assert.equal(v.snapshot().blocks.find((b: any) => b.id === 'booking.reminder').relationships[0].target, 'booking.hold');
});

test('A09-A12,A14,A20: packet partitions, fresh repair review, exact Resolution and candidate-bound measured evidence', async () => {
  const { f, v, event, author, prepare } = fixture(); await event('bootstrap', 'host', {}); for (const a of ['a', 'c', 'b']) await author(a);
  const first = await prepare(), review = projectSelection(first); assert.deepEqual(review.considered.slice().sort(), ['L-alternative@1', 'L-hold@1', 'L-reminder@1']);
  const twenty = review.options.find((o: any) => o.id === '1200'); assert.equal(twenty.executable, true); assert.deepEqual(twenty.selected, ['L-alternative@1']);
  await event('selection', 'operator', f.receipt('1200')); assert.equal(v.snapshot().selection, null); assert.equal(v.snapshot().decisions.length, 1);
  await author('b', true); const second = await prepare(); assert.notEqual(second.packet_digest, first.packet_digest); assert.deepEqual(second.allowed_actions, ['1200', 'defer']);
  assert.ok(v.snapshot().proposals['L-reminder@1']); assert.deepEqual(v.snapshot().proposals['L-reminder@2'].requires_layers, ['L-alternative@1']);
  await event('selection', 'operator', f.receipt('1200')); assert.ok(v.snapshot().selection.resolution_ref); assert.deepEqual(v.snapshot().selection.selected.sort(), ['L-alternative@1', 'L-reminder@2']);
  const realized = await event('realize', 'host', {}); assert.equal(realized.outcome.ok, true);
  const data = (realized.outcome as any).data, measured = await measureDemoApp(data.realization, 1200);
  v.accept({ type: 'measurement-verified', ...measured, evidence: { ...measured.evidence, candidate: 'wrong' } }); assert.equal(v.snapshot().evidence, null);
  await event('evidence', 'runner', { evidence: measured.evidence, observations_digest: measured.observations_digest });
  v.accept({ type: 'measurement-verified', ...measured });
  const evidence = v.snapshot().evidence; assert.equal(evidence.results.filter((r: any) => r.method === 'mechanical' && r.passed).length, 6);
  assert.equal(evidence.results.filter((r: any) => r.method === 'review').length, 4); assert.equal(v.snapshot().observations.reminder.fixture_seconds, 1140);
  await event('endorse', 'operator', f.receipt('approve-release')); assert.equal(v.snapshot().inherited_equal, null); assert.equal(v.snapshot().cleanup.status, 'unverified');
});

test('A17,A18: duplicate/older observations cannot roll back; conflicting identity and gaps freeze projection', async () => {
  const { v, event, records } = fixture(); await event('bootstrap', 'host', {}); const before = v.snapshot();
  v.accept(records[0]); assert.deepEqual(v.snapshot(), before);
  v.accept({ ...records[0], outcome: { ok: false, error: { code: 'CONFLICT' } } }); assert.match(v.snapshot().incomplete, /Conflicting/);
  v.accept({ type: 'release-verified', released: { ref: 'release@late', state: 'validated' }, inherited_observations_equal: true });
  assert.equal(v.snapshot().release, null); assert.equal(v.snapshot().inherited_equal, null);
  const gap = new DemoRunPresentation('test'); gap.accept({ ...records[0], sequence: 4 }); assert.match(gap.snapshot().incomplete, /gap/); assert.equal(gap.snapshot().release, null);
  const isolated = new DemoRunPresentation('other'); isolated.accept({ ...records[0], run_id: 'prior' }); assert.equal(isolated.snapshot().checkpoint, null);
});

test('A18: a complete presentation snapshot survives the bounded event log truncating', async () => {
  const { f, event, records } = fixture(); await event('bootstrap', 'host', {});
  await event('actor', 'actor:a', { command: 'inspect', input: { type: 'release', ref: 'R0@1' } });
  const server = await createDemoDashboard(f.checkpoint.run_id, () => {}), url = new URL(server.url);
  try {
    for (const record of records) await server.emit(record);
    for (let i = 0; i < 170; i++) await server.emit({ type: 'actor-finished', actor: 'a', assigned_revision: 1 });
    const state: any = await (await fetch(url.origin + '/state', { headers: { authorization: 'Bearer ' + url.hash.slice(1) } })).json();
    assert.equal(state.events.length, 160); assert.equal(state.view.checkpoint.sequence, 2);
    assert.equal(state.view.blocks.length, 4); assert.equal(state.view.incomplete, null);
  } finally { await server.close(); }
});

test('A13,A19-A23: Release, inherited measurement, failure and cleanup remain independent', () => {
  const v = new DemoRunPresentation('test');
  v.accept({ type: 'provider-outcome', provider: { status: 'complete' }, application: { ok: false, phase: 'failed' } });
  assert.equal(v.snapshot().provider.status, 'complete'); assert.equal(v.snapshot().application.ok, false); assert.equal(v.snapshot().release, null);
  v.accept({ type: 'release-verified', released: { ref: 'release@test', state: 'validated' }, inherited: { ref: 'inherited@test' }, inherited_observations_equal: true });
  v.accept({ type: 'cleanup-blocked' }); assert.equal(v.snapshot().release.ref, 'release@test'); assert.equal(v.snapshot().cleanup.status, 'blocked');
  v.accept({ type: 'run-failed', code: 'FAIL', message: 'Stopped' }); assert.equal(v.snapshot().inherited_equal, true); assert.equal(v.snapshot().failure.code, 'FAIL');
  v.accept({ type: 'cleanup-verified', cleanup: { cleanup: { instance_absent: true, worker_retained_verified: true, worker_delete_requested: false }, counters: { handles_open: 0 } } });
  assert.equal(v.snapshot().cleanup.checks.worker_delete_requested, false); assert.equal(v.snapshot().cleanup.counters.handles_open, 0);
  assert.equal(v.snapshot().cleanup.counters.unsettled_dispatches, undefined); assert.ok(v.snapshot().failure);
});

test('A24-A27: retained replay integrity, absence of invented timestamps/private streams, and mutation rejection', async () => {
  const replay = parseRunReplay(JSON.parse(await readFile('examples/replay/synthetic-run.json', 'utf8')));
  for (const c of replay.chapters) { assert.equal(c.view.source_mode, 'recorded-replay'); assert.ok(c.view.event_order.every((e: any) => e.observed_at === null)); }
  const bytes = JSON.stringify(replay); for (const privateField of ['codex_event_stream', 'codex_stderr', 'operator_label', 'prompt_sha256', 'account_id', 'namespace_id', 'capability']) assert.ok(!bytes.includes(privateField), privateField);
  assert.equal(replay.chapters.filter(c => c.recorded_choice).length, 3);
  assert.equal(replay.chapters.at(-1)!.view.release.state, 'validated'); assert.equal(replay.chapters.at(-1)!.view.inherited_equal, true);
  const changed = structuredClone(replay); changed.chapters[0].view.phase = 'complete'; assert.throws(() => parseRunReplay(changed), /integrity/);
  const server = await createDemoDashboard(replay.run_id, () => { throw Error('Replay must not stop a run'); }, undefined, { source_mode: 'recorded-replay', replay });
  const url = new URL(server.url);
  try { for (const route of ['/decision', '/stop', '/lab/begin', '/lab/check', '/lab/fresh']) assert.equal((await fetch(url.origin + route, { method: 'POST', headers: { authorization: 'Bearer ' + url.hash.slice(1), origin: url.origin, 'content-type': 'application/json' }, body: '{}' })).status, 409); }
  finally { await server.close(); }
});

test('A15,A27: dashboard response acknowledgement is packet-specific; arbitrary raw emit fields are not exposed', async () => {
  const { f, event, author, prepare } = fixture(Date.now()); await event('bootstrap', 'host', {}); for (const a of ['a', 'c', 'b']) await author(a); const packet = await prepare();
  const server = await createDemoDashboard(f.checkpoint.run_id, () => {}), url = new URL(server.url), auth = { authorization: 'Bearer ' + url.hash.slice(1) };
  try {
    await server.emit({ type: 'actor-finished', actor: 'a', assigned_revision: 1, prompt: 'SECRET', codex_stderr: 'SECRET', private_url: 'SECRET' });
    const waiting = server.decide(packet, new AbortController().signal);
    await fetch(url.origin + '/decision', { method: 'POST', headers: { ...auth, origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ run_id: packet.run_id, packet_digest: packet.packet_digest, phase: packet.phase, action: '900', reason: 'synthetic' }) }); await waiting;
    const state: any = await (await fetch(url.origin + '/state', { headers: auth })).json(); assert.equal(state.response_received.packet_digest, packet.packet_digest); assert.equal(state.packet, null); assert.ok(!JSON.stringify(state).includes('SECRET'));
  } finally { await server.close(); }
});
