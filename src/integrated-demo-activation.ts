import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, bytesDigest, digest, fail } from './model.js';
import { DEMO_ACTORS, DEMO_LIMITS } from './integrated-demo.js';
import type { DemoManagementTarget } from './integrated-demo-management.js';
import { LOCAL_PROJECT } from './security.js';

// Pin the operator and its compiled/transitive code as well as the Worker source.
// Prepare after building; a rebuilt or changed executable requires a new review.
// This is an explicit reviewed inventory. The source-closure regression checks
// local static imports (including literal dynamic imports) without running them.
export const DEMO_ACTIVATION_SOURCE_FILES = Object.freeze([
  'agent/strata/SKILL.md',
  'examples/replay/synthetic-run.json',
  'dist/scripts/integrated-demo-activation.js',
  'dist/scripts/integrated-demo-operator.js',
  'dist/scripts/integrated-demo-guided.js',
  'dist/src/integrated-demo-dashboard.js',
  'dist/src/demo-run-presentation.js',
  'dist/src/demo-run-workbench.js',
  'dist/src/demo-run-replay.js',
  'dist/scripts/integrated-demo-browser.js',
  'dist/src/demo-browser-lab.js',
  'dist/src/demo-lab-worker.js',
  'dist/src/demo-lab-config.js',
  'dist/src/artifact-registry.js',
  'dist/src/artifacts-git.js',
  'dist/src/artifacts-test-cleanup.js',
  'dist/src/artifacts-test-fixture.js',
  'dist/src/artifacts-test-worker-entry.js',
  'dist/src/artifacts-test-worker.js',
  'dist/src/artifacts.js',
  'dist/src/assets-node.js',
  'dist/src/assets.js',
  'dist/src/backup.js',
  'dist/src/booking-checker.js',
  'dist/src/budget.js',
  'dist/src/cli.js',
  'dist/src/cli-config.js',
  'dist/src/doctor.js',
  'dist/src/review.js',
  'dist/src/content.js',
  'dist/src/core.js',
  'dist/src/fixtures.js',
  'dist/src/integrated-demo-activation.js',
  'dist/src/integrated-demo-actor-cli.js',
  'dist/src/integrated-demo-actor-mcp.js',
  'dist/src/integrated-demo-host.js',
  'dist/src/integrated-demo-full-step.js',
  'dist/src/integrated-demo-live.js',
  'dist/src/integrated-demo-management-wrangler.js',
  'dist/src/integrated-demo-management.js',
  'dist/src/integrated-demo-operator.js',
  'dist/src/integrated-demo-operator-reply.js',
  'dist/src/integrated-demo-replay.js',
  'dist/src/integrated-demo-review.js',
  'dist/src/integrated-demo-runner.js',
  'dist/src/integrated-demo-visualization.js',
  'dist/src/integrated-demo-worker-entry.js',
  'dist/src/integrated-demo-workflow.js',
  'dist/src/integrated-demo-workflow-description.js',
  'dist/src/integrated-demo.js',
  'dist/src/local-broker.js',
  'dist/src/mediation.js',
  'dist/src/model.js',
  'dist/src/node-state.js',
  'dist/src/profile.js',
  'dist/src/profile-types.js',
  'dist/src/profiles.js',
  'dist/src/profiles/booking.js',
  'dist/src/profiles/booking-checker.js',
  'dist/src/profiles/booking-example.js',
  'dist/src/profiles/booking-runner.js',
  'dist/src/profiles/booking-selection.js',
  'dist/src/profiles/counter-fixture.js',
  'dist/src/provider-diagnostic.js',
  'dist/src/publication.js',
  'dist/src/recovery.js',
  'dist/src/runner.js',
  'dist/src/security.js',
  'dist/src/service.js',
  'dist/src/trace.js',
  'dist/src/worker.js',
  'package-lock.json',
  'package.json',
  'scripts/integrated-demo-activation.ts',
  'scripts/integrated-demo-operator.ts',
  'scripts/integrated-demo-guided.ts',
  'scripts/start-attended-demo.ps1',
  'scripts/start-demo-browser.ps1',
  'scripts/integrated-demo-browser.ts',
  'src/demo-browser-lab.ts',
  'src/demo-lab-worker.ts',
  'src/demo-lab-config.ts',
  'src/integrated-demo-dashboard.ts',
  'src/artifact-registry.ts',
  'src/artifacts-git.ts',
  'src/artifacts-test-cleanup.ts',
  'src/artifacts-test-fixture.ts',
  'src/artifacts-test-worker-entry.ts',
  'src/artifacts-test-worker.ts',
  'src/artifacts.ts',
  'src/assets-node.ts',
  'src/assets.ts',
  'src/backup.ts',
  'src/booking-checker.ts',
  'src/budget.ts',
  'src/cli.ts',
  'src/content.ts',
  'src/core.ts',
  'src/fixtures.ts',
  'src/integrated-demo-activation.ts',
  'src/integrated-demo-actor-cli.ts',
  'src/integrated-demo-actor-mcp.ts',
  'src/integrated-demo-host.ts',
  'src/integrated-demo-full-step.ts',
  'src/integrated-demo-live.ts',
  'src/integrated-demo-management-wrangler.ts',
  'src/integrated-demo-management.ts',
  'src/integrated-demo-operator.ts',
  'src/integrated-demo-operator-reply.ts',
  'src/integrated-demo-replay.ts',
  'src/integrated-demo-review.ts',
  'src/integrated-demo-runner.ts',
  'src/integrated-demo-visualization.ts',
  'src/integrated-demo-worker-entry.ts',
  'src/integrated-demo-workflow.ts',
  'src/integrated-demo-workflow-description.ts',
  'src/integrated-demo.ts',
  'src/local-broker.ts',
  'src/mediation.ts',
  'src/model.ts',
  'src/node-state.ts',
  'src/profile.ts',
  'src/profile-types.ts',
  'src/profiles.ts',
  'src/profiles/booking.ts',
  'src/profiles/booking-checker.ts',
  'src/profiles/booking-example.ts',
  'src/profiles/booking-runner.ts',
  'src/profiles/booking-selection.ts',
  'src/profiles/counter-fixture.ts',
  'src/provider-diagnostic.ts',
  'src/publication.ts',
  'src/recovery.ts',
  'src/runner.ts',
  'src/security.ts',
  'src/service.ts',
  'src/trace.ts',
  'src/worker.ts',
  'wrangler.integrated-demo.json',
  'demo/ordered-feed.ts',
  'dist/demo/ordered-feed.js',
  'dist/scripts/explorer.js',
  'dist/scripts/studio-agents.js',
  'dist/scripts/studio-connections.js',
  'dist/scripts/studio.js',
  'dist/src/adoption/contract.js',
  'dist/src/adoption/coverage.js',
  'dist/src/adoption/git-bridge-schema.js',
  'dist/src/adoption/git-bridge.js',
  'dist/src/adoption/guard.js',
  'dist/src/adoption/persistent.js',
  'dist/src/adoption/records.js',
  'dist/src/agent-adapters/cloudflare.js',
  'dist/src/agent-discovery.js',
  'dist/src/auth/records.js',
  'dist/src/commands/client.js',
  'dist/src/commands/contract.js',
  'dist/src/commands/host-client.js',
  'dist/src/commands/node.js',
  'dist/src/commands/replay-effects.js',
  'dist/src/explorer/agent-client.js',
  'dist/src/explorer/agent-connection-store.js',
  'dist/src/explorer/agent-connection.js',
  'dist/src/explorer/commands.js',
  'dist/src/explorer/connection-client.js',
  'dist/src/explorer/connection-manager.js',
  'dist/src/explorer/connection-policy.js',
  'dist/src/explorer/connections.js',
  'dist/src/explorer/contract.js',
  'dist/src/explorer/credential-api.js',
  'dist/src/explorer/credential-store.js',
  'dist/src/explorer/host.js',
  'dist/src/explorer/hosted.js',
  'dist/src/explorer/launch.js',
  'dist/src/explorer/owner-files.js',
  'dist/src/explorer/read-budget.js',
  'dist/src/explorer/read.js',
  'dist/src/explorer/source.js',
  'dist/src/explorer/validate.js',
  'dist/src/git-adoption-node.js',
  'dist/src/git-adoption.js',
  'dist/src/git-application-checker.js',
  'dist/src/git-finalization-proof.js',
  'dist/src/git-patch.js',
  'dist/src/git-record-schemas.js',
  'dist/src/git-workspace.js',
  'dist/src/native-support.js',
  'dist/src/obligations.js',
  'dist/src/profile-capabilities.js',
  'dist/src/profiles/collection-checker.js',
  'dist/src/profiles/collection-host-checker.js',
  'dist/src/profiles/collection-host-semantics.js',
  'dist/src/profiles/collection-host.js',
  'dist/src/profiles/collection-semantics.js',
  'dist/src/profiles/collection.js',
  'dist/src/profiles/counter-host.js',
  'dist/src/reconciliation.js',
  'dist/src/source-binding.js',
  'dist/src/source-drift.js',
  'dist/src/workflow.js',
  'scripts/explorer.ts',
  'scripts/studio-agents.ts',
  'scripts/studio-connections.ts',
  'scripts/studio.ts',
  'src/adoption/contract.ts',
  'src/adoption/coverage.ts',
  'src/adoption/git-bridge-schema.ts',
  'src/adoption/git-bridge.ts',
  'src/adoption/guard.ts',
  'src/adoption/persistent.ts',
  'src/adoption/records.ts',
  'src/agent-adapters/cloudflare.ts',
  'src/agent-discovery.ts',
  'src/auth/records.ts',
  'src/cli-config.ts',
  'src/commands/client.ts',
  'src/commands/contract.ts',
  'src/commands/host-client.ts',
  'src/commands/node.ts',
  'src/commands/replay-effects.ts',
  'src/demo-run-presentation.ts',
  'src/demo-run-replay.ts',
  'src/demo-run-workbench.ts',
  'src/doctor.ts',
  'src/explorer/agent-client.ts',
  'src/explorer/agent-connection-store.ts',
  'src/explorer/agent-connection.ts',
  'src/explorer/commands.ts',
  'src/explorer/connection-client.ts',
  'src/explorer/connection-manager.ts',
  'src/explorer/connection-policy.ts',
  'src/explorer/connections.ts',
  'src/explorer/contract.ts',
  'src/explorer/credential-api.ts',
  'src/explorer/credential-store.ts',
  'src/explorer/host.ts',
  'src/explorer/hosted.ts',
  'src/explorer/launch.ts',
  'src/explorer/owner-files.ts',
  'src/explorer/read-budget.ts',
  'src/explorer/read.ts',
  'src/explorer/source.ts',
  'src/explorer/validate.ts',
  'src/git-adoption-node.ts',
  'src/git-adoption.ts',
  'src/git-application-checker.ts',
  'src/git-finalization-proof.ts',
  'src/git-patch.ts',
  'src/git-record-schemas.ts',
  'src/git-workspace.ts',
  'src/native-support.ts',
  'src/obligations.ts',
  'src/profile-capabilities.ts',
  'src/profiles/collection-checker.ts',
  'src/profiles/collection-host-checker.ts',
  'src/profiles/collection-host-semantics.ts',
  'src/profiles/collection-host.ts',
  'src/profiles/collection-semantics.ts',
  'src/profiles/collection.ts',
  'src/profiles/counter-host.ts',
  'src/reconciliation.ts',
  'src/review.ts',
  'src/source-binding.ts',
  'src/source-drift.ts',
  'src/workflow.ts',
].sort());

