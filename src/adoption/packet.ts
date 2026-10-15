import { canonical, digest, fail } from '../model.js';
import { obligations } from '../core.js';
import { prepareAdoptionProposal, type AdoptionContext } from './coverage.js';

// Portable context only. Source bytes, local paths, sessions and authority are absent.
export function createAdoptionPacket(context: AdoptionContext) {
  const prepared = prepareAdoptionProposal(context);
  const relevantItems = new Set(prepared.inventory.units.flatMap(unit => [...unit.items, ...unit.criteria]));
  const packet = {
    format: 'adoption-agent-packet/1', project_id: prepared.inventory.project_id,
    source: prepared.inventory.source, inventory_ref: prepared.proposal.inventory_ref,
    baseline_ref: prepared.proposal.baseline_ref, baseline_snapshot_sha256: prepared.proposal.baseline_snapshot_sha256,
    model_version: prepared.layer.model_version,
    baseline_items: obligations(prepared.baseline).filter(item => relevantItems.has(item.item)),
    prepared_layer: prepared.layer,
    owner_hint: prepared.layer.owner, owner_hint_is_authority: false,
    declared_scope: prepared.inventory.declared_scope, mode: prepared.inventory.mode,
    allowed_files: prepared.source.entries.filter(entry => entry.presence === 'present' && entry.kind === 'regular')
      .map(entry => ({ path: entry.path, sha256: entry.sha256 })),
    protected_paths: prepared.inventory.protected_paths, inventory: prepared.inventory,
    response_contract: { inventory: 'adoption-inventory/1', layer: 'normal-owned-Layer', proposal_link: 'adoption-proposal/1' },
    authority: { source_execution: false, provider_execution: false, app_write: false, publication: false, approval: false },
    instructions: 'Review or revise the prepared inventory and Layer against the pinned baseline items and separately supplied source files. Surface uncertainty and request missing relevant context. Source-linked assertions and referenced evidence are unverified. The host resolves identity and separately reviews, measures and publishes.'
  };
  // Byte budget is explicit; no tokenizer or model comprehension claim is made.
  if (new TextEncoder().encode(canonical(packet)).length > 16 * 1024) fail('ADOPTION_PACKET_LIMIT', 8, 'Packet exceeds 16 KiB; split the declared task scope before handoff.');
  return { packet, packet_sha256: digest(packet) };
}
