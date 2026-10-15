import { z } from 'zod';
import { BLOCK_MODEL, CONTENT_MODEL, MODEL, SUPPORTED_MODELS, canonical, digest, fail, parse, type Records } from '../model.js';
import { Engine, snapshotFromRelease } from '../core.js';
import { sourceBindingSchema, sourceSnapshotSchema, verifySourceBindingHistory } from '../source-binding.js';
import { GIT_ADOPTION_SCHEMAS } from '../git-record-schemas.js';
import { verifyGitAdoptionHistory } from '../git-adoption.js';
import { ADOPTION_RECORD_SCHEMAS } from '../adoption/records.js';
import { verifyAdoptionHistory } from '../adoption/persistent.js';
import { DRIFT_SCHEMAS, verifyDriftHistory } from '../reconciliation.js';
import { validateRecords } from '../explorer/validate.js';

// Preparation-only contracts. These are deliberately absent from service dispatch,
// engine storage, backup allowlists, command schemas and the native Node adapter.
export const V1_P_FORMAT = 'native-git-history-contract/1';
export const V1_P_LEGACY_SCHEMAS = {
  'source-snapshot': sourceSnapshotSchema,
  'source-binding': sourceBindingSchema,
  ...GIT_ADOPTION_SCHEMAS
} as const;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256);
const text = z.string().min(1).max(256);
const pin = z.object({ ref, sha256: hash }).strict();
const authority = z.discriminatedUnion('trust', [
  z.object({ trust: z.literal('local-fixture'), principal: text, responsible_scope: text, authority_sha256: hash }).strict(),
  z.object({ trust: z.literal('host-authenticated'), principal: text, responsible_scope: text, authority_sha256: hash, auth_receipt: pin }).strict()
]);
export const nativeGitHistoryContractSchema = z.object({
  format: z.literal(V1_P_FORMAT),
  model_version: z.enum(SUPPORTED_MODELS), target_model_version: z.enum(SUPPORTED_MODELS),
  purpose: z.enum(['historical-inspection', 'native-dispatch', 'migration', 'reinterpretation']),
  project_id: text, repo_id: text, history_sha256: hash,
  binding: pin, source: pin,
  intent: z.object({ ref, sha256: hash, snapshot_sha256: hash, model_version: z.enum(SUPPORTED_MODELS) }).strict(),
  authority,
  evidence: z.array(pin.extend({
    format: z.enum(['git-acceptance/1', 'git-acceptance/2', 'git-application-observation/1', 'strata-host-evidence/1']),
    principal: text, trust: z.enum(['local-fixture-import', 'local-fixed-fixture', 'host-measured']), execution_authenticated: z.boolean()
  }).strict()).max(256),
  finalization: pin.nullable()
}).strict();
export type NativeGitHistoryContract = z.infer<typeof nativeGitHistoryContractSchema>;

/** Describe accepted version boundaries without allocating future native formats.
 * Host auth/evidence formats already exist; they do not provide native Git parity. */
export function nativeGitVersionContract(model: string) {
  if (model === MODEL) return {
    format: 'native-git-version-contract/1' as const, model_version: MODEL,
    authority: 'local-fixture' as const, source_binding: 'source-binding/1' as const,
    application_evidence: ['git-acceptance/1', 'git-acceptance/2'] as const,
    finalization: 'git-finalization/1' as const,
    history: 'retained-exact-bytes-and-closure' as const,
    dispatch: 'existing-configured-local-node-only' as const
  };
  if (model === BLOCK_MODEL) return {
    format: 'native-git-version-contract/1' as const, model_version: BLOCK_MODEL,
    authority: 'host-authenticated-required' as const,
    existing_auth_receipt: 'strata-host-auth/1' as const,
    existing_semantic_evidence: 'strata-host-evidence/1' as const,
    native_record_formats: 'unassigned-pending-design-review' as const,
    history: 'legacy-remains-in-its-original-version' as const,
    dispatch: 'unsupported' as const,
    requirements: [
      'fresh-explicit-v0.3-project-no-in-place-history-migration',
      'server-derived-actor-project-action-input-policy-grant-auth-receipt-closure',
      'current-operation-repository-path-block-and-baseline-authority-at-dispatch-and-commit',
      'exact-release-source-scope-stage-result-tree-and-owner-commit-finalization',
      'application-specific-checker-fixture-oracle-and-criterion-regression-closure',
      'retained-authenticated-producer-run-and-review-receipts-no-fixture-promotion',
      'versioned-native-records-reader-and-inactive-archive-closure-before-dispatch',
      'native-parity-qualification-independent-of-hosted-collection-checks'
    ] as const
  };
  if (model === CONTENT_MODEL) return {
    format: 'native-git-version-contract/1' as const, model_version: CONTENT_MODEL,
    authority: 'no-native-git-contract' as const, dispatch: 'unsupported' as const
  };
  fail('UNSUPPORTED_MODEL_VERSION', 8, 'No native Git version contract is declared for this model.');
}

function readPin(records: Records, value: z.infer<typeof pin>, type: string) {
  const stored = records[value.ref];
  if (!stored || stored.type !== type || !stored.published)
    fail('V1_P_MISSING_HISTORY', 6, 'A published exact typed history pin is required.');
  if (digest(stored.data) !== value.sha256 ||
      (type === 'source-binding' || type === 'source-snapshot' || type.startsWith('git-')) && value.ref !== type + '@' + value.sha256)
    fail('V1_P_PIN_MISMATCH', 6, 'A history pin differs from its retained bytes or full content-addressed ref.');
  return stored.data;
}

/** Pure compatibility inspection of retained records. No authorization or runtime
 * completion follows from this result. Existing historical verifiers remain the
 * authority for source/Git closure; no current issuer, filesystem or runner is used. */