export const DEMO_ACTIVATION_LIMITS = Object.freeze({
  duration_ms: DEMO_LIMITS.duration_ms, cleanup_ms: DEMO_LIMITS.cleanup_ms,
  management_calls: 180, status_reads: 160, event_sends: 60, cleanup_reserve_calls: 10, cleanup_reserve_status_reads: 10,
  workflow_steps: DEMO_LIMITS.steps,
  artifact_dispatches: DEMO_LIMITS.artifact_dispatches, artifact_transfer_bytes: DEMO_LIMITS.transfer_bytes,
  original_bytes: DEMO_LIMITS.original_bytes, stage_batches: DEMO_LIMITS.stage_batches,
  records: DEMO_LIMITS.records, repo_tokens_issued: 25,
  actor_processes: 3, max_concurrent_actor_turns: 2, total_actor_turns: 12, total_actor_tool_calls: 60,
  actors: {
    a: { model: 'gpt-6-luna', reasoning_effort: 'medium', max_turns: DEMO_LIMITS.turns_per_actor, max_tool_calls: DEMO_LIMITS.tools_per_actor },
    c: { model: 'gpt-6-luna', reasoning_effort: 'medium', max_turns: DEMO_LIMITS.turns_per_actor, max_tool_calls: DEMO_LIMITS.tools_per_actor },
    b: { model: 'gpt-6-luna', reasoning_effort: 'high', max_turns: DEMO_LIMITS.turns_per_actor, max_tool_calls: DEMO_LIMITS.tools_per_actor }
  },
  fallback: false, public_routes: false, provider_api_budget_usd: null, provider_api_budget_verified: false
});

