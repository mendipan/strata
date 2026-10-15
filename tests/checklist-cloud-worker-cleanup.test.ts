// Offline synthetic cases, including the observed private-entity 404 shape.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/model.js';
import {checklistWorkerId,checklistWorkerEntityUrl,checklistPrivateWorkerIdentity,checklistWorkerDeleteAcknowledgement,checklistPrivateWorkerAbsence} from '../src/checklist-cloud-worker-identity.js';
import {verifyChecklistWorkerRecovery,checklistWorkerCleanupPlan,verifyChecklistWorkerCleanupFreshRead,
 initialChecklistWorkerCleanupState,reserveChecklistWorkerCleanupDelete,acknowledgeChecklistWorkerCleanupDelete,observeChecklistWorkerCleanupAbsence,
 type ChecklistWorkerRecovery,type ChecklistWorkerCleanupAuthority} from '../src/checklist-cloud-worker-cleanup.js';

const now=Date.parse('2026-10-13T12:00:00Z'),candidate='a'.repeat(40);
const identity={account_id:'1'.repeat(32),name:'synthetic-owned-worker',id:'1234567890abcdef1234567890abcdef',
 created_on:'2026-10-13T11:00:00.123456Z',updated_on:'2026-10-13T11:00:00.123456Z'};
const worker={id:identity.id,name:identity.name,created_on:identity.created_on,updated_on:identity.updated_on,deployed_on:null,logpush:false,
 subdomain:{enabled:false,previews_enabled:false,url:'https://synthetic.invalid',preview_url_suffix:'synthetic.invalid'},
 references:{dispatch_namespace_outbounds:[],domains:[],durable_objects:[],queues:[],workers:[]},tags:[],tail_consumers:[]};
const raw={success:true,errors:[],messages:[],result:worker};
const read=(by:'id'|'name')=>({method:'GET' as const,url:checklistWorkerEntityUrl(identity.account_id,by==='id'?identity.id:identity.name,by),
 http_status:200 as const,response_sha256:digest(raw),identity});
const proof:ChecklistWorkerRecovery={format:'strata-checklist-worker-recovery/1',bridge_candidate_commit:'b'.repeat(40),source_sha256:'c'.repeat(64),
 target_sha256:'d'.repeat(64),reconciliation_plan_sha256:'e'.repeat(64),consumed_activation_sha256:'f'.repeat(64),
 original_POST_response_sha256:digest(raw),identity,exact_name_read:read('name'),exact_id_read:read('id')};
const plan=checklistWorkerCleanupPlan(proof,digest(proof));
const authority:ChecklistWorkerCleanupAuthority={format:'strata-checklist-worker-cleanup-authority/1',approved:true,cleanup_only:true,
 approval_id:'synthetic-cleanup-only',approved_at:now-1000,expires_at:now+1000,candidate_commit:candidate,contract_sha256:digest(plan),
 recovery_sha256:digest(proof),consumed_activation_sha256:proof.consumed_activation_sha256,identity,maximum_deletes:1,force:false,
 preserve_quarantine:true,preserve_cost_hold:true};
const fresh={method:'GET' as const,url:plan.fresh_read.url,http_status:200,raw,observed_at:now};
const reserve=(state=initialChecklistWorkerCleanupState(proof))=>reserveChecklistWorkerCleanupDelete(proof,digest(proof),authority,candidate,state,fresh,now);

