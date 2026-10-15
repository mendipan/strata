import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { bytesDigest, canonical, fail } from './model.js';
import { DEMO_ACTORS, DEMO_LIMITS, type DemoActor } from './integrated-demo.js';
import { demoActorInstructions, DemoHost } from './integrated-demo-host.js';

const execFileAsync = promisify(execFile);
const TOOL_NAME = 'strata_operation';
const MAX_TOOL_BYTES = DEMO_LIMITS.event_bytes;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ACTOR_PROCESS_MS = 10 * 60 * 1000;
const MCP_ENV = ['STRATA_DEMO_ACTOR_ENDPOINT', 'STRATA_DEMO_ACTOR_CAPABILITY'] as const;
const actorEnvironmentKeys = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME',
  'CODEX_HOME', 'TEMP', 'TMP', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'ProgramFiles', 'ProgramFiles(x86)'];

export type DemoActorProcessInvocation = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string;
  timeout_ms: number; max_output_bytes: number; windows_hide: true; shell: false };
export type DemoActorProcessResult = { code: number | null; stdout: string; stderr: string; turn_starts: number;
  process?: { started_at: number; ended_at: number; duration_ms: number; signal: string | null;
    termination: 'exit' | 'cancelled' | 'timeout' | 'output-limit' | 'malformed-jsonl' | 'turn-limit' | 'missing-turn-count' | 'spawn-failed';
    output_truncated: boolean; child_close_observed: boolean; child_spawned: boolean } };
export class DemoActorProcessError extends Error {
  readonly code = 'DEMO_ACTOR_PROCESS_FAILED';
  constructor(readonly result: DemoActorProcessResult) { super('Actor subprocess did not complete; bounded partial evidence is retained.'); }
}
export type DemoActorProcessRunner = (invocation: DemoActorProcessInvocation, signal: AbortSignal, maxTurns: number) => Promise<DemoActorProcessResult>;
export type DemoActorCliOptions = { project_directory: string; codex_entrypoint?: string; node_executable?: string;
  tool_server_entrypoint?: string; base_environment?: NodeJS.ProcessEnv; run_process?: DemoActorProcessRunner;
  now?: () => number; run_expires_at: number; actor_process_timeout_ms?: number; process_label?: 'real-codex-subscription-cli' | 'mock-codex-process';
  actor_process_limit?: 3 | 4;
  save_evidence?: (evidence: DemoActorTurnEvidence) => Promise<void> };
export type DemoActorToolCall = { actor: DemoActor; command: string; input: unknown; result: unknown; at: number };
export type DemoActorTurnEvidence = { actor: DemoActor; assigned_revision: 1 | 2; thread: string; model: string; reasoning_effort: string; prompt: string;
  prompt_sha256: string; codex_event_stream: string; codex_stderr: string; turn_starts: number; tool_calls: DemoActorToolCall[]; exit_code: number | null;
  command: { executable: string; args: string[]; cwd: string; shell: false; timeout_ms: number; max_output_bytes: number; environment_keys: string[]; environment_values_retained: false } | null;
  invocation: { started_at: number; ended_at: number; duration_ms: number; boundary: 'host subprocess invocation; not inference timing' };
  process: DemoActorProcessResult['process'] | null; process_error_code: string | null; partial: boolean;
  label: 'real-codex-subscription-cli' | 'mock-codex-process' };

export function actorCliModel(actor: DemoActor) {
  const spec = DEMO_ACTORS[actor];
  return { provider: 'codex-subscription-cli', model: 'gpt-6-luna', reasoning_effort: spec.reasoning.toLowerCase(),
    sandbox: 'read-only', max_host_turns: DEMO_LIMITS.turns_per_actor, max_tool_calls: DEMO_LIMITS.tools_per_actor,
    tool: TOOL_NAME, fallback: false } as const;
}

