import { z } from 'zod';
import { Engine, snapshotFromRelease, normalizeComposition, normalizeLayer } from './core.js';
import { MODEL, canonical, digest, fail, parse, normalizeSnapshot, snapshotSchema, compositionSchema, layerSchema, approvalSchema, evidenceSchema, boundEvidenceSchema, type Records } from './model.js';
import { sourceHashSchema as hash, sourceRefSchema as ref, sourceTextSchema as text, gitObservationSchema, readSourceBinding, readBindingSource, sourceBindingArchiveReferences, validateGitObservation, verifySourceBindingHistory } from './source-binding.js';
import { driftReportSchema } from './source-drift.js';
import { reconciliationProposalSchema, reconciliationReviewSchema, driftArchiveReferences, verifyDriftHistory } from './reconciliation.js';
import { acceptanceSchema, observationSchema, gitCheckerSchema, targetSchema, GIT_ADOPTION_SCHEMAS } from './git-record-schemas.js';
import { gitAdoptionArchiveReferences, verifyGitAdoptionHistory } from './git-adoption.js';

const pin = z.object({ ref: ref.max(256), sha256: hash }).strict();
const producer = acceptanceSchema.shape.producer;

// Exact legacy semantic shapes, matching the retained core/backup formats.
// These are private R1 readers, not new runtime records or version adapters.
const legacyReleaseSchema = snapshotSchema.extend({ baseline: ref, candidate: hash,
  provenance: z.record(z.string(), z.array(ref)), lineage: z.array(ref), resolutions: z.array(ref),
  acceptance_manifest: z.array(z.unknown()), validation: ref, approvals: z.array(ref),
  state: z.literal('validated'), trust: z.literal('local-fixture') }).strict();
const semanticSchemas: Record<string, z.ZodType> = {
  composition: compositionSchema, layer: layerSchema,
  validation: z.object({ candidate: hash, target: ref, realization: ref,
    evidence: z.union([evidenceSchema, boundEvidenceSchema]), evidence_digest: hash,
    trust: z.literal('local-fixture-import') }).strict(),
  approval: approvalSchema.extend({ principal: text, trust: z.literal('local-fixture'), ref }).strict(),
  resolution: z.object({ layer: ref, proposal_index: z.number().int().nonnegative(),
    payload: layerSchema.shape.resolution_proposals.element, approvals: z.array(ref),
    sealed_by: text, trust: z.literal('local-fixture') }).strict(),
  realization: z.object({ protocol_version: z.literal('1'), model_version: z.literal(MODEL),
    target: ref, candidate: hash, profile_id: text, profile: hash, output_tree: hash,
    files: z.record(z.string(), z.string()), coverage: z.array(z.unknown()),
    reverse_links: z.record(z.string(), z.array(z.string())), trust: z.literal('local-template'),
    format: z.literal('strata-realization/2').optional(), checker_sha256: hash.optional(),
    fixture_sha256: hash.optional(), oracle_sha256: hash.optional(), oracle: z.unknown().optional() }).strict(),
};

function validateSemanticShape(exact: string, type: string, data: any) {
  if (type !== 'release' && !Object.hasOwn(semanticSchemas, type)) return;
  if (data?.model_version !== undefined && data.model_version !== MODEL)
    fail('UNSUPPORTED_MODEL_VERSION', 8, 'R1 semantic predecessors must retain the explicit v0.1 model.');
  if (type === 'release') parse(data?.baseline === undefined ? snapshotSchema : legacyReleaseSchema, data);
  else parse(semanticSchemas[type], data);
  if (type === 'composition' || type === 'layer' || type === 'release' && data.baseline === undefined)
    same(exact, `${data.id}@${data.revision}`, 'Retained named semantic reference differs from its record identity.');
}

