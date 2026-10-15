import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, fail } from './model.js';
import { DEMO_LIMITS, checkpointDigest, type DemoCheckpoint, type DemoEvent } from './integrated-demo.js';
import { demoEventType } from './integrated-demo-workflow.js';
import { validateDemoActivationGrant, type DemoActivationGrant, type DemoActivationSourceManifest, type DemoLabInfrastructure } from './integrated-demo-activation.js';
import { validateDemoFullStep, type DemoFullStep, type DemoSupplementalRead } from './integrated-demo-full-step.js';

// These are admission-port call/CLI-invocation and canonical-envelope bounds.
// They do not count Wrangler's internal HTTP requests/retries or establish wire bytes or cost.
export const DEMO_MANAGEMENT_LIMITS = Object.freeze({
  calls: 180, status_reads: 160, event_sends: 60, cleanup_reserve_calls: 10, cleanup_reserve_status_reads: 10,
  repo_tokens_issued: DEMO_LIMITS.repo_tokens_issued,
  duration_ms: DEMO_LIMITS.duration_ms, cleanup_ms: DEMO_LIMITS.cleanup_ms,
  event_bytes: DEMO_LIMITS.event_bytes,
  max_request_bytes_per_call: 4 * 1024 * 1024, max_response_bytes_per_call: 4 * 1024 * 1024,
  request_bytes: DEMO_LIMITS.transfer_bytes, response_bytes: DEMO_LIMITS.transfer_bytes
});

export type DemoManagementTarget = {
  account_id: string; project_id: string; run_id: string; worker_name: string; workflow_name: string;
  instance_id: string; namespace_id: string; repository_name: string;
};
export type DemoManagementPlan = {
  format: 'strata.integrated-demo-management-plan/1';
  mode: 'admission-only';
  live_authorized: false;
  grant_id: string;
  target: DemoManagementTarget;
  started_at: number;
  expires_at: number;
  limits: typeof DEMO_MANAGEMENT_LIMITS;
  infrastructure?: never;
} | {
  format: 'strata.integrated-demo-management-plan/2';
  mode: 'reviewed-attended';
  live_authorized: true;
  grant_id: string;
  target: DemoManagementTarget;
  started_at: number;
  expires_at: number;
  limits: typeof DEMO_MANAGEMENT_LIMITS;
  source_sha256: string;
  target_sha256: string;
  grant_sha256: string;
  infrastructure?: DemoLabInfrastructure;
};
export type DemoManagementAction = 'describe-step' | 'describe-instance' | 'send-event' | 'delete-instance' | 'describe-workflow' |
  'delete-workflow' | 'describe-worker' | 'delete-worker' | 'describe-repository' | 'delete-repository' | 'list-namespace' | 'create-instance' | 'preflight-full-step' | 'preflight-namespace' | 'preflight-worker' | 'preflight-workflow' | 'preflight-lab-instances' | 'deploy-private';
export type DemoCleanupAction = Exclude<DemoManagementAction, 'send-event' | 'create-instance' | 'describe-step'>;
export type DemoManagementRequest = {
  action: DemoManagementAction; target: DemoManagementTarget;
  event_type?: string; event?: DemoEvent;
};
export type DemoManagementProvider = {
  readonly mode: 'mock-only' | 'wrangler-cli';
  call(request: DemoManagementRequest, supplementalRead?: DemoSupplementalRead): Promise<unknown>;
  supports?(action: DemoManagementAction): boolean;
  preflight?(action: DemoManagementAction, plan?: DemoManagementPlan): void;
};
export type MockDemoManagementProvider = DemoManagementProvider & { readonly mode: 'mock-only' };

const reviewedPlans = new WeakMap<object, string>();

// A Wrangler-capable plan is constructed only from a valid attended grant and a
// source manifest that was freshly read from the local checkout.
export function reviewedDemoManagementPlan(grant: DemoActivationGrant, source: DemoActivationSourceManifest, now = Date.now()): DemoManagementPlan {
  validateDemoActivationGrant(grant, source, now);
  const plan: DemoManagementPlan = { format: 'strata.integrated-demo-management-plan/2', mode: 'reviewed-attended', live_authorized: true,
    grant_id: grant.grant_id, target: structuredClone(grant.target), started_at: grant.started_at, expires_at: grant.expires_at,
    limits: DEMO_MANAGEMENT_LIMITS, source_sha256: source.sha256, target_sha256: grant.target_sha256, grant_sha256: grant.grant_sha256,
    ...(grant.infrastructure ? { infrastructure: structuredClone(grant.infrastructure) } : {}) };
  reviewedPlans.set(plan, digest(plan));
  return plan;
}

