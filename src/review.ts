import { digest, fail, type Layer } from './model.js';
import { completionProjection,reconciliationCompletionSchema } from './revalidation.js';

export const REVIEW_TYPES = ['layer', 'validation', 'authoring-review','source-snapshot','source-binding','git-change-plan','git-patch-stage','git-acceptance','git-application-observation','git-apply-review','git-apply-receipt','git-finalization','drift-report','reconciliation-proposal','reconciliation-review','revalidation-auth','git-revalidation-run','revalidation-criterion-review','reconciliation-completion'] as const;
export type ReviewType = typeof REVIEW_TYPES[number];

// A read projection of inspected records. It neither writes records nor verifies execution.
export function reviewRecord(type: ReviewType, ref: string, record: any) {
  const assertions: any[] = [], observations: any[] = [], unverified: string[] = [];
  const subject = { type, ref, record_sha256: digest(record) };
  if(type==='reconciliation-completion') {
    const d=reconciliationCompletionSchema.parse(record);
    observations.push({kind:'historical_authenticated_completion',...completionProjection(ref,d),historical_review_trust:d.bridge.historical_review_trust,historical_basis_producer:d.bridge.historical_producer,completed_at:d.completed_at});
    unverified.push(...d.limitations,'Current source and authority were not checked by this historical inspection.');
  } else if(type==='revalidation-auth'||type==='git-revalidation-run'||type==='revalidation-criterion-review') {
    observations.push({source_ref:ref,kind:'historical_authenticated_revalidation',record,live_source_checked:false});
    if(type==='revalidation-criterion-review')assertions.push(...record.assertions.map((row:any)=>({...row,principal:record.reviewer,kind:'explicit_current_criterion_assertion'})));
    unverified.push('This historical inspection executes nothing and grants no live authority.');
  } else if (type === 'layer') {
    const layer = record as Layer;
    assertions.push({ source_ref: ref, principal: layer.owner, kind: 'proposed_intent', statement: layer.intent });
    for (const change of layer.changes) assertions.push({ source_ref: ref, principal: layer.owner, kind: 'proposed_change', item: `${change.block}/${change.path}`, value: change.value });
    for (const acceptance of layer.acceptance) assertions.push({ source_ref: ref, principal: layer.owner, kind: 'proposed_acceptance', item: `${acceptance.block}/acceptance.${acceptance.id}`, statement: acceptance.criterion.statement });
    for (const resolution of layer.resolution_proposals) assertions.push({ source_ref: ref, principal: layer.owner, kind: 'proposed_resolution', proposal: resolution });
    for (const trace of layer.derived_from?.traceability ?? []) assertions.push({ source_ref: ref, principal: layer.owner, kind: 'supplied_traceability', ...trace });
    observations.push({ source_ref: ref, kind: 'recorded_provenance', baseline: layer.baseline, revision: layer.revision, owner: layer.owner,
      source_digest: layer.derived_from?.source_digest ?? null, against: layer.derived_from?.against ?? null });
    unverified.push('Proposed behavior and supplied traceability have not been checked by this review. A supplied classification of observed remains an author assertion.', ...(layer.derived_from?.questions ?? []));
  } else if (type === 'validation') {
    const evidence = record.evidence;
    const binding = { validation_ref: ref, target_ref: record.target, candidate: record.candidate, realization_ref: record.realization,
      profile: evidence.profile, output_tree: evidence.output_tree, evidence_digest: record.evidence_digest,
      ...('format' in evidence ? { checker_sha256: evidence.checker_sha256, fixture_sha256: evidence.fixture_sha256, oracle_sha256: evidence.oracle_sha256 } : {}) };
    observations.push({ source_ref: ref, kind: 'recorded_binding', ...binding, trust: record.trust });
    for (const result of evidence.results) {
      const entry = { source_ref: ref, ...binding, ...result, executor: evidence.executor, trust: record.trust, execution_authenticated: false };
      if (result.method === 'review') assertions.push({ ...entry, kind: 'fixture_review_attestation' });
      else observations.push({ ...entry, kind: 'imported_check_result', observation: 'The imported fixture evidence reports this check outcome; this command did not run the check.' });
    }
    unverified.push('Execution and producer identity are not independently authenticated. Hashes bind content; they do not prove a test ran.',
      'Fixture review attestations do not establish independent or human review.',
      'Behavior beyond the named checks, current on-disk artifact bytes, and current release approval readiness were not checked.');
  } else if (type === 'authoring-review') {
    assertions.push({ source_ref: ref, kind: 'fixture_authoring_attestation', principal: record.reviewer, accepted: record.accepted, statement: record.rationale, trust: record.trust });
    observations.push({ source_ref: ref, kind: 'recorded_binding', draft_ref: record.draft_ref, draft_digest: record.draft_digest, checklist: record.checklist });
    unverified.push('This records a local fixture authoring attestation, without authenticating human consent or establishing runtime behavior. Current draft bytes were not rechecked.');
  } else if(type.startsWith('git-')||type.startsWith('source-')||type.startsWith('drift-')||type.startsWith('reconciliation-')) {
    observations.push({source_ref:ref,kind:'recorded_implementation_binding',record_sha256:subject.record_sha256,record});
    if(type==='git-acceptance')for(const result of record.results) (result.method==='review'?assertions:observations).push({source_ref:ref,kind:result.method==='review'?'fixture_review_attestation':'imported_application_check',...result,producer:record.producer});
    if(type==='git-apply-review'||type==='source-binding')assertions.push({source_ref:ref,kind:'local_implementation_acceptance',principal:record.principal??record.acceptance?.principal,accepted:record.accepted??record.acceptance?.accepted});
    unverified.push('This review reads immutable records; it does not reopen the Git checkout or run acceptance checks.','Application evidence and review attestations are local fixture claims; hashes do not authenticate execution or human consent.');
  } else fail('UNSUPPORTED_CAPABILITY', 8, 'Unsupported review record type.');
  return { format: 'strata-review/1', subject, assertions, observations, unverified, execution_checked: false };
}
