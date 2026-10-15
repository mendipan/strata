import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Engine, obligations } from '../core.js';
import { bytesDigest, canonical, digest, MODEL } from '../model.js';
import { FixtureIssuer } from '../security.js';
import { startLocalBroker } from '../local-broker.js';
import { runFixtureEvidence } from '../runner.js';
import { APPLICATION_CHECKER, applicationCheckerPins } from '../git-application-checker.js';
import { runGit, gitPins, decodeGit } from '../git-workspace.js';
import { ADOPTION_KINDS } from '../adoption/contract.js';
import type { SourceScope } from '../source-binding.js';
import { noLinks } from '../node-state.js';

const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const preservedTests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { createCounter } from './counter.mjs';
test('preserved positive additions and detached instances', () => { const app=createCounter(); assert.equal(app.total(),0); assert.deepEqual(app.add(1),{accepted:true,total:1}); assert.deepEqual(app.add(1),{accepted:true,total:2}); assert.equal(createCounter().total(),0); });
test('preserved invalid additions are atomic', () => { const app=createCounter(); for(const value of [0,-1,1.5,'1',null]) { assert.deepEqual(app.add(value),{accepted:false,reason:'invalid',total:0}); assert.equal(app.total(),0); } });
`;
const fixture = async (name: string) => JSON.parse(await readFile(path.join(checkout, 'tests/fixtures/counter', name + '.json'), 'utf8'));
const projectId = 'q1-existing-route-fixture', repoId = 'q1-synthetic-app';
export type ExistingRoute = 'incremental' | 'reconstruct_declared_scope';

async function newTrial(output: string) {
  const root = path.resolve(output); await noLinks(path.dirname(root));
  for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
    if (await access(path.join(parent, '.git')).then(() => true, () => false)) throw new Error('Qualification output must be outside existing Git repositories.');
    if (path.dirname(parent) === parent) break;
  }
  await mkdir(root); // New directory only; never overwrite or accept an existing app.
  return root;
}

/** Fixed synthetic qualification of existing commands, not an Engine endpoint,
 * source importer, arbitrary application runner or adoption/delivery bridge. */
export async function qualifyExistingRoute(route: ExistingRoute, output: string, options: {adoptionBridge?:boolean} = {}) {
  assert(['incremental', 'reconstruct_declared_scope'].includes(route), 'Use a supported fixed route.');
  assert(!options.adoptionBridge||route==='incremental','The reviewed adoption bridge supports selected incremental delivery only.');
  const root = await newTrial(output), app = path.join(root, 'app'), project = path.join(root, 'intent'), logs = path.join(root, 'commands');
  await mkdir(app); await mkdir(project); await mkdir(logs);
  const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' };
  for (const key of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|CLOUDFLARE_API|CF_API|STRATA_SESSION|STRATA_CONFIG|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  const guard = pathToFileURL(path.join(checkout, 'tests/no-external-fetch.mjs')).href; let sequence = 0;
  const report: any = { format: 'existing-route-qualification/1', route, status: 'running', trust: 'synthetic-local-fixture', source_sha: decodeGit(await runGit(checkout, ['rev-parse', 'HEAD'])).trim(), model: MODEL, profile: 'counter-fixture/1', checker: APPLICATION_CHECKER,
    runtime: { node: process.version, platform: process.platform, qualifier_sha256: bytesDigest(await readFile(fileURLToPath(import.meta.url))) },
    execution_authenticated: false, automatic_extraction: false, adoption_delivery_bridge_established: false, reconciliation_complete: false, universal_equivalence: 'not-established', commands: [], refusals: [], refs: {}, host_closed: false };
  if(options.adoptionBridge)report.whole_application_equivalence=false;
  async function command(args: string[], input: string, role: string, label: string, timeout = 180000) {
    const name = String(++sequence).padStart(3, '0') + '-' + label, started = performance.now();
    const child = spawn(process.execPath, ['--import', guard, ...args], { cwd: checkout, env: { ...env, STRATA_SESSION: role }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exceeded = false;
    child.stdout.on('data', data => { stdout += new TextDecoder().decode(data); if (stdout.length > 2 * 1024 * 1024) { exceeded = true; child.kill(); } });
    child.stderr.on('data', data => { stderr += new TextDecoder().decode(data); if (stderr.length > 2 * 1024 * 1024) { exceeded = true; child.kill(); } });
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, timeout);
    const closed = new Promise<{ exit: number | null; signal: string | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (exit, signal) => resolve({ exit, signal })); });
    child.stdin.end(input);
    let result; try { result = await closed; } finally { clearTimeout(timer); }
    await writeFile(path.join(logs, name + '.stdin.log'), input, { flag: 'wx' }); await writeFile(path.join(logs, name + '.stdout.log'), stdout, { flag: 'wx' }); await writeFile(path.join(logs, name + '.stderr.log'), stderr, { flag: 'wx' });
    const recorded = { command: ['node', '--import', guard, ...args], role, ...result, bounded_failure: exceeded, duration_ms: Math.round(performance.now() - started), stdin_sha256: bytesDigest(input), stdout_sha256: bytesDigest(stdout), stderr_sha256: bytesDigest(stderr), log_prefix: 'commands/' + name };
    report.commands.push(recorded); assert(!exceeded, label + ' exceeded the fixed timeout/output bound'); return { ...result, stdout, stderr };
  }
  const cli = async (args: string[], input?: unknown, role = 'fixture-preparer') => {
    const result = await command([path.join(checkout, 'dist/src/cli.js'), ...args, '--project', project, '--json', '--non-interactive', '--offline'], input === undefined ? '' : JSON.stringify(input), role, args.slice(0, 2).join('-').replace(/[^a-z0-9-]/gi, '_'));
    assert(result.stdout.trim(), args.join(' ') + ' returned no JSON: ' + result.stderr);
    const envelope = JSON.parse(result.stdout); assert.equal(result.exit, envelope.exit_code); return envelope;
  };
  const ok = async (args: string[], input?: unknown, role?: string) => { const response = await cli(args, input, role); assert.equal(response.ok, true, JSON.stringify(response.errors)); return response.data; };
  const refuse = async (label: string, args: string[], input: unknown, role: string, allowed?: string[]) => {
    const response = await cli(args, input, role); assert.equal(response.ok, false, label); const code = response.errors?.[0]?.code ?? response.error?.code;
    if (allowed) assert(allowed.includes(code), label + ': ' + code); report.refusals.push({ label, code, exit: response.exit_code }); return response;
  };
  const json = async (name: string, value: unknown) => { const file = path.join(root, name + '.json'); await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return file; };
  const host = { projectId, repoId, root: app }, paths = ['counter.mjs', 'counter.test.mjs', 'image.bin', 'unrelated.txt'];
  const pins = async () => ({ ...await gitPins(host), branch: decodeGit(await runGit(app, ['symbolic-ref', '--short', 'HEAD'])).trim(), refs: decodeGit(await runGit(app, ['for-each-ref', '--format=%(refname) %(objectname)'])).trim() });
  const bytes = async () => Object.fromEntries(await Promise.all(['.gitattributes', ...paths].map(async name => [name, bytesDigest(await readFile(path.join(app, name)))])));
  let broker: Awaited<ReturnType<typeof startLocalBroker>> | undefined, failWrite = false, writeFaultTriggered = false;
  try {
    const baseline = await fixture('bootstrap'), template = new Engine(); template.init(baseline, 'bootstrap');
    const old = template.realize('CounterBaseline@1', 'counter-fixture/1');
    await writeFile(path.join(app, '.gitattributes'), '* -text\n'); await writeFile(path.join(app, 'counter.mjs'), old.files['counter.mjs']);
    await writeFile(path.join(app, 'counter.test.mjs'), preservedTests); await writeFile(path.join(app, 'image.bin'), new Uint8Array([0, 255, 17, 10])); await writeFile(path.join(app, 'unrelated.txt'), 'Unadopted report bytes remain unchanged.\n');
    // Owner actions occur only in this newly created synthetic Git fixture.
    await runGit(app, ['init', '--quiet', '-b', 'main']); await runGit(app, ['config', 'user.name', 'Synthetic Q1 Owner']); await runGit(app, ['config', 'user.email', 'fixture@example.invalid']);
    await runGit(app, ['add', '--', '.']); await runGit(app, ['commit', '--quiet', '-m', 'Synthetic original app']); await runGit(app, ['branch', 'untouched-history']);
    const before = await pins(), originalBytes = await bytes(); report.original = { git: before, bytes: originalBytes, origin: 'Recognized compiled counter template; this is not an independently inferred arbitrary app.' };
    const defaultIssuer = new FixtureIssuer(), assignments: any = {};
    const gitOperations = ['source.capture', 'source.bind', 'git.plan', 'git.stage', 'git.check', 'git.evidence', 'git.review', 'git.apply', 'git.finalize', 'git.transaction.inspect', 'git.transaction.recover'];
    for (const role of ['fixture-a', 'fixture-preparer', 'fixture-runner', 'fixture-selector']) {
      const context = defaultIssuer.resolve(role);
      assignments[role] = { principal: context.principal_id, operations: [...context.allowed_operations, ...gitOperations, ...(role === 'fixture-a' ? ['adoption.prepare', 'adoption.review'] : [])], repositories: [repoId], git_paths: paths, git_checkers: [APPLICATION_CHECKER], layer_ids: ['CounterExtension'], write_block_ids: ['counter'],
        ...(role === 'fixture-selector' ? { approvals: ['scope', 'resolution'] } : {}), ...(role === 'fixture-runner' ? { executor: 'strata-local-fixture-runner/1', reviewers: ['fixture-reviewer'] } : {}) };
    }
    const issuer = new FixtureIssuer({ project_id: projectId, assignments });
    const start = async () => {
      broker = await startLocalBroker(path.join(project, 'state'), 0, { issuer, model_version: MODEL, git: { repositories: [host], directory: path.join(root, 'git-state'), enabledCheckers: [APPLICATION_CHECKER], afterWriteForTest: async () => { if (failWrite) { writeFaultTriggered = true; throw new Error('Fixed Q1 rollback qualification fault'); } } } });
      await writeFile(path.join(project, 'strata.config.json'), JSON.stringify({ schema_version: '1', model_version: MODEL, project_id: projectId, broker: broker.url, artifact_adapter: 'local-persistent-fake', profiles: ['counter-fixture/1'], identity_policy: 'trusted-local-fixture-sessions', network_policy: 'loopback-only' }));
    };
    await start(); await ok(['status']); await ok(['init', '--file', '-'], baseline, 'fixture-bootstrap');
    const criteria = Object.values(baseline.blocks.counter.acceptance).map((row: any) => ({ check: row.check, version: row.version, fixture: row.fixture, method: row.method })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    async function accept(candidate: any, name: string, maximum: 6 | 12) {
      const materialized = await ok(['materialize', candidate.ref, '--profile', 'counter-fixture/1', '--out', '.strata/' + name]);
      const manifest = JSON.parse(await readFile(materialized.manifest, 'utf8'));
      const oracle = { format: 'counter-oracle/1', snapshot_sha256: digest(candidate.snapshot), expected: { maximum }, criteria };
      const measured = await runFixtureEvidence(path.dirname(materialized.manifest), manifest.record, oracle as any);
      await json(name + '-fixture-measurement', measured); const evidenceFile = await json(name + '-evidence', measured.evidence);
      const validation = await ok(['validate', candidate.ref, '--realization', materialized.manifest, '--evidence', evidenceFile], undefined, 'fixture-runner');
      const scope = await ok(['approve', '--file', '-'], { kind: 'scope', target: candidate.fingerprint, scope: 'counter', evidence_digest: validation.evidence_digest }, 'fixture-selector');
      const releaseApproval = await ok(['approve', '--file', '-'], { kind: 'release', target: candidate.fingerprint, scope: null, evidence_digest: validation.evidence_digest }, 'fixture-release');
      const release = await ok(['release', candidate.ref, '--validation', validation.ref, '--approval', scope.ref, '--approval', releaseApproval.ref], undefined, 'fixture-release');
      return { candidate, release, validation, manifest, measured, oracle, approvals: [scope.ref, releaseApproval.ref] };
    }
    const recipe = await fixture('composition');
    const noChange = await ok(['compose', '--file', '-'], { ...recipe, id: 'Q1OriginalBaseline', proposals: [], selected: [] });
    const acceptedBaseline = await accept(noChange, 'accepted-baseline', 6);
    const selectedItems = obligations(baseline), scope: SourceScope = { format: 'source-scope/1', coverage: 'selected-scope', paths, watch_roots: [], exclusions: [], items: selectedItems.map(item => item.item).sort(), mapping: selectedItems.map(item => ({ item: item.item, paths: ['counter.mjs'], criteria: [...item.criteria].sort() })).sort((a, b) => a.item.localeCompare(b.item)), limitations: ['Only the fixed counter feature is adopted; preserved test/text/binary files are inventoried. No UI/network/persistence migration.'] };
    const captured = await ok(['source', 'capture', '--file', '-'], { repo_id: repoId, scope }, 'fixture-selector');
    const source = await ok(['inspect', 'source-snapshot', captured.ref]);
    const filePin = (name: string) => ({ path: name, sha256: source.entries.find((entry: any) => entry.path === name).sha256 });
    const unit = (id: string, kind: string, items: string[], name = 'counter.mjs') => ({ id, kind, description: 'Reviewed declared ' + kind + ' for the recognized counter fixture.', scope: 'adopted', classification: kind === 'state' ? 'inferred' : 'observed', rationale: 'Human-authored fixture proposal, never automatic extraction.', disposition: 'mapped', files: [filePin(name)], dependency_paths: name === 'counter.test.mjs' ? ['counter.mjs'] : [], items: [...items].sort(), criteria: [...new Set(items.flatMap(item => selectedItems.find(row => row.item === item)!.criteria))].sort(), evidence_refs: [] });
    const units: any[] = [unit('behavior', 'behavior', ['counter/purpose', 'counter/requirements.limit']), unit('integers', 'error', ['counter/requirements.integers', 'counter/contract.failures.ceiling']), unit('interface', 'interface', ['counter/contract.inputs.add', 'counter/contract.outputs.total']), unit('state', 'state', ['counter/requirements.limit']), unit('tests', 'test', Object.keys(baseline.blocks.counter.acceptance).map(id => 'counter/acceptance.' + id), 'counter.test.mjs'), { ...unit('unadopted-report', 'behavior', []), scope: 'outside', disposition: 'excluded', files: [filePin('image.bin'), filePin('unrelated.txt')], description: 'Preserve explicitly unadopted binary and report content.' }];
    const inventory = { format: 'adoption-inventory/1', project_id: projectId, source: { ref: captured.ref, sha256: captured.source_sha256 }, mode: route, declared_scope: 'Complete declared counter feature only; test/binary/report preservation explicit; no whole-app equivalence.', units, accounting: ADOPTION_KINDS.map(kind => ({ kind, unit_ids: units.filter(unit => unit.kind === kind).map(unit => unit.id).sort(), none_reason: null })), protected_paths: ['image.bin', 'unrelated.txt'], exclusions: [{ unit_id: 'unadopted-report', reason: 'Unrelated content remains outside adopted intent.' }], questions: [], limitations: ['Supplied declared interpretation; no automatic extractor, adoption/delivery bridge or migration claim.'] };
    const layer = await fixture('extend'); layer.baseline = acceptedBaseline.release.ref;
    const proposal = await ok(['adoption', 'prepare', '--file', '-'], { inventory, layer }, 'fixture-a');
    const interpretation = await ok(['adoption', 'review', '--file', '-'], { proposal_ref: proposal.ref, expected_proposal_sha256: proposal.proposal_sha256, accepted: true, rationale: 'Review synthetic interpretation only; independent fixture measurement and delivery reviews are separate.' }, 'fixture-a');
    assert.equal(interpretation.behavior_verified, false);
    const publication = await ok(['layer', 'publish', proposal.draft_ref, '--adoption-review', interpretation.ref], undefined, 'fixture-a');
    const candidate = await ok(['compose', '--file', '-'], { ...recipe, id: 'Q1ChangedCounter', baseline: acceptedBaseline.release.ref, proposals: [proposal.draft_ref], selected: [proposal.draft_ref] });
    const acceptedChange = await accept(candidate, 'accepted-change', 12);
    // Inventory includes preserved outside content; an accepted source binding
    // covers only artifacts actually mapped to the selected counter obligations.
    const bindingScope: SourceScope = { ...scope, paths: ['counter.mjs', 'counter.test.mjs'], mapping: scope.mapping.map(row => ({ ...row, paths: row.item.startsWith('counter/acceptance.') ? ['counter.mjs', 'counter.test.mjs'] : ['counter.mjs'] })) };
    const bindingSource = await ok(['source', 'capture', '--file', '-'], { repo_id: repoId, scope: bindingScope }, 'fixture-selector');
    const baselineRecord = await ok(['inspect', 'release', acceptedBaseline.release.ref]);
    const payload: any = { format: 'source-binding-payload/1', project_id: projectId, repo_id: repoId, intent: { release_ref: acceptedBaseline.release.ref, release_sha256: digest(baselineRecord), snapshot_sha256: digest(noChange.snapshot), model_version: MODEL }, source_ref: bindingSource.ref, source_sha256: bindingSource.source_sha256, previous_binding_ref: null, completion_ref: null, basis: 'validated-release-association', acceptance_evidence_refs: [], limitations: ['Only counter module and mapped tests are associated; preserved binary/report remain outside intent. Owner fixture source association and finite accepted intent; source.bind behavior_verified remains false.'] };
    const binding = await ok(['source', 'bind', '--file', '-'], { payload, expected_payload_sha256: digest(payload), rationale: 'Associate this exact unchanged synthetic Git app with separately validated no-change fixture intent.', review_refs: [] }, 'fixture-selector');
    report.refs = { source: captured.ref, binding_source: bindingSource.ref, inventory: proposal.inventory_ref, proposal: proposal.ref, interpretation_review: interpretation.ref, publication: publication.adoption_publication_ref, baseline_release: acceptedBaseline.release.ref, changed_release: acceptedChange.release.ref, initial_binding: binding.ref };
    report.accepted_intent = { baseline: { ref: acceptedBaseline.release.ref, validation: acceptedBaseline.validation.ref, approvals: acceptedBaseline.approvals }, changed: { ref: acceptedChange.release.ref, validation: acceptedChange.validation.ref, approvals: acceptedChange.approvals }, literal_delta: 'ceiling 6 to 12; positive safe integers and atomic rejection preserved' };
    assert.deepEqual(await pins(), before); assert.deepEqual(await bytes(), originalBytes);
    for (const [name, accepted] of [['independent-baseline', acceptedBaseline], ['independent-change', acceptedChange]] as const) {
      const materialized = await ok(['materialize', accepted.release.ref, '--profile', 'counter-fixture/1', '--out', '.strata/' + name]);
      const manifest = JSON.parse(await readFile(materialized.manifest, 'utf8'));
      const measured = await runFixtureEvidence(path.dirname(materialized.manifest), manifest.record, accepted.oracle as any);
      assert.deepEqual(measured.observations, accepted.measured.observations); await json(name + '-measurement', measured);
      report[name] = { realization_ref: manifest.realization_ref, output_tree: manifest.record.output_tree, observations_sha256: digest(measured.observations), location: path.relative(root, path.dirname(materialized.manifest)) };
    }
    assert.equal(await readFile(path.join(app, 'counter.mjs'), 'utf8'), acceptedBaseline.manifest.record.files['counter.mjs']);
    async function preservedTestRun(label: string, expectedModule: string) {
      assert.equal(await readFile(path.join(app, 'counter.test.mjs'), 'utf8'), preservedTests); assert.equal(await readFile(path.join(app, 'counter.mjs'), 'utf8'), expectedModule);
      const result = await command(['--test', path.join(app, 'counter.test.mjs')], '', 'fixture-owner', label, 30000); assert.equal(result.exit, 0, result.stderr);
    }
    await preservedTestRun('original-fixed-tests', old.files['counter.mjs']);
    if (route === 'incremental') {
      const planInput={ binding_ref: binding.ref, target_ref: candidate.ref, write_paths: ['counter.mjs'], checker: applicationCheckerPins(acceptedChange.oracle as any), oracle: acceptedChange.oracle, regressions: ['unrelated-byte-preservation'] };
      let plan:any;
      if(options.adoptionBridge){
        const input={...planInput,adoption:{publication_ref:publication.adoption_publication_ref,expected_bridge_sha256:null}};
        const preview=await ok(['git','plan','--file','-','--dry-run'],input,'fixture-a');assert.equal(preview.execution_ready,false);assert.equal(preview.disclosure_required,true);
        await json('bridge-preview',preview);input.adoption.expected_bridge_sha256=preview.bridge_sha256;
        plan=await ok(['git','plan','--file','-','--idempotency-key','g2-plan'],input,'fixture-a');assert.equal(plan.record.format,'git-change-plan/2');await json('bridge-plan',plan);
        report.adoption_delivery_bridge_established=true;report.refs.bridge_plan=plan.ref;
      }else plan=await ok(['git','plan','--file','-'],planInput);
      const originalLines = old.files['counter.mjs'].trimEnd().split('\n'), changedLines = acceptedChange.manifest.record.files['counter.mjs'].trimEnd().split('\n'); assert.equal(originalLines.length, changedLines.length);
      const patch = 'diff --git a/counter.mjs b/counter.mjs\n--- a/counter.mjs\n+++ b/counter.mjs\n@@ -1,' + originalLines.length + ' +1,' + changedLines.length + ' @@\n' + originalLines.map((line, i) => line === changedLines[i] ? ' ' + line : '-' + line + '\n+' + changedLines[i]).join('\n') + '\n';
      const patchFile = path.join(root, 'selected-change.patch'); await writeFile(patchFile, patch, { flag: 'wx' });
      const stage = await ok(['git', 'stage', plan.ref, '--patch', patchFile]); const oracleFile = await json('application-oracle', acceptedChange.oracle);
      const acceptance = await ok(['git', 'check', stage.ref, '--checker', APPLICATION_CHECKER, '--oracle', oracleFile], undefined, 'fixture-runner');
      const request: any = { stage: stage.ref, acceptance: acceptance.ref, release: acceptedChange.release.ref, expected_target_sha256: null, accepted: true, rationale: options.adoptionBridge?'Exact disclosed adoption bridge, staged fixture patch and complete finite observations.':'Exact staged fixture patch and finite application observations; no automatic adopted-unit bridge.' };
      const preview = await ok(['git', 'review', '--file', '-', '--dry-run'], request, 'fixture-selector'); request.expected_target_sha256 = preview.target_sha256;
      const review = await ok(['git', 'review', '--file', '-'], request, 'fixture-selector');
      await refuse('wrong-actor', ['git', 'apply', stage.ref, '--review', review.ref], undefined, 'fixture-release', ['OPERATION_FORBIDDEN']);
      const protectedFile = path.join(app, 'unrelated.txt'), protectedBytes = await readFile(protectedFile);
      try { await writeFile(protectedFile, 'Synthetic owner drift\n'); await refuse('dirty-protected-source', ['git', 'apply', stage.ref, '--review', review.ref], undefined, 'fixture-selector', ['UNSUPPORTED_CHECKOUT_TRANSFORM']); assert.equal(await readFile(path.join(app, 'counter.mjs'), 'utf8'), old.files['counter.mjs']); }
      finally { await writeFile(protectedFile, protectedBytes); }
      failWrite = true; try { await refuse('fixed-write-failure', ['git', 'apply', stage.ref, '--review', review.ref, '--idempotency-key', 'q1-write-failure'], undefined, 'fixture-selector', ['STORE_UNAVAILABLE']); } finally { failWrite = false; }
      assert(writeFaultTriggered, 'Fixed fault must occur after the staged write.');
      assert.deepEqual(await pins(), before); assert.deepEqual(await bytes(), originalBytes);
      const rolledBack = await ok(['git', 'transaction', 'inspect', '--file', '-'], { repo_id: repoId }, 'fixture-selector'); assert.equal(rolledBack.state, 'rolled_back'); report.rollback = { state: rolledBack.state, fixed_post_write_fault_triggered: writeFaultTriggered, original_bytes_and_git_restored: true };
      const applied = await ok(['git', 'apply', stage.ref, '--review', review.ref, '--idempotency-key', 'q1-apply'], undefined, 'fixture-selector'); assert.equal(applied.record.state, 'applied-awaiting-owner-commit'); assert.deepEqual(await pins(), before);
      const retry = await ok(['git', 'apply', stage.ref, '--review', review.ref, '--idempotency-key', 'q1-apply'], undefined, 'fixture-selector'); assert.equal(retry.ref, applied.ref);
      await refuse('no-owner-commit', ['git', 'finalize', applied.ref, '--commit', before.head_commit], undefined, 'fixture-selector', ['UNSUPPORTED_CHECKOUT_TRANSFORM']);
      const afterApply = await bytes(); for (const name of ['.gitattributes', 'counter.test.mjs', 'image.bin', 'unrelated.txt']) assert.equal(afterApply[name], originalBytes[name]);
      await preservedTestRun('changed-fixed-tests', acceptedChange.manifest.record.files['counter.mjs']);
      await runGit(app, ['add', '--', 'counter.mjs']); await runGit(app, ['commit', '--quiet', '-m', 'Synthetic owner accepts reviewed selected patch']);
      const commit = decodeGit(await runGit(app, ['rev-parse', 'HEAD'])).trim(), finalization = await ok(['git', 'finalize', applied.ref, '--commit', commit], undefined, 'fixture-selector');
      const successorSource = await ok(['source', 'capture', '--file', '-'], { repo_id: repoId, scope: bindingScope, expected_head: commit }, 'fixture-selector'), changedRecord = await ok(['inspect', 'release', acceptedChange.release.ref]);
      const successorPayload = { ...payload, intent: { release_ref: acceptedChange.release.ref, release_sha256: digest(changedRecord), snapshot_sha256: digest(candidate.snapshot), model_version: MODEL }, source_ref: successorSource.ref, source_sha256: successorSource.source_sha256, previous_binding_ref: binding.ref, completion_ref: finalization.ref, acceptance_evidence_refs: [acceptance.ref] };
      const successor = await ok(['source', 'bind', '--file', '-'], { payload: successorPayload, expected_payload_sha256: digest(successorPayload), rationale: 'Associate exact owner committed fixture result through existing native finalization.', review_refs: [review.ref] }, 'fixture-selector'); assert.equal(successor.state, 'accepted-association'); assert.equal(successor.behavior_verified, false);
      Object.assign(report.refs, { plan: plan.ref, stage: stage.ref, application_acceptance: acceptance.ref, apply_review: review.ref, apply_receipt: applied.ref, native_finalization: finalization.ref, successor_source: successorSource.ref, successor_binding: successor.ref });
      const after = await pins(); assert.equal(after.branch, before.branch); assert(after.refs.includes('refs/heads/untouched-history ' + before.head_commit));
      report.delivery = { state: 'owner-committed-and-natively-finalized', owner_commit: commit, engine_implicitly_committed: false, before_owner_commit_head_and_index_preserved: true, untouched_paths_preserved: true, cached_apply_reused: retry.ref === applied.ref, git_after: after };
    } else {
      assert.deepEqual(await pins(), before); assert.deepEqual(await bytes(), originalBytes);
      report.delivery = { state: 'independent-reconstruction-qualified', original_git_and_all_bytes_unchanged: true, cutover_performed: false, native_apply_performed: false, owner_commit_performed: false };
    }
    const releaseBeforeRestart = await ok(['inspect', 'release', acceptedChange.release.ref]), bindingBeforeRestart = await ok(['inspect', 'source-binding', report.refs.successor_binding ?? binding.ref]);
    await broker!.close(); broker = undefined; await start();
    assert.equal(digest(await ok(['inspect', 'release', acceptedChange.release.ref])), digest(releaseBeforeRestart));
    const restoredBinding = await ok(['inspect', 'source-binding', report.refs.successor_binding ?? binding.ref]); assert.deepEqual(restoredBinding, bindingBeforeRestart);
    report.restart = { accepted_release_visible: true, exact_binding_visible: restoredBinding.payload.source_ref === (report.refs.successor_source ?? bindingSource.ref) };
    assert(report.restart.exact_binding_visible); await broker!.close(); broker = undefined;
    const backup = await ok(['backup', 'create', '--out', path.join(root, 'inactive-backup'), '--state-dir', 'state', '--max-bytes', '16777216'], undefined, 'fixture-backup');
    const verified = await ok(['backup', 'verify', path.join(root, 'inactive-backup'), '--expect-project', projectId, '--expect-digest', backup.manifest_sha256], undefined, 'fixture-backup'); assert(backup.inactive && verified.verified);
    report.backup = { inactive: true, verified: true, manifest_sha256: backup.manifest_sha256, no_identity_or_grants_restored: true };
    report.status = 'qualified_fixture_lane'; report.original_after = { git: await pins(), bytes: await bytes() };
    report.honest_stop = options.adoptionBridge?'Exact reviewed adoption-to-selected-Git bridge and native owner finalization qualified for the fixed local counter lane; no arbitrary equivalence, reconciliation completion or authenticated execution.':route === 'incremental' ? 'Existing native selected delivery and owner association qualified; no first-class adoption/output bridge or reconciliation completion.' : 'Declared fixed counter baseline/change reconstruction qualified; original app retained; no full-app equivalence, state migration or cutover.';
  } catch (error) { report.status = 'failed'; report.failure = error instanceof Error ? error.message : String(error); }
  finally { if (broker) await broker.close(); report.host_closed = true; report.finished_utc = new Date().toISOString(); await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  return report;
}