test('Worker-only 32-hex policy preserves case and exact entity paths; rejects UUIDs and path injections',()=>{
 for(const id of [identity.id,identity.id.toUpperCase()]){
  assert(checklistWorkerId(id));assert(checklistWorkerEntityUrl(identity.account_id,id).endsWith('/'+id));
  assert.equal(checklistPrivateWorkerIdentity({...worker,id},identity.name,id),id);
 }
 for(const id of ['',null,32,'a'.repeat(31),'a'.repeat(33),'g'.repeat(32),'a'.repeat(32)+'\n',
  '12345678-90ab-cdef-1234-567890abcdef','../'+identity.id,identity.id+'?force=true',identity.id+'%2f']){
  assert.equal(checklistWorkerId(id),false);assert.throws(()=>checklistPrivateWorkerIdentity({...worker,id},identity.name));
  assert.throws(()=>checklistWorkerEntityUrl(identity.account_id,id as string));
 }
 assert.throws(()=>checklistWorkerEntityUrl('../account',identity.id));
 assert.throws(()=>checklistWorkerEntityUrl(identity.account_id,'worker?force=true','name'));
 assert.throws(()=>checklistPrivateWorkerIdentity(worker,identity.name,identity.id.toUpperCase()));
});
test('Recovery requires separately pinned proof and both exact endpoint identities matching the original POST digest',()=>{
 assert.deepEqual(verifyChecklistWorkerRecovery(proof,digest(proof)),proof);
 assert.throws(()=>verifyChecklistWorkerRecovery(proof,'0'.repeat(64)));
 for(const key of ['exact_name_read','exact_id_read'] as const)for(const change of [
  {response_sha256:'0'.repeat(64)},{url:plan.delete.url+'?force=true'},{http_status:404},{method:'POST'},
  {identity:{...identity,id:'2'.repeat(32)}},{identity:{...identity,created_on:'2026-10-12T11:00:00Z'}}]){
  const wrong={...proof,[key]:{...proof[key],...change}};assert.throws(()=>verifyChecklistWorkerRecovery(wrong,digest(wrong)));
 }
 assert.equal(plan.delete.method,'DELETE');assert.equal(plan.delete.url,read('id').url);assert.equal(plan.maximum_deletes,1);
 assert(!plan.delete.url.includes('?'));assert.equal(plan.execution_enabled,false);assert.equal(plan.absence_reads.length,2);
});
test('Fresh read refuses same-name wrong-ID, changed/private/deployed/ref state, missing null and any full digest drift',()=>{
 assert.equal(verifyChecklistWorkerCleanupFreshRead(proof,fresh,now).response_sha256,digest(raw));
 for(const change of [{id:'2'.repeat(32)},{name:'different-name'},{created_on:'2026-10-12T11:00:00Z'},
  {updated_on:'2026-10-13T11:01:00Z'},{deployed_on:'2026-10-13T11:01:00Z'},{deployed_on:undefined},{logpush:true},
  {subdomain:{enabled:true,previews_enabled:false}},{subdomain:{enabled:false,previews_enabled:true}},
  {references:{...worker.references,workers:[{id:'2'.repeat(32),name:'synthetic-ref'}]}},{references:{}},
  {tags:['synthetic']},{tail_consumers:[{name:'synthetic'}]},{previews_base_config:{}},{unknown:'digest-drift'}])
  assert.throws(()=>verifyChecklistWorkerCleanupFreshRead(proof,{...fresh,raw:{...raw,result:{...worker,...change}}},now));
 for(const change of [{observed_at:now-60001},{observed_at:now+1},{url:read('name').url},{http_status:403},
  {raw:{...raw,messages:[{code:1000,message:'access denied'}]}},{raw:{...raw,result_info:{cursor:'synthetic'}}},
  {raw:{success:false,errors:[{code:10007,message:'not found'}],messages:[],result:null}}])
  assert.throws(()=>verifyChecklistWorkerCleanupFreshRead(proof,{...fresh,...change},now));
});
test('Fresh cleanup-only authority pins all scope and reserves DELETE exactly once, even after uncertain outcomes',()=>{
 for(const change of [{approved:false},{cleanup_only:false},{force:true},{maximum_deletes:2},{preserve_quarantine:false},
  {preserve_cost_hold:false},{contract_sha256:'0'.repeat(64)},{candidate_commit:'0'.repeat(40)},
  {recovery_sha256:'0'.repeat(64)},{consumed_activation_sha256:'0'.repeat(64)},
  {identity:{...identity,id:'2'.repeat(32)}},{approved_at:now+1},{expires_at:now},{expires_at:now+900001},
  {extra:'unknown-field'}])assert.throws(()=>reserveChecklistWorkerCleanupDelete(proof,digest(proof),{...authority,...change},candidate,
   initialChecklistWorkerCleanupState(proof),fresh,now));
 const reserved=reserve();assert.equal(reserved.state.phase,'delete-reserved-uncertain');assert.equal(reserved.state.delete_reservations,1);
 assert.throws(()=>reserve(reserved.state),'Lost response must never re-arm DELETE.');
 const ack={success:true,errors:[],messages:[]};
 const acknowledged=acknowledgeChecklistWorkerCleanupDelete(proof,reserved.state,plan.delete.url,200,ack);
 assert.equal(acknowledged.phase,'delete-acknowledged');assert.equal(acknowledged.acknowledgement.response_sha256,digest(ack));
 assert.throws(()=>reserve(acknowledged));assert.throws(()=>acknowledgeChecklistWorkerCleanupDelete(proof,acknowledged,plan.delete.url,200,ack));
 assert.throws(()=>acknowledgeChecklistWorkerCleanupDelete(proof,reserved.state,read('name').url,200,ack));
});
test('Documented no-result DELETE ack accepts optional null, typed diagnostics; refuses denial/pagination and uncertainty',()=>{
 const ack={success:true,errors:[],messages:[]};
 for(const body of [ack,{...ack,result:null},{...ack,messages:[{code:1000,message:'Synthetic diagnostic',documentation_url:'https://synthetic.invalid',source:{pointer:'/ignored'}}]}])
  assert.equal(checklistWorkerDeleteAcknowledgement(200,body).accepted,true);
 for(const body of [{...ack,result:{}},{...ack,messages:undefined},{...ack,messages:['malformed']},
  {...ack,messages:[{code:1000,message:'Insufficient privileges'}]},{...ack,messages:[{code:1000,message:'You cannot delete this Worker'}]},
  {...ack,messages:[{code:0,message:'synthetic'}]},{...ack,messages:[{code:1000,message:'Synthetic',source:{unknown:'value'}}]},
  {...ack,errors:[{code:10007,message:'not found'}]},{...ack,cursor:'synthetic'},{...ack,result_info:{count:1,total_count:1,per_page:1}},
  {...ack,success:false},{...ack,unknown:'field'},null])assert.throws(()=>checklistWorkerDeleteAcknowledgement(200,body));
 for(const status of [0,204,302,403,404,429,500])assert.throws(()=>checklistWorkerDeleteAcknowledgement(status,ack));
});
test('Follow-up ID/name negative observations never invent entity absence, clear quarantine or retry DELETE',()=>{
 const uncertain=reserve().state;
 for(const url of plan.absence_reads.map(r=>r.url))for(const [status,body] of [[404,{success:false,errors:[{code:10007,message:'Synthetic not found'}],messages:[],result:null}],
  [404,{success:false,errors:[{code:10007,message:'Insufficient privileges'}],messages:[],result:null}],
  [404,{}],[403,{}],[500,{}],[200,raw],[200,{...raw,result:{...worker,id:'2'.repeat(32)}}]] as const){
  const observation=observeChecklistWorkerCleanupAbsence(proof,uncertain,url,status,body);
  assert.equal(observation.verified_absent,false);assert.equal(observation.quarantine_preserved,true);assert.equal(observation.cost_hold_preserved,true);
  assert.equal(observation.response_sha256,digest(body));assert(!JSON.stringify(observation).includes('Insufficient privileges'));
  assert.throws(()=>reserve(uncertain));
 }
 assert.throws(()=>observeChecklistWorkerCleanupAbsence(proof,uncertain,plan.delete.url.replace('/workers/workers/','/workers/scripts/')+'/deployments',404,{}));
 assert.throws(()=>observeChecklistWorkerCleanupAbsence(proof,initialChecklistWorkerCleanupState(proof),plan.delete.url,404,{}));
});

test('Private exact-ID absence admits only the observed 404/10007 envelope and refuses denial or ambiguous negatives',()=>{
 const absent={success:false,errors:[{code:10007,message:'Synthetic Worker not found'}],messages:[],result:null};
 assert.deepEqual(checklistPrivateWorkerAbsence(404,absent),{absent:true});
 for(const status of [0,200,204,302,401,403,429,500])assert.throws(()=>checklistPrivateWorkerAbsence(status,absent));
 for(const change of [{success:true},{result:{}},{result:undefined},{messages:undefined},{messages:[{code:1000,message:'warning'}]},
  {cursor:'next'},{result_info:{count:1,total_count:1,per_page:1}},
  {errors:[]},{errors:[...absent.errors,...absent.errors]},
  ...[10200,10090,'10007'].map(code=>({errors:[{code,message:'Synthetic Worker not found'}]})),
  ...['permission denied; not found','not found; insufficient privileges','Unauthorized','Unknown error',''].map(message=>({errors:[{code:10007,message}]})),
  {errors:[{code:10007,message:'not found',unexpected:'value'}]}])
  assert.throws(()=>checklistPrivateWorkerAbsence(404,{...absent,...change}));
});
