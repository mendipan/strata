import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { canonical, digest, fail } from '../src/model.js';
import { normalizeBuildProfile } from '../src/build-contracts.js';
import { profileFor } from '../src/profiles.js';
import { PROFILE_READS } from '../src/build-records.js';
import { namespaceProfileService, NamespaceProfilesStudioAdapter } from '../src/explorer/namespace-profiles.js';
import { StudioCommands } from '../src/explorer/commands.js';
import { startLocalBroker } from '../src/local-broker.js';
import { assertRepositoryReceipt } from '../src/repository-receipts.js';
import { localBuildFixture } from './build-local-fixture.js';
import { workspaceRuntimeFixture } from './workspace-runtime-fixture.js';
import type { ProfileServiceScope } from '../src/profile-service.js';

const errorCode = (code: string) => (error: any) => error.code === code;
const contractInput = (revision = 1, previous: string | null = null) => ({
  record: { format: 'strata-repository-compatibility/1', id: 'NamespaceContract', revision, rules: [], preferences: [] }, previous,
});
function profileInput(contract: any, revision = 1, name = 'Saved namespace profile', id = 'NamespaceProfile') {
  const record = { id, revision, name, contract_ref: contract.ref, contract_sha256: contract.sha256,
    choices: { language: 'javascript', framework: 'none', runtime: 'node' },
    materializer: { id: 'collection-host/1', archive_sha256: digest(profileFor('collection-host/1').archive()) } };
  return { record, expected_normalized_sha256: digest(normalizeBuildProfile(record)) };
}
async function fixture(runtimeOperations: string[] = []) {
  const source = await localBuildFixture('namespace-profiles');
  const scope: ProfileServiceScope = { project_id: source.issuer.projectId, repository_id: 'immutable-test-id',
    authority_ref: 'HostCollectionBaseline@1', source_trust: 'host-authenticated' };
  const f = await workspaceRuntimeFixture({ seed: source.engine, principal: 'release-manager', profileScope: scope, runtimeOperations });
  let active = await f.start();
  const context = () => f.issuer.resolve(f.token);
  const call = async (command: string, input: unknown, opts: any = {}) => {
    await f.issuer.refreshSession(f.token);
    const response = await fetch(active.broker.url + '/v1/operation', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-strata-session': f.token, 'x-strata-project': scope.project_id,
      'x-strata-artifact-adapter': 'cloudflare-artifacts-remote',
      ...(opts.expected_generation ? { 'x-strata-expected-generation': opts.expected_generation } : {}),
      ...(opts.expected_policy ? { 'x-strata-expected-policy': opts.expected_policy } : {}),
    }, body: JSON.stringify({ command, input, options: { idempotency_key: opts.idempotency_key, dry_run: opts.dry_run } }) });
    const result: any = await response.json();
    if (!result.ok) { const error = new Error(result.error.message); Object.assign(error, result.error); throw error; }
    return result;
  };
  // Separately authenticated in-process reviewer. This callback is never an
  // operation-envelope field or route; it uses the same writer and receipts.
  const review = (command: 'repository.contract.import' | 'repository.contract.attach', input: unknown) =>
    active.broker.repositoryTransaction(context(), command, input, { key: randomUUID() }, async engine => ({
      data: namespaceProfileService(engine, scope, context(), f.issuer).review(command, input), write: true,
    }));
  const saveContract = async (revision = 1, previous: string | null = null) => {
    const input = contractInput(revision, previous); await review('repository.contract.import', input);
    return (await call('repository.contract.import', input, { idempotency_key: randomUUID() })).data;
  };
  return { ...f, scope, source, context, call, review, saveContract, get active() { return active; },
    restart: async (extra: any = {}) => { await active.broker.close(); active = await f.start(extra); }, close: () => active.broker.close() };
}

