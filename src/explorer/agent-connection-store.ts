import path from 'node:path';
import { z } from 'zod';
import { digest } from '../model.js';
import { agentBindingSchema, agentDiscoverySchema } from '../agent-discovery.js';
import { privateDir, readPrivate, withLease, writePrivate } from './owner-files.js';
import { ExplorerError, problem } from './contract.js';

export const agentMessages = {
  INVALID_INPUT: 'Use one bounded agent action, current revision and request ID.',
  OWNER_SESSION_REQUIRED: 'Sign in to Studio again.',
  OWNER_REAUTH_REQUIRED: 'Confirm your password before changing agent configuration.',
  AGENT_SOURCE_UNCONFIGURED: 'Select the exact approved source before configuring discovery.',
  AGENT_TARGET_UNCONFIGURED: 'An operator must configure an approved discovery target.',
  AGENT_APPROVAL_REQUIRED: 'The exact discovery target approval is absent or changed.',
  AGENT_AUTH_UNCONFIGURED: 'Discovery authentication is not configured.',
  AGENT_SESSION_EXPIRED: 'The service credential session expired. Integration consent remains saved; a supported service authentication adapter must renew it.',
  AGENT_REVOKED: 'Agent integration consent was revoked. Confirm a new connection before using this service.',
  AGENT_STATE_UNAVAILABLE: 'Protected agent state needs operator reconciliation.',
  AGENT_CHANGED: 'Agent configuration or its current authority changed.',
  AGENT_BUSY: 'One bounded discovery exchange is already in progress.',
  AGENT_RECOVERY_REQUIRED: 'Inspect the interrupted action before operator reconciliation.',
  AGENT_CAPACITY: 'Agent action history is full; operator archival is required.',
  AGENT_RATE_LIMIT: 'At most five explicit discovery exchanges are allowed per minute.',
  REQUEST_CONFLICT: 'This request ID already identifies a different action.',
  NOT_FOUND: 'No agent action receipt exists for this request.',
  AGENT_TARGET: 'The discovery destination is not the exact approved target.',
  AGENT_DECLARATION: 'The approved discovery declaration does not match.',
  AGENT_AUTH: 'The approved service identity could not be verified.',
  AGENT_BINDING: 'Discovery does not match the approved service and project binding.',
  AGENT_EXPIRED: 'The approved target, authentication or discovery has expired.',
  AGENT_PROTOCOL: 'The service did not return the supported discovery contract.',
  AGENT_RESPONSE_LIMIT: 'Discovery exceeded its bounded response size.',
  AGENT_CANCELLED: 'Local waiting was cancelled; no remote rollback is implied.',
  AGENT_TIMEOUT: 'Discovery did not complete within ten seconds.',
  AGENT_UNAVAILABLE: 'The bounded discovery exchange could not be verified.',
} as const;
export type AgentCode = keyof typeof agentMessages;
export const agentCodeSchema = z.enum(Object.keys(agentMessages) as [AgentCode, ...AgentCode[]]);
export function agentFailure(code: AgentCode, status = 403): never { return problem(code, status, agentMessages[code]); }
export function safeAgentCode(error: unknown): AgentCode {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return typeof code === 'string' && Object.hasOwn(agentMessages, code) ? code as AgentCode : 'AGENT_UNAVAILABLE';
  } catch { return 'AGENT_UNAVAILABLE'; }
}
export const agentGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const agentKey = z.string().regex(/^[A-Za-z0-9_.:/-]{1,256}$/);
const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const agentStateScopeSchema = z.object({ installation_id: id, owner_id: id, state_id: id, binding: agentBindingSchema }).strict();
export type AgentStateScope = z.infer<typeof agentStateScopeSchema>;
export const agentActionNameSchema = z.enum(['configure', 'test', 'connect', 'retry', 'disconnect', 'revoke', 'remove']);
export const agentProofSchema = z.object({
  source_sha256: hash, approval_sha256: hash, authentication_sha256: hash.nullable(), profile_id: agentKey,
}).strict();
export type AgentProof = z.infer<typeof agentProofSchema>;
const resultSchema = z.object({ state: z.enum(['completed', 'failed']), code: agentCodeSchema.nullable(), revision: agentGeneration }).strict();
export const agentStateSchema = z.object({
  format: z.literal('strata-studio-agent-state/1'), scope: agentStateScopeSchema,
  revision: agentGeneration, epoch: agentGeneration,
  connection: z.object({
    connection_id: id, target_profile_id: agentKey, binding: agentBindingSchema,
    // Optional only for backward-compatible reads. Legacy records never acquire
    // durable consent at startup or from historical successful probes.
    authorization: z.object({
      mode: z.literal('until-revoked'), state: z.enum(['approved', 'revoked']),
      approved_at: z.string().datetime(), revoked_at: z.string().datetime().nullable(), enabled: z.boolean(),
      target_sha256: hash,
    }).strict().optional(),
    last_test: z.object({ at: z.string().datetime(), outcome: z.enum(['passed', 'failed']), code: agentCodeSchema.nullable(), discovery: agentDiscoverySchema.nullable() }).strict().nullable(),
  }).strict().nullable(),
  probe_times: z.array(z.number().int().nonnegative()).max(5),
  operations: z.array(z.object({
    request_id: id, payload_sha256: hash, action: agentActionNameSchema, owner_generation: agentGeneration,
    at: z.string().datetime(), boot_id: id, epoch: agentGeneration, connection_id: id.nullable(),
    proof: agentProofSchema.nullable(), result: resultSchema.nullable(),
  // One terminal revoke/remove slot remains available when normal history is
  // full. No old receipt or rate reservation is discarded to make room.
  }).strict()).max(257),
}).strict();
export type AgentState = z.infer<typeof agentStateSchema>;
export type AgentOperation = AgentState['operations'][number];
export function initialAgentState(scope: AgentStateScope): AgentState {
  return agentStateSchema.parse({ format: 'strata-studio-agent-state/1', scope: agentStateScopeSchema.parse(scope), revision: 0, epoch: 0, connection: null, probe_times: [], operations: [] });
}
function checked(value: unknown, scope: AgentStateScope): AgentState {
  const state = agentStateSchema.parse(value);
  if (digest(state.scope) !== digest(scope) || state.epoch > state.revision || new Set(state.operations.map(o => o.request_id)).size !== state.operations.length) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  if (state.connection && digest(state.connection.binding) !== digest(scope.binding)) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  for (const op of state.operations) {
    if (op.epoch > state.epoch || (op.result && op.result.revision > state.revision) ||
      (['configure', 'test', 'connect', 'retry'].includes(op.action) !== !!op.proof) ||
      (!op.result && !['test', 'connect', 'retry'].includes(op.action)) ||
      (op.proof && ((op.action === 'configure') !== (op.proof.authentication_sha256 === null))) ||
      (op.result && ((op.result.state === 'completed') !== (op.result.code === null)))) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  }
  const authorization = state.connection?.authorization;
  if (authorization && ((authorization.state === 'revoked') !== (authorization.revoked_at !== null) ||
    (authorization.state === 'revoked' && authorization.enabled))) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  const last = state.connection?.last_test;
  if (last && ((last.outcome === 'passed') !== (last.code === null && last.discovery !== null) ||
    (last.outcome === 'failed' && (!last.code || last.discovery)) ||
    (last.discovery && digest(last.discovery.binding) !== digest(scope.binding)))) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  return state;
}
export interface AgentStatePort {
  readonly scope: AgentStateScope;
  read(): Promise<AgentState>;
  transaction<T>(operation: (state: AgentState, save: () => Promise<void>) => Promise<T>): Promise<T>;
}
// Preparation is an explicit fixture/operator action. Startup never creates,
// resets or repairs these files, and stale leases are never reclaimed.
export class AgentConnectionStore implements AgentStatePort {
  readonly scope: AgentStateScope;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly directory: string, scope: AgentStateScope) {
    this.scope = agentStateScopeSchema.parse(scope);
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  }
  private async load() {
    await privateDir(this.directory);
    const genesis = checked(await readPrivate(path.join(this.directory, 'genesis.json'), 2 * 1024 * 1024), this.scope);
    if (digest(genesis) !== digest(initialAgentState(this.scope))) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
    return checked(await readPrivate(path.join(this.directory, 'state.json'), 2 * 1024 * 1024), this.scope);
  }
  read() { return this.transaction(async state => structuredClone(state)); }
  async transaction<T>(operation: (state: AgentState, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const previous = this.queue; let release!: () => void;
    this.queue = new Promise<void>(resolve => release = resolve); await previous;
    try {
      return await withLease(this.directory, async () => {
        const state = await this.load();
        return operation(state, async () => {
          const parsed = checked(state, this.scope);
          if (Buffer.byteLength(JSON.stringify(parsed)) > 2 * 1024 * 1024) agentFailure('AGENT_CAPACITY', 409);
          await writePrivate(path.join(this.directory, 'state.json'), parsed);
        });
      });
    } catch (error) {
      if (error instanceof ExplorerError && Object.hasOwn(agentMessages, error.code)) return agentFailure(error.code as AgentCode, error.status >= 400 && error.status <= 599 ? error.status : 503);
      return agentFailure('AGENT_STATE_UNAVAILABLE', 503);
    } finally { release(); }
  }
}
