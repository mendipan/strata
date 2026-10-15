import { normalizeLayer, obligations } from '../core.js';
import { MODEL, CONTENT_MODEL, canonical, digest, fail, normalizeSnapshot, parse, write, type Layer, type Snapshot } from '../model.js';
import { sourceRefSchema } from '../source-binding.js';
import { adoptionInventoryRef, adoptionProposalRef, adoptionProposalSchema, boundedRecord, validateAdoptionInventory, type AdoptionInventory, type AdoptionProposal } from './contract.js';

export type AdoptionContext = {
  inventory: unknown; source: unknown; baseline_ref: string; baseline: unknown; layer: unknown;
};
export type AdoptionCoverage = {
  format: 'adoption-coverage/1'; inventory_ref: string; layer_ref: string;
  declared_inventory_accounted: true; scope_accounted: boolean;
  scope_claim: 'selected_scope' | 'complete_declared_scope' | 'incomplete';
  adopted_units: string[]; outside_units: string[]; changed_items: string[];
  inferred_units: string[]; referenced_evidence_verified: false;
  blockers: { code: string; units: string[]; questions: string[] }[];
  interpretation_reviewed: false; source_fresh: false; freshness: 'not_checked';
  behavior_verified: false; publication_ready: false;
};
function layerContext(context: AdoptionContext) {
  const { inventory, source } = validateAdoptionInventory(context.inventory, context.source);
  parse(sourceRefSchema, context.baseline_ref);
  const baseline = normalizeSnapshot(context.baseline);
  if (baseline.model_version !== MODEL && baseline.model_version !== CONTENT_MODEL) fail('UNSUPPORTED_MODEL_VERSION', 8, 'Adoption preparation supports v0.1/v0.2 only; new Block lifecycle accounting is unconfigured.');
  const layer = normalizeLayer(context.layer, baseline);
  if (layer.baseline !== context.baseline_ref) fail('MIXED_BASELINE', 5, 'Proposal must use the supplied exact baseline reference.');
  if (layer.resolution_proposals.length) fail('INVALID_DECISION_LAYER', 2, 'Adoption proposals describe intent; decision Layers are reviewed separately.');
  boundedRecord(layer);
  const snapshot = structuredClone(baseline);
  for (const change of layer.changes) write(snapshot.blocks[change.block], change.path, change.value);
  for (const addition of layer.acceptance) write(snapshot.blocks[addition.block], 'acceptance.' + addition.id, addition.criterion);
  // Recheck complete subjects and references after the supplied Layer is applied.
  return { inventory, source, baseline, layer, snapshot: normalizeSnapshot(snapshot) };
}
function coverage(inventory: AdoptionInventory, layer: Layer, snapshot: Snapshot): AdoptionCoverage {
  const items = new Map(obligations(snapshot).map(obligation => [obligation.item, obligation]));
  const mappedUnits = inventory.units.filter(unit => unit.disposition === 'mapped');
  for (const unit of mappedUnits) {
    const required = new Set<string>();
    for (const key of unit.items) {
      const obligation = items.get(key);
      if (!obligation) fail('ADOPTION_MAPPING_INVALID', 2, 'Mapped intent item is absent from the proposed snapshot.', { unit: unit.id, item: key });
      if (!obligation.criteria.length) fail('ADOPTION_MAPPING_INVALID', 2, 'Mapped intent needs declared acceptance.', { unit: unit.id, item: key });
      for (const key of obligation.criteria) required.add(key);
    }
    if (canonical([...required].sort()) !== canonical(unit.criteria)) {
      fail('ADOPTION_MAPPING_INVALID', 2, 'Mapped units must retain the exact complete criterion set of their intent items.', { unit: unit.id });
    }
  }
  const changed = [...layer.changes.map(change => change.block + '/' + change.path),
    ...layer.acceptance.map(addition => addition.block + '/acceptance.' + addition.id)].sort();
  for (const key of changed) {
    if (!mappedUnits.some(unit => unit.scope === 'adopted' && unit.items.includes(key))) {
      fail('ADOPTION_MAPPING_INVALID', 2, 'Every supplied Layer change and added criterion must link to an adopted inventory unit.', { item: key });
    }
  }
  const adopted = inventory.units.filter(unit => unit.scope === 'adopted'), blockers: AdoptionCoverage['blockers'] = [];
  if (!adopted.length) blockers.push({ code: 'ADOPTION_SCOPE_EMPTY', units: [], questions: [] });
  const incomplete = adopted.filter(unit => unit.disposition !== 'mapped').map(unit => unit.id);
  if (incomplete.length) blockers.push({ code: 'ADOPTION_SCOPE_INCOMPLETE', units: incomplete, questions: [] });
  const questions = inventory.questions.filter(question => !question.unit_ids.length || question.unit_ids.some(id => adopted.some(unit => unit.id === id))).map(question => question.id);
  if (questions.length) blockers.push({ code: 'ADOPTION_QUESTIONS_UNRESOLVED', units: [], questions });
  const complete = blockers.length === 0;
  return {
    format: 'adoption-coverage/1', inventory_ref: adoptionInventoryRef(inventory), layer_ref: layer.id + '@' + layer.revision,
    declared_inventory_accounted: true, scope_accounted: complete,
    scope_claim: complete ? inventory.mode === 'incremental' ? 'selected_scope' : 'complete_declared_scope' : 'incomplete',
    adopted_units: adopted.map(unit => unit.id), outside_units: inventory.units.filter(unit => unit.scope === 'outside').map(unit => unit.id),
    changed_items: changed, inferred_units: inventory.units.filter(unit => unit.classification === 'inferred').map(unit => unit.id),
    referenced_evidence_verified: false, blockers,
    interpretation_reviewed: false, source_fresh: false, freshness: 'not_checked', behavior_verified: false, publication_ready: false
  };
}

