import { canonical, fail } from './model.js';
import { checkpointDigest, DEMO_LIMITS, type DemoCheckpoint } from './integrated-demo.js';
import { createReviewedDemoDispatch, DemoManagementAdmissionPort, FileDemoManagementJournal, reviewedDemoManagementPlan,
  type DemoManagementProvider, type LiveDemoInstanceDescription } from './integrated-demo-management.js';
import { WranglerCliDemoManagementProvider } from './integrated-demo-management-wrangler.js';
import { readDemoActivationSource, validateDemoActivationGrant, type DemoActivationAttendance, type DemoActivationGrant } from './integrated-demo-activation.js';

export type ReviewedDemoSessionOptions = { project_directory: string; journal_path: string; config_path: string;
  grant: DemoActivationGrant; attendance: DemoActivationAttendance; provider?: DemoManagementProvider;
  provision?: boolean; on_port?: (port: DemoManagementAdmissionPort) => void; now?: () => number; sleep?: (ms: number) => Promise<void> };

export async function startReviewedDemoSession(options: ReviewedDemoSessionOptions) {
  const now = options.now ?? Date.now, source = await readDemoActivationSource(options.project_directory);
  validateDemoActivationGrant(options.grant, source, now());
  const browser = options.grant.format === 'strata.integrated-demo-activation-grant/3';
  if (!options.attendance || (!browser && (options.attendance.stdin_is_tty !== true || options.attendance.stdout_is_tty !== true)) ||
      (options.grant.format === 'strata.integrated-demo-activation-grant/1'
        ? options.attendance.typed_digest !== options.grant.grant_sha256 || options.attendance.confirmation_text !== undefined
        : (browser ? options.attendance.browser_action !== 'begin-demo' || options.attendance.confirmation_text !== undefined
          : options.attendance.confirmation_text !== 'START DEMO') || options.attendance.confirmed_grant_sha256 !== options.grant.grant_sha256 ||
          options.attendance.typed_digest !== undefined || options.attendance.operator_label !== options.grant.approval.operator_label) || typeof options.attendance.operator_label !== 'string' ||
      !options.attendance.operator_label.trim() || options.attendance.operator_label.length > 128)
    fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'Live Workflow creation requires an attended terminal confirmation bound to this exact grant.');
  const plan = reviewedDemoManagementPlan(options.grant, source, now());
  const provider = options.provider ?? new WranglerCliDemoManagementProvider({ project_directory: options.project_directory,
    config_path: options.config_path, activation_grant: options.grant });
  const port = new DemoManagementAdmissionPort(plan, new FileDemoManagementJournal(options.journal_path), provider, now);
  options.on_port?.(port);
  if (options.provision) for (const action of ['preflight-full-step', 'preflight-namespace', 'preflight-worker', 'preflight-workflow',
    ...(browser ? ['preflight-lab-instances' as const] : ['deploy-private' as const])] as const) await port.provision(action);
  await port.createInstance();
  const description = await waitForReviewedDemoStartup(port, now, options.sleep);
  if (canonical(description.checkpoint.mode) !== canonical('controlled-private'))
    fail('DEMO_MANAGEMENT_INSTANCE_MODE_REFUSED', 7, 'Workflow did not start in controlled-private mode.');
  return { plan, port, initial_checkpoint: description.checkpoint,
    ...(description.workflow_export === undefined ? {} : { initial_workflow_export: structuredClone(description.workflow_export) }),
    dispatch: createReviewedDemoDispatch(port),
    actors: { a: { model: 'gpt-6-luna', reasoning_effort: 'medium' }, c: { model: 'gpt-6-luna', reasoning_effort: 'medium' },
      b: { model: 'gpt-6-luna', reasoning_effort: 'high' } },
    max_concurrent_actor_turns: 2, run_expires_at: plan.expires_at, cleanup_starts_at: plan.expires_at - DEMO_LIMITS.cleanup_ms };
}

