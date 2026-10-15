import { z } from 'zod';
import { MODEL, digest, fail, parse, type Records, type Layer } from '../model.js';
import { adoptionInventorySchema, adoptionProposalSchema } from './contract.js';
import { gitObservationSchema } from '../source-binding.js';

const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const owned = { project_id: z.string().min(1).max(120), owner: z.string().min(1).max(120), draft_ref: ref };
// Versioned storage envelopes keep A1 document fingerprints distinct from record refs.
export const inventoryRecordSchema = z.object({
  format: z.literal('adoption-inventory-record/1'), ...owned, inventory: adoptionInventorySchema
}).strict();
export const proposalRecordSchema = z.object({
  format: z.literal('adoption-proposal-record/1'), ...owned, inventory_record_ref: ref,
  previous_proposal_ref: ref.nullable(), proposal: adoptionProposalSchema
}).strict();
export const adoptionReviewSchema = z.object({
  format: z.literal('adoption-review/1'), ...owned, proposal_ref: ref, proposal_sha256: hash,
  layer_sha256: hash, accepted: z.boolean(), rationale: z.string().min(1).max(4096),
  principal: z.string().min(1), grant_id: z.string().min(1), policy_version: z.string().min(1), authority_sha256: hash, trust: z.literal('local-fixture'),
  interpretation_reviewed: z.literal(true), behavior_verified: z.literal(false)
}).strict();
export const publicationRecordSchema = z.object({
  format: z.literal('adoption-publication/1'), ...owned, proposal_ref: ref, review_ref: ref,
  layer_sha256: hash, source: adoptionProposalSchema.shape.source,
  observation: gitObservationSchema, observation_sha256: hash, index_sha256: hash, principal: z.string().min(1), policy_version: z.string().min(1), authority_sha256: hash,
  trust: z.literal('local-measurement'), interpretation_reviewed: z.literal(true),
  source_fresh_at_publication: z.literal(true), behavior_verified: z.literal(false)
}).strict();
export const ADOPTION_RECORD_SCHEMAS = {
  'adoption-inventory': inventoryRecordSchema, 'adoption-proposal': proposalRecordSchema,
  'adoption-review': adoptionReviewSchema, 'adoption-publication': publicationRecordSchema
};
export { adoptionRequired } from './guard.js';
export function exactAdoptionProposal(records: Records, layer: Layer) {
  const proposals = Object.entries(records).filter(([, record]) => record.type === 'adoption-proposal' && record.data.draft_ref === `${layer.id}@${layer.revision}`);
  if (proposals.length !== 1) fail('ADOPTION_PROPOSAL_REQUIRED', 6, 'This adopted Layer lineage needs one exact proposal for its current revision.');
  const [ref, record] = proposals[0], data = parse(proposalRecordSchema, record.data);
  if (ref !== 'adoption-proposal@' + digest(data) || data.owner !== layer.owner || data.proposal.layer_sha256 !== digest(layer) || data.proposal.layer_ref !== data.draft_ref || data.proposal.model_version !== MODEL) fail('STALE_ADOPTION_PROPOSAL', 5, 'Retained adoption proposal does not bind this exact Layer.');
  return { ref, data };
}
export function adoptionArchiveReferences(type: string, data: any): string[] {
  switch (type) {
    case 'adoption-inventory': return [data.draft_ref, data.inventory.source.ref];
    case 'adoption-proposal': return [data.draft_ref, data.inventory_record_ref, data.proposal.baseline_ref, data.proposal.source.ref, ...(data.previous_proposal_ref ? [data.previous_proposal_ref] : [])];
    case 'adoption-review': return [data.draft_ref, data.proposal_ref];
    case 'adoption-publication': return [data.draft_ref, data.proposal_ref, data.review_ref, data.source.ref];
    default: return [];
  }
}
