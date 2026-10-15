import { HOST_RECORD_SCHEMAS, hostAuthoringReviewSchema, storedHostApprovalSchema, hostResolutionSchema, hostValidationSchema, authReceiptSchema } from '../auth/records.js';
import { z } from 'zod';
import { CONTENT_MODEL, MODEL, BLOCK_MODEL, blockSnapshotSchema, blockAuthoringReviewSchema, assetDescriptorSchema, authoringReviewSchema, approvalSchema, contentApprovalSchema, snapshotSchema, contentSnapshotSchema, parseLayer, parseComposition, parseEvidence, canonical, digest, bytesDigest, checkTree, type Records } from '../model.js';
import { normalizeLayer, normalizeComposition, snapshotFromRelease } from '../core.js';
import { verifyRealization } from '../profile.js';
import { MEDIATION_SCHEMAS, HOST_MEDIATION_SCHEMAS } from '../mediation.js';
import { LIMITS, problem, safeJson } from './contract.js';
import { BUILD_RECORD_SCHEMAS, buildRecordType, verifyBuildHistory } from '../build-records.js';
import { BUILD_ATTEMPT_SCHEMAS, attemptRecordType, verifyBuildAttempts } from '../build-attempt-records.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
const storedApproval = approvalSchema.extend({ principal: z.string().min(1), trust: z.literal('local-fixture'), ref }).strict();
const storedContentApproval = contentApprovalSchema.extend({ principal: z.string().min(1), trust: z.literal('local-fixture'), ref }).strict();
const validation = z.object({ candidate: hash, target: ref, realization: ref, evidence: z.unknown(), evidence_digest: hash, trust: z.literal('local-fixture-import') }).strict();
const resolution = z.object({ layer: ref, proposal_index: z.number().int().nonnegative(), payload: z.unknown(), approvals: z.array(ref), sealed_by: z.string().min(1), trust: z.literal('local-fixture') }).strict();
const interaction = z.object({ composition: ref, candidate: hash, principal: z.string().min(1), message: z.string(), ref }).strict();
const releaseFields = { baseline: ref, candidate: hash, provenance: z.record(z.string(), z.array(ref)), lineage: z.array(ref), resolutions: z.array(ref), acceptance_manifest: z.array(z.unknown()), validation: ref, approvals: z.array(ref), state: z.literal('validated'), trust: z.literal('local-fixture') };
const coverageSchema = z.array(z.object({ item: z.string().min(1), facets: z.array(z.enum(['behavior','design','data','safety'])), subjects: z.array(z.string()), status: z.literal('implemented_validation_pending'), capability: z.string().min(1), rationale: z.string(), outputs: z.array(z.object({ path: z.string(), digest: hash }).strict()), checks: z.array(z.object({ check: z.string(), version: z.string(), fixture: z.string(), method: z.enum(['mechanical','review']) }).strict()), facet_handling: z.record(z.string(), z.string()) }).strict());

