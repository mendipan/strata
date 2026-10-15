import { z } from 'zod';
import {
  AgentExecutionError, executionDeclarationSchema, executionTaskSchema, executionTaskRef,
  executionSnapshotSchema, executionResultSchema, executionDigest, sameExecutionValue,
  type ExecutionTask, type ExecutionTaskRef, type ExecutionGrant, type ExecutionOperation,
} from '../agent-execution.js';
import {
  cloudflareExecutionDeclaration, cloudflareExecutionTargetSchema, checkExecutionGrant, canonicalTaskId,
  executionBasePath, executionBytes, executionParse, executionWait, executionFailure, readExecutionJson,
  type CloudflareExecutionTarget,
} from './cloudflare-execution-protocol.js';
import { CloudflareExecutionJournal } from './cloudflare-execution-journal.js';

export const cloudflareNativeObservationSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_.:/-]{1,256}$/),
  snapshot: executionSnapshotSchema, result: executionResultSchema.optional(),
}).strict();
export interface CloudflareExecutionRuntime {
  // Exact application runtime pin. A real runtime must independently enforce
  // deadline_at/output limits and support original-ID lookup plus idempotent
  // cooperative cancellation. A model endpoint does not implement this port.
  readonly identity: { name: string; version: string };
  start(task: ExecutionTask, ref: ExecutionTaskRef, deadline_at: number, signal: AbortSignal): Promise<Response>;
  lookup(ref: ExecutionTaskRef, handle: string | undefined, signal: AbortSignal): Promise<Response | undefined>;
  cancel(ref: ExecutionTaskRef, handle: string, signal: AbortSignal): Promise<Response>;
}
export type CloudflareExecutionPermission = { grant: ExecutionGrant; invalidated: AbortSignal };
export type CloudflareExecutionAuthorizer = (request: Request, operation: ExecutionOperation,
  taskId: string | undefined, signal: AbortSignal) => Promise<CloudflareExecutionPermission | undefined>;
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
function errorResponse(error: unknown): Response {
  const code = executionFailure(error).code;
  const status = code === 'EXECUTION_AUTH' || code === 'EXECUTION_EXPIRED' || code === 'EXECUTION_STALE' ? 403 :
    code === 'EXECUTION_NOT_FOUND' || code === 'EXECUTION_RESULT_UNAVAILABLE' ? 404 :
    code === 'EXECUTION_CONFLICT' ? 409 : code === 'EXECUTION_LIMIT' ? 413 :
    code === 'EXECUTION_UNCONFIGURED' || code === 'EXECUTION_UNAVAILABLE' || code === 'EXECUTION_TIMEOUT' ? 503 : 400;
  return new Response(JSON.stringify({ error: { code } }), { status, headers });
}

/** Separate positive routes for an existing protected service. No Worker export,
 * discovery route, Agent creation, credentials, consent store or default fetch.
 */