type CleanupProgress = {
  terminal_instance_verified: boolean; local_dispatches_settled: boolean; repo_tokens_clean: boolean; handles_disposed: boolean;
  instance_delete_requested: boolean; instance_absent: boolean;
  workflow_delete_requested: boolean; workflow_absent: boolean;
  worker_delete_requested: boolean; worker_absent: boolean;
  workflow_retained_verified?: boolean; worker_retained_verified?: boolean;
  repository_delete_requested: boolean; repository_absent: boolean; namespace_empty_verified: boolean;
};
type InFlight = { call_id: string; action: DemoManagementAction; request_digest: string; reserved_at: number };
export type DemoManagementLedgerState = {
  format: 'strata.integrated-demo-management-ledger/1'; grant_id: string; target_digest: string; started_at: number; expires_at: number;
  counters: { calls: number; status_reads: number; event_sends: number; cleanup_calls: number; request_bytes: number; response_bytes: number };
  next_event_sequence: number; cleanup_started: boolean; reconciliation_required: boolean;
  instance_create_requested: boolean; instance_created: boolean; instance_ready_verified: boolean;
  in_flight: InFlight | null; cleanup: CleanupProgress;
  supplemental_read?: { call_id: string; parent_call_id: string };
  history: { call_id: string; action: DemoManagementAction; request_digest: string; response_digest?: string; response_bytes?: number; result: 'reserved' | 'complete' | 'uncertain' }[];
};
export type DemoManagementReservation = { call_id: string; action: DemoManagementAction; target_digest: string };

// The journal contract is a serialized durable transaction. The supplied file
// implementation takes an exclusive lock and fails closed on stale locks or a
// process crash with an in-flight call. A production host must keep this file
// private and backed up; no Cloudflare transport is installed by this module.
export class FileDemoManagementJournal {
  private readonly statePath: string;
  private readonly lockPath: string;
  constructor(filePath: string) { this.statePath = path.resolve(filePath); this.lockPath = this.statePath + '.lock'; }

