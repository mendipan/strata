import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Engine } from '../src/core.js';
import { MODEL, CONTENT_MODEL, BLOCK_MODEL, canonical } from '../src/model.js';
import { FixtureIssuer, type AuthorityIssuer } from '../src/security.js';
import { HostIssuer, HOST_OPERATIONS } from '../src/auth/host-issuer.js';
import { executeAuthorized } from '../src/service.js';
import { startLocalBroker } from '../src/local-broker.js';
import { describeNativeSupport, nativeCapabilityFlags } from '../src/native-support.js';
import { GIT_OPERATIONS } from '../src/git-adoption.js';
import { APPLICATION_CHECKER } from '../src/git-application-checker.js';
import { runGit, gitPins } from '../src/git-workspace.js';
import type { SourceScope } from '../src/source-binding.js';

const operations = ['status', 'capabilities', 'source.capture', 'source.bind', ...GIT_OPERATIONS, 'drift.check', 'drift.propose', 'drift.review', 'adoption.prepare', 'adoption.review'];
const issuerFor = (now?: () => number, expires_at?: string) => new FixtureIssuer({ now, assignments: {
  probe: { principal: 'probe', operations, repositories: ['app'], git_paths: ['counter.mjs'], git_checkers: [APPLICATION_CHECKER], ...(expires_at ? { expires_at } : {}) }
} });
const row = (data: any, operation: string) => data.operations.find((r: any) => r.operation === operation);
const scope: SourceScope = { format: 'source-scope/1', coverage: 'selected-scope', paths: ['counter.mjs'], watch_roots: [], exclusions: [],
  items: ['counter/purpose'], mapping: [{ item: 'counter/purpose', paths: ['counter.mjs'], criteria: [] }], limitations: ['Synthetic selected source only.'] };
async function host() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-native-support-')), app = path.join(root, 'app');
  await mkdir(app); await runGit(app, ['init', '--quiet']);
  await runGit(app, ['config', 'user.name', 'Synthetic Fixture']); await runGit(app, ['config', 'user.email', 'fixture@example.invalid']);
  await runGit(app, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(app, 'counter.mjs'), 'export const value = 1;\n');
  await runGit(app, ['add', '--', 'counter.mjs']); await runGit(app, ['commit', '--quiet', '-m', 'Synthetic baseline']);
  return { root, app };
}
async function brokerFixture(model = MODEL, repositories: { projectId: string; repoId: string; root: string }[] = [], enabledCheckers: string[] = [], issuer: AuthorityIssuer = issuerFor(), backend = true, root?: string) {
  root ??= await mkdtemp(path.join(os.tmpdir(), 'strata-native-support-'));
  const directory = path.join(root, 'git-state'), state = path.join(root, 'state');
  const broker = await startLocalBroker(state, 0, { issuer, model_version: model as typeof MODEL, ...(backend ? { git: { directory, repositories, enabledCheckers } } : {}) });
  const call = async (command: string, input: any = {}, selector = 'probe', options?: any) => (await fetch(broker.url + '/v1/operation', {
    method: 'POST', headers: { 'x-strata-session': selector, 'content-type': 'application/json' }, body: JSON.stringify({ command, input, ...(options ? { options } : {}) })
  })).json() as Promise<any>;
  return { broker, call, directory, state };
}

test('fresh v0.3 empty Node adapter no longer advertises git.plan support; execution still refuses', async () => {
  const f = await brokerFixture(BLOCK_MODEL);
  try {
    const capability = await f.call('capabilities'), status = await f.call('status');
    assert.equal(capability.ok, true); assert.equal(status.ok, true);
    assert.equal(capability.data.native_support.adapter_present, true);
    assert.equal(capability.data.native_support.configured_repositories, 0);
    assert.equal(row(capability.data, 'git.plan').authorized, true);
    assert.equal(row(capability.data, 'git.plan').supported, false);
    assert.equal(row(capability.data, 'git.plan').unsupported_reason.code, 'UNSUPPORTED_MODEL_VERSION');
    assert.equal(status.data.capabilities['git-patch/1'], false); assert.equal(status.data.capabilities['source-binding/1'], false);
    assert.equal(row(capability.data, 'source.capture').unsupported_reason.code, 'REPOSITORY_FORBIDDEN');
    const plan = await f.call('git.plan'); assert.equal(plan.ok, false); assert.equal(plan.error.code, 'UNSUPPORTED_MODEL_VERSION');
    assert.deepEqual(capability.created, []); assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.broker.close(); }
});