test('namespace profile saves use production transactions, exact remote locators, immutable CAS and cold replay', async t => {
  const f = await fixture(); t.after(f.close);
  const contract = await f.saveContract(), input = profileInput(contract), key = randomUUID();
  const saved = await f.call('profile.create', input, { idempotency_key: key });
  assert.equal(saved.data.record.author, 'release-manager');
  assert.equal(saved.data.record.repository_id, f.scope.repository_id);
  const first = saved.data.ref, oldBytes = canonical(saved.data.record), counts = f.counts(), budget = await f.budget.snapshot();
  const replay = await f.call('profile.create', input, { idempotency_key: key, expected_generation: 'f'.repeat(64) });
  assert.equal(replay.reused, true); assert.equal(replay.data.ref, first);
  assert.deepEqual(f.counts(), counts); assert.deepEqual(await f.budget.snapshot(), budget);
  await assert.rejects(f.call('profile.create', profileInput(contract, 1, 'Different'), { idempotency_key: key }), errorCode('IDEMPOTENCY_CONFLICT'));
  const update = { previous: first, ...profileInput(contract, 2, 'Renamed') };
  const raced = await Promise.allSettled([f.call('profile.revise', update, { idempotency_key: randomUUID() }), f.call('profile.revise', update, { idempotency_key: randomUUID() })]);
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((raced.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'STALE_REVISION');
  assert.equal(canonical((await f.call('profile.inspect', { ref: first })).data.record), oldBytes);
  const registry = JSON.parse(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'));
  assert.equal(registry.storage.mode, 'remote');
  assert.equal(registry.entries[first].locator.hash, digest(saved.data.record));
  assert.ok(Object.keys(registry.workspace_commits).length >= 4);
  await f.restart();
  const before = f.counts().pushes;
  assert.equal((await f.call('operation.inspect', { key })).data.state, 'committed');
  assert.equal((await f.call('profile.create', input, { idempotency_key: key })).reused, true);
  assert.equal(f.counts().pushes, before);
  assert.equal((await f.call('profile.list', {})).data.profiles[0].record.revision, 2);
  // Startup requires the retained exact namespace cache. Removing indexed bytes
  // must refuse rather than create a second profile store or fetch without an
  // admitted provider operation. The canonical index remains intact.
  await f.active.broker.close();
  const indexBytes = await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8');
  await unlink(path.join(f.directories.broker, 'verified-artifacts', registry.entries[first].hash + '.json'));
  await assert.rejects(f.restart(), errorCode('STORE_UNAVAILABLE'));
  assert.equal(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), indexBytes);
});

test('namespace contract/adoption requires retained review and publication; exact binding survives restart', async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.call('repository.contract.import', contractInput(), { idempotency_key: randomUUID() }), errorCode('BUILD_REVIEW_REQUIRED'));
  const contract = await f.saveContract();
  const release_ref = f.source.release.ref, releaseBytes = canonical(f.source.engine.read(release_ref));
  const input = { release_ref, contract_ref: contract.ref, expected_release_sha256: digest(f.source.engine.read(release_ref)) };
  assert.equal((await f.call('repository.compatibility', { release_ref })).data.contract_binding, 'missing');
  await assert.rejects(f.call('repository.contract.attach', input, { idempotency_key: randomUUID() }), errorCode('BUILD_REVIEW_REQUIRED'));
  await f.review('repository.contract.attach', input);
  const key = randomUUID(), attached = await f.call('repository.contract.attach', input, { idempotency_key: key });
  assert.equal(attached.data.record.provenance, 'post_publication_adoption');
  await assert.rejects(f.call('repository.contract.attach', input, { idempotency_key: randomUUID() }), errorCode('BUILD_BINDING_CONFLICT'));
  await assert.rejects(f.call('repository.contract.attach', { ...input, expected_release_sha256: 'f'.repeat(64) }, { idempotency_key: randomUUID() }), errorCode('BUILD_PIN_MISMATCH'));
  await assert.rejects(f.call('repository.contract.attach', { ...input, release_ref: 'HostCollectionBaseline@1' }, { idempotency_key: randomUUID() }), errorCode('BUILD_BOOTSTRAP_EXCLUDED'));
  await f.restart();
  assert.equal((await f.call('repository.contract.attach', input, { idempotency_key: key })).data.ref, attached.data.ref);
  assert.equal((await f.call('repository.compatibility', { release_ref })).data.context.contract.ref, contract.ref);
  assert.equal(canonical((await f.call('inspect', { type: 'release', ref: release_ref })).data), releaseBytes);
  const second = await f.saveContract(2, contract.ref);
  assert.equal((await f.call('repository.compatibility', {})).data.context.contract.ref, second.ref);
  assert.equal((await f.call('repository.compatibility', { release_ref })).data.context.contract.ref, contract.ref);
});

