import { authoritativeDemoWorkflowOutput, isPendingDemoWorkflowStep } from './integrated-demo-workflow-description.js';
import { DemoFullStepOutputs, describeDemoFullStepCommand, parseDemoFullStepResponse, type DemoSupplementalRead } from './integrated-demo-full-step.js';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { providerDiagnostic } from './provider-diagnostic.js';
import { canonical, digest, fail } from './model.js';
import { DEMO_LIMITS, type DemoEvent } from './integrated-demo.js';
import { demoEventType } from './integrated-demo-workflow.js';
import { DEMO_MANAGEMENT_LIMITS, type DemoManagementAction, type DemoManagementProvider, type DemoManagementRequest,
  type DemoManagementPlan, validateDemoManagementTarget } from './integrated-demo-management.js';
import { createDemoActivationWorkerConfig, readDemoActivationSource, validateDemoActivationGrant, validateDemoActivationBindings,
  type DemoActivationGrant } from './integrated-demo-activation.js';

export const PINNED_WRANGLER_VERSION = '4.147.0';
const COMMAND_TIMEOUT_MS = 30_000;
const INTERACTIVE_ACTIONS = new Set<DemoManagementAction>(['delete-worker']);

export type WranglerCommandDescription = {
  executable: string; args: string[]; cwd: string; account_id: string; interactive: boolean;
  timeout_ms: number; max_output_bytes: number; telemetry_disabled_by_config: boolean;
};
export type WranglerProcessInvocation = Omit<WranglerCommandDescription, 'account_id' | 'telemetry_disabled_by_config'> & {
  env: NodeJS.ProcessEnv; windows_hide: boolean;
};
export type WranglerProcessResult = { code: number; stdout: string; stderr: string };
export type WranglerProcessRunner = (invocation: WranglerProcessInvocation) => Promise<WranglerProcessResult>;
export type WranglerManagementOptions = {
  project_directory?: string; config_path?: string; activation_grant?: DemoActivationGrant;
  run_process?: WranglerProcessRunner; interactive_terminal?: () => boolean;
  base_environment?: NodeJS.ProcessEnv;
};

const allowedActions: readonly DemoManagementAction[] = [
  'create-instance', 'describe-instance', 'send-event', 'delete-instance', 'describe-workflow', 'delete-workflow',
  'describe-worker', 'delete-worker', 'describe-repository', 'delete-repository', 'list-namespace',
  'preflight-full-step', 'preflight-namespace', 'preflight-worker', 'preflight-workflow', 'preflight-lab-instances', 'deploy-private'
];

function pinnedVersion(projectDirectory: string) {
  try {
    const value = JSON.parse(readFileSync(path.join(projectDirectory, 'node_modules', 'wrangler', 'package.json'), 'utf8'));
    return value?.version;
  } catch { return undefined; }
}

function assertEvent(request: DemoManagementRequest): asserts request is DemoManagementRequest & { event: DemoEvent; event_type: string } {
  const event = request.event;
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      canonical(Object.keys(event).sort()) !== canonical(['format', 'run_id', 'project_id', 'sequence', 'request_id', 'previous_digest', 'phase', 'kind', 'source', 'input', 'input_digest'].sort()) ||
      request.target.run_id !== event.run_id || request.target.project_id !== event.project_id ||
      request.event_type !== demoEventType(event.sequence) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      event.sequence > DEMO_MANAGEMENT_LIMITS.event_sends || event.format !== 'strata-integrated-demo-event/1' ||
      typeof event.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.request_id) ||
      !/^[a-f0-9]{64}$/.test(event.previous_digest) || digest(event.input) !== event.input_digest ||
      Buffer.byteLength(canonical(event)) > DEMO_MANAGEMENT_LIMITS.event_bytes)
    fail('DEMO_WRANGLER_EVENT_REFUSED', 4, 'Wrangler event must bind the exact run, project, sequence, and bounded payload.');
}

