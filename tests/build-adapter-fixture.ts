import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { localBuildFixture } from './build-local-fixture.js';
import { HostIssuer } from '../src/auth/host-issuer.js';
import { PROFILE_OPERATIONS } from '../src/build-records.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION } from '../src/build-operations.js';
import { BLOCK_MODEL, canonical, digest, bytesDigest, type Records } from '../src/model.js';
import { bindNodeState } from '../src/node-state.js';
import { openLocalBuildRepository, type LocalBuildRepositoryConfig } from '../src/build-repository-node.js';
import { normalizeBuildProfile } from '../src/build-contracts.js';

export async function indexedBuildRecords(state: string): Promise<Records> {
  const registry = JSON.parse(await readFile(path.join(state, 'registry.json'), 'utf8')), records: Records = {};
  for (const [ref, entry] of Object.entries(registry.entries) as [string, any][]) records[ref] = { type: entry.type, published: entry.published, data: JSON.parse(await readFile(path.join(state, 'artifacts', entry.hash + '.json'), 'utf8')) };
  return records;
}
export async function buildAdapterFixture(name: string, hooks: Partial<LocalBuildRepositoryConfig> = {}, repository_id = 's3-demo') {
  const f = await localBuildFixture('s3-' + name);
  const policy: any = { ...f.policy, format: 'strata-host-policy/4', generation: 2, grants: f.policy.grants.map(g => {
    const { expires_at, ...old } = g;
    return { ...old, operations: [...new Set([...g.operations, ...PROFILE_OPERATIONS, ...(g.principal_id === 'runner' ? BUILD_OPERATIONS : []),
      ...(g.principal_id === 'release-manager' ? [BUILD_RECOVERY_OPERATION, 'build.inspect', 'build.outputs'] : [])])],
      lifetime: { mode: 'until', expires_at }, build_repository_ids: [repository_id] };
  }) };
  // All credentials/policy are existing deterministic disposable fixture values.
  const issuer = new HostIssuer(f.accounts, policy), tokens = Object.fromEntries(Object.keys(f.keys).map(n => [n, issuer.login(n, f.keys[n])]));
  const state = path.join(f.output.slot.excluded_roots[0], 'state'), lease = await bindNodeState(state, issuer.projectId, BLOCK_MODEL); await lease();
  await mkdir(path.join(state, 'artifacts')); const entries: Record<string, any> = {};
  for (const [ref, r] of Object.entries(f.engine.records)) { const bytes = canonical(r.data), hash = bytesDigest(bytes); await writeFile(path.join(state, 'artifacts', hash + '.json'), bytes); entries[ref] = { type: r.type, published: r.published, hash }; }
  await writeFile(path.join(state, 'registry.json'), canonical({ entries, heads: f.engine.ownerHeads, requests: {}, commit_audit: [] }));
  const config: LocalBuildRepositoryConfig = { state_directory: state, issuer, scope: { project_id: issuer.projectId, repository_id, source_trust: 'local-fixture', authority_ref: 'HostCollectionBaseline@1' }, output: f.output, host: async () => f.getHost(), ...hooks };
  let repository = await openLocalBuildRepository(config);
  const context = (name = 'runner') => issuer.resolve(tokens[name]);
  const importInput = { record: { format: 'strata-repository-compatibility/1', id: 'LocalContract', revision: 1, rules: [], preferences: [] }, previous: null };
  await repository.review('repository.contract.import', importInput, context('release-manager'), { key: 'review-import' });
  const contract = (await repository.execute('repository.contract.import', importInput, context('author-a'), { key: 'import' })).data;
  const attach = { release_ref: f.release.ref, contract_ref: contract.ref, expected_release_sha256: digest(f.engine.read(f.release.ref)) };
  await repository.review('repository.contract.attach', attach, context('release-manager'), { key: 'review-attach' });
  const binding = (await repository.execute('repository.contract.attach', attach, context('author-a'), { key: 'attach' })).data;
  const inputProfile = { ...f.profile, id: 'S3Profile', name: 'Local preview', contract_ref: contract.ref, contract_sha256: contract.sha256 };
  const { format, project_id, repository_id: _repository, previous, author, auth_receipt, derived_from, ...record } = inputProfile;
  const profileRequest = { record, expected_normalized_sha256: digest(normalizeBuildProfile(record)) };
  const saved = (await repository.execute('profile.create', profileRequest, context('author-a'), { key: 'save' })).data;
  const selection = { release_ref: f.release.ref, profile_ref: saved.ref, destination: { kind: 'local', slot_id: f.output.slot.id } };
  return { ...f, issuer, tokens, policy, state, config, context, importInput, contract, binding, saved, profileRequest, selection,
    get repository() { return repository; },
    async reopen() { await repository.close(); repository = await openLocalBuildRepository(config); return repository; },
  };
}