export type DemoActivationSourceManifest = { format: 'strata.integrated-demo-source-manifest/1'; files: Record<string, string>; sha256: string };
export type DemoActivationLimits = Omit<typeof DEMO_ACTIVATION_LIMITS, 'actor_processes'> & { actor_processes: 3 | 4 };
function activationLimits(reminderRepair: boolean): DemoActivationLimits {
  return { ...DEMO_ACTIVATION_LIMITS, actor_processes: reminderRepair ? 4 : 3 };
}
function validLimits(limits: DemoActivationLimits, persistent: boolean) {
  return !!limits && (limits.actor_processes === 3 || persistent && limits.actor_processes === 4) &&
    canonical(limits) === canonical(activationLimits(limits.actor_processes === 4));
}
export type DemoLabInfrastructure = {
  policy: 'retain-private-worker-workflow'; workflow_id: string; worker_version_id: string; workflow_version_id: string;
};
export type DemoActivationReview = {
  format: 'strata.integrated-demo-activation-review/1'; status: 'prepared-disabled'; live_authorized: false;
  grant_id: string; target: DemoManagementTarget; target_sha256: string; source: DemoActivationSourceManifest;
  limits: DemoActivationLimits; review_sha256: string; infrastructure?: DemoLabInfrastructure;
};
type DemoActivationGrantBody = {
  status: 'attended-approved'; live_authorized: true;
  grant_id: string; target: DemoManagementTarget; target_sha256: string; source: DemoActivationSourceManifest;
  limits: DemoActivationLimits; review_sha256: string; started_at: number; expires_at: number;
  grant_sha256: string; infrastructure?: DemoLabInfrastructure;
};
export type LegacyDemoActivationGrant = DemoActivationGrantBody & {
  format: 'strata.integrated-demo-activation-grant/1';
  approval: { typed_digest: string; operator_label: string; capture_method: 'local-interactive-terminal'; attended_at: number };
};
export type ConfirmedDemoActivationGrant = DemoActivationGrantBody & {
  format: 'strata.integrated-demo-activation-grant/2';
  approval: { confirmed_review_sha256: string; confirmation_text: 'START DEMO'; operator_label: string;
    capture_method: 'local-interactive-terminal'; attended_at: number };
};
export type BrowserDemoActivationGrant = DemoActivationGrantBody & {
  format: 'strata.integrated-demo-activation-grant/3'; infrastructure: DemoLabInfrastructure;
  approval: { confirmed_review_sha256: string; action: 'begin-demo'; operator_label: string;
    capture_method: 'local-browser'; attended_at: number };
};
export type DemoActivationGrant = LegacyDemoActivationGrant | ConfirmedDemoActivationGrant | BrowserDemoActivationGrant;

