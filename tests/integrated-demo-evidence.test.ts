import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexSubscriptionActorRunner, defaultProcessRunner, DemoActorProcessError, type DemoActorProcessInvocation, type DemoActorTurnEvidence } from '../src/integrated-demo-actor-cli.js';
import { DemoHost } from '../src/integrated-demo-host.js';
import { IntegratedDemo, demoEvent, DEMO_LIMITS } from '../src/integrated-demo.js';
import { canonical, digest } from '../src/model.js';
import { preparedFixture, demoFixture, requireDemoOk, DEMO_NOW } from './integrated-demo-fixture.js';
import { measureDemoApp } from '../src/integrated-demo-runner.js';

async function endorsementFixture() {
  const { fixture } = await preparedFixture();
  requireDemoOk(await fixture.event('selection', 'operator', fixture.receipt('900')));
  const realized = requireDemoOk(await fixture.event('realize', 'host', {}));
  const measured = await measureDemoApp(realized.realization, 900);
  requireDemoOk(await fixture.event('evidence', 'runner', { evidence: measured.evidence, observations_digest: measured.observations_digest }));
  return fixture;
}

for (const fault of ['missing', 'corrupt', 'semantic'] as const) test('final read-back fails closed after staging: ' + fault, async () => {
  const fixture = await endorsementFixture(), before = structuredClone(fixture.checkpoint);
  const store = fixture.storage(), fresh = store.freshReader.bind(store);
  let reads = 0;
  store.freshReader = () => {
    reads++;
    const reader = fresh(), load = reader.load.bind(reader);
    reader.load = async registry => {
      assert.equal(Object.keys(registry.entries).length, 4);
      if (fault === 'missing') fixture.strict.missingRead = true;
      if (fault === 'corrupt') fixture.strict.corruptRead = true;
      const result = await load(registry);
      if (fault === 'semantic') Object.values(result.records).find(r => r.type === 'release')!.data.candidate = 'f'.repeat(64);
      return result;
    };
    return reader;
  };
  const event = demoEvent(before, 'endorse', 'operator', fixture.receipt('approve-release'), 'final-readback');
  const controller = new IntegratedDemo(store, () => DEMO_NOW);
  const reservation = controller.reserve(before, event), pushes = fixture.strict.pushes;
  const result = await controller.apply(before, event, reservation);
  assert.equal(reads, 1); assert.equal(fixture.strict.pushes, pushes + 1, 'Failure is after final staging, never before its read-back.');
  assert.equal(result.outcome.ok, false); assert.equal(result.checkpoint.phase, 'failed');
  assert.equal(canonical(result.checkpoint.registry), canonical(before.registry));
  assert.equal(result.checkpoint.counters.artifact_reserved, reservation.counters.artifact_reserved);
  const dispatches = fixture.strict.calls.length;
  const replay = await controller.apply(result.checkpoint, event);
  assert.equal(replay.reused, true); assert.equal(fixture.strict.calls.length, dispatches);
  assert.equal(result.outcome.error.code, fault === 'missing' ? 'STORE_UNAVAILABLE' : fault === 'corrupt' ? 'ARTIFACT_DIGEST' : 'DEMO_RELEASE_READBACK_FAILED');
});

test('fresh-reader reconstruction retains one run budget and exact measured references', async () => {
  const fixture = await endorsementFixture(), prior = fixture.budget.snapshot();
  const result = requireDemoOk(await fixture.event('endorse', 'operator', fixture.receipt('approve-release')));
  const receipt = result.readback, cp = fixture.checkpoint;
  assert.equal(receipt.registry_sha256, digest(cp.registry)); assert.equal(receipt.fresh_reader, true);
  assert.equal(receipt.realization_ref, cp.refs.realization); assert.equal(receipt.validation_ref, cp.refs.validation);
  assert.equal(receipt.inherited_realization_sha256, digest(result.inherited_realization));
  assert.ok(fixture.budget.snapshot().reserved.operations > prior.reserved.operations);
  assert.ok(cp.counters.artifact_reserved <= DEMO_LIMITS.artifact_dispatches);
  for (const [ref, entry] of Object.entries(receipt.fresh_entries)) assert.equal(canonical(entry), canonical(cp.registry.entries[ref]));
});

