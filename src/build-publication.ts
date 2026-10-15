import { Engine, snapshotFromRelease } from './core.js';
import { BLOCK_MODEL, canonical, digest, fail, parse, set, StrataError, type Approval, type Records, type Stored } from './model.js';
import { authReceiptSchema, hostValidationSchema, storedHostApprovalSchema } from './auth/records.js';
import { validateRecords } from './explorer/validate.js';
import { mediationArchiveReferences, verifyMediationHistory } from './mediation.js';
import { assertSelectionApprovalBinding, assertSelectionSealBinding } from './mediation-bindings.js';
import { assertPublicationApprovals } from './publication-approvals.js';
import type { BuildPin } from './build-contracts.js';

export type PublicationContext = {
  project_id: string; records: Records; asset_bytes?: Map<string, Uint8Array>;
  // Trust comes from the admitted source, not owner login or fields in an imported record.
  source_trust: 'local-fixture' | 'host-authenticated' | 'legacy-history-authenticated-authoring';
  visible?: (ref: string) => boolean;
};
export type PublicationReport = {
  format: 'strata-build-publication-report/1'; state: 'approved' | 'excluded' | 'unavailable' | 'corrupt' | 'unsupported';
  code: string; message: string; historically_approved: boolean; execution_authorized: null;
  source_trust: PublicationContext['source_trust']; record_trust: 'local-fixture' | 'host-authenticated' | null;
  release: BuildPin | null; composition: BuildPin | null; validation: BuildPin | null; realization: BuildPin | null;
  approvals: BuildPin[]; closure: BuildPin[];
};
// Exact typed edges only. Never scan prose for something that resembles a ref.
function references(r: Stored): string[] {
  const d = r.data;
  let refs: string[] = [];
  switch (r.type) {
    case 'release': refs = [d.baseline, d.validation, ...(d.lineage ?? []), ...Object.values(d.provenance ?? {}).flat(), ...(d.approvals ?? []), ...(d.resolutions ?? [])].filter(Boolean) as string[];
      for (const b of Object.values(d.blocks) as any[]) for (const a of Object.values(b.asset_refs ?? {}) as any[]) refs.push(a.asset_ref); break;
    case 'composition': refs = [d.baseline, ...d.proposals, ...d.selected, ...d.resolutions]; break;
    case 'layer': refs = [d.baseline, ...d.requires_layers, ...d.read_set.map((v: any) => v.layer), ...(d.derived_from ? [d.derived_from.against] : [])]; break;
    case 'validation': refs = [d.target, d.realization, ...(d.evidence.run_ref ? [d.evidence.run_ref] : []), ...d.evidence.results.flatMap((v: any) => v.review_ref ? [v.review_ref] : [])]; break;
    case 'realization': refs = [d.target]; break;
    case 'approval': refs = [d.baseline, ...(d.binding ? [d.binding.basis_ref, d.binding.packet_ref, d.binding.receipt_ref] : [])].filter(Boolean); break;
    case 'resolution': refs = [d.layer, ...d.approvals, ...(d.payload.basis_ref ? [d.payload.basis_ref] : [])]; break;
    case 'host-run': case 'criterion-review': refs = [d.realization]; break;
    case 'authoring-review': refs = [d.draft_ref]; break;
    default: refs = mediationArchiveReferences(r.type, d);
  }
  if (d.auth_receipt) refs.push(d.auth_receipt);
  return [...new Set(refs)];
}

