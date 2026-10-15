import { z } from 'zod';
import { digest } from '../model.js';
import { AgentConnections, agentConnectionActionSchema, type AgentOwnerAuthority } from './agent-connection.js';
import { agentFailure, agentKey, agentMessages } from './agent-connection-store.js';

// Trusted local selector hints. These do not grant approval, supply an endpoint,
// load authentication or provision persistence. The manager reauthorizes actions.
const profilesSchema = z.array(agentKey).max(16).refine(ids => new Set(ids).size === ids.length);
export class OwnerAgentSettings {
  private readonly profiles: readonly string[];
  constructor(private readonly manager?: AgentConnections, profiles: readonly string[] = []) {
    this.profiles = Object.freeze(profilesSchema.parse(profiles));
  }
  changed() { this.manager?.changed(); }
  private async projection(authority: AgentOwnerAuthority) {
    const owner = await authority.current();
    const ownerScope = digest({ installation_id: owner.installation_id, owner_id: owner.owner_id });
    const scope = this.manager ? digest(this.manager.store.scope) : null;
    return { profiles: this.manager ? this.profiles.map(target_profile_id => ({ target_profile_id })) : [], owner_confirmation_required: !owner.fresh, reconciliation_scope: { owner: ownerScope, state: scope, authentication_generation: owner.authentication_generation } };
  }
  async status(authority: AgentOwnerAuthority) {
    const projection = await this.projection(authority);
    if (!this.manager) return {
      format: 'strata-studio-owner-agents/1' as const, revision: null,
      management: { state: 'unconfigured' as const, code: 'AGENT_TARGET_UNCONFIGURED' as const },
      connection: null, capabilities: { configure: false, test: false, connect: false, retry: false, disconnect: false, revoke: false, remove: false },
      integration: { state: 'unconfigured', consent: null, enabled: false, approved_at: null, revoked_at: null },
      health: { state: 'unavailable', code: 'AGENT_TARGET_UNCONFIGURED', verified_until: null },
      service_session: { state: 'unconfigured', renewal: 'unsupported' },
      engine_authority: { state: 'unconfigured' as const, operations: [] }, effective: { authoring: false, execution: false, chat: false }, operations: [], ...projection,
    };
    const current = this.manager.projectionGuard();
    const status = await this.manager.status(authority);
    // Recheck identity after asynchronous projection; no old owner's pending
    // namespace may be installed alongside a newer authenticated status.
    const latest = await this.projection(authority);
    if (latest.reconciliation_scope.owner !== projection.reconciliation_scope.owner ||
      latest.reconciliation_scope.authentication_generation !== projection.reconciliation_scope.authentication_generation) agentFailure('OWNER_SESSION_REQUIRED', 401);
    // This check is synchronous and lifecycle-owned; another async snapshot
    // would create the same gap. Keep historical evidence, never stale readiness.
    const invalidated = current(), code = status.management.code ?? invalidated;
    return { ...status,
      ...(invalidated ? { management: { ...status.management, code }, health: { state: status.integration.state === 'revoked' ? 'revoked' : 'disconnected', code, verified_until: null }, service_session: { state: 'unverified', renewal: 'unsupported' }, connection: status.connection ? { ...status.connection, state: status.connection.state === 'interrupted' ? 'interrupted' : status.integration.state === 'revoked' ? 'revoked' : 'blocked', runtime_ready: false, current_discovery: null, error: { code: code!, message: agentMessages[code!] } } : null } : {}),
      capabilities: { ...status.capabilities, configure: !invalidated && !latest.owner_confirmation_required && status.capabilities.configure && this.profiles.length > 0, test: !invalidated && status.capabilities.test, connect: !invalidated && status.capabilities.connect, retry: !invalidated && status.capabilities.retry, revoke: !latest.owner_confirmation_required && status.capabilities.revoke, remove: !latest.owner_confirmation_required && status.capabilities.remove }, ...latest };
  }
  async action(authority: AgentOwnerAuthority, input: unknown, signal?: AbortSignal) {
    await authority.current();
    if (!this.manager) return agentFailure('AGENT_TARGET_UNCONFIGURED');
    const parsed = agentConnectionActionSchema.safeParse(input);
    if (!parsed.success) return agentFailure('INVALID_INPUT', 400);
    if (parsed.data.action === 'configure' && !this.profiles.includes(parsed.data.target_profile_id)) return agentFailure('AGENT_APPROVAL_REQUIRED');
    const result = await this.manager.action(authority, parsed.data, signal);
    return { ...await this.status(authority), replayed: result.replayed, outcome: result.outcome };
  }
  async outcome(authority: AgentOwnerAuthority, id: string) {
    await authority.current();
    if (!this.manager) return agentFailure('AGENT_TARGET_UNCONFIGURED');
    return this.manager.outcome(authority, id);
  }
}
