import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostCollectionFixture } from './collection-host-fixture.js';
import { digest, fail, canonical } from '../src/model.js';
import { runNodeCommand } from '../src/commands/node.js';
import { hostRunner } from '../src/auth/runner.js';
import { buildSupportingRef, type BuildProfileRecord, type ReleaseBuildBinding, type RepositoryContractRecord } from '../src/build-contracts.js';
import { LocalBuildCoordinator, assertBuildRun, type BuildAttemptStore, type BuildRun, type BuildDependencies } from '../src/build.js';
import { LocalBuildOutput } from '../src/build-output.js';
import { currentBuildHost } from '../src/build-host.js';
import { runLocalBuildChecks } from '../src/build-node.js';
import { profileFor } from '../src/profiles.js';

/** Test-only mock. Production durable admission and authorization remain S1/S3 work. */
export class MockBuildStore implements BuildAttemptStore {
  rows = new Map<string, BuildRun>();
  failReplace: ((run: BuildRun) => boolean) | null = null;
  private key(run: BuildRun) { return canonical([run.project_id, run.repository_id, run.actor, run.request_key]); }
  async request(project: string, repository: string, actor: string, key: string) {
    const found = [...this.rows.values()].find(r => this.key(r) === canonical([project, repository, actor, key]));
    return found ? structuredClone(found) : null;
  }
  async accept(run: BuildRun) {
    // No awaited gap: model the required atomic request-key claim.
    const existing = [...this.rows.values()].find(value => this.key(value) === this.key(run));
    if (existing) {
      if (existing.request_sha256 !== run.request_sha256) fail('BUILD_REQUEST_CONFLICT', 5, 'Request key conflict.');
      return { created: false, run: existing };
    }
    assertBuildRun(run); this.rows.set(run.build_id, structuredClone(run));
    return { created: true, run: structuredClone(run) };
  }
  async get(id: string) { return this.rows.has(id) ? structuredClone(this.rows.get(id)!) : null; }
  async replace(run: BuildRun, expected: string) {
    if (this.failReplace?.(run)) throw new Error('Simulated journal persistence outage.');
    if (!this.rows.has(run.build_id) || digest(this.rows.get(run.build_id)) !== expected) fail('BUILD_RUN_CONFLICT', 5, 'Attempt CAS failed.');
    this.rows.set(run.build_id, structuredClone(assertBuildRun(run)));
  }
  async pending(project: string, repository: string) { return [...this.rows.values()].filter(r => r.project_id === project && r.repository_id === repository).map(r => structuredClone(r)); }
}
export async function localBuildFixture(name: string) {
  const f = await hostCollectionFixture('s2-' + name);
  f.publish(f.extension);
  const target = f.call('author-a', 'compose', { record: { ...f.recipe, id: 'S2Publication' } }).ref;
  const materialized = await runNodeCommand(f.root, async (c, i) => f.call('runner', c, i), 'materialize', { target, profile: 'collection-host/1', out: '.strata/source-evidence' });
  const realization = f.engine.read(materialized.ref), request = { target, slot: 'source', profile: 'collection-host/1' };
  f.call('runner', 'evidence.run', request);
  const run = await hostRunner(f.root, { source: '.strata/source-evidence' }, ['collection-host/1'])(f.engine, request, f.issuer.resolve(f.tokens.runner));
  const reviews = realization.oracle.criteria.filter((c: any) => c.method === 'review').map((criterion: any) => f.call('reviewer', 'criterion.review', { realization: materialized.ref, criterion, accepted: true, rationale: 'Reviewed synthetic source for the isolated S2 test.' }).ref);
  const evidence = f.call('runner', 'evidence.assemble', { realization: materialized.ref, run_ref: run.ref, review_refs: reviews }).evidence;
  const validation = f.call('runner', 'validate', { target, realization: materialized.ref, evidence });
  const evaluation = f.engine.target(target), shape = { format: 'approval/3', project_id: f.issuer.projectId, model_version: f.baseline.model_version, baseline: 'HostCollectionBaseline@1', authority_sha256: digest(f.baseline.authorities), target: evaluation.fingerprint, evidence_digest: validation.evidence_digest, generation: f.engine.mediation!.generation(), expires_at: null, binding: null };
  const scope = f.call('scope-selector', 'approve', { record: { ...shape, kind: 'scope', scope: evaluation.scope } });
  const approval = f.call('release-manager', 'approve', { record: { ...shape, kind: 'release', scope: null } });
  const release = f.call('release-manager', 'release', { target, validation: validation.ref, approvals: [scope.ref, approval.ref] });
  const project_id = f.issuer.projectId, repository_id = 's2-demo', pin = (ref: string) => ({ ref, sha256: 'a'.repeat(64) });
  const contract: RepositoryContractRecord = { format: 'strata-repository-compatibility/1', id: 'S2Contract', revision: 1, rules: [], preferences: [], project_id, repository_id, previous: null, author: 'synthetic-author', auth_receipt: pin('auth-receipt@aa'), review: pin('review@aa') };
  const context = { project_id, repository_id, contract: { ref: buildSupportingRef(contract), sha256: digest(contract), record: contract } };
  const binding: ReleaseBuildBinding = { format: 'strata-release-build-binding/1', project_id, repository_id, release: { ref: release.ref, sha256: digest(f.engine.read(release.ref)) }, contract: { ref: context.contract.ref, sha256: context.contract.sha256 }, provenance: 'post_publication_adoption', author: 'synthetic-adopter', auth_receipt: pin('auth-receipt@aa'), review: pin('review@aa') };
  const profile: BuildProfileRecord = { format: 'strata-build-profile/1', project_id, repository_id, id: 'S2Local', revision: 1, name: 'S2 Local', previous: null, author: 'synthetic-author', auth_receipt: pin('auth-receipt@aa'), derived_from: null,
    contract_ref: context.contract.ref, contract_sha256: context.contract.sha256, choices: { language: 'javascript', framework: 'none', runtime: 'node' }, materializer: { id: 'collection-host/1', archive_sha256: digest(profileFor('collection-host/1').archive()) } };
  const container = await mkdtemp(path.join(os.tmpdir(), 'strata-s2-output-' + name + '-')), root = path.join(container, 'build-output'); await mkdir(root, { mode: 0o700 });
  const output = new LocalBuildOutput({ id: 'local-output', label: 'Isolated test output', root, excluded_roots: [f.root, process.cwd()],
    // Explicit mocked custody; the native Windows adapter has its own separate test.
    protection: async () => ({ safe: true, fingerprint: digest('mocked-private-custody') }) });
  const store = new MockBuildStore(), operations: string[] = [];
  const registrations = new Map<string, { state: 'committed'; command: 'realization.register'; child_key: string; input_sha256: string; ref: string }>();
  let host = currentBuildHost('Synthetic Studio host', { id: 'finite-node', profile_ids: ['collection-host/1'] }), allowed = true, policy_sha256 = digest('s2-policy'), source_generation = 1;
  const dependencies: BuildDependencies = {
    project_id, repository_id, store, output,
    lookup: { compatibility: async () => ({ contract_binding: 'post_publication_adoption', context, binding: { ref: buildSupportingRef(binding), sha256: digest(binding), record: binding } }),
      profile: async ref => ({ ref, sha256: digest(profile), record: profile }) },
    readContext: async () => ({ engine: f.engine, source_generation, publication: { project_id, records: f.engine.records, source_trust: 'local-fixture' } }),
    authorize: async () => { if (!allowed) fail('BUILD_FORBIDDEN', 4, 'Synthetic access was revoked.'); return { actor: 'runner', project_id, repository_id, policy_sha256 }; },
    host: async () => host,
    operation: async (command, input, key) => {
      assert.match(key, /^[a-f0-9]{64}$/); operations.push(command);
      const result = f.call('runner', command, input);
      if (command === 'realization.register') registrations.set(key, { state: 'committed', command, child_key: key, input_sha256: digest(input), ref: result.ref });
      return result;
    },
    lookupRegistration: async request => {
      assert.equal(request.project_id, project_id); assert.equal(request.repository_id, repository_id); assert.equal(request.actor, 'runner');
      return registrations.get(request.child_key) ?? { state: 'unknown' };
    },
    runChecks: async input => {
      operations.push('evidence.run');
      // Establish the existing operation's authenticated receipt before invoking the private runner seam.
      f.call('runner', 'evidence.run', { target: input.target, slot: 'build-' + input.build_id, profile: input.profile });
      return runLocalBuildChecks(output, f.engine, f.issuer.resolve(f.tokens.runner), input);
    }
  };
  const coordinator = new LocalBuildCoordinator(dependencies), selection = { release_ref: release.ref, profile_ref: buildSupportingRef(profile), destination: { kind: 'local' as const, slot_id: output.slot.id } };
  return { ...f, release, sourceRun: run, target, context, profile, binding, root, output, store, operations, registrations, dependencies, coordinator, selection,
    setHost: (value: typeof host) => { host = value; }, getHost: () => host, setAllowed: (value: boolean) => { allowed = value; },
    setPolicy: () => { policy_sha256 = digest('changed-policy'); }, setGeneration: () => { source_generation++; } };
}
