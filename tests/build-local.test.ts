import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, symlink, link, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bytesDigest, canonical, digest } from '../src/model.js';
import { assertFlatOutputNames, LocalBuildOutput, windowsOutputProtection, unixOutputProtection, assessWindowsOutputProtection, assessUnixOutputProtection } from '../src/build-output.js';
import { preflightLocalHost } from '../src/build-host.js';
import { describeBuildOptions } from '../src/build-options.js';
import { profileFor } from '../src/profiles.js';
import { LocalBuildCoordinator, assertBuildRun, buildPlanSchema, buildRunSchema } from '../src/build.js';
import { localBuildFixture } from './build-local-fixture.js';
import { hostRunSchema } from '../src/auth/records.js';

const code = (wanted: string) => (e: any) => e.code === wanted;
test('portable flat filenames refuse traversal, devices, ADS, case aliases and overlarge output', () => {
  for (const name of ['../escaped', '/absolute', 'C:\\drive', 'file:ads', 'CON.txt', 'LPT9', 'trail.', 'sub/file', '\\server\\share', 'realization.json']) assert.throws(() => assertFlatOutputNames({ [name]: 'x' }), code('OUTPUT_NAME_UNSAFE'));
  assert.throws(() => assertFlatOutputNames({ 'Readme.md': 'a', 'README.md': 'b' }), code('OUTPUT_NAME_UNSAFE'));
  assert.throws(() => assertFlatOutputNames({ 'large.txt': 'x'.repeat(1048577) }), code('OUTPUT_LIMIT'));
  assertFlatOutputNames({ 'collection.mjs': 'export {}', 'README.md': 'finite module' });
});
test('Windows ACL and Debian ownership/mode evaluation refuse unsafe custody independently of host OS', () => {
  const sid = 'S-1-5-21-1-2-3-4', root = { reparse: false, owner: sid, rules: [{ sid, allow: true, inherit_only: false, rights: 2032127 }] };
  assert.equal(assessWindowsOutputProtection([root], sid), true);
  assert.equal(assessWindowsOutputProtection([{ ...root, reparse: true }], sid), false);
  assert.equal(assessWindowsOutputProtection([{ ...root, rules: [...root.rules, { sid: 'S-1-1-0', allow: true, inherit_only: false, rights: 1179785 }] }], sid), false);
  assert.equal(assessWindowsOutputProtection([root, { ...root, rules: [{ sid: 'S-1-1-0', allow: true, inherit_only: false, rights: 65536 }] }], sid), false);
  assert.equal(assessUnixOutputProtection({ uid: 1000, mode: 0o40700 }, [{ uid: 0, mode: 0o41777 }, { uid: 0, mode: 0o40755 }], 1000), true);
  assert.equal(assessUnixOutputProtection({ uid: 1000, mode: 0o40755 }, [], 1000), false);
  assert.equal(assessUnixOutputProtection({ uid: 1001, mode: 0o40700 }, [], 1000), false);
  assert.equal(assessUnixOutputProtection({ uid: 1000, mode: 0o40700 }, [{ uid: 0, mode: 0o40777 }], 1000), false);
});

test('preflight is read-only and independently reports runtime, tooling, custody and verification', async () => {
  const f = await localBuildFixture('preflight'), before = canonical(f.engine.records);
  const p = await f.coordinator.prepare(f.selection); buildPlanSchema.parse(p.plan);
  assert.equal(p.plan.source_trust, 'local-fixture'); assert.equal(p.plan.environment.node_version, process.version);
  assert.equal(canonical(f.engine.records), before); assert.deepEqual(await readdir(f.root), []); assert.deepEqual(f.operations, []);
  const requirements = describeBuildOptions(profileFor('collection-host/1')).requirements;
  for (const [host, codes] of [
    [{ ...f.getHost(), node_version: 'v9.99.0' }, ['HOST_RUNTIME_VERSION_UNSUPPORTED', 'TOOLCHAIN_MISSING']],
    [{ ...f.getHost(), node_version: null }, ['HOST_RUNTIME_MISSING', 'TOOLCHAIN_MISSING']],
    [{ ...f.getHost(), os: 'darwin', arch: 'ia32' }, ['TARGET_OS_INCOMPATIBLE', 'TARGET_ARCH_INCOMPATIBLE']],
    [{ ...f.getHost(), runner: null }, ['RUNNER_UNAVAILABLE']]
  ] as const) {
    const report = await preflightLocalHost(host, f.output, requirements);
    for (const c of codes) assert(report.blockers.some(b => b.code === c));
    assert.equal(report.verify, false); assert.equal(report.run_application, false); assert.equal(report.serve_application, false);
    if (host.runner === null) assert.equal(report.materialize, true);
  }
  const unsafe = new LocalBuildOutput({ ...f.output.slot, protection: async () => ({ safe: false, fingerprint: digest('unsafe') }) });
  assert((await preflightLocalHost(f.getHost(), unsafe, requirements)).blockers.some(b => b.code === 'OUTPUT_ROOT_UNSAFE'));
  const overlap = new LocalBuildOutput({ ...f.output.slot, excluded_roots: [f.root] });
  await assert.rejects(overlap.preflight(), code('OUTPUT_ROOT_UNSAFE'));
});