export function describeWranglerCommand(request: DemoManagementRequest, projectDirectory = process.cwd(), configPath?: string, grant?: DemoActivationGrant): WranglerCommandDescription {
  validateDemoManagementTarget(request.target);
  const { target, action } = request;
  if (!allowedActions.includes(action)) fail('DEMO_WRANGLER_ACTION_UNSUPPORTED', 7, 'Wrangler adapter does not support this operation.');
  if (action === 'preflight-full-step') {
    const command = describeDemoFullStepCommand(target, { name: 'claim-run-1', type: 'step', attempt: 1 }, projectDirectory);
    return { ...command, args: [command.args[0], 'workflows', 'list', '--page', '1', '--per-page', '1'],
      account_id: target.account_id, telemetry_disabled_by_config: false };
  }
  const config = path.resolve(configPath ?? path.join(projectDirectory, 'wrangler.integrated-demo.json'));
  const cliPath = path.resolve(projectDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const prefix = ['--config', config];
  let args: string[];
  switch (action) {
    case 'describe-step': fail('DEMO_FULL_STEP_ADMISSION_REQUIRED', 7, 'Full-step commands are dispatched only through an admitted instance observation.');
    case 'deploy-private': args = [...prefix, 'deploy', '--no-autoconfig', '--strict']; break;
    case 'create-instance': args = [...prefix, 'workflows', 'trigger', target.workflow_name,
      JSON.stringify({ run_id: target.run_id, ...(grant?.infrastructure ? { activation_grant: grant } : {}) }), '--id', target.instance_id, '--json']; break;
    case 'describe-instance': args = [...prefix, 'workflows', 'instances', 'describe', target.workflow_name, target.instance_id, '--json']; break;
    case 'send-event':
      assertEvent(request);
      args = [...prefix, 'workflows', 'instances', 'send-event', target.workflow_name, target.instance_id,
        '--type', request.event_type, '--payload', canonical(request.event), '--json'];
      break;
    case 'delete-instance': args = [...prefix, 'workflows', 'instances', 'delete', target.workflow_name, target.instance_id, '--json']; break;
    case 'preflight-workflow':
    case 'describe-workflow': args = grant?.infrastructure ? [...prefix, 'workflows', 'describe', target.workflow_name, '--json']
      : [...prefix, 'workflows', 'list', '--per-page', '100', '--json']; break;
    case 'preflight-lab-instances': args = [...prefix, 'workflows', 'instances', 'list', target.workflow_name, '--per-page', '100', '--json']; break;
    case 'delete-workflow': args = [...prefix, 'workflows', 'delete', target.workflow_name, '--json']; break;
    case 'preflight-worker':
    case 'describe-worker': args = [...prefix, 'deployments', 'list', '--name', target.worker_name, '--json']; break;
    case 'delete-worker': args = [...prefix, 'delete', target.worker_name]; break;
    case 'describe-repository':
    case 'preflight-namespace':
    case 'list-namespace': args = [...prefix, 'artifacts', 'repos', 'list', '--namespace', target.namespace_id, '--json']; break;
    case 'delete-repository': args = [...prefix, 'artifacts', 'repos', 'delete', target.repository_name, '--namespace', target.namespace_id, '--force', '--json']; break;
  }
  return { executable: process.execPath, args: [cliPath, ...args], cwd: path.resolve(projectDirectory), account_id: target.account_id,
    interactive: INTERACTIVE_ACTIONS.has(action), timeout_ms: COMMAND_TIMEOUT_MS,
    max_output_bytes: DEMO_MANAGEMENT_LIMITS.max_response_bytes_per_call, telemetry_disabled_by_config: true };
}

function defaultRunProcess(invocation: WranglerProcessInvocation): Promise<WranglerProcessResult> {
  if (invocation.interactive) {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd, env: invocation.env, windowsHide: false, shell: false, stdio: 'inherit'
      });
      let timer: NodeJS.Timeout | undefined;
      const timeout = () => { child.kill(); reject(new Error('Wrangler command deadline expired.')); };
      timer = setTimeout(timeout, invocation.timeout_ms); timer.unref();
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: '', stderr: '' }); });
    });
  }
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd, env: invocation.env, windowsHide: invocation.windows_hide, shell: false,
      timeout: invocation.timeout_ms, maxBuffer: invocation.max_output_bytes, encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code !== 'number' || error.killed || error.signal) { reject(error); return; }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) }); return;
      }
      resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseJson(stdout: string, action: DemoManagementAction): any {
  try { return JSON.parse(stdout); }
  catch { fail('DEMO_WRANGLER_JSON_REFUSED', 5, `Wrangler ${action} did not return valid --json output.`); }
}
function parseArray(value: any, action: DemoManagementAction): any[] {
  const result = Array.isArray(value) ? value : Array.isArray(value?.result) ? value.result : null;
  if (!result) fail('DEMO_WRANGLER_JSON_REFUSED', 5, `Wrangler ${action} did not return a JSON array.`);
  return result;
}
function optionalSafeInteger(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined; }

