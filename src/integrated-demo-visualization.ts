import { demoApplySequence, decodeDemoStepOutput } from './integrated-demo-workflow-description.js';
import { digest, fail } from './model.js';
import { checkpointDigest, type DemoCheckpoint, type DemoEvent } from './integrated-demo.js';
import { checkpointFromWorkflowDescription } from './integrated-demo-host.js';
import { operatorPromptPacket } from './integrated-demo-operator-reply.js';
import type { SyntheticViewEvent } from '../demo/ordered-feed.js';

type JsonRecord = Record<string, any>;
const demoPhases = new Set(['new', 'authors', 'selection', 'repair', 'runner', 'endorsement', 'complete', 'aborted', 'failed']);
const demoKinds = new Set(['bootstrap', 'actor', 'prepare', 'selection', 'realize', 'evidence', 'endorse', 'stop']);
const cloudflareStatuses = new Set(['queued', 'running', 'paused', 'errored', 'terminated', 'complete', 'waitingForPause', 'waiting', 'rollingBack']);

export type SyntheticDecisionOption = { id: string; selected: string[]; rejected: string[]; effects: string; follow_up: string };
export type SyntheticDecisionPacket = {
  kind: 'selection'; packet_digest: string; case_revision: number; baseline_seconds: number; expires_at: string;
  considered: string[]; choice_preselected: false; repair_required_for_initial_1200: boolean;
  business_request: string; validation_status: string; options: SyntheticDecisionOption[];
};
export type SyntheticViewSummary = {
  format: 'strata.integrated-demo-view-summary/1'; mode: 'synthetic-replay'; branch: '900' | '1200';
  run_id: string; instance_id: string; project_id: string; event_count: number;
  synthetic_only: true; real_model_calls: 0; actual_human_replies: 0; provider_calls: 0;
  fixture_turns: { actor: string; start_ms: number; duration_ms: number; label: 'scripted-fixture' }[];
  actors: { actor: string; layers: string[] }[];
  selection_packets: SyntheticDecisionPacket[];
  endorsement: { packet_digest: string; candidate_ref: string; scope: string; checks_passed: boolean; approvals_pending: boolean };
  release: { ref: string; state: string; evidence_digest: string; inherited_ref: string };
  final_phase: 'complete';
  note: string;
};

export type WorkflowTraceItem = { sequence: number; kind: string; source: string; actor: string; phase: string; outcome: string; summary: string; event_digest: string | null };
export type WorkflowDecisionReceipt = { sequence: number; kind: 'selection' | 'endorsement'; packet_digest: string;
  action: '900' | '1200' | 'defer' | 'approve-release'; source: 'operator-supplied-artifact' | 'synthetic-rehearsal';
  receipt_digest: string; received_at: string; capture_method: 'operator-supplied-file' | 'local-interactive-terminal' | 'local-browser' | null;
  declared_operator_label: string | null; packet_available: boolean; authenticated: false };
export type ImportedWorkflowSnapshot = {
  format: 'strata.integrated-demo-view-snapshot/1'; mode: 'workflow-snapshot'; source: 'operator-supplied-json-unverified';
  imported_at: string; instance_id: string; workflow_status: string; step_count: number;
  execution_mode: 'local-rehearsal' | 'controlled-private' | null;
  steps: { name: string; type: string; success: boolean | null; event_type?: string }[];
  run_id: string | null; sequence: number | null; checkpoint_digest: string | null; phase: string | null;
  trace: WorkflowTraceItem[]; decision_receipts: WorkflowDecisionReceipt[];
  pending_packet: null | { kind: string; digest: string; packet_ref: string | null; content_sha256: string | null;
    allowed_actions: string[]; considered: string[]; baseline_seconds: number | null; case_revision: number | null;
    business_request: string | null; options: { id: string; selected: string[]; rejected: string[]; effects: string; follow_up: string }[] };
  composition_ref: string | null; candidate_ref: string | null; release_ref: string | null;
  waiting_for: string | null; completeness: 'checkpoint' | 'status-only'; message: string;
};


