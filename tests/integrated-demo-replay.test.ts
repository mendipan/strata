import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { OrderedSyntheticFeed, type SyntheticViewEvent } from '../demo/ordered-feed.js';
import {
  compareWorkflowSnapshots,
  parseWorkflowSnapshot,
  type ImportedWorkflowSnapshot
} from '../src/integrated-demo-visualization.js';
import {
  integratedDemoReplayData,
  renderIntegratedDemoReplayHtml,
  type IntegratedDemoReplay
} from '../src/integrated-demo-replay.js';

const source = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/demo/rehearsal.json'), 'utf8')) as unknown;
const replay = integratedDemoReplayData(source);
const htmlTemplate = '<!doctype html><script id="replay-data" type="application/json">@@REPLAY_DATA@@</script>';

function fixtureEvent(event: SyntheticViewEvent, patch: Partial<SyntheticViewEvent> = {}): SyntheticViewEvent {
  return { ...structuredClone(event), ...patch };
}

test('local fixture bundle uses canonical ordered events and exact review packets, without timing fields', () => {
  assert.equal(replay.format, 'strata.integrated-demo-replay-view/1');
  assert.equal(replay.source, 'historical-local-rehearsal-fixture');
  assert.equal(replay.live_data, false);
  assert.deepEqual(replay.branches.map(branch => branch.branch), ['900', '1200']);

  for (const branch of replay.branches) {
    assert.equal(branch.events.length, branch.event_count);
    assert.deepEqual(branch.events.map(event => event.sequence), Array.from({ length: branch.event_count }, (_, index) => index + 1));
    assert.deepEqual(branch.provenance, { synthetic_only: true, real_model_calls: 0, actual_human_replies: 0, provider_calls: 0 });
    const actorA = branch.actors.find(actor => actor.actor === 'A')!;
    assert.deepEqual(actorA.layers, ['L-hold@1']);
    assert.ok(branch.actors.some(actor => actor.actor === 'C' && actor.layers.includes('L-alternative@1')));
    assert.ok(branch.actors.some(actor => actor.actor === 'B' && actor.layers.includes('L-reminder@1')));
    assert.equal(actorA.layers.includes('L-alternative@2'), false);
    assert.ok(branch.scripted_overlap_actors.includes('A'));
    assert.ok(branch.scripted_overlap_actors.includes('C'));
    assert.ok(branch.selection_packets.every(packet => packet.choice_preselected === false));
    assert.ok(branch.selection_packets.every(packet => !('expires_at' in packet)));
    assert.ok(branch.events.some(event => event.kind === 'prepare' && event.packet_digest));
    assert.ok(branch.events.some(event => event.kind === 'selection' && event.actor === 'Decision input · synthetic fixture'));
    assert.ok(branch.events.some(event => event.kind === 'realize'));
    assert.ok(branch.events.some(event => event.kind === 'evidence'));
    assert.ok(branch.events.some(event => event.kind === 'endorse'));
    assert.equal(branch.endorsement.checks_passed, true);
    assert.equal(branch.endorsement.approvals_pending, true);
    assert.equal(branch.release.fixture_state, 'validated');
    assert.match(branch.release.state, /not live or human-approved/);
    const refused = branch.events.find(event => event.outcome === 'LAYER_SCOPE_FORBIDDEN');
    assert.ok(refused);
    assert.match(refused.summary, /^Refused revise attempt for L-alternative@2$/);
  }

  const branch1200 = replay.branches.find(branch => branch.branch === '1200')!;
  assert.equal(branch1200.selection_packets.length, 2);
  assert.deepEqual(branch1200.actors.find(actor => actor.actor === 'B')?.layers, ['L-reminder@1', 'L-reminder@2']);
  assert.ok(branch1200.events.some(event => event.phase_after === 'repair'));
  const serialized = JSON.stringify(replay);
  assert.equal(serialized.includes('start_ms'), false);
  assert.equal(serialized.includes('duration_ms'), false);
  assert.equal(serialized.includes('"expires_at"'), false);
});

test('ordered feed buffers gaps, drains in order, and treats repeated delivery as duplicate', () => {
  const events = replay.branches[0]!.events;
  const feed = new OrderedSyntheticFeed();
  const third = feed.accept(events[2]);
  assert.equal(third.decision, 'buffered');
  assert.equal(third.missing_sequence, 1);
  assert.equal(feed.accept(events[2]).decision, 'duplicate');
  assert.equal(feed.accept(events[0]).decision, 'applied');
  const drained = feed.accept(events[1]);
  assert.equal(drained.decision, 'applied');
  assert.deepEqual(drained.applied.map(event => event.sequence), [2, 3]);
  assert.equal(feed.nextSequence, 4);
  assert.deepEqual(feed.records.map(event => event.sequence), [1, 2, 3]);
});

