import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildAdapterFixture, indexedBuildRecords } from './build-adapter-fixture.js';
import { localBuildHttpHandler } from '../src/build-http.js';
import { runLocalBuildCli, parseLocalBuildCli } from '../src/commands/build-cli.js';
import { canonical, digest, StrataError } from '../src/model.js';
import { verifyBuildAttempts, latestAttempt } from '../src/build-attempt-records.js';
import { openLocalBuildRepository } from '../src/build-repository-node.js';
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.js';
import { INACTIVE_MARKER, STATE_LEASE } from '../src/node-state.js';
import { runCli, parseArgs } from '../src/cli.js';
import { StudioCommands } from '../src/explorer/commands.js';
import { startExplorer } from '../src/explorer/host.js';
import { LocalBuildStudioAdapter, PROFILES_BUILD_COMMANDS } from '../src/build-studio.js';
import { spawn } from 'node:child_process';

const code = (value: string) => (error: any) => error.code === value;
test('authenticated CLI/HTTP saves exact profiles and runs a durable fresh Release-targeted finite build', async () => {
  const f = await buildAdapterFixture('vertical');
  const handler = localBuildHttpHandler(f.repository, { resolve: async req => f.issuer.resolve(String(req.headers['x-strata-session'] ?? ''), String(req.headers['x-strata-project'] ?? '')) });
  const server = createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as any, url = `http://127.0.0.1:${address.port}/v1/operation`;
  const call = async (command: string, input: unknown, options: any = {}) => {
    const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': f.tokens.runner, 'x-strata-project': f.issuer.projectId,
      ...(options.expected_generation ? { 'x-strata-expected-generation': options.expected_generation } : {}), ...(options.expected_policy ? { 'x-strata-expected-policy': options.expected_policy } : {}) }, body: JSON.stringify({ command, input, options: { idempotency_key: options.idempotency_key, dry_run: options.dry_run } }) });
    const response: any = await result.json(); if (!response.ok) throw new StrataError(response.error.code, response.error.exit, response.error.message, response.error.details); return response;
  };
  try {
    const profile = await runLocalBuildCli(['profiles', 'validate', '--file', '-', '--release', f.release.ref], call, JSON.stringify(f.profileRequest.record));
    const direct = await f.repository.execute('profile.validate', { record: f.profileRequest.record, target_ref: f.release.ref }, f.context());
    assert.equal(canonical(profile.data), canonical(direct.data)); assert.equal(profile.data.report.normalized_sha256, f.profileRequest.expected_normalized_sha256);
    await writeFile(path.join(path.dirname(f.state), 'strata.config.json'), JSON.stringify({ schema_version: '1', model_version: f.baseline.model_version, project_id: f.issuer.projectId,
      broker: url.replace('/v1/operation', '/'), artifact_adapter: 'local-persistent-fake', identity_policy: 'trusted-local-fixture-sessions', profiles: ['collection-host/1'], network_policy: 'loopback-only' }));
    const cli = await runCli(['profiles', 'validate', '--file', '-', '--release', f.release.ref, '--project', path.dirname(f.state)], JSON.stringify(f.profileRequest.record), { STRATA_SESSION: f.tokens.runner });
    assert.equal(cli.ok, true); assert.equal(canonical(cli.data), canonical(direct.data));
    assert.equal(parseArgs(['materialize', f.release.ref, '--profile', 'collection-host/1', '--out', 'legacy']).command, 'materialize');
    await assert.rejects(parseLocalBuildCli(['build', '--profile', f.saved.ref]), code('INVALID_ARGUMENT'));
    const before = await readFile(path.join(f.state, 'registry.json'), 'utf8');
    const args = ['--release', f.release.ref, '--profile-ref', f.saved.ref, '--slot', f.output.slot.id];
    const prepared = await runLocalBuildCli(['build', 'plan', ...args, '--destination', 'local'], call);
    assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), before);
    assert.equal((await runLocalBuildCli(['build', 'context'], call)).data.run_application, false);
    const start = await runLocalBuildCli(['build', ...args, '--destination', 'local', '--expect-plan', prepared.data.plan_sha256, '--idempotency-key', 'vertical'], call);
    assert.equal(start.data.phase, 'completed'); assert.equal(start.data.verification.bytes, true); assert.equal(start.data.verification.mechanical, true); assert.equal(start.data.verification.fresh_semantic_validation, false);
    const records = await indexedBuildRecords(f.state); verifyBuildAttempts(records, f.issuer.projectId);
    const measured = records[start.data.host_run.ref].data;
    assert.notEqual(start.data.host_run.ref, f.sourceRun.ref); assert.equal(records[measured.realization].data.target, f.release.ref);
    assert.equal(measured.producer, 'runner'); assert.equal(measured.checker_sha256, records[measured.realization].data.checker_sha256);
    const output = await runLocalBuildCli(['build', 'outputs', start.data.build_id], call), module = output.data.files.find((file: any) => file.name === 'collection.mjs');
    assert(module);
    const response = await fetch(url + '/outputs?build_id=' + start.data.build_id + '&file_id=' + module.file_id, { headers: { 'x-strata-session': f.tokens.runner, 'x-strata-project': f.issuer.projectId } });
    assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString(), records[start.data.realization.ref].data.files['collection.mjs']);
    const app = await import(pathToFileURL(path.join(f.output.slot.root, start.data.allocation.relative, 'collection.mjs')).href);
    const collection = app.createCollection(); assert.deepEqual(collection.list(), []);
    assert.deepEqual(collection.add('demo', 'A task'), { accepted: true, item: { id: 'demo', title: 'A task', completed: false } });
    assert.deepEqual(collection.complete('demo'), { accepted: true, item: { id: 'demo', title: 'A task', completed: true } });
    assert.deepEqual(collection.remove('demo'), { accepted: true, item: { id: 'demo', title: 'A task', completed: true } });
    assert.deepEqual(collection.list(), []); assert.deepEqual(app.createCollection().list(), []);
    await f.reopen();
    assert.equal((await f.repository.execute('build.inspect', { build_id: start.data.build_id }, f.context())).data.phase, 'completed');
    const replay = await f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: prepared.data.plan_sha256 }, f.context(), { key: 'vertical' });
    assert.equal(replay.data.host_run.ref, start.data.host_run.ref);
    await assert.rejects(f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: 'f'.repeat(64) }, f.context(), { key: 'vertical' }), code('IDEMPOTENCY_CONFLICT'));
    assert.equal(canonical(await indexedBuildRecords(f.state)), canonical(records));
    await assert.rejects(f.repository.download(start.data.build_id, 'f'.repeat(64), f.context()), code('OUTPUT_LOCATOR_INVALID'));
    await writeFile(path.join(f.output.slot.root, start.data.allocation.relative, 'collection.mjs'), 'changed after completion');
    await assert.rejects(f.repository.download(start.data.build_id, module.file_id, f.context()), code('OUTPUT_TAMPERED'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.repository.close(); }
});