  private async transaction<T>(change: (state: DemoManagementLedgerState | null) => { state: DemoManagementLedgerState; value: T }): Promise<T> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    let lock;
    try { lock = await open(this.lockPath, 'wx', 0o600); }
    catch { fail('DEMO_MANAGEMENT_LOCKED', 7, 'Admission journal is locked; inspect the prior process before continuing.'); }
    try {
      let state: DemoManagementLedgerState | null = null;
      try { state = JSON.parse(await readFile(this.statePath, 'utf8')) as DemoManagementLedgerState; }
      catch (error: any) { if (error?.code !== 'ENOENT') fail('DEMO_MANAGEMENT_JOURNAL_INVALID', 7, 'Admission journal cannot be read; do not reset it.'); }
      const changed = change(state);
      const tempPath = this.statePath + '.' + randomUUID() + '.tmp';
      const temp = await open(tempPath, 'wx', 0o600);
      try { await temp.writeFile(JSON.stringify(changed.state, null, 2) + '\n', 'utf8'); await temp.sync(); }
      finally { await temp.close(); }
      try { await rename(tempPath, this.statePath); }
      catch (error) { await unlink(tempPath).catch(() => undefined); throw error; }
      return changed.value;
    } finally {
      await lock.close(); await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private initial(plan: DemoManagementPlan, targetDigest: string): DemoManagementLedgerState {
    return { format: 'strata.integrated-demo-management-ledger/1', grant_id: plan.grant_id, target_digest: targetDigest,
      started_at: plan.started_at, expires_at: plan.expires_at,
      counters: { calls: 0, status_reads: 0, event_sends: 0, cleanup_calls: 0, request_bytes: 0, response_bytes: 0 },
      next_event_sequence: 1, cleanup_started: false, reconciliation_required: false, instance_create_requested: false,
      instance_created: false, instance_ready_verified: false, in_flight: null,
      cleanup: { terminal_instance_verified: false, local_dispatches_settled: false, repo_tokens_clean: false, handles_disposed: false,
        instance_delete_requested: false, instance_absent: false, workflow_delete_requested: false, workflow_absent: false,
        worker_delete_requested: false, worker_absent: false, repository_delete_requested: false, repository_absent: false, namespace_empty_verified: false },
      history: [] };
  }

  async reserve(plan: DemoManagementPlan, action: DemoManagementAction, requestDigest: string, requestBytes: number, now: number, eventSequence?: number): Promise<DemoManagementReservation> {
    const targetDigest = digest(plan.target);
    return this.transaction(state => {
      state ??= this.initial(plan, targetDigest);
      if (state.format !== 'strata.integrated-demo-management-ledger/1' || state.grant_id !== plan.grant_id || state.target_digest !== targetDigest ||
          state.started_at !== plan.started_at || state.expires_at !== plan.expires_at) fail('DEMO_MANAGEMENT_TARGET_CONFLICT', 5, 'Journal belongs to a different grant or exact resource set.');
      if (state.in_flight) {
        return { state, value: fail('DEMO_MANAGEMENT_RECONCILIATION_REQUIRED', 7, 'A prior provider call has no settled response; do not resend it.') };
      }
      if (state.reconciliation_required) fail('DEMO_MANAGEMENT_RECONCILIATION_REQUIRED', 7, 'Provider state is uncertain; stop and reconcile manually.');
      if (now < state.started_at || now >= state.expires_at) fail('DEMO_MANAGEMENT_DEADLINE', 7, 'The fixed management window expired or has not started.');
      if (!Number.isSafeInteger(requestBytes) || requestBytes < 0 || requestBytes > DEMO_MANAGEMENT_LIMITS.max_request_bytes_per_call ||
          state.counters.request_bytes + requestBytes > DEMO_MANAGEMENT_LIMITS.request_bytes)
        fail('DEMO_MANAGEMENT_REQUEST_BYTES_LIMIT', 7, 'Management request byte ceiling reached.');
      const setupActions = plan.infrastructure
        ? ['preflight-full-step', 'preflight-namespace', 'preflight-worker', 'preflight-workflow', 'preflight-lab-instances']
        : ['preflight-full-step', 'preflight-namespace', 'preflight-worker', 'preflight-workflow', 'deploy-private'];
      if (plan.infrastructure && ['deploy-private', 'delete-worker', 'delete-workflow'].includes(action))
        fail('DEMO_LAB_RESOURCE_RETAINED', 7, 'This grant retains the pinned private Worker and Workflow; deployment or deletion is refused.');
      const setupAction = setupActions.includes(action);
      const cleanupAction = !setupAction && action !== 'send-event' && action !== 'describe-instance' && action !== 'create-instance';
      if (setupAction && (state.cleanup_started || state.instance_create_requested)) fail('DEMO_MANAGEMENT_SETUP_REFUSED', 7, 'Provisioning is limited to the initial attended run boundary.');
      if (setupAction && state.history.some(item => item.action === action)) fail('DEMO_MANAGEMENT_SETUP_REFUSED', 7, 'Each provisioning operation is single use.');
      if (setupAction && (!plan.live_authorized || state.cleanup_started || now >= state.expires_at - DEMO_MANAGEMENT_LIMITS.cleanup_ms ||
          action !== setupActions[state.history.length]))
        fail('DEMO_MANAGEMENT_SETUP_REFUSED', 7, 'Provisioning requires the attended grant and exact initial single-use order.');
      if (now >= state.expires_at - DEMO_MANAGEMENT_LIMITS.cleanup_ms) state.cleanup_started = true;
      if (state.cleanup_started && action === 'send-event') fail('DEMO_MANAGEMENT_CLEANUP_WINDOW', 7, 'No events are admitted after cleanup starts.');
      if (state.cleanup_started && action === 'create-instance') fail('DEMO_MANAGEMENT_CLEANUP_WINDOW', 7, 'Workflow creation is refused after cleanup starts.');
      if (cleanupAction && !state.cleanup_started) fail('DEMO_MANAGEMENT_CLEANUP_ORDER', 7, 'Cleanup actions require an explicit cleanup boundary.');
      if (plan.live_authorized && action === 'create-instance') {
        if (state.history.some(item => !setupActions.includes(item.action)) || state.instance_create_requested ||
          (plan.infrastructure && (state.history.length !== setupActions.length || state.history.some(item => item.result !== 'complete'))))
          fail('DEMO_MANAGEMENT_INSTANCE_CREATE_ONCE', 7, 'The reviewed Workflow instance may be created once, after its exact preflights.');
        state.instance_create_requested = true;
      }
      if (plan.live_authorized && action === 'send-event' && !state.instance_created)
        fail('DEMO_MANAGEMENT_INSTANCE_NOT_READY', 7, 'The exact reviewed Workflow instance must be confirmed before sending events.');
      if (plan.live_authorized && action === 'send-event' && !state.instance_ready_verified)
        fail('DEMO_MANAGEMENT_INSTANCE_NOT_READY', 7, 'A status read must confirm the exact reviewed Workflow instance is running before sending events.');
      if (plan.live_authorized && !setupAction && action !== 'create-instance' && state.counters.calls === 0)
        fail('DEMO_MANAGEMENT_INSTANCE_CREATE_REQUIRED', 7, 'The fixed Workflow instance trigger must be the first management call.');
      if (state.counters.calls >= DEMO_MANAGEMENT_LIMITS.calls) fail('DEMO_MANAGEMENT_CALL_LIMIT', 7, 'Total management-call ceiling reached.');
      const isRead = action.startsWith('describe-') || action.startsWith('preflight-') || action === 'list-namespace';
      if (isRead && state.counters.status_reads >= DEMO_MANAGEMENT_LIMITS.status_reads) fail('DEMO_MANAGEMENT_READ_LIMIT', 7, 'Management status-read ceiling reached.');
      if (plan.live_authorized && !state.cleanup_started &&
          state.counters.calls + 1 > DEMO_MANAGEMENT_LIMITS.calls - DEMO_MANAGEMENT_LIMITS.cleanup_reserve_calls)
        fail('DEMO_MANAGEMENT_CLEANUP_RESERVE', 7, 'Run dispatch reached the fixed cleanup-call reserve.');
      if (plan.live_authorized && isRead && !state.cleanup_started &&
          state.counters.status_reads + 1 > DEMO_MANAGEMENT_LIMITS.status_reads - DEMO_MANAGEMENT_LIMITS.cleanup_reserve_status_reads)
        fail('DEMO_MANAGEMENT_CLEANUP_RESERVE', 7, 'Run dispatch reached the fixed cleanup-status reserve.');
      if (action === 'send-event') {
        if (state.counters.event_sends >= DEMO_MANAGEMENT_LIMITS.event_sends) fail('DEMO_MANAGEMENT_EVENT_LIMIT', 7, 'Workflow event-send ceiling reached.');
        if (eventSequence !== state.next_event_sequence) fail('DEMO_MANAGEMENT_SEQUENCE', 5, 'Event sequence is not the next reserved sequence.');
        state.next_event_sequence++;
      }
      this.assertCleanupOrder(state, action, plan);
      state.counters.calls++; state.counters.request_bytes += requestBytes;
      if (isRead) state.counters.status_reads++;
      if (action === 'send-event') state.counters.event_sends++;
      if (cleanupAction) state.counters.cleanup_calls++;
      const call_id = 'mgmt-' + state.counters.calls;
      state.in_flight = { call_id, action, request_digest: requestDigest, reserved_at: now };
      state.history.push({ call_id, action, request_digest: requestDigest, result: 'reserved' });
      return { state, value: { call_id, action, target_digest: targetDigest } };
    });
  }

  async settle(plan: DemoManagementPlan, ticket: DemoManagementReservation, response: unknown): Promise<void> {
    const responseDigest = digest(response), responseBytes = Buffer.byteLength(canonical(response));
    const overLimit = await this.transaction(state => {
      this.assertTicket(state, plan, ticket);
      const active = state!.in_flight!;
      if (state!.supplemental_read) fail('DEMO_MANAGEMENT_TICKET', 5, 'Instance observation has an unsettled supplemental read.');
      if (responseBytes > DEMO_MANAGEMENT_LIMITS.max_response_bytes_per_call ||
          state!.counters.response_bytes + responseBytes > DEMO_MANAGEMENT_LIMITS.response_bytes) {
        state!.counters.response_bytes += responseBytes; state!.reconciliation_required = true; state!.in_flight = null;
        const item = state!.history.find(entry => entry.call_id === ticket.call_id)!;
        item.response_digest = responseDigest; item.response_bytes = responseBytes; item.result = 'uncertain';
        return { state: state!, value: true };
      }
      this.applyCleanupResult(state!, active.action, response, plan.target, plan);
      state!.counters.response_bytes += responseBytes; state!.in_flight = null;
      const item = state!.history.find(entry => entry.call_id === ticket.call_id)!;
      item.response_digest = responseDigest; item.response_bytes = responseBytes; item.result = 'complete';
      return { state: state!, value: false };
    });
    if (overLimit) fail('DEMO_MANAGEMENT_RESPONSE_BYTES_LIMIT', 7, 'Management response exceeded the fixed byte ceiling; admission requires reconciliation.');
  }

  async uncertain(plan: DemoManagementPlan, ticket: DemoManagementReservation): Promise<void> {
    await this.transaction(state => {
      this.assertTicket(state, plan, ticket); state!.reconciliation_required = true; state!.in_flight = null;
      if (state!.supplemental_read) {
        state!.history.find(entry => entry.call_id === state!.supplemental_read!.call_id)!.result = 'uncertain';
        delete state!.supplemental_read;
      }
      const item = state!.history.find(entry => entry.call_id === ticket.call_id)!; item.result = 'uncertain';
      return { state: state!, value: undefined };
    });
  }

  async reserveSupplementalRead(plan: DemoManagementPlan, parent: DemoManagementReservation, step: DemoFullStep, now: number) {
    validateDemoFullStep(step);
    const request = { action: 'describe-step', target: plan.target, step }, requestBytes = Buffer.byteLength(canonical(request));
    return this.transaction(state => {
      this.assertTicket(state, plan, parent);
      if (parent.action !== 'describe-instance' || state!.supplemental_read || state!.reconciliation_required)
        fail('DEMO_MANAGEMENT_RECONCILIATION_REQUIRED', 7, 'Supplemental reads require the current serialized instance observation.');
      if (now < plan.started_at || now >= plan.expires_at) fail('DEMO_MANAGEMENT_DEADLINE', 7, 'Full-step read exceeds the fixed deadline.');
      const cleanup = state!.cleanup_started || now >= plan.expires_at - DEMO_MANAGEMENT_LIMITS.cleanup_ms;
      const callLimit = DEMO_MANAGEMENT_LIMITS.calls - (cleanup ? 0 : DEMO_MANAGEMENT_LIMITS.cleanup_reserve_calls);
      const readLimit = DEMO_MANAGEMENT_LIMITS.status_reads - (cleanup ? 0 : DEMO_MANAGEMENT_LIMITS.cleanup_reserve_status_reads);
      if (state!.counters.calls >= callLimit || state!.counters.status_reads >= readLimit)
        fail('DEMO_MANAGEMENT_CLEANUP_RESERVE', 7, 'Full-step read reached the fixed call/read ceiling or cleanup reserve.');
      if (state!.counters.request_bytes + requestBytes > DEMO_MANAGEMENT_LIMITS.request_bytes)
        fail('DEMO_MANAGEMENT_REQUEST_BYTES_LIMIT', 7, 'Full-step request exceeds the fixed transfer budget.');
      state!.counters.calls++; state!.counters.status_reads++; state!.counters.request_bytes += requestBytes;
      const call_id = 'mgmt-' + state!.counters.calls;
      state!.history.push({ call_id, action: 'describe-step', request_digest: digest(request), result: 'reserved' });
      state!.supplemental_read = { call_id, parent_call_id: parent.call_id };
      return { state: state!, value: call_id };
    });
  }

  async settleSupplementalRead(plan: DemoManagementPlan, parent: DemoManagementReservation, callId: string, response: unknown) {
    const bytes = Buffer.byteLength(canonical(response));
    const overLimit = await this.transaction(state => {
      this.assertTicket(state, plan, parent);
      if (state!.supplemental_read?.call_id !== callId || state!.supplemental_read.parent_call_id !== parent.call_id)
        fail('DEMO_MANAGEMENT_TICKET', 5, 'Full-step response does not match its reserved observation.');
      const item = state!.history.find(entry => entry.call_id === callId)!;
      item.response_digest = digest(response); item.response_bytes = bytes;
      const over = bytes > DEMO_MANAGEMENT_LIMITS.max_response_bytes_per_call || state!.counters.response_bytes + bytes > DEMO_MANAGEMENT_LIMITS.response_bytes;
      item.result = over ? 'uncertain' : 'complete'; state!.counters.response_bytes += bytes;
      if (over) state!.reconciliation_required = true;
      delete state!.supplemental_read;
      return { state: state!, value: over };
    });
    if (overLimit) fail('DEMO_MANAGEMENT_RESPONSE_BYTES_LIMIT', 7, 'Full-step response exceeded the fixed transfer budget.');
  }

  async beginCleanup(plan: DemoManagementPlan): Promise<void> {
    await this.transaction(state => {
      this.assertState(state, plan);
      if (state!.in_flight || state!.reconciliation_required) fail('DEMO_MANAGEMENT_RECONCILIATION_REQUIRED', 7, 'Cannot enter cleanup with an unsettled provider call.');
      state!.cleanup_started = true; return { state: state!, value: undefined };
    });
  }

  async snapshot(plan: DemoManagementPlan): Promise<DemoManagementLedgerState> {
    return this.transaction(state => { this.assertState(state, plan); return { state: state!, value: structuredClone(state!) }; });
  }

  private assertState(state: DemoManagementLedgerState | null, plan: DemoManagementPlan) {
    if (!state || state.grant_id !== plan.grant_id || state.target_digest !== digest(plan.target) || state.started_at !== plan.started_at || state.expires_at !== plan.expires_at)
      fail('DEMO_MANAGEMENT_TARGET_CONFLICT', 5, 'No matching admission ledger exists.');
  }
  private assertTicket(state: DemoManagementLedgerState | null, plan: DemoManagementPlan, ticket: DemoManagementReservation) {
    this.assertState(state, plan);
    if (!state!.in_flight || state!.in_flight.call_id !== ticket.call_id || state!.in_flight.action !== ticket.action || state!.target_digest !== ticket.target_digest)
      fail('DEMO_MANAGEMENT_TICKET', 5, 'Provider result does not match its reserved call.');
  }
  private assertCleanupOrder(state: DemoManagementLedgerState, action: DemoManagementAction, plan: DemoManagementPlan) {
    const c = state.cleanup;
    if (action === 'delete-instance' && (!c.terminal_instance_verified || !c.local_dispatches_settled || !c.repo_tokens_clean || !c.handles_disposed))
      fail('DEMO_MANAGEMENT_CLEANUP_ORDER', 7, 'A terminal instance and explicit settled/revoked/disposed local resource counts are required before deletion.');
    if (action === 'delete-workflow' && !c.instance_absent) fail('DEMO_MANAGEMENT_CLEANUP_ORDER', 7, 'Verify instance absence before deleting its Workflow.');
    if (action === 'delete-worker' && !c.workflow_absent) fail('DEMO_MANAGEMENT_CLEANUP_ORDER', 7, 'Verify Workflow absence before deleting its Worker.');
    const infrastructureClean = plan.infrastructure ? c.instance_absent && c.worker_retained_verified && c.workflow_retained_verified : c.worker_absent;
    if (action === 'delete-repository' && (!infrastructureClean || !c.repo_tokens_clean || !c.handles_disposed || !c.local_dispatches_settled))
      fail('DEMO_MANAGEMENT_CLEANUP_ORDER', 7, 'Verify Worker absence and settled/revoked/disposed Artifacts state before repository deletion.');
    if (action === 'list-namespace' && !c.repository_absent) fail('DEMO_MANAGEMENT_CLEANUP_ORDER', 7, 'Verify repository absence before checking the retained namespace.');
    if (c.namespace_empty_verified) fail('DEMO_MANAGEMENT_CLEANUP_ORDER', 7, 'Cleanup is complete; the namespace is retained and cannot be mutated.');
  }
  private applyCleanupResult(state: DemoManagementLedgerState, action: DemoManagementAction, value: unknown, target: DemoManagementTarget, plan: DemoManagementPlan) {
    const result = value as any, c = state.cleanup;
    const lab = plan.infrastructure;
    if (lab && ['preflight-worker', 'describe-worker', 'preflight-workflow', 'describe-workflow'].includes(action)) {
      const valid = result?.found === true && (action.endsWith('worker')
        ? result.worker_name === target.worker_name && result.worker_version_id === lab.worker_version_id
        : result.workflow_name === target.workflow_name && result.workflow_id === lab.workflow_id && result.script_name === target.worker_name &&
          result.class_name === 'StrataIntegratedDemoWorkflow' && result.workflow_version_id === lab.workflow_version_id);
      if (!valid) fail('DEMO_LAB_IDENTITY_REFUSED', 7, 'Persistent lab resource or deployed version differs from the approved exact review.');
      if (state.cleanup_started && c.instance_absent) {
        if (action === 'describe-worker') c.worker_retained_verified = true;
        if (action === 'describe-workflow') c.workflow_retained_verified = true;
      }
      return;
    }
    if (action === 'preflight-lab-instances') {
      if (!lab || result?.workflow_name !== target.workflow_name || !Array.isArray(result.instances) || result.instances.length !== 0)
        fail('DEMO_LAB_INSTANCES_PRESENT', 7, 'Existing lab instances require reconciliation before a fresh demo.');
      return;
    }
    if (action === 'preflight-full-step') {
      if (result?.accepted !== true || result?.account_id !== target.account_id)
        fail('DEMO_MANAGEMENT_SETUP_REFUSED', 7, 'Full-step CLI must verify read access to the exact account before provisioning.');
      return;
    }
    if (['preflight-namespace', 'preflight-worker', 'preflight-workflow'].includes(action)) {
      if (action === 'preflight-namespace' ? result?.namespace_id !== target.namespace_id || !Array.isArray(result.repositories) || result.repositories.length !== 0 : result?.found !== false)
        fail('DEMO_MANAGEMENT_SETUP_REFUSED', 7, 'Provisioning requires an empty retained namespace and absent exact Worker/Workflow.');
      return;
    }
    if (action === 'deploy-private') {
      if (result?.accepted !== true) fail('DEMO_MANAGEMENT_SETUP_REFUSED', 7, 'Provisioning did not settle successfully.');
      return;
    }
    if (action === 'create-instance') {
      if (!state.instance_create_requested || result?.accepted !== true || result.workflow_name !== target.workflow_name || result.instance_id !== target.instance_id)
        fail('DEMO_MANAGEMENT_INSTANCE_CREATE_REFUSED', 5, 'Workflow creation did not confirm the exact reviewed workflow and instance ID.');
      state.instance_created = true;
      return;
    }
    if (action === 'describe-instance') {
      if (result?.found === false) { if (c.instance_delete_requested) c.instance_absent = true; return; }
      if (result?.found === true && c.instance_delete_requested) c.instance_absent = false;
      state.instance_ready_verified = state.instance_created && result?.found === true && ['running', 'waiting'].includes(result?.status);
      if (result?.found !== true || !['complete', 'errored', 'terminated'].includes(result.status)) return;
      if (!Number.isSafeInteger(result.used_steps) || result.used_steps < 0 ||
          !Number.isSafeInteger(result.artifact_dispatches) || result.artifact_dispatches < 0)
        fail('DEMO_MANAGEMENT_INNER_COUNTS_MISSING', 7, 'Terminal Workflow output must include exact step and Artifact dispatch counts.');
      if (result.used_steps > DEMO_LIMITS.steps || result.artifact_dispatches > DEMO_LIMITS.artifact_dispatches)
        fail('DEMO_MANAGEMENT_INNER_LIMIT', 7, 'Workflow output exceeded its step or Artifact dispatch ceiling.');
      c.terminal_instance_verified = true;
      c.local_dispatches_settled = result.unsettled_dispatches === 0;
      c.repo_tokens_clean = Number.isSafeInteger(result.repo_tokens_issued) && result.repo_tokens_issued >= 0 &&
        result.repo_tokens_issued <= DEMO_MANAGEMENT_LIMITS.repo_tokens_issued && result.repo_tokens_revoked === result.repo_tokens_issued;
      c.handles_disposed = Number.isSafeInteger(result.handles_open) && result.handles_open === 0;
      return;
    }
    if (action === 'delete-instance' && result?.accepted === true) {
      c.instance_delete_requested = true;
      if (result.deleted_instance_id === target.instance_id) c.instance_absent = true;
      return;
    }
    if (action === 'describe-workflow' && result?.found === false && c.workflow_delete_requested) { c.workflow_absent = true; return; }
    if (action === 'delete-workflow' && result?.accepted === true) { c.workflow_delete_requested = true; return; }
    if (action === 'describe-worker' && result?.found === false && c.worker_delete_requested) { c.worker_absent = true; return; }
    if (action === 'delete-worker' && result?.accepted === true) { c.worker_delete_requested = true; return; }
    if (action === 'describe-repository' && result?.found === false && c.repository_delete_requested) { c.repository_absent = true; return; }
    if (action === 'delete-repository' && result?.accepted === true) { c.repository_delete_requested = true; return; }
    if (action === 'list-namespace' && result?.namespace_id !== target.namespace_id) fail('DEMO_MANAGEMENT_NAMESPACE_REFUSED', 5, 'Namespace verification did not return the exact retained namespace ID.');
    if (action === 'list-namespace') {
      if (!Array.isArray(result.repositories) || result.repositories.length !== 0) fail('DEMO_MANAGEMENT_NAMESPACE_NOT_EMPTY', 7, 'Retained namespace still contains repositories.');
      c.namespace_empty_verified = true; return;
    }
    if (action === 'send-event' && result?.accepted === true) return;
    if (['delete-instance', 'delete-workflow', 'delete-worker', 'delete-repository'].includes(action) && result?.accepted === true) return;
    if (action.startsWith('describe-')) return;
    fail('DEMO_MANAGEMENT_RESPONSE_REFUSED', 5, 'Management provider response did not match the reserved operation.');
  }
}

export class DemoManagementAdmissionPort {
  readonly live_authorized: boolean;
  readonly plan: Readonly<DemoManagementPlan>;
  constructor(plan: DemoManagementPlan, private readonly journal: FileDemoManagementJournal,
    private readonly provider: DemoManagementProvider, private readonly now: () => number = Date.now) {
    validatePlan(plan);
    this.plan = deepFreeze(structuredClone(plan)) as Readonly<DemoManagementPlan>;
    this.live_authorized = this.plan.live_authorized;
    if (!provider)
      fail('DEMO_MANAGEMENT_PROVIDER_REFUSED', 7, 'Management provider must implement an explicit supported transport.');
    if (!['mock-only', 'wrangler-cli'].includes(provider.mode))
      fail('DEMO_MANAGEMENT_LIVE_DISABLED', 7, 'Unrecognized live management providers are refused.');
    if (typeof provider.call !== 'function')
      fail('DEMO_MANAGEMENT_PROVIDER_REFUSED', 7, 'Management provider must implement an explicit supported transport.');
  }

