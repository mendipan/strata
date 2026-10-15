import { z } from 'zod';
import {
  AgentExecutionError, executionTaskSchema, executionSnapshotSchema, executionResultSchema, executionGrantSchema,
  executionTaskRef, executionDigest, sameExecutionValue, assertExecutionTransition,
  type ExecutionTask, type ExecutionTaskRef, type ExecutionGrant, type ExecutionSnapshot, type ExecutionResult,
} from '../agent-execution.js';
import { executionParse, executionBytes } from './cloudflare-execution-protocol.js';

// Structural subset of DurableObjectStorage.transaction. Transactions can retry;
// callbacks below only perform storage operations, never auth or native start.
export interface CloudflareExecutionTransaction {
  // Local file publication can yield after the closure's last guard. Register
  // that same guard at its atomic commit boundary; native DO ports may omit it.
  beforeCommit?(guard: () => void): void;
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T = unknown>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
}
export interface CloudflareExecutionStorage {
  transaction<T>(closure: (transaction: CloudflareExecutionTransaction) => Promise<T>): Promise<T>;
}
const prefix = 'strata-execution/1/', headerKey = prefix + 'journal';
const headerSchema = z.object({ format: z.literal('strata-cloudflare-execution-journal/1'),
  connection_id: z.string(), ids: z.array(z.string().uuid()).max(256),
  admissions_at: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).max(256),
}).strict();
const recordSchema = z.object({
  format: z.literal('strata-cloudflare-execution-record/1'), task: executionTaskSchema,
  admission: executionGrantSchema, snapshot: executionSnapshotSchema,
  native_handle: z.string().regex(/^[A-Za-z0-9_.:/-]{1,256}$/).optional(),
  deadline_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), cancel_intent: z.literal(true).optional(),
  result: executionResultSchema.optional(), result_expires_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type CloudflareExecutionRecord = z.infer<typeof recordSchema>;
function admissionScope(grant: ExecutionGrant) {
  const { task, declaration_sha256, service_id, instance_id, subject, approval_generation, selection_generation } = grant;
  return { task, declaration_sha256, service_id, instance_id, subject, approval_generation, selection_generation };
}

/** One protected connection per journal. No automatic initialization or deletion.
 * Index and records commit atomically; expired outputs retain permanent IDs.
 * Actual crash durability requires the injected Cloudflare storage implementation.
 */
export class CloudflareExecutionJournal {
  constructor(private readonly storage: CloudflareExecutionStorage, readonly connectionId: string,
    readonly capacity = 64, readonly resultRetentionMs = 300000,
    readonly admissionLimits = { activeTasks: 4, startsPerMinute: 16 }) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256 || !Number.isInteger(resultRetentionMs) || resultRetentionMs < 1 || resultRetentionMs > 3600000)
      throw new AgentExecutionError('EXECUTION_INVALID');
    for (const limit of [admissionLimits.activeTasks, admissionLimits.startsPerMinute])
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new AgentExecutionError('EXECUTION_INVALID');
  }
  // Explicit provisioning in trusted composition only, never a request route.
  async initializeEmpty(): Promise<void> {
    await this.storage.transaction(async tx => {
      if ((await tx.list({ prefix, limit: 1 })).size) throw new AgentExecutionError('EXECUTION_CONFLICT');
      await tx.put(headerKey, { format: 'strata-cloudflare-execution-journal/1', connection_id: this.connectionId, ids: [], admissions_at: [] });
    });
  }
  private async header(tx: CloudflareExecutionTransaction) {
    const raw = await tx.get(headerKey);
    if (!raw) throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
    const header = executionParse(headerSchema, raw);
    if (header.connection_id !== this.connectionId || header.ids.length > this.capacity || new Set(header.ids).size !== header.ids.length)
      throw new AgentExecutionError('EXECUTION_PROTOCOL');
    return header;
  }
  private async indexedRecord(tx: CloudflareExecutionTransaction, taskId: string): Promise<CloudflareExecutionRecord> {
    const record = executionParse(recordSchema, await tx.get(prefix + taskId));
    const retained = await executionTaskRef(record.task);
    if (retained.connection_id !== this.connectionId || retained.task_id !== taskId ||
        !sameExecutionValue(record.snapshot.task, retained) || !sameExecutionValue(record.admission.task, retained)) throw new AgentExecutionError('EXECUTION_PROTOCOL');
    if (record.result && (record.snapshot.state !== 'succeeded' || !sameExecutionValue(record.result.task, retained) ||
        await executionDigest(record.result) !== record.snapshot.result_sha256 || record.result_expires_at === undefined ||
        executionBytes(record.result) > record.task.limits.output_bytes)) throw new AgentExecutionError('EXECUTION_PROTOCOL');
    return record;
  }
  private async read(tx: CloudflareExecutionTransaction, ref: ExecutionTaskRef, grant: ExecutionGrant): Promise<CloudflareExecutionRecord> {
    const header = await this.header(tx);
    if (ref.connection_id !== this.connectionId) throw new AgentExecutionError('EXECUTION_BINDING');
    if (!header.ids.includes(ref.task_id)) throw new AgentExecutionError('EXECUTION_NOT_FOUND');
    const record = await this.indexedRecord(tx, ref.task_id);
    if (!sameExecutionValue(record.admission.task, ref)) throw new AgentExecutionError('EXECUTION_CONFLICT');
    if (!sameExecutionValue(admissionScope(record.admission), admissionScope(grant))) throw new AgentExecutionError('EXECUTION_STALE');
    return record;
  }
  async reserve(task: ExecutionTask, grant: ExecutionGrant, now: number, guard: () => void): Promise<{ fresh: boolean; record: CloudflareExecutionRecord }> {
    const ref = await executionTaskRef(task);
    return this.storage.transaction(async tx => {
      tx.beforeCommit?.(guard);
      const header = await this.header(tx);
      if (ref.connection_id !== this.connectionId) throw new AgentExecutionError('EXECUTION_BINDING');
      if (header.ids.includes(ref.task_id)) return { fresh: false, record: await this.read(tx, ref, grant) };
      if (await tx.get(prefix + ref.task_id)) throw new AgentExecutionError('EXECUTION_PROTOCOL');
      if (header.ids.length >= this.capacity) throw new AgentExecutionError('EXECUTION_LIMIT');
      if (header.admissions_at.some(time => time > now)) throw new AgentExecutionError('EXECUTION_UNAVAILABLE');
      const recent = header.admissions_at.filter(time => time > now - 60000);
      if (recent.length >= this.admissionLimits.startsPerMinute) throw new AgentExecutionError('EXECUTION_LIMIT');
      let active = 0;
      for (const id of header.ids) {
        const retained = await this.indexedRecord(tx, id);
        if (!['succeeded', 'failed', 'cancelled'].includes(retained.snapshot.state)) active++;
      }
      if (active >= this.admissionLimits.activeTasks) throw new AgentExecutionError('EXECUTION_LIMIT');
      const record: CloudflareExecutionRecord = { format: 'strata-cloudflare-execution-record/1', task: structuredClone(task),
        admission: structuredClone(grant), deadline_at: now + task.limits.runtime_ms,
        snapshot: { format: 'strata-agent-task-status/1', task: ref, state: 'queued', sequence: 0 } };
      // Absence of a handle means uncertain admission, including a crash before
      // start. Subsequent submit NEVER starts this retained ID again.
      guard(); await tx.put(prefix + ref.task_id, record);
      guard();
      await tx.put(headerKey, { ...header, ids: [...header.ids, ref.task_id], admissions_at: [...recent, now] });
      guard();
      return { fresh: true, record };
    });
  }
  get(ref: ExecutionTaskRef, grant: ExecutionGrant): Promise<CloudflareExecutionRecord> {
    return this.storage.transaction(tx => this.read(tx, ref, grant));
  }
  async observe(ref: ExecutionTaskRef, grant: ExecutionGrant, observation: {
    handle: string; snapshot: ExecutionSnapshot; result?: ExecutionResult;
  }, now: number, guard: () => void): Promise<CloudflareExecutionRecord> {
    return this.storage.transaction(async tx => {
      tx.beforeCommit?.(guard);
      const record = await this.read(tx, ref, grant);
      if (record.native_handle && record.native_handle !== observation.handle) throw new AgentExecutionError('EXECUTION_BINDING');
      if (!sameExecutionValue(observation.snapshot.task, ref)) throw new AgentExecutionError('EXECUTION_BINDING');
      // Out-of-order observations can race status/cancel. Only an older sequence
      // is ignored; equal-sequence mutations and changed terminal states refuse.
      if (observation.snapshot.sequence < record.snapshot.sequence) return record;
      assertExecutionTransition(record.snapshot, observation.snapshot);
      if (observation.snapshot.state === 'succeeded') {
        if (!observation.result || !sameExecutionValue(observation.result.task, ref) ||
            await executionDigest(observation.result) !== observation.snapshot.result_sha256) throw new AgentExecutionError('EXECUTION_BINDING');
        if (executionBytes(observation.result) > record.task.limits.output_bytes) throw new AgentExecutionError('EXECUTION_LIMIT');
        if (record.snapshot.state !== 'succeeded') {
          record.result = observation.result;
          record.result_expires_at = now + this.resultRetentionMs;
        } // Never replenish expired output or extend retention on a repeated poll.
      } else if (observation.result) throw new AgentExecutionError('EXECUTION_PROTOCOL');
      record.native_handle = observation.handle; record.snapshot = observation.snapshot;
      guard(); await tx.put(prefix + ref.task_id, record);
      guard();
      return record;
    });
  }
  async requestCancel(ref: ExecutionTaskRef, grant: ExecutionGrant, guard: () => void): Promise<CloudflareExecutionRecord> {
    return this.storage.transaction(async tx => {
      tx.beforeCommit?.(guard);
      const record = await this.read(tx, ref, grant);
      if (!record.native_handle) throw new AgentExecutionError('EXECUTION_UNAVAILABLE');
      if (!['succeeded', 'failed', 'cancelled'].includes(record.snapshot.state)) {
        record.cancel_intent = true;
        guard(); await tx.put(prefix + ref.task_id, record);
        guard();
      }
      return record;
    });
  }
  async result(ref: ExecutionTaskRef, grant: ExecutionGrant, now: () => number, guard: () => void): Promise<ExecutionResult> {
    return this.storage.transaction(async tx => {
      tx.beforeCommit?.(guard);
      const record = await this.read(tx, ref, grant);
      if (record.snapshot.state !== 'succeeded' || !record.result) throw new AgentExecutionError('EXECUTION_RESULT_UNAVAILABLE');
      // Read the live clock after transaction queuing and asynchronous validation.
      if (record.result_expires_at! <= now()) {
        delete record.result; // Keep task, immutable snapshot/digest and ID tombstone.
        guard(); await tx.put(prefix + ref.task_id, record);
        guard();
        return undefined;
      }
      guard();
      return record.result;
    }).then(value => { if (!value) throw new AgentExecutionError('EXECUTION_RESULT_UNAVAILABLE'); return value; });
  }
}