function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DEMO_VIEW_INPUT_REFUSED', 4, `${label} must be an object.`);
  return value as JsonRecord;
}
function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('DEMO_VIEW_INPUT_REFUSED', 4, `${label} must be non-empty text.`);
  return value;
}
function viewActor(source: string): string {
  if (/^actor:[abc]$/.test(source)) return `Actor ${source.slice(-1).toUpperCase()} · scripted fixture`;
  if (source === 'operator' || source === 'human') return 'Decision input · synthetic fixture';
  if (source === 'runner') return 'Validator · scripted fixture';
  if (source === 'host') return 'Local host · fixture';
  fail('DEMO_VIEW_INPUT_REFUSED', 4, 'Rehearsal contains an unsupported source label.');
}
function workflowActor(source: string): string {
  if (/^actor:[abc]$/.test(source)) return 'Actor ' + source.slice(-1).toUpperCase() + ' - host-declared, identity unverified';
  if (source === 'operator' || source === 'human') return 'Operator input - identity and consent unverified';
  if (source === 'runner') return 'Runner - host-declared';
  if (source === 'host') return 'Workflow host';
  fail('DEMO_VIEW_INPUT_REFUSED', 4, 'Workflow trace contains an unsupported source label.');
}

function eventLabel(event: DemoEvent, layerRef?: string, fixtureAction?: string, outcome?: unknown): string {
  const input = event.input as JsonRecord;
  const command = typeof input?.command === 'string' ? input.command : '';
  if (event.kind === 'bootstrap') return 'Pinned booking baseline loaded';
  if (event.kind === 'prepare') return 'Complete considered set and decision packet prepared';
  if (event.kind === 'selection') return `Synthetic decision fixture · ${fixtureAction ?? 'response recorded'}`;
  if (event.kind === 'realize') return 'Composed candidate materialized for the bounded booking profile';
  if (event.kind === 'evidence') return 'Generated booking behavior and acceptance evidence measured';
  if (event.kind === 'endorse') return 'Synthetic test input at the separate Release gate';
  if (event.kind === 'actor' && command.startsWith('layer.') && String(outcome) !== 'accepted')
    return `Refused ${command.slice('layer.'.length)} attempt for ${layerRef ?? 'an unpinned Layer'}`;
  if (command === 'inspect') return `Read ${String(input.input?.ref ?? 'pinned intent')}`;
  if (command === 'layer.create') return `Drafted ${layerRef ?? 'an owned Layer'}`;
  if (command === 'layer.revise') return `Revised owned proposal ${layerRef ?? ''}`.trim();
  if (command === 'layer.publish') return `Published ${layerRef ?? 'an owned Layer revision'}`;
  return 'Recorded local fixture event';
}

function layerReference(event: DemoEvent): string | undefined {
  const input = event.input as JsonRecord, payload = input?.input as JsonRecord | undefined;
  if (typeof payload?.ref === 'string' && /^[a-zA-Z0-9._-]{1,64}@[1-9][0-9]{0,7}$/.test(payload.ref)) return payload.ref;
  const layer = payload?.record as JsonRecord | undefined;
  if (typeof layer?.id === 'string' && Number.isSafeInteger(layer.revision) && layer.revision > 0) return `${layer.id}@${layer.revision}`;
  return undefined;
}

function decisionPacket(value: unknown): SyntheticDecisionPacket {
  const handoff = record(value, 'selection handoff'), packetRecord = record(handoff.packet, 'mediation packet ref');
  const packet = record(packetRecord.packet, 'mediation packet bytes');
  if (handoff.kind !== 'selection' || handoff.choice_preselected !== false || typeof handoff.packet_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(handoff.packet_digest) || packetRecord.packet_sha256 !== digest(packet) || packetRecord.ref !== `decision-packet@${digest(packet)}` ||
      packet.format !== 'decision-packet/1' || !Array.isArray(packet.options) || !Array.isArray(handoff.considered) ||
      !Number.isSafeInteger(packet.case_revision) || !Number.isSafeInteger(handoff.baseline_seconds))
    fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Selection fixture did not preserve the exact unselected packet and source digest.');
  const options = (packet.options as unknown[]).map(optionValue => {
    const option = record(optionValue, 'decision option');
    if (typeof option.id !== 'string' || !Array.isArray(option.selected) || !Array.isArray(option.rejected) ||
        typeof option.effects !== 'string' || typeof option.follow_up !== 'string') fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Decision option is incomplete.');
    return { id: option.id, selected: option.selected.map(String), rejected: option.rejected.map(String), effects: option.effects, follow_up: option.follow_up };
  });
  return { kind: 'selection', packet_digest: handoff.packet_digest, case_revision: packet.case_revision,
    baseline_seconds: handoff.baseline_seconds, expires_at: nonEmpty(packet.expires_at, 'packet expiry'),
    considered: handoff.considered.map((ref: unknown) => nonEmpty(ref, 'considered Layer ref')),
    choice_preselected: false, repair_required_for_initial_1200: handoff.repair_required_for_initial_1200 === true,
    business_request: nonEmpty(handoff.business_request, 'business request'), validation_status: nonEmpty(handoff.validation_status, 'validation status'), options };
}

