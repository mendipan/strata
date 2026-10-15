import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine, snapshotFromRelease } from '../src/core.js';
import { MODEL, CONTENT_MODEL, canonical, digest, normalizeSnapshot, type Snapshot, type Layer, type Composition } from '../src/model.js';
import { profileFingerprint, materialize, type FixtureOracle, treeDigest } from '../src/profile.js';
import { runFixtureEvidence } from '../src/runner.js';
import { startLocalBroker } from '../src/local-broker.js';
import { runCli, HELP } from '../src/cli.js';
import { createBackup, verifyBackup } from '../src/backup.js';
import { prepared } from './helpers.js';
import { setup as mediationSetup } from './mediation-helpers.js';
import { verifyMediationHistory } from '../src/mediation.js';
import { COUNTER_PROFILE } from '../src/profiles/counter-fixture.js';

const fixture = async (name: string) => JSON.parse(await readFile(path.resolve('tests/fixtures/counter', name + '.json'), 'utf8'));
const baseline: Snapshot = await fixture('bootstrap'), layer: Layer = await fixture('extend'), recipe: Composition = await fixture('composition');
const root = await mkdtemp(path.resolve('.strata/profile-separation-'));
const observations: unknown[] = [];
after(async () => { await writeFile(path.resolve('.strata/profile-separation-evidence.json'), JSON.stringify({ base: '61b5ceb', trust: 'synthetic local fixtures; zero cloud calls', cases: observations }, null, 2)); await rm(root, { recursive: true, force: true }); });
const code = (expected: string) => (error: any) => error.code === expected;
const expectedItems = ['counter/purpose', 'counter/requirements.limit', 'counter/requirements.integers', 'counter/acceptance.add', 'counter/acceptance.limit', 'counter/acceptance.invalid', 'counter/acceptance.review', 'counter/contract.inputs.add', 'counter/contract.outputs.total', 'counter/contract.failures.ceiling'].sort();
function oracle(snapshot: Snapshot, maximum: number): FixtureOracle {
  // The host expectation is a literal test input, independent of program config and the adapter's oracle builder.
  const criteria = Object.values(baseline.blocks.counter.acceptance).map(c => ({ check: c.check, version: c.version, fixture: c.fixture, method: c.method })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { format: 'counter-oracle/1', snapshot_sha256: digest(snapshot), expected: { maximum }, criteria };
}
function candidate(snapshot = baseline) {
  const engine = new Engine(); engine.init(structuredClone(snapshot), 'bootstrap');
  engine.layer(structuredClone(layer), 'author-a'); engine.publish('CounterExtension@1', 'author-a');
  return { engine, candidate: engine.compose(structuredClone(recipe)) };
}
async function output(engine: Engine, target: ReturnType<Engine['compose']>, suffix: string) {
  const realization = engine.realize(target.ref, COUNTER_PROFILE), registered = engine.registerRealization(realization), directory = path.join(root, suffix);
  await mkdir(directory); for (const [name, body] of Object.entries(realization.files)) await writeFile(path.join(directory, name), body);
  await writeFile(path.join(directory, 'realization.json'), JSON.stringify({ record: realization, realization_ref: registered.ref }));
  return { realization, registered, directory };
}

test('core, record shapes, runner and mediation contain no booking names, parameters or runtime exports', async () => {
  for (const file of ['core.ts', 'model.ts', 'runner.ts', 'mediation.ts', 'service.ts', 'backup.ts', 'cli.ts']) assert.doesNotMatch(await readFile(path.resolve('src', file), 'utf8'), /booking|lead_seconds|createBooking/, file);
  assert(HELP.capabilities.profiles.includes(COUNTER_PROFILE));
});
test('all four booking profile fingerprints retain their 61b5ceb identities', () => {
  const historical: Record<string, string> = {
    'booking-node/1': '082c69b5420253378ae65ba450aa26be9e791921c50a9f7acca2a9c8345e13e5',
    'booking-node/2': '1d3733faf4753ad6d7a0d17640715d5479a28a7797909100e0f2aa2b66dfa2ee',
    'booking-node/3': '6399b1a73c4dac314ea45832436213a4c9506bb858e3c7cc0e3d4122b6e37c7a',
    'booking-node/4': 'fac3dd30e161d78d0f48d18dfdc05432584d63e2aedd8032b378bde6e43b9c8f'
  };
  for (const [id, hash] of Object.entries(historical)) assert.equal(profileFingerprint(id), hash, id);
});
test('single-Block counter composes, materializes, measures, validates and releases through unchanged generic gates', async () => {
  const { engine, candidate: target } = candidate(); assert.equal(target.state, 'eligible_for_validation'); assert.equal(target.scope, 'counter');
  assert.deepEqual(Object.keys(target.snapshot.blocks), ['counter']); assert.deepEqual(target.obligations.map(o => o.item).sort(), expectedItems);
  assert.deepEqual(target.provenance['counter/requirements.limit'], ['CounterExtension@1']);
  const o = await output(engine, target, 'counter-positive'), run = await runFixtureEvidence(o.directory, o.realization, oracle(target.snapshot, 12));
  assert(run.evidence.results.every(r => r.passed)); assert.deepEqual(o.realization.coverage.map(c => c.item).sort(), expectedItems);
  const { createCounter }: any = await import(pathToFileURL(path.join(o.directory, 'counter.mjs')).href);
  const app = createCounter(); assert.equal(app.total(), 0); assert.deepEqual(app.add(5), { accepted: true, total: 5 }); assert.deepEqual(app.add(7), { accepted: true, total: 12 });
  assert.deepEqual(app.add(1), { accepted: false, reason: 'ceiling', total: 12 }); assert.deepEqual(app.add(-1), { accepted: false, reason: 'invalid', total: 12 }); assert.equal(app.total(), 12);
  const v = engine.validate(target.ref, o.registered.ref, run.evidence);
  assert.throws(() => engine.release(target.ref, v.ref, []), code('ENDORSEMENT_REQUIRED'));
  assert.throws(() => engine.approve({ kind: 'scope', target: target.fingerprint, scope: target.scope, evidence_digest: v.evidence_digest }, 'author-a'), code('AUTHORITY_FORBIDDEN'));
  const approvals = [engine.approve({ kind: 'scope', target: target.fingerprint, scope: target.scope, evidence_digest: v.evidence_digest }, 'scope-selector').ref, engine.approve({ kind: 'release', target: target.fingerprint, scope: null, evidence_digest: v.evidence_digest }, 'release-manager').ref];
  const release = engine.release(target.ref, v.ref, approvals); assert.equal(engine.release(target.ref, v.ref, [...approvals].reverse()).ref, release.ref);
  assert.equal(canonical(snapshotFromRelease(engine.read(release.ref))), canonical(target.snapshot));
  const standalone = new Engine({ [release.ref]: engine.records[release.ref] });
  const inherited = standalone.compose({ ...recipe, id: 'CounterInherited', baseline: release.ref, proposals: [], selected: [] });
  assert.equal(inherited.state, 'eligible_for_validation'); assert.deepEqual(inherited.provenance, target.provenance); assert.deepEqual(inherited.obligations, target.obligations);
  const next = await output(standalone, inherited, 'counter-inherited'), again = await runFixtureEvidence(next.directory, next.realization, oracle(inherited.snapshot, 12));
  assert(again.evidence.results.every(r => r.passed)); assert.equal(next.realization.output_tree, o.realization.output_tree);
  observations.push({ case: 'counter-release-and-inheritance', candidate: target.fingerprint, release: release.ref, scope: target.scope, items: expectedItems, profile: o.realization.profile, checker: o.realization.checker_sha256, fixture: o.realization.fixture_sha256, oracle: run.observations.oracle_sha256, checks: run.observations.checks, literal_trace: [0, 5, 12, 12], inherited_output_tree: next.realization.output_tree });
});
test('counter unknown checks, absent capabilities, false assumptions, extra semantics and weakened check edges fail closed', () => {
  const { engine } = candidate();
  for (const checks of [[], [{ id: 'counter.compatibility', version: '2' }], [{ id: 'unknown.compatibility', version: '1' }]]) {
    const c = engine.compose({ ...recipe, id: 'bad-check-' + checks.length + '-' + (checks[0]?.id ?? 'empty'), scenario: { id: 'counter', checks } }); assert.equal(c.state, 'blocked'); assert.throws(() => engine.realize(c.ref, COUNTER_PROFILE), code('BLOCKED_CANDIDATE'));
  }
  const falseAssumption = structuredClone(layer); falseAssumption.id = 'false-assumption'; falseAssumption.assumptions = [{ block: 'counter', path: 'requirements.limit', expected: { kind: 'value', value: baseline.blocks.counter.requirements.limit } }];
  engine.layer(falseAssumption, 'author-a'); engine.publish('false-assumption@1', 'author-a');
  assert(engine.compose({ ...recipe, id: 'failed-assumption', proposals: ['false-assumption@1'], selected: ['false-assumption@1'] }).diagnostics.some(d => d.code === 'ASSUMPTION_FAILED'));
  for (const [name, mutate] of Object.entries({
    unknownRequirement: (s: Snapshot) => { s.blocks.counter.requirements.extra = { ...structuredClone(s.blocks.counter.requirements.limit), statement: 'Also reset the counter every night.' }; },
    unknownParameter: (s: Snapshot) => { s.blocks.counter.requirements.limit.parameters.reset = true; },
    unknownCriterion: (s: Snapshot) => { s.blocks.counter.acceptance.limit.check = 'counter.reset'; },
    wrongProse: (s: Snapshot) => { s.blocks.counter.purpose = 'Charge money for each addition.'; },
    weakenedEdge: (s: Snapshot) => { s.blocks.counter.acceptance.limit = { ...s.blocks.counter.acceptance.add }; }
  })) {
    const s = structuredClone(baseline); mutate(s); const e = new Engine(); e.init(s, 'bootstrap'); const c = e.compose({ ...recipe, id: name, proposals: [], selected: [] });
    assert.equal(c.state, 'eligible_for_validation'); assert.throws(() => e.realize(c.ref, COUNTER_PROFILE), code(name === 'weakenedEdge' ? 'OBLIGATION_CHECK_MISMATCH' : 'UNSUPPORTED_OBLIGATION'));
    assert.equal(Object.values(e.records).filter(r => r.type === 'release').length, 1);
  }
  const wrongCapability = engine.compose({ ...recipe, id: 'wrong-profile-capability', scenario: { id: 'wrong', checks: [{ id: 'booking.compatibility', version: '1' }] } });
  assert.throws(() => engine.realize(wrongCapability.ref, COUNTER_PROFILE), code('PROFILE_SCENARIO_MISMATCH'));
  const dropped = engine.target('CounterCandidate@1'); dropped.obligations.pop(); assert.throws(() => materialize('CounterCandidate@1', dropped, COUNTER_PROFILE), code('OBLIGATION_CONSERVATION'));
});
test('counter evidence, host oracle and output substitutions cannot validate or release', async () => {
  const { engine, candidate: target } = candidate(), o = await output(engine, target, 'counter-negative');
  await assert.rejects(() => runFixtureEvidence(o.directory, o.realization), code('ORACLE_REQUIRED'));
  await assert.rejects(() => runFixtureEvidence(o.directory, o.realization, oracle(target.snapshot, 6)), code('ORACLE_MISMATCH'));
  const run = await runFixtureEvidence(o.directory, o.realization, oracle(target.snapshot, 12));
  assert.throws(() => engine.validate(target.ref, o.registered.ref, { ...run.evidence, results: run.evidence.results.slice(1) }), code('VALIDATION_INCOMPLETE'));
  assert.throws(() => engine.validate(target.ref, o.registered.ref, { ...run.evidence, results: run.evidence.results.map(r => ({ ...r, passed: false })) }), code('VALIDATION_INCOMPLETE'));
  assert.throws(() => engine.validate(target.ref, o.registered.ref, { ...run.evidence, checker_sha256: '0'.repeat(64) }), code('STALE_CHECKER_EVIDENCE'));
  const tampered = structuredClone(o.realization); tampered.files['counter.mjs'] = tampered.files['counter.mjs'].replace('total += value', 'total += 1'); tampered.output_tree = treeDigest(tampered.files);
  assert.throws(() => engine.registerRealization(tampered), code('STALE_REALIZATION'));
  await writeFile(path.join(o.directory, 'counter.mjs'), tampered.files['counter.mjs']); await assert.rejects(() => runFixtureEvidence(o.directory, o.realization, oracle(target.snapshot, 12)), code('OUTPUT_TAMPERED'));
});
test('counter collisions route to the declared root authority and require an exact endorsed whole-Layer selection', () => {
  const { engine } = candidate(), alternate = structuredClone(layer); alternate.id = 'CounterAlternative'; alternate.owner = 'author-c';
  alternate.changes[0].value = { ...structuredClone(layer.changes[0].value as object), statement: 'The total starts at zero and cannot exceed 18.', parameters: { maximum: 18 } };
  engine.layer(alternate, 'author-c'); engine.publish('CounterAlternative@1', 'author-c');
  const considered = ['CounterExtension@1', 'CounterAlternative@1'], blocked = engine.compose({ ...recipe, id: 'CounterConflict', proposals: considered, selected: considered });
  assert.equal(blocked.state, 'blocked'); assert(blocked.diagnostics.some(d => d.code === 'ITEM_COLLISION')); assert.equal(blocked.scope, 'counter'); assert.deepEqual(blocked.impact, ['counter']);
  const decision: Layer = { ...structuredClone(layer), id: 'CounterDecision', owner: 'scope-selector', changes: [], resolution_proposals: [{ input_fingerprint: blocked.input_fingerprint, scope: 'counter', impact: ['counter'], outcome: { kind: 'select', selected: ['CounterExtension@1'], rejected: ['CounterAlternative@1'] } }] };
  engine.layer(decision, 'scope-selector'); engine.publish('CounterDecision@1', 'scope-selector');
  const request = { layer: 'CounterDecision@1', proposal_index: 0, composition: blocked.ref, approvals: [] as string[] };
  const unsigned = engine.resolution(request, 'scope-selector', true) as any;
  assert.throws(() => engine.resolution(request, 'scope-selector'), code('ENDORSEMENT_REQUIRED'));
  request.approvals.push(engine.approve({ kind: 'resolution', target: unsigned.target, scope: 'counter', evidence_digest: null }, 'scope-selector').ref);
  const resolution = engine.resolution(request, 'scope-selector') as any;
  const selected = engine.compose({ ...recipe, id: 'CounterSelected', proposals: considered, selected: ['CounterExtension@1'], resolutions: [resolution.ref] });
  assert.equal(selected.state, 'eligible_for_validation'); assert.doesNotThrow(() => engine.realize(selected.ref, COUNTER_PROFILE));
  const stale = engine.compose({ ...recipe, id: 'CounterStaleDecision', resolutions: [resolution.ref] }); assert(stale.diagnostics.some(d => d.code === 'STALE_RESOLUTION'));
});
test('v0.2 scalar parameter keys are domain neutral while unsupported booking meanings still cannot materialize', () => {
  const { engine, candidate: c } = prepared(), s = structuredClone(c.snapshot); s.id = 'ContentParameters'; s.model_version = CONTENT_MODEL;
  for (const block of Object.values(s.blocks)) { block.description = { format: 'plain-text/1', text: '' }; block.asset_refs = {}; }
  s.blocks['booking.hold'].requirements.expiry.parameters.maximum = 12; assert.doesNotThrow(() => normalizeSnapshot(s));
  const e = new Engine(); e.init(s, 'bootstrap'); const r = engine.read(c.ref, 'composition'); const target = e.compose({ ...r, id: 'UnsupportedParameters', model_version: CONTENT_MODEL, baseline: 'ContentParameters@1', proposals: [], selected: [], resolutions: [], alternative_groups: [] });
  assert.throws(() => e.realize(target.ref, 'booking-node/4'), code('UNSUPPORTED_OBLIGATION'));
});
test('unknown executor evaluator and wrong evaluator scope refuse before fixture installation', () => {
  const f = mediationSetup(); assert(f.config);
  const p = f.config.policies[0];
  assert.throws(() => mediationSetupWithPolicy({ ...p, evaluator: 'unknown-selection/1' }), code('UNSUPPORTED_POLICY_EVALUATOR'));
  assert.throws(() => mediationSetupWithPolicy({ ...p, scope: 'app' }), code('UNSUPPORTED_POLICY_EVALUATOR'));
  const historical = new Engine(structuredClone(f.engine.records));
  Object.values(historical.records).find(r => r.type === 'selection-policy')!.data.evaluator = 'unknown-selection/1';
  assert.throws(() => verifyMediationHistory(historical, f.issuer.projectId), code('BACKUP_INVALID'));
  function mediationSetupWithPolicy(policy: typeof p) {
    // Exercise the actual trusted runtime installation, retaining existing grants/authority.
    const m = f.engine.mediation!; const config = { ...f.config!, policies: [policy], generation: 2 };
    const Runtime = m.constructor as new (...args: any[]) => typeof m;
    return new Runtime(f.engine, f.issuer, f.issuer.resolve('fixture-bootstrap'), config).install('R0@1');
  }
});
test('counter traverses the Node broker and public CLI materialize/validate/Release path', async () => {
  const project = path.join(root, 'cli'); await mkdir(project);
  const broker = await startLocalBroker(path.join(project, 'state'), 0);
  try {
    const config = JSON.parse(await readFile('strata.config.json', 'utf8')); config.broker = broker.url; config.profiles = [COUNTER_PROFILE]; await writeFile(path.join(project, 'strata.config.json'), JSON.stringify(config));
    async function cli(args: string[], record?: unknown, session = 'fixture-preparer') {
      const result = await runCli([...args, '--project', project, '--json', '--offline', '--non-interactive'], record === undefined ? undefined : JSON.stringify(record), { ...process.env, STRATA_SESSION: session });
      assert.equal(result.exit_code, 0, JSON.stringify(result.errors)); return result.data;
    }
    await cli(['init', '--file', '-'], baseline, 'fixture-bootstrap'); const draft = await cli(['layer', 'create', '--file', '-'], layer, 'fixture-a'); await cli(['layer', 'publish', draft.ref], undefined, 'fixture-a');
    const target = await cli(['compose', '--file', '-'], recipe); const realized = await cli(['materialize', target.ref, '--profile', COUNTER_PROFILE, '--out', '.strata/counter']);
    const manifest = JSON.parse(await readFile(realized.manifest, 'utf8')), run = await runFixtureEvidence(path.dirname(realized.manifest), manifest.record, oracle(target.snapshot, 12));
    const evidenceFile = path.join(project, 'evidence.json'); await writeFile(evidenceFile, JSON.stringify(run.evidence)); const v = await cli(['validate', target.ref, '--realization', realized.manifest, '--evidence', evidenceFile], undefined, 'fixture-runner');
    const scope = await cli(['approve', '--file', '-'], { kind: 'scope', target: target.fingerprint, scope: 'counter', evidence_digest: v.evidence_digest }, 'fixture-selector');
    const releaseApproval = await cli(['approve', '--file', '-'], { kind: 'release', target: target.fingerprint, scope: null, evidence_digest: v.evidence_digest }, 'fixture-release');
    const released = await cli(['release', target.ref, '--validation', v.ref, '--approval', scope.ref, '--approval', releaseApproval.ref], undefined, 'fixture-release');
    const inherited = await cli(['compose', '--file', '-'], { ...recipe, id: 'CounterCliInherited', baseline: released.ref, proposals: [], selected: [] });
    assert.equal(inherited.snapshot.blocks.counter.requirements.limit.parameters.maximum, 12); assert.deepEqual(inherited.obligations.map((o: any) => o.item).sort(), expectedItems);
    observations.push({ case: 'counter-cli-release', candidate: target.fingerprint, release: released.ref, model: MODEL, profile: COUNTER_PROFILE, obligations: expectedItems });
  } finally { await broker.close(); }
  const bundle = path.join(project, 'bundle'), backup = await createBackup({ state: path.join(project, 'state'), out: bundle, project: JSON.parse(await readFile(path.join(project, 'strata.config.json'), 'utf8')).project_id, selector: 'fixture-backup', maxBytes: 8 * 1024 * 1024 });
  const verified = await verifyBackup({ bundle, project: backup.project_id, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 }); assert.equal(verified.verified, true);
  observations.push({ case: 'counter-backup-closure', verified: verified.verified, profile: COUNTER_PROFILE, manifest_sha256: backup.manifest_sha256 });
});