export function codexActorCommand(cwd: string, options: { actor: DemoActor; codexEntrypoint: string; nodeExecutable: string;
  toolServerEntrypoint: string; mcpCwd: string }) {
  const profile = actorCliModel(options.actor), config = (key: string, value: string) => ['-c', `${key}=${value}`];
  const args = ['exec', '--model', profile.model, '--sandbox', 'read-only', '--ephemeral', '--json', '-C', cwd, '--skip-git-repo-check',
    '--ignore-user-config', ...config('model_reasoning_effort', JSON.stringify(profile.reasoning_effort)),
    ...config('forced_login_method', JSON.stringify('chatgpt')), ...config('model_provider', JSON.stringify('openai')),
    ...config('approval_policy', JSON.stringify('never')), ...config('features.shell_tool', 'false'),
    ...config('mcp_servers.strata_demo.enabled', 'true'), ...config('mcp_servers.strata_demo.required', 'true'),
    ...config('mcp_servers.strata_demo.command', JSON.stringify(options.nodeExecutable)),
    ...config('mcp_servers.strata_demo.args', JSON.stringify([options.toolServerEntrypoint])),
    ...config('mcp_servers.strata_demo.cwd', JSON.stringify(options.mcpCwd)),
    ...config('mcp_servers.strata_demo.env_vars', JSON.stringify([...MCP_ENV])),
    ...config('mcp_servers.strata_demo.enabled_tools', JSON.stringify([TOOL_NAME])),
    ...config('mcp_servers.strata_demo.default_tools_approval_mode', JSON.stringify('auto')),
    // Only this grant-scoped bridge is preapproved; all other approval policy stays closed.
    ...config('mcp_servers.strata_demo.tools.strata_operation.approval_mode', JSON.stringify('approve')),
    ...config('mcp_servers.strata_demo.startup_timeout_sec', '15'), ...config('mcp_servers.strata_demo.tool_timeout_sec', '60'),
    ...config('mcp_optional_startup_grace_ms', '0'), '-'];
  return { executable: options.nodeExecutable, args: [options.codexEntrypoint, ...args], profile, shell: false as const,
    mcp_server: 'strata_demo', exposed_tools: [TOOL_NAME] as const, env_forwarded_to_server: [...MCP_ENV] as const };
}

export class DemoActorToolBridge {
  readonly capability = Buffer.from(randomBytes(32)).toString('base64url');
  readonly server: Server;
  readonly calls: DemoActorToolCall[] = [];
  private started = false;
  constructor(private readonly host: DemoHost, private readonly actor: DemoActor, private readonly thread: string, private readonly clock = Date.now) {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.server.requestTimeout = 15_000; this.server.headersTimeout = 5_000; this.server.keepAliveTimeout = 1_000;
  }
  async listen() {
    if (this.started) fail('DEMO_ACTOR_BRIDGE_STATE', 7, 'Actor tool bridge is already listening.');
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') fail('DEMO_ACTOR_BRIDGE_STATE', 7, 'Loopback actor tool bridge has no TCP address.');
    return { endpoint: `http://127.0.0.1:${address.port}/strata_operation`, capability: this.capability };
  }
  async close() {
    if (!this.started || !this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve())); this.started = false;
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('cache-control', 'no-store'); response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method !== 'POST' || request.url !== '/strata_operation') { response.writeHead(404).end('{}'); return; }
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const expected = Buffer.from(this.capability), provided = Buffer.from(bearer);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) { response.writeHead(401).end('{"error":"unauthorized"}'); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.byteLength;
        if (size > MAX_TOOL_BYTES) { response.writeHead(413).end('{"error":"tool payload too large"}'); return; }
        chunks.push(bytes);
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || canonical(Object.keys(envelope).sort()) !== canonical(['command','input']) ||
          typeof envelope.command !== 'string' || !envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input))
        fail('DEMO_ACTOR_TOOL_REFUSED', 4, 'Actor tool accepts a command/input envelope only.');
      const result = await this.host.actorOperation(this.thread, envelope);
      this.calls.push({ actor: this.actor, command: envelope.command, input: structuredClone(envelope.input), result: structuredClone(result), at: this.clock() });
      response.writeHead(200).end(JSON.stringify({ result }));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DEMO_ACTOR_TOOL_REFUSED';
      response.writeHead(400).end(JSON.stringify({ error: code }));
    }
  }
}