export function syntheticViewSummary(value: unknown): SyntheticViewSummary {
  const rehearsal = record(value, 'local rehearsal'), checkpoint = record(rehearsal.checkpoint, 'rehearsal checkpoint') as unknown as DemoCheckpoint;
  if (rehearsal.mode !== 'local-deterministic-rehearsal' || !['900', '1200'].includes(rehearsal.choice) ||
      rehearsal.real_model_calls !== 0 || rehearsal.actual_human_replies !== 0 || rehearsal.provider_calls !== 0 ||
      checkpoint.format !== 'strata-integrated-demo-checkpoint/1' || checkpoint.mode !== 'local-rehearsal' ||
      checkpoint.phase !== 'complete' || checkpoint.refs.released !== rehearsal.released?.ref || !Array.isArray(rehearsal.events) ||
      !Array.isArray(checkpoint.trace) || rehearsal.events.length !== checkpoint.sequence || checkpoint.trace.length !== checkpoint.sequence ||
      checkpointDigest(checkpoint) !== rehearsal.checkpoint_digest)
    fail('DEMO_VIEW_REHEARSAL_REFUSED', 4, 'Only a complete zero-model, zero-human, zero-provider local rehearsal is accepted.');
  const choice = rehearsal.choice as '900' | '1200';
  const selectionPackets = [rehearsal.firstPacket, rehearsal.secondPacket].filter(Boolean).map(decisionPacket);
  if (!selectionPackets.length) fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Rehearsal did not contain a complete selection packet.');
  const events = rehearsal.events as DemoEvent[], trace = checkpoint.trace;
  let packetIndex = 0, activeSelection: SyntheticDecisionPacket | undefined;
  const actorLayers = new Map<string, Set<string>>([['A', new Set()], ['B', new Set()], ['C', new Set()]]);
  const fixtureEvents: SyntheticViewEvent[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!, item = trace[index]!;
    if (event.format !== 'strata-integrated-demo-event/1' || event.run_id !== checkpoint.run_id || event.project_id !== checkpoint.project_id ||
        event.sequence !== index + 1 || !demoKinds.has(event.kind) || !demoPhases.has(event.phase) || digest(event.input) !== event.input_digest ||
        item.sequence !== event.sequence || item.kind !== event.kind || item.source !== event.source || !demoPhases.has(item.phase))
      fail('DEMO_VIEW_EVENT_REFUSED', 4, 'Synthetic event and checkpoint trace are incomplete, duplicated, or out of order.');
    if (event.kind === 'prepare') activeSelection = selectionPackets[packetIndex++];
    const layerRef = layerReference(event);
    if (layerRef && /^actor:[abc]$/.test(event.source)) actorLayers.get(event.source.slice(-1).toUpperCase())!.add(layerRef);
    const rawInput = event.input as JsonRecord;
    const fixtureAction = (event.kind === 'selection' || event.kind === 'endorse') && typeof rawInput?.action === 'string' ? rawInput.action : undefined;
    const activePacketDigest = event.kind === 'evidence' || event.kind === 'endorse' ? rehearsal.endorsementPacket?.packet_digest : activeSelection?.packet_digest;
    fixtureEvents.push({ format: 'strata.integrated-demo-view-event/1', mode: 'synthetic-replay', branch: choice,
      run_id: checkpoint.run_id, instance_id: `run-${checkpoint.run_id}`, sequence: event.sequence, event_digest: digest(event),
      kind: event.kind, actor: viewActor(event.source), phase_before: event.phase, phase_after: item.phase, outcome: String(item.outcome).slice(0, 80),
      summary: eventLabel(event, layerRef, fixtureAction, item.outcome), ...(layerRef ? { layer_ref: layerRef } : {}),
      ...(activePacketDigest && /^[a-f0-9]{64}$/.test(activePacketDigest) ? { packet_digest: activePacketDigest } : {}),
      ...(fixtureAction ? { fixture_action: fixtureAction } : {}) });
    if (event.kind === 'selection') activeSelection = undefined;
    if (event.kind === 'endorse') activeSelection = undefined;
  }
  const intervals = Array.isArray(rehearsal.intervals) ? rehearsal.intervals : [];
  if (intervals.some((interval: JsonRecord) => interval.label !== 'synthetic-turn'))
    fail('DEMO_VIEW_INTERVAL_REFUSED', 4, 'Only explicitly synthetic host-turn intervals can be visualized.');
  const minStart = intervals.length ? Math.min(...intervals.map((interval: JsonRecord) => interval.start)) : 0;
  const maxEnd = intervals.length ? Math.max(...intervals.map((interval: JsonRecord) => interval.end)) : minStart;
  const fixtureTurns = intervals.map((interval: JsonRecord) => ({ actor: String(interval.actor).toUpperCase(),
    start_ms: Math.max(0, Math.round(interval.start - minStart)), duration_ms: Math.max(1, Math.round(interval.end - interval.start)), label: 'scripted-fixture' as const }));
  const endorsement = record(rehearsal.endorsementPacket, 'Release endorsement packet'), validation = record(endorsement.validation, 'validation state');
  const released = record(rehearsal.released, 'fixture Release');
  if (validation.approvals_pending !== true || validation.checks_passed !== true || typeof endorsement.packet_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(endorsement.packet_digest) || typeof released.ref !== 'string' || released.state !== 'validated' ||
      maxEnd < minStart || rehearsal.checkpoint.phase !== 'complete')
    fail('DEMO_VIEW_RELEASE_REFUSED', 4, 'Synthetic Release fixture does not retain the separate pending-approval boundary.');
  return { format: 'strata.integrated-demo-view-summary/1', mode: 'synthetic-replay', branch: choice,
    run_id: checkpoint.run_id, instance_id: `run-${checkpoint.run_id}`, project_id: checkpoint.project_id, event_count: fixtureEvents.length,
    synthetic_only: true, real_model_calls: 0, actual_human_replies: 0, provider_calls: 0, fixture_turns: fixtureTurns,
    actors: [...actorLayers].map(([actor, layers]) => ({ actor, layers: [...layers] })), selection_packets: selectionPackets,
    endorsement: { packet_digest: endorsement.packet_digest, candidate_ref: nonEmpty(endorsement.candidate_ref, 'candidate ref'),
      scope: nonEmpty(endorsement.scope, 'release scope'), checks_passed: true, approvals_pending: true },
    release: { ref: nonEmpty(released.ref, 'Release ref'), state: 'fixture result · not live or human-approved',
      evidence_digest: nonEmpty(rehearsal.evidence_digest, 'evidence digest'),
      inherited_ref: nonEmpty(checkpoint.refs.inherited ?? (typeof rehearsal.inherited === 'string' ? rehearsal.inherited : rehearsal.inherited?.ref), 'inherited Release ref') },
    final_phase: 'complete', note: 'Synthetic Node fixture replay. No model, human response, Cloudflare Workflow or provider call occurred.' };
}

