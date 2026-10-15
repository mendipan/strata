import { DEMO_LAB } from './demo-lab-fixture.js';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startDemoBrowser } from '../scripts/integrated-demo-browser.js';
import { createBrowserDemoLab } from '../src/demo-browser-lab.js';
import { DEMO_ACTIVATION_SOURCE_FILES, readDemoActivationSource } from '../src/integrated-demo-activation.js';
import { IntegratedDemo, initialDemoCheckpoint, demoEvent, rehearsalLayer } from '../src/integrated-demo.js';
import { StrictArtifacts } from './artifacts-fixture.js';
import { ArtifactRegistryStore } from '../src/artifact-registry.js';
import { RunBudget } from '../src/budget.js';
import { LOCAL_PROJECT } from '../src/security.js';
import { digest } from '../src/model.js';
import { operatorPromptPacketFromCheckpoint } from '../src/integrated-demo-operator-reply.js';
import { measureDemoApp } from '../src/integrated-demo-runner.js';

export async function startMockRunBrowser(options: { repair?: boolean; cleanup_blocked?: boolean; actor_failure?: boolean; startup_failure?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-run-ui-mock-'));
  for (const file of DEMO_ACTIVATION_SOURCE_FILES) { const destination = path.join(root, file); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(file, destination); }
  const infrastructure = { policy: 'retain-private-worker-workflow' as const, workflow_id: '11111111-1111-4111-8111-111111111111', worker_version_id: '22222222-2222-4222-8222-222222222222', workflow_version_id: '33333333-3333-4333-8333-333333333333' };
  await mkdir(path.join(root, '.strata'));
  const source = await readDemoActivationSource(root);
  await writeFile(path.join(root, '.strata/demo-lab-profile.json'), JSON.stringify({ format: 'strata.browser-demo-lab/1', target: DEMO_LAB, source_sha256: source.sha256, infrastructure, diagnostic_passed: true, diagnostic_instance_absent: true, evidence: 'SYNTHETIC offline mock', recorded_at: new Date().toISOString() }));
  let starts = 0;
  const lab = await startDemoBrowser(root, false, options.repair !== false, (r, o) => createBrowserDemoLab(r, { ...o, presentation_mode: 'synthetic-fixture',
    check: async (_root, _profile, record) => { await record('SYNTHETIC local source/limits check; no provider calls'); },
    run: async (args, ports = {}) => {
      starts++; const grant = JSON.parse(await readFile(args[1], 'utf8'));
      const out = args[2]; await mkdir(out, { recursive: true });
      const journal = { instance_create_requested: true, in_flight: null, reconciliation_required: options.cleanup_blocked === true, history: [],
        cleanup: {} as Record<string, boolean>, counters: { unsettled_dispatches: 0, handles_open: 0 } };
      const strict = new StrictArtifacts(), budget = new RunBudget({ operations: 2000, bytes: 64 * 1024 * 1024, attempts: 2000, duration_ms: 1800000, input_tokens: 0, output_tokens: 0 });
      const storage = new ArtifactRegistryStore(strict.adapter(budget), LOCAL_PROJECT), engine = new IntegratedDemo(storage);
      let checkpoint = initialDemoCheckpoint(grant.target.run_id, storage), lastOutcome: any;
      const emit = async (record: any) => { await ports.emit?.(record); };
      const event = async (kind: any, actor: any, input: any) => {
        const e = demoEvent(checkpoint, kind, actor, input, 'mock-' + (checkpoint.sequence + 1)), result = await engine.apply(checkpoint, e);
        checkpoint = result.checkpoint; lastOutcome = result.outcome;
        await emit({ type: 'workflow-event', kind, source: actor, sequence: checkpoint.sequence, phase: checkpoint.phase, checkpoint_digest: digest(checkpoint), outcome: result.outcome,
          ...(kind === 'actor' ? { command: input.command, ...(['layer.create', 'layer.revise'].includes(input.command) ? { proposal: input.input.record } : {}) } : {}) });
        if (!result.outcome.ok) throw Error(result.outcome.error.code); return result.outcome.data;
      };
      const author = async (a: 'a' | 'b' | 'c', repaired = false, launched = false) => {
        if (!launched) await emit({ type: 'actor-launching', actor: a, assigned_revision: repaired ? 2 : 1, model: 'synthetic fixture', reasoning_effort: 'none' });
        const record = rehearsalLayer(a, repaired);
        await event('actor', 'actor:' + a, { command: repaired ? 'layer.revise' : 'layer.create', input: { record, ...(repaired ? { previous: 'L-reminder@1' } : {}) } });
        await event('actor', 'actor:' + a, { command: 'layer.publish', input: { ref: record.id + '@' + record.revision } });
        await emit({ type: 'actor-finished', actor: a, assigned_revision: repaired ? 2 : 1, model: 'synthetic fixture', execution: 'mock-codex-process', turn_starts: 0, tool_calls: 2 });
      };
      const decision = async () => {
        const packet = operatorPromptPacketFromCheckpoint(checkpoint, lastOutcome);
        await emit({ type: 'operator-pause', packet });
        const response = await ports.decide!(packet, ports.signal!);
        // Deliberately delay acknowledgement so UI must distinguish controller
        // receipt from authoritative semantic acceptance.
        await new Promise(resolve => setTimeout(resolve, 1600));
        return event(packet.phase === 'selection' ? 'selection' : 'endorse', 'operator', { source: 'synthetic-rehearsal', message_id: 'synthetic-' + checkpoint.sequence,
          received_at: new Date().toISOString(), packet_digest: packet.packet_digest, action: response.action, text: response.reason });
      };
      try {
        await emit({ type: 'provisioning-started' });
        if (options.startup_failure) throw Object.assign(Error('Synthetic start failed after Begin was recorded.'), { code: 'DEMO_PROVIDER_WORKER_NOT_FOUND' });
        await event('bootstrap', 'host', {});
        for (const a of ['a', 'c']) await emit({ type: 'actor-launching', actor: a, assigned_revision: 1, model: 'synthetic fixture', reasoning_effort: 'none' });
        if (options.actor_failure) throw Object.assign(Error('Synthetic actor interruption.'), { code: 'MOCK_ACTOR_FAILED' });
        await author('a', false, true); await author('c', false, true); await author('b'); await event('prepare', 'host', {});
        let selected = await decision();
        if (selected.repair_required) {
          if (grant.limits.actor_processes !== 4) throw Object.assign(Error('Synthetic three-process grant stops at repair gate.'), { code: 'DEMO_OPERATOR_REPAIR_REQUIRED' });
          await author('b', true); await event('prepare', 'host', {}); selected = await decision();
        }
        if (!selected.aborted) {
          const realized = await event('realize', 'host', {}), measured = await measureDemoApp(realized.realization, realized.selected_seconds);
          await event('evidence', 'runner', { evidence: measured.evidence, observations_digest: measured.observations_digest });
          await emit({ type: 'measurement-verified', ...measured });
          const finish = await decision();
          if (!finish.aborted) {
            const inherited = await measureDemoApp(finish.inherited_realization, realized.selected_seconds);
            await emit({ type: 'release-verified', released: finish.released, inherited: finish.inherited, evidence: measured.evidence,
              inherited_observations_equal: digest(inherited.observations) === digest(measured.observations) });
          }
        }
        return { released: null, cleanup: journal, live_authorized: false, model_availability_verified: false };
      } catch (error) {
        if (!['complete', 'aborted'].includes(checkpoint.phase)) await event('stop', 'host', {});
        throw error;
      } finally {
        await emit({ type: 'cleanup-started' });
        Object.assign(journal.cleanup, { terminal_instance_verified: true, local_dispatches_settled: true, repo_tokens_clean: true, handles_disposed: true,
          instance_absent: true, repository_absent: !options.cleanup_blocked, namespace_empty_verified: true, workflow_retained_verified: true, worker_retained_verified: true, worker_delete_requested: false, workflow_delete_requested: false });
        journal.counters.unsettled_dispatches = 0; journal.counters.handles_open = 0;
        await writeFile(path.join(out, 'management-journal.json'), JSON.stringify(journal));
        await emit(options.cleanup_blocked ? { type: 'cleanup-blocked', code: 'MOCK_CLEANUP_BLOCKED' } : { type: 'cleanup-verified', cleanup: journal });
      }
    } }));
  await lab.settled();
  return { ...lab, root, starts: () => starts, async close() { await lab.close(); await rm(root, { recursive: true, force: true }); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mock = await startMockRunBrowser(); console.log('SYNTHETIC UI MOCK: no paid models, provider calls, real actors or human consent. ' + mock.url);
  process.once('SIGINT', () => void mock.close());
}