/** Pure historical projection: no release(), registration, live approvals, I/O or checks run. */
export function inspectReleasePublication(context: PublicationContext, releaseRef: string): PublicationReport {
  const result: PublicationReport = {
    format: 'strata-build-publication-report/1', state: 'corrupt', code: 'BUILD_PUBLICATION_CORRUPT', message: 'Retained publication closure could not be verified.',
    historically_approved: false, execution_authorized: null, source_trust: context.source_trust, record_trust: null,
    release: null, composition: null, validation: null, realization: null, approvals: [], closure: []
  };
  const unavailable = () => ({ ...result, state: 'unavailable' as const, code: 'BUILD_SOURCE_UNAVAILABLE', message: 'Publication history is unavailable in this read scope.' });
  if (context.visible && !context.visible(releaseRef)) return unavailable();
  const selected = context.records[releaseRef];
  if (!selected || !selected.published) return unavailable();
  if (selected.type !== 'release') return { ...result, state: 'excluded', code: 'BUILD_RELEASE_REQUIRED', message: 'Build requires an approved published Release.' };
  if (selected.data.candidate === undefined) return { ...result, state: 'excluded', code: 'BUILD_BOOTSTRAP_EXCLUDED', message: 'Bootstrap is a baseline without publication validation or approvals.' };
  try {
    const closure: Records = Object.create(null), pending = [releaseRef];
    while (pending.length) {
      const ref = pending.pop()!;
      if (Object.hasOwn(closure, ref)) continue;
      if (context.visible && !context.visible(ref)) return unavailable();
      const record = context.records[ref];
      if (!record || !record.published) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Required publication record is absent.');
      closure[ref] = structuredClone(record);
      if (Object.keys(closure).length > 1000) fail('BUILD_PUBLICATION_LIMIT', 8, 'Publication closure exceeds the bounded read limit.');
      pending.push(...references(record));
      // Published content Layers require retained exact accepted authoring review.
      if (record.type === 'layer' && record.data.model_version !== 'strata/0.1-facets-experimental' && (record.data.changes.length || record.data.acceptance.length || record.data.created_blocks?.length)) {
        const reviews = Object.entries(context.records).filter(([, r]) => r.type === 'authoring-review' && r.published && r.data.accepted && r.data.draft_ref === ref && r.data.draft_digest === digest(record.data));
        const visible = reviews.filter(([ref]) => !context.visible || context.visible(ref));
        if (!visible.length && reviews.length) return unavailable();
        if (!visible.length) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Published content Layer lacks its admitted authoring review.');
        // An exact review is sufficient; use stable identity, not timestamp precedence.
        pending.push(visible.map(([ref]) => ref).sort()[0]);
      }
    }
    const model = selected.data.model_version;
    validateRecords(closure, context.project_id, model);
    const engine = new Engine(closure, {}, { projectId: context.project_id, modelVersion: model, assetBytes: context.asset_bytes, historical: true, checkerBackend: 'node' });
    verifyMediationHistory(engine, context.project_id);
    for (const record of Object.values(closure)) {
      const d = record.data;
      if (model === BLOCK_MODEL && record.type === 'authoring-review') engine.checkAuth(d.auth_receipt, d.reviewer, ['content.review']);
      if (model === BLOCK_MODEL && record.type === 'mediation-receipt') engine.checkAuth(d.auth_receipt, d.principal, ['mediation.respond']);
      if (record.type === 'resolution') {
        const layer = engine.read(d.layer, 'layer'), baseline = engine.read(layer.baseline, 'release');
        const unsigned = digest({ layer: d.layer, proposal_index: d.proposal_index, payload: d.payload });
        const approvals = d.approvals.map((ref: string) => engine.read(ref, 'approval'));
        if (!approvals.some((a: any) => a.kind === 'resolution' && a.target === unsigned && a.scope === d.payload.scope && a.evidence_digest === null && baseline.authorities.scopes.some((s: any) => s.block === a.scope && s.selectors.includes(a.principal)))) fail('ENDORSEMENT_REQUIRED', 6, 'Retained Resolution lacks its baseline selector endorsement.');
        for (const a of approvals) if (a.format) {
          if (!a.binding) fail('ENDORSEMENT_REQUIRED', 6, 'Selection approval requires a server response/use receipt.');
          assertSelectionApprovalBinding(a, a.principal, engine.read(a.binding.basis_ref, 'mediation-basis'), engine.read(a.binding.packet_ref, 'decision-packet'), engine.read(a.binding.receipt_ref, 'mediation-receipt'));
        }
      }
    }
    // Check every retained ancestor publication as well as the selected one.
    for (const [ref, record] of Object.entries(closure)) if (record.type === 'release' && record.data.validation) {
      const release = engine.read(ref, 'release'), validation = engine.read(release.validation, 'validation');
      const composition = engine.read(validation.target, 'composition'), evaluation = engine.target(validation.target);
      for (const ref of composition.resolutions) {
        const resolution = engine.read(ref, 'resolution');
        if (resolution.payload.basis_ref) assertSelectionSealBinding(resolution.payload, composition, engine.read(resolution.payload.basis_ref, 'mediation-basis'), () => evaluation.input_fingerprint);
      }
      if (evaluation.state === 'blocked' || release.candidate !== evaluation.fingerprint || validation.candidate !== release.candidate || release.baseline !== composition.baseline || canonical(snapshotFromRelease(release)) !== canonical(evaluation.snapshot) || canonical(release.provenance) !== canonical(evaluation.provenance) || canonical(release.acceptance_manifest) !== canonical(evaluation.obligations) || canonical(release.resolutions) !== canonical(composition.resolutions)) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Release is not the exact flattened publication candidate.');
      const baseline = engine.read(composition.baseline, 'release');
      const lineage = set([...(baseline.lineage ?? []), ...composition.selected]);
      if (canonical(release.lineage) !== canonical(lineage) || canonical(release.approvals) !== canonical(set(release.approvals))) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Release lineage or approval set differs from publication.');
      const realization = engine.read(validation.realization, 'realization');
      if (canonical(engine.realize(validation.target, realization.profile_id)) !== canonical(realization)) fail('STALE_REALIZATION', 6, 'Historical realization differs from its exact compiled materializer.');
      const checked = engine.checkValidation(validation.target, validation.realization, validation.evidence);
      const { auth_receipt, ...storedValidation } = validation;
      if (canonical(checked) !== canonical(auth_receipt ? storedValidation : validation)) fail('STALE_EVIDENCE', 6, 'Historical validation differs from exact retained evidence.');
      const approvals = release.approvals.map((r: string) => engine.read(r, 'approval')) as Approval[];
      assertPublicationApprovals(snapshotFromRelease(baseline), evaluation, validation.evidence_digest, approvals);
      for (const a of approvals as any[]) {
        const authorized = a.kind === 'release' ? a.scope === null && baseline.authorities.release.includes(a.principal)
          : a.kind === 'scope' ? a.scope === evaluation.scope && baseline.authorities.scopes.some((s: any) => s.block === a.scope && s.selectors.includes(a.principal))
          : a.kind === 'guardian' && baseline.authorities.guardians.some((g: any) => g.item === a.scope && g.principal === a.principal);
        if (!authorized) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Historical endorsement lacks pinned baseline authority.');
        if (a.format && (a.baseline !== composition.baseline || a.authority_sha256 !== digest(baseline.authorities) || a.binding !== null)) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Historical publication approval authority binding differs.');
      }
      if (model === BLOCK_MODEL) {
        const valid = parse(hostValidationSchema, validation), auth = parse(authReceiptSchema, engine.read(valid.auth_receipt, 'auth-receipt'));
        engine.checkAuth(valid.auth_receipt, auth.principal_id, ['validate']);
        for (const a of approvals) { const typed = parse(storedHostApprovalSchema, a); engine.checkAuth(typed.auth_receipt, typed.principal, ['approve', 'mediation.respond']); }
        const publicationAuth = parse(authReceiptSchema, engine.read(release.auth_receipt, 'auth-receipt'));
        engine.checkAuth(release.auth_receipt, publicationAuth.principal_id, ['release']);
        // Receipt request hashes were taken before set normalization. Historical reads
        // preserve the admitted trust boundary; they cannot reconstruct raw input order.
      }
    }
    const pin = (ref: string): BuildPin => ({ ref, sha256: digest(closure[ref].data) });
    const release = selected.data, validation = closure[release.validation].data;
    return { ...result, state: 'approved', code: 'BUILD_PUBLICATION_APPROVED', message: 'Exact historical publication closure is retained; current execution authority is separate.', historically_approved: true,
      record_trust: release.trust, release: pin(releaseRef), composition: pin(validation.target), validation: pin(release.validation), realization: pin(validation.realization),
      approvals: release.approvals.map(pin), closure: Object.keys(closure).sort().map(pin) };
  } catch (error) {
    if (error instanceof StrataError && error.exit === 8) return { ...result, state: 'unsupported', code: error.code, message: error.message };
    // Corrupt diagnostics carry no hidden refs or record contents.
    return result;
  }
}