export function syntheticViewEvents(value: unknown): SyntheticViewEvent[] {
  const rehearsal = record(value, 'local rehearsal');
  syntheticViewSummary(rehearsal);
  const checkpoint = rehearsal.checkpoint as DemoCheckpoint, events = rehearsal.events as DemoEvent[], trace = checkpoint.trace;
  const summary = syntheticViewSummary(rehearsal);
  let packetIndex = 0, activeSelection: SyntheticDecisionPacket | undefined;
  const result: SyntheticViewEvent[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!, item = trace[index]!;
    if (event.kind === 'prepare') activeSelection = summary.selection_packets[packetIndex++];
    const layerRef = layerReference(event), input = event.input as JsonRecord;
    const action = (event.kind === 'selection' || event.kind === 'endorse') && typeof input?.action === 'string' ? input.action : undefined;
    const packetDigest = event.kind === 'evidence' || event.kind === 'endorse' ? rehearsal.endorsementPacket?.packet_digest : activeSelection?.packet_digest;
    result.push({ format: 'strata.integrated-demo-view-event/1', mode: 'synthetic-replay', branch: summary.branch,
      run_id: event.run_id, instance_id: `run-${event.run_id}`, sequence: event.sequence, event_digest: digest(event),
      kind: event.kind, actor: viewActor(event.source), phase_before: event.phase, phase_after: item.phase, outcome: String(item.outcome).slice(0, 80),
      summary: eventLabel(event, layerRef, action, item.outcome), ...(layerRef ? { layer_ref: layerRef } : {}),
      ...(typeof packetDigest === 'string' && /^[a-f0-9]{64}$/.test(packetDigest) ? { packet_digest: packetDigest } : {}), ...(action ? { fixture_action: action } : {}) });
    if (event.kind === 'selection' || event.kind === 'endorse') activeSelection = undefined;
  }
  return result;
}

