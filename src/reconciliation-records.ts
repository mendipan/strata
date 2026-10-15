import { z } from 'zod';
import { MODEL, canonical, digest, bytesDigest, fail, parse } from './model.js';
import { sourceScopeSchema, sourceSnapshotSchema, gitObservationSchema, intentPinSchema, validateSourceScope } from './source-binding.js';

/** Independent of the frozen R1/R1-C record maps. Registration belongs to S4. */
export const RECONCILIATION_LIMITS = Object.freeze({ rawObject: 512 * 1024, objects: 8192,
  rawBytes: 16 * 1024 * 1024, endpointEntries: 5000, ancestryEdges: 256,
  recordBytes: 768 * 1024, closureRecords: 16384, closureBytes: 64 * 1024 * 1024,
  patchBytes: 256 * 1024, patchPaths: 64, patchImages: 512 * 1024 });
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(4096).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v));
const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256);
export const pinSchema = z.object({ ref, sha256: hashSchema }).strict();
export type Pin = z.infer<typeof pinSchema>;
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const timestamp = z.string().datetime(), attempt = z.string().uuid();
export function reconciliationPath(value: string): string {
  if (!value || value.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(value) || value.split('/').some(p =>
    !p || p === '.' || p === '..' || p.endsWith('.') || /^\.git(?:$|\.)/i.test(p) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    fail('RECONCILIATION_PATH', 2, 'Expected a bounded portable relative Git path.');
  return value;
}
const path = z.string().refine(v => { try { reconciliationPath(v); return true; } catch { return false; } });
export function orderedSet(values: string[], label: string, aliases = false): void {
  if (canonical(values) !== canonical([...values].sort()) || new Set(values.map(v => aliases ? v.toLowerCase() : v)).size !== values.length)
    fail('RECONCILIATION_SET', 2, `${label} must be sorted and unique.`);
  if (aliases) {
    const components = new Map<string, string>();
    for (const value of values) {
      const parts = value.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), prior = components.get(prefix.toLowerCase());
        if (prior && prior !== prefix) fail('RECONCILIATION_PATH', 2, `${label} contains aliased directory names.`);
        components.set(prefix.toLowerCase(), prefix);
      }
    }
    if (values.some((v, i) => values.some((w, j) => i !== j && w.toLowerCase().startsWith(v.toLowerCase() + '/'))))
      fail('RECONCILIATION_PATH', 2, `${label} contains file/directory collisions.`);
  }
}
function setSchema<T extends z.ZodType>(schema: T, key: (v: z.infer<T>) => string, max = 256, aliases = false) {
  return z.array(schema).max(max).superRefine((rows, ctx) => {
    try { orderedSet(rows.map(key), 'Declared set', aliases); }
    catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); }
  });
}
const strings = setSchema(text, v => v), pins = setSchema(pinSchema, v => v.ref);
const paths = setSchema(path, v => v, 256, true);
const common = { project_id: text, repo_id: text };
const mode = z.enum(['100644', '100755']);
const newModes = setSchema(z.object({ path, mode: z.literal('100644') }).strict(), v => v.path, 64, true);
export const checkerSchema = z.object({ id: text, version: text, sha256: hashSchema,
  fixture_sha256: hashSchema, oracle_sha256: hashSchema }).strict();
export const producerDescriptorSchema = z.object({ format: z.literal('reconciliation-producer-descriptor/1'), id: text, version: text,
  checker: checkerSchema, oracle: z.json(), assets: setSchema(z.object({ role: text, media_type: z.enum(['text/javascript', 'application/json', 'text/plain']),
    byte_length: z.number().int().nonnegative().max(RECONCILIATION_LIMITS.rawObject), sha256: hashSchema,
    bytes_base64: z.string().max(Math.ceil(RECONCILIATION_LIMITS.rawObject / 3) * 4) }).strict(), v => v.role, 64),
  bounds: z.object({ milliseconds: z.literal(5000), old_generation_mib: z.literal(64), young_generation_mib: z.literal(16), ipc_bytes: z.literal(262144) }).strict()
}).strict();
export const targetSchema = intentPinSchema.extend({ candidate_fingerprint: hashSchema }).strict();
const criterion = z.object({ criterion_ref: text, statement: text, subjects: strings.min(1),
  check: text, version: text, fixture: text, method: z.enum(['mechanical', 'review']) }).strict();
