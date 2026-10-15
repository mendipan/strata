import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer } from '../src/security.js';
import { bootstrap } from '../src/fixtures.js';
import { normalizeSnapshot, digest, bytesDigest } from '../src/model.js';
import { verifySourceBindingHistory, type SourceScope } from '../src/source-binding.js';
import { verifyDriftHistory } from '../src/reconciliation.js';
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.js';

const exec = promisify(execFile), brokers: Awaited<ReturnType<typeof startLocalBroker>>[] = [];
after(async () => { for (const broker of brokers) await broker.close(); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-drift-cli-')), app = path.join(root, 'app'), project = path.join(root, 'intent'); await mkdir(path.join(app, 'src'), { recursive: true }); await mkdir(project);
  const git = async (args: string[]) => exec('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), '-C', app, ...args], { windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  await git(['init', '--quiet']); await git(['config', 'user.name', 'Synthetic Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(app, 'src/app.txt'), 'hello\n'); await writeFile(path.join(app, 'unrelated.bin'), new Uint8Array([255, 0, 254])); await writeFile(path.join(app, '.gitignore'), 'src/secret.txt\n'); await git(['add', '--', '.']); await git(['commit', '--quiet', '-m', 'Synthetic source baseline']);
  const paths = ['src/app.txt', 'src/new.txt', 'src/renamed.txt'], operations = ['source.capture', 'source.bind', 'drift.check', 'drift.propose', 'drift.review', 'inspect'];
  const issuer = new FixtureIssuer({ assignments: {
    'fixture-drift-selector': { principal: 'scope-selector', operations, repositories: ['synthetic-source'], git_paths: paths },
    'fixture-drift-author': { principal: 'author-a', operations: ['drift.check', 'drift.propose', 'drift.review', 'inspect'], repositories: ['synthetic-source'], git_paths: paths },
    'fixture-drift-unbound': { principal: 'reader', operations: ['drift.check'], repositories: [], git_paths: [] }
  } });
  let mutateAfterStage = false;
  const controls = { issuer, git: { repositories: [{ projectId: issuer.projectId, repoId: 'synthetic-source', root: app }], directory: path.join(root, 'git-state') }, afterStage: async () => { if (mutateAfterStage) { mutateAfterStage = false; await writeFile(path.join(app, 'src/app.txt'), 'changed during registry staging\n'); } } };
  const broker = await startLocalBroker(path.join(project, 'state'), 0, controls); brokers.push(broker);
  const config = JSON.parse(await readFile('strata.config.json', 'utf8')); config.broker = broker.url; await writeFile(path.join(project, 'strata.config.json'), JSON.stringify(config));
  const cli = (args: string[], input?: unknown, session = 'fixture-drift-selector') => runCli([...args, '--project', project, '--json', '--offline', '--non-interactive'], input === undefined ? undefined : JSON.stringify(input), { ...process.env, STRATA_SESSION: session });
  const ok = async (args: string[], input?: unknown, session?: string) => { const result = await cli(args, input, session); assert.equal(result.ok, true, JSON.stringify(result.errors)); return result.data; };
  await ok(['init', '--file', '-'], bootstrap(), 'fixture-bootstrap'); const release = await ok(['inspect', 'release', 'R0@1']);
  const scope: SourceScope = { format: 'source-scope/1', coverage: 'selected-scope', paths: ['src/app.txt'], watch_roots: ['src'], exclusions: [], items: ['app/purpose'], mapping: [{ item: 'app/purpose', paths: ['src/app.txt'], criteria: ['app/acceptance.review'] }], limitations: ['Only the declared selected item is mapped.'] };
  const captured = await ok(['source', 'capture', '--file', '-'], { repo_id: 'synthetic-source', scope });
  const payload = { format: 'source-binding-payload/1', project_id: issuer.projectId, repo_id: 'synthetic-source', intent: { release_ref: 'R0@1', release_sha256: digest(release), snapshot_sha256: digest(normalizeSnapshot(release)), model_version: release.model_version }, source_ref: captured.ref, source_sha256: captured.source_sha256, previous_binding_ref: null, completion_ref: null, basis: 'owner-accepted-bootstrap-association', acceptance_evidence_refs: [], limitations: ['unvalidated-bootstrap explicit association.'] };
  const binding = await ok(['source', 'bind', '--file', '-'], { payload, expected_payload_sha256: digest(payload), rationale: 'Review selected source and exact baseline.', review_refs: [] });
  const check = async (session?: string) => { const data = await ok(['drift', 'check', '--file', '-'], { binding_ref: binding.ref }, session), report = await ok(['inspect', 'drift-report', data.ref]); return { data, report }; };
  const propose = async (report: any, reportRef: string) => { const data = await ok(['drift', 'propose', '--file', '-'], { report_ref: reportRef, expected_report_sha256: digest(report), action: 'revalidate', rationale: 'Revalidate the changed selected source.', paths: ['src/app.txt'], items: ['app/purpose'], layer_refs: [], patch_refs: [], evidence_refs: [], questions: [], supersedes: null }, 'fixture-drift-author'); const proposal = await ok(['inspect', 'reconciliation-proposal', data.ref]); return { data, input: { proposal_ref: data.ref, expected_proposal_sha256: digest(proposal), decision: 'approve_plan', rationale: 'Review exact revalidation proposal.', questions: [] } }; };
  return { root, app, project, issuer, broker, cli, ok, git, check, propose, binding, scope, release, mutateAfterStage: () => { mutateAfterStage = true; } };
}

test('generic Git repository has a persistent real CLI report and approved plan without source execution', async () => {
  const f = await setup(), head = (await f.git(['rev-parse', 'HEAD'])).stdout.trim(), index = bytesDigest(await readFile(path.join(f.app, '.git/index'))), binary = await readFile(path.join(f.app, 'unrelated.bin'));
  const unchanged = await f.check(); assert.equal(unchanged.report.behavior_status, 'unknown'); assert.equal(unchanged.report.assessment, 'no-source-delta');
  await writeFile(path.join(f.app, 'src/app.txt'), 'hello\n// harmless byte change\n'); const changed = await f.check('fixture-drift-author'); assert.equal(changed.report.source_changes[0].kind, 'bytes-changed'); assert.equal(changed.report.behavior_status, 'unknown');
  const proposal = await f.propose(changed.report, changed.data.ref), reviewed = await f.ok(['drift', 'review', '--file', '-'], proposal.input); assert.equal(reviewed.state, 'approved_plan'); assert.equal(reviewed.completion, false);
  const readView = await f.ok(['review', 'reconciliation-review', reviewed.ref]); assert.equal(readView.execution_checked, false);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), head); assert.equal(bytesDigest(await readFile(path.join(f.app, '.git/index'))), index); assert.deepEqual(await readFile(path.join(f.app, 'unrelated.bin')), binary);
  const registry = JSON.parse(await readFile(path.join(f.project, 'state/registry.json'), 'utf8')), records: any = {};
  for (const [ref, entry] of Object.entries(registry.entries) as any) records[ref] = { type: entry.type, published: entry.published, data: JSON.parse(await readFile(path.join(f.project, 'state/artifacts', entry.hash + '.json'), 'utf8')) };
  verifySourceBindingHistory(records, f.issuer.projectId); verifyDriftHistory(records, f.issuer.projectId); assert.equal(Object.values(records).filter((r: any) => r.type === 'source-binding').length, 1);
  await f.broker.close(); const bundle = path.join(f.root, 'bundle'), exported = await createBackup({ state: path.join(f.project, 'state'), out: bundle, project: f.issuer.projectId, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 });
  assert.equal((await verifyBackup({ bundle, project: f.issuer.projectId, selector: 'fixture-backup', expectedDigest: exported.manifest_sha256 })).records, Object.keys(records).length);
  assert.equal((await restoreBackup({ bundle, out: path.join(f.root, 'inactive'), project: f.issuer.projectId, selector: 'fixture-backup', expectedDigest: exported.manifest_sha256 })).inactive, true);
});
test('real CLI refuses stale review, unauthorized approval and poststaging source changes', async () => {
  const f = await setup(); await writeFile(path.join(f.app, 'src/app.txt'), 'first edit\n'); let checked = await f.check(), proposal = await f.propose(checked.report, checked.data.ref);
  const denied = await f.cli(['drift', 'review', '--file', '-'], proposal.input, 'fixture-drift-author'); assert.equal(denied.exit_code, 4);
  const noRepo = await f.cli(['drift', 'check', '--file', '-'], { binding_ref: f.binding.ref }, 'fixture-drift-unbound'); assert.equal(noRepo.exit_code, 4);
  await writeFile(path.join(f.app, 'src/app.txt'), 'second edit\n'); const stale = await f.cli(['drift', 'review', '--file', '-'], proposal.input); assert.equal(stale.exit_code, 5);
  checked = await f.check(); proposal = await f.propose(checked.report, checked.data.ref); const before = await readFile(path.join(f.project, 'state/registry.json'), 'utf8'); f.mutateAfterStage(); const late = await f.cli(['drift', 'review', '--file', '-'], proposal.input); assert.equal(late.exit_code, 5); assert.equal(await readFile(path.join(f.project, 'state/registry.json'), 'utf8'), before);
});
test('real CLI reports new, deleted and renamed artifacts while ignored content stays unread in results', async () => {
  const f = await setup(); await writeFile(path.join(f.app, 'src/secret.txt'), 'ignored-private-content-canary'); await writeFile(path.join(f.app, 'src/new.txt'), 'new artifact\n'); let checked = await f.check(); assert.equal(checked.report.coverage.scope_complete, false); assert.ok(checked.report.coverage.unmapped_paths.includes('src/new.txt')); assert.equal(JSON.stringify(checked.report).includes('ignored-private-content-canary'), false);
  await rename(path.join(f.app, 'src/app.txt'), path.join(f.app, 'src/renamed.txt')); checked = await f.check(); assert.ok(checked.report.source_changes.some((c: any) => c.kind === 'deleted' && c.path === 'src/app.txt')); assert.ok(checked.report.possible_renames.some((r: any) => r.deleted === 'src/app.txt' && r.added.includes('src/renamed.txt'))); assert.equal(checked.report.behavior_status, 'unknown');
});

