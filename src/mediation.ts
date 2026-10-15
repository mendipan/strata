import { hostApprovalSchema } from './auth/records.js';
import { z } from 'zod';
import { CONTENT_MODEL, BLOCK_MODEL, hostSelectionSchema, canonical, digest, fail, parse, set, plainTextSchema, contentApprovalSchema, contentSelectionSchema, type Composition, type Snapshot } from './model.js';
import type { Engine } from './core.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import { materialize, defaultProfileForScenario, selectionEvaluator } from './profile.js';
import { assertSelectionApprovalBinding, assertSelectionSealBinding } from './mediation-bindings.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
const key = z.string().regex(/^[A-Za-z0-9_-]+$/);
const text = plainTextSchema.pipe(z.string().min(1));
const date = z.string().datetime();
const partitionSchema = z.object({ id:key, selected:z.array(ref), rejected:z.array(ref) }).strict();
export const selectionPolicySchema = z.object({ format:z.literal('selection-policy/1'), project_id:key, model_version:z.literal(CONTENT_MODEL), baseline:ref, baseline_sha256:hash, authority_sha256:hash, evaluator:text, scenario_sha256:hash, scope:z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/), impact:z.array(z.string()), proposal_sha256:z.record(ref,hash), goal:text, rationale:text, issued_by:z.string().min(1) }).strict();
export const selectionGrantSchema = z.object({ format:z.literal('selection-grant/1'), project_id:key, model_version:z.literal(CONTENT_MODEL), baseline:ref, policy_ref:ref, policy_sha256:hash, principal:z.string().min(1), delegator:z.string().min(1), scope:z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/), case_id:key, max_uses:z.literal(1), issued_at:date, expires_at:date, generation:z.number().int().positive() }).strict();
export type MediationConfig = { generation:number; policies:z.infer<typeof selectionPolicySchema>[]; grants:z.infer<typeof selectionGrantSchema>[] };
export const mediationInstallationSchema = z.object({ format:z.literal('mediation-installation/1'), project_id:key, model_version:z.literal(CONTENT_MODEL), baseline:ref, authority_sha256:hash, configuration_sha256:hash, access_generation:text, access_binding_sha256:hash, generation:z.number().int().positive(), policies:z.array(ref), grants:z.array(ref) }).strict();
const alternativeSchema = partitionSchema.extend({ context_sha256:hash, eligible:z.boolean(), diagnostics:z.array(z.object({ code:z.string(), message:z.string(), details:z.unknown().optional() }).strict()), snapshot_sha256:hash, dispositions:z.array(ref) }).strict();
export const mediationBasisSchema = z.object({ format:z.literal('mediation-basis/1'), project_id:key, model_version:z.literal(CONTENT_MODEL), composition_ref:ref, baseline:ref, authority_sha256:hash, input_fingerprint:hash, source_sha256:z.record(ref,hash), case_id:key, case_revision:z.number().int().positive().max(3), supersedes:ref.nullable(), expires_at:date, goal:text, impact:z.array(z.string()), scope:z.string(), guardians:z.array(z.unknown()), reports:z.array(ref), report_generation:z.number().int().nonnegative(), configuration_sha256:hash, access_generation:text, policy_status:z.enum(['unique','unresolved']), policy_ref:ref.nullable(), grant_ref:ref.nullable(), policy_reason:text, alternatives:z.array(alternativeSchema).min(1).max(3) }).strict();
const packetOptionSchema = z.object({ id:key, layer:ref, proposal_index:z.number().int().nonnegative(), target:hash, partition_sha256:hash, selected:z.array(ref), rejected:z.array(ref), context_sha256:hash, effects:text, follow_up:text, executable:z.boolean() }).strict();
export const decisionPacketSchema = z.object({ format:z.literal('decision-packet/1'), project_id:key, model_version:z.literal(CONTENT_MODEL), basis_ref:ref, basis_sha256:hash, case_id:key, case_revision:z.number().int().positive(), expires_at:date, goal:text, question:text, recommendation:key.nullable(), options:z.array(packetOptionSchema).min(1).max(3), defer:z.literal(true), costs:z.literal('unknown; no execution permission'), required_authorities:z.array(z.string()), remaining_gates:z.array(z.string()), sources:z.record(ref,z.unknown()) }).strict();
export const mediationReceiptSchema = z.object({ format:z.literal('mediation-receipt/1'), project_id:key, model_version:z.literal(CONTENT_MODEL), packet_ref:ref, basis_ref:ref, case_id:key, case_revision:z.number().int().positive(), action:z.enum(['approve_selection','defer','request_context','planning_direction']), option_id:key.nullable(), target:hash.nullable(), partition_sha256:hash.nullable(), principal:z.string().min(1), origin:z.enum(['human-fixture','policy-fixture','context-fixture']), generation:text, created_at:date, grant_ref:ref.nullable(), use_ref:ref.nullable(), message:plainTextSchema }).strict();
export const selectionUseSchema = z.object({ format:z.literal('selection-use/1'), project_id:key, grant_ref:ref, policy_ref:ref, case_id:key, case_revision:z.number().int().positive(), packet_ref:ref, target:hash, principal:z.string().min(1), configuration_sha256:hash }).strict();
export const interactionReportSchema = z.object({ format:z.literal('interaction-report/2'), project_id:key, model_version:z.literal(CONTENT_MODEL), id:key, composition:ref, candidate:hash, principal:z.string().min(1), message:text, affected_items:z.array(z.string()).min(1), contributors:z.array(ref), evidence_refs:z.array(ref), signature_sha256:hash }).strict();
export const reportDispositionSchema = z.object({ format:z.literal('report-disposition/1'), project_id:key, model_version:z.literal(CONTENT_MODEL), report_ref:ref, selection_context_sha256:hash, kind:z.enum(['correction','not_applicable']), rationale:text, evidence_refs:z.array(ref).min(1), principal:z.string().min(1), scope:z.string(), authority_sha256:hash }).strict();
export const MEDIATION_SCHEMAS = { 'selection-policy':selectionPolicySchema, 'selection-grant':selectionGrantSchema, 'mediation-installation':mediationInstallationSchema, 'mediation-basis':mediationBasisSchema, 'decision-packet':decisionPacketSchema, 'mediation-receipt':mediationReceiptSchema, 'selection-use':selectionUseSchema, 'interaction-report':interactionReportSchema, 'report-disposition':reportDispositionSchema };

