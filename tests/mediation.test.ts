import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core.js';
import {CONTENT_MODEL,MODEL,canonical,digest,type Layer} from '../src/model.js';
import {FixtureIssuer,LOCAL_PROJECT} from '../src/security.js';
import {expiryRequirement} from '../src/profile.js';
import {proposal} from '../src/fixtures.js';
import {snapshot,setup,prepare,respond,select,release,measured,approval,publish,session,composition,FIXTURE_NOW,issuerFor,fixtureConfiguration,layers} from './mediation-helpers.js';
const code=(value:string)=>(error:any)=>{assert.equal(error.code,value);return true;};

test('prerequisite: fresh v0.2 uses exact approval/2, measured evidence and separate Release',async()=>{
  const engine=new Engine({}, {},{projectId:LOCAL_PROJECT,modelVersion:CONTENT_MODEL}),issuer=issuerFor(),call=session(engine,issuer);
  call('init',{record:snapshot()},'fixture-bootstrap');const c=composition('C-prerequisite-s2');c.proposals=[];c.selected=[];c.alternative_groups=[];const candidate=call('compose',{record:c});
  const actual=await measured(engine,call,candidate);const base=approval(engine,candidate,actual.validation);
  assert.equal(actual.actual.evidence.results.length,9);assert.deepEqual(actual.actual.observations.competing_hold,{accepted:false,reason:'occupied'});
  assert.throws(()=>call('approve',{record:{kind:'scope',target:candidate.fingerprint,scope:candidate.scope,evidence_digest:actual.validation.evidence_digest}},'fixture-selector'),code('INVALID_RECORD'));
  for(const patch of [{project_id:'foreign'},{authority_sha256:'a'.repeat(64)},{generation:'previous'},{baseline:'absent@1'},{expires_at:new Date(FIXTURE_NOW-1).toISOString()}])assert.throws(()=>call('approve',{record:{...base,...patch}},'fixture-selector'));
  const scope=call('approve',{record:base},'fixture-selector');assert.throws(()=>call('release',{target:candidate.ref,validation:actual.validation.ref,approvals:[scope.ref]},'fixture-release'),code('RELEASE_APPROVAL_REQUIRED'));
  const project=call('approve',{record:approval(engine,candidate,actual.validation,'release',null)},'fixture-release');const released=call('release',{target:candidate.ref,validation:actual.validation.ref,approvals:[scope.ref,project.ref]},'fixture-release');
  assert.equal(engine.read(released.ref).model_version,CONTENT_MODEL);assert.equal(canonical(engine.read(released.ref).acceptance_manifest),canonical(candidate.obligations));assert.equal(engine.read(scope.ref).format,'approval/2');
});

test('one exact booking policy creates one whole partition, durable use and endorsement; no model',async()=>{
  const f=setup(),p=prepare(f);assert.equal(p.analysis.basis.policy_status,'unique');assert.deepEqual(p.analysis.basis.alternatives[0].selected,['L-hold@1','L-reminder@1']);
  const selected=select(f,p),again=respond(f,p);assert.equal(again.ref,selected.endorsement.ref);assert.equal(Object.values(f.engine.records).filter(r=>r.type==='selection-use').length,1);
  assert.equal(f.engine.read(again.ref).principal,'policy-executor');assert.equal(f.engine.read(selected.endorsement.receipt_ref).origin,'policy-fixture');
  const actual=await measured(f.engine,f.call,selected.candidate);assert.equal(actual.actual.observations.reminder.reminders[0].at,840);assert.equal(actual.actual.observations.expired.now,900);
  assert.throws(()=>f.call('release',{target:selected.candidate.ref,validation:actual.validation.ref,approvals:[]},'fixture-release'),code('ENDORSEMENT_REQUIRED'));
  const done=await release(f,selected.candidate);assert.equal(done.released.state,'validated');
});

