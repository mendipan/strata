import { MODEL, bytesDigest, canonical, digest } from '../model.js';
import { treeDigest, type ProfileAdapter } from '../profile-types.js';
import { collectionChecker } from './collection-checker.js';
import { COLLECTION_PROFILE, collectionOracle, collectionScenario, collectionSemanticsArchive, recognizeCollection, recognizeCollectionEvaluation } from './collection-semantics.js';

const PROGRAM = `export const config = Object.freeze(__CONFIG__);
export function createCollection() {
  const items = new Map();
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.exec(id)?.[0] === id;
  const failure = reason => ({ accepted: false, reason });
  const success = item => ({ accepted: true, item: { ...item } });
  return {
    add(id, title) {
      if (!validId(id) || typeof title !== 'string' || !title.trim()) return failure('invalid');
      if ([...title].length > config.max_title_length) return failure('title_too_long');
      if (items.has(id)) return failure('duplicate');
      if (items.size >= config.max_items) return failure('limit');
      const item = { id, title, completed: false };
      items.set(id, item);
      return success(item);
    },
    get(id) {
      if (!validId(id)) return failure('invalid');
      return items.has(id) ? success(items.get(id)) : failure('missing');
    },
    list() { return [...items.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(item => ({ ...item })); },
    complete(id) {
      if (!validId(id)) return failure('invalid');
      const item = items.get(id);
      if (!item) return failure('missing');
      item.completed = true;
      return success(item);
    },
    remove(id) {
      if (!validId(id)) return failure('invalid');
      const item = items.get(id);
      if (!item) return failure('missing');
      items.delete(id);
      return success(item);
    }
  };
}
`;
const archive = () => ({ id: COLLECTION_PROFILE, template_version: '1', models: [MODEL], backend: 'node', scenario: { id: collectionScenario.id, version: collectionScenario.version }, trust: 'bounded-local-fixture', capabilities: ['three-block-in-memory-collection', 'detached-ascii-ordered-reads', 'atomic-bounded-mutations', 'checker-bound-evidence'], template: PROGRAM, semantics: collectionSemanticsArchive(), checker: collectionChecker.archive() });

export const collectionProfile: ProfileAdapter = {
  id: COLLECTION_PROFILE, models: [MODEL], scenario: collectionScenario, defaultForScenario: true, boundEvidence: true, archive, checker: collectionChecker,
  describeEffects(snapshot) { const config = recognizeCollection(snapshot); return `Synthetic in-memory collection: at most ${config.max_items} items, titles at most ${config.max_title_length} Unicode code points. State is per instance. Fresh fixture evidence and separate approvals remain required.`; },
  materialize(target, evaluation) {
    const config = recognizeCollectionEvaluation(evaluation);
    const files = {
      'collection.mjs': PROGRAM.replace('__CONFIG__', canonical(config)),
      'README.md': 'Synthetic local in-memory collection. Import createCollection from collection.mjs. add/get/complete/remove return {accepted:true,item} or {accepted:false,reason}; list returns detached items in ASCII ID order. IDs match [A-Za-z0-9][A-Za-z0-9_-]{0,31}. Title length uses JavaScript string iteration (Unicode code points), with no normalization. Each instance starts empty; no persistence, network, clock, random values, imports or packages. No arbitrary application or equivalence claim.\n'
    };
    const outputs = Object.entries(files).map(([path, body]) => ({ path, digest: bytesDigest(body) }));
    const coverage = evaluation.obligations.map(o => ({
      item: o.item, facets: [...o.facets], subjects: o.item.includes('/acceptance.') ? [...o.value.subjects] : [o.item],
      status: 'implemented_validation_pending' as const, capability: 'bounded-collection-template',
      rationale: 'Exact collection meaning recognized; measured fixture checks, synthetic review, and separate authority approvals remain required.', outputs,
      checks: o.criteria.map(ref => { const [block, key] = ref.split('/acceptance.'); const c = evaluation.snapshot.blocks[block].acceptance[key]; return { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; }),
      facet_handling: Object.fromEntries(o.facets.map(f => [f, 'Covered by exact declared collection criterion links; a facet grants no authority.']))
    }));
    const oracle = collectionOracle(evaluation.snapshot);
    return { protocol_version: '1', model_version: MODEL, target, candidate: evaluation.fingerprint, profile_id: COLLECTION_PROFILE, profile: digest(archive()), output_tree: treeDigest(files), files, coverage, reverse_links: Object.fromEntries(Object.keys(files).map(file => [file, coverage.map(c => c.item)])), trust: 'local-template', format: 'strata-realization/2', checker_sha256: collectionChecker.digest(), fixture_sha256: collectionChecker.fixtureDigest(oracle), oracle_sha256: digest(oracle), oracle };
  }
};