test('namespace Studio port saves/reloads profiles, reports separate Build support and refuses invalid/stale/foreign inputs', async t => {
  const f = await fixture(); t.after(f.close);
  const contract = await f.saveContract();
  const port = new NamespaceProfilesStudioAdapter(f.scope.repository_id, f.call);
  let blocked = false;
  const commands = new StudioCommands({ project_id: f.scope.project_id, model_version: f.grant.model_version }, f.token, f.directories.broker,
    [...PROFILE_READS, 'profile.create', 'profile.revise', 'profile.archive'], {}, 'host-authenticated', () => f.issuer.accessBinding(),
    opts => async (command, input) => {
      const result = await f.call(command, input, opts);
      if (blocked && command === 'capabilities') {
        result.data.write_blocked = true;
        result.data.operations = result.data.operations.map((row: any) => row.operation === 'profile.create' ? { ...row, supported: false, reason: 'Synthetic retained writer recovery required.' } : row);
      }
      return result;
    }, undefined, port);
  t.after(() => commands.close());
  const caps = await commands.read('capabilities');
  assert.equal(caps.operations.find((r: any) => r.operation === 'profile.create').supported, true);
  assert.equal(caps.operations.find((r: any) => r.operation === 'profile.create').allowed, true);
  assert.equal(caps.operations.find((r: any) => r.operation === 'build.start').supported, false);
  const input = profileInput(contract);
  const request = { command: 'profile.create', input, idempotency_key: randomUUID(), expected_generation: caps.generation, expected_policy: caps.policy_generation };
  const saved = await commands.operation(request); assert.equal(saved.refresh_error, null);
  const replay = await commands.operation(request); assert.equal(replay.reused, true); assert.deepEqual(replay.created, []);
  assert.equal((await commands.read('profile.list')).profiles[0].ref, saved.data.ref);
  blocked = true;
  const refusedCaps = await commands.read('capabilities');
  assert.equal(refusedCaps.operations.find((r: any) => r.operation === 'profile.create').supported, false);
  assert.match(refusedCaps.operations.find((r: any) => r.operation === 'profile.create').reason, /writer recovery/);
  blocked = false;
  await assert.rejects(commands.read('build.context', {}), errorCode('UNSUPPORTED_CAPABILITY'));
  await assert.rejects(port.download('fake', 'fake'), errorCode('UNSUPPORTED_CAPABILITY'));
  await assert.rejects(f.call('profile.create', profileInput(contract, 1, 'Next', 'Next'), { idempotency_key: randomUUID(), expected_generation: caps.generation }), errorCode('STALE_GENERATION'));
  await assert.rejects(f.call('profile.create', profileInput(contract, 1, 'Next', 'Next'), { idempotency_key: randomUUID(), expected_policy: 'old-policy' }), errorCode('STALE_POLICY'));
  const bad = profileInput(contract, 1, 'Unsafe', 'Unsafe');
  await assert.rejects(f.call('profile.create', { ...bad, record: { ...bad.record, token: 'synthetic-secret-refused' } }, { idempotency_key: randomUUID() }), errorCode('INVALID_RECORD'));
  await assert.rejects(f.call('profile.create', profileInput({ ...contract, sha256: 'f'.repeat(64) }, 1, 'Stale', 'Stale'), { idempotency_key: randomUUID() }), errorCode('BUILD_PROFILE_INVALID'));
  const ctx = f.context();
  await assert.rejects(f.active.broker.repositoryTransaction(ctx, 'profile.inspect', { ref: saved.data.ref }, { dry_run: true }, async engine => ({
    data: namespaceProfileService(engine, { ...f.scope, repository_id: 'foreign' }, ctx, f.issuer).execute('profile.inspect', { ref: saved.data.ref }),
  })), errorCode('REPOSITORY_FORBIDDEN'));
  const policy = structuredClone(f.policy); policy.generation++;
  assert.ok('build_repository_ids' in policy.grants[0]);
  policy.grants[0].build_repository_ids = [];
  f.issuer.reload(f.accounts, policy);
  await assert.rejects(f.call('profile.create', input, { idempotency_key: request.idempotency_key }), errorCode('REPOSITORY_FORBIDDEN'));
  await assert.rejects(f.call('operation.inspect', { key: request.idempotency_key }), errorCode('REPOSITORY_FORBIDDEN'));
  const deniedCaps = await commands.read('capabilities');
  assert.equal(deniedCaps.operations.find((row: any) => row.operation === 'profile.create').allowed, false);
});

