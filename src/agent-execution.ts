import { z } from 'zod';
import { agentBindingSchema } from './agent-discovery.js';

// Execution is a separate protocol. No discovery declaration or projection changes.
const key = z.string().regex(/^[A-Za-z0-9_.:/-]{1,256}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const EXECUTION_PROTOCOL = 'strata-agent-execution/1' as const;
export const executionDeclarationSchema = z.object({
  format: z.literal('strata-agent-execution-adapter/1'),
  protocol: z.literal(EXECUTION_PROTOCOL),
  id: key, version: key,
  runtime: z.object({ name: key, version: key, kind: z.literal('agent-runtime') }).strict(),
  models: z.array(key).min(1).max(16), // Strata models, not LLM names.
  capabilities: z.object({
    submit: z.literal(true), status: z.literal(true), result: z.literal(true),
    cancel: z.enum(['cooperative', 'unsupported']),
    idempotency: z.literal('durable-task-id'), recovery: z.literal('lookup-task-id'),
  }).strict(),
  limits: z.object({
    call_timeout_ms: z.number().int().min(1).max(10000),
    task_runtime_ms: z.number().int().min(1).max(3600000),
    output_bytes: z.number().int().min(1).max(65536),
  }).strict(),
  authority: z.literal('task-only'),
}).strict();

export const executionTaskSchema = z.object({
  format: z.literal('strata-agent-task/1'),
  connection_id: key, task_id: z.string().uuid(),
  binding: agentBindingSchema,
  repository_revision: revision,
  instruction: z.string().min(1).max(16384),
  limits: z.object({
    runtime_ms: z.number().int().min(1).max(3600000),
    output_bytes: z.number().int().min(1).max(65536),
  }).strict(),
}).strict();
export const executionTaskRefSchema = executionTaskSchema.pick({
  connection_id: true, task_id: true, binding: true, repository_revision: true,
}).extend({ request_sha256: sha256 }).strict();

const snapshotBase = {
  format: z.literal('strata-agent-task-status/1'), task: executionTaskRefSchema,
  sequence: generation,
};
export const executionFailureSchema = z.enum(['TASK_FAILED', 'TASK_DEADLINE', 'TASK_LIMIT', 'TASK_POLICY']);
export const executionSnapshotSchema = z.discriminatedUnion('state', [
  z.object({ ...snapshotBase, state: z.literal('queued') }).strict(),
  z.object({ ...snapshotBase, state: z.literal('running') }).strict(),
  z.object({ ...snapshotBase, state: z.literal('cancel_requested') }).strict(),
  z.object({ ...snapshotBase, state: z.literal('cancelled') }).strict(),
  z.object({ ...snapshotBase, state: z.literal('failed'), failure: executionFailureSchema }).strict(),
  z.object({ ...snapshotBase, state: z.literal('succeeded'), result_sha256: sha256 }).strict(),
]);
export const executionResultSchema = z.object({
  format: z.literal('strata-agent-task-result/1'), task: executionTaskRefSchema,
  summary: z.string().max(16384),
  artifacts: z.array(z.object({
    id: key, sha256, bytes: generation, media_type: z.enum(['text/plain', 'text/x-diff', 'application/json']),
  }).strict()).max(16),
  trust: z.literal('agent-output'),
}).strict();

// Host-produced metadata only. Never deserialize a grant from browser/provider JSON.
// Durable consent is distinct from the finite authenticated dispatch session.
export const executionGrantSchema = z.object({
  format: z.literal('strata-agent-execution-grant/1'),
  task: executionTaskRefSchema,
  declaration_sha256: sha256,
  service_id: key, instance_id: key, subject: key,
  consent: z.literal('approved'), enabled: z.literal(true),
  approval_generation: generation, selection_generation: generation,
  session_generation: generation, credential_generation: generation,
  valid_until: z.string().datetime(),
}).strict();

export type ExecutionDeclaration = z.infer<typeof executionDeclarationSchema>;
export type ExecutionTask = z.infer<typeof executionTaskSchema>;
export type ExecutionTaskRef = z.infer<typeof executionTaskRefSchema>;
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export type ExecutionGrant = z.infer<typeof executionGrantSchema>;
export type ExecutionOperation = 'submit' | 'status' | 'result' | 'cancel';
export type ExecutionContext = { grant: ExecutionGrant; signal: AbortSignal };

export interface AgentExecutionAdapterV1 {
  describe(): ExecutionDeclaration; // Pure, compiled registration; no provider access.
  submit(task: ExecutionTask, context: ExecutionContext): Promise<ExecutionSnapshot>;
  status(task: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot>;
  result(task: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionResult>;
  cancel(task: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot>;
}

export interface AgentExecutionAccess {
  // Local metadata only; check owner, saved execution consent, selected source,
  // task admission/journal, target, session and credential generations each time.
  current(task: ExecutionTaskRef, operation: ExecutionOperation, signal: AbortSignal): Promise<ExecutionGrant | undefined>;
}

export const executionErrorCodeSchema = z.enum([
  'EXECUTION_UNCONFIGURED', 'EXECUTION_INVALID', 'EXECUTION_VERSION', 'EXECUTION_UNSUPPORTED',
  'EXECUTION_AUTH', 'EXECUTION_EXPIRED', 'EXECUTION_STALE', 'EXECUTION_BINDING',
  'EXECUTION_CONFLICT', 'EXECUTION_NOT_FOUND', 'EXECUTION_RESULT_UNAVAILABLE',
  'EXECUTION_PROTOCOL', 'EXECUTION_LIMIT', 'EXECUTION_ABORTED', 'EXECUTION_TIMEOUT',
  'EXECUTION_UNAVAILABLE',
]);
export type ExecutionErrorCode = z.infer<typeof executionErrorCodeSchema>;
export class AgentExecutionError extends Error {
  constructor(readonly code: ExecutionErrorCode, readonly dispatch: 'not_dispatched' | 'unknown' = 'not_dispatched') {
    super('Agent execution could not complete the requested operation.');
    this.name = 'AgentExecutionError';
  }
}

// Stable JSON digest; inputs are always parsed strict DTOs before use.
export function executionCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(executionCanonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + executionCanonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export async function executionDigest(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(executionCanonical(value))))]
    .map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function executionTaskRef(input: ExecutionTask): Promise<ExecutionTaskRef> {
  const task = executionTaskSchema.parse(input);
  return executionTaskRefSchema.parse({ connection_id: task.connection_id, task_id: task.task_id,
    binding: task.binding, repository_revision: task.repository_revision, request_sha256: await executionDigest(task) });
}
export function sameExecutionValue(a: unknown, b: unknown): boolean {
  return executionCanonical(a) === executionCanonical(b);
}

// The host retains the last accepted snapshot. This helper never grants authority.
export function assertExecutionTransition(previous: ExecutionSnapshot, next: ExecutionSnapshot): void {
  const before = executionSnapshotSchema.parse(previous), after = executionSnapshotSchema.parse(next);
  if (!sameExecutionValue(before.task, after.task)) throw new AgentExecutionError('EXECUTION_BINDING');
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(before.state);
  const allowed: Record<ExecutionSnapshot['state'], string[]> = {
    queued: ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled'],
    running: ['running', 'cancel_requested', 'succeeded', 'failed', 'cancelled'],
    cancel_requested: ['cancel_requested', 'succeeded', 'failed', 'cancelled'],
    succeeded: ['succeeded'], failed: ['failed'], cancelled: ['cancelled'],
  };
  if (after.sequence < before.sequence || !allowed[before.state].includes(after.state) ||
      ((terminal || after.sequence === before.sequence) && !sameExecutionValue(before, after))) {
    throw new AgentExecutionError('EXECUTION_PROTOCOL');
  }
}
