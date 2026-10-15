import { readFile, writeFile, mkdir, readdir, lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { MODEL, CONTENT_MODEL, SUPPORTED_MODELS, assetDescriptorSchema, authoringReviewSchema, parseLayer, parseComposition, write, canonical, digest, bytesDigest, fail, StrataError, layerSchema, compositionSchema, approvalSchema, evidenceSchema, boundEvidenceSchema, normalizeSnapshot, type Records } from './model.js';
import { Engine, snapshotFromRelease, normalizeComposition, normalizeLayer } from './core.js';
import { PROFILE_IDS, profileFingerprint, profileArchive, verifyRealization } from './profile.js';
import { MEDIATION_SCHEMAS, mediationArchiveReferences, verifyMediationHistory } from './mediation.js';
import { SOURCE_BINDING_SCHEMAS, sourceBindingArchiveReferences, verifySourceBindingHistory } from './source-binding.js';
import { DRIFT_SCHEMAS, driftArchiveReferences, verifyDriftHistory } from './reconciliation.js';
import { GIT_ADOPTION_SCHEMAS, gitAdoptionArchiveReferences, verifyGitAdoptionHistory } from './git-adoption.js';
import { ADOPTION_RECORD_SCHEMAS, adoptionArchiveReferences } from './adoption/records.js';
import { verifyAdoptionHistory } from './adoption/persistent.js';
import { REVALIDATION_SCHEMAS,revalidationArchiveReferences,completionProjection,reconciliationCompletionSchema,revalidationRequestDigest } from './revalidation.js';
import { verifyRetainedRevalidation } from './revalidation-producers.js';
import { contentApprovalSchema, contentSelectionSchema } from './model.js';
import { FixtureIssuer } from './security.js';
import { NODE_STATE_FORMAT, STATE_DESCRIPTOR, INACTIVE_MARKER, noLinks, assertQuiesced, acquireStateLease } from './node-state.js';

import { checkAssets, checkAssetClosure } from './assets.js';
import { BLOCK_MODEL } from './model.js';
import { BUILD_RECORD_SCHEMAS, buildRecordType, buildRecordReferences, exactBuildRecord, verifyBuildHistory } from './build-records.js';
import { BUILD_ATTEMPT_SCHEMAS, attemptRecordType, verifyBuildAttempts } from './build-attempt-records.js';
import { validateRecords as validateStudioRecords } from './explorer/validate.js';
import { inspectReleasePublication } from './build-publication.js';
export const BACKUP_FORMAT = 'strata-local-backup/1';
export const CONTENT_BACKUP_FORMAT = 'strata-local-backup/2';
export const REVALIDATION_BACKUP_FORMAT = 'strata-local-backup/3';
export const BUILD_BACKUP_FORMAT = 'strata-local-backup/4';
export const BACKUP_LIMITS = { bytes: 64 * 1024 * 1024, file_bytes: 8 * 1024 * 1024, files: 20004, records: 20000, milliseconds: 60000 };
const EXCLUSIONS = ['personal-context-and-navigation-receipts', 'active-request-cache-and-request-keys', 'unindexed-staging-orphans', 'credentials-secret-files-and-local-config', 'sessions-issuer-assignments-and-live-grants', 'provider-bindings-and-queued-jobs', 'customer-runtime-data-and-workspace-files'];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const exactRef = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
const recordType = z.enum(['adoption-inventory', 'adoption-proposal', 'adoption-review', 'adoption-publication', 'release', 'layer', 'composition', 'resolution', 'approval', 'realization', 'validation', 'interaction', 'asset', 'authoring-review', 'selection-policy','selection-grant','mediation-installation','mediation-basis','decision-packet','mediation-receipt','selection-use','interaction-report','report-disposition', 'source-snapshot', 'source-binding', 'drift-report', 'reconciliation-proposal', 'reconciliation-review', 'git-change-plan', 'git-patch-stage', 'git-acceptance', 'git-application-observation', 'git-apply-review', 'git-apply-receipt', 'git-finalization','revalidation-auth','git-revalidation-run','revalidation-criterion-review','reconciliation-completion', ...Object.keys(BUILD_RECORD_SCHEMAS), ...Object.keys(BUILD_ATTEMPT_SCHEMAS), 'auth-receipt', 'host-run', 'criterion-review']);
const entrySchema = z.object({ hash, type: recordType, published: z.boolean() }).strict();
const auditSchema = z.object({ event_id: z.string(), operation_id: z.string(), project_id: z.string(), principal_id: z.string().nullable(), policy_version: z.string().nullable(), action: z.string(), outcome: z.enum(['allowed', 'denied', 'committed']), reason: z.string().nullable(), references: z.array(z.string()) }).strict();
const resultSchema = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()), created: z.array(exactRef), operation_id: z.string(), dry_run: z.literal(false) }).strict();
const checkpointSchema = z.object({ format: z.literal('strata-node-checkpoint/1'), entries: z.record(exactRef, entrySchema), heads: z.record(z.string(), z.object({ owner: z.string().min(1), head: z.number().int().positive() }).strict()), commit_audit: z.array(auditSchema), historical_requests: z.array(z.object({ digest: hash, result: resultSchema }).strict()) }).strict();
const sourceSchema = z.object({ format: z.literal(NODE_STATE_FORMAT), model_version: z.enum(SUPPORTED_MODELS), project_id: z.string().min(1) }).strict();
const legacyManifestSchema = z.object({ format: z.enum([BACKUP_FORMAT,CONTENT_BACKUP_FORMAT]), model_version: z.enum(SUPPORTED_MODELS), storage_format: z.literal(NODE_STATE_FORMAT), project_id: z.string().min(1), scope: z.literal('full-indexed-project'), checkpoint_sha256: hash, roots: z.array(exactRef), inventory: z.array(z.object({ path: z.string(), sha256: hash, bytes: z.number().int().nonnegative().max(BACKUP_LIMITS.file_bytes) }).strict()).max(BACKUP_LIMITS.files), exclusions: z.array(z.string()), unindexed_orphans: z.number().int().nonnegative(), profile_assets: z.array(hash), source_quiescence: z.literal('exclusive-cooperative-lease') }).strict();
const manifestSchema=z.union([legacyManifestSchema,legacyManifestSchema.extend({format:z.literal(REVALIDATION_BACKUP_FORMAT),model_version:z.literal(MODEL),capability:z.literal('authoritative-revalidation-v0.1/1'),revalidation_assets:z.array(hash).max(4096)}).strict(),legacyManifestSchema.extend({format:z.literal(BUILD_BACKUP_FORMAT),capability:z.literal('profiles-and-host-publication/1'),revalidation_assets:z.array(hash).max(4096)}).strict()]);
type Checkpoint = z.infer<typeof checkpointSchema>;
type Manifest = z.infer<typeof manifestSchema>;
type Files = Map<string, Buffer>;
type Budget = { max: number; read: number; deadline: number };
function checkTime(b: Budget) { if (Date.now() > b.deadline) fail('BACKUP_LIMIT', 5, 'The bounded recovery time limit was exceeded; any partial destination is incomplete.'); }
function budget(max = BACKUP_LIMITS.bytes): Budget {
  if (!Number.isSafeInteger(max) || max < 1 || max > BACKUP_LIMITS.bytes) fail('INVALID_ARGUMENT', 2, 'max-bytes must be a positive integer no greater than 67108864.');
  return { max, read: 0, deadline: Date.now() + BACKUP_LIMITS.milliseconds };
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) fail('BACKUP_INVALID', 6, 'Recovery metadata or record has an unsupported shape/version.'); return result.data; }
function utf8(bytes: Uint8Array): string { try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { fail('BACKUP_INVALID', 6, 'Recovery JSON must contain valid UTF-8.'); } }
function json(bytes: Buffer): any {
  let value: any; try { value = JSON.parse(utf8(bytes)); } catch { fail('BACKUP_INVALID', 6, 'A recovery file is not valid JSON.'); }
  const stack = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) { const next = stack.pop()!; if (++nodes > 200000 || next.depth > 48) fail('BACKUP_LIMIT', 5, 'Recovery JSON exceeds the bounded structure limit.'); if (next.value && typeof next.value === 'object') for (const child of Object.values(next.value)) stack.push({ value: child, depth: next.depth + 1 }); }
  return value;
}
function secrets(bytes: Buffer) {
  if (/art_v1_[A-Za-z0-9_-]+|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s*["'][^"'\s]{8,}/i.test(utf8(bytes))) fail('BACKUP_SECRET_DETECTED', 4, 'A retained payload contains a recognized secret pattern. No redaction or complete export was performed; explicit handling is required.');
}
async function readBounded(file: string, b: Budget): Promise<Buffer> {
  checkTime(b); await noLinks(file); const stats = await lstat(file);
  if (!stats.isFile()) fail('INVALID_PATH', 2, 'Recovery inventory requires regular files.');
  if (stats.size > BACKUP_LIMITS.file_bytes || b.read + stats.size > b.max) fail('BACKUP_LIMIT', 5, 'Recovery bytes exceed the explicit total or per-file limit.');
  const bytes = await readFile(file); b.read += bytes.length;
  if (bytes.length !== stats.size || b.read > b.max) fail('BACKUP_LIMIT', 5, 'Recovery input changed or exceeded its byte limit.');
  checkTime(b); return bytes;
}
function encoded(value: unknown) { return Buffer.from(canonical(value)); }
function inactiveMarker(project: string, manifest: string) { return encoded({ format: 'strata-recovery-inactive/1', project_id: project, manifest_sha256: manifest, identities_active: false, requests_active: false }); }
function auth(operation: string, project: string, selector: string) {
  const issuer = new FixtureIssuer({ project_id: project }); const context = issuer.resolve(selector, project); issuer.authorize(context, operation, {}); return context;
}
function relativeFile(name: string) {
  if (!/^(?:source\.json|checkpoint\.json|audit\.jsonl|profiles\/[a-f0-9]{64}\.json|artifacts\/[a-f0-9]{64}\.json|assets\/blobs\/[a-f0-9]{64})$/.test(name)) fail('INVALID_PATH', 2, 'Backup inventory contains an escaping or unsupported path.');
}
function overlap(a: string, b: string) { const rel = path.relative(a, b); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
async function destination(requested: string, source: string) {
  const output = await noLinks(requested); const original = await noLinks(source);
  if (overlap(original, output) || overlap(output, original)) fail('INVALID_PATH', 2, 'Recovery output must be separate from its source.');
  try { const stats = await lstat(output); if (!stats.isDirectory() || (await readdir(output)).length) fail('OUTPUT_EXISTS', 5, 'Recovery refuses an occupied destination; select a new or empty isolated directory.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return output;
}
async function isolatedRestore(output: string) {
  let ancestor = output;
  while (true) {
    for (const marker of ['strata.config.json', STATE_DESCRIPTOR]) {
      try { await lstat(path.join(ancestor, marker)); fail('INVALID_PATH', 2, 'Restore must be outside every existing configured Strata project and Node state.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (path.dirname(ancestor) === ancestor) return; ancestor = path.dirname(ancestor);
  }
}
function auditEvents(text: string, project: string, records: Records, committed: boolean) {
  const lines = text.split('\n').filter(Boolean); if (lines.length > BACKUP_LIMITS.records) fail('BACKUP_LIMIT', 5, 'Audit history exceeds the bounded event limit.');
  return lines.map(line => parsed(auditSchema, json(Buffer.from(line)))).filter(event => !event.action.startsWith('context.')).map(event => {
    if (event.project_id !== project && event.principal_id !== null) fail('BACKUP_PROJECT_MISMATCH', 4, 'Historical audit belongs to another project.');
    if (committed && event.outcome !== 'committed') fail('BACKUP_INVALID', 6, 'Commit history contains a noncommit event.');
    for (const ref of event.references) if (!/^sha256:[a-f0-9]{64}$/.test(ref) && !Object.hasOwn(records, ref)) fail('BACKUP_MISSING_REFERENCE', 6, 'An audit receipt references missing historical state.');
    if(event.action==='drift.revalidate'&&event.outcome==='committed') {
      const completions=event.references.filter(ref=>records[ref]?.type==='reconciliation-completion');
      if(completions.length!==1)fail('BACKUP_INVALID',6,'Revalidation audit requires one exact completion.');
      const d=records[completions[0]].data,attemptRefs=Object.keys(records).filter(ref=>records[ref].data.attempt_id===d.attempt_id);
      const expected=[d.request.review.ref,d.request.basis_evidence.ref,...attemptRefs].sort();
      if(canonical([...event.references].sort())!==canonical(expected)||event.principal_id!==d.bridge.authority.principal_id||event.policy_version!=='host-policy/'+d.bridge.authority.policy_generation+'/'+d.bridge.authority.policy_sha256)
        fail('BACKUP_INVALID',6,'Revalidation audit authority/closure differs.');
    }
    if (event.action === 'layer.restore' && event.outcome === 'committed') {
      if (event.references.length !== 4) fail('BACKUP_INVALID', 6, 'Restoration audit must retain all exact historical references.');
      const [previous, source, fingerprint, result] = event.references; recoveryReceipt(records, { previous, source, source_fingerprint: fingerprint.replace(/^sha256:/, ''), result }, event.principal_id);
    }
    return event;
  });
}
function recoveryReceipt(records: Records, input: unknown, principal?: string | null) {
  const receipt = parsed(z.object({ previous: exactRef, source: exactRef, source_fingerprint: hash, result: exactRef }).strict(), input);
  const history = [receipt.previous, receipt.source, receipt.result].map(ref => records[ref]);
  if (history.some(record => record?.type !== 'layer')) fail('BACKUP_MISSING_REFERENCE', 6, 'A restoration receipt needs its previous, source and resulting Layer bytes.');
  const [previous, source, result] = history.map(record => record.data);
  if (previous.id !== source.id || result.id !== source.id || source.revision >= previous.revision || result.revision !== previous.revision + 1 || receipt.source_fingerprint !== digest(source) || canonical(result) !== canonical({ ...source, revision: result.revision }) || (principal !== undefined && principal !== source.owner)) fail('BACKUP_INVALID', 6, 'Restoration provenance disagrees with retained source and resulting proposal bytes.');
}
// Verify retained historical structure and closure. Do not re-run present-day selection,
// approval liveness or evidence execution and retroactively rewrite historical validity.
function validateRecords(checkpoint: Checkpoint, files: Files, project: string, b: Budget): Records {
  const entries = Object.entries(checkpoint.entries); if (!entries.length || entries.length > BACKUP_LIMITS.records) fail('BACKUP_INCOMPLETE', 6, 'A bounded nonempty publication checkpoint is required.');
  const records: Records = Object.create(null); const owners = new Map<string, { owner: string; head: number; revisions: number[]; baseline: string }>();
  for (const [ref, entry] of entries) {
    checkTime(b);
    const bytes = files.get('artifacts/' + entry.hash + '.json'); if (!bytes) fail('BACKUP_MISSING_REFERENCE', 6, 'An indexed immutable artifact is absent.');
    if (bytesDigest(bytes) !== entry.hash) fail('BACKUP_HASH_MISMATCH', 6, 'Indexed artifact bytes do not match their fingerprint.');
    secrets(bytes); const data = json(bytes);
    if (canonical(data) !== utf8(bytes)) fail('BACKUP_INVALID', 6, 'Immutable artifact bytes must be canonical JSON without duplicate keys.');
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('BACKUP_INVALID', 6, 'Immutable artifacts must be record objects.');
    if (entry.type !== 'layer' && !Object.hasOwn(ADOPTION_RECORD_SCHEMAS, entry.type) && !entry.published) fail('BACKUP_INVALID', 6, 'Unpublished record type is unsupported in this storage version.');
    records[ref] = { ...entry, data };
  }
  const requireRef = (ref: unknown, types: string[], published = true) => {
    if (typeof ref !== 'string' || !Object.hasOwn(records, ref) || !types.includes(records[ref].type) || (published && !records[ref].published)) fail('BACKUP_MISSING_REFERENCE', 6, 'A required pinned historical record is absent or incompatible.');
    return records[ref].data;
  };
  const hostModel = Object.values(records).some(r => r.type === 'release' && r.data.model_version === BLOCK_MODEL);
  if (hostModel) { try { validateStudioRecords(records, project, BLOCK_MODEL); } catch { fail('BACKUP_INVALID', 6, 'Host record identity or supporting closure is invalid.'); } }
  verifyBuildHistory(records, project);
  verifyBuildAttempts(records, project);
  for (const [ref, record] of Object.entries(records)) {
    checkTime(b);
    const data = record.data; let expected: string;
    if (attemptRecordType(record.type)) continue;
    if (buildRecordType(record.type)) {
      parsed(BUILD_RECORD_SCHEMAS[record.type] as z.ZodType<any>, data);
      for (const pin of buildRecordReferences(record.type, data)) exactBuildRecord(records, pin);
      continue; // Full identity, normalization, lineage, action and review closure checked above.
    }
    if (hostModel) {
      // /4 uses the same strict host admission schemas and short historical refs.
      // The legacy switch below must never reinterpret /3 approvals or evidence.
      if (record.type === 'layer') {
        const layer = parseLayer(data), old = owners.get(layer.id);
        if (old && (old.owner !== layer.owner || old.baseline !== layer.baseline)) fail('BACKUP_OWNERSHIP_MISMATCH', 4, 'Layer history disagrees on ownership or baseline.');
        owners.set(layer.id, { owner: layer.owner, baseline: layer.baseline, head: Math.max(old?.head ?? 0, layer.revision), revisions: [...(old?.revisions ?? []), layer.revision] });
      }
      if (record.type === 'realization') {
        const archive = files.get('profiles/' + data.profile + '.json');
        if (!archive || canonical(json(archive)) !== canonical(profileArchive(data.profile_id))) fail('BACKUP_MISSING_PROFILE', 6, 'Exact historical materializer archive is missing.');
      }
      continue;
    }
    switch (record.type) {
      case 'asset': { const asset=parsed(assetDescriptorSchema,data); expected='asset@'+digest(asset); break; }
      case 'authoring-review': { const review=parsed(authoringReviewSchema,data); if(review.project_id!==project) fail('BACKUP_PROJECT_MISMATCH',4,'Authoring review belongs to another project.'); expected='authoring-review@'+digest(review); break; }
      case 'layer': {
        const layer = parseLayer(data); expected = `${layer.id}@${layer.revision}`; requireRef(layer.baseline, ['release']);
        for (const needed of [...layer.requires_layers, ...layer.read_set.map(r => r.layer)]) requireRef(needed, ['layer']);
        if (layer.derived_from) requireRef(layer.derived_from.against, ['release', 'composition']);
        const owner = owners.get(layer.id);
        if (owner && (owner.owner !== layer.owner || owner.baseline !== layer.baseline)) fail('BACKUP_OWNERSHIP_MISMATCH', 4, 'Layer history disagrees on ownership or baseline.');
        owners.set(layer.id, { owner: layer.owner, head: Math.max(owner?.head ?? 0, layer.revision), revisions: [...(owner?.revisions ?? []), layer.revision], baseline: layer.baseline }); break;
      }
      case 'composition': {
        const composition = parseComposition(data); normalizeComposition(composition); expected = `${composition.id}@${composition.revision}`; requireRef(composition.baseline, ['release']);
        for (const needed of [...composition.proposals, ...composition.selected]) requireRef(needed, ['layer']); for (const needed of composition.resolutions) requireRef(needed, ['resolution']); break;
      }
      case 'release': {
        normalizeSnapshot(snapshotFromRelease(data));
        if (data.baseline === undefined) { parsed(z.object({ id: z.string(), revision: z.number(), model_version: z.string(), root: z.string(), blocks: z.unknown(), authorities: z.unknown(), deleted_ids: z.unknown() }).strict(), data); expected = `${data.id}@${data.revision}`; }
        else {
          parsed(z.object({ id: z.string(), revision: z.number(), model_version: z.enum(SUPPORTED_MODELS), root: z.string(), blocks: z.unknown(), authorities: z.unknown(), deleted_ids: z.unknown(), baseline: exactRef, candidate: hash, provenance: z.record(z.string(), z.array(exactRef)), lineage: z.array(exactRef), resolutions: z.array(exactRef), acceptance_manifest: z.array(z.unknown()), validation: exactRef, approvals: z.array(exactRef), state: z.literal('validated'), trust: z.literal('local-fixture') }).strict(), data);
          const releaseBaseline=requireRef(data.baseline,['release']);if(releaseBaseline.model_version!==data.model_version)fail('BACKUP_INVALID',6,'Historical Release crosses model versions.'); const validation = requireRef(data.validation, ['validation']);
          if (validation.candidate !== data.candidate) fail('BACKUP_INVALID', 6, 'Release validation does not bind its candidate.');
          for (const needed of data.approvals) { const a = requireRef(needed, ['approval']); if ((data.model_version===CONTENT_MODEL ? a.format!=='approval/2' : a.format!==undefined) || a.target !== data.candidate || a.evidence_digest !== validation.evidence_digest) fail('BACKUP_INVALID', 6, 'Release endorsement does not bind its evidence.'); }
          for (const needed of [...data.lineage, ...Object.values(data.provenance).flat() as string[]]) requireRef(needed, ['layer']); for (const needed of data.resolutions) requireRef(needed, ['resolution']);
          expected = 'release@' + digest(data).slice(0, 24);
        } break;
      }
      case 'approval': {
        const { principal, trust, ref: embedded, ...request } = data; parsed(request.format==='approval/2'?contentApprovalSchema:approvalSchema as any, request);
        if(request.format==='approval/2'){const baseline=requireRef(request.baseline,['release']);if(request.project_id!==project || baseline.model_version!==CONTENT_MODEL || request.authority_sha256!==digest(baseline.authorities))fail('BACKUP_INVALID',6,'Versioned approval authority/project binding disagrees.');if(request.binding){requireRef(request.binding.basis_ref,['mediation-basis']);requireRef(request.binding.packet_ref,['decision-packet']);const receipt=requireRef(request.binding.receipt_ref,['mediation-receipt']);if(receipt.target!==request.target || receipt.principal!==principal || receipt.action!=='approve_selection' || receipt.partition_sha256!==request.binding.partition_sha256)fail('BACKUP_INVALID',6,'Versioned selection receipt disagrees.');}}
        if (typeof principal !== 'string' || !principal || trust !== 'local-fixture' || embedded !== ref) fail('BACKUP_INVALID', 6, 'Historical endorsement metadata is inconsistent.');
        if (request.kind === 'resolution') {
          if (!Object.values(records).some(r => r.type === 'layer' && r.published && r.data.resolution_proposals.some((payload: any, index: number) => digest({ layer: `${r.data.id}@${r.data.revision}`, proposal_index: index, payload }) === request.target))) fail('BACKUP_MISSING_REFERENCE', 6, 'An endorsement decision source is absent.');
        } else if (!Object.values(records).some(r => r.type === 'validation' && r.data.candidate === request.target && r.data.evidence_digest === request.evidence_digest)) fail('BACKUP_MISSING_REFERENCE', 6, 'An endorsement validation source is absent.');
        expected = 'approval@' + digest({ ...request, principal, trust }).slice(0, 24); break;
      }
      case 'resolution': {
        parsed(z.object({ layer: exactRef, proposal_index: z.number().int().nonnegative(), payload: z.unknown(), approvals: z.array(exactRef), sealed_by: z.string().min(1), trust: z.literal('local-fixture') }).strict(), data);
        const layer = requireRef(data.layer, ['layer']);if(layer.model_version===CONTENT_MODEL){parsed(contentSelectionSchema,data.payload);requireRef(data.payload.basis_ref,['mediation-basis']);}
        if (canonical(layer.resolution_proposals[data.proposal_index] ?? null) !== canonical(data.payload)) fail('BACKUP_INVALID', 6, 'A resolution disagrees with its pinned proposal.');
        for (const needed of [...data.payload.outcome.selected, ...data.payload.outcome.rejected]) requireRef(needed, ['layer']);
        for (const needed of data.approvals) { const a = requireRef(needed, ['approval']); if (a.kind !== 'resolution' || a.target !== digest({ layer: data.layer, proposal_index: data.proposal_index, payload: data.payload })) fail('BACKUP_INVALID', 6, 'A resolution endorsement binds another decision.'); }
        expected = 'resolution@' + digest(data).slice(0, 24); break;
      }
      case 'realization': {
        parsed(z.object({ protocol_version: z.literal('1'), model_version: z.enum(SUPPORTED_MODELS), target: exactRef, candidate: hash, profile_id: z.enum(PROFILE_IDS), profile: hash, output_tree: hash, files: z.record(z.string(), z.string()), coverage: z.array(z.unknown()), reverse_links: z.record(z.string(), z.array(z.string())), trust: z.literal('local-template'), asset_manifest:z.record(z.string(),z.unknown()).optional(),asset_closure_sha256:hash.optional(),format:z.literal('strata-realization/2').optional(),checker_sha256:hash.optional(),fixture_sha256:hash.optional(),oracle_sha256:hash.optional(),oracle:z.unknown().optional() }).strict(), data);
        verifyRealization(data); requireRef(data.target, ['release', 'composition']);
        const asset = files.get('profiles/' + data.profile + '.json'); if (!asset || canonical(json(asset)) !== canonical(profileArchive(data.profile_id))) fail('BACKUP_MISSING_PROFILE', 6, 'The exact supported profile/template asset is missing or incompatible.');
        expected = 'realization@' + digest(data).slice(0, 24); break;
      }
      case 'validation': {
        parsed(z.object({ candidate: hash, target: exactRef, realization: exactRef, evidence: z.union([evidenceSchema,boundEvidenceSchema]), evidence_digest: hash, trust: z.literal('local-fixture-import') }).strict(), data);
        requireRef(data.target, ['release', 'composition']); const realization = requireRef(data.realization, ['realization']);
        if (data.evidence_digest !== digest(data.evidence) || realization.target !== data.target || realization.candidate !== data.candidate || data.evidence.candidate !== data.candidate || data.evidence.profile !== realization.profile || data.evidence.output_tree !== realization.output_tree) fail('BACKUP_INVALID', 6, 'Historical validation, realization and evidence disagree.');
        if(realization.format==='strata-realization/2' && (data.evidence.format!=='strata-fixture-evidence/2' || data.evidence.checker_sha256!==realization.checker_sha256 || data.evidence.fixture_sha256!==realization.fixture_sha256 || data.evidence.oracle_sha256!==realization.oracle_sha256)) fail('BACKUP_INVALID',6,'Historical checker, fixture and oracle evidence bindings disagree.');
        expected = 'validation@' + digest(data).slice(0, 24); break;
      }
      case 'interaction': {
        const { ref: embedded, ...report } = data; parsed(z.object({ composition: exactRef, candidate: hash, principal: z.string().min(1), message: z.string().min(1) }).strict(), report); requireRef(data.composition, ['composition']); if (embedded !== ref) fail('BACKUP_INVALID', 6, 'Interaction reference is inconsistent.'); expected = 'interaction@' + digest(report).slice(0, 24); break;
      }
      default: {
        const supporting = { ...SOURCE_BINDING_SCHEMAS, ...DRIFT_SCHEMAS, ...GIT_ADOPTION_SCHEMAS, ...ADOPTION_RECORD_SCHEMAS,...REVALIDATION_SCHEMAS };
        if (Object.hasOwn(supporting, record.type)) {
          parsed(supporting[record.type as keyof typeof supporting] as z.ZodType<any>, data);
          const recordProject = record.type === 'source-binding' ? data.payload.project_id : record.type === 'git-apply-review' ? data.target.project_id : data.project_id;
          if (recordProject !== project) fail('BACKUP_PROJECT_MISMATCH', 4, 'Source/drift/Git history belongs to another project.');
          const refs = [...sourceBindingArchiveReferences(record.type, data), ...driftArchiveReferences(record.type, data), ...gitAdoptionArchiveReferences(record.type, data), ...adoptionArchiveReferences(record.type, data),...revalidationArchiveReferences(record.type,data)];
          for (const needed of refs) requireRef(needed, [records[needed]?.type], records[needed]?.type !== 'layer' && !Object.hasOwn(ADOPTION_RECORD_SCHEMAS, records[needed]?.type));
          expected = record.type + '@' + digest(data); break;
        }
        const schema = MEDIATION_SCHEMAS[record.type as keyof typeof MEDIATION_SCHEMAS];
        if (!schema) fail('BACKUP_INVALID', 6, 'Unsupported historical record type.');
        parsed(schema as any, data); if (data.project_id !== project) fail('BACKUP_PROJECT_MISMATCH', 4, 'Mediation record belongs to another project.');
        for (const needed of mediationArchiveReferences(record.type, data)) requireRef(needed, [records[needed]?.type]);
        expected = record.type + '@' + digest(data); break;
      }
    }
    if (expected !== ref) fail('BACKUP_REFERENCE_MISMATCH', 6, 'An immutable reference conflicts with its historical content.');
  }
  if (Object.keys(checkpoint.heads).length !== owners.size) fail('BACKUP_OWNERSHIP_MISMATCH', 4, 'Publication heads omit or add Layer identities.');
  for (const [id, history] of owners) {
    const head = checkpoint.heads[id]; if (!head || head.owner !== history.owner || head.head !== history.head || history.revisions.length !== history.head) fail('BACKUP_OWNERSHIP_MISMATCH', 4, 'Publication heads or contiguous Layer history disagree with historical ownership.');
  }
  const assetBytes=new Map<string,Uint8Array>([...files].filter(([name])=>name.startsWith('assets/blobs/')).map(([name,bytes])=>[name.slice('assets/blobs/'.length),bytes])); checkAssets(records,assetBytes,project);
  // Historical verification preserves pre-adoption realization bytes, including
  // outputs that current adopted policy may now refuse to generate again.
  const semanticRecords = Object.fromEntries(Object.entries(records).filter(([, r]) => !buildRecordType(r.type)));
  const engine = new Engine(semanticRecords, checkpoint.heads,{projectId:project,assetBytes,historical:true});
  for(const [ref,r] of Object.entries(records)) {
    if(r.type==='release') checkAssetClosure(snapshotFromRelease(r.data),records,assetBytes,project);
    if(r.type==='layer') { const baseline=snapshotFromRelease(requireRef(r.data.baseline,['release'])); if(canonical(normalizeLayer(r.data,baseline))!==canonical(r.data)) fail('BACKUP_INVALID',6,'Layer bytes are not normalized.');
      const draft=structuredClone(baseline); for(const block of r.data.created_blocks ?? []) draft.blocks[block.id] = structuredClone(block); for(const c of r.data.changes) write(draft.blocks[c.block],c.path,c.value); checkAssetClosure(draft,records,assetBytes,project);
      if([CONTENT_MODEL, BLOCK_MODEL].includes(r.data.model_version) && r.published && (r.data.changes.length || r.data.acceptance.length || r.data.created_blocks?.length) && !Object.values(records).some(review=>review.type==='authoring-review' && review.data.accepted && review.data.draft_ref===ref && review.data.draft_digest===digest(r.data))) fail('BACKUP_MISSING_REFERENCE',6,'Published content Layer lacks its exact accepted authoring review.');
    }
  }
  verifyMediationHistory(engine, project);
  verifySourceBindingHistory(records, project);
  verifyDriftHistory(records, project);
  verifyGitAdoptionHistory(records, project);
  verifyAdoptionHistory(engine, project);
  verifyRetainedRevalidation(records,project);
  if (hostModel) verifyHostPublicationHistory(engine, project, assetBytes, b);
  const fingerprints = new Map<string, ReturnType<Engine['target']>>();
  const target = (ref: string) => { if (!fingerprints.has(ref)) fingerprints.set(ref, engine.target(ref)); return fingerprints.get(ref)!; };
  for (const record of Object.values(records)) {
    checkTime(b); const data = record.data;
    if (record.type === 'realization' || record.type === 'validation') { if (data.candidate !== target(data.target).fingerprint) fail('BACKUP_INVALID', 6, 'Historical candidate fingerprint disagrees with its exact target.'); }
    if (record.type === 'interaction' && data.candidate !== target(data.composition).fingerprint) fail('BACKUP_INVALID', 6, 'Interaction evidence binds another candidate.');
    if (record.type === 'release' && data.validation) {
      const evaluation = target(records[data.validation].data.target);
      if (canonical(snapshotFromRelease(data)) !== canonical(evaluation.snapshot) || canonical(data.provenance) !== canonical(evaluation.provenance)) fail('BACKUP_INVALID', 6, 'Release snapshot or provenance disagrees with its retained validated candidate.');
    }
  }
  auditEvents(checkpoint.commit_audit.map(e => canonical(e)).join('\n'), project, records, true);
  if (checkpoint.commit_audit.some(e => e.action.startsWith('context.'))) fail('BACKUP_INVALID', 6, 'Personal navigation receipts are outside recovery scope.');
  for (const receipt of checkpoint.historical_requests) {
    checkTime(b); requireRef(receipt.result.data.ref, [records[String(receipt.result.data.ref)]?.type], false); for (const ref of receipt.result.created) requireRef(ref, [records[ref]?.type], false);
    if (receipt.result.data.recovery) { recoveryReceipt(records, receipt.result.data.recovery); if ((receipt.result.data.recovery as any).result !== receipt.result.data.ref) fail('BACKUP_INVALID', 6, 'Cached historical restoration result disagrees with its receipt.'); }
    if(receipt.result.data.completion_ref) {
      const ref=receipt.result.data.completion_ref;if(typeof ref!=='string')fail('BACKUP_INVALID',6,'Historical completion reference must be exact.');
      const d=parsed(reconciliationCompletionSchema,requireRef(ref,['reconciliation-completion']));
      const {live_source_checked:_,...result}=receipt.result.data, {live_source_checked:__,...expected}=completionProjection(ref,d);
      const attemptRefs=Object.keys(records).filter(ref=>records[ref].data.attempt_id===d.attempt_id).sort();
      if(canonical(result)!==canonical(expected)||receipt.digest!==revalidationRequestDigest(d.request,d.bridge.authority.principal_id)||canonical([...receipt.result.created].sort())!==canonical(attemptRefs))fail('BACKUP_INVALID',6,'Historical request result differs from its exact committed completion.');
    }
    secrets(encoded(receipt));
  }
  return records;
}
function validateSet(manifest: Manifest, files: Files, b: Budget) {
  for (const [name, bytes] of files) { checkTime(b); if(name.startsWith('assets/blobs/')) continue; secrets(bytes); if (name !== 'audit.jsonl' && canonical(json(bytes)) !== utf8(bytes)) fail('BACKUP_INVALID', 6, 'Recovery JSON must be canonical without duplicate keys.'); }
  const source = parsed(sourceSchema, json(files.get('source.json') ?? Buffer.alloc(0))); const checkpoint = parsed(checkpointSchema, json(files.get('checkpoint.json') ?? Buffer.alloc(0)));
  const hasRevalidation=Object.values(checkpoint.entries).some(e=>Object.hasOwn(REVALIDATION_SCHEMAS,e.type));
  const hasBuild = Object.values(checkpoint.entries).some(e => buildRecordType(e.type));
  if(source.model_version!==manifest.model_version || manifest.format!==((hasBuild || manifest.model_version === BLOCK_MODEL) ? BUILD_BACKUP_FORMAT : hasRevalidation?REVALIDATION_BACKUP_FORMAT:manifest.model_version===CONTENT_MODEL ? CONTENT_BACKUP_FORMAT : BACKUP_FORMAT)) fail('BACKUP_INVALID',6,'Recovery format and explicit model binding disagree.');
  if (source.project_id !== manifest.project_id) fail('BACKUP_PROJECT_MISMATCH', 4, 'Source binding differs from the manifest project.');
  if (bytesDigest(files.get('checkpoint.json')!) !== manifest.checkpoint_sha256 || canonical(Object.keys(checkpoint.entries).sort()) !== canonical(manifest.roots)) fail('BACKUP_INCOMPLETE', 6, 'Checkpoint fingerprint or full root inventory is inconsistent.');
  if (canonical(manifest.exclusions) !== canonical(EXCLUSIONS)) fail('BACKUP_INVALID', 6, 'Recovery exclusions are unsupported.');
  const records = validateRecords(checkpoint, files, manifest.project_id, b);
  if(Object.values(records).some(r=>r.data.model_version && r.data.model_version!==manifest.model_version) || (manifest.model_version===MODEL && Object.values(records).some(r=>['asset','authoring-review'].includes(r.type)))) fail('BACKUP_INVALID',6,'Backup contains mixed model records.');
  const blobs=[...new Set(Object.values(records).filter(r=>r.type==='asset').map(r=>'assets/blobs/'+r.data.content_sha256))];
  const profiles = archivedProfiles(Object.values(records));
  const revalidationAssets=[...new Set(Object.values(records).filter(r=>r.type==='git-revalidation-run').map(r=>r.data.descriptor_sha256 as string))].sort();
  if(manifest.format===REVALIDATION_BACKUP_FORMAT || manifest.format===BUILD_BACKUP_FORMAT){
    if(canonical(manifest.revalidation_assets)!==canonical(revalidationAssets))fail('BACKUP_MISSING_PROFILE',6,'Revalidator descriptor inventory differs.');
    for(const r of Object.values(records).filter(r=>r.type==='git-revalidation-run')){const bytes=files.get('profiles/'+r.data.descriptor_sha256+'.json');if(!bytes||canonical(json(bytes))!==canonical(r.data.descriptor))fail('BACKUP_MISSING_PROFILE',6,'Archived runner/checker/fixture/recognizer/oracle descriptor differs.');}
  }
  if (canonical(profiles) !== canonical(manifest.profile_assets)) fail('BACKUP_MISSING_PROFILE', 6, 'Pinned profile inventory is incomplete.');
  const required = ['source.json', 'checkpoint.json', 'audit.jsonl', ...new Set(Object.values(checkpoint.entries).map(e => 'artifacts/' + e.hash + '.json')), ...profiles.map(p => 'profiles/' + p + '.json'),...revalidationAssets.map(p=>'profiles/'+p+'.json'),...blobs].sort();
  if (canonical(required) !== canonical([...files.keys()].sort())) fail('BACKUP_INCOMPLETE', 6, 'Recovery inventory adds or omits required state.');
  const audit = files.get('audit.jsonl')!; secrets(audit); const events = auditEvents(utf8(audit), manifest.project_id, records, false);
  if (canonical(events.map(e => canonical(e)).join('\n') + (events.length ? '\n' : '')) !== canonical(utf8(audit))) fail('BACKUP_INVALID', 6, 'Audit history must be canonical, scoped and free of personal navigation.');
  return { checkpoint, records };
}
function archivedProfiles(records: Array<{ type: string; data: any }>) {
  return [...new Set(records.flatMap(r => r.type === 'realization' ? [r.data.profile as string] : r.type === 'build-profile' ? [r.data.materializer.archive_sha256 as string] : []))].sort();
}
function verifyHostPublicationHistory(engine: Engine, project: string, assetBytes: Map<string, Uint8Array>, b: Budget) {
  for (const [ref, r] of Object.entries(engine.records)) {
    checkTime(b); const d = r.data;
    if (r.type === 'realization' && canonical(engine.realize(d.target, d.profile_id)) !== canonical(d)) fail('BACKUP_INVALID', 6, 'Host realization differs from exact historical generation.');
    if (r.type === 'validation') {
      const { auth_receipt, ...stored } = d;
      if (canonical(engine.checkValidation(d.target, d.realization, d.evidence)) !== canonical(stored)) fail('BACKUP_INVALID', 6, 'Host validation differs from retained measured evidence.');
      const a = engine.read(auth_receipt, 'auth-receipt'); engine.checkAuth(auth_receipt, a.principal_id, ['validate']);
    }
    if (r.type === 'host-run' || r.type === 'criterion-review') {
      const realization = engine.read(d.realization, 'realization');
      const fields = ['candidate', 'profile', 'output_tree', 'checker_sha256', 'fixture_sha256', 'oracle_sha256'];
      if (fields.some(k => d[k] !== realization[k])) fail('BACKUP_INVALID', 6, 'Host run/review has inconsistent exact realization pins.');
      engine.checkAuth(d.auth_receipt, r.type === 'host-run' ? d.producer : d.reviewer, [r.type === 'host-run' ? 'evidence.run' : 'criterion.review']);
      if (r.type === 'host-run' && d.profile_id !== realization.profile_id) fail('BACKUP_INVALID', 6, 'Host run names another compiled materializer.');
      if (r.type === 'criterion-review' && !realization.coverage.some((c: any) => c.checks.some((check: any) => canonical(check) === canonical(d.criterion)))) fail('BACKUP_INVALID', 6, 'Criterion review is outside exact realization coverage.');
    }
    if (r.type === 'authoring-review') {
      if (d.draft_digest !== digest(engine.read(d.draft_ref, 'layer', false))) fail('BACKUP_INVALID', 6, 'Host authoring review differs from its exact retained draft.');
      engine.checkAuth(d.auth_receipt, d.reviewer, ['content.review']);
    }
    if (r.type === 'resolution') engine.checkAuth(d.auth_receipt, d.sealed_by, ['resolve']);
    if (r.type === 'approval') engine.checkAuth(d.auth_receipt, d.principal, ['approve', 'mediation.respond']);
    if (r.type === 'release' && d.validation) {
      const report = inspectReleasePublication({ project_id: project, records: engine.records, asset_bytes: assetBytes, source_trust: 'local-fixture' }, ref);
      if (!report.historically_approved) fail('BACKUP_INVALID', 6, 'Complete historical host publication could not be verified.');
    }
  }
}
async function assertNoPendingGit(directory: string) {
  const marker = await noLinks(path.join(directory, 'GIT_APPLY_PENDING.json'));
  try { await lstat(marker); fail('STATE_BUSY', 5, 'Resolve the pending Git apply transaction before portable backup.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function createBackup(input: { state: string; out: string; project: string; selector: string; maxBytes: number; dryRun?: boolean }) {
  auth('backup.create', input.project, input.selector); const b = budget(input.maxBytes); const source = await noLinks(input.state); const out = await destination(input.out, source);
  await assertQuiesced(source); await assertNoPendingGit(source); let release: (() => Promise<void>) | undefined;
  if (!input.dryRun) release = await acquireStateLease(source, 'backup');
  try {
    let descriptorBytes: Buffer; try { descriptorBytes = await readBounded(path.join(source, STATE_DESCRIPTOR), b); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('STATE_BINDING_REQUIRED', 4, 'Export requires an updated Node broker descriptor. Run that broker once and close it gracefully; SDK state is unsupported.'); throw error; }
    const descriptor = parsed(sourceSchema, json(descriptorBytes)); if (descriptor.project_id !== input.project) fail('BACKUP_PROJECT_MISMATCH', 4, 'Node state is bound to another project.');
    const registryBytes = await readBounded(path.join(source, 'registry.json'), b); const registry = json(registryBytes);
    if(registry.storage || registry.asset_locators || Object.values(registry.entries ?? {}).some((e:any)=>e.locator)) fail('UNSUPPORTED_REMOTE_BACKUP',8,'Local-file backup cannot export a remotely indexed registry.');
    parsed(z.object({ entries: z.record(exactRef, entrySchema), heads: checkpointSchema.shape.heads, requests: z.record(z.string(), z.object({ digest: hash, result: resultSchema }).strict()), commit_audit: z.array(auditSchema).optional(), contexts: z.record(z.string(), z.unknown()).optional() }).strict(), registry);
    const checkpoint: Checkpoint = { format: 'strata-node-checkpoint/1', entries: registry.entries, heads: registry.heads, commit_audit: (registry.commit_audit ?? []).filter((e: any) => !e.action.startsWith('context.')), historical_requests: Object.values(registry.requests).filter((r: any) => typeof r.result.data.ref === 'string') as Checkpoint['historical_requests'] };
    if (Object.keys(checkpoint.entries).length > BACKUP_LIMITS.records || checkpoint.commit_audit.length > BACKUP_LIMITS.records || checkpoint.historical_requests.length > BACKUP_LIMITS.records) fail('BACKUP_LIMIT', 5, 'Recovery checkpoint exceeds its bounded history limit.');
    secrets(encoded(checkpoint));
    const files: Files = new Map([['source.json', encoded(descriptor)], ['checkpoint.json', encoded(checkpoint)]]);
    for (const entry of Object.values(checkpoint.entries)) { const name = 'artifacts/' + entry.hash + '.json'; if (!files.has(name)) files.set(name, await readBounded(path.join(source, name), b)); }
    for(const entry of Object.values(checkpoint.entries).filter(e=>e.type==='asset')) {const asset=parsed(assetDescriptorSchema,json(files.get('artifacts/'+entry.hash+'.json')!)); const name='assets/blobs/'+asset.content_sha256; if(!files.has(name)) files.set(name,await readBounded(path.join(source,name),b));}
    let auditBytes = Buffer.alloc(0); try { auditBytes = await readBounded(path.join(source, 'audit.jsonl'), b); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const rawAudit = utf8(auditBytes).split('\n').filter(Boolean).map(line => parsed(auditSchema, json(Buffer.from(line)))).filter(e => !e.action.startsWith('context.'));
    files.set('audit.jsonl', Buffer.from(rawAudit.map(e => canonical(e)).join('\n') + (rawAudit.length ? '\n' : '')));
    const retained = Object.values(checkpoint.entries).map(e => ({ type: e.type, data: json(files.get('artifacts/' + e.hash + '.json')!) }));
    const profiles = archivedProfiles(retained);
    for (const profile of profiles) { const id=PROFILE_IDS.find(id=>profile===profileFingerprint(id)); if (!id) fail('BACKUP_MISSING_PROFILE', 6, 'An indexed realization needs an unavailable historical profile asset.'); files.set('profiles/' + profile + '.json', encoded(profileArchive(id))); }
    const runs=Object.values(checkpoint.entries).filter(e=>e.type==='git-revalidation-run').map(e=>json(files.get('artifacts/'+e.hash+'.json')!));
    const revalidationAssets=[...new Set(runs.map(r=>r.descriptor_sha256 as string))].sort();
    for(const run of runs)files.set('profiles/'+run.descriptor_sha256+'.json',encoded(run.descriptor));
    const hasRevalidation=Object.values(checkpoint.entries).some(e=>Object.hasOwn(REVALIDATION_SCHEMAS,e.type));
    const hasBuild = Object.values(checkpoint.entries).some(e => buildRecordType(e.type));
    let unindexed = 0; const indexed = new Set(Object.values(checkpoint.entries).map(e => e.hash + '.json'));
    await noLinks(path.join(source, 'artifacts'));
    for await (const item of await opendir(path.join(source, 'artifacts'))) { if (!indexed.has(item.name)) unindexed++; if (unindexed > BACKUP_LIMITS.files) fail('BACKUP_LIMIT', 5, 'The bounded staging-orphan inventory limit was exceeded.'); }
    const manifest = parsed(manifestSchema,{ format: (hasBuild || descriptor.model_version === BLOCK_MODEL) ? BUILD_BACKUP_FORMAT : hasRevalidation?REVALIDATION_BACKUP_FORMAT:descriptor.model_version===CONTENT_MODEL ? CONTENT_BACKUP_FORMAT : BACKUP_FORMAT, model_version: descriptor.model_version, storage_format: NODE_STATE_FORMAT, project_id: input.project, scope: 'full-indexed-project', checkpoint_sha256: bytesDigest(files.get('checkpoint.json')!), roots: Object.keys(checkpoint.entries).sort(), inventory: [...files].map(([name, bytes]) => ({ path: name, sha256: bytesDigest(bytes), bytes: bytes.length })).sort((a, c) => a.path.localeCompare(c.path)), exclusions: EXCLUSIONS, unindexed_orphans: unindexed, profile_assets: profiles, source_quiescence: 'exclusive-cooperative-lease',...((hasBuild || descriptor.model_version === BLOCK_MODEL) ? {capability:'profiles-and-host-publication/1',revalidation_assets:revalidationAssets} : hasRevalidation?{capability:'authoritative-revalidation-v0.1/1',revalidation_assets:revalidationAssets}:{}) });
    parsed(manifestSchema, manifest); validateSet(manifest, files, b);
    const manifestBytes = encoded(manifest); const manifestDigest = bytesDigest(manifestBytes); const complete = encoded({ format: 'strata-backup-complete/1', manifest_sha256: manifestDigest });
    const inactive = inactiveMarker(input.project, manifestDigest);
    const total = [...files.values(), manifestBytes, complete, inactive].reduce((sum, bytes) => sum + bytes.length, 0);
    if (total > b.max || [...files.values(), manifestBytes].some(bytes => bytes.length > BACKUP_LIMITS.file_bytes)) fail('BACKUP_LIMIT', 5, 'The complete output would exceed the recovery byte limit.');
    if (bytesDigest(await readBounded(path.join(source, 'registry.json'), { ...b, read: 0 })) !== bytesDigest(registryBytes) || bytesDigest(await readBounded(path.join(source, STATE_DESCRIPTOR), { ...b, read: 0 })) !== bytesDigest(descriptorBytes)) fail('STATE_CHANGED', 5, 'Source checkpoint changed during export.');
    await assertNoPendingGit(source);
    if (input.dryRun) await assertQuiesced(source);
    else { await destination(out, source); await mkdir(out, { recursive: true }); await writeFile(path.join(out, INACTIVE_MARKER), inactive, { flag: 'wx' }); for (const [name, bytes] of files) { checkTime(b); await noLinks(path.join(out, name)); await mkdir(path.dirname(path.join(out, name)), { recursive: true }); await writeFile(path.join(out, name), bytes, { flag: 'wx' }); } await writeFile(path.join(out, 'manifest.json'), manifestBytes, { flag: 'wx' }); await verifyWritten(out, manifest, files, b); checkTime(b); await writeFile(path.join(out, 'COMPLETE.json'), complete, { flag: 'wx' }); }
    return { format: manifest.format, project_id: input.project, scope: manifest.scope, records: manifest.roots.length, bytes: total, manifest_sha256: manifestDigest, checkpoint_sha256: manifest.checkpoint_sha256, unindexed_orphans: unindexed, exclusions: EXCLUSIONS, complete: !input.dryRun, quiescence: input.dryRun ? 'observed-only; apply requires an exclusive lease' : manifest.source_quiescence, output: out, inactive: true };
  } finally { await release?.(); }
}
async function verifyWritten(directory: string, manifest: Manifest, files: Files, b: Budget) {
  const copied: Files = new Map(); const checkBudget = { ...b, max: BACKUP_LIMITS.bytes, read: 0 };
  for (const item of manifest.inventory) { const bytes = await readBounded(path.join(directory, item.path), checkBudget); if (bytesDigest(bytes) !== item.sha256 || bytes.length !== item.bytes) fail('BACKUP_HASH_MISMATCH', 6, 'Written recovery bytes do not match their inventory.'); copied.set(item.path, bytes); }
  validateSet(manifest, copied, b); if (canonical([...files.keys()].sort()) !== canonical([...copied.keys()].sort())) fail('BACKUP_INCOMPLETE', 6, 'Copied inventory is incomplete.');
}
async function listing(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of await opendir(path.join(directory, prefix))) {
    const name = prefix ? prefix + '/' + entry.name : entry.name; await noLinks(path.join(directory, name));
    if (entry.isDirectory()) { if (!['artifacts', 'profiles','assets','assets/blobs'].includes(name)) fail('INVALID_PATH', 2, 'Backup has an unsupported directory.'); result.push(...await listing(directory, name)); }
    else { if (!entry.isFile()) fail('INVALID_PATH', 2, 'Backup inventory cannot contain links or special files.'); result.push(name); }
    if (result.length > BACKUP_LIMITS.files + 3) fail('BACKUP_LIMIT', 5, 'Backup file count exceeds its bounded limit.');
  }
  return result.sort();
}
async function loadBundle(input: { bundle: string; project: string; selector: string; expectedDigest?: string }, operation: string) {
  auth(operation, input.project, input.selector); const b = budget(); const directory = await noLinks(input.bundle);
  const complete = parsed(z.object({ format: z.literal('strata-backup-complete/1'), manifest_sha256: hash }).strict(), json(await readBounded(path.join(directory, 'COMPLETE.json'), b)));
  const manifestBytes = await readBounded(path.join(directory, 'manifest.json'), b); const manifestDigest = bytesDigest(manifestBytes); const manifest = parsed(manifestSchema, json(manifestBytes));
  if (utf8(manifestBytes) !== canonical(manifest)) fail('BACKUP_INVALID', 6, 'Manifest must be canonical JSON without duplicate keys.');
  if (complete.manifest_sha256 !== manifestDigest || (input.expectedDigest !== undefined && input.expectedDigest !== manifestDigest)) fail('BACKUP_HASH_MISMATCH', 6, 'The bundle does not match the completion marker or operator-pinned manifest digest.');
  if (manifest.project_id !== input.project) fail('BACKUP_PROJECT_MISMATCH', 4, 'The bundle does not match the explicitly expected project.');
  const names = new Set<string>(); const files: Files = new Map();
  for (const item of manifest.inventory) { relativeFile(item.path); if (names.has(item.path)) fail('BACKUP_INVALID', 6, 'Backup inventory repeats a path.'); names.add(item.path); const bytes = await readBounded(path.join(directory, item.path), b); if (bytes.length !== item.bytes || bytesDigest(bytes) !== item.sha256) fail('BACKUP_HASH_MISMATCH', 6, 'A declared file is corrupt or incomplete.'); files.set(item.path, bytes); }
  const actual = await listing(directory); const expected = [...names, 'manifest.json', 'COMPLETE.json'];
  if (actual.includes(INACTIVE_MARKER)) { const marker = parsed(z.object({ format: z.literal('strata-recovery-inactive/1'), project_id: z.string(), manifest_sha256: hash, identities_active: z.literal(false), requests_active: z.literal(false) }).strict(), json(await readBounded(path.join(directory, INACTIVE_MARKER), b))); if (marker.project_id !== input.project || marker.manifest_sha256 !== manifestDigest) fail('BACKUP_PROJECT_MISMATCH', 4, 'Inactive recovery binding disagrees with its manifest.'); expected.push(INACTIVE_MARKER); }
  if (canonical(actual) !== canonical(expected.sort())) fail('BACKUP_INCOMPLETE', 6, 'Backup contains missing or unmanifested files.');
  const state = validateSet(manifest, files, b); checkTime(b); return { directory, manifest, manifestBytes, manifestDigest, complete, files, ...state, b };
}
export async function verifyBackup(input: { bundle: string; project: string; selector: string; expectedDigest?: string; ref?: string }) {
  const bundle = await loadBundle(input, input.ref ? 'backup.inspect' : 'backup.verify');
  if (input.ref && !Object.hasOwn(bundle.records, input.ref)) fail('REF_NOT_FOUND', 3, 'Exact historical record is absent from this recovery copy.');
  return { verified: true, project_id: bundle.manifest.project_id, scope: bundle.manifest.scope, manifest_sha256: bundle.manifestDigest, checkpoint_sha256: bundle.manifest.checkpoint_sha256, records: bundle.manifest.roots.length, roots: bundle.manifest.roots, heads: bundle.checkpoint.heads, exclusions: bundle.manifest.exclusions, inactive: true, authors_authenticated: false,...(bundle.manifest.format===REVALIDATION_BACKUP_FORMAT?{historical_completion_verified:true,live_authority_checked:false,live_source_checked:false}:{}), ...(input.ref ? { ref: input.ref, record: bundle.records[input.ref] } : {}) };
}
export async function restoreBackup(input: { bundle: string; project: string; selector: string; expectedDigest: string; out: string; dryRun?: boolean }) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedDigest)) fail('INVALID_ARGUMENT', 2, 'Restore requires a trusted expected manifest SHA-256.');
  const bundle = await loadBundle(input, 'backup.restore'); const out = await destination(input.out, bundle.directory); await isolatedRestore(out);
  if (!input.dryRun) {
    await destination(out, bundle.directory); await isolatedRestore(out); await mkdir(out, { recursive: true });
    await writeFile(path.join(out, INACTIVE_MARKER), inactiveMarker(input.project, bundle.manifestDigest), { flag: 'wx' });
    for (const [name, bytes] of bundle.files) { checkTime(bundle.b); await noLinks(path.join(out, name)); await mkdir(path.dirname(path.join(out, name)), { recursive: true }); await writeFile(path.join(out, name), bytes, { flag: 'wx' }); }
    await writeFile(path.join(out, 'manifest.json'), bundle.manifestBytes, { flag: 'wx' }); await verifyWritten(out, bundle.manifest, bundle.files, bundle.b); checkTime(bundle.b); await writeFile(path.join(out, 'COMPLETE.json'), encoded(bundle.complete), { flag: 'wx' });
  }
  return { verified: true, restored: !input.dryRun, inactive: true, project_id: input.project, output: out, manifest_sha256: bundle.manifestDigest, records: bundle.manifest.roots.length, identities_active: false, requests_active: false, next_action: 'Inspect exact refs offline. Resuming authoring requires a separate explicit local trust/configuration binding, which is deferred.' };
}
export function backupError(error: unknown): StrataError { return error instanceof StrataError ? error : new StrataError('BACKUP_UNAVAILABLE', 9, 'Recovery I/O failed. Any partial destination is incomplete and must not be activated.'); }