test('unconfigured namespace policy retains refusal and profile dry-run stages no records or receipts', async t => {
  const plain = await workspaceRuntimeFixture(), unconfigured = await plain.start(); t.after(() => unconfigured.broker.close());
  assert.equal((await unconfigured.call('profile.list')).error.code, 'OPERATION_FORBIDDEN');
  const f = await fixture(); t.after(f.close); const contract = await f.saveContract();
  const index = await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), budget = await f.budget.snapshot(), control = await f.control.snapshot();
  const key = randomUUID(), result = await f.call('profile.create', profileInput(contract), { idempotency_key: key, dry_run: true });
  assert.equal(result.dry_run, true); assert.deepEqual(result.created, []);
  assert.equal(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), index);
  assert.deepEqual(await f.budget.snapshot(), budget); assert.deepEqual(await f.control.snapshot(), control);
  assert.equal((await f.call('operation.inspect', { key })).data.state, 'not_found');
});

test('namespace supporting scope rejects foreign valid records before staging; owner revocation cannot replay a save', async t => {
  const f = await fixture(); t.after(f.close);
  const contract = await f.saveContract(), saved = profileInput(contract), key = randomUUID();
  await f.call('profile.create', saved, { idempotency_key: key });
  const policy = structuredClone(f.policy); policy.generation++;
  assert.ok('build_repository_ids' in policy.grants[0]); policy.grants[0].build_repository_ids = [f.scope.repository_id, 'foreign'];
  f.issuer.reload(f.accounts, policy);
  const ctx = f.context(), before = await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), counts = f.counts();
  await assert.rejects(f.active.broker.repositoryTransaction(ctx, 'repository.contract.import', contractInput(), { key: randomUUID() }, async engine => {
    const service = namespaceProfileService(engine, { ...f.scope, repository_id: 'foreign' }, ctx, f.issuer);
    service.review('repository.contract.import', contractInput());
    return { data: service.execute('repository.contract.import', contractInput()), write: true };
  }), errorCode('BUILD_REPOSITORY_MISMATCH'));
  assert.equal(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), before);
  assert.deepEqual(f.counts(), counts);
  f.revokeParent();
  await assert.rejects(f.call('profile.create', saved, { idempotency_key: key }));
  assert.deepEqual(f.counts(), counts);
});

test('profile receipt survives uncertain commit and restart; original outcome is retained without another push', async t => {
  const f = await fixture(); t.after(f.close); const contract = await f.saveContract();
  await f.restart({ directorySyncForTest: () => { throw Error('synthetic directory durability uncertainty'); } });
  const input = profileInput(contract), key = randomUUID();
  await assert.rejects(f.call('profile.create', input, { idempotency_key: key }), errorCode('WORKSPACE_DURABILITY_UNCERTAIN'));
  const count = f.counts().pushes, outcome = (await f.call('operation.inspect', { key })).data;
  assert.equal(outcome.state, 'committed'); assert.equal(outcome.result.data.record.name, input.record.name);
  assert.equal((await f.call('profile.create', input, { idempotency_key: key })).reused, true);
  await assert.rejects(f.call('profile.create', profileInput(contract, 1, 'New', 'New'), { idempotency_key: randomUUID() }), errorCode('WRITE_RECONCILIATION_REQUIRED'));
  await f.restart();
  assert.equal((await f.call('profile.create', input, { idempotency_key: key })).reused, true);
  assert.equal(f.counts().pushes, count);
});

test('unmounted profile backend refuses old profile replay and protected original outcomes before provider access', async t => {
  const f = await fixture(); t.after(f.close); const contract = await f.saveContract();
  const input = profileInput(contract), key = randomUUID();
  await f.call('profile.create', input, { idempotency_key: key });
  const runtime = f.active.runtime; await f.active.broker.close();
  const unmounted = await startLocalBroker(f.directories.broker, 0, { issuer: f.issuer, model_version: f.grant.model_version,
    artifacts: runtime.store, workspace: runtime.brokerControls(), max_pending: 4 });
  t.after(() => unmounted.close());
  const counts = f.counts(), budget = await f.budget.snapshot();
  const raw = async (command: string, value: unknown) => {
    const response = await fetch(unmounted.url + '/v1/operation', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-strata-session': f.token, 'x-strata-project': f.scope.project_id,
      'x-strata-artifact-adapter': 'cloudflare-artifacts-remote',
    }, body: JSON.stringify({ command, input: value, options: { idempotency_key: key } }) });
    return response.json() as Promise<any>;
  };
  assert.equal((await raw('profile.create', input)).error.code, 'UNSUPPORTED_CAPABILITY');
  assert.equal((await raw('profile.list', {})).error.code, 'UNSUPPORTED_CAPABILITY');
  assert.equal((await raw('operation.inspect', { key })).error.code, 'UNSUPPORTED_CAPABILITY');
  assert.deepEqual(f.counts(), counts); assert.deepEqual(await f.budget.snapshot(), budget);
});

