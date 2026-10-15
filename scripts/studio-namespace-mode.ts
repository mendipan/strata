import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { digest } from '../src/model.js';
import { hostedConfigSchema } from './studio-host.js';
import { controlSchema } from '../src/explorer/bootstrap-control.js';
import { sourcePolicySchema } from '../src/explorer/connection-policy.js';
import { connectionStateSchema, validateConnectionCatalog } from '../src/explorer/connection-store.js';
import { initialReadBudget, readBudgetSchema } from '../src/explorer/read-budget.js';
import { namespaceConfigSchema, namespacePolicySchema, initialNamespaceFiles } from '../src/explorer/namespace-policy.js';
import { canonicalDisjointPaths } from '../src/explorer/workspace-policy.js';

const inputSchema = z.object({
  host: hostedConfigSchema, control: controlSchema,
  namespace: namespaceConfigSchema, policy: namespacePolicySchema,
  conformance_spending: z.object({ requests: z.number().int().min(0).max(160), bytes: z.number().int().min(0).max(50*1024**2), projects: z.number().int().min(0).max(1) }).strict(),
  predecessor: z.object({ policy: sourcePolicySchema, genesis: connectionStateSchema, state: connectionStateSchema,
    ledgers: z.array(z.object({ grant: z.unknown(), ledger: readBudgetSchema }).strict()).max(64),
    legacy_ledger: readBudgetSchema,
  }).strict(),
}).strict();

// Pure, secret-free preparation for a NEW lineage. Never changes an old policy,
// reconstructs a writer, approves consent, or initializes state on startup.
export function prepareNamespaceMode(input: unknown) {
  const p = inputSchema.parse(input), old = p.predecessor;
  const require = (condition: unknown) => { if (!condition) throw Error('Namespace mode preparation binding differs.'); };
  require(p.host.browser_owner && p.host.source_management && !p.host.namespace && !p.host.workspace &&
    !p.host.connection_config && !p.host.credential_store && !p.host.access_key_hash_file);
  const binding = p.control.owner_binding;
  require(binding && p.control.state === 'closed' && p.control.origin === p.host.public_origin &&
    binding.installation_id === p.policy.installation_id && binding.owner_id === p.policy.owner_id &&
    old.policy.installation_id === p.policy.installation_id && old.policy.owner_id === p.policy.owner_id);
  canonicalDisjointPaths([...Object.values(p.namespace), ...Object.values(p.host.browser_owner!),
    ...Object.values(p.host.source_management!)]);
  require(p.policy.namespace.length >= 2 && p.policy.namespace.length <= 63 && /^[a-z0-9][a-z0-9_-]*$/.test(p.policy.namespace));
  validateConnectionCatalog(old.policy, old.genesis, old.state);
  require(!old.state.operations.some(o => o.result === null));
  require(old.ledgers.length === old.state.grants.length);
  const used = new Set<string>();
  let requests = old.legacy_ledger.reserved_requests + p.conformance_spending.requests;
  let bytes = old.legacy_ledger.reserved_bytes + p.conformance_spending.bytes;
  used.add(old.legacy_ledger.binding_sha256);
  for (const entry of old.ledgers) {
    const ticket = old.policy.tickets.find(t => digest(t) === digest(entry.grant));
    const grant = ticket && old.state.grants.find(g => g.grant_id === ticket.grant_id && g.ticket_id === ticket.ticket_id);
    require(ticket && grant && grant.binding_sha256 === entry.ledger.binding_sha256);
    require(!used.has(entry.ledger.binding_sha256)); used.add(entry.ledger.binding_sha256);
    require(entry.ledger.binding_sha256 === initialReadBudget(ticket!.connection, ticket!.expected_repository_id).binding_sha256 &&
      entry.ledger.reserved_requests <= ticket!.connection.read_authorization.max_requests &&
      entry.ledger.reserved_bytes <= ticket!.connection.read_authorization.max_bytes);
    requests += entry.ledger.reserved_requests; bytes += entry.ledger.reserved_bytes;
  }
  const policy = namespacePolicySchema.parse({ ...p.policy, max_projects: p.policy.max_projects - p.conformance_spending.projects, limits: { ...p.policy.limits,
    requests: p.policy.limits.requests - requests, bytes: p.policy.limits.bytes - bytes } });
  const { source_management: _retained, ...common } = p.host;
  const host = hostedConfigSchema.parse({ ...common, namespace: p.namespace });
  return { format: 'strata-studio-namespace-mode-preparation/1' as const, host, policy,
    ...initialNamespaceFiles(policy), prior_spending: { requests, bytes },
    total_limits: p.policy.limits, policy_sha256: digest(policy) };
}

async function main() {
  if (process.argv.slice(2).join(' ') !== '--validate-stdin') throw Error('Explicit bounded stdin validation required.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 4 * 1024 ** 2) throw Error('Preparation exceeds bound.'); chunks.push(chunk); }
  process.stdout.write(JSON.stringify(prepareNamespaceMode(JSON.parse(Buffer.concat(chunks).toString('utf8')))) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('Namespace mode preparation refused.\n'); process.exitCode = 1;
});
