import { bytesDigest, digest } from '../model.js';
import type { CheckObservation, FixtureChecker } from '../profile-types.js';
import { COLLECTION_CHECKS } from './collection-semantics.js';

export const COLLECTION_FIXTURE = {
  format: 'collection-fixtures/1', checks: [...COLLECTION_CHECKS],
  invalid_ids: [null, 0, {}, '', '-', '_first', 'a b', ' a', 'a.', 'é', 'x'.repeat(33), 'a\n', 'a\r', 'a\r\n', 'a\u2028', 'a\u2029', 'a'.repeat(32) + '\n'],
  valid_ids: ['0', 'A', 'a-b_c', 'constructor', 'x'.repeat(32)],
  invalid_titles: [null, 0, {}, '', ' ', '\t\n', '\u00a0'],
  unicode: '😀', ascii: 'a', preserved_title: ' a '
};

// All helpers live inside this function so its digest pins every behavioral assertion.
// Host expectations are a separate argument, never read from generated config.
export function collectionCheckSuite(module: any, expected: Record<string, unknown>, fixture: typeof COLLECTION_FIXTURE) {
  const checks: Record<string, CheckObservation> = {};
  const equal = (actual: unknown, wanted: unknown, failure: string) => { if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(failure); };
  const require = (condition: unknown, failure: string) => { if (!condition) throw new Error(failure); };
  for (const check of fixture.checks) {
    const observations: Record<string, unknown> = {};
    try {
      if (check === 'intent.review') { checks[check] = { passed: true, failure: null, observations: { attestation: 'local fixture review only; no authenticated or human review' } }; continue; }
      const count = expected.max_items as number, length = expected.max_title_length as number;
      require(Number.isSafeInteger(count) && count >= 1 && count <= 1000 && Number.isSafeInteger(length) && length >= 1 && length <= 200, 'INVALID_EXPECTATION');
      equal(module.config, expected, 'ORACLE_CONFIGURATION');
      const app = module.createCollection(); equal(app.list(), [], 'INITIAL_EMPTY');
      const item = (id: string, title = fixture.ascii, completed = false) => ({ id, title, completed });
      const success = (value: unknown) => ({ accepted: true, item: value });
      const failure = (reason: string) => ({ accepted: false, reason });
      const rejected = (operation: () => unknown, reason: string) => { const before = JSON.stringify(app.list()); equal(operation(), failure(reason), 'FAILURE_' + reason); equal(JSON.stringify(app.list()), before, 'ATOMIC_' + reason); };
      if (check === 'collection.lifecycle') {
        const second = module.createCollection(); equal(second.list(), [], 'SECOND_EMPTY');
        const ids = ['c', 'a', 'b'].slice(0, Math.min(count, 3));
        for (const id of ids) equal(app.add(id, fixture.ascii), success(item(id)), 'ADD_INCOMPLETE');
        equal(app.list(), [...ids].sort().map(id => item(id)), 'STABLE_ORDER');
        equal(app.get(ids[0]), success(item(ids[0])), 'GET_EXISTING');
        equal(app.complete(ids[0]), success(item(ids[0], fixture.ascii, true)), 'COMPLETE');
        const once = app.list(); equal(app.complete(ids[0]), success(item(ids[0], fixture.ascii, true)), 'COMPLETE_AGAIN'); equal(app.list(), once, 'COMPLETE_NO_OP');
        equal(app.remove(ids[0]), success(item(ids[0], fixture.ascii, true)), 'REMOVE');
        equal(app.add('new', fixture.ascii), success(item('new')), 'CAPACITY_FREED');
        equal(second.list(), [], 'INSTANCE_ISOLATION'); equal(module.createCollection().list(), [], 'FRESH_INSTANCE_EMPTY');
        observations.final = app.list();
      }
      if (check === 'collection.detached') {
        const added = app.add('a', fixture.ascii); equal(added, success(item('a')), 'DETACHED_SETUP'); added.item.title = 'mutated'; added.item.completed = true;
        const got = app.get('a'); equal(got, success(item('a')), 'ADD_RESULT_DETACHED'); got.item.title = 'mutated'; got.item.id = 'b';
        const listed = app.list(); equal(listed, [item('a')], 'GET_DETACHED'); listed[0].completed = true; listed.push(item('z'));
        equal(app.list(), [item('a')], 'LIST_DETACHED');
        const completed = app.complete('a'); completed.item.title = 'mutated'; equal(app.get('a'), success(item('a', fixture.ascii, true)), 'COMPLETE_DETACHED');
        const removed = app.remove('a'); removed.item.id = 'mutated'; equal(app.list(), [], 'REMOVE_DETACHED');
        observations.detached = true;
      }
      if (check === 'collection.invalid') {
        for (const id of fixture.invalid_ids) for (const operation of [() => app.add(id, fixture.ascii), () => app.get(id), () => app.complete(id), () => app.remove(id)]) rejected(operation, 'invalid');
        for (const title of fixture.invalid_titles) rejected(() => app.add('a', title), 'invalid');
        for (const id of fixture.valid_ids) { equal(app.add(id, fixture.ascii), success(item(id)), 'BOUNDARY_ID'); equal(app.remove(id), success(item(id)), 'BOUNDARY_REMOVE'); }
        if (length >= [...fixture.preserved_title].length) { equal(app.add('title', fixture.preserved_title), success(item('title', fixture.preserved_title)), 'TITLE_PRESERVED'); app.remove('title'); }
        observations.invalid_ids = fixture.invalid_ids; observations.invalid_titles = fixture.invalid_titles;
      }
      if (check === 'collection.limits') {
        const boundary = fixture.unicode.repeat(length);
        equal(app.add('unicode', boundary), success(item('unicode', boundary)), 'UNICODE_CODE_POINTS');
        rejected(() => app.add('long', boundary + fixture.ascii), 'title_too_long'); app.remove('unicode');
        const ascii = fixture.ascii.repeat(length); equal(app.add('ascii', ascii), success(item('ascii', ascii)), 'TITLE_EXACT_BOUNDARY'); app.remove('ascii');
        for (let i = 1; i <= count; i++) equal(app.add('i' + i, fixture.ascii), success(item('i' + i)), 'COUNT_BELOW_BOUNDARY');
        rejected(() => app.add('overflow', fixture.ascii), 'limit');
        app.remove('i1'); equal(app.add('replacement', fixture.ascii), success(item('replacement')), 'COUNT_CAPACITY_REUSED');
        observations.maximum = count; observations.title_code_points = length;
      }
      if (check === 'collection.atomic') {
        equal(app.add('a', fixture.ascii), success(item('a')), 'ATOMIC_SETUP');
        rejected(() => app.add('a', fixture.ascii), 'duplicate');
        rejected(() => app.add('a', ' '), 'invalid');
        rejected(() => app.add('a', fixture.ascii.repeat(length + 1)), 'title_too_long');
        for (const operation of [() => app.get('missing'), () => app.complete('missing'), () => app.remove('missing')]) rejected(operation, 'missing');
        for (let i = 1; i < count; i++) app.add('fill' + i, fixture.ascii);
        rejected(() => app.add('overflow', fixture.ascii), 'limit'); rejected(() => app.complete('bad id'), 'invalid');
        observations.final_count = app.list().length;
      }
      checks[check] = { passed: true, failure: null, observations };
    } catch (error) { checks[check] = { passed: false, failure: error instanceof Error ? error.message : String(error), observations }; }
  }
  return checks;
}

export const collectionChecker: FixtureChecker = {
  entrypoint: 'collection.mjs', oracleFormat: 'collection-oracle/1',
  archive: () => ({ format: 'collection-checker/1', source: collectionCheckSuite.toString(), fixture: COLLECTION_FIXTURE }),
  digest: () => bytesDigest(collectionCheckSuite.toString()),
  fixtureDigest: oracle => digest({ fixture: COLLECTION_FIXTURE, criteria: oracle.criteria }),
  run(module, oracle) { const checks = collectionCheckSuite(module, oracle.expected, COLLECTION_FIXTURE); return { checks, observations: { checks, oracle_sha256: digest(oracle) } }; }
};