test('review P1: nested profile envelopes and Build acceptance-shaped private outcomes respect revocation and unmount', async t => {
  const f = await fixture(['build.start', 'build.inspect']); t.after(f.close);
  const contract = await f.saveContract(), wrappedInput = profileInput(contract, 1, 'Protected wrapped profile', 'Wrapped');
  const ctx = f.context(), saved = await f.active.broker.repositoryTransaction(ctx, 'profile.create', wrappedInput, { key: 'wrapped-save' }, async engine => ({
    data: { ok: true, data: namespaceProfileService(engine, f.scope, ctx, f.issuer).execute('profile.create', wrappedInput) }, write: true,
  }));
  assert.equal((await f.call('operation.inspect', { key: 'wrapped-save' })).data.result.data.data.ref, saved.data.ref);
  // The callback's arbitrary result may also use the coordinator's acceptance
  // wrapper. The protected payload here is a real saved profile, not a fake run.
  const acceptedInput = profileInput(contract, 1, 'Acceptance-shaped payload', 'AcceptedPayload');
  await f.active.broker.repositoryTransaction(ctx, 'build.start', { step: 'acceptance-shape' }, { key: 'acceptance-shape' }, async engine => ({
    data: { created: true, run: { saved_profile: namespaceProfileService(engine, f.scope, ctx, f.issuer).execute('profile.create', acceptedInput) } }, write: true,
  }));
  const before = await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), counts = f.counts();
  const policy = structuredClone(f.policy); policy.generation++;
  assert.ok('build_repository_ids' in policy.grants[0]); policy.grants[0].build_repository_ids = [];
  f.issuer.reload(f.accounts, policy);
  for (const key of ['wrapped-save', 'acceptance-shape']) await assert.rejects(f.call('operation.inspect', { key }), errorCode('REPOSITORY_FORBIDDEN'));
  const indexed = JSON.parse(before), legacy = structuredClone(indexed.requests[`${ctx.tenant_id}:${ctx.project_id}:${ctx.principal_id}:wrapped-save`]);
  delete legacy.repository_step;
  // The direct adapter's shared guard also covers legacy nested envelopes via
  // broker-authored created refs, without changing their historical JSON.
  await assert.rejects(f.active.broker.repositoryTransaction(f.context(), 'operation.inspect', { key: 'wrapped-save' }, { dry_run: true }, async engine => {
    assertRepositoryReceipt(legacy, f.context(), engine, f.issuer, f.scope); return { data: null };
  }), errorCode('REPOSITORY_FORBIDDEN'));
  const readRevoked = structuredClone(f.policy); readRevoked.generation = policy.generation + 1;
  readRevoked.grants[0].operations = readRevoked.grants[0].operations.filter(op => op !== 'profile.inspect');
  f.issuer.reload(f.accounts, readRevoked);
  await assert.rejects(f.call('operation.inspect', { key: 'wrapped-save' }), errorCode('OPERATION_FORBIDDEN'));
  await f.active.broker.close();
  const runtime = f.active.runtime, unmounted = await startLocalBroker(f.directories.broker, 0, {
    issuer: f.issuer, model_version: f.grant.model_version, artifacts: runtime.store, workspace: runtime.brokerControls(), max_pending: 4,
  });
  t.after(() => unmounted.close());
  for (const key of ['wrapped-save', 'acceptance-shape']) {
    const response = await fetch(unmounted.url + '/v1/operation', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-strata-session': f.token, 'x-strata-project': f.scope.project_id,
      'x-strata-artifact-adapter': 'cloudflare-artifacts-remote',
    }, body: JSON.stringify({ command: 'operation.inspect', input: { key } }) });
    assert.equal((await response.json() as any).error.code, 'UNSUPPORTED_CAPABILITY');
  }
  assert.equal(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), before);
  assert.deepEqual(f.counts(), counts);
});

