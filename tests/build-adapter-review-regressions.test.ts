import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { BLOCK_MODEL, digest } from '../src/model.js';
import { buildAdapterFixture } from './build-adapter-fixture.js';
import { LocalBuildStudioAdapter, PROFILES_BUILD_COMMANDS } from '../src/build-studio.js';
import { StudioCommands } from '../src/explorer/commands.js';
import { presentOperationEffects } from '../src/commands/replay-effects.js';

test('HTTPS Profiles CLI preserves each explicit CAS pin and only defaults omitted pins', async t => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'strata-s3-reviewed-cli-'));
  const config = { schema_version: '1', model_version: BLOCK_MODEL, project_id: 'review-fixture',
    broker: 'https://s3-reviewed.invalid/', artifact_adapter: 'hosted-local-state', profiles: ['collection-host/1'],
    identity_policy: 'host-accounts/1', network_policy: 'configured-https' };
  await writeFile(path.join(project, 'strata.config.json'), JSON.stringify(config));
  const originalFetch = globalThis.fetch, current = { generation: 'b'.repeat(64), policy_generation: 'current-policy', model_version: BLOCK_MODEL };
  let dispatched: any;
  // Fully synthetic HTTPS transport: no endpoint or live credential is used.
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); assert.equal(url.origin, config.broker.slice(0, -1));
    if (url.pathname === '/studio/cli/login') return Response.json({ project_id: config.project_id, token: 'x'.repeat(43) });
    if (url.pathname === '/studio/v1/capabilities') return Response.json({ data: current });
    if (url.pathname === '/studio/logout') return Response.json({});
    assert.equal(url.pathname, '/studio/v1/operation'); dispatched = JSON.parse(String(options?.body));
    const code = dispatched.expected_policy !== current.policy_generation ? 'STALE_POLICY'
      : dispatched.expected_generation !== current.generation ? 'STALE_GENERATION' : null;
    if (code) return Response.json({ error: { code, message: 'Explicit caller precondition differs from the current view.' } }, { status: 409 });
    return Response.json({ data: { data: { ref: 'build-profile-archive@' + 'c'.repeat(64) }, created: [], operation_id: 'synthetic-operation' } });
  };
  try {
    for (const scenario of [
      { name: 'explicit stale generation, omitted policy', generation: 'a'.repeat(64), policy: undefined, error: 'STALE_GENERATION' },
      { name: 'explicit stale policy, omitted generation', generation: undefined, policy: 'reviewed-policy', error: 'STALE_POLICY' },
      { name: 'both explicit stale pins', generation: 'a'.repeat(64), policy: 'reviewed-policy', error: 'STALE_POLICY' },
      { name: 'both omitted pins retain existing capability defaults', generation: undefined, policy: undefined, error: null },
    ]) await t.test(scenario.name, async () => {
      const flags = [...(scenario.generation !== undefined ? ['--expect-generation', scenario.generation] : []), ...(scenario.policy !== undefined ? ['--expect-policy', scenario.policy] : [])];
      const result = await runCli(['profiles', 'archive', 'build-profile@' + 'd'.repeat(64), '--project', project,
        '--idempotency-key', 'review-original', ...flags], undefined, { STRATA_HOST_ACCOUNT: 'synthetic-account', STRATA_HOST_KEY: 'synthetic-key' });
      assert.equal(dispatched.expected_generation, scenario.generation ?? current.generation);
      assert.equal(dispatched.expected_policy, scenario.policy ?? current.policy_generation);
      assert.equal(dispatched.command, 'profile.archive'); assert.equal(dispatched.idempotency_key, 'review-original');
      assert.equal(result.ok, scenario.error === null);
      if (scenario.error) { assert.equal(result.exit_code, 5); assert.equal(result.errors[0].code, scenario.error); }
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('Studio profile replay projects no creation effects and preserves the durable historical receipt', async () => {
  const f = await buildAdapterFixture('review-replay-fixed');
  const studio = new LocalBuildStudioAdapter(f.repository, () => f.context('author-a'));
  const commands = new StudioCommands({ project_id: f.issuer.projectId, model_version: BLOCK_MODEL }, '', f.root,
    [...PROFILES_BUILD_COMMANDS], {}, 'local-fixture', undefined,
    options => async (command, input) => presentOperationEffects(await f.repository.execute(command, input, f.context('author-a'), {
      key: options.idempotency_key, expected_generation: options.expected_generation, expected_policy: options.expected_policy,
    })), undefined, studio);
  try {
    const snapshot = await f.repository.snapshot(f.context('author-a'));
    const request = { command: 'profile.create', input: f.profileRequest, idempotency_key: 'save', expected_generation: snapshot.generation, expected_policy: snapshot.policy_generation };
    const before = await readFile(path.join(f.state, 'registry.json'), 'utf8');
    const raw = await f.repository.execute('profile.create', f.profileRequest, f.context('author-a'), { key: 'save' });
    assert.equal(raw.reused, true); assert(raw.created.includes(f.saved.ref));
    for (const response of [await studio.operation(request), await commands.operation(request)]) {
      assert.equal(response.reused, true); assert.deepEqual(response.created, []);
      assert.equal(response.data.ref, f.saved.ref); assert.equal(response.operation_id, raw.operation_id);
    }
    const retained = (await f.repository.execute('operation.inspect', { key: 'save' }, f.context('author-a'))).data.result;
    assert.deepEqual(retained.created, raw.created); assert(retained.created.includes(f.saved.ref));
    assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), before);
    const record = { ...f.profileRequest.record, id: 'FreshReviewProfile', name: 'Fresh review profile' };
    const fresh = await commands.operation({ ...request, input: { record, expected_normalized_sha256: digest(record) }, idempotency_key: 'fresh-profile' });
    assert.equal(fresh.reused, false); assert(fresh.created.includes(fresh.data.ref));
  } finally { commands.close(); await f.repository.close(); }
});