export function inspectNativeGitHistory(input: unknown, records: Records) {
  const request = parse(nativeGitHistoryContractSchema, input);
  if (request.purpose === 'migration' || request.purpose === 'reinterpretation' || request.target_model_version !== request.model_version)
    fail('V1_P_MIGRATION_UNSUPPORTED', 8, 'History cannot be migrated, reinterpreted or retargeted by this preparation contract.');
  if (request.purpose !== 'historical-inspection')
    fail('V1_P_DISPATCH_UNSUPPORTED', 8, 'This preparation contract cannot dispatch native Git operations.');
  if (request.model_version !== MODEL)
    fail('UNSUPPORTED_MODEL_VERSION', 8, 'Only retained v0.1 native Git history has an executable compatibility contract.');
  if (request.intent.model_version !== MODEL || Object.values(records).some(r => r.data.model_version !== undefined && r.data.model_version !== MODEL))
    fail('V1_P_VERSION_MISMATCH', 6, 'Semantic history and intent pins must retain their original model version.');
  if (request.authority.trust !== 'local-fixture')
    fail('V1_P_AUTHORITY_MISMATCH', 6, 'Named host authority cannot replace historical local fixture authority.');
  if (Object.keys(records).length > 20000)
    fail('V1_P_HISTORY_LIMIT', 8, 'History inspection is bounded to 20000 retained records.');
  if (digest(records) !== request.history_sha256)
    fail('V1_P_HISTORY_MISMATCH', 6, 'The exact retained history digest differs.');

  const binding = parse(sourceBindingSchema, readPin(records, request.binding, 'source-binding'));
  const payload = binding.payload;
  const source = parse(sourceSnapshotSchema, readPin(records, request.source, 'source-snapshot'));
  const release = readPin(records, request.intent, 'release');
  if (payload.project_id !== request.project_id || payload.repo_id !== request.repo_id ||
      source.project_id !== request.project_id || source.repo_id !== request.repo_id ||
      payload.source_ref !== request.source.ref || payload.source_sha256 !== request.source.sha256 ||
      payload.intent.release_ref !== request.intent.ref || payload.intent.release_sha256 !== request.intent.sha256 ||
      payload.intent.model_version !== request.intent.model_version || payload.intent.snapshot_sha256 !== request.intent.snapshot_sha256 ||
      digest(snapshotFromRelease(release)) !== request.intent.snapshot_sha256)
    fail('V1_P_PIN_MISMATCH', 6, 'The contract must name this binding\'s exact source, repository, Release and snapshot.');
  if (request.authority.principal !== binding.acceptance.principal ||
      request.authority.responsible_scope !== binding.acceptance.responsible_scope ||
      request.authority.authority_sha256 !== digest(release.authorities))
    fail('V1_P_AUTHORITY_MISMATCH', 6, 'Historical acceptance retains its original principal, responsible scope and baseline authority.');

  const evidenceRefs = request.evidence.map(e => e.ref);
  if (new Set(evidenceRefs).size !== evidenceRefs.length || canonical(evidenceRefs) !== canonical([...evidenceRefs].sort()) ||
      canonical(evidenceRefs) !== canonical(payload.acceptance_evidence_refs))
    fail('V1_P_EVIDENCE_MISMATCH', 6, 'The contract must pin every declared application acceptance exactly once in sorted order.');
  for (const evidence of request.evidence) {
    if (!['git-acceptance/1', 'git-acceptance/2'].includes(evidence.format) || evidence.trust === 'host-measured' || evidence.execution_authenticated)
      fail('V1_P_EVIDENCE_MISMATCH', 6, 'Observations and hosted semantic measurements cannot replace historical application acceptance.');
    const data = readPin(records, evidence, 'git-acceptance');
    if (data.format !== evidence.format || data.producer.principal !== evidence.principal ||
        data.producer.trust !== evidence.trust || data.producer.execution_authenticated !== evidence.execution_authenticated)
      fail('V1_P_EVIDENCE_MISMATCH', 6, 'Evidence must retain its exact application format and recorded producer trust.');
  }
  if ((request.finalization?.ref ?? null) !== payload.completion_ref)
    fail('V1_P_FINALIZATION_MISMATCH', 6, 'Successor completion retains its exact finalization; bootstrap has none.');
  if (request.finalization) readPin(records, request.finalization, 'git-finalization');
  verifySourceBindingHistory(records, request.project_id);
  verifyGitAdoptionHistory(records, request.project_id);
  verifyAdoptionHistory(new Engine(records, {}, { projectId: request.project_id }), request.project_id);
  // Existing drift context can coexist with native history. Reuse its historical
  // verifier only; V1-P does not implement reconciliation or completion receipts.
  verifyDriftHistory(records, request.project_id);
  // Reuse the existing pure semantic reader for Release/validation/approval and
  // profile closure. Native/source/adoption records have their own verifiers above.
  const semantic = Object.fromEntries(Object.entries(records).filter(([, r]) =>
    !Object.hasOwn(V1_P_LEGACY_SCHEMAS, r.type) && !Object.hasOwn(ADOPTION_RECORD_SCHEMAS, r.type) && !Object.hasOwn(DRIFT_SCHEMAS, r.type)));
  try { validateRecords(semantic, request.project_id, MODEL); }
  catch { fail('V1_P_SEMANTIC_HISTORY_INVALID', 6, 'Retained semantic schema, profile or typed reference closure is incomplete.'); }
  return {
    format: 'native-git-history-inspection/1' as const, model_version: MODEL,
    binding_ref: request.binding.ref, history_sha256: request.history_sha256,
    historical_compatibility: true as const, execution_ready: false as const,
    authority_granted: false as const, migrated: false as const
  };
}
