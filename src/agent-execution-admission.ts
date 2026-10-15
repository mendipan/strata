import { z } from 'zod';
import {
  AgentExecutionError, executionTaskSchema, executionGrantSchema, executionTaskRefSchema,
  executionTaskRef, sameExecutionValue, assertExecutionTransition, executionResultSchema,
  executionDigest, executionSnapshotSchema, type ExecutionTask, type ExecutionTaskRef,
  type ExecutionGrant, type ExecutionSnapshot, type ExecutionResult, type ExecutionOperation,
} from './agent-execution.js';
import { AgentExecutionClient } from './agent-execution-client.js';
import { ExecutionAccess } from './agent-execution-access.js';
import {
  CloudflareExecutionJournal, type CloudflareExecutionStorage, type CloudflareExecutionTransaction,
  type CloudflareExecutionRecord,
} from './agent-adapters/cloudflare-execution-journal.js';
import { executionParse, executionBytes, executionFailure, executionWait } from './agent-adapters/cloudflare-execution-protocol.js';

// Local host metadata supplements the accepted journal; it is not a wire DTO,
// consent store or second task/result journal. One storage instance has one owner
// and connection. The adapter/service uses a DIFFERENT storage instance.
const prefix = 'strata-execution-host/1/';
const ownerSchema = z.object({ owner_id: z.string().min(1).max(256), connection_id: z.string().min(1).max(256) }).strict();
const permissionSchema = z.object({
  owner_id: ownerSchema.shape.owner_id, task: executionTaskRefSchema,
  operations: z.array(z.enum(['submit', 'status', 'result', 'cancel'])).min(1).max(4),
  limits: executionTaskSchema.shape.limits,
}).strict();
export type ExecutionAdmission = z.infer<typeof permissionSchema> & { grant: ExecutionGrant };
export type RetainedExecution = { permission: z.infer<typeof permissionSchema>; record: CloudflareExecutionRecord };
export type ExecutionJournalOptions = { capacity?: number; resultRetentionMs?: number; admissionLimits?: { activeTasks: number; startsPerMinute: number } };

