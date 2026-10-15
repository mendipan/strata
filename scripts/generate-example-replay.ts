// Reproducible offline example from engine events. No retained application or provider records.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { demoFixture, requireDemoOk } from '../tests/integrated-demo-fixture.js';
import { rehearsalLayer } from '../src/integrated-demo.js';
import { DemoRunPresentation } from '../src/demo-run-presentation.js';
import { operatorPromptPacketFromCheckpoint } from '../src/integrated-demo-operator-reply.js';
import { measureDemoApp } from '../src/integrated-demo-runner.js';
import { digest } from '../src/model.js';
import type { RunReplay } from '../src/demo-run-replay.js';

export async function generateExampleReplay(): Promise<RunReplay> {
  const f = demoFixture(), view = new DemoRunPresentation(f.checkpoint.run_id, 'recorded-replay');
  const chapters: RunReplay['chapters'] = [];
  const chapter = (title: string, recorded_choice?: string) => chapters.push({ title, ...(recorded_choice ? { recorded_choice } : {}), view: view.snapshot() });
  const event = async (kind: any, source: any, input: any) => {
    const result = await f.event(kind, source, input);
    view.accept({ type: 'workflow-event', kind, source, sequence: result.checkpoint.sequence, phase: result.checkpoint.phase,
      checkpoint_digest: digest(result.checkpoint), outcome: result.outcome,
      ...(kind === 'actor' ? { command: input.command, ...(['layer.create', 'layer.revise'].includes(input.command) ? { proposal: input.input.record } : {}) } : {}) });
    return requireDemoOk(result);
  };
  const author = async (actor: 'a' | 'b' | 'c', repaired = false) => {
    view.accept({ type: 'actor-launching', actor, assigned_revision: repaired ? 2 : 1, model: 'synthetic fixture', reasoning_effort: 'none' });
    const record = rehearsalLayer(actor, repaired);
    await event('actor', `actor:${actor}`, { command: repaired ? 'layer.revise' : 'layer.create', input: { record, ...(repaired ? { previous: 'L-reminder@1' } : {}) } });
    await event('actor', `actor:${actor}`, { command: 'layer.publish', input: { ref: record.id + '@' + record.revision } });
    view.accept({ type: 'actor-finished', actor, assigned_revision: repaired ? 2 : 1, execution: 'synthetic-fixture' });
  };
  const review = (outcome: any) => view.review(operatorPromptPacketFromCheckpoint(f.checkpoint, { ok: true, data: outcome }));
  await event('bootstrap', 'host', {});
  await event('actor', 'actor:a', { command: 'inspect', input: { type: 'release', ref: 'R0@1' } });
  chapter('Synthetic pinned baseline');
  for (const actor of ['a', 'c', 'b'] as const) await author(actor);
  chapter('Published owned example proposals');
  review(await event('prepare', 'host', {})); chapter('First simulated choice', '1200');
  await event('selection', 'operator', f.receipt('1200')); chapter('20 minutes requires reminder repair');
  await author('b', true); chapter('Same owner. New revision.');
  review(await event('prepare', 'host', {})); chapter('Review the revised reminder', '1200');
  await event('selection', 'operator', f.receipt('1200'));
  const realized = await event('realize', 'host', {}); chapter('Selected Composition and local realization');
  const measured = await measureDemoApp(realized.realization, 1200);
  const packet = await event('evidence', 'runner', { evidence: measured.evidence, observations_digest: measured.observations_digest });
  view.accept({ type: 'measurement-verified', ...measured }); review(packet); chapter('Separate simulated Release approval', 'approve-release');
  const finished = await event('endorse', 'operator', f.receipt('approve-release'));
  const inherited = await measureDemoApp(finished.inherited_realization, 1200);
  view.accept({ type: 'release-verified', released: finished.released, inherited: finished.inherited,
    inherited_observations_equal: digest(inherited.observations) === digest(measured.observations) });
  chapter('Locally measured Release and inherited behavior'); chapter('Synthetic example complete; no cloud resources used');
  const body = { format: 'strata-recorded-demo-replay/1' as const, run_id: f.checkpoint.run_id,
    provenance: 'Synthetic example generated from local engine events by scripts/generate-example-replay.ts. Scripted actors and approvals; actual local generated-app measurement. No human consent, model calls, provider execution or external application records.',
    timing: 'Deterministic fixture time and event order only. No wall-clock performance claim; playback delays are illustrative.',
    evidence_manifest: {}, chapters };
  return { ...body, bundle_sha256: digest(body) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = path.resolve('examples/replay/synthetic-run.json');
  const replay = await generateExampleReplay();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(replay, null, 2) + '\n');
  console.log(JSON.stringify({ output, chapters: replay.chapters.length, sha256: replay.bundle_sha256, source: 'synthetic-fixture' }));
}
