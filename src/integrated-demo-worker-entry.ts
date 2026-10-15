import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ArtifactRegistryStore } from './artifact-registry.js';
import { ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT, CloudflareArtifactsAdapter, type ArtifactsNamespace } from './artifacts.js';
import { RunBudget } from './budget.js';
import { DEMO_LIMITS, IntegratedDemo, safeDemoError } from './integrated-demo.js';
import { DEMO_ACTIVATION_LIMITS, decodeDemoActivationGrant, validateDemoActivationGrant } from './integrated-demo-activation.js';
import { LOCAL_PROJECT } from './security.js';
import { runIntegratedDemoWorkflow, type IntegratedDemoWorkflowRunMode } from './integrated-demo-workflow.js';
import { fail } from './model.js';

export type IntegratedDemoWorkerEnv = {
  [key: string]: unknown;
  ARTIFACTS?: ArtifactsNamespace;
  STRATA_DEMO_ACTIVATION_GRANT_MANIFEST?: string;
  STRATA_DEMO_ACTIVATION_GRANT_SHA256?: string;
  STRATA_DEMO_SOURCE_SHA256?: string;
  STRATA_DEMO_TARGET_SHA256?: string;
  STRATA_DEMO_WORKER_NAME?: string;
  STRATA_DEMO_WORKFLOW_NAME?: string;
  STRATA_DEMO_PROJECT_ID?: string;
};

export function createActivatedDemoRuntime(env: IntegratedDemoWorkerEnv, event: WorkflowEvent<{ run_id: string }>, now = Date.now()) {
  if (!env.STRATA_DEMO_ACTIVATION_GRANT_SHA256 || !env.STRATA_DEMO_SOURCE_SHA256 ||
      !env.STRATA_DEMO_TARGET_SHA256 || !env.STRATA_DEMO_WORKER_NAME || !env.STRATA_DEMO_WORKFLOW_NAME ||
      !env.STRATA_DEMO_PROJECT_ID || !env.ARTIFACTS)
    fail('DEMO_LIVE_ACTIVATION_REQUIRED', 7, 'Integrated demo remains disabled until an exact attended grant and pinned Worker bindings are supplied.');
  const grant = decodeDemoActivationGrant(env);
  validateDemoActivationGrant(grant!, grant!.source, now);
  const target = grant!.target;
  if (env.STRATA_DEMO_ACTIVATION_GRANT_SHA256 !== grant!.grant_sha256 || env.STRATA_DEMO_SOURCE_SHA256 !== grant!.source.sha256 ||
      env.STRATA_DEMO_TARGET_SHA256 !== grant!.target_sha256 || env.STRATA_DEMO_WORKER_NAME !== target.worker_name ||
      env.STRATA_DEMO_WORKFLOW_NAME !== target.workflow_name || env.STRATA_DEMO_PROJECT_ID !== target.project_id ||
      target.project_id !== LOCAL_PROJECT || target.run_id !== event.payload?.run_id || target.instance_id !== event.instanceId ||
      event.instanceId !== 'run-' + target.run_id || event.payload?.run_id !== target.run_id)
    fail('DEMO_ACTIVATION_TARGET_MISMATCH', 7, 'Worker bindings or Workflow instance do not match the exact reviewed grant.');
  if (now >= grant!.expires_at - DEMO_LIMITS.cleanup_ms)
    fail('DEMO_ACTIVATION_CLEANUP_WINDOW', 7, 'Workflow start is refused after the grant enters its reserved cleanup window.');

  const remaining = grant!.expires_at - now;
  const budget = new RunBudget({ operations: DEMO_LIMITS.artifact_dispatches, bytes: DEMO_LIMITS.transfer_bytes,
    attempts: DEMO_LIMITS.artifact_dispatches, input_tokens: 0, output_tokens: 0, duration_ms: remaining });
  const adapter = new CloudflareArtifactsAdapter({ mode: 'remote', namespace: env.ARTIFACTS,
    repository: target.repository_name, identity: { account: target.account_id, namespace: target.namespace_id },
    approval: { approved: true, repository: target.repository_name, approval_id: grant!.grant_id, project_id: target.project_id,
      expires_at: new Date(grant!.expires_at - DEMO_LIMITS.cleanup_ms).toISOString() }, budget,
    max_repo_tokens: Math.min(DEMO_ACTIVATION_LIMITS.repo_tokens_issued, ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT),
    transport: request => fetch(request) });
  const storage = new ArtifactRegistryStore(adapter, target.project_id);
  // identity() checks project/account/namespace/repository binding without a provider request.
  storage.binding();
  const controller = new IntegratedDemo(storage, () => Date.now());
  const runMode: IntegratedDemoWorkflowRunMode = { mode: 'controlled-private', started_at: grant!.started_at,
    live_authorized: true, provider_binding_verified: true, initialize: () => adapter.provisionDisposableRepository() };
  return { controller, grant: grant!, runMode };
}

// The entry deliberately has no fetch handler, public route, schedule, or RPC.
// It can only be triggered through the separately named Workflow binding.
export class StrataIntegratedDemoWorkflow extends WorkflowEntrypoint<IntegratedDemoWorkerEnv, { run_id: string }> {
  async run(event: WorkflowEvent<{ run_id: string }>, step: WorkflowStep) {
    try {
      const runtime = createActivatedDemoRuntime(this.env, event);
      return await runIntegratedDemoWorkflow(event, step, runtime.controller, runtime.runMode);
    } catch (error) { return safeDemoError(error); }
  }
}