// Retain only recognized diagnostic categories; never journal raw provider output.
export function sanitizedWranglerFailure(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, 256 * 1024).replace(/\x1b\[[0-9;]*m/g, '');
  const statuses = [...text.matchAll(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[\s:=]+)([45]\d{2})\b/gi)].map(match => match[1]);
  const codes = [...text.matchAll(/(?:\[code:\s*|provider code )(\d{1,8})\b/g)].map(match => match[1]);
  const details = [...new Set(statuses)].slice(0, 4).map(status => `HTTP ${status}`);
  details.push(...[...new Set(codes)].slice(0, 4).map(code => `provider code ${code}`));
  if (/environment variable.{0,80}(?:size|limit|large)|(?:size|limit|large).{0,80}environment variable/i.test(text))
    details.push('environment variable size/limit diagnostic');
  return details.length ? ` Sanitized diagnostic: ${details.join('; ')}.` : '';
}

function validateConfigVariables(config: unknown) {
  const vars = config && typeof config === 'object' ? (config as { vars?: unknown }).vars : undefined;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars))
    fail('DEMO_ACTIVATION_BINDINGS_REFUSED', 7, 'Activation variables are missing or malformed.');
  validateDemoActivationBindings(vars as Record<string, unknown>);
}

function confirmsWorkerAbsent(stderr: string, target: DemoManagementRequest['target']) {
  const endpoint = `/accounts/${target.account_id}/workers/scripts/${target.worker_name}/deployments`;
  return stderr.includes(`Cloudflare API (${endpoint})`) &&
    stderr.includes('This Worker does not exist on your account. [code: 10007]');
}

function confirmsInstanceAbsent(stderr: string, target: DemoManagementRequest['target']) {
  const endpoint = `/accounts/${target.account_id}/workflows/${target.workflow_name}/instances/${target.instance_id}`;
  return stderr.includes(`Cloudflare API (${endpoint})`) &&
    (/(?:does not exist|not found)/i.test(stderr) ||
      stderr.includes('workflows.api.error.instance.not_found [code: 10400]'));
}