test('event states bind decision pauses and fixture actions to their exact review packets', () => {
  for (const branch of replay.branches) {
    const prepareIndexes = branch.events.flatMap((event, index) => event.kind === 'prepare' ? [index] : []);
    const selectionIndexes = branch.events.flatMap((event, index) => event.kind === 'selection' ? [index] : []);
    assert.equal(prepareIndexes.length, branch.selection_packets.length);
    assert.equal(selectionIndexes.length, branch.selection_packets.length);
    for (let index = 0; index < prepareIndexes.length; index++) {
      const prepare = branch.events[prepareIndexes[index]!]!;
      const selection = branch.events[selectionIndexes[index]!]!;
      const packet = branch.selection_packets.find(item => item.packet_digest === prepare.packet_digest);
      assert.ok(packet);
      assert.equal(packet.choice_preselected, false);
      assert.equal(selection.packet_digest, packet.packet_digest);
      assert.equal(selection.actor, 'Decision input · synthetic fixture');
      assert.equal(selection.fixture_action, branch.branch);
    }
  }
  const packet1200 = replay.branches[1]!.selection_packets[0]!;
  assert.equal(packet1200.repair_required_for_initial_1200, true);
});

test('replay refuses live-labelled, malformed-event, and packet-digest-tampered sources', () => {
  const live = JSON.parse(JSON.stringify(source)) as { live_authorized: boolean };
  live.live_authorized = true;
  assert.throws(() => integratedDemoReplayData(live), /live activity disabled/);

  const malformedEvent = JSON.parse(JSON.stringify(source)) as { rehearsals: Array<{ events: Array<{ sequence: number }> }> };
  malformedEvent.rehearsals[0]!.events[1]!.sequence = 1;
  assert.throws(() => integratedDemoReplayData(malformedEvent), /incomplete, duplicated, or out of order/);

  const malformedPacket = JSON.parse(JSON.stringify(source)) as { rehearsals: Array<{ firstPacket: { packet: { packet_sha256: string } } }> };
  malformedPacket.rehearsals[0]!.firstPacket.packet.packet_sha256 = 'f'.repeat(64);
  assert.throws(() => integratedDemoReplayData(malformedPacket), /exact unselected packet and source digest/);
});

test('reconnect replay is idempotent, old pruned events are stale, malformed input is inert', () => {
  const events = replay.branches[0]!.events;
  const firstConnection = new OrderedSyntheticFeed();
  firstConnection.accept(events[0]);
  firstConnection.accept(events[1]);

  const reconnected = new OrderedSyntheticFeed();
  for (const persisted of firstConnection.records) assert.equal(reconnected.accept(persisted).decision, 'applied');
  assert.equal(reconnected.accept(events[1]).decision, 'duplicate');
  assert.equal(reconnected.accept(events[2]).decision, 'applied');
  assert.deepEqual(reconnected.records.map(event => event.sequence), [1, 2, 3]);

  const boundedHistory = new OrderedSyntheticFeed(64, 1);
  boundedHistory.accept(events[0]);
  boundedHistory.accept(events[1]);
  assert.equal(boundedHistory.accept(events[0]).decision, 'stale');

  const invalid = { ...events[0] } as Partial<SyntheticViewEvent>;
  delete invalid.summary;
  const malformedFeed = new OrderedSyntheticFeed();
  assert.equal(malformedFeed.accept(invalid).decision, 'invalid');
  assert.equal(malformedFeed.nextSequence, 1);
  assert.equal(malformedFeed.accept(events[0]).decision, 'applied');
});

test('conflicting identities or different bytes at one sequence stop the feed', () => {
  const events = replay.branches[0]!.events;
  const identityFeed = new OrderedSyntheticFeed();
  assert.equal(identityFeed.accept(events[0]).decision, 'applied');
  assert.equal(identityFeed.accept(fixtureEvent(events[1]!, { branch: '1200' })).decision, 'conflict');
  assert.equal(identityFeed.accept(events[1]).decision, 'conflict');

  const digestFeed = new OrderedSyntheticFeed();
  assert.equal(digestFeed.accept(events[0]).decision, 'applied');
  assert.equal(digestFeed.accept(fixtureEvent(events[0]!, { event_digest: 'f'.repeat(64) })).decision, 'conflict');
  assert.equal(digestFeed.accept(events[1]).decision, 'conflict');
});

