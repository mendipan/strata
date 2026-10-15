import { canonical, fail, type Records } from './model.js';
import type { Engine } from './core.js';
import type { ContextMap } from './recovery.js';

export type RegistryEntry = { type: string; hash: string; published: boolean };
export type Registry = { entries: Record<string, RegistryEntry>; heads: Engine['ownerHeads']; contexts?: ContextMap };
export type LayerContext = { entries: Record<string, RegistryEntry>; head: Engine['ownerHeads'][string] | null };
export type PreparedLayer = { id: string; principal: string; expected_head: LayerContext['head']; refs: LayerContext['entries']; ref: string; entry: RegistryEntry; record: Records[string]; head: LayerContext['head'] };

// Pure CAS reducer used inside the project's synchronous SQLite transaction.
// It merges a delta into the CURRENT registry, never replaces it with an old actor snapshot.
export function publishPrepared(registry: Registry, prepared: PreparedLayer): Registry {
  if (prepared.record.type !== 'layer' || prepared.entry.type !== 'layer' || prepared.record.data.id !== prepared.id || prepared.record.data.owner !== prepared.principal || prepared.ref !== `${prepared.id}@${prepared.record.data.revision}`) fail('OWNER_FORBIDDEN', 4, 'Prepared Layer identity does not match its owner.');
  const head = registry.heads[prepared.id] ?? null;
  if (head && head.owner !== prepared.principal) fail('OWNER_FORBIDDEN', 4, 'This Layer belongs to another principal.');
  if (canonical(head) !== canonical(prepared.expected_head)) fail('STALE_REVISION', 5, 'The owned head changed while this Layer was being prepared.');
  for (const [ref, expected] of Object.entries(prepared.refs)) {
    if (canonical(registry.entries[ref] ?? null) !== canonical(expected)) fail('STALE_REVISION', 5, 'A preparation reference changed before publication.', { ref });
  }
  const existing = registry.entries[prepared.ref];
  if (existing && (existing.hash !== prepared.entry.hash || existing.type !== prepared.entry.type)) fail('IMMUTABLE_REFERENCE', 5, 'An immutable reference already has different content.');
  return {
    ...registry,
    entries: { ...registry.entries, [prepared.ref]: { ...prepared.entry, published: prepared.entry.published || !!existing?.published } },
    heads: prepared.head ? { ...registry.heads, [prepared.id]: prepared.head } : { ...registry.heads }
  };
}
