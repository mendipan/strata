import { z } from 'zod';
import { canonical, digest, fail, parse, type Records } from './model.js';
import { Engine } from './core.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import { authorizeSource, readSourceBinding, readBindingSource, validateIntentPin, sourceHashSchema as hash, sourceRefSchema as ref, sourceTextSchema as text, sourceAuthorityScope } from './source-binding.js';
import { buildDriftReport, driftReportSchema, driftReportArchiveReferences, verifyDriftReportHistory, driftHostObservation, executeDriftCheck, type DriftHostProof, type DriftReport } from './source-drift.js';

const actionSchema = z.enum(['accept_code', 'update_intent', 'restore_intent', 'revalidate', 'defer', 'reject']);
const proposalInputSchema = z.object({ report_ref: ref, expected_report_sha256: hash, action: actionSchema, rationale: text, paths: z.array(text).min(1).max(256), items: z.array(text).min(1).max(256), layer_refs: z.array(ref).max(256), patch_refs: z.array(ref).max(256), evidence_refs: z.array(ref).max(256), questions: z.array(text).max(256), supersedes: ref.nullable() }).strict();
export const reconciliationProposalSchema = proposalInputSchema.omit({ expected_report_sha256: true }).extend({ format: z.literal('reconciliation-proposal/1'), project_id: text, repo_id: text, report_sha256: hash, binding_ref: ref, binding_sha256: hash, owner: text, observation_sha256: hash, intent_sha256: hash, coverage_sha256: hash, evidence_sha256: hash, state: z.literal('proposed') }).strict();
export const reconciliationReviewSchema = z.object({ format: z.literal('reconciliation-review/1'), project_id: text, repo_id: text, proposal_ref: ref, proposal_sha256: hash, report_ref: ref, report_sha256: hash, binding_ref: ref, binding_sha256: hash, decision: z.enum(['approve_plan', 'request_changes', 'reject', 'defer']), responsible_scope: text, reviewer: text, policy_version: text, trust: z.literal('local-fixture'), rationale: text, questions: z.array(text).max(256), fresh_observation_sha256: hash.nullable(), state: z.enum(['approved_plan', 'changes_requested', 'rejected', 'deferred']) }).strict();
export const DRIFT_SCHEMAS = { 'drift-report': driftReportSchema, 'reconciliation-proposal': reconciliationProposalSchema, 'reconciliation-review': reconciliationReviewSchema } as const;
export type ReconciliationProposal = z.infer<typeof reconciliationProposalSchema>;
export type ReconciliationReview = z.infer<typeof reconciliationReviewSchema>;
function uniqueSorted(values: string[], name: string) { if (new Set(values).size !== values.length || canonical(values) !== canonical([...values].sort())) fail('INVALID_RECORD', 2, `${name} must be unique and sorted.`); }
function proposalContext(engine: Engine, reportRef: string) {
  const report = parse(driftReportSchema, engine.read(reportRef, 'drift-report')), binding = readSourceBinding(engine, report.binding_ref), source = readBindingSource(engine, binding), { snapshot } = validateIntentPin(engine, binding.payload.intent);
  if (reportRef !== 'drift-report@' + digest(report)) fail('SOURCE_INTEGRITY', 6, 'Report reference is not content-addressed.');
  if (digest(binding) !== report.binding_sha256) fail('SOURCE_SNAPSHOT_STALE', 5, 'Report binding digest differs.');
  const rebuilt = buildDriftReport(engine, { binding_ref: report.binding_ref, against: report.observed_intent.ref, evidence_refs: report.evidence.map(e => e.ref) }, report.observation, report.producer.principal);
  if (canonical(report) !== canonical(rebuilt)) fail('SOURCE_INTEGRITY', 6, 'Report derived inputs or evidence are inconsistent.');
  return { report, binding, source, snapshot };
}
function validateProposal(engine: Engine, p: ReconciliationProposal) {
  const { report, source } = proposalContext(engine, p.report_ref);
  if (p.project_id !== report.project_id || p.repo_id !== report.repo_id || p.report_sha256 !== digest(report) || p.binding_ref !== report.binding_ref || p.binding_sha256 !== report.binding_sha256 || p.observation_sha256 !== report.observation_sha256 || p.intent_sha256 !== digest(report.observed_intent) || p.coverage_sha256 !== digest(report.coverage) || p.evidence_sha256 !== report.evidence_sha256) fail('SOURCE_SNAPSHOT_STALE', 5, 'Proposal no longer pins its exact report inputs.');
  for (const [values, label] of [[p.paths, 'Proposal paths'], [p.items, 'Proposal items'], [p.layer_refs, 'Layer refs'], [p.patch_refs, 'Patch refs'], [p.evidence_refs, 'Evidence refs']] as const) uniqueSorted(values, label);
  const selectedMapping = source.scope.mapping.filter(m => p.items.includes(m.item)), mapped = new Set(selectedMapping.flatMap(m => m.paths));
  if (p.paths.some(path => !mapped.has(path)) || p.items.some(i => !source.scope.items.includes(i) || !selectedMapping.find(m => m.item === i)?.paths.some(path => p.paths.includes(path)))) fail('BLOCK_SCOPE_FORBIDDEN', 4, 'Proposal paths/items exceed their accepted item mapping.');
  if (p.action === 'update_intent' && !p.layer_refs.length) fail('RECONCILIATION_INPUT_REQUIRED', 2, 'Updating intent needs an explicitly supplied owned Layer.');
  for (const layerRef of p.layer_refs) {
    const layer = engine.read(layerRef, 'layer', false);
    if (layer.owner !== p.owner || layer.baseline !== readSourceBinding(engine, p.binding_ref).payload.intent.release_ref) fail('OWNER_FORBIDDEN', 4, 'Intent handoff must use an owned Layer on the exact accepted baseline.');
    const allowedCriteria = new Set(selectedMapping.flatMap(m => m.criteria));
    if (layer.changes.some((c: any) => !p.items.includes(c.block + '/' + c.path)) || layer.acceptance.some((c: any) => !allowedCriteria.has(c.block + '/acceptance.' + c.id))) fail('BLOCK_SCOPE_FORBIDDEN', 4, 'Supplied Layer exceeds proposed items and their declared criteria.');
  }
  for (const patchRef of p.patch_refs) {
    const patch = engine.read(patchRef, 'git-patch-stage'), plan = engine.read(patch.plan_ref, 'git-change-plan');
    if (patch.project_id !== p.project_id || patch.repo_id !== p.repo_id) fail('PROJECT_FORBIDDEN', 4, 'Patch handoff belongs to another source repository.');
    if (plan.binding_ref !== p.binding_ref || plan.target.snapshot_sha256 !== report.observed_intent.snapshot_sha256 || plan.target.candidate_fingerprint !== report.observed_intent.candidate_fingerprint || patch.operations.some((op: any) => !p.paths.includes(op.path))) fail('SOURCE_SNAPSHOT_STALE', 5, 'Patch handoff must match this binding, intended target and proposed paths.');
  }
  for (const evidenceRef of p.evidence_refs) { engine.read(evidenceRef); if (!report.evidence.some(e => e.ref === evidenceRef)) fail('SOURCE_SNAPSHOT_STALE', 5, 'Proposal evidence must be included in the exact reviewed report.'); }
  if (p.supersedes) { const prior = parse(reconciliationProposalSchema, engine.read(p.supersedes, 'reconciliation-proposal')); if (prior.owner !== p.owner || prior.binding_ref !== p.binding_ref) fail('OWNER_FORBIDDEN', 4, 'Cannot supersede another owner or baseline.'); }
  return report;
}
export function executeDrift(engine: Engine, command: string, input: any, context: SecurityContext, issuer: AuthorityIssuer, host?: DriftHostProof) {
  if (command === 'drift.check') return executeDriftCheck(engine, input, context, issuer, host);
  if (command === 'drift.propose') {
    const request = parse(proposalInputSchema, input), { report, source, snapshot } = proposalContext(engine, request.report_ref);
    if (report.project_id !== context.project_id || digest(report) !== request.expected_report_sha256) fail('SOURCE_SNAPSHOT_STALE', 5, 'Proposal must use the exact project/report digest.');
    authorizeSource(issuer, context, command, report.repo_id, request.paths, snapshot, source.scope);
    const { expected_report_sha256: _, ...body } = request;
    const data: ReconciliationProposal = { ...body, format: 'reconciliation-proposal/1', project_id: report.project_id, repo_id: report.repo_id, report_sha256: digest(report), binding_ref: report.binding_ref, binding_sha256: report.binding_sha256, owner: context.principal_id, observation_sha256: report.observation_sha256, intent_sha256: digest(report.observed_intent), coverage_sha256: digest(report.coverage), evidence_sha256: report.evidence_sha256, state: 'proposed' };
    validateProposal(engine, data); const proposalRef = 'reconciliation-proposal@' + digest(data); engine.store(proposalRef, 'reconciliation-proposal', data); return { ref: proposalRef, state: 'proposed', action: data.action, completion: false };
  }
  if (command !== 'drift.review') fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown drift operation.');
  const request = parse(z.object({ proposal_ref: ref, expected_proposal_sha256: hash, decision: z.enum(['approve_plan', 'request_changes', 'reject', 'defer']), rationale: text, questions: z.array(text).max(256) }).strict(), input), proposal = parse(reconciliationProposalSchema, engine.read(request.proposal_ref, 'reconciliation-proposal'));
  if (proposal.project_id !== context.project_id || digest(proposal) !== request.expected_proposal_sha256 || request.proposal_ref !== 'reconciliation-proposal@' + digest(proposal)) fail('SOURCE_SNAPSHOT_STALE', 5, 'Review must use the exact content-addressed proposal digest.');
  const report = validateProposal(engine, proposal), { source, snapshot } = proposalContext(engine, proposal.report_ref), approved = request.decision === 'approve_plan';
  const scope = authorizeSource(issuer, context, command, report.repo_id, proposal.paths, snapshot, source.scope, approved) ?? sourceAuthorityScope(snapshot, source.scope);
  let fresh: string|null = null;
  if (approved) {
    if (proposal.action === 'defer' || proposal.action === 'reject') fail('INVALID_RECORD', 2, 'A defer/reject proposal cannot be marked approved_plan.');
    if (proposal.questions.length || request.questions.length || !report.coverage.scope_complete) fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Plan approval requires complete declared scope and no unresolved questions.');
    if (proposal.action === 'accept_code' && !report.coverage.acceptance_complete) fail('ACCEPTANCE_REQUIRED', 6, 'Accept-code planning requires complete bound application acceptance.');
    const observed = driftHostObservation(host);
    if (observed.trust !== 'local-measurement' || report.producer.trust !== 'local-measurement' || observed.coherence !== 'stable' || digest(observed) !== report.observation_sha256) fail('SOURCE_SNAPSHOT_STALE', 5, 'Source observation changed or was never locally measured.');
    fresh = digest(observed);
  }
  const state = { approve_plan: 'approved_plan', request_changes: 'changes_requested', reject: 'rejected', defer: 'deferred' }[request.decision] as ReconciliationReview['state'];
  const data: ReconciliationReview = { format: 'reconciliation-review/1', project_id: report.project_id, repo_id: report.repo_id, proposal_ref: request.proposal_ref, proposal_sha256: digest(proposal), report_ref: proposal.report_ref, report_sha256: digest(report), binding_ref: report.binding_ref, binding_sha256: report.binding_sha256, decision: request.decision, responsible_scope: scope, reviewer: context.principal_id, policy_version: context.policy_version, trust: 'local-fixture', rationale: request.rationale, questions: request.questions, fresh_observation_sha256: fresh, state };
  const reviewRef = 'reconciliation-review@' + digest(data); engine.store(reviewRef, 'reconciliation-review', data); return { ref: reviewRef, state, action: proposal.action, completion: false, behavior_verified: false, handoff: proposal.action === 'update_intent' ? 'existing-layer-release-workflow' : proposal.action === 'restore_intent' || proposal.action === 'accept_code' ? 'reviewed-git-adoption-workflow' : 'fresh-bound-evidence' };
}
export function driftArchiveReferences(type: string, data: any): string[] {
  if (type === 'drift-report') return driftReportArchiveReferences(data);
  if (type === 'reconciliation-proposal') { const p = parse(reconciliationProposalSchema, data); return [...new Set([p.report_ref, p.binding_ref, ...p.layer_refs, ...p.patch_refs, ...p.evidence_refs, ...(p.supersedes ? [p.supersedes] : [])])].sort(); }
  if (type === 'reconciliation-review') { const r = parse(reconciliationReviewSchema, data); return [r.proposal_ref, r.report_ref, r.binding_ref].sort(); }
  return [];
}
export function verifyDriftHistory(records: Records, projectId: string) {
  verifyDriftReportHistory(records, projectId); const engine = new Engine(records, {}, { projectId });
  for (const [ref, stored] of Object.entries(records)) {
    if (stored.type === 'reconciliation-proposal') { const p = parse(reconciliationProposalSchema, stored.data); if (p.project_id !== projectId || ref !== 'reconciliation-proposal@' + digest(p)) fail('SOURCE_INTEGRITY', 6, 'Historical proposal identity differs.'); validateProposal(engine, p); }
    if (stored.type === 'reconciliation-review') {
      const r = parse(reconciliationReviewSchema, stored.data), p = parse(reconciliationProposalSchema, engine.read(r.proposal_ref, 'reconciliation-proposal')), report = validateProposal(engine, p), { snapshot, source } = proposalContext(engine, p.report_ref), state = { approve_plan: 'approved_plan', request_changes: 'changes_requested', reject: 'rejected', defer: 'deferred' }[r.decision];
      if (r.project_id !== projectId || ref !== 'reconciliation-review@' + digest(r) || r.proposal_sha256 !== digest(p) || r.report_ref !== p.report_ref || r.report_sha256 !== digest(report) || r.binding_ref !== p.binding_ref || r.binding_sha256 !== p.binding_sha256 || r.repo_id !== p.repo_id || r.state !== state || r.responsible_scope !== sourceAuthorityScope(snapshot, source.scope)) fail('SOURCE_INTEGRITY', 6, 'Historical review binding differs.');
      if (r.decision === 'approve_plan' && (r.questions.length || p.questions.length || !report.coverage.scope_complete || r.fresh_observation_sha256 !== report.observation_sha256 || report.producer.trust !== 'local-measurement' || !snapshot.authorities.scopes.some(a => a.block === r.responsible_scope && a.selectors.includes(r.reviewer)) || (p.action === 'accept_code' && !report.coverage.acceptance_complete) || ['defer', 'reject'].includes(p.action))) fail('SOURCE_INTEGRITY', 6, 'Historical plan approval lacks its recorded authority or exact observation.');
      if (r.decision !== 'approve_plan' && r.fresh_observation_sha256 !== null) fail('SOURCE_INTEGRITY', 6, 'Historical nonapproval cannot claim fresh source approval.');
    }
  }
}