export type DemoActivationAttendance = { stdin_is_tty: boolean; stdout_is_tty: boolean; typed_digest?: string; operator_label: string;
  confirmation_text?: string; confirmed_grant_sha256?: string; browser_action?: 'begin-demo' };

export async function readDemoActivationSource(root: string): Promise<DemoActivationSourceManifest> {
  const files: Record<string, string> = {};
  for (const name of DEMO_ACTIVATION_SOURCE_FILES) {
    let bytes: Buffer;
    try { bytes = await readFile(path.join(root, name)); }
    catch { fail('DEMO_ACTIVATION_SOURCE_MISSING', 7, `Reviewed source file is unavailable: ${name}.`); }
    files[name] = bytesDigest(bytes!);
  }
  return { format: 'strata.integrated-demo-source-manifest/1', files, sha256: digest(files) };
}

export function createDemoActivationReview(grantId: string, target: DemoManagementTarget, source: DemoActivationSourceManifest,
  infrastructure?: DemoLabInfrastructure, reminderRepair = false): DemoActivationReview {
  validateTarget(target);
  if (typeof reminderRepair !== 'boolean' || reminderRepair && !infrastructure)
    fail('DEMO_ACTIVATION_REVIEW_REFUSED', 4, 'Reminder repair requires a separate exact browser lab review.');
  if (infrastructure) validateLabInfrastructure(infrastructure, target);
  validateSource(source);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(grantId)) fail('DEMO_ACTIVATION_REVIEW_REFUSED', 4, 'Activation grant ID is invalid.');
  const body = { format: 'strata.integrated-demo-activation-review/1' as const, status: 'prepared-disabled' as const,
    live_authorized: false as const, grant_id: grantId, target: structuredClone(target), target_sha256: digest(target),
    source: structuredClone(source), limits: activationLimits(reminderRepair), ...(infrastructure ? { infrastructure: structuredClone(infrastructure) } : {}) };
  return { ...body, review_sha256: digest(body) };
}