function parseJsonOutput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}
function unwrapDescription(raw: unknown): JsonRecord {
  const input = record(raw, 'Workflow export');
  if (input.result && typeof input.result === 'object' && !Array.isArray(input.result) &&
      (Array.isArray(input.result.steps) || typeof input.result.id === 'string')) return input.result as JsonRecord;
  return input;
}
function workflowEventDigests(steps: JsonRecord[]): Map<number, string> {
  const digests = new Map<number, string>();
  let previous = new Map<string, string>();
  const applies = steps.filter(step => step.type === 'step' && step.success === true && demoApplySequence(step.name) !== undefined)
    .sort((left, right) => demoApplySequence(left.name)! - demoApplySequence(right.name)!);
  for (const step of applies) {
    const sequence = demoApplySequence(step.name)!, checkpoint = step.output?.checkpoint, requests = checkpoint?.requests;
    if (!requests || typeof requests !== 'object' || Array.isArray(requests)) continue;
    const current = new Map<string, string>();
    for (const [requestId, value] of Object.entries(requests)) {
      const request = record(value, 'checkpoint request');
      if (typeof request.event_digest !== 'string' || !/^[a-f0-9]{64}$/.test(request.event_digest))
        fail('DEMO_VIEW_EVENT_DIGEST_REFUSED', 4, 'Checkpoint request lacks its exact event digest.');
      current.set(requestId, request.event_digest);
    }
    if ([...previous].some(([requestId, digestValue]) => current.get(requestId) !== digestValue))
      fail('DEMO_VIEW_HISTORY_REFUSED', 4, 'Workflow checkpoint history changed a previously recorded event digest.');
    const added = [...current].filter(([requestId]) => !previous.has(requestId));
    if (checkpoint.sequence === sequence && added.length === 1) digests.set(sequence, added[0]![1]);
    previous = current;
  }
  return digests;
}

function decisionPacketKinds(steps: JsonRecord[]): Map<string, 'selection' | 'endorsement'> {
  const packets = new Map<string, 'selection' | 'endorsement'>();
  for (const step of steps) {
    if (step.type !== 'step' || step.success !== true || demoApplySequence(step.name) === undefined) continue;
    const output = step.output as JsonRecord | undefined;
    const outcome = parseJsonOutput(output?.outcome) as JsonRecord | undefined;
    const data = outcome?.data as JsonRecord | undefined;
    if (!data || (data.kind !== 'selection' && data.kind !== 'endorsement') || typeof data.packet_digest !== 'string') continue;
    if (!/^[a-f0-9]{64}$/.test(data.packet_digest)) fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Workflow output contains an invalid decision packet digest.');
    const prior = packets.get(data.packet_digest);
    if (prior && prior !== data.kind) fail('DEMO_VIEW_PACKET_REFUSED', 4, 'One packet digest is assigned to conflicting decision gates.');
    packets.set(data.packet_digest, data.kind);
  }
  return packets;
}

