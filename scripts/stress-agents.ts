import { mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { bootstrap, proposal, recipe, criterion } from '../src/fixtures.js';
import { expiryRequirement } from '../src/profile.js';
import { normalizeLayer } from '../src/core.js';
import { normalizeSnapshot, digest, canonical } from '../src/model.js';
import { RunBudget } from '../src/budget.js';
import { measuredOverlap, latencies, formatStressEvidence, type WorkSpan } from '../src/trace.js';
import { localRuntime } from './local-runtime.js';
import { demoAt } from './demo.js';

const argv = process.argv.slice(2), json = argv.includes('--json'), countValue = argv[argv.indexOf('--actors') + 1];
if (argv.some((a, i) => !['--actors', '--json', '100', '1000'].includes(a)) || !['100', '1000'].includes(countValue) || argv.filter(a => a === '--actors').length !== 1) throw new Error('Usage: stress-agents --actors 100|1000 [--json]');
const actors = Number(countValue), window = actors === 100 ? 16 : 32;
const root = process.cwd(), directory = path.join(root, '.strata/sdk-stress-' + actors + '-' + Date.now());
await mkdir(directory, { recursive: true });
const budget = new RunBudget({ operations: actors * 6 + 50, bytes: 256 * 1024 * 1024, input_tokens: 0, output_tokens: 0, attempts: actors * 6 + 50, duration_ms: actors === 100 ? 600000 : 1200000 });
const spans: WorkSpan[] = [], times: Record<string, number[]> = {}, failures: { command: string; code: string }[] = [];
let runtime: Awaited<ReturnType<typeof localRuntime>> | undefined, report: any;
let completedActors = 0;
async function operation(command: string, input: unknown, session = 'fixture-reader', options: any = {}, expectFailure = false) {
  const body = JSON.stringify({ command, input, options }); budget.reserve({ operations: 1, attempts: 1, bytes: Buffer.byteLength(body) });
  const started = performance.now();
  const response = await fetch(runtime!.url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': session }, body, signal: AbortSignal.timeout(Math.min(30000, budget.remainingMs())) });
  const text = await response.text(); budget.reserve({ bytes: Buffer.byteLength(text) });
  const result = JSON.parse(text); (times[command] ??= []).push(performance.now() - started);
  if (!result.ok && !expectFailure) { failures.push({ command, code: result.error?.code ?? 'HTTP_ERROR' }); throw new Error(command + ': ' + (result.error?.code ?? response.status)); }
  if (result.trace && !result.reused) spans.push(...result.trace);
  return result;
}
async function boundedMap<T>(items: T[], action: (item: T, index: number) => Promise<void>) {
  let next = 0; const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(window, items.length) }, async () => {
    while (next < items.length && !errors.length) {
      const index = next++;
      try { await action(items[index], index); } catch (error) { errors.push(error); }
    }
  }));
  if (errors.length) throw errors[0];
}
async function diskBytes(dir: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    try { if (entry.isDirectory()) size += await diskBytes(file); else if (entry.isFile()) size += (await stat(file)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // SQLite removes/checkpoints transient -shm/-wal files during sampling.
  }
  return size;
}
try {
  if (actors === 1000 && os.freemem() < 1024 * 1024 * 1024) throw new Error('Resource guard: less than 1 GiB available memory; 1,000-actor run skipped.');
  runtime = await localRuntime(root, directory);
  await operation('init', { record: bootstrap() }, 'fixture-bootstrap');
  const baselineBefore = (await operation('inspect', { type: 'release', ref: 'R0@1' })).data;
  const layers = Array.from({ length: actors }, (_, i) => {
    const owner = ['author-a', 'author-b', 'author-c'][i % 3], layer = proposal(`stress-${actors}-${i.toString().padStart(4, '0')}`, owner);
    if (i % 10 < 7) layer.acceptance = [{ block: 'booking.hold', id: 'actor-' + i, criterion: criterion('booking.expiry', 'actor-' + i, ['booking.hold/requirements.expiry']) }];
    else layer.changes = [{ op: 'set_item', block: 'booking.hold', path: 'requirements.expiry', expected: { kind: 'value', value: expiryRequirement(600) }, value: expiryRequirement(i % 10 === 9 ? 1200 : 900) }];
    return layer;
  });
  const phaseStart = Date.now();
  for (let offset = 0; offset < layers.length; offset += window) {
    // Leave 16 MiB for the bounded final in-flight batch and evidence/cleanup.
    if (await diskBytes(directory) > 240 * 1024 * 1024) throw new Error('Resource guard: stopping before the 256 MiB local test data cap.');
    await boundedMap(layers.slice(offset, offset + window), async (layer, index) => {
      const i = offset + index, session = ['fixture-a', 'fixture-b', 'fixture-c'][i % 3];
      const draft = await operation('layer.create', { record: layer }, session, { idempotency_key: 'create-' + i });
      await operation('layer.publish', { ref: draft.data.ref }, session, { idempotency_key: 'publish-' + i });
      completedActors++;
    });
  }
  const actorElapsed = Date.now() - phaseStart;
  let verified = 0;
  await boundedMap(layers, async layer => {
    const record = (await operation('inspect', { type: 'layer', ref: layer.id + '@1' })).data;
    if (canonical(record) !== canonical(normalizeLayer(layer, normalizeSnapshot(bootstrap())))) throw new Error('Immutable Layer integrity mismatch.');
    verified++;
  });
  const baselineAfter = (await operation('inspect', { type: 'release', ref: 'R0@1' })).data;
  if (digest(baselineAfter) !== digest(baselineBefore)) throw new Error('Pinned baseline changed.');
  const all = recipe('C-stress-all-' + actors); all.alternative_groups = []; all.proposals = all.selected = layers.map(l => l.id + '@1');
  const blocked = (await operation('compose', { record: all }, 'fixture-preparer')).data;
  if (blocked.state !== 'blocked' || !blocked.diagnostics.some((d: any) => d.code === 'ITEM_COLLISION')) throw new Error('Conflicting writes were not blocked.');
  const compatible = recipe('C-stress-compatible-' + actors); compatible.alternative_groups = []; compatible.proposals = compatible.selected = layers.filter((_, i) => i % 10 !== 9).map(l => l.id + '@1');
  const merged = (await operation('compose', { record: compatible }, 'fixture-preparer')).data;
  if (merged.state !== 'eligible_for_validation' || merged.provenance['booking.hold/requirements.expiry']?.length !== actors / 5) throw new Error('Compatible writes did not coalesce with complete provenance.');
  const peer = await operation('layer.revise', { previous: layers[0].id + '@1', record: { ...layers[0], owner: 'author-b', revision: 2 } }, 'fixture-b', {}, true);
  if (peer.error?.code !== 'OWNER_FORBIDDEN') throw new Error('Peer owner guard failed.');
  const duplicate = await Promise.all([0, 1].map(() => operation('layer.create', { record: layers[0] }, 'fixture-a', { idempotency_key: 'create-0' })));
  if (!duplicate.every(r => r.ok && r.reused && r.data.ref === layers[0].id + '@1')) throw new Error('Duplicate request did not reuse the exact publication.');
  const stale = await operation('layer.revise', { previous: layers[0].id + '@0', record: { ...layers[0], revision: 2 } }, 'fixture-a', {}, true);
  if (stale.ok || !['REF_NOT_FOUND', 'STALE_REVISION'].includes(stale.error?.code)) throw new Error('Stale revision guard returned: ' + JSON.stringify(stale.error));
  // Real SDK fault recovery, in addition to the pure CAS unit checks.
  const recoveryLayer = proposal('stress-recovery-' + actors, 'bootstrap');
  const staged = await operation('layer.create', { record: recoveryLayer }, 'fixture-bootstrap', { fault: 'after-stage', idempotency_key: 'recover-stage' }, true);
  if (staged.error?.code !== 'INJECTED_STAGE_FAILURE') throw new Error('Stage fault fixture failed.');
  const absent = await operation('inspect', { type: 'layer', ref: recoveryLayer.id + '@1' }, 'fixture-bootstrap', {}, true);
  if (absent.error?.code !== 'REF_NOT_FOUND') throw new Error('Uncommitted staged artifact became visible.');
  const committed = await operation('layer.create', { record: recoveryLayer }, 'fixture-bootstrap', { fault: 'after-commit', idempotency_key: 'recover-stage' }, true);
  if (committed.error?.code !== 'INJECTED_RESPONSE_LOSS') throw new Error('Commit response-loss fixture failed.');
  const recovered = await operation('layer.create', { record: recoveryLayer }, 'fixture-bootstrap', { idempotency_key: 'recover-stage' });
  if (!recovered.reused) throw new Error('Committed Layer did not recover by idempotent retry.');
  // One existing executable-app/release workflow verifies the refactored SDK path;
  // 1,000 actors does not repeat this unchanged workflow.
  let workflow: Awaited<ReturnType<typeof demoAt>> | null = null;
  if (actors === 100) {
    // Conservative allowance for the CLI workflow's nested preflight/read requests.
    budget.reserve({ operations: 50, attempts: 50, bytes: 8 * 1024 * 1024 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { workflow = await Promise.race([demoAt(root, runtime.url, 'cloudflare-agents'), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Budget deadline during executable workflow.')), budget.remainingMs()); })]); }
    finally { clearTimeout(timer); }
  }
  const stored = await diskBytes(directory);
  if (stored > 256 * 1024 * 1024) throw new Error('Local test data exceeded the 256 MiB guard.');
  report = { status: 'passed', runtime: 'local-workerd-cloudflare-agents-sdk', actors, actor_kind: 'deterministic-scripted-sdk-actors', model_calls: 0, codex_subprocess_agents: 0, cloud_calls: 0, fixture_principals: 3, max_open_actor_requests: window,
    actor_elapsed_ms: actorElapsed, completed_actors: completedActors, local_wrangler_trace_collector: 'disabled with installed Wrangler X_LOCAL_OBSERVABILITY; own phase evidence retained', failures, latency: Object.fromEntries(Object.entries(times).map(([phase, values]) => [phase, latencies(values)])),
    actual_server_work_overlap: measuredOverlap(spans, ['hash', 'storage-io']), native_hash_overlap: measuredOverlap(spans, ['hash']), storage_io_overlap: measuredOverlap(spans, ['storage-io']), publication_overlap: measuredOverlap(spans, ['publication']),
    concurrency_limits: 'Concurrent submitted native hash/persistence jobs, measured inside server actors. This does not measure CPU parallelism, LLM inference, cloud throughput, or all actors running simultaneously. Publication stays serialized.',
    integrity: { verified_immutable_layers: verified, published_layers: actors, baseline_unchanged: true, expected_collision_diagnostics: blocked.diagnostics.filter((d: any) => d.code === 'ITEM_COLLISION').length, compatible_selected: compatible.selected.length, coalesced_expiry_contributors: merged.provenance['booking.hold/requirements.expiry'].length, peer_write_refused: true, stale_revision_refused: true, duplicate_publication_reused: true, stage_failure_unpublished: true, committed_response_loss_recovered: true },
    executable_workflow: workflow ? { commands: workflow.trace.length, release: workflow.release, retry_same_release: workflow.retry_same_release, evidence: workflow.evidence, inherited_duration: workflow.inherited_duration, inherited_reminders: workflow.inherited_reminders, inherited_layer_acceptance: workflow.inherited_layer_acceptance } : 'verified in the 100-actor run',
    local_test_data_bytes: stored, budget: budget.snapshot() };
} catch (error) { budget.stop(); report = { status: 'failed-or-resource-blocked', actors, completed_actors: completedActors, actor_kind: 'deterministic-scripted-sdk-actors', model_calls: 0, cloud_calls: 0, message: (error as Error).message, failures, latency: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, latencies(v)])), partial_server_work_overlap: measuredOverlap(spans, ['hash', 'storage-io']), budget: budget.snapshot() }; process.exitCode = 9; }
finally {
  try { await runtime?.close(); report.local_listener_closed = true; } catch (error) { report.local_listener_closed = false; report.cleanup_error = (error as Error).message; process.exitCode = 9; }
  await writeFile(path.join(directory, 'server-spans.json'), JSON.stringify(spans) + '\n');
  report.evidence = { result: path.join(directory, 'result.json'), spans: path.join(directory, 'server-spans.json') };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(json ? JSON.stringify(report) + '\n' : formatStressEvidence(report));
}
