// ZCode translation assignment: bounded bidirectional booking translation.
// Positive M1 exchange: generated implementation experiment -> explicit source
// manifest -> supplied expiry proposal -> exact review -> owned publication ->
// composition -> separate rematerialization -> fresh evidence and synthetic
// Release. M2 adds the separately owned reminder composition and the missing
// boundary regressions. Everything is a synthetic local fixture: no model,
// provider, credential or deployment surface is involved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startLocalBroker } from '../src/local-broker.js';
import { bootstrap, criterion, demoLayers } from '../src/fixtures.js';
import { bytesDigest, canonical, digest } from '../src/model.js';
import { expiryRequirement, timingRequirement } from '../src/profile.js';
import { fixtureOracle } from '../src/booking-checker.js';
import { runFixtureEvidence } from '../src/runner.js';
import { appCall, assertPriorArtifactsPreserved, makeCli, obligationMap, stateBytes, writeJson, type Broker, type Cli } from './zcode-translation-helpers.js';

let root: string;
let broker: Broker;
let cli: Cli;
const refusals: { case: string; exit: number; code: string }[] = [];
const facts: Record<string, unknown> = { scope: 'synthetic local fixture booking translation', started_at: new Date().toISOString(), refusals };
const refusal = (name: string, result: any) => { refusals.push({ case: name, exit: result.exit_code, code: result.errors?.[0]?.code ?? 'OK' }); return result; };
const S = (name: string) => path.join(root, name);

// Shared M1 state, populated by the ordered tests below.
let r0: any, r0RecordDigest: string, r0Manifest: any, m1RecordDigest = '';
let experimentBefore: Record<string, string>, experimentAfter: Record<string, string>;
let sourceManifest: any, checkedInProposal: any;
let draft: any, draftDigest: string;
let candidate: any, candidateManifest: any, rematerialized: any;
let validation: any, scopeApproval = '', releaseApproval = '', m1Release: any;
let reminderDraft: any, reminderCandidate: any, reminderManifest: any, reminderValidation: any, m2Release: any;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zcode-translation-'));
  broker = await startLocalBroker(path.join(root, 'state'), 0);
  const config = JSON.parse(await readFile('strata.config.json', 'utf8'));
  config.broker = broker.url;
  await writeFile(path.join(root, 'strata.config.json'), JSON.stringify(config));
  cli = makeCli(root);
  const init = await cli(['init', '--file', '-'], bootstrap(), 'fixture-bootstrap');
  assert.equal(init.exit_code, 0, JSON.stringify(init.errors));
  facts.environment = { node: process.version, platform: process.platform, root_pattern: 'os.tmpdir zcode-translation-*' };
});

after(async () => {
  facts.finished_at = new Date().toISOString();
  facts.counts = { refusals: refusals.length };
  try {
    const observations = path.resolve('.strata/zcode-translation');
    await mkdir(observations, { recursive: true });
    await writeFile(path.join(observations, `observations-${Date.now()}.json`), JSON.stringify(facts, null, 2));
  } catch { /* observation persistence must never mask test results */ }
  await broker?.close();
  // Recursive deletion only of this run's verified unique temp root.
  const resolved = path.resolve(root);
  assert.match(resolved, /[\\/]zcode-translation-/);
  assert.equal(path.dirname(resolved), os.tmpdir());
  await rm(resolved, { recursive: true, force: true });
});

test('M1: canonical R0@1 baseline is pinned and materialized with booking-node/3', async () => {
  r0 = (await cli(['conflicts', 'R0@1'], undefined, 'fixture-reader')).data;
  const hold = r0.snapshot.blocks['booking.hold'], reminder = r0.snapshot.blocks['booking.reminder'];
  assert.equal(hold.requirements.expiry.parameters.seconds, 600);
  assert.equal(reminder.requirements.timing.parameters.enabled, false);
  assert.equal(reminder.requirements.timing.parameters.lead_seconds, 60);
  assert.equal(hold.requirements.exclusive.parameters.exclusive, true);
  r0RecordDigest = digest((await cli(['inspect', 'release', 'R0@1'], undefined, 'fixture-reader')).data);
  const mat = await cli(['materialize', 'R0@1', '--profile', 'booking-node/3', '--out', '.strata/m1-realization'], undefined, 'fixture-preparer');
  assert.equal(mat.exit_code, 0, JSON.stringify(mat.errors));
  r0Manifest = JSON.parse(await readFile(mat.data.manifest, 'utf8')).record;
  assert.equal(r0Manifest.profile_id, 'booking-node/3');
  assert.equal(r0Manifest.format, 'strata-realization/2');
  assert.equal(r0Manifest.candidate, r0.fingerprint);
  for (const field of ['checker_sha256', 'fixture_sha256', 'oracle_sha256'] as const) assert.match(r0Manifest[field], /^[a-f0-9]{64}$/);
  assert.equal(r0Manifest.coverage.length, r0.obligations.length);
  const generated = await readFile(path.join(path.dirname(mat.data.manifest), 'booking.mjs'), 'utf8');
  assert.ok(generated.includes('"seconds":600'));
  // Literal 599/600 boundary checks on the baseline output itself, with the
  // runtime state file outside the pinned realization tree.
  const r0Output = path.join(root, '.strata', 'm1-realization');
  const runtimeR0 = S('runtime-r0.json');
  assert.deepEqual(await appCall(r0Output, runtimeR0, ['hold', 'room', 'one']), { accepted: true, expires: 600 });
  assert.equal((await appCall(r0Output, runtimeR0, ['hold', 'room', 'two'])).accepted, false);
  const at599 = await appCall(r0Output, runtimeR0, ['advance', '599']);
  assert.equal(Object.keys(at599.holds).length, 1);
  assert.equal(at599.reminders.length, 0);
  const at600 = await appCall(r0Output, runtimeR0, ['advance', '1']);
  assert.equal(Object.keys(at600.holds).length, 0);
  assert.equal(at600.reminders.length, 0);
  assert.equal((await appCall(r0Output, runtimeR0, ['hold', 'room', 'two'])).accepted, true);
  facts.baseline = { ref: 'R0@1', snapshot_sha256: digest(r0.snapshot), release_record_sha256: r0RecordDigest, expiry_seconds: 600, reminders: 'disabled', exclusive: true, obligations: r0.obligations.length, literal: { boundary: 'active at 599, expired at 600', exclusivity: 'competing hold refused', next_hold: 'accepted', reminders: 'zero', measured_from: 'pinned test constants, not generated configuration' } };
  facts.r0_realization = { ref: mat.data.ref, profile: r0Manifest.profile, profile_id: r0Manifest.profile_id, output_tree: r0Manifest.output_tree, checker_sha256: r0Manifest.checker_sha256, fixture_sha256: r0Manifest.fixture_sha256, oracle_sha256: r0Manifest.oracle_sha256, coverage_items: r0Manifest.coverage.length };
});