export function approveDemoActivationReview(review: DemoActivationReview, currentSource: DemoActivationSourceManifest,
  attendance: DemoActivationAttendance, now = Date.now()): LegacyDemoActivationGrant {
  validateReview(review, currentSource);
  if (review.infrastructure) fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'Persistent lab runs require their browser approval flow.');
  if (!attendance || attendance.stdin_is_tty !== true || attendance.stdout_is_tty !== true)
    fail('DEMO_ACTIVATION_TTY_REQUIRED', 7, 'Live admission requires an attended local terminal; redirected input/output is refused.');
  if (attendance.typed_digest !== review.review_sha256)
    fail('DEMO_ACTIVATION_DIGEST_REFUSED', 4, 'The typed review digest does not match the exact source, grant, target, and budget.');
  const operatorLabel = attendance.operator_label?.trim();
  if (typeof attendance.operator_label !== 'string' || !operatorLabel || operatorLabel.length > 128 || !Number.isFinite(now))
    fail('DEMO_ACTIVATION_ATTENDANCE_REFUSED', 4, 'A bounded self-declared operator label and finite local timestamp are required.');
  const body = { format: 'strata.integrated-demo-activation-grant/1' as const, status: 'attended-approved' as const,
    live_authorized: true as const, grant_id: review.grant_id, target: structuredClone(review.target),
    target_sha256: review.target_sha256, source: structuredClone(review.source), limits: DEMO_ACTIVATION_LIMITS,
    review_sha256: review.review_sha256, started_at: now, expires_at: now + DEMO_ACTIVATION_LIMITS.duration_ms,
    approval: { typed_digest: attendance.typed_digest!, operator_label: operatorLabel,
      capture_method: 'local-interactive-terminal' as const, attended_at: now } };
  return { ...body, grant_sha256: digest(body) };
}

// Store the words actually entered, with the exact review binding separately.
// This does not authenticate identity or assert a manually typed hash.
export function confirmDemoActivationReview(review: DemoActivationReview, currentSource: DemoActivationSourceManifest,
  attendance: DemoActivationAttendance, now = Date.now()): ConfirmedDemoActivationGrant {
  validateReview(review, currentSource);
  if (review.infrastructure) fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'Persistent lab runs require their browser approval flow.');
  if (attendance?.stdin_is_tty !== true || attendance.stdout_is_tty !== true)
    fail('DEMO_ACTIVATION_TTY_REQUIRED', 7, 'Live admission requires an attended local terminal.');
  if (attendance.confirmation_text !== 'START DEMO' || attendance.typed_digest !== undefined || attendance.confirmed_grant_sha256 !== undefined)
    fail('DEMO_ACTIVATION_CONFIRMATION_REFUSED', 4, 'Enter START DEMO to approve the displayed exact run.');
  const operatorLabel = attendance.operator_label?.trim();
  if (typeof attendance.operator_label !== 'string' || !operatorLabel || operatorLabel.length > 128 || !Number.isFinite(now))
    fail('DEMO_ACTIVATION_ATTENDANCE_REFUSED', 4, 'A bounded self-declared operator label and finite local timestamp are required.');
  const body = { format: 'strata.integrated-demo-activation-grant/2' as const, status: 'attended-approved' as const,
    live_authorized: true as const, grant_id: review.grant_id, target: structuredClone(review.target),
    target_sha256: review.target_sha256, source: structuredClone(review.source), limits: DEMO_ACTIVATION_LIMITS,
    review_sha256: review.review_sha256, started_at: now, expires_at: now + DEMO_ACTIVATION_LIMITS.duration_ms,
    approval: { confirmed_review_sha256: review.review_sha256, confirmation_text: 'START DEMO' as const,
      operator_label: operatorLabel, capture_method: 'local-interactive-terminal' as const, attended_at: now } };
  return { ...body, grant_sha256: digest(body) };
}

function validGrantApproval(grant: DemoActivationGrant): boolean {
  if (!grant.approval) return false;
  const expected = grant.format === 'strata.integrated-demo-activation-grant/1'
    ? ['typed_digest', 'operator_label', 'capture_method', 'attended_at']
    : grant.format === 'strata.integrated-demo-activation-grant/3'
      ? ['confirmed_review_sha256', 'action', 'operator_label', 'capture_method', 'attended_at']
      : ['confirmed_review_sha256', 'confirmation_text', 'operator_label', 'capture_method', 'attended_at'];
  if (canonical(Object.keys(grant.approval).sort()) !== canonical(expected.sort())) return false;
  return grant.format === 'strata.integrated-demo-activation-grant/1'
    ? grant.approval.typed_digest === grant.review_sha256
    : grant.approval.confirmed_review_sha256 === grant.review_sha256 && (grant.format === 'strata.integrated-demo-activation-grant/3'
      ? grant.approval.action === 'begin-demo' : grant.approval.confirmation_text === 'START DEMO');
}