/** Proposed portable contract only; deliberately absent from runtime schema/dispatch maps. */
export const r1CompletionReceiptSchema = z.object({
  format: z.literal('reconciliation-completion-receipt/1'), model_version: z.literal(MODEL),
  action: z.literal('revalidate'), project_id: text, repo_id: text,
  proposal: pin, review: pin, report: pin, binding: pin, target: targetSchema,
  basis_evidence: pin, evidence: pin, observation: gitObservationSchema,
  acceptance_contract_sha256: hash, checker: gitCheckerSchema, producer,
  outcome: z.literal('revalidated-selected-evidence'),
  git_finalization_ref: z.null(), successor_binding_ref: z.null(),
}).strict();
export type R1CompletionReceipt = z.infer<typeof r1CompletionReceiptSchema>;

/** Caller-selected pins, supplied separately from the untrusted receipt. No authority is issued. */
export const r1CompletionExpectationSchema = z.object({
  project_id: text, repo_id: text, review: pin, basis_evidence: pin,
  observation_sha256: hash,
}).strict();
export type R1CompletionExpectation = z.infer<typeof r1CompletionExpectationSchema>;

function same(a: unknown, b: unknown, message: string) {
  if (canonical(a) !== canonical(b)) fail('R1_PIN_MISMATCH', 6, message);
}

// Follow only record edges, never strings in rationale, source, or oracle data.
function semanticReferences(type: string, data: any, records: Records): string[] {
  const edge = (exact: string, types: string[]) => {
    if (!records[exact]?.published || !types.includes(records[exact].type))
      fail('R1_CLOSURE_REQUIRED', 6, 'R1 semantic predecessor has missing or substituted record type.', { ref: exact });
    return exact;
  };
  switch (type) {
    case 'release': return data.baseline ? [edge(data.baseline, ['release']), edge(data.validation, ['validation']),
      ...data.approvals.map((r: string) => edge(r, ['approval'])), ...data.lineage.map((r: string) => edge(r, ['layer'])),
      ...data.resolutions.map((r: string) => edge(r, ['resolution'])),
      ...(Object.values(data.provenance).flat() as string[]).map(r => edge(r, ['release', 'layer']))] : [];
    case 'composition': return [edge(data.baseline, ['release']), ...[...data.proposals, ...data.selected].map((r: string) => edge(r, ['layer'])), ...data.resolutions.map((r: string) => edge(r, ['resolution']))];
    case 'layer': return [edge(data.baseline, ['release']), ...[...data.requires_layers, ...data.read_set.map((r: any) => r.layer)].map((r: string) => edge(r, ['layer'])), ...(data.derived_from ? [edge(data.derived_from.against, ['composition', 'release'])] : [])];
    case 'validation': return [edge(data.target, ['composition', 'release']), edge(data.realization, ['realization'])];
    case 'realization': return [edge(data.target, ['composition', 'release'])];
    case 'resolution': return [edge(data.layer, ['layer']), ...data.approvals.map((r: string) => edge(r, ['approval']))];
    case 'authoring-review': return [edge(data.draft_ref, ['layer'])];
    case 'approval': return []; // Legacy approval targets are fingerprints, not refs.
    default: return [];
  }
}

export function retainedR1Closure(records: Records, roots: string[]): Records {
  const closure: Records = {}, pending = [...roots]; let count = 0;
  while (pending.length) {
    const exact = pending.pop()!;
    if (Object.hasOwn(closure, exact)) continue;
    if (count++ >= 4096) fail('R1_CLOSURE_LIMIT', 8, 'R1 retained closure exceeds 4096 records.');
    const stored = records[exact];
    if (!stored || !stored.published) fail('R1_CLOSURE_REQUIRED', 6, 'R1 requires published retained record closure.', { ref: exact });
    validateSemanticShape(exact, stored.type, stored.data);
    if (['source-snapshot', 'source-binding', 'drift-report', 'reconciliation-proposal', 'reconciliation-review'].includes(stored.type) || stored.type.startsWith('git-')) {
      if (exact !== stored.type + '@' + digest(stored.data)) fail('R1_PIN_MISMATCH', 6, 'Retained record is not exactly content-addressed.');
    }
    if (stored.type === 'git-change-plan' && stored.data.format !== 'git-change-plan/1')
      fail('R1_UNSUPPORTED_CONTRACT', 8, 'R1 requires the retained legacy unbridged application contract.');
    if (stored.type in GIT_ADOPTION_SCHEMAS)
      parse(GIT_ADOPTION_SCHEMAS[stored.type as keyof typeof GIT_ADOPTION_SCHEMAS] as z.ZodType, stored.data);
    if (['validation', 'realization', 'resolution'].includes(stored.type) || stored.type === 'release' && stored.data.baseline) {
      same(exact, stored.type + '@' + digest(stored.data).slice(0, 24), 'Retained legacy semantic digest reference differs.');
    }
    if (stored.type === 'approval') {
      const { ref: self, ...body } = stored.data;
      same([exact, self], ['approval@' + digest(body).slice(0, 24), exact], 'Retained legacy approval digest reference differs.');
    }
    closure[exact] = structuredClone(stored);
    pending.push(...sourceBindingArchiveReferences(stored.type, stored.data),
      ...driftArchiveReferences(stored.type, stored.data), ...gitAdoptionArchiveReferences(stored.type, stored.data),
      ...semanticReferences(stored.type, stored.data, records));
  }
  return closure;
}

