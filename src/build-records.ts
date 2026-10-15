import { z } from 'zod';
import { canonical, digest, fail, parse, type Records } from './model.js';
import { BUILD_LIMITS, buildPinSchema, repositoryContractRecordSchema, buildProfileRecordSchema, releaseBuildBindingSchema, normalizeRepositoryContract, normalizeBuildProfile, type BuildPin } from './build-contracts.js';
import { resolveBuildProfile, type ContractContext } from './build-compatibility.js';
import { inspectReleasePublication } from './build-publication.js';

export const PROFILE_READS = ['repository.compatibility', 'profile.list', 'profile.inspect', 'profile.validate'] as const;
export const PROFILE_MUTATIONS = ['repository.contract.import', 'repository.contract.attach', 'profile.create', 'profile.revise', 'profile.archive'] as const;
export const PROFILE_OPERATIONS = [...PROFILE_READS, ...PROFILE_MUTATIONS] as const;
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Separate supporting authentication, including truthful synthetic fixture provenance.
// These receipts are historical evidence, never live credentials or grants.
export const buildRepositoryAuthSchema = z.object({
  format: z.literal('strata-build-repository-auth/1'), project_id: id, repository_id: id,
  principal_id: id, principal_kind: z.enum(['fixture', 'person', 'agent']),
  account_id: id.nullable(), credential_epoch: z.number().int().positive().nullable(),
  action: z.enum(PROFILE_OPERATIONS), input_sha256: hash, request_sha256: hash,
  policy_generation: z.string().min(1).max(256), grant_id: id, expires_at: z.string().datetime().nullable(),
  trust: z.enum(['local-fixture', 'host-authenticated'])
}).strict();
export const buildContractReviewSchema = z.object({
  format: z.literal('strata-build-contract-review/1'), project_id: id, repository_id: id,
  action: z.enum(['repository.contract.import', 'repository.contract.attach']), subject_sha256: hash,
  reviewer: id, authority: buildPinSchema, auth_receipt: buildPinSchema, accepted: z.literal(true)
}).strict();
export const buildProfileArchiveSchema = z.object({
  format: z.literal('strata-build-profile-archive/1'), project_id: id, repository_id: id,
  profile: buildPinSchema, author: id, auth_receipt: buildPinSchema
}).strict();
export const BUILD_RECORD_SCHEMAS = {
  'repository-compatibility': repositoryContractRecordSchema, 'build-profile': buildProfileRecordSchema,
  'release-build-binding': releaseBuildBindingSchema, 'build-repository-auth': buildRepositoryAuthSchema,
  'build-contract-review': buildContractReviewSchema, 'build-profile-archive': buildProfileArchiveSchema
};
export type BuildContractReview = z.infer<typeof buildContractReviewSchema>;
export function buildRecordType(type: string): type is keyof typeof BUILD_RECORD_SCHEMAS { return Object.hasOwn(BUILD_RECORD_SCHEMAS, type); }
export function buildRecordRef(type: string, data: unknown) { return type + '@' + digest(data); }
export function buildRecordReferences(type: string, d: any): BuildPin[] {
  switch (type) {
    case 'repository-compatibility': return [d.previous, d.auth_receipt, d.review].filter(Boolean);
    case 'build-profile': return [{ ref: d.contract_ref, sha256: d.contract_sha256 }, d.previous, d.derived_from, d.auth_receipt].filter(Boolean);
    case 'release-build-binding': return [d.release, d.contract, d.auth_receipt, d.review];
    case 'build-contract-review': return [d.authority, d.auth_receipt];
    case 'build-profile-archive': return [d.profile, d.auth_receipt];
    default: return [];
  }
}
export function exactBuildRecord(records: Records, pin: BuildPin, type?: string) {
  parse(buildPinSchema, pin);
  const r = records[pin.ref];
  if (!r?.published || type && r.type !== type || digest(r.data) !== pin.sha256) fail('BUILD_PIN_MISMATCH', 6, 'Supporting record has a missing or inconsistent exact pin.');
  if (buildRecordType(r.type) && pin.ref !== buildRecordRef(r.type, r.data)) fail('BUILD_PIN_MISMATCH', 6, 'Supporting reference differs from its full digest.');
  return r.data;
}
export function contractContext(records: Records, project: string, repository: string, pin: BuildPin): ContractContext {
  const record = parse(repositoryContractRecordSchema, exactBuildRecord(records, pin, 'repository-compatibility'));
  if (record.project_id !== project || record.repository_id !== repository) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Exact contract belongs to another repository.');
  return { project_id: project, repository_id: repository, contract: { ...pin, record } };
}
export function contractInput(d: any) { const { project_id, repository_id, previous, author, auth_receipt, review, ...input } = d; return normalizeRepositoryContract(input); }
export function profileInput(d: any) { const { format, project_id, repository_id, previous, author, auth_receipt, derived_from, ...input } = d; return normalizeBuildProfile(input); }

