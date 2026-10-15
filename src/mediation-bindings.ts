import { canonical, digest, fail, type Composition } from './model.js';

/** Structural portion of the versioned mediation predicate. Callers parse the
 * exact retained shapes first; no current clock, issuer or live grant is used. */
export function assertSelectionApprovalBinding(request: any, principal: string, basis: any, packet: any, receipt: any): void {
  if (!request.binding) fail('ENDORSEMENT_REQUIRED', 6, 'Selection approval requires a server response/use receipt.');
  const binding = request.binding, option = packet.options.find((o: any) => o.id === binding.option_id);
  if (!option || !option.executable || packet.basis_ref !== binding.basis_ref || packet.basis_sha256 !== digest(basis) || binding.case_revision !== basis.case_revision || request.baseline !== basis.baseline || request.scope !== basis.scope || request.target !== option.target || binding.partition_sha256 !== option.partition_sha256 || request.expires_at !== basis.expires_at || receipt.packet_ref !== binding.packet_ref || receipt.basis_ref !== binding.basis_ref || receipt.case_revision !== basis.case_revision || receipt.option_id !== option.id || receipt.target !== request.target || receipt.partition_sha256 !== binding.partition_sha256 || receipt.principal !== principal || receipt.action !== 'approve_selection' || receipt.generation !== request.generation || Date.parse(receipt.created_at) >= Date.parse(basis.expires_at)) fail('MEDIATION_STALE', 5, 'Approval disagrees with its exact prepared packet, response and target.');
}

/** Structural portion of seal(): binds the complete selected partition to the
 * retained basis and exact considered Composition without refreshing expiry. */
export function assertSelectionSealBinding(payload: any, composition: Composition, basis: any, inputFingerprint: () => string): void {
  if (payload.basis_sha256 !== digest(basis) || basis.baseline !== composition.baseline || basis.input_fingerprint !== inputFingerprint() || !basis.alternatives.some((a: any) => a.eligible && canonical(a.selected) === canonical(payload.outcome.selected) && canonical(a.rejected) === canonical(payload.outcome.rejected))) fail('MEDIATION_STALE', 5, 'Resolution must bind an eligible complete selection in the exact basis.');
}