test('missing backend and missing repository have distinct reasons without dispatching native work', async () => {
  for (const backend of [false, true]) {
    const f = await brokerFixture(MODEL, [], [], issuerFor(), backend);
    try {
      const result = await f.call('capabilities'); assert.equal(result.ok, true);
      const reason = backend ? 'REPOSITORY_FORBIDDEN' : 'UNSUPPORTED_SOURCE_BACKEND';
      for (const operation of ['source.capture', 'source.bind', 'git.plan', 'git.stage', 'git.check']) {
        assert.equal(row(result.data, operation).supported, false); assert.equal(row(result.data, operation).unsupported_reason.code, reason);
      }
      assert.equal(result.data.native_support.execution_ready, false); assert.deepEqual(result.created, []);
      const forged = await f.call('capabilities', { native_backend: { repositories: 1, enabled_checkers: [APPLICATION_CHECKER] } });
      assert.equal(forged.ok, false); assert.equal(forged.error.code, 'INVALID_RECORD');
      assert.equal((await f.call('status')).data.capabilities['git-patch/1'], false);
      if (backend) assert.deepEqual(await readdir(f.directory), []);
      await assert.rejects(readFile(path.join(f.state, 'registry.json')), { code: 'ENOENT' });
    } finally { await f.broker.close(); }
  }
});

test('configured v0.1 reports real checker availability without blocking imported evidence or implying apply readiness', async () => {
  const { root, app } = await host(), issuer = issuerFor();
  for (const checkers of [[], ['unimplemented-checker/1'], [APPLICATION_CHECKER]]) {
    const f = await brokerFixture(MODEL, [{ projectId: issuer.projectId, repoId: 'app', root: app }], checkers, issuer, true, path.join(root, 'case-' + checkers.length + '-' + (checkers[0] ?? 'none').replaceAll('/', '-')));
    try {
      const before = canonical(await gitPins({ projectId: issuer.projectId, repoId: 'app', root: app })), bytes = await readFile(path.join(app, 'counter.mjs'));
      const result = await f.call('capabilities'); assert.equal(result.ok, true);
      for (const operation of ['source.capture', 'source.bind', 'git.plan', 'git.stage', 'git.evidence', 'git.review', 'git.apply', 'git.finalize']) {
        assert.equal(row(result.data, operation).supported, true, operation); assert.equal(row(result.data, operation).execution_ready, false);
      }
      const enabled = checkers.includes(APPLICATION_CHECKER);
      assert.equal(row(result.data, 'git.check').supported, enabled);
      assert.equal(row(result.data, 'git.check').unsupported_reason?.code ?? null, enabled ? null : 'UNSUPPORTED_CHECKER');
      assert.deepEqual(result.data.native_support.enabled_checkers, enabled ? [APPLICATION_CHECKER] : []);
      assert.equal((await f.call('status')).data.capabilities.adoption_selected_git_bridge_v1, enabled);
      assert.deepEqual(await readdir(f.directory), []); assert.deepEqual(await readFile(path.join(app, 'counter.mjs')), bytes);
      assert.equal(canonical(await gitPins({ projectId: issuer.projectId, repoId: 'app', root: app })), before);
      const missing = await f.call('git.apply', { stage: 'missing@1', review: 'missing@1' });
      assert.equal(missing.ok, false); assert.equal(missing.error.code, 'REF_NOT_FOUND');
    } finally { await f.broker.close(); }
  }
});

