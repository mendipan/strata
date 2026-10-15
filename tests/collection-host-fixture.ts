import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HostIssuer, HOST_OPERATIONS } from '../src/auth/host-issuer.js';
import { Engine } from '../src/core.js';
import { BLOCK_MODEL, digest } from '../src/model.js';
import { executeAuthorized } from '../src/service.js';

export async function hostCollectionFixture(name = 'workflow', createUnderCollection = true, projectId = 'synthetic-collection-host', clockStart = Date.now()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-collection-host-' + name + '-'));
  const names = ['author-a', 'author-b', 'runner', 'reviewer', 'scope-selector', 'safety-guardian', 'release-manager', 'reader'];
  // Public deterministic synthetic credentials only, confined to this disposable test.
  const keys = Object.fromEntries(names.map((name, n) => [name, Buffer.alloc(32, n + 71).toString('base64url')]));
  let now = clockStart;
  const accounts = { format: 'strata-host-accounts/1', generation: 1, accounts: names.map(principal_id => ({ account_id: principal_id, principal_id, principal_kind: principal_id === 'runner' ? 'agent' : 'person', active: true, credential_epoch: 1, key_sha256: createHash('sha256').update(keys[principal_id]).digest('hex') })) };
  const policy = { format: 'strata-host-policy/1', project_id: projectId, generation: 1, grants: names.map(principal_id => ({
    grant_id: principal_id, principal_id, operations: principal_id === 'reader' ? ['inspect', 'status', 'capabilities', 'review.state'] : [...HOST_OPERATIONS], layer_ids: null,
    write_block_ids: principal_id.startsWith('author-') ? ['collection', 'items', 'policy'] : [], create_under_block_ids: principal_id.startsWith('author-') && createUnderCollection ? ['collection'] : [],
    approvals: principal_id === 'scope-selector' ? ['scope', 'resolution'] : principal_id === 'safety-guardian' ? ['guardian'] : principal_id === 'release-manager' ? ['release'] : [],
    profiles: principal_id === 'runner' ? ['collection-host/1'] : [], expires_at: new Date(now + 3600000).toISOString()
  })) };
  const issuer = new HostIssuer(accounts, policy, () => now);
  const tokens = Object.fromEntries(names.map(name => [name, issuer.login(name, keys[name])]));
  const engine = new Engine({}, {}, { projectId: issuer.projectId, modelVersion: BLOCK_MODEL, checkerBackend: 'node' });
  const call = (principal: string, command: string, input: any) => executeAuthorized(engine, command, input, issuer.resolve(tokens[principal]), issuer);
  const read = async (name: string) => JSON.parse(await readFile(path.join('tests/fixtures/collection-host', name + '.json'), 'utf8'));
  const baseline = await read('bootstrap'), extension = await read('extend'), recipe = await read('composition'), expectations = await read('expectations');
  const audit = await read('audit-layer'); audit.created_blocks = [await read('audit-block')];
  call('author-a', 'init', { record: baseline });
  function publish(layer: any, principal = layer.owner) {
    call(principal, 'layer.create', { record: layer });
    const normalized = engine.read(layer.id + '@' + layer.revision, 'layer', false);
    const review = call('reviewer', 'content.review', { record: { draft: normalized, expected_digest: digest(normalized), accepted: true, rationale: 'Reviewed exact synthetic collection intent.' } });
    return call(principal, 'layer.publish', { ref: layer.id + '@' + layer.revision, authoring_review: review.ref });
  }
  return { root, keys, accounts, policy, issuer, tokens, engine, call, baseline, extension, recipe, expectations, audit, publish, advance: () => { now += 1800001; } };
}
