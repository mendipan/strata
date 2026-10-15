import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../model.js';
import {
  agentBindingSchema, approvedAgentTargetSchema, declarationDigest, discoveryProjection, AgentDiscoveryError,
  type AgentAuthentication, type AgentDiscoveryV1, type ApprovedAgentTarget,
} from '../agent-discovery.js';
import { CloudflareDiscoveryAdapter } from '../agent-adapters/cloudflare.js';
import {
  agentFailure, agentGeneration, agentKey, agentMessages, safeAgentCode,
  type AgentCode, type AgentOperation, type AgentProof, type AgentState, type AgentStatePort,
} from './agent-connection-store.js';

const ownerSchema = z.object({ installation_id: z.string().uuid(), owner_id: z.string().uuid(), authentication_generation: agentGeneration, fresh: z.boolean() }).strict();
export type AgentOwner = z.infer<typeof ownerSchema>;
export interface AgentOwnerAuthority { current(fresh?: boolean): Promise<AgentOwner> }
export const unconfiguredAgentOwner: AgentOwnerAuthority = { async current() { return agentFailure('OWNER_SESSION_REQUIRED', 401); } };
export const selectedAgentSourceSchema = z.object({ selection_id: agentKey, epoch: agentGeneration, binding: agentBindingSchema, valid_until: z.string().datetime().nullable() }).strict();
export type SelectedAgentSource = z.infer<typeof selectedAgentSourceSchema>;
export interface AgentSelectedSource { current(): Promise<SelectedAgentSource | undefined> }
// Null is an explicit trusted until-revoked target policy. It never extends an
// old finite approval, authentication session or discovery manifest.
const targetPolicySchema = z.object({ ...approvedAgentTargetSchema.shape, valid_until: z.string().datetime().nullable() }).strict()
  .refine(target => approvedAgentTargetSchema.safeParse({ ...target, valid_until: target.valid_until ?? '1970-01-01T00:00:00.000Z' }).success);
export const agentTargetApprovalSchema = z.object({ generation: agentKey, target: targetPolicySchema }).strict();
export type AgentTargetApproval = z.infer<typeof agentTargetApprovalSchema>;
export interface AgentTargetApprovals {
  current(profileId: string, owner: AgentOwner, source: SelectedAgentSource): Promise<AgentTargetApproval | undefined>;
}
export const agentAuthenticationMetadataSchema = z.object({ generation: agentKey, valid_until: z.string().datetime() }).strict();
export type AgentAuthenticationMetadata = z.infer<typeof agentAuthenticationMetadataSchema>;
export interface AgentProbeAccess {
  // Metadata reads must be local, secret-free and have no provider dispatch.
  current(approval: AgentTargetApproval): Promise<AgentAuthenticationMetadata | undefined>;
  // Called only after durable explicit test/connect admission. No ambient fallback.
  context(approval: AgentTargetApproval, metadata: AgentAuthenticationMetadata): Promise<{ authentication: AgentAuthentication; transport: typeof fetch }>;
}
export const unconfiguredAgentSource: AgentSelectedSource = { async current() { return undefined; } };
export const unconfiguredAgentTargets: AgentTargetApprovals = { async current() { return undefined; } };
export const unconfiguredAgentProbeAccess: AgentProbeAccess = {
  async current() { return undefined; }, async context() { return agentFailure('AGENT_AUTH_UNCONFIGURED'); },
};
const common = { revision: agentGeneration, request_id: z.string().uuid() };
export const agentConnectionActionSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('configure'), target_profile_id: agentKey }).strict(),
  ...(['test', 'connect', 'retry', 'disconnect', 'revoke', 'remove'] as const).map(action => z.object({ ...common, action: z.literal(action) }).strict()),
]);
export type AgentConnectionAction = z.infer<typeof agentConnectionActionSchema>;
type Resolution = { source: SelectedAgentSource; approval: AgentTargetApproval; authentication?: AgentAuthenticationMetadata; target: ApprovedAgentTarget; proof: AgentProof };
type Runtime = { operation: AgentOperation; revision: number; localEpoch: number; discovery: AgentDiscoveryV1 };
const needsFresh = (action?: string) => action === 'configure' || action === 'remove' || action === 'revoke';
const probes = (action: string) => action === 'test' || action === 'connect' || action === 'retry';
const expiry = (until: string | null) => until === null ? Infinity : Date.parse(until);
const targetIdentity = (approval: AgentTargetApproval) => {
  const { valid_until: _lease, ...target } = approval.target;
  return digest(target);
};
const receipt = (op: AgentOperation, bootId: string) => ({
  request_id: op.request_id, action: op.action, state: op.result?.state ?? (op.boot_id === bootId ? 'pending' : 'interrupted'),
  code: op.result?.code ?? null, revision: op.result?.revision ?? null,
});
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return agentFailure('AGENT_CANCELLED', 409); }
  let abort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Aborted bounded local wait.')); signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