/** Admission and inactive recovery share this exact closure check. No live authority is invented. */
export function verifyBuildHistory(records: Records, project: string): void {
  const histories = new Map<string, Array<{ ref: string; d: any }>>(), bindings = new Set<string>(), archives = new Set<string>();
  const auth = (d: any, pin: BuildPin, actor: string, action: string, input?: unknown) => {
    const a = parse(buildRepositoryAuthSchema, exactBuildRecord(records, pin, 'build-repository-auth'));
    if (a.project_id !== d.project_id || a.repository_id !== d.repository_id || a.principal_id !== actor || a.action !== action || input !== undefined && a.input_sha256 !== digest(input)
      || a.request_sha256 !== digest({ command: a.action, input_sha256: a.input_sha256, principal: actor, repository: d.repository_id, policy: a.policy_generation }))
      fail('BUILD_AUTH_CLOSURE_INVALID', 6, 'Supporting authentication does not bind the exact action, actor and input.');
    return a;
  };
  for (const [ref, stored] of Object.entries(records)) {
    if (!buildRecordType(stored.type)) continue;
    const d: any = parse(BUILD_RECORD_SCHEMAS[stored.type] as z.ZodType<any>, stored.data);
    if (!stored.published || d.project_id !== project || ref !== buildRecordRef(stored.type, d)) fail('BUILD_HISTORY_INVALID', 6, 'Supporting identity or project differs from its admitted history.');
    for (const pin of buildRecordReferences(stored.type, d)) exactBuildRecord(records, pin);
    if (stored.type === 'build-repository-auth') {
      if (d.trust === 'local-fixture' ? d.principal_kind !== 'fixture' || d.account_id !== null || d.credential_epoch !== null : d.principal_kind === 'fixture' || d.account_id === null || d.credential_epoch === null)
        fail('BUILD_AUTH_CLOSURE_INVALID', 6, 'Supporting authentication has inconsistent source trust.');
      if (d.request_sha256 !== digest({ command: d.action, input_sha256: d.input_sha256, principal: d.principal_id, repository: d.repository_id, policy: d.policy_generation })) fail('BUILD_AUTH_CLOSURE_INVALID', 6, 'Retained action request digest is inconsistent.');
      continue;
    }
    if (stored.type === 'build-contract-review') {
      const a = auth(d, d.auth_receipt, d.reviewer, d.action);
      if (a.input_sha256 !== d.subject_sha256) fail('BUILD_REVIEW_INVALID', 6, 'Review does not bind its authenticated exact subject.');
      const authority = exactBuildRecord(records, d.authority, 'release');
      if (!authority.authorities.release.includes(d.reviewer)) fail('BUILD_REVIEW_INVALID', 6, 'Review lacks its exact retained Release authority.');
      continue;
    }
    if (stored.type === 'build-profile-archive') {
      const p = exactBuildRecord(records, d.profile, 'build-profile');
      if (p.project_id !== d.project_id || p.repository_id !== d.repository_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Archive belongs to another repository.');
      auth(d, d.auth_receipt, d.author, 'profile.archive', { ref: d.profile.ref });
      const key = d.repository_id + ':' + p.id;
      if (archives.has(key)) fail('BUILD_HISTORY_INVALID', 6, 'Logical profile has competing archive records.');
      archives.add(key); continue;
    }
    if (stored.type === 'release-build-binding') {
      const release = exactBuildRecord(records, d.release, 'release');
      if (!release.validation) fail('BUILD_BOOTSTRAP_EXCLUDED', 6, 'Adoption requires a published Release.');
      contractContext(records, project, d.repository_id, d.contract);
      // One legacy Release has one adoption, including across competing repository labels.
      if (bindings.has(d.release.ref)) fail('BUILD_BINDING_CONFLICT', 5, 'Release has competing immutable adoption bindings.');
      bindings.add(d.release.ref);
      const input = { release_ref: d.release.ref, contract_ref: d.contract.ref, expected_release_sha256: d.release.sha256 };
      auth(d, d.auth_receipt, d.author, 'repository.contract.attach', input);
      checkReview(d, input, 'repository.contract.attach'); continue;
    }
    const input = stored.type === 'repository-compatibility' ? contractInput(d) : profileInput(d);
    if (canonical({ ...d, ...input }) !== canonical(d)) fail('BUILD_HISTORY_INVALID', 6, 'Supporting input is not normalized.');
    const key = stored.type + ':' + d.repository_id + ':' + d.id, list = histories.get(key) ?? [];
    list.push({ ref, d }); histories.set(key, list);
    if (d.previous) {
      const p = exactBuildRecord(records, d.previous, stored.type);
      if (p.project_id !== project || p.repository_id !== d.repository_id || p.id !== d.id || p.revision + 1 !== d.revision) fail('BUILD_HISTORY_INVALID', 6, 'Supporting predecessor crosses an identity or skips a revision.');
    } else if (d.revision !== 1) fail('BUILD_HISTORY_INVALID', 6, 'Supporting lineage must start at revision one.');
    if (stored.type === 'repository-compatibility') {
      const request = { record: input, previous: d.previous?.ref ?? null };
      auth(d, d.auth_receipt, d.author, 'repository.contract.import', request); checkReview(d, request, 'repository.contract.import');
    } else {
      const context = contractContext(records, project, d.repository_id, { ref: d.contract_ref, sha256: d.contract_sha256 });
      const result = resolveBuildProfile(context, input).report;
      if (!result.repository_valid || result.checks.some(c => c.category === 'materializer' && c.state !== 'satisfied')) fail('BUILD_PROFILE_INVALID', 6, 'Retained profile does not bind a valid contract and exact compiled choices.');
      if (canonical(d.derived_from) !== canonical(d.previous)) fail('BUILD_HISTORY_INVALID', 6, 'V1 profile lineage must retain its exact predecessor.');
      const request = { ...(d.previous ? { previous: d.previous.ref } : {}), record: input, expected_normalized_sha256: digest(input) };
      auth(d, d.auth_receipt, d.author, d.previous ? 'profile.revise' : 'profile.create', request);
    }
  }
  const contractIds = new Map<string, Set<string>>(), profileIds = new Map<string, Set<string>>();
  for (const [key, values] of histories) {
    values.sort((a, b) => a.d.revision - b.d.revision);
    if (values.some((v, i) => v.d.revision !== i + 1 || i > 0 && v.d.previous?.ref !== values[i - 1].ref)) fail('BUILD_HISTORY_INVALID', 6, 'Supporting history is incomplete or forked.');
    const d = values[0].d, map = key.startsWith('repository-compatibility:') ? contractIds : profileIds, ids = map.get(d.repository_id) ?? new Set<string>();
    ids.add(d.id); map.set(d.repository_id, ids);
    if (key.startsWith('build-profile:') && values.length > BUILD_LIMITS.revisions) fail('BUILD_PROFILE_LIMIT', 6, 'Profile revision capacity exceeded.');
    if (archives.has(d.repository_id + ':' + d.id) && key.startsWith('build-profile:')) {
      const archived = Object.values(records).find(r => r.type === 'build-profile-archive' && r.data.repository_id === d.repository_id && records[r.data.profile.ref]?.data.id === d.id)!;
      if (archived.data.profile.ref !== values.at(-1)!.ref) fail('BUILD_HISTORY_INVALID', 6, 'Archived logical profile has a later revision.');
    }
  }
  for (const ids of contractIds.values()) if (ids.size > 1) fail('BUILD_CONTRACT_LINEAGE_CONFLICT', 5, 'Repository has competing designated contract lineages.');
  for (const ids of profileIds.values()) if (ids.size > BUILD_LIMITS.profiles) fail('BUILD_PROFILE_LIMIT', 6, 'Profile capacity exceeded.');
  for (const ref of bindings) {
    // The projection selects only semantic publication closure, so it never
    // follows adoption records back into this supporting-history validator.
    const report = inspectReleasePublication({ project_id: project, records, source_trust: 'local-fixture' }, ref);
    if (!report.historically_approved) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Adoption lacks complete exact historical publication closure.');
  }

  function checkReview(d: any, input: unknown, action: string) {
    const review = parse(buildContractReviewSchema, exactBuildRecord(records, d.review, 'build-contract-review'));
    if (review.project_id !== project || review.repository_id !== d.repository_id || review.action !== action || review.subject_sha256 !== digest(input)) fail('BUILD_REVIEW_INVALID', 6, 'Retained review does not bind the exact imported contract or adoption.');
    auth(review, review.auth_receipt, review.reviewer, action, input);
    const expectedAuthority = action === 'repository.contract.attach' ? records[records[d.release.ref].data.baseline] : records[review.authority.ref];
    if (!expectedAuthority || digest(expectedAuthority.data) !== review.authority.sha256 || !expectedAuthority.data.authorities.release.includes(review.reviewer)) fail('BUILD_REVIEW_INVALID', 6, 'Adoption review does not bind original publication authority.');
  }
}
