import path from 'node:path';
import { AgentConnectionStore, agentStateScopeSchema, agentFailure, type AgentStateScope } from './agent-connection-store.js';
import { AgentConnections, type AgentSelectedSource, type AgentTargetApprovals, type AgentProbeAccess } from './agent-connection.js';
import { OwnerAgentSettings } from './agent-settings.js';
import type { BootstrapState } from './bootstrap-state.js';

const nested = (a: string, b: string) => {
  const relative = path.relative(a, b);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
export type PersistentAgentHostOptions = {
  directory: string; scope: AgentStateScope; ownerState: BootstrapState;
  source: AgentSelectedSource; targets?: AgentTargetApprovals; access?: AgentProbeAccess;
  profileIds?: readonly string[]; protectedPaths: readonly string[]; now?: () => number;
};

// Trusted composition seam for the existing adapter. No browser endpoint,
// dynamic module, credential scheme or service is inferred. Namespace and
// finite-source hosts may both supply a metadata-only selection port.
export async function createPersistentAgentHost(options: PersistentAgentHostOptions) {
  const scope = agentStateScopeSchema.parse(options.scope);
  const paths = [...Object.values(options.ownerState.config), ...options.protectedPaths];
  if (!path.isAbsolute(options.directory) || path.resolve(options.directory) !== options.directory ||
    paths.some(p => !path.isAbsolute(p) || path.resolve(p) !== p || nested(options.directory, p) || nested(p, options.directory))) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  const owner = await options.ownerState.owner(false);
  if (!owner || owner.owner_id !== scope.owner_id || owner.manifest.installation_id !== scope.installation_id) agentFailure('AGENT_STATE_UNAVAILABLE', 503);
  const store = new AgentConnectionStore(options.directory, scope);
  // Existing immutable genesis is required. Missing or corrupt state never
  // recreates a revoked connection, and a stale lease is never reclaimed.
  await store.read();
  const manager = new AgentConnections(store, { source: options.source, targets: options.targets, access: options.access, now: options.now });
  const settings = new OwnerAgentSettings(manager, options.profileIds);
  return { settings, changed: () => settings.changed(), dispose: () => settings.changed() };
}