test('M1: isolated experiment changes only the explicit expiry configuration', async () => {
  const output = path.join(root, '.strata', 'm1-realization');
  experimentBefore = {}; experimentAfter = {};
  const changes: unknown[] = [];
  for (const name of ['booking.mjs', 'intent.json']) {
    const before = await readFile(path.join(output, name), 'utf8');
    assert.equal(before.split('"seconds":600').length - 1, 1, `expected exactly one 600-second config occurrence in ${name}`);
    const after = before.replaceAll('"seconds":600', '"seconds":900');
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
    experimentBefore[name] = bytesDigest(before); experimentAfter[name] = bytesDigest(after);
    changes.push({ path: name, before_sha256: experimentBefore[name], after_sha256: experimentAfter[name], change: '"seconds":600 -> "seconds":900', occurrences: 1, bytes_before: Buffer.byteLength(before), bytes_after: Buffer.byteLength(after) });
  }
  const experiment = path.join(root, 'experiment');
  await mkdir(experiment);
  for (const name of ['booking.mjs', 'intent.json']) {
    const before = await readFile(path.join(output, name), 'utf8');
    await writeFile(path.join(experiment, name), before.replaceAll('"seconds":600', '"seconds":900'));
  }
  assert.equal(await readFile(path.join(experiment, 'booking.mjs'), 'utf8'), (await readFile(path.join(output, 'booking.mjs'), 'utf8')).replaceAll('"seconds":600', '"seconds":900'));
  sourceManifest = { root: 'experiment', files: [{ path: 'booking.mjs', digest: experimentAfter['booking.mjs'] }, { path: 'intent.json', digest: experimentAfter['intent.json'] }] };
  await writeJson(S('m1-source.json'), sourceManifest);
  checkedInProposal = JSON.parse(await readFile(path.resolve('tests/fixtures/zcode-translation/expiry-proposal.json'), 'utf8'));
  await writeJson(S('m1-proposal.json'), checkedInProposal);
  assert.deepEqual(checkedInProposal.layer.changes[0].expected.value, expiryRequirement(600));
  // Literal 899/900 boundary checks on the isolated experiment itself (the
  // known local booking fixture with only the expiry configuration changed).
  // Runtime state stays outside the experiment tree, and the declared bytes
  // are re-hashed afterwards to prove execution did not mutate the source.
  const runtimeExperiment = S('runtime-experiment.json');
  const experimentOutput = path.join(root, 'experiment');
  assert.deepEqual(await appCall(experimentOutput, runtimeExperiment, ['hold', 'room', 'one']), { accepted: true, expires: 900 });
  assert.equal((await appCall(experimentOutput, runtimeExperiment, ['hold', 'room', 'two'])).accepted, false);
  const experimentAt899 = await appCall(experimentOutput, runtimeExperiment, ['advance', '899']);
  assert.equal(Object.keys(experimentAt899.holds).length, 1);
  assert.equal(experimentAt899.reminders.length, 0);
  const experimentAt900 = await appCall(experimentOutput, runtimeExperiment, ['advance', '1']);
  assert.equal(Object.keys(experimentAt900.holds).length, 0);
  assert.equal(experimentAt900.reminders.length, 0);
  assert.equal((await appCall(experimentOutput, runtimeExperiment, ['hold', 'room', 'two'])).accepted, true);
  for (const name of ['booking.mjs', 'intent.json']) assert.equal(bytesDigest(await readFile(path.join(experimentOutput, name), 'utf8')), experimentAfter[name], `execution mutated declared source bytes: ${name}`);
  facts.experiment = { isolated_directory: 'experiment (inside the synthetic project root)', files: changes, reminders_in_experiment: 'disabled (only the expiry configuration changed)', literal: { boundary: 'active at 899, expired at 900', exclusivity: 'competing hold refused', next_hold: 'accepted', reminders: 'zero', measured_from: 'pinned test constants, not experiment configuration', bytes_unchanged_by_execution: true } };
  facts.source_manifest = { ...sourceManifest, source_digest: digest(sourceManifest) };
});

test('M1: dist dry-run leaves semantic, index, artifact and output-path bytes unchanged', async () => {
  const state = await stateBytes(root);
  const strataListing = (await readdir(path.join(root, '.strata'))).sort();
  const dry = await cli(['dist', '--source', S('m1-source.json'), '--against', 'R0@1', '--layer', 'L-translation-expiry', '--proposal', S('m1-proposal.json'), '--dry-run'], undefined, 'fixture-a');
  assert.equal(dry.exit_code, 0, JSON.stringify(dry.errors));
  assert.equal(dry.mode, 'dry_run');
  assert.equal(dry.data.classification, 'supplied_proposal');
  assert.equal(dry.data.review_required, true);
  assert.deepEqual(dry.effects.created, []);
  assert.deepEqual(dry.effects.paths, []);
  assert.deepEqual(await stateBytes(root), state);
  assert.deepEqual((await readdir(path.join(root, '.strata'))).sort(), strataListing);
  assert.equal((await cli(['inspect', 'layer', 'L-translation-expiry@1'], undefined, 'fixture-a')).exit_code, 3);
});