test('review P2: stable private review-step replay returns exact original data without invoking work, including restart', async t => {
  const f = await fixture(); t.after(f.close); let calls = 0;
  const input = contractInput(), key = 'stable-review-step';
  const review = (value = input) => {
    const ctx = f.context();
    return f.active.broker.repositoryTransaction(ctx, 'repository.contract.import', value, { key }, async engine => {
      calls++; return { data: namespaceProfileService(engine, f.scope, ctx, f.issuer).review('repository.contract.import', value), write: true };
    });
  };
  const first = await review(), before = await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), counts = f.counts(), budget = await f.budget.snapshot();
  assert.deepEqual(await review(), first); assert.equal(calls, 1);
  assert.equal(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), before);
  assert.deepEqual(f.counts(), counts); assert.deepEqual(await f.budget.snapshot(), budget);
  await f.restart(); assert.deepEqual(await review(), first); assert.equal(calls, 1);
  await assert.rejects(review(contractInput(2)), errorCode('IDEMPOTENCY_CONFLICT')); assert.equal(calls, 1);
  const policy = structuredClone(f.policy); policy.generation++; policy.grants[0].approvals = [];
  f.issuer.reload(f.accounts, policy);
  await assert.rejects(review(), errorCode('AUTHORITY_FORBIDDEN')); assert.equal(calls, 1);
  assert.deepEqual(f.counts(), counts);
});