// Pure read validation only. No writer Engine operation, file materialization,
// mediation installation or invocation of a declared check is performed.
export function validateRecords(records: Records, project: string, model: string) {
  try {
    if (![MODEL, CONTENT_MODEL, BLOCK_MODEL].includes(model) || Object.keys(records).length > LIMITS.records) throw new Error();
    safeJson(canonical(records), LIMITS.jsonBytes + LIMITS.registryBytes);
    for (const [key, record] of Object.entries(records)) {
      const d = record.data;
      if (!d || Array.isArray(d) || typeof d !== 'object' || (d.project_id !== undefined && d.project_id !== project) || (d.model_version !== undefined && d.model_version !== model)) throw new Error();
      switch (record.type) {
        case 'release': {
          const schema = model===BLOCK_MODEL?blockSnapshotSchema:model === CONTENT_MODEL ? contentSnapshotSchema : snapshotSchema;
          if (d.candidate !== undefined) schema.extend(model===BLOCK_MODEL?{...releaseFields,format:z.literal('release/3'),trust:z.literal('host-authenticated'),auth_receipt:ref}:releaseFields).strict().parse(d); else schema.parse(d);
          const snapshot = snapshotFromRelease(d); if (Object.keys(snapshot.blocks).length > LIMITS.blocks) problem('READ_LIMIT', 413, 'This project exceeds the current Studio read limit.');
          checkTree(snapshot);
          if (d.candidate === undefined && key !== `${d.id}@${d.revision}`) throw new Error();
          if (d.candidate !== undefined && key !== 'release@' + digest(d).slice(0, 24)) throw new Error();
          break;
        }
        case 'layer': parseLayer(d); if (key !== `${d.id}@${d.revision}`) throw new Error(); break;
        case 'composition': parseComposition(d); normalizeComposition(structuredClone(d)); if (key !== `${d.id}@${d.revision}`) throw new Error(); break;
        case 'approval': (model===BLOCK_MODEL?storedHostApprovalSchema:d.format ? storedContentApproval : storedApproval).parse(d); if (d.ref !== key || key !== 'approval@' + digest(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'ref'))).slice(0, 24)) throw new Error(); break;
        case 'validation': if(model===BLOCK_MODEL)hostValidationSchema.parse(d);else{validation.parse(d);parseEvidence(d.evidence);} if (key !== 'validation@' + digest(d).slice(0, 24)) throw new Error(); break;
        case 'resolution': (model===BLOCK_MODEL?hostResolutionSchema:resolution).parse(d); if (key !== 'resolution@' + digest(d).slice(0, 24)) throw new Error(); break;
        case 'realization': {
          const allowed = ['protocol_version','model_version','target','candidate','profile_id','profile','output_tree','files','coverage','reverse_links','trust','asset_manifest','asset_closure_sha256','format','checker_sha256','fixture_sha256','oracle_sha256','oracle'];
          if (Object.keys(d).some(k => !allowed.includes(k)) || d.protocol_version !== '1' || d.trust !== 'local-template' || !Array.isArray(d.coverage) || !d.reverse_links) throw new Error();
          hash.parse(d.candidate); ref.parse(d.target); z.record(z.string(), z.string()).parse(d.files); coverageSchema.parse(d.coverage); z.record(z.string(), z.array(z.string())).parse(d.reverse_links); verifyRealization(d);
          if (new Set(d.coverage.map((c: any) => c.item)).size !== d.coverage.length || canonical(Object.keys(d.reverse_links).sort()) !== canonical(Object.keys(d.files).sort())) throw new Error();
          for (const c of d.coverage) for (const output of c.outputs) if (!Object.hasOwn(d.files, output.path) || output.digest !== bytesDigest(d.files[output.path])) throw new Error();
          for (const [filename, items] of Object.entries(d.reverse_links) as [string,string[]][]) for (const item of items) if (!d.coverage.some((c: any) => c.item === item && c.outputs.some((o: any) => o.path === filename))) throw new Error();
          if (key !== 'realization@' + digest(d).slice(0,24)) throw new Error(); break;
        }
        case 'asset': assetDescriptorSchema.parse(d); if (key !== 'asset@' + digest(d)) throw new Error(); break;
        case 'authoring-review': (model===BLOCK_MODEL?hostAuthoringReviewSchema:authoringReviewSchema).parse(d); if (key !== 'authoring-review@' + digest(d)) throw new Error(); break;
        case 'interaction': interaction.parse(d); if (d.ref !== key || key !== 'interaction@' + digest(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'ref'))).slice(0,24)) throw new Error(); break;
        default: {
          if (attemptRecordType(record.type)) { BUILD_ATTEMPT_SCHEMAS[record.type].parse(d); if (key !== record.type + '@' + digest(d)) throw new Error(); break; }
          if (buildRecordType(record.type)) { BUILD_RECORD_SCHEMAS[record.type].parse(d); if (key !== record.type + '@' + digest(d)) throw new Error(); break; }
          const schema = (model===BLOCK_MODEL?{...HOST_MEDIATION_SCHEMAS,...HOST_RECORD_SCHEMAS}:MEDIATION_SCHEMAS)[record.type as keyof typeof MEDIATION_SCHEMAS];
          if (!schema) throw new Error(); schema.parse(d); if (key !== record.type + '@' + digest(d)) throw new Error();
        }
      }
    }
    const requireRef = (key: string, type: string | undefined, published: boolean) => {
      const found = records[key]; if (!found || (type && found.type !== type) || (published && !found.published)) throw new Error(); return found.data;
    };
    for (const record of Object.values(records)) {
      const d = record.data, pub = record.published;
      if (record.type === 'layer') {
        const base = requireRef(d.baseline, 'release', pub); normalizeLayer(structuredClone(d), snapshotFromRelease(base));
        for (const r of [...d.requires_layers, ...d.read_set.map((r: any) => r.layer)]) requireRef(r, 'layer', pub);
        if (d.derived_from) requireRef(d.derived_from.against, 'release', pub);
      }
      if (record.type === 'composition') {
        requireRef(d.baseline, 'release', pub); for (const r of d.proposals) requireRef(r, 'layer', pub); for (const r of d.resolutions) requireRef(r, 'resolution', pub);
      }
      if (record.type === 'release') {
        if (d.baseline) requireRef(d.baseline, 'release', pub);
        for (const r of [...(d.lineage ?? []), ...Object.values(d.provenance ?? {}).flat()]) requireRef(r as string, 'layer', pub);
        if (d.validation) requireRef(d.validation, 'validation', pub);
        for (const r of d.approvals ?? []) requireRef(r, 'approval', pub);
        for (const r of d.resolutions ?? []) requireRef(r, 'resolution', pub);
        for (const b of Object.values(d.blocks) as any[]) for (const a of Object.values(b.asset_refs ?? {}) as any[]) { const desc = requireRef(a.asset_ref, 'asset', pub); if (desc.content_sha256 !== a.content_sha256) throw new Error(); }
      }
      if (record.type === 'validation') { requireRef(d.target, undefined, pub); requireRef(d.realization, 'realization', pub); }
      if (record.type === 'realization') requireRef(d.target, undefined, pub);
      if (record.type === 'approval' && d.format) {
        requireRef(d.baseline, 'release', pub);
        if (d.binding) for (const [k,t] of [['basis_ref','mediation-basis'],['packet_ref','decision-packet'],['receipt_ref','mediation-receipt']]) requireRef(d.binding[k], t, pub);
      }
      if (record.type === 'resolution') {
        const layer = requireRef(d.layer, 'layer', pub);
        if (!layer.resolution_proposals[d.proposal_index] || canonical(layer.resolution_proposals[d.proposal_index]) !== canonical(d.payload)) throw new Error();
        for (const r of d.approvals) requireRef(r, 'approval', pub);
      }
      if (record.type === 'authoring-review') requireRef(d.draft_ref, 'layer', false);
      if (record.type === 'interaction' || record.type === 'interaction-report') requireRef(d.composition, 'composition', pub);
      if(d.auth_receipt && !buildRecordType(record.type)){const auth=authReceiptSchema.parse(requireRef(d.auth_receipt,'auth-receipt',pub));const principal=d.principal??d.producer??d.reviewer??d.sealed_by;if(principal&&principal!==auth.principal_id)throw new Error();}
      if(record.type==='validation'&&model===BLOCK_MODEL){requireRef(d.evidence.run_ref,'host-run',pub);for(const r of d.evidence.results)if(r.review_ref)requireRef(r.review_ref,'criterion-review',pub);}
      if(['host-run','criterion-review'].includes(record.type))requireRef(d.realization,'realization',pub);
      // Validate typed supporting closure without interpreting arbitrary prose as refs.
      for (const k of ['basis_ref','packet_ref','report_ref','composition_ref','supersedes','grant_ref','policy_ref','receipt_ref','use_ref']) if (d[k]) requireRef(d[k], undefined, pub);
      for (const k of ['reports','evidence_refs','contributors','policies','grants']) if (Array.isArray(d[k])) for (const r of d[k]) requireRef(r, undefined, pub);
    }
    verifyBuildHistory(records, project);
    verifyBuildAttempts(records, project);
  } catch (error) {
    if ((error as any)?.code === 'READ_LIMIT') throw error;
    problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
  }
}