  provision(action: 'preflight-full-step' | 'preflight-namespace' | 'preflight-worker' | 'preflight-workflow' | 'preflight-lab-instances' | 'deploy-private') { return this.call(action, {}); }
  describeInstance() { return this.call('describe-instance', {}); }
  createInstance() {
    if (!this.live_authorized) fail('DEMO_MANAGEMENT_LIVE_DISABLED', 7, 'Workflow instance creation requires an exact-source, exact-target attended grant.');
    return this.call('create-instance', {});
  }
  async sendEvent(event: DemoEvent) {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        canonical(Object.keys(event).sort()) !== canonical(['format', 'run_id', 'project_id', 'sequence', 'request_id', 'previous_digest', 'phase', 'kind', 'source', 'input', 'input_digest'].sort()) ||
        event.format !== 'strata-integrated-demo-event/1' || event.run_id !== this.plan.target.run_id || event.project_id !== this.plan.target.project_id ||
        !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        typeof event.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.request_id) ||
        !/^[a-f0-9]{64}$/.test(event.previous_digest) || !['new', 'authors', 'selection', 'repair', 'runner', 'endorsement', 'complete', 'aborted', 'failed'].includes(event.phase) ||
        !['bootstrap', 'actor', 'prepare', 'selection', 'realize', 'evidence', 'endorse', 'stop'].includes(event.kind) ||
        !/^(host|operator|runner|actor:[abc])$/.test(event.source) || digest(event.input) !== event.input_digest ||
        Buffer.byteLength(canonical(event)) > DEMO_MANAGEMENT_LIMITS.event_bytes)
      fail('DEMO_MANAGEMENT_EVENT_REFUSED', 4, 'Event does not bind the exact run/project, sequence and input digest.');
    return this.call('send-event', { event_type: demoEventType(event.sequence), event }, event.sequence);
  }
  beginCleanup() { return this.journal.beginCleanup(this.plan); }
  cleanup(action: Exclude<DemoCleanupAction, 'send-event' | 'create-instance'>) { return this.call(action, {}); }
  async snapshot() { return this.journal.snapshot(this.plan); }

  private async call(action: DemoManagementAction, payload: Record<string, unknown>, eventSequence?: number): Promise<unknown> {
    if (this.provider.supports && !this.provider.supports(action))
      fail('DEMO_MANAGEMENT_ACTION_UNSUPPORTED', 7, 'The selected management transport does not support this operation.');
    if (this.provider.mode === 'wrangler-cli' && this.plan.mode !== 'reviewed-attended')
      fail('DEMO_MANAGEMENT_LIVE_DISABLED', 7, 'Wrangler dispatch requires a current exact-source, exact-target, attended grant.');
    this.provider.preflight?.(action, this.plan);
    const request: DemoManagementRequest = { action, target: this.plan.target, ...(action === 'send-event' ? payload as { event_type: string; event: DemoEvent } : {}) };
    const requestBytes = Buffer.byteLength(canonical(request)), requestDigest = digest(request), now = this.now();
    const ticket = await this.journal.reserve(this.plan, action, requestDigest, requestBytes, now, eventSequence);
    try {
      const supplementalRead: DemoSupplementalRead = async (step, operation) => {
        const callId = await this.journal.reserveSupplementalRead(this.plan, ticket, step, this.now());
        const response = await operation();
        await this.journal.settleSupplementalRead(this.plan, ticket, callId, response);
        return structuredClone(response);
      };
      const response = await this.provider.call(structuredClone(request), action === 'describe-instance' ? supplementalRead : undefined);
      await this.journal.settle(this.plan, ticket, response);
      return structuredClone(response);
    } catch (error) {
      await this.journal.uncertain(this.plan, ticket).catch(() => undefined);
      throw error;
    }
  }
}