test('private callback snapshots survive same-key custom originals and later updates; replay authorization runs without work', async t => {
  const f = await fixture(['build.start', 'build.inspect']); t.after(f.close); const contract = await f.saveContract();
  const ctx = f.context(), input = profileInput(contract, 1, 'Custom receipt', 'CustomReceipt'), key = 'private-original';
  const receiptKey = `${ctx.tenant_id}:${ctx.project_id}:${ctx.principal_id}:${key}`;
  let calls = 0, guards = 0, allowed = true;
  const execute = () => f.active.broker.repositoryTransaction(f.context(), 'profile.create', input, { key,
    replay_authorize: () => { guards++; if (!allowed) fail('OPERATION_FORBIDDEN', 4, 'Consumer authority revoked'); },
  }, async engine => {
    calls++; const result = namespaceProfileService(engine, f.scope, f.context(), f.issuer).execute('profile.create', input);
    return { data: { created: true, run: { profile: result.ref } }, write: true,
      receipt: { key: receiptKey, digest: digest({ command: 'profile.create', input, principal: ctx.principal_id }), result: { ok: true, data: result, created: [result.ref] } } };
  });
  const first = await execute(), index = JSON.parse(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'));
  assert.equal(index.requests[receiptKey].result.data.ref, first.run.profile);
  assert.deepEqual(index.requests[receiptKey].repository_step.callback_result, first);
  await f.active.broker.repositoryTransaction(f.context(), 'build.start', { phase: 'later-receipt-update' }, { key: 'later-step' }, async () => ({
    data: undefined, write: true, receipt: { key: receiptKey, digest: index.requests[receiptKey].digest,
      result: { ...index.requests[receiptKey].result, data: { ...index.requests[receiptKey].result.data, observation: 'later' } } },
  }));
  const updated = JSON.parse(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'));
  assert.equal(updated.requests[receiptKey].result.data.observation, 'later');
  assert.deepEqual(updated.requests[receiptKey].repository_step, index.requests[receiptKey].repository_step);
  assert.deepEqual(await execute(), first); assert.equal(calls, 1); assert.equal(guards, 1);
  f.scope.visible = ref => ref !== contract.ref;
  await assert.rejects(execute(), errorCode('BUILD_SOURCE_UNAVAILABLE')); assert.equal(calls, 1);
  delete f.scope.visible;
  allowed = false; await assert.rejects(execute(), errorCode('OPERATION_FORBIDDEN')); assert.equal(calls, 1);
});

test('legacy predecessor index applies current root and supporting-closure visibility without changing receipts', async t => {
  const f = await fixture(); t.after(f.close);
  // Use the exact predecessor production broker, not a receipt with removed or
  // fabricated metadata. Other adapter/service implementations are unchanged.
  // This is an offline source-history fixture; Git never fetches a missing ref.
  const predecessor = execFileSync('git', ['show', 'ae49a3e4409b66e4a11d945acfb39a45693be2d3:src/local-broker.ts'], { encoding: 'utf8', windowsHide: true });
  const moduleFile = fileURLToPath(new URL('../src/predecessor-broker-' + randomUUID() + '.mjs', import.meta.url));
  await writeFile(moduleFile, transformSync(predecessor, { loader: 'ts', format: 'esm', target: 'es2022' }).code, { flag: 'wx' });
  t.after(() => unlink(moduleFile));
  const predecessorStart: typeof startLocalBroker = (await import(pathToFileURL(moduleFile).href)).startLocalBroker;
  const runtime = f.active.runtime;
  await f.active.broker.close();
  let broker = await predecessorStart(f.directories.broker, 0, { issuer: f.issuer, model_version: f.grant.model_version,
    artifacts: runtime.store, workspace: runtime.brokerControls(), repository: { scope: f.scope }, max_pending: 4 });
  t.after(() => broker.close());
  const raw = async (command: string, input: unknown, key?: string) => {
    const response = await fetch(broker.url + '/v1/operation', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-strata-session': f.token, 'x-strata-project': f.scope.project_id,
      'x-strata-artifact-adapter': 'cloudflare-artifacts-remote',
    }, body: JSON.stringify({ command, input, options: { idempotency_key: key } }) });
    return response.json() as Promise<any>;
  };
  const ctx = f.context(), input = contractInput();
  await broker.repositoryTransaction(ctx, 'repository.contract.import', input, { key: 'legacy-review' }, async engine => ({
    data: namespaceProfileService(engine, f.scope, ctx, f.issuer).review('repository.contract.import', input), write: true,
  }));
  const imported = await raw('repository.contract.import', input, 'legacy-import'); assert.equal(imported.ok, true);
  const profile = profileInput(imported.data, 1, 'Legacy protected saved profile', 'LegacyProfile');
  const saved = await broker.repositoryTransaction(ctx, 'profile.create', profile, { key: 'legacy-wrapped-save' }, async engine => ({
    data: { ok: true, data: namespaceProfileService(engine, f.scope, ctx, f.issuer).execute('profile.create', profile) }, write: true,
  }));
  const before = await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), index = JSON.parse(before);
  const receipt = index.requests[`${ctx.tenant_id}:${ctx.project_id}:${ctx.principal_id}:legacy-wrapped-save`];
  assert.equal(receipt.repository_step, undefined); assert.ok(receipt.result.created.includes(saved.data.ref));
  const counts = f.counts(), budget = await f.budget.snapshot();
  await broker.close();
  // Reopen the untouched predecessor-written index under the current broker.
  broker = await startLocalBroker(f.directories.broker, 0, { issuer: f.issuer, model_version: f.grant.model_version,
    artifacts: runtime.store, workspace: runtime.brokerControls(), repository: { scope: f.scope }, max_pending: 4 });
  for (const visible of [undefined, (ref: string) => ref !== 'UnrelatedRecord@1']) {
    f.scope.visible = visible;
    assert.equal((await raw('profile.inspect', { ref: saved.data.ref })).ok, true);
    assert.deepEqual((await raw('operation.inspect', { key: 'legacy-wrapped-save' })).data.result, receipt.result);
  }
  for (const hidden of [saved.data.ref, imported.data.ref, f.scope.authority_ref]) {
    f.scope.visible = ref => ref !== hidden;
    assert.equal((await raw('profile.inspect', { ref: saved.data.ref })).error.code, 'BUILD_SOURCE_UNAVAILABLE');
    assert.equal((await raw('operation.inspect', { key: 'legacy-wrapped-save' })).error.code, 'BUILD_SOURCE_UNAVAILABLE');
    await assert.rejects(broker.repositoryTransaction(f.context(), 'operation.inspect', { key: 'legacy-wrapped-save' }, { dry_run: true }, async engine => {
      assertRepositoryReceipt(receipt, f.context(), engine, f.issuer, f.scope); return { data: receipt.result };
    }), errorCode('BUILD_SOURCE_UNAVAILABLE'));
  }
  delete f.scope.visible;
  assert.deepEqual((await raw('operation.inspect', { key: 'legacy-wrapped-save' })).data.result, receipt.result);
  assert.equal(await readFile(path.join(f.directories.broker, 'registry.json'), 'utf8'), before);
  assert.deepEqual(f.counts(), counts); assert.deepEqual(await f.budget.snapshot(), budget);
});