test('source capture stays model-neutral on real synthetic Git; no v0.3 binding authority is introduced', async () => {
  const { root, app } = await host(), issuer = issuerFor();
  const f = await brokerFixture(BLOCK_MODEL, [{ projectId: issuer.projectId, repoId: 'app', root: app }], [], issuer, true, root);
  try {
    const capability = await f.call('capabilities'); assert.equal(row(capability.data, 'source.capture').supported, true);
    assert.equal(row(capability.data, 'source.bind').supported, false);
    const capture = await f.call('source.capture', { repo_id: 'app', scope }); assert.equal(capture.ok, true, JSON.stringify(capture));
    assert.equal(capture.data.trust, 'local-measurement'); assert.equal(capture.created.length, 1);
    const retry = await f.call('source.capture', { repo_id: 'app', scope }); assert.equal(retry.data.ref, capture.data.ref);
  } finally { await f.broker.close(); }
});

test('configuration support never substitutes for an absent repository/path grant', async () => {
  const { root, app } = await host();
  for (const assignedRepository of [false, true]) {
    const issuer = new FixtureIssuer({ assignments: { probe: { principal: 'probe', operations, ...(assignedRepository ? { repositories: ['app'], git_paths: [] } : {}) } } });
    const f = await brokerFixture(MODEL, [{ projectId: issuer.projectId, repoId: 'app', root: app }], [APPLICATION_CHECKER], issuer, true, root);
    try {
      const result = await f.call('capabilities'); assert.equal(row(result.data, 'source.capture').supported, true);
      assert.equal(result.data.native_support.execution_ready, false);
      const capture = await f.call('source.capture', { repo_id: 'app', scope }); assert.equal(capture.ok, false); assert.equal(capture.error.code, assignedRepository ? 'PATCH_SCOPE' : 'REPOSITORY_FORBIDDEN');
      assert.deepEqual(await readdir(f.directory), []); await assert.rejects(readFile(path.join(f.state, 'registry.json')), { code: 'ENOENT' });
    } finally { await f.broker.close(); }
  }
});