test('source confinement and identity refusals leave the semantic store unchanged', async () => {
  const proposalFor = (layerId: string, files = ['booking.mjs', 'intent.json']) => {
    const layer = structuredClone(checkedInProposal.layer); layer.id = layerId;
    return { layer, traceability: [{ item: 'booking.hold/requirements.expiry', classification: 'observed', rationale: 'Declared experiment bytes.', files }], questions: [] };
  };
  const run = async (name: string, manifest: any, layerId: string, proposal: any, expectedCode: string, expectedExit: number) => {
    const state = await stateBytes(root);
    await writeJson(S('case-source.json'), manifest); await writeJson(S('case-proposal.json'), proposal);
    const result = await cli(['dist', '--source', S('case-source.json'), '--against', 'R0@1', '--layer', layerId, '--proposal', S('case-proposal.json')], undefined, 'fixture-a');
    refusal(name, result);
    assert.equal(result.exit_code, expectedExit, `${name}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.errors[0].code, expectedCode, name);
    assert.deepEqual(await stateBytes(root), state, `${name} changed semantic/index/artifact bytes`);
  };
  const booking = { path: 'booking.mjs', digest: experimentAfter['booking.mjs'] };
  const intent = { path: 'intent.json', digest: experimentAfter['intent.json'] };
  await run('empty-files', { root: 'experiment', files: [] }, 'L-t-empty', proposalFor('L-t-empty'), 'INVALID_RECORD', 2);
  await run('unknown-manifest-key', { root: 'experiment', files: [booking], extra: 1 }, 'L-t-key', proposalFor('L-t-key', ['booking.mjs']), 'INVALID_RECORD', 2);
  await run('missing-declared-file', { root: 'experiment', files: [booking, { path: 'absent.txt', digest: '0'.repeat(64) }] }, 'L-t-missing', proposalFor('L-t-missing'), 'INTERNAL_ERROR', 1);
  await run('duplicate-identical-path', { root: 'experiment', files: [booking, structuredClone(booking)] }, 'L-t-dup', proposalFor('L-t-dup'), 'INVALID_RECORD', 2);
  await run('traversal-root', { root: '..', files: [{ path: 'package.json', digest: '0'.repeat(64) }] }, 'L-t-trav', proposalFor('L-t-trav', ['package.json']), 'INVALID_PATH', 2);
  await run('outside-root-absolute', { root: path.parse(root).root, files: [{ path: 'windows/system32/config.sys', digest: '0'.repeat(64) }] }, 'L-t-abs', proposalFor('L-t-abs', ['windows/system32/config.sys']), 'INVALID_PATH', 2);
  let junction = true;
  try { (await import('node:fs')).symlinkSync(path.join(root, 'experiment'), path.join(root, 'experiment-link'), 'junction'); }
  catch { junction = false; refusals.push({ case: 'junction-root', exit: -1, code: 'SKIPPED-EPERM-ON-HOST' }); }
  if (junction) await run('junction-root', { root: 'experiment-link', files: [booking] }, 'L-t-link', proposalFor('L-t-link', ['booking.mjs']), 'INVALID_PATH', 2);
  // Deterministic source-byte mutation with the previously valid manifest:
  // the bytes change, the manifest does not, and the refusal leaves no trace.
  {
    const state = await stateBytes(root);
    const intentFile = path.join(root, 'experiment', 'intent.json');
    const cleanIntent = await readFile(intentFile, 'utf8');
    await writeFile(intentFile, cleanIntent.replaceAll('"seconds":900', '"seconds":901'));
    await writeJson(S('case-source.json'), sourceManifest); await writeJson(S('case-proposal.json'), proposalFor('L-t-stale'));
    const stale = await cli(['dist', '--source', S('case-source.json'), '--against', 'R0@1', '--layer', 'L-t-stale', '--proposal', S('case-proposal.json')], undefined, 'fixture-a');
    await writeFile(intentFile, cleanIntent);
    refusal('stale-source-byte-mutation-old-manifest', stale);
    assert.equal(stale.exit_code, 5, JSON.stringify(stale.errors));
    assert.equal(stale.errors[0].code, 'STALE_SOURCE');
    assert.deepEqual(await stateBytes(root), state, 'stale-source refusal changed state');
  }
  // Multiple spellings of one confined file are refused before draft creation,
  // with complete state preservation and no draft stored (resolved shared-core
  // change implemented in src/cli.ts under extended ownership).
  const aliasSpellings = ['./booking.mjs', 'sub/../booking.mjs', ...(process.platform === 'win32' || process.platform === 'darwin' ? ['BOOKING.MJS'] : [])];
  for (const [index, spelling] of aliasSpellings.entries()) {
    await run('alias-spelling-refused-' + index, { root: 'experiment', files: [booking, { path: spelling, digest: experimentAfter['booking.mjs'] }, intent] }, 'L-translation-alias-' + index, proposalFor('L-translation-alias-' + index), 'INVALID_RECORD', 2);
  }
  // Supported alternative spellings used alone remain valid single declarations.
  for (const [index, spelling] of aliasSpellings.entries()) {
    const loneManifest = { root: 'experiment', files: [{ path: spelling, digest: experimentAfter['booking.mjs'] }, intent] };
    const layerId = 'L-translation-lone-' + index;
    await writeJson(S('case-source.json'), loneManifest); await writeJson(S('case-proposal.json'), proposalFor(layerId, [spelling, 'intent.json']));
    const lone = await cli(['dist', '--source', S('case-source.json'), '--against', 'R0@1', '--layer', layerId, '--proposal', S('case-proposal.json')], undefined, 'fixture-a');
    assert.equal(lone.exit_code, 0, `${spelling} alone: ${JSON.stringify(lone.errors)}`);
    assert.equal(lone.data.source_digest, digest(loneManifest));
  }
  // Byte mismatches for unique files still refuse STALE_SOURCE; only duplicate
  // aliases refuse earlier with INVALID_RECORD.
  await run('unique-file-digest-mismatch', { root: 'experiment', files: [booking, { path: 'intent.json', digest: bytesDigest('other') }] }, 'L-t-aliasbad', proposalFor('L-t-aliasbad'), 'STALE_SOURCE', 5);
  // Undeclared inputs are outside the hashed claim: an extra undeclared file
  // neither fails the run nor changes the manifest digest.
  await writeFile(path.join(root, 'experiment', 'scratch-undeclared.txt'), 'not declared');
  await writeJson(S('case-source.json'), sourceManifest); await writeJson(S('case-proposal.json'), proposalFor('L-translation-undeclared'));
  const undeclared = await cli(['dist', '--source', S('case-source.json'), '--against', 'R0@1', '--layer', 'L-translation-undeclared', '--proposal', S('case-proposal.json')], undefined, 'fixture-a');
  assert.equal(undeclared.exit_code, 0, JSON.stringify(undeclared.errors));
  assert.equal(undeclared.data.source_digest, digest(sourceManifest));
  (facts as any).source_observations = {
    alias_spellings: { covered: aliasSpellings, behavior: 'multiple spellings of one confined file refuse INVALID_RECORD exit 2 before draft creation with full state preservation and no draft; a spelling used alone remains a valid single declaration', resolution: 'implemented in src/cli.ts ; translation/README.md records the resolution' },
    undeclared_extra_file: 'ignored by hashing; source_digest stays digest(manifest)',
    missing_file_surface: 'INTERNAL_ERROR exit 1 carrying raw ENOENT (fail-closed, no state change)',
    deterministic_mutation: 'declared bytes mutated with the previously valid manifest refuse STALE_SOURCE with no state change',
  };
});

test('drift timing: deterministic probe of the read-to-draft interval (no atomic freeze claimed)', async () => {
  // The CLI hashes every declared file once, then performs the broker target
  // lookup, then creates the draft. This probe mutates the declared bytes
  // deterministically inside that interval - hooked to the first broker call,
  // never to a timer - and observes that the run still stores the draft bound
  // to the manifest digests. No atomic frozen source tree exists or is claimed;
  // the next run with the same manifest re-hashes and refuses.
  const experimentFile = path.join(root, 'experiment', 'booking.mjs');
  const clean = await readFile(experimentFile, 'utf8');
  const realFetch = globalThis.fetch;
  let mutatedInsideInterval = false;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!mutatedInsideInterval && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        if (body.command === 'conflicts') {
          mutatedInsideInterval = true;
          await writeFile(experimentFile, clean + '// deterministic interval drift');
        }
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const proposalForInterval = structuredClone(checkedInProposal);
    proposalForInterval.layer.id = 'L-translation-interval';
    await writeJson(S('interval-proposal.json'), proposalForInterval);
    const before = await stateBytes(root);
    const result = await cli(['dist', '--source', S('m1-source.json'), '--against', 'R0@1', '--layer', 'L-translation-interval', '--proposal', S('interval-proposal.json')], undefined, 'fixture-a');
    assert.equal(mutatedInsideInterval, true, 'mutation did not land inside the read-to-draft interval');
    assert.equal(result.exit_code, 0, JSON.stringify(result.errors));
    assert.equal(result.data.source_digest, digest(sourceManifest));
    assertPriorArtifactsPreserved(before, await stateBytes(root), 'interval draft append');
    // The very next run with the same previously valid manifest re-hashes the
    // live bytes and refuses, which is the only revalidation that exists.
    await writeJson(S('interval-proposal2.json'), { ...structuredClone(proposalForInterval), layer: { ...structuredClone(proposalForInterval.layer), id: 'L-translation-interval2' } });
    const rehash = await cli(['dist', '--source', S('m1-source.json'), '--against', 'R0@1', '--layer', 'L-translation-interval2', '--proposal', S('interval-proposal2.json')], undefined, 'fixture-a');
    refusal('post-interval-rehash-refuses', rehash);
    assert.equal(rehash.exit_code, 5);
    assert.equal(rehash.errors[0].code, 'STALE_SOURCE');
  } finally {
    globalThis.fetch = realFetch;
    await writeFile(experimentFile, clean);
  }
  const stored = (await cli(['inspect', 'layer', 'L-translation-interval@1'], undefined, 'fixture-a')).data;
  assert.equal(stored.derived_from.source_digest, digest(sourceManifest));
  (facts as any).read_to_draft_interval = {
    probe: 'declared bytes mutated deterministically between per-file hashing and draft creation (hooked to the broker target lookup, not a timer)',
    observed: 'draft stored with the manifest source_digest despite mid-interval drift',
    claim: 'no atomic frozen source tree; per-run re-hashing is the only revalidation; publication later checks stored digests only',
  };
});

test('alias refusal regression: multiple spellings of one confined file are refused before draft creation', async () => {
  // Formerly the retained reproducer of an unresolved acceptance requirement.
  // The host extended ownership to src/cli.ts and the refusal is now
  // implemented with filesystem-aware canonical identity (realpath); see
  // translation/README.md for the resolution record.
  const refusalProposal = structuredClone(checkedInProposal);
  refusalProposal.layer.id = 'L-translation-repro';
  const reproManifest = { root: 'experiment', files: [{ path: 'booking.mjs', digest: experimentAfter['booking.mjs'] }, { path: './booking.mjs', digest: experimentAfter['booking.mjs'] }, { path: 'intent.json', digest: experimentAfter['intent.json'] }] };
  const state = await stateBytes(root);
  await writeJson(S('repro-source.json'), reproManifest); await writeJson(S('repro-proposal.json'), refusalProposal);
  const result = await cli(['dist', '--source', S('repro-source.json'), '--against', 'R0@1', '--layer', 'L-translation-repro', '--proposal', S('repro-proposal.json')], undefined, 'fixture-a');
  refusal('alias-refusal-regression', result);
  assert.equal(result.exit_code, 2, JSON.stringify(result.errors));
  assert.equal(result.errors[0].code, 'INVALID_RECORD');
  assert.deepEqual(await stateBytes(root), state, 'alias refusal changed semantic/index/artifact bytes');
  assert.equal((await cli(['inspect', 'layer', 'L-translation-repro@1'], undefined, 'fixture-a')).exit_code, 3);
  (facts as any).alias_refusal_resolution = { requirement: 'acceptance matrix source-confinement row: duplicate/aliased manifest files must be refused', implemented: 'src/cli.ts distill manifest validation (realpath-based canonical identity)', behavior: 'INVALID_RECORD exit 2 before draft creation, complete state preservation, no draft', controls: 'supported alternative spellings used alone still distill; unique-file byte mismatches still refuse STALE_SOURCE', record: 'translation/README.md' };
});

test('proposal shape, traceability and baseline refusals create no publishable draft', async () => {
  const proposalWith = (layerId: string, mutate: (proposal: any) => void) => {
    const proposal = structuredClone(checkedInProposal); proposal.layer.id = layerId; mutate(proposal);
    return proposal;
  };
  const run = async (name: string, layerId: string, proposal: any, expectedCode: string, expectedExit: number) => {
    const state = await stateBytes(root);
    await writeJson(S('case-proposal.json'), proposal);
    const args = ['dist', '--source', S('m1-source.json'), '--against', 'R0@1', '--layer', layerId, '--proposal', S('case-proposal.json')];
    const result = await cli(args, undefined, 'fixture-a');
    refusal(name, result);
    assert.equal(result.exit_code, expectedExit, `${name}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.errors[0].code, expectedCode, name);
    assert.deepEqual(await stateBytes(root), state, `${name} changed state`);
    assert.equal((await cli(['inspect', 'layer', `${layerId}@1`], undefined, 'fixture-a')).exit_code, 3, `${name} stored a draft`);
  };
  await run('missing-trace', 'L-t-notrace', proposalWith('L-t-notrace', p => { p.traceability = []; }), 'TRACEABILITY_REQUIRED', 2);
  await run('duplicate-trace', 'L-t-duptrace', proposalWith('L-t-duptrace', p => { p.traceability.push(structuredClone(p.traceability[0])); }), 'TRACEABILITY_REQUIRED', 2);
  await run('unlisted-trace-file', 'L-t-unlisted', proposalWith('L-t-unlisted', p => { p.traceability[0].files = ['undeclared.txt']; }), 'TRACEABILITY_REQUIRED', 2);
  await run('unknown-proposal-field', 'L-t-field', proposalWith('L-t-field', p => { (p as any).method = 'inferred'; }), 'INVALID_RECORD', 2);
  await run('layer-id-mismatch', 'L-t-wrongid', proposalWith('L-t-other', () => {}), 'INVALID_RECORD', 2);
  await run('wrong-baseline', 'L-t-baseline', proposalWith('L-t-baseline', p => { p.layer.baseline = 'R9@1'; }), 'MIXED_BASELINE', 5);
  await run('wrong-precondition', 'L-t-precondition', proposalWith('L-t-precondition', p => { p.layer.changes[0].expected.value.parameters.seconds = 601; }), 'BASELINE_PRECONDITION', 5);
  await run('wrong-owner', 'L-t-owner', proposalWith('L-t-owner', p => { p.layer.owner = 'author-b'; }), 'OWNER_FORBIDDEN', 4);
});