function workflowDecisionReceipts(checkpoint: DemoCheckpoint, packetKinds: Map<string, 'selection' | 'endorsement'>): WorkflowDecisionReceipt[] {
  if (!Array.isArray(checkpoint.receipts)) fail('DEMO_VIEW_RECEIPT_REFUSED', 4, 'Workflow checkpoint receipt list is missing.');
  const accepted = checkpoint.trace.filter(entry => (entry.kind === 'selection' || entry.kind === 'endorse') && entry.outcome === 'accepted');
  if (accepted.length !== checkpoint.receipts.length)
    fail('DEMO_VIEW_RECEIPT_REFUSED', 4, 'Recorded decisions do not match accepted selection and Release-gate events.');
  const receipts = checkpoint.receipts.map((value, index) => {
    const receipt = record(value, 'decision receipt'), trace = accepted[index]!;
    const kind: 'selection' | 'endorsement' = trace.kind === 'endorse' ? 'endorsement' : 'selection';
    const allowed = kind === 'selection' ? ['900', '1200', 'defer'] : ['approve-release', 'defer'];
    if (typeof receipt.packet_digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.packet_digest) ||
        typeof receipt.message_id !== 'string' || !receipt.message_id.trim() || receipt.message_id.length > 256 ||
        typeof receipt.received_at !== 'string' || !Number.isFinite(Date.parse(receipt.received_at)) ||
        !allowed.includes(receipt.action) || !['operator-supplied-artifact', 'synthetic-rehearsal'].includes(receipt.source) ||
        receipt.source === 'synthetic-rehearsal' && (checkpoint.mode !== 'local-rehearsal' || receipt.operator_label !== undefined || receipt.artifact_digest !== undefined || receipt.capture_method !== undefined) ||
        receipt.source === 'operator-supplied-artifact' && (typeof receipt.operator_label !== 'string' || !receipt.operator_label.trim() || receipt.operator_label.length > 128 ||
          typeof receipt.artifact_digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.artifact_digest) ||
          !['operator-supplied-file', 'local-interactive-terminal', 'local-browser'].includes(receipt.capture_method)))
      fail('DEMO_VIEW_RECEIPT_REFUSED', 4, 'Decision receipt is malformed or does not match its separate gate.');
    const packetKind = packetKinds.get(receipt.packet_digest);
    if (packetKind && packetKind !== kind) fail('DEMO_VIEW_RECEIPT_REFUSED', 4, 'Decision receipt refers to a packet from another gate.');
    return { sequence: trace.sequence, kind, packet_digest: receipt.packet_digest, action: receipt.action,
      source: receipt.source, receipt_digest: digest(receipt), received_at: receipt.received_at,
      capture_method: receipt.capture_method ?? null, declared_operator_label: receipt.operator_label ?? null,
      packet_available: packetKind === kind, authenticated: false as const };
  });
  const choice = [...receipts].reverse().find(receipt => receipt.kind === 'selection');
  if (checkpoint.refs.chosen && choice?.action !== checkpoint.refs.chosen)
    fail('DEMO_VIEW_RECEIPT_REFUSED', 4, 'Selected Layer choice does not match its recorded selection receipt.');
  const releaseApproval = [...receipts].reverse().find(receipt => receipt.kind === 'endorsement');
  if (checkpoint.refs.released && releaseApproval?.action !== 'approve-release')
    fail('DEMO_VIEW_RECEIPT_REFUSED', 4, 'Release ref has no distinct recorded Release-gate input.');
  return receipts;
}

function phaseSummary(checkpoint: DemoCheckpoint, eventDigests: Map<number, string>): WorkflowTraceItem[] {
  if (!Array.isArray(checkpoint.trace) || checkpoint.trace.length !== checkpoint.sequence)
    fail('DEMO_VIEW_TRACE_REFUSED', 4, 'Imported checkpoint trace is not complete.');
  return checkpoint.trace.map((entry, index) => {
    if (entry.sequence !== index + 1 || !demoKinds.has(entry.kind) || !demoPhases.has(entry.phase) || typeof entry.outcome !== 'string')
      fail('DEMO_VIEW_TRACE_REFUSED', 4, 'Imported checkpoint trace is duplicated or out of order.');
    return { sequence: entry.sequence, kind: entry.kind, source: entry.source, actor: workflowActor(entry.source), phase: entry.phase,
      outcome: entry.outcome.slice(0, 80), summary: entry.kind + ' - ' + entry.phase, event_digest: eventDigests.get(entry.sequence) ?? null };
  });
}

