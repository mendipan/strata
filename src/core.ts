import { z } from 'zod';
import { authReceiptSchema, hostAuthoringReviewSchema, hostApprovalSchema, storedHostApprovalSchema, hostResolutionSchema, hostEvidenceSchema, hostValidationSchema, hostRunSchema, criterionReviewSchema } from './auth/records.js';
import { MODEL, CONTENT_MODEL, BLOCK_MODEL, isContentModel, hostSelectionSchema, blockAuthoringReviewSchema, parseLayer, parseComposition, parseEvidence, authoringReviewSchema, type Snapshot, type Layer, type Composition, type Records, type Stored, type Approval, type Evidence, normalizeSnapshot, parse, layerSchema, compositionSchema, approvalSchema, evidenceSchema, fail, canonical, digest, set, item, write, matches, itemRef, checkTree, responsible, impactClosure, blockFacets, ancestors } from './model.js';
import { materialize, compatibleProfile, boundProfile, profileFor, evaluateScenario, type Realization, verifyRealization } from './profile.js';

import type { Mediation } from './mediation.js';
import { contentApprovalSchema, contentSelectionSchema } from './model.js';
import { checkAssetClosure } from './assets.js';
import { adoptionRequired } from './adoption/guard.js';
import { obligations } from './obligations.js';
import { assertPublicationApprovals } from './publication-approvals.js';
import { assertBoundReleaseMaterializer } from './build-materialization-guard.js';
export { obligations } from './obligations.js';
export type Evaluation = { state: 'blocked' | 'eligible_for_validation' | 'validated'; fingerprint: string; input_fingerprint: string; diagnostics: { code: string; message: string; details?: unknown }[]; snapshot: Snapshot; provenance: Record<string, string[]>; impact: string[]; scope: string; obligations: ReturnType<typeof obligations> };
export function normalizeLayer(input: unknown, baseline: Snapshot): Layer {
  if ((input as any)?.changes?.some((c: any) => c.op !== 'set_item')) fail('UNSUPPORTED_CAPABILITY', 8, 'The prototype only supports set_item changes.');
  const layer = parseLayer(input);
  if(layer.model_version !== baseline.model_version) fail('UNSUPPORTED_MODEL_VERSION',8,'Layer and baseline must use the same explicit model.');

  layer.requires_layers = set(layer.requires_layers);
  layer.read_set = [...layer.read_set].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  if (new Set(layer.read_set.map(r => r.layer)).size !== layer.read_set.length) fail('INVALID_RECORD', 2, 'Duplicate peer read.');
  for (const read of layer.read_set) if (read.mode === 'required' && !layer.requires_layers.includes(read.layer)) fail('DEPENDENCY_REQUIRED', 5, 'A required read must be an exact selected dependency.');
  const seen = new Set<string>(); const scratch = structuredClone(baseline);
  if(layer.created_blocks?.length) {
    const ids=set(layer.created_blocks.map(b=>b.id));
    for(const block of layer.created_blocks) {
      if(baseline.blocks[block.id]||baseline.deleted_ids.includes(block.id))fail('BLOCK_ID_EXISTS',5,'Created Block ID is already present or deleted.');
      if(block.parent===null||!baseline.blocks[block.parent])fail('INVALID_CREATE_PARENT',2,'Creation requires an existing baseline parent.');
      if(Object.values(block.requirements).some(r=>r.kind==='invariant'))fail('GUARDIAN_ASSIGNMENT_REQUIRED',8,'New invariants require an explicit guardian assignment contract.');
      scratch.blocks[block.id]=structuredClone(block);
    }
    const normalized=normalizeSnapshot(scratch);
    layer.created_blocks=ids.map(id=>normalized.blocks[id]);
  }
  for (const change of layer.changes) {
    const key = itemRef(change.block, change.path);
    if (seen.has(key)) fail('DUPLICATE_WRITE', 2, 'A Layer writes a semantic item twice.', { key });
    seen.add(key);
    const block = baseline.blocks[change.block];
    if (!block) fail('REF_NOT_FOUND', 3, 'A Layer may only patch existing baseline Blocks.');
    if (change.expected.kind === 'value') { const expectedBlock = structuredClone(block); write(expectedBlock, change.path, change.expected.value); change.expected.value = item(expectedBlock, change.path).value; }
    if (!matches(item(block, change.path), change.expected)) fail('BASELINE_PRECONDITION', 5, 'Preconditions must match the pinned baseline.', { key });
    write(scratch.blocks[change.block], change.path, change.value);
    change.value = item(scratch.blocks[change.block], change.path).value;
  }
  for (const acceptance of layer.acceptance) {
    const key = itemRef(acceptance.block, 'acceptance.' + acceptance.id);
    if (!scratch.blocks[acceptance.block]) fail('REF_NOT_FOUND', 3, 'Layer acceptance target is absent.');
    if (seen.has(key) || item(baseline.blocks[acceptance.block], 'acceptance.' + acceptance.id).exists) fail('DUPLICATE_WRITE', 2, 'Layer acceptance must add a new uniquely keyed criterion.');
    seen.add(key); write(scratch.blocks[acceptance.block], 'acceptance.' + acceptance.id, acceptance.criterion);
    acceptance.criterion = scratch.blocks[acceptance.block].acceptance[acceptance.id];
  }
  if (layer.resolution_proposals.length && (layer.changes.length || layer.acceptance.length || layer.created_blocks?.length)) fail('INVALID_DECISION_LAYER', 2, 'Decision Layers cannot carry behavioral changes or acceptance.');
  for (const proposal of layer.resolution_proposals) { proposal.impact = set(proposal.impact); proposal.outcome.selected = set(proposal.outcome.selected); proposal.outcome.rejected = set(proposal.outcome.rejected); }
  layer.changes.sort((a, b) => itemRef(a.block, a.path).localeCompare(itemRef(b.block, b.path)));
  layer.acceptance.sort((a, b) => itemRef(a.block, a.id).localeCompare(itemRef(b.block, b.id)));
  for (const assumption of layer.assumptions) {
    const block = baseline.blocks[assumption.block]; if (!block) fail('REF_NOT_FOUND', 3, 'Assumption target is absent from the baseline.');
    if (assumption.expected.kind === 'value') { const expectedBlock = structuredClone(block); write(expectedBlock, assumption.path, assumption.expected.value); assumption.expected.value = item(expectedBlock, assumption.path).value; }
  }
  layer.assumptions.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  checkTree(scratch);
  return layer;
}
export function normalizeComposition(input: unknown): Composition {
  const composition = parseComposition(input);
  for (const key of ['proposals', 'selected', 'resolutions'] as const) composition[key] = set(composition[key]);
  composition.alternative_groups = composition.alternative_groups.map(g => ({ ...g, members: set(g.members) })).sort((a, b) => a.id.localeCompare(b.id));
  composition.scenario.checks.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  if (new Set(composition.scenario.checks.map(c => c.id)).size !== composition.scenario.checks.length) fail('INVALID_RECORD', 2, 'Duplicate scenario check.');
  if (new Set(composition.alternative_groups.map(g => g.id)).size !== composition.alternative_groups.length) fail('INVALID_RECORD', 2, 'Duplicate alternative group.');
  if (composition.selected.some(r => !composition.proposals.includes(r))) fail('INVALID_RECORD', 2, 'Selected Layers must belong to the considered proposal set.');
  for (const group of composition.alternative_groups) if (group.min > group.max || group.members.some(r => !composition.proposals.includes(r))) fail('INVALID_RECORD', 2, 'Invalid alternative group.');
  return composition;
}
export function contextFingerprint(composition: Composition): string {
  return digest({ model_version: composition.model_version, baseline: composition.baseline, proposals: composition.proposals, alternative_groups: composition.alternative_groups, scenario: composition.scenario });
}
export class Engine {
  adoptionPublication?: (ref: string, principal: string, review?: string) => { ref: string };
  retainedAuthority?:(principal:string,operation:string,kind?:string,epoch?:number)=>boolean;
  authentication?:{receipt:any;assertLive:()=>void};
  authReceipt(action?:string){if(!this.authentication)fail('AUTHENTICATION_REQUIRED',4,'v0.3 authority requires a server-authenticated actor.');this.authentication.assertLive();const data=parse(authReceiptSchema,this.authentication.receipt);if(action&&data.action!==action)fail('AUTHORITY_FORBIDDEN',4,'Authenticated receipt belongs to a different operation.');const ref='auth-receipt@'+digest(data);this.store(ref,'auth-receipt',data);return ref;}
  checkAuth(ref:string,principal:string,actions:string[]){const data=parse(authReceiptSchema,this.read(ref,'auth-receipt'));if(ref!=='auth-receipt@'+digest(data)||data.project_id!==this.options.projectId||data.principal_id!==principal||!actions.includes(data.action))fail('AUTHENTICATION_REQUIRED',4,'The exact authenticated action closure is missing or inconsistent.');return data;}
  mediation?: Mediation;
  constructor(public records: Records = {}, public ownerHeads: Record<string, { owner: string; head: number }> = {}, public options: { projectId?: string; checkerBackend?:'node'|'none'; assetBytes?: Map<string,Uint8Array>; modelVersion?: typeof MODEL | typeof CONTENT_MODEL | typeof BLOCK_MODEL; historical?:boolean } = {}) {}
  modelVersion() { return Object.values(this.records).find(r=>r.type==='release')?.data.model_version ?? this.options.modelVersion ?? MODEL; }
  closure(snapshot: Snapshot) { checkAssetClosure(snapshot,this.records,this.options.assetBytes,this.options.projectId); }
  mediationGate() { if(isContentModel(this.modelVersion())) {if(!this.mediation || !Object.values(this.records).some(r=>r.type==='mediation-installation')) fail('UNSUPPORTED_CAPABILITY',8,'v0.2 mediation requires a server-bound, explicitly installed fixture runtime.');this.mediation.installed();} }
  read(ref: string, type?: string, published = true): any {
    const record = this.records[ref];
    if (!record || (type && record.type !== type) || (published && !record.published)) fail('REF_NOT_FOUND', 3, 'Pinned published reference was not found.', { ref, type });
    return structuredClone(record.data);
  }
  store(ref: string, type: string, data: unknown, published = true) {
    const existing = this.records[ref];
    if (existing && (existing.type !== type || canonical(existing.data) !== canonical(data))) fail('IMMUTABLE_REFERENCE', 5, 'An immutable reference already has different content.', { ref });
    this.records[ref] = { type, data: structuredClone(data), published: published || !!existing?.published };
    return ref;
  }
  init(input: unknown, principal: string, verifiedInitialization=false) {
    if (!verifiedInitialization && principal !== 'bootstrap') fail('OWNER_FORBIDDEN', 4, 'Initialization needs an explicit verified bootstrap grant.');
    const snapshot = normalizeSnapshot(input); if(this.options.modelVersion && snapshot.model_version!==this.options.modelVersion) fail('UNSUPPORTED_MODEL_VERSION',8,'Initialization must match the explicit node model.'); this.closure(snapshot); const ref = `${snapshot.id}@${snapshot.revision}`;
    if (Object.values(this.records).some(r=>r.type!=='asset')) {
      if (this.records[ref]?.type === 'release' && canonical(this.records[ref].data) === canonical(snapshot)) return { ref, reused: true };
      fail('PROJECT_EXISTS', 5, 'Initialization refuses to replace existing intent.');
    }
    this.store(ref, 'release', snapshot); return { ref, reused: false };
  }
  layer(input: unknown, principal: string, previous?: string) {
    const raw = input as Layer;
    if(isContentModel(raw.model_version) && raw.resolution_proposals?.length)this.mediationGate();
    if (raw.owner !== principal) fail('OWNER_FORBIDDEN', 4, 'Owner fields cannot replace the broker-authenticated principal.');
    const head = this.ownerHeads[raw.id];
    if (head && head.owner !== principal) fail('OWNER_FORBIDDEN', 4, 'This Layer belongs to another principal.');
    if (head && previous !== `${raw.id}@${head.head}`) fail('STALE_REVISION', 5, 'Revision must be based on the current owned head.');
    if (!head && previous) fail('REF_NOT_FOUND', 3, 'Cannot revise an absent Layer.');
    if (raw.revision !== (head?.head ?? 0) + 1) fail('STALE_REVISION', 5, 'Use the next exact Layer revision.');
    if (previous && this.read(previous, 'layer', false).baseline !== raw.baseline) fail('UNSUPPORTED_CAPABILITY', 8, 'Revision cannot silently rebase a Layer.');
    const baseline=snapshotFromRelease(this.read(raw.baseline,'release')); this.closure(baseline); const layer = normalizeLayer(input,baseline);
    const draft=structuredClone(baseline);for(const b of layer.created_blocks??[])draft.blocks[b.id]=structuredClone(b); for(const c of layer.changes) write(draft.blocks[c.block],c.path,c.value); this.closure(draft);
    for (const read of layer.read_set) this.read(read.layer, 'layer');
    if (layer.derived_from) {
      const derived = layer.derived_from;
      for (const change of [...layer.changes, ...layer.acceptance.map(a => ({ block: a.block, path: 'acceptance.' + a.id }))]) {
        const traces = derived.traceability.filter(t => t.item === itemRef(change.block, change.path));
        if (traces.length !== 1 || !traces[0].files.length) fail('TRACEABILITY_REQUIRED', 2, 'Every distilled item needs one source trace.');
      }
    }
    const ref = `${layer.id}@${layer.revision}`; this.store(ref, 'layer', layer, false);
    this.ownerHeads[layer.id] = { owner: principal, head: layer.revision }; return { ref, published: false };
  }
  publish(ref: string, principal: string, review?: any, authoringReview?: string, adoptionReview?: string) {
    const layer: Layer = this.read(ref, 'layer', false);
    if (layer.owner !== principal) fail('OWNER_FORBIDDEN', 4, 'Only the owner may freeze a Layer revision.');
    if (layer.derived_from !== null) {
      const derived: any = layer.derived_from;
      if (derived.kind !== 'supplied_proposal' || !review || review.source_digest !== derived.source_digest || review.draft_digest !== digest(layer) || review.reviewer !== principal || review.accepted !== true || derived.questions?.length) fail('DISTILL_REVIEW_REQUIRED', 6, 'A distilled draft needs exact source/draft review and no unresolved questions.');
    }
    if(isContentModel(layer.model_version) && (layer.changes.length || layer.acceptance.length || layer.created_blocks?.length)) {
      if(!authoringReview) fail('AUTHORING_REVIEW_REQUIRED',6,'Exact content needs an explicit intent-authoring/1 review before publication.');
      const attestation=parse<any>(layer.model_version===BLOCK_MODEL?hostAuthoringReviewSchema:authoringReviewSchema,this.read(authoringReview,'authoring-review'));
      if(layer.model_version===BLOCK_MODEL){this.checkAuth((attestation as any).auth_receipt,attestation.reviewer,['content.review']);if(this.retainedAuthority&&!this.retainedAuthority(attestation.reviewer,'content.review',undefined,this.read(attestation.auth_receipt,'auth-receipt').credential_epoch))fail('ENDORSEMENT_REVOKED',6,'The authoring reviewer no longer has an active grant.');}
      if(attestation.project_id!==this.options.projectId || attestation.draft_ref!==ref || attestation.draft_digest!==digest(layer) || !attestation.accepted) fail('STALE_AUTHORING_REVIEW',6,'Authoring review does not accept this exact normalized draft.');
    }
    let adoption: { ref: string } | undefined;
    if (adoptionRequired(this.records, layer)) {
      if (!this.adoptionPublication) fail('UNSUPPORTED_SOURCE_BACKEND', 8, 'Adopted Layer publication requires trusted current source remeasurement.');
      adoption = this.adoptionPublication(ref, principal, adoptionReview);
    } else if (adoptionReview) fail('ADOPTION_PROPOSAL_REQUIRED', 6, 'An unadopted Layer cannot claim an adoption review.');
    this.records[ref].published = true; return { ref, published: true, ...(adoption ? { adoption_publication_ref: adoption.ref } : {}) };
  }
  contentReview(input: any, principal: string) {
    const request=parse(z.object({draft:z.unknown(),expected_digest:z.string().regex(/^[a-f0-9]{64}$/),accepted:z.boolean(),rationale:z.string().min(1)}).strict(),input);
    const raw=request.draft as Layer; const layer=normalizeLayer(raw,snapshotFromRelease(this.read(raw.baseline,'release')));
    if(!isContentModel(layer.model_version) || !this.options.projectId) fail('UNSUPPORTED_CAPABILITY',8,'Authoring review requires an explicit v0.2 project.');
    if(digest(layer)!==request.expected_digest) fail('STALE_AUTHORING_REVIEW',6,'Reviewer input does not match the exact normalized draft digest.');
    const data=parse<any>(layer.model_version===BLOCK_MODEL?hostAuthoringReviewSchema:authoringReviewSchema,{format:layer.model_version===BLOCK_MODEL?'authoring-review/2':'authoring-review/1',project_id:this.options.projectId,model_version:layer.model_version,draft_ref:`${layer.id}@${layer.revision}`,draft_digest:digest(layer),checklist:'intent-authoring/1',accepted:request.accepted,rationale:request.rationale,reviewer:principal,trust:layer.model_version===BLOCK_MODEL?'host-authenticated':'local-fixture',...(layer.model_version===BLOCK_MODEL?{auth_receipt:this.authReceipt('content.review')}:{})});
    const ref='authoring-review@'+digest(data); this.store(ref,'authoring-review',data); return {ref,review:data};
  }
  evaluate(compositionInput: Composition, hypothesis = false): Evaluation {
    const composition = normalizeComposition(compositionInput);
    const baselineRecord = this.read(composition.baseline, 'release');
    const baseline: Snapshot = snapshotFromRelease(baselineRecord);
    if (baseline.model_version !== composition.model_version) fail('UNSUPPORTED_MODEL_VERSION', 8, 'Cross-version composition is unsupported.');
    this.closure(baseline);
    const inputFingerprint = contextFingerprint(composition); const snapshot = structuredClone(baseline);
    const diagnostics: Evaluation['diagnostics'] = []; const add = (code: string, message: string, details?: unknown) => diagnostics.push({ code, message, details });
    const proposals = new Map<string, Layer>();
    for (const ref of composition.proposals) {
      const layer: Layer = this.read(ref, 'layer');
      if (layer.baseline !== composition.baseline || layer.model_version !== composition.model_version) add('MIXED_BASELINE', 'Selected proposals must share the exact baseline/model.', { ref });
      if (layer.resolution_proposals.length) add('DECISION_NOT_BEHAVIOR', 'Decision Layers must be referenced through sealed Resolutions.', { ref });
      proposals.set(ref, layer);
    }
    const impact = impactClosure(baseline, [...new Set([...proposals.values()].flatMap(l => [...l.changes.map(c => c.block), ...l.acceptance.map(c => c.block),...(l.created_blocks??[]).flatMap(b=>[b.parent!,...Object.values(b.relationships).map(r=>r.target),...Object.values(b.acceptance).flatMap(c=>c.subjects.map(v=>v.split('/')[0]).filter(id=>!!baseline.blocks[id]))])]))]);
    const scope = responsible(baseline, impact);
    for (const resolutionRef of composition.resolutions) {
      const resolution = this.read(resolutionRef, 'resolution');
      if(isContentModel(composition.model_version)) {
        if(composition.model_version===BLOCK_MODEL){const r=parse(hostResolutionSchema,resolution);this.checkAuth(r.auth_receipt,r.sealed_by,['resolve']);}
        parse<any>(composition.model_version===BLOCK_MODEL?hostSelectionSchema:contentSelectionSchema,resolution.payload);
        for(const ref of resolution.approvals) {const a=this.read(ref,'approval');if(composition.model_version===BLOCK_MODEL){const r=parse(storedHostApprovalSchema,a);this.checkAuth(r.auth_receipt,r.principal,['approve','mediation.respond']);}const {principal,trust,ref:embedded,auth_receipt,...request}=a;parse<any>(composition.model_version===BLOCK_MODEL?hostApprovalSchema:contentApprovalSchema,request);if(!a.binding || a.binding.basis_ref!==resolution.payload.basis_ref || a.binding.partition_sha256!==digest(resolution.payload.outcome) || a.target!==digest({layer:resolution.layer,proposal_index:resolution.proposal_index,payload:resolution.payload}) || a.baseline!==composition.baseline || a.authority_sha256!==digest(baseline.authorities)) add('MEDIATION_STALE','Versioned Resolution approval does not bind the exact basis, partition and authority.');}
        if(!hypothesis && !this.options.historical && this.mediation)try {this.mediation.seal(resolution.payload,composition,resolution.approvals.map((r:string)=>this.read(r,'approval')));}catch(error:any){add(error.code??'MEDIATION_STALE',error.message);}
      }
      if (resolution.payload.input_fingerprint !== inputFingerprint) { add('STALE_RESOLUTION', 'Resolution belongs to a different frozen considered set.'); continue; }
      if (canonical(resolution.payload.outcome.selected) !== canonical(composition.selected)) add('RESOLUTION_SELECTION', 'Selection does not match the sealed outcome.');
      if (resolution.payload.scope !== scope || canonical(resolution.payload.impact) !== canonical(impact)) add('RESOLUTION_SCOPE', 'Resolution must cover the complete baseline impact.');
    }
    if (composition.selected.length !== composition.proposals.length && !composition.resolutions.length) add('RESOLUTION_REQUIRED', 'Omitted considered proposals require an explicit sealed decision.');
    const visited = new Set<string>(); const active = new Set<string>();
    const visit = (ref: string) => {
      if (active.has(ref)) { add('DEPENDENCY_CYCLE', 'Layer dependencies must be acyclic.', { ref }); return; }
      if (visited.has(ref)) return; active.add(ref);
      for (const dependency of proposals.get(ref)?.requires_layers ?? []) {
        if (!composition.selected.includes(dependency)) add('MISSING_DEPENDENCY', 'A required exact Layer revision is not selected.', { ref, dependency });
        else visit(dependency);
      }
      active.delete(ref); visited.add(ref);
    };
    for (const ref of composition.selected) visit(ref);
    for (const group of composition.alternative_groups) {
      const count = group.members.filter(r => composition.selected.includes(r)).length;
      if (count < group.min || count > group.max) add('ALTERNATIVE_CARDINALITY', 'Alternative group cardinality is violated.', { group: group.id });
    }
    const creations=new Map<string,string>();
    for(const ref of composition.selected)for(const block of proposals.get(ref)!.created_blocks??[]) {
      if(creations.has(block.id)){add('BLOCK_CREATION_COLLISION','Distinct selected Layers claim the same new Block ID.',{block:block.id,contributors:[creations.get(block.id),ref]});continue;}
      creations.set(block.id,ref);snapshot.blocks[block.id]=structuredClone(block);
    }
    const writes = new Map<string, { block: string; path: string; expected: any; value: unknown; contributors: string[] }>();
    for (const ref of composition.selected) {
      const layer = proposals.get(ref)!;
      const normalized = [...layer.changes, ...layer.acceptance.map(a => ({ op: 'set_item' as const, block: a.block, path: 'acceptance.' + a.id, expected: { kind: 'absent' as const }, value: a.criterion }))];
      for (const change of normalized) {
        const key = itemRef(change.block, change.path); const block = baseline.blocks[change.block];
        if (!block || !matches(item(block, change.path), change.expected)) { add('BASELINE_PRECONDITION', 'Precondition does not match this baseline.', { key }); continue; }
        const existing = writes.get(key);
        if (existing && (canonical(existing.value) !== canonical(change.value) || canonical(existing.expected) !== canonical(change.expected))) add('ITEM_COLLISION', 'Different writes target one atomic semantic item.', { key, contributors: [...existing.contributors, ref] });
        else if (existing) existing.contributors.push(ref);
        else writes.set(key, { ...change, contributors: [ref] });
      }
    }
    for (const change of writes.values()) write(snapshot.blocks[change.block], change.path, change.value);
    for (const ref of composition.selected) for (const assumption of proposals.get(ref)!.assumptions) {
      const block = snapshot.blocks[assumption.block];
      if (!block || !matches(item(block, assumption.path), assumption.expected)) add('ASSUMPTION_FAILED', 'A declared semantic assumption is false in the effective snapshot.', { ref, assumption });
    }
    try { checkTree(snapshot); } catch (error) { add('INVALID_EFFECTIVE_TREE', (error as Error).message); }
    diagnostics.push(...evaluateScenario({ composition, baseline, snapshot, proposals }));
    const creationProvenance=Object.fromEntries(obligations(snapshot).filter(o=>creations.has(o.item.split('/')[0])).map(o=>[o.item,[creations.get(o.item.split('/')[0])!]]));
    const provenance = { ...(baselineRecord.provenance ?? {}),...creationProvenance, ...Object.fromEntries([...writes].map(([key, value]) => [key, value.contributors.sort()])) };
    this.closure(snapshot); const fingerprint = digest({ composition, effective: snapshot, provenance });
    const reports = Object.values(this.records).filter(r => r.type === 'interaction' && r.data.composition === `${composition.id}@${composition.revision}`);
    if (reports.length) add('INTERACTION_REVIEW_REQUIRED', 'Attributed interaction reports block this exact candidate revision.', reports.map(r => r.data.ref));
    if(isContentModel(composition.model_version) && !hypothesis && !this.options.historical) {
      const open=Object.entries(this.records).filter(([,r])=>r.type==='interaction-report');
      if(open.length) {const selectionContext=digest({project_id:this.options.projectId??'strata-local-demo',model_version:composition.model_version,baseline:composition.baseline,proposals:composition.proposals,alternative_groups:composition.alternative_groups,scenario:composition.scenario,selected:composition.selected,rejected:composition.proposals.filter(r=>!composition.selected.includes(r)),effective:snapshot});
        const uncovered=open.filter(([ref])=>!Object.values(this.records).some(r=>r.type==='report-disposition' && r.data.report_ref===ref && r.data.selection_context_sha256===selectionContext && r.data.authority_sha256===digest(baseline.authorities)));
        if(uncovered.length)add('INTERACTION_REVIEW_REQUIRED','Open project reports carry into every v0.2 candidate until exact evidence-bound disposition.',uncovered.map(([r])=>r));
      }
    }
    return { state: diagnostics.length ? 'blocked' : 'eligible_for_validation', fingerprint, input_fingerprint: inputFingerprint, diagnostics, snapshot, provenance, impact, scope, obligations: obligations(snapshot) };
  }
  compose(input: unknown) {
    const composition = normalizeComposition(input); const result = this.evaluate(composition);
    const ref = `${composition.id}@${composition.revision}`; this.store(ref, 'composition', composition);
    return { ref, ...result };
  }
  target(ref: string): Evaluation {
    const record = this.records[ref];
    if (record?.type === 'composition') return this.evaluate(this.read(ref, 'composition'));
    if (record?.type === 'release') {
      const data = this.read(ref, 'release'); const snapshot = snapshotFromRelease(data); this.closure(snapshot);
      return { state: 'validated', fingerprint: data.candidate ?? digest(snapshot), input_fingerprint: digest(snapshot), diagnostics: [], snapshot, provenance: data.provenance ?? {}, impact: [], scope: snapshot.root, obligations: obligations(snapshot) };
    }
    fail('REF_NOT_FOUND', 3, 'Target must be an exact Composition or Release.');
  }
  resolution(request: unknown, principal: string, dryRun = false) {
    this.mediationGate();
    const input = parse(z.object({ layer: z.string(), proposal_index: z.number().int().nonnegative(), composition: z.string(), approvals: z.array(z.string()) }).strict(), request);
    const layer: Layer = this.read(input.layer, 'layer');
    if (!layer.resolution_proposals.length || layer.changes.length || layer.acceptance.length) fail('INVALID_DECISION_LAYER', 2, 'Resolution needs a published decision-only Layer.');
    const payload = layer.resolution_proposals[input.proposal_index];
    if (!payload) fail('REF_NOT_FOUND', 3, 'Decision proposal is absent.');
    const composition: Composition = this.read(input.composition, 'composition'); const evaluation = this.evaluate(composition);
    if (payload.input_fingerprint !== contextFingerprint(composition)) fail('STALE_RESOLUTION', 5, 'Decision input fingerprint is stale.');
    const partition = [...payload.outcome.selected, ...payload.outcome.rejected].sort();
    if (canonical(partition) !== canonical(composition.proposals) || new Set(partition).size !== partition.length) fail('INVALID_RESOLUTION', 2, 'Select/reject must partition the whole frozen considered set.');
    if (payload.scope !== evaluation.scope || canonical(payload.impact) !== canonical(evaluation.impact)) fail('AUTHORITY_SCOPE', 4, 'Decision scope must cover all impacted baseline Blocks and consumers.');
    const target = digest({ layer: input.layer, proposal_index: input.proposal_index, payload });
    const authority = evaluation.snapshot.authorities.scopes.find(s => s.block === evaluation.scope)!;
    const approvals: Approval[] = input.approvals.map(r => this.read(r, 'approval'));
    if(isContentModel(composition.model_version))this.mediation!.seal(payload,composition,approvals);
    const ready = approvals.some(a => a.kind === 'resolution' && a.target === target && a.scope === evaluation.scope && authority.selectors.includes(a.principal));
    if (dryRun) return { unsigned_payload: { layer: input.layer, proposal_index: input.proposal_index, payload }, target, scope: evaluation.scope, execution_ready: ready };
    if (!ready) fail('ENDORSEMENT_REQUIRED', 6, 'A baseline selector must endorse the exact unsigned decision.');
    const data = { layer: input.layer, proposal_index: input.proposal_index, payload, approvals: set(input.approvals), sealed_by: principal, trust: this.modelVersion()===BLOCK_MODEL?'host-authenticated':'local-fixture',...(this.modelVersion()===BLOCK_MODEL?{format:'resolution/3',auth_receipt:this.authReceipt('resolve')}:{}) };
    const ref = 'resolution@' + digest(data).slice(0, 24); this.store(ref, 'resolution', data); return { ref, target };
  }
  approve(input: unknown, principal: string) {
    this.mediationGate();
    const versioned=isContentModel(this.modelVersion()) ? parse<any>(this.modelVersion()===BLOCK_MODEL?hostApprovalSchema:contentApprovalSchema,input) : null;
    if(versioned)this.mediation!.approval(versioned,principal);
    const request=versioned ?? parse(approvalSchema,input);
    let baseline: Snapshot;
    if (request.kind === 'resolution') {
      const proposal = Object.values(this.records).filter(r => r.type === 'layer' && r.published).flatMap(r => (r.data as Layer).resolution_proposals.map((payload, index) => ({ layer: r.data, index, payload }))).find(p => digest({ layer: `${p.layer.id}@${p.layer.revision}`, proposal_index: p.index, payload: p.payload }) === request.target);
      if (!proposal) fail('REF_NOT_FOUND', 3, 'Approval target must be an existing frozen unsigned decision.');
      baseline = this.read(proposal.layer.baseline, 'release');
      if(versioned && versioned.baseline!==proposal.layer.baseline)fail('MEDIATION_STALE',5,'Approval baseline disagrees with the frozen decision.');
      if (request.evidence_digest !== null || request.scope !== proposal.payload.scope) fail('INVALID_RECORD', 2, 'Resolution endorsement must bind its declared scope without validation evidence.');
    } else {
      const match = Object.entries(this.records).find(([, r]) => r.type === 'composition' && this.evaluate(r.data).fingerprint === request.target);
      if (!match) fail('REF_NOT_FOUND', 3, 'Approval target must be an exact candidate fingerprint.');
      const evaluation = this.evaluate(match[1].data); baseline = this.read(match[1].data.baseline, 'release');
      if(versioned && versioned.baseline!==match[1].data.baseline)fail('MEDIATION_STALE',5,'Approval baseline disagrees with the candidate.');
      if (evaluation.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'A blocked candidate cannot be approved.');
      if (!Object.values(this.records).some(r => r.type === 'validation' && r.data.candidate === request.target && r.data.evidence_digest === request.evidence_digest)) fail('VALIDATION_REQUIRED', 6, 'Candidate approvals must bind registered successful evidence.');
      if (request.kind === 'scope' && request.scope !== evaluation.scope) fail('AUTHORITY_SCOPE', 4, 'Approval must cover the calculated responsible scope.');
      if (request.kind === 'release' && request.scope !== null) fail('INVALID_RECORD', 2, 'Release approval is project-wide.');
    }
    const authorized = request.kind === 'release' ? baseline.authorities.release.includes(principal) : request.kind === 'guardian' ? baseline.authorities.guardians.some(g => g.item === request.scope && g.principal === principal) : baseline.authorities.scopes.some(s => s.block === request.scope && s.selectors.includes(principal));
    if (!authorized) fail('AUTHORITY_FORBIDDEN', 4, 'The broker principal lacks baseline authority for this endorsement.');
    const data = { ...request, principal, trust:this.modelVersion()===BLOCK_MODEL?'host-authenticated':'local-fixture',...(this.modelVersion()===BLOCK_MODEL?{auth_receipt:this.authReceipt()}:{}) }; const ref = 'approval@' + digest(data).slice(0, 24);
    this.store(ref, 'approval', { ...data, ref }); return { ref, trust: data.trust };
  }
  realize(target: string, profile: string) {
    assertBoundReleaseMaterializer(this.records, this.options.projectId, target, profile);
    if(boundProfile(profile) && this.options.checkerBackend==='none') fail('UNSUPPORTED_CHECKER_BACKEND',8,'Checker-bound profiles require the measured Node host backend; SDK checker retention is deferred.');
    const evaluation = this.target(target);
    if(!compatibleProfile(profile,evaluation.snapshot.model_version)) fail('UNSUPPORTED_PROFILE',8,'Profile must match the target model.');
    if (evaluation.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'Materialization requires an eligible Composition or Release.', evaluation.diagnostics);
    if (this.records[target]?.type === 'composition') {
      const capability = profileFor(profile).scenario;
      if (!this.read(target, 'composition').scenario.checks.some((c: { id: string; version: string }) => c.id === capability.id && c.version === capability.version)) fail('PROFILE_SCENARIO_MISMATCH', 8, 'Materialization requires the selected profile compatibility capability in the exact Composition.');
    }
    return materialize(target, evaluation,profile);
  }
  registerRealization(input: unknown) {
    const realization = verifyRealization(input);
    const expected = this.realize(realization.target, realization.profile_id);
    if (canonical(expected) !== canonical(realization)) fail('STALE_REALIZATION', 6, 'Realization must match the pinned profile, candidate, coverage, and output bytes.');
    const ref = 'realization@' + digest(realization).slice(0, 24); this.store(ref, 'realization', realization); return { ref, manifest: realization };
  }
  checkValidation(target: string, realizationRef: string, input: unknown) {
    const evaluation = this.target(target);
    if (evaluation.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'Candidate is blocked.', evaluation.diagnostics);
    const realization: Realization = this.read(realizationRef, 'realization');
    if(evaluation.snapshot.model_version===BLOCK_MODEL)return this.checkHostValidation(target,realizationRef,input);
    if(realization.format==='strata-realization/2' && this.options.checkerBackend==='none') fail('UNSUPPORTED_CHECKER_BACKEND',8,'Checker-bound validation requires the measured Node host backend.');
    const evidence = parseEvidence(input);
    if (realization.target !== target || realization.candidate !== evaluation.fingerprint || evidence.candidate !== evaluation.fingerprint || evidence.profile !== realization.profile || evidence.output_tree !== realization.output_tree) fail('STALE_EVIDENCE', 6, 'Evidence does not bind the exact candidate, profile, and output tree.');
    if(realization.format==='strata-realization/2') {if(!('format' in evidence) || evidence.checker_sha256!==realization.checker_sha256 || evidence.fixture_sha256!==realization.fixture_sha256 || evidence.oracle_sha256!==realization.oracle_sha256) fail('STALE_CHECKER_EVIDENCE',6,'Evidence must bind the exact checker implementation, fixture content and semantic oracle.');}
    else if('format' in evidence) fail('INVALID_RECORD',2,'Legacy profiles accept only their explicit legacy evidence format.');
    const required = Object.values(evaluation.snapshot.blocks).flatMap(b => Object.values(b.acceptance));
    const known = new Set(required.map(c => `${c.check}:${c.version}:${c.fixture}:${c.method}`));
    if (evidence.results.some(r => !known.has(`${r.check}:${r.version}:${r.fixture}:${r.method}`))) fail('UNKNOWN_EVIDENCE', 6, 'Evidence contains an unknown check, version, fixture, or method.');
    for (const criterion of required) {
      const results = evidence.results.filter(r => r.check === criterion.check && r.version === criterion.version && r.fixture === criterion.fixture && r.method === criterion.method);
      if (results.length !== 1 || !results[0].passed || (criterion.method === 'review' && results[0].reviewer !== 'fixture-reviewer')) fail('VALIDATION_INCOMPLETE', 6, 'Every active acceptance criterion needs one passing bound result; review is an explicit fixture attestation.', { criterion });
    }
    const data = { candidate: evaluation.fingerprint, target, realization: realizationRef, evidence, evidence_digest: digest(evidence), trust: 'local-fixture-import' };
    return data;
  }
  criterionReview(input:unknown,principal:string){
    const request=parse(z.object({realization:z.string(),criterion:z.object({check:z.string(),version:z.string(),fixture:z.string(),method:z.literal('review')}).strict(),accepted:z.boolean(),rationale:z.string().min(1).max(4096)}).strict(),input),realization:Realization=this.read(request.realization,'realization');
    if(realization.model_version!==BLOCK_MODEL||realization.format!=='strata-realization/2')fail('UNSUPPORTED_HOSTED_AUTHORITY',8,'Criterion review requires a v0.3 checker-bound realization.');
    if(!realization.coverage.some(c=>c.checks.some(k=>canonical(k)===canonical(request.criterion))))fail('UNKNOWN_EVIDENCE',6,'Review criterion is not in this exact realization.');
    const data=parse(criterionReviewSchema,{format:'criterion-review/1',project_id:this.options.projectId,model_version:BLOCK_MODEL,candidate:realization.candidate,realization:request.realization,profile:realization.profile,output_tree:realization.output_tree,checker_sha256:realization.checker_sha256,fixture_sha256:realization.fixture_sha256,oracle_sha256:realization.oracle_sha256,criterion:request.criterion,accepted:request.accepted,rationale:request.rationale,reviewer:principal,auth_receipt:this.authReceipt('criterion.review'),trust:'host-authenticated'});
    const ref='criterion-review@'+digest(data);this.store(ref,'criterion-review',data);return {ref,accepted:data.accepted};
  }
  checkHostValidation(target:string,realizationRef:string,input:unknown){
    const evidence=parse(hostEvidenceSchema,input),evaluation=this.target(target),realization:Realization=this.read(realizationRef,'realization'),run=parse(hostRunSchema,this.read(evidence.run_ref,'host-run'));
    this.checkAuth(run.auth_receipt,run.producer,['evidence.run']);if(this.retainedAuthority&&!this.retainedAuthority(run.producer,'evidence.run',undefined,this.read(run.auth_receipt,'auth-receipt').credential_epoch))fail('ENDORSEMENT_REVOKED',6,'The retained runner no longer has an active grant.');
    if(evidence.run_ref!=='host-run@'+digest(run)||realization.model_version!==BLOCK_MODEL||realization.target!==target||realization.format!=='strata-realization/2'||run.producer!==evidence.producer)fail('STALE_EVIDENCE',6,'Host evidence requires its exact retained measured run.');
    for(const [key,value]of Object.entries({candidate:evaluation.fingerprint,realization:realizationRef,profile:realization.profile,output_tree:realization.output_tree,checker_sha256:realization.checker_sha256,fixture_sha256:realization.fixture_sha256,oracle_sha256:realization.oracle_sha256}))if((evidence as any)[key]!==value||(run as any)[key]!==value)fail('STALE_EVIDENCE',6,'Host evidence/run does not bind the exact candidate, realization, checker and oracle.');
    const criteria=[...new Map(Object.values(evaluation.snapshot.blocks).flatMap(b=>Object.values(b.acceptance)).map(c=>{const key={check:c.check,version:c.version,fixture:c.fixture,method:c.method};return [canonical(key),key] as const;})).values()];
    if(evidence.results.length!==criteria.length)fail('VALIDATION_INCOMPLETE',6,'Host evidence must cover every distinct active check exactly once.');
    for(const criterion of criteria){const matches=evidence.results.filter(r=>['check','version','fixture','method'].every(k=>(r as any)[k]===(criterion as any)[k]));if(matches.length!==1||!matches[0].passed)fail('VALIDATION_INCOMPLETE',6,'An active criterion has no unique passing evidence.');const result=matches[0];if(result.method==='mechanical'){const observed=run.results.filter(r=>r.check===result.check&&r.version===result.version&&r.fixture===result.fixture);if(observed.length!==1||!observed[0].passed||result.review_ref!==null||result.reviewer!==null)fail('VALIDATION_INCOMPLETE',6,'Mechanical evidence requires the observed passing host result.');}else{if(!result.review_ref||!result.reviewer)fail('VALIDATION_INCOMPLETE',6,'Review needs an authenticated exact criterion attestation.');const review=parse(criterionReviewSchema,this.read(result.review_ref,'criterion-review'));this.checkAuth(review.auth_receipt,review.reviewer,['criterion.review']);if(this.retainedAuthority&&!this.retainedAuthority(review.reviewer,'criterion.review',undefined,this.read(review.auth_receipt,'auth-receipt').credential_epoch))fail('ENDORSEMENT_REVOKED',6,'The retained criterion reviewer no longer has an active grant.');if(result.review_ref!=='criterion-review@'+digest(review)||!review.accepted||review.reviewer!==result.reviewer||canonical(review.criterion)!==canonical(criterion)||Object.keys({candidate:0,realization:0,profile:0,output_tree:0,checker_sha256:0,fixture_sha256:0,oracle_sha256:0}).some(k=>(review as any)[k]!==(evidence as any)[k]))fail('STALE_EVIDENCE',6,'Criterion attestation belongs to another result or realization.');}}
    return {format:'validation/3' as const,candidate:evaluation.fingerprint,target,realization:realizationRef,evidence,evidence_digest:digest(evidence),trust:'host-measured' as const};
  }
  validate(target: string, realizationRef: string, input: unknown) {
    const checked=this.checkValidation(target,realizationRef,input),data='format' in checked?parse(hostValidationSchema,{...checked,auth_receipt:this.authReceipt('validate')}):checked;
    const ref = 'validation@' + digest(data).slice(0, 24); this.store(ref, 'validation', data);
    return { ref, checks_passed: true, state: 'eligible_for_validation', evidence_digest: data.evidence_digest, approvals_pending: true };
  }
  release(target: string, validationRef: string, approvalRefs: string[]) {
    this.mediationGate();
    const composition: Composition = this.read(target, 'composition'); const evaluation = this.evaluate(composition);
    if (evaluation.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'Blocked intent cannot be released.', evaluation.diagnostics);
    const validation = this.read(validationRef, 'validation');
    if (validation.candidate !== evaluation.fingerprint || validation.target !== target) fail('STALE_EVIDENCE', 6, 'Validation belongs to another candidate.');
    const realization = this.read(validation.realization, 'realization');
    if (canonical(this.realize(target, realization.profile_id)) !== canonical(realization)) fail('STALE_REALIZATION', 6, 'The realization no longer matches the candidate.');
    this.checkValidation(target, validation.realization, validation.evidence);
    if(composition.model_version===BLOCK_MODEL){const valid=parse(hostValidationSchema,validation);const auth=parse(authReceiptSchema,this.read(valid.auth_receipt,'auth-receipt'));this.checkAuth(valid.auth_receipt,auth.principal_id,['validate']);}
    const approvals: Approval[] = set(approvalRefs).map(r => this.read(r, 'approval'));
    if(isContentModel(composition.model_version)) {for(const a of approvals){if(composition.model_version===BLOCK_MODEL){const typed=parse(storedHostApprovalSchema,a);this.checkAuth(typed.auth_receipt,typed.principal,['approve','mediation.respond']);}const {principal,trust,ref,auth_receipt,...request}=a as any;this.mediation!.approval(request,principal);}for(const r of composition.resolutions){const resolution=this.read(r,'resolution');this.mediation!.seal(resolution.payload,composition,resolution.approvals.map((r:string)=>this.read(r,'approval')));}}
    const baseline: Snapshot = snapshotFromRelease(this.read(composition.baseline, 'release'));
    assertPublicationApprovals(baseline, evaluation, validation.evidence_digest, approvals);
    const preservedSnapshot=structuredClone(evaluation.snapshot),preservedObligations=structuredClone(evaluation.obligations),preservedProvenance=structuredClone(evaluation.provenance);
    const data = { ...evaluation.snapshot, baseline: composition.baseline, candidate: evaluation.fingerprint, provenance: evaluation.provenance, lineage: [...new Set([...(this.read(composition.baseline, 'release').lineage ?? []), ...composition.selected])].sort(), resolutions: composition.resolutions, acceptance_manifest: evaluation.obligations, validation: validationRef, approvals: set(approvalRefs), state: 'validated', trust:composition.model_version===BLOCK_MODEL?'host-authenticated':'local-fixture',...(composition.model_version===BLOCK_MODEL?{format:'release/3',auth_receipt:this.authReceipt('release')}:{}) };
    if(canonical(snapshotFromRelease(data))!==canonical(preservedSnapshot) || canonical(data.acceptance_manifest)!==canonical(preservedObligations) || canonical(data.provenance)!==canonical(preservedProvenance)) fail('OBLIGATION_CONSERVATION',5,'Flattening must preserve the exact candidate obligations and provenance.');
    const ref = 'release@' + digest(data).slice(0, 24); const reused = !!this.records[ref]; this.store(ref, 'release', data);
    return { ref, reused, candidate: evaluation.fingerprint, state: 'validated' };
  }
  canInspect(ref:string,principal:string) {
    const basic=(r:Stored|undefined)=>!!r&&(r.published||r.data.owner===principal)&&(!r.data.draft_ref||this.records[r.data.draft_ref]?.published||this.records[r.data.draft_ref]?.data.owner===principal);
    const record=this.records[ref];
    if(!basic(record))return false;
    if(record.type!=='auth-receipt'||record.data.principal_id===principal)return true;
    // A private/orphan action receipt must not reveal another actor's draft activity.
    return Object.values(this.records).some(r=>r.type!=='auth-receipt'&&r.data.auth_receipt===ref&&basic(r));
  }
  inspect(type: string, ref?: string, principal = 'reader', limit = 25, cursor?: string) {
    if (ref) {
      if (type === 'block') {
        const [snapshotRef, blockId] = ref.split('#'); const snapshot = this.target(snapshotRef).snapshot; const block = snapshot.blocks[blockId];
        if (!block) fail('REF_NOT_FOUND', 3, 'Block is absent.'); return { ...block, derived_facets: blockFacets(block), derived_subtree_facets: [...new Set(Object.values(snapshot.blocks).filter(b => ancestors(snapshot, b.id).includes(blockId)).flatMap(blockFacets))].sort() };
      }
      const record = this.records[ref];
      if (!record || record.type !== type || !this.canInspect(ref,principal)) fail('REF_NOT_FOUND', 3, 'Record is not visible to this principal.');
      return type === 'composition' ? { ...this.read(ref, type), evaluation: this.target(ref) } : structuredClone(record.data);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_ARGUMENT', 2, 'List limit must be 1..100.');
    const list = Object.entries(this.records).filter(([ref, r]) => r.type === type && this.canInspect(ref,principal)).map(([ref]) => ref).sort();
    if (cursor && !list.includes(cursor)) fail('INVALID_CURSOR', 2, 'Cursor is not a visible reference in this listing.');
    const offset = cursor ? list.indexOf(cursor) + 1 : 0; const page = list.slice(offset, offset + limit);
    return { items: page, next_cursor: offset + limit < list.length ? page.at(-1) : null, total: list.length };
  }
}
export function snapshotFromRelease(data: any): Snapshot {
  const keys = ['id', 'revision', 'model_version', 'root', 'blocks', 'authorities', 'deleted_ids'];
  return Object.fromEntries(keys.map(k => [k, structuredClone(data[k])])) as Snapshot;
}