const criteria = setSchema(criterion, v => v.criterion_ref);
const roles = setSchema(z.string().regex(/^(?:release|source:[A-Za-z0-9_.-]+|scope:[A-Za-z0-9_.-]+|guardian:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/), v => v);
const entry = z.discriminatedUnion('presence', [
  z.object({ path, presence: z.literal('absent'), mode: z.null(), byte_length: z.null(), sha256: z.null(), blob: z.null() }).strict(),
  z.object({ path, presence: z.literal('present'), mode, byte_length: z.number().int().nonnegative().max(RECONCILIATION_LIMITS.rawObject), sha256: hashSchema, blob: pinSchema }).strict(),
]);
export const proofEntrySchema = entry;
const entries = setSchema(entry, v => v.path, 256, true);
const operation = z.object({ path, before: entry, after: entry }).strict().refine(v => v.path === v.before.path && v.path === v.after.path);
const operations = setSchema(operation, v => v.path, 64, true);
export const gitObjectSchema = z.object({ format: z.literal('reconciliation-git-object/1'),
  object_format: z.enum(['sha1', 'sha256']), kind: z.enum(['commit', 'tree', 'blob']), oid,
  byte_length: z.number().int().nonnegative().max(RECONCILIATION_LIMITS.rawObject), raw_sha256: hashSchema,
  bytes_base64: z.string().max(Math.ceil(RECONCILIATION_LIMITS.rawObject / 3) * 4) }).strict();
export type GitObject = z.infer<typeof gitObjectSchema>;
export const plannedProofSchema = z.object({ format: z.literal('reconciliation-source-proof/1'), phase: z.literal('planned'),
  ...common, object_format: z.enum(['sha1', 'sha256']), predecessor: pinSchema, report: pinSchema, bound_source: pinSchema,
  action: z.enum(['accept_code', 'restore_intent', 'update_intent']), scope: sourceScopeSchema,
  association_paths: paths, restore_paths: paths, new_file_modes: newModes,
  observation: gitObservationSchema, observation_sha256: hashSchema,
  base_commit_oid: oid, observed_head_oid: oid, ancestry_oids: z.array(oid).min(1).max(257),
  trees: z.object({ bound: oid, head: oid, observed: oid, desired: oid }).strict(),
  objects: setSchema(pinSchema, v => v.ref, RECONCILIATION_LIMITS.objects),
  selected: z.object({ bound: entries, observed: entries, desired: entries }).strict(),
  patch: z.string().max(RECONCILIATION_LIMITS.patchBytes).nullable(), patch_sha256: hashSchema.nullable(), operations,
}).strict();
export type PlannedProof = z.infer<typeof plannedProofSchema>;
export const committedProofSchema = z.object({ format: z.literal('reconciliation-source-proof/1'), phase: z.literal('committed'),
  ...common, object_format: z.enum(['sha1', 'sha256']), prepared: pinSchema, plan: pinSchema, source_snapshot: pinSchema,
  observation: gitObservationSchema, observation_sha256: hashSchema, owner_commit_oid: oid, tree_oid: oid,
  transition: z.enum(['same-reviewed-clean-head', 'direct-child']),
  additional_objects: setSchema(pinSchema, v => v.ref, RECONCILIATION_LIMITS.objects) }).strict();
export type CommittedProof = z.infer<typeof committedProofSchema>;
export const sourceProofSchema = z.discriminatedUnion('phase', [plannedProofSchema, committedProofSchema]);
const scopeDerivation = z.object({ source_scope: text, target_scope: text,
  target_case: z.enum(['normative-impact', 'evaluated-composition', 'source-association']), changed_target: z.boolean(),
  normative_delta: z.boolean(), guardians: strings }).strict();
const semanticEdge = z.object({ type: z.enum(['release', 'composition', 'layer', 'resolution', 'realization', 'validation', 'approval']), pin: pinSchema }).strict();
const bridge = z.object({ predecessor: pinSchema, old_intent: intentPinSchema, target: targetSchema,
  target_release_trust: z.literal('local-fixture'), predecessor_validation: z.enum(['validated', 'accepted-unvalidated-bootstrap']),
  target_validation: z.literal('validated'), semantic_records: setSchema(semanticEdge, v => v.pin.ref, RECONCILIATION_LIMITS.closureRecords) }).strict();
const evidencePolicy = z.literal('fresh-same-contract-and-source');
export const successorTemplateSchema = z.object({ predecessor: pinSchema, target: targetSchema, scope: sourceScopeSchema,
  desired_tree_oid: oid, desired_manifest_sha256: hashSchema, limitations: strings,
  allowed_transition: z.literal('reviewed-clean-head-or-single-child'), evidence_policy: evidencePolicy, required_roles: roles }).strict();
export const planBodySchema = z.object({ format: z.literal('reconciliation-plan-body/2'), ...common,
  action: z.enum(['accept_code', 'restore_intent', 'update_intent']), report: pinSchema, predecessor: pinSchema,
  old_intent: intentPinSchema, target: targetSchema, layer_refs: setSchema(ref, v => v), historical_bridge: bridge,
  observation: gitObservationSchema, observation_sha256: hashSchema, source_proof: pinSchema,
  observed_tree_oid: oid, desired_tree_oid: oid, desired_entries: entries, binding_delta_paths: paths,
  patch: z.string().max(RECONCILIATION_LIMITS.patchBytes).nullable(), patch_sha256: hashSchema.nullable(), operations,
  association_paths: paths, restore_paths: paths, new_file_modes: newModes, old_scope: sourceScopeSchema, scope: sourceScopeSchema,
  scopes: scopeDerivation, criteria, checker: checkerSchema, producer_id: text, producer_descriptor: pinSchema,
  oracle: z.json(), contract_sha256: hashSchema, required_roles: roles, successor_template: successorTemplateSchema,
  rationale: text }).strict();
export type PlanBody = z.infer<typeof planBodySchema>;
export const planSchema = z.object({ format: z.literal('reconciliation-proposal/2'), body: planBodySchema,
  body_sha256: hashSchema, author: text, auth: pinSchema, state: z.literal('proposed') }).strict();
export type Plan = z.infer<typeof planSchema>;
const assertion = z.object({ criterion_ref: text, accepted: z.literal(true), rationale: text }).strict();
const assertions = setSchema(assertion, v => v.criterion_ref);
const roleInput = z.union([z.enum(['source', 'scope', 'release']), z.object({ guardian: text }).strict()]);
export const prepareRequestSchema = z.object({ report: pinSchema, action: z.enum(['accept_code', 'restore_intent', 'update_intent']),
  target_release: pinSchema, layer_refs: setSchema(ref, v => v), rationale: text, patch: z.string().nullable(),
  checker: checkerSchema, producer_id: text, oracle: z.json(), new_file_modes: newModes }).strict().superRefine((v, ctx) => {
    if ((v.action === 'restore_intent') !== (v.patch !== null) || (v.action === 'restore_intent' && v.layer_refs.length))
      ctx.addIssue({ code: 'custom', message: 'Only restore_intent supplies a patch; restoration cannot select Layers.' });
    if (v.patch !== null && (!v.patch || Buffer.byteLength(v.patch) > RECONCILIATION_LIMITS.patchBytes || /[\r\0]/.test(v.patch)))
      ctx.addIssue({ code: 'custom', message: 'Supply one bounded LF patch.' });
  });
export const checkRequestSchema = z.object({ plan: pinSchema, criterion_reviews: assertions }).strict();
export const approveRequestSchema = z.object({ plan: pinSchema, evidence: pinSchema, expected_subject_sha256: hashSchema,
  roles: setSchema(roleInput, v => typeof v === 'string' ? v : 'guardian:' + v.guardian).min(1), accepted: z.literal(true), rationale: text }).strict();
export const completeRequestSchema = z.object({ plan: pinSchema, evidence: pinSchema, approvals: pins.min(1), owner_commit: oid }).strict();
export const actionInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('drift.reconcile.prepare'), request: prepareRequestSchema, layer_pins: pins, plan_body_sha256: hashSchema }).strict(),
  z.object({ action: z.literal('drift.reconcile.check'), request: checkRequestSchema, plan_body_sha256: hashSchema }).strict(),
  z.object({ action: z.literal('drift.reconcile.approve'), request: approveRequestSchema, subject_sha256: hashSchema, roles }).strict(),
  z.object({ action: z.literal('drift.reconcile.complete'), request: completeRequestSchema, plan_body_sha256: hashSchema }).strict(),
  z.object({ action: z.literal('reconciliation.run'), plan: pinSchema, phase: z.enum(['planned-source', 'committed-source']),
    contract_sha256: hashSchema, source_proof: pinSchema, measured_input_sha256: hashSchema, producer_descriptor: pinSchema }).strict(),
  z.object({ action: z.literal('reconciliation.criterion-review'), plan: pinSchema, assertions }).strict(),
  z.object({ action: z.literal('reconciliation.role-approval'), plan: pinSchema, evidence: pinSchema, subject_sha256: hashSchema, roles }).strict(),
]);
export const authoritySchema = z.object({ account_id: text, principal_id: text, principal_kind: z.enum(['person', 'agent']),
  credential_epoch: z.number().int().positive(), account_generation: z.number().int().positive(), accounts_sha256: hashSchema,
  policy_generation: z.number().int().positive(), policy_sha256: hashSchema, grant_id: text, grant_scope_sha256: hashSchema,
  repository_configuration_sha256: hashSchema, producer_configuration_sha256: hashSchema, grant_expires_at: timestamp }).strict();
