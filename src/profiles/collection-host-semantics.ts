import { BLOCK_MODEL, MODEL, canonical, digest, fail, normalizeSnapshot, type Block, type Snapshot } from '../model.js';
import type { Evaluation } from '../core.js';
import { obligations } from '../obligations.js';
import type { CheckDefinition, FixtureOracle, ScenarioCapability } from '../profile-types.js';
import { recognizeCollection, type CollectionConfig } from './collection-semantics.js';

export const HOST_COLLECTION_PROFILE = 'collection-host/1';
export type HostCollectionConfig = CollectionConfig & { audit: boolean };
export function collectionAuditRelationship() {
  return { target: 'audit', statement: 'The collection records successful state changes through audit.', acceptance: ['audit'] };
}
export function collectionAuditOutput() {
  return { statement: 'When audit is present, audit() returns detached mutation events in sequence order.', acceptance: ['audit'] };
}
export function collectionAuditCriterion() {
  return { statement: 'Verify collection.audit for events.', method: 'mechanical' as const, check: 'collection.audit', version: '1', fixture: 'events', subjects: ['collection/contract.outputs.audit', 'collection/relationships.audit'] };
}
export function collectionAuditBlock(): Block {
  return {
    id: 'audit', parent: 'collection', purpose: 'Record successful collection mutations in deterministic sequence order.',
    requirements: {
      copies: { statement: 'Audit events and their items are detached copies; history is per instance and starts empty.', kind: 'rule', facets: ['data'], acceptance: ['events'], parameters: {} },
      sequence: { statement: 'Successful state changes append exactly one event with consecutive sequence numbers starting at one.', kind: 'rule', facets: ['behavior'], acceptance: ['events'], parameters: {} },
      successful: { statement: 'Record successful add, first completion and removal; rejected operations and repeated completion append no event.', kind: 'rule', facets: ['behavior'], acceptance: ['events'], parameters: {} }
    },
    relationships: {},
    contract: {
      inputs: { mutations: { statement: 'Observe add, complete and remove state changes.', acceptance: ['events'] } },
      outputs: { events: { statement: 'audit() returns events containing exactly sequence, operation and a detached item.', acceptance: ['events'] } },
      failures: { excluded: { statement: 'Reads, rejected operations and already-complete no-ops leave audit history unchanged.', acceptance: ['events'] } }
    },
    acceptance: {
      events: { statement: 'Verify collection.audit for events.', method: 'mechanical', check: 'collection.audit', version: '1', fixture: 'events', subjects: ['audit/contract.failures.excluded', 'audit/contract.inputs.mutations', 'audit/contract.outputs.events', 'audit/requirements.copies', 'audit/requirements.sequence', 'audit/requirements.successful'] },
      review: { statement: 'Verify intent.review for audit.', method: 'review', check: 'intent.review', version: '1', fixture: 'audit', subjects: ['audit/purpose'] }
    }
  };
}
function semanticBlock(block: Block): Block {
  const { description, asset_refs, ...semantic } = block;
  return semantic;
}
/** Reuse the unchanged local semantic recognizer only after explicit v0.3 guards.
 * This projection carries no evidence, permission or model support to the local adapter. */
export function recognizeHostCollection(snapshot: Snapshot): HostCollectionConfig {
  if (snapshot.model_version !== BLOCK_MODEL) fail('UNSUPPORTED_PROFILE', 8, 'collection-host/1 requires the explicit v0.3 authenticated host model.');
  const audit = Object.hasOwn(snapshot.blocks, 'audit');
  const ids = audit ? ['audit', 'collection', 'items', 'policy'] : ['collection', 'items', 'policy'];
  if (snapshot.root !== 'collection' || canonical(Object.keys(snapshot.blocks).sort()) !== canonical(ids)) fail('UNSUPPORTED_OBLIGATION', 8, 'Hosted collection supports only its three mandatory Blocks and optional audit child.');
  if (Object.values(snapshot.blocks).some(block => Object.keys(block.asset_refs ?? {}).length)) fail('UNSUPPORTED_OBLIGATION', 8, 'Hosted collection does not consume background assets.');
  const normalized = normalizeSnapshot(snapshot);
  const blocks = Object.fromEntries(['collection', 'items', 'policy'].map(id => [id, semanticBlock(normalized.blocks[id])]));
  if (audit) {
    const wanted = collectionAuditBlock();
    if (canonical(semanticBlock(normalized.blocks.audit)) !== canonical(wanted)
      || canonical(blocks.collection.relationships.audit ?? null) !== canonical(collectionAuditRelationship())
      || canonical(blocks.collection.contract.outputs.audit ?? null) !== canonical(collectionAuditOutput())
      || canonical(blocks.collection.acceptance.audit ?? null) !== canonical(collectionAuditCriterion())) fail('UNSUPPORTED_OBLIGATION', 8, 'Unrecognized audit Block, links, contract or criterion.');
    delete blocks.collection.relationships.audit;
    delete blocks.collection.contract.outputs.audit;
    delete blocks.collection.acceptance.audit;
  }
  const projected = normalizeSnapshot({ ...normalized, model_version: MODEL, blocks });
  return { ...recognizeCollection(projected), audit };
}
export function recognizeHostCollectionEvaluation(evaluation: Evaluation): HostCollectionConfig {
  // Like the existing host counter, the adapter recognizes pure hypothetical
  // selections for mediation. Engine.realize/register/Release enforce eligibility.
  const config = recognizeHostCollection(evaluation.snapshot);
  if (canonical(evaluation.obligations) !== canonical(obligations(normalizeSnapshot(evaluation.snapshot)))) fail('OBLIGATION_CONSERVATION', 5, 'Hosted collection must conserve all original v0.3 obligation links.');
  return config;
}
export const hostCollectionScenario: ScenarioCapability = {
  id: 'collection.compatibility', version: '1', models: [BLOCK_MODEL],
  evaluate({ snapshot }) {
    try { recognizeHostCollection(snapshot); return []; }
    catch (error) { if (error instanceof Error && 'code' in error) return [{ code: String(error.code), message: error.message, details: 'details' in error ? error.details : null }]; throw error; }
  }
};
export function hostCollectionOracle(snapshot: Snapshot): FixtureOracle {
  const expected = recognizeHostCollection(snapshot);
  const criteria = [...new Map(Object.values(snapshot.blocks).flatMap(block => Object.values(block.acceptance)).map(c => {
    const row: CheckDefinition = { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; return [canonical(row), row] as const;
  })).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { format: 'collection-host-oracle/1', snapshot_sha256: digest(snapshot), expected, criteria };
}
export function hostCollectionSemanticsArchive() {
  return { format: 'collection-host-semantics/1', sources: {
    relationship: collectionAuditRelationship.toString(), output: collectionAuditOutput.toString(), criterion: collectionAuditCriterion.toString(), audit: collectionAuditBlock.toString(),
    projection: semanticBlock.toString(), recognition: recognizeHostCollection.toString(), conservation: recognizeHostCollectionEvaluation.toString(), oracle: hostCollectionOracle.toString()
  } };
}
