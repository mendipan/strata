import { z } from 'zod';
import {
  AgentExecutionError, executionDeclarationSchema, executionTaskSchema, executionTaskRefSchema,
  executionSnapshotSchema, executionResultSchema, executionGrantSchema, executionErrorCodeSchema,
  executionDigest, executionTaskRef, sameExecutionValue, assertExecutionTransition,
  type AgentExecutionAdapterV1, type AgentExecutionAccess, type ExecutionDeclaration,
  type ExecutionTask, type ExecutionTaskRef, type ExecutionSnapshot, type ExecutionResult,
  type ExecutionGrant, type ExecutionOperation, type ExecutionContext,
} from './agent-execution.js';

function parse<T>(schema: z.ZodType<T>, value: unknown, code: 'EXECUTION_INVALID' | 'EXECUTION_PROTOCOL'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentExecutionError(code);
  return parsed.data;
}
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = () => new AgentExecutionError(signal.reason?.name === 'TimeoutError' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_ABORTED');
  if (signal.aborted) throw aborted();
  let listener!: () => void;
  try {
    return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw aborted(); return work(); }),
      new Promise<never>((_, reject) => { listener = () => reject(aborted()); signal.addEventListener('abort', listener, { once: true }); })]);
  } finally { signal.removeEventListener('abort', listener); }
}

/** Host-side guard, not a scheduler, journal, credential store or transport. */
export class AgentExecutionClient {
  private readonly declaration?: ExecutionDeclaration;
  constructor(private readonly adapter?: AgentExecutionAdapterV1,
    private readonly access?: AgentExecutionAccess, private readonly now: () => number = Date.now) {
    if (adapter) {
      try { this.declaration = parse(executionDeclarationSchema, adapter.describe(), 'EXECUTION_INVALID'); }
      catch { throw new AgentExecutionError('EXECUTION_INVALID'); }
    }
  }