function invocation(code: string, timeout_ms = 2000, max_output_bytes = 4096): DemoActorProcessInvocation {
  return { executable: process.execPath, args: ['-e', code], cwd: process.cwd(), env: {}, stdin: '', timeout_ms, max_output_bytes, windows_hide: true, shell: false };
}
const start = `process.stdout.write('{"type":"turn.started"}\\n'); process.stderr.write('public-partial-stderr');`;
for (const [name, code, termination] of [
  ['malformed', start + `process.stdout.write('malformed\\n'); setInterval(()=>{},1000);`, 'malformed-jsonl'],
  ['timeout', start + 'setInterval(()=>{},1000);', 'timeout'],
  ['turn-ceiling', start + `process.stdout.write('{"type":"turn.started"}\\n');`, 'turn-limit'],
  ['missing-count', `process.stdout.write('{"type":"thread.started"}\\n');`, 'missing-turn-count'],
  ['output-limit', start + `process.stdout.write('x'.repeat(8192));`, 'output-limit']
] as const) test('real bounded Node subprocess preserves partial failure: ' + name, async () => {
  await assert.rejects(defaultProcessRunner(invocation(code, name === 'timeout' ? 500 : 2000), new AbortController().signal, 1), (error: unknown) => {
    assert.ok(error instanceof DemoActorProcessError);
    assert.equal(error.result.process!.termination, termination);
    assert.ok(Buffer.byteLength(error.result.stdout) <= 4096 && Buffer.byteLength(error.result.stderr) <= 4096);
    assert.ok(error.result.process!.duration_ms >= 0);
    if (name !== 'missing-count') assert.match(error.result.stdout, /turn.started/);
    return true;
  });
});

test('real subprocess cancellation and spawn failure retain honest unknown exit metadata', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(defaultProcessRunner(invocation(start), controller.signal, 1), (error: DemoActorProcessError) => {
    assert.equal(error.result.code, null); assert.equal(error.result.process!.termination, 'cancelled');
    assert.equal(error.result.process!.child_close_observed, false); return true;
  });
  await assert.rejects(defaultProcessRunner({ ...invocation(start), executable: path.join(os.tmpdir(), 'strata-no-executable-' + crypto.randomUUID()) }, new AbortController().signal, 1), (error: DemoActorProcessError) => {
    assert.equal(error.result.code, null); assert.equal(error.result.process!.termination, 'spawn-failed'); return true;
  });
});

test('cancelling a running real subprocess retains the output received before cancellation', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try { await assert.rejects(defaultProcessRunner(invocation(start + 'setInterval(()=>{},1000);'), controller.signal, 1), (error: DemoActorProcessError) => {
    assert.equal(error.result.process!.termination, 'cancelled');
    assert.equal(error.result.process!.child_spawned, true); assert.equal(error.result.process!.child_close_observed, true);
    assert.match(error.result.stdout, /turn.started/); assert.match(error.result.stderr, /public-partial/); return true;
  }); } finally { clearTimeout(timer); }
});

test('successful machine stream preserves split Unicode and trailing output after process exit', async () => {
  const code = start + `const b=Buffer.from(JSON.stringify({type:'item.completed',text:'שלום'})+'\\n');process.stdout.write(b.subarray(0,b.length-4));setTimeout(()=>{process.stdout.end(b.subarray(b.length-4));},10);`;
  const result = await defaultProcessRunner(invocation(code), new AbortController().signal, 1);
  assert.equal(result.code, 0); assert.equal(result.process!.child_close_observed, true);
  assert.match(result.stdout, /שלום/); assert.equal(result.turn_starts, 1);
});

