import { authoritativeDemoWorkflowOutput } from './integrated-demo-workflow-description.js';
import { canonical, digest, fail } from './model.js';
import { DEMO_LIMITS, checkpointDigest, demoEvent, type DemoCheckpoint, type DemoEvent, type HumanReceipt } from './integrated-demo.js';
import { demoEventType } from './integrated-demo-workflow.js';

export type OperatorDecisionAction = '900' | '1200' | 'defer' | 'approve-release';
export type OperatorDecisionArtifact = {
  format: 'strata.integrated-demo-operator-reply/1';
  run_id: string;
  packet_digest: string;
  action: OperatorDecisionAction;
  response_text: string;
  operator_label: string;
  recorded_at: string;
  capture_method: 'operator-supplied-file' | 'local-interactive-terminal' | 'local-browser';
};
export type OperatorPromptPacket = {
  format: 'strata.integrated-demo-operator-packet/1';
  run_id: string;
  phase: 'selection' | 'endorsement';
  packet_digest: string;
  expires_at: number;
  allowed_actions: OperatorDecisionAction[];
  decision: unknown;
  attribution: 'operator-supplied-file; identity and authorship are not authenticated by this runtime';
};
export type OperatorDecisionTemplate = Pick<OperatorDecisionArtifact, 'format' | 'run_id' | 'packet_digest' | 'capture_method'> & {
  action: ''; response_text: ''; operator_label: ''; recorded_at: '';
};

const allowedKeys = ['format', 'run_id', 'packet_digest', 'action', 'response_text', 'operator_label', 'recorded_at', 'capture_method'];

// Wrangler --json may wrap its Workflow description in a result object. Accept
// only these known shapes and then require exact successful apply-step output.
function unwrapDescription(raw: any) {
  if (raw && Array.isArray(raw.steps)) return raw;
  if (raw?.result && Array.isArray(raw.result.steps)) return raw.result;
  fail('DEMO_OPERATOR_PACKET_REFUSED', 4, 'Expected a structured Workflow description with step outputs.');
}
function latestCheckpoint(description: any): { checkpoint: DemoCheckpoint; apply: any } {
  let parsed: ReturnType<typeof authoritativeDemoWorkflowOutput>;
  try { parsed = authoritativeDemoWorkflowOutput(description); }
  catch { fail('DEMO_OPERATOR_PACKET_REFUSED', 4, 'No complete successful apply checkpoint is available.'); }
  const { checkpoint, apply } = parsed;
  if (!apply) fail('DEMO_OPERATOR_PACKET_REFUSED', 4, 'No complete successful apply checkpoint is available.');
  return { checkpoint, apply };
}
export function checkpointFromWorkflowDescriptionJson(raw: unknown): DemoCheckpoint {
  return latestCheckpoint(unwrapDescription(raw)).checkpoint;
}

export function operatorPromptPacketFromCheckpoint(checkpoint: DemoCheckpoint, outcome: unknown): OperatorPromptPacket {
  const pending = checkpoint.pending;
  if (!pending || !['selection', 'endorsement'].includes(pending.kind)) fail('DEMO_OPERATOR_PACKET_REFUSED', 4, 'No operator decision is currently pending.');
  const data = (outcome as any)?.data;
  if (!data || data.packet_digest !== pending.digest || data.kind !== pending.kind ||
      digest(Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'packet_digest'))) !== pending.digest)
    fail('DEMO_OPERATOR_PACKET_REFUSED', 4, 'Workflow output does not contain the exact pending decision packet.');
  const allowed = pending.kind === 'endorsement' ? ['approve-release', 'defer'] as OperatorDecisionAction[] :
    checkpoint.refs.case_revision === 2 ? ['1200', 'defer'] as OperatorDecisionAction[] : ['900', '1200', 'defer'] as OperatorDecisionAction[];
  return { format: 'strata.integrated-demo-operator-packet/1', run_id: checkpoint.run_id, phase: pending.kind,
    packet_digest: pending.digest, expires_at: pending.expires_at, allowed_actions: allowed, decision: structuredClone(data),
    attribution: 'operator-supplied-file; identity and authorship are not authenticated by this runtime' };
}