export const authSchema = z.object({ format: z.literal('reconciliation-auth/1'), model_version: z.literal(MODEL), ...common,
  attempt_id: attempt, request_sha256: hashSchema, action_input: actionInputSchema, action_input_sha256: hashSchema,
  authority: authoritySchema, issued_at: timestamp, session: z.object({ id_sha256: hashSchema, issued_at: timestamp,
    expires_at: timestamp, parent_id_sha256: hashSchema.nullable() }).strict(),
  action_started_at: timestamp, action_finished_at: timestamp, endorsement_valid_until: timestamp.nullable() }).strict();
export const runSchema = z.object({ format: z.literal('reconciliation-run/1'), ...common, phase: z.enum(['planned-source', 'committed-source']),
  attempt_id: attempt, plan: pinSchema, contract_sha256: hashSchema, target: targetSchema, source_content_sha256: hashSchema,
  producer_id: text, producer_descriptor: pinSchema, measured_input_sha256: hashSchema, source_proof: pinSchema,
  results: setSchema(z.object({ criterion_ref: text, check: text, version: text, fixture: text,
    method: z.literal('mechanical'), passed: z.boolean() }).strict(), v => v.criterion_ref), observations: z.json(),
  started_at: timestamp, finished_at: timestamp, auth: pinSchema,
  final_source: z.object({ owner_commit_oid: oid, source_snapshot: pinSchema, observation_sha256: hashSchema }).strict().nullable(),
}).strict().refine(v => (v.phase === 'committed-source') === (v.final_source !== null));
export const criterionReviewSchema = z.object({ format: z.literal('reconciliation-criterion-review/1'), ...common,
  plan: pinSchema, desired_tree_oid: oid, target: targetSchema, criteria_sha256: hashSchema, assertions,
  actor: text, auth: pinSchema, valid_until: timestamp }).strict();
