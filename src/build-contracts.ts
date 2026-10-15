import { z } from 'zod';
import { canonical, digest, fail, parse, set } from './model.js';

// Supporting formats only: none extend a semantic snapshot or activate persistence.
export const BUILD_LIMITS = Object.freeze({ contract_bytes: 65536, rules: 128, profiles: 128, revisions: 64, page: 100, name: 80 });
export const BUILD_DESTINATION_KINDS = ['local', 'cloudflare-worker'] as const;
export type BuildDestinationKind = typeof BUILD_DESTINATION_KINDS[number];
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/);
const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const value = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const rationale = z.string().min(1).max(4096);
export const buildFieldSchema = z.enum(['language', 'framework', 'runtime']);
export const buildPinSchema = z.object({ ref, sha256: hash }).strict();
export const repositoryContractInputSchema = z.object({
  format: z.literal('strata-repository-compatibility/1'), id, revision: z.number().int().positive(),
  rules: z.array(z.object({ id, field: buildFieldSchema, allowed: z.array(value).min(1).max(128), rationale }).strict()).max(BUILD_LIMITS.rules),
  preferences: z.array(z.object({ field: buildFieldSchema, value, rationale }).strict()).max(128)
}).strict();
export const buildChoicesSchema = z.object({ language: value, framework: value, runtime: value }).strict();
export const buildProfileInputSchema = z.object({
  id, revision: z.number().int().positive().max(BUILD_LIMITS.revisions), name: z.string().min(1).max(BUILD_LIMITS.name),
  contract_ref: ref, contract_sha256: hash, choices: buildChoicesSchema,
  materializer: z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+\/[1-9][0-9]*$/).max(128), archive_sha256: hash }).strict()
}).strict();
// These fields are server-resolved on admission. Parsing them proves shape, never authority.
const context = { project_id: id, repository_id: id, previous: buildPinSchema.nullable(), author: id, auth_receipt: buildPinSchema };
export const repositoryContractRecordSchema = repositoryContractInputSchema.extend({ ...context, review: buildPinSchema }).strict();
export const buildProfileRecordSchema = buildProfileInputSchema.extend({ format: z.literal('strata-build-profile/1'), ...context, derived_from: buildPinSchema.nullable() }).strict();
export const releaseBuildBindingSchema = z.object({
  format: z.literal('strata-release-build-binding/1'), project_id: id, repository_id: id,
  release: buildPinSchema, contract: buildPinSchema, provenance: z.literal('post_publication_adoption'),
  author: id, auth_receipt: buildPinSchema, review: buildPinSchema
}).strict();
export const buildSelectionSchema = z.object({ release_ref: ref, profile_ref: ref, destination: z.object({ kind: z.literal('local'), slot_id: id }).strict() }).strict();
export const buildStartInputSchema = z.object({ selection: buildSelectionSchema, expected_plan_sha256: hash }).strict();
export const environmentRequirementSchema = z.object({
  stage: z.enum(['build', 'verify', 'run']), subject: z.enum(['host', 'target']),
  kind: z.enum(['os', 'architecture', 'runtime', 'toolchain', 'system-feature']), id,
  version: z.union([z.object({ min_major: z.number().int().positive() }).strict(), z.object({ exact: z.string().min(1).max(128) }).strict()]).nullable(),
  allowed_values: z.array(z.string().min(1).max(128)).max(128).nullable(), source_ref: z.string().min(1).max(512)
}).strict();
export const compatibilitySourceSchema = z.object({
  kind: z.enum(['repository_rule', 'semantic_item', 'compiled_derivation', 'materializer', 'destination', 'operational_policy']),
  ref, sha256: hash, item: z.string().min(1).max(512).nullable(), rule_version: z.string().min(1).max(128).nullable()
}).strict();
export const compatibilityCheckSchema = z.object({
  id: z.string().min(1).max(256), category: z.enum(['schema', 'repository', 'semantic', 'materializer', 'destination', 'authority', 'environment']),
  state: z.enum(['satisfied', 'invalid', 'unsupported', 'unavailable']), code: z.string().min(1).max(128), message: z.string(),
  field: z.string().nullable(), sources: z.array(compatibilitySourceSchema)
}).strict();
export const compatibilityReportSchema = z.object({
  format: z.literal('strata-build-compatibility-report/1'), repository_id: id, contract_ref: ref, contract_sha256: hash,
  target_ref: ref.nullable(), target_sha256: hash.nullable(), normalized_profile: buildProfileInputSchema.nullable(), normalized_sha256: hash.nullable(),
  checks: z.array(compatibilityCheckSchema), repository_valid: z.boolean(), materialization_supported: z.boolean().nullable(), runnable_here: z.boolean().nullable()
}).strict();
export type BuildField = z.infer<typeof buildFieldSchema>;
export type BuildPin = z.infer<typeof buildPinSchema>;
export type RepositoryContractInput = z.infer<typeof repositoryContractInputSchema>;
export type RepositoryContractRecord = z.infer<typeof repositoryContractRecordSchema>;
export type BuildChoices = z.infer<typeof buildChoicesSchema>;
export type BuildProfileInput = z.infer<typeof buildProfileInputSchema>;
export type BuildProfileRecord = z.infer<typeof buildProfileRecordSchema>;
export type ReleaseBuildBinding = z.infer<typeof releaseBuildBindingSchema>;
export type BuildSelection = z.infer<typeof buildSelectionSchema>;
export type BuildStartInput = z.infer<typeof buildStartInputSchema>;
export type EnvironmentRequirement = z.infer<typeof environmentRequirementSchema>;
export type CompatibilityReport = z.infer<typeof compatibilityReportSchema>;
export type CompatibilityCheck = z.infer<typeof compatibilityCheckSchema>;
export type CompatibilitySource = z.infer<typeof compatibilitySourceSchema>;

export function normalizeRepositoryContract(input: unknown): RepositoryContractInput {
  if (Buffer.byteLength(canonical(input), 'utf8') > BUILD_LIMITS.contract_bytes) fail('BUILD_CONTRACT_LIMIT', 2, 'Compatibility contract exceeds 64 KiB.');
  const record = parse(repositoryContractInputSchema, input);
  if (new Set(record.rules.map(r => r.id)).size !== record.rules.length) fail('INVALID_RECORD', 2, 'Compatibility rule IDs must be unique.');
  // Only allowed is a declared set. Rule/preference order and human text are preserved.
  record.rules = record.rules.map(r => ({ ...r, allowed: set(r.allowed) }));
  return record;
}
export function normalizeBuildProfile(input: unknown): BuildProfileInput { return parse(buildProfileInputSchema, input); }
export function buildSupportingRef(record: RepositoryContractRecord | BuildProfileRecord | ReleaseBuildBinding): string {
  const type = record.format === 'strata-repository-compatibility/1' ? 'repository-compatibility'
    : record.format === 'strata-build-profile/1' ? 'build-profile' : 'release-build-binding';
  return type + '@' + digest(record);
}
export const BUILD_SCHEMAS = {
  'repository-contract-input': repositoryContractInputSchema, 'repository-compatibility': repositoryContractRecordSchema,
  'build-profile-input': buildProfileInputSchema, 'build-profile': buildProfileRecordSchema, 'release-build-binding': releaseBuildBindingSchema,
  'build-selection': buildSelectionSchema, 'build-start-input': buildStartInputSchema, 'build-compatibility-report': compatibilityReportSchema,
  'build-environment-requirement': environmentRequirementSchema
};