export function demoManagementPlan(target: DemoManagementTarget, startedAt: number, grantId = 'local-' + target.run_id): DemoManagementPlan {
  validateDemoManagementTarget(target);
  return { format: 'strata.integrated-demo-management-plan/1', mode: 'admission-only', live_authorized: false, grant_id: grantId,
    target: structuredClone(target), started_at: startedAt, expires_at: startedAt + DEMO_MANAGEMENT_LIMITS.duration_ms,
    limits: DEMO_MANAGEMENT_LIMITS };
}
export const mockDemoManagementPlan = demoManagementPlan;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validatePlan(plan: DemoManagementPlan) {
  validateDemoManagementTarget(plan.target);
  const baseValid = /^[a-zA-Z0-9_-]{1,80}$/.test(plan.grant_id) && Number.isFinite(plan.started_at) &&
    plan.expires_at === plan.started_at + DEMO_MANAGEMENT_LIMITS.duration_ms && canonical(plan.limits) === canonical(DEMO_MANAGEMENT_LIMITS);
  const disabled = plan.format === 'strata.integrated-demo-management-plan/1' && plan.mode === 'admission-only' && plan.live_authorized === false && baseValid;
  const approved = plan.format === 'strata.integrated-demo-management-plan/2' && plan.mode === 'reviewed-attended' && plan.live_authorized === true && baseValid &&
    /^[a-f0-9]{64}$/.test(plan.source_sha256) && plan.target_sha256 === digest(plan.target) && /^[a-f0-9]{64}$/.test(plan.grant_sha256) &&
    reviewedPlans.get(plan) === digest(plan);
  if (!disabled && !approved)
    fail('DEMO_MANAGEMENT_PLAN_REFUSED', 7, 'Management plan must be the fixed disabled 30-minute profile.');
}