for (const failure of ['malformed', 'custom'] as const) test('actor saves failed evidence once, masks bridge values and omits environment values: ' + failure, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-actor-partial-'));
  try {
    const entry = path.join(directory, 'codex-fixture.js');
    await writeFile(entry, start + `process.stdout.write(process.env.STRATA_DEMO_ACTOR_ENDPOINT+' '+process.env.STRATA_DEMO_ACTOR_CAPABILITY+'\\n');`);
    const fixture = demoFixture(), host = new DemoHost(fixture.checkpoint, fixture.sendEvent, () => DEMO_NOW, 'model-turn');
    host.bindThread('actor-a', 'a'); requireDemoOk(await host.event('bootstrap', 'host', {}));
    const saved: DemoActorTurnEvidence[] = [];
    const runner = new CodexSubscriptionActorRunner(host, { project_directory: process.cwd(), codex_entrypoint: entry,
      now: () => DEMO_NOW, run_expires_at: DEMO_NOW + DEMO_LIMITS.duration_ms, process_label: 'mock-codex-process',
      base_environment: { OPENAI_API_KEY: 'secret-not-forwarded', HOME: 'private-environment-value' }, save_evidence: async evidence => { saved.push(evidence); },
      ...(failure === 'custom' ? { run_process: async () => { throw new Error('unknown secret-not-retained'); } } : {}) });
    await assert.rejects(runner.run('a', 'actor-a'));
    await runner.settleActiveProcesses();
    assert.equal(saved.length, 1); assert.equal(saved[0].partial, true); assert.equal(saved[0].command!.environment_values_retained, false);
    assert.ok(saved[0].invocation.duration_ms >= 0); assert.equal(host.intervals.length, 1); assert.equal(host.intervals[0].cancelled, true);
    const bytes = JSON.stringify(saved); assert.doesNotMatch(bytes, /secret-not-forwarded|private-environment-value|unknown secret-not-retained|http:\/\/127\.0\.0\.1:\d+/);
    if (failure === 'malformed') {
      assert.equal(saved[0].process!.termination, 'malformed-jsonl'); assert.match(saved[0].codex_event_stream, /redacted-capability/);
    } else { assert.equal(saved[0].exit_code, null); assert.equal(saved[0].codex_event_stream, ''); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host keeps observed failed dispatch spans without pretending they succeeded', async () => {
  const fixture = demoFixture(); let clock = 0;
  const host = new DemoHost(fixture.checkpoint, async () => { throw new Error('fixture refusal'); }, () => ++clock);
  await assert.rejects(host.event('bootstrap', 'host', {}));
  assert.deepEqual(host.operations, [{ source: 'host', kind: 'bootstrap', received: 1, executing: 2, completed: 3, outcome: 'threw' }]);
});

test('uncertain child teardown blocks remote cleanup admission and truncated bridge values are masked', async () => {
  const fixture = demoFixture(), host = new DemoHost(fixture.checkpoint, fixture.sendEvent, () => DEMO_NOW);
  host.bindThread('actor-a', 'a'); requireDemoOk(await host.event('bootstrap', 'host', {}));
  const saved: DemoActorTurnEvidence[] = []; let prefix = '';
  const runner = new CodexSubscriptionActorRunner(host, { project_directory: process.cwd(), codex_entrypoint: 'synthetic-only.js',
    now: () => DEMO_NOW, run_expires_at: DEMO_NOW + DEMO_LIMITS.duration_ms, process_label: 'mock-codex-process',
    save_evidence: async evidence => { saved.push(evidence); }, run_process: async invocation => {
      prefix = invocation.env.STRATA_DEMO_ACTOR_CAPABILITY!.slice(0, 19);
      throw new DemoActorProcessError({ code: null, stdout: '{"type":"turn.started"}\n' + prefix, stderr: '', turn_starts: 1,
        process: { started_at: DEMO_NOW, ended_at: DEMO_NOW + 1, duration_ms: 1, signal: null, termination: 'output-limit',
          output_truncated: true, child_spawned: true, child_close_observed: false } });
    } });
  await assert.rejects(runner.run('a', 'actor-a'));
  assert.equal(saved.length, 1); assert.equal(JSON.stringify(saved).includes(prefix), false);
  assert.match(saved[0].codex_event_stream, /redacted-truncated-bridge-value/);
  await assert.rejects(runner.settleActiveProcesses(), (error: any) => error.code === 'DEMO_ACTOR_TEARDOWN_UNCERTAIN');
});
