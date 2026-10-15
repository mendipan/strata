import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildAdapterFixture, indexedBuildRecords } from './build-adapter-fixture.js';
import { StudioCommands } from '../src/explorer/commands.js';
import { startExplorer } from '../src/explorer/host.js';
import { LocalBuildStudioAdapter, PROFILES_BUILD_COMMANDS } from '../src/build-studio.js';
import { BLOCK_MODEL, digest } from '../src/model.js';

test('Profiles HTTP saves refresh the actual Explorer generation, retain immutable history and refuse stale CAS after reopen', async () => {
  const f = await buildAdapterFixture('profiles-ui-http');
  const actor = () => f.context('author-a');
  const studio = new LocalBuildStudioAdapter(f.repository, actor);
  const commands = new StudioCommands({ project_id: f.issuer.projectId, model_version: BLOCK_MODEL }, '', f.root,
    [...PROFILES_BUILD_COMMANDS], {}, 'local-fixture', undefined,
    options => (command, input) => f.repository.execute(command, input, actor(), { key: options.idempotency_key }), undefined, studio);
  await commands.reader.refresh();
  const host = await startExplorer(commands.reader, { assets: path.resolve('explorer'), commands });
  const headers = { authorization: 'Bearer ' + host.capability, origin: host.origin, 'content-type': 'application/json' };
  const get = async (route: string) => (await (await fetch(host.origin + route, { headers })).json()) as any;
  try {
    const initial = await get('/explorer/v1/connection');
    assert.equal(initial.data.repository_id, f.repository.repository_id);
    assert.equal(initial.data.ready, true);
    for (const module of ['profiles', 'profile-api']) assert.equal((await fetch(host.origin + '/' + module + '.js')).status, 200);
    const snapshot = await f.repository.snapshot(actor());
    const record = { ...f.profileRequest.record, id: 'BrowserHttpProfile', name: 'Synthetic HTTP profile' };
    const request = { command: 'profile.create', input: { record, expected_normalized_sha256: digest(record) },
      idempotency_key: 'profiles-http-save', expected_generation: snapshot.generation, expected_policy: snapshot.policy_generation };
    const saved = await (await fetch(host.origin + '/studio/v1/operation', { method: 'POST', headers, body: JSON.stringify(request) })).json() as any;
    assert(saved.data.data.ref);
    const connection = await get('/explorer/v1/connection');
    assert.equal(connection.data.source.registry_generation, saved.data.generation);
    assert.equal((await get('/explorer/v1/records?type=release&generation=' + saved.data.generation)).error, undefined);
    const bytes = await readFile(path.join(f.state, 'registry.json'), 'utf8');
    const replay = await commands.operation(request);
    assert.equal(replay.reused, true); assert.deepEqual(replay.created, []);
    assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), bytes);
    await f.reopen();
    assert.equal((await f.repository.execute('profile.inspect', { ref: saved.data.data.ref }, actor())).data.record.name, record.name);
    const historical = await indexedBuildRecords(f.state);
    assert.equal(digest(historical[saved.data.data.ref].data), saved.data.data.sha256);
    await assert.rejects(f.repository.execute('profile.create', { ...request.input, record: { ...record, id: 'StaleHttpProfile' } }, actor(),
      { key: 'profiles-http-stale', expected_generation: snapshot.generation, expected_policy: snapshot.policy_generation }), (error: any) => error.code === 'STALE_GENERATION');
    assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), bytes);
  } finally { await host.close(); commands.close(); await f.repository.close(); }
});
