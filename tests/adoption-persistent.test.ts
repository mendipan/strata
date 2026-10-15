import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../src/core.js';
import { MODEL, canonical, digest, type Records } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { executeAuthorized } from '../src/service.js';
import { startLocalBroker } from '../src/local-broker.js';
import { runCli } from '../src/cli.js';
import { runGit, gitPins } from '../src/git-workspace.js';
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.js';
import { publicationGate, verifyAdoptionHistory } from '../src/adoption/persistent.js';
import { adoptionFixture } from './adoption-fixture.js';

const brokers: Awaited<ReturnType<typeof startLocalBroker>>[] = [];
after(async () => { for (const broker of brokers) await broker.close(); });
async function setup(watch = false) {
  const fixture = await adoptionFixture(), root = await mkdtemp(path.join(os.tmpdir(), 'strata-adoption-a2-'));
  const app = path.join(root, 'app'), project = path.join(root, 'intent'), state = path.join(project, 'state'), directory = path.join(root, 'git-state');
  await mkdir(app); await mkdir(project);
  const files = fixture.source.scope.paths;
  for (const file of files) await writeFile(path.join(app, file), await readFile(path.join('tests/fixtures/adoption', file)));
  await runGit(app, ['init', '--quiet']); await runGit(app, ['config', 'user.name', 'Synthetic Fixture']); await runGit(app, ['config', 'user.email', 'fixture@example.invalid']);
  await runGit(app, ['add', '--', '.']); await runGit(app, ['commit', '--quiet', '-m', 'Synthetic adoption baseline']);
  const principal = 'author-a', projectId = 'adoption-synthetic', repoId = 'synthetic-repository', base = new FixtureIssuer().resolve('fixture-a');
  const assignment = { principal, operations: [...base.allowed_operations, 'source.capture', 'adoption.prepare', 'adoption.review'], repositories: [repoId], git_paths: [...files, 'extra.txt'] };
  const issuer = new FixtureIssuer({ project_id: projectId, assignments: { 'fixture-a': assignment } });
  let fault: 'after-stage' | 'after-commit' | undefined, stageAction: (() => Promise<void>) | undefined;
  const git = { repositories: [{ projectId, repoId, root: app }], directory };
  let broker = await startLocalBroker(state, 0, { issuer, git, faultForTest: () => fault, afterStage: async () => { const action = stageAction; stageAction = undefined; await action?.(); } }); brokers.push(broker);
  const config = { schema_version: '1', model_version: MODEL, project_id: projectId, broker: broker.url, artifact_adapter: 'local-persistent-fake', profiles: ['counter-fixture/1'], identity_policy: 'trusted-local-fixture-sessions', network_policy: 'loopback-only' };
  const saveConfig = () => writeFile(path.join(project, 'strata.config.json'), JSON.stringify({ ...config, broker: broker.url })); await saveConfig();
  const cli = (args: string[], input?: unknown, session = 'fixture-a') => runCli([...args, '--project', project, '--json', '--offline'], input === undefined ? undefined : JSON.stringify(input), { ...process.env, STRATA_SESSION: session });
  const ok = async (args: string[], input?: unknown, session?: string) => { const result = await cli(args, input, session); assert.equal(result.ok, true, JSON.stringify(result.errors)); return result.data; };
  await ok(['init', '--file', '-'], fixture.baseline, 'fixture-bootstrap');
  const scope = { ...fixture.source.scope, watch_roots: watch ? ['.'] : [] };
  const captured = await ok(['source', 'capture', '--file', '-'], { repo_id: repoId, scope });
  const source = await ok(['inspect', 'source-snapshot', captured.ref]);
  const inventory = { ...fixture.inventory, source: { ref: captured.ref, sha256: captured.source_sha256 } };
  const prepare = (extra = {}) => ok(['adoption', 'prepare', '--file', '-'], { inventory, layer: fixture.layer, ...extra });
  const review = (proposal: any, accepted = true) => ok(['adoption', 'review', '--file', '-'], { proposal_ref: proposal.ref, expected_proposal_sha256: proposal.proposal_sha256, accepted, rationale: 'Owner reviewed declared interpretation, exclusions and inference; no behavior equivalence claimed.' });
  const publish = (review: any, key?: string) => cli(['layer', 'publish', 'CounterExtension@1', '--adoption-review', review.ref, ...(key ? ['--idempotency-key', key] : [])]);
  const load = async () => {
    const registry = JSON.parse(await readFile(path.join(state, 'registry.json'), 'utf8')), records: Records = {};
    for (const [ref, entry] of Object.entries(registry.entries) as [string, any][]) records[ref] = { type: entry.type, published: entry.published, data: JSON.parse(await readFile(path.join(state, 'artifacts', entry.hash + '.json'), 'utf8')) };
    return new Engine(records, registry.heads, { projectId });
  };
  const restart = async (backend = true, authority = issuer) => { await broker.close(); broker = await startLocalBroker(state, 0, { issuer: authority, ...(backend ? { git } : {}) }); brokers.push(broker); await saveConfig(); };
  const raw = async (command: string, input: unknown) => (await fetch(broker.url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': 'fixture-a', 'x-strata-project': projectId }, body: JSON.stringify({ command, input }) })).json() as Promise<any>;
  return { ...fixture, source, inventory, root, app, project, state, git, issuer, assignment, projectId, repoId, cli, ok, prepare, review, publish, load, raw, restart, stop: () => broker.close(), setFault: (value: typeof fault) => { fault = value; }, afterStage: (action: () => Promise<void>) => { stageAction = action; } };
}
function refused(result: any, ...codes: string[]) { assert.equal(result.ok, false, JSON.stringify(result)); const code = result.error?.code ?? result.errors?.[0]?.code; assert.ok(codes.includes(code), code); }
async function accepted(f: Awaited<ReturnType<typeof setup>>) { const proposal = await f.prepare(), review = await f.review(proposal); return { proposal, review }; }
const stale = ['SOURCE_SNAPSHOT_STALE', 'STALE_SOURCE', 'DIRTY_GIT_WORKTREE', 'UNSUPPORTED_CHECKOUT_TRANSFORM'];

test('A2 real CLI retains private proposal/review and measured publication without changing Git or app bytes', async () => {
  const f = await setup(), beforePins = await gitPins(f.git.repositories[0]), original = await Promise.all(f.source.scope.paths.map((file: string) => readFile(path.join(f.app, file))));
  assert.equal((await f.ok(['status'])).capabilities['adoption/1'], true);
  await f.ok(['adoption', 'prepare', '--file', '-', '--dry-run'], { inventory: f.inventory, layer: f.layer }); assert.equal((await f.load()).records['CounterExtension@1'], undefined);
  const { proposal, review } = await accepted(f);
  assert.equal(proposal.coverage.source_fresh, false); assert.equal(review.behavior_verified, false); assert.equal(review.publication_ready, false);
  const result = await f.publish(review); assert.equal(result.ok, true, JSON.stringify(result.errors)); assert.ok(result.data.adoption_publication_ref);
  const receipt = await f.ok(['inspect', 'adoption-publication', result.data.adoption_publication_ref]); assert.equal(receipt.source_fresh_at_publication, true); assert.equal(receipt.behavior_verified, false); assert.equal(receipt.observation_sha256, digest(receipt.observation));
  const engine = await f.load(); verifyAdoptionHistory(engine, f.projectId);
  assert.equal(engine.records[proposal.ref].published, false); assert.equal(engine.records[review.ref].published, false);
  assert.deepEqual(await gitPins(f.git.repositories[0]), beforePins);
  for (const [index, file] of f.source.scope.paths.entries()) assert.deepEqual(await readFile(path.join(f.app, file)), original[index]);
  assert.equal((await f.ok(['inspect', 'adoption-proposal'], undefined, 'fixture-reader')).total, 0);
  refused(await f.cli(['inspect', 'adoption-proposal', proposal.ref], undefined, 'fixture-reader'), 'REF_NOT_FOUND');
  assert.equal((await f.ok(['inspect', 'layer', 'CounterExtension@1'], undefined, 'fixture-reader')).id, 'CounterExtension');
});
test('A2 publication refuses omitted/rejected/wrong review and request-supplied bypass or host proof', async () => {
  const f = await setup(), proposal = await f.prepare(), rejected = await f.review(proposal, false);
  refused(await f.cli(['layer', 'publish', 'CounterExtension@1']), 'ADOPTION_REVIEW_REQUIRED');
  refused(await f.publish(rejected), 'STALE_ADOPTION_REVIEW');
  const review = await f.review(proposal);
  for (const extra of [{ source_fresh: true }, { bypass_adoption: true }, { host_proof: { snapshot: f.source } }]) refused(await f.raw('layer.publish', { ref: 'CounterExtension@1', adoption_review: review.ref, ...extra }), 'INVALID_RECORD');
  const engine = await f.load(); assert.throws(() => executeAuthorized(engine, 'layer.publish', { ref: 'CounterExtension@1', adoption_review: review.ref }, f.issuer.resolve('fixture-a'), f.issuer), { code: 'UNSUPPORTED_SOURCE_BACKEND' });
  assert.throws(() => publicationGate(engine, 'CounterExtension@1', review.ref, f.issuer.resolve('fixture-a'), f.issuer, JSON.parse(JSON.stringify({ snapshot: f.source, observation: {} }))), { code: 'UNSUPPORTED_SOURCE_BACKEND' });
  assert.equal((await f.load()).records['CounterExtension@1'].published, false);
});
test('A2 review rejects wrong owner, exact digest, model, project and missing accounting', async () => {
  const f = await setup(), proposal = await f.prepare();
  refused(await f.cli(['adoption', 'review', '--file', '-'], { proposal_ref: proposal.ref, expected_proposal_sha256: '0'.repeat(64), accepted: true, rationale: 'Exact review' }), 'STALE_ADOPTION_REVIEW');
  refused(await f.cli(['adoption', 'review', '--file', '-'], { proposal_ref: proposal.ref, expected_proposal_sha256: proposal.proposal_sha256, accepted: true, rationale: 'Wrong actor' }, 'fixture-b'), 'OPERATION_FORBIDDEN');
  const other = await setup(); refused(await other.cli(['adoption', 'prepare', '--file', '-'], { inventory: { ...other.inventory, project_id: 'other' }, layer: other.layer }), 'PROJECT_FORBIDDEN');
  const incomplete = await setup(), inv = structuredClone(incomplete.inventory); inv.questions.push({ id: 'unresolved', unit_ids: ['add'], text: 'Clarify selected behavior.' });
  const draft = await incomplete.ok(['adoption', 'prepare', '--file', '-'], { inventory: inv, layer: incomplete.layer }); assert.equal(draft.coverage.scope_accounted, false);
  refused(await incomplete.cli(['adoption', 'review', '--file', '-'], { proposal_ref: draft.ref, expected_proposal_sha256: draft.proposal_sha256, accepted: true, rationale: 'Not resolved' }), 'ADOPTION_SCOPE_INCOMPLETE');
});
for (const [name, mutate] of [
  ['changed selected bytes', async (f: Awaited<ReturnType<typeof setup>>) => writeFile(path.join(f.app, 'selected.mjs'), 'changed synthetic source\n')],
  ['deleted selected file', async (f: Awaited<ReturnType<typeof setup>>) => unlink(path.join(f.app, 'selected.mjs'))],
  ['changed protected bytes', async (f: Awaited<ReturnType<typeof setup>>) => writeFile(path.join(f.app, 'protected.bin'), new Uint8Array([17, 19]))],
  ['staged index change', async (f: Awaited<ReturnType<typeof setup>>) => { await writeFile(path.join(f.app, 'selected.mjs'), 'staged synthetic change\n'); await runGit(f.app, ['add', '--', 'selected.mjs']); }],
  ['new HEAD with identical tree', async (f: Awaited<ReturnType<typeof setup>>) => { await runGit(f.app, ['commit', '--quiet', '--allow-empty', '-m', 'Owner new baseline']); }]
] as const) test('A2 refuses ' + name + ' before publication', async () => {
  const f = await setup(), { review } = await accepted(f); await mutate(f); refused(await f.publish(review), ...stale); assert.equal((await f.load()).records['CounterExtension@1'].published, false);
});
test('A2 watched additions and path links cannot enter a reviewed source scope', async () => {
  const f = await setup(true), { review } = await accepted(f); await writeFile(path.join(f.app, 'extra.txt'), 'new watched source\n'); refused(await f.publish(review), ...stale);
  const link = await setup(), a = await accepted(link); await unlink(path.join(link.app, 'selected.mjs')); await symlink(link.app, path.join(link.app, 'selected.mjs'), process.platform === 'win32' ? 'junction' : 'dir'); refused(await link.publish(a.review), 'INVALID_PATH', 'UNSUPPORTED_GIT_FILE', ...stale);
});
test('A2 precommit source mutation and authority revocation leave Layer private and no indexed receipt', async () => {
  const f = await setup(), { review } = await accepted(f); f.afterStage(() => writeFile(path.join(f.app, 'selected.mjs'), 'concurrent synthetic edit\n'));
  refused(await f.publish(review), ...stale); const engine = await f.load(); assert.equal(engine.records['CounterExtension@1'].published, false); assert.equal(Object.values(engine.records).filter(record => record.type === 'adoption-publication').length, 0);
  const revoked = await setup(), reviewed = await accepted(revoked); revoked.afterStage(async () => { revoked.issuer.suspendForTest('author-a'); }); refused(await revoked.publish(reviewed.review), 'ACCESS_REVOKED', 'STALE_POLICY'); assert.equal((await revoked.load()).records['CounterExtension@1'].published, false);
});
test('A2 plain revisions/restorations cannot strip lineage; explicit proposal revisions conserve unit IDs', async () => {
  const f = await setup(), { proposal, review } = await accepted(f); assert.equal((await f.publish(review)).ok, true);
  const raw = { ...f.layer, revision: 2, intent: 'Ordinary revision cannot remove adoption requirements.' }; await f.ok(['layer', 'revise', 'CounterExtension@1', '--file', '-'], raw);
  refused(await f.cli(['layer', 'publish', 'CounterExtension@2', '--adoption-review', review.ref]), 'ADOPTION_PROPOSAL_REQUIRED');
  const lost = structuredClone(f.inventory); lost.units = lost.units.filter(unit => unit.id !== 'state'); lost.accounting.find(section => section.kind === 'state')!.unit_ids = []; lost.accounting.find(section => section.kind === 'state')!.none_reason = 'Attempted loss';
  refused(await f.cli(['adoption', 'prepare', '--file', '-'], { inventory: lost, layer: { ...raw, revision: 3 }, previous: 'CounterExtension@2', previous_proposal: proposal.ref }), 'ADOPTION_INVENTORY_LOSS');
  const next = await f.ok(['adoption', 'prepare', '--file', '-'], { inventory: f.inventory, layer: { ...raw, revision: 3 }, previous: 'CounterExtension@2', previous_proposal: proposal.ref }); const nextReview = await f.review(next);
  refused(await f.cli(['layer', 'publish', 'CounterExtension@3', '--adoption-review', review.ref]), 'STALE_ADOPTION_REVIEW');
  await f.ok(['layer', 'publish', 'CounterExtension@3', '--adoption-review', nextReview.ref]);
  const restored = await f.ok(['layer', 'restore', 'CounterExtension@3', '--from', 'CounterExtension@1']); assert.equal(restored.ref, 'CounterExtension@4');
  refused(await f.cli(['layer', 'publish', restored.ref, '--adoption-review', review.ref]), 'ADOPTION_PROPOSAL_REQUIRED'); verifyAdoptionHistory(await f.load(), f.projectId);
});
test('A2 restart/cached retry remeasure source; response-loss inspect preserves historical receipt only', async () => {
  const f = await setup(), { review } = await accepted(f); f.setFault('after-commit'); refused(await f.publish(review, 'publish-one'), 'INJECTED_RESPONSE_LOSS'); f.setFault(undefined);
  const inspect = await f.ok(['operation', 'inspect', 'publish-one']); assert.equal(inspect.state, 'committed'); const publication = inspect.result.data.adoption_publication_ref;
  await f.restart(); const retry = await f.publish(review, 'publish-one'); assert.equal(retry.ok, true, JSON.stringify(retry.errors)); assert.equal(retry.data.adoption_publication_ref, publication);
  await writeFile(path.join(f.app, 'selected.mjs'), 'later source drift\n'); refused(await f.publish(review, 'publish-one'), ...stale); assert.equal((await f.ok(['operation', 'inspect', 'publish-one'])).result.data.adoption_publication_ref, publication); verifyAdoptionHistory(await f.load(), f.projectId);
});
test('A2 fresh assigned backend is mandatory after restart and permissions are rechecked on retry', async () => {
  const f = await setup(), { review } = await accepted(f); const published = await f.publish(review, 'once'); assert.equal(published.ok, true);
  await f.restart(false); refused(await f.publish(review), 'UNSUPPORTED_SOURCE_BACKEND');
  // Cached publication must also refuse when its configured host is unavailable.
  refused(await f.publish(review, 'once'), 'UNSUPPORTED_SOURCE_BACKEND');
  const denied = new FixtureIssuer({ project_id: f.projectId, assignments: { 'fixture-a': { ...f.assignment, repositories: [] } } }); await f.restart(true, denied); refused(await f.publish(review, 'once'), 'REPOSITORY_FORBIDDEN');
});
test('A2 stage failure is retryable and private adoption history survives inactive backup without fresh claims', async () => {
  const f = await setup(), { proposal, review } = await accepted(f); f.setFault('after-stage'); refused(await f.publish(review, 'gate-retry'), 'INJECTED_STAGE_FAILURE'); f.setFault(undefined);
  assert.equal((await f.load()).records['CounterExtension@1'].published, false); assert.equal((await f.publish(review, 'gate-retry')).ok, true);
  await f.stop(); const bundle = path.join(f.root, 'backup'), restored = path.join(f.root, 'restored');
  const backup = await createBackup({ state: f.state, out: bundle, project: f.projectId, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 });
  await verifyBackup({ bundle, project: f.projectId, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  await restoreBackup({ bundle, out: restored, project: f.projectId, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  const checkpoint = JSON.parse(await readFile(path.join(restored, 'checkpoint.json'), 'utf8')); assert.equal(checkpoint.entries[proposal.ref].published, false); assert.equal(checkpoint.entries[review.ref].published, false);
  const engine = await f.load(); const pub = Object.entries(engine.records).find(([, record]) => record.type === 'adoption-publication')!;
  pub[1].data.observation_sha256 = '0'.repeat(64); assert.throws(() => verifyAdoptionHistory(engine, f.projectId));
});
