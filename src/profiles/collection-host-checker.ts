import { bytesDigest, canonical, digest } from '../model.js';
import type { CheckObservation, FixtureChecker } from '../profile-types.js';
import { COLLECTION_FIXTURE, collectionCheckSuite, collectionChecker } from './collection-checker.js';

export const HOST_COLLECTION_FIXTURE = {
  format: 'collection-host-fixtures/1',
  mechanical: { ...COLLECTION_FIXTURE, checks: COLLECTION_FIXTURE.checks.filter(check => check !== 'intent.review') },
  audit_events: [
    { sequence: 1, operation: 'add', item: { id: 'a', title: 'a', completed: false } },
    { sequence: 2, operation: 'complete', item: { id: 'a', title: 'a', completed: true } },
    { sequence: 3, operation: 'remove', item: { id: 'a', title: 'a', completed: true } },
    { sequence: 4, operation: 'add', item: { id: 'b', title: 'a', completed: false } },
    { sequence: 5, operation: 'complete', item: { id: 'b', title: 'a', completed: true } },
    { sequence: 6, operation: 'remove', item: { id: 'b', title: 'a', completed: true } }
  ]
};
export function hostCollectionCheckSuite(module: any, expected: Record<string, unknown>) {
  const base = { max_items: expected.max_items, max_title_length: expected.max_title_length };
  const checks = collectionCheckSuite(module, base, HOST_COLLECTION_FIXTURE.mechanical);
  const shape = canonical(Object.keys(expected).sort()) === canonical(['audit', 'max_items', 'max_title_length']) && typeof expected.audit === 'boolean' && module.auditEnabled === expected.audit;
  if (!shape) for (const check of Object.keys(checks)) checks[check] = { passed: false, failure: 'HOST_ORACLE_CONFIGURATION', observations: {} };
  if (expected.audit !== true) {
    if (shape && typeof module.createCollection().audit !== 'undefined') checks['collection.lifecycle'] = { passed: false, failure: 'UNDECLARED_AUDIT', observations: {} };
    return checks;
  }
  const observations: Record<string, unknown> = {};
  const equal = (actual: unknown, wanted: unknown, failure: string) => { if (canonical(actual) !== canonical(wanted)) throw new Error(failure); };
  try {
    if (!shape) throw new Error('HOST_ORACLE_CONFIGURATION');
    const app = module.createCollection(), other = module.createCollection();
    equal(app.audit(), [], 'AUDIT_INITIAL_EMPTY');
    const added = app.add('a', 'a'); added.item.title = 'changed return';
    app.get('a'); app.list(); app.add('a', 'a'); app.add('bad id', 'a'); app.add('missing', ' '.repeat(2)); app.add('long', 'a'.repeat((expected.max_title_length as number) + 1));
    app.complete('missing'); app.remove('missing'); app.complete('a'); app.complete('a'); app.remove('a'); app.add('b', 'a'); app.complete('b'); const removed = app.remove('b'); removed.item.id = 'changed return';
    equal(app.audit(), HOST_COLLECTION_FIXTURE.audit_events, 'AUDIT_EXACT_SEQUENCE');
    const detached = app.audit(); detached[0].sequence = 100; detached[0].item.title = 'changed history'; detached.push(detached[0]);
    equal(app.audit(), HOST_COLLECTION_FIXTURE.audit_events, 'AUDIT_DETACHED');
    equal(other.audit(), [], 'AUDIT_INSTANCE_ISOLATION'); equal(module.createCollection().audit(), [], 'AUDIT_RESTART_EMPTY');
    const full = module.createCollection(); for (let n = 0; n < (expected.max_items as number); n++) full.add('i' + n, 'a');
    const before = full.audit(); equal(full.add('overflow', 'a'), { accepted: false, reason: 'limit' }, 'AUDIT_LIMIT_REJECTION'); equal(full.audit(), before, 'AUDIT_LIMIT_NO_EVENT');
    observations.events = app.audit(); observations.limit_rejection_unchanged = true;
    checks['collection.audit'] = { passed: true, failure: null, observations };
  } catch (error) { checks['collection.audit'] = { passed: false, failure: error instanceof Error ? error.message : String(error), observations }; }
  return checks;
}
export const hostCollectionChecker: FixtureChecker = {
  entrypoint: 'collection.mjs', oracleFormat: 'collection-host-oracle/1',
  archive: () => ({ format: 'collection-host-checker/1', base: collectionChecker.archive(), source: hostCollectionCheckSuite.toString(), fixture: HOST_COLLECTION_FIXTURE }),
  digest: () => digest({ base: collectionChecker.digest(), source: bytesDigest(hostCollectionCheckSuite.toString()) }),
  fixtureDigest: oracle => digest({ fixture: HOST_COLLECTION_FIXTURE, criteria: oracle.criteria }),
  run(module, oracle) { const checks: Record<string, CheckObservation> = hostCollectionCheckSuite(module, oracle.expected); return { checks, observations: { checks, oracle_sha256: digest(oracle) } }; }
};