test('cached CLI source and drift mutations repeat freshness and current grants', async () => {
  const f = await setup(), captureInput = { repo_id: 'synthetic-source', scope: f.scope }, captureArgs = ['source', 'capture', '--file', '-', '--idempotency-key', 'capture-retry'];
  await f.ok(captureArgs, captureInput); await writeFile(path.join(f.app, 'src/app.txt'), 'changed after cached capture\n'); assert.equal((await f.cli(captureArgs, captureInput)).exit_code, 5);
  const checkArgs = ['drift', 'check', '--file', '-', '--idempotency-key', 'check-retry'], checkInput = { binding_ref: f.binding.ref }, checked = await f.ok(checkArgs, checkInput), report = await f.ok(['inspect', 'drift-report', checked.ref]);
  const proposal = await f.propose(report, checked.ref), reviewArgs = ['drift', 'review', '--file', '-', '--idempotency-key', 'review-retry']; await f.ok(reviewArgs, proposal.input); assert.equal((await f.ok(reviewArgs, proposal.input)).state, 'approved_plan');
  await writeFile(path.join(f.app, 'src/app.txt'), 'changed after cached approval\n'); assert.equal((await f.cli(reviewArgs, proposal.input)).exit_code, 5); assert.equal((await f.cli(checkArgs, checkInput)).exit_code, 5);
  await writeFile(path.join(f.app, 'src/ungranted.txt'), 'ungranted-content-canary'); const denied = await f.cli(['drift', 'check', '--file', '-'], checkInput); assert.equal(denied.exit_code, 4); assert.equal(JSON.stringify(denied).includes('ungranted-content-canary'), false);
  assert.equal((await f.ok(['drift', 'review', '--file', '-'], { ...proposal.input, decision: 'defer', questions: ['Source is now stale; retain historical deferral.'] }, 'fixture-drift-author')).state, 'deferred');
  f.issuer.suspendForTest('scope-selector'); assert.equal((await f.cli(reviewArgs, proposal.input)).exit_code, 4);
});
