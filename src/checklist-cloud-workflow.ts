import { z } from 'zod';
import { canonical, digest, bytesDigest, fail, parse } from './model.js';
import { CloudflareArtifactsAdapter, type ArtifactsNamespace, type ArtifactLocator } from './artifacts.js';
import { ArtifactRegistryStore, type LocatedRegistry } from './artifact-registry.js';
import { RunBudget } from './budget.js';
import type { FetchTransport } from './artifacts-git.js';
import { CHECKLIST_CEILINGS, verifyPrepared, type PreparedChecklist } from './checklist-cloud-contract.js';
import { boundedChecklistJson, checklistSequence, verifyChecklistObservation } from './checklist-cloud-app-worker.js';
import { checklistConfigDigest } from './checklist-cloud-config.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const checklistGrantSchema = z.object({ format: z.literal('strata-checklist-cloud-run-grant/1'), approved: z.literal(true),
  approval_id: z.string().min(1).max(128), preparation_sha256: hash, source_sha256: hash, target_sha256: hash,
  config_sha256:hash,workflow_id:z.string().min(1).max(128),workflow_definition_version_id:z.string().min(1).max(128),
  workflow_version_id: z.string().min(1), app_version_id: z.string().min(1), started_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(), cleanup_expires_at: z.number().int().positive(),
  metered_charges_accepted: z.literal(true), spending_limit_usd: z.number().positive().finite(),
  retention: z.object({ repository: z.enum(['retain', 'delete']), instance: z.literal('delete'), workers: z.enum(['retain', 'delete']) }).strict() }).strict();
export type ChecklistRunGrant = z.infer<typeof checklistGrantSchema>;
const eventPayloadSchema=z.object({run_id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),grant_sha256:hash,grant:checklistGrantSchema}).strict();
export type ChecklistWorkflowEvent={instanceId:string;payload:z.infer<typeof eventPayloadSchema>};
// REST parameters can arrive as their documented JSON string. Decode once at
// ingress; this is a representation change, never a substitute for grant checks.
export function checklistWorkflowEvent(event:{instanceId:string;payload:unknown}):ChecklistWorkflowEvent {
  let payload=event.payload;
  if(typeof payload==='string'){
    if(Buffer.byteLength(payload)>CHECKLIST_CEILINGS.request_bytes)fail('CHECKLIST_GRANT_REFUSED',7,'Workflow payload exceeds the request bound.');
    try{payload=JSON.parse(payload);}catch{fail('CHECKLIST_GRANT_REFUSED',7,'Workflow payload must contain one JSON object.');}
  }
  const parsed=parse(eventPayloadSchema,payload);
  if(Buffer.byteLength(canonical(parsed))>CHECKLIST_CEILINGS.request_bytes)fail('CHECKLIST_GRANT_REFUSED',7,'Workflow payload exceeds the request bound.');
  return {instanceId:event.instanceId,payload:parsed};
}
// Deployment assigns version IDs. Pin predeployment authorization separately to avoid a grant/config/version hash cycle.
// The two returned version IDs remain mandatory and checked against native metadata/service response.
export function checklistAuthorizationDigest(g: ChecklistRunGrant) {
  const {workflow_version_id,app_version_id,workflow_id,workflow_definition_version_id,...authorization}=g; return digest(authorization);
}
export type ChecklistRuntimePins = { source_sha256: string; grant_sha256: string; authorization_sha256: string; workflow_version_id: string; app_version_id: string };
export function verifyChecklistGrant(raw: unknown, p: PreparedChecklist, runtime: ChecklistRuntimePins, now: number, allowSynthetic = false): ChecklistRunGrant {
  verifyPrepared(p, allowSynthetic); const g = parse(checklistGrantSchema, raw);
  if (p.input.evidence_kind !== 'published-local-history' && !allowSynthetic) fail('CHECKLIST_GRANT_REFUSED', 7, 'Synthetic package cannot be dispatched remotely.');
  if (digest(g) !== runtime.grant_sha256 || checklistAuthorizationDigest(g) !== runtime.authorization_sha256 || g.preparation_sha256 !== digest(p) || g.source_sha256 !== runtime.source_sha256 ||
    g.target_sha256 !== p.target_sha256 || g.config_sha256!==checklistConfigDigest(p,runtime.source_sha256)||g.workflow_version_id !== runtime.workflow_version_id || g.app_version_id !== runtime.app_version_id ||
    now < g.started_at || now >= g.expires_at || g.expires_at - g.started_at > CHECKLIST_CEILINGS.run_ms ||
    g.cleanup_expires_at - g.expires_at !== CHECKLIST_CEILINGS.cleanup_ms) fail('CHECKLIST_GRANT_REFUSED', 7, 'Fresh trusted consumed grant/source/target/version/time pins required.');
  return g;
}
export const CHECKLIST_STEPS = ['claim-run', 'reserve-archive', 'archive-closure', 'reserve-index', 'archive-index', 'cold-read', 'reserve-observations', 'observe-app'] as const;
export type ChecklistStepName = typeof CHECKLIST_STEPS[number];
export type ChecklistStepContext = {step:{name:string;count:number};attempt:number;config:{retries?:{limit:number}}};
export interface ChecklistSteps { do<T>(name: ChecklistStepName, config: { retries: { limit: 0; delay: number }; timeout: string }, callback: (ctx:ChecklistStepContext) => Promise<T>): Promise<T> }
export type ChecklistWorkflowPorts = { namespace: ArtifactsNamespace; transport: FetchTransport; app: { fetch(request: Request): Promise<Response> };
  now: () => number; mode: 'remote' | 'synthetic-test-only'; provision?: (adapter: CloudflareArtifactsAdapter) => Promise<void> };