export const HOST_MEDIATION_SCHEMAS=Object.fromEntries(Object.entries(MEDIATION_SCHEMAS).map(([type,schema])=>{const old=(schema.shape as any).format.value;const slash=old.lastIndexOf('/');let extra:any={format:z.literal(old.slice(0,slash+1)+(Number(old.slice(slash+1))+1)),model_version:z.literal(BLOCK_MODEL),auth_receipt:ref};if(type==='mediation-receipt')extra.origin=z.literal('host-authenticated');return [type,schema.extend(extra).strict()];})) as unknown as Record<keyof typeof MEDIATION_SCHEMAS,z.ZodType<any>>;

// Only a server-bound issuer supplies this runtime. Historical descriptors never activate it.
export class Mediation {
  readonly configuration_sha256:string;
  constructor(readonly engine:Engine, readonly issuer:AuthorityIssuer, readonly context:SecurityContext, readonly config:MediationConfig) {
    this.configuration_sha256=digest({project_id:context.project_id,config,access_generation:context.policy_version,access_binding_sha256:issuer.accessBinding()});
  }
  get model(){return this.engine.modelVersion();}
  get hosted(){return this.model===BLOCK_MODEL;}
  checked<T>(schema:z.ZodType<T>,input:unknown):T {const type=Object.entries(MEDIATION_SCHEMAS).find(([,s])=>(s as z.ZodType<any>)===(schema as z.ZodType<any>))?.[0] as keyof typeof MEDIATION_SCHEMAS|undefined;const use=this.hosted?(type?HOST_MEDIATION_SCHEMAS[type]:(schema as z.ZodType<any>)===contentApprovalSchema?hostApprovalSchema:(schema as z.ZodType<any>)===contentSelectionSchema?hostSelectionSchema:schema):schema;return parse(use as z.ZodType<T>,input);}
  records(type:string) { return Object.entries(this.engine.records).filter(([,r])=>r.type===type && r.published).map(([ref,r])=>({ref,data:r.data})); }
  decorate(type:keyof typeof MEDIATION_SCHEMAS,data:any){if(this.hosted){const shape=(HOST_MEDIATION_SCHEMAS[type] as z.ZodObject<any>).shape;Object.assign(data,{format:shape.format.value,model_version:BLOCK_MODEL,auth_receipt:this.engine.authReceipt()});if(type==='mediation-receipt')data.origin='host-authenticated';}return data;}
  put(type:keyof typeof MEDIATION_SCHEMAS,data:any) {this.decorate(type,data);const parsed=this.checked(MEDIATION_SCHEMAS[type] as z.ZodType<any>,data);const ref=type+'@'+digest(parsed);this.engine.store(ref,type,parsed);return ref;}
  now() { return this.issuer.time(); }
  install(baselineRef:string) {
    const existing=this.records('mediation-installation');
    const latest=existing.sort((a,b)=>b.data.generation-a.data.generation)[0];
    if(latest && this.config.generation<=latest.data.generation) {this.installed();return;}
    if(latest && (this.config.generation!==latest.data.generation+1 || baselineRef!==latest.data.baseline))fail('MEDIATION_STALE',5,'Explicit fixture activation must advance one durable generation on the unchanged bootstrap baseline.');
    // Called only with successful bootstrap init in the same publication transaction.
    if(this.hosted?!this.context.allowed_operations.some(op=>['init','mediation.install'].includes(op)):this.context.principal_id!=='bootstrap') fail('AUTHORITY_FORBIDDEN',4,'Only explicit bootstrap may install the local fixture configuration.');
    const baseline=this.engine.read(baselineRef,'release');
    for (const policy of this.config.policies) if (!selectionEvaluator(policy.evaluator).supports(policy.model_version, policy.scope)) fail('UNSUPPORTED_POLICY_EVALUATOR', 8, 'The declared finite selection evaluator does not support this model and scope.');
    const policies=this.config.policies.map(p=>this.put('selection-policy',p));
    const grants=this.config.grants.map(g=>this.put('selection-grant',g));
    for(const policy of this.config.policies) if(policy.project_id!==this.context.project_id || policy.baseline!==baselineRef || policy.baseline_sha256!==digest(baseline) || policy.authority_sha256!==digest(baseline.authorities) || !baseline.authorities.scopes.some((s:any)=>s.block===policy.scope && s.selectors.includes(policy.issued_by))) fail('SELECTION_GRANT_FORBIDDEN',4,'Policy installation must bind this fresh baseline and its issuing selector.');
    for(const grant of this.config.grants) {
      const policy=this.engine.read(grant.policy_ref,'selection-policy');
      if(grant.scope!==policy.scope || !this.issuer.narrowSelectionExecutor(grant.principal) || grant.project_id!==this.context.project_id || grant.baseline!==baselineRef || grant.policy_sha256!==digest(policy) || grant.generation!==this.config.generation || !baseline.authorities.scopes.some((s:any)=>s.block===grant.scope && s.selectors.includes(grant.principal) && s.selectors.includes(grant.delegator)) || Date.parse(grant.expires_at)<=Date.parse(grant.issued_at) || Date.parse(grant.expires_at)-Date.parse(grant.issued_at)>3600000) fail('SELECTION_GRANT_FORBIDDEN',4,'Executor needs a baseline selector, one-case grant and validity within one hour.');
    }
    this.put('mediation-installation',{format:'mediation-installation/1',project_id:this.context.project_id,model_version:this.model,baseline:baselineRef,authority_sha256:digest(baseline.authorities),configuration_sha256:this.configuration_sha256,access_generation:this.context.policy_version,access_binding_sha256:this.issuer.accessBinding(),generation:this.config.generation,policies:set(policies),grants:set(grants)});
  }
  installed() {
    this.issuer.assertLive(this.context);
    const list=this.records('mediation-installation');
    if(!list.length || new Set(list.map(r=>r.data.generation)).size!==list.length) fail('MEDIATION_CONFIGURATION_REQUIRED',8,'A fresh bootstrap installation is required; missing durable state never resets a grant.');
    const data=this.checked(mediationInstallationSchema,list.sort((a,b)=>b.data.generation-a.data.generation)[0].data);
    if(data.project_id!==this.context.project_id || data.configuration_sha256!==this.configuration_sha256 || data.generation!==this.config.generation || data.access_generation!==this.context.policy_version || data.access_binding_sha256!==this.issuer.accessBinding()) fail('MEDIATION_STALE',5,'Installed fixture configuration/access generation changed or rolled back; explicit reconfiguration is required.');
    if(canonical(data.policies)!==canonical(set(this.config.policies.map(p=>'selection-policy@'+digest(p)))) || canonical(data.grants)!==canonical(set(this.config.grants.map(g=>'selection-grant@'+digest(g))))) fail('MEDIATION_STALE',5,'Installed policy/grant inventory is incompatible.');
    for(const r of [...data.policies,...data.grants]) this.engine.read(r);
    return data;
  }
  isExecutor(principal:string) {return this.config.grants.some(g=>g.principal===principal) || this.records('selection-grant').some(r=>r.data.principal===principal);}
  enabled() { try {this.installed();return true;}catch{return false;} }
  reportGeneration() { return this.records('interaction-report').length+this.records('report-disposition').length; }
  generation() { this.installed();return `${this.config.generation}:${this.context.policy_version}:${this.reportGeneration()}`; }
  contextFor(composition:Composition,partition:{selected:string[];rejected:string[]}) {
    const normalized={...composition,proposals:set(composition.proposals),selected:set(partition.selected),resolutions:[]};
    const all=set([...partition.selected,...partition.rejected]);
    if(canonical(all)!==canonical(normalized.proposals) || all.length!==partition.selected.length+partition.rejected.length) fail('INVALID_RESOLUTION',2,'Options must partition the whole considered set.');
    const evaluation=this.engine.evaluate(normalized,true);
    const input={model_version:composition.model_version,baseline:composition.baseline,proposals:normalized.proposals,alternative_groups:composition.alternative_groups,scenario:composition.scenario};
    const context_sha256=digest({project_id:this.context.project_id,...input,selected:set(partition.selected),rejected:set(partition.rejected),effective:evaluation.snapshot});
    const baseline=this.engine.read(composition.baseline,'release');
    const dispositions=this.records('report-disposition').filter(r=>r.data.selection_context_sha256===context_sha256 && r.data.authority_sha256===digest(baseline.authorities)).map(r=>r.ref).sort();
    const open=this.records('interaction-report').filter(r=>!dispositions.some(d=>this.engine.records[d].data.report_ref===r.ref));
    const diagnostics=evaluation.diagnostics.filter(d=>d.code!=='RESOLUTION_REQUIRED' && d.code!=='INTERACTION_REVIEW_REQUIRED');
    try {materialize('hypothetical-selection',evaluation,defaultProfileForScenario(composition.model_version,composition.scenario.checks).id);}catch(error:any){diagnostics.push({code:error.code??'UNKNOWN_CHECK',message:error.message,details:error.details});}
    if(open.length) diagnostics.push({code:'INTERACTION_REVIEW_REQUIRED',message:'Open project reports need exact evidence-bound dispositions.',details:open.map(r=>r.ref)});
    return {evaluation,context_sha256,dispositions,diagnostics,eligible:diagnostics.length===0};
  }
  policy(composition:Composition) {
    const installation=this.installed();const baseline=this.engine.read(composition.baseline,'release');
    const layers=composition.proposals.map(r=>({ref:r,data:this.engine.read(r,'layer')}));
    const unresolved=(reason:string)=>({status:'unresolved' as const,reason,policy_ref:null as string|null,grant_ref:null as string|null,partition:null as {id:string;selected:string[];rejected:string[]}|null});
    const matches: {policy_ref:string;grant_ref:string;partition:{id:string;selected:string[];rejected:string[]};reason:string}[]=[];
    for(const policyRef of installation.policies) {
      const p=this.checked(selectionPolicySchema,this.engine.read(policyRef,'selection-policy'));
      if(p.project_id!==this.context.project_id || p.baseline!==composition.baseline || p.baseline_sha256!==digest(baseline) || p.authority_sha256!==digest(baseline.authorities) || p.scenario_sha256!==digest(composition.scenario) || canonical(Object.keys(p.proposal_sha256).sort())!==canonical(set(composition.proposals)) || layers.some(l=>p.proposal_sha256[l.ref]!==digest(l.data))) continue;
      const evaluator=selectionEvaluator(p.evaluator);
      if(!evaluator.supports(composition.model_version,p.scope))continue;
      const partition=evaluator.match(baseline,layers);
      if(!partition)continue;
      const test=this.contextFor(composition,partition);
      if(!test.eligible || test.evaluation.scope!==p.scope || canonical(test.evaluation.impact)!==canonical(set(p.impact)))continue;
      const grants=installation.grants.filter(r=>{const g=this.engine.read(r,'selection-grant');return g.policy_ref===policyRef && g.baseline===composition.baseline;});
      if(grants.length!==1)continue;
      matches.push({policy_ref:policyRef,grant_ref:grants[0],partition,reason:evaluator.reason});
    }
    if(matches.length!==1) return unresolved(matches.length?'Multiple matching policy/grant rules; no authorized unique tie-breaker.':'No exact policy covers this complete input and impact.');
    return {status:'unique' as const,...matches[0]};
  }
  fresh(basisRef:string) {
    const b=this.checked(mediationBasisSchema,this.engine.read(basisRef,'mediation-basis'));this.installed();
    if(b.project_id!==this.context.project_id || b.configuration_sha256!==this.configuration_sha256 || b.access_generation!==this.context.policy_version || b.report_generation!==this.reportGeneration() || Date.parse(b.expires_at)<=this.now()) fail('MEDIATION_STALE',5,'Decision basis expired or its configuration/access/report generation changed.');
    if(this.records('mediation-basis').some(r=>r.data.case_id===b.case_id && r.data.case_revision>b.case_revision)) fail('MEDIATION_STALE',5,'A newer case revision supersedes this basis.');
    const c:Composition=this.engine.read(b.composition_ref,'composition');const evaluation=this.engine.evaluate(c,true);
    if(evaluation.input_fingerprint!==b.input_fingerprint || canonical(evaluation.impact)!==canonical(b.impact) || evaluation.scope!==b.scope || digest(this.engine.read(c.baseline,'release').authorities)!==b.authority_sha256 || Object.entries(b.source_sha256).some(([r,h])=>digest(this.engine.read(r))!==h)) fail('MEDIATION_STALE',5,'Exact considered inputs, authority or impact changed.');
    for(const a of b.alternatives) {const check=this.contextFor(c,a);if(check.context_sha256!==a.context_sha256 || canonical(check.dispositions)!==canonical(a.dispositions) || check.eligible!==a.eligible) fail('MEDIATION_STALE',5,'Selection context or report coverage changed.');}
    const policy=this.policy(c);
    if(policy.status!==b.policy_status || policy.policy_ref!==b.policy_ref || policy.grant_ref!==b.grant_ref) fail('MEDIATION_STALE',5,'Policy match changed.');
    return {basis:b,composition:c};
  }
  prepare(input:any) {
    const deadline=performance.now()+10000;this.installed();
    if(input?.basis_ref) {
      const request=parse(z.object({basis_ref:ref,decisions:z.array(z.object({option_id:key,layer:ref,proposal_index:z.number().int().nonnegative()}).strict()).min(1).max(3)}).strict(),input);
      const {basis:b}=this.fresh(request.basis_ref);
      if(request.decisions.length!==b.alternatives.length || new Set(request.decisions.map(d=>d.option_id)).size!==request.decisions.length) fail('INVALID_RECORD',2,'Prepare exactly one owned decision target per alternative.');
      const options=request.decisions.map(d=>{
        const a=b.alternatives.find(a=>a.id===d.option_id);if(!a)fail('INVALID_RECORD',2,'Option is outside the frozen basis.');
        const layer=this.engine.read(d.layer,'layer'),payload=layer.resolution_proposals[d.proposal_index];
        const expected=this.payload(request.basis_ref,b,a);
        if(layer.model_version!==this.model || layer.baseline!==b.baseline || layer.changes.length || layer.acceptance.length || !payload || canonical({...payload,rationale:expected.rationale})!==canonical(expected)) fail('MEDIATION_STALE',5,'Decision must bind the exact versioned basis and complete prepared partition.');
        const composition:Composition=this.engine.read(b.composition_ref,'composition');
        const effective=this.contextFor(composition,a).evaluation.snapshot;
        let effects='Effects are unsupported by the finite profile inventory. All declared acceptance still requires fresh evidence.';
        try { effects=defaultProfileForScenario(composition.model_version,composition.scenario.checks).describeEffects(effective); } catch { /* Unsupported alternatives remain visible and non-executable. */ }
        return {id:d.option_id,layer:d.layer,proposal_index:d.proposal_index,target:digest({layer:d.layer,proposal_index:d.proposal_index,payload}),partition_sha256:digest(payload.outcome),selected:a.selected,rejected:a.rejected,context_sha256:a.context_sha256,effects,follow_up:'Fresh measured realization, evidence and separate scope/guardian/Release endorsements are still required.',executable:a.eligible};
      }).sort((a,b)=>a.id.localeCompare(b.id));
      const sources=Object.fromEntries(Object.keys(b.source_sha256).sort().map(r=>[r,this.engine.read(r)]));
      const packet={format:'decision-packet/1',project_id:b.project_id,model_version:this.model,basis_ref:request.basis_ref,basis_sha256:digest(b),case_id:b.case_id,case_revision:b.case_revision,expires_at:b.expires_at,goal:b.goal,question:'Choose an already-authored whole-Layer selection, or defer.',recommendation:b.policy_status==='unique'?'policy-selection':null,options,defer:true,costs:'unknown; no execution permission',required_authorities:this.engine.read(b.baseline,'release').authorities.scopes.find((s:any)=>s.block===b.scope).selectors,remaining_gates:['realization','acceptance evidence','scope approval','applicable guardian approval','separate Release approval'],sources};
      if(performance.now()>deadline)fail('MEDIATION_LIMIT',2,'Cooperative packet analysis exceeded ten seconds.');
      if(new TextEncoder().encode(canonical(packet)).length>131072)fail('MEDIATION_LIMIT',2,'Packet exceeds 128 KiB; no source/obligation truncation.');
      const packetRef=this.put('decision-packet',packet);return {ref:packetRef,packet_sha256:digest(packet),packet};
    }
    const request=parse(z.object({target:ref,case_id:key,case_revision:z.number().int().positive().max(3),expires_at:date,goal:text,partitions:z.array(partitionSchema).max(3),supersedes:ref.nullable()}).strict(),input);
    const c:Composition=this.engine.read(request.target,'composition');if(c.model_version!==this.model)fail('UNSUPPORTED_MODEL_VERSION',8,'Mediation requires explicit v0.2.');
    if(c.proposals.length>20 || this.records('interaction-report').length>100)fail('MEDIATION_LIMIT',2,'Finite mediation analysis bounds exceeded.');
    const evaluation=this.engine.evaluate(c,true);if(c.proposals.length>20 || evaluation.impact.length>100 || evaluation.diagnostics.filter(d=>d.code==='ITEM_COLLISION').length>50 || this.records('interaction-report').length>100) fail('MEDIATION_LIMIT',2,'Finite mediation analysis bounds exceeded.');
    if(Date.parse(request.expires_at)<=this.now() || Date.parse(request.expires_at)>this.now()+86400000)fail('INVALID_RECORD',2,'Packet validity must be positive and at most 24 hours.');
    const p=this.policy(c);const partitions=p.status==='unique'?[p.partition!]:request.partitions;
    if(!partitions.length)fail('POLICY_UNRESOLVED',5,'No policy match: supply up to three prepared whole-Layer alternatives or missing context.');
    if(new Set(partitions.map(p=>p.id)).size!==partitions.length)fail('INVALID_RECORD',2,'Duplicate option identity.');
    const alternatives=partitions.map(p=>{p={...p,selected:set(p.selected),rejected:set(p.rejected)};const check=this.contextFor(c,p);return {...p,context_sha256:check.context_sha256,eligible:check.eligible,diagnostics:check.diagnostics,snapshot_sha256:digest(check.evaluation.snapshot),dispositions:check.dispositions};}).sort((a,b)=>a.id.localeCompare(b.id));
    const expires=p.grant_ref?new Date(Math.min(Date.parse(request.expires_at),Date.parse(this.engine.read(p.grant_ref,'selection-grant').expires_at))).toISOString():request.expires_at;
    const basis={format:'mediation-basis/1',project_id:this.context.project_id,model_version:this.model,composition_ref:request.target,baseline:c.baseline,authority_sha256:digest(this.engine.read(c.baseline,'release').authorities),input_fingerprint:evaluation.input_fingerprint,source_sha256:Object.fromEntries(set([c.baseline,...c.proposals]).map(r=>[r,digest(this.engine.read(r))])),case_id:request.case_id,case_revision:request.case_revision,supersedes:request.supersedes,expires_at:expires,goal:request.goal,impact:evaluation.impact,scope:evaluation.scope,guardians:this.engine.read(c.baseline,'release').authorities.guardians,reports:this.records('interaction-report').map(r=>r.ref).sort(),report_generation:this.reportGeneration(),configuration_sha256:this.configuration_sha256,access_generation:this.context.policy_version,policy_status:p.status,policy_ref:p.policy_ref,grant_ref:p.grant_ref,policy_reason:p.reason,alternatives};
    this.decorate('mediation-basis',basis);const previous=this.records('mediation-basis').filter(r=>r.data.case_id===basis.case_id);
    const same=previous.find(r=>r.data.case_revision===basis.case_revision);
    if(same && canonical(same.data)!==canonical(basis))fail('CASE_REVISION_CONFLICT',5,'Changing inputs requires a new bounded case revision and exact supersession.');
    if(!same && (basis.case_revision!==Math.max(0,...previous.map(r=>r.data.case_revision))+1 || (previous.length && !previous.some(r=>r.ref===basis.supersedes && r.data.case_revision===basis.case_revision-1)) || (!previous.length && basis.supersedes!==null))) fail('CASE_REVISION_CONFLICT',5,'Case revisions are consecutive and explicitly supersede the prior basis.');
    if(performance.now()>deadline)fail('MEDIATION_LIMIT',2,'Cooperative mediation analysis exceeded ten seconds.');
    const basisRef=this.put('mediation-basis',basis);return {ref:basisRef,basis_sha256:digest(basis),basis,needs_authoring:true,decision_proposals:alternatives.map(a=>({option_id:a.id,payload:this.payload(basisRef,basis,a)}))};
  }
  payload(basisRef:string,b:any,a:any) {return {format:this.hosted?'selection/3':'selection/2',input_fingerprint:b.input_fingerprint,basis_ref:basisRef,basis_sha256:digest(b),impact:b.impact,scope:b.scope,outcome:{kind:'select',selected:a.selected,rejected:a.rejected},rationale:b.policy_status==='unique'?b.policy_reason:'Human selection of already-authored alternatives; fresh behavioral evidence remains required.'};}
  grant(grantRef:string,caseId:string,target:string) {
    this.installed();const g=this.checked(selectionGrantSchema,this.engine.read(grantRef,'selection-grant'));
    if(g.case_id!==caseId || g.project_id!==this.context.project_id || g.generation!==this.config.generation || Date.parse(g.issued_at)>this.now() || Date.parse(g.expires_at)<=this.now() || !this.issuer.active(g.principal))fail('SELECTION_GRANT_FORBIDDEN',4,'Executor grant is expired, revoked or outside this case.');
    const uses=this.records('selection-use').filter(r=>r.data.grant_ref===grantRef),receipts=this.records('mediation-receipt').filter(r=>r.data.grant_ref===grantRef && r.data.action==='approve_selection');
    if(uses.length>1 || receipts.some(r=>!uses.some(u=>u.ref===r.data.use_ref && u.data.target===r.data.target && u.data.packet_ref===r.data.packet_ref)) || uses.some(u=>!receipts.some(r=>r.data.use_ref===u.ref)))fail('SELECTION_LEDGER_INVALID',9,'Missing or incompatible durable use/response state cannot reset an executor balance.');
    if(uses.length && !uses.some(r=>r.data.case_id===caseId && r.data.target===target && r.data.principal===g.principal))fail('SELECTION_GRANT_EXHAUSTED',4,'Durable one-use grant is already consumed for a different exact target.');
    return g;
  }
  respond(input:any) {
    const request=parse(z.object({packet_ref:ref,packet_sha256:hash,case_revision:z.number().int().positive(),action:z.enum(['approve_selection','defer','request_context','planning_direction']),option_id:key.nullable(),message:plainTextSchema}).strict(),input);
    const packet=this.checked(decisionPacketSchema,this.engine.read(request.packet_ref,'decision-packet'));
    if(digest(packet)!==request.packet_sha256 || packet.case_revision!==request.case_revision)fail('MEDIATION_STALE',5,'Response needs the exact packet digest and case revision.');
    const {basis:b,composition:c}=this.fresh(packet.basis_ref);
    const option=packet.options.find(o=>o.id===request.option_id);
    if(request.action==='approve_selection' && (!option || !option.executable))fail('POLICY_UNRESOLVED',5,'Only an eligible already-authored option can be endorsed.');
    if(request.action!=='approve_selection' && request.option_id!==null)fail('INVALID_RECORD',2,'Nonapproval responses do not select an executable option.');
    const principal=this.context.principal_id;const executor=this.isExecutor(principal);
    if(executor && request.action!=='approve_selection')fail('SELECTION_GRANT_FORBIDDEN',4,'Executor may perform only its uniquely covered selection.');
    let grantRef:string|null=null,useRef:string|null=null;
    if(request.action==='approve_selection') {
      if(!this.issuer.permitsApproval(this.context,'resolution') || !this.engine.read(b.baseline,'release').authorities.scopes.some((s:any)=>s.block===b.scope && s.selectors.includes(principal)))fail('AUTHORITY_FORBIDDEN',4,'Only an assigned baseline selector may approve selection.');
      if(executor) {
        const p=this.policy(c);if(p.status!=='unique' || p.grant_ref!==b.grant_ref || option!.id!=='policy-selection' || canonical(p.partition!.selected)!==canonical(option!.selected) || canonical(p.partition!.rejected)!==canonical(option!.rejected))fail('SELECTION_GRANT_FORBIDDEN',4,'Executor content must match the one exact deterministic policy output.');
        const g=this.grant(b.grant_ref!,b.case_id,option!.target);if(g.principal!==principal)fail('SELECTION_GRANT_FORBIDDEN',4,'Grant belongs to another executor.');
        grantRef=b.grant_ref;
        useRef='selection-use@'+digest({format:'selection-use/1',project_id:b.project_id,grant_ref:grantRef,policy_ref:b.policy_ref,case_id:b.case_id,case_revision:b.case_revision,packet_ref:request.packet_ref,target:option!.target,principal,configuration_sha256:this.configuration_sha256});
      }
    }
    const receipt={format:'mediation-receipt/1',project_id:b.project_id,model_version:this.model,packet_ref:request.packet_ref,basis_ref:packet.basis_ref,case_id:b.case_id,case_revision:b.case_revision,action:request.action,option_id:option?.id??null,target:option?.target??null,partition_sha256:option?.partition_sha256??null,principal,origin:executor?'policy-fixture':request.action==='approve_selection'?'human-fixture':'context-fixture',generation:this.generation(),created_at:new Date(this.now()).toISOString(),grant_ref:grantRef,use_ref:useRef,message:request.message};
    const prior=this.records('mediation-receipt').filter(r=>r.data.case_id===b.case_id && r.data.case_revision===b.case_revision && r.data.action==='approve_selection');
    if(prior.some(r=>r.data.target!==receipt.target || r.data.principal!==principal || r.data.packet_ref!==request.packet_ref))fail('CASE_ALREADY_DECIDED',5,'A case already has another immutable approved target.');
    if(this.records('mediation-receipt').some(r=>r.data.packet_ref===request.packet_ref && r.data.action==='defer') && request.action!=='defer')fail('DECISION_DEFERRED',5,'Deferred packet needs explicit new case revision; silence/defer never approves.');
    if(useRef) {const g=this.engine.read(grantRef!,'selection-grant');this.put('selection-use',{format:'selection-use/1',project_id:b.project_id,grant_ref:grantRef,policy_ref:g.policy_ref,case_id:b.case_id,case_revision:b.case_revision,packet_ref:request.packet_ref,target:option!.target,principal,configuration_sha256:this.configuration_sha256});}
    const existing=prior.find(r=>r.data.target===receipt.target && r.data.principal===principal && r.data.packet_ref===request.packet_ref);
    const receiptRef=existing?.ref ?? this.put('mediation-receipt',receipt);
    if(request.action!=='approve_selection')return {ref:receiptRef,action:request.action,approved:false,authoring_required:request.action==='planning_direction'};
    const approval=this.engine.approve({format:this.hosted?'approval/3':'approval/2',project_id:b.project_id,model_version:this.model,baseline:b.baseline,authority_sha256:b.authority_sha256,kind:'resolution',target:option!.target,scope:b.scope,evidence_digest:null,generation:this.generation(),expires_at:b.expires_at,binding:{basis_ref:packet.basis_ref,packet_ref:request.packet_ref,case_revision:b.case_revision,option_id:option!.id,partition_sha256:option!.partition_sha256,receipt_ref:receiptRef}},principal);
    return {...approval,approved:true,receipt_ref:receiptRef,use_ref:useRef,origin:receipt.origin,reused:!!existing};
  }
  approval(request:any,principal:string) {
    const {principal:storedPrincipal,trust,ref:embedded,auth_receipt,...shape}=request;request=shape;
    this.installed();this.checked(contentApprovalSchema,request);
    if(request.project_id!==this.context.project_id || request.model_version!==this.model || request.generation!==this.generation() || request.expires_at && Date.parse(request.expires_at)<=this.now())fail('MEDIATION_STALE',5,'Versioned approval project, generation or expiry is stale.');
    const baseline=this.engine.read(request.baseline,'release');if(baseline.model_version!==this.model || request.authority_sha256!==digest(baseline.authorities))fail('MEDIATION_STALE',5,'Versioned approval must bind this exact v0.2 authority manifest.');
    const executor=this.isExecutor(principal);
    if(request.kind!=='resolution') {if(request.binding!==null || executor)fail('SELECTION_GRANT_FORBIDDEN',4,'Executor has no scope, guardian or Release approval authority.');return;}
    if(!request.binding)fail('ENDORSEMENT_REQUIRED',6,'Selection approval requires a server response/use receipt.');
    const binding=request.binding,receipt=this.checked(mediationReceiptSchema,this.engine.read(binding.receipt_ref,'mediation-receipt')),packet=this.checked(decisionPacketSchema,this.engine.read(binding.packet_ref,'decision-packet'));
    if(this.hosted)this.engine.checkAuth((receipt as any).auth_receipt,receipt.principal,['mediation.respond']);
    const {basis:b}=this.fresh(binding.basis_ref);
    assertSelectionApprovalBinding(request,principal,b,packet,receipt);
    const option=packet.options.find(o=>o.id===binding.option_id)!;
    if(executor) {
      if(receipt.origin!=='policy-fixture' || receipt.grant_ref!==b.grant_ref || !receipt.use_ref)fail('SELECTION_GRANT_FORBIDDEN',4,'Executor requires its durable policy-use receipt.');
      const g=this.grant(receipt.grant_ref!,b.case_id,request.target);const use=this.checked(selectionUseSchema,this.engine.read(receipt.use_ref,'selection-use'));
      if(g.principal!==principal || use.target!==request.target || use.grant_ref!==receipt.grant_ref || use.packet_ref!==binding.packet_ref || use.configuration_sha256!==this.configuration_sha256)fail('SELECTION_GRANT_FORBIDDEN',4,'Policy/use receipt does not authorize this exact target.');
      const p=this.policy(this.engine.read(b.composition_ref,'composition'));if(p.status!=='unique' || p.policy_ref!==b.policy_ref || p.grant_ref!==b.grant_ref || option.id!=='policy-selection')fail('SELECTION_GRANT_FORBIDDEN',4,'Automatic policy outcome is no longer uniquely covered.');
    }else if(receipt.origin!==(this.hosted?'host-authenticated':'human-fixture') || receipt.grant_ref!==null || receipt.use_ref!==null)fail('AUTHORITY_FORBIDDEN',4,'Human endorsement requires the server-derived human response origin.');
  }
  seal(payload:any,composition:Composition,approvals:any[]) {
    this.checked(contentSelectionSchema,payload);const {basis:b}=this.fresh(payload.basis_ref);
    assertSelectionSealBinding(payload,composition,b,()=>this.engine.evaluate(composition,true).input_fingerprint);
    for(const a of approvals) this.approval(a,a.principal);
  }
  recheck(command:string,input:any) {
    if(!this.enabled() && !['init','status','inspect','diff','migration.preview','content.review','conflicts','layer.create','layer.revise','layer.publish','realization.register','materialize','validate','compose'].includes(command))this.installed();
    if(command==='mediation.prepare') {if(input.basis_ref)this.fresh(input.basis_ref);else {const prior=this.records('mediation-basis').find(r=>r.data.case_id===input.case_id && r.data.case_revision===input.case_revision);if(prior)this.fresh(prior.ref);}}
    if(command==='mediation.respond') {
      const packet=this.engine.read(input.packet_ref,'decision-packet');this.fresh(packet.basis_ref);
      const prior=this.records('mediation-receipt').filter(r=>r.data.packet_ref===input.packet_ref && r.data.action==='approve_selection');
      for(const r of prior)if(r.data.grant_ref)this.grant(r.data.grant_ref,r.data.case_id,r.data.target);
    }
    if(command==='approve') this.approval(input.record,this.context.principal_id);
    if(command==='resolve') {const layer=this.engine.read(input.record.layer,'layer'),payload=layer.resolution_proposals[input.record.proposal_index],approvals=(input.record.approvals??[]).map((r:string)=>this.engine.read(r,'approval'));this.seal(payload,this.engine.read(input.record.composition,'composition'),approvals);if(this.isExecutor(this.context.principal_id) && !approvals.some((a:any)=>a.principal===this.context.principal_id && a.binding))fail('SELECTION_GRANT_FORBIDDEN',4,'Executor sealing requires its own exact policy-use endorsement.');}
    if(command==='release') {
      const c:Composition=this.engine.read(input.target,'composition');
      for(const r of c.resolutions) {const resolution=this.engine.read(r,'resolution');this.seal(resolution.payload,c,resolution.approvals.map((r:string)=>this.engine.read(r,'approval')));}
      for(const r of input.approvals??[])this.approval(this.engine.read(r,'approval'),this.engine.read(r,'approval').principal);
      if(this.engine.evaluate(c).state==='blocked')fail('BLOCKED_CANDIDATE',5,'Pending Release acquired an unresolved report or stale decision.');
    }
  }
  report(input:any) {
    this.installed();const request=parse(z.object({target:ref,report:z.object({id:key,message:text,affected_items:z.array(z.string()).min(1),contributors:z.array(ref),evidence_refs:z.array(ref)}).strict()}).strict(),input);
    const c:Composition=this.engine.read(request.target,'composition');if(c.model_version!==this.model)fail('UNSUPPORTED_MODEL_VERSION',8,'Report version must match its Composition.');
    const evaluation=this.engine.evaluate(c,true);
    for(const item of request.report.affected_items){const slash=item.indexOf('/');if(slash<0 || !evaluation.snapshot.blocks[item.slice(0,slash)])fail('REF_NOT_FOUND',3,'Reported affected Block is absent.');}
    for(const r of [...request.report.contributors,...request.report.evidence_refs])this.engine.read(r);
    const data={format:'interaction-report/2',project_id:this.context.project_id,model_version:this.model,composition:request.target,candidate:evaluation.fingerprint,principal:this.context.principal_id,...request.report,affected_items:set(request.report.affected_items),contributors:set(request.report.contributors),evidence_refs:set(request.report.evidence_refs),signature_sha256:digest({items:set(request.report.affected_items),contributors:set(request.report.contributors)})};
    this.decorate('interaction-report',data);if(this.records('interaction-report').some(r=>r.data.id===data.id && canonical(r.data)!==canonical(data)))fail('IMMUTABLE_REFERENCE',5,'An attributed report ID cannot be overwritten.');
    const reportRef=this.put('interaction-report',data);return {ref:reportRef,state:'blocked',report_generation:this.reportGeneration()};
  }
  disposition(input:any) {
    this.installed();const request=parse(z.object({report_ref:ref,target:ref,selected:z.array(ref),rejected:z.array(ref),kind:z.enum(['correction','not_applicable']),rationale:text,evidence_refs:z.array(ref).min(1)}).strict(),input);
    this.engine.read(request.report_ref,'interaction-report');const c:Composition=this.engine.read(request.target,'composition');const check=this.contextFor(c,request),baseline=this.engine.read(c.baseline,'release');
    if(!baseline.authorities.scopes.some((s:any)=>s.block===check.evaluation.scope && s.selectors.includes(this.context.principal_id)) || this.isExecutor(this.context.principal_id))fail('AUTHORITY_FORBIDDEN',4,'A responsible human fixture selector must review the report; executor cannot dispose of it.');
    for(const r of request.evidence_refs) {const validation=this.engine.read(r,'validation'),evidenceComposition:Composition=this.engine.read(validation.target,'composition');const evidenceContext=this.contextFor(evidenceComposition,{selected:evidenceComposition.selected,rejected:evidenceComposition.proposals.filter(r=>!evidenceComposition.selected.includes(r))});if(evidenceContext.context_sha256!==check.context_sha256 || validation.candidate!==this.engine.evaluate(evidenceComposition,true).fingerprint)fail('STALE_EVIDENCE',6,'Disposition evidence must bind the exact proposed selection context.');}
    const data={format:'report-disposition/1',project_id:this.context.project_id,model_version:this.model,report_ref:request.report_ref,selection_context_sha256:check.context_sha256,kind:request.kind,rationale:request.rationale,evidence_refs:set(request.evidence_refs),principal:this.context.principal_id,scope:check.evaluation.scope,authority_sha256:digest(baseline.authorities)};
    const dispositionRef=this.put('report-disposition',data);return {ref:dispositionRef,report_generation:this.reportGeneration(),globally_closed:false};
  }
}