export function approveBrowserDemoReview(review: DemoActivationReview, source: DemoActivationSourceManifest,
  input: { review_sha256: string; operator_label: string; action: 'begin-demo' }, now = Date.now()): BrowserDemoActivationGrant {
  validateReview(review, source);
  if (!review.infrastructure || input.action !== 'begin-demo' || input.review_sha256 !== review.review_sha256 ||
    typeof input.operator_label !== 'string' || !input.operator_label.trim() || input.operator_label.trim().length > 128 || !Number.isFinite(now))
    fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'The browser must approve the current exact lab review with an operator label.');
  const body = { format: 'strata.integrated-demo-activation-grant/3' as const, status: 'attended-approved' as const,
    live_authorized: true as const, grant_id: review.grant_id, target: structuredClone(review.target), target_sha256: review.target_sha256,
    source: structuredClone(source), limits: structuredClone(review.limits), infrastructure: structuredClone(review.infrastructure),
    review_sha256: review.review_sha256, started_at: now, expires_at: now + DEMO_ACTIVATION_LIMITS.duration_ms,
    approval: { confirmed_review_sha256: review.review_sha256, action: 'begin-demo' as const,
      operator_label: input.operator_label.trim(), capture_method: 'local-browser' as const, attended_at: now } };
  return { ...body, grant_sha256: digest(body) };
}

export function validateLabInfrastructure(value: DemoLabInfrastructure, target: DemoManagementTarget) {
  validateTarget(target);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!value || canonical(Object.keys(value).sort()) !== canonical(['policy', 'workflow_id', 'worker_version_id', 'workflow_version_id'].sort()) ||
    value.policy !== 'retain-private-worker-workflow' || !uuid.test(value.workflow_id) || !uuid.test(value.worker_version_id) || !uuid.test(value.workflow_version_id) ||
    target.repository_name !== 'strata-run-' + target.run_id)
    fail('DEMO_LAB_IDENTITY_REFUSED', 7, 'Persistent lab policy requires a complete target, exact versions and a run-owned repository.');
}

export function validateDemoActivationGrant(grant: DemoActivationGrant, currentSource: DemoActivationSourceManifest,
  now = Date.now()): void {
  if (!grant || !['strata.integrated-demo-activation-grant/1', 'strata.integrated-demo-activation-grant/2', 'strata.integrated-demo-activation-grant/3'].includes(grant.format) || grant.status !== 'attended-approved' || grant.live_authorized !== true)
    fail('DEMO_ACTIVATION_GRANT_REFUSED', 7, 'A prepared-disabled review is not a live activation grant.');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(grant.grant_id)) fail('DEMO_ACTIVATION_GRANT_REFUSED', 4, 'Activation grant ID is invalid.');
  validateTarget(grant.target); validateSource(grant.source); validateSource(currentSource);
  if (grant.format === 'strata.integrated-demo-activation-grant/3') validateLabInfrastructure(grant.infrastructure, grant.target);
  else if (grant.infrastructure) fail('DEMO_LAB_IDENTITY_REFUSED', 7, 'Legacy grants cannot authorize persistent resources.');
  if (canonical(currentSource) !== canonical(grant.source)) fail('DEMO_ACTIVATION_SOURCE_STALE', 7, 'Source changed after review; prepare and review a new exact grant.');
  if (grant.target_sha256 !== digest(grant.target) || !validLimits(grant.limits, !!grant.infrastructure) ||
      grant.expires_at !== grant.started_at + DEMO_ACTIVATION_LIMITS.duration_ms || !Number.isFinite(grant.started_at) ||
      !validGrantApproval(grant) || grant.approval.capture_method !== (grant.format === 'strata.integrated-demo-activation-grant/3' ? 'local-browser' : 'local-interactive-terminal') ||
      !grant.approval.operator_label?.trim() || grant.approval.operator_label.length > 128 || grant.approval.attended_at !== grant.started_at ||
      !Number.isFinite(now) || now < grant.started_at || now >= grant.expires_at)
    fail('DEMO_ACTIVATION_GRANT_REFUSED', 7, 'Grant target, fixed budget, attended confirmation, or 30-minute window is invalid.');
  const reviewBody = { format: 'strata.integrated-demo-activation-review/1' as const, status: 'prepared-disabled' as const,
    live_authorized: false as const, grant_id: grant.grant_id, target: grant.target, target_sha256: grant.target_sha256,
    source: grant.source, limits: grant.limits, ...(grant.infrastructure ? { infrastructure: grant.infrastructure } : {}) };
  const grantBody = { format: grant.format, status: grant.status, live_authorized: grant.live_authorized, grant_id: grant.grant_id,
    target: grant.target, target_sha256: grant.target_sha256, source: grant.source, limits: grant.limits,
    review_sha256: grant.review_sha256, started_at: grant.started_at, expires_at: grant.expires_at, approval: grant.approval,
    ...(grant.infrastructure ? { infrastructure: grant.infrastructure } : {}) };
  if (grant.review_sha256 !== digest(reviewBody) || grant.grant_sha256 !== digest(grantBody))
    fail('DEMO_ACTIVATION_GRANT_REFUSED', 7, 'Grant digest does not match the reviewed source, exact target, attendance, and budgets.');
}

