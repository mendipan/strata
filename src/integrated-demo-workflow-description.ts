import { checkpointDigest, DEMO_LIMITS, type DemoCheckpoint } from './integrated-demo.js';
import { canonical, fail } from './model.js';
import { LOCAL_PROJECT } from './security.js';

const refused = (): never => fail('DEMO_STATUS_REFUSED', 4, 'Workflow step output is incomplete, ambiguous or inconsistent.');
const record = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
// This workflow invokes each distinct name once. The provider appends the
// occurrence count (1); it is not a retry counter or an arbitrary numeric suffix.
export function demoApplySequence(name: unknown): number | undefined {
  if (typeof name !== 'string') return undefined;
  const match = /^apply-([1-9]\d*)(?:-1)?$/.exec(name);
  const sequence = match && Number(match[1]);
  return sequence && sequence <= DEMO_LIMITS.events ? sequence : undefined;
}
export function decodeDemoStepOutput(value: unknown): any {
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > DEMO_LIMITS.checkpoint_bytes * 2) refused();
      value = JSON.parse(value); // Exactly one transport encoding layer.
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Buffer.byteLength(canonical(value)) > DEMO_LIMITS.checkpoint_bytes * 2) refused();
    return value;
  } catch { return refused(); }
}

// A current provider attempt can be visible before its durable output exists.
// It is not a checkpoint, a failed step, or permission to resend its event.
export function isPendingDemoWorkflowStep(description: any, step: any): boolean {
  if (!['queued', 'running', 'waiting'].includes(description?.status) || step?.type !== 'step' ||
      step.success !== null || step.end != null || step.error != null || step.output != null ||
      !Array.isArray(step.attempts) || step.attempts.length > 1) return false;
  return step.attempts.every((attempt: any) => record(attempt) && attempt.success == null &&
    attempt.end == null && attempt.error == null);
}

export function authoritativeDemoWorkflowOutput(raw: any): { checkpoint: DemoCheckpoint; apply?: any } {
  const description = Array.isArray(raw?.steps) ? raw : raw?.result;
  if (!Array.isArray(description?.steps) || description.steps.length > DEMO_LIMITS.steps) refused();
  let latest: DemoCheckpoint | undefined, apply: any, pending = false;
  const seen = new Set<number>();
  for (const step of description.steps) {
    if (!step || typeof step.name !== 'string') refused();
    const claim = /^(claim-run)(?:-1)?$/.test(step.name);
    const sequence = claim ? 0 : demoApplySequence(step.name);
    // Reject lookalikes instead of silently falling back to an earlier checkpoint.
    if (sequence === undefined) {
      if (/^(claim-run|apply-)/.test(step.name)) refused();
      continue;
    }
    if (pending || seen.has(sequence) || step.type !== 'step') refused();
    seen.add(sequence);
    if (isPendingDemoWorkflowStep(description, step)) {
      if (!latest || sequence !== latest.sequence + 1) refused();
      pending = true;
      continue;
    }
    if (step.success !== true) refused();
    const output = decodeDemoStepOutput(step.output), cp = claim ? output : output.checkpoint;
    if (!cp || cp.format !== 'strata-integrated-demo-checkpoint/1' || cp.sequence !== sequence ||
        !/^[a-f0-9]{16}$/.test(cp.run_id) || cp.project_id !== LOCAL_PROJECT ||
        !['local-rehearsal', 'controlled-private'].includes(cp.mode) ||
        !Number.isSafeInteger(cp.started_at) || cp.expires_at !== cp.started_at + DEMO_LIMITS.duration_ms ||
        !['new', 'authors', 'selection', 'repair', 'runner', 'endorsement', 'complete', 'aborted', 'failed'].includes(cp.phase) ||
        (claim ? cp.phase !== 'new' || cp.previous_digest !== null : !/^[a-f0-9]{64}$/.test(cp.previous_digest)) ||
        (description.id !== undefined && description.id !== 'run-' + cp.run_id) ||
        !record(cp.registry) || !record(cp.registry.entries) || !record(cp.registry.storage) ||
        cp.registry.storage.project_id !== cp.project_id || !record(cp.registry.asset_locators) ||
        !record(cp.heads) || !record(cp.refs) || !record(cp.requests) || !record(cp.counters) ||
        !record(cp.counters.tools) ||
        (cp.management_cleanup !== undefined && !record(cp.management_cleanup)) ||
        (cp.mode === 'controlled-private' && !record(cp.management_cleanup)) ||
        !Array.isArray(cp.receipts) || !Array.isArray(cp.trace) || cp.trace.length !== sequence ||
        (cp.pending !== null && !record(cp.pending)) ||
        (!claim && Object.hasOwn(output, 'outcome') && (!record(output.outcome) || typeof output.outcome.ok !== 'boolean')) ||
        Buffer.byteLength(canonical(cp)) > DEMO_LIMITS.checkpoint_bytes || !/^[a-f0-9]{64}$/.test(checkpointDigest(cp))) refused();
    if (latest && (sequence !== latest.sequence + 1 || cp.previous_digest !== checkpointDigest(latest) ||
        cp.run_id !== latest.run_id || cp.project_id !== latest.project_id || cp.mode !== latest.mode ||
        cp.started_at !== latest.started_at || cp.expires_at !== latest.expires_at)) refused();
    latest = cp; apply = claim ? undefined : { ...step, output };
  }
  if (!latest) return refused();
  return { checkpoint: structuredClone(latest), ...(apply ? { apply: structuredClone(apply) } : {}) };
}
