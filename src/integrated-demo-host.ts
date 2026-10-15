import { DEMO_ACTORS, DEMO_LIMITS, type DemoActor, type DemoCheckpoint, type DemoEvent, type DemoKind, type HumanReceipt, demoEvent, rehearsalLayer } from './integrated-demo.js';
import { operatorDecisionEvent, type OperatorDecisionArtifact } from './integrated-demo-operator-reply.js';
import { canonical, fail } from './model.js';
import { validateEnvelope } from './security.js';
import { authoritativeDemoWorkflowOutput } from './integrated-demo-workflow-description.js';

export type DemoDispatch = (event: DemoEvent) => Promise<{ checkpoint: DemoCheckpoint; outcome: any; reused: boolean; workflow_export?: unknown }>;
export const modelAllocation = (actor: DemoActor) => ({ provider: 'codex-subscription-cli', model: 'gpt-6-luna',
  reasoningEffort: DEMO_ACTORS[actor].reasoning.toLowerCase(), sandbox: 'read-only',
  max_host_turns: DEMO_LIMITS.turns_per_actor, max_tool_calls: DEMO_LIMITS.tools_per_actor,
  max_concurrent_actor_turns: 2, initial_context_target_tokens: 3000, per_request_input_target_tokens: 6000, output_target_tokens: 2000,
  hard_token_cap_verified: false, fallback: false, tool: 'strata_operation' });
export function demoActorInstructions(actor: DemoActor, repaired = false) {
  const task = rehearsalLayer(actor, repaired), spec = DEMO_ACTORS[actor];
  return ['Follow the supplied portable Strata skill. Your identity and tool scope are fixed by the host.',
    'You are ' + spec.principal + ', owning only ' + spec.layer + '. Use only strata_operation command/input envelopes; there is no shell, credential or management tool.',
    'First discover status and read exact baseline R0@1. Read relevant published peers through inspect; do not assume a revision or omit a required read.',
    'MCP call shapes: {"command":"status","input":{}}; {"command":"inspect","input":{"type":"release","ref":"R0@1"}}; inspect a peer with type "layer" and its exact ref. Create with {"command":"layer.create","input":{"record":YOUR_RECORD}} and publish with {"command":"layer.publish","input":{"ref":"YOUR_LAYER@REVISION"}}. Use these envelopes directly; no CLI/file access is available to this actor.',
    'Required Layer record fields are id, revision, owner, model_version, baseline, intent, changes, requires_layers, read_set, assumptions, acceptance, resolution_proposals, derived_from. Copy the assigned task values below after inspecting their basis; write your own nonempty plain-text intent string. read_set contains {"layer":"EXACT_REF","mode":"required"} for each required Layer dependency and may include actually read informational peers with mode "informational". Set resolution_proposals to [] and derived_from to null. Do not add fields. This is the transport/schema contract, not a completed model response.',
    'Author the finite assigned booking intent below. You must construct the Layer record yourself, preserve baseline preconditions and include the exact pinned read/dependency and acceptance. These are task inputs, not prerecorded model outputs.',
    'Copy changes, acceptance, requires_layers and assumptions exactly from your assigned task. An empty array means none: do not invent entries or copy acceptance IDs from inside a requirement into the Layer acceptance array. Only the reminder actor has a final-duration assumption and required peer dependency. The portable skill reminder example applies only to that role. A and C can publish independently; they do not need to inspect unpublished peers.',
    canonical({ id: task.id, revision: task.revision, owner: task.owner, model_version: task.model_version, baseline: task.baseline,
      changes: task.changes, acceptance: task.acceptance, requires_layers: task.requires_layers, assumptions: task.assumptions }),
    repaired ? 'Inspect your own L-reminder@1, then revise it with {"command":"layer.revise","input":{"previous":"L-reminder@1","record":YOUR_REVISION_2_RECORD}}. Pin L-alternative@1 and publish L-reminder@2. Explain why the old 900-second dependency is incompatible; do not reuse old human approval.' :
      actor === 'b' ? 'Read both L-hold@1 and L-alternative@1 before authoring. Explain the duration conflict and the operator handoff; approval is outside your scope.' : 'Begin independently of the other hold author. Explain your change and ask the host to handle semantic decisions.',
    'Invalid drafts are refused before persistence, so correct them within your bounded turn/tool allocation. Publish your own accepted draft, then report its exact ref. Do not author a decision Layer or invoke selection, scope or release approval.',
    'Report a refused peer write and its reason if supplied by the host. Further human choice, Node evidence and release endorsement remain separate gates.'
  ].join('\n\n');
}

