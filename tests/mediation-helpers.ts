import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engine,normalizeLayer } from '../src/core.js';
import { bootstrap,demoLayers,proposal,recipe } from '../src/fixtures.js';
import { CONTENT_MODEL,canonical,digest,normalizeSnapshot,type Snapshot,type Layer } from '../src/model.js';
import { FixtureIssuer,LOCAL_PROJECT } from '../src/security.js';
import { executeAuthorized } from '../src/service.js';
import { fixtureOracle } from '../src/booking-checker.js';
import { runFixtureEvidence } from '../src/runner.js';
import type { MediationConfig } from '../src/mediation.js';

export const FIXTURE_NOW=Date.parse('2026-10-04T12:00:00Z');
export function snapshot(executor=false):Snapshot {
  const s=bootstrap();s.model_version=CONTENT_MODEL;
  for(const b of Object.values(s.blocks)){b.description={format:'plain-text/1',text:''};b.asset_refs={};}
  if(executor)s.authorities.scopes.find(s=>s.block==='booking')!.selectors.push('policy-executor');
  return normalizeSnapshot(s);
}
export function layers(s:Snapshot):Layer[] {return Object.values(demoLayers()).map(l=>normalizeLayer({...l,model_version:CONTENT_MODEL},s));}
export function composition(id='C-mediation') {return {...recipe(id),model_version:CONTENT_MODEL};}
export function fixtureConfiguration(s:Snapshot,ls:Layer[],ambiguous=false):MediationConfig {
  const c=composition();const p:MediationConfig['policies'][number]={format:'selection-policy/1' as const,project_id:LOCAL_PROJECT,model_version:CONTENT_MODEL,baseline:'R0@1',baseline_sha256:digest(s),authority_sha256:digest(s.authorities),evaluator:'booking-reminder-selection/1' as const,scenario_sha256:digest(c.scenario),scope:'booking' as const,impact:['booking.hold','booking.reminder'],proposal_sha256:Object.fromEntries(ls.map(l=>[`${l.id}@${l.revision}`,digest(l)])),goal:'Keep the exact 900-second reminder dependency.',rationale:'The already-authored reminder requires the exact 900-second hold.',issued_by:'scope-selector'};
  const ps=ambiguous?[p,{...p,rationale:'Second reviewed rule without precedence.'}]:[p];
  return {generation:1,policies:ps,grants:ps.map(policy=>({format:'selection-grant/1',project_id:LOCAL_PROJECT,model_version:CONTENT_MODEL,baseline:'R0@1',policy_ref:'selection-policy@'+digest(policy),policy_sha256:digest(policy),principal:'policy-executor',delegator:'scope-selector',scope:'booking',case_id:'booking-case',max_uses:1,issued_at:new Date(FIXTURE_NOW).toISOString(),expires_at:new Date(FIXTURE_NOW+3600000).toISOString(),generation:1}))};
}
export function issuerFor(config?:MediationConfig,now=()=>FIXTURE_NOW) {
  return new FixtureIssuer({now,mediation:config,assignments:{'fixture-content-s2':{principal:'content-reviewer',operations:['content.review']},...(config?.grants.length?{'fixture-executor-s2':{principal:'policy-executor',operations:['status','mediation.respond','approve','resolve'],approvals:['resolution']}}:{})}});
}
export function session(engine:Engine,issuer:FixtureIssuer) {
  return (command:string,input:any,selector='fixture-preparer',dry=false)=>executeAuthorized(engine,command,input,issuer.resolve(selector),issuer,dry);
}
export function publish(call:ReturnType<typeof session>,layer:Layer) {
  const selector=layer.owner==='author-a'?'fixture-a':layer.owner==='author-b'?'fixture-b':'fixture-c';
  const draft=call('layer.create',{record:layer},selector);
  if(layer.changes.length || layer.acceptance.length){const normalized=call('inspect',{type:'layer',ref:draft.ref},selector);const review=call('content.review',{record:{draft:normalized,expected_digest:digest(normalized),accepted:true,rationale:'Exact local fixture authoring review.'}},'fixture-content-s2');call('layer.publish',{ref:draft.ref,authoring_review:review.ref},selector);}else call('layer.publish',{ref:draft.ref},selector);
  return draft.ref;
}
export function setup(policy=true,ambiguous=false) {
  let now=FIXTURE_NOW;const s=snapshot(policy),ls=layers(s),config=policy?fixtureConfiguration(s,ls,ambiguous):undefined;
  const issuer=issuerFor(config,()=>now),engine=new Engine({}, {},{projectId:LOCAL_PROJECT,modelVersion:CONTENT_MODEL}),call=session(engine,issuer);
  call('init',{record:s},'fixture-bootstrap');ls.forEach(l=>publish(call,l));const blocked=call('compose',{record:composition()});
  return {s,ls,config,issuer,engine,call,blocked,setNow:(n:number)=>{now=n;}};
}
export function prepare(f:ReturnType<typeof setup>,options:any={}) {
  const analysis=f.call('mediation.prepare',{target:f.blocked.ref,case_id:'booking-case',case_revision:1,expires_at:new Date(FIXTURE_NOW+7200000).toISOString(),goal:'Choose the compatible hold and reminder.',partitions:[{id:'900',selected:['L-hold@1','L-reminder@1'],rejected:['L-alternative@1']},{id:'1200',selected:['L-alternative@1'],rejected:['L-hold@1','L-reminder@1']}],supersedes:null,...options});
  const decisions=analysis.decision_proposals.map((d:any,i:number)=>{const l=proposal('L-s2-decision-'+analysis.basis.case_revision+'-'+i,'author-a');l.model_version=CONTENT_MODEL;l.resolution_proposals=[d.payload];return {option_id:d.option_id,layer:publish(f.call,l),proposal_index:0};});
  const packet=f.call('mediation.prepare',{basis_ref:analysis.ref,decisions});
  return {analysis,packet,decisions};
}
export function respond(f:ReturnType<typeof setup>,p:ReturnType<typeof prepare>,selector='fixture-executor-s2',option=p.packet.packet.options[0].id,action='approve_selection') {
  return f.call('mediation.respond',{packet_ref:p.packet.ref,packet_sha256:p.packet.packet_sha256,case_revision:p.analysis.basis.case_revision,action,option_id:action==='approve_selection'?option:null,message:'Exact synthetic fixture response.'},selector);
}
export function select(f:ReturnType<typeof setup>,p=prepare(f),selector='fixture-executor-s2',option=p.packet.packet.options[0].id) {
  const endorsement=respond(f,p,selector,option);const decision=p.decisions.find((d:any)=>d.option_id===option)!;
  const resolved=f.call('resolve',{record:{layer:decision.layer,proposal_index:decision.proposal_index,composition:f.blocked.ref,approvals:[endorsement.ref]}});
  const chosen=p.packet.packet.options.find((o:any)=>o.id===option);
  const c=composition('C-selected');c.revision=p.analysis.basis.case_revision;c.selected=chosen.selected;c.resolutions=[resolved.ref];const candidate=f.call('compose',{record:c});assert.equal(candidate.state,'eligible_for_validation');return {p,endorsement,resolved,candidate};
}
export async function measured(engine:Engine,call:ReturnType<typeof session>,candidate:any,profile='booking-node/4') {
  const r=call('materialize',{target:candidate.ref,profile}),registered=call('realization.register',{record:r});
  const out=await mkdtemp(path.join(tmpdir(),'strata-mediation-output-'));
  try {for(const [name,body] of Object.entries(r.files))await writeFile(path.join(out,name),body as string);await writeFile(path.join(out,'realization.json'),canonical(r));const oracle=fixtureOracle(candidate.snapshot);const actual=await runFixtureEvidence(out,r,oracle);assert(actual.evidence.results.every(r=>r.passed));const validation=call('validate',{target:candidate.ref,realization:registered.ref,evidence:actual.evidence},'fixture-runner');return {r,registered,actual,validation};}finally{await rm(out,{recursive:true,force:true});}
}
export function approval(engine:Engine,candidate:any,validation:any,kind='scope',scope:string|null=candidate.scope) {
  const c=engine.read(candidate.ref,'composition'),baseline=engine.read(c.baseline,'release');
  return {format:'approval/2',project_id:LOCAL_PROJECT,model_version:CONTENT_MODEL,baseline:c.baseline,authority_sha256:digest(baseline.authorities),kind,target:candidate.fingerprint,scope,evidence_digest:validation.evidence_digest,generation:engine.mediation!.generation(),expires_at:null,binding:null};
}
export async function release(f:ReturnType<typeof setup>,candidate:any) {const result=await measured(f.engine,f.call,candidate);const scope=f.call('approve',{record:approval(f.engine,candidate,result.validation)},'fixture-selector'),project=f.call('approve',{record:approval(f.engine,candidate,result.validation,'release',null)},'fixture-release');const released=f.call('release',{target:candidate.ref,validation:result.validation.ref,approvals:[scope.ref,project.ref]},'fixture-release');return {...result,scope,project,released};}