export async function cleanupReviewedDemoSession(port: DemoManagementAdmissionPort,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  // Eventual visibility may lag an accepted delete. Repeat only observations;
  // preserve enough calls for the remaining ordered cleanup, never retry deletes.
  const absent = async (action: 'describe-instance' | 'describe-workflow' | 'describe-worker' | 'describe-repository',
    key: 'instance_absent' | 'workflow_absent' | 'worker_absent' | 'repository_absent', remaining: number) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await port.cleanup(action);
      const state = await port.snapshot();
      if (state.cleanup[key]) return;
      if (state.counters.calls + remaining + 1 > port.plan.limits.calls ||
        state.counters.status_reads + remaining + 1 > port.plan.limits.status_reads || Date.now() + 11000 >= port.plan.expires_at) break;
      if (attempt < 3) await sleep(10000);
    }
    fail('DEMO_OPERATOR_CLEANUP_PENDING', 7, `Accepted deletion is not yet absent after bounded ${action} observations. Preserve the journal; do not repeat deletion.`);
  };
  await port.beginCleanup();
  await port.cleanup('describe-instance');
  await port.cleanup('delete-instance');
  await absent('describe-instance', 'instance_absent', 7);
  if (port.plan.infrastructure) {
    await port.cleanup('describe-workflow');
    await port.cleanup('describe-worker');
  } else {
    await port.cleanup('delete-workflow');
    await absent('describe-workflow', 'workflow_absent', 5);
    await port.cleanup('delete-worker');
    await absent('describe-worker', 'worker_absent', 3);
  }
  await port.cleanup('delete-repository');
  await absent('describe-repository', 'repository_absent', 1);
  await port.cleanup('list-namespace');
  return port.snapshot();
}

// Read-only readiness observation. Never re-creates or replays an instance.
export async function waitForReviewedDemoStartup(port: DemoManagementAdmissionPort, now = Date.now,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<LiveDemoInstanceDescription> {
  const plan = port.plan;

  let description: LiveDemoInstanceDescription | undefined;
  const deadline = Math.min(now() + 30_000, plan.expires_at - DEMO_LIMITS.cleanup_ms - 30_000);
  const state = await port.snapshot();
  const reads = Math.max(0, Math.min(7, plan.limits.calls - state.counters.calls - plan.limits.cleanup_reserve_calls,
    plan.limits.status_reads - state.counters.status_reads - plan.limits.cleanup_reserve_status_reads));
  for (let read = 0; read < reads && now() < deadline; read++) {
    if (read) await sleep(Math.min(5000, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const result = await port.describeInstance() as any;
    if (now() >= deadline) break;
    if (result?.found !== true || !['running', 'waiting'].includes(result.status) ||
        !result.checkpoint || result.checkpoint.format !== 'strata-integrated-demo-checkpoint/1') continue;
    const checkpoint = result.checkpoint as DemoCheckpoint;
    if (checkpoint.run_id !== plan.target.run_id || checkpoint.project_id !== plan.target.project_id ||
        checkpoint.mode !== 'controlled-private' || checkpoint.started_at !== plan.started_at || checkpoint.expires_at !== plan.expires_at ||
        !/^[a-f0-9]{64}$/.test(checkpointDigest(checkpoint)))
      fail('DEMO_MANAGEMENT_INSTANCE_STATE_REFUSED', 7, 'Created Workflow has no exact grant-bound private checkpoint.');
    description = { found: true, status: result.status, checkpoint: structuredClone(checkpoint),
      ...(Object.hasOwn(result, 'outcome') ? { outcome: result.outcome } : {}),
      ...(Object.hasOwn(result, 'workflow_export') ? { workflow_export: structuredClone(result.workflow_export) } : {}) };
    break;
  }
  if (!description) fail('DEMO_MANAGEMENT_INSTANCE_NOT_READY', 7, 'Exact Workflow instance did not expose its initial checkpoint within the 30-second deadline and seven-read budget; preserve the journal and reconcile the exact target, without replay.');
  return description;
}