test('unassigned executor, author, reader, preparer and spoofed origin cannot approve',()=>{
  const f=setup(),p=prepare(f),option=p.packet.packet.options[0];
  for(const selector of ['fixture-a','fixture-reader','fixture-preparer'])assert.throws(()=>respond(f,p,selector));
  const input={packet_ref:p.packet.ref,packet_sha256:p.packet.packet_sha256,case_revision:1,action:'approve_selection',option_id:option.id,message:'x',origin:'human'};
  assert.throws(()=>f.call('mediation.respond',input,'fixture-executor-s2'),code('INVALID_RECORD'));
  const copied={...f.engine.read(p.decisions[0].layer).resolution_proposals[0],kind:'resolution'};assert.throws(()=>f.call('approve',{record:copied},'fixture-executor-s2'));
  const unassigned=issuerFor();const call=session(f.engine,unassigned);assert.throws(()=>call('mediation.respond',input,'fixture-executor-s2'),code('AUTHENTICATION_REQUIRED'));
  assert.equal(Object.values(f.engine.records).filter(r=>r.type==='selection-use').length,0);
});

test('without executor baseline authority a policy descriptor cannot be installed',()=>{
  const s=snapshot(false),config=fixtureConfiguration(s,layers(s)),issuer=issuerFor(config),engine=new Engine({}, {},{projectId:LOCAL_PROJECT,modelVersion:CONTENT_MODEL}),call=session(engine,issuer);
  assert.throws(()=>call('init',{record:s},'fixture-bootstrap'),code('SELECTION_GRANT_FORBIDDEN'));assert.equal(Object.keys(engine.records).length,0);
});

test('human route presents exact alternatives; defer and planning direction mint no approvals',()=>{
  const f=setup(false),p=prepare(f);assert.equal(p.analysis.basis.policy_status,'unresolved');assert.equal(p.packet.packet.options.length,2);assert.equal(p.packet.packet.recommendation,null);
  const deferred=respond(f,p,'fixture-selector',undefined,'defer');assert.equal(deferred.approved,false);assert.equal(Object.values(f.engine.records).some(r=>r.type==='approval'),false);
  assert.throws(()=>respond(f,p,'fixture-selector','900'),code('DECISION_DEFERRED'));
  const next=prepare(f,{case_revision:2,supersedes:p.analysis.ref});const planning=respond(f,next,'fixture-reviewer',undefined,'planning_direction');assert.equal(planning.authoring_required,true);assert.equal(planning.approved,false);
  const chosen=select(f,next,'fixture-selector','1200');assert.equal(chosen.candidate.snapshot.blocks['booking.hold'].requirements.expiry.parameters.seconds,1200);
});

test('ambiguous policies remain unresolved and executor cannot choose either outcome',()=>{
  const f=setup(true,true),p=prepare(f);assert.equal(p.analysis.basis.policy_status,'unresolved');assert.equal(p.packet.packet.options.length,2);assert.throws(()=>respond(f,p),code('SELECTION_GRANT_FORBIDDEN'));assert.equal(Object.values(f.engine.records).filter(r=>r.type==='selection-use').length,0);
});

test('exact packet/digest/case/option and input changes refuse stale pending responses',()=>{
  for(const patch of [{packet_sha256:'a'.repeat(64)},{case_revision:2},{option_id:'not-prepared'}]){const f=setup(),p=prepare(f);const request={packet_ref:p.packet.ref,packet_sha256:p.packet.packet_sha256,case_revision:1,action:'approve_selection',option_id:'policy-selection',message:'x',...patch};assert.throws(()=>f.call('mediation.respond',request,'fixture-executor-s2'));assert.equal(Object.values(f.engine.records).filter(r=>r.type==='selection-use').length,0);}
  const f=setup(),p=prepare(f);const extra=proposal('L-extra','author-c');extra.model_version=CONTENT_MODEL;publish(f.call,extra);const changed=composition('C-changed');changed.proposals.push('L-extra@1');changed.selected.push('L-extra@1');const blocked=f.call('compose',{record:changed});
  const decision=p.decisions[0];assert.throws(()=>f.call('resolve',{record:{layer:decision.layer,proposal_index:0,composition:blocked.ref,approvals:[]}}),code('MEDIATION_STALE'));
  const original=f.engine.read(p.analysis.ref);const changedBasis={...original,source_sha256:{...original.source_sha256,'L-hold@1':'a'.repeat(64)}};const badRef='mediation-basis@'+digest(changedBasis);f.engine.store(badRef,'mediation-basis',changedBasis);assert.throws(()=>f.engine.mediation!.fresh(badRef),code('MEDIATION_STALE'));
});

