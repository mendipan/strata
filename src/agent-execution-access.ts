import { z } from 'zod';
import { agentBindingSchema } from './agent-discovery.js';
import {
  AgentExecutionError, executionGrantSchema, executionTaskSchema, executionTaskRefSchema, sameExecutionValue, executionCanonical,
  type AgentExecutionAccess, type ExecutionGrant, type ExecutionTask, type ExecutionTaskRef, type ExecutionOperation,
} from './agent-execution.js';
import type { ExecutionAdmissionJournal, ExecutionAdmission } from './agent-execution-admission.js';
import { executionParse, executionFailure } from './agent-adapters/cloudflare-execution-protocol.js';

// Trusted constructor-injected host metadata ONLY. No HTTP/browser/provider
// deserializer, discovery-consent migration or credential resolver is provided.
const consentSchema = executionGrantSchema.omit({ format: true, task: true, consent: true, enabled: true,
  selection_generation: true, session_generation: true, credential_generation: true, valid_until: true }).extend({
  kind: z.literal('execution'), owner_id: z.string().min(1).max(256), connection_id: z.string().min(1).max(256),
  binding: agentBindingSchema, repository_revision: executionTaskSchema.shape.repository_revision,
  operations: z.array(z.enum(['submit', 'status', 'result', 'cancel'])).min(1).max(4), limits: executionTaskSchema.shape.limits,
}).strict();
const stateSchema = z.object({
  owner: z.object({ id: consentSchema.shape.owner_id, authenticated: z.boolean() }).strict(),
  consent: consentSchema.optional(), enabled: z.boolean(),
  source: z.object({ binding: agentBindingSchema, repository_revision: executionTaskSchema.shape.repository_revision,
    revision_verified: z.literal(true), selection_generation: executionGrantSchema.shape.selection_generation }).strict(),
  session: z.object({ authenticated: z.boolean(), generation: executionGrantSchema.shape.session_generation,
    valid_until: executionGrantSchema.shape.valid_until }).strict(),
  credential_generation: executionGrantSchema.shape.credential_generation,
}).strict();
export type TrustedExecutionState = z.infer<typeof stateSchema>;
export interface TrustedExecutionMetadata {
  read(): TrustedExecutionState | undefined; // Synchronous local facts, no I/O.
  subscribe(changed: () => void): () => void; // Invalidate synchronously on ANY authority change.
}

export class ExecutionAccess implements AgentExecutionAccess {
  // A client derives its own deadline/session signals. Bind the seal to the
  // exact operation instead of signal object identity so every current() check
  // sees the original facts. Concurrent scopes for this same operation must all
  // remain current; unrelated task/operation scopes do not constrain each other.
  private readonly waits = new Map<string, Set<{ state: TrustedExecutionState | undefined }>>();
  constructor(private readonly metadata: TrustedExecutionMetadata, private readonly journal: ExecutionAdmissionJournal,
    private readonly now: () => number = Date.now) {}
  private waitKey(ref: ExecutionTaskRef, operation: ExecutionOperation) { return executionCanonical({ ref, operation }); }
  openWait(ref: ExecutionTaskRef, operation: ExecutionOperation, input?: AbortSignal) {
    const controller = new AbortController();
    let unsubscribe = () => {};
    try {
      unsubscribe = this.metadata.subscribe(() => controller.abort());
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000), ...(input ? [input] : [])]);
      const key = this.waitKey(ref, operation), seal = { state: structuredClone(this.metadata.read()) };
      const seals = this.waits.get(key) ?? new Set();
      seals.add(seal); this.waits.set(key, seals);
      return { signal, dispose: () => {
        seals.delete(seal); if (!seals.size) this.waits.delete(key); unsubscribe();
      } };
    } catch (error) {
      try { unsubscribe(); } catch { /* Preserve the safe original failure. */ }
      throw executionFailure(error);
    }
  }
  private facts(ref: ExecutionTaskRef, operation: ExecutionOperation, signal: AbortSignal) {
    if (signal.aborted) throw new AgentExecutionError(signal.reason?.name === 'TimeoutError' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_ABORTED');
    const raw = this.metadata.read();
    if (!raw) throw new AgentExecutionError('EXECUTION_AUTH');
    const state = executionParse(stateSchema, raw, 'EXECUTION_INVALID'), consent = state.consent;
    for (const seal of this.waits.get(this.waitKey(ref, operation)) ?? [])
      if (!sameExecutionValue(seal.state, state)) throw new AgentExecutionError('EXECUTION_STALE');
    if (!consent || !state.enabled || !state.owner.authenticated || !state.session.authenticated ||
      state.owner.id !== consent.owner_id || new Set(consent.operations).size !== consent.operations.length ||
      !consent.operations.includes(operation)) throw new AgentExecutionError('EXECUTION_AUTH');
    if (ref.connection_id !== consent.connection_id || !sameExecutionValue(ref.binding, consent.binding) ||
      ref.repository_revision !== consent.repository_revision || !sameExecutionValue(state.source.binding, consent.binding) ||
      state.source.repository_revision !== consent.repository_revision) throw new AgentExecutionError('EXECUTION_BINDING');
    const grant = executionParse(executionGrantSchema, {
      format: 'strata-agent-execution-grant/1', task: ref, declaration_sha256: consent.declaration_sha256,
      service_id: consent.service_id, instance_id: consent.instance_id, subject: consent.subject,
      consent: 'approved', enabled: true, approval_generation: consent.approval_generation,
      selection_generation: state.source.selection_generation, session_generation: state.session.generation,
      credential_generation: state.credential_generation, valid_until: state.session.valid_until,
    });
    if (Date.parse(grant.valid_until) <= this.now()) throw new AgentExecutionError('EXECUTION_EXPIRED');
    return { state, consent, grant };
  }
  admit(ref: ExecutionTaskRef, task: ExecutionTask, signal: AbortSignal): ExecutionAdmission {
    const { consent, grant } = this.facts(ref, 'submit', signal);
    if (task.limits.runtime_ms > consent.limits.runtime_ms || task.limits.output_bytes > consent.limits.output_bytes)
      throw new AgentExecutionError('EXECUTION_LIMIT');
    return { owner_id: consent.owner_id, task: structuredClone(ref), operations: [...consent.operations],
      limits: structuredClone(consent.limits), grant };
  }
  guard(grant: ExecutionGrant, operation: ExecutionOperation, signal: AbortSignal): void {
    const current = this.facts(grant.task, operation, signal).grant;
    if (!sameExecutionValue(grant, current)) throw new AgentExecutionError('EXECUTION_STALE');
  }
  async current(input: ExecutionTaskRef, operation: ExecutionOperation, signal: AbortSignal): Promise<ExecutionGrant | undefined> {
    const ref = executionParse(executionTaskRefSchema, input, 'EXECUTION_INVALID');
    const before = this.facts(ref, operation, signal);
    const retained = await this.journal.read(ref, before.grant);
    if (retained.permission.owner_id !== before.state.owner.id || !retained.permission.operations.includes(operation) ||
      retained.record.task.limits.runtime_ms > before.consent.limits.runtime_ms ||
      retained.record.task.limits.output_bytes > before.consent.limits.output_bytes ||
      !sameExecutionValue(before.state, this.facts(ref, operation, signal).state)) throw new AgentExecutionError('EXECUTION_STALE');
    return structuredClone(before.grant);
  }
}