export type ChecklistArchiveIndex = { format: 'strata-checklist-cloud-archive-index/1'; preparation_sha256: string;
  source_sha256: string; target_sha256: string; pins: PreparedChecklist['pins']; registry: LocatedRegistry;
  location_claim: string; authority_active: false; live_project_restore: false };
export type ChecklistCloudResult = { format: 'strata-checklist-cloud-result/1'; evidence_kind: 'remote-observation' | 'synthetic-test-only';
  run_id: string; instance_id: string; source_sha256: string; target_sha256: string; preparation_sha256: string;
  pins: PreparedChecklist['pins']; archive_index: ArtifactLocator; registry: LocatedRegistry; observations: unknown[];
  cold_read_verified: true; cleanup: { unsettled_dispatches: number; repo_tokens_issued: number | null; repo_tokens_revoked: number | null; handles_open: number };
  cumulative_reserved: PreparedChecklist['qualification']['reservations']&{repo_tokens:number;stage_batches:number;workflow_subrequests:PreparedChecklist['qualification']['workflow_subrequests']}; token_allowance_consumed: number; semantic_location: 'Node'; runtime_location: 'Worker'; invoice_cap: false };
const config = { retries: { limit: 0 as const, delay: 1 }, timeout: '2 minutes' };
function clean(a: CloudflareArtifactsAdapter) {
  const c = a.managementCleanupCounts();
  if (c.unsettled_dispatches || c.handles_open || c.repo_tokens_issued === null || c.repo_tokens_revoked !== c.repo_tokens_issued) fail('CHECKLIST_CLEANUP_REFUSED', 9, 'Outstanding dispatch/token/handle state; run cannot report success.');
  return c;
}

