import { z } from 'zod';
import { agentBindingSchema } from '../agent-discovery.js';
import {
  AgentExecutionError, executionDeclarationSchema, executionGrantSchema, executionErrorCodeSchema,
  sameExecutionValue, type ExecutionGrant, type ExecutionDeclaration,
} from '../agent-execution.js';

// New application protocol. This declares the fixture runtime actually tested,
// not an Agents SDK native execution endpoint or a qualified live runtime.
export const cloudflareExecutionDeclaration = executionDeclarationSchema.parse({
  format: 'strata-agent-execution-adapter/1', protocol: 'strata-agent-execution/1',
  id: 'cloudflare-execution-reference', version: '1',
  runtime: { name: 'synthetic-cloudflare-task-service', version: '1', kind: 'agent-runtime' },
  models: ['strata/0.3-block-lifecycle-experimental'],
  capabilities: { submit: true, status: true, result: true, cancel: 'cooperative',
    idempotency: 'durable-task-id', recovery: 'lookup-task-id' },
  limits: { call_timeout_ms: 10000, task_runtime_ms: 60000, output_bytes: 32768 }, authority: 'task-only',
});
const key = z.string().regex(/^[A-Za-z0-9_.:/-]{1,256}$/);
export const cloudflareExecutionTargetSchema = z.object({
  base_url: z.string().url().refine(value => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash &&
      u.href === value && (u.pathname === '/' || !u.pathname.endsWith('/')) &&
      !u.pathname.includes('%') && !u.pathname.includes('//');
  }),
  connection_id: key, service_id: key, instance_id: key, subject: key,
  binding: agentBindingSchema, declaration_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CloudflareExecutionTarget = z.infer<typeof cloudflareExecutionTargetSchema>;
export const cloudflareExecutionErrorSchema = z.object({ error: z.object({
  code: executionErrorCodeSchema,
}).strict() }).strict();
export const canonicalTaskId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function executionBasePath(target: CloudflareExecutionTarget): string {
  const path = new URL(target.base_url).pathname;
  return path === '/' ? '' : path;
}
export function executionBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
export function executionParse<T>(schema: z.ZodType<T>, value: unknown, code: 'EXECUTION_INVALID' | 'EXECUTION_PROTOCOL' = 'EXECUTION_PROTOCOL'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentExecutionError(code);
  return parsed.data;
}
export function executionFailure(error: unknown, dispatched = false): AgentExecutionError {
  const code = error instanceof AgentExecutionError && executionErrorCodeSchema.safeParse(error.code).success
    ? error.code : 'EXECUTION_UNAVAILABLE';
  return new AgentExecutionError(code, dispatched ? 'unknown' : 'not_dispatched');
}
export async function executionWait<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = () => new AgentExecutionError(signal.reason?.name === 'TimeoutError' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_ABORTED');
  if (signal.aborted) throw aborted();
  let listener!: () => void;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { if (signal.aborted) throw aborted(); return work(); }),
      new Promise<never>((_, reject) => { listener = () => reject(aborted()); signal.addEventListener('abort', listener, { once: true }); }),
    ]);
  } finally { signal.removeEventListener('abort', listener); }
}
// Bounds untrusted raw UTF-8 before JSON/schema parsing, including chunked and
// lying content-length bodies. Also closes the reader on malformed/aborted data.
export async function readExecutionJson(message: Request | Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (message.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !message.body) {
    void message.body?.cancel().catch(() => {});
    throw new AgentExecutionError('EXECUTION_PROTOCOL');
  }
  const reader = message.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await executionWait(() => reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new AgentExecutionError('EXECUTION_LIMIT');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new AgentExecutionError('EXECUTION_PROTOCOL'); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function checkExecutionGrant(raw: unknown, target: CloudflareExecutionTarget, declaration: ExecutionDeclaration, now: number): ExecutionGrant {
  const grant = executionParse(executionGrantSchema, raw);
  if (grant.declaration_sha256 !== target.declaration_sha256 || grant.service_id !== target.service_id ||
      grant.instance_id !== target.instance_id || grant.subject !== target.subject ||
      grant.task.connection_id !== target.connection_id || !sameExecutionValue(grant.task.binding, target.binding))
    throw new AgentExecutionError('EXECUTION_BINDING');
  if (!declaration.models.includes(grant.task.binding.model_version)) throw new AgentExecutionError('EXECUTION_VERSION');
  if (!canonicalTaskId.test(grant.task.task_id)) throw new AgentExecutionError('EXECUTION_INVALID');
  if (Date.parse(grant.valid_until) <= now) throw new AgentExecutionError('EXECUTION_EXPIRED');
  return grant;
}
