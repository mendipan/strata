import { z } from 'zod';
import { BLOCK_MODEL, bytesDigest, canonical, digest, fail, parse, type Records } from './model.js';
import { Engine, snapshotFromRelease } from './core.js';
import { verifyRealization, type Realization } from './profile.js';
import { validateRecords } from './explorer/validate.js';
import { mediationArchiveReferences } from './mediation.js';
import { artifactBundle, MAX_GIT_RESPONSE_BYTES } from './artifacts-git.js';
import { CHECKLIST_CEILINGS, type AppPins } from './checklist-cloud-limits.js';
import { checklistSubrequestQualification } from './checklist-cloud-config.js';
export { CHECKLIST_CEILINGS, type AppPins } from './checklist-cloud-limits.js';

// Application reservations, never a Cloudflare invoice cap. No old demo budgets are widened.
export const LOCATION_CLAIM = 'Node authors, reviews, measures and publishes; Cloudflare archives the same published history and observes a fresh instance of its exact generated module.';
const hash = z.string().regex(/^[a-f0-9]{64}$/), ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
export const targetSchema = z.object({ account_id: z.string().regex(/^[a-f0-9]{32}$/), namespace: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  project_id: z.string().min(1).max(128), repository: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  app_worker: z.string().regex(/^[a-z0-9-]{1,63}$/), workflow_worker: z.string().regex(/^[a-z0-9-]{1,63}$/),
  workflow: z.string().regex(/^[a-z0-9-]{1,63}$/), instance_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), run_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict();
export type ChecklistTarget = z.infer<typeof targetSchema>;
const storedSchema = z.object({ type: z.string(), published: z.literal(true), data: z.record(z.string(), z.unknown()) }).strict();
export const handoffSchema = z.object({ format: z.literal('strata-checklist-cloud-handoff/1'),
  evidence_kind: z.enum(['published-local-history', 'synthetic-test-only']), source_commit: z.string().regex(/^[a-f0-9]{40}$/),
  project_id: z.string().min(1), release_ref: ref, realization_ref: ref,
  records: z.record(ref, storedSchema), record_hashes: z.record(ref, hash),
  module_sha256: hash, output_tree: hash, producer: z.object({ lane_id: hash, summary_sha256: hash, registry_sha256: hash, manifest_sha256: hash }).strict(),
  expectations: z.object({ capacity: z.literal(7), visible_audit_events: z.literal(10), unicode_observer_audit_events: z.literal(11) }).strict() }).strict();
export type ChecklistHandoff = z.infer<typeof handoffSchema>;
export type PreparedChecklist = { format: 'strata-checklist-cloud-preparation/1'; live_authorized: false;
  input: ChecklistHandoff; input_sha256: string; target: ChecklistTarget; target_sha256: string; pins: AppPins;
  qualification: ReturnType<typeof calculateChecklistQualification>; location_claim: typeof LOCATION_CLAIM };
const refuse = (message: string): never => fail('CHECKLIST_CONTRACT_REFUSED', 6, message);

export function verifyChecklistHandoff(raw: unknown, allowSynthetic = false): { input: ChecklistHandoff; realization: Realization } {
  const input = parse(handoffSchema, raw);
  if (input.evidence_kind === 'synthetic-test-only' && !allowSynthetic) refuse('Synthetic fixtures cannot prepare a live Release package.');
  const records = input.records as Records;
  if (Object.keys(records).length > CHECKLIST_CEILINGS.records || Buffer.byteLength(canonical(records)) > CHECKLIST_CEILINGS.json_bytes) refuse('Published history exceeds the fixed continuation envelope.');
  if (canonical(Object.keys(records).sort()) !== canonical(Object.keys(input.record_hashes).sort())) refuse('Exact record hash inventory required.');
  for (const [key, record] of Object.entries(records)) if (digest(record.data) !== input.record_hashes[key]) refuse('Published record bytes changed.');
  // Reuse the product's read-only v0.3 schema/ref/closure validator; never activate an issuer.
  validateRecords(records, input.project_id, BLOCK_MODEL);
  for (const record of Object.values(records)) {
    if (record.type === 'asset') refuse('Binary assets are outside this collection continuation.');
    for (const needed of mediationArchiveReferences(record.type, record.data)) if (!records[needed]?.published) refuse('Published mediation history is incomplete.');
    if (record.type === 'layer' && (record.data.changes.length || record.data.created_blocks.length || record.data.acceptance.length)) {
      const review = Object.values(records).find(r => r.type === 'authoring-review' && r.data.draft_ref === `${record.data.id}@${record.data.revision}` && r.data.draft_digest === digest(record.data) && r.data.accepted);
      const acceptedReview = review ?? refuse('Published behavioral Layer has no exact accepted authoring review.');
      const historical = new Engine(records, {}, {projectId:input.project_id,historical:true});
      historical.checkAuth(acceptedReview.data.auth_receipt,acceptedReview.data.reviewer,['content.review']);
    }
  }
  const release = records[input.release_ref];
  if (release?.type !== 'release' || release.data.format !== 'release/3' || release.data.state !== 'validated' || release.data.trust !== 'host-authenticated') refuse('An actual published v0.3 Release is required.');
  const v = records[release.data.validation];
  if (v?.type !== 'validation' || v.data.realization !== input.realization_ref || v.data.candidate !== release.data.candidate || digest(v.data.evidence) !== v.data.evidence_digest) refuse('Release/validation/realization linkage changed.');
  const realization = verifyRealization(records[input.realization_ref]?.data);
  if (canonical(realization.oracle?.expected) !== canonical({max_items:7,max_title_length:20,audit:true})) refuse('Only the approved literal seven-entry/twenty-code-point/audit continuation fits this package.');
  if (records[input.realization_ref]?.type !== 'realization' || realization.profile_id !== 'collection-host/1' || realization.model_version !== BLOCK_MODEL || realization.target !== v.data.target || realization.candidate !== release.data.candidate ||
      input.output_tree !== realization.output_tree || bytesDigest(realization.files['collection.mjs']) !== input.module_sha256 || canonical(Object.keys(realization.files).sort()) !== canonical(['README.md', 'collection.mjs'])) refuse('Selected output or module pins changed.');
  const engine = new Engine(records, {}, { projectId: input.project_id, modelVersion: BLOCK_MODEL, historical: true });
  const evaluation = engine.target(v.data.target);
  if (evaluation.fingerprint !== release.data.candidate || canonical(evaluation.snapshot) !== canonical(snapshotFromRelease(release.data)) || canonical(evaluation.obligations) !== canonical(release.data.acceptance_manifest) || canonical(evaluation.provenance) !== canonical(release.data.provenance)) refuse('Release differs from its complete considered candidate.');
  // Historical integrity only: no claim of current authority, human approval, or a new measured run.
  engine.checkHostValidation(v.data.target, input.realization_ref, v.data.evidence);
  engine.checkAuth(v.data.auth_receipt,records[v.data.auth_receipt].data.principal_id,['validate']);
  const reconstructed = engine.realize(input.release_ref, 'collection-host/1');
  if (canonical(reconstructed.files) !== canonical(realization.files) || reconstructed.output_tree !== input.output_tree) refuse('Release reconstruction differs from selected output.');
  const kinds = release.data.approvals.map((r: string) => {
    const a = records[r]?.data;
    if (!a || a.target !== release.data.candidate || a.evidence_digest !== v.data.evidence_digest) refuse('Release approval pins changed.');
    engine.checkAuth(a.auth_receipt, a.principal, ['approve', 'mediation.respond']);
    const base = records[release.data.baseline].data;
    if(a.baseline!==release.data.baseline||a.authority_sha256!==digest(base.authorities)||
      (a.kind==='scope'&&(a.scope!==evaluation.scope||!base.authorities.scopes.find((s:{block:string})=>s.block===evaluation.scope)?.selectors.includes(a.principal)))||
      (a.kind==='release'&&!base.authorities.release.includes(a.principal)))refuse('Historical approval differs from fixed baseline authority/scope.');
    return a.kind;
  });
  if (!kinds.includes('scope') || !kinds.includes('release')) refuse('Distinct scope and Release approval records required.');
  engine.checkAuth(release.data.auth_receipt, records[release.data.auth_receipt].data.principal_id, ['release']);
  return { input, realization };
}

export function calculateChecklistQualification(input: ChecklistHandoff) {
  const unique = new Map(Object.values(input.records).map(r => { const bytes = canonical(r.data); return [bytesDigest(bytes), { hash: bytesDigest(bytes), bytes }]; }));
  const objects = [...unique.values()], bundle = artifactBundle(objects), jsonBytes = objects.reduce((n, r) => n + Buffer.byteLength(r.bytes), 0);
  const readRecords=Object.keys(input.records).length,readBytes=Object.values(input.records).reduce((n,r)=>n+Buffer.byteLength(canonical(r.data)),0);
  // Index worst case: 80 exact locators plus storage/pins/cumulative receipts, bounded to 64 KiB.
  const indexBytes = 65536, indexPackBytes = indexBytes + 32768;
  const reservations = { operations: 3 + (6 + objects.length) + (6 + 1) + 3 * (readRecords + 1),
    attempts: 3 + 2 + readRecords + 1, bytes: 16384 + bundle.pack.length + 1024 + 2 * MAX_GIT_RESPONSE_BYTES + jsonBytes +
      indexPackBytes + 1024 + 2 * MAX_GIT_RESPONSE_BYTES + indexBytes + readBytes + indexBytes,
    input_tokens: 0, output_tokens: 0, duration_ms: CHECKLIST_CEILINGS.run_ms };
  // One create, 12 status reads, 8 complete-step reads; cleanup has 12 prepaid management calls.
  const management = { work_calls: 21, cleanup_calls: 12, maximum_calls: 33, provider_requests_per_call:1, automatic_retries:0, pagination:'refuse' as const, request_bytes: CHECKLIST_CEILINGS.request_bytes,
    maximum_response_bytes: CHECKLIST_CEILINGS.response_bytes, workflow_step_output_bytes: 65536 + 2 * 65536 };
  if (jsonBytes > CHECKLIST_CEILINGS.json_bytes || objects.length > CHECKLIST_CEILINGS.records || reservations.operations > CHECKLIST_CEILINGS.operations || reservations.bytes + management.maximum_calls * (management.maximum_response_bytes + CHECKLIST_CEILINGS.request_bytes) > CHECKLIST_CEILINGS.transfer_bytes || management.workflow_step_output_bytes > CHECKLIST_CEILINGS.response_bytes) refuse('Actual history/pack/step/management envelope does not fit; do not widen automatically.');
  return { records: Object.keys(input.records).length, unique_objects: objects.length, json_bytes: jsonBytes, pack_bytes: bundle.pack.length,
    closure_commit: bundle.commit, closure_branch: bundle.branch, index_max_bytes: indexBytes, reservations, management, token_issuances: 3, stage_batches: 2,
    workflow_subrequests:checklistSubrequestQualification(objects.length,readRecords),invoice_cap: false, observed_provider_usage: false };
}
export function prepareChecklist(raw: unknown, targetInput: unknown, expectedInputHash: string, allowSynthetic = false): PreparedChecklist {
  const { input } = verifyChecklistHandoff(raw, allowSynthetic), target = parse(targetSchema, targetInput);
  if (digest(input) !== expectedInputHash || target.project_id !== input.project_id || target.app_worker === target.workflow_worker) refuse('Trusted input or target changed.');
  const input_sha256 = digest(input);
  return { format: 'strata-checklist-cloud-preparation/1', live_authorized: false, input, input_sha256, target, target_sha256: digest(target),
    pins: { release_ref: input.release_ref, realization_ref: input.realization_ref, module_sha256: input.module_sha256, output_tree: input.output_tree, input_sha256 },
    qualification: calculateChecklistQualification(input), location_claim: LOCATION_CLAIM };
}
export function verifyPrepared(p: PreparedChecklist, allowSynthetic = false) {
  if (canonical(prepareChecklist(p.input, p.target, p.input_sha256, allowSynthetic)) !== canonical(p)) refuse('Prepared source/input/target package changed.');
}
