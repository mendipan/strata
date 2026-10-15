import { MODEL, canonical, digest, bytesDigest, fail, type Snapshot } from '../model.js';
import { treeDigest, type FixtureOracle, type ProfileAdapter, type ScenarioCapability, type CheckObservation } from '../profile-types.js';

export const COUNTER_PROFILE = 'counter-fixture/1';
export const COUNTER_PURPOSE = 'Accumulate positive integer additions within a fixed ceiling.';
export const counterLimit = (maximum: number) => ({ statement: `The total starts at zero and cannot exceed ${maximum}.`, kind: 'rule' as const, facets: ['behavior', 'data'] as ('behavior' | 'data')[], acceptance: ['add', 'limit'], parameters: { maximum } });
export const COUNTER_INTEGERS = { statement: 'Accept only positive safe integer additions.', kind: 'invariant' as const, facets: ['behavior', 'safety'] as ('behavior' | 'safety')[], acceptance: ['invalid'], parameters: { positive: true } };
export const COUNTER_CONTRACTS = {
  'counter/contract.inputs.add': 'An addition supplies one positive integer.',
  'counter/contract.outputs.total': 'Expose the accumulated total.',
  'counter/contract.failures.ceiling': 'Reject an addition above the ceiling without changing the total.'
};
const checks = ['counter.add', 'counter.limit', 'counter.invalid', 'intent.review'];
const fixture = { format: 'counter-fixtures/1', checks, invalid: [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1] };
const scenario: ScenarioCapability = {
  id: 'counter.compatibility', version: '1', models: [MODEL],
  evaluate({ snapshot }) {
    const maximum = snapshot.blocks.counter?.requirements.limit?.parameters.maximum;
    if (snapshot.root !== 'counter' || Object.keys(snapshot.blocks).join('|') !== 'counter') return [{ code: 'SEMANTIC_INCOMPATIBILITY', message: 'Counter fixture requires its single rooted Block.' }];
    return Number.isSafeInteger(maximum) && (maximum as number) >= 2 && (maximum as number) <= 1000 ? [] : [{ code: 'SEMANTIC_INCOMPATIBILITY', message: 'Counter ceiling must be a safe integer from 2 to 1000.' }];
  }
};
export function counterFixtureOracle(snapshot: Snapshot): FixtureOracle {
  const maximum = snapshot.blocks.counter?.requirements.limit?.parameters.maximum;
  if (!Number.isSafeInteger(maximum) || (maximum as number) < 2 || (maximum as number) > 1000) fail('INVALID_ORACLE', 6, 'Counter oracle requires a bounded integer ceiling.');
  const criteria = [...new Map(Object.values(snapshot.blocks).flatMap(b => Object.values(b.acceptance)).map(c => { const row = { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; return [canonical(row), row] as const; })).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { format: 'counter-oracle/1', snapshot_sha256: digest(snapshot), expected: { maximum }, criteria };
}
// Checker assertions and fixture inputs are independent of generated program configuration.
export function counterCheckSuite(module: any, expected: Record<string, unknown>, inputs: typeof fixture) {
  const results: Record<string, CheckObservation> = {};
  const equal = (actual: unknown, value: unknown, code: string) => { if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error(code); };
  for (const name of inputs.checks) {
    const observations: Record<string, unknown> = {};
    try {
      if (name === 'intent.review') { results[name] = { passed: true, failure: null, observations: { attestation: 'local fixture review only' } }; continue; }
      equal(module.config, expected, 'ORACLE_CONFIGURATION');
      const app = module.createCounter(); equal(app.total(), 0, 'INITIAL_TOTAL');
      if (name === 'counter.add') { equal(app.add(1), { accepted: true, total: 1 }, 'ADD_ONE'); equal(app.add(1), { accepted: true, total: 2 }, 'ACCUMULATE'); observations.total = app.total(); }
      if (name === 'counter.limit') { equal(app.add(expected.maximum), { accepted: true, total: expected.maximum }, 'AT_CEILING'); equal(app.add(1), { accepted: false, reason: 'ceiling', total: expected.maximum }, 'ABOVE_CEILING'); equal(app.total(), expected.maximum, 'ATOMIC_REJECTION'); observations.total = app.total(); }
      if (name === 'counter.invalid') { for (const value of inputs.invalid) { equal(app.add(value), { accepted: false, reason: 'invalid', total: 0 }, 'INVALID_ADDITION'); equal(app.total(), 0, 'INVALID_UNCHANGED'); } observations.invalid = inputs.invalid; }
      results[name] = { passed: true, failure: null, observations };
    } catch (error: any) { results[name] = { passed: false, failure: error.message, observations }; }
  }
  return results;
}
const checkerDigest = () => bytesDigest(counterCheckSuite.toString());
const fixtureDigest = (oracle: FixtureOracle) => digest({ fixture, criteria: oracle.criteria });
const archive = () => ({ id: COUNTER_PROFILE, template_version: '1', trust: 'bounded-test-fixture', capabilities: ['positive-integer-accumulation', 'atomic-ceiling-rejection', 'checker-bound-evidence'], checks, template: PROGRAM, checker: { source: counterCheckSuite.toString(), fixture } });

export const counterProfile: ProfileAdapter = {
  id: COUNTER_PROFILE, models: [MODEL], scenario, defaultForScenario: true, boundEvidence: true, archive,
  checker: {
    entrypoint: 'counter.mjs', oracleFormat: 'counter-oracle/1', archive: () => ({ source: counterCheckSuite.toString(), fixture }), digest: checkerDigest, fixtureDigest,
    run(module, oracle) { const results = counterCheckSuite(module, oracle.expected, fixture); return { checks: results, observations: { checks: results, oracle_sha256: digest(oracle) } }; }
  },
  describeEffects: snapshot => `Positive integer counter with ceiling ${snapshot.blocks.counter.requirements.limit.parameters.maximum}; overflow leaves the total unchanged. Fresh evidence and approvals remain required.`,
  materialize(target, evaluation) {
    const snapshot = evaluation.snapshot, block = snapshot.blocks.counter;
    if (snapshot.root !== 'counter' || Object.keys(snapshot.blocks).join('|') !== 'counter' || !block || block.parent !== null) fail('UNSUPPORTED_OBLIGATION', 8, 'Counter fixture supports only its single rooted Block.');
    const maximum = block.requirements.limit?.parameters.maximum;
    if (!Number.isSafeInteger(maximum) || (maximum as number) < 2 || (maximum as number) > 1000) fail('UNSUPPORTED_OBLIGATION', 8, 'Unsupported counter ceiling.');
    const recognized: Record<string, unknown> = {
      'counter/purpose': COUNTER_PURPOSE,
      'counter/requirements.limit': counterLimit(maximum as number),
      'counter/requirements.integers': COUNTER_INTEGERS,
      ...Object.fromEntries(Object.entries(COUNTER_CONTRACTS).map(([item, statement]) => [item, { statement, acceptance: item.includes('inputs') ? ['add', 'invalid'] : item.includes('outputs') ? ['add'] : ['limit'] }]))
    };
    const allowed: Record<string, string[]> = {
      'counter.add': ['counter/requirements.limit', 'counter/contract.inputs.add', 'counter/contract.outputs.total'],
      'counter.limit': ['counter/requirements.limit', 'counter/contract.failures.ceiling'],
      'counter.invalid': ['counter/requirements.integers', 'counter/contract.inputs.add'],
      'intent.review': ['counter/purpose']
    };
    for (const [key, c] of Object.entries(block.acceptance)) {
      if (!checks.includes(c.check) || c.version !== '1' || c.method !== (c.check === 'intent.review' ? 'review' : 'mechanical') || c.statement !== `Verify ${c.check} for ${c.fixture}.` || !c.subjects.length || c.subjects.some(s => !allowed[c.check].includes(s))) fail('UNSUPPORTED_OBLIGATION', 8, 'Unrecognized counter acceptance claim.', { item: 'counter/acceptance.' + key });
    }
    for (const obligation of evaluation.obligations) {
      if (!obligation.item.includes('/acceptance.')) {
        if (!Object.hasOwn(recognized, obligation.item) || canonical(recognized[obligation.item]) !== canonical(obligation.value)) fail('UNSUPPORTED_OBLIGATION', 8, 'Counter fixture cannot realize this active obligation.', { item: obligation.item });
        const linked = obligation.criteria.map(ref => block.acceptance[ref.split('/acceptance.')[1]]);
        if (linked.some(c => !c || !c.subjects.includes(obligation.item))) fail('OBLIGATION_CHECK_MISMATCH', 8, 'Counter criterion does not cover its linked subject.');
        const required = Object.entries(allowed).filter(([, subjects]) => subjects.includes(obligation.item)).map(([check]) => check);
        if (!required.length || required.some(check => !linked.some(c => c.check === check))) fail('OBLIGATION_CHECK_MISMATCH', 8, 'Counter obligation lacks a required check family.');
      }
    }
    for (const item of Object.keys(recognized)) if (!evaluation.obligations.some(o => o.item === item)) fail('OBLIGATION_CONSERVATION', 5, 'Counter fixture requires its complete core obligation set.', { item });
    const files = { 'counter.mjs': PROGRAM.replace('__CONFIG__', canonical({ maximum })), 'README.md': 'Disposable bounded counter test fixture. Import createCounter; add positive integers, then inspect total.\n' };
    const outputs = Object.entries(files).map(([path, body]) => ({ path, digest: bytesDigest(body) }));
    const coverage = evaluation.obligations.map(o => ({ item: o.item, facets: o.facets, subjects: o.item.includes('/acceptance.') ? o.value.subjects : [o.item], status: 'implemented_validation_pending' as const, capability: 'bounded-counter-template', rationale: 'Recognized counter intent; measured checks and explicit fixture review remain required.', outputs, checks: o.criteria.map(ref => { const c = block.acceptance[ref.split('/acceptance.')[1]]; return { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; }), facet_handling: Object.fromEntries(o.facets.map(f => [f, 'Covered by the declared counter checks; facet grants no authority.'])) }));
    const oracle = counterFixtureOracle(snapshot);
    return { protocol_version: '1', model_version: snapshot.model_version, target, candidate: evaluation.fingerprint, profile_id: COUNTER_PROFILE, profile: digest(archive()), output_tree: treeDigest(files), files, coverage, reverse_links: Object.fromEntries(Object.keys(files).map(file => [file, coverage.map(c => c.item)])), trust: 'local-template', format: 'strata-realization/2', checker_sha256: checkerDigest(), oracle, oracle_sha256: digest(oracle), fixture_sha256: fixtureDigest(oracle) };
  }
};

const PROGRAM = `export const config = __CONFIG__;
export function createCounter() {
  let total = 0;
  return {
    add(value) {
      if (!Number.isSafeInteger(value) || value <= 0) return { accepted: false, reason: 'invalid', total };
      if (value > config.maximum - total) return { accepted: false, reason: 'ceiling', total };
      total += value;
      return { accepted: true, total };
    },
    total: () => total
  };
}
`;
