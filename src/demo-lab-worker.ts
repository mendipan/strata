import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { encodeDemoActivationGrant, validateDemoActivationGrant, type BrowserDemoActivationGrant } from './integrated-demo-activation.js';
import { createActivatedDemoRuntime, type IntegratedDemoWorkerEnv } from './integrated-demo-worker-entry.js';
import { runIntegratedDemoWorkflow } from './integrated-demo-workflow.js';
import { safeDemoError } from './integrated-demo.js';
import { parseDemoLabTarget } from './demo-lab-config.js';
import { fail } from './model.js';

type LabEnv = IntegratedDemoWorkerEnv & { STRATA_LAB_TARGET: string; STRATA_LAB_SOURCE_SHA256: string; STRATA_LAB_VERSION: { id: string } };
type LabParams = { probe?: string; run_id: string; activation_grant?: BrowserDemoActivationGrant };

// The only externally callable surface is the account-authorized Workflow API.
// Per-run grants are parameters; the deployed source and version stay pinned.
export function labActivatedEnvironment(env: LabEnv, event: WorkflowEvent<LabParams>, now = Date.now()): IntegratedDemoWorkerEnv {
  const grant = event.payload.activation_grant;
  if (!grant || grant.format !== 'strata.integrated-demo-activation-grant/3')
    fail('DEMO_LIVE_ACTIVATION_REQUIRED', 7, 'Begin the exact reviewed run from the attended local browser.');
  validateDemoActivationGrant(grant, grant.source, now);
  let target;
  try { target = parseDemoLabTarget(JSON.parse(env.STRATA_LAB_TARGET)); }
  catch { fail('DEMO_LAB_IDENTITY_REFUSED', 7, 'Deployed lab target is missing or invalid.'); }
  if (grant.source.sha256 !== env.STRATA_LAB_SOURCE_SHA256 || grant.infrastructure.worker_version_id !== env.STRATA_LAB_VERSION?.id ||
    grant.target.account_id !== target.account_id || grant.target.namespace_id !== target.namespace_id ||
    grant.target.worker_name !== target.worker_name || grant.target.workflow_name !== target.workflow_name ||
    event.payload.run_id !== grant.target.run_id || event.instanceId !== grant.target.instance_id)
    fail('DEMO_LAB_VERSION_REFUSED', 7, 'The grant does not match this deployed source, version and exact run.');
  return { ARTIFACTS: env.ARTIFACTS, ...encodeDemoActivationGrant(grant), STRATA_DEMO_ACTIVATION_GRANT_SHA256: grant.grant_sha256,
    STRATA_DEMO_SOURCE_SHA256: grant.source.sha256, STRATA_DEMO_TARGET_SHA256: grant.target_sha256,
    STRATA_DEMO_WORKER_NAME: grant.target.worker_name, STRATA_DEMO_WORKFLOW_NAME: grant.target.workflow_name,
    STRATA_DEMO_PROJECT_ID: grant.target.project_id };
}

export class StrataIntegratedDemoWorkflow extends WorkflowEntrypoint<LabEnv, LabParams> {
  async run(event: WorkflowEvent<LabParams>, step: WorkflowStep) {
    if (event.payload.probe && !event.payload.activation_grant && /^[a-f0-9]{32}$/.test(event.payload.probe) && event.instanceId === 'probe-' + event.payload.probe) {
      return step.do('browser-lab-readiness', { retries: { limit: 0, delay: 1 }, timeout: '10 seconds' }, async () => {
        if (!this.env.ARTIFACTS || !/^[a-f0-9]{64}$/.test(this.env.STRATA_LAB_SOURCE_SHA256) || !this.env.STRATA_LAB_VERSION?.id)
          throw new Error('Lab bindings are incomplete.');
        let refusal: string | undefined;
        try { labActivatedEnvironment(this.env, event); } catch (error: any) { refusal = error.code; }
        if (refusal !== 'DEMO_LIVE_ACTIVATION_REQUIRED') throw new Error('Ungranted run did not refuse.');
        return { ok: true, diagnostic: 'browser-lab-private-workflow', probe: event.payload.probe, instance_id: event.instanceId,
          source_sha256: this.env.STRATA_LAB_SOURCE_SHA256, worker_version_id: this.env.STRATA_LAB_VERSION.id,
          real_demo_module_loaded: true, artifacts_binding_present: true, activation_refusal: refusal,
          actors: 0, repo_tokens: 0, external_calls: 0 };
      });
    }
    try {
      const runtime = createActivatedDemoRuntime(labActivatedEnvironment(this.env, event), event);
      // The approval envelope is consumed by this wrapper. The core Workflow
      // accepts only its original fixed run payload, not transport metadata.
      const runEvent = { ...event, payload: { run_id: event.payload.run_id } };
      return await runIntegratedDemoWorkflow(runEvent, step, runtime.controller, runtime.runMode);
    } catch (error) { return safeDemoError(error); }
  }
}