function managementResponse(request: DemoManagementRequest, stdout: string, grant?: DemoActivationGrant): unknown {
  const { action, target } = request;
  if (action === 'preflight-full-step') {
    const workflows = parseArray(parseJson(stdout, action), action);
    if (workflows.length > 1) fail('DEMO_FULL_STEP_REFUSED', 7, 'Full-step access preflight exceeded its page bound.');
    return { accepted: true, account_id: target.account_id };
  }
  if (action === 'deploy-private') return { accepted: true, worker_name: target.worker_name };
  if (action === 'create-instance') {
    const raw = parseJson(stdout, action);
    if (raw?.id !== target.instance_id) fail('DEMO_WRANGLER_INSTANCE_REFUSED', 5, 'Workflow trigger did not return the exact requested instance ID.');
    return { accepted: true, workflow_name: target.workflow_name, instance_id: target.instance_id };
  }
  if (action === 'send-event') {
    assertEvent(request);
    return { accepted: true, event_type: request.event_type, instance_id: target.instance_id };
  }
  if (action === 'delete-worker') return { accepted: true, worker_name: target.worker_name };
  if (action === 'delete-workflow') return { accepted: true, workflow_name: target.workflow_name };
  if (action === 'delete-instance') {
    const raw = parseJson(stdout, action), errors = Array.isArray(raw?.errors) ? raw.errors : [];
    if (errors.length) fail('DEMO_WRANGLER_DELETE_REFUSED', 5, 'Wrangler reported an instance deletion error.');
    const deleted = Array.isArray(raw?.deleted) ? raw.deleted.map((item: any) => typeof item === 'string' ? item : item?.id) : [];
    if (!deleted.includes(target.instance_id)) fail('DEMO_WRANGLER_DELETE_UNCONFIRMED', 5, 'Wrangler did not confirm deletion of the exact Workflow instance.');
    return { accepted: true, deleted_instance_id: target.instance_id };
  }
  if (action === 'describe-instance') {
    const raw = parseJson(stdout, action), id = raw?.id;
    if (id !== target.instance_id || typeof raw?.status !== 'string') fail('DEMO_WRANGLER_INSTANCE_REFUSED', 5, 'Workflow response does not identify the exact instance and status.');
    if (raw.status === 'errored' && raw.success === false && raw.params?.run_id === target.run_id &&
        raw.step_count === 0 && Array.isArray(raw.steps) && raw.steps.length === 0 && raw.error?.message === 'Worker not found.')
      fail('DEMO_PROVIDER_WORKER_NOT_FOUND', 7,
        'Cloudflare could not load the deployed Worker. The Workflow failed before any application step or coding actor. ' +
        'This is a provider startup failure; its cause is unverified. Preserve the journal for exact resource reconciliation. No automatic retry.');
    const output = raw.output && typeof raw.output === 'object' ? raw.output : {};
    if (['complete', 'errored', 'terminated'].includes(raw.status) && raw.step_count === 0 && Array.isArray(raw.steps) && raw.steps.length === 0 &&
      output.ok === false && typeof output.error?.code === 'string' && /^DEMO_[A-Z0-9_]{1,80}$/.test(output.error.code))
      fail('DEMO_APPLICATION_STARTUP_REFUSED', 7, `The Worker refused this run before its first Workflow step (${output.error.code}). ` +
        'No coding actor started. Preserve the exact instance and journal for owner reconciliation; no automatic retry.');
    const summaryCheckpoint = output.checkpoint && typeof output.checkpoint === 'object' ? output.checkpoint : {};
    let authoritativeCheckpoint: any, authoritativeApply: any;
    const relevant = Array.isArray(raw.steps) ? raw.steps.filter((step: any) => /^(claim-run|apply-)/.test(step?.name)) : [];
    const pendingClaim = relevant.length === 1 && /^claim-run(?:-1)?$/.test(relevant[0].name) && isPendingDemoWorkflowStep(raw, relevant[0]);
    if (relevant.length && !pendingClaim) {
      const parsed = authoritativeDemoWorkflowOutput(raw);
      authoritativeCheckpoint = parsed.checkpoint; authoritativeApply = parsed.apply;
    }
    const counters = summaryCheckpoint.counters && typeof summaryCheckpoint.counters === 'object' ? summaryCheckpoint.counters :
      authoritativeCheckpoint?.counters && typeof authoritativeCheckpoint.counters === 'object' ? authoritativeCheckpoint.counters : {};
    const cleanup = output.management_cleanup && typeof output.management_cleanup === 'object' ? output.management_cleanup :
      authoritativeCheckpoint?.management_cleanup && typeof authoritativeCheckpoint.management_cleanup === 'object' ? authoritativeCheckpoint.management_cleanup : {};
    return { found: true, status: raw.status,
      ...(authoritativeCheckpoint ? { checkpoint: authoritativeCheckpoint, workflow_export: structuredClone(raw) } : {}),
      ...(authoritativeApply ? { outcome: authoritativeApply.output.outcome } : {}),
      ...(Array.isArray(raw.steps) ? { used_steps: raw.steps.length } : {}),
      ...(optionalSafeInteger(counters.artifact_reserved) !== undefined ? { artifact_dispatches: counters.artifact_reserved } : {}),
      ...(optionalSafeInteger(cleanup.unsettled_dispatches) !== undefined ? { unsettled_dispatches: cleanup.unsettled_dispatches } : {}),
      ...(optionalSafeInteger(cleanup.repo_tokens_issued) !== undefined ? { repo_tokens_issued: cleanup.repo_tokens_issued } : {}),
      ...(optionalSafeInteger(cleanup.repo_tokens_revoked) !== undefined ? { repo_tokens_revoked: cleanup.repo_tokens_revoked } : {}),
      ...(optionalSafeInteger(cleanup.handles_open) !== undefined ? { handles_open: cleanup.handles_open } : {}) };
  }
  if ((action === 'describe-workflow' || action === 'preflight-workflow')) {
    if (grant?.infrastructure) {
      const workflow = parseJson(stdout, action);
      return { found: workflow?.name === target.workflow_name, workflow_name: workflow?.name, workflow_id: workflow?.id,
        script_name: workflow?.script_name, class_name: workflow?.class_name, workflow_version_id: workflow?.latest_version?.id };
    }
    const workflows = parseArray(parseJson(stdout, action), action);
    if (workflows.length > 100) fail('DEMO_WRANGLER_LIST_REFUSED', 5, 'Workflow listing exceeded its exact-page bound.');
    const exists = workflows.some((workflow: any) => workflow?.name === target.workflow_name);
    return { ...(exists || workflows.length < 100 ? { found: exists } : {}), workflow_name: target.workflow_name, page_complete: workflows.length < 100 };
  }
  if ((action === 'describe-worker' || action === 'preflight-worker')) {
    const deployments = parseArray(parseJson(stdout, action), action);
    // A successful exact-name deployments request proves that the script
    // endpoint exists. An empty list alone does not prove script deletion.
    const latest = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
    const version = latest?.versions?.length === 1 && latest.versions[0].percentage === 100 ? latest.versions[0].version_id : undefined;
    return { found: true, worker_name: target.worker_name, deployments_count: deployments.length, verification: 'Wrangler deployment listing',
      ...(grant?.infrastructure ? { worker_version_id: version } : {}) };
  }
  if (action === 'preflight-lab-instances') return { workflow_name: target.workflow_name, instances: parseArray(parseJson(stdout, action), action) };
  const repositories = parseArray(parseJson(stdout, action), action);
  const names = repositories.map((repo: any) => repo?.name).filter((name: unknown): name is string => typeof name === 'string');
  if (action === 'describe-repository') return { found: names.includes(target.repository_name), repository_name: target.repository_name, namespace_id: target.namespace_id };
  return { namespace_id: target.namespace_id, repositories: names.map(name => ({ name })) };
}

