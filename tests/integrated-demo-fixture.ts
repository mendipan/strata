import { ArtifactRegistryStore } from '../src/artifact-registry.js';
import { RunBudget } from '../src/budget.js';
import { StrictArtifacts } from './artifacts-fixture.js';
import { IntegratedDemo, initialDemoCheckpoint, demoEvent, rehearsalLayer, type DemoCheckpoint, type DemoActor, type DemoKind, type DemoEvent, type HumanReceipt } from '../src/integrated-demo.js';
import { DemoHost } from '../src/integrated-demo-host.js';
import { LOCAL_PROJECT } from '../src/security.js';

export const DEMO_NOW = Date.parse('2026-10-05T00:00:00Z');
export function demoFixture(mode: DemoCheckpoint['mode'] = 'local-rehearsal', startedAt = DEMO_NOW) {
  let now = startedAt;
  const strict = new StrictArtifacts(), budget = new RunBudget({ operations: 2000, bytes: 64 * 1024 * 1024, attempts: 2000, duration_ms: 1800000, input_tokens: 0, output_tokens: 0 }, () => now);
  const adapter = strict.adapter(budget), storage = () => new ArtifactRegistryStore(adapter, LOCAL_PROJECT);
  let checkpoint = initialDemoCheckpoint('0a1b2c3d4e5f6789', storage(), mode, now);
  const initialCheckpoint = structuredClone(checkpoint);
  const events: DemoEvent[] = [], outputs: any[] = [];
  async function sendEvent(event: DemoEvent) {
    const controller = new IntegratedDemo(storage(), () => now); // fresh controller over one run-scoped bounded adapter
    const result = await controller.apply(checkpoint, event); checkpoint = result.checkpoint;
    events.push(structuredClone(event)); outputs.push(structuredClone(result)); return result;
  }
  async function event(kind: DemoKind, source: DemoEvent['source'], input: any) { return sendEvent(demoEvent(checkpoint, kind, source, input, 'fixture-' + (checkpoint.sequence + 1))); }
  const receipt = (action: HumanReceipt['action']): HumanReceipt => ({ source: 'synthetic-rehearsal', message_id: 'synthetic-' + (checkpoint.sequence + 1),
    received_at: new Date(now).toISOString(), packet_digest: checkpoint.pending!.digest, action, text: 'Explicit synthetic rehearsal reply; no actual human consent or live authority.' });
  return { strict, budget, storage, event, sendEvent, receipt, events, outputs, initialCheckpoint, get checkpoint() { return checkpoint; }, setNow: (value: number) => { now = value; } };
}
export function requireDemoOk(result: any): any { if (!result.outcome.ok) throw new Error(result.outcome.error.code); return result.outcome.data; }
export async function authorFixture(fixture: ReturnType<typeof demoFixture>, actor: DemoActor, repaired = false) {
  const record = rehearsalLayer(actor, repaired);
  requireDemoOk(await fixture.event('actor', `actor:${actor}`, { command: repaired ? 'layer.revise' : 'layer.create', input: { record, ...(repaired ? { previous: 'L-reminder@1' } : {}) } }));
  requireDemoOk(await fixture.event('actor', `actor:${actor}`, { command: 'layer.publish', input: { ref: `${record.id}@${record.revision}` } }));
}
export async function preparedFixture(mode: DemoCheckpoint['mode'] = 'local-rehearsal') {
  const fixture = demoFixture(mode); requireDemoOk(await fixture.event('bootstrap', 'host', {}));
  await authorFixture(fixture, 'a'); await authorFixture(fixture, 'c'); await authorFixture(fixture, 'b');
  const packet = requireDemoOk(await fixture.event('prepare', 'host', {})); return { fixture, packet };
}
export function localDemoHost(fixture: ReturnType<typeof demoFixture>) {
  const host = new DemoHost(fixture.checkpoint, event => fixture.sendEvent(event));
  for (const actor of ['a', 'b', 'c'] as const) host.bindThread('synthetic-' + actor, actor);
  return host;
}
