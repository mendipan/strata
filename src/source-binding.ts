import { z } from 'zod';
import { MODEL, canonical, digest, fail, parse, item, responsible, impactClosure, type Records, type Snapshot } from './model.js';
import { Engine, obligations, snapshotFromRelease } from './core.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import { gitFinalizationBindingProof } from './git-finalization-proof.js';

export const SOURCE_LIMITS = { entries: 256, roots: 64, file: 4 * 1024 * 1024, bytes: 16 * 1024 * 1024, inventory: 5000 };
export const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceRefSchema = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
export const sourceTextSchema = z.string().min(1).max(4096).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), 'Control characters are unsupported.');
export function sourcePath(value: string, root = false): string {
  if (root && value === '.') return value;
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(value)) fail('INVALID_PATH', 2, 'Source paths use bounded relative portable ASCII names.');
  if (value.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || /^\.git(?:$|\.)/i.test(p) || /^\.strata$/i.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('INVALID_PATH', 2, 'Source path traverses metadata, aliases or reserved names.');
  return value;
}
const pathSchema = z.string().max(240).refine(v => { try { sourcePath(v); return true; } catch { return false; } }, 'Unsafe source path.');
const rootSchema = z.string().max(240).refine(v => { try { sourcePath(v, true); return true; } catch { return false; } }, 'Unsafe source root.');
const idSchema = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/).max(120);
const strings = z.array(sourceTextSchema).max(256);
export const sourceScopeSchema = z.object({
  format: z.literal('source-scope/1'), coverage: z.literal('selected-scope'),
  paths: z.array(pathSchema).max(SOURCE_LIMITS.entries), watch_roots: z.array(rootSchema).max(SOURCE_LIMITS.roots),
  exclusions: z.array(z.object({ path: pathSchema, kind: z.enum(['file', 'directory']), reason: sourceTextSchema }).strict()).max(256),
  items: strings.min(1), mapping: z.array(z.object({ item: sourceTextSchema, paths: z.array(pathSchema).min(1).max(256), criteria: strings }).strict()).min(1).max(256),
  limitations: strings
}).strict();
export const sourceEntrySchema = z.object({ path: pathSchema, presence: z.enum(['present', 'absent']), kind: z.enum(['regular', 'symlink', 'gitlink']).nullable(), mode: z.enum(['100644', '100755', '120000', '160000']).nullable(), byte_length: z.number().int().nonnegative().max(SOURCE_LIMITS.file).nullable(), sha256: sourceHashSchema.nullable() }).strict();
export const sourceSnapshotSchema = z.object({ format: z.literal('source-snapshot/1'), project_id: idSchema, repo_id: idSchema, object_format: z.enum(['sha1', 'sha256']), head_commit: z.string(), head_tree: z.string(), scope: sourceScopeSchema, scope_sha256: sourceHashSchema, entries: z.array(sourceEntrySchema).max(SOURCE_LIMITS.entries), manifest_sha256: sourceHashSchema }).strict();
export const gitObservationSchema = z.object({
  format: z.literal('git-observation/1'), project_id: idSchema, repo_id: idSchema, object_format: z.enum(['sha1', 'sha256']), head_commit: z.string(), head_tree: z.string(), index_sha256: sourceHashSchema,
  scope_sha256: sourceHashSchema, entries: z.array(sourceEntrySchema).max(SOURCE_LIMITS.entries), manifest_sha256: sourceHashSchema,
  status: z.array(z.object({ path: pathSchema, staged: z.boolean(), unstaged: z.boolean(), untracked: z.boolean() }).strict()).max(SOURCE_LIMITS.inventory),
  outside_scope_dirty: z.boolean(), ignored_count: z.number().int().nonnegative().max(SOURCE_LIMITS.inventory), excluded_count: z.number().int().nonnegative().max(SOURCE_LIMITS.inventory),
  unsupported: z.array(z.object({ path: pathSchema, reason: sourceTextSchema }).strict()).max(256), coherence: z.enum(['stable', 'changed-during-read']), trust: z.enum(['local-measurement', 'imported-snapshot'])
}).strict();
export const intentPinSchema = z.object({ release_ref: sourceRefSchema, release_sha256: sourceHashSchema, snapshot_sha256: sourceHashSchema, model_version: z.literal(MODEL) }).strict();
export const bindingPayloadSchema = z.object({ format: z.literal('source-binding-payload/1'), project_id: idSchema, repo_id: idSchema, intent: intentPinSchema, source_ref: sourceRefSchema, source_sha256: sourceHashSchema, previous_binding_ref: sourceRefSchema.nullable(), completion_ref: sourceRefSchema.nullable(), basis: z.enum(['owner-accepted-bootstrap-association', 'validated-release-association']), acceptance_evidence_refs: z.array(sourceRefSchema).max(256), limitations: strings }).strict();
export const sourceBindingSchema = z.object({ format: z.literal('source-binding/1'), payload: bindingPayloadSchema, payload_sha256: sourceHashSchema, acceptance: z.object({ principal: sourceTextSchema, trust: z.literal('local-fixture'), responsible_scope: idSchema, rationale: sourceTextSchema, accepted: z.literal(true), review_refs: z.array(sourceRefSchema).max(256) }).strict() }).strict();
export const SOURCE_BINDING_SCHEMAS = { 'source-snapshot': sourceSnapshotSchema, 'source-binding': sourceBindingSchema } as const;
export type SourceScope = z.infer<typeof sourceScopeSchema>;
export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type GitObservation = z.infer<typeof gitObservationSchema>;
export type IntentPin = z.infer<typeof intentPinSchema>;
export type BindingPayload = z.infer<typeof bindingPayloadSchema>;
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export type Verification = { matches: boolean; clean: boolean; observation: GitObservation; blockers: { code: string; path?: string }[] };
export type GitHost = { projectId: string; repoId: string; root: string; identity?: string };