export function parseWorkflowSnapshot(raw: unknown, importedAt = new Date().toISOString()): ImportedWorkflowSnapshot {
  const description = unwrapDescription(raw), instanceId = description.id ?? description.instance_id;
  if (typeof instanceId !== 'string' || !/^run-[a-f0-9]{16}$/.test(instanceId) || typeof description.status !== 'string' || !cloudflareStatuses.has(description.status))
    fail('DEMO_VIEW_WORKFLOW_REFUSED', 4, 'Workflow export must contain a supported status and the exact integrated-demo instance id.');
  const rawSteps = Array.isArray(description.steps) ? description.steps : [];
  const steps: JsonRecord[] = rawSteps.map((value: unknown) => {
    const step = record(value, 'Workflow step');
    return { ...step, output: step.success === true && /^(claim-run|apply-)/.test(step.name) ? decodeDemoStepOutput(step.output) : parseJsonOutput(step.output) };
  });
  const normalized = { ...description, id: instanceId, steps };
  const viewSteps = steps.map((step: JsonRecord) => ({ name: typeof step.name === 'string' ? step.name.slice(0, 120) : 'unnamed step',
    type: typeof step.type === 'string' ? step.type.slice(0, 40) : 'unknown', success: typeof step.success === 'boolean' ? step.success : null,
    ...(typeof step.event_type === 'string' ? { event_type: step.event_type.slice(0, 120) } : {}) }));
  const fullApply = steps.some((step: JsonRecord) => step.type === 'step' && step.success === true && demoApplySequence(step.name) !== undefined &&
    step.output?.checkpoint?.format === 'strata-integrated-demo-checkpoint/1');
  const importedAtIso = new Date(importedAt).toISOString();
  const stepCount = Number.isSafeInteger(description.step_count) && description.step_count >= 0 ? description.step_count : steps.length;
  const waitingStep = [...steps].reverse().find((step: JsonRecord) => step.type === 'waitForEvent' && step.success !== true);
  const runFromId = instanceId.slice('run-'.length);
  if (!fullApply) return { format: 'strata.integrated-demo-view-snapshot/1', mode: 'workflow-snapshot', source: 'operator-supplied-json-unverified',
    imported_at: importedAtIso, instance_id: instanceId, workflow_status: description.status, step_count: stepCount, execution_mode: null, steps: viewSteps,
    run_id: runFromId, sequence: null, checkpoint_digest: null, phase: null, trace: [], decision_receipts: [], pending_packet: null,
    composition_ref: null, candidate_ref: null, release_ref: null,
    waiting_for: waitingStep && typeof waitingStep.event_type === 'string' ? waitingStep.event_type.slice(0, 120) : null,
    completeness: 'status-only', message: 'Status imported; this file has no complete successful Apply checkpoint, so phase and decision state are unknown.' };
  const checkpoint = checkpointFromWorkflowDescription(normalized) as DemoCheckpoint;
  const cpDigest = checkpointDigest(checkpoint);
  if (checkpoint.run_id !== runFromId || checkpoint.format !== 'strata-integrated-demo-checkpoint/1' ||
      !Number.isSafeInteger(checkpoint.sequence) || !demoPhases.has(checkpoint.phase) || !/^[a-f0-9]{64}$/.test(cpDigest))
    fail('DEMO_VIEW_WORKFLOW_REFUSED', 4, 'Workflow id and exact Apply checkpoint do not match or fail their digest check.');
  const eventDigests = workflowEventDigests(steps), trace = phaseSummary(checkpoint, eventDigests);
  const packets = decisionPacketKinds(steps), decisionReceipts = workflowDecisionReceipts(checkpoint, packets);
  let pending: ImportedWorkflowSnapshot['pending_packet'] = null;
  if (checkpoint.pending) {
    const packet = operatorPromptPacket(normalized);
    if (packet.phase !== checkpoint.pending.kind || packet.packet_digest !== checkpoint.pending.digest)
      fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Pending Workflow checkpoint and exact decision handoff digest differ.');
    const decision = record(packet.decision, 'pending decision packet');
    let packetRef: string | null = null, contentSha256: string | null = null;
    let options: NonNullable<ImportedWorkflowSnapshot['pending_packet']>['options'] = [];
    if (packet.phase === 'selection') {
      const packetBody = record(decision.packet, 'decision packet ref'), packetBytes = record(packetBody.packet, 'decision packet bytes');
      contentSha256 = digest(packetBytes); packetRef = 'decision-packet@' + contentSha256;
      if (packetBody.packet_sha256 !== contentSha256 || packetBody.ref !== packetRef || !Array.isArray(packetBytes.options))
        fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Selection packet bytes do not match their immutable digest and ref.');
      options = packetBytes.options.map((value: unknown) => {
        const option = record(value, 'decision option');
        if (typeof option.id !== 'string' || !Array.isArray(option.selected) || !Array.isArray(option.rejected) ||
            typeof option.effects !== 'string' || typeof option.follow_up !== 'string')
          fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Decision option is incomplete.');
        return { id: option.id, selected: option.selected.filter((ref: unknown) => typeof ref === 'string'),
          rejected: option.rejected.filter((ref: unknown) => typeof ref === 'string'), effects: option.effects.slice(0, 500), follow_up: option.follow_up.slice(0, 500) };
      });
      if (packets.has(packet.packet_digest) && packets.get(packet.packet_digest) !== 'selection')
        fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Pending selection digest conflicts with its successful Workflow output.');
    } else {
      const dataDigest = digest(Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'packet_digest')));
      if (dataDigest !== packet.packet_digest) fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Release handoff bytes do not match their exact pending digest.');
      if (packets.has(packet.packet_digest) && packets.get(packet.packet_digest) !== 'endorsement')
        fail('DEMO_VIEW_PACKET_REFUSED', 4, 'Pending Release digest conflicts with its successful Workflow output.');
    }
    pending = { kind: packet.phase, digest: packet.packet_digest, packet_ref: packetRef, content_sha256: contentSha256,
      allowed_actions: packet.allowed_actions,
      considered: Array.isArray(decision.considered) ? decision.considered.filter((value: unknown) => typeof value === 'string') : [],
      baseline_seconds: Number.isSafeInteger(decision.baseline_seconds) ? decision.baseline_seconds : null,
      case_revision: Number.isSafeInteger(decision.packet?.packet?.case_revision) ? decision.packet.packet.case_revision : null,
      business_request: typeof decision.business_request === 'string' ? decision.business_request.slice(0, 300) : null, options };
  }
  return { format: 'strata.integrated-demo-view-snapshot/1', mode: 'workflow-snapshot', source: 'operator-supplied-json-unverified',
    imported_at: importedAtIso, instance_id: instanceId, workflow_status: description.status, step_count: stepCount, execution_mode: checkpoint.mode, steps: viewSteps,
    run_id: checkpoint.run_id, sequence: checkpoint.sequence, checkpoint_digest: cpDigest, phase: checkpoint.phase, trace,
    decision_receipts: decisionReceipts, pending_packet: pending, composition_ref: checkpoint.refs.composition ?? null, candidate_ref: checkpoint.refs.candidate ?? null,
    release_ref: checkpoint.refs.released ?? null,
    waiting_for: waitingStep && typeof waitingStep.event_type === 'string' ? waitingStep.event_type.slice(0, 120) : null,
    completeness: 'checkpoint', message: 'Imported Workflow snapshot only. File source is unverified; the viewer did not contact the host or authorize decisions.' };
}