/** Reuses the accepted atomic reservation, budgets, ID index and result journal. */
export class ExecutionAdmissionJournal {
  private readonly owner: z.infer<typeof ownerSchema>;
  private readonly options: ExecutionJournalOptions;
  constructor(private readonly storage: CloudflareExecutionStorage, ownerId: string,
    readonly connectionId: string, options: ExecutionJournalOptions = {}) {
    this.options = structuredClone(options);
    this.owner = executionParse(ownerSchema, { owner_id: ownerId, connection_id: connectionId }, 'EXECUTION_INVALID');
    this.journal(storage); // Validate configured bounds even before provisioning.
  }
  private journal(storage: CloudflareExecutionStorage) {
    return new CloudflareExecutionJournal(storage, this.connectionId, this.options.capacity,
      this.options.resultRetentionMs, this.options.admissionLimits);
  }
  private async transaction<T>(work: (tx: CloudflareExecutionTransaction, journal: CloudflareExecutionJournal) => Promise<T>): Promise<T> {
    try {
      return await this.storage.transaction(async tx => {
        const owner = executionParse(ownerSchema, await tx.get(prefix + 'owner'));
        if (!sameExecutionValue(owner, this.owner)) throw new AgentExecutionError('EXECUTION_BINDING');
        // Nested journal operations share this transaction; no native/auth calls.
        return work(tx, this.journal({ transaction: closure => closure(tx) }));
      });
    } catch (error) { throw executionFailure(error); }
  }
  /** Explicit trusted provisioning only. Startup never repairs missing state. */
  async initializeEmpty(): Promise<void> {
    try {
      await this.storage.transaction(async tx => {
        if ((await tx.list({ prefix, limit: 1 })).size) throw new AgentExecutionError('EXECUTION_CONFLICT');
        await this.journal({ transaction: closure => closure(tx) }).initializeEmpty();
        await tx.put(prefix + 'owner', this.owner);
      });
    } catch (error) { throw executionFailure(error); }
  }
  private async retained(tx: CloudflareExecutionTransaction, journal: CloudflareExecutionJournal,
    ref: ExecutionTaskRef, grant: ExecutionGrant): Promise<RetainedExecution> {
    const record = await journal.get(ref, grant);
    const permission = executionParse(permissionSchema, await tx.get(prefix + ref.task_id));
    if (permission.owner_id !== this.owner.owner_id || !sameExecutionValue(permission.task, ref) ||
      record.task.limits.runtime_ms > permission.limits.runtime_ms || record.task.limits.output_bytes > permission.limits.output_bytes ||
      new Set(permission.operations).size !== permission.operations.length) throw new AgentExecutionError('EXECUTION_PROTOCOL');
    // Absence of a marker is valid ONLY for the pristine queued/0 reservation.
    // Losing a marker from an observed/terminal record is corruption, not a new
    // initial lookup. Check during reads so no adapter is contacted to repair it.
    if (record.native_handle === undefined) {
      if (record.snapshot.state !== 'queued' || record.snapshot.sequence !== 0 || record.cancel_intent !== undefined ||
        record.result !== undefined || record.result_expires_at !== undefined) throw new AgentExecutionError('EXECUTION_PROTOCOL');
    } else if (record.native_handle !== 'host-observation/' + ref.task_id) throw new AgentExecutionError('EXECUTION_PROTOCOL');
    return { record, permission };
  }
  read(ref: ExecutionTaskRef, grant: ExecutionGrant): Promise<RetainedExecution> {
    return this.transaction((tx, journal) => this.retained(tx, journal, ref, grant));
  }
  async reserve(task: ExecutionTask, admission: ExecutionAdmission, now: number, guard: () => void) {
    const grant = executionParse(executionGrantSchema, admission.grant, 'EXECUTION_INVALID');
    const { grant: _grant, ...rawPermission } = admission;
    const permission = executionParse(permissionSchema, rawPermission, 'EXECUTION_INVALID');
    const ref = await executionTaskRef(task);
    if (permission.owner_id !== this.owner.owner_id || !sameExecutionValue(permission.task, ref) ||
      !sameExecutionValue(grant.task, ref) || !permission.operations.includes('submit') ||
      task.limits.runtime_ms > permission.limits.runtime_ms || task.limits.output_bytes > permission.limits.output_bytes ||
      new Set(permission.operations).size !== permission.operations.length) throw new AgentExecutionError('EXECUTION_AUTH');
    return this.transaction(async (tx, journal) => {
      const reserved = await journal.reserve(task, grant, now, guard);
      if (reserved.fresh) {
        if (await tx.get(prefix + ref.task_id)) throw new AgentExecutionError('EXECUTION_PROTOCOL');
        guard(); await tx.put(prefix + ref.task_id, permission); guard();
      } else await this.retained(tx, journal, ref, grant);
      return reserved;
    });
  }
  observe(ref: ExecutionTaskRef, grant: ExecutionGrant, input: ExecutionSnapshot, now: number, guard: () => void) {
    const snapshot = executionParse(executionSnapshotSchema, input);
    if (!sameExecutionValue(snapshot.task, ref)) throw new AgentExecutionError('EXECUTION_BINDING');
    if (executionBytes(snapshot) > 32768) throw new AgentExecutionError('EXECUTION_LIMIT');
    return this.transaction(async (tx, journal) => {
      tx.beforeCommit?.(guard);
      const { record } = await this.retained(tx, journal, ref, grant);
      // This opaque marker means a guarded HOST observation was retained. It is
      // never a provider native handle; real handles live only in the service.
      const handle = 'host-observation/' + ref.task_id;
      if (record.native_handle && record.native_handle !== handle) throw new AgentExecutionError('EXECUTION_PROTOCOL');
      // queued/0 without this marker is only a write-ahead reservation, never a
      // remote observation. Any schema-valid initial state/sequence is legal.
      // Once marked, the ordinary transition/immutability checks apply forever.
      if (!record.native_handle) {
        record.native_handle = handle; record.snapshot = snapshot;
        guard(); await tx.put('strata-execution/1/' + ref.task_id, record); guard();
        return record;
      }
      if (snapshot.state !== 'succeeded') return journal.observe(ref, grant, { handle, snapshot }, now, guard);
      // A host status operation may be approved WITHOUT output retrieval. Reuse
      // the same journal record/index and shared transition guard, but do not use
      // its native-envelope observe(), which requires result bytes on success.
      if (snapshot.sequence < record.snapshot.sequence) return record;
      assertExecutionTransition(record.snapshot, snapshot);
      record.native_handle = handle; record.snapshot = snapshot;
      guard(); await tx.put('strata-execution/1/' + ref.task_id, record); guard();
      return record;
    });
  }
  retainResult(ref: ExecutionTaskRef, grant: ExecutionGrant, input: ExecutionResult, now: number, guard: () => void) {
    const result = executionParse(executionResultSchema, input);
    return this.transaction(async (tx, journal) => {
      tx.beforeCommit?.(guard);
      const { record } = await this.retained(tx, journal, ref, grant);
      if (record.snapshot.state !== 'succeeded' || !sameExecutionValue(result.task, ref) ||
        await executionDigest(result) !== record.snapshot.result_sha256) throw new AgentExecutionError('EXECUTION_BINDING');
      if (executionBytes(result) > record.task.limits.output_bytes) throw new AgentExecutionError('EXECUTION_LIMIT');
      if (record.result && !sameExecutionValue(record.result, result)) throw new AgentExecutionError('EXECUTION_BINDING');
      // A timestamp without bytes is the accepted journal's expired tombstone.
      // Only a first authorized retrieval can attach bytes; never replenish them.
      if (record.result_expires_at === undefined) {
        record.result = result; record.result_expires_at = now + (this.options.resultRetentionMs ?? 300000);
        guard(); await tx.put('strata-execution/1/' + ref.task_id, record); guard();
      }
    });
  }
  result(ref: ExecutionTaskRef, grant: ExecutionGrant, now: () => number, guard: () => void) {
    return this.transaction(async (tx, journal) => {
      await this.retained(tx, journal, ref, grant);
      try { return await journal.result(ref, grant, now, guard); }
      catch (error) {
        // Expiry deletion must commit before the public refusal. The reused
        // journal normally throws after its transaction; ours encloses it.
        if (error instanceof AgentExecutionError && error.code === 'EXECUTION_RESULT_UNAVAILABLE') return undefined;
        throw error;
      }
    }).then(value => { if (!value) throw new AgentExecutionError('EXECUTION_RESULT_UNAVAILABLE'); return value; });
  }
}

