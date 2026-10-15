import { MODEL, canonical, fail, normalizeSnapshot, type Block, type Snapshot } from '../model.js';
import type { Evaluation } from '../core.js';
import { obligations } from '../obligations.js';
import type { CheckDefinition, FixtureOracle, ScenarioCapability } from '../profile-types.js';
import { digest } from '../model.js';

export const COLLECTION_PROFILE = 'collection-node/1';
export const COLLECTION_CHECKS = ['collection.lifecycle', 'collection.detached', 'collection.invalid', 'collection.limits', 'collection.atomic', 'intent.review'] as const;
export type CollectionConfig = { max_items: number; max_title_length: number };
export const collectionCountRequirement = (max_items: number) => ({ statement: `At most ${max_items} items exist per collection instance.`, kind: 'rule' as const, facets: ['data'] as 'data'[], acceptance: ['limits'], parameters: { max_items } });
export const collectionTitleRequirement = (max_title_length: number) => ({ statement: `Titles contain at most ${max_title_length} Unicode code points.`, kind: 'rule' as const, facets: ['data'] as 'data'[], acceptance: ['limits'], parameters: { max_title_length } });

const criterion = (check: string, fixture: string, subjects: string[]) => ({ statement: `Verify ${check} for ${fixture}.`, method: check === 'intent.review' ? 'review' as const : 'mechanical' as const, check, version: '1', fixture, subjects });
const entry = (statement: string, acceptance: string[]) => ({ statement, acceptance });
// These finite meanings are product source. They do not interpret input prose or code.
function expectedBlocks(config: CollectionConfig): Record<string, Block> {
  return {
    collection: {
      id: 'collection', parent: null, purpose: 'Compose item lifecycle and bounded input policy into an in-memory collection API.', requirements: {},
      relationships: {
        items: { target: 'items', statement: 'The collection delegates item lifecycle and detached reads to items.', acceptance: ['lifecycle', 'detached'] },
        policy: { target: 'policy', statement: 'The collection enforces input policy and atomic rejection of failed mutations.', acceptance: ['atomic'] }
      },
      contract: {
        inputs: { operations: entry('Expose add(id, title), get(id), list(), complete(id), and remove(id).', ['lifecycle', 'atomic']) },
        outputs: { api: entry('Each instance starts empty; list returns detached items in ascending ASCII ID order.', ['lifecycle', 'detached']) },
        failures: { rejected: entry('Rejected operations return an explicit reason and leave all items unchanged.', ['atomic']) }
      },
      acceptance: {
        lifecycle: criterion('collection.lifecycle', 'operations', ['collection/relationships.items', 'collection/contract.inputs.operations', 'collection/contract.outputs.api']),
        detached: criterion('collection.detached', 'copies', ['collection/relationships.items', 'collection/contract.outputs.api']),
        atomic: criterion('collection.atomic', 'rejections', ['collection/relationships.policy', 'collection/contract.inputs.operations', 'collection/contract.failures.rejected']),
        review: criterion('intent.review', 'collection', ['collection/purpose'])
      }
    },
    items: {
      id: 'items', parent: 'collection', purpose: 'Maintain unique items, idempotent completion, removal, and detached reads.', relationships: {},
      requirements: {
        lifecycle: { statement: 'Add inserts an incomplete item; completing twice succeeds without another change; removal frees capacity.', kind: 'rule', facets: ['behavior'], acceptance: ['lifecycle'], parameters: {} },
        detached: { statement: 'All returned items are detached copies; instance state is independent and restart begins empty.', kind: 'invariant', facets: ['behavior', 'data'], acceptance: ['detached'], parameters: {} }
      },
      contract: { inputs: {}, outputs: { item: entry('An item contains exactly id, title, and completed.', ['lifecycle', 'detached']) }, failures: {} },
      acceptance: {
        lifecycle: criterion('collection.lifecycle', 'operations', ['items/requirements.lifecycle', 'items/contract.outputs.item']),
        detached: criterion('collection.detached', 'copies', ['items/requirements.detached', 'items/contract.outputs.item']),
        review: criterion('intent.review', 'items', ['items/purpose'])
      }
    },
    policy: {
      id: 'policy', parent: 'collection', purpose: 'Enforce portable IDs, nonblank bounded titles, count limits, and atomic failures.', relationships: {},
      requirements: {
        count: collectionCountRequirement(config.max_items), title_length: collectionTitleRequirement(config.max_title_length),
        identifiers: { statement: 'IDs match [A-Za-z0-9][A-Za-z0-9_-]{0,31} exactly.', kind: 'invariant', facets: ['data', 'safety'], acceptance: ['invalid'], parameters: {} },
        titles: { statement: 'A title is a string with nonblank trim(); preserve its original text without normalization.', kind: 'invariant', facets: ['data'], acceptance: ['invalid'], parameters: {} },
        atomic: { statement: 'Invalid input, duplicate ID, missing item, and limit violations preserve the complete instance state.', kind: 'invariant', facets: ['behavior', 'safety'], acceptance: ['atomic'], parameters: {} }
      },
      contract: { inputs: {}, outputs: {}, failures: { reasons: entry('Failure reasons are invalid, title_too_long, duplicate, missing, and limit; validate input before duplicate and capacity.', ['atomic']) } },
      acceptance: {
        limits: criterion('collection.limits', 'bounds', ['policy/requirements.count', 'policy/requirements.title_length']),
        invalid: criterion('collection.invalid', 'inputs', ['policy/requirements.identifiers', 'policy/requirements.titles']),
        atomic: criterion('collection.atomic', 'rejections', ['policy/requirements.atomic', 'policy/contract.failures.reasons']),
        review: criterion('intent.review', 'policy', ['policy/purpose'])
      }
    }
  };
}