// Entrypoint generated outside the repo extends native WorkflowEntrypoint. There is no fetch/RPC/schedule ingress.
// Already published history is batched; this never executes Strata writer/reviewer/Release operations.
export async function runChecklistCloudWorkflow(p: PreparedChecklist, grant: unknown, runtime: ChecklistRuntimePins,
  event: ChecklistWorkflowEvent, step: ChecklistSteps, ports: ChecklistWorkflowPorts): Promise<ChecklistCloudResult> {
  const synthetic = ports.mode === 'synthetic-test-only', now = ports.now();
  const g = verifyChecklistGrant(grant, p, runtime, now, synthetic);
  if (event.instanceId !== p.target.instance_id || canonical(event.payload) !== canonical({ run_id: p.target.run_id, grant_sha256: runtime.grant_sha256, grant:g })) fail('CHECKLIST_GRANT_REFUSED', 7, 'Only the exact single instance may consume this run.');
  const once = <T>(name:ChecklistStepName, callback:()=>Promise<T>)=>step.do(name,config,async ctx=>{
    if(ctx?.step.name!==name||ctx.step.count!==1||ctx.attempt!==1||ctx.config.retries?.limit!==0)fail('CHECKLIST_STEP_REPLAY_REFUSED',7,'First invocation/attempt only; no allowance replenishment after failure.');
    return callback();
  });
  const claim = await once('claim-run', async () => ({ grant_sha256: digest(g), preparation_sha256: digest(p), expires_at: g.expires_at,
    run_id: p.target.run_id, instance_id: event.instanceId }));
  if (canonical(claim) !== canonical({ grant_sha256: digest(g), preparation_sha256: digest(p), expires_at: g.expires_at, run_id: p.target.run_id, instance_id: event.instanceId })) fail('CHECKLIST_GRANT_REFUSED', 7, 'Durable claim differs; no replay.');
  const q = p.qualification;
  // Reserve the ENTIRE Artifacts allowance durably before provider work. Hibernation never replenishes it.
  const reserved = await once('reserve-archive', async () => ({ ...q.reservations, repo_tokens: q.token_issuances, stage_batches: 2 as const,workflow_subrequests:q.workflow_subrequests }));
  if (canonical(reserved) !== canonical({ ...q.reservations, repo_tokens: q.token_issuances, stage_batches: 2,workflow_subrequests:q.workflow_subrequests })) fail('CHECKLIST_BUDGET_REFUSED', 7, 'Durable cumulative reservation changed.');
  function adapter(limits: typeof q.reservations, maxTokens: number) {
    if (ports.now() >= g.expires_at) fail('CHECKLIST_GRANT_REFUSED', 7, 'Consumed run expired; no new dispatch.');
    const budget = new RunBudget({ ...limits, duration_ms: Math.min(limits.duration_ms, g.expires_at - ports.now()) });
    return { budget, value: new CloudflareArtifactsAdapter({ namespace: ports.namespace, repository: p.target.repository, budget,
      transport: ports.transport, max_repo_tokens: maxTokens, ...(synthetic ? { mode: 'strict-mock' as const, identity: { account: p.target.account_id, namespace: p.target.namespace } } :
        { mode: 'remote' as const, identity: { account: p.target.account_id, namespace: p.target.namespace }, approval: { approved: true as const,
          repository: p.target.repository, project_id: p.target.project_id, approval_id: g.approval_id, expires_at: new Date(g.expires_at).toISOString() } }) }) };
  }
  const closure = await once('archive-closure', async () => {
    const a = adapter(q.reservations, 2);
    if (synthetic) { if (!ports.provision) fail('CHECKLIST_SYNTHETIC_REFUSED', 7, 'Explicit synthetic provisioning seam required.'); await ports.provision(a.value); }
    else await a.value.provisionDisposableRepository();
    const store = new ArtifactRegistryStore(a.value, p.input.project_id);
    const staged = await store.stage(p.input.records, new Map(), { entries: {} });
    if (staged.receipt?.commit !== q.closure_commit) fail('CHECKLIST_ARCHIVE_REFUSED', 6, 'Staged closure differs from preparation Git pack.');
    return { registry: { entries: staged.entries, storage: staged.storage, asset_locators: staged.asset_locators }, cleanup: clean(a.value), reserved: a.budget.snapshot().reserved };
  });
  const remaining = Object.fromEntries(Object.entries(q.reservations).map(([key, limit]) => [key, key === 'duration_ms' ? limit : limit - closure.reserved[key as keyof typeof closure.reserved]])) as typeof q.reservations;
  const index: ChecklistArchiveIndex = { format: 'strata-checklist-cloud-archive-index/1', preparation_sha256: digest(p), source_sha256: runtime.source_sha256,
    target_sha256: p.target_sha256, pins: p.pins, registry: closure.registry, location_claim: p.location_claim, authority_active: false, live_project_restore: false };
  const indexBytes = canonical(index), indexHash = bytesDigest(indexBytes);
  if (Buffer.byteLength(indexBytes) > q.index_max_bytes) fail('CHECKLIST_BUDGET_REFUSED', 7, 'Archive index exceeds its prepaid bound.');
  const indexReservation = await once('reserve-index', async () => ({ remaining, token_allowance_consumed: 3, stage_batches_consumed: 2, index_sha256: indexHash }));
  if (canonical(indexReservation) !== canonical({ remaining, token_allowance_consumed: 3, stage_batches_consumed: 2, index_sha256: indexHash })) fail('CHECKLIST_BUDGET_REFUSED', 7, 'Index reservation changed.');
  const archived = await once('archive-index', async () => {
    const a = adapter(remaining, 1), result = await a.value.putMany([{ hash: indexHash, bytes: indexBytes }]);
    return { locator: result.locators[0], cleanup: clean(a.value), reserved: a.budget.snapshot().reserved };
  });
  const readRemaining = Object.fromEntries(Object.entries(remaining).map(([key, limit]) => [key, key === 'duration_ms' ? limit : limit - archived.reserved[key as keyof typeof archived.reserved]])) as typeof q.reservations;
  const cold = await once('cold-read', async () => {
    const a = adapter(readRemaining, 0);
    const text = await a.value.getAt(archived.locator);
    if (text !== indexBytes) fail('CHECKLIST_ARCHIVE_REFUSED', 6, 'Exact-commit archive index cold read differs.');
    const stored = JSON.parse(text) as ChecklistArchiveIndex;
    const store = new ArtifactRegistryStore(a.value, p.input.project_id).freshReader();
    const loaded = await store.load(stored.registry);
    if (canonical(loaded.records) !== canonical(p.input.records) || loaded.assetBytes.size !== 0) fail('CHECKLIST_ARCHIVE_REFUSED', 6, 'Exact remote cold read differs; local fallback forbidden.');
    return { verified: true, cleanup: clean(a.value), reserved: a.budget.snapshot().reserved };
  });
  const appReservation = await once('reserve-observations', async () => ({ requests: 2, operation_counts: [checklistSequence(false).length, checklistSequence(true).length],
    source_sha256: runtime.source_sha256, app_version_id: g.app_version_id }));
  if (canonical(appReservation) !== canonical({ requests: 2, operation_counts: [checklistSequence(false).length, checklistSequence(true).length], source_sha256: runtime.source_sha256, app_version_id: g.app_version_id })) fail('CHECKLIST_BUDGET_REFUSED', 7, 'App reservation changed.');
  const observations = await once('observe-app', async () => {
    const result = [];
    for (const unicode of [false, true]) {
      if (ports.now() >= g.expires_at) fail('CHECKLIST_GRANT_REFUSED', 7, 'Run expired before service dispatch.');
      const request = new Request('https://checklist.internal/observe', { method: 'POST', body: canonical({ pins: p.pins, source_sha256: runtime.source_sha256,
        target_sha256: p.target_sha256, worker_version_id: g.app_version_id, operations: checklistSequence(unicode) }), signal: AbortSignal.timeout(Math.min(10000, g.expires_at - ports.now())) });
      const response = await ports.app.fetch(request);
      if (!response.ok) fail('CHECKLIST_OBSERVATION_REFUSED', 6, 'Private service observation failed; no retry.');
      result.push(verifyChecklistObservation(await boundedChecklistJson(response, CHECKLIST_CEILINGS.app_response_bytes), p.pins, runtime.source_sha256, p.target_sha256, g.app_version_id, unicode));
    }
    const counts = [closure.cleanup, archived.cleanup, cold.cleanup];
    const output: ChecklistCloudResult = { format: 'strata-checklist-cloud-result/1', evidence_kind: synthetic ? 'synthetic-test-only' : 'remote-observation', run_id: p.target.run_id,
    instance_id: p.target.instance_id, source_sha256: runtime.source_sha256, target_sha256: p.target_sha256, preparation_sha256: digest(p), pins: p.pins,
    archive_index: archived.locator, registry: closure.registry, observations: result, cold_read_verified: true,
    cleanup: { unsettled_dispatches: 0, handles_open: 0, repo_tokens_issued: counts.reduce((n, c) => n + c.repo_tokens_issued!, 0), repo_tokens_revoked: counts.reduce((n, c) => n + c.repo_tokens_revoked!, 0) },
    cumulative_reserved: reserved, token_allowance_consumed: indexReservation.token_allowance_consumed, semantic_location: 'Node', runtime_location: 'Worker', invoice_cap: false };
    if (Buffer.byteLength(canonical(output)) > CHECKLIST_CEILINGS.response_bytes) fail('CHECKLIST_BUDGET_REFUSED', 7, 'Complete full-step result exceeds its prepaid byte envelope.');
    return output;
  });
  return observations;
}