export function compareWorkflowSnapshots(current: ImportedWorkflowSnapshot | null, incoming: ImportedWorkflowSnapshot): { decision: 'accept' | 'duplicate' | 'stale' | 'partial' | 'conflict'; message: string } {
  if (!current || current.run_id !== incoming.run_id) return { decision: 'accept', message: 'Snapshot selected for viewing.' };
  if (incoming.sequence === null) return { decision: 'partial', message: 'Partial Workflow status received; last complete checkpoint retained.' };
  if (current.sequence === null) return { decision: 'accept', message: 'Complete Apply checkpoint imported.' };
  if (incoming.sequence < current.sequence) return { decision: 'stale', message: 'Older snapshot ignored; last good state retained.' };
  if (incoming.sequence === current.sequence) {
    if (incoming.checkpoint_digest !== current.checkpoint_digest) return { decision: 'conflict', message: 'Same sequence has a different checkpoint digest; last good state retained.' };
    return { decision: 'duplicate', message: 'Same checkpoint; status metadata refreshed.' };
  }
  const prefixMatches = current.trace.every((item, index) => {
    const next = incoming.trace[index];
    return next && item.sequence === next.sequence && item.kind === next.kind && item.source === next.source && item.actor === next.actor &&
      item.phase === next.phase && item.outcome === next.outcome && (!item.event_digest || !next.event_digest || item.event_digest === next.event_digest);
  });
  const priorDecisionsMatch = (current.decision_receipts ?? []).every((item, index) => incoming.decision_receipts?.[index]?.receipt_digest === item.receipt_digest);
  if (!prefixMatches || !priorDecisionsMatch)
    return { decision: 'conflict', message: 'Workflow history or a previously recorded decision changed; last good state retained.' };
  return { decision: 'accept', message: 'Newer checkpoint imported.' };
}