export function demoActivationGrantDigest(grant: DemoActivationReview | DemoActivationGrant) {
  return grant.status === 'prepared-disabled' ? grant.review_sha256 : grant.grant_sha256;
}

// Use the smaller plan's count limit and leave a margin below the 5 KB value limit.
export const DEMO_BINDING_BYTES = 4096;
export const DEMO_BINDING_COUNT = 64;
const GRANT_PREFIX = 'STRATA_DEMO_ACTIVATION_GRANT';
const MANIFEST_KEY = GRANT_PREFIX + '_MANIFEST';
const chunkKey = (index: number) => GRANT_PREFIX + '_CHUNK_' + String(index).padStart(3, '0');

export function validateDemoActivationBindings(vars: Record<string, unknown>): void {
  if (Object.keys(vars).length > DEMO_BINDING_COUNT || Object.values(vars).some(value =>
    typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > DEMO_BINDING_BYTES))
    fail('DEMO_ACTIVATION_BINDINGS_REFUSED', 7, 'Activation variables exceed the bounded count or UTF-8 value size.');
}

export function encodeDemoActivationGrant(grant: DemoActivationGrant): Record<string, string> {
  const json = JSON.stringify(grant), chunks: string[] = [];
  let chunk = '', size = 0;
  for (const character of json) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (size + bytes > DEMO_BINDING_BYTES) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += character; size += bytes;
  }
  if (chunk) chunks.push(chunk);
  const vars: Record<string, string> = { [MANIFEST_KEY]: JSON.stringify({
    format: 'strata.integrated-demo-grant-chunks/1', count: chunks.length,
    utf8_bytes: Buffer.byteLength(json, 'utf8'), sha256: bytesDigest(Buffer.from(json, 'utf8'))
  }) };
  chunks.forEach((value, index) => { vars[chunkKey(index)] = value; });
  validateDemoActivationBindings(vars);
  return vars;
}

export function decodeDemoActivationGrant(env: Record<string, unknown>): DemoActivationGrant {
  const refuse = () => fail('DEMO_ACTIVATION_GRANT_REFUSED', 7, 'Worker activation chunks are incomplete, altered, malformed, or ambiguous.');
  try {
    const raw = env[MANIFEST_KEY];
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > DEMO_BINDING_BYTES) return refuse();
    const manifest = JSON.parse(raw);
    if (manifest.format !== 'strata.integrated-demo-grant-chunks/1' ||
        !Number.isSafeInteger(manifest.count) || manifest.count < 1 || manifest.count >= DEMO_BINDING_COUNT ||
        !Number.isSafeInteger(manifest.utf8_bytes) || manifest.utf8_bytes < 1 ||
        manifest.utf8_bytes > manifest.count * DEMO_BINDING_BYTES || !/^[a-f0-9]{64}$/.test(manifest.sha256)) return refuse();
    const keys = [MANIFEST_KEY, ...Array.from({ length: manifest.count }, (_, index) => chunkKey(index))];
    const suppliedKeys = Object.keys(env).filter(key => key.startsWith(GRANT_PREFIX) && key !== GRANT_PREFIX + '_SHA256');
    if (canonical(suppliedKeys.sort()) !== canonical([...keys].sort())) return refuse();
    const vars = Object.fromEntries(keys.map(key => [key, env[key]]));
    validateDemoActivationBindings(vars);
    const json = keys.slice(1).map(key => vars[key]).join('');
    if (Buffer.byteLength(json, 'utf8') !== manifest.utf8_bytes || bytesDigest(Buffer.from(json, 'utf8')) !== manifest.sha256) return refuse();
    const grant = JSON.parse(json) as DemoActivationGrant;
    // Enforce one serialization, manifest shape, and deterministic chunk partition.
    if (canonical(vars) !== canonical(encodeDemoActivationGrant(grant))) return refuse();
    return grant;
  } catch { return refuse(); }
}