test('expiry, revocation and configuration rollback block pending and same-target retry',()=>{
  const f=setup(),p=prepare(f);respond(f,p);f.setNow(FIXTURE_NOW+3600000);assert.throws(()=>respond(f,p),code('MEDIATION_STALE'));
  const revoked=setup(),rp=prepare(revoked);respond(revoked,rp);revoked.issuer.suspendForTest('policy-executor');assert.throws(()=>respond(revoked,rp));
  const old=setup(),op=prepare(old);const rolled=new FixtureIssuer({now:()=>FIXTURE_NOW,mediation:{...old.config!,generation:2}}),call=session(old.engine,rolled);assert.throws(()=>call('mediation.prepare',{basis_ref:op.analysis.ref,decisions:op.decisions}),code('MEDIATION_STALE'));
});

test('one-case use cannot authorize a new target or replenish by another request',()=>{
  const f=setup(),p=prepare(f),result=respond(f,p);assert(result.use_ref);assert.throws(()=>f.engine.mediation!.grant(p.analysis.basis.grant_ref,'booking-case','a'.repeat(64)),code('SELECTION_GRANT_EXHAUSTED'));
  assert.throws(()=>f.engine.mediation!.grant(p.analysis.basis.grant_ref,'different-case',p.packet.packet.options[0].target),code('SELECTION_GRANT_FORBIDDEN'));
  const engine=new Engine(structuredClone(f.engine.records),structuredClone(f.engine.ownerHeads),{projectId:LOCAL_PROJECT,modelVersion:CONTENT_MODEL}),call=session(engine,issuerFor(f.config));const retry=call('mediation.respond',{packet_ref:p.packet.ref,packet_sha256:p.packet.packet_sha256,case_revision:1,action:'approve_selection',option_id:'policy-selection',message:'Exact synthetic fixture response.'},'fixture-executor-s2');assert.equal(retry.ref,result.ref);assert.equal(Object.values(engine.records).filter(r=>r.type==='selection-use').length,1);
  delete engine.records[Object.keys(engine.records).find(r=>engine.records[r].type==='mediation-installation')!];assert.throws(()=>call('mediation.respond',{packet_ref:p.packet.ref,packet_sha256:p.packet.packet_sha256,case_revision:1,action:'approve_selection',option_id:'policy-selection',message:'x'},'fixture-executor-s2'),code('MEDIATION_CONFIGURATION_REQUIRED'));
});

test('broader impact, extra writes/acceptance/descriptions and unknown scenario checks stop automatic policy',()=>{
  for(const mutation of ['extra','scope','check','asset','criterion']){
    const f=setup();let c=composition('C-'+mutation);
    if(mutation==='check')c.scenario.checks.push({id:'unknown',version:'1'});
    else {const l=proposal('L-uncovered','author-c');l.model_version=CONTENT_MODEL;if(mutation==='scope')l.changes=[{op:'set_item',block:'app',path:'description',expected:{kind:'value',value:f.s.blocks.app.description},value:{format:'plain-text/1',text:'Expanded impact.'}}];if(mutation==='asset')l.changes=[{op:'set_item',block:'booking.hold',path:'description',expected:{kind:'value',value:f.s.blocks['booking.hold'].description},value:{format:'plain-text/1',text:'Unreviewed side effect in an additional layer.'}}];if(mutation==='criterion')l.acceptance=[{block:'booking.hold',id:'extra',criterion:{statement:'Extra criterion',method:'mechanical',check:'booking.expiry',version:'1',fixture:'extra',subjects:['booking.hold/requirements.expiry']}}];publish(f.call,l);c.proposals.push(l.id+'@1');c.selected.push(l.id+'@1');}
    const blocked=f.call('compose',{record:c});const prepared=prepare({...f,blocked},{partitions:[{id:'900',selected:['L-hold@1','L-reminder@1'],rejected:c.proposals.filter(r=>!['L-hold@1','L-reminder@1'].includes(r))}]});assert.equal(prepared.analysis.basis.policy_status,'unresolved');assert.throws(()=>respond(f,prepared,'fixture-executor-s2','900'));
  }
});