export const evidenceSchema = z.object({ format: z.literal('reconciliation-evidence/1'), ...common, plan: pinSchema,
  planned_run: pinSchema, criterion_review: pinSchema.nullable(), contract_sha256: hashSchema, target: targetSchema,
  desired_tree_oid: oid, source_content_sha256: hashSchema, producer_id: text, producer_descriptor: pinSchema,
  trust: z.literal('host-authenticated'), limitations: strings }).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const approvalSubjectSchema = z.object({ format: z.literal('reconciliation-approval-subject/2'), ...common,
  plan: pinSchema, plan_body_sha256: hashSchema, evidence: pinSchema, target: targetSchema, desired_tree_oid: oid,
  contract_sha256: hashSchema, required_roles: roles, successor_template: successorTemplateSchema, historical_bridge: bridge }).strict();
export type ApprovalSubject = z.infer<typeof approvalSubjectSchema>;
export const reviewSchema = z.object({ format: z.literal('reconciliation-review/2'), subject: approvalSubjectSchema,
  subject_sha256: hashSchema, actor: text, auth: pinSchema, roles: roles.min(1), accepted: z.literal(true), rationale: text,
  valid_until: timestamp }).strict();
export const bindingPayloadSchema = z.object({ format: z.literal('source-binding-payload/2'), ...common, intent: intentPinSchema,
  source: pinSchema, predecessor: pinSchema, basis: z.literal('authenticated-reconciliation-association'),
  evidence: pins.min(1), limitations: strings }).strict();
