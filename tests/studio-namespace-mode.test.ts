import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareNamespaceMode } from '../scripts/studio-namespace-mode.js';
import { managerFixture } from './studio-manager-fixture.js';
import { armControl } from '../src/explorer/bootstrap-control.js';
import { DEFAULT_WORKSPACE_LIMITS } from '../src/explorer/workspace-policy.js';
import { digest } from '../src/model.js';
import { initialReadBudget } from '../src/explorer/read-budget.js';

async function fixture() {
  const f = await managerFixture();
  const ticket = f.policy.tickets[0];
  const ledger = initialReadBudget(ticket.connection, ticket.expected_repository_id); ledger.reserved_requests = 12; ledger.reserved_bytes = 393020;
  const state = await f.state();
  state.grants.push({ grant_id: ticket.grant_id, ticket_id: ticket.ticket_id, binding_sha256: ledger.binding_sha256, phase: 'active' });
  const installation_id = f.policy.installation_id, owner_id = f.policy.owner_id;
  const control = { ...armControl('https://studio.example.test', installation_id), state: 'closed',
    owner_binding: { installation_id, owner_id, initialization_id: randomUUID(), key_id: randomUUID(), initial_manifest_sha256: digest('synthetic-manifest') } };
  return { f, input: {
    host: { format: 'strata-studio-host/1', public_origin: control.origin, trusted_proxy_addresses: ['127.0.0.1'], port: 4174,
      browser_owner: { control_file: path.join(f.directory, 'owner-control.json'), state_directory: path.join(f.directory, 'owner'),
        key_directory: path.join(f.directory, 'keys'), credential_directory: path.join(f.directory, 'credentials') },
      source_management: { policy_file: path.join(f.directory, 'source-policy.json'), catalog_directory: f.storeDir, accounting_directory: f.accounting } },
    control,
    conformance_spending: { requests: 0, bytes: 0, projects: 0 },
    namespace: { policy_file: path.join(f.directory, 'namespace-policy.json'), catalog_directory: path.join(f.directory, 'namespace-catalog'), projects_directory: path.join(f.directory, 'namespace-projects') },
    policy: { format: 'strata-studio-namespace-policy/1', installation_id, owner_id, lineage_id: randomUUID(), account: 'a'.repeat(32), namespace: 'synthetic',
      lifetime: { mode: 'until-revoked', expires_at: null }, permissions: ['discover', 'create', 'read', 'draft'],
      principal_id: 'namespace-author', account_id: 'namespace-owner', provider_contract: 'development-name-addressed',
      operator_rule: 'no-delete-recreate-or-rebind-during-write-or-reconciliation', automatic_creation_token: 'discard-secret-and-allow-provider-expiry',
      automatic_token_max_lifetime_seconds: 86400, limits: DEFAULT_WORKSPACE_LIMITS, max_projects: 8 },
    predecessor: { policy: f.policy, genesis: JSON.parse(await readFile(path.join(f.storeDir, 'genesis.json'), 'utf8')),
      state, ledgers: [{ grant: ticket, ledger }],
      legacy_ledger: { format: 'strata-studio-read-budget/1', binding_sha256: digest('separate legacy zero ledger'), reserved_requests: 0, reserved_bytes: 0 } },
  } };
}

test('new namespace deducts retained spending once, preserves host owner/ingress, and starts unapproved', async () => {
  const { f, input } = await fixture(), before = structuredClone(input);
  const result = prepareNamespaceMode(input);
  assert.deepEqual(input, before); assert.deepEqual(result.prior_spending, { requests: 12, bytes: 393020 });
  assert.equal(result.policy.limits.requests, 9988); assert.equal(result.policy.limits.bytes, 1024**3 - 393020);
  assert.deepEqual(result.total_limits, DEFAULT_WORKSPACE_LIMITS);
  assert.equal(result.state.approved, false); assert.equal(result.state.connected, false); assert.equal(result.state.projects.length, 0);
  assert.equal(result.usage.reserved_requests, 0); assert.equal(result.usage.reserved_bytes, 0);
  assert.deepEqual(result.host.browser_owner, input.host.browser_owner); assert.equal(result.host.source_management, undefined);
  assert.deepEqual(result.host.namespace, input.namespace); assert.deepEqual(result.policy.lifetime, { mode: 'until-revoked', expires_at: null });
  assert.equal(f.calls(), 0); assert.equal((await f.state()).grants.length, 0);
});

test('preparation rejects scope, accounting, uncertain predecessor, and overlapping-storage substitutions', async () => {
  const { input } = await fixture();
  const mutations: ((p: any) => void)[] = [
    p => p.policy.owner_id = randomUUID(), p => p.policy.installation_id = randomUUID(),
    p => p.control.state = 'armed', p => p.host.namespace = p.namespace,
    p => p.namespace.catalog_directory = p.host.browser_owner.credential_directory,
    p => p.namespace.projects_directory = path.join(p.host.source_management.catalog_directory, 'child'),
    p => p.predecessor.genesis.revision++, p => p.predecessor.state.policy_sha256 = digest('changed'),
    p => p.predecessor.state.grants[0].phase = 'prepared',
    p => p.predecessor.state.operations.push({ request_id: randomUUID(), payload_sha256: digest('pending'), action: 'test', owner_generation: 1,
      at: new Date().toISOString(), boot_id: randomUUID(), epoch: 1, connection_id: null, result: null }),
    p => p.predecessor.ledgers = [], p => p.predecessor.ledgers.push(p.predecessor.ledgers[0]),
    p => p.predecessor.ledgers[0].ledger.binding_sha256 = digest('changed'),
    p => p.predecessor.ledgers[0].grant.connection.read_authorization.max_requests++,
    p => p.predecessor.legacy_ledger = p.predecessor.ledgers[0].ledger,
    p => p.policy.limits.requests = 12, p => p.policy.limits.bytes = 393020,
  ];
  for (const mutate of mutations) { const p = structuredClone(input); mutate(p); assert.throws(() => prepareNamespaceMode(p)); }
});

test('all retained ledger spending contributes, failed reservations are never refunded', async () => {
  const { input } = await fixture(); input.predecessor.legacy_ledger.reserved_requests = 2; input.predecessor.legacy_ledger.reserved_bytes = 8192;
  input.conformance_spending = { requests: 20, bytes: 100000, projects: 1 };
  assert.deepEqual(prepareNamespaceMode(input).prior_spending, { requests: 34, bytes: 501212 });
  assert.equal(prepareNamespaceMode(input).policy.max_projects, 7);
});
