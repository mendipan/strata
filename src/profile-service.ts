import { z } from 'zod';
import { Engine } from './core.js';
import { canonical, digest, fail, parse } from './model.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import { BUILD_LIMITS, buildPinSchema, buildProfileInputSchema, repositoryContractInputSchema, normalizeRepositoryContract, normalizeBuildProfile, type BuildPin, type BuildProfileRecord } from './build-contracts.js';
import { resolveBuildProfile, type BuildRepositoryLookup, type CompatibilityLookup } from './build-compatibility.js';
import { inspectReleasePublication, type PublicationContext } from './build-publication.js';
import { visibleRecords } from './workflow.js';
import { PROFILE_MUTATIONS, buildRecordRef, buildRecordReferences, buildRecordType, contractContext, exactBuildRecord, profileInput, verifyBuildHistory, type BuildContractReview } from './build-records.js';

const ref = buildPinSchema.shape.ref, hash = buildPinSchema.shape.sha256;
export const PROFILE_OPERATION_SCHEMAS = {
  'repository.compatibility': z.object({ release_ref: ref.optional() }).strict(),
  'repository.contract.import': z.object({ record: repositoryContractInputSchema, previous: ref.nullable() }).strict(),
  'repository.contract.attach': z.object({ release_ref: ref, contract_ref: ref, expected_release_sha256: hash }).strict(),
  'profile.list': z.object({ contract_ref: ref.optional(), limit: z.number().int().min(1).max(BUILD_LIMITS.page).optional(), cursor: ref.optional() }).strict(),
  'profile.inspect': z.object({ ref }).strict(),
  'profile.validate': z.object({ record: buildProfileInputSchema, target_ref: ref.optional() }).strict(),
  'profile.create': z.object({ record: buildProfileInputSchema, expected_normalized_sha256: hash }).strict(),
  'profile.revise': z.object({ previous: ref, record: buildProfileInputSchema, expected_normalized_sha256: hash }).strict(),
  'profile.archive': z.object({ ref }).strict()
};
export type ProfileServiceScope = {
  project_id: string; repository_id: string; source_trust: PublicationContext['source_trust'];
  // Host-owned retained baseline and exact review resolver. Neither is accepted in request JSON.
  authority_ref: string; review?: (action: string, subject_sha256: string) => BuildPin | undefined;
  visible?: (ref: string) => boolean;
};
/** Used within the host's existing registry transaction; this service performs no filesystem I/O. */
export class BuildProfileService implements BuildRepositoryLookup {
  constructor(readonly engine: Engine, readonly scope: ProfileServiceScope, readonly context: SecurityContext, readonly issuer: AuthorityIssuer) {
    if (engine.options.projectId !== scope.project_id || context.project_id !== scope.project_id || issuer.projectId !== scope.project_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Profile service must be bound to one authenticated project.');
  }
  private authorize(command: string, input: unknown) {
    this.issuer.authorize(this.context, command, input, this.engine);
    this.issuer.assertRepository(this.context, command, this.scope.repository_id, []);
  }
  assertAuthority(command: string, input: unknown) { this.authorize(command, this.normalized(command, input)); }
  assertVisibleRecord(ref: string) { this.visible(ref); }
  private pin(ref: string, type?: string): BuildPin {
    this.visible(ref); const record = this.engine.read(ref, type);
    return { ref, sha256: digest(record) };
  }
  private visible(ref: string, visited = new Set<string>()) {
    if (visited.has(ref)) return; visited.add(ref);
    const r = this.engine.records[ref];
    if (!r?.published || this.scope.visible && !this.scope.visible(ref)) fail('BUILD_SOURCE_UNAVAILABLE', 3, 'Exact supporting history is unavailable in this read scope.');
    if (buildRecordType(r.type)) {
      if (r.data.project_id !== this.scope.project_id || r.data.repository_id !== this.scope.repository_id) fail('BUILD_SOURCE_UNAVAILABLE', 3, 'Exact supporting history is unavailable in this repository.');
      for (const p of buildRecordReferences(r.type, r.data)) this.visible(p.ref, visited);
    }
  }
  private entries(type: string) { return Object.entries(this.engine.records).filter(([, r]) => r.type === type && r.data.project_id === this.scope.project_id && r.data.repository_id === this.scope.repository_id); }
  private head(type: string, id?: string) { return this.entries(type).filter(([, r]) => id === undefined || r.data.id === id).sort((a, b) => b[1].data.revision - a[1].data.revision)[0]?.[0]; }
  private archived(id: string) { return this.entries('build-profile-archive').some(([, r]) => this.engine.records[r.data.profile.ref]?.data.id === id); }
  private publication(releaseRef: string) {
    const report = inspectReleasePublication({ project_id: this.scope.project_id, records: this.engine.records, asset_bytes: this.engine.options.assetBytes, source_trust: this.scope.source_trust, visible: this.scope.visible }, releaseRef);
    if (!report.historically_approved) fail(report.code, report.state === 'unavailable' ? 3 : 6, report.message);
    return report;
  }
  private normalized(command: string, value: unknown): any {
    if (!Object.hasOwn(PROFILE_OPERATION_SCHEMAS, command)) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown profile repository operation.');
    const input: any = parse(PROFILE_OPERATION_SCHEMAS[command as keyof typeof PROFILE_OPERATION_SCHEMAS] as z.ZodType<any>, value);
    if (command === 'repository.contract.import') input.record = normalizeRepositoryContract(input.record);
    else if (input.record) input.record = normalizeBuildProfile(input.record);
    return input;
  }
  private authenticate(command: string, input: unknown) {
    this.issuer.assertLive(this.context);
    const c = this.context, input_sha256 = digest(input);
    const data = {
      format: 'strata-build-repository-auth/1', project_id: c.project_id, repository_id: this.scope.repository_id,
      principal_id: c.principal_id, principal_kind: c.principal_kind, account_id: c.account_id ?? null, credential_epoch: c.credential_epoch ?? null,
      action: command, input_sha256, request_sha256: digest({ command, input_sha256, principal: c.principal_id, repository: this.scope.repository_id, policy: c.policy_version }),
      policy_generation: c.policy_version, grant_id: c.grant_id, expires_at: c.expires_at, trust: c.trust_mode === 'host_authenticated' ? 'host-authenticated' : 'local-fixture'
    };
    const ref = buildRecordRef('build-repository-auth', data); this.engine.store(ref, 'build-repository-auth', data);
    return { ref, sha256: digest(data) };
  }
  private retainedReview(command: string, input: unknown) {
    const resolved = this.scope.review?.(command, digest(input));
    if (!resolved) fail('BUILD_REVIEW_REQUIRED', 6, 'An exact retained authorized contract review is required.');
    const pin = { ref: resolved.ref, sha256: resolved.sha256 };
    this.visible(pin.ref); const review: BuildContractReview = exactBuildRecord(this.engine.records, pin, 'build-contract-review');
    if (review.action !== command || review.subject_sha256 !== digest(input) || review.project_id !== this.scope.project_id || review.repository_id !== this.scope.repository_id) fail('BUILD_REVIEW_INVALID', 6, 'Review does not bind this exact repository request.');
    return pin;
  }
  /** Internal review seam for a separately authenticated reviewer, never a public review claim. */
  review(command: 'repository.contract.import' | 'repository.contract.attach', value: unknown) {
    const input = this.normalized(command, value); this.authorize(command, input); verifyBuildHistory(this.engine.records, this.scope.project_id);
    const authorityRef = command === 'repository.contract.attach' ? this.engine.read(input.release_ref, 'release').baseline : this.scope.authority_ref;
    if (command === 'repository.contract.attach') this.publication(input.release_ref);
    const authority = this.pin(authorityRef, 'release');
    if (!this.engine.read(authorityRef, 'release').authorities.release.includes(this.context.principal_id) || !this.issuer.permitsApproval(this.context, 'release')) fail('AUTHORITY_FORBIDDEN', 4, 'Contract reviewer needs explicitly assigned repository operation and pinned Release-review authority.');
    const before = structuredClone(this.engine.records);
    try {
      const record: BuildContractReview = { format: 'strata-build-contract-review/1', project_id: this.scope.project_id, repository_id: this.scope.repository_id,
        action: command, subject_sha256: digest(input), reviewer: this.context.principal_id, authority, accepted: true, auth_receipt: this.authenticate(command, input) };
      const ref = buildRecordRef('build-contract-review', record); this.engine.store(ref, 'build-contract-review', record);
      verifyBuildHistory(this.engine.records, this.scope.project_id); this.issuer.assertLive(this.context);
      return { ref, sha256: digest(record), record };
    } catch (error) { this.engine.records = before; throw error; }
  }
  async compatibility(release_ref?: string): Promise<CompatibilityLookup> { return this.execute('repository.compatibility', release_ref ? { release_ref } : {}); }
  async profile(ref: string): Promise<BuildPin & { record: BuildProfileRecord }> {
    this.authorize('profile.inspect', { ref }); verifyBuildHistory(this.engine.records, this.scope.project_id);
    return { ...this.pin(ref, 'build-profile'), record: this.engine.read(ref, 'build-profile') };
  }
  generation() {
    return digest(visibleRecords(this.engine, this.context.principal_id));
  }
  execute(command: string, value: unknown, expected?: { generation?: string; policy?: string }): any {
    const input = this.normalized(command, value); this.authorize(command, input); verifyBuildHistory(this.engine.records, this.scope.project_id);
    if (expected?.policy !== undefined && expected.policy !== this.context.policy_version) fail('STALE_POLICY', 5, 'Profile policy changed before dispatch.');
    if (expected?.generation !== undefined && expected.generation !== this.generation()) fail('STALE_GENERATION', 5, 'Profile repository view changed before dispatch.');
    const before = structuredClone(this.engine.records);
    try {
      const data = this.dispatch(command, input);
      if (PROFILE_MUTATIONS.includes(command as any)) { verifyBuildHistory(this.engine.records, this.scope.project_id); this.authorize(command, input); }
      return data;
    } catch (error) { this.engine.records = before; throw error; }
  }
  private dispatch(command: string, input: any): any {
    switch (command) {
      case 'repository.compatibility': {
        if (input.release_ref) {
          this.publication(input.release_ref);
          const entries = this.entries('release-build-binding').filter(([, r]) => r.data.release.ref === input.release_ref);
          if (!entries.length) return { contract_binding: 'missing', context: null, binding: null };
          const [ref, stored] = entries[0]; this.visible(ref);
          return { contract_binding: 'post_publication_adoption', context: contractContext(this.engine.records, this.scope.project_id, this.scope.repository_id, stored.data.contract), binding: { ...this.pin(ref), record: structuredClone(stored.data) } };
        }
        const ref = this.head('repository-compatibility');
        return ref ? { contract_binding: 'profile_authoring_head', context: contractContext(this.engine.records, this.scope.project_id, this.scope.repository_id, this.pin(ref)), binding: null } : { contract_binding: 'missing', context: null, binding: null };
      }
      case 'repository.contract.import': {
        const head = this.head('repository-compatibility');
        if ((head ?? null) !== input.previous) fail('STALE_REVISION', 5, 'Contract import must name the exact current authoring head.');
        const prior = head ? this.engine.read(head, 'repository-compatibility') : null;
        if (input.record.revision !== (prior?.revision ?? 0) + 1 || prior && prior.id !== input.record.id) fail('BUILD_CONTRACT_LINEAGE_CONFLICT', 5, 'Contract must continue the designated repository lineage.');
        const record = { ...input.record, project_id: this.scope.project_id, repository_id: this.scope.repository_id, previous: head ? this.pin(head) : null,
          author: this.context.principal_id, review: this.retainedReview(command, input), auth_receipt: this.authenticate(command, input) };
        const ref = buildRecordRef('repository-compatibility', record); this.engine.store(ref, 'repository-compatibility', record); return { ref, sha256: digest(record), record };
      }
      case 'repository.contract.attach': {
        const publication = this.publication(input.release_ref);
        if (publication.release!.sha256 !== input.expected_release_sha256) fail('BUILD_PIN_MISMATCH', 6, 'Adoption Release changed from the explicitly expected digest.');
        const contract = this.pin(input.contract_ref, 'repository-compatibility'); contractContext(this.engine.records, this.scope.project_id, this.scope.repository_id, contract);
        if (Object.values(this.engine.records).some(r => r.type === 'release-build-binding' && r.data.release.ref === input.release_ref)) fail('BUILD_BINDING_CONFLICT', 5, 'Legacy Release already has an immutable adoption.');
        const record = { format: 'strata-release-build-binding/1', project_id: this.scope.project_id, repository_id: this.scope.repository_id,
          release: publication.release!, contract, provenance: 'post_publication_adoption', author: this.context.principal_id,
          review: this.retainedReview(command, input), auth_receipt: this.authenticate(command, input) };
        const ref = buildRecordRef('release-build-binding', record); this.engine.store(ref, 'release-build-binding', record); return { ref, sha256: digest(record), record };
      }
      case 'profile.validate': {
        this.pin(input.record.contract_ref, 'repository-compatibility');
        if (input.target_ref) {
          const lookup = this.dispatch('repository.compatibility', { release_ref: input.target_ref });
          if (!lookup.context) fail('BUILD_CONTRACT_MISSING', 6, 'Selected Release has no adoption binding.');
          return resolveBuildProfile(lookup.context, input.record, { engine: this.engine, ref: input.target_ref });
        }
        const context = this.dispatch('repository.compatibility', {}).context;
        if (!context) fail('BUILD_CONTRACT_MISSING', 6, 'Repository has no profile-authoring contract.');
        return resolveBuildProfile(context, input.record);
      }
      case 'profile.create': case 'profile.revise': {
        const head = this.head('build-profile', input.record.id);
        if (command === 'profile.create' && (head || input.record.revision !== 1)) fail('BUILD_PROFILE_EXISTS', 5, 'New logical profile requires unused identity and revision one.');
        if (command === 'profile.revise' && (!head || input.previous !== head || input.record.revision !== this.engine.read(head).revision + 1)) fail('STALE_REVISION', 5, 'Profile revision must name the exact current head.');
        if (this.archived(input.record.id)) fail('BUILD_PROFILE_ARCHIVED', 5, 'Archived logical profile cannot be revised.');
        const context = this.dispatch('repository.compatibility', {}).context;
        if (!context) fail('BUILD_CONTRACT_MISSING', 6, 'Repository has no profile-authoring contract.');
        const result = resolveBuildProfile(context, input.record);
        if (result.report.normalized_sha256 !== input.expected_normalized_sha256) fail('BUILD_PROFILE_DIGEST_MISMATCH', 5, 'Normalized profile differs from the reviewed expected digest.');
        if (!result.report.repository_valid || result.report.checks.some(c => c.category === 'materializer' && c.state !== 'satisfied')) fail('BUILD_PROFILE_INVALID', 8, 'Profile cannot be saved with invalid rules or unsupported compiled choices.', result.report);
        if (!head && new Set(this.entries('build-profile').map(([, r]) => r.data.id)).size >= BUILD_LIMITS.profiles) fail('BUILD_PROFILE_LIMIT', 5, 'Repository logical profile capacity is full.');
        const previous = head ? this.pin(head, 'build-profile') : null;
        const record: BuildProfileRecord = { ...input.record, format: 'strata-build-profile/1', project_id: this.scope.project_id, repository_id: this.scope.repository_id,
          previous, derived_from: previous, author: this.context.principal_id, auth_receipt: this.authenticate(command, input) };
        const ref = buildRecordRef('build-profile', record); this.engine.store(ref, 'build-profile', record); return { ref, sha256: digest(record), record, report: result.report };
      }
      case 'profile.inspect': {
        const pin = this.pin(input.ref, 'build-profile'), record = this.engine.read(input.ref, 'build-profile');
        const context = this.dispatch('repository.compatibility', {}).context;
        return { ...pin, record, archived: this.archived(record.id), report: context ? resolveBuildProfile(context, profileInput(record)).report : null };
      }
      case 'profile.list': {
        if (input.contract_ref) this.pin(input.contract_ref, 'repository-compatibility');
        const refs = this.entries('build-profile').filter(([ref, r]) => !this.archived(r.data.id) && (!input.contract_ref || r.data.contract_ref === input.contract_ref) && this.head('build-profile', r.data.id) === ref).map(([ref]) => ref).sort();
        const visible = refs.filter(ref => { try { this.visible(ref); return true; } catch { return false; } });
        if (input.cursor && !visible.includes(input.cursor)) fail('INVALID_CURSOR', 2, 'List cursor is not in the current visible profile selection.');
        const offset = input.cursor ? visible.indexOf(input.cursor) + 1 : 0, page = visible.slice(offset, offset + (input.limit ?? BUILD_LIMITS.page));
        return { profiles: page.map(ref => this.dispatch('profile.inspect', { ref })), cursor: offset + page.length < visible.length ? page.at(-1) : null };
      }
      case 'profile.archive': {
        const p = this.dispatch('profile.inspect', input);
        if (this.head('build-profile', p.record.id) !== input.ref || this.archived(p.record.id)) fail('STALE_REVISION', 5, 'Archive requires an unarchived exact profile head.');
        const record = { format: 'strata-build-profile-archive/1', project_id: this.scope.project_id, repository_id: this.scope.repository_id,
          profile: { ref: p.ref, sha256: p.sha256 }, author: this.context.principal_id, auth_receipt: this.authenticate(command, input) };
        const ref = buildRecordRef('build-profile-archive', record); this.engine.store(ref, 'build-profile-archive', record); return { ref, sha256: digest(record), record };
      }
      default: fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown profile repository operation.');
    }
  }
}