export const completionSchema = z.object({ format: z.literal('reconciliation-completion/2'), ...common,
  action: z.enum(['accept_code', 'restore_intent', 'update_intent']), plan: pinSchema, evidence: pinSchema, reviews: pins.min(1),
  auth: pinSchema, historical_bridge: bridge, owner_commit_oid: oid, observation: gitObservationSchema,
  observation_sha256: hashSchema, source_snapshot: pinSchema, source_proof: pinSchema, final_run: pinSchema,
  successor_payload: bindingPayloadSchema, successor_payload_sha256: hashSchema, completed_at: timestamp,
  outcome: z.enum(['accepted-code-selected-scope', 'restored-intent-selected-scope', 'updated-intent-selected-scope']),
  completion: z.literal(true), behavior_verified: z.literal(false) }).strict();
export const bindingSchema = z.object({ format: z.literal('source-binding/2'), payload: bindingPayloadSchema,
  payload_sha256: hashSchema, acceptance: z.object({ trust: z.literal('host-authenticated'), completion: pinSchema,
    source_approval: pinSchema, finalizer_auth: pinSchema }).strict() }).strict();
export const RECONCILIATION_V2_SCHEMAS = {
  'reconciliation-proposal': planSchema, 'reconciliation-auth': authSchema, 'reconciliation-source-proof': sourceProofSchema,
  'reconciliation-git-object': gitObjectSchema, 'reconciliation-run': runSchema, 'reconciliation-criterion-review': criterionReviewSchema,
  'reconciliation-evidence': evidenceSchema, 'reconciliation-review': reviewSchema, 'reconciliation-completion': completionSchema,
  'source-binding': bindingSchema,
  'reconciliation-producer-descriptor': producerDescriptorSchema,
} as const;
export type ReconciliationAuth = z.infer<typeof authSchema>;
export type ReconciliationRun = z.infer<typeof runSchema>;
export type CriterionReview = z.infer<typeof criterionReviewSchema>;
export type ReconciliationReview = z.infer<typeof reviewSchema>;
export type ReconciliationCompletion = z.infer<typeof completionSchema>;
export type BindingPayloadV2 = z.infer<typeof bindingPayloadSchema>;
export type SourceBindingV2 = z.infer<typeof bindingSchema>;
export type ProducerDescriptor = z.infer<typeof producerDescriptorSchema>;
export type ReconciliationType = keyof typeof RECONCILIATION_V2_SCHEMAS;
export type TypedEdge = { pin: Pin; type: string };
/** The reader resolves indexed immutable records; it does not grant runtime authority. */
export type TypedRecordReader = (pin: Pin, type: string) => unknown;
export function recordPin(type: string, data: unknown): Pin { const sha256 = digest(data); return { ref: `${type}@${sha256}`, sha256 }; }
export function same(a: unknown, b: unknown, label: string): void {
  if (canonical(a) !== canonical(b)) fail('RECONCILIATION_MISMATCH', 6, label);
}
export function readPinned(read: TypedRecordReader, pin: Pin, type: string): any {
  parse(pinSchema, pin); const data = read(pin, type);
  if (digest(data) !== pin.sha256 || (Object.hasOwn(RECONCILIATION_V2_SCHEMAS, type) || type === 'source-snapshot') && pin.ref !== `${type}@${pin.sha256}`)
    fail('RECONCILIATION_PIN', 6, 'Retained record type/reference/digest mismatch.');
  return data;
}
export type SemanticContext = { source_scope: string; target_scope: string; changed_target: boolean; guardians: string[] };
export function requiredRoleKeys(context: SemanticContext): string[] {
  const result = [`source:${context.source_scope}`, ...(context.changed_target ? [`scope:${context.target_scope}`, 'release', ...context.guardians.map(g => `guardian:${g}`)] : [])].sort();
  return parse(roles, result);
}
export function normalizeRoleKeys(input: z.infer<typeof approveRequestSchema>['roles'], context: SemanticContext): string[] {
  const result = input.map(r => typeof r === 'object' ? `guardian:${r.guardian}` : r === 'source' ? `source:${context.source_scope}` : r === 'scope' ? `scope:${context.target_scope}` : 'release').sort();
  parse(roles, result); const required = requiredRoleKeys(context);
  if (result.some(r => !required.includes(r))) fail('RECONCILIATION_ROLES', 4, 'Approval includes an unneeded role.');
  return result;
}
export function exactRoleCoverage(required: string[], supplied: string[][]): void {
  parse(roles, required); const flattened = supplied.flat().sort(); parse(roles, flattened);
  same(flattened, required, 'Every required role must be covered exactly once.');
}
export function exactCriterionCoverage(definitions: PlanBody['criteria'], method: 'mechanical' | 'review', rows: { criterion_ref: string }[]): void {
  parse(criteria, definitions); orderedSet(rows.map(r => r.criterion_ref), 'Criterion results/assertions');
  same(rows.map(r => r.criterion_ref), definitions.filter(c => c.method === method).map(c => c.criterion_ref), 'Every selected criterion must occur exactly once for its method.');
}
export function contractDigest(body: Pick<PlanBody, 'target' | 'criteria' | 'checker' | 'producer_id' | 'producer_descriptor' | 'oracle'>): string {
  return digest({ format: 'reconciliation-application-contract/1', target: body.target, criteria: body.criteria,
    checker: body.checker, producer_id: body.producer_id, producer_descriptor: body.producer_descriptor, oracle: body.oracle });
}
/** Canonical sets must already be sorted; normalization never silently removes duplicates. */
export function normalizePlanBody(input: PlanBody): PlanBody {
  const b = parse(planBodySchema, input);
  validateSourceScope(b.old_scope); validateSourceScope(b.scope);
  same({ ...b.scope, mapping: b.old_scope.mapping }, b.old_scope, 'Target scope cannot enlarge items, paths, watches, exclusions or limitations.');
  same(b.scope.mapping.map(m => ({ item: m.item, paths: m.paths })), b.old_scope.mapping.map(m => ({ item: m.item, paths: m.paths })), 'Target mapping must retain selected items and paths.');
  same(b.criteria.map(c => c.criterion_ref), [...new Set(b.scope.mapping.flatMap(m => m.criteria))].sort(), 'Criteria must cover the exact derived target mapping.');
  if (b.criteria.some(c => !b.scope.items.includes(c.criterion_ref) || c.subjects.some(s => !b.scope.items.includes(s))) ||
    b.scope.mapping.some(m => m.item.includes('/acceptance.') && !m.criteria.includes(m.item)))
    fail('RECONCILIATION_CRITERIA', 8, 'Criterion items and affected subjects must remain inside complete selected scope.');
  if (b.layer_refs.some(ref => !b.historical_bridge.semantic_records.some(e => e.type === 'layer' && e.pin.ref === ref)))
    fail('RECONCILIATION_TARGET', 6, 'Selected Layers need exact typed retained semantic pins.');
  same(b.required_roles, requiredRoleKeys(b.scopes), 'Plan role derivation disagrees.');
  same(b.contract_sha256, contractDigest(b), 'Contract digest disagrees.');
  same(b.checker.oracle_sha256, digest(b.oracle), 'Oracle digest disagrees.');
  same(b.observation_sha256, digest(b.observation), 'Observation digest disagrees.');
  if ((b.action === 'restore_intent') !== (b.patch !== null) || (b.patch === null) !== (b.patch_sha256 === null)) fail('RECONCILIATION_ACTION', 2, 'Action and patch presence disagree.');
  if (b.patch !== null) same(b.patch_sha256, bytesDigest(b.patch), 'Patch digest disagrees.');
  if (b.action !== 'restore_intent' && (b.operations.length || b.restore_paths.length) || b.action === 'restore_intent' && (b.layer_refs.length || b.scopes.changed_target)) fail('RECONCILIATION_ACTION', 2, 'Restoration and source-only inputs disagree.');
  const changed = b.old_intent.release_ref !== b.target.release_ref;
  same(changed, b.scopes.changed_target, 'Changed-target derivation disagrees.');
  if (!changed) same(b.old_intent, { release_ref: b.target.release_ref, release_sha256: b.target.release_sha256,
    snapshot_sha256: b.target.snapshot_sha256, model_version: b.target.model_version }, 'Unchanged target must retain the exact old intent pin.');
  if (!changed && b.scopes.normative_delta || (b.scopes.target_case === 'normative-impact') !== b.scopes.normative_delta)
    fail('RECONCILIATION_TARGET', 6, 'Target scope derivation case differs from the normative delta.');
  if (b.action === 'update_intent' && (!changed || !b.scopes.normative_delta)) fail('RECONCILIATION_ACTION', 2, 'update_intent requires a distinct target and normative delta.');
  if (!changed && b.historical_bridge.predecessor_validation === 'accepted-unvalidated-bootstrap') fail('RECONCILIATION_TARGET', 8, 'Unchanged bootstrap target is not validated.');
  same(b.historical_bridge.predecessor, b.predecessor, 'Historical predecessor differs.');
  same(b.historical_bridge.old_intent, b.old_intent, 'Historical intent differs.');
  same(b.historical_bridge.target, b.target, 'Historical target differs.');
  same(b.successor_template, { predecessor: b.predecessor, target: b.target, scope: b.scope,
    desired_tree_oid: b.desired_tree_oid, desired_manifest_sha256: digest(b.desired_entries), limitations: b.scope.limitations,
    allowed_transition: 'reviewed-clean-head-or-single-child', evidence_policy: 'fresh-same-contract-and-source', required_roles: b.required_roles }, 'Successor template differs from fixed plan inputs.');
  return b;
}
export function deriveApprovalSubject(input: Plan, inputEvidence: Evidence): ApprovalSubject {
  const plan = parse(planSchema, input), b = normalizePlanBody(plan.body), e = parse(evidenceSchema, inputEvidence);
  same(plan.body_sha256, digest(b), 'Plan body digest disagrees.');
  same(e.plan, recordPin('reconciliation-proposal', plan), 'Evidence references another plan.');
  same([e.project_id, e.repo_id, e.target, e.contract_sha256, e.desired_tree_oid, e.source_content_sha256, e.producer_id, e.producer_descriptor],
    [b.project_id, b.repo_id, b.target, b.contract_sha256, b.desired_tree_oid, digest(b.desired_entries), b.producer_id, b.producer_descriptor], 'Evidence changes the approved contract/source.');
  return parse(approvalSubjectSchema, { format: 'reconciliation-approval-subject/2', project_id: b.project_id, repo_id: b.repo_id,
    plan: recordPin('reconciliation-proposal', plan), plan_body_sha256: plan.body_sha256, evidence: recordPin('reconciliation-evidence', e),
    target: b.target, desired_tree_oid: b.desired_tree_oid, contract_sha256: b.contract_sha256, required_roles: b.required_roles,
    successor_template: b.successor_template, historical_bridge: b.historical_bridge });
}
/** Shapes/labels are assertions. S4/S5 must verify action joins, semantic closure and authority. */
export function parseReconciliationRecord(type: ReconciliationType, input: unknown): any {
  if (Buffer.byteLength(canonical(input)) > RECONCILIATION_LIMITS.recordBytes) fail('RECONCILIATION_RECORD_LIMIT', 8, 'Canonical record exceeds 768 KiB.');
  const d: any = parse(RECONCILIATION_V2_SCHEMAS[type] as z.ZodType, input);
  if (type === 'reconciliation-proposal') {
    normalizePlanBody(d.body); same(d.body_sha256, digest(d.body), 'Deterministic body digest differs.');
  }
  if (type === 'reconciliation-review') {
    same(d.subject_sha256, digest(d.subject), 'Approval subject digest differs.');
    if (d.roles.some((r: string) => !d.subject.required_roles.includes(r))) fail('RECONCILIATION_ROLES', 6, 'Review endorses an unneeded role.');
  }
  if (type === 'source-binding') same(d.payload_sha256, digest(d.payload), 'Binding payload digest differs.');
  if (type === 'reconciliation-completion') {
    const outcomes = { accept_code: 'accepted-code-selected-scope', restore_intent: 'restored-intent-selected-scope', update_intent: 'updated-intent-selected-scope' };
    same(d.outcome, outcomes[d.action as keyof typeof outcomes], 'Completion outcome differs from its action.');
    same(d.observation_sha256, digest(d.observation), 'Final observation digest differs.');
    same(d.successor_payload_sha256, digest(d.successor_payload), 'Final payload digest differs.');
    same([d.successor_payload.project_id, d.successor_payload.repo_id, d.successor_payload.source], [d.project_id, d.repo_id, d.source_snapshot], 'Final payload source identity differs.');
    const t = d.historical_bridge.target;
    same(d.successor_payload.intent, { release_ref: t.release_ref, release_sha256: t.release_sha256, snapshot_sha256: t.snapshot_sha256, model_version: t.model_version }, 'Final payload target differs.');
  }
  if (type === 'reconciliation-run' && Date.parse(d.started_at) > Date.parse(d.finished_at)) fail('RECONCILIATION_TIME', 6, 'Run interval is reversed.');
  if (type === 'reconciliation-auth') {
    same(d.action_input_sha256, digest(d.action_input), 'Canonical action input digest differs.');
    if (d.action_input.action === 'drift.reconcile.prepare') same(d.action_input.layer_pins.map((p: Pin) => p.ref), d.action_input.request.layer_refs, 'Prepared Layer pins differ from exact request refs.');
    const start = Date.parse(d.action_started_at), end = Date.parse(d.action_finished_at), issued = Date.parse(d.issued_at),
      sessionStart = Date.parse(d.session.issued_at), sessionEnd = Date.parse(d.session.expires_at), grantEnd = Date.parse(d.authority.grant_expires_at);
    if (!(sessionStart <= issued && issued <= start && start <= end && end <= sessionEnd && end <= grantEnd))
      fail('RECONCILIATION_TIME', 6, 'Recorded action must fall inside its valid issuing session and grant.');
    const durable = ['drift.reconcile.approve', 'reconciliation.criterion-review', 'reconciliation.role-approval'].includes(d.action_input.action);
    if (durable !== (d.endorsement_valid_until !== null)) fail('RECONCILIATION_TIME', 6, 'Durable endorsement expiry is action-specific.');
    if (durable && !(end < Date.parse(d.endorsement_valid_until) && Date.parse(d.endorsement_valid_until) <= Math.min(issued + 86400000, grantEnd)))
      fail('RECONCILIATION_TIME', 6, 'Durable expiry exceeds 24 hours or the exact grant expiry.');
  }
  if (type === 'reconciliation-producer-descriptor') {
    same(d.checker.oracle_sha256, digest(d.oracle), 'Descriptor oracle digest differs.');
    for (const asset of d.assets) {
      const bytes = Buffer.from(asset.bytes_base64, 'base64');
      if (bytes.toString('base64') !== asset.bytes_base64 || bytes.length !== asset.byte_length || bytesDigest(bytes) !== asset.sha256)
        fail('RECONCILIATION_ASSET', 6, 'Producer asset bytes/length/digest differ.');
    }
  }
  return d;
}
export { sourceSnapshotSchema };