// Read-only access/absence checks before any expiring grant exists. This port
// cannot dispatch mutations, create a journal/grant, or read credential files.
export async function preflightDemoAccess(target: DemoManagementRequest['target'], root: string, config: string,
  record: (record: unknown) => Promise<void>, run: WranglerProcessRunner = defaultRunProcess) {
  if (pinnedVersion(root) !== PINNED_WRANGLER_VERSION) fail('DEMO_WRANGLER_VERSION_REFUSED', 7, 'Install the pinned lockfile first.');
  for (const action of ['preflight-full-step', 'preflight-namespace', 'preflight-worker', 'preflight-workflow'] as const) {
    const request = { action, target }, command = describeWranglerCommand(request, root, config);
    await record({ action, status: 'started', observed_at: new Date().toISOString() });
    try {
      const result = await run({ ...command, windows_hide: true, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.account_id, CI: 'true' } });
      let response: any;
      if (result.code === 1 && action === 'preflight-worker' && confirmsWorkerAbsent(result.stderr, target)) response = { found: false };
      else {
        if (result.code !== 0) fail('DEMO_ACCESS_REFUSED', 7, `${action} failed.${sanitizedWranglerFailure(result.stderr + '\n' + result.stdout)} No grant was created. Use the launcher's sign-in option, then explicitly rerun the checks.`);
        response = managementResponse(request, result.stdout);
      }
      if (action === 'preflight-full-step' ? response.accepted !== true : action === 'preflight-namespace'
        ? response.namespace_id !== target.namespace_id || response.repositories.length !== 0 : response.found !== false)
        fail('DEMO_ACCESS_REFUSED', 7, `${action}: exact empty namespace or target absence is unverified. No grant was created.`);
      await record({ action, status: 'passed', observed_at: new Date().toISOString(), response });
    } catch (error: any) {
      await record({ action, status: 'failed', code: error.code ?? 'DEMO_ACCESS_REFUSED', observed_at: new Date().toISOString() });
      if (error.code?.startsWith('DEMO_')) throw error;
      fail('DEMO_ACCESS_REFUSED', 7, `${action} did not settle. No grant created; no automatic retry.`);
    }
  }
}

