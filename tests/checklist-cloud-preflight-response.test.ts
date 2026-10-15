// Synthetic endpoint contract tests; no original provider message/URL reconstruction.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {normalizeChecklistHttpResponse,type ChecklistManagementAction} from '../src/checklist-cloud-management.js';
import {canonical} from '../src/model.js';
import {checklistResponseDiagnostic,checklistDenialMessage,checklistFailureStage} from '../src/checklist-cloud-diagnostics.js';
const target={account_id:'a'.repeat(32),namespace:'synthetic-namespace',repository:'synthetic-repo',workflow:'synthetic-workflow',
 app_worker:'synthetic-app',workflow_worker:'synthetic-archive',project_id:'synthetic-project',run_id:'synthetic-run',instance_id:'synthetic-instance'};
const body=(code:number,message='Synthetic opaque missing-resource diagnostic',extra:Record<string,unknown>={})=>({success:false,result:null,errors:[{code,message,...extra}],messages:[]});
const call=(action:ChecklistManagementAction,raw:unknown,status=404)=>normalizeChecklistHttpResponse({action,target},status,raw);

test('Pinned installed primary client binds Workflow/Worker missing codes and exact remaining endpoint paths without invoking it',async()=>{
 const cli=await readFile(path.join(process.cwd(),'node_modules/wrangler/wrangler-dist/cli.js'),'utf8');
 assert(cli.includes('WORKFLOW_NOT_FOUND_CODE = 10200'));assert(cli.includes('e11 instanceof APIError && e11.code === WORKFLOW_NOT_FOUND_CODE'));
 assert(cli.includes('WORKER_NOT_FOUND_ERR_CODE = 10007'));assert(cli.includes('async function fetchLatestDeployments'));
 assert(cli.includes('/accounts/${accountId}/workflows/${workflowName}'));assert(cli.includes('/accounts/${accountId}/workers/scripts/${workerName}/deployments'));
});
test('Workflow404/10200 is code-authoritative for opaque non-denial prose, with exact requested name; repository and instance wording rules remain',()=>{
 assert.deepEqual(call('inspect-workflow',body(10200)),{absent:true,name:target.workflow});
 assert.throws(()=>call('inspect-repository',body(10200)));assert.throws(()=>call('inspect-instance',body(10200)));
 for(const message of ['Synthetic authentication failed','Synthetic permission denied','Synthetic bearer credential missing','Synthetic forbidden'])assert.throws(()=>call('inspect-workflow',body(10200,message)));
 for(const code of [10000,10007,10090,10201,10400])assert.throws(()=>call('inspect-workflow',body(code,'Synthetic resource not found')));
 assert.throws(()=>call('inspect-workflow',body(10200,'Synthetic opaque',{documentation_url:'https://synthetic.invalid'})));
});
test('Both remaining Worker GETs admit only404/10007 and typed documented inert diagnostics, without guessing actual messages',()=>{
 const metadata={documentation_url:'file:///synthetic-do-not-open?token=synthetic-secret',source:{pointer:'https://synthetic.invalid/not-fetched'}};
 for(const action of ['inspect-app-worker','inspect-workflow-worker'] as const){
  assert.deepEqual(call(action,body(10007)),{absent:true,name:action==='inspect-app-worker'?target.app_worker:target.workflow_worker});
  for(const source of [{},{pointer:'synthetic'}])assert.doesNotThrow(()=>call(action,body(10007,'Synthetic opaque',{...metadata,source})));
  for(const code of [10000,10090,10200,10201,10400])assert.throws(()=>call(action,body(code,'Synthetic resource not found',metadata)));
  for(const message of ['Synthetic authentication not found','Synthetic permission denied','Synthetic token missing'])assert.throws(()=>call(action,body(10007,message,metadata)));
 }
 const diagnostic=canonical(checklistResponseDiagnostic(404,body(10007,'Synthetic opaque',metadata)));assert(!diagnostic.includes('synthetic-secret'));assert(!diagnostic.includes('file:///'));assert(!diagnostic.includes('https://'));
});
test('Worker optional fields refuse invalid types, unknown error/source keys and mixed contradictory codes',()=>{
 for(const action of ['inspect-app-worker','inspect-workflow-worker'] as const){
  for(const value of [undefined,null,false,1,{},[]])assert.throws(()=>call(action,body(10007,'Synthetic opaque',{documentation_url:value})));
  for(const source of [undefined,null,false,1,'synthetic',[],{pointer:1},{pointer:null},{pointer:undefined},{other:'synthetic'}])assert.throws(()=>call(action,body(10007,'Synthetic opaque',{source})));
  assert.throws(()=>call(action,body(10007,'Synthetic opaque',{unknown:'synthetic'})));
  assert.throws(()=>call(action,{...body(10007),errors:[body(10007).errors[0],body(10000,'Synthetic denied').errors[0]]}));
 }
});
test('Every coded preflight absence keeps strict target/status/envelope/messages/result/pagination guards; empty lists never prove absence',()=>{
 for(const action of ['inspect-workflow','inspect-app-worker','inspect-workflow-worker'] as const){
  const raw=body(action==='inspect-workflow'?10200:10007);
  for(const status of [200,302,403,429,500])assert.throws(()=>call(action,raw,status));
  for(const invalid of [null,[],{...raw,success:true},{...raw,errors:[]},{...raw,messages:undefined},{...raw,messages:null},
   {...raw,messages:[{code:0,message:'Synthetic'}]},{...raw,result:{}},{...raw,extra:true},{...raw,cursor:undefined},
   {...raw,result_info:{count:1,per_page:1,total_count:2,page:1,total_pages:2}},
   {...raw,errors:[{code:raw.errors[0].code,message:''}]},{...raw,errors:[{code:raw.errors[0].code,message:42}]}])assert.throws(()=>call(action,invalid));
  assert.throws(()=>normalizeChecklistHttpResponse({action,target:{...target,account_id:'invalid'}},404,raw));
  assert.throws(()=>call(action,{success:true,result:{deployments:[]},errors:[],messages:[]},200));
 }
});

