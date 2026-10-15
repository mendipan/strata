import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { canonical, digest } from '../src/model.js';
import { checkpointDigest } from '../src/integrated-demo.js';
import { measureDemoApp } from '../src/integrated-demo-runner.js';
import { demoFixture, localDemoHost, requireDemoOk } from '../tests/integrated-demo-fixture.js';
import { rehearsalLayer } from '../src/integrated-demo.js';

export async function rehearseIntegratedDemo(choice: '900' | '1200') {
  const fixture = demoFixture(), host = localDemoHost(fixture);
  requireDemoOk(await host.event('bootstrap', 'host', {}));
  const author = async (actor: 'a' | 'b' | 'c', repaired = false) => {
    const thread = 'synthetic-' + actor; host.beginTurn(thread);
    try {
      requireDemoOk(await host.actorOperation(thread, { command: 'inspect', input: { type: 'release', ref: 'R0@1' } }));
      if (actor === 'b') for (const ref of ['L-hold@1', 'L-alternative@1']) requireDemoOk(await host.actorOperation(thread, { command: 'inspect', input: { type: 'layer', ref } }));
      const record = rehearsalLayer(actor, repaired);
      requireDemoOk(await host.actorOperation(thread, { command: repaired ? 'layer.revise' : 'layer.create', input: { record, ...(repaired ? { previous: 'L-reminder@1' } : {}) } }));
      requireDemoOk(await host.actorOperation(thread, { command: 'layer.publish', input: { ref: `${record.id}@${record.revision}` } }));
    } finally { host.endTurn(thread); }
  };
  await Promise.all([author('a'), author('c')]); await author('b');
  host.beginTurn('synthetic-a');
  const peerRefusal = await host.actorOperation('synthetic-a', { command: 'layer.revise', input: { previous: 'L-alternative@1', record: { ...rehearsalLayer('c'), revision: 2 } } });
  host.endTurn('synthetic-a'); if (peerRefusal.outcome.ok) throw new Error('Peer write was accepted');
  const firstPacket = requireDemoOk(await host.event('prepare', 'host', {}));
  const firstReply = requireDemoOk(await host.syntheticReply(fixture.receipt(choice)));
  let secondPacket;
  if (choice === '1200') { if (!firstReply.repair_required) throw new Error('Missing repair gate'); await author('b', true);
    secondPacket = requireDemoOk(await host.event('prepare', 'host', {})); requireDemoOk(await host.syntheticReply(fixture.receipt('1200'))); }
  const realized = requireDemoOk(await host.event('realize', 'host', {}));
  const measured = await measureDemoApp(realized.realization, Number(choice) as 900 | 1200);
  const endorsementPacket = requireDemoOk(await host.event('evidence', 'runner', { evidence: measured.evidence, observations_digest: measured.observations_digest }));
  const finished = requireDemoOk(await host.syntheticReply(fixture.receipt('approve-release')));
  const inheritedMeasured = await measureDemoApp(finished.inherited_realization, Number(choice) as 900 | 1200);
  const cold = await fixture.storage().load(host.checkpoint.registry);
  if (!cold.records[finished.released.ref]?.published || canonical(measured.observations) !== canonical(inheritedMeasured.observations)) throw new Error('Fresh Release/inherited behavior differs');
  return { mode: 'local-deterministic-rehearsal', choice, real_model_calls: 0, actual_human_replies: 0, provider_calls: 0,
    substrate: 'strict in-memory Artifacts/Git protocol fixture', source_boundary: 'synthetic actors/replies; actual Node generated-app measurement; actual local native Workflow checked separately',
    peer_refusal: peerRefusal.outcome, firstPacket, secondPacket, endorsementPacket, released: finished.released, inherited: finished.inherited,
    measured, inheritedMeasured, model_allocation_usage: host.usage(), intervals: host.intervals, operations: host.operations,
    counters: host.checkpoint.counters, checkpoint_bytes: Buffer.byteLength(canonical(host.checkpoint)), checkpoint_digest: checkpointDigest(host.checkpoint),
    registry_entries: Object.keys(host.checkpoint.registry.entries).length, semantic_payload_bytes: Object.values(host.checkpoint.registry.entries).reduce((n, entry) => n + entry.locator!.size_bytes!, 0),
    artifact_mock_calls: fixture.strict.calls.filter(call => call !== 'dispose').length, pushes: fixture.strict.pushes, tokens_revoked: fixture.strict.revoked,
    handles_disposed: fixture.strict.disposed, adapter_reservations: fixture.budget.snapshot(), fresh_release_read: true, readback: finished.readback,
    inherited_acceptance_equal: true, inherited_observations_equal: true, release_replay_ref: finished.replay.ref,
    events: fixture.events, checkpoint: host.checkpoint, evidence_digest: digest(measured.evidence) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !process.argv[2].endsWith('.json')) throw new Error('Provide one local evidence JSON path; no live mode is supported.');
  const results = await Promise.all(['900', '1200'].map(choice => rehearseIntegratedDemo(choice as '900' | '1200')));
  await writeFile(path.resolve(process.argv[2]), JSON.stringify({ live_authorized: false, rehearsals: results }, null, 2) + '\n');
  console.log(JSON.stringify(results.map(({ choice, counters, registry_entries, pushes, checkpoint_bytes, artifact_mock_calls }) => ({ choice, counters, registry_entries, pushes, checkpoint_bytes, artifact_mock_calls })), null, 2));
}