export class WranglerCliDemoManagementProvider implements DemoManagementProvider {
  readonly mode = 'wrangler-cli' as const;
  private readonly projectDirectory: string;
  private readonly runProcess: WranglerProcessRunner;
  private readonly hasInteractiveTerminal: () => boolean;
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly configPath?: string;
  private readonly activationGrant?: DemoActivationGrant;
  private authorizedPlan?: DemoManagementPlan;
  private readonly fullStepOutputs = new DemoFullStepOutputs();

  constructor(options: WranglerManagementOptions = {}) {
    this.projectDirectory = path.resolve(options.project_directory ?? process.cwd());
    const version = pinnedVersion(this.projectDirectory);
    if (version !== PINNED_WRANGLER_VERSION) fail('DEMO_WRANGLER_VERSION_REFUSED', 7, `Expected installed Wrangler ${PINNED_WRANGLER_VERSION}; found ${String(version)}.`);
    this.runProcess = options.run_process ?? defaultRunProcess;
    this.hasInteractiveTerminal = options.interactive_terminal ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
    this.baseEnvironment = options.base_environment ?? process.env;
    this.configPath = options.config_path && path.resolve(options.config_path);
    this.activationGrant = options.activation_grant;
    if (this.configPath && this.activationGrant) {
      let supplied: unknown;
      try { supplied = JSON.parse(readFileSync(this.configPath, 'utf8')); }
      catch { fail('DEMO_WRANGLER_ACTIVATION_CONFIG_REQUIRED', 7, 'The target-specific Wrangler config is missing or invalid.'); }
      validateConfigVariables(supplied);
      if (canonical(supplied) !== canonical(createDemoActivationWorkerConfig(this.activationGrant, this.projectDirectory)))
        fail('DEMO_WRANGLER_ACTIVATION_CONFIG_MISMATCH', 7, 'Wrangler config differs from the exact attended grant and target.');
    }
  }

