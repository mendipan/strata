import { BLOCK_MODEL, bytesDigest, canonical, digest } from '../model.js';
import { treeDigest, type ProfileAdapter } from '../profile-types.js';
import { collectionProfile } from './collection.js';
import { hostCollectionChecker } from './collection-host-checker.js';
import { HOST_COLLECTION_PROFILE, hostCollectionOracle, hostCollectionScenario, hostCollectionSemanticsArchive, recognizeHostCollection, recognizeHostCollectionEvaluation, type HostCollectionConfig } from './collection-host-semantics.js';

const AUDIT_WRAPPER = `export function createCollection() {
  const base = createCollectionBase();
  const events = [];
  const record = (operation, result) => { events.push({ sequence: events.length + 1, operation, item: { ...result.item } }); return result; };
  return {
    ...base,
    add(id, title) { const result = base.add(id, title); return result.accepted ? record('add', result) : result; },
    complete(id) { const before = base.get(id); const result = base.complete(id); return result.accepted && before.accepted && !before.item.completed ? record('complete', result) : result; },
    remove(id) { const result = base.remove(id); return result.accepted ? record('remove', result) : result; },
    audit() { return events.map(event => ({ ...event, item: { ...event.item } })); }
  };
}
`;
export function hostCollectionProgram(config: HostCollectionConfig) {
  const template = (collectionProfile.archive() as { template: string }).template;
  const base = template.replace('__CONFIG__', canonical({ max_items: config.max_items, max_title_length: config.max_title_length }));
  return config.audit
    ? base.replace('export function createCollection()', 'function createCollectionBase()') + '\nexport const auditEnabled = true;\n' + AUDIT_WRAPPER
    : base + '\nexport const auditEnabled = false;\n';
}
const archive = () => ({ format: 'strata-host-profile/1', id: HOST_COLLECTION_PROFILE, models: [BLOCK_MODEL], base: collectionProfile.archive(), audit_wrapper: AUDIT_WRAPPER, program: hostCollectionProgram.toString(), semantics: hostCollectionSemanticsArchive(), checker: hostCollectionChecker.archive(), review: 'authenticated-criterion-attestation/1' });

export const hostCollectionProfile: ProfileAdapter = {
  id: HOST_COLLECTION_PROFILE, models: [BLOCK_MODEL], scenario: hostCollectionScenario, defaultForScenario: true, boundEvidence: true, archive, checker: hostCollectionChecker,
  describeEffects(snapshot) { const config = recognizeHostCollection(snapshot); return `Finite hosted in-memory collection: ${config.max_items} items, ${config.max_title_length} Unicode title code points${config.audit ? ', deterministic mutation audit' : ''}. Separate authenticated criterion review and approvals remain required.`; },
  materialize(target, evaluation) {
    const config = recognizeHostCollectionEvaluation(evaluation);
    const files = {
      'collection.mjs': hostCollectionProgram(config),
      'README.md': 'Synthetic v0.3 compiled collection. Import createCollection; add/get/list/complete/remove use the finite collection contract. ' + (config.audit ? 'audit() returns detached successful mutation events; reads, rejection and repeated completion add none. ' : 'Audit is absent. ') + 'State is per instance and starts empty. No persistence, network, clock, random values, imports or packages. Mechanical execution does not supply criterion review, approval or Release.\n'
    };
    const outputs = Object.entries(files).map(([path, body]) => ({ path, digest: bytesDigest(body) }));
    const coverage = evaluation.obligations.map(o => ({
      item: o.item, facets: [...o.facets], subjects: o.item.includes('/acceptance.') ? [...o.value.subjects] : [o.item], status: 'implemented_validation_pending' as const,
      capability: 'bounded-host-collection-template', rationale: 'Exact finite collection intent recognized. Mechanical results need the configured measured host runner; reviews require separate authenticated criterion attestations.', outputs,
      checks: o.criteria.map(ref => { const [block, key] = ref.split('/acceptance.'); const c = evaluation.snapshot.blocks[block].acceptance[key]; return { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; }),
      facet_handling: Object.fromEntries(o.facets.map(f => [f, 'Covered by exact declared criterion links; this grants no authority.']))
    }));
    const oracle = hostCollectionOracle(evaluation.snapshot);
    return { protocol_version: '1', model_version: BLOCK_MODEL, target, candidate: evaluation.fingerprint, profile_id: HOST_COLLECTION_PROFILE, profile: digest(archive()), output_tree: treeDigest(files), files, coverage, reverse_links: Object.fromEntries(Object.keys(files).map(file => [file, coverage.map(c => c.item)])), trust: 'local-template', format: 'strata-realization/2', checker_sha256: hostCollectionChecker.digest(), fixture_sha256: hostCollectionChecker.fixtureDigest(oracle), oracle_sha256: digest(oracle), oracle };
  }
};