// All inputs are supplied values. No records, files, grants or evidence are created.
export function prepareAdoptionProposal(context: AdoptionContext) {
  const { inventory, source, baseline, layer, snapshot } = layerContext(context);
  const proposal: AdoptionProposal = {
    format: 'adoption-proposal/1', project_id: inventory.project_id,
    inventory_ref: adoptionInventoryRef(inventory), inventory_sha256: digest(inventory),
    source: structuredClone(inventory.source), baseline_ref: context.baseline_ref, baseline_snapshot_sha256: digest(baseline),
    layer_ref: layer.id + '@' + layer.revision, layer_sha256: digest(layer), model_version: layer.model_version, author: layer.owner,
    output_lane: inventory.mode === 'incremental' ? 'selected_git_patch' : 'independent_reconstruction'
  };
  return { inventory, source, baseline, layer, proposal, proposal_ref: adoptionProposalRef(proposal), coverage: coverage(inventory, layer, snapshot) };
}
export function validateAdoptionProposal(input: unknown, context: AdoptionContext) {
  const proposal = parse(adoptionProposalSchema, input), prepared = prepareAdoptionProposal(context);
  if (canonical(proposal) !== canonical(prepared.proposal)) fail('STALE_ADOPTION_PROPOSAL', 5, 'Proposal linkage differs from its exact normalized inventory, source, baseline or Layer.');
  return prepared;
}

// Revision checking conserves unit identities. Recapture is a new inventory, not a silent revision.
export function validateAdoptionInventoryRevision(previousInput: unknown, nextInput: unknown, sourceInput: unknown): AdoptionInventory {
  const previous = validateAdoptionInventory(previousInput, sourceInput).inventory;
  const next = validateAdoptionInventory(nextInput, sourceInput).inventory;
  if (previous.mode !== next.mode || previous.declared_scope !== next.declared_scope) fail('ADOPTION_SCOPE_CHANGED', 5, 'Changed scope or route requires a new explicitly reviewed inventory.');
  const removed = previous.units.filter(unit => !next.units.some(current => current.id === unit.id)).map(unit => unit.id);
  if (removed.length) fail('ADOPTION_INVENTORY_LOSS', 5, 'A revision cannot silently drop declared units; retain them with explicit disposition.', { units: removed });
  return next;
}