test('Studio routes share real profile persistence/CAS and refuse unconfigured namespace-style commands', async () => {
  const f = await buildAdapterFixture('studio');
  const client = (options: any) => (command: string, input: unknown) => f.repository.execute(command, input, f.context(), { key: options.idempotency_key, expected_generation: options.expected_generation, expected_policy: options.expected_policy, dry_run: options.dry_run });
  const commands = new StudioCommands({ project_id: f.issuer.projectId, model_version: f.baseline.model_version }, '', f.root, [...PROFILES_BUILD_COMMANDS], {}, 'local-fixture', () => { f.issuer.assertLive(f.context()); return f.issuer.accessBinding(); }, client, undefined, new LocalBuildStudioAdapter(f.repository, () => f.context()));
  const host = await startExplorer(commands.reader, { assets: path.resolve('explorer'), commands });
  const headers = { authorization: 'Bearer ' + host.capability, origin: host.origin, 'content-type': 'application/json' };
  try {
    const list: any = await (await fetch(host.origin + '/studio/v1/profiles', { headers })).json(); assert.equal(list.data.profiles[0].ref, f.saved.ref);
    const source: any = await (await fetch(host.origin + '/studio/v1/repository/compatibility?release_ref=' + encodeURIComponent(f.release.ref), { headers })).json();
    assert.equal(source.data.binding.ref, f.binding.ref); assert.equal(source.data.contract_binding, 'post_publication_adoption');
    const snapshot = await f.repository.snapshot(f.context()), revised = { previous: f.saved.ref, record: { ...f.profileRequest.record, revision: 2, name: 'Renamed via Studio' }, expected_normalized_sha256: '' };
    const oldPlan = (await f.repository.execute('build.prepare', f.selection, f.context())).data;
    revised.expected_normalized_sha256 = digest(revised.record);
    const request = { command: 'profile.revise', input: revised, idempotency_key: 'studio-revise', expected_generation: snapshot.generation, expected_policy: snapshot.policy_generation };
    const result: any = await (await fetch(host.origin + '/studio/v1/operation', { method: 'POST', headers, body: JSON.stringify(request) })).json();
    assert.equal(result.data.data.record.name, 'Renamed via Studio');
    const replay: any = await (await fetch(host.origin + '/studio/v1/operation', { method: 'POST', headers, body: JSON.stringify(request) })).json(); assert.equal(replay.data.reused, true);
    const stale: any = await (await fetch(host.origin + '/studio/v1/operation', { method: 'POST', headers, body: JSON.stringify({ ...request, idempotency_key: 'other-revision' }) })).json(); assert.equal(stale.error.code, 'STALE_GENERATION');
    const readonly = new StudioCommands({ project_id: f.issuer.projectId, model_version: f.baseline.model_version }, '', f.root, [], {}, 'local-fixture', undefined, client);
    const capability = await readonly.read('capabilities');
    assert(capability.operations.filter((r: any) => PROFILES_BUILD_COMMANDS.includes(r.operation)).every((r: any) => !r.configured && !r.supported));
    await assert.rejects(readonly.read('build.context', {}), code('UNSUPPORTED_CAPABILITY'));
    await assert.rejects(readonly.operation({ ...request, command: 'build.start', input: {} }), code('UNSUPPORTED_CAPABILITY'));
    assert.equal((await f.repository.execute('profile.inspect', { ref: f.saved.ref }, f.context())).data.record.name, 'Local preview');
    await assert.rejects(f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: oldPlan.plan_sha256 }, f.context(), { key: 'stale-plan' }), code('BUILD_PLAN_STALE'));
  } finally { await host.close(); commands.close(); await f.repository.close(); }
});