// Archive verification is structural/historical and never activates a descriptor.
export function mediationArchiveReferences(type:string,data:any):string[] {
  switch(type) {
    case 'selection-policy':return [data.baseline,...Object.keys(data.proposal_sha256)];
    case 'selection-grant':return [data.baseline,data.policy_ref];
    case 'mediation-installation':return [data.baseline,...data.policies,...data.grants];
    case 'mediation-basis':return [data.composition_ref,data.baseline,...Object.keys(data.source_sha256),...data.reports,...data.alternatives.flatMap((a:any)=>a.dispositions),...[data.supersedes,data.policy_ref,data.grant_ref].filter(Boolean)];
    case 'decision-packet':return [data.basis_ref,...data.options.map((o:any)=>o.layer),...Object.keys(data.sources)];
    case 'mediation-receipt':return [data.packet_ref,data.basis_ref,...[data.grant_ref,data.use_ref].filter(Boolean)];
    case 'selection-use':return [data.grant_ref,data.policy_ref,data.packet_ref];
    case 'interaction-report':return [data.composition,...data.contributors,...data.evidence_refs];
    case 'report-disposition':return [data.report_ref,...data.evidence_refs];
    default:return [];
  }
}

export function verifyMediationHistory(engine:Engine,project:string) {
  const records=Object.entries(engine.records);
  const read=(ref:string,type:string)=>engine.read(ref,type);
  const bad=(condition:boolean,message:string)=>{if(condition)fail('BACKUP_INVALID',6,message);};
  const context=(c:Composition,selected:string[],rejected:string[])=>{
    const effective=engine.evaluate({...c,selected:set(selected),resolutions:[]},true).snapshot;
    return digest({project_id:project,model_version:c.model_version,baseline:c.baseline,proposals:set(c.proposals),alternative_groups:c.alternative_groups,scenario:c.scenario,selected:set(selected),rejected:set(rejected),effective});
  };
  for(const [ref,r] of records) {
    const d=r.data;
    if(r.type==='selection-policy') {
      try { bad(!selectionEvaluator(d.evaluator).supports(d.model_version,d.scope),'Historical policy evaluator cannot support this model/scope.'); }
      catch(error:any) { if(error.code==='UNSUPPORTED_POLICY_EVALUATOR')bad(true,'Historical policy requires an unavailable finite evaluator.');else throw error; }
      const b=read(d.baseline,'release');bad(digest(b)!==d.baseline_sha256 || digest(b.authorities)!==d.authority_sha256,'Historical policy baseline/authority digest disagrees.');
      bad(!b.authorities.scopes.some((s:any)=>s.block===d.scope && s.selectors.includes(d.issued_by)),'Historical policy issuer lacks baseline selection authority.');
      for(const [source,h]of Object.entries(d.proposal_sha256))bad(digest(read(source,'layer'))!==h,'Historical policy proposal content changed.');
    }
    if(r.type==='selection-grant') {
      const p=read(d.policy_ref,'selection-policy'),b=read(d.baseline,'release');bad(d.scope!==p.scope || digest(p)!==d.policy_sha256 || p.baseline!==d.baseline || !b.authorities.scopes.some((s:any)=>s.block===d.scope && s.selectors.includes(d.principal) && s.selectors.includes(d.delegator)) || Date.parse(d.expires_at)<=Date.parse(d.issued_at) || Date.parse(d.expires_at)-Date.parse(d.issued_at)>3600000,'Historical grant policy/authority/validity is inconsistent.');
      bad(records.filter(([,r])=>r.type==='selection-use' && r.data.grant_ref===ref).length>1,'Historical one-use grant has multiple debits.');
    }
    if(r.type==='mediation-installation') {
      const b=read(d.baseline,'release');bad(digest(b.authorities)!==d.authority_sha256,'Historical installation authority changed.');
      d.policies.forEach((r:string)=>read(r,'selection-policy'));d.grants.forEach((r:string)=>read(r,'selection-grant'));
    }
    if(r.type==='mediation-basis') {
      const c=read(d.composition_ref,'composition'),b=read(d.baseline,'release');bad(c.model_version!==engine.modelVersion() || c.baseline!==d.baseline || digest(b.authorities)!==d.authority_sha256 || engine.evaluate(c,true).input_fingerprint!==d.input_fingerprint || canonical(Object.keys(d.source_sha256).sort())!==canonical(set([c.baseline,...c.proposals])),'Historical basis considered context/authority differs.');
      for(const [source,h]of Object.entries(d.source_sha256))bad(digest(engine.read(source))!==h,'Historical basis source digest disagrees.');
      for(const a of d.alternatives) {bad(canonical(set([...a.selected,...a.rejected]))!==canonical(c.proposals) || a.selected.length+a.rejected.length!==c.proposals.length || context(c,a.selected,a.rejected)!==a.context_sha256,'Historical basis alternative is not the exact complete selection context.');for(const r of a.dispositions){const disp=read(r,'report-disposition');bad(disp.selection_context_sha256!==a.context_sha256,'Historical basis disposition binds another context.');}}
      d.reports.forEach((r:string)=>read(r,'interaction-report'));if(d.policy_ref)read(d.policy_ref,'selection-policy');if(d.grant_ref)read(d.grant_ref,'selection-grant');if(d.supersedes){const previous=read(d.supersedes,'mediation-basis');bad(previous.case_id!==d.case_id || previous.case_revision+1!==d.case_revision,'Historical basis supersession is inconsistent.');}
    }
    if(r.type==='decision-packet') {
      const b=read(d.basis_ref,'mediation-basis');bad(d.basis_sha256!==digest(b) || d.case_id!==b.case_id || d.case_revision!==b.case_revision || d.expires_at!==b.expires_at,'Historical packet basis/case/expiry differs.');
      for(const o of d.options){const layer=read(o.layer,'layer'),payload=layer.resolution_proposals[o.proposal_index],a=b.alternatives.find((a:any)=>a.id===o.id);bad(!payload || !a || payload.basis_ref!==d.basis_ref || payload.basis_sha256!==digest(b) || o.target!==digest({layer:o.layer,proposal_index:o.proposal_index,payload}) || o.partition_sha256!==digest(payload.outcome) || canonical(o.selected)!==canonical(a.selected) || canonical(o.rejected)!==canonical(a.rejected) || o.context_sha256!==a.context_sha256 || o.executable!==a.eligible,'Historical packet option/decision target differs.');}
      for(const [source,content]of Object.entries(d.sources))bad(canonical(engine.read(source))!==canonical(content),'Historical packet source material differs.');
    }
    if(r.type==='mediation-receipt') {
      const p=read(d.packet_ref,'decision-packet'),b=read(d.basis_ref,'mediation-basis');bad(p.basis_ref!==d.basis_ref || d.case_id!==b.case_id || d.case_revision!==b.case_revision,'Historical response context differs.');
      if(d.action==='approve_selection') {const o=p.options.find((o:any)=>o.id===d.option_id),baseline=read(b.baseline,'release');bad(!o || !o.executable || d.target!==o.target || d.partition_sha256!==o.partition_sha256 || !baseline.authorities.scopes.some((s:any)=>s.block===b.scope && s.selectors.includes(d.principal)),'Historical response target/authority differs.');if(d.origin==='policy-fixture'){const g=read(d.grant_ref,'selection-grant'),u=read(d.use_ref,'selection-use');bad(g.principal!==d.principal || g.case_id!==d.case_id || u.grant_ref!==d.grant_ref || u.packet_ref!==d.packet_ref || u.target!==d.target || b.grant_ref!==d.grant_ref,'Historical policy response/use differs.');}else bad(d.origin!==(engine.modelVersion()===BLOCK_MODEL?'host-authenticated':'human-fixture') || d.grant_ref!==null || d.use_ref!==null,'Historical human response origin is inconsistent.');}else bad(d.target!==null || d.option_id!==null || d.grant_ref!==null || d.use_ref!==null,'Historical nonapproval response carries authority.');
    }
    if(r.type==='selection-use') {const g=read(d.grant_ref,'selection-grant'),p=read(d.packet_ref,'decision-packet');bad(g.policy_ref!==d.policy_ref || g.principal!==d.principal || g.case_id!==d.case_id || p.case_id!==d.case_id || !p.options.some((o:any)=>o.target===d.target),'Historical debit does not bind its exact policy/case/target.');}
    if(r.type==='interaction-report') {const c=read(d.composition,'composition');bad(d.candidate!==engine.evaluate(c,true).fingerprint,'Historical interaction origin fingerprint differs.');}
    if(r.type==='report-disposition') {read(d.report_ref,'interaction-report');for(const r of d.evidence_refs){const v=read(r,'validation'),c=read(v.target,'composition'),b=read(c.baseline,'release');bad(d.selection_context_sha256!==context(c,c.selected,c.proposals.filter((r:string)=>!c.selected.includes(r))) || d.authority_sha256!==digest(b.authorities) || !b.authorities.scopes.some((s:any)=>s.block===d.scope && s.selectors.includes(d.principal)),'Historical disposition evidence/authority/context differs.');}}
  }
}