  supports(action: DemoManagementAction) { return allowedActions.includes(action); }
  preflight(action: DemoManagementAction, plan?: DemoManagementPlan) {
    if (!this.activationGrant || !this.configPath || !plan || plan.mode !== 'reviewed-attended' || plan.live_authorized !== true ||
        plan.grant_id !== this.activationGrant.grant_id || plan.grant_sha256 !== this.activationGrant.grant_sha256 ||
        plan.target_sha256 !== this.activationGrant.target_sha256 || canonical(plan.target) !== canonical(this.activationGrant.target) ||
        plan.source_sha256 !== this.activationGrant.source.sha256)
      fail('DEMO_WRANGLER_ACTIVATION_REQUIRED', 7, 'Wrangler dispatch requires the matching attended grant and target-specific config.');
    validateDemoActivationGrant(this.activationGrant, this.activationGrant.source);
    if (this.activationGrant.infrastructure && ['deploy-private', 'delete-worker', 'delete-workflow'].includes(action))
      fail('DEMO_LAB_RESOURCE_RETAINED', 7, 'The browser grant retains the private Worker and Workflow.');
    if (action === 'deploy-private')
      describeDemoFullStepCommand(plan.target, { name: 'claim-run-1', type: 'step', attempt: 1 }, this.projectDirectory);
    let supplied: unknown;
    try { supplied = JSON.parse(readFileSync(this.configPath, 'utf8')); }
    catch { fail('DEMO_WRANGLER_ACTIVATION_CONFIG_REQUIRED', 7, 'The target-specific Wrangler config is missing or invalid.'); }
    validateConfigVariables(supplied);
    if (canonical(supplied) !== canonical(createDemoActivationWorkerConfig(this.activationGrant, this.projectDirectory)))
      fail('DEMO_WRANGLER_ACTIVATION_CONFIG_MISMATCH', 7, 'Wrangler config differs from the exact attended grant and target.');
    if (INTERACTIVE_ACTIONS.has(action) && !this.hasInteractiveTerminal())
      fail('DEMO_WRANGLER_TTY_REQUIRED', 7, 'Worker deletion requires the host-attended Wrangler confirmation prompt.');
    this.authorizedPlan = structuredClone(plan);
  }

  command(request: DemoManagementRequest) { return describeWranglerCommand(request, this.projectDirectory, this.configPath, this.activationGrant); }

