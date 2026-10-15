import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, access, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { runCli, formatHuman } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { bootstrap, demoLayers, recipe, proposal } from '../src/fixtures.js';
import {fixtureOracle} from '../src/booking-checker.js';
import { runFixtureEvidence } from '../src/runner.js';
import { digest, bytesDigest } from '../src/model.js';
import { expiryRequirement } from '../src/profile.js';
const exec = promisify(execFile);
let root: string, broker: Awaited<ReturnType<typeof startLocalBroker>>, candidate: any, validation: any, approvalRefs: string[], realization: any;
let fixtureFault: 'after-stage' | 'after-commit' | undefined;
const env = (session = 'fixture-reader') => ({ ...process.env, STRATA_SESSION: session });
async function cli(args: string[], record?: unknown, session = ['release', 'flatten'].includes(args[0]) ? 'fixture-release' : args[0] === 'validate' ? 'fixture-runner' : args[0] === 'conflicts' && args.includes('--report') ? 'fixture-reviewer' : 'fixture-preparer') { return runCli([...args, '--project', root, '--json', '--non-interactive'], record === undefined ? undefined : JSON.stringify(record), env(session)); }
async function op(command: string, input: unknown, session = 'fixture-reader', options: any = {}) {
  return fetch(broker.url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': session }, body: JSON.stringify({ command, input, options }) }).then(r => r.json()) as Promise<any>;
}
before(async () => {
  root = path.resolve('.strata/cli-tests-' + Date.now()); await mkdir(root, { recursive: true }); broker = await startLocalBroker(path.join(root, 'state'), 0, { faultForTest: () => fixtureFault });
  const config = JSON.parse(await readFile('strata.config.json', 'utf8')); config.broker = broker.url; await writeFile(path.join(root, 'strata.config.json'), JSON.stringify(config));
  assert.equal((await cli(['init', '--file', '-'], bootstrap(), 'fixture-bootstrap')).exit_code, 0);
  const { a, b, c } = demoLayers(); for (const [session, layer] of [['fixture-a', a], ['fixture-b', b], ['fixture-c', c]] as const) { const draft = await cli(['layer', 'create', '--file', '-'], layer, session); assert.equal(draft.exit_code, 0); assert.equal((await cli(['layer', 'publish', draft.data.ref], undefined, session)).exit_code, 0); }
  const blocked = await cli(['compose', '--file', '-'], recipe()); assert.equal(blocked.exit_code, 5);
  const d = proposal('L-decision', 'scope-selector'); d.resolution_proposals = [{ input_fingerprint: blocked.data.input_fingerprint, scope: blocked.data.scope, impact: blocked.data.impact, outcome: { kind: 'select', selected: ['L-hold@1', 'L-reminder@1'], rejected: ['L-alternative@1'] } }];
  await cli(['layer', 'create', '--file', '-'], d, 'fixture-selector'); await cli(['layer', 'publish', 'L-decision@1'], undefined, 'fixture-selector');
  const request = { layer: 'L-decision@1', proposal_index: 0, composition: 'C-demo@1', approvals: [] };
  const unsigned = (await cli(['resolve', '--file', '-', '--dry-run'], request, 'fixture-selector')).data;
  const approval = (await cli(['approve', '--file', '-'], { kind: 'resolution', target: unsigned.target, scope: unsigned.scope, evidence_digest: null }, 'fixture-selector')).data;
  const resolution = (await cli(['resolve', '--file', '-', '--approval', approval.ref], request, 'fixture-selector')).data;
  const selected = recipe(); selected.revision = 2; selected.selected = ['L-hold@1', 'L-reminder@1']; selected.resolutions = [resolution.ref]; candidate = (await cli(['compose', '--file', '-'], selected)).data;
  const result = await cli(['mat', candidate.ref, '--profile', 'booking-node/1', '--out', '.strata/realization']); assert.equal(result.exit_code, 0); realization = result.data;
  const manifest = JSON.parse(await readFile(realization.manifest, 'utf8')); const runner = await runFixtureEvidence(path.dirname(realization.manifest), manifest.record,fixtureOracle(candidate.snapshot)); await writeFile(path.join(root, 'evidence.json'), JSON.stringify(runner.evidence));
  validation = (await cli(['validate', candidate.ref, '--realization', realization.manifest, '--evidence', path.join(root, 'evidence.json')], undefined, 'fixture-runner')).data;
  approvalRefs = [];
  for (const [kind, session, scope] of [['scope', 'fixture-selector', candidate.scope], ['release', 'fixture-release', null]] as const) approvalRefs.push((await cli(['approve', '--file', '-'], { kind, target: candidate.fingerprint, scope, evidence_digest: validation.evidence_digest }, session)).data.ref);
});
after(async () => { await broker?.close(); });
test('review CLI reuses inspector visibility and exposes exact bindings in JSON and human output', async () => {
  const before = await readFile(path.join(root, 'state/registry.json'), 'utf8');
  const result = await cli(['review', 'validation', validation.ref], undefined, 'fixture-reader');
  assert.equal(result.ok, true);
  assert.equal(result.data.subject.ref, validation.ref);
  assert(result.data.assertions.some((r: any) => r.kind === 'fixture_review_attestation'));
  assert(result.data.observations.some((r: any) => r.kind === 'imported_check_result' && r.target_ref === candidate.ref));
  const human = formatHuman(result);
  assert.match(human, /Assertion \[fixture_review_attestation\]/);
  assert.match(human, /Observation \[imported_check_result\]/);
  assert.match(human, /Unverified:/);
  assert(human.includes(validation.ref) && human.includes(candidate.ref));
  assert.equal(await readFile(path.join(root, 'state/registry.json'), 'utf8'), before);
  const layer = { ...demoLayers().a, id: 'L-review-private' };
  const draft = await cli(['layer', 'create', '--file', '-'], layer, 'fixture-a');
  const denied = await cli(['review', 'layer', draft.data.ref], undefined, 'fixture-reader');
  assert.equal(denied.errors[0].code, 'REF_NOT_FOUND');
  assert.equal(denied.data, null);
  assert.equal((await cli(['review', 'layer', draft.data.ref], undefined, 'fixture-a')).data.subject.ref, draft.data.ref);
  assert.equal((await cli(['review', 'layer', 'latest'])).exit_code, 2);
  assert.equal((await cli(['review', 'release', 'R0@1'])).exit_code, 8);
});
test('public CLI process emits exactly one JSON envelope and canonical alias names', async () => {
  const { stdout, stderr } = await exec(process.execPath, ['dist/src/cli.js', '--version'], { env: env() }); assert.equal(stderr, ''); assert.equal(stdout.trim().split('\n').length, 1); const result = JSON.parse(stdout); assert.equal(result.protocol_version, '1'); assert.equal(result.exit_code, 0);
  const alias = await cli(['mat', candidate.ref, '--profile', 'booking-node/1', '--out', '.strata/dry', '--dry-run']); assert.equal(alias.command, 'materialize');
});
test('stdin JSON, help, and redacted configuration remain noninteractive', async () => {
  const result = await cli(['init', '--file', '-'], bootstrap(), 'fixture-bootstrap'); assert.equal(result.exit_code, 0); assert.equal(result.data.reused, true);
  const config = await cli(['config', 'show'], undefined, 'fixture-a'); assert.equal(config.exit_code, 0); assert.ok(!JSON.stringify(config).includes('fixture-a')); assert.deepEqual(config.effects.network, []);
  assert.equal((await cli(['layer', 'create', '--help'])).data.capabilities.remote, false);
});
test('claimed owner and --actor do not spoof authenticated identity; absent identity is refused', async () => {
  const a = { ...demoLayers().a, id: 'spoof' }; const result = await cli(['layer', 'create', '--file', '-'], a, 'fixture-b'); assert.equal(result.exit_code, 4);
  assert.equal((await cli(['status', '--actor', 'scope-selector'])).exit_code, 2);
  const missing = await runCli(['status', '--project', root, '--json'], undefined, { ...process.env, STRATA_SESSION: '' }); assert.equal(missing.exit_code, 4);
});
test('general Agent routes and browser-origin requests are closed', async () => {
  assert.equal((await fetch(broker.url + '/agents/layer-agent/L-hold')).status, 404);
  const response = await fetch(broker.url + '/v1/operation', { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' }); assert.equal(response.status, 404);
});
test('dry-run draft/materialization do not write semantic records, artifacts, or output files', async () => {
  const before = await readFile(path.join(root, 'state/registry.json'), 'utf8'); const artifacts = await readdir(path.join(root, 'state/artifacts'));
  const a = { ...demoLayers().a, id: 'dry-owned' }; const draft = await cli(['layer', 'create', '--file', '-', '--dry-run'], a, 'fixture-a'); assert.equal(draft.exit_code, 0); assert.deepEqual(draft.effects.created, []);
  const mat = await cli(['mat', candidate.ref, '--profile', 'booking-node/1', '--out', '.strata/dry-output', '--dry-run']); assert.equal(mat.exit_code, 0); await assert.rejects(access(path.join(root, '.strata/dry-output')));
  assert.equal(await readFile(path.join(root, 'state/registry.json'), 'utf8'), before); assert.deepEqual(await readdir(path.join(root, 'state/artifacts')), artifacts);
});
test('blocked composition is persisted and inspectable despite exit 5', async () => {
  const inspect = await cli(['inspect', 'composition', 'C-demo@1']); assert.equal(inspect.exit_code, 0); assert.equal(inspect.data.evaluation.state, 'blocked'); assert.ok(inspect.data.evaluation.diagnostics.some((d: any) => d.code === 'ITEM_COLLISION'));
  assert.equal((await cli(['mat', 'C-demo@1', '--profile', 'booking-node/1', '--out', '.strata/blocked'])).exit_code, 5); await assert.rejects(access(path.join(root, '.strata/blocked')));
});
test('generated realization independently enforces exclusive holds, 840 reminder, 900 expiry, and a subsequent hold', async () => {
  const output = path.dirname(realization.manifest), runtime = path.join(root, 'runtime.json');
  async function app(args: string[]) { return JSON.parse((await exec(process.execPath, [path.join(output, 'booking.mjs'), ...args, '--state-file', runtime])).stdout); }
  assert.equal((await app(['hold', 'room', 'one'])).accepted, true); assert.equal((await app(['hold', 'room', 'two'])).accepted, false);
  assert.equal((await app(['advance', '839'])).reminders.length, 0); assert.equal((await app(['advance', '1'])).reminders.length, 1); assert.equal((await app(['advance', '0'])).reminders.length, 1);
  assert.equal(Object.keys((await app(['advance', '59'])).holds).length, 1); assert.equal(Object.keys((await app(['advance', '1'])).holds).length, 0); assert.equal((await app(['hold', 'room', 'two'])).accepted, true);
});
test('tampered or unmanifested local files invalidate validation and release', async () => {
  const program = path.join(path.dirname(realization.manifest), 'booking.mjs'); const original = await readFile(program, 'utf8');
  await writeFile(program, original + '// tampered'); assert.equal((await cli(['validate', candidate.ref, '--realization', realization.manifest, '--evidence', path.join(root, 'evidence.json')])).exit_code, 6);
  assert.equal((await cli(['release', candidate.ref, '--validation', validation.ref, '--approval', approvalRefs[0], '--approval', approvalRefs[1]])).exit_code, 6); await writeFile(program, original);
  const extra = path.join(path.dirname(program), 'extra.txt'); await writeFile(extra, 'unmanifested'); assert.equal((await cli(['validate', candidate.ref, '--realization', realization.manifest, '--evidence', path.join(root, 'evidence.json')])).exit_code, 6); await unlink(extra);
});
test('local release retry and concurrent duplicate requests produce one immutable publication', async () => {
  const args = ['flatten', candidate.ref, '--validation', validation.ref, '--approval', approvalRefs[0], '--approval', approvalRefs[1], '--idempotency-key', 'release-duplicate'];
  const [a, b] = await Promise.all([cli(args), cli(args)]); assert.equal(a.exit_code, 0); assert.equal(b.exit_code, 0); assert.equal(a.data.ref, b.data.ref);
  const status = await cli(['inspect', 'release']); assert.equal(status.data.items.filter((r: string) => r.startsWith('release@')).length, 1);
});
test('fault after artifact staging publishes nothing; response loss after index commit is recoverable', async () => {
  const input = { target: candidate.ref, validation: validation.ref, approvals: approvalRefs };
  const before = await readFile(path.join(root, 'state/registry.json'), 'utf8');
  assert.equal((await op('release', input, 'fixture-bootstrap', { fault: 'after-stage' })).error.code, 'OPERATION_FORBIDDEN');
  assert.equal((await op('release', input, 'fixture-release', { fault: 'after-stage' })).error.code, 'OWNER_FORBIDDEN');
  // Only the trusted test driver injects faults; the caller keeps its real release role.
  try {
    fixtureFault = 'after-stage';
    const staged = await op('release', input, 'fixture-release', { idempotency_key: 'stage-fault' }); assert.equal(staged.error.exit, 9); assert.equal(await readFile(path.join(root, 'state/registry.json'), 'utf8'), before);
    fixtureFault = 'after-commit';
    const lost = await op('release', input, 'fixture-release', { idempotency_key: 'lost-response' }); assert.equal(lost.error.exit, 9);
  } finally { fixtureFault = undefined; }
  const retry = await op('release', input, 'fixture-release', { idempotency_key: 'lost-response' }); assert.equal(retry.ok, true); assert.equal(retry.reused, true);
  const changed = await op('release', { ...input, approvals: [] }, 'fixture-release', { idempotency_key: 'lost-response' }); assert.equal(changed.error.code, 'IDEMPOTENCY_CONFLICT');
});
test('unsupported design coverage fails before output creation', async () => {
  const layer = { ...demoLayers().a, id: 'L-design' }; (layer.changes[0].value as any).facets.push('design'); await cli(['layer', 'create', '--file', '-'], layer, 'fixture-a'); await cli(['layer', 'publish', 'L-design@1'], undefined, 'fixture-a');
  const c = recipe('C-design'); c.proposals = c.selected = ['L-design@1']; c.alternative_groups = []; const composed = await cli(['compose', '--file', '-'], c); assert.equal(composed.exit_code, 0);
  const mat = await cli(['mat', 'C-design@1', '--profile', 'booking-node/1', '--out', '.strata/design-output']); assert.equal(mat.exit_code, 8); await assert.rejects(access(path.join(root, '.strata/design-output')));
});
test('path traversal, existing output, remote broker, and remote adapters fail before external access', async () => {
  assert.equal((await cli(['mat', candidate.ref, '--profile', 'booking-node/1', '--out', '..\outside'])).exit_code, 2);
  assert.equal((await cli(['mat', candidate.ref, '--profile', 'booking-node/1', '--out', '.strata/realization'])).exit_code, 5);
  const configFile = path.join(root, 'strata.config.json'); const original = await readFile(configFile, 'utf8');
  try { const config = JSON.parse(original); config.broker = 'https://example.com'; await writeFile(configFile, JSON.stringify(config)); const result = await cli(['status']); assert.equal(result.exit_code, 7); assert.deepEqual(result.effects.network, []); config.artifact_adapter = 'cloudflare-artifacts'; await writeFile(configFile, JSON.stringify(config)); assert.equal((await cli(['status'])).exit_code, 7); }
  finally { await writeFile(configFile, original); }
});
test('supplied-proposal distillation reads only declared bytes and needs source/draft-bound review', async () => {
  const sourceRoot = path.join(root, 'observations'); await mkdir(sourceRoot); const sourceText = 'Observed 900 second hold in a local experiment.\n'; await writeFile(path.join(sourceRoot, 'note.txt'), sourceText);
  const source = { root: 'observations', files: [{ path: 'note.txt', digest: bytesDigest(sourceText) }] }; const sourceFile = path.join(root, 'source.json'); await writeFile(sourceFile, JSON.stringify(source));
  const layer = { ...demoLayers().a, id: 'L-distilled' }; const proposalFile = path.join(root, 'prepared-proposal.json'); const prepared = { layer, traceability: [{ item: 'booking.hold/requirements.expiry', classification: 'observed', rationale: 'Explicitly observed in the authorized note.', files: ['note.txt'] }], questions: [] }; await writeFile(proposalFile, JSON.stringify(prepared));
  const result = await cli(['dist', '--source', sourceFile, '--against', 'R0@1', '--layer', layer.id, '--proposal', proposalFile], undefined, 'fixture-a'); assert.equal(result.exit_code, 0); assert.equal(result.command, 'distill'); assert.equal(result.data.review_required, true);
  assert.equal((await cli(['layer', 'publish', result.data.ref], undefined, 'fixture-a')).exit_code, 6);
  const draft = (await cli(['inspect', 'layer', result.data.ref], undefined, 'fixture-a')).data;
  const reviewFile = path.join(root, 'review.json'); await writeFile(reviewFile, JSON.stringify({ source_digest: draft.derived_from.source_digest, draft_digest: digest(draft), reviewer: 'author-a', accepted: true })); assert.equal((await cli(['layer', 'publish', result.data.ref, '--review', reviewFile], undefined, 'fixture-a')).exit_code, 0);
  await writeFile(path.join(sourceRoot, 'note.txt'), 'changed'); assert.equal((await cli(['dist', '--source', sourceFile, '--against', 'R0@1', '--layer', layer.id, '--proposal', proposalFile], undefined, 'fixture-a')).exit_code, 5);
});
test('attributed interaction reports invalidate readiness without changing immutable Composition content', async () => {
  const before = (await cli(['inspect', 'composition', candidate.ref])).data; const reportFile = path.join(root, 'report.json'); await writeFile(reportFile, JSON.stringify({ message: 'A fixture reviewer identified an interaction that needs a new candidate.' }));
  const report = await cli(['conflicts', candidate.ref, '--report', reportFile]); assert.equal(report.exit_code, 0); const after = (await cli(['inspect', 'composition', candidate.ref])).data;
  assert.equal(before.revision, after.revision); assert.equal(after.evaluation.state, 'blocked'); assert.equal((await cli(['release', candidate.ref, '--validation', validation.ref, '--approval', approvalRefs[0], '--approval', approvalRefs[1]])).exit_code, 5);
});

test('help advertises the accepted backup digest pin, current Block contract and human limitations', async () => {
  const result = await runCli(['--help', '--human']);
  assert.equal(result.ok, true);
  assert.ok(result.data.commands.includes('backup inspect BUNDLE --expect-project ID [--expect-digest HASH] [--ref EXACT_REF]'));
  const human = formatHuman(result);
  assert.match(human, /Block contract: docs\/BLOCK_CONTRACT\.md/);
  assert.match(human, /Limit:.*production authentication/);
  assert.match(human, /Limit:.*isolated inactive archive/);
});
