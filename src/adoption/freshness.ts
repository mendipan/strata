import { digest } from '../model.js';
import { validateSourceSnapshot } from '../source-binding.js';
import { validateAdoptionInventory } from './contract.js';

// Compares supplied immutable captures only. Equality is never a host proof or a live freshness check.
export function compareAdoptionSourceSnapshot(inventoryInput: unknown, expectedInput: unknown, candidateInput: unknown) {
  const { source: expected } = validateAdoptionInventory(inventoryInput, expectedInput);
  const candidate = validateSourceSnapshot(candidateInput);
  const fields = ['project_id', 'repo_id', 'object_format', 'head_commit', 'head_tree', 'scope_sha256', 'manifest_sha256'] as const;
  const changed = fields.filter(field => expected[field] !== candidate[field]);
  return {
    format: 'adoption-capture-comparison/1', expected_sha256: digest(expected), candidate_sha256: digest(candidate),
    captured_source_matches: digest(expected) === digest(candidate), changed_fields: changed,
    source_fresh: false, freshness: 'not_checked', host_authority_verified: false
  } as const;
}