// Discovery only. No host routes, credentials, engine principal, inference or
// executable provider registry is created by this core. All injected ports are
// trusted server adapters; advertised remote metadata cannot supply them.
export class AgentConnections {
  readonly bootId = randomUUID();
  private readonly adapter = new CloudflareDiscoveryAdapter();
  private readonly source: AgentSelectedSource;
  private readonly targets: AgentTargetApprovals;
  private readonly access: AgentProbeAccess;
  private readonly configured: boolean;
  private readonly targetsConfigured: boolean;
  private readonly now: () => number;
  private runtime?: Runtime;
  private localEpoch = 0;
  private inflight = new Map<string, AbortController>();
  constructor(readonly store: AgentStatePort, options: {
    source?: AgentSelectedSource; targets?: AgentTargetApprovals; access?: AgentProbeAccess; now?: () => number;
  } = {}) {
    this.source = options.source ?? unconfiguredAgentSource;
    this.targets = options.targets ?? unconfiguredAgentTargets;
    this.access = options.access ?? unconfiguredAgentProbeAccess;
    this.configured = !!options.source && !!options.targets && !!options.access;
    this.targetsConfigured = !!options.targets;
    this.now = options.now ?? Date.now;
  }
  changed() {
    this.localEpoch++; this.runtime = undefined;
    for (const controller of this.inflight.values()) controller.abort();
  }
  // Trusted projection bridges may await additional local metadata after status.
  // Capture before status and invoke synchronously after their final await. No
  // owner/source approval is supplied by this guard; it only invalidates a view.
  projectionGuard() {
    const epoch = this.localEpoch, runtime = this.runtime;
    return (): 'AGENT_CHANGED' | 'AGENT_EXPIRED' | null =>
      epoch !== this.localEpoch || runtime !== this.runtime ? 'AGENT_CHANGED' :
      runtime && Date.parse(runtime.discovery.valid_until) <= this.now() ? 'AGENT_EXPIRED' : null;
  }
  private async owner(authority: AgentOwnerAuthority, action?: string, previous?: AgentOwner) {
    let owner: AgentOwner;
    try { owner = ownerSchema.parse(await authority.current(needsFresh(action))); }
    catch { this.changed(); return agentFailure('OWNER_SESSION_REQUIRED', 401); }
    if (owner.installation_id !== this.store.scope.installation_id || owner.owner_id !== this.store.scope.owner_id ||
      (previous && owner.authentication_generation !== previous.authentication_generation)) {
      this.changed(); return agentFailure('OWNER_SESSION_REQUIRED', 401);
    }
    if (needsFresh(action) && !owner.fresh) return agentFailure('OWNER_REAUTH_REQUIRED');
    return owner;
  }
  private async selected() {
    let source: SelectedAgentSource;
    try { source = selectedAgentSourceSchema.parse(await this.source.current()); }
    catch { return agentFailure('AGENT_SOURCE_UNCONFIGURED'); }
    if (digest(source.binding) !== digest(this.store.scope.binding)) return agentFailure('AGENT_BINDING');
    if (expiry(source.valid_until) <= this.now()) return agentFailure('AGENT_EXPIRED');
    return source;
  }
  private async resolve(owner: AgentOwner, profileId: string, probe: boolean): Promise<Resolution> {
    const source = await this.selected(); let approval: AgentTargetApproval;
    try { approval = agentTargetApprovalSchema.parse(await this.targets.current(profileId, owner, source)); }
    catch { return agentFailure(this.targets === unconfiguredAgentTargets ? 'AGENT_TARGET_UNCONFIGURED' : 'AGENT_APPROVAL_REQUIRED'); }
    const target = approval.target;
    if (target.profile_id !== profileId || digest(target.binding) !== digest(source.binding)) return agentFailure('AGENT_BINDING');
    if (expiry(target.valid_until) <= this.now()) return agentFailure('AGENT_EXPIRED');
    if (target.declaration_sha256 !== await declarationDigest(this.adapter.describe())) return agentFailure('AGENT_DECLARATION');
    let authentication: AgentAuthenticationMetadata | undefined;
    if (probe) {
      try { authentication = agentAuthenticationMetadataSchema.parse(await this.access.current(approval)); }
      catch { return agentFailure('AGENT_AUTH_UNCONFIGURED'); }
      if (Date.parse(authentication.valid_until) <= this.now()) return agentFailure('AGENT_SESSION_EXPIRED');
    }
    // The wire adapter still receives a short bounded probe lease. This is not
    // a provider session renewal or a new integration approval.
    const wireTarget = { ...target, valid_until: target.valid_until ?? new Date(Math.min(this.now() + 300_000, expiry(source.valid_until), authentication ? Date.parse(authentication.valid_until) : Infinity)).toISOString() };
    return { source, approval, authentication, target: wireTarget, proof: {
      source_sha256: digest(source), approval_sha256: digest(approval), authentication_sha256: authentication ? digest(authentication) : null, profile_id: profileId,
    } };
  }
  private async authorizedProof(authority: AgentOwnerAuthority, owner: AgentOwner, op: AgentOperation) {
    await this.owner(authority, op.action, owner);
    if (op.owner_generation !== owner.authentication_generation) return agentFailure('OWNER_SESSION_REQUIRED', 401);
    if (!op.proof) return undefined;
    const resolved = await this.resolve(owner, op.proof.profile_id, probes(op.action));
    if (digest(resolved.proof) !== digest(op.proof)) return agentFailure('AGENT_CHANGED', 409);
    await this.owner(authority, op.action, owner); return resolved;
  }
  private usable(state: AgentState, op: AgentOperation) {
    if (state.connection?.authorization?.state === 'revoked') agentFailure('AGENT_REVOKED');
    if (!state.connection || state.connection.connection_id !== op.connection_id || state.epoch !== op.epoch || state.connection.target_profile_id !== op.proof?.profile_id) agentFailure('AGENT_CHANGED', 409);
  }
  private async guard(authority: AgentOwnerAuthority, owner: AgentOwner, op: AgentOperation, epoch: number, signal: AbortSignal) {
    if (signal.aborted || epoch !== this.localEpoch) return agentFailure('AGENT_CHANGED', 409);
    const resolved = await this.authorizedProof(authority, owner, op);
    this.usable(await this.store.read(), op);
    if (signal.aborted || epoch !== this.localEpoch) return agentFailure('AGENT_CHANGED', 409);
    return resolved!;
  }
  async outcome(authority: AgentOwnerAuthority, requestId: string) {
    if (!z.string().uuid().safeParse(requestId).success) return agentFailure('INVALID_INPUT', 400);
    const owner = await this.owner(authority), state = await this.store.read();
    const op = state.operations.find(o => o.request_id === requestId); if (!op) return agentFailure('NOT_FOUND', 404);
    await this.owner(authority, undefined, owner); return receipt(op, this.bootId);
  }
  async status(authority: AgentOwnerAuthority) {
    const owner = await this.owner(authority); let state = await this.store.read(), code: AgentCode | null = null, sourceReady = false;
    const runtime = this.runtime;
    try {
      await this.selected(); sourceReady = true;
      if (state.connection) {
        if (state.connection.authorization?.state === 'revoked') agentFailure('AGENT_REVOKED');
        if (runtime) {
          this.usable(state, runtime.operation);
          await this.authorizedProof(authority, owner, runtime.operation);
          if (runtime.revision !== state.revision || runtime.localEpoch !== this.localEpoch || Date.parse(runtime.discovery.valid_until) <= this.now()) agentFailure('AGENT_CHANGED', 409);
        } else {
          const resolved = await this.resolve(owner, state.connection.target_profile_id, true);
          if (!state.connection.authorization && (resolved.source.valid_until === null || resolved.approval.target.valid_until === null)) agentFailure('AGENT_APPROVAL_REQUIRED');
          if (state.connection.authorization && state.connection.authorization.target_sha256 !== targetIdentity(resolved.approval)) agentFailure('AGENT_APPROVAL_REQUIRED');
        }
      } else if (!this.targetsConfigured) code = 'AGENT_TARGET_UNCONFIGURED';
      else if (!this.configured) code = 'AGENT_AUTH_UNCONFIGURED';
    } catch (error) {
      code = safeAgentCode(error);
      // A stable blocked/revoked projection is metadata, not a new lifecycle
      // invalidation. Otherwise every refresh would disable fresh Configure.
      if (this.runtime || this.inflight.size) this.changed();
    }
    // A later owner/source/credential invalidation cannot reuse a projection
    // assembled before the final asynchronous checks.
    await this.store.transaction(async latest => {
      if (latest.revision !== state.revision) { this.changed(); state = latest; code = 'AGENT_CHANGED'; }
      await this.owner(authority, undefined, owner);
      if (runtime && this.runtime === runtime) {
        try { await this.authorizedProof(authority, owner, runtime.operation); this.usable(latest, runtime.operation); }
        catch (error) { code = safeAgentCode(error); this.changed(); }
      }
    });
    if (runtime && this.runtime === runtime && Date.parse(runtime.discovery.valid_until) <= this.now()) { code = 'AGENT_EXPIRED'; this.changed(); }
    if (state.connection?.authorization?.state === 'revoked') code = 'AGENT_REVOKED';
    const ready = !code && !!runtime && this.runtime === runtime && runtime.localEpoch === this.localEpoch;
    const interrupted = state.operations.some(o => !o.result && o.boot_id !== this.bootId);
    const busy = state.operations.some(o => !o.result);
    const authorization = state.connection?.authorization;
    const healthCode = code ?? (!ready && state.connection?.last_test?.outcome === 'failed' ? state.connection.last_test.code : null);
    const health = interrupted ? 'interrupted' : ready ? 'connected' : healthCode === 'AGENT_REVOKED' ? 'revoked' : healthCode === 'AGENT_UNAVAILABLE' || healthCode === 'AGENT_TIMEOUT' || healthCode === 'AGENT_AUTH_UNCONFIGURED' || healthCode === 'AGENT_TARGET_UNCONFIGURED' || healthCode === 'AGENT_SOURCE_UNCONFIGURED' || healthCode === 'AGENT_SESSION_EXPIRED' ? 'unavailable' : healthCode ? 'error' : 'disconnected';
    return {
      format: 'strata-studio-owner-agents/1' as const, revision: state.revision,
      management: { state: this.configured ? 'injected' as const : 'unconfigured' as const, code },
      integration: { state: authorization?.state ?? (state.connection ? 'legacy' : 'unconfigured'), consent: authorization?.mode ?? null,
        enabled: authorization?.enabled ?? false, approved_at: authorization?.approved_at ?? null, revoked_at: authorization?.revoked_at ?? null },
      health: { state: health, code: healthCode, verified_until: ready ? runtime!.discovery.valid_until : null },
      service_session: { state: code === 'AGENT_SESSION_EXPIRED' ? 'expired' : code === 'AGENT_AUTH_UNCONFIGURED' ? 'unconfigured' : ready ? 'active' : 'unverified', renewal: 'unsupported' as const },
      connection: state.connection ? {
        connection_id: state.connection.connection_id, target_profile_id: state.connection.target_profile_id,
        binding: structuredClone(state.connection.binding), state: interrupted ? 'interrupted' : authorization?.state === 'revoked' ? 'revoked' : ready ? 'connected-discovery' : code ? 'blocked' : 'disconnected',
        runtime_ready: ready, last_test: structuredClone(state.connection.last_test),
        current_discovery: ready ? structuredClone(runtime!.discovery) : null,
        error: healthCode ? { code: healthCode, message: agentMessages[healthCode] } : null,
      } : null,
      capabilities: { configure: this.targetsConfigured && sourceReady && owner.fresh && !busy, test: !!state.connection && !code && !busy, connect: !!state.connection && !code && !busy, retry: !!state.connection && authorization?.state === 'approved' && !code && !busy, disconnect: !!state.connection && authorization?.state !== 'revoked', revoke: !!state.connection && authorization?.state !== 'revoked' && owner.fresh, remove: !!state.connection && owner.fresh },
      engine_authority: { state: 'unconfigured' as const, operations: [] }, effective: { authoring: false, execution: false, chat: false },
      operations: state.operations.filter(o => !o.result).map(o => receipt(o, this.bootId)),
    };
  }
  async action(authority: AgentOwnerAuthority, input: unknown, inputSignal?: AbortSignal) {
    const parsed = agentConnectionActionSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 1024) return agentFailure('INVALID_INPUT', 400);
    const action = parsed.data, owner = await this.owner(authority, action.action), payload = digest(action);
    let operation!: AgentOperation, replayed = false, operationEpoch = 0;
    await this.store.transaction(async (state, save) => {
      await this.owner(authority, action.action, owner);
      const old = state.operations.find(o => o.request_id === action.request_id);
      if (old) {
        if (old.payload_sha256 !== payload) return agentFailure('REQUEST_CONFLICT', 409);
        if (state.connection?.authorization?.state === 'revoked' && probes(old.action)) return agentFailure('AGENT_REVOKED');
        await this.authorizedProof(authority, owner, old);
        if (!old.result) return agentFailure('AGENT_RECOVERY_REQUIRED', 503);
        operation = structuredClone(old); replayed = true; return;
      }
      if (state.revision !== action.revision) return agentFailure('AGENT_CHANGED', 409);
      if ((state.operations.length >= 256 && !['revoke', 'remove'].includes(action.action)) || state.operations.length >= 257 || state.revision >= Number.MAX_SAFE_INTEGER - 3 || state.epoch >= Number.MAX_SAFE_INTEGER - 3) return agentFailure('AGENT_CAPACITY', 409);
      if (state.operations.some(o => !o.result && o.boot_id !== this.bootId) && !['disconnect', 'revoke', 'remove'].includes(action.action)) return agentFailure('AGENT_RECOVERY_REQUIRED', 503);
      if (probes(action.action) && (state.operations.some(o => !o.result) || this.inflight.size)) return agentFailure('AGENT_BUSY', 409);
      if (action.action !== 'configure' && !state.connection) return agentFailure('INVALID_INPUT', 400);
      if (action.action === 'configure' && state.operations.some(o => !o.result)) return agentFailure('AGENT_BUSY', 409);
      if (probes(action.action) && state.connection?.authorization?.state === 'revoked') return agentFailure('AGENT_REVOKED');
      if (action.action === 'retry' && !state.connection?.authorization) return agentFailure('AGENT_APPROVAL_REQUIRED');
      const profile = action.action === 'configure' ? action.target_profile_id : state.connection?.target_profile_id;
      const resolved = ['configure', 'test', 'connect', 'retry'].includes(action.action) ? await this.resolve(owner, profile!, probes(action.action)) : undefined;
      if (resolved && probes(action.action) && !state.connection?.authorization && (resolved.source.valid_until === null || resolved.approval.target.valid_until === null)) return agentFailure('AGENT_APPROVAL_REQUIRED');
      if (resolved && probes(action.action) && state.connection?.authorization && state.connection.authorization.target_sha256 !== targetIdentity(resolved.approval)) return agentFailure('AGENT_APPROVAL_REQUIRED');
      if (probes(action.action)) {
        // Durable rate reservation is never refunded and survives restart/remove.
        state.probe_times = state.probe_times.filter(time => this.now() - time < 60_000);
        if (state.probe_times.length >= 5) return agentFailure('AGENT_RATE_LIMIT', 429);
        state.probe_times.push(this.now());
      }
      this.changed(); operationEpoch = this.localEpoch; state.epoch++; state.revision++;
      if (action.action === 'configure') state.connection = { connection_id: state.connection?.connection_id ?? randomUUID(), target_profile_id: action.target_profile_id, binding: structuredClone(resolved!.source.binding), last_test: null,
        authorization: { mode: 'until-revoked', state: 'approved', approved_at: new Date(this.now()).toISOString(), revoked_at: null, enabled: false, target_sha256: targetIdentity(resolved!.approval) } };
      if (state.connection?.authorization) {
        if (action.action === 'connect' || action.action === 'retry') state.connection.authorization.enabled = true;
        if (action.action === 'disconnect') state.connection.authorization.enabled = false;
        if (action.action === 'revoke') state.connection.authorization = { ...state.connection.authorization, state: 'revoked', enabled: false, revoked_at: new Date(this.now()).toISOString() };
      }
      if (action.action === 'revoke' && state.connection && !state.connection.authorization) {
        state.connection.authorization = { mode: 'until-revoked', state: 'revoked', approved_at: new Date(this.now()).toISOString(), revoked_at: new Date(this.now()).toISOString(), enabled: false, target_sha256: digest({ legacy_revocation: state.connection.connection_id }) };
      }
      if (action.action === 'remove') state.connection = null;
      operation = {
        request_id: action.request_id, payload_sha256: payload, action: action.action, owner_generation: owner.authentication_generation,
        at: new Date(this.now()).toISOString(), boot_id: this.bootId, epoch: state.epoch, connection_id: state.connection?.connection_id ?? null,
        proof: resolved?.proof ?? null, result: probes(action.action) ? null : { state: 'completed', code: null, revision: state.revision },
      };
      state.operations.push(operation); await this.owner(authority, action.action, owner); await save();
    });
    if (!replayed && probes(action.action)) await this.probe(authority, owner, operation, operationEpoch, inputSignal);
    const outcome = await this.outcome(authority, action.request_id);
    return { ...await this.status(authority), replayed, outcome };
  }
  private async probe(authority: AgentOwnerAuthority, owner: AgentOwner, operation: AgentOperation, epoch: number, inputSignal?: AbortSignal) {
    const controller = new AbortController(), deadline = AbortSignal.timeout(10_000);
    const signal = AbortSignal.any([controller.signal, deadline, ...(inputSignal ? [inputSignal] : [])]);
    this.inflight.set(operation.request_id, controller);
    if (epoch !== this.localEpoch) controller.abort();
    let discovery: AgentDiscoveryV1 | undefined, code: AgentCode | null = null;
    try {
      const resolved = await abortable(this.guard(authority, owner, operation, epoch, signal), signal);
      const context = await abortable(this.access.context(resolved.approval, resolved.authentication!), signal);
      // The existing adapter accepts only its sanitized discovery errors. Keep
      // our current-authority refusal code across that boundary, never its text.
      const guard = () => abortable(this.guard(authority, owner, operation, epoch, signal), signal)
        .catch(error => { throw new AgentDiscoveryError(safeAgentCode(error)); });
      let dispatched = false;
      discovery = await abortable(this.adapter.probe({
        target: resolved.target, now: this.now,
        authentication: {
          headers: async (target, s) => { await guard(); const headers = await abortable(context.authentication.headers(target, s), signal); await guard(); return headers; },
          verify: async (response, target, s) => { await guard(); const identity = await abortable(context.authentication.verify(response, target, s), signal); await guard(); return identity; },
        },
        transport: async (input, init) => {
          await guard();
          if (dispatched || input !== resolved.approval.target.url || init?.method !== 'GET' || init.body != null || init.redirect !== 'manual') return agentFailure('AGENT_TARGET');
          dispatched = true; return abortable(context.transport(input, init), signal);
        },
      }, signal), signal);
      await abortable(this.guard(authority, owner, operation, epoch, signal), signal);
      if (Date.parse(discovery.valid_until) > Math.min(expiry(resolved.source.valid_until), Date.parse(resolved.authentication!.valid_until))) return agentFailure('AGENT_EXPIRED');
    } catch (error) {
      code = inputSignal?.aborted ? 'AGENT_CANCELLED' : deadline.aborted ? 'AGENT_TIMEOUT' : controller.signal.aborted ? 'AGENT_CHANGED' : safeAgentCode(error);
      discovery = undefined;
    }
    try {
      await this.store.transaction(async (state, save) => {
        await this.owner(authority, operation.action, owner);
        const current = state.operations.find(o => o.request_id === operation.request_id);
        if (!current || current.result) return agentFailure('AGENT_RECOVERY_REQUIRED', 503);
        try {
          this.usable(state, operation); await this.authorizedProof(authority, owner, operation);
          if (signal.aborted || epoch !== this.localEpoch) agentFailure('AGENT_CHANGED', 409);
        } catch (error) { code ??= safeAgentCode(error); discovery = undefined; }
        if (state.connection?.connection_id === operation.connection_id && state.epoch === operation.epoch) state.connection.last_test = {
          at: new Date(this.now()).toISOString(), outcome: discovery ? 'passed' : 'failed', code, discovery: discovery ?? null,
        };
        state.revision++; current.result = { state: discovery ? 'completed' : 'failed', code, revision: state.revision };
        await this.owner(authority, operation.action, owner); await save();
      });
      // Remain registered through durable finalization so changed()/disconnect
      // cannot be missed while fsync/rename waits. Never install before save.
      if (discovery && ['connect', 'retry'].includes(operation.action) && !signal.aborted && epoch === this.localEpoch) {
        await this.guard(authority, owner, operation, epoch, signal);
        const latest = await this.store.read(); this.usable(latest, operation);
        await this.authorizedProof(authority, owner, operation);
        if (!signal.aborted && epoch === this.localEpoch && Date.parse(discovery.valid_until) > this.now()) this.runtime = { operation, revision: latest.revision, localEpoch: epoch, discovery: discoveryProjection(discovery).discovery };
      }
    } finally { this.inflight.delete(operation.request_id); }
  }
}