  private async call<T>(operation: ExecutionOperation, ref: ExecutionTaskRef,
    invoke: (context: ExecutionContext) => Promise<unknown>, validate: (value: unknown) => Promise<T>,
    inputSignal?: AbortSignal): Promise<T> {
    let dispatched = false;
    try {
      if (!this.adapter || !this.access || !this.declaration) throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
      if (!this.declaration.models.includes(ref.binding.model_version)) throw new AgentExecutionError('EXECUTION_VERSION');
      if (operation === 'cancel' && this.declaration.capabilities.cancel === 'unsupported') throw new AgentExecutionError('EXECUTION_UNSUPPORTED');
      const signal = AbortSignal.any([...(inputSignal ? [inputSignal] : []), AbortSignal.timeout(this.declaration.limits.call_timeout_ms)]);
      return await bounded(async () => {
        const digest = await executionDigest(this.declaration);
        const readGrant = async (): Promise<ExecutionGrant> => {
          const raw = await bounded(() => this.access!.current(structuredClone(ref), operation, signal), signal);
          if (!raw) throw new AgentExecutionError('EXECUTION_AUTH');
          const grant = parse(executionGrantSchema, raw, 'EXECUTION_PROTOCOL');
          if (!sameExecutionValue(grant.task, ref) || grant.declaration_sha256 !== digest) throw new AgentExecutionError('EXECUTION_BINDING');
          if (Date.parse(grant.valid_until) <= this.now()) throw new AgentExecutionError('EXECUTION_EXPIRED');
          return grant;
        };
        const before = await readGrant();
        const sessionSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(10000, Math.max(1, Date.parse(before.valid_until) - this.now())))]);
        const value = await bounded(() => {
          if (Date.parse(before.valid_until) <= this.now()) throw new AgentExecutionError('EXECUTION_EXPIRED');
          dispatched = true;
          return invoke({ grant: structuredClone(before), signal: sessionSignal });
        }, sessionSignal);
        const result = await validate(value);
        const after = await readGrant();
        if (!sameExecutionValue(before, after)) throw new AgentExecutionError('EXECUTION_STALE');
        if (sessionSignal.aborted) throw new AgentExecutionError('EXECUTION_EXPIRED');
        return result;
      }, signal);
    } catch (error) {
      const code = error instanceof AgentExecutionError && executionErrorCodeSchema.safeParse(error.code).success
        ? error.code : 'EXECUTION_UNAVAILABLE';
      // Even a typed provider error cannot assert that a dispatched write did not run.
      throw new AgentExecutionError(code, dispatched ? 'unknown' : 'not_dispatched');
    }
  }

  private snapshot(value: unknown, ref: ExecutionTaskRef, previous?: ExecutionSnapshot): ExecutionSnapshot {
    const snapshot = parse(executionSnapshotSchema, value, 'EXECUTION_PROTOCOL');
    if (bytes(snapshot) > 32768) throw new AgentExecutionError('EXECUTION_LIMIT');
    if (!sameExecutionValue(snapshot.task, ref)) throw new AgentExecutionError('EXECUTION_BINDING');
    if (previous) assertExecutionTransition(previous, snapshot);
    return snapshot;
  }

  async submit(input: ExecutionTask, signal?: AbortSignal): Promise<ExecutionSnapshot> {
    const task = parse(executionTaskSchema, input, 'EXECUTION_INVALID');
    if (bytes(task) > 32768) throw new AgentExecutionError('EXECUTION_LIMIT');
    if (this.declaration && (task.limits.runtime_ms > this.declaration.limits.task_runtime_ms ||
      task.limits.output_bytes > this.declaration.limits.output_bytes)) throw new AgentExecutionError('EXECUTION_LIMIT');
    const ref = await executionTaskRef(task);
    return this.call('submit', ref, ctx => this.adapter!.submit(structuredClone(task), ctx),
      async value => this.snapshot(value, ref), signal);
  }

  async status(input: ExecutionTaskRef, previous?: ExecutionSnapshot, signal?: AbortSignal): Promise<ExecutionSnapshot> {
    const ref = parse(executionTaskRefSchema, input, 'EXECUTION_INVALID');
    const before = this.previous(ref, previous);
    return this.call('status', ref, ctx => this.adapter!.status(structuredClone(ref), ctx),
      async value => this.snapshot(value, ref, before), signal);
  }

  async cancel(input: ExecutionTaskRef, previous?: ExecutionSnapshot, signal?: AbortSignal): Promise<ExecutionSnapshot> {
    const ref = parse(executionTaskRefSchema, input, 'EXECUTION_INVALID');
    const before = this.previous(ref, previous);
    return this.call('cancel', ref, ctx => this.adapter!.cancel(structuredClone(ref), ctx), async value => {
      const result = this.snapshot(value, ref, before);
      if (result.state === 'queued' || result.state === 'running') throw new AgentExecutionError('EXECUTION_PROTOCOL');
      return result;
    }, signal);
  }

  async result(input: ExecutionTask, completed: ExecutionSnapshot, signal?: AbortSignal): Promise<ExecutionResult> {
    const task = parse(executionTaskSchema, input, 'EXECUTION_INVALID'), ref = await executionTaskRef(task);
    const snapshot = this.previous(ref, parse(executionSnapshotSchema, completed, 'EXECUTION_INVALID'))!;
    if (snapshot.state !== 'succeeded') throw new AgentExecutionError('EXECUTION_RESULT_UNAVAILABLE');
    return this.call('result', ref, ctx => this.adapter!.result(structuredClone(ref), ctx), async value => {
      const result = parse(executionResultSchema, value, 'EXECUTION_PROTOCOL');
      if (!sameExecutionValue(result.task, ref)) throw new AgentExecutionError('EXECUTION_BINDING');
      if (bytes(result) > Math.min(task.limits.output_bytes, this.declaration!.limits.output_bytes)) throw new AgentExecutionError('EXECUTION_LIMIT');
      if (await executionDigest(result) !== snapshot.result_sha256) throw new AgentExecutionError('EXECUTION_BINDING');
      return result;
    }, signal);
  }

  private previous(ref: ExecutionTaskRef, value?: ExecutionSnapshot): ExecutionSnapshot | undefined {
    if (value === undefined) return undefined;
    const previous = parse(executionSnapshotSchema, value, 'EXECUTION_INVALID');
    if (!sameExecutionValue(previous.task, ref)) throw new AgentExecutionError('EXECUTION_BINDING');
    return previous;
  }
}