export type LiveDemoInstanceDescription = { found: true; status: string; checkpoint: DemoCheckpoint; outcome?: unknown; workflow_export?: unknown };
export type ReviewedDemoDispatchResult = { checkpoint: DemoCheckpoint; outcome: unknown; reused: boolean; workflow_export?: unknown };
export function createReviewedDemoDispatch(port: DemoManagementAdmissionPort, options: { max_reads_per_event?: number;
  poll_delay_ms?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const maxReads = options.max_reads_per_event ?? 3, delay = options.poll_delay_ms ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  if (!Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > 8 || !Number.isFinite(delay) || delay < 0 || delay > 5000)
    fail('DEMO_MANAGEMENT_DISPATCH_CONFIG', 4, 'Live Workflow dispatch polling is outside its fixed bound.');
  const verified = (value: unknown): LiveDemoInstanceDescription => {
    const result = value as any, checkpoint = result?.checkpoint as DemoCheckpoint;
    if (result?.found !== true || !['running', 'waiting', 'complete', 'errored', 'terminated'].includes(result?.status) ||
        !checkpoint || checkpoint.format !== 'strata-integrated-demo-checkpoint/1' ||
        checkpoint.run_id !== port.plan.target.run_id || checkpoint.project_id !== port.plan.target.project_id ||
        checkpoint.mode !== 'controlled-private' || checkpoint.started_at !== port.plan.started_at ||
        checkpoint.expires_at !== port.plan.expires_at || !/^[a-f0-9]{64}$/.test(checkpointDigest(checkpoint)))
      fail('DEMO_MANAGEMENT_INSTANCE_STATE_REFUSED', 7, 'Workflow status lacks an exact, digest-valid checkpoint for the attended run.');
    return { found: true, status: result.status, checkpoint: structuredClone(checkpoint), ...(Object.hasOwn(result, 'outcome') ? { outcome: result.outcome } : {}),
      ...(Object.hasOwn(result, 'workflow_export') ? { workflow_export: structuredClone(result.workflow_export) } : {}) };
  };
  return async (event: DemoEvent): Promise<ReviewedDemoDispatchResult> => {
    const before = verified(await port.describeInstance());
    if (!['running', 'waiting'].includes(before.status)) fail('DEMO_MANAGEMENT_INSTANCE_TERMINAL', 7, 'Workflow is not accepting events.');
    if (event.sequence !== before.checkpoint.sequence + 1 || event.previous_digest !== checkpointDigest(before.checkpoint) ||
        event.run_id !== before.checkpoint.run_id || event.project_id !== before.checkpoint.project_id)
      fail('DEMO_MANAGEMENT_EVENT_CHAIN_REFUSED', 5, 'Event must extend the exact latest remote checkpoint digest and sequence.');
    await port.sendEvent(event);
    for (let read = 0; read < maxReads; read++) {
      if (read && delay) await sleep(delay);
      const current = verified(await port.describeInstance());
      if (current.checkpoint.sequence === event.sequence) {
        if (current.checkpoint.previous_digest !== event.previous_digest ||
            current.checkpoint.requests?.[event.request_id]?.event_digest !== digest(event))
          fail('DEMO_MANAGEMENT_EVENT_RESULT_REFUSED', 5, 'Workflow checkpoint does not record the exact dispatched event digest.');
        return { checkpoint: current.checkpoint, outcome: current.outcome, reused: false,
          ...(current.workflow_export === undefined ? {} : { workflow_export: structuredClone(current.workflow_export) }) };
      }
      if (current.checkpoint.sequence > event.sequence || !['running', 'waiting'].includes(current.status))
        fail('DEMO_MANAGEMENT_EVENT_RESULT_REFUSED', 5, 'Workflow checkpoint advanced unexpectedly or became terminal before the exact event settled.');
    }
    fail('DEMO_MANAGEMENT_EVENT_PENDING', 7, 'Workflow event did not settle within the bounded status-read allowance; do not resend it.');
  };
}
export function validateDemoManagementTarget(target: DemoManagementTarget) {
  const name = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
  if (!target || canonical(Object.keys(target).sort()) !== canonical(['account_id', 'project_id', 'run_id', 'worker_name', 'workflow_name', 'instance_id', 'namespace_id', 'repository_name'].sort()) ||
      !/^[a-f0-9]{32}$/.test(target.account_id) || !/^[a-f0-9]{16}$/.test(target.run_id) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(target.project_id) || target.instance_id !== 'run-' + target.run_id ||
      !name(target.worker_name) || !name(target.workflow_name) || !name(target.namespace_id) || !name(target.repository_name))
    fail('DEMO_MANAGEMENT_TARGET_REFUSED', 4, 'All management operations require a complete exact resource target.');
}