function sanitizedEnvironment(base: NodeJS.ProcessEnv, endpoint: string, capability: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of actorEnvironmentKeys) if (base[key] !== undefined) env[key] = base[key];
  env.STRATA_DEMO_ACTOR_ENDPOINT = endpoint; env.STRATA_DEMO_ACTOR_CAPABILITY = capability; return env;
}

export async function findCodexEntrypoint(environment: NodeJS.ProcessEnv) {
  const candidates = [environment.CODEX_CLI_ENTRYPOINT,
    environment.APPDATA ? path.join(environment.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : undefined,
    environment.USERPROFILE ? path.join(environment.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : undefined]
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) try { await access(candidate); return path.resolve(candidate); } catch { /* continue */ }
  fail('DEMO_ACTOR_CLI_MISSING', 7, 'Codex subscription CLI entrypoint is unavailable; no alternate model/provider is permitted.');
}

export function defaultProcessRunner(invocation: DemoActorProcessInvocation, signal: AbortSignal, maxTurns: number): Promise<DemoActorProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now(), elapsed = performance.now();
    const stdout: Buffer[] = [], stderr: Buffer[] = [], decoder = new StringDecoder('utf8');
    let stdoutBytes = 0, stderrBytes = 0, pending = '', turns = 0, settled = false, truncated = false, childSpawned = false;
    let termination: NonNullable<DemoActorProcessResult['process']>['termination'] = 'exit';
    let stop: Promise<unknown> | undefined;
    const snapshot = (code: number | null, exitSignal: string | null, closed: boolean): DemoActorProcessResult => ({ code,
      stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), turn_starts: turns,
      process: { started_at: started, ended_at: Date.now(), duration_ms: Math.max(0, performance.now() - elapsed),
        signal: exitSignal, termination, output_truncated: truncated, child_close_observed: closed, child_spawned: childSpawned } });
    if (signal.aborted) { termination = 'cancelled'; reject(new DemoActorProcessError(snapshot(null, null, false))); return; }
    const child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    childSpawned = !!child.pid;
    const stopTree = async () => {
      if (!child.pid) { child.kill(); return; }
      if (process.platform === 'win32') await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f'],
        { windowsHide: true, timeout: 2000, maxBuffer: 4096 }).catch(() => undefined);
      else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        await new Promise(resolve => setTimeout(resolve, 250));
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already absent */ }
      }
    };
    const finish = async (code: number | null, exitSignal: string | null, closed: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(stopDeadline); signal.removeEventListener('abort', onAbort);
      await stop;
      const result = snapshot(code, exitSignal, closed);
      if (termination !== 'exit') reject(new DemoActorProcessError(result)); else resolve(result);
    };
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    const refuse = (reason: typeof termination) => {
      if (settled || termination !== 'exit') return;
      termination = reason; clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      stop = stopTree();
      // If process teardown is uncertain, retain evidence without claiming exit.
      stopDeadline = setTimeout(() => { void finish(null, null, false); }, 2500);
    };
    const timer = setTimeout(() => refuse('timeout'), invocation.timeout_ms);
    const onAbort = () => refuse('cancelled'); signal.addEventListener('abort', onAbort, { once: true });
    const parseLine = (line: string) => {
      if (!line.trim() || termination !== 'exit') return;
      let event: any; try { event = JSON.parse(line); } catch { refuse('malformed-jsonl'); return; }
      if (event?.type === 'turn.started' && ++turns > maxTurns) refuse('turn-limit');
    };
    child.once('error', () => { termination = 'spawn-failed'; void finish(null, null, false); });
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      const bytes = Buffer.from(chunk), kept = bytes.subarray(0, Math.max(0, invocation.max_output_bytes - stdoutBytes));
      if (kept.byteLength) stdout.push(Buffer.from(kept)); stdoutBytes += kept.byteLength;
      if (kept.byteLength < bytes.byteLength) { truncated = true; refuse('output-limit'); return; }
      pending += decoder.write(kept);
      while (true) {
        const newline = pending.indexOf('\n'); if (newline < 0) break;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1); parseLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      const bytes = Buffer.from(chunk), kept = bytes.subarray(0, Math.max(0, invocation.max_output_bytes - stderrBytes));
      if (kept.byteLength) stderr.push(Buffer.from(kept)); stderrBytes += kept.byteLength;
      if (kept.byteLength < bytes.byteLength) { truncated = true; refuse('output-limit'); }
    });
    child.once('close', (code, exitSignal) => {
      pending += decoder.end(); parseLine(pending);
      if (termination === 'exit' && !turns) termination = 'missing-turn-count';
      void finish(code, exitSignal, true);
    });
    child.stdin.end(invocation.stdin, 'utf8');
  });
}