function sortedUnique(values: string[], label: string, aliases = false) {
  if (new Set(values.map(v => aliases ? v.toLowerCase() : v)).size !== values.length || canonical(values) !== canonical([...values].sort())) fail('INVALID_RECORD', 2, `${label} must be unique and sorted.`);
  if (aliases) for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) if (values[j].toLowerCase().startsWith(values[i].toLowerCase() + '/')) fail('INVALID_PATH', 2, `${label} contains a file/directory collision.`);
}
export function pathInScope(scope: SourceScope, path: string) {
  return scope.paths.includes(path) || scope.watch_roots.some(root => root === '.' || path.startsWith(root + '/'));
}
export function pathExcluded(scope: SourceScope, path: string) { return scope.exclusions.some(e => e.path === path || (e.kind === 'directory' && path.startsWith(e.path + '/'))); }
export function validateSourceScope(input: unknown, snapshot?: Snapshot): SourceScope {
  const scope = parse(sourceScopeSchema, input);
  sortedUnique(scope.paths, 'Source paths', true); sortedUnique(scope.watch_roots, 'Watched roots', true); sortedUnique(scope.items, 'Declared items');
  sortedUnique(scope.exclusions.map(e => e.path), 'Exclusions', true); sortedUnique(scope.mapping.map(m => m.item), 'Mappings');
  if (!scope.paths.length && !scope.watch_roots.length) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Declare at least one source path or watched root.');
  if (canonical(scope.items) !== canonical(scope.mapping.map(m => m.item))) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Every selected intent item needs exactly one mapping.');
  for (const m of scope.mapping) {
    sortedUnique(m.paths, 'Mapped paths', true); sortedUnique(m.criteria, 'Mapped criteria');
    if (m.paths.some(p => !pathInScope(scope, p) || pathExcluded(scope, p))) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Mapped paths must be included and not excluded.');
  }
  if (snapshot) {
    const all = new Map(obligations(snapshot).map(o => [o.item, o]));
    for (const m of scope.mapping) {
      const o = all.get(m.item);
      if (!o || !o.criteria.length || canonical([...o.criteria].sort()) !== canonical(m.criteria)) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Mapping must retain the complete acceptance set for an existing selected item.', { item: m.item });
    }
  }
  return scope;
}
export function sourceAuthorityScope(snapshot: Snapshot, scope: SourceScope) { return responsible(snapshot, impactClosure(snapshot, scope.items.map(i => i.split('/')[0]))); }
function entries(input: SourceEntry[], committed: boolean) {
  sortedUnique(input.map(e => e.path), 'Source entries', true);
  let bytes = 0;
  for (const e of input) {
    if (e.presence === 'absent') { if ([e.kind, e.mode, e.byte_length, e.sha256].some(v => v !== null)) fail('INVALID_RECORD', 2, 'Absent source entries have no content metadata.'); continue; }
    if (e.kind === 'regular') { if (!e.sha256 || e.byte_length === null || !['100644', '100755', ...(committed ? [] : [null])].includes(e.mode)) fail('INVALID_RECORD', 2, 'Regular source metadata is incomplete.'); }
    else if (e.kind === 'symlink') { if (e.mode !== '120000' || e.byte_length === null || !e.sha256) fail('INVALID_RECORD', 2, 'Symlink metadata must pin the link itself.'); }
    else if (e.kind === 'gitlink') { if (e.mode !== '160000' || e.byte_length !== null || e.sha256 !== null) fail('INVALID_RECORD', 2, 'Gitlinks cannot claim measured content bytes.'); }
    else fail('INVALID_RECORD', 2, 'Present source entries need a supported metadata kind.');
    bytes += e.byte_length ?? 0;
  }
  if (bytes > SOURCE_LIMITS.bytes) fail('SOURCE_LIMIT', 8, 'Selected source exceeds the byte budget.');
}
function pins(value: { object_format: string; head_commit: string; head_tree: string }) { const re = new RegExp(`^[a-f0-9]{${value.object_format === 'sha256' ? 64 : 40}}$`); if (!re.test(value.head_commit) || !re.test(value.head_tree)) fail('INVALID_RECORD', 2, 'Source requires full object-format-bound Git OIDs.'); }
export function validateSourceSnapshot(input: unknown): SourceSnapshot {
  const s = parse(sourceSnapshotSchema, input); validateSourceScope(s.scope); pins(s); entries(s.entries, true);
  if (digest(s.scope) !== s.scope_sha256 || digest(s.entries) !== s.manifest_sha256) fail('SOURCE_INTEGRITY', 6, 'Source scope or manifest digest disagrees.');
  if (s.entries.some(e => !pathInScope(s.scope, e.path) || pathExcluded(s.scope, e.path)) || s.scope.paths.some(p => !s.entries.some(e => e.path === p))) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Source manifest must retain all exact paths within declared scope.');
  return s;
}
export function validateGitObservation(input: unknown, scope?: SourceScope): GitObservation {
  const o = parse(gitObservationSchema, input); pins(o); entries(o.entries, false); sortedUnique(o.status.map(s => s.path), 'Observed status paths', true);
  sortedUnique(o.unsupported.map(s => s.path), 'Unsupported observed paths', true);
  if (digest(o.entries) !== o.manifest_sha256 || (scope && digest(scope) !== o.scope_sha256)) fail('SOURCE_INTEGRITY', 6, 'Observation manifest or scope digest disagrees.');
  if (scope && o.entries.some(e => !pathInScope(scope, e.path) || pathExcluded(scope, e.path))) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Observation includes undeclared source paths.');
  return o;
}
export function readSourceBinding(engine: Engine, ref: string): SourceBinding { const b = parse(sourceBindingSchema, engine.read(ref, 'source-binding')); if (b.payload_sha256 !== digest(b.payload) || ref !== 'source-binding@' + digest(b)) fail('SOURCE_INTEGRITY', 6, 'Binding content-addressed reference or payload digest disagrees.'); sortedUnique(b.payload.acceptance_evidence_refs, 'Evidence references'); sortedUnique(b.acceptance.review_refs, 'Review references'); return b; }
export function readBindingSource(engine: Engine, binding: SourceBinding) { const s = validateSourceSnapshot(engine.read(binding.payload.source_ref, 'source-snapshot')); if (digest(s) !== binding.payload.source_sha256 || binding.payload.source_ref !== 'source-snapshot@' + digest(s)) fail('SOURCE_INTEGRITY', 6, 'Binding source reference or digest disagrees.'); return s; }
function acceptedCoverage(source: SourceSnapshot) {
  const mapped = new Set(source.scope.mapping.flatMap(m => m.paths));
  if (source.scope.mapping.some(m => !m.paths.some(p => source.entries.some(e => e.path === p && e.presence === 'present'))) || source.entries.some(e => e.presence === 'present' && (!mapped.has(e.path) || e.kind !== 'regular'))) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Accepted source must have an existing mapped artifact for each selected item and no unreviewed present entries.');
}
export function validateIntentPin(engine: Engine, pin: IntentPin) {
  const release = engine.read(pin.release_ref, 'release'), snapshot = snapshotFromRelease(release);
  if (release.model_version !== MODEL || digest(release) !== pin.release_sha256 || digest(snapshot) !== pin.snapshot_sha256) fail('STALE_INTENT', 5, 'Intent pin differs from its exact Release.');
  return { release, snapshot };
}
type RepositoryIssuer = AuthorityIssuer & { assertRepository(context: SecurityContext, command: string, repoId: string, paths: string[], checker?: string): void };
export function authorizeSource(issuer: AuthorityIssuer, context: SecurityContext, command: string, repoId: string, paths: string[], snapshot?: Snapshot, scope?: SourceScope, authority = false) {
  issuer.assertLive(context);
  if (!context.allowed_operations.includes(command)) fail('OPERATION_FORBIDDEN', 4, 'This assignment has no source operation grant.');
  if (typeof (issuer as RepositoryIssuer).assertRepository !== 'function') fail('REPOSITORY_GRANT_REQUIRED', 4, 'Source operations require an explicit configured repository grant.');
  (issuer as RepositoryIssuer).assertRepository(context, command, repoId, paths);
  if (scope && context.write_block_ids !== null && scope.items.some(i => !context.write_block_ids!.includes(i.split('/')[0]))) fail('BLOCK_SCOPE_FORBIDDEN', 4, 'Source operation exceeds assigned Block scope.');
  if (authority && snapshot && scope) { const calculated = sourceAuthorityScope(snapshot, scope); if (!snapshot.authorities.scopes.some(s => s.block === calculated && s.selectors.includes(context.principal_id))) fail('AUTHORITY_FORBIDDEN', 4, 'Source acceptance requires responsible baseline scope authority.'); return calculated; }
  return null;
}
const HOST = Symbol('trusted-source-host');
export type SourceHostProof = { readonly [HOST]: true; snapshot: SourceSnapshot; observation: GitObservation };
// Only the trusted in-process Node adapter supplies this nonserializable dependency.
export function createSourceHostProof(snapshot: SourceSnapshot, observation: GitObservation): SourceHostProof {
  return { [HOST]: true, snapshot: validateSourceSnapshot(snapshot), observation: validateGitObservation(observation, snapshot.scope) };
}
export function verifySourceHostProof(proof: SourceHostProof | undefined, source?: SourceSnapshot) {
  if (!proof?.[HOST]) fail('UNSUPPORTED_SOURCE_BACKEND', 8, 'A trusted local source capture backend is required.');
  const s = validateSourceSnapshot(proof.snapshot), o = validateGitObservation(proof.observation, s.scope);
  if (o.trust !== 'local-measurement' || o.coherence !== 'stable' || o.status.length || o.outside_scope_dirty || o.unsupported.length || s.entries.some(e => e.presence === 'present' && e.kind !== 'regular')) fail('SOURCE_SNAPSHOT_STALE', 5, 'Accepted source requires a stable clean ordinary-file observation.');
  if (s.project_id !== o.project_id || s.repo_id !== o.repo_id || s.head_commit !== o.head_commit || s.head_tree !== o.head_tree || s.manifest_sha256 !== o.manifest_sha256 || (source && digest(source) !== digest(s))) fail('SOURCE_SNAPSHOT_STALE', 5, 'Captured source and current physical observation differ.');
  return s;
}
const cleanHost = verifySourceHostProof;
export function validateBindingCompletion(engine: Engine, payload: BindingPayload, source: SourceSnapshot) {
  if (!payload.previous_binding_ref) { if (payload.completion_ref) fail('INVALID_RECORD', 2, 'Initial association cannot carry successor completion.'); return; }
  const previous = readSourceBinding(engine, payload.previous_binding_ref);
  if (previous.payload.project_id !== payload.project_id || previous.payload.repo_id !== payload.repo_id || !payload.completion_ref) fail('SOURCE_COMPLETION_REQUIRED', 6, 'Successor source requires matching predecessor and Git finalization.');
  const c = gitFinalizationBindingProof(engine.records, payload.completion_ref);
  if (payload.completion_ref !== 'git-finalization@' + digest(c)) fail('SOURCE_COMPLETION_REQUIRED', 6, 'Finalization reference is not content-addressed.');
  if (c.project_id !== payload.project_id || c.repo_id !== payload.repo_id || c.binding_ref !== payload.previous_binding_ref || c.release_ref !== payload.intent.release_ref || c.release_sha256 !== payload.intent.release_sha256 || c.snapshot_sha256 !== payload.intent.snapshot_sha256 || c.head_commit !== source.head_commit || c.head_tree !== source.head_tree || !payload.acceptance_evidence_refs.includes(c.acceptance_ref)) fail('SOURCE_COMPLETION_REQUIRED', 6, 'Finalization does not bind this exact source, Release and acceptance.');
  for (const [ref, type] of [[c.receipt_ref, 'git-apply-receipt'], [c.stage_ref, 'git-patch-stage'], [c.review_ref, 'git-apply-review'], [c.acceptance_ref, 'git-acceptance']] as const) engine.read(ref, type);
  const release = engine.read(c.release_ref, 'release'), receipt = engine.read(c.receipt_ref, 'git-apply-receipt'), stage = engine.read(c.stage_ref, 'git-patch-stage'), review = engine.read(c.review_ref, 'git-apply-review');
  if (release.state !== 'validated' || release.candidate !== c.candidate || c.base_commit !== readBindingSource(engine, previous).head_commit || receipt.binding_ref !== c.binding_ref || receipt.stage_ref !== c.stage_ref || receipt.review_ref !== c.review_ref || receipt.result_tree_oid !== c.head_tree || stage.result_tree_oid !== c.head_tree || source.manifest_sha256 !== stage.result_manifest_sha256 || !review.accepted || review.target.stage_ref !== c.stage_ref || review.target.acceptance_ref !== c.acceptance_ref || review.target.release_ref !== c.release_ref || review.target.release_sha256 !== c.release_sha256) fail('SOURCE_COMPLETION_REQUIRED', 6, 'Successor completion provenance does not agree with its reviewed applied tree and selected manifest.');
}
export function executeSourceBinding(engine: Engine, command: string, input: any, context: SecurityContext, issuer: AuthorityIssuer, host?: SourceHostProof) {
  if (command === 'source.capture') {
    const request = parse(z.object({ repo_id: idSchema, scope: sourceScopeSchema, expected_head: z.string().optional() }).strict(), input);
    const s = cleanHost(host); if (s.repo_id !== request.repo_id || s.project_id !== context.project_id || digest(s.scope) !== digest(request.scope) || (request.expected_head && request.expected_head !== s.head_commit)) fail('SOURCE_SNAPSHOT_STALE', 5, 'Host capture differs from the requested source.');
    authorizeSource(issuer, context, command, s.repo_id, s.entries.map(e => e.path));
    const ref = 'source-snapshot@' + digest(s); engine.store(ref, 'source-snapshot', s); return { ref, source_sha256: digest(s), scope_sha256: s.scope_sha256, trust: 'local-measurement' };
  }
  if (command !== 'source.bind') fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown source operation.');
  const request = parse(z.object({ payload: bindingPayloadSchema, expected_payload_sha256: sourceHashSchema, rationale: sourceTextSchema, review_refs: z.array(sourceRefSchema).max(256) }).strict(), input), p = request.payload;
  if (p.project_id !== context.project_id || p.project_id !== engine.options.projectId) fail('PROJECT_FORBIDDEN', 4, 'Source binding belongs to another project.');
  if (digest(p) !== request.expected_payload_sha256) fail('SOURCE_SNAPSHOT_STALE', 5, 'Review must accept the exact binding payload digest.');
  sortedUnique(p.acceptance_evidence_refs, 'Evidence references'); sortedUnique(request.review_refs, 'Review references');
  const source = validateSourceSnapshot(engine.read(p.source_ref, 'source-snapshot')); cleanHost(host, source);
  if (source.project_id !== p.project_id || source.repo_id !== p.repo_id || digest(source) !== p.source_sha256 || p.source_ref !== 'source-snapshot@' + digest(source)) fail('SOURCE_INTEGRITY', 6, 'Association source belongs to another repository, content-addressed reference or digest.');
  const { release, snapshot } = validateIntentPin(engine, p.intent); validateSourceScope(source.scope, snapshot); acceptedCoverage(source);
  if ((release.state === 'validated') !== (p.basis === 'validated-release-association')) fail('SOURCE_BASELINE_ACCEPTANCE_REQUIRED', 6, 'Explicit association basis must disclose unvalidated bootstrap intent.');
  if (p.basis === 'owner-accepted-bootstrap-association' && !p.limitations.some(s => s.includes('unvalidated-bootstrap'))) fail('SOURCE_BASELINE_ACCEPTANCE_REQUIRED', 6, 'Bootstrap association must disclose unvalidated-bootstrap status.');
  validateBindingCompletion(engine, p, source);
  for (const ref of [...p.acceptance_evidence_refs, ...request.review_refs]) { const r = engine.read(ref); if (r.project_id && r.project_id !== p.project_id) fail('PROJECT_FORBIDDEN', 4, 'Association evidence belongs to another project.'); }
  const calculated = authorizeSource(issuer, context, command, p.repo_id, source.entries.map(e => e.path), snapshot, source.scope, true)!;
  const data: SourceBinding = { format: 'source-binding/1', payload: p, payload_sha256: digest(p), acceptance: { principal: context.principal_id, trust: 'local-fixture', responsible_scope: calculated, rationale: request.rationale, accepted: true, review_refs: request.review_refs } };
  const ref = 'source-binding@' + digest(data); engine.store(ref, 'source-binding', data); return { ref, state: 'accepted-association', basis: p.basis, behavior_verified: false };
}
export function sourceBindingArchiveReferences(type: string, data: any): string[] {
  if (type === 'source-snapshot') return [];
  if (type !== 'source-binding') return [];
  const b = parse(sourceBindingSchema, data), p = b.payload;
  return [...new Set([p.intent.release_ref, p.source_ref, ...(p.previous_binding_ref ? [p.previous_binding_ref] : []), ...(p.completion_ref ? [p.completion_ref] : []), ...p.acceptance_evidence_refs, ...b.acceptance.review_refs])].sort();
}
export function verifySourceBindingHistory(records: Records, projectId: string) {
  const engine = new Engine(records, {}, { projectId });
  for (const [ref, record] of Object.entries(records)) {
    if (record.type === 'source-snapshot') { const s = validateSourceSnapshot(record.data); if (s.project_id !== projectId || ref !== 'source-snapshot@' + digest(s)) fail('SOURCE_INTEGRITY', 6, 'Historical source identity or digest disagrees.'); }
    if (record.type === 'source-binding') {
      const b = readSourceBinding(engine, ref), p = b.payload, s = readBindingSource(engine, b), { release, snapshot } = validateIntentPin(engine, p.intent);
      if (p.project_id !== projectId || s.project_id !== projectId || p.repo_id !== s.repo_id || ref !== 'source-binding@' + digest(b)) fail('SOURCE_INTEGRITY', 6, 'Historical association identity disagrees.');
      validateSourceScope(s.scope, snapshot); acceptedCoverage(s); validateBindingCompletion(engine, p, s);
      if ((release.state === 'validated') !== (p.basis === 'validated-release-association') || (p.basis === 'owner-accepted-bootstrap-association' && !p.limitations.some(s => s.includes('unvalidated-bootstrap')))) fail('SOURCE_INTEGRITY', 6, 'Historical bootstrap basis is mislabeled.');
      if (b.acceptance.responsible_scope !== sourceAuthorityScope(snapshot, s.scope) || !snapshot.authorities.scopes.some(a => a.block === b.acceptance.responsible_scope && a.selectors.includes(b.acceptance.principal))) fail('SOURCE_INTEGRITY', 6, 'Historical baseline acceptance authority disagrees.');
      for (const needed of sourceBindingArchiveReferences(record.type, b)) engine.read(needed);
    }
  }
}
