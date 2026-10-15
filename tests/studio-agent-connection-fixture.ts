import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { declarationDigest, type AgentDiscoveryV1, type VerifiedAgentIdentity } from '../src/agent-discovery.js';
import { cloudflareDiscoveryDeclaration } from '../src/agent-adapters/cloudflare.js';
import { AgentConnectionStore, initialAgentState, type AgentState, type AgentStatePort } from '../src/explorer/agent-connection-store.js';
import { AgentConnections, type AgentOwner, type AgentOwnerAuthority, type AgentSelectedSource, type AgentTargetApproval, type AgentTargetApprovals, type AgentProbeAccess, type AgentAuthenticationMetadata } from '../src/explorer/agent-connection.js';
import { writePrivate } from '../src/explorer/owner-files.js';

export const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; };
export const errorCode = (wanted: string) => (error: any) => error.code === wanted;
export async function agentFixture() {
  let time = Date.now(); const iso = (delta = 0) => new Date(time + delta).toISOString();
  const directory = await mkdtemp(path.join(tmpdir(), 'strata-agent-lifecycle-'));
  await chmod(directory, 0o700); const stateDirectory = path.join(directory, 'agent'); await mkdir(stateDirectory, { mode: 0o700 });
  const scope = { installation_id: randomUUID(), owner_id: randomUUID(), state_id: randomUUID(), binding: { project_id: 'synthetic-project', model_version: 'strata/0.1-facets-experimental', repository_id: 'synthetic-repository' } };
  const initial = initialAgentState(scope); await writePrivate(path.join(stateDirectory, 'genesis.json'), initial, true); await writePrivate(path.join(stateDirectory, 'state.json'), initial, true);
  let owner: AgentOwner = { installation_id: scope.installation_id, owner_id: scope.owner_id, authentication_generation: 1, fresh: true };
  const authority: AgentOwnerAuthority = { async current() { return structuredClone(owner); } };
  let source: Awaited<ReturnType<AgentSelectedSource['current']>> = { selection_id: 'selected-source', epoch: 1, binding: scope.binding, valid_until: iso(3_600_000) };
  const sourcePort: AgentSelectedSource = { async current() { return structuredClone(source); } };
  let approval: AgentTargetApproval | undefined = {
    generation: 'approved-1', target: { profile_id: 'synthetic', url: 'https://agent.example.test/strata-discovery', service_id: 'synthetic-service', instance_id: 'existing-synthetic-instance', expected_subject: 'independently-verified-synthetic-subject', binding: scope.binding, valid_until: iso(3_600_000), declaration_sha256: await declarationDigest(cloudflareDiscoveryDeclaration) },
  };
  const targets: AgentTargetApprovals = { async current(profile) { return profile === approval?.target.profile_id ? structuredClone(approval) : undefined; } };
  let metadata: AgentAuthenticationMetadata | undefined = { generation: 'synthetic-auth-1', valid_until: iso(3_600_000) };
  let contextLoads = 0, headers = 0, verifications = 0, dispatches = 0;
  let delay: Promise<void> | undefined, contextDelay: Promise<void> | undefined, headerDelay: Promise<void> | undefined;
  let fail: unknown, response: ((manifest: AgentDiscoveryV1) => Response) | undefined, identity: VerifiedAgentIdentity | undefined;
  const started = deferred();
  const access: AgentProbeAccess = {
    async current() { return structuredClone(metadata); },
    async context(a, m) {
      contextLoads++; if (contextDelay) await contextDelay;
      return { authentication: {
        async headers() { headers++; if (headerDelay) await headerDelay; return new Headers({ 'x-synthetic-proof': 'public-fixture-only' }); },
        async verify() { verifications++; return identity ?? { subject: a.target.expected_subject, expires_at: m.valid_until }; },
      }, transport: async (input, init) => {
        dispatches++; started.resolve(); assert.equal(String(input), a.target.url); assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assert.equal(init?.redirect, 'manual'); assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
        if (delay) await delay; if (fail) throw fail;
        const manifest: AgentDiscoveryV1 = { format: 'strata-agent-discovery/1', service_id: a.target.service_id, instance_id: a.target.instance_id, authenticated_subject: a.target.expected_subject, binding: a.target.binding, declaration_sha256: a.target.declaration_sha256, discovered_at: iso(), valid_until: iso(60_000), advertised_features: ['inference', 'engine:approve', 'task:create', 'tools'] };
        return response ? response(manifest) : Response.json(manifest);
      } };
    },
  };
  const store = new AgentConnectionStore(stateDirectory, scope);
  const make = (port: AgentStatePort = store) => new AgentConnections(port, { source: sourcePort, targets, access, now: () => time });
  const manager = make();
  const state = async () => JSON.parse(await readFile(path.join(stateDirectory, 'state.json'), 'utf8')) as AgentState;
  const input = async (action: string, extra = {}) => ({ action, revision: (await state()).revision, request_id: randomUUID(), ...(action === 'configure' ? { target_profile_id: 'synthetic' } : {}), ...extra });
  return {
    directory, stateDirectory, scope, store, manager, make, authority, sourcePort, targets, access, iso, state, input, started,
    action: async (action: string, extra = {}) => manager.action(authority, await input(action, extra)),
    counts: () => ({ contextLoads, headers, verifications, dispatches }),
    advance: (ms: number) => { time += ms; },
    owner: () => structuredClone(owner), setOwner: (change: Partial<AgentOwner>) => { owner = { ...owner, ...change }; },
    source: () => structuredClone(source), setSource: (value: typeof source) => { source = value; },
    approval: () => structuredClone(approval), setApproval: (value: typeof approval) => { approval = value; },
    metadata: () => structuredClone(metadata), setMetadata: (value: typeof metadata) => { metadata = value; },
    delay: (value: typeof delay) => { delay = value; }, contextDelay: (value: typeof contextDelay) => { contextDelay = value; }, headerDelay: (value: typeof headerDelay) => { headerDelay = value; },
    fail: (value: unknown) => { fail = value; }, response: (value: typeof response) => { response = value; }, identity: (value: typeof identity) => { identity = value; },
  };
}