export function verifyR1SemanticHistory(engine: Engine) {
  const targets = new Map<string, ReturnType<Engine['target']>>();
  const target = (exact: string) => {
    if (!targets.has(exact)) targets.set(exact, engine.target(exact));
    return targets.get(exact)!;
  };
  for (const stored of Object.values(engine.records)) {
    const data = stored.data;
    if (stored.type === 'release') same(snapshotFromRelease(data), normalizeSnapshot(snapshotFromRelease(data)), 'Retained Release snapshot is not normalized.');
    if (stored.type === 'composition') same(data, normalizeComposition(data), 'Retained Composition is not normalized.');
    if (stored.type === 'layer') same(data, normalizeLayer(data, snapshotFromRelease(engine.read(data.baseline, 'release'))), 'Retained Layer is not normalized.');
    if (stored.type === 'realization' || stored.type === 'validation') {
      same(data.candidate, target(data.target).fingerprint, 'Historical semantic candidate differs from its exact retained target.');
      if (stored.type === 'realization') same(data, engine.realize(data.target, data.profile_id), 'Historical realization differs from its exact candidate/profile.');
      else same(data, engine.checkValidation(data.target, data.realization, data.evidence), 'Historical validation differs from its retained candidate/realization/evidence.');
    }
    if (stored.type === 'release' && data.baseline !== undefined) {
      const validation = engine.read(data.validation, 'validation'), composition = engine.read(validation.target, 'composition'), evaluated = target(validation.target);
      same([data.baseline, data.candidate, snapshotFromRelease(data), data.provenance, data.acceptance_manifest, data.resolutions, data.lineage],
        [composition.baseline, evaluated.fingerprint, evaluated.snapshot, evaluated.provenance, evaluated.obligations, composition.resolutions,
          [...new Set([...(engine.read(data.baseline, 'release').lineage ?? []), ...composition.selected])].sort()],
        'Historical Release differs from its retained validated candidate.');
      for (const selected of data.approvals) {
        const approval = engine.read(selected, 'approval');
        same([approval.target, approval.evidence_digest], [data.candidate, validation.evidence_digest], 'Historical Release approval belongs to another candidate/evidence.');
      }
    }
    if (stored.type === 'resolution') {
      const layer = engine.read(data.layer, 'layer');
      same(data.payload, layer.resolution_proposals[data.proposal_index] ?? null, 'Historical Resolution differs from its exact Layer proposal.');
      for (const selected of data.approvals) {
        const approval = engine.read(selected, 'approval');
        same([approval.kind, approval.target], ['resolution', digest({ layer: data.layer, proposal_index: data.proposal_index, payload: data.payload })], 'Historical Resolution approval belongs to another decision.');
      }
    }
  }
}

/**
 * Validate one bounded revalidate contract against retained history and independent pins.
 * Never stores a receipt, mutates completion, measures disk, runs a checker, or resolves grants.
 */