test('new project report invalidates packets and carries across names/baselines; exact disposition only',async()=>{
  const f=setup(false),p=prepare(f),chosen=select(f,p,'fixture-selector','900'),done=await release(f,chosen.candidate),historical=digest(f.engine.read(done.released.ref));
  const report=f.call('conflicts.report',{target:chosen.candidate.ref,report:{id:'late-interaction',message:'Review interaction against the actual fixture.',affected_items:['booking.hold/requirements.expiry'],contributors:['L-hold@1','L-reminder@1'],evidence_refs:[done.validation.ref]}},'fixture-reviewer');
  assert.throws(()=>respond(f,p,'fixture-selector','900'),code('MEDIATION_STALE'));
  const clone=composition('C-renamed');clone.selected=chosen.candidate.selected??['L-hold@1','L-reminder@1'];clone.resolutions=[chosen.resolved.ref];const renamed=f.call('compose',{record:clone});assert.equal(renamed.state,'blocked');assert(renamed.diagnostics.some((d:any)=>d.code==='INTERACTION_REVIEW_REQUIRED'));
  assert.throws(()=>f.call('reports.dispose',{report_ref:report.ref,target:chosen.candidate.ref,selected:clone.selected,rejected:['L-alternative@1'],kind:'not_applicable',rationale:'review',evidence_refs:[]},'fixture-selector'),code('INVALID_RECORD'));
  const disposed=f.call('reports.dispose',{report_ref:report.ref,target:chosen.candidate.ref,selected:clone.selected,rejected:['L-alternative@1'],kind:'not_applicable',rationale:'Exact measured selection does not exhibit the attributed fixture interaction.',evidence_refs:[done.validation.ref]},'fixture-selector');assert.equal(disposed.globally_closed,false);
  const next=composition('C-next-baseline');next.baseline=done.released.ref;next.proposals=[];next.selected=[];next.alternative_groups=[];const blocked=f.call('compose',{record:next});assert(blocked.diagnostics.some((d:any)=>d.code==='INTERACTION_REVIEW_REQUIRED'));assert.equal(digest(f.engine.read(done.released.ref)),historical);
});

test('deliberate authorized v0.2 evolution to 1200 seconds requires fresh checks and approvals',async()=>{
  const f=setup(),first=select(f),r1=await release(f,first.candidate),old=digest(f.engine.read(r1.released.ref));
  const l=proposal('L-evolve','author-a',[{op:'set_item',block:'booking.hold',path:'requirements.expiry',expected:{kind:'value',value:expiryRequirement(900)},value:expiryRequirement(1200)}]);l.model_version=CONTENT_MODEL;l.baseline=r1.released.ref;const ref=publish(f.call,l);const c=composition('C-evolved');c.baseline=r1.released.ref;c.proposals=[ref];c.selected=[ref];c.alternative_groups=[];const candidate=f.call('compose',{record:c});assert.equal(candidate.state,'eligible_for_validation');
  assert.throws(()=>f.call('validate',{target:candidate.ref,realization:r1.registered.ref,evidence:r1.actual.evidence},'fixture-runner'),code('STALE_EVIDENCE'));
  const r2=await release(f,candidate);assert.equal(r2.actual.observations.reminder.reminders[0].at,1140);assert.equal(r2.actual.observations.expired.now,1200);assert.equal(digest(f.engine.read(r1.released.ref)),old);
  assert.throws(()=>f.call('release',{target:candidate.ref,validation:r2.validation.ref,approvals:[r1.scope.ref,r1.project.ref]},'fixture-release'),code('STALE_APPROVAL'));
});