export function createCloudflareExecutionService(options?: {
  target: CloudflareExecutionTarget; journal: CloudflareExecutionJournal;
  authorize: CloudflareExecutionAuthorizer; runtime: CloudflareExecutionRuntime;
  declaration?: ReturnType<typeof executionDeclarationSchema.parse>; now?: () => number;
}) {
  const target = options && executionParse(cloudflareExecutionTargetSchema, options.target, 'EXECUTION_INVALID');
  const declaration = executionParse(executionDeclarationSchema, options?.declaration ?? cloudflareExecutionDeclaration, 'EXECUTION_INVALID');
  const now = options?.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    try {
      if (!options || !target) throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
      if (await executionDigest(declaration) !== target.declaration_sha256 || options.journal.connectionId !== target.connection_id)
        throw new AgentExecutionError('EXECUTION_BINDING');
      if (options.runtime.identity.name !== declaration.runtime.name || options.runtime.identity.version !== declaration.runtime.version)
        throw new AgentExecutionError('EXECUTION_VERSION');
      const url = new URL(request.url), base = new URL(target.base_url), path = url.pathname.slice(executionBasePath(target).length);
      if (url.origin !== base.origin || !url.pathname.startsWith(executionBasePath(target) + '/tasks') || url.search || url.hash || url.username || url.password)
        throw new AgentExecutionError('EXECUTION_INVALID');
      const route = /^\/tasks\/([^/]+)(?:\/(result|cancel))?$/.exec(path);
      const operation: ExecutionOperation = path === '/tasks' && request.method === 'POST' ? 'submit' :
        route && request.method === 'GET' && route[2] !== 'cancel' ? (route[2] === 'result' ? 'result' : 'status') :
        route && request.method === 'POST' && route[2] === 'cancel' ? 'cancel' : (() => { throw new AgentExecutionError('EXECUTION_INVALID'); })();
      const taskId = route?.[1];
      if (taskId && !canonicalTaskId.test(taskId)) throw new AgentExecutionError('EXECUTION_INVALID');
      if (operation !== 'submit' && request.body !== null) throw new AgentExecutionError('EXECUTION_INVALID');
      if (operation === 'cancel' && declaration.capabilities.cancel === 'unsupported') throw new AgentExecutionError('EXECUTION_UNSUPPORTED');
      const callSignal = AbortSignal.any([request.signal, AbortSignal.timeout(declaration.limits.call_timeout_ms)]);
      return await executionWait(async () => {
        // Authorizer is protected host configuration, never request JSON. It must
        // check current admission/session and synchronously abort on invalidation.
        const first = await executionWait(() => options.authorize(request, operation, taskId, callSignal), callSignal);
        if (!first) throw new AgentExecutionError('EXECUTION_AUTH');
        const grant = checkExecutionGrant(first.grant, target, declaration, now()), ref = grant.task;
        if (taskId && taskId !== ref.task_id) throw new AgentExecutionError('EXECUTION_BINDING');
        const signal = AbortSignal.any([callSignal, first.invalidated,
          AbortSignal.timeout(Math.min(declaration.limits.call_timeout_ms, Math.max(1, Date.parse(grant.valid_until) - now())))]);
        const guard = () => {
          if (signal.aborted) throw new AgentExecutionError(signal.reason?.name === 'TimeoutError' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_ABORTED');
          checkExecutionGrant(grant, target, declaration, now());
        };
        const recheck = async () => {
          guard();
          const current = await executionWait(() => options.authorize(request, operation, taskId, signal), signal);
          if (!current) throw new AgentExecutionError('EXECUTION_AUTH');
          const next = checkExecutionGrant(current.grant, target, declaration, now());
          if (current.invalidated.aborted || !sameExecutionValue(next, grant)) throw new AgentExecutionError('EXECUTION_STALE');
          guard();
        };
        const observe = async (raw: Response, cancelling = false) => {
          if (raw.status !== 200 || raw.redirected) {
            void raw.body?.cancel().catch(() => {});
            throw new AgentExecutionError('EXECUTION_UNAVAILABLE');
          }
          const observation = executionParse(cloudflareNativeObservationSchema,
            await readExecutionJson(raw, 32768 + declaration.limits.output_bytes + 1024, signal));
          if (!sameExecutionValue(observation.snapshot.task, ref)) throw new AgentExecutionError('EXECUTION_BINDING');
          if (executionBytes(observation.snapshot) > 32768 || (observation.result && executionBytes(observation.result) > declaration.limits.output_bytes))
            throw new AgentExecutionError('EXECUTION_LIMIT');
          await recheck();
          if (cancelling && ['queued', 'running'].includes(observation.snapshot.state)) {
            const retained = await options.journal.get(ref, grant);
            if (['succeeded', 'failed', 'cancelled'].includes(retained.snapshot.state)) return retained;
            throw new AgentExecutionError('EXECUTION_PROTOCOL');
          }
          return options.journal.observe(ref, grant, observation, now(), guard);
        };
        let snapshot;
        if (operation === 'submit') {
          const task = executionParse(executionTaskSchema, await readExecutionJson(request, 32768, signal), 'EXECUTION_INVALID');
          if (!sameExecutionValue(await executionTaskRef(task), ref)) throw new AgentExecutionError('EXECUTION_BINDING');
          if (task.limits.runtime_ms > declaration.limits.task_runtime_ms || task.limits.output_bytes > declaration.limits.output_bytes)
            throw new AgentExecutionError('EXECUTION_LIMIT');
          await recheck();
          const admission = await options.journal.reserve(task, grant, now(), guard);
          if (!admission.fresh) {
            if (!admission.record.native_handle) throw new AgentExecutionError('EXECUTION_UNAVAILABLE');
            snapshot = admission.record.snapshot;
          } else {
            await recheck();
            if (admission.record.deadline_at <= now()) throw new AgentExecutionError('EXECUTION_TIMEOUT');
            // Reservation is durable BEFORE this sole start. A crash/timeout at
            // any point retains it. No second start even if lookup returns absent.
            snapshot = (await observe(await executionWait(() => options.runtime.start(structuredClone(task), structuredClone(ref), admission.record.deadline_at, signal), signal))).snapshot;
          }
        } else if (operation === 'result') {
          await recheck();
          const result = await options.journal.result(ref, grant, now, guard);
          await recheck();
          return new Response(JSON.stringify(result), { status: 200, headers });
        } else {
          let record = await options.journal.get(ref, grant);
          if (['succeeded', 'failed', 'cancelled'].includes(record.snapshot.state)) snapshot = record.snapshot;
          else {
            await recheck();
            if (operation === 'cancel') {
              record = await options.journal.requestCancel(ref, grant, guard);
              if (['succeeded', 'failed', 'cancelled'].includes(record.snapshot.state)) snapshot = record.snapshot;
              else {
                const observed = await observe(await executionWait(() => options.runtime.cancel(structuredClone(ref), record.native_handle!, signal), signal), true);
                if (['queued', 'running'].includes(observed.snapshot.state)) throw new AgentExecutionError('EXECUTION_PROTOCOL');
                snapshot = observed.snapshot;
              }
            } else {
              const raw = await executionWait(() => options.runtime.lookup(structuredClone(ref), record.native_handle, signal), signal);
              if (!raw) throw new AgentExecutionError('EXECUTION_UNAVAILABLE');
              snapshot = (await observe(raw)).snapshot;
            }
          }
        }
        await recheck();
        return new Response(JSON.stringify(snapshot), { status: 200, headers });
      }, callSignal);
    } catch (error) { void request.body?.cancel().catch(() => {}); return errorResponse(error); }
  };
}