test('real finite Release build retains separate byte/mechanical facts, opaque files and replay', async () => {
  const f = await localBuildFixture('complete'), prepared = await f.coordinator.prepare(f.selection), input = { selection: f.selection, expected_plan_sha256: prepared.plan_sha256 };
  const run = await f.coordinator.start(input, 'same-request'); buildRunSchema.parse(run); assertBuildRun(run);
  assert.equal(run.phase, 'completed'); assert.equal(run.verification.bytes, true); assert.equal(run.verification.mechanical, true); assert.equal(run.verification.fresh_semantic_validation, false);
  assert.notEqual(run.host_run!.ref, f.sourceRun.ref);
  assert.deepEqual(run.events.map(e => e.phase), ['accepted', 'materializing', 'exporting', 'verifying_bytes', 'checking', 'verifying_bytes', 'completed']);
  assert.equal(f.engine.read(run.realization!.ref).target, f.release.ref);
  const files = await f.coordinator.outputs(run.build_id);
  for (const file of files.files) {
    assert.match(file.file_id, /^[a-f0-9]{64}$/);
    const bytes = await f.coordinator.download(run.build_id, file.file_id);
    assert.equal(bytesDigest(bytes), file.sha256);
    assert.equal(bytes.length, file.bytes);
  }
  const before = f.operations.length; f.setGeneration(); f.setPolicy();
  assert.deepEqual(await f.coordinator.start(input, 'same-request'), run); assert.equal(f.operations.length, before);
  assert.equal((await new LocalBuildCoordinator(f.dependencies).inspect(run.build_id)).phase, 'completed');
  await assert.rejects(f.coordinator.start({ ...input, expected_plan_sha256: 'a'.repeat(64) }, 'same-request'), code('BUILD_REQUEST_CONFLICT'));
  await assert.rejects(f.coordinator.download(run.build_id, '../collection.mjs'), code('OUTPUT_LOCATOR_INVALID'));
  f.setAllowed(false); await assert.rejects(f.coordinator.start(input, 'same-request'), code('BUILD_FORBIDDEN')); await assert.rejects(f.coordinator.outputs(run.build_id), code('BUILD_FORBIDDEN'));
});