test('fixture access activation advances durable generation; restarting an older config cannot revive executor',()=>{
  const f=setup(),p=prepare(f);respond(f,p);
  const config={generation:2,policies:[],grants:[]},issuer=issuerFor(config),call=session(f.engine,issuer);
  call('init',{record:f.s},'fixture-bootstrap');assert.equal(Object.values(f.engine.records).filter(r=>r.type==='mediation-installation').length,2);
  const old=session(f.engine,issuerFor(f.config));assert.throws(()=>old('mediation.prepare',{basis_ref:p.analysis.ref,decisions:p.decisions}),code('MEDIATION_STALE'));
  const next=prepare({...f,call,issuer,config},{case_revision:2,supersedes:p.analysis.ref});const chosen=select({...f,call,issuer,config},next,'fixture-selector','1200');assert.equal(chosen.candidate.snapshot.blocks['booking.hold'].requirements.expiry.parameters.seconds,1200);
  assert.equal(Object.values(f.engine.records).filter(r=>r.type==='selection-use').length,1);
});

test('uncovered report between prepare and endorsement mints no receipt/use, and exact disposition permits fresh human case',async()=>{
  const f=setup(),p=prepare(f);f.call('conflicts.report',{target:f.blocked.ref,report:{id:'before-endorsement',message:'Unknown interaction remains open.',affected_items:['booking.hold/requirements.expiry'],contributors:['L-hold@1'],evidence_refs:[]}},'fixture-reviewer');assert.throws(()=>respond(f,p),code('MEDIATION_STALE'));assert.equal(Object.values(f.engine.records).filter(r=>r.type==='selection-use').length,0);
  const h=setup(false),hp=prepare(h),selected=select(h,hp,'fixture-selector','900'),done=await release(h,selected.candidate);
  const report=h.call('conflicts.report',{target:selected.candidate.ref,report:{id:'reviewed-interaction',message:'Review exact measured interaction.',affected_items:['booking.hold/requirements.expiry'],contributors:['L-hold@1'],evidence_refs:[done.validation.ref]}},'fixture-reviewer');
  assert.throws(()=>h.call('release',{target:selected.candidate.ref,validation:done.validation.ref,approvals:[done.scope.ref,done.project.ref]},'fixture-release'),code('MEDIATION_STALE'));
  h.call('reports.dispose',{report_ref:report.ref,target:selected.candidate.ref,selected:['L-hold@1','L-reminder@1'],rejected:['L-alternative@1'],kind:'not_applicable',rationale:'Responsible reviewer checked the exact existing measured selection.',evidence_refs:[done.validation.ref]},'fixture-selector');
  const refreshed=prepare(h,{case_revision:2,supersedes:hp.analysis.ref});assert.equal(refreshed.analysis.basis.alternatives.find((a:any)=>a.id==='900').eligible,true);assert.equal(refreshed.analysis.basis.alternatives.find((a:any)=>a.id==='1200').eligible,false);const adopted=select(h,refreshed,'fixture-selector','900');assert.equal(adopted.candidate.state,'eligible_for_validation');
});

test('executor lower-level resolve cannot seal human choices; changed explanation does not mint a second endorsement',()=>{
  const f=setup(),p=prepare(f),first=respond(f,p);const input={packet_ref:p.packet.ref,packet_sha256:p.packet.packet_sha256,case_revision:1,action:'approve_selection',option_id:'policy-selection',message:'Another explanation for the same exact response.'};const retry=f.call('mediation.respond',input,'fixture-executor-s2');assert.equal(retry.ref,first.ref);assert.equal(retry.receipt_ref,first.receipt_ref);assert.equal(Object.values(f.engine.records).filter(r=>r.type==='mediation-receipt').length,1);assert.equal(Object.values(f.engine.records).filter(r=>r.type==='approval').length,1);
  const h=setup(),c=composition('C-human-not-policy');c.scenario.id='human-booking';const blocked=h.call('compose',{record:c}),humanFixture={...h,blocked};const hp=prepare(humanFixture),human=respond(humanFixture,hp,'fixture-selector','1200'),d=hp.decisions.find((d:any)=>d.option_id==='1200');assert.throws(()=>h.call('resolve',{record:{layer:d.layer,proposal_index:0,composition:blocked.ref,approvals:[human.ref]}},'fixture-executor-s2'),code('SELECTION_GRANT_FORBIDDEN'));
});