/** Fresh product intent, shared with the finite recognizer. No evidence or authority. */
export function initialCollectionBlocks(config: CollectionConfig) {
  return expectedBlocks(config);
}

/** Shared authoritative recognition for this adapter's scenario and materialization. */
export function recognizeCollection(snapshot: Snapshot): CollectionConfig {
  if (snapshot.model_version !== MODEL) fail('UNSUPPORTED_PROFILE', 8, 'collection-node/1 supports only local v0.1; v0.2 and hosted execution are unsupported.');
  if (snapshot.root !== 'collection' || canonical(Object.keys(snapshot.blocks).sort()) !== canonical(['collection', 'items', 'policy'])) fail('UNSUPPORTED_OBLIGATION', 8, 'Collection requires exactly the collection root and items/policy children.', { item: 'snapshot/block-set' });
  const max_items = snapshot.blocks.policy.requirements.count?.parameters.max_items;
  const max_title_length = snapshot.blocks.policy.requirements.title_length?.parameters.max_title_length;
  for (const [key, value, maximum] of [['max_items', max_items, 1000], ['max_title_length', max_title_length, 200]] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) fail('UNSUPPORTED_OBLIGATION', 8, 'Collection parameter is outside its finite integer bounds.', { parameter: key, minimum: 1, maximum });
  }
  const config = { max_items: max_items as number, max_title_length: max_title_length as number };
  const normalized = normalizeSnapshot(snapshot);
  const expected = normalizeSnapshot({ ...normalized, blocks: expectedBlocks(config) });
  // Normalize declared sets, then require exact topology and all semantic items.
  for (const id of ['collection', 'items', 'policy']) {
    const actual = normalized.blocks[id], wanted = expected.blocks[id];
    if (actual.parent !== wanted.parent) fail('UNSUPPORTED_OBLIGATION', 8, 'Collection child topology is fixed.', { item: id + '/parent' });
    if (actual.purpose !== wanted.purpose) fail('UNSUPPORTED_OBLIGATION', 8, 'Unrecognized collection purpose.', { item: id + '/purpose' });
    for (const section of ['requirements', 'acceptance', 'relationships'] as const) {
      const keys = [...new Set([...Object.keys(actual[section]), ...Object.keys(wanted[section])])].sort();
      for (const key of keys) if (canonical(actual[section][key] ?? null) !== canonical(wanted[section][key] ?? null)) fail('UNSUPPORTED_OBLIGATION', 8, 'Unrecognized or missing collection semantic item.', { item: `${id}/${section}.${key}` });
    }
    for (const section of ['inputs', 'outputs', 'failures'] as const) {
      const keys = [...new Set([...Object.keys(actual.contract[section]), ...Object.keys(wanted.contract[section])])].sort();
      for (const key of keys) if (canonical(actual.contract[section][key] ?? null) !== canonical(wanted.contract[section][key] ?? null)) fail('UNSUPPORTED_OBLIGATION', 8, 'Unrecognized or missing collection contract.', { item: `${id}/contract.${section}.${key}` });
    }
  }
  return config;
}

export function recognizeCollectionEvaluation(evaluation: Evaluation): CollectionConfig {
  if (evaluation.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'Collection materialization requires eligible intent.', evaluation.diagnostics);
  const config = recognizeCollection(evaluation.snapshot);
  const expected = obligations(normalizeSnapshot(evaluation.snapshot));
  if (canonical(evaluation.obligations) !== canonical(expected)) fail('OBLIGATION_CONSERVATION', 5, 'Collection obligations, facets, values and criterion links must match the normalized snapshot exactly.');
  return config;
}

export const collectionScenario: ScenarioCapability = {
  id: 'collection.compatibility', version: '1', models: [MODEL],
  evaluate({ snapshot }) {
    try { recognizeCollection(snapshot); return []; }
    catch (error) { if (error instanceof Error && 'code' in error) return [{ code: String(error.code), message: error.message, details: 'details' in error ? error.details : null }]; throw error; }
  }
};
export function collectionOracle(snapshot: Snapshot): FixtureOracle {
  const expected = recognizeCollection(snapshot);
  const criteria = [...new Map(Object.values(snapshot.blocks).flatMap(b => Object.values(b.acceptance)).map(c => {
    const row: CheckDefinition = { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; return [canonical(row), row] as const;
  })).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { format: 'collection-oracle/1', snapshot_sha256: digest(snapshot), expected, criteria };
}

// Pin recognizer/oracle code as well as the generated runtime and checker. An adapter's
// supported meanings must not change while retaining its original archive identity.
export function collectionSemanticsArchive() {
  return { format: 'collection-semantics/1', sources: {
    count: collectionCountRequirement.toString(), title: collectionTitleRequirement.toString(),
    criterion: criterion.toString(), entry: entry.toString(), blocks: expectedBlocks.toString(),
    recognition: recognizeCollection.toString(), obligations: recognizeCollectionEvaluation.toString(), oracle: collectionOracle.toString()
  } };
}