/** Explicit operations only: no scheduler, retries, reconnect or background work. */
export class ExecutionAdmissionCore {
  constructor(private readonly journal: ExecutionAdmissionJournal, private readonly access: ExecutionAccess,
    private readonly client: AgentExecutionClient, private readonly now: () => number = Date.now) {}

  private async operation<T>(ref: ExecutionTaskRef, operation: ExecutionOperation,
    work: (signal: AbortSignal) => Promise<T>, input?: AbortSignal): Promise<T> {
    const wait = this.access.openWait(ref, operation, input);
    try { return await work(wait.signal); }
    catch (error) { throw executionFailure(error, error instanceof AgentExecutionError && error.dispatch === 'unknown'); }
    finally { wait.dispose(); }
  }
  async submit(input: ExecutionTask, signal?: AbortSignal): Promise<ExecutionSnapshot> {
    const task = executionParse(executionTaskSchema, input, 'EXECUTION_INVALID');
    if (executionBytes(task) > 32768) throw new AgentExecutionError('EXECUTION_LIMIT');
    const ref = await executionTaskRef(task);
    return this.operation(ref, 'submit', async wait => {
      const admission = this.access.admit(ref, task, wait);
      const reservation = await executionWait(() => this.journal.reserve(task, admission, this.now(),
        () => this.access.guard(admission.grant, 'submit', wait)), wait);
      if (!reservation.fresh) {
        await this.required(ref, 'submit', wait);
        // An admission without an accepted observation stays uncertain, even if
        // dispatch never reached the adapter. Only explicit original-ref status.
        if (!reservation.record.native_handle) throw new AgentExecutionError('EXECUTION_UNAVAILABLE', 'unknown');
        this.access.guard(admission.grant, 'submit', wait);
        return structuredClone(reservation.record.snapshot);
      }
      const snapshot = await this.client.submit(task, wait);
      return this.retain(ref, snapshot, 'submit', wait);
    }, signal);
  }
  status(input: ExecutionTaskRef, signal?: AbortSignal): Promise<ExecutionSnapshot> {
    return this.observe('status', input, signal);
  }
  cancel(input: ExecutionTaskRef, signal?: AbortSignal): Promise<ExecutionSnapshot> {
    return this.observe('cancel', input, signal);
  }
  private observe(operation: 'status' | 'cancel', input: ExecutionTaskRef, signal?: AbortSignal) {
    const ref = executionParse(executionTaskRefSchema, input, 'EXECUTION_INVALID');
    return this.operation(ref, operation, async wait => {
      const grant = await this.required(ref, operation, wait), { record } = await executionWait(() => this.journal.read(ref, grant), wait);
      const previous = record.native_handle ? record.snapshot : undefined;
      const snapshot = operation === 'status' ? await this.client.status(ref, previous, wait) : await this.client.cancel(ref, previous, wait);
      return this.retain(ref, snapshot, operation, wait);
    }, signal);
  }
  private async required(ref: ExecutionTaskRef, operation: ExecutionOperation, signal: AbortSignal) {
    const grant = await executionWait(() => this.access.current(ref, operation, signal), signal);
    if (!grant) throw new AgentExecutionError('EXECUTION_AUTH');
    return grant;
  }
  private async retain(ref: ExecutionTaskRef, snapshot: ExecutionSnapshot, operation: ExecutionOperation, signal: AbortSignal) {
    try {
      const grant = await this.required(ref, operation, signal);
      const retained = await executionWait(() => this.journal.observe(ref, grant, snapshot, this.now(),
        () => this.access.guard(grant, operation, signal)), signal);
      this.access.guard(grant, operation, signal);
      return retained.snapshot;
    } catch (error) { throw executionFailure(error, true); }
  }
  result(input: ExecutionTaskRef, signal?: AbortSignal): Promise<ExecutionResult> {
    const ref = executionParse(executionTaskRefSchema, input, 'EXECUTION_INVALID');
    return this.operation(ref, 'result', async wait => {
      let fetched = false;
      try {
        const grant = await this.required(ref, 'result', wait);
        const { record } = await executionWait(() => this.journal.read(ref, grant), wait);
        if (record.snapshot.state !== 'succeeded') throw new AgentExecutionError('EXECUTION_RESULT_UNAVAILABLE');
        if (record.result_expires_at === undefined) {
          const output = await this.client.result(record.task, record.snapshot, wait);
          fetched = true;
          const current = await this.required(ref, 'result', wait);
          if (!sameExecutionValue(grant, current)) throw new AgentExecutionError('EXECUTION_STALE');
          await executionWait(() => this.journal.retainResult(ref, current, output, this.now(),
            () => this.access.guard(current, 'result', wait)), wait);
        }
        const result = await executionWait(() => this.journal.result(ref, grant, this.now,
          () => this.access.guard(grant, 'result', wait)), wait);
        this.access.guard(grant, 'result', wait);
        return result;
      } catch (error) {
        throw executionFailure(error, fetched || (error instanceof AgentExecutionError && error.dispatch === 'unknown'));
      }
    }, signal);
  }
}
