import { z } from 'zod';
import { MODEL, canonical, digest, fail, parse, type Records, type Snapshot } from './model.js';
import { Engine, obligations } from './core.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import { authorizeSource, gitObservationSchema, sourceEntrySchema, sourceHashSchema as hash, sourceRefSchema as ref, sourceTextSchema as text, readSourceBinding, readBindingSource, validateIntentPin, validateGitObservation, validateSourceScope, type GitObservation, type SourceSnapshot, type SourceScope } from './source-binding.js';

const targetSchema = z.object({ ref, record_sha256: hash, snapshot_sha256: hash, candidate_fingerprint: hash.nullable() }).strict();
const findingSchema = z.object({ path: text, kind: z.enum(['added', 'deleted', 'bytes-changed', 'mode-changed', 'kind-changed']), before: sourceEntrySchema.nullable(), after: sourceEntrySchema.nullable() }).strict();
const intentChangeSchema = z.object({ item: text, before_sha256: hash.nullable(), after_sha256: hash.nullable(), category: z.enum(['normative', 'explanatory', 'topology']) }).strict();
const evidenceAssessmentSchema = z.object({ ref, record_sha256: hash, kind: z.enum(['application', 'profile-only']), state: z.enum(['compatible-pass', 'compatible-fail', 'incomplete', 'mismatched', 'profile-only']), trust: z.enum(['local-fixture-import', 'local-fixed-fixture', 'profile-fixture']), execution_authenticated: z.literal(false), criteria: z.array(text), limitations: z.array(text).max(256) }).strict();
export const driftReportSchema = z.object({
  format: z.literal('source-drift-report/1'), project_id: text, repo_id: text, binding_ref: ref, binding_sha256: hash, observed_intent: targetSchema,
  observation: gitObservationSchema, observation_sha256: hash, evidence: z.array(evidenceAssessmentSchema).max(256), evidence_sha256: hash,
  source_changes: z.array(findingSchema).max(768), possible_renames: z.array(z.object({ deleted: text, added: z.array(text).max(256), ambiguous: z.boolean() }).strict()).max(256),
  acceptance_changes: z.array(z.object({ criterion_ref: text, before_evidence_ref: ref, after_evidence_ref: ref, before_passed: z.boolean(), after_passed: z.boolean(), kind: z.enum(['reported-outcome-change', 'demonstrated-fixture-outcome-change', 'incomparable']), reason: text }).strict()).max(1024),
  intent_changes: z.array(intentChangeSchema).max(1024), intent_record_changed: z.boolean(), head_changed: z.boolean(), index_status_changed: z.boolean(),
  coverage: z.object({ scope_sha256: hash, scope_complete: z.boolean(), acceptance_complete: z.boolean(), missing_paths: z.array(text), unmapped_paths: z.array(text), missing_items: z.array(text), criteria: z.array(text), exclusions: z.array(text) }).strict(),
  behavior_status: z.enum(['unknown', 'reported-compatible-results', 'bounded-fixture-results', 'reported-outcome-change', 'demonstrated-fixture-outcome-change']), assessment: z.enum(['no-source-delta', 'attention', 'blocked']), blockers: z.array(text).max(512), limitations: z.array(text).max(256),
  producer: z.object({ principal: text, trust: z.enum(['local-measurement', 'imported-snapshot']) }).strict()
}).strict();
export type DriftReport = z.infer<typeof driftReportSchema>;
const HOST = Symbol('trusted-drift-host');
export type DriftHostProof = { readonly [HOST]: true; observation: GitObservation };
export function createDriftHostProof(observation: GitObservation): DriftHostProof {
  const o = validateGitObservation(observation); if (o.trust !== 'local-measurement') fail('SOURCE_INTEGRITY', 6, 'Host proof requires a local measurement.'); return { [HOST]: true, observation: o };
}
export function driftHostObservation(host?: DriftHostProof) { if (!host?.[HOST]) fail('UNSUPPORTED_SOURCE_BACKEND', 8, 'Fresh source observation requires a trusted local host.'); return host.observation; }
export function compareIntent(before: Snapshot, after: Snapshot): DriftReport['intent_changes'] {
  const changes: DriftReport['intent_changes'] = [];
  const collect = (s: Snapshot) => {
    const values = new Map<string, unknown>(obligations(s).map(o => [o.item, o.value]));
    for (const b of Object.values(s.blocks)) { values.set(b.id + '/parent', b.parent); if (b.description) values.set(b.id + '/description', b.description); for (const [key, v] of Object.entries(b.asset_refs ?? {})) values.set(b.id + '/asset_refs.' + key, v); }
    return values;
  };
  const a = collect(before), b = collect(after);
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.has(key) ? digest(a.get(key)) : null, y = b.has(key) ? digest(b.get(key)) : null;
    if (x !== y) changes.push({ item: key, before_sha256: x, after_sha256: y, category: key.endsWith('/parent') ? 'topology' : /\/(?:description|asset_refs\.)/.test(key) ? 'explanatory' : 'normative' });
  }
  return changes;
}
function evidenceAssessment(engine: Engine, evidenceRef: string, scope: SourceScope, observation: GitObservation, target: DriftReport['observed_intent'], targetSnapshot: Snapshot): DriftReport['evidence'][number] {
  const record = engine.records[evidenceRef], data = engine.read(evidenceRef);
  if (record.type === 'validation') return { ref: evidenceRef, record_sha256: digest(data), kind: 'profile-only', state: 'profile-only', trust: 'profile-fixture', execution_authenticated: false, criteria: [], limitations: ['Compiled-profile validation does not measure this application source.'] };
  if (!['git-acceptance', 'git-application-observation'].includes(record.type)) fail('INVALID_RECORD', 2, 'Drift evidence must be exact application evidence or profile validation records.');
  const required = [...new Set(obligations(targetSnapshot).filter(o => scope.items.includes(o.item)).flatMap(o => o.criteria))].sort();
  const rows: any[] = Array.isArray(data.results) ? data.results : [], criteria = rows.map(r => r.criterion_ref).sort();
  let state: 'compatible-pass'|'compatible-fail'|'incomplete'|'mismatched' = 'compatible-pass';
  if (canonical(criteria) !== canonical(required) || new Set(criteria).size !== criteria.length) state = 'incomplete';
  let targetPinned = false;
  if (typeof data.target?.ref === 'string') {
    const pinned = engine.read(data.target.ref), evaluated = engine.target(data.target.ref);
    targetPinned = digest(pinned) === data.target.record_sha256 && digest(evaluated.snapshot) === data.target.snapshot_sha256 && evaluated.fingerprint === data.target.candidate_fingerprint;
  }
  // A plan's Composition can flatten to this Release only with the same exact candidate and snapshot.
  const match = data.project_id === observation.project_id && data.repo_id === observation.repo_id && data.result_manifest_sha256 === observation.manifest_sha256 && targetPinned && data.target?.snapshot_sha256 === target.snapshot_sha256 && data.target?.candidate_fingerprint === target.candidate_fingerprint;
  if (!match) state = 'mismatched';
  for (const row of rows) {
    const slash = typeof row.criterion_ref === 'string' ? row.criterion_ref.indexOf('/') : -1, block = targetSnapshot.blocks[row.criterion_ref?.slice(0, slash)];
    const path = typeof row.criterion_ref === 'string' ? row.criterion_ref.slice(slash + 1) : '', key = path.startsWith('acceptance.') ? path.slice(11) : '';
    const criterion = block && slash > 0 && Object.hasOwn(block.acceptance, key) ? block.acceptance[key] : null;
    if (!criterion || row.check !== criterion.check || row.version !== criterion.version || row.fixture !== criterion.fixture || row.method !== criterion.method || typeof row.passed !== 'boolean' || (row.method === 'review' && typeof row.reviewer !== 'string')) state = 'mismatched';
  }
  if (!data.checker?.sha256 || !data.checker?.fixture_sha256 || !data.checker?.oracle_sha256 || !data.acceptance_contract_sha256 || data.producer?.execution_authenticated !== false || !['local-fixed-fixture', 'local-fixture-import'].includes(data.producer?.trust)) state = 'mismatched';
  if (state === 'compatible-pass' && (rows.some(r => !r.passed) || !Array.isArray(data.regressions) || data.regressions.some((r: any) => r.passed !== true))) state = 'compatible-fail';
  return { ref: evidenceRef, record_sha256: digest(data), kind: 'application', state, trust: data.producer?.trust === 'local-fixed-fixture' ? 'local-fixed-fixture' : 'local-fixture-import', execution_authenticated: false, criteria, limitations: ['Application outcomes are bound local results; execution is not independently authenticated.', ...(Array.isArray(data.limitations) ? data.limitations.slice(0, 64) : [])] };
}
function compareAcceptance(engine: Engine, baselineRefs: string[], current: DriftReport['evidence'], source: SourceSnapshot, baseline: Snapshot, intended: Snapshot): DriftReport['acceptance_changes'] {
  const result: DriftReport['acceptance_changes'] = [];
  const old = baselineRefs.filter(r => ['git-acceptance', 'git-application-observation'].includes(engine.records[r]?.type));
  const criterionValue = (s: Snapshot, key: string) => { const slash = key.indexOf('/'), b = s.blocks[key.slice(0, slash)], path = key.slice(slash + 1), local = path.startsWith('acceptance.') ? path.slice(11) : ''; return b && Object.hasOwn(b.acceptance, local) ? b.acceptance[local] : null; };
  for (const previousRef of old) for (const assessed of current.filter(e => e.kind === 'application')) {
    const before = engine.read(previousRef), after = engine.read(assessed.ref), rows: any[] = before.results ?? [];
    for (const row of rows) {
      if (typeof row.criterion_ref !== 'string') continue;
      const peers = (after.results as any[]).filter(r => r.criterion_ref === row.criterion_ref);
      if (peers.length !== 1 || typeof row.passed !== 'boolean' || typeof peers[0].passed !== 'boolean') continue;
      const next = peers[0], a = criterionValue(baseline, row.criterion_ref), b = criterionValue(intended, row.criterion_ref);
      const sourceBound = before.project_id === source.project_id && before.repo_id === source.repo_id && before.result_manifest_sha256 === source.manifest_sha256;
      let oldTargetBound = false;
      if (typeof before.target?.ref === 'string') { const pin = engine.read(before.target.ref), evaluated = engine.target(before.target.ref); oldTargetBound = digest(pin) === before.target.record_sha256 && digest(evaluated.snapshot) === before.target.snapshot_sha256 && digest(baseline) === before.target.snapshot_sha256 && evaluated.fingerprint === before.target.candidate_fingerprint; }
      const sameCriterion = a && b && digest(a) === digest(b) && [row, next].every(r => r.check === a.check && r.version === a.version && r.fixture === a.fixture && r.method === a.method);
      const comparable = sourceBound && oldTargetBound && sameCriterion && before.acceptance_contract_sha256 === after.acceptance_contract_sha256 && canonical(before.checker) === canonical(after.checker) && ['compatible-pass', 'compatible-fail'].includes(assessed.state);
      if (comparable && row.passed === next.passed) continue;
      const demonstrated = comparable && a.method === 'mechanical' && before.producer?.trust === 'local-fixed-fixture' && after.producer?.trust === 'local-fixed-fixture';
      result.push({ criterion_ref: row.criterion_ref, before_evidence_ref: previousRef, after_evidence_ref: assessed.ref, before_passed: row.passed, after_passed: next.passed, kind: !comparable ? 'incomparable' : demonstrated ? 'demonstrated-fixture-outcome-change' : 'reported-outcome-change', reason: !comparable ? 'Source/intent/criterion/checker/fixture/oracle pins are not comparable.' : demonstrated ? 'The same bounded mechanical fixture reports different measured outcomes.' : 'Bound imported or review outcomes changed; execution is not authenticated.' });
      if (result.length > 1024) fail('SOURCE_LIMIT', 8, 'Acceptance comparison exceeds the bounded report budget.');
    }
  }
  return result;
}
export function buildDriftReport(engine: Engine, input: { binding_ref: string; against?: string; evidence_refs?: string[] }, observationInput: GitObservation, principal: string): DriftReport {
  const binding = readSourceBinding(engine, input.binding_ref), source = readBindingSource(engine, binding), { snapshot: baseline } = validateIntentPin(engine, binding.payload.intent);
  const observation = validateGitObservation(observationInput, source.scope);
  if (binding.payload.project_id !== observation.project_id || binding.payload.repo_id !== observation.repo_id) fail('PROJECT_FORBIDDEN', 4, 'Observation belongs to another source association.');
  if (observation.coherence !== 'stable') fail('SOURCE_SNAPSHOT_STALE', 5, 'Source changed during observation.');
  const targetRef = input.against ?? binding.payload.intent.release_ref, targetRecord = engine.read(targetRef), evaluation = engine.target(targetRef), targetSnapshot = evaluation.snapshot;
  if (targetSnapshot.model_version !== MODEL || targetRecord.model_version !== MODEL) fail('UNSUPPORTED_MODEL_VERSION', 8, 'Source drift v1 requires v0.1 intent.');
  if (evaluation.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'Cannot compare against blocked effective intent.');
  const target = { ref: targetRef, record_sha256: digest(targetRecord), snapshot_sha256: digest(targetSnapshot), candidate_fingerprint: evaluation.fingerprint };
  const sourceChanges: DriftReport['source_changes'] = [], a = new Map(source.entries.map(e => [e.path, e])), b = new Map(observation.entries.map(e => [e.path, e]));
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const before = a.get(name) ?? null, after = b.get(name) ?? null, oldPresent = before?.presence === 'present', newPresent = after?.presence === 'present';
    const add = (kind: DriftReport['source_changes'][number]['kind']) => sourceChanges.push({ path: name, kind, before, after });
    if (!oldPresent && newPresent) add('added'); else if (oldPresent && !newPresent) add('deleted');
    else if (oldPresent && newPresent) { if (before!.kind !== after!.kind) add('kind-changed'); if (before!.mode !== after!.mode) add('mode-changed'); if (before!.sha256 !== after!.sha256 || before!.byte_length !== after!.byte_length) add('bytes-changed'); }
  }
  const possible_renames = sourceChanges.filter(e => e.kind === 'deleted' && e.before?.kind === 'regular').map(e => { const added = sourceChanges.filter(n => n.kind === 'added' && n.after?.kind === 'regular' && n.after.sha256 === e.before!.sha256).map(n => n.path); return { deleted: e.path, added, ambiguous: added.length !== 1 }; }).filter(r => r.added.length);
  const paths = [...new Set(source.scope.mapping.flatMap(m => m.paths))].sort(), missing_paths = paths.filter(p => a.get(p)?.presence === 'present' && b.get(p)?.presence !== 'present');
  const unmapped_paths = observation.entries.filter(e => e.presence === 'present' && !paths.includes(e.path)).map(e => e.path), missing_items = source.scope.items.filter(i => !obligations(targetSnapshot).some(o => o.item === i));
  const criteria = [...new Set(obligations(targetSnapshot).filter(o => source.scope.items.includes(o.item)).flatMap(o => o.criteria))].sort();
  let mappingComplete = true; try { validateSourceScope(source.scope, targetSnapshot); } catch { mappingComplete = false; }
  const scope_complete = !missing_paths.length && !unmapped_paths.length && !missing_items.length && !observation.unsupported.length && !observation.entries.some(e => e.presence === 'present' && e.kind !== 'regular') && mappingComplete;
  const evidenceRefs = [...(input.evidence_refs ?? [])]; if (new Set(evidenceRefs).size !== evidenceRefs.length) fail('INVALID_RECORD', 2, 'Duplicate evidence references.'); evidenceRefs.sort();
  const evidence = evidenceRefs.map(r => evidenceAssessment(engine, r, source.scope, observation, target, targetSnapshot));
  const application = evidence.filter(e => e.kind === 'application'), acceptance_complete = scope_complete && application.length > 0 && application.every(e => e.state === 'compatible-pass');
  const acceptance_changes = compareAcceptance(engine, binding.payload.acceptance_evidence_refs, evidence, source, baseline, targetSnapshot);
  const behavior_status = acceptance_changes.some(c => c.kind === 'demonstrated-fixture-outcome-change') ? 'demonstrated-fixture-outcome-change' : acceptance_changes.some(c => c.kind === 'reported-outcome-change') ? 'reported-outcome-change' : !acceptance_complete ? 'unknown' : application.every(e => e.trust === 'local-fixed-fixture') ? 'bounded-fixture-results' : 'reported-compatible-results';
  const blockers = [ ...(!scope_complete ? ['SOURCE_COVERAGE_INCOMPLETE'] : []), ...evidence.filter(e => !['compatible-pass', 'profile-only'].includes(e.state)).map(e => 'ACCEPTANCE_' + e.state.toUpperCase().replaceAll('-', '_')) ];
  const intent_changes = compareIntent(baseline, targetSnapshot), head_changed = source.head_commit !== observation.head_commit || source.head_tree !== observation.head_tree;
  const assessment = blockers.length ? 'blocked' : sourceChanges.length || intent_changes.length || head_changed || observation.status.length ? 'attention' : 'no-source-delta';
  return parse(driftReportSchema, { format: 'source-drift-report/1', project_id: observation.project_id, repo_id: observation.repo_id, binding_ref: input.binding_ref, binding_sha256: digest(binding), observed_intent: target, observation, observation_sha256: digest(observation), evidence, evidence_sha256: digest(evidence), source_changes: sourceChanges, possible_renames, acceptance_changes, intent_changes, intent_record_changed: target.record_sha256 !== binding.payload.intent.release_sha256, head_changed, index_status_changed: observation.status.length > 0, coverage: { scope_sha256: source.scope_sha256, scope_complete, acceptance_complete, missing_paths, unmapped_paths, missing_items, criteria, exclusions: source.scope.exclusions.map(e => e.path) }, behavior_status, assessment, blockers: [...new Set(blockers)].sort(), limitations: ['Source byte changes do not establish semantic divergence.', 'Selected scope does not establish whole-application behavior or equivalence.', 'Ignored and excluded contents were not inspected.', 'Local identities and imported results are not independent attestations.', ...source.scope.limitations], producer: { principal, trust: observation.trust } });
}
export function executeDriftCheck(engine: Engine, input: any, context: SecurityContext, issuer: AuthorityIssuer, host?: DriftHostProof) {
  const request = parse(z.object({ binding_ref: ref, against: ref.optional(), evidence_refs: z.array(ref).max(256).optional(), imported_observation: gitObservationSchema.optional() }).strict(), input), binding = readSourceBinding(engine, request.binding_ref), source = readBindingSource(engine, binding);
  if (binding.payload.project_id !== context.project_id) fail('PROJECT_FORBIDDEN', 4, 'Drift source belongs to another project.');
  const observation = request.imported_observation ? { ...request.imported_observation, trust: 'imported-snapshot' as const } : driftHostObservation(host);
  authorizeSource(issuer, context, 'drift.check', binding.payload.repo_id, observation.entries.map(e => e.path));
  const report = buildDriftReport(engine, request, observation, context.principal_id), reportRef = 'drift-report@' + digest(report); engine.store(reportRef, 'drift-report', report);
  return { ref: reportRef, assessment: report.assessment, behavior_status: report.behavior_status, blockers: report.blockers, source_changes: report.source_changes, review_required: true };
}
export function driftReportArchiveReferences(data: unknown) { const r = parse(driftReportSchema, data); return [r.binding_ref, r.observed_intent.ref, ...r.evidence.map(e => e.ref)].sort(); }
export function verifyDriftReportHistory(records: Records, projectId: string) {
  const engine = new Engine(records, {}, { projectId });
  for (const [ref, stored] of Object.entries(records)) if (stored.type === 'drift-report') {
    const report = parse(driftReportSchema, stored.data), rebuilt = buildDriftReport(engine, { binding_ref: report.binding_ref, against: report.observed_intent.ref, evidence_refs: report.evidence.map(e => e.ref) }, report.observation, report.producer.principal);
    if (report.project_id !== projectId || ref !== 'drift-report@' + digest(report) || canonical(report) !== canonical(rebuilt)) fail('SOURCE_INTEGRITY', 6, 'Historical drift report cannot be recomputed from retained inputs.');
  }
}
