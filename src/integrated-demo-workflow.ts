import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { IntegratedDemo, DEMO_LIMITS, initialDemoCheckpoint, safeDemoError, type DemoCheckpoint, type DemoEvent } from './integrated-demo.js';
import type { ArtifactCleanupCounts } from './artifacts.js';
import { canonical, fail } from './model.js';

export const DEMO_STEP_CONFIG = Object.freeze({ retries: { limit: 0, delay: 1, backoff: 'constant' as const }, timeout: '1 minute' as const });
export const demoEventType = (sequence: number) => 'strata-demo-' + sequence;

function accumulateCleanupCounts(total: ArtifactCleanupCounts, before: ArtifactCleanupCounts, current: ArtifactCleanupCounts): ArtifactCleanupCounts {
  const add = (prior: number | null, start: number | null, end: number | null) =>
    prior === null || start === null || end === null || end < start ? null : prior + end - start;
  return { unsettled_dispatches: Math.max(total.unsettled_dispatches, current.unsettled_dispatches),
    repo_tokens_issued: add(total.repo_tokens_issued, before.repo_tokens_issued, current.repo_tokens_issued),
    repo_tokens_revoked: add(total.repo_tokens_revoked, before.repo_tokens_revoked, current.repo_tokens_revoked),
    handles_open: Math.max(total.handles_open, current.handles_open) };
}

export type IntegratedDemoWorkflowRunMode = { mode: 'local-rehearsal' | 'controlled-private'; started_at?: number; live_authorized?: boolean; provider_binding_verified?: boolean; initialize?: () => Promise<number> };

export async function runIntegratedDemoWorkflow(event: WorkflowEvent<{ run_id: string }>, step: Pick<WorkflowStep, 'do' | 'waitForEvent'>,
  controller: IntegratedDemo, runMode: IntegratedDemoWorkflowRunMode = { mode: 'local-rehearsal' }) {
  if (!event.payload || Object.keys(event.payload).some(key => key !== 'run_id') || event.instanceId !== 'run-' + event.payload.run_id) fail('DEMO_WORKFLOW_EVENT_REFUSED', 4, 'Workflow requires one fixed run instance.');
  let usedSteps = 1;
  const runStartedAt = runMode.started_at ?? controller.now();
  let checkpoint = await step.do('claim-run', DEMO_STEP_CONFIG, async () => {
    const dispatched = await runMode.initialize?.() ?? 0;
    const initial = initialDemoCheckpoint(event.payload.run_id, controller.storage, runMode.mode, runStartedAt);
    initial.management_cleanup = controller.storage.managementCleanupCounts();
    initial.counters.artifact_reserved = dispatched;
    if (dispatched) initial.counters.transfer_reserved = 16 * 1024;
    return initial;
  });
  let cleanupSample = controller.storage.managementCleanupCounts();
  // Reserve/apply outputs are immutable durable Workflow step outputs. A failure
  // stops the instance; no controller retry or counter-resetting restart path.
  for (let receive = 1; usedSteps + 3 <= DEMO_LIMITS.steps; receive++) {
    if (['complete', 'aborted', 'failed'].includes(checkpoint.phase)) break;
    try {
      const remaining = checkpoint.expires_at - DEMO_LIMITS.cleanup_ms - controller.now();
      if (remaining <= 0) { checkpoint = { ...checkpoint, phase: 'aborted', pending: null }; break; }
      usedSteps++;
      const received = await step.waitForEvent<DemoEvent>('receive-' + receive, { type: demoEventType(checkpoint.sequence + 1), timeout: Math.min(remaining, 300000) });
      usedSteps++;
      const reserved = await step.do('reserve-' + receive, DEMO_STEP_CONFIG, async () => controller.reserve(checkpoint, received.payload));
      usedSteps++;
      const applied = await step.do('apply-' + receive, DEMO_STEP_CONFIG, async () => {
        const result = await controller.apply(checkpoint, received.payload, reserved);
        const current = controller.storage.managementCleanupCounts();
        const cleanup = accumulateCleanupCounts(checkpoint.management_cleanup, cleanupSample, current);
        cleanupSample = current;
        return { ...result, checkpoint: { ...result.checkpoint, management_cleanup: cleanup } };
      });
      checkpoint = applied.checkpoint;
    } catch (error) {
      const current = controller.storage.managementCleanupCounts();
      checkpoint = { ...checkpoint, management_cleanup: accumulateCleanupCounts(checkpoint.management_cleanup, cleanupSample, current) };
      cleanupSample = current;
      return { ...safeDemoError(error), mode: runMode.mode === 'controlled-private' ? 'controlled-private-workflow' : 'local-native-workflow',
        live_authorized: runMode.live_authorized === true, checkpoint, used_steps: usedSteps,
        management_cleanup: checkpoint.management_cleanup, automatic_retries: 0, cleanup_required: true,
        provider_binding_verified: runMode.provider_binding_verified === true };
    }
  }
  if (!['complete', 'aborted', 'failed'].includes(checkpoint.phase)) checkpoint = { ...checkpoint, phase: 'aborted', pending: null };
  const current = controller.storage.managementCleanupCounts();
  checkpoint = { ...checkpoint, management_cleanup: accumulateCleanupCounts(checkpoint.management_cleanup, cleanupSample, current) };
  return { ok: checkpoint.phase === 'complete', mode: runMode.mode === 'controlled-private' ? 'controlled-private-workflow' : 'local-native-workflow',
    live_authorized: runMode.live_authorized === true, checkpoint,
    checkpoint_bytes: Buffer.byteLength(canonical(checkpoint)), used_steps: usedSteps, management_cleanup: checkpoint.management_cleanup, automatic_retries: 0,
    cleanup_required: true, provider_binding_verified: runMode.provider_binding_verified === true };
}

// Local planning has no live authorization/configuration. The separate attended
// activation/session path supplies a grant-bound adapter and Worker bindings;
// an actor event, environment flag or fixture ID cannot enable this guard.
export function refuseUnconfiguredLiveDemo(): never { fail('DEMO_LIVE_ACTIVATION_REQUIRED', 7, 'Integrated demo remains local-only pending a separately reviewed and approved activation.'); }