test('lost original registration response recovers under current scoped read authority without replay or measurement', async () => {
  let lose = true;
  const f = await buildAdapterFixture('receipt-loss', { afterCommit: async action => { if (action === 'realization.register' && lose) { lose = false; throw new Error('fixture lost response'); } } });
  try {
    const prepared = (await f.repository.execute('build.prepare', f.selection, f.context())).data;
    const result = (await f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: prepared.plan_sha256 }, f.context(), { key: 'lost' })).data;
    assert.equal(result.phase, 'exporting'); assert.equal(result.realization, null); assert.equal(result.error.code, 'BUILD_RECONCILIATION_REQUIRED');
    const before = await indexedBuildRecords(f.state), child = Object.values(before).find(r => r.type === 'build-child-receipt')!;
    assert.equal(child.data.command, 'realization.register'); assert.equal(child.data.actor, 'runner');
    const status = (await f.repository.execute('operation.inspect', { key: 'lost' }, f.context())).data;
    assert.equal(status.state, 'committed'); assert.equal(status.result.data.build_id, result.build_id);
    await f.reopen();
    const revoked = structuredClone(f.policy); revoked.generation++; revoked.grants.find((g: any) => g.principal_id === 'runner').operations = ['inspect', 'build.inspect', 'build.outputs'];
    f.issuer.reload(f.accounts, revoked);
    assert.equal(await f.repository.reconcile(f.context('release-manager')), 1);
    const after = await indexedBuildRecords(f.state), run = latestAttempt(after, result.build_id)![1].data.run;
    assert.equal(run.phase, 'interrupted'); assert.equal(run.realization.ref, child.data.result.ref); assert.equal(run.host_run, null);
    assert.equal(Object.values(after).filter(r => r.type === 'build-child-receipt').length, 1);
    assert.equal(Object.values(after).filter(r => r.type === 'host-run').length, Object.values(before).filter(r => r.type === 'host-run').length);
    assert.equal(await f.repository.reconcile(f.context('release-manager')), 0);
    const originalAuth = after[child.data.authentication.ref].data;
    assert.equal(originalAuth.action, 'realization.register'); assert.equal(originalAuth.input_sha256, digest({ record: after[child.data.result.ref].data }));
    await assert.rejects(f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: prepared.plan_sha256 }, f.context(), { key: 'lost' }), code('OPERATION_FORBIDDEN'));
  } finally { await f.repository.close(); }
});