test('stale preview, bootstrap, cross-repository and broken binding refuse before accepting effects', async () => {
  const f = await localBuildFixture('refusals'), plan = await f.coordinator.prepare(f.selection);
  f.setGeneration(); await assert.rejects(f.coordinator.start({ selection: f.selection, expected_plan_sha256: plan.plan_sha256 }, 'stale'), code('BUILD_PLAN_STALE'));
  assert.equal(f.store.rows.size, 0); assert.deepEqual(await readdir(f.root), []);
  await assert.rejects(f.coordinator.prepare({ ...f.selection, release_ref: 'HostCollectionBaseline@1' }), code('BUILD_BOOTSTRAP_EXCLUDED'));
  await assert.rejects(f.coordinator.prepare({ ...f.selection, release_ref: f.target }), code('BUILD_RELEASE_REQUIRED'));
  f.profile.repository_id = 'elsewhere'; await assert.rejects(f.coordinator.prepare(f.selection), code('BUILD_REPOSITORY_MISMATCH'));
  f.profile.repository_id = 's2-demo'; f.binding.release.sha256 = 'a'.repeat(64); await assert.rejects(f.coordinator.prepare(f.selection), code('BUILD_BINDING_PIN_MISMATCH'));
});
test('concurrent duplicate dispatch owns one attempt and rechecks host before registration', async () => {
  const f = await localBuildFixture('concurrent'), p = await f.coordinator.prepare(f.selection), input = { selection: f.selection, expected_plan_sha256: p.plan_sha256 };
  const second = new LocalBuildCoordinator(f.dependencies);
  const runs = await Promise.all([f.coordinator.start(input, 'concurrent-key'), second.start(input, 'concurrent-key')]);
  assert.equal(runs[0].build_id, runs[1].build_id); assert.equal(f.store.rows.size, 1);
  assert.equal(f.operations.filter(c => c === 'realization.register').length, 1); assert.equal((await f.coordinator.inspect(runs[0].build_id)).phase, 'completed');
  const operation = f.dependencies.operation;
  f.dependencies.operation = async (command, request, key) => {
    const result = await operation(command, request, key);
    if (command === 'materialize') f.setHost({ ...f.getHost(), runner: null });
    return result;
  };
  const failed = await f.coordinator.start(input, 'host-drift');
  assert.equal(failed.phase, 'failed'); assert.equal(failed.error!.code, 'RUNNER_UNAVAILABLE'); assert.equal(failed.realization, null);
  assert.equal(f.operations.filter(c => c === 'realization.register').length, 1);
});

test('changed output, hard links and manifest paths cannot be downloaded as verified files', async () => {
  const f = await localBuildFixture('tamper'), p = await f.coordinator.prepare(f.selection);
  const run = await f.coordinator.start({ selection: f.selection, expected_plan_sha256: p.plan_sha256 }, 'tamper');
  const directory = await f.output.directory(run.allocation!);
  const file = run.inventory.find(v => v.name === 'collection.mjs')!;
  const original = await readFile(path.join(directory, file.name));
  await writeFile(path.join(directory, file.name), 'tampered');
  await assert.rejects(f.coordinator.download(run.build_id, file.file_id), code('OUTPUT_TAMPERED'));
  await writeFile(path.join(directory, file.name), original); await link(path.join(directory, file.name), path.join(path.dirname(f.root), 'hard-link'));
  await assert.rejects(f.coordinator.outputs(run.build_id), code('OUTPUT_TAMPERED'));
  const manifest = JSON.parse(await readFile(path.join(directory, 'realization.json'), 'utf8')); manifest.record.files = { '../outside': 'x' };
  await writeFile(path.join(directory, 'realization.json'), JSON.stringify(manifest)); await assert.rejects(f.coordinator.outputs(run.build_id), code('OUTPUT_TAMPERED'));
});

test('partial export retains realization and interrupted durable attempts never rerun effects', async () => {
  const f = await localBuildFixture('partial'), p = await f.coordinator.prepare(f.selection), dispatch = f.dependencies.operation;
  f.dependencies.operation = async (command, input, key) => {
    const result = await dispatch(command, input, key);
    if (command === 'realization.register') {
      const accepted = [...f.store.rows.values()][0];
      await writeFile(path.join(f.root, accepted.allocation!.relative, 'collection.mjs'), 'exclusive collision');
    }
    return result;
  };
  const input = { selection: f.selection, expected_plan_sha256: p.plan_sha256 }, partial = await f.coordinator.start(input, 'partial');
  assert.equal(partial.phase, 'output_incomplete'); assert(partial.realization); assert.equal(partial.inventory.length, 0);
  await assert.rejects(f.coordinator.outputs(partial.build_id), code('OUTPUT_UNAVAILABLE'));
  const count = f.operations.length; assert.deepEqual(await f.coordinator.start(input, 'partial'), partial); assert.equal(f.operations.length, count);
  f.dependencies.operation = dispatch;
  f.store.failReplace = run => ['checking', 'failed'].includes(run.phase);
  const uncertain = await f.coordinator.start(input, 'unknown-outcome');
  assert.equal(uncertain.phase, 'verifying_bytes'); assert.equal(uncertain.error!.code, 'BUILD_RECONCILIATION_REQUIRED');
  const pending = [...f.store.rows.values()].find(r => r.request_key === 'unknown-outcome')!; assert.equal(pending.phase, 'verifying_bytes');
  f.store.failReplace = null;
  const restarted = new LocalBuildCoordinator(f.dependencies), before = f.operations.length;
  assert.equal(await restarted.reconcile(), 1); assert.equal((await restarted.inspect(pending.build_id)).phase, 'interrupted');
  assert.equal((await restarted.start(input, 'unknown-outcome')).phase, 'interrupted'); assert.equal(f.operations.length, before);
});

