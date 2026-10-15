import type { Engine } from './core.js';
import { canonical, digest, fail, StrataError } from './model.js';
import { profileFor } from './profiles.js';
import { inspectProfileSupport, type ProfileSupportReport } from './profile-capabilities.js';
import { describeBuildOptions, type BuildOptions } from './build-options.js';
import {
  buildSupportingRef, normalizeBuildProfile, normalizeRepositoryContract, repositoryContractRecordSchema,
  type BuildChoices, type BuildPin, type BuildProfileRecord, type CompatibilityCheck, type CompatibilityReport, type CompatibilitySource, type ReleaseBuildBinding, type RepositoryContractRecord
} from './build-contracts.js';

export type ContractContext = { project_id: string; repository_id: string; contract: BuildPin & { record: RepositoryContractRecord } };
export type CompatibilityLookup =
  | { contract_binding: 'missing'; context: null; binding: null }
  | { contract_binding: 'profile_authoring_head'; context: ContractContext; binding: null }
  | { contract_binding: 'post_publication_adoption'; context: ContractContext; binding: BuildPin & { record: ReleaseBuildBinding } };
/** S1 supplies these repository-scoped lookups; S2 consumes them. No storage here. */
export interface BuildRepositoryLookup {
  compatibility(release_ref?: string): Promise<CompatibilityLookup>;
  profile(ref: string): Promise<BuildPin & { record: BuildProfileRecord }>;
}
function checkedContract(context: ContractContext) {
  const parsed = repositoryContractRecordSchema.safeParse(context.contract.record);
  if (!parsed.success) fail('UNSUPPORTED_BUILD_CONTRACT', 8, 'The selected hard contract has an unknown format, field or rule grammar.', { ref: context.contract.ref, sha256: context.contract.sha256, issues: parsed.error.issues });
  const record = parsed.data;
  if (record.project_id !== context.project_id || record.repository_id !== context.repository_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Contract belongs to another repository or project.');
  if (digest(record) !== context.contract.sha256 || buildSupportingRef(record) !== context.contract.ref) fail('BUILD_CONTRACT_PIN_MISMATCH', 6, 'Contract bytes do not match the exact selected ref and digest.');
  const { project_id, repository_id, previous, author, auth_receipt, review, ...input } = record;
  if (canonical(normalizeRepositoryContract(input)) !== canonical(input)) fail('INVALID_RECORD', 2, 'Admitted compatibility rules must be normalized.');
  return record;
}
/** Independent hard errors, combined by intersection. Preferences never widen rules. */
export function checkRepositoryChoices(context: ContractContext, choices: BuildChoices): CompatibilityCheck[] {
  const contract = checkedContract(context);
  const source = (rule: string): CompatibilitySource => ({ kind: 'repository_rule', ref: context.contract.ref, sha256: context.contract.sha256, item: rule, rule_version: contract.format });
  const checks: CompatibilityCheck[] = [];
  for (const field of ['language', 'framework', 'runtime'] as const) {
    const rules = contract.rules.filter(r => r.field === field);
    const intersection = rules.reduce<string[] | null>((domain, r) => domain === null ? [...r.allowed] : domain.filter(v => r.allowed.includes(v)), null);
    if (intersection?.length === 0) checks.push({ id: 'repository.intersection.' + field, category: 'repository', state: 'invalid', code: 'BUILD_RULE_CONFLICT', message: 'Hard repository rules have no common value.', field, sources: rules.map(r => source(r.id)) });
    for (const r of rules) checks.push({ id: 'repository.rule.' + r.id, category: 'repository', state: r.allowed.includes(choices[field]) ? 'satisfied' : 'invalid', code: r.allowed.includes(choices[field]) ? 'BUILD_RULE_SATISFIED' : 'BUILD_CHOICE_FORBIDDEN', message: r.rationale, field, sources: [source(r.id)] });
  }
  return checks;
}
/** Future Engine bound-Release guard reuses this function after S1 admits bindings. */
export function assertRepositoryChoices(context: ContractContext, choices: BuildChoices): void {
  const failures = checkRepositoryChoices(context, choices).filter(c => c.state !== 'satisfied');
  if (failures.length) fail(failures[0].code, 8, 'Materializer choices violate the exact repository contract.', failures);
}
export type ResolveBuildProfileResult = { report: CompatibilityReport; options: BuildOptions | null; support: ProfileSupportReport | null };
/** Read/compute only. Service supplies authenticated repository context, never client IDs. */
export function resolveBuildProfile(context: ContractContext, input: unknown, target?: { engine: Engine; ref: string }): ResolveBuildProfileResult {
  const report: CompatibilityReport = {
    format: 'strata-build-compatibility-report/1', repository_id: context.repository_id,
    contract_ref: context.contract.ref, contract_sha256: context.contract.sha256,
    target_ref: target?.ref ?? null, target_sha256: null, normalized_profile: null, normalized_sha256: null,
    checks: [], repository_valid: false, materialization_supported: null, runnable_here: null
  };
  const check = (id: string, category: CompatibilityCheck['category'], state: CompatibilityCheck['state'], code: string, message: string, field: string | null = null, sources: CompatibilitySource[] = []) => report.checks.push({ id, category, state, code, message, field, sources });
  try { checkedContract(context); }
  catch (e) {
    if (!(e instanceof StrataError) || e.code !== 'UNSUPPORTED_BUILD_CONTRACT') throw e;
    check('repository.schema', 'repository', 'unsupported', e.code, e.message, null,
      [{ kind: 'repository_rule', ref: context.contract.ref, sha256: context.contract.sha256, item: null, rule_version: null }]);
    return { report, options: null, support: null };
  }
  let profile;
  try { profile = normalizeBuildProfile(input); }
  catch (e) { if (!(e instanceof StrataError)) throw e; check('schema.profile', 'schema', 'invalid', e.code, e.message); return { report, options: null, support: null }; }
  report.normalized_profile = profile; report.normalized_sha256 = digest(profile);
  check('schema.profile', 'schema', 'satisfied', 'BUILD_PROFILE_SCHEMA_VALID', 'Build profile matches the bounded V1 schema.');
  if (profile.contract_ref !== context.contract.ref || profile.contract_sha256 !== context.contract.sha256) check('repository.contract', 'repository', 'invalid', 'BUILD_CONTRACT_PIN_MISMATCH', 'Profile must adopt this exact contract revision.', 'contract_ref');
  else report.checks.push(...checkRepositoryChoices(context, profile.choices));
  report.repository_valid = !report.checks.some(c => (c.category === 'schema' || c.category === 'repository') && c.state !== 'satisfied');
  let options: BuildOptions;
  try { options = describeBuildOptions(profileFor(profile.materializer.id)); }
  catch (e) { if (!(e instanceof StrataError)) throw e; check('materializer.options', 'materializer', 'unsupported', e.code, e.message, 'materializer'); return { report, options: null, support: null }; }
  const materializerSource: CompatibilitySource = { kind: 'materializer', ref: 'collection-host@1', sha256: options.archive_sha256, item: null, rule_version: options.format };
  if (profile.materializer.archive_sha256 !== options.archive_sha256) check('materializer.archive', 'materializer', 'unsupported', 'BUILD_MATERIALIZER_PIN_MISMATCH', 'The requested historical archive is not the registered adapter archive.', 'materializer.archive_sha256', [materializerSource]);
  else check('materializer.archive', 'materializer', 'satisfied', 'BUILD_MATERIALIZER_PIN_VALID', 'Exact compiled archive is available.', null, [materializerSource]);
  if (canonical(profile.choices) !== canonical(options.choices)) check('materializer.choices', 'materializer', 'unsupported', 'BUILD_CHOICES_UNSUPPORTED', 'This materializer supports only javascript / none / node.', 'choices', [materializerSource]);
  else check('materializer.choices', 'materializer', 'satisfied', 'BUILD_CHOICES_SUPPORTED', 'Requested choices describe the actual fixed output.', null, [materializerSource]);
  let support: ProfileSupportReport | null = null;
  if (target) {
    if (target.engine.options.projectId !== context.project_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Support engine belongs to another authenticated project.');
    const record = target.engine.read(target.ref);
    report.target_sha256 = digest(record);
    if (!report.checks.some(c => c.category === 'materializer' && c.state !== 'satisfied')) {
      // Reuses the actual authoritative realization probe, preserving its first StrataError.
      support = inspectProfileSupport(profileFor(profile.materializer.id), () => target.engine.realize(target.ref, profile.materializer.id));
      report.materialization_supported = support.materialization.supported;
      const blocker = support.materialization.supported ? null : support.materialization.first_blocker;
      check('semantic.realize', 'semantic', blocker ? 'unsupported' : 'satisfied', blocker?.code ?? 'BUILD_MATERIALIZATION_SUPPORTED', blocker?.message ?? 'Exact target passes the authoritative materializer.', null,
        [{ kind: 'compiled_derivation', ref: target.ref, sha256: report.target_sha256, item: null, rule_version: options.format }, materializerSource]);
    } else report.materialization_supported = false;
  }
  return { report, options, support };
}