test('absent original receipt stays unknown; a wrong-action or cross-repository rehashed receipt is rejected', async () => {
  let refuse = true;
  const f = await buildAdapterFixture('receipt-absence', { beforeCommit: async action => { if (action === 'realization.register' && refuse) { refuse = false; throw new Error('fixture precommit outage'); } } });
  try {
    const prepared = (await f.repository.execute('build.prepare', f.selection, f.context())).data;
    const result = (await f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: prepared.plan_sha256 }, f.context(), { key: 'absent' })).data;
    await f.reopen();
    assert.equal(await f.repository.reconcile(f.context('release-manager')), 0);
    const before = await indexedBuildRecords(f.state), run = latestAttempt(before, result.build_id)![1].data.run;
    assert.equal(run.phase, 'exporting'); assert.equal(run.realization, null);
    assert.equal(Object.values(before).filter(r => r.type === 'build-child-receipt').length, 0);
    // Exact saved/adopted bindings are required even when the semantic Release is approved.
    await assert.rejects(f.repository.execute('build.prepare', { ...f.selection, profile_ref: f.contract.ref }, f.context()), code('REF_NOT_FOUND'));
    const second = (await f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: prepared.plan_sha256 }, f.context(), { key: 'fresh' })).data;
    assert.equal(second.phase, 'completed');
    const records = await indexedBuildRecords(f.state), [ref, stored] = Object.entries(records).find(([, r]) => r.type === 'build-child-receipt' && r.data.command === 'realization.register')!;
    for (const change of [{ command: 'evidence.run' }, { repository_id: 'other' }, { actor: 'author-a' }]) {
      const bad = structuredClone(records), data = { ...stored.data, ...change }; delete bad[ref]; bad['build-child-receipt@' + digest(data)] = { ...stored, data };
      assert.throws(() => verifyBuildAttempts(bad, f.issuer.projectId));
    }
    await assert.rejects(openLocalBuildRepository({ ...f.config, scope: { ...f.config.scope, repository_id: 'other' } }), code('STATE_BUSY'));
    await f.repository.close();
    const foreign = await openLocalBuildRepository({ ...f.config, scope: { ...f.config.scope, repository_id: 'other' } });
    try { await assert.rejects(foreign.execute('build.inspect', { build_id: second.build_id }, f.context()), code('REPOSITORY_FORBIDDEN')); }
    finally { await foreign.close(); }
  } finally { await f.repository.close(); }
});

test('current authority is checked before atomic measurement commit and before output download', async () => {
  let revoke = false;
  const f = await buildAdapterFixture('revocation', { beforeCommit: async action => {
    if (action === 'evidence.run' && revoke) { revoke = false; const changed = structuredClone(f.policy); changed.generation++; changed.grants.find((g: any) => g.principal_id === 'runner').operations = ['inspect', 'build.inspect']; f.issuer.reload(f.accounts, changed); }
  } });
  try {
    const plan = (await f.repository.execute('build.prepare', f.selection, f.context())).data; revoke = true;
    await assert.rejects(f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: plan.plan_sha256 }, f.context(), { key: 'revoke' }));
    const records = await indexedBuildRecords(f.state), latest = Object.values(records).filter(r => r.type === 'build-attempt-revision').sort((a, b) => b.data.revision - a.data.revision)[0].data.run;
    assert.equal(latest.phase, 'checking'); assert.equal(latest.host_run, null);
    assert.equal(Object.values(records).filter(r => r.type === 'build-child-receipt' && r.data.command === 'evidence.run').length, 0);
    await assert.rejects(f.repository.download(latest.build_id, 'f'.repeat(64), f.context()), code('OPERATION_FORBIDDEN'));
    // Without an original committed measurement receipt, recovery must preserve
    // the unknown outcome just as it does an absent registration receipt.
    assert.equal(await f.repository.reconcile(f.context('release-manager')), 0);
    const after = await indexedBuildRecords(f.state);
    assert.equal(latestAttempt(after, latest.build_id)![1].data.run.phase, 'checking');
    assert.equal(Object.values(after).filter(r => r.type === 'build-child-receipt' && r.data.command === 'evidence.run').length, 0);
  } finally { await f.repository.close(); }
});

