// Deterministic synthetic diagnostics only. Never a provider run or credential read.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,StrataError} from '../src/model.js';
import {checklistResponseDiagnostic,checklistFailureStage,checklistTransientGetFailure,CHECKLIST_DIAGNOSTIC_BYTES} from '../src/checklist-cloud-diagnostics.js';
import {normalizeChecklistHttpResponse} from '../src/checklist-cloud-management.js';
const target={account_id:'a'.repeat(32),namespace:'synthetic-namespace',repository:'synthetic-repo',workflow:'synthetic-workflow',
 app_worker:'synthetic-app',workflow_worker:'synthetic-archive',project_id:'synthetic-project',run_id:'synthetic-run',instance_id:'synthetic-instance'};
const missing={success:false,result:null,errors:[{code:10200,message:'Repository not found'}],messages:[]};
function stage(raw:unknown,status=404){try{normalizeChecklistHttpResponse({action:'inspect-repository',target},status,raw);return'accepted';}
 catch(error){return checklistFailureStage(error,'management.other');}}
test('Documented Artifacts NOT_FOUND accepts optional documentation_url:string only for the named repository GET',()=>{
 assert.equal(stage(missing),'accepted');
 assert.equal(stage({...missing,errors:[{...missing.errors[0],documentation_url:'https://synthetic.invalid/do-not-follow'}]}),'accepted');
 assert.equal(stage({...missing,errors:[{...missing.errors[0],source:{pointer:'/repository'}}]}),'absence.error.fields');
 assert.equal(stage({...missing,messages:undefined}),'absence.messages');
 assert.equal(stage({...missing,errors:[{code:10200,message:'No such repository'}]}),'absence.error.message');
});

test('Optional documentation field remains inert and rejects every non-string type or additional error field',()=>{
 for(const value of [undefined,null,0,false,{},[],['https://synthetic.invalid']])
  assert.equal(stage({...missing,errors:[{...missing.errors[0],documentation_url:value}]}),'absence.error.fields');
 const optional={...missing,errors:[{...missing.errors[0],documentation_url:'file:///synthetic-do-not-read?token=synthetic-secret'}]};
 assert.equal(stage(optional),'accepted','A typed string is ignored, never followed or interpreted as authority.');
 const diagnostic=canonical(checklistResponseDiagnostic(404,optional));assert(!diagnostic.includes('file:///'));assert(!diagnostic.includes('synthetic-secret'));
 for(const field of [{source:{}},{pointer:'/synthetic'},{unknown:'synthetic'}])
  assert.equal(stage({...optional,errors:[{...optional.errors[0],...field}]}),'absence.error.fields');
 for(const action of ['inspect-instance','inspect-workflow','inspect-app-worker','inspect-workflow-worker'] as const)
  assert.throws(()=>normalizeChecklistHttpResponse({action,target},404,optional));
});