// Adapts the existing trusted host's thread/tool contract. No model launcher or
// external management transport is enabled by this finite local scaffolding.
export class DemoHost {
  private chain: Promise<unknown> = Promise.resolve();
  private threads = new Map<string, DemoActor>();
  private turns: Record<DemoActor, number> = { a: 0, b: 0, c: 0 };
  private tools: Record<DemoActor, number> = { a: 0, b: 0, c: 0 };
  private active = new Map<string, { actor: DemoActor; started: number }>();
  private stopped = false;
  readonly intervals: { actor: DemoActor; label: 'model-turn' | 'synthetic-turn'; start: number; end: number; cancelled: boolean }[] = [];
  readonly operations: { source: string; kind: DemoKind; received: number; executing: number; completed: number; outcome: 'returned' | 'threw' }[] = [];
  constructor(public checkpoint: DemoCheckpoint, private readonly dispatch: DemoDispatch, private readonly clock = () => performance.now(), readonly inferenceLabel: 'model-turn' | 'synthetic-turn' = 'synthetic-turn') {}
  bindThread(thread: string, actor: DemoActor) {
    if (this.threads.has(thread) || [...this.threads.values()].includes(actor) || !(actor in DEMO_ACTORS) || !thread || this.threads.size >= 3) fail('DEMO_THREAD_REFUSED', 4, 'Exactly one fixed host thread per actor.');
    this.threads.set(thread, actor);
  }
  beginTurn(thread: string) {
    const actor = this.actor(thread);
    if (this.stopped || this.active.has(thread) || this.active.size >= 2 || this.turns[actor] >= DEMO_LIMITS.turns_per_actor) fail('DEMO_TURN_LIMIT', 7, 'Finite model allocation exhausted or cancelled.');
    this.turns[actor]++; this.active.set(thread, { actor, started: this.clock() }); return modelAllocation(actor);
  }
  endTurn(thread: string, cancelled = false) {
    const turn = this.active.get(thread); if (!turn) fail('DEMO_THREAD_REFUSED', 4, 'Turn is not active.');
    this.intervals.push({ actor: turn.actor, label: this.inferenceLabel, start: turn.started, end: this.clock(), cancelled }); this.active.delete(thread);
  }
  cancel() { this.stopped = true; for (const thread of [...this.active.keys()]) this.endTurn(thread, true); }
  actorOperation(thread: string, envelope: any) {
    const actor = this.actor(thread);
    if (this.stopped || !this.active.has(thread)) fail('DEMO_THREAD_REFUSED', 4, 'Only an active fixed thread can use the tool.');
    validateEnvelope(canonical(envelope));
    if (this.tools[actor] >= DEMO_LIMITS.tools_per_actor) fail('DEMO_TOOL_LIMIT', 7, 'Actor tool budget exhausted.');
    this.tools[actor]++;
    return this.event('actor', `actor:${actor}`, envelope);
  }
  operatorReply(artifact: OperatorDecisionArtifact) {
    return this.submit(checkpoint => operatorDecisionEvent(checkpoint, artifact).event);
  }
  syntheticReply(receipt: HumanReceipt) {
    if (this.checkpoint.mode !== 'local-rehearsal' || receipt.source !== 'synthetic-rehearsal') fail('DEMO_HUMAN_RECEIPT_REFUSED', 4, 'Synthetic replies are limited to the local rehearsal.');
    return this.event(receipt.action === 'approve-release' || this.checkpoint.phase === 'endorsement' ? 'endorse' : 'selection', 'operator', receipt);
  }
  event(kind: DemoKind, source: DemoEvent['source'], input: any) {
    return this.submit(checkpoint => demoEvent(checkpoint, kind, source, input, 'host-' + (checkpoint.sequence + 1)));
  }
  private submit(createEvent: (checkpoint: DemoCheckpoint) => DemoEvent) {
    const received = this.clock();
    const execute = async () => {
      const event = createEvent(this.checkpoint);
      if (this.stopped && event.kind !== 'stop') fail('DEMO_RUN_STOPPED', 7, 'Host dispatch was cancelled.');
      const executing = this.clock();
      let outcome: 'returned' | 'threw' = 'threw';
      try { const result = await this.dispatch(event); this.checkpoint = result.checkpoint; outcome = 'returned'; return result; }
      finally { this.operations.push({ source: event.source, kind: event.kind, received, executing, completed: this.clock(), outcome }); }
    };
    const result = this.chain.then(execute); this.chain = result.catch(() => undefined); return result;
  }
  private actor(thread: string) { const actor = this.threads.get(thread); if (!actor) fail('DEMO_THREAD_REFUSED', 4, 'Unbound model thread.'); return actor; }
  usage() { return { turns: { ...this.turns }, tools: { ...this.tools }, cancelled: this.stopped, token_usage_measured: false,
    inference_calls_measured: false, real_model_calls: this.inferenceLabel === 'synthetic-turn' ? 0 : null }; }
}

// Shared provider decoder also serves operator packets and management outcomes.
export function checkpointFromWorkflowDescription(description: any): DemoCheckpoint {
  return authoritativeDemoWorkflowOutput(description).checkpoint;
}