export function validateR1CompletionReceipt(input: unknown, records: Records, expectedInput: unknown) {
  const receipt = parse(r1CompletionReceiptSchema, input), expected = parse(r1CompletionExpectationSchema, expectedInput);
  same([receipt.project_id, receipt.repo_id, receipt.review, receipt.basis_evidence, digest(receipt.observation)],
    [expected.project_id, expected.repo_id, expected.review, expected.basis_evidence, expected.observation_sha256],
    'Receipt differs from the independently selected review, evidence, source observation or repository.');

  const closure = retainedR1Closure(records, [receipt.review.ref, receipt.evidence.ref]);
  const engine = new Engine(closure, {}, { projectId: expected.project_id });
  verifyR1SemanticHistory(engine);
  const readPin = (selected: z.infer<typeof pin>, type: string) => {
    const data = engine.read(selected.ref, type);
    same(digest(data), selected.sha256, 'Pinned record digest differs.');
    return data;
  };
  const review = parse(reconciliationReviewSchema, readPin(receipt.review, 'reconciliation-review'));
  same(receipt.proposal, { ref: review.proposal_ref, sha256: review.proposal_sha256 }, 'Completion must retain the exact reviewed proposal.');
  same(receipt.report, { ref: review.report_ref, sha256: review.report_sha256 }, 'Completion must retain the exact reviewed report.');
  same(receipt.binding, { ref: review.binding_ref, sha256: review.binding_sha256 }, 'Completion must retain the exact reviewed binding.');
  const proposal = parse(reconciliationProposalSchema, readPin(receipt.proposal, 'reconciliation-proposal'));
  const report = parse(driftReportSchema, readPin(receipt.report, 'drift-report'));
  const binding = readSourceBinding(engine, receipt.binding.ref), source = readBindingSource(engine, binding);
  if (review.decision !== 'approve_plan' || review.state !== 'approved_plan' || proposal.action !== 'revalidate')
    fail('R1_APPROVED_ACTION_REQUIRED', 6, 'R1 requires an approved revalidate plan.');
  if (proposal.layer_refs.length || proposal.patch_refs.length)
    fail('R1_UNSUPPORTED_HANDOFF', 8, 'This revalidate slice does not close Layer or patch handoffs.');
  same(proposal.items, source.scope.items, 'R1 requires the complete declared selected item scope.');
  same(proposal.paths, [...new Set(source.scope.mapping.flatMap(m => m.paths))].sort(), 'R1 requires the complete mapped source scope.');
  same([review.project_id, review.repo_id], [expected.project_id, expected.repo_id], 'Approved review belongs to another project or repository.');

  const releaseRef = binding.payload.intent.release_ref, release = engine.read(releaseRef, 'release'), target = engine.target(releaseRef);
  const exactTarget = { ref: releaseRef, record_sha256: digest(release), snapshot_sha256: digest(target.snapshot), candidate_fingerprint: target.fingerprint };
  same(receipt.target, exactTarget, 'Revalidation cannot replace the accepted Release.');
  same(report.observed_intent, exactTarget, 'Approved report must target the unchanged accepted Release.');
  const observation = validateGitObservation(receipt.observation, source.scope);
  same(observation, report.observation, 'Source observation changed after plan approval.');
  if (observation.trust !== 'local-measurement' || observation.coherence !== 'stable' || !report.coverage.scope_complete)
    fail('R1_SOURCE_REQUIRED', 6, 'Revalidation needs the recorded stable local observation and complete selected scope.');

  const assessed = report.evidence.find(e => e.ref === receipt.basis_evidence.ref);
  if (!proposal.evidence_refs.includes(receipt.basis_evidence.ref) || assessed?.kind !== 'application' || assessed.record_sha256 !== receipt.basis_evidence.sha256)
    fail('R1_REVIEWED_EVIDENCE_REQUIRED', 6, 'Named checker/fixture/oracle evidence must already be retained in the exact approved plan.');
  const readEvidence = (selected: z.infer<typeof pin>) => {
    const type = closure[selected.ref]?.type;
    if (type !== 'git-acceptance' && type !== 'git-application-observation') fail('R1_EVIDENCE_REQUIRED', 6, 'R1 needs existing v1 application evidence, not a plan, profile validation or finalization.');
    const data = readPin(selected, type);
    return type === 'git-acceptance' ? parse(acceptanceSchema, data) : parse(observationSchema, data);
  };
  const before = readEvidence(receipt.basis_evidence), after = readEvidence(receipt.evidence);
  if (receipt.evidence.ref === receipt.basis_evidence.ref || report.evidence.some(e => e.ref === receipt.evidence.ref) || after.observations_sha256 === before.observations_sha256)
    fail('R1_FRESH_EVIDENCE_REQUIRED', 6, 'The approved plan and its existing observations are not fresh revalidation evidence.');
  same([after.project_id, after.repo_id, after.base_source_ref, after.target, after.result_manifest_sha256],
    [expected.project_id, expected.repo_id, binding.payload.source_ref, exactTarget, observation.manifest_sha256],
    'Fresh evidence differs from the exact source, repository or accepted target.');
  same([after.plan_ref, after.stage_ref, after.result_tree_oid, after.acceptance_contract_sha256, after.checker, after.producer],
    [before.plan_ref, before.stage_ref, before.result_tree_oid, before.acceptance_contract_sha256, before.checker, before.producer],
    'Revalidation changed the reviewed application contract, staged source or recorded producer trust.');
  same([receipt.acceptance_contract_sha256, receipt.checker, receipt.producer],
    [after.acceptance_contract_sha256, after.checker, after.producer], 'Receipt must disclose the exact evidence contract and producer trust.');
  const plan = engine.read(after.plan_ref, 'git-change-plan');
  if (plan.format !== 'git-change-plan/1') fail('R1_UNSUPPORTED_CONTRACT', 8, 'R1 revalidation requires the retained legacy unbridged application contract.');
  same(plan.binding_ref, receipt.binding.ref, 'Application plan belongs to another accepted binding.');
  const required = report.coverage.criteria.map(criterion_ref => {
    const [block, id] = criterion_ref.split('/acceptance.'), c = target.snapshot.blocks[block]?.acceptance[id];
    if (!c) fail('R1_EVIDENCE_REQUIRED', 6, 'Active scoped criterion is missing.');
    return { criterion_ref, check: c.check, version: c.version, fixture: c.fixture, method: c.method };
  });
  same(plan.criteria, required, 'Frozen application contract must retain every active selected criterion.');
  const results = after.results.map(({ passed, reviewer, ...row }) => row).sort((a, b) => a.criterion_ref.localeCompare(b.criterion_ref));
  same(results, required, 'Fresh evidence needs exactly one result for every active selected criterion.');
  same(after.regressions.map(r => r.id).sort(), plan.regressions, 'Fresh evidence must retain every frozen regression.');
  if (after.results.some(r => !r.passed || (r.method === 'review' ? !r.reviewer : r.reviewer !== null)) || after.regressions.some(r => !r.passed))
    fail('R1_ACCEPTANCE_INCOMPLETE', 6, 'Every frozen criterion and regression must pass with the required review labels.');

  // Recompute historical plan approval and transitive source/evidence provenance.
  // This is historical local-fixture integrity, not current S0 authentication or permission.
  verifySourceBindingHistory(closure, expected.project_id);
  verifyDriftHistory(closure, expected.project_id);
  verifyGitAdoptionHistory(closure, expected.project_id);
  return {
    valid: true as const, validation_only: true as const, completion: false as const,
    action: receipt.action, receipt_sha256: digest(receipt), review_ref: receipt.review.ref,
    evidence_ref: receipt.evidence.ref, producer: structuredClone(after.producer),
    source_binding_advanced: false as const, behavior_verified: false as const,
    limitations: ['Retained synthetic/local evidence does not authenticate a fresh execution or current authority.',
      'Validation covers the declared selected criteria; it does not establish whole-application equivalence.',
      'Revalidation establishes no Git finalization, owner-commit acceptance or successor source association.'],
  };
}
