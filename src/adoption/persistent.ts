import { z } from 'zod';
import { Engine, snapshotFromRelease } from '../core.js';
import { MODEL, canonical, digest, fail, parse, type Layer } from '../model.js';
import type { AuthorityIssuer, SecurityContext } from '../security.js';
import { createSourceHostProof, verifySourceHostProof, validateSourceSnapshot, type SourceHostProof } from '../source-binding.js';
import { prepareAdoptionProposal, validateAdoptionProposal } from './coverage.js';
import { normalizeAdoptionInventory, boundedRecord } from './contract.js';
import { ADOPTION_RECORD_SCHEMAS, inventoryRecordSchema, proposalRecordSchema, adoptionReviewSchema, publicationRecordSchema, exactAdoptionProposal, adoptionRequired } from './records.js';

const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const adoptionPrepareInput = z.object({ inventory: z.unknown(), layer: z.unknown(), previous: ref.optional(), previous_proposal: ref.optional() }).strict();
export const adoptionReviewInput = z.object({ proposal_ref: ref, expected_proposal_sha256: hash, accepted: z.boolean(), rationale: z.string().trim().min(1).max(4096) }).strict();
function local(engine: Engine, context: SecurityContext) {
  if (context.trust_mode !== 'local_fixture' || engine.modelVersion() !== MODEL) fail('UNSUPPORTED_SOURCE_BACKEND', 8, 'Persistent adoption requires the explicitly configured local Node v0.1 source host.');
}
function store(engine: Engine, type: keyof typeof ADOPTION_RECORD_SCHEMAS, input: unknown) {
  const data = parse(ADOPTION_RECORD_SCHEMAS[type] as z.ZodType<any>, input); boundedRecord(data);
  const ref = type + '@' + digest(data); engine.store(ref, type, data, false); return ref;
}
export function adoptionContext(engine: Engine, proposalRef: string) {
  const record = parse(proposalRecordSchema, engine.read(proposalRef, 'adoption-proposal', false));
  const inventory = parse(inventoryRecordSchema, engine.read(record.inventory_record_ref, 'adoption-inventory', false));
  const proposal = record.proposal, layer: Layer = engine.read(record.draft_ref, 'layer', false);
  const source = engine.read(proposal.source.ref, 'source-snapshot'), baseline = snapshotFromRelease(engine.read(proposal.baseline_ref, 'release'));
  if (proposalRef !== 'adoption-proposal@' + digest(record) || record.inventory_record_ref !== 'adoption-inventory@' + digest(inventory) || inventory.draft_ref !== record.draft_ref || inventory.owner !== record.owner || inventory.project_id !== record.project_id || proposal.project_id !== record.project_id || layer.owner !== record.owner) fail('STALE_ADOPTION_PROPOSAL', 5, 'Stored adoption envelope and exact document closure disagree.');
  const prepared = validateAdoptionProposal(proposal, { inventory: inventory.inventory, source, baseline_ref: proposal.baseline_ref, baseline, layer });
  return { record, inventoryRecord: inventory, ...prepared };
}
function ownerCurrent(engine: Engine, layer: Layer, context: SecurityContext) {
  if (layer.owner !== context.principal_id) fail('OWNER_FORBIDDEN', 4, 'Adoption preparation and interpretation review require the currently assigned Layer owner.');
  if (engine.ownerHeads[layer.id]?.head !== layer.revision) fail('STALE_REVISION', 5, 'Adoption review/publication requires the exact current owned Layer head.');
  if (context.layer_ids !== null && !context.layer_ids.includes(layer.id)) fail('LAYER_SCOPE_FORBIDDEN', 4, 'Adoption is outside the assigned Layer scope.');
  if (context.write_block_ids !== null && [...layer.changes, ...layer.acceptance].some(change => !context.write_block_ids!.includes(change.block))) fail('BLOCK_SCOPE_FORBIDDEN', 4, 'Adoption exceeds assigned Block scope.');
}
export function executeAdoption(engine: Engine, command: string, input: unknown, context: SecurityContext, issuer: AuthorityIssuer) {
  local(engine, context); issuer.authorize(context, command, input, engine);
  if (command === 'adoption.prepare') {
    const request = parse(adoptionPrepareInput, input), inventory = normalizeAdoptionInventory(request.inventory), raw = request.layer as Layer;
    if (inventory.project_id !== context.project_id || engine.options.projectId !== context.project_id) fail('PROJECT_FORBIDDEN', 4, 'Adoption belongs to another project.');
    const source = validateSourceSnapshot(engine.read(inventory.source.ref, 'source-snapshot'));
    issuer.assertRepository(context, command, source.repo_id, source.entries.map(entry => entry.path));
    // Retained lineage cannot be removed through a normal Layer revision or restoration.
    if (adoptionRequired(engine.records, raw)) {
      if (!request.previous_proposal || !request.previous) fail('ADOPTION_PREDECESSOR_REQUIRED', 6, 'Revising adopted intent requires its explicit prior proposal and current Layer head.');
      const prior = adoptionContext(engine, request.previous_proposal);
      const family = Object.values(engine.records).filter(record => record.type === 'adoption-proposal' && record.data.draft_ref.split('@')[0] === raw.id);
      const newest = Math.max(...family.map(record => Number(record.data.draft_ref.split('@')[1])));
      if (prior.layer.id !== raw.id || prior.layer.owner !== context.principal_id || prior.layer.revision !== newest || prior.layer.revision >= raw.revision) fail('ADOPTION_PREDECESSOR_REQUIRED', 6, 'Predecessor must be the latest retained adoption proposal for this owner and lineage.');
      if (prior.inventory.mode !== inventory.mode || prior.inventory.declared_scope !== inventory.declared_scope) fail('ADOPTION_SCOPE_CHANGED', 5, 'A changed route or declared scope needs a new explicitly named Layer lineage.');
      const removed = prior.inventory.units.filter(unit => !inventory.units.some(current => current.id === unit.id)).map(unit => unit.id);
      if (removed.length) fail('ADOPTION_INVENTORY_LOSS', 5, 'Adoption revision must retain declared units with explicit disposition.', { units: removed });
    } else if (request.previous_proposal) fail('ADOPTION_PREDECESSOR_REQUIRED', 6, 'A first adoption proposal cannot claim an unrelated predecessor.');
    const prepared = prepareAdoptionProposal({ inventory, source, baseline_ref: raw.baseline, baseline: snapshotFromRelease(engine.read(raw.baseline, 'release')), layer: raw });
    if (prepared.layer.model_version !== MODEL) fail('UNSUPPORTED_MODEL_VERSION', 8, 'Persistent source adoption currently supports v0.1 only.');
    // Issuer authorization applies the actual Layer owner/Block/Layer assignment to this command.
    const layer = engine.layer(prepared.layer, context.principal_id, request.previous), owned = { project_id: context.project_id, owner: context.principal_id, draft_ref: layer.ref };
    const inventoryRef = store(engine, 'adoption-inventory', { format: 'adoption-inventory-record/1', ...owned, inventory: prepared.inventory });
    const proposalRef = store(engine, 'adoption-proposal', { format: 'adoption-proposal-record/1', ...owned, inventory_record_ref: inventoryRef, previous_proposal_ref: request.previous_proposal ?? null, proposal: prepared.proposal });
    return { ref: proposalRef, inventory_ref: inventoryRef, draft_ref: layer.ref, proposal_sha256: digest(engine.read(proposalRef, 'adoption-proposal', false)), coverage: prepared.coverage, published: false };
  }
  if (command === 'adoption.review') {
    const request = parse(adoptionReviewInput, input), prepared = adoptionContext(engine, request.proposal_ref);
    ownerCurrent(engine, prepared.layer, context);
    if (prepared.record.project_id !== context.project_id || digest(prepared.record) !== request.expected_proposal_sha256) fail('STALE_ADOPTION_REVIEW', 6, 'Review must pin the exact retained proposal envelope and project.');
    issuer.assertRepository(context, command, prepared.source.repo_id, prepared.source.entries.map(entry => entry.path));
    if (request.accepted && !prepared.coverage.scope_accounted) fail('ADOPTION_SCOPE_INCOMPLETE', 6, 'Interpretation cannot be accepted while adopted units or questions remain unresolved.', { blockers: prepared.coverage.blockers });
    const ref = store(engine, 'adoption-review', { format: 'adoption-review/1', project_id: context.project_id, owner: prepared.layer.owner, draft_ref: prepared.proposal.layer_ref, proposal_ref: request.proposal_ref, proposal_sha256: digest(prepared.record), layer_sha256: digest(prepared.layer), accepted: request.accepted, rationale: request.rationale, principal: context.principal_id, grant_id: context.grant_id, policy_version: context.policy_version, authority_sha256: issuer.accessBinding(), trust: 'local-fixture', interpretation_reviewed: true, behavior_verified: false });
    return { ref, accepted: request.accepted, interpretation_reviewed: true, behavior_verified: false, source_fresh: false, publication_ready: false };
  }
  fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown adoption operation.');
}
export function publicationGate(engine: Engine, draftRef: string, reviewRef: string | undefined, context: SecurityContext, issuer: AuthorityIssuer, proof: SourceHostProof | undefined, retainedPublication?: any) {
  local(engine, context); const layer: Layer = engine.read(draftRef, 'layer', false); ownerCurrent(engine, layer, context);
  const exact = exactAdoptionProposal(engine.records, layer), prepared = adoptionContext(engine, exact.ref);
  if (!reviewRef) fail('ADOPTION_REVIEW_REQUIRED', 6, 'Publication requires the exact retained accepted interpretation review.');
  const review = parse(adoptionReviewSchema, engine.read(reviewRef, 'adoption-review', false));
  if (reviewRef !== 'adoption-review@' + digest(review) || review.project_id !== context.project_id || review.proposal_ref !== exact.ref || review.proposal_sha256 !== digest(exact.data) || review.draft_ref !== draftRef || review.layer_sha256 !== digest(layer) || review.owner !== layer.owner || review.principal !== layer.owner || !review.accepted || review.policy_version !== context.policy_version || review.authority_sha256 !== issuer.accessBinding() || !issuer.active(review.principal) || !prepared.coverage.scope_accounted) fail('STALE_ADOPTION_REVIEW', 6, 'The accepted interpretation review, current assignment and exact draft no longer agree.');
  const reviewer = issuer.resolve(review.grant_id, review.project_id);
  issuer.authorize(reviewer, 'adoption.review', { proposal_ref: review.proposal_ref }, engine);
  issuer.assertRepository(reviewer, 'adoption.review', prepared.source.repo_id, prepared.source.entries.map(entry => entry.path));
  issuer.assertRepository(context, 'layer.publish', prepared.source.repo_id, prepared.source.entries.map(entry => entry.path));
  verifySourceHostProof(proof, prepared.source);
  const observation = proof!.observation;
  const data = parse(publicationRecordSchema, { format: 'adoption-publication/1', project_id: context.project_id, owner: layer.owner, draft_ref: draftRef, proposal_ref: exact.ref, review_ref: reviewRef, layer_sha256: digest(layer), source: prepared.proposal.source, observation, observation_sha256: digest(observation), index_sha256: observation.index_sha256, principal: context.principal_id, policy_version: context.policy_version, authority_sha256: issuer.accessBinding(), trust: 'local-measurement', interpretation_reviewed: true, source_fresh_at_publication: true, behavior_verified: false });
  if (retainedPublication && canonical(data) !== canonical(retainedPublication)) fail('SOURCE_SNAPSHOT_STALE', 5, 'Source, index or authority changed after publication measurement.');
  return data;
}
// Structural historical verification does not re-run current grants or source freshness.
export function verifyAdoptionHistory(engine: Engine, project: string) {
  for (const [ref, stored] of Object.entries(engine.records)) {
    if (!Object.hasOwn(ADOPTION_RECORD_SCHEMAS, stored.type)) continue;
    const data = parse(ADOPTION_RECORD_SCHEMAS[stored.type as keyof typeof ADOPTION_RECORD_SCHEMAS] as z.ZodType<any>, stored.data);
    if (ref !== stored.type + '@' + digest(data) || data.project_id !== project || stored.published) fail('BACKUP_INVALID', 6, 'Adoption history must retain exact private content-addressed project records.');
    const layer: Layer = engine.read(data.draft_ref, 'layer', false);
    if (layer.owner !== data.owner || layer.model_version !== MODEL) fail('BACKUP_INVALID', 6, 'Adoption history owner/model differs from its draft.');
    if (stored.type === 'adoption-inventory') {
      const prepared = Object.values(engine.records).find(record => record.type === 'adoption-proposal' && record.data.inventory_record_ref === ref);
      if (!prepared) fail('BACKUP_MISSING_REFERENCE', 6, 'Adoption inventory lacks its proposal closure.');
    }
    if (stored.type === 'adoption-proposal') {
      const prepared = adoptionContext(engine, ref);
      if (data.previous_proposal_ref) {
        const prior = adoptionContext(engine, data.previous_proposal_ref);
        if (prior.layer.id !== layer.id || prior.layer.owner !== layer.owner || prior.layer.revision >= layer.revision || prior.inventory.mode !== prepared.inventory.mode || prior.inventory.declared_scope !== prepared.inventory.declared_scope || prior.inventory.units.some(unit => !prepared.inventory.units.some(next => next.id === unit.id))) fail('BACKUP_INVALID', 6, 'Adoption predecessor loses its owner, lineage or declared inventory.');
      }
    }
    if (stored.type === 'adoption-review' || stored.type === 'adoption-publication') {
      const prepared = adoptionContext(engine, data.proposal_ref);
      if (prepared.proposal.layer_ref !== data.draft_ref || data.layer_sha256 !== digest(layer) || data.principal !== layer.owner) fail('BACKUP_INVALID', 6, 'Adoption review/publication differs from its exact owner draft.');
      if (stored.type === 'adoption-review' && (data.proposal_sha256 !== digest(prepared.record) || data.accepted && !prepared.coverage.scope_accounted)) fail('BACKUP_INVALID', 6, 'Adoption review does not pin its accounted proposal.');
      if (stored.type === 'adoption-publication') {
        const review = parse(adoptionReviewSchema, engine.read(data.review_ref, 'adoption-review', false));
        if (!layer || !engine.records[data.draft_ref].published || !review.accepted || review.proposal_ref !== data.proposal_ref || review.layer_sha256 !== data.layer_sha256 || review.policy_version !== data.policy_version || review.authority_sha256 !== data.authority_sha256 || canonical(data.source) !== canonical(prepared.proposal.source)) fail('BACKUP_INVALID', 6, 'Publication lacks its accepted review and exact source closure.');
        verifySourceHostProof(createSourceHostProof(prepared.source, data.observation), prepared.source);
        if (digest(data.observation) !== data.observation_sha256 || data.observation.index_sha256 !== data.index_sha256) fail('BACKUP_INVALID', 6, 'Publication observation bytes differ from retained measurement pins.');
      }
    }
  }
  for (const [ref, stored] of Object.entries(engine.records)) if (stored.type === 'layer' && stored.published && adoptionRequired(engine.records, stored.data)) {
    // Layers published before the first opt-in adoption proposal keep their historical contract.
    const first = Math.min(...Object.values(engine.records).filter(record => record.type === 'adoption-proposal' && record.data.draft_ref.split('@')[0] === stored.data.id).map(record => Number(record.data.draft_ref.split('@')[1])));
    if (stored.data.revision >= first && !Object.values(engine.records).some(record => record.type === 'adoption-publication' && record.data.draft_ref === ref)) fail('BACKUP_MISSING_REFERENCE', 6, 'Published adopted lineage lacks a retained publication gate receipt.');
  }
}
