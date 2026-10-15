import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fail, canonical, digest } from './model.js';
import { findCodexEntrypoint, CodexSubscriptionActorRunner, type DemoActorCliOptions } from './integrated-demo-actor-cli.js';
import { DemoHost, type DemoDispatch } from './integrated-demo-host.js';
import { cleanupReviewedDemoSession, startReviewedDemoSession } from './integrated-demo-live.js';
import { DEMO_LIMITS, checkpointDigest } from './integrated-demo.js';
import { readDemoActivationSource, validateDemoActivationGrant, type DemoActivationGrant } from './integrated-demo-activation.js';
import { type DemoManagementProvider, type DemoManagementAdmissionPort } from './integrated-demo-management.js';
import { operatorPromptPacketFromCheckpoint, type OperatorDecisionAction, type OperatorPromptPacket } from './integrated-demo-operator-reply.js';
import { measureDemoApp } from './integrated-demo-runner.js';
import { sanitizedWranglerFailure } from './integrated-demo-management-wrangler.js';
import { isProviderDiagnostic } from './provider-diagnostic.js';

const exec = promisify(execFile);

// Codex 0.160.1 can emit these Windows arg0 warnings before login status.
// Only the observed stderr diagnostics are tolerated; auth stays explicit.
function subscriptionCliStatusAccepted(result: { code: number; stdout: string; stderr: string }): boolean {
  if (result.code !== 0) return false;
  const status = 'Logged in using ChatGPT';
  const cleanupWarning = 'WARNING: failed to clean up stale arg0 temp dirs: Access is denied. (os error 5)';
  const pathWarning = /^WARNING: proceeding, even though we could not create PATH aliases: Access is denied\. \(os error 5\) at path "[A-Za-z]:\\+[^"\r\n]*\\+tmp\\+arg0\\+codex-arg0[A-Za-z0-9]+"$/;
  const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let statuses = 0;
  for (const line of lines(result.stdout)) {
    if (line !== status) return false;
    statuses++;
  }
  const warnings = new Set<string>();
  for (const line of lines(result.stderr)) {
    if (line === status) { statuses++; continue; }
    const kind = line === cleanupWarning ? 'cleanup' : pathWarning.test(line) ? 'path' : null;
    if (!kind || warnings.has(kind)) return false;
    warnings.add(kind);
  }
  // Diagnostics cannot authenticate; duplicate/conflicting status is refused.
  return statuses === 1;
}