export class CodexSubscriptionActorRunner {
  private readonly now: () => number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly nodeExecutable: string;
  private readonly codexEntrypoint?: string;
  private readonly toolServerEntrypoint: string;
  private readonly processRunner: DemoActorProcessRunner;
  private readonly active = new Map<string, AbortController>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly actualTurns: Record<DemoActor, number> = { a: 0, b: 0, c: 0 };
  private readonly startedActors = new Set<DemoActor>();
  private repairStarted = false;
  private processes = 0;
  private stopped = false;
  private uncertainProcess = false;
  private stopWorkflowEvent?: Promise<unknown>;

  constructor(private readonly host: DemoHost, private readonly options: DemoActorCliOptions) {
    this.now = options.now ?? Date.now; this.environment = options.base_environment ?? process.env;
    this.nodeExecutable = path.resolve(options.node_executable ?? process.execPath);
    this.codexEntrypoint = options.codex_entrypoint && path.resolve(options.codex_entrypoint);
    this.toolServerEntrypoint = path.resolve(options.tool_server_entrypoint ?? path.join(options.project_directory, 'dist', 'src', 'integrated-demo-actor-mcp.js'));
    this.processRunner = options.run_process ?? defaultProcessRunner;
  }

  run(actor: DemoActor, thread: string, repaired = false): Promise<DemoActorTurnEvidence> {
    const limit = this.options.actor_process_limit ?? 3;
    const repairAllowed = repaired && limit === 4 && actor === 'b' && !this.repairStarted && this.startedActors.size === 3 &&
      this.host.checkpoint.phase === 'repair' && this.host.checkpoint.heads['L-reminder']?.head === 1 && this.running.size === 0;
    if (![3, 4].includes(limit) || this.processes >= limit || (repaired ? !repairAllowed : this.startedActors.has(actor)))
      fail('DEMO_ACTOR_PROCESS_LIMIT', 7, 'The reviewed process budget permits one initial process per actor and, only when approved, one reminder repair.');
    this.processes++; if (repaired) this.repairStarted = true;
    this.startedActors.add(actor);
    const work = this.runOne(actor, thread, repaired); this.running.add(work);
    return work.finally(() => this.running.delete(work));
  }