test('M1: apply creates an owned private supplied_proposal draft and preserves the baseline', async () => {
  const beforeApply = await stateBytes(root);
  const apply = await cli(['dist', '--source', S('m1-source.json'), '--against', 'R0@1', '--layer', 'L-translation-expiry', '--proposal', S('m1-proposal.json')], undefined, 'fixture-a');
  assert.equal(apply.exit_code, 0, JSON.stringify(apply.errors));
  assertPriorArtifactsPreserved(beforeApply, await stateBytes(root), 'distill apply append');
  assert.equal(apply.command, 'distill');
  assert.equal(apply.data.ref, 'L-translation-expiry@1');
  assert.equal(apply.data.published, false);
  assert.equal(apply.data.classification, 'supplied_proposal');
  assert.equal(apply.data.review_required, true);
  assert.equal(apply.data.source_digest, digest(sourceManifest));
  draft = (await cli(['inspect', 'layer', 'L-translation-expiry@1'], undefined, 'fixture-a')).data;
  draftDigest = digest(draft);
  assert.equal(draft.owner, 'author-a');
  assert.equal(draft.baseline, 'R0@1');
  assert.equal(draft.derived_from.kind, 'supplied_proposal');
  assert.equal(draft.derived_from.against, 'R0@1');
  assert.equal(draft.derived_from.source_digest, digest(sourceManifest));
  assert.deepEqual(draft.derived_from.questions, []);
  assert.equal(draft.derived_from.traceability.length, 1);
  assert.deepEqual(draft.derived_from.traceability[0].files, ['booking.mjs', 'intent.json']);
  assert.equal(draft.changes[0].expected.value.parameters.seconds, 600);
  assert.equal(draft.changes[0].value.parameters.seconds, 900);
  // Peer boundary: the private draft and its head belong to author-a only.
  assert.equal((await cli(['inspect', 'layer', 'L-translation-expiry@1'], undefined, 'fixture-b')).exit_code, 3);
  refusal('peer-publish', await cli(['layer', 'publish', 'L-translation-expiry@1'], undefined, 'fixture-b'));
  assert.equal(refusals.at(-1)!.exit, 4);
  refusal('peer-revise', await cli(['layer', 'revise', 'L-translation-expiry@1', '--file', '-'], { ...structuredClone(draft), revision: 2, owner: 'author-b' }, 'fixture-b'));
  assert.equal(refusals.at(-1)!.exit, 4);
  assert.equal(digest((await cli(['inspect', 'release', 'R0@1'], undefined, 'fixture-reader')).data), r0RecordDigest);
  facts.m1_draft = { ref: 'L-translation-expiry@1', draft_sha256: draftDigest, source_digest: draft.derived_from.source_digest, owner: draft.owner, published: false };
});

