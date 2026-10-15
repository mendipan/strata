import {
  AgentExecutionError, executionDeclarationSchema, executionTaskSchema, executionTaskRefSchema,
  executionSnapshotSchema, executionResultSchema, executionTaskRef, executionDigest, sameExecutionValue,
  type AgentExecutionAdapterV1, type ExecutionContext, type ExecutionTask, type ExecutionTaskRef,
  type ExecutionSnapshot, type ExecutionResult, type ExecutionOperation, type ExecutionGrant,
} from '../agent-execution.js';
import {
  cloudflareExecutionDeclaration, cloudflareExecutionTargetSchema, cloudflareExecutionErrorSchema,
  checkExecutionGrant, executionParse, executionBytes, executionWait, executionFailure,
  readExecutionJson, executionBasePath, type CloudflareExecutionTarget,
} from './cloudflare-execution-protocol.js';

export interface CloudflareExecutionAuthentication {
  // Trusted host implementations resolve a separately approved credential slot
  // here. Neither task data nor provider JSON can provide verified identity.
  headers(target: CloudflareExecutionTarget, grant: ExecutionGrant, operation: ExecutionOperation, signal: AbortSignal): Promise<HeadersInit>;
  verify(response: Response, target: CloudflareExecutionTarget, grant: ExecutionGrant, signal: AbortSignal): Promise<{
    subject: string; service_id: string; instance_id: string; expires_at: string;
  }>;
}
export class CloudflareExecutionAdapter implements AgentExecutionAdapterV1 {
  private readonly declaration;
  private readonly target;
  constructor(private readonly options?: {
    target: CloudflareExecutionTarget; authentication: CloudflareExecutionAuthentication;
    transport: (url: string, init: RequestInit) => Promise<Response>;
    declaration?: ReturnType<typeof executionDeclarationSchema.parse>; now?: () => number;
  }) {
    this.declaration = executionParse(executionDeclarationSchema, options?.declaration ?? cloudflareExecutionDeclaration, 'EXECUTION_INVALID');
    this.target = options && executionParse(cloudflareExecutionTargetSchema, options.target, 'EXECUTION_INVALID');
  }
  describe() { return structuredClone(this.declaration); }
  private async call(operation: ExecutionOperation, ref: ExecutionTaskRef, context: ExecutionContext, task?: ExecutionTask): Promise<ExecutionSnapshot | ExecutionResult> {
    let dispatched = false; let response: Response | undefined;
    try {
      if (!this.options || !this.target) throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
      const { authentication, transport } = this.options, target = structuredClone(this.target), now = this.options.now ?? Date.now;
      const grant = checkExecutionGrant(context.grant, target, this.declaration, now());
      if (!sameExecutionValue(grant.task, ref) || await executionDigest(this.declaration) !== target.declaration_sha256)
        throw new AgentExecutionError('EXECUTION_BINDING');
      if (operation === 'cancel' && this.declaration.capabilities.cancel === 'unsupported') throw new AgentExecutionError('EXECUTION_UNSUPPORTED');
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(this.declaration.limits.call_timeout_ms, Math.max(1, Date.parse(grant.valid_until) - now())))]);
      return await executionWait(async () => {
        const headers = new Headers(await executionWait(() => authentication.headers(structuredClone(target), structuredClone(grant), operation, signal), signal));
        for (const header of ['host', 'cookie', 'origin', 'referer', 'forwarded', 'connection', 'content-length', 'transfer-encoding'])
          if (headers.has(header)) throw new AgentExecutionError('EXECUTION_AUTH');
        for (const [header] of headers) if (header.startsWith('x-forwarded-')) throw new AgentExecutionError('EXECUTION_AUTH');
        headers.set('accept', 'application/json');
        if (task) headers.set('content-type', 'application/json');
        const suffix = operation === 'submit' ? '/tasks' : '/tasks/' + ref.task_id + (operation === 'status' ? '' : '/' + operation);
        const url = new URL(target.base_url); url.pathname = executionBasePath(target) + suffix;
        checkExecutionGrant(grant, target, this.declaration, now());
        response = await executionWait(() => {
          dispatched = true;
          return transport(url.href, { method: operation === 'submit' || operation === 'cancel' ? 'POST' : 'GET',
            headers, ...(task ? { body: JSON.stringify(task) } : {}), redirect: 'manual', cache: 'no-store', signal });
        }, signal);
        checkExecutionGrant(grant, target, this.declaration, now());
        if (response.redirected || (response.url && response.url !== url.href)) throw new AgentExecutionError('EXECUTION_PROTOCOL');
        const identity = await executionWait(() => authentication.verify(response!, structuredClone(target), structuredClone(grant), signal), signal);
        if (identity.subject !== target.subject || identity.service_id !== target.service_id || identity.instance_id !== target.instance_id ||
            !Number.isFinite(Date.parse(identity.expires_at)) || Date.parse(identity.expires_at) <= now()) throw new AgentExecutionError('EXECUTION_AUTH');
        const body = await readExecutionJson(response, operation === 'result' && response.status === 200 ? this.declaration.limits.output_bytes : 32768, signal);
        if (response.status !== 200) {
          if (response.status < 400 || response.status > 599) throw new AgentExecutionError('EXECUTION_PROTOCOL');
          throw new AgentExecutionError(executionParse(cloudflareExecutionErrorSchema, body).error.code);
        }
        const result = operation === 'result' ? executionParse(executionResultSchema, body) : executionParse(executionSnapshotSchema, body);
        if (!sameExecutionValue(result.task, ref)) throw new AgentExecutionError('EXECUTION_BINDING');
        if (operation === 'cancel' && 'state' in result && ['queued', 'running'].includes(result.state)) throw new AgentExecutionError('EXECUTION_PROTOCOL');
        checkExecutionGrant(grant, target, this.declaration, now());
        if (Date.parse(identity.expires_at) <= now()) throw new AgentExecutionError('EXECUTION_EXPIRED');
        return result;
      }, signal);
    } catch (error) { void response?.body?.cancel().catch(() => {}); throw executionFailure(error, dispatched); }
  }
  async submit(input: ExecutionTask, context: ExecutionContext): Promise<ExecutionSnapshot> {
    const task = executionParse(executionTaskSchema, input, 'EXECUTION_INVALID');
    if (executionBytes(task) > 32768 || task.limits.runtime_ms > this.declaration.limits.task_runtime_ms || task.limits.output_bytes > this.declaration.limits.output_bytes)
      throw new AgentExecutionError('EXECUTION_LIMIT');
    return this.call('submit', await executionTaskRef(task), context, task) as Promise<ExecutionSnapshot>;
  }
  status(input: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return this.call('status', executionParse(executionTaskRefSchema, input, 'EXECUTION_INVALID'), context) as Promise<ExecutionSnapshot>;
  }
  cancel(input: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return this.call('cancel', executionParse(executionTaskRefSchema, input, 'EXECUTION_INVALID'), context) as Promise<ExecutionSnapshot>;
  }
  result(input: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionResult> {
    return this.call('result', executionParse(executionTaskRefSchema, input, 'EXECUTION_INVALID'), context) as Promise<ExecutionResult>;
  }
}