test('snapshot parser keeps status-only imports unknown and accepts only ordered complete checkpoints', () => {
  const input = source as { rehearsals: Array<{ checkpoint: { run_id: string; sequence: number; trace: unknown[] } }> };
  const checkpoint = input.rehearsals[0]!.checkpoint;
  const id = `run-${checkpoint.run_id}`;
  const importedAt = '2026-10-05T00:00:00.000Z';
  const partial = parseWorkflowSnapshot({ id, status: 'paused', step_count: 1, steps: [
    { name: 'wait-for-selection', type: 'waitForEvent', success: false, event_type: 'operator-choice' }
  ] }, importedAt);
  assert.equal(partial.completeness, 'status-only');
  assert.equal(partial.phase, null);
  assert.equal(partial.sequence, null);
  assert.equal(partial.waiting_for, 'operator-choice');
  assert.equal(partial.source, 'operator-supplied-json-unverified');

  const complete = parseWorkflowSnapshot({ id, status: 'complete', step_count: 1, steps: [
    { name: `apply-${checkpoint.sequence}`, type: 'step', success: true, output: { checkpoint } }
  ] }, importedAt);
  assert.equal(complete.completeness, 'checkpoint');
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.sequence, checkpoint.sequence);
  assert.ok(complete.release_ref);
  assert.equal(complete.trace.length, checkpoint.sequence);
  assert.equal(complete.imported_at, importedAt);
  assert.equal(complete.source, 'operator-supplied-json-unverified');

  const malformedTrace = structuredClone(checkpoint);
  (malformedTrace.trace as Array<{ sequence: number }>)[0]!.sequence = 2;
  assert.throws(() => parseWorkflowSnapshot({ id, status: 'complete', steps: [
    { name: `apply-${checkpoint.sequence}`, type: 'step', success: true, output: { checkpoint: malformedTrace } }
  ] }, importedAt), /duplicated or out of order/);
  assert.throws(() => parseWorkflowSnapshot({ id: 'run-not-a-run', status: 'complete', steps: [] }, importedAt), /exact integrated-demo instance id/);
});

test('snapshot reconnect comparison distinguishes duplicate, stale, partial, and changed history', () => {
  const input = source as { rehearsals: Array<{ checkpoint: { run_id: string; sequence: number; trace: unknown[] } }> };
  const checkpoint = input.rehearsals[0]!.checkpoint;
  const id = `run-${checkpoint.run_id}`;
  const complete = parseWorkflowSnapshot({ id, status: 'complete', steps: [
    { name: `apply-${checkpoint.sequence}`, type: 'step', success: true, output: { checkpoint } }
  ] }, '2026-10-05T00:00:00.000Z');
  const same = { ...complete, imported_at: '2026-10-05T00:01:00.000Z' };
  assert.equal(compareWorkflowSnapshots(complete, same).decision, 'duplicate');

  const stale = { ...complete, sequence: complete.sequence! - 1, checkpoint_digest: 'a'.repeat(64) };
  assert.equal(compareWorkflowSnapshots(complete, stale).decision, 'stale');
  const partial = { ...complete, sequence: null, checkpoint_digest: null, completeness: 'status-only' as const, phase: null, trace: [] };
  assert.equal(compareWorkflowSnapshots(complete, partial).decision, 'partial');
  const changed = { ...complete, checkpoint_digest: 'b'.repeat(64) };
  assert.equal(compareWorkflowSnapshots(complete, changed).decision, 'conflict');

  const next: ImportedWorkflowSnapshot = {
    ...complete,
    sequence: complete.sequence! + 1,
    checkpoint_digest: 'c'.repeat(64),
    trace: [...complete.trace, { ...complete.trace.at(-1)!, sequence: complete.sequence! + 1 }]
  };
  assert.equal(compareWorkflowSnapshots(complete, next).decision, 'accept');
});

test('preview embeds safely escaped fixture data in one offline template slot', () => {
  const html = renderIntegratedDemoReplayHtml(htmlTemplate, replay);
  assert.match(html, /"live_data":false/);
  assert.match(html, /"actual_human_replies":0/);
  assert.equal(html.includes('@@REPLAY_DATA@@'), false);

  const injected = structuredClone(replay) as IntegratedDemoReplay;
  injected.branches[0]!.selection_packets[0]!.business_request = '</script><script>alert(1)</script>';
  const safeHtml = renderIntegratedDemoReplayHtml(htmlTemplate, injected);
  assert.equal(safeHtml.includes('</script><script>alert(1)</script>'), false);
  assert.equal(safeHtml.includes('\\u003c/script\\u003e'), true);
  assert.throws(() => renderIntegratedDemoReplayHtml(`${htmlTemplate}@@REPLAY_DATA@@`, replay), /one replay data slot/);
});