test('mechanical tampering fails after checks and failed observations retain explicitly failed downloads', async () => {
  const f = await localBuildFixture('checking'), p = await f.coordinator.prepare(f.selection), checks = f.dependencies.runChecks;
  f.dependencies.runChecks = async input => {
    const measured = await checks(input);
    await writeFile(path.join(f.root, input.allocation.relative, 'collection.mjs'), 'changed after runner');
    return measured;
  };
  const tampered = await f.coordinator.start({ selection: f.selection, expected_plan_sha256: p.plan_sha256 }, 'post-check-tamper');
  assert.equal(tampered.phase, 'failed'); assert.equal(tampered.error!.code, 'OUTPUT_TAMPERED'); assert.equal(tampered.inventory.length, 0);
  f.dependencies.runChecks = async input => {
    const measured = await checks(input), record = hostRunSchema.parse(structuredClone(measured.run)); record.results[0].passed = false;
    const ref = 'host-run@' + digest(record); f.engine.store(ref, 'host-run', record);
    return { ref, run: record, checks_passed: false };
  };
  const failed = await f.coordinator.start({ selection: f.selection, expected_plan_sha256: p.plan_sha256 }, 'failed-checks');
  assert.equal(failed.phase, 'failed'); assert.equal(failed.verification.bytes, true); assert.equal(failed.verification.mechanical, false);
  assert.equal((await f.coordinator.outputs(failed.build_id)).state, 'failed');
});

test('root links and an existing allocation refuse rather than adopting foreign output', async () => {
  const f = await localBuildFixture('containment'), receipt = await f.output.preflight(), id = digest('allocation');
  await f.output.allocate('s2-demo', id, receipt);
  await assert.rejects(f.output.allocate('s2-demo', id, receipt), (e: any) => e.code === 'EEXIST');
  const alias = path.join(path.dirname(f.root), 'alias'); await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = new LocalBuildOutput({ ...f.output.slot, root: alias }); await assert.rejects(linked.preflight(), code('OUTPUT_ROOT_UNSAFE'));
});

test('native Windows ACL inspector reads custody and refuses broad access and reparse', { skip: process.platform !== 'win32' }, async () => {
  const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const execute = async (script: string) => (await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 5000, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PSModulePath: path.win32.join(path.win32.dirname(powershell), 'Modules') }
  })).stdout.trim();
  const sid = await execute('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-s2-acl-')), quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  await execute(`$p=${quote(root)}; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetOwner([Security.Principal.SecurityIdentifier]::new('${sid}')); $a.SetAccessRuleProtection($true,$false); foreach($s in @('${sid}','S-1-5-18','S-1-5-32-544')) { $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }; Set-Acl -LiteralPath $p -AclObject $a`);
  const inspector = windowsOutputProtection(powershell, sid);
  const custody = await inspector(root); assert.match(custody.fingerprint, /^[a-f0-9]{64}$/);
  const alias = root + '-junction'; await symlink(root, alias, 'junction'); assert.equal((await inspector(alias)).safe, false);
  const broadRoot = await mkdtemp(path.join(os.tmpdir(), 'strata-s2-broad-acl-'));
  await execute(`$p=${quote(broadRoot)}; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetOwner([Security.Principal.SecurityIdentifier]::new('${sid}')); $a.SetAccessRuleProtection($true,$false); foreach($s in @('${sid}','S-1-5-18','S-1-5-32-544')) { $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $p -AclObject $a`);
  assert.equal((await inspector(broadRoot)).safe, false);
  assert.equal((await unixOutputProtection()(root)).safe, false);
});