  async cancelAndStopWorkflow() {
    this.stopped = true; this.host.cancel();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.running]);
    return this.dispatchStopEvent();
  }

  async settleActiveProcesses() {
    if (this.active.size) {
      this.stopped = true; this.host.cancel();
      for (const controller of this.active.values()) controller.abort();
    }
    await Promise.allSettled([...this.running]);
    if (this.uncertainProcess) fail('DEMO_ACTOR_TEARDOWN_UNCERTAIN', 7, 'Local child exit was not observed; preserve the journal and reconcile before remote deletion.');
  }

  private dispatchStopEvent() {
    this.stopWorkflowEvent ??= this.host.event('stop', 'host', {});
    return this.stopWorkflowEvent;
  }

  private async runOne(actor: DemoActor, thread: string, repaired: boolean): Promise<DemoActorTurnEvidence> {
    if (this.stopped) fail('DEMO_RUN_STOPPED', 7, 'Actor launcher was cancelled.');
    const workDeadline = this.options.run_expires_at - DEMO_LIMITS.cleanup_ms;
    const timeout = Math.min(this.options.actor_process_timeout_ms ?? MAX_ACTOR_PROCESS_MS, workDeadline - this.now());
    if (timeout <= 0) fail('DEMO_RUN_STOPPED', 7, 'No actor time remains before the fixed cleanup reserve.');
    const model = actorCliModel(actor), allocation = this.host.beginTurn(thread);
    if (allocation.model !== model.model || allocation.reasoningEffort !== model.reasoning_effort) {
      this.host.endTurn(thread, true);
      fail('DEMO_ACTOR_PROFILE_REFUSED', 7, 'Host actor allocation does not match the fixed Luna model profile.');
    }
    const bridge = new DemoActorToolBridge(this.host, actor, thread, this.now);
    const controller = new AbortController(); this.active.set(thread, controller);
    const timer = setTimeout(() => controller.abort(), timeout); let turnEnded = false, cancelled = false;
    let invocation: DemoActorProcessInvocation | undefined, endpoint: { endpoint: string; capability: string } | undefined;
    let prompt = '', result: DemoActorProcessResult | undefined, evidenceSaved = false;
    let invocationStarted = this.now(), invocationElapsed = performance.now();
    const save = async (error?: unknown) => {
      if (evidenceSaved) return;
      const redact = (text: string, truncated = false) => {
        if (!endpoint) return text;
        let masked = text.replaceAll(endpoint.capability, '[redacted-capability]').replaceAll(endpoint.endpoint, '[local-actor-endpoint]');
        if (truncated && result?.process?.output_truncated) for (const value of [endpoint.capability, endpoint.endpoint]) {
          for (let length = value.length - 1; length > 0; length--) if (masked.endsWith(value.slice(0, length))) {
            masked = masked.slice(0, -length) + '[redacted-truncated-bridge-value]'; break;
          }
        }
        return masked;
      };
      const evidence: DemoActorTurnEvidence = { actor, assigned_revision: repaired ? 2 : 1, thread, model: model.model, reasoning_effort: model.reasoning_effort,
        prompt, prompt_sha256: bytesDigest(prompt), codex_event_stream: redact(result?.stdout ?? '', true), codex_stderr: redact(result?.stderr ?? '', true),
        turn_starts: result?.turn_starts ?? 0, tool_calls: JSON.parse(redact(JSON.stringify(bridge.calls))), exit_code: result?.code ?? null,
        command: invocation ? { executable: invocation.executable, args: invocation.args.map(value => redact(value)), cwd: invocation.cwd, shell: false,
          timeout_ms: invocation.timeout_ms, max_output_bytes: invocation.max_output_bytes, environment_keys: Object.keys(invocation.env).sort(), environment_values_retained: false } : null,
        invocation: { started_at: invocationStarted, ended_at: this.now(), duration_ms: Math.max(0, performance.now() - invocationElapsed), boundary: 'host subprocess invocation; not inference timing' },
        process: result?.process ?? null, process_error_code: error ? (error instanceof DemoActorProcessError ? error.code : 'DEMO_ACTOR_PROCESS_FAILED') : null,
        partial: !!error || !result || result.code !== 0 || !!result.process && result.process.termination !== 'exit', label: this.options.process_label ?? 'real-codex-subscription-cli' };
      evidenceSaved = true; await this.options.save_evidence?.(evidence); return evidence;
    };
    try {
      endpoint = await bridge.listen();
      const codex = this.codexEntrypoint ?? await findCodexEntrypoint(this.environment);
      const project = path.resolve(this.options.project_directory);
      const command = codexActorCommand(project, { actor, codexEntrypoint: codex, nodeExecutable: this.nodeExecutable,
        toolServerEntrypoint: this.toolServerEntrypoint, mcpCwd: project });
      const skill = await readFile(path.join(project, 'agent', 'strata', 'SKILL.md'), 'utf8');
      const sections = skill.split(/(?=^## )/m).filter(section => /^## (Author only|Preserve conflicts|Keep execution)/.test(section));
      prompt = 'Reviewed portable Strata skill excerpt (host MCP envelope replaces ordinary CLI transport):\n' + sections.join('\n') + '\n\n' + demoActorInstructions(actor, repaired);
      invocation = { executable: command.executable, args: command.args, cwd: project,
        env: sanitizedEnvironment(this.environment, endpoint.endpoint, endpoint.capability), stdin: prompt, timeout_ms: timeout,
        max_output_bytes: MAX_PROCESS_OUTPUT_BYTES, windows_hide: true, shell: false };
      const remainingTurns = allocation.max_host_turns - this.actualTurns[actor];
      if (remainingTurns <= 0) fail('DEMO_ACTOR_TURN_LIMIT', 7, 'No inference turns remain for this actor.');
      invocationStarted = this.now(); invocationElapsed = performance.now();
      result = await this.processRunner(invocation, controller.signal, remainingTurns);
      const evidence = (await save())!;
      if (controller.signal.aborted || result.code !== 0) fail('DEMO_ACTOR_PROCESS_FAILED', 7, 'Codex actor process did not finish; no provider/model fallback is permitted.');
      if (!Number.isSafeInteger(result.turn_starts) || result.turn_starts < 1 || result.turn_starts > allocation.max_host_turns ||
          this.actualTurns[actor] + result.turn_starts > allocation.max_host_turns)
        fail('DEMO_ACTOR_TURN_LIMIT', 7, 'Codex inference-turn count is missing or exceeds the fixed per-actor ceiling.');
      const expectedRef = DEMO_ACTORS[actor].layer + '@' + (repaired ? 2 : 1);
      if (!bridge.calls.some(call => call.command === 'layer.publish' && (call.input as any)?.ref === expectedRef &&
          (call.result as any)?.outcome?.ok === true) || this.host.checkpoint.heads[DEMO_ACTORS[actor].layer]?.head !== (repaired ? 2 : 1))
        fail('DEMO_ACTOR_NO_PUBLICATION', 7, `Actor ${actor} exited without publishing ${expectedRef}; inspect its saved actor evidence. No dependent actor or prepare will run.`);
      this.actualTurns[actor] += result.turn_starts; this.host.endTurn(thread); turnEnded = true;
      return evidence;
    } catch (error) {
      if (error instanceof DemoActorProcessError) result = error.result;
      if (result?.process?.child_spawned && !result.process.child_close_observed) this.uncertainProcess = true;
      // Preserve bounded partial output before cancellation/cleanup, even when
      // no result was returned. Unknown custom-runner errors retain no raw text.
      let evidenceFailure: unknown;
      try { await save(error); } catch (failure) { evidenceFailure = failure; }
      cancelled = true; this.stopped = true; this.host.cancel();
      for (const pending of this.active.values()) pending.abort();
      await this.dispatchStopEvent().catch(() => undefined);
      if (evidenceFailure) fail('DEMO_ACTOR_EVIDENCE_FAILED', 7, 'Actor evidence could not be durably saved; cleanup still ran.');
      throw error;
    } finally {
      clearTimeout(timer); this.active.delete(thread);
      if (!turnEnded && !cancelled) { try { this.host.endTurn(thread); } catch { /* host cancellation already closed the turn */ } }
      await bridge.close().catch(() => undefined);
    }
  }
}