test('unsupported acceptance version produces a truthful nonexecutable packet, never automatic endorsement',()=>{
  const s=snapshot(true);s.blocks['booking.hold'].acceptance.expiry.version='2';const ls=layers(s),config=fixtureConfiguration(s,ls),issuer=issuerFor(config),engine=new Engine({}, {},{projectId:LOCAL_PROJECT,modelVersion:CONTENT_MODEL}),call=session(engine,issuer);call('init',{record:s},'fixture-bootstrap');ls.forEach(l=>publish(call,l));const blocked=call('compose',{record:composition()});const f={s,ls,config,issuer,engine,call,blocked,setNow:()=>{}};const p=prepare(f);assert.equal(p.analysis.basis.policy_status,'unresolved');assert(p.packet.packet.options.every((o:any)=>!o.executable));assert.throws(()=>respond(f,p,'fixture-selector','900'),code('POLICY_UNRESOLVED'));assert.equal(Object.values(engine.records).filter(r=>r.type==='selection-use').length,0);
});

test('missing durable use state refuses reuse rather than replenishing balance; input ordering is stable',()=>{
  const f=setup(),p=prepare(f);const c=composition();c.proposals.reverse();c.selected.reverse();c.alternative_groups[0].members.reverse();const normalized=f.call('compose',{record:c});assert.equal(normalized.ref,f.blocked.ref);const result=f.call('mediation.prepare',{target:f.blocked.ref,case_id:'booking-case',case_revision:1,expires_at:new Date(FIXTURE_NOW+7200000).toISOString(),goal:'Choose the compatible hold and reminder.',partitions:[],supersedes:null});assert.equal(result.ref,p.analysis.ref);
  const endorsed=respond(f,p);delete f.engine.records[endorsed.use_ref];assert.throws(()=>respond(f,p),code('SELECTION_LEDGER_INVALID'));assert.equal(Object.values(f.engine.records).filter(r=>r.type==='selection-use').length,0);
});

test('prerequisite: existing fixed guardian rules use protected-item scope in approval/2',async()=>{
  const s=snapshot();s.authorities.guardians.push({item:'booking.hold/requirements.expiry',principal:'safety-guardian'});const issuer=issuerFor(),engine=new Engine({}, {},{projectId:LOCAL_PROJECT,modelVersion:CONTENT_MODEL}),call=session(engine,issuer);call('init',{record:s},'fixture-bootstrap');const l=proposal('L-protected-expiry','author-a',[{op:'set_item',block:'booking.hold',path:'requirements.expiry',expected:{kind:'value',value:expiryRequirement(600)},value:expiryRequirement(900)}]);l.model_version=CONTENT_MODEL;const ref=publish(call,l),c=composition('C-guardian');c.proposals=[ref];c.selected=[ref];c.alternative_groups=[];const candidate=call('compose',{record:c}),actual=await measured(engine,call,candidate);const scope=call('approve',{record:approval(engine,candidate,actual.validation)},'fixture-selector'),project=call('approve',{record:approval(engine,candidate,actual.validation,'release',null)},'fixture-release');assert.throws(()=>call('release',{target:candidate.ref,validation:actual.validation.ref,approvals:[scope.ref,project.ref]},'fixture-release'),code('GUARDIAN_REQUIRED'));
  const guardian=call('approve',{record:approval(engine,candidate,actual.validation,'guardian','booking.hold/requirements.expiry')},'fixture-guardian');const released=call('release',{target:candidate.ref,validation:actual.validation.ref,approvals:[scope.ref,project.ref,guardian.ref]},'fixture-release');assert.equal(released.state,'validated');assert.equal(engine.read(guardian.ref).scope,'booking.hold/requirements.expiry');assert.equal(engine.read(released.ref).blocks['booking.hold'].requirements.expiry.parameters.seconds,900);
});