test('M1: exact review gates precede publication; publication checks stored digests, not source files', async () => {
  const reviewFile = S('m1-review.json');
  const attempt = async (name: string, review: any) => {
    const state = await stateBytes(root);
    const args = ['layer', 'publish', 'L-translation-expiry@1'];
    if (review !== null) { await writeJson(reviewFile, review); args.push('--review', reviewFile); }
    const result = await cli(args, undefined, 'fixture-a');
    refusal(name, result);
    assert.equal(result.exit_code, 6, `${name}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.errors[0].code, 'DISTILL_REVIEW_REQUIRED', name);
    assert.deepEqual(await stateBytes(root), state, `${name} changed state`);
  };
  await attempt('review-missing', null);
  await attempt('review-rejected', { source_digest: draft.derived_from.source_digest, draft_digest: draftDigest, reviewer: 'author-a', accepted: false });
  await attempt('review-wrong-source-digest', { source_digest: 'f'.repeat(64), draft_digest: draftDigest, reviewer: 'author-a', accepted: true });
  await attempt('review-wrong-draft-digest', { source_digest: draft.derived_from.source_digest, draft_digest: 'a'.repeat(64), reviewer: 'author-a', accepted: true });
  await attempt('review-wrong-reviewer', { source_digest: draft.derived_from.source_digest, draft_digest: draftDigest, reviewer: 'author-b', accepted: true });
  // Distinct, labeled behavior: after the draft exists, publication compares
  // the stored source manifest digest and exact draft digest; it never reopens
  // the source files. The declared bytes are deliberately drifted here.
  const experimentFile = path.join(root, 'experiment', 'booking.mjs');
  const clean = await readFile(experimentFile, 'utf8');
  await writeFile(experimentFile, clean + '// drifted after draft creation');
  await writeJson(reviewFile, { source_digest: draft.derived_from.source_digest, draft_digest: draftDigest, reviewer: 'author-a', accepted: true });
  const beforePublish = await stateBytes(root);
  const publish = await cli(['layer', 'publish', 'L-translation-expiry@1', '--review', reviewFile], undefined, 'fixture-a');
  await writeFile(experimentFile, clean);
  assert.equal(publish.exit_code, 0, JSON.stringify(publish.errors));
  assert.equal(publish.data.published, true);
  assertPriorArtifactsPreserved(beforePublish, await stateBytes(root), 'publish append');
  assert.equal(digest((await cli(['inspect', 'release', 'R0@1'], undefined, 'fixture-reader')).data), r0RecordDigest);
  (facts as any).publication_behavior = 'stored source/draft digests only; source bytes drifted after draft creation did not block the exact accepted review';
});

test('M1: composition conserves every obligation and rematerialization changes only the expiry item', async () => {
  const recipe = { id: 'C-translation-expiry', revision: 1, model_version: bootstrap().model_version, baseline: 'R0@1', proposals: ['L-translation-expiry@1'], selected: ['L-translation-expiry@1'], alternative_groups: [], scenario: { id: 'booking-demo', checks: [{ id: 'booking.compatibility', version: '1' }] }, resolutions: [] };
  const composeBefore = await stateBytes(root);
  const composed = await cli(['compose', '--file', '-'], recipe, 'fixture-preparer');
  assert.equal(composed.exit_code, 0, JSON.stringify(composed.errors));
  assertPriorArtifactsPreserved(composeBefore, await stateBytes(root), 'composition append');
  candidate = composed.data;
  assert.equal(candidate.state, 'eligible_for_validation');
  assert.equal(candidate.scope, 'booking');
  // Complete obligation comparison: exactly the expiry item changed.
  const expected = { ...obligationMap(r0.obligations), 'booking.hold/requirements.expiry': expiryRequirement(900) };
  assert.equal(candidate.obligations.length, r0.obligations.length);
  assert.equal(canonical(obligationMap(candidate.obligations)), canonical(expected));
  assert.equal(candidate.snapshot.blocks['booking.reminder'].requirements.timing.parameters.enabled, false);
  assert.deepEqual(candidate.provenance, { 'booking.hold/requirements.expiry': ['L-translation-expiry@1'] });
  const mat = await cli(['materialize', candidate.ref, '--profile', 'booking-node/3', '--out', '.strata/m1-rematerialized'], undefined, 'fixture-preparer');
  assert.equal(mat.exit_code, 0, JSON.stringify(mat.errors));
  assertPriorArtifactsPreserved(composeBefore, await stateBytes(root), 'realization registration append');
  rematerialized = mat.data;
  candidateManifest = JSON.parse(await readFile(mat.data.manifest, 'utf8')).record;
  assert.equal(candidateManifest.candidate, candidate.fingerprint);
  assert.notEqual(candidateManifest.output_tree, r0Manifest.output_tree);
  assert.equal(candidateManifest.checker_sha256, r0Manifest.checker_sha256);
  assert.notEqual(candidateManifest.oracle_sha256, r0Manifest.oracle_sha256);
  const generated = await readFile(path.join(path.dirname(mat.data.manifest), 'booking.mjs'), 'utf8');
  assert.ok(generated.includes('"seconds":900'));
  assert.ok(generated.includes('"enabled":false'));
  // Repeats require a distinct empty output.
  refusal('nonempty-output', await cli(['materialize', candidate.ref, '--profile', 'booking-node/3', '--out', '.strata/m1-rematerialized'], undefined, 'fixture-preparer'));
  assert.equal(refusals.at(-1)!.exit, 5);
  assert.equal(refusals.at(-1)!.code, 'OUTPUT_EXISTS');
  facts.m1_candidate = { ref: candidate.ref, fingerprint: candidate.fingerprint, obligations: candidate.obligations.length, changed_items: ['booking.hold/requirements.expiry'], provenance: candidate.provenance, rematerialized: { ref: mat.data.ref, profile: candidateManifest.profile, output_tree: candidateManifest.output_tree, checker_sha256: candidateManifest.checker_sha256, fixture_sha256: candidateManifest.fixture_sha256, oracle_sha256: candidateManifest.oracle_sha256 } };
});

test('M1: literal 899/900 boundaries, exclusivity, next hold and zero reminders', async () => {
  const output = path.join(root, '.strata', 'm1-rematerialized');
  const runtime = S('runtime-m1.json');
  const first = await appCall(output, runtime, ['hold', 'room', 'one']);
  assert.deepEqual(first, { accepted: true, expires: 900 });
  assert.equal((await appCall(output, runtime, ['hold', 'room', 'two'])).accepted, false);
  const at899 = await appCall(output, runtime, ['advance', '899']);
  assert.equal(Object.keys(at899.holds).length, 1);
  assert.equal(at899.reminders.length, 0);
  const at900 = await appCall(output, runtime, ['advance', '1']);
  assert.equal(Object.keys(at900.holds).length, 0);
  assert.equal(at900.reminders.length, 0);
  assert.equal((await appCall(output, runtime, ['hold', 'room', 'two'])).accepted, true);
  assert.equal((await appCall(output, runtime, ['advance', '0'])).reminders.length, 0);
  (facts as any).m1_literal = { expiry_boundary: 'active at 899, expired at 900', exclusivity: 'competing hold refused', next_hold: 'accepted', reminders: 'zero (baseline reminder intent disabled)', measured_from: 'pinned test constants, not generated configuration' };
});

test('M1: fresh format-2 evidence binds exactly; approvals gate an immutable synthetic Release', async () => {
  const output = path.join(root, '.strata', 'm1-rematerialized');
  const run = await runFixtureEvidence(output, candidateManifest, fixtureOracle(candidate.snapshot));
  assert.ok(run.evidence.results.every((r: any) => r.passed));
  assert.equal((run.evidence as any).format, 'strata-fixture-evidence/2');
  assert.equal((run.evidence as any).checker_sha256, candidateManifest.checker_sha256);
  assert.equal((run.evidence as any).fixture_sha256, candidateManifest.fixture_sha256);
  assert.equal((run.evidence as any).oracle_sha256, candidateManifest.oracle_sha256);
  assert.equal(run.evidence.candidate, candidate.fingerprint);
  await writeJson(S('m1-evidence.json'), run.evidence);
  const arbitrary = { ...run.evidence, executor: 'arbitrary-pass' };
  await writeJson(S('m1-evidence-arbitrary.json'), arbitrary);
  refusal('arbitrary-executor', await cli(['validate', candidate.ref, '--realization', rematerialized.manifest, '--evidence', S('m1-evidence-arbitrary.json')], undefined, 'fixture-runner'));
  assert.equal(refusals.at(-1)!.exit, 4);
  assert.equal(refusals.at(-1)!.code, 'EVIDENCE_PRODUCER_FORBIDDEN');
  const validateBefore = await stateBytes(root);
  validation = (await cli(['validate', candidate.ref, '--realization', rematerialized.manifest, '--evidence', S('m1-evidence.json')], undefined, 'fixture-runner')).data;
  assert.equal(validation.checks_passed, true);
  assert.equal(validation.approvals_pending, true);
  assertPriorArtifactsPreserved(validateBefore, await stateBytes(root), 'validation append');
  refusal('release-without-approvals', await cli(['release', candidate.ref, '--validation', validation.ref], undefined, 'fixture-release'));
  assert.equal(refusals.at(-1)!.exit, 6);
  assert.equal(refusals.at(-1)!.code, 'ENDORSEMENT_REQUIRED');
  refusal('approval-wrong-evidence-digest', await cli(['approve', '--file', '-'], { kind: 'release', target: candidate.fingerprint, scope: null, evidence_digest: '0'.repeat(64) }, 'fixture-release'));
  assert.equal(refusals.at(-1)!.exit, 6);
  assert.equal(refusals.at(-1)!.code, 'VALIDATION_REQUIRED');
  scopeApproval = (await cli(['approve', '--file', '-'], { kind: 'scope', target: candidate.fingerprint, scope: candidate.scope, evidence_digest: validation.evidence_digest }, 'fixture-selector')).data.ref;
  releaseApproval = (await cli(['approve', '--file', '-'], { kind: 'release', target: candidate.fingerprint, scope: null, evidence_digest: validation.evidence_digest }, 'fixture-release')).data.ref;
  const releaseArgs = ['release', candidate.ref, '--validation', validation.ref, '--approval', scopeApproval, '--approval', releaseApproval];
  const releaseBefore = await stateBytes(root);
  m1Release = (await cli(releaseArgs, undefined, 'fixture-release')).data;
  assert.equal(m1Release.state, 'validated');
  assertPriorArtifactsPreserved(releaseBefore, await stateBytes(root), 'release append');
  const retry = (await cli(releaseArgs, undefined, 'fixture-release')).data;
  assert.equal(retry.ref, m1Release.ref);
  assert.equal(retry.reused, true);
  const record = (await cli(['inspect', 'release', m1Release.ref], undefined, 'fixture-reader')).data;
  assert.equal(canonical(record.acceptance_manifest), canonical(candidate.obligations));
  assert.equal(canonical(record.provenance), canonical(candidate.provenance));
  assert.deepEqual(record.lineage, ['L-translation-expiry@1']);
  m1RecordDigest = digest(record);
  assert.equal(digest((await cli(['inspect', 'release', 'R0@1'], undefined, 'fixture-reader')).data), r0RecordDigest);
  facts.m1_validation = { validation_ref: validation.ref, evidence_digest: validation.evidence_digest, evidence_format: 'strata-fixture-evidence/2', scope_approval: scopeApproval, release_approval: releaseApproval, release_ref: m1Release.ref, release_record_sha256: m1RecordDigest, release_reused_on_retry: true, baseline_unchanged: true };
});

test('M2: reminder authoring is dependency-bound; conflicts and omissions block composition', async () => {
  const reminder = structuredClone(demoLayers().b);
  reminder.id = 'L-translation-reminder';
  reminder.intent = 'Enable one reminder 60 seconds before the 900-second hold expiry, depending on the exact published expiry Layer.';
  reminder.requires_layers = ['L-translation-expiry@1'];
  reminder.read_set = [{ layer: 'L-translation-expiry@1', mode: 'required' }];
  reminder.assumptions = [{ block: 'booking.hold', path: 'requirements.expiry', expected: { kind: 'value', value: expiryRequirement(900) } }];
  reminderDraft = (await cli(['layer', 'create', '--file', '-'], reminder, 'fixture-b')).data;
  assert.equal(reminderDraft.ref, 'L-translation-reminder@1');
  assert.equal((await cli(['layer', 'publish', 'L-translation-reminder@1'], undefined, 'fixture-b')).exit_code, 0);
  const blockedCompose = async (name: string, recipe: any, codes: string[]) => {
    const composed = await cli(['compose', '--file', '-'], recipe, 'fixture-preparer');
    refusal(name, composed);
    assert.equal(composed.exit_code, 5, `${name}: ${JSON.stringify(composed.errors)}`);
    for (const code of codes) assert.ok(composed.data.diagnostics.some((d: any) => d.code === code), `${name} missing ${code}`);
    assert.equal(composed.data.state, 'blocked');
    return composed;
  };
  const child = (id: string, proposals: string[], selected = proposals) => ({ id, revision: 1, model_version: bootstrap().model_version, baseline: 'R0@1', proposals, selected, alternative_groups: [], scenario: { id: 'booking-demo', checks: [{ id: 'booking.compatibility', version: '1' }] }, resolutions: [] });
  const missing = await blockedCompose('reminder-missing-dependency', child('C-m2-missing', ['L-translation-reminder@1']), ['MISSING_DEPENDENCY']);
  refusal('materialize-blocked', await cli(['materialize', missing.data.ref, '--profile', 'booking-node/3', '--out', '.strata/m2-blocked'], undefined, 'fixture-preparer'));
  assert.equal(refusals.at(-1)!.exit, 5);
  assert.equal(refusals.at(-1)!.code, 'BLOCKED_CANDIDATE');
  await assert.rejects(access(path.join(root, '.strata', 'm2-blocked')));
  // A reminder pinned to a not-yet-published revision cannot even be authored.
  const wrongPin = structuredClone(reminder); wrongPin.id = 'L-translation-reminder-wrongpin';
  wrongPin.requires_layers = ['L-translation-expiry@2'];
  wrongPin.read_set = [{ layer: 'L-translation-expiry@2', mode: 'required' }];
  refusal('dependency-on-absent-revision', await cli(['layer', 'create', '--file', '-'], wrongPin, 'fixture-b'));
  assert.equal(refusals.at(-1)!.exit, 3);
  assert.equal(refusals.at(-1)!.code, 'REF_NOT_FOUND');
  // Conflicting expiry proposals stay visible in the considered set.
  const conflict = structuredClone(demoLayers().c);
  conflict.id = 'L-translation-expiry-conflict';
  conflict.intent = 'Competing proposal: extend the hold to 1200 seconds instead.';
  await cli(['layer', 'create', '--file', '-'], conflict, 'fixture-c');
  assert.equal((await cli(['layer', 'publish', 'L-translation-expiry-conflict@1'], undefined, 'fixture-c')).exit_code, 0);
  await blockedCompose('conflicting-expiry-writes', child('C-m2-collision', ['L-translation-expiry@1', 'L-translation-expiry-conflict@1']), ['ITEM_COLLISION']);
  await blockedCompose('conflict-breaks-assumption', child('C-m2-assumption', ['L-translation-expiry-conflict@1', 'L-translation-reminder@1']), ['MISSING_DEPENDENCY', 'ASSUMPTION_FAILED']);
  await blockedCompose('omitted-alternative-needs-decision', child('C-m2-omitted', ['L-translation-expiry@1', 'L-translation-expiry-conflict@1', 'L-translation-reminder@1'], ['L-translation-expiry@1', 'L-translation-reminder@1']), ['RESOLUTION_REQUIRED']);
  const reordered = child('C-m2-reordered', ['L-translation-expiry-conflict@1', 'L-translation-expiry@1', 'L-translation-reminder@1'], ['L-translation-reminder@1', 'L-translation-expiry@1']);
  const reorderedResult = await blockedCompose('reordered-selection-same-block', reordered, ['RESOLUTION_REQUIRED']);
  assert.deepEqual(reorderedResult.data.diagnostics, (await cli(['conflicts', 'C-m2-omitted@1'], undefined, 'fixture-reader')).data.diagnostics);
});

test('M2: a revised distilled Layer needs a fresh exact review; wrong selected revisions stay blocked', async () => {
  const revision2 = structuredClone(draft);
  revision2.revision = 2;
  revision2.intent = 'Clarified intent: extend the booking hold expiry from the exact 600-second baseline to 900 seconds.';
  const reviseBefore = await stateBytes(root);
  const revised = await cli(['layer', 'revise', 'L-translation-expiry@1', '--file', '-'], revision2, 'fixture-a');
  assert.equal(revised.exit_code, 0, JSON.stringify(revised.errors));
  assert.equal(revised.data.ref, 'L-translation-expiry@2');
  assert.equal(revised.data.published, false);
  assertPriorArtifactsPreserved(reviseBefore, await stateBytes(root), 'revise append');
  const oldReview = S('m1-review.json');
  refusal('stale-head-review', await cli(['layer', 'publish', 'L-translation-expiry@2', '--review', oldReview], undefined, 'fixture-a'));
  assert.equal(refusals.at(-1)!.exit, 6);
  assert.equal(refusals.at(-1)!.code, 'DISTILL_REVIEW_REQUIRED');
  const draft2 = (await cli(['inspect', 'layer', 'L-translation-expiry@2'], undefined, 'fixture-a')).data;
  await writeJson(S('m1-review-2.json'), { source_digest: draft2.derived_from.source_digest, draft_digest: digest(draft2), reviewer: 'author-a', accepted: true });
  assert.equal((await cli(['layer', 'publish', 'L-translation-expiry@2', '--review', S('m1-review-2.json')], undefined, 'fixture-a')).exit_code, 0);
  const recipe = { id: 'C-m2-wrongrev', revision: 1, model_version: bootstrap().model_version, baseline: 'R0@1', proposals: ['L-translation-expiry@2', 'L-translation-reminder@1'], selected: ['L-translation-expiry@2', 'L-translation-reminder@1'], alternative_groups: [], scenario: { id: 'booking-demo', checks: [{ id: 'booking.compatibility', version: '1' }] }, resolutions: [] };
  const composed = await cli(['compose', '--file', '-'], recipe, 'fixture-preparer');
  refusal('wrong-selected-dependency-revision', composed);
  assert.equal(composed.exit_code, 5);
  assert.ok(composed.data.diagnostics.some((d: any) => d.code === 'MISSING_DEPENDENCY'));
  assert.equal((await cli(['inspect', 'release', m1Release.ref], undefined, 'fixture-reader')).data.state, 'validated');
});

test('M2: valid expiry+reminder candidate gets separate output, fresh evidence and its own Release', async () => {
  const recipe = { id: 'C-translation-reminder', revision: 1, model_version: bootstrap().model_version, baseline: 'R0@1', proposals: ['L-translation-expiry@1', 'L-translation-reminder@1'], selected: ['L-translation-expiry@1', 'L-translation-reminder@1'], alternative_groups: [], scenario: { id: 'booking-demo', checks: [{ id: 'booking.compatibility', version: '1' }] }, resolutions: [] };
  const reordered = { ...structuredClone(recipe), id: 'C-translation-reminder-reordered', proposals: [...recipe.proposals].reverse(), selected: [...recipe.selected].reverse() };
  const m2ComposeBefore = await stateBytes(root);
  const composed = (await cli(['compose', '--file', '-'], recipe, 'fixture-preparer')).data;
  assert.equal(composed.state, 'eligible_for_validation');
  assertPriorArtifactsPreserved(m2ComposeBefore, await stateBytes(root), 'M2 composition append');
  const reorderedComposed = (await cli(['compose', '--file', '-', '--dry-run'], reordered, 'fixture-preparer')).data;
  assert.equal(canonical(reorderedComposed.snapshot), canonical(composed.snapshot));
  assert.equal(canonical(reorderedComposed.obligations), canonical(composed.obligations));
  reminderCandidate = composed;
  const enabledTiming = { ...timingRequirement(true), acceptance: [...timingRequirement(true).acceptance].sort() };
  const expected = { ...obligationMap(r0.obligations), 'booking.hold/requirements.expiry': expiryRequirement(900), 'booking.reminder/requirements.timing': enabledTiming, 'booking.reminder/acceptance.layer-reminder': criterion('booking.reminder', 'layer-reminder', ['booking.reminder/requirements.timing']) };
  assert.equal(reminderCandidate.obligations.length, r0.obligations.length + 1);
  assert.equal(canonical(obligationMap(reminderCandidate.obligations)), canonical(expected));
  assert.deepEqual(reminderCandidate.provenance, { 'booking.hold/requirements.expiry': ['L-translation-expiry@1'], 'booking.reminder/requirements.timing': ['L-translation-reminder@1'], 'booking.reminder/acceptance.layer-reminder': ['L-translation-reminder@1'] });
  const mat = await cli(['materialize', reminderCandidate.ref, '--profile', 'booking-node/3', '--out', '.strata/m2-output'], undefined, 'fixture-preparer');
  assert.equal(mat.exit_code, 0, JSON.stringify(mat.errors));
  reminderManifest = JSON.parse(await readFile(mat.data.manifest, 'utf8')).record;
  const generated = await readFile(path.join(path.dirname(mat.data.manifest), 'booking.mjs'), 'utf8');
  assert.ok(generated.includes('"seconds":900'));
  assert.ok(generated.includes('"enabled":true'));
  const output = path.join(root, '.strata', 'm2-output');
  const runtime = S('runtime-m2.json');
  const first = await appCall(output, runtime, ['hold', 'room', 'one']);
  assert.deepEqual(first, { accepted: true, expires: 900 });
  assert.equal((await appCall(output, runtime, ['hold', 'room', 'two'])).accepted, false);
  assert.equal((await appCall(output, runtime, ['advance', '839'])).reminders.length, 0);
  const at840 = await appCall(output, runtime, ['advance', '1']);
  assert.equal(at840.reminders.length, 1);
  assert.equal(at840.reminders[0].at, 840);
  assert.equal((await appCall(output, runtime, ['advance', '0'])).reminders.length, 1);
  const at899 = await appCall(output, runtime, ['advance', '59']);
  assert.equal(Object.keys(at899.holds).length, 1);
  assert.equal(Object.keys((await appCall(output, runtime, ['advance', '1'])).holds).length, 0);
  assert.equal((await appCall(output, runtime, ['hold', 'room', 'two'])).accepted, true);
  const run = await runFixtureEvidence(output, reminderManifest, fixtureOracle(reminderCandidate.snapshot));
  assert.ok(run.evidence.results.every((r: any) => r.passed));
  await writeJson(S('m2-evidence.json'), run.evidence);
  const m2ValidateBefore = await stateBytes(root);
  reminderValidation = (await cli(['validate', reminderCandidate.ref, '--realization', mat.data.manifest, '--evidence', S('m2-evidence.json')], undefined, 'fixture-runner')).data;
  assert.equal(reminderValidation.checks_passed, true);
  assertPriorArtifactsPreserved(m2ValidateBefore, await stateBytes(root), 'M2 validation append');
  // Old evidence and old approvals cannot be carried over to the new candidate.
  refusal('old-evidence-new-candidate', await cli(['validate', reminderCandidate.ref, '--realization', mat.data.manifest, '--evidence', S('m1-evidence.json')], undefined, 'fixture-runner'));
  assert.equal(refusals.at(-1)!.exit, 6);
  assert.equal(refusals.at(-1)!.code, 'STALE_EVIDENCE');
  refusal('old-approvals-new-candidate', await cli(['release', reminderCandidate.ref, '--validation', reminderValidation.ref, '--approval', scopeApproval, '--approval', releaseApproval], undefined, 'fixture-release'));
  assert.equal(refusals.at(-1)!.exit, 6);
  assert.equal(refusals.at(-1)!.code, 'STALE_APPROVAL');
  const freshScope = (await cli(['approve', '--file', '-'], { kind: 'scope', target: reminderCandidate.fingerprint, scope: reminderCandidate.scope, evidence_digest: reminderValidation.evidence_digest }, 'fixture-selector')).data.ref;
  const freshRelease = (await cli(['approve', '--file', '-'], { kind: 'release', target: reminderCandidate.fingerprint, scope: null, evidence_digest: reminderValidation.evidence_digest }, 'fixture-release')).data.ref;
  const m2ReleaseBefore = await stateBytes(root);
  m2Release = (await cli(['release', reminderCandidate.ref, '--validation', reminderValidation.ref, '--approval', freshScope, '--approval', freshRelease], undefined, 'fixture-release')).data;
  assert.notEqual(m2Release.ref, m1Release.ref);
  assertPriorArtifactsPreserved(m2ReleaseBefore, await stateBytes(root), 'M2 release append');
  assertPriorArtifactsPreserved(m2ComposeBefore, await stateBytes(root), 'M2 full sequence');
  const releases = (await cli(['inspect', 'release'], undefined, 'fixture-reader')).data.items.filter((r: string) => r.startsWith('release@'));
  assert.equal(releases.length, 2);
  const record = (await cli(['inspect', 'release', m2Release.ref], undefined, 'fixture-reader')).data;
  assert.equal(canonical(record.acceptance_manifest), canonical(reminderCandidate.obligations));
  assert.equal(digest((await cli(['inspect', 'release', m1Release.ref], undefined, 'fixture-reader')).data), m1RecordDigest);
  assert.equal(digest((await cli(['inspect', 'release', 'R0@1'], undefined, 'fixture-reader')).data), r0RecordDigest);
  facts.m2 = { reminder_layer: 'L-translation-reminder@1 (owner author-b, required read/dependency on L-translation-expiry@1, 900-second assumption)', candidate: reminderCandidate.ref, fingerprint: reminderCandidate.fingerprint, obligations: reminderCandidate.obligations.length, provenance: reminderCandidate.provenance, output: { profile: reminderManifest.profile, output_tree: reminderManifest.output_tree, checker_sha256: reminderManifest.checker_sha256, fixture_sha256: reminderManifest.fixture_sha256, oracle_sha256: reminderManifest.oracle_sha256 }, literal: { reminder_at: 840, repeat_tick: 'still one', active_at: 899, expired_at: 900, next_hold: 'accepted', exclusivity: 'competing refused' }, validation_ref: reminderValidation.ref, evidence_digest: reminderValidation.evidence_digest, release_ref: m2Release.ref, stale_carryover_refused: ['STALE_EVIDENCE', 'STALE_APPROVAL'] };
  (facts as any).preservation_checks = { method: 'SHA-256 of every stored artifact compared across successful append operations; prior records must keep identical bytes and only new artifacts may appear', checkpoints: ['distill apply', 'accepted publish', 'owned revise', 'M1 composition', 'realization registration', 'M1 validation', 'M1 release', 'M2 composition', 'M2 validation', 'M2 release and full M2 sequence'], pinned_records_reverified: ['R0@1 release record', 'M1 release record'] };
});

test('boundary: structurally representable but unsupported values draft, publish, then fail materialization', async () => {
  const cases = [
    { id: 'L-t-contradictory', mutate: (value: any) => { value.statement = 'A hold expires exactly 600 seconds after it starts.'; } },
    { id: 'L-t-design', mutate: (value: any) => { value.facets.push('design'); } },
    { id: 'L-t-prose', mutate: (value: any) => { value.statement = 'Also collect a payment while holding the seat.'; } },
  ];
  for (const { id, mutate } of cases) {
    const proposal = structuredClone(checkedInProposal);
    proposal.layer.id = id;
    mutate(proposal.layer.changes[0].value);
    await writeJson(S('case-source.json'), sourceManifest); await writeJson(S('case-proposal.json'), proposal);
    const distilled = await cli(['dist', '--source', S('case-source.json'), '--against', 'R0@1', '--layer', id, '--proposal', S('case-proposal.json')], undefined, 'fixture-a');
    assert.equal(distilled.exit_code, 0, JSON.stringify(distilled.errors));
    const stored = (await cli(['inspect', 'layer', `${id}@1`], undefined, 'fixture-a')).data;
    await writeJson(S('case-review.json'), { source_digest: stored.derived_from.source_digest, draft_digest: digest(stored), reviewer: 'author-a', accepted: true });
    assert.equal((await cli(['layer', 'publish', `${id}@1`, '--review', S('case-review.json')], undefined, 'fixture-a')).exit_code, 0);
    const recipe = { id: 'C-' + id, revision: 1, model_version: bootstrap().model_version, baseline: 'R0@1', proposals: [`${id}@1`], selected: [`${id}@1`], alternative_groups: [], scenario: { id: 'booking-demo', checks: [{ id: 'booking.compatibility', version: '1' }] }, resolutions: [] };
    const composed = await cli(['compose', '--file', '-'], recipe, 'fixture-preparer');
    assert.equal(composed.exit_code, 0, JSON.stringify(composed.errors));
    refusal('unsupported-materialization-' + id, await cli(['materialize', composed.data.ref, '--profile', 'booking-node/3', '--out', `.strata/refuse-${id}`], undefined, 'fixture-preparer'));
    assert.equal(refusals.at(-1)!.exit, 8);
    assert.equal(refusals.at(-1)!.code, 'UNSUPPORTED_OBLIGATION');
    await assert.rejects(access(path.join(root, '.strata', `refuse-${id}`)));
  }
  // Unresolved questions keep an otherwise exact draft unpublishable.
  const questions = structuredClone(checkedInProposal);
  questions.layer.id = 'L-t-questions';
  questions.questions = ['Which lead time should a future reminder use?'];
  await writeJson(S('case-source.json'), sourceManifest); await writeJson(S('case-proposal.json'), questions);
  assert.equal((await cli(['dist', '--source', S('case-source.json'), '--against', 'R0@1', '--layer', 'L-t-questions', '--proposal', S('case-proposal.json')], undefined, 'fixture-a')).exit_code, 0);
  const stored = (await cli(['inspect', 'layer', 'L-t-questions@1'], undefined, 'fixture-a')).data;
  await writeJson(S('case-review.json'), { source_digest: stored.derived_from.source_digest, draft_digest: digest(stored), reviewer: 'author-a', accepted: true });
  refusal('unresolved-questions', await cli(['layer', 'publish', 'L-t-questions@1', '--review', S('case-review.json')], undefined, 'fixture-a'));
  assert.equal(refusals.at(-1)!.exit, 6);
  assert.equal(refusals.at(-1)!.code, 'DISTILL_REVIEW_REQUIRED');
  (facts as any).representable_but_unsupported = { cases: ['contradictory statement/parameters', 'design facet', 'arbitrary prose'], drafts_created_and_published: true, materialization: 'UNSUPPORTED_OBLIGATION exit 8', unresolved_questions: 'DISTILL_REVIEW_REQUIRED exit 6' };
});