test('A documentation field never overrides NOT_FOUND code, denied/ambiguous envelope, pagination, status or target binding',()=>{
 const optional={...missing,errors:[{...missing.errors[0],documentation_url:'https://synthetic.invalid/do-not-follow'}]};
 for(const code of [10000,10400,10201,0,'10200',null])assert.notEqual(stage({...optional,errors:[{...optional.errors[0],code}]}),'accepted');
 for(const message of ['Authentication not found','Permission denied; repository not found','Bearer credential not found','Repository lookup failed'])
  assert.notEqual(stage({...optional,errors:[{...optional.errors[0],message}]}),'accepted');
 for(const raw of [{...optional,success:true},{...optional,errors:[]},{...optional,messages:[{code:0,message:'Synthetic message'}]},
  {...optional,messages:undefined},{...optional,result:{name:target.repository}},{...optional,cursor:'synthetic'},
  {...optional,result_info:{count:1,total_count:2,per_page:1,page:1,total_pages:2}},
  {...optional,errors:[optional.errors[0],{code:10000,message:'Synthetic authentication failed'}]},
  {...optional,errors:[optional.errors[0],{code:10200,message:'Synthetic permission denied; not found'}]},
  {...optional,errors:[optional.errors[0],{code:10200,message:'Synthetic different failure'}]}])assert.notEqual(stage(raw),'accepted');
 for(const status of [200,302,403,500])assert.notEqual(stage(optional,status),'accepted');
 assert.throws(()=>normalizeChecklistHttpResponse({action:'inspect-repository',target:{...target,account_id:'invalid'}},404,optional));
 assert.deepEqual(normalizeChecklistHttpResponse({action:'inspect-repository',target},404,optional),{absent:true,name:target.repository});
});
test('Refusal stages distinguish malformed, denied and paginated responses without widening absence',()=>{
 assert.equal(stage(null),'response.kind');assert.equal(stage({...missing,extra:true}),'absence.envelope.fields');
 assert.equal(stage({...missing,success:true}),'absence.success');assert.equal(stage({...missing,errors:[]}),'absence.errors');
 assert.equal(stage({...missing,messages:[{code:1000,message:'permission denied'}]}),'absence.messages');
 assert.equal(stage({...missing,result:{}}),'absence.result');assert.equal(stage({...missing,errors:[{code:10200,message:'Authentication not found'}]}),'absence.error.authorization');
 assert.equal(stage({...missing,cursor:'next'}),'pagination.marker');assert.equal(stage({...missing,result_info:{count:0,total_count:0,per_page:0}}),'pagination.info.counts');
 assert.equal(stage(missing,403),'http.status');
});
test('Diagnostics never retain arbitrary messages, headers, URLs, result values or unknown field names',()=>{
 const secret='synthetic-secret-DO-NOT-RETAIN',url='https://example.invalid/?token='+secret;
 const raw={...missing,[secret]:secret,result:{token:secret,headers:{authorization:secret}},
  errors:[{code:10200,message:'Repository not found; Bearer '+secret,documentation_url:url,source:{pointer:secret,[secret]:secret}}],
  messages:[{code:1000,message:secret}]};
 const d=checklistResponseDiagnostic(404,raw),text=canonical(d);assert(!text.includes(secret));assert(!text.includes(url));assert(!text.includes('Bearer'));
 assert.equal(d.arbitrary_text_retained,false);assert.equal(d.result_values_retained,false);assert.equal(d.headers_retained,false);
 assert.equal(d.errors!.entries![0].code,10200);assert.equal(d.errors!.entries![0].message!.safe_text,'authorization diagnostic');
 assert.equal(d.errors!.entries![0].message!.not_found_phrase,true);assert.equal(d.fields!.unknown_fields,1);
});
test('Diagnostic output is finite even for many oversized errors and unknown fields; retries classify only transient codes/statuses',()=>{
 const d=checklistResponseDiagnostic(500,{errors:Array.from({length:1000},()=>({code:1000,message:'x'.repeat(3000)})),messages:[]});
 assert(new TextEncoder().encode(canonical(d)).length<=CHECKLIST_DIAGNOSTIC_BYTES);assert.equal(d.errors!.truncated,true);assert.equal(d.errors!.entries!.length,4);
 assert(checklistTransientGetFailure(Object.assign(new Error('secret'),{code:'ETIMEDOUT'})));
 assert(checklistTransientGetFailure(new StrataError('CHECKLIST_MANAGEMENT_REFUSED',7,'secret',{http_status:503,checklist_stage:'http.status'})));
 for(const e of [new Error('timeout'),{code:'CERT_HAS_EXPIRED'},new StrataError('CHECKLIST_MANAGEMENT_REFUSED',7,'secret',{http_status:404}),
  new StrataError('CHECKLIST_MANAGEMENT_REFUSED',7,'secret',{http_status:503,checklist_stage:'http.body'}),
  new StrataError('CHECKLIST_MANAGEMENT_REFUSED',7,'secret',{http_status:503,checklist_stage:'absence.error.authorization'})])assert.equal(checklistTransientGetFailure(e),false);
 assert.equal(checklistFailureStage(new StrataError('x',7,'secret',{checklist_stage:'synthetic-secret'}),'http.transport'),'http.transport');
});