test('build history uses inactive backup/4, preserves historical archives, and never restores active authority', async () => {
  const f = await buildAdapterFixture('backup');
  const plan = (await f.repository.execute('build.prepare', f.selection, f.context())).data;
  const run = (await f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: plan.plan_sha256 }, f.context(), { key: 'backup' })).data;
  const records = await indexedBuildRecords(f.state); await f.repository.close();
  const bundle = path.join(path.dirname(f.state), 'backup'), restored = path.join(path.dirname(f.state), 'restored');
  const backup = await createBackup({ state: f.state, out: bundle, project: f.issuer.projectId, selector: 'fixture-backup', maxBytes: 16 * 1024 ** 2 });
  assert.equal(backup.format, 'strata-local-backup/4');
  const verified = await verifyBackup({ bundle, project: f.issuer.projectId, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 }); assert.equal(verified.inactive, true);
  await restoreBackup({ bundle, out: restored, project: f.issuer.projectId, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
  assert.equal(JSON.parse(await readFile(path.join(restored, INACTIVE_MARKER), 'utf8')).identities_active, false);
  const checkpoint = JSON.parse(await readFile(path.join(restored, 'checkpoint.json'), 'utf8'));
  for (const [ref, r] of Object.entries(records)) assert.equal(await readFile(path.join(restored, 'artifacts', checkpoint.entries[ref].hash + '.json'), 'utf8'), canonical(r.data));
  assert(checkpoint.entries[latestAttempt(records, run.build_id)![0]]);
  await assert.rejects(openLocalBuildRepository({ ...f.config, state_directory: restored }), code('RECOVERY_INACTIVE'));
});

test('actual process death retains the installation lease and refuses automatic stale-lock recovery', async () => {
  const f = await buildAdapterFixture('process-death'); await f.repository.close();
  const module = pathToFileURL(path.resolve('dist/src/node-state.js')).href;
  const script = `import {bindNodeState} from ${JSON.stringify(module)}; await bindNodeState(${JSON.stringify(f.state)},${JSON.stringify(f.issuer.projectId)},${JSON.stringify(f.baseline.model_version)}); process.exit(86);`;
  const exit = await new Promise<number | null>((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exit, 86); assert.equal(JSON.parse(await readFile(path.join(f.state, STATE_LEASE), 'utf8')).role, 'broker');
  await assert.rejects(openLocalBuildRepository(f.config), code('STATE_BUSY'));
  // The disposable evidence retains the stale lock; there is no production remover.
});

test('graceful close stops admission while retaining the lease until accepted effects finish', async () => {
  let allowCommit!: () => void, reached!: () => void;
  const blocked = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { allowCommit = resolve; });
  const f = await buildAdapterFixture('close', { beforeCommit: async action => { if (action === 'realization.register') { reached(); await gate; } } });
  const plan = (await f.repository.execute('build.prepare', f.selection, f.context())).data;
  const running = f.repository.execute('build.start', { selection: f.selection, expected_plan_sha256: plan.plan_sha256 }, f.context(), { key: 'close' });
  await blocked;
  const closed = f.repository.close();
  await assert.rejects(f.repository.execute('profile.list', {}, f.context()));
  await assert.rejects(openLocalBuildRepository(f.config), code('STATE_BUSY'));
  allowCommit();
  const completed = await running; assert.equal(completed.data.phase, 'completed'); await closed;
  const reopened = await openLocalBuildRepository(f.config);
  try { assert.equal((await reopened.execute('build.inspect', { build_id: completed.data.build_id }, f.context())).data.phase, 'completed'); }
  finally { await reopened.close(); }
});
