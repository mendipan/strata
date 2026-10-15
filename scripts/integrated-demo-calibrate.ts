import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { demoFixture, DEMO_NOW } from '../tests/integrated-demo-fixture.js';
import { IntegratedDemo, checkpointDigest, DEMO_LIMITS, type DemoEvent } from '../src/integrated-demo.js';
import { canonical } from '../src/model.js';

export async function calibrateIntegratedDemo(rehearsals: any[]) {
  const size = (value: unknown) => Buffer.byteLength(canonical(value)), branches = [];
  for (const recorded of rehearsals) {
    if (recorded.mode !== 'local-deterministic-rehearsal' || recorded.real_model_calls !== 0 || recorded.actual_human_replies !== 0 || recorded.provider_calls !== 0) throw new Error('Only explicit synthetic local rehearsal evidence accepted.');
    const fixture = demoFixture(); let logicalState = size(fixture.checkpoint), cumulativeDescribe = 0; const spans = [];
    for (const event of recorded.events as DemoEvent[]) {
      const controller = new IntegratedDemo(fixture.storage(), () => DEMO_NOW), reserved = controller.reserve(fixture.checkpoint, event);
      const before = fixture.strict.calls.filter(call => call !== 'dispose').length;
      const applied = await fixture.sendEvent(event);
      if (!applied.outcome.ok && event.kind !== 'actor') throw new Error(applied.outcome.error.code);
      logicalState += size(event) + size(reserved) + size(applied);
      const logicalDescribe: number = logicalState + size(applied.checkpoint) + 512 * (1 + spans.length * 3); cumulativeDescribe += logicalDescribe;
      spans.push({ sequence: event.sequence, kind: event.kind, source: event.source,
        artifact_mock_dispatches: fixture.strict.calls.filter(call => call !== 'dispose').length - before,
        event_bytes: size(event), checkpoint_bytes: size(applied.checkpoint), approximate_logical_describe_bytes: logicalDescribe });
    }
    if (checkpointDigest(fixture.checkpoint) !== recorded.checkpoint_digest) throw new Error('Replayed calibration differs from reviewed evidence.');
    branches.push({ choice: recorded.choice, event_count: spans.length, commands: recorded.counters.commands, stage_batches: recorded.pushes, records: recorded.registry_entries,
      max_event_bytes: Math.max(...spans.map(span => span.event_bytes)), max_checkpoint_bytes: Math.max(...spans.map(span => span.checkpoint_bytes)),
      max_artifact_dispatches_per_apply: Math.max(...spans.map(span => span.artifact_mock_dispatches)), artifact_dispatches_scenario: spans.reduce((n, span) => n + span.artifact_mock_dispatches, 0),
      final_cold_read_dispatches: recorded.registry_entries * 3, original_semantic_payload_bytes: recorded.semantic_payload_bytes,
      artifact_reserved_dispatches: recorded.counters.artifact_reserved, artifact_reserved_transfer_bytes: recorded.counters.transfer_reserved, original_reserved_bytes: recorded.counters.original_reserved,
      approximate_logical_workflow_step_state_bytes: logicalState, approximate_logical_describe_bytes_final: spans.at(-1)!.approximate_logical_describe_bytes,
      approximate_one_describe_each_cumulative_bytes: cumulativeDescribe,
      measurement_limit: 'Logical JSON sizes plus illustrative log envelope only; provider encoding/state billing, CPU and control-plane transfer are unmeasured.', spans });
  }
  return { mode: 'local-only-calibration', live_authorized: false, provider_calls: 0, limits: DEMO_LIMITS, branches };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || !process.argv[2].endsWith('.json') || !process.argv[3].endsWith('.json')) throw new Error('Provide local rehearsal and output JSON paths; no live mode.');
  const input = await readFile(path.resolve(process.argv[2]), 'utf8'); if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Input exceeds local bound.');
  const result = await calibrateIntegratedDemo(JSON.parse(input).rehearsals);
  await writeFile(path.resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result.branches.map(({ spans, ...summary }) => summary), null, 2));
}
