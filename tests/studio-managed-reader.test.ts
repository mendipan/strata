import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { canonical, digest, bytesDigest } from '../src/model.js';
import { ArtifactsManagedReaders } from '../src/explorer/managed-reader.js';
import { RegistrySource } from '../src/explorer/source.js';
import { INACTIVE_MARKER, STATE_DESCRIPTOR, NODE_STATE_FORMAT } from '../src/node-state.js';
import { prepareSourcePolicy, initialConnectionState } from '../src/explorer/connection-store.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { managerFixture } from './studio-manager-fixture.js';
import { registry, sample } from './explorer-fixture.js';

async function fixture() {
  let credentials = 0, calls = 0, revoke = false;
  const records = await sample();
  const files = new Map(Object.values(records).map(record => {
    const text = canonical(record.data);
    return [bytesDigest(text) + '.json', text];
  }));
  const f = await managerFixture({ build: async (ticket, budget, check) => {
    const factory = new ArtifactsManagedReaders(f.policyPort, async () => {
      credentials++;
      // The durable reservation must already exist before a credential is read.
      assert.equal((await f.ledger(ticket.grant_id)).reserved_requests, credentials);
      if (revoke) f.setPolicy(undefined);
      return 'synthetic-provider-value';
    }, async (input, options) => {
      calls++;
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'manual');
      const url = new URL(String(input));
      if (url.pathname.endsWith('/file')) {
        assert.equal(url.searchParams.get('ref'), 'f'.repeat(40));
        return new Response(files.get(url.searchParams.get('path')!) ?? '', { status: 200 });
      }
      const storage = ticket.connection.storage;
      return Response.json({success:true,result:{id:ticket.expected_repository_id,name:storage.repository,
        remote:`https://${storage.account}.artifacts.cloudflare.net/git/${storage.namespace}/${storage.repository}.git`}});
    });
    return factory.build(ticket, budget, check);
  }});
  const index = registry(records, f.policy.tickets[0].connection);
  await writePrivate(f.policy.tickets[0].connection.registry_path, index, true);
  const policy = prepareSourcePolicy({...f.policy,profiles:[{...f.policy.profiles[0],registry_sha256:digest(index)}]});
  f.setPolicy(policy);
  const genesis = initialConnectionState(policy);
  await writePrivate(path.join(f.storeDir,'genesis.json'), genesis);
  await writePrivate(path.join(f.storeDir,'state.json'), genesis);
  return {...f,policy,index,credentials:()=>credentials,calls:()=>calls,revoke:()=>revoke=true};
}

test('managed real REST adapter verifies immutable synthetic records and preserves one ledger through restart', async () => {
  const f = await fixture();
  await f.action('create');
  assert.equal(f.calls(), 0);
  const result = await f.action('connect');
  assert.equal(result.outcome.state, 'completed');
  assert.equal(f.calls(), 15);
  assert.equal(f.credentials(), 15);
  const ledger = await f.ledger(f.policy.tickets[0].grant_id);
  assert.equal(ledger.reserved_requests, 15);
  assert.equal((await f.make().status(f.authority)).connections[0].runtime_ready, false);
  assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_bytes, ledger.reserved_bytes);
});

test('revocation between durable reservation and credential return prevents provider dispatch without refund', async () => {
  const f = await fixture();
  await f.action('create');
  f.revoke();
  await assert.rejects(f.action('connect'), (error:any) => error.code === 'SOURCE_MANAGEMENT_REQUIRED');
  assert.equal(f.credentials(), 1);
  assert.equal(f.calls(), 0);
  assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests, 1);
});

test('fixed registry replacement before consumption is denied before reservation, credential or provider access', async () => {
  const f = await fixture();
  await f.action('create');
  const replacement = structuredClone(f.index);
  for (const entry of Object.values(replacement.entries)) entry.locator!.ref = 'e'.repeat(40);
  const original = RegistrySource.prototype.load;
  RegistrySource.prototype.load = async function(signal) {
    await writePrivate(this.config.registry_path, replacement);
    return original.call(this, signal);
  };
  try {
    const result = await f.action('connect');
    assert.equal(result.outcome.state, 'failed');
    assert.equal(result.outcome.code, 'SOURCE_BINDING');
    assert.equal(result.connections[0].runtime_ready, false);
    assert.equal(f.calls(), 0);
    assert.equal(f.credentials(), 0);
    assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests, 0);
  } finally { RegistrySource.prototype.load = original; }
});

test('fixed registry consumption uses the exact approved bytes even if the file changes afterward', async () => {
  const f = await fixture();
  await f.action('create');
  const replacement = structuredClone(f.index);
  for (const entry of Object.values(replacement.entries)) entry.locator!.ref = 'e'.repeat(40);
  const original = RegistrySource.prototype.load;
  RegistrySource.prototype.load = async function(signal) {
    const source = this as unknown as { registry: () => Promise<string> };
    const read = source.registry;
    source.registry = async () => {
      const approvedBytes = await read();
      await writePrivate(this.config.registry_path, replacement);
      return approvedBytes;
    };
    try { return await original.call(this, signal); }
    finally { source.registry = read; }
  };
  try {
    const result = await f.action('connect');
    assert.equal(result.outcome.state, 'completed');
    assert.equal(result.connections[0].runtime_ready, true);
    assert.equal(f.calls(), 15); // The transport asserts every ref is the approved commit.
    assert.equal(f.credentials(), 15);
    assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests, 15);
  } finally { RegistrySource.prototype.load = original; }
});

for (const boundary of ['inactive', 'descriptor'] as const) {
  test(`managed fixed registry retains the ${boundary} admission safeguard`, async () => {
    const f = await fixture();
    await f.action('create');
    if (boundary === 'inactive') await writeFile(path.join(f.directory, INACTIVE_MARKER), 'synthetic inactive recovery');
    else await writePrivate(path.join(f.directory, STATE_DESCRIPTOR), {
      format: NODE_STATE_FORMAT, model_version: f.policy.tickets[0].connection.model_version, project_id: 'another-project'
    });
    const result = await f.action('connect');
    assert.equal(result.outcome.code, 'SOURCE_BINDING');
    assert.equal(f.calls(), 0);
    assert.equal(f.credentials(), 0);
    assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests, 0);
  });
}