  async call(request: DemoManagementRequest, supplementalRead?: DemoSupplementalRead): Promise<unknown> {
    if (!this.activationGrant || !this.authorizedPlan || canonical(this.authorizedPlan.target) !== canonical(request.target))
      fail('DEMO_WRANGLER_ACTIVATION_REQUIRED', 7, 'No exact attended plan was admitted for this Wrangler request.');
    const currentSource = await readDemoActivationSource(this.projectDirectory);
    validateDemoActivationGrant(this.activationGrant, currentSource);
    this.preflight(request.action, this.authorizedPlan);
    const description = this.command(request);
    const invocation: WranglerProcessInvocation = { ...description,
      env: { ...this.baseEnvironment, CLOUDFLARE_ACCOUNT_ID: request.target.account_id,
        ...(!description.interactive ? { CI: 'true' } : {}) }, windows_hide: !description.interactive,
      timeout_ms: Math.max(1, Math.min(description.timeout_ms, this.activationGrant.expires_at - Date.now())) };
    let result: WranglerProcessResult;
    try { result = await this.runProcess(invocation); }
    catch (error) {
      const diagnostic = request.action === 'deploy-private' && error && typeof error === 'object'
        ? sanitizedWranglerFailure((error as { stderr?: unknown }).stderr) : '';
      fail('DEMO_WRANGLER_COMMAND_UNCERTAIN', 7, `Wrangler ${request.action} did not return a settled response; do not retry automatically.${diagnostic}`,
        providerDiagnostic('wrangler.' + request.action, error));
    }
    if (!result || Buffer.byteLength(result.stdout) > description.max_output_bytes ||
        Buffer.byteLength(result.stderr) > description.max_output_bytes)
      fail('DEMO_WRANGLER_COMMAND_UNCERTAIN', 7, `Wrangler ${request.action} failed or exceeded its output bound; do not retry automatically.`);
    if ((request.action === 'describe-worker' || request.action === 'preflight-worker') && result.code !== 0) {
      if (result.code === 1 && confirmsWorkerAbsent(result.stderr, request.target))
        return { found: false, worker_name: request.target.worker_name, verification: 'exact-target Workers API 10007 not-found response' };
      fail('DEMO_WRANGLER_COMMAND_UNCERTAIN', 7, 'Worker absence was not confirmed by the exact-target not-found response; do not retry automatically.');
    }
    if (request.action === 'describe-instance' && result.code !== 0) {
      if (result.code === 1 && confirmsInstanceAbsent(result.stderr, request.target))
        return { found: false, instance_id: request.target.instance_id, verification: 'exact-target Workflow instance API not-found response' };
      fail('DEMO_WRANGLER_COMMAND_UNCERTAIN', 7, 'Workflow instance absence was not confirmed by the exact-target not-found response; do not retry automatically.');
    }
    if (result.code !== 0)
      fail('DEMO_WRANGLER_COMMAND_UNCERTAIN', 7, `Wrangler ${request.action} returned a nonzero exit status (${Number.isSafeInteger(result.code) ? result.code : 'unknown'}); do not retry automatically.${request.action === 'deploy-private' ? sanitizedWranglerFailure(result.stderr + '\n' + result.stdout) : ''}`,
        providerDiagnostic('wrangler.' + request.action, { code: result.code, stderr: result.stderr }));
    if (request.action === 'delete-repository') {
      const raw = parseJson(result.stdout, request.action);
      if (raw?.deleted !== true || raw.name !== request.target.repository_name || raw.namespace !== request.target.namespace_id)
        fail('DEMO_WRANGLER_DELETE_UNCONFIRMED', 5, 'Wrangler did not confirm deletion of the exact Artifacts repository.');
      return { accepted: true, repository_name: request.target.repository_name };
    }
    if (request.action === 'describe-instance') {
      const raw = parseJson(result.stdout, request.action);
      if (raw?.id !== request.target.instance_id || typeof raw.status !== 'string')
        fail('DEMO_WRANGLER_INSTANCE_REFUSED', 5, 'Workflow response does not identify the exact instance and status.');
      if (Array.isArray(raw.steps) && raw.steps.some((step: any) => /^(claim-run|apply-)/.test(step?.name))) {
        const hydrated = await this.fullStepOutputs.hydrate(raw, request.target, async step => {
          if (!supplementalRead) fail('DEMO_FULL_STEP_ADMISSION_REQUIRED', 7, 'Full-step retrieval requires an admitted management read.');
          const command = describeDemoFullStepCommand(request.target, step, this.projectDirectory);
          return supplementalRead(step, async () => {
            const current = await readDemoActivationSource(this.projectDirectory);
            validateDemoActivationGrant(this.activationGrant!, current);
            const invocation: WranglerProcessInvocation = { ...command,
              env: { ...this.baseEnvironment, CLOUDFLARE_ACCOUNT_ID: request.target.account_id, CI: 'true' }, windows_hide: true,
              timeout_ms: Math.max(1, Math.min(command.timeout_ms, this.activationGrant!.expires_at - Date.now())) };
            let output: WranglerProcessResult;
            try { output = await this.runProcess(invocation); }
            catch { fail('DEMO_FULL_STEP_UNCERTAIN', 7, 'cf full-step read did not settle; preserve evidence without retry.'); }
            if (!output || output.code !== 0 || Buffer.byteLength(output.stderr) > command.max_output_bytes)
              fail('DEMO_FULL_STEP_UNCERTAIN', 7, 'cf full-step read failed; check its supported login and read permissions without copying credentials or retrying.');
            return parseDemoFullStepResponse(output.stdout);
          });
        });
        const response: any = managementResponse(request, JSON.stringify(hydrated));
        if (response.checkpoint && (response.checkpoint.run_id !== request.target.run_id || response.checkpoint.project_id !== request.target.project_id ||
            response.checkpoint.mode !== 'controlled-private' || response.checkpoint.started_at !== this.activationGrant.started_at ||
            response.checkpoint.expires_at !== this.activationGrant.expires_at))
          fail('DEMO_WRANGLER_INSTANCE_REFUSED', 5, 'Full checkpoint does not bind the exact attended run and grant period.');
        return response;
      }
    }
    return managementResponse(request, result.stdout, this.activationGrant);
  }
}