export type OperatorTerminal = { stdin_is_tty: boolean; stdout_is_tty: boolean; write(text: string): void; ask(prompt: string): Promise<string> };
export type CliProbe = (entrypoint: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;
export async function probeSubscriptionCli(root: string, environment = process.env, probe: CliProbe = async (entrypoint, args, env) => {
  try { const result = await exec(process.execPath, [entrypoint, ...args], { cwd: root, env, windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr }; }
  catch { return { code: 1, stdout: '', stderr: '' }; }
}) {
  const entrypoint = await findCodexEntrypoint(environment);
  // This only inherits the user's existing auth location; it never reads/copies credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'CODEX_HOME', 'TEMP', 'TMP', 'COMSPEC'])
    if (environment[key] !== undefined) env[key] = environment[key];
  const version = await probe(entrypoint, ['--version'], env);
  const help = await probe(entrypoint, ['exec', '--help'], env);
  const auth = await probe(entrypoint, ['login', 'status'], env);
  if (version.code !== 0 || !/^codex-cli 0\.160\.1\s*$/.test(version.stdout.trim()) || help.code !== 0 ||
      ['--model', '--sandbox', '--ephemeral', '--json', '--ignore-user-config', '--skip-git-repo-check'].some(flag => !help.stdout.includes(flag)))
    fail('DEMO_OPERATOR_CLI_UNSUPPORTED', 7, 'Expected installed Codex CLI 0.160.1 and its reviewed exec flags; no generation was attempted.');
  if (!subscriptionCliStatusAccepted(auth))
    fail('DEMO_OPERATOR_AUTH_REQUIRED', 7, 'Run from your ordinary PowerShell with Codex logged in using ChatGPT. No API-key/provider fallback is allowed.');
  await access(path.join(root, 'dist', 'src', 'integrated-demo-actor-mcp.js'));
  return { entrypoint, version: '0.160.1', billing_mode: 'chatgpt-subscription', model_availability_verified: false };
}

export type OperatorOptions = { root: string; grant: DemoActivationGrant; config_path: string; journal_path: string;
  terminal: OperatorTerminal; signal: AbortSignal; now?: () => number; provider?: DemoManagementProvider;
  on_admit?: () => Promise<void>; probe?: typeof probeSubscriptionCli; actor_options?: Partial<DemoActorCliOptions>;
  // In-memory handoff from the guided terminal's actual START DEMO input.
  // Not a CLI flag and never inferred merely from loading a grant file.
  confirmed_grant_sha256?: string;
  browser_approval?: { action: 'begin-demo'; grant_sha256: string };
  decide?: (packet: OperatorPromptPacket, signal: AbortSignal) => Promise<{ action: OperatorDecisionAction; reason: string; capture_method: 'local-browser' }>;
  emit?: (record: unknown, workflowExport?: unknown) => Promise<void>; sleep?: (ms: number) => Promise<void> };

// A finite operator adapter over the existing reviewed session and actor launcher.
// Test callers replace only terminal, clock, and subprocess/provider boundaries.
export async function runAttendedDemo(options: OperatorOptions): Promise<{ released: unknown; readback?: unknown; cleanup: unknown; live_authorized: boolean; model_availability_verified: boolean }> {
  const now = options.now ?? Date.now, terminal = options.terminal;
  const browser = options.grant.format === 'strata.integrated-demo-activation-grant/3';
  if (browser ? options.browser_approval?.action !== 'begin-demo' || options.browser_approval.grant_sha256 !== options.grant.grant_sha256 || !options.decide
    : !terminal.stdin_is_tty || !terminal.stdout_is_tty) fail('DEMO_OPERATOR_TTY_REQUIRED', 7, 'Exact browser approval or an attended terminal is required.');
  validateDemoActivationGrant(options.grant, await readDemoActivationSource(options.root), now());
  const cli = await (options.probe ?? probeSubscriptionCli)(options.root);
  const grant = options.grant;
  if (grant.format === 'strata.integrated-demo-activation-grant/1') terminal.write(canonical({ grant_sha256: grant.grant_sha256, target: grant.target, source_sha256: grant.source.sha256,
    limits: grant.limits, expires_at: new Date(grant.expires_at).toISOString(), cli,
    cost: 'US$1 is a review/stop target, not an invoice cap. Provider dollars and hard token caps are unverified.' }) + '\n');
  const workDeadline = grant.expires_at - DEMO_LIMITS.cleanup_ms - 30_000;
  const assertWorking = () => {
    if (options.signal.aborted || now() >= workDeadline) fail('DEMO_OPERATOR_STOPPED', 7, 'Interrupted or at the reserved cleanup boundary.');
  };
  const ask = async (prompt: string) => {
    assertWorking();
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new Error('Operator interrupted.')); options.signal.addEventListener('abort', abort, { once: true }); });
    try { const result = await Promise.race([terminal.ask(prompt), interrupted]); assertWorking(); return result; }
    finally { options.signal.removeEventListener('abort', abort); }
  };
  let typed: string | undefined;
  if (grant.format === 'strata.integrated-demo-activation-grant/1') {
    if (options.confirmed_grant_sha256 !== undefined) fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'Legacy grant requires its digest entry.');
    typed = await ask('Type the exact grant digest to provision the private resources and start this one run: ');
    if (typed !== grant.grant_sha256) fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'Exact grant digest required.');
  } else if (!browser && options.confirmed_grant_sha256 !== grant.grant_sha256) {
    if (options.confirmed_grant_sha256 !== undefined) fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'Confirmation belongs to a different grant.');
    terminal.write('Starting this exact confirmed grant: ' + canonical(grant.target) + '\n30 minutes including cleanup; three Luna 6 actors, ChatGPT subscription only. US$1 is a stop target; costs unverified.\n');
    if (await ask('Type START DEMO to start this exact grant and authorize cleanup: ') !== 'START DEMO')
      fail('DEMO_ACTIVATION_ATTENDANCE_REQUIRED', 7, 'START DEMO confirmation required.');
  }
  const operator = grant.approval.operator_label;
  let port: DemoManagementAdmissionPort | undefined, host: DemoHost | undefined, runner: CodexSubscriptionActorRunner | undefined;
  let failure: unknown, released: unknown, cleanup: unknown, readback: unknown;
  const emit = options.emit ?? (async record => terminal.write(canonical(record) + '\n'));
  try {
    assertWorking(); await options.on_admit?.();
    await emit({ type: 'provisioning-started', message: browser ? 'Checking the retained private lab and starting the approved instance. No coding actor has launched yet.' : 'Provisioning the exact private targets. No coding actor has launched yet.' });
    const session = await startReviewedDemoSession({ project_directory: options.root, grant,
      config_path: options.config_path, journal_path: options.journal_path, provider: options.provider,
      provision: true, on_port: value => { port = value; }, now, sleep: options.sleep,
      attendance: { stdin_is_tty: terminal.stdin_is_tty, stdout_is_tty: terminal.stdout_is_tty, operator_label: operator,
        ...(grant.format === 'strata.integrated-demo-activation-grant/1' ? { typed_digest: typed }
          : browser ? { browser_action: 'begin-demo' as const, confirmed_grant_sha256: grant.grant_sha256 }
          : { confirmation_text: 'START DEMO', confirmed_grant_sha256: grant.grant_sha256 }) } });
    const dispatch: DemoDispatch = async event => {
      if (event.kind !== 'stop') assertWorking();
      const result = await session.dispatch(event);
      await emit({ type: 'workflow-event', sequence: event.sequence, kind: event.kind, source: event.source,
        phase: result.checkpoint.phase, checkpoint_digest: checkpointDigest(result.checkpoint), outcome: result.outcome,
        ...(['selection', 'endorse'].includes(event.kind) ? { decision_packet_digest: event.input.packet_digest } : {}),
        ...(event.kind === 'actor' ? { command: event.input.command,
          ...((result.outcome as any).ok && ['layer.create', 'layer.revise'].includes(event.input.command) ? { proposal: event.input.input.record } : {}) } : {}) }, result.workflow_export);
      return result;
    };
    host = new DemoHost(session.initial_checkpoint, dispatch, now, 'model-turn');
    for (const actor of ['a', 'c', 'b'] as const) host.bindThread('actor-' + actor, actor);
    runner = new CodexSubscriptionActorRunner(host, { ...options.actor_options, project_directory: options.root,
      codex_entrypoint: cli.entrypoint, now, run_expires_at: grant.expires_at, actor_process_limit: grant.limits.actor_processes });
    const onAbort = () => { void runner!.cancelAndStopWorkflow().catch(() => undefined); }; options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const ok = (result: any) => { if (result.outcome?.ok !== true) fail('DEMO_OPERATOR_EVENT_FAILED', 7, 'Workflow refused: ' + result.outcome?.error?.code,
        isProviderDiagnostic(result.outcome?.error?.diagnostic) ? result.outcome.error.diagnostic : null); return result.outcome.data; };
      ok(await host.event('bootstrap', 'host', {}));
      const actor = async (role: 'a' | 'b' | 'c', repaired = false) => {
        await emit({ type: 'actor-launching', actor: role, assigned_revision: repaired ? 2 : 1, model: 'gpt-6-luna', reasoning_effort: role === 'b' ? 'high' : 'medium' });
        const evidence = await runner!.run(role, 'actor-' + role, repaired);
        await emit({ type: 'actor-finished', actor: role, model: evidence.model, reasoning_effort: evidence.reasoning_effort,
          prompt_sha256: evidence.prompt_sha256, turn_starts: evidence.turn_starts, tool_calls: evidence.tool_calls.length,
          execution: evidence.label, assigned_revision: evidence.assigned_revision });
      };
      await Promise.all([actor('a'), actor('c')]); assertWorking();
      await actor('b'); assertWorking();
      const decision = async (result: any) => {
        const packet = operatorPromptPacketFromCheckpoint(host!.checkpoint, result.outcome);
        await emit({ type: 'operator-pause', packet });
        if (!options.decide) terminal.write(JSON.stringify(packet, null, 2) + '\n');
        else terminal.write('Your ' + packet.phase + ' decision is ready in the local browser. Review the packet, enter a reason, and choose an option.\n');
        if (packet.phase === 'selection') terminal.write(grant.limits.actor_processes === 4
          ? 'This grant permits one reminder repair invocation, followed by a fresh selection and separate Release decision.\n'
          : '1200 requires a new reminder authoring turn; this three-process launch stops at that repair gate.\n');
        const browser = options.decide ? await options.decide(packet, options.signal) : undefined;
        assertWorking();
        const action = browser?.action ?? await ask(packet.phase === 'selection' ? 'Conflict decision (900, 1200, defer): ' : 'Separate Release gate (approve-release, defer): ');
        if (!packet.allowed_actions.includes(action as OperatorDecisionAction)) fail('DEMO_OPERATOR_REPLY_REFUSED', 4, 'Invalid decision; no automatic choice.');
        const text = browser?.reason ?? await ask('Reason for this exact decision: ');
        const reply = await host!.operatorReply({ format: 'strata.integrated-demo-operator-reply/1', run_id: packet.run_id,
          packet_digest: packet.packet_digest, action: action as OperatorDecisionAction, response_text: text, operator_label: operator,
          recorded_at: new Date(now()).toISOString(), capture_method: browser?.capture_method ?? 'local-interactive-terminal' });
        return ok(reply);
      };
      const prepared = await host.event('prepare', 'host', {}); ok(prepared);
      let selected = await decision(prepared);
      if (selected.repair_required) {
        if (grant.limits.actor_processes !== 4) fail('DEMO_OPERATOR_REPAIR_REQUIRED', 7, '1200 requires a fourth actor process; stopped without exceeding the grant.');
        await actor('b', true); assertWorking();
        const repaired = await host.event('prepare', 'host', {}); ok(repaired);
        selected = await decision(repaired);
      }
      if (!selected.aborted) {
        const realized = ok(await host.event('realize', 'host', {}));
        if (![900, 1200].includes(realized.selected_seconds)) fail('DEMO_OPERATOR_CHOICE_REFUSED', 7, 'Unknown duration in realization checkpoint.');
        const measured = await measureDemoApp(realized.realization, realized.selected_seconds); assertWorking();
        const evidence = await host.event('evidence', 'runner', { evidence: measured.evidence, observations_digest: measured.observations_digest }); ok(evidence);
        await emit({ type: 'measurement-verified', evidence: measured.evidence, observations: measured.observations, observations_digest: measured.observations_digest });
        const finish = await decision(evidence);
        if (!finish.aborted) {
          const verified = finish.readback;
          if (!verified || verified.format !== 'strata-demo-release-readback/1' || verified.fresh_reader !== true ||
              verified.registry_sha256 !== digest(host.checkpoint.registry) || verified.released_ref !== finish.released.ref ||
              verified.candidate_ref !== host.checkpoint.refs.candidate || verified.realization_ref !== host.checkpoint.refs.realization ||
              verified.validation_ref !== host.checkpoint.refs.validation || verified.evidence_digest !== digest(measured.evidence) ||
              verified.inherited_realization_sha256 !== digest(finish.inherited_realization))
            fail('DEMO_OPERATOR_READBACK_FAILED', 6, 'Final storage read-back does not bind the measured app and exact checkpoint.');
          const inherited = await measureDemoApp(finish.inherited_realization, realized.selected_seconds); assertWorking();
          if (canonical(inherited.observations) !== canonical(measured.observations)) fail('DEMO_OPERATOR_INHERITANCE_FAILED', 6, 'Inherited behavior differs.');
          released = finish.released; readback = verified;
          await emit({ type: 'release-verified', released, readback, inherited: finish.inherited, evidence: measured.evidence, inherited_observations_equal: true });
        }
      }
    } finally { options.signal.removeEventListener('abort', onAbort); }
  } catch (error) { failure = error; }
  finally {
    await emit({ type: 'cleanup-started', message: browser ? 'Verifying token accounting and removing this run’s instance and repository. The private Worker and Workflow are retained.' : 'Wait for terminal accounting and resource absence. Wrangler may ask you to confirm Worker deletion in the terminal.' }).catch(() => undefined);
    // Abort local processes before any remote deletion. Never delete through uncertainty.
    try {
      // A peer can still be saving partial evidence after Promise.all rejects.
      // Settle all local children before any terminal check or remote deletion.
      await runner?.settleActiveProcesses();
      if (runner && host && !['complete', 'aborted', 'failed'].includes(host.checkpoint.phase)) await runner.cancelAndStopWorkflow();
      if (port) {
        const state = await port.snapshot();
        if (!state.instance_created) fail('DEMO_OPERATOR_RECONCILE_REQUIRED', 7, 'Provision/start incomplete. Preserve the journal and reconcile the exact target manually; do not retry.');
        if (!runner) await emit({ type: 'startup-reconciliation-required', original_failure_code: (failure as any)?.code ?? 'DEMO_STARTUP_FAILED',
          target: grant.target, journal_path: options.journal_path,
          instruction: 'No actor runner exists to send a checkpoint-bound stop. Owner must reconcile this exact instance and explicitly terminate it if running; unknown state authorizes no replay or deletion.' });
        const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
        const terminalKnown = (await port.snapshot()).cleanup.terminal_instance_verified;
        const reads = Math.min(33, port.plan.limits.calls - state.counters.calls - port.plan.limits.cleanup_reserve_calls,
          port.plan.limits.status_reads - state.counters.status_reads - port.plan.limits.cleanup_reserve_status_reads);
        const terminalDeadline = Math.min(now() + 320_000, grant.expires_at - 60_000);
        if (!terminalKnown && reads <= 0) fail('DEMO_OPERATOR_CLEANUP_PENDING', 7, 'No monitoring allowance remains outside the protected cleanup reserve.');
        for (let read = 0; !terminalKnown && read < reads; read++) {
          if (now() >= terminalDeadline) fail('DEMO_OPERATOR_CLEANUP_PENDING', 7, 'Terminal accounting was not verified before the bounded cleanup deadline. Preserve the journal; no deletion attempted.');
          const result = await port.describeInstance() as any;
          if (['complete', 'errored', 'terminated'].includes(result?.status)) break;
          if (read === reads - 1) fail('DEMO_OPERATOR_CLEANUP_PENDING', 7, 'Workflow is not terminal within the reserved read allowance; no deletion attempted.');
          await emit({ type: 'cleanup-waiting', message: 'Waiting for Workflow terminal accounting; no deletion yet.', observed_status: result?.status ?? 'unknown' });
          await sleep(Math.min(10_000, Math.max(1, terminalDeadline - now())));
        }
        cleanup = await cleanupReviewedDemoSession(port, options.sleep);
        await emit({ type: 'cleanup-verified', cleanup });
      }
    } catch (error) {
      const diagnostic = failure && typeof failure === 'object' && (failure as { code?: unknown }).code === 'DEMO_WRANGLER_COMMAND_UNCERTAIN'
        ? sanitizedWranglerFailure((failure as { message?: unknown }).message) : '';
      await emit({ type: 'cleanup-blocked', code: (error as any).code ?? 'DEMO_OPERATOR_CLEANUP_FAILED',
        ...(isProviderDiagnostic((error as any)?.details) ? { diagnostic: (error as any).details } : {}),
        ...(failure ? { original_failure_code: (failure as any).code ?? 'DEMO_OPERATOR_FAILED' } : {}),
        ...(diagnostic ? { underlying_deploy_diagnostic: diagnostic.trim() } : {}),
        journal_path: options.journal_path, target: grant.target, instruction: 'Reconcile exact target manually; no automatic retry or new grant.' });
      if (failure && typeof failure === 'object') Object.assign(failure, { cleanup_error: error });
      else failure = error;
    }
    try { await emit({ type: 'execution-observed', ok: !failure, intervals: structuredClone(host?.intervals ?? []),
      operations: structuredClone(host?.operations ?? []), usage: host?.usage() ?? null,
      checkpoint_digest: host ? checkpointDigest(host.checkpoint) : null, readback: readback ?? null,
      boundary: 'Host actor/tool spans include setup, waiting and cleanup; subprocess timing is in actor evidence. Neither proves simultaneous inference or measured token cost.' }); }
    catch { if (!failure) failure = new Error('Observed execution evidence could not be saved.'); }
  }
  if (failure) throw failure;
  return { released: released ?? null, readback: readback ?? null, cleanup, live_authorized: true, model_availability_verified: false };
}