test('Access, privilege and equivalent prohibitions contradict coded absence; parser and sanitized classification agree',()=>{
 const denials=['You do not have access to this Workflow.','Insufficient privileges.','This operation is not allowed.',
  'Caller is not permitted to read this resource.','Access is restricted.','Request is prohibited.',
  'You are not entitled to use this resource.','You cannot view this resource.','You can’t invoke this resource.',
  'Caller lacks the required capability.','Caller lacks the required role.','Scope does not allow this operation.',
  'Request was rejected.','This request is blocked.','You may not perform this operation.','Unable to retrieve this resource.',
  'You have no rights to this resource.','Caller is not eligible for this resource.','Not able to fetch this resource.','This is a denial.'];
 for(const message of denials){
  assert.equal(checklistDenialMessage(message),true);
  for(const action of ['inspect-workflow','inspect-app-worker','inspect-workflow-worker'] as const){
   const raw=body(action==='inspect-workflow'?10200:10007,message);
   assert.throws(()=>call(action,raw),error=>checklistFailureStage(error,'management.other')==='absence.error.authorization');
   const diagnostic=checklistResponseDiagnostic(404,raw),encoded=canonical(diagnostic);
   assert.equal(diagnostic.authorization_present,true);assert.equal(diagnostic.errors!.entries![0].message!.authorization_phrase,true);
   assert.equal(diagnostic.errors!.entries![0].message!.safe_text,'authorization diagnostic');assert(!encoded.includes(message));
  }
 }
 for(const message of ['Synthetic opaque missing-resource diagnostic','Synthetic resource not found','Synthetic resource does not exist'])assert.equal(checklistDenialMessage(message),false);
 for(const value of [null,undefined,0,{}])assert.equal(checklistDenialMessage(value),false);
});

test('Denial outside the four displayed errors still sets sanitized refusal classification',()=>{
 const raw={...body(10200),errors:[...Array.from({length:4},()=>body(10200).errors[0]),body(10200,'Insufficient privileges.').errors[0]]};
 assert.throws(()=>call('inspect-workflow',raw));const diagnostic=checklistResponseDiagnostic(404,raw);
 assert.equal(diagnostic.authorization_present,true);assert.equal(diagnostic.errors!.entries!.length,4);assert.equal(diagnostic.errors!.truncated,true);
});