test('a host-supplied unknown native operation is never advertised as implemented', () => {
  const issuer = new FixtureIssuer({ assignments: { probe: { principal: 'probe', operations: ['capabilities', 'git.unknown'] } } });
  const context = issuer.resolve('probe'), engine = new Engine();
  const result: any = executeAuthorized(engine, 'capabilities', {}, context, issuer);
  assert.equal(row(result, 'git.unknown').supported, false);
  assert.equal(row(result, 'git.unknown').unsupported_reason.code, 'UNSUPPORTED_CAPABILITY');
  assert.throws(() => executeAuthorized(engine, 'git.unknown', {}, context, issuer), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('shared SDK projection refuses native backend claims and keeps imported drift separate from local measurement', () => {
  const issuer = issuerFor(), context = issuer.resolve('probe'), engine = new Engine({}, {}, { modelVersion: MODEL });
  const before = canonical(engine.records), result: any = executeAuthorized(engine, 'capabilities', {}, context, issuer);
  assert.equal(row(result, 'git.plan').supported, false); assert.equal(row(result, 'git.plan').unsupported_reason.code, 'UNSUPPORTED_SOURCE_BACKEND');
  assert.equal(row(result, 'drift.check').supported, true); assert.equal(row(result, 'drift.check').local_source.supported, false);
  assert.equal(row(result, 'drift.propose').supported, true); assert.equal(row(result, 'drift.review').local_source.supported, false);
  assert.equal(canonical(engine.records), before);
  for (const model of [CONTENT_MODEL, BLOCK_MODEL]) {
    const report = describeNativeSupport(model, context, { repositories: 1, enabled_checkers: [APPLICATION_CHECKER] });
    for (const operation of GIT_OPERATIONS) assert.equal(row(report, operation).supported, operation.startsWith('git.transaction.'));
    assert.equal(nativeCapabilityFlags(report)['git-patch/1'], false);
  }
});

test('authenticated v0.3 diagnostics preserve policy and repository/evidence refusals, including expired sessions', async () => {
  let now = Date.now(); const key = Buffer.alloc(32, 3).toString('base64url');
  const accounts = { format: 'strata-host-accounts/1', generation: 1, accounts: [{ account_id: 'probe', principal_id: 'probe', principal_kind: 'person', active: true, credential_epoch: 1, key_sha256: createHash('sha256').update(key).digest('hex') }] };
  const policy = { format: 'strata-host-policy/1', project_id: 'strata-local-demo', generation: 1, grants: [{ grant_id: 'read', principal_id: 'probe', operations: ['status', 'capabilities'], layer_ids: null, write_block_ids: [], create_under_block_ids: [], approvals: [], profiles: [], expires_at: new Date(now + 3600000).toISOString() }] };
  const issuer = new HostIssuer(accounts, policy, () => now), token = issuer.login('probe', key), context = issuer.resolve(token);
  const f = await brokerFixture(BLOCK_MODEL, [], [], issuer);
  try {
    const result = await f.call('capabilities', {}, token); assert.equal(result.ok, true);
    assert.equal(result.data.operations.some((r: any) => r.operation === 'git.plan'), false);
    assert.equal(row(result.data.native_support, 'source.capture').supported, false);
    assert.equal(row(result.data.native_support, 'source.capture').unsupported_reason.code, 'UNSUPPORTED_SOURCE_BACKEND');
    assert.equal(row(result.data.native_support, 'git.plan').authorized, false);
    assert.equal((await f.call('git.plan', {}, token)).error.code, 'OPERATION_FORBIDDEN');
    assert.equal(HOST_OPERATIONS.some(o => /^(git|source|drift|adoption)\./.test(o)), false);
    assert.throws(() => issuer.assertRepository(), { code: 'UNSUPPORTED_SOURCE_BACKEND' }); assert.throws(() => issuer.assertGitEvidence(), { code: 'UNSUPPORTED_SOURCE_BACKEND' });
    issuer.reload(accounts, { ...policy, generation: 2 });
    assert.throws(() => executeAuthorized(new Engine({}, {}, { modelVersion: BLOCK_MODEL }), 'capabilities', {}, context, issuer), { code: 'STALE_POLICY' });
    now += 31 * 60 * 1000; assert.equal((await f.call('capabilities', {}, token)).error.code, 'AUTHENTICATION_REQUIRED');
  } finally { await f.broker.close(); }
});

test('capabilities are fresh reads; revoked, expired, stale-policy and stale-target contexts cannot claim readiness', async () => {
  let now = Date.now(); const issuer = issuerFor(() => now, new Date(now + 1000).toISOString()), context = issuer.resolve('probe');
  const engine = new Engine(), before = canonical(engine.records);
  const result: any = executeAuthorized(engine, 'capabilities', {}, context, issuer); assert.equal(result.native_support.execution_ready, false);
  assert.throws(() => executeAuthorized(engine, 'capabilities', { target: 'missing@1' }, context, issuer), { code: 'REF_NOT_FOUND' });
  now += 1001; assert.throws(() => executeAuthorized(engine, 'capabilities', {}, context, issuer), { code: 'ACCESS_REVOKED' });
  assert.equal(canonical(engine.records), before);
  const live = issuerFor(), stale = live.resolve('probe'); live.suspendForTest('unrelated');
  assert.throws(() => executeAuthorized(engine, 'capabilities', {}, stale, live), { code: 'STALE_POLICY' });
  const f = await brokerFixture(MODEL, [], [], live);
  try {
    assert.equal((await f.call('capabilities')).ok, true); live.suspendForTest('probe');
    assert.equal((await f.call('capabilities')).error.code, 'ACCESS_REVOKED');
  } finally { await f.broker.close(); }
});
