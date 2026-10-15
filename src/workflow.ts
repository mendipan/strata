import {hostRunSchema,criterionReviewSchema,hostEvidenceSchema} from './auth/records.js';
import { z } from 'zod';
import { Engine, normalizeLayer, snapshotFromRelease } from './core.js';
import { canonical, digest, fail, parse, item, write, CONTENT_MODEL, BLOCK_MODEL, isContentModel, type Layer } from './model.js';
import { PROFILE_IDS, profileFor } from './profile.js';
import { describeProfileSupport, inspectProfileSupport } from './profile-capabilities.js';
import type { SecurityContext } from './security.js';
import { describeNativeSupport, nativeOperationSupport } from './native-support.js';
import { completionProjection,reconciliationCompletionSchema } from './revalidation.js';

const exact = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256);
export const WORKFLOW_READS = ['capabilities','review.inbox','review.state','layer.preview','studio.snapshot','operation.inspect','evidence.assemble'];
type GateState = 'satisfied'|'missing'|'blocked'|'stale'|'unsupported'|'not_applicable'|'unavailable';
export type Gate = { id:string; state:GateState; code:string|null; reason:string; subject_refs:string[]; operation:string|null; required_role:string|null };
export function reviewState(engine: Engine, ref: string, principal: string, context?: SecurityContext) {
  const stored=engine.records[ref];
  if(!stored)fail('REF_NOT_FOUND',3,'Record is not visible to this principal.');
  const record=engine.inspect(stored.type,ref,principal), gates:Gate[]=[];
  if(stored.type==='reconciliation-completion')return {format:'strata-review-state/1',type:stored.type,record_sha256:digest(record),
    ...completionProjection(ref,reconciliationCompletionSchema.parse(record)),execution_checked:false,ready:false};
  const gate=(id:string,state:GateState,reason:string,code:string|null=null,operation:string|null=null,required_role:string|null=null,refs:string[]=[ref])=>gates.push({id,state,reason,code,operation,required_role,subject_refs:refs});
  let candidate_snapshot:any=null,responsible_scope:string|null=null,authority_sha256:string|null=null,validation_evidence:any[]=[];
  let baseline:string|null=record.baseline??(stored.type==='release'?ref:null), candidate:string|null=null;
  if(stored.type==='layer') {
    const head=engine.ownerHeads[record.id];
    gate('ownership',record.owner===principal?'satisfied':'unavailable',record.owner===principal?'This principal owns the proposal.':'Only the owner can revise or publish it.','OWNER_FORBIDDEN','layer.revise','owner');
    gate('head',!head||head.head===record.revision?'satisfied':'stale',!head||head.head===record.revision?'Exact current revision.':'A newer owned revision exists.','STALE_REVISION','layer.revise','owner');
    const questions=record.derived_from?.questions??[];
    gate('source_questions',questions.length?'blocked':'satisfied',questions.length?`${questions.length} unresolved source questions require an owned revision.`:'No unresolved source questions.',questions.length?'DISTILL_REVIEW_REQUIRED':null,'layer.revise','owner');
    gate('source_review',record.derived_from&&!stored.published?'missing':'not_applicable',record.derived_from?'Publication requires exact source and normalized draft review.':'No supplied-source review is required.',record.derived_from?'DISTILL_REVIEW_REQUIRED':null,'layer.publish','owner');
    const retainedReviews=Object.entries(engine.records).filter(([,r])=>r.type==='authoring-review'&&r.data.draft_ref===ref&&r.data.draft_digest===digest(record)&&r.data.accepted);
    const reviews=retainedReviews.filter(([,r])=>{if(record.model_version!==BLOCK_MODEL||stored.published)return true;try{engine.checkAuth(r.data.auth_receipt,r.data.reviewer,['content.review']);return !engine.retainedAuthority||engine.retainedAuthority(r.data.reviewer,'content.review',undefined,engine.read(r.data.auth_receipt,'auth-receipt').credential_epoch);}catch{return false;}});
    const content=isContentModel(record.model_version)&&(record.changes.length||record.acceptance.length||record.created_blocks?.length);
    gate('authoring_review',!content?'not_applicable':reviews.length?'satisfied':retainedReviews.length?'stale':'missing',content?(retainedReviews.length&&!reviews.length?'The retained authoring reviewer no longer has active authority for this draft.':'Exact intent-authoring review is required.'):'No content authoring attestation is required.',content&&!reviews.length?(retainedReviews.length?'ENDORSEMENT_REVOKED':'AUTHORING_REVIEW_REQUIRED'):null,'content.review','authoring reviewer',reviews.map(([r])=>r));
    gate('publication',stored.published?'satisfied':'missing',stored.published?'Published proposal; selection and validation remain separate.':'Private draft; not selected or validated.',stored.published?null:'PUBLICATION_REQUIRED','layer.publish','owner');
  } else if(stored.type==='composition'||stored.type==='release') {
    if(stored.type==='release'&&!record.validation) {
      gate('bootstrap','not_applicable','Bootstrap baseline; no validation or publication evidence was recorded.');
      return {format:'strata-review-state/1',ref,type:stored.type,record_sha256:digest(record),baseline,candidate:null,publication:'bootstrap',trust:context?.trust_mode==='host_authenticated'?'host-authenticated':'local-fixture',policy_generation:context?.policy_version??null,gates,ready:false};
    }
    let evaluation;
    try { evaluation=engine.target(ref); }
    catch(error:any) {gate('candidate','blocked',error.message,error.code);return {format:'strata-review-state/1',ref,type:stored.type,record_sha256:digest(record),baseline,candidate:null,trust:context?.trust_mode==='host_authenticated'?'host-authenticated':'local-fixture',gates,ready:false};}
    candidate=evaluation.fingerprint;
    gate('candidate',evaluation.state==='blocked'?'blocked':'satisfied',evaluation.state==='blocked'?'Candidate has unresolved semantic gates.':'Exact candidate is structurally eligible.',evaluation.state==='blocked'?'BLOCKED_CANDIDATE':null,'conflicts');
    for(const diagnostic of evaluation.diagnostics)gate('semantic:'+diagnostic.code,'blocked',diagnostic.message,diagnostic.code,'conflicts');
    const base=snapshotFromRelease(engine.read(baseline!,'release'));
    candidate_snapshot=evaluation.state==='blocked'?null:evaluation.snapshot;responsible_scope=evaluation.scope;authority_sha256=digest(base.authorities);
    const scope=base.authorities.scopes.find(s=>s.block===evaluation.scope);
    gate('baseline_authority',scope?.selectors.length&&base.authorities.release.length?'satisfied':'blocked','Scope and Release authority must come from the immutable baseline.',scope?.selectors.length&&base.authorities.release.length?null:'AUTHORITY_REQUIRED');
    const supported:string[]=[],unsupported:any[]=[];
    for(const profile of PROFILE_IDS)try {engine.realize(ref,profile);supported.push(profile);}catch(error:any){unsupported.push({profile,code:error.code});}
    gate('profile',supported.length?'satisfied':'unsupported',supported.length?'Supported finite profile: '+supported.join(', '):'No configured finite profile can realize these exact claims.','UNSUPPORTED_PROFILE','materialize','preparer');
    const validations=Object.entries(engine.records).filter(([,r])=>r.type==='validation'&&r.data.target===ref&&r.data.candidate===candidate);
    const valid:any[]=[];
    for(const [v,r]of validations) {
      try {engine.checkValidation(ref,r.data.realization,r.data.evidence);valid.push({ref:v,data:r.data});}
      catch {gate('evidence:'+v,'stale','Retained evidence does not satisfy this current candidate.','STALE_EVIDENCE','validate','evidence producer',[v]);}
    }
    validation_evidence=valid.map(v=>({ref:v.ref,evidence_digest:v.data.evidence_digest}));
    // Pure evidence predicate shared with validate; reads never create records.
    gate('validation',valid.length?'satisfied':supported.length?'missing':'unavailable',valid.length?'Retained exact evidence passes the engine gate; local file verification remains separate.':'Complete candidate/profile/output-bound results are required.',valid.length?null:'VALIDATION_REQUIRED','validate','evidence producer',valid.map(v=>v.ref));
    const retainedApprovals=Object.entries(engine.records).filter(([,r])=>r.type==='approval'&&r.data.target===candidate&&valid.some(v=>v.data.evidence_digest===r.data.evidence_digest));
    const approvals=retainedApprovals.filter(([approvalRef,r])=>{try{if(isContentModel(record.model_version)){const {principal,trust,ref,auth_receipt,...request}=r.data;engine.mediation!.approval(request,principal);if(record.model_version===BLOCK_MODEL)engine.checkAuth(auth_receipt,principal,['approve','mediation.respond']);}return true;}catch(error:any){gate('endorsement:'+approvalRef,'stale','Retained approval no longer satisfies current authority/generation/expiry.',error.code??'STALE_APPROVAL','approve',null,[approvalRef]);return false;}});
    const required=[{kind:'scope',scope:evaluation.scope,principals:scope?.selectors??[]},{kind:'release',scope:null,principals:base.authorities.release}];
    for(const guardian of base.authorities.guardians) {const [block,path]=guardian.item.split('/');if(canonical(item(base.blocks[block],path).value)!==canonical(item(evaluation.snapshot.blocks[block],path).value))required.push({kind:'guardian',scope:guardian.item,principals:[guardian.principal]});}
    for(const need of required) {
      const matches=approvals.filter(([,r])=>r.data.kind===need.kind&&r.data.scope===need.scope&&need.principals.includes(r.data.principal)&&(!engine.retainedAuthority||engine.retainedAuthority(r.data.principal,'approve',need.kind,engine.read(r.data.auth_receipt,'auth-receipt').credential_epoch)));
      gate(need.kind+(need.scope?':'+need.scope:''),matches.length?'satisfied':'missing',need.kind==='scope'?'Responsible scope approval.':need.kind==='release'?'Separate project Release approval.':'Fixed guardian approval for the protected amendment.',matches.length?null:'ENDORSEMENT_REQUIRED','approve',need.principals.join(', ')||'No baseline authority',matches.map(([r])=>r));
    }
    gate('output_bytes','unavailable','Current local output bytes are verified by the shared Node command service before validation/Release.','LOCAL_PREFLIGHT_REQUIRED','release');
    gate('publication',stored.type==='release'?'satisfied':'missing',stored.type==='release'?'Immutable Release recorded.':'A candidate is not a Release.',null,'release','release manager');
  } else fail('UNSUPPORTED_CAPABILITY',8,'Workflow review supports exact Layers, Compositions and Releases.');
  if(context)gate('operation_permission','satisfied','Actions remain subject to the current per-operation grant.');
  return {format:'strata-review-state/1',ref,type:stored.type,record_sha256:digest(record),baseline,candidate,trust:context?.trust_mode==='host_authenticated'?'host-authenticated':'local-fixture',policy_generation:context?.policy_version??null,candidate_snapshot,responsible_scope,authority_sha256,validation_evidence,gates,ready:gates.every(g=>['satisfied','not_applicable'].includes(g.state))};
}
export function workflow(engine:Engine,command:string,input:any,principal:string,context?:SecurityContext) {
  if(command==='capabilities') {
    const request=parse(z.object({target:exact.optional()}).strict(),input);
    const profiles=PROFILE_IDS.filter(id=>profileFor(id).models.includes(engine.modelVersion()));
    if(request.target){const stored=engine.records[request.target];if(!stored)fail('REF_NOT_FOUND',3,'Record is not visible to this principal.');engine.inspect(stored.type,request.target,principal);}
    const profile_details=profiles.map(id=>describeProfileSupport(profileFor(id)));
    const target_support=request.target?{target:request.target,profiles:profiles.map(id=>inspectProfileSupport(profileFor(id),()=>engine.realize(request.target!,id)))}:null;
    const native_support=describeNativeSupport(engine.modelVersion(),context);
    return {format:'strata-capabilities/1',model_version:engine.modelVersion(),trust:context?.trust_mode==='host_authenticated'?'host-authenticated':'local-fixture',principal_id:principal,policy_generation:context?.policy_version??null,profiles,profile_details,target_support,native_support,scenarios:[...(engine.modelVersion()===BLOCK_MODEL?[{id:'intent-structure',version:'1'}]:[]),...profiles.map(id=>({id:profileFor(id).scenario.id,version:profileFor(id).scenario.version}))],operations:(context?.allowed_operations??[]).filter(operation=>!operation.startsWith('revalidation.')).map(operation=>({operation,supported:operation!=='evidence.assemble'||engine.modelVersion()===BLOCK_MODEL,authorized:true,...nativeOperationSupport(native_support,operation)})),hosted_identity:context?.trust_mode==='host_authenticated',mediation_generation:engine.mediation?.enabled()?engine.mediation.generation():null,agent_chat:false,block_create:engine.modelVersion()===BLOCK_MODEL&&!!context?.create_under_block_ids?.length};
  }
  if(command==='evidence.assemble'){
    const request=parse(z.object({realization:exact,run_ref:exact,review_refs:z.array(exact).max(100)}).strict(),input);const run=parse(hostRunSchema,engine.read(request.run_ref,'host-run'));
    if(request.realization!==run.realization||new Set(request.review_refs).size!==request.review_refs.length)fail('STALE_EVIDENCE',6,'Choose one exact measured run and distinct criterion attestation refs.');
    const reviews=request.review_refs.map(ref=>({ref,data:parse(criterionReviewSchema,engine.read(ref,'criterion-review'))}));
    const evidence=parse(hostEvidenceSchema,{format:'strata-host-evidence/1',candidate:run.candidate,realization:run.realization,profile:run.profile,output_tree:run.output_tree,checker_sha256:run.checker_sha256,fixture_sha256:run.fixture_sha256,oracle_sha256:run.oracle_sha256,producer:run.producer,run_ref:request.run_ref,results:[...run.results.map(r=>({...r,method:'mechanical',reviewer:null,review_ref:null})),...reviews.map(r=>({...r.data.criterion,passed:r.data.accepted,reviewer:r.data.reviewer,review_ref:r.ref}))]});
    const realization=engine.read(request.realization,'realization');engine.checkHostValidation(realization.target,request.realization,evidence);return {evidence,evidence_digest:digest(evidence),validated:false};
  }
  if(command==='studio.snapshot') {
    parse(z.object({}).strict(),input);
    const records=visibleRecords(engine,principal);
    if(Object.keys(records).length>1000)fail('READ_LIMIT',2,'This view exceeds the Studio record limit.');
    return {records,generation:digest(records),principal_id:principal,policy_generation:context?.policy_version??null,trust:context?.trust_mode==='host_authenticated'?'host-authenticated':'local-fixture'};
  }
  if(command==='review.state') {const request=parse(z.object({ref:exact}).strict(),input);return reviewState(engine,request.ref,principal,context);}
  if(command==='review.inbox') {
    const request=parse(z.object({baseline:exact.optional(),limit:z.number().int().min(1).max(100).default(25),cursor:z.string().max(1024).optional()}).strict(),input);
    const visible=Object.entries(engine.records).filter(([,r])=>['layer','composition','release'].includes(r.type)&&(r.published||r.data.owner===principal)&&(!request.baseline||r.data.baseline===request.baseline));
    const generation=digest({principal,policy:context?.policy_version??null,refs:visible.map(([ref,r])=>[ref,r.published,digest(r.data)])});
    let offset=0;
    if(request.cursor) {const parts=request.cursor.split(':');if(parts.length!==2||parts[0]!==generation||!/^\d+$/.test(parts[1]))fail('STALE_CURSOR',5,'Review inbox changed; reload its first page.');offset=Number(parts[1]);if(offset>=visible.length)fail('INVALID_CURSOR',2,'Review cursor is outside this page.');}
    visible.sort(([a],[b])=>a.localeCompare(b));
    const items=visible.slice(offset,offset+request.limit).map(([ref,r])=>({ref,type:r.type,owner:r.data.owner??null,intent:r.data.intent??null,baseline:r.data.baseline??ref,published:r.published,review:reviewState(engine,ref,principal,context)}));
    return {format:'strata-review-inbox/1',generation,items,total:visible.length,next_cursor:offset+request.limit<visible.length?`${generation}:${offset+request.limit}`:null};
  }
  if(command==='layer.preview') {
    const request=parse(z.object({record:z.unknown()}).strict(),input), raw=request.record as Layer;
    if(raw.owner!==principal)fail('OWNER_FORBIDDEN',4,'Only the assigned owner can preview a draft input.');
    const baseline=snapshotFromRelease(engine.read(raw.baseline,'release')), layer=normalizeLayer(raw,baseline), snapshot=structuredClone(baseline);
    for(const b of layer.created_blocks??[])snapshot.blocks[b.id]=structuredClone(b);
    for(const change of layer.changes)write(snapshot.blocks[change.block],change.path,change.value);
    for(const added of layer.acceptance)write(snapshot.blocks[added.block],'acceptance.'+added.id,added.criterion);
    return {format:'strata-layer-preview/1',baseline:layer.baseline,record:layer,record_sha256:digest(layer),snapshot,accepted:false,selected:false,validated:false};
  }
  fail('UNSUPPORTED_CAPABILITY',8,'This workflow operation requires a supported persistent host.');
}
export function visibleRecords(engine:Engine,principal:string){return Object.fromEntries(Object.entries(engine.records).filter(([ref])=>engine.canInspect(ref,principal)));}