export function operatorPromptPacket(workflowDescription: unknown): OperatorPromptPacket {
  const description = unwrapDescription(workflowDescription), { checkpoint, apply } = latestCheckpoint(description);
  return operatorPromptPacketFromCheckpoint(checkpoint, apply.output?.outcome);
}

export function operatorDecisionEvent(checkpoint: DemoCheckpoint, artifact: OperatorDecisionArtifact, now = Date.now()): { event: DemoEvent; event_type: string } {
  if (!checkpoint.pending || !['selection', 'endorsement'].includes(checkpoint.pending.kind) ||
      !artifact || typeof artifact !== 'object' || Array.isArray(artifact) ||
      Object.keys(artifact).some(key => !allowedKeys.includes(key)) || Object.keys(artifact).length !== allowedKeys.length ||
      artifact.format !== 'strata.integrated-demo-operator-reply/1' || artifact.run_id !== checkpoint.run_id ||
      artifact.packet_digest !== checkpoint.pending.digest || !/^[a-f0-9]{64}$/.test(artifact.packet_digest) || now >= checkpoint.pending.expires_at ||
      !['operator-supplied-file', 'local-interactive-terminal', 'local-browser'].includes(artifact.capture_method) ||
      typeof artifact.operator_label !== 'string' || !artifact.operator_label.trim() || artifact.operator_label.length > 128 ||
      typeof artifact.response_text !== 'string' || !artifact.response_text.trim() || artifact.response_text.length > 2048 ||
      typeof artifact.recorded_at !== 'string' || !Number.isFinite(Date.parse(artifact.recorded_at)) || Date.parse(artifact.recorded_at) > now ||
      Date.parse(artifact.recorded_at) < checkpoint.started_at || Date.parse(artifact.recorded_at) >= checkpoint.pending.expires_at)
    fail('DEMO_OPERATOR_REPLY_REFUSED', 4, 'Reply artifact is malformed, expired, or bound to a different run/packet.');
  const allowed = checkpoint.pending.kind === 'endorsement' ? ['approve-release', 'defer'] :
    checkpoint.refs.case_revision === 2 ? ['1200', 'defer'] : ['900', '1200', 'defer'];
  if (!allowed.includes(artifact.action)) fail('DEMO_OPERATOR_REPLY_REFUSED', 4, 'Reply action is not allowed by the exact pending packet.');
  const artifactDigest = digest(artifact);
  const receipt: HumanReceipt = { source: 'operator-supplied-artifact', operator_label: artifact.operator_label,
    artifact_digest: artifactDigest, message_id: 'operator-' + artifactDigest.slice(0, 32), received_at: artifact.recorded_at,
    packet_digest: artifact.packet_digest, action: artifact.action, text: artifact.response_text, capture_method: artifact.capture_method };
  const kind = checkpoint.pending.kind === 'selection' ? 'selection' : 'endorse';
  const event = demoEvent(checkpoint, kind, 'operator', receipt, 'operator-' + artifactDigest.slice(0, 32));
  if (Buffer.byteLength(canonical(event)) > DEMO_LIMITS.event_bytes) fail('DEMO_OPERATOR_REPLY_REFUSED', 4, 'Operator reply event exceeds the fixed Workflow event bound.');
  return { event, event_type: demoEventType(event.sequence) };
}

export function operatorReplyTemplate(packet: OperatorPromptPacket): OperatorDecisionTemplate {
  return { format: 'strata.integrated-demo-operator-reply/1', run_id: packet.run_id, packet_digest: packet.packet_digest,
    action: '', response_text: '', operator_label: '', recorded_at: '', capture_method: 'operator-supplied-file' };
}

export function operatorEventPreview(workflowDescription: unknown, artifact: OperatorDecisionArtifact, now = Date.now()) {
  const checkpoint = checkpointFromWorkflowDescriptionJson(workflowDescription);
  const { event, event_type } = operatorDecisionEvent(checkpoint, artifact, now);
  return { format: 'strata.integrated-demo-operator-event-preview/1', live_authorized: false as const, event_type, payload: event,
    capture_method: artifact.capture_method,
    attribution: 'operator-supplied artifact; capture_method records the local CLI path, but identity and consent are not authenticated' as const };
}
