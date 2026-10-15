// Offline provider-envelope regressions, generated from synthetic engine checkpoints.
import { writeFile } from 'node:fs/promises';
import { demoFixture } from '../tests/integrated-demo-fixture.js';
import { checkpointDigest, demoEvent } from '../src/integrated-demo.js';
import { digest } from '../src/model.js';

const f = demoFixture('controlled-private');
await f.event('bootstrap', 'host', {});
const initial = structuredClone(f.initialCheckpoint), checkpoint = structuredClone(f.checkpoint);
const storage = { format: 'strata-artifacts-registry/1' as const, project_id: initial.project_id,
  account: 'a'.repeat(32), namespace: 'synthetic-namespace', repository: 'synthetic-repository', mode: 'remote' as const };
initial.registry.storage = storage; checkpoint.registry.storage = { ...storage };
initial.management_cleanup = { unsettled_dispatches: 0, repo_tokens_issued: 1, repo_tokens_revoked: 1, handles_open: 0 };
checkpoint.previous_digest = checkpointDigest(initial);
checkpoint.management_cleanup = { ...initial.management_cleanup, repo_tokens_issued: 2, repo_tokens_revoked: 2 };
const event = demoEvent(initial, 'bootstrap', 'host', {}, 'host-1');
const outcome = { ok: true as const, data: { ref: 'R0@1', reused: false } };
checkpoint.requests = { 'host-1': { event_digest: digest(event), outcome } };
const complete = { checkpoint, outcome, reused: false };
const step = (name: string, output: unknown) => ({ name, type: 'step', success: true, output, attempts: [{ success: true, error: null }] });
const running = { id: 'run-' + initial.run_id, params: { run_id: initial.run_id }, status: 'running', step_count: 5, steps: [
  step('claim-run-1', JSON.stringify(initial)),
  { name: 'receive-1-1', type: 'waitForEvent', finished: true, event_type: 'strata-demo-1', output: JSON.stringify(event) },
  step('reserve-1-1', JSON.stringify(initial)),
  step('apply-1-1', JSON.stringify(complete).slice(0, 1300) + '[truncated output]'),
  { name: 'receive-2-1', type: 'waitForEvent', finished: false, event_type: 'strata-demo-2' }
] };
const label = 'Synthetic provider response shape with exact local checkpoint chain. No provider execution or retained operational record.';
const files = {
  'tests/fixtures/integrated-demo-cf-full-step.json': { evidence: label, running,
    full_step: { success: true, errors: [], messages: [], result: { status: 'complete', error: null, output: complete } } },
  'tests/fixtures/integrated-demo-provider-truncation.json': { label, running, terminal: { checkpoint } }
};
for (const [file, value] of Object.entries(files)) await writeFile(file, JSON.stringify(value, null, 2) + '\n');
console.log(JSON.stringify({ fixtures: Object.keys(files), source: 'synthetic-fixture' }));