export function createDemoActivationWorkerConfig(grant: DemoActivationGrant, projectDirectory = process.cwd()) {
  const target = grant.target;
  validateTarget(target);
  if (!['strata.integrated-demo-activation-grant/1', 'strata.integrated-demo-activation-grant/2', 'strata.integrated-demo-activation-grant/3'].includes(grant.format) || grant.live_authorized !== true ||
      grant.status !== 'attended-approved' || grant.target_sha256 !== digest(target))
    fail('DEMO_ACTIVATION_GRANT_REFUSED', 7, 'A target-specific Worker config requires the exact attended grant.');
  const config = {
    '$schema': 'node_modules/wrangler/config-schema.json', name: target.worker_name,
    main: path.resolve(projectDirectory, 'src/integrated-demo-worker-entry.ts'), account_id: target.account_id,
    compatibility_date: '2026-10-03', compatibility_flags: ['nodejs_compat'], workers_dev: false,
    preview_urls: false, send_metrics: false, observability: { enabled: false },
    limits: { cpu_ms: 1000, subrequests: 100 },
    workflows: [{ binding: 'STRATA_DEMO_WORKFLOW', name: target.workflow_name, class_name: 'StrataIntegratedDemoWorkflow',
      limits: { steps: DEMO_ACTIVATION_LIMITS.workflow_steps }, concurrency: { limit: 1 },
      default_retention: { success_retention: 3600000, error_retention: 3600000 } }],
    artifacts: [{ binding: 'ARTIFACTS', namespace: target.namespace_id }],
    vars: { ...encodeDemoActivationGrant(grant), STRATA_DEMO_ACTIVATION_GRANT_SHA256: grant.grant_sha256,
      STRATA_DEMO_SOURCE_SHA256: grant.source.sha256, STRATA_DEMO_TARGET_SHA256: grant.target_sha256,
      STRATA_DEMO_WORKER_NAME: target.worker_name, STRATA_DEMO_WORKFLOW_NAME: target.workflow_name,
      STRATA_DEMO_PROJECT_ID: target.project_id }
  };
  validateDemoActivationBindings(config.vars);
  return config;
}

function validateReview(review: DemoActivationReview, currentSource: DemoActivationSourceManifest) {
  if (!review || review.format !== 'strata.integrated-demo-activation-review/1' || review.status !== 'prepared-disabled' || review.live_authorized !== false)
    fail('DEMO_ACTIVATION_REVIEW_REFUSED', 7, 'Only a disabled review manifest may be approved.');
  validateTarget(review.target); validateSource(review.source); validateSource(currentSource);
  if (review.infrastructure) validateLabInfrastructure(review.infrastructure, review.target);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(review.grant_id)) fail('DEMO_ACTIVATION_REVIEW_REFUSED', 4, 'Activation grant ID is invalid.');
  const body = { format: review.format, status: review.status, live_authorized: review.live_authorized, grant_id: review.grant_id,
    target: review.target, target_sha256: review.target_sha256, source: review.source, limits: review.limits,
    ...(review.infrastructure ? { infrastructure: review.infrastructure } : {}) };
  if (review.target_sha256 !== digest(review.target) || !validLimits(review.limits, !!review.infrastructure) ||
      review.review_sha256 !== digest(body) || canonical(currentSource) !== canonical(review.source))
    fail('DEMO_ACTIVATION_REVIEW_REFUSED', 7, 'Review digest or current exact source, target, and prepared budgets differ.');
}

function validateSource(source: DemoActivationSourceManifest) {
  if (!source || source.format !== 'strata.integrated-demo-source-manifest/1' ||
      canonical(Object.keys(source.files ?? {}).sort()) !== canonical(DEMO_ACTIVATION_SOURCE_FILES) ||
      Object.values(source.files).some(hash => !/^[a-f0-9]{64}$/.test(hash)) || source.sha256 !== digest(source.files))
    fail('DEMO_ACTIVATION_SOURCE_REFUSED', 7, 'Source manifest is incomplete, malformed, or has a bad digest.');
}

function validateTarget(target: DemoManagementTarget) {
  const keys = ['account_id','instance_id','namespace_id','project_id','repository_name','run_id','worker_name','workflow_name'].sort();
  const name = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
  if (!target || canonical(Object.keys(target).sort()) !== canonical(keys) || !/^[a-f0-9]{32}$/.test(target.account_id) ||
      !/^[a-f0-9]{16}$/.test(target.run_id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(target.project_id) ||
      target.instance_id !== 'run-' + target.run_id || !name(target.worker_name) || !name(target.workflow_name) ||
      !name(target.namespace_id) || !name(target.repository_name) || target.project_id !== LOCAL_PROJECT)
    fail('DEMO_ACTIVATION_TARGET_REFUSED', 4, 'Review must pin the complete exact account, project, run, Worker, Workflow, instance, namespace, and repository.');
}
