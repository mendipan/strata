// Offline synthetic protocol fixtures. This suite is not evidence of a provider run.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {readFileSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonical,digest,bytesDigest} from '../src/model.js';
import {checklistCloudFixture} from './checklist-cloud-fixture.js';
import {buildChecklistBundle,verifyChecklistBundle} from '../scripts/checklist-cloud-prepare.js';
import {activateAttendedChecklist,checklistBootstrapPlan,checklistBootstrapCliOptions,CHECKLIST_MODEL_DIAGNOSTIC_LIMITS,checklistMultipart,type ChecklistActivation} from '../scripts/checklist-cloud-bootstrap.js';
import {checklistSubrequestQualification,checklistConfigDigest,checklistPrivateConfigs,checklistUploadMetadata} from '../src/checklist-cloud-config.js';
import {describeChecklistHttpRequest,normalizeChecklistHttpResponse,checklistNoPagination} from '../src/checklist-cloud-management.js';
import {checklistAuthorizationDigest,runChecklistCloudWorkflow,CHECKLIST_STEPS,type ChecklistSteps,type ChecklistRunGrant} from '../src/checklist-cloud-workflow.js';
import {checklistAppWorker} from '../src/checklist-cloud-app-worker.js';
import {StrictArtifacts} from './artifacts-fixture.js';
import {initializeChecklistSharedBudget} from '../scripts/checklist-cloud-budget.js';
import {checklistWorkerCreateBody,checklistWorkerVersionBody} from '../scripts/checklist-cloud-worker-version.js';

const fixture=await checklistCloudFixture(),p=fixture.p,repository=process.cwd(),clock=Date.parse('2026-10-13T02:00:00Z');
const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-bootstrap-package-'));
const built=await buildChecklistBundle(p,directory,repository,true),source=built.source.source_sha256;
const diagnosticDirectory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-app-model-package-'));
const diagnosticBuilt=await buildChecklistBundle(p,diagnosticDirectory,repository,true,'app-model-diagnostic'),diagnosticSource=diagnosticBuilt.source.source_sha256;
const versionDirectory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-version-evidence-package-'));
const versionBuilt=await buildChecklistBundle(p,versionDirectory,repository,true,'worker-version-diagnostic'),versionSource=versionBuilt.source.source_sha256;
const settingsFixture=JSON.parse(await readFile('tests/fixtures/checklist-worker-wire/settings.json','utf8')).result;
const evidence:unknown[]=[];
const ids={app:'11111111111141118111111111111111',workflow:'22222222222242228222222222222222',
 appVersion:'33333333-3333-4333-8333-333333333333',workerVersion:'44444444-4444-4444-8444-444444444444',
 workflowId:'55555555-5555-4555-8555-555555555555',definition:'66666666-6666-4666-8666-666666666666'};
const json=(result:unknown)=>new Response(canonical({success:true,errors:[],messages:[],result}),{headers:{'content-type':'application/json'}});
const absent=(code=10200)=>new Response(canonical({success:false,errors:[{code,message:'Synthetic resource not found'}],messages:[],result:null}),{status:404});
async function scope(purpose?:'app-model-diagnostic'|'worker-version-diagnostic'):Promise<ChecklistActivation>{const evidence_directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-bootstrap-ledger-'));
 const source=purpose==='worker-version-diagnostic'?versionSource:purpose?diagnosticSource:built.source.source_sha256;
 return {format:'strata-checklist-cloud-activation/1',approved:true,approval_id:'synthetic-bootstrap-only',approved_at:clock-1000,approval_expires_at:clock+3600000,
  ...(purpose?{purpose}:{}),preparation_sha256:digest(p),source_sha256:source,target_sha256:p.target_sha256,config_sha256:checklistConfigDigest(p,source),plan_sha256:digest(checklistBootstrapPlan(p,source,purpose)),
  evidence_directory,credential_reference:'env:CLOUDFLARE_API_TOKEN',existing_standard_paid_confirmed:true,required_permissions_confirmed:['Workers Scripts Write','Artifacts Read/Edit'],
  spending_limit_usd:1,local_evidence_retention_days:30,shared_budget_file:path.join(os.tmpdir(),'strata-synthetic-shared-budget.json'),combined_gross_spending_limit_usd:20,
  retention:purpose==='worker-version-diagnostic'?{repository:'retain',instance:'delete',workers:'retain'}:{repository:'delete',instance:'delete',workers:'delete'}};
}
function provider(s:ChecklistActivation,mode='healthy') {
 const source=s.source_sha256,directory=s.purpose==='worker-version-diagnostic'?versionDirectory:s.purpose?diagnosticDirectory:built.output;
 const calls:{url:string;method:string;body:string}[]=[],state=new Map<string,{id:string;private:boolean;version?:string;versionBody?:ReturnType<typeof checklistWorkerVersionBody>}>();
 let workflowCreated=false,headers=0,postCount=0,activation='',runStarted=false,instanceDeleted=false,repoPresent=false;
 const outputs=new Map<string,unknown>();
 const root=`/client/v4/accounts/${p.target.account_id}`,names=[p.target.app_worker,p.target.workflow_worker];
 const fetch=async(r:Request)=>{
  const u=new URL(r.url),body=r.body?await r.text():'';calls.push({url:r.url,method:r.method,body});
  assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(r.redirect,'manual');assert(u.pathname.startsWith(root+'/'));
  const reserved=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  if(u.pathname.endsWith('/instances')&&r.method==='POST')runStarted=true;
  if(!runStarted){assert.equal(reserved.at(-1).state,'reserved-before-dispatch');assert.equal(reserved.at(-1).url,r.url,'Every bootstrap exchange is fsync-reserved first.');}
  else{const progress=(await readdir(s.evidence_directory)).find(name=>name.endsWith('.consumed.json.progress.json'))!;
   const receipt=JSON.parse(await readFile(path.join(s.evidence_directory,progress),'utf8'));
   assert.equal(receipt.receipts.at(-1).state,'reserved-before-dispatch','Existing runner reserves before handoff exchanges.');}
  assert(!JSON.stringify(reserved).includes('Bearer')&&!JSON.stringify(reserved).includes('synthetic-public-key'));
  if(mode==='eligibility-refusal'&&u.pathname.endsWith('/account-settings'))return json({default_usage_model:'bundled'});
  if(u.pathname.endsWith('/account-settings'))return json({default_usage_model:'standard'});
  if(u.pathname===root+`/artifacts/namespaces/${p.target.namespace}`)return json({namespace:p.target.namespace,jurisdiction:'unrestricted'});
  if(u.pathname.endsWith('/repos/'+p.target.repository)){
   if(r.method==='DELETE'){assert(repoPresent);repoPresent=false;return json(null);}
   return mode==='collision'||repoPresent?json({name:p.target.repository}):absent();
  }
  if(u.pathname.endsWith('/instances')&&r.method==='POST'){
   const wire=JSON.parse(body);assert.equal(wire.instance_id,p.target.instance_id);assert.equal(typeof wire.params,'string');
   if(mode==='unsupported-create')return new Response(canonical({success:false,errors:[{code:1000,message:'Synthetic unsupported parameter shape'}],messages:[],result:null}),{status:400});
   const payload=JSON.parse(wire.params),g=payload.grant as ChecklistRunGrant;
   const runtime={source_sha256:source,grant_sha256:digest(g),authorization_sha256:checklistAuthorizationDigest(g),workflow_version_id:g.workflow_version_id,app_version_id:g.app_version_id};
   const strict=new StrictArtifacts(),mod=await import('data:text/javascript;base64,'+Buffer.from(fixture.realization.files['collection.mjs']).toString('base64'));
   const app=checklistAppWorker(mod.createCollection,p.pins);
   const steps:ChecklistSteps={async do(name,config,callback){const output=await callback({step:{name,count:1},attempt:1,config});outputs.set(name,output);return output;}};
   await runChecklistCloudWorkflow(p,g,runtime,{instanceId:wire.instance_id,payload},steps,{mode:'synthetic-test-only',now:()=>clock,provision:async()=>{},
    namespace:{get:async name=>{const handle=await strict.get(name);return{...handle,info:async()=>({remote:(await handle.info()).remote.replace('account.artifacts',p.target.account_id+'.artifacts')})};}},
    transport:request=>strict.transport(new Request(request.url.replace(p.target.account_id+'.artifacts','account.artifacts'),request)),
    app:{fetch:request=>app.fetch(request,{CHECKLIST_SOURCE_SHA256:source,CHECKLIST_TARGET_SHA256:p.target_sha256,CHECKLIST_VERSION:{id:g.app_version_id}})}});
   repoPresent=true;return json({id:p.target.instance_id,status:'complete',version_id:ids.definition,workflow_id:ids.workflowId});
  }
  if(u.pathname.endsWith('/instances/'+p.target.instance_id)){
   if(r.method==='DELETE'){instanceDeleted=true;return json(null);}
   return instanceDeleted||mode==='unsupported-create'?absent(10400):json({status:'complete',versionId:ids.definition,steps:CHECKLIST_STEPS.map(name=>({name:name+'-1',type:'step',success:true,attempts:[{success:true}]}))});
  }
  if(u.pathname.endsWith('/status')&&r.method==='PATCH')return json(null);
  if(u.pathname.endsWith('/step'))return json({status:'complete',error:null,output:outputs.get(u.searchParams.get('name')!.replace(/-1$/,''))});
  if(u.pathname===root+'/workers/workers'&&r.method==='POST'){
   postCount++;const input=JSON.parse(body);assert.deepEqual(input,checklistWorkerCreateBody(p,source,input.name===names[0]?'app':'workflow'));
   assert(names.includes(input.name));const kind=input.name===names[0]?'app':'workflow',id=ids[kind];state.set(input.name,{id,private:true});
   if(mode==='lost-create')throw Error('Synthetic lost acknowledgement after creation');
   return json({id,name:input.name,logpush:false,subdomain:{enabled:mode==='public-create',previews_enabled:false}});
  }
  if(u.pathname.startsWith(root+'/workers/workers/')){
   if(u.pathname.includes('/versions')){
    const id=u.pathname.split('/workers/workers/')[1].split('/')[0],entry=[...state].find(([,value])=>value.id===id);
    assert(entry);const kind=entry[0]===names[0]?'app':'workflow';
    if(r.method==='POST'){
     assert.equal(u.search,'?deploy=true');assert(entry[1].private);
     const versionBody=JSON.parse(body),bundle=await readFile(path.join(directory,kind+'-bundle.mjs'));
     assert(Object.hasOwn(versionBody,'usage_model'));assert.equal(versionBody.usage_model,'standard');
     const reservation=reserved.find(r=>r.state==='reserved-before-dispatch'&&r.sequence===calls.length);
     assert(reservation);assert.equal(reservation.requested_usage_model,'standard');assert.equal(reservation.body_sha256,bytesDigest(body));
     if(kind==='workflow')activation=versionBody.bindings.find((v:{name:string})=>v.name==='CHECKLIST_AUTHORIZATION_SHA256').text;
     assert.deepEqual(versionBody,checklistWorkerVersionBody(bundle,p,source,kind,activation));
     assert.equal(Buffer.from(versionBody.modules[0].content_base64,'base64').compare(bundle),0);
     if(mode==='upload-failure')return new Response('{}',{status:500});
     entry[1].version=kind==='app'?ids.appVersion:ids.workerVersion;entry[1].versionBody=versionBody;
     return json({id:entry[1].version,number:1,created_on:'2026-10-13T02:00:00Z',urls:[],usage_model:'standard'});
    }
    assert.equal(r.method,'GET');assert.equal(u.search,'?include=modules');assert(u.pathname.endsWith('/'+entry[1].version));
    return json({id:entry[1].version,number:1,created_on:'2026-10-13T02:00:00Z',urls:[],...entry[1].versionBody});
   }
   const id=u.pathname.split('/').at(-1),entry=[...state].find(([,value])=>value.id===id);
   if(!entry){assert.equal(r.method,'GET');return absent(10007);}// Synthetic response matching the observed exact-ID negative contract.
   if(r.method==='DELETE'){state.delete(entry[0]);return new Response(canonical({success:true,errors:[],messages:[]}));}
   assert.equal(r.method,'GET');return json({id,name:entry[0],logpush:false,subdomain:{enabled:false,previews_enabled:false},observability:{enabled:true,traces:{enabled:true}}});
  }
  const worker=names.find(name=>u.pathname.startsWith(root+'/workers/scripts/'+name));
  if(worker){const entry=state.get(worker),kind=worker===names[0]?'app':'workflow';
   if(r.method==='DELETE'){assert(entry);state.delete(worker);return json(null);}
   if(u.pathname.endsWith('/deployments'))return entry?.version?json({deployments:[{id:'77777777-7777-4777-8777-777777777777',created_on:'2026-10-13T02:00:00Z',source:'api',strategy:'percentage',versions:[{version_id:mode==='wrong-version'?ids.definition:entry.version,percentage:100}]}]}):absent(10007);
   if(u.pathname.endsWith('/subdomain'))return json({enabled:false,previews_enabled:false});
   if(u.pathname.endsWith('/settings')){
    const version=entry!.versionBody!;
    return json({...settingsFixture,bindings:version.bindings,compatibility_date:version.compatibility_date,
     compatibility_flags:version.compatibility_flags,limits:version.limits,usage_model:version.usage_model});
   }
  }
  if(u.pathname===root+'/workflows/'+p.target.workflow){
   if(r.method==='PUT'){assert(state.get(p.target.workflow_worker)?.version);assert.deepEqual(JSON.parse(body),{script_name:p.target.workflow_worker,class_name:'ChecklistArchiveWorkflow',limits:{steps:8},concurrency:{limit:1},default_retention:{success_retention:3600000,error_retention:3600000}});workflowCreated=true;return json({id:ids.workflowId});}
   if(r.method==='DELETE'){assert(workflowCreated);workflowCreated=false;return json(null);}
   return workflowCreated?json({id:ids.workflowId,name:p.target.workflow,script_name:p.target.workflow_worker,class_name:'ChecklistArchiveWorkflow',schedules:[]}):absent();
  }
  if(u.pathname.endsWith('/versions')){
   assert.equal(u.search,'?page=1&per_page=1');assert(workflowCreated);
   return json([{id:ids.definition,workflow_id:ids.workflowId,class_name:'ChecklistArchiveWorkflow',language:'javascript',limits:{steps:8},concurrency:{limit:1},default_retention:{success_retention:3600000,error_retention:3600000}}]);
  }
  throw Error('Unapproved synthetic endpoint: '+r.method+' '+u.pathname);
 };
 return {calls,state,fetch,headers:()=>headers,posts:()=>postCount,options:{mode:'synthetic-test-only' as const,repository,package_directory:directory,evidence_directory:s.evidence_directory,
  attended_terminal:()=>true,now:()=>clock,authorize_headers:()=>{headers++;return {authorization:'Bearer synthetic-public-key'};},synthetic_fetch:fetch,synthetic_bootstrap_only:true}};
}

test('App model diagnostic purpose is explicit in CLI/plan/activation and cannot reuse full-demo authority',async()=>{
 assert.deepEqual(checklistBootstrapCliOptions('--app-model-diagnostic'),{purpose:'app-model-diagnostic'});
 assert.deepEqual(checklistBootstrapCliOptions('--preflight'),{preflight_only:true});assert.throws(()=>checklistBootstrapCliOptions('--diagnostic'));
 const plan=checklistBootstrapPlan(p,diagnosticSource,'app-model-diagnostic');
 assert.equal(diagnosticBuilt.source.purpose,'app-model-diagnostic');assert.equal(diagnosticBuilt.approval.purpose,'app-model-diagnostic');
 assert.equal(diagnosticBuilt.approval.diagnostic_only,true);assert.equal(diagnosticBuilt.approval.billing_state,'unresolved');
 assert.deepEqual(diagnosticBuilt.approval.private_resources,{workers:1,workflow:0,instance:0,repository:0,service_bindings:0,public_routes:0});
 assert.deepEqual(diagnosticBuilt.approval.diagnostic_request_limits,{work_calls:13,cleanup_calls:2,retries:0,app_requests:0});
 assert.equal(plan.purpose,'app-model-diagnostic');assert.equal(plan.diagnostic_only,true);assert.equal(plan.billing_state,'unresolved');
 assert.deepEqual(plan.limits,CHECKLIST_MODEL_DIAGNOSTIC_LIMITS);assert.equal(plan.private_create.bodies.length,1);assert.equal(plan.workers.length,1);assert.equal(plan.workflow,null);
 assert.deepEqual(plan.get_retry,{enabled:false,maximum_attempts:1});
 for(const mismatch of ['full-packet','full-cli','full-plan'] as const){
  const s=await scope(mismatch==='full-packet'?undefined:'app-model-diagnostic'),api=provider(s);
  if(mismatch==='full-plan')s.plan_sha256=digest(checklistBootstrapPlan(p,source));
  await assert.rejects(activateAttendedChecklist(p,s.source_sha256,s,{...api.options,...(mismatch==='full-cli'?{}:{purpose:'app-model-diagnostic' as const})}));
  assert.equal(api.calls.length,0);assert.equal(api.headers(),0);
 }
 const s=await scope('app-model-diagnostic'),api=provider(s);delete s.purpose;s.plan_sha256=digest(checklistBootstrapPlan(p,s.source_sha256));
 await assert.rejects(activateAttendedChecklist(p,s.source_sha256,s,api.options));assert.equal(api.calls.length,0);assert.equal(api.headers(),0);
});
test('Retained version evidence requires its own package, purpose, plan and retention authority before any request',async()=>{
 assert.deepEqual(checklistBootstrapCliOptions('--worker-version-diagnostic'),{purpose:'worker-version-diagnostic'});
 assert.equal(versionBuilt.source.purpose,'worker-version-diagnostic');assert.equal(versionBuilt.approval.diagnostic_only,true);
 assert.deepEqual(versionBuilt.approval.diagnostic_request_limits,{work_calls:17,cleanup_calls:0,retries:0,app_requests:0});
 const plan=checklistBootstrapPlan(p,versionSource,'worker-version-diagnostic');assert.equal(plan.workflow,null);
 assert.equal(plan.limits.total_host_calls,17);assert.equal(plan.limits.partial_cleanup_calls,0);assert.deepEqual(plan.get_retry,{enabled:false,maximum_attempts:1});
 for(const mismatch of ['full-cli','full-package','delete-workers','delete-repository','full-plan'] as const){
  const s=await scope(mismatch==='full-package'?undefined:'worker-version-diagnostic'),api=provider(s);
  if(mismatch==='delete-workers')s.retention.workers='delete';if(mismatch==='delete-repository')s.retention.repository='delete';
  if(mismatch==='full-plan')s.plan_sha256=digest(checklistBootstrapPlan(p,s.source_sha256));
  await assert.rejects(activateAttendedChecklist(p,s.source_sha256,s,{...api.options,...(mismatch==='full-cli'?{}:{purpose:'worker-version-diagnostic' as const})}));
  assert.equal(api.calls.length,0);assert.equal(api.headers(),0);
 }
});

test('Retained version evidence captures matching or differing configuration, stops at 17 calls and cannot execute or delete resources',async()=>{
 for(const variant of ['matching','service-environment-mismatch','module-mismatch'] as const){
  const budgetFile=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-version-budget-')),'budget.json');
  const budget=await initializeChecklistSharedBudget(budgetFile,0,'b'.repeat(64),true,true),s=await scope('worker-version-diagnostic');s.shared_budget_file=budgetFile;
  const api=provider(s),result=await activateAttendedChecklist(p,versionSource,s,{...api.options,purpose:'worker-version-diagnostic',shared_budget:budget,synthetic_fetch:async request=>{
   const response=await api.fetch(request);
   if(request.method!=='GET'||!request.url.includes('/workers/'+ids.workflow+'/versions/'))return response;
   const raw=JSON.parse(await response.text());
   if(variant==='service-environment-mismatch')raw.result.bindings.find((b:{type:string})=>b.type==='service').environment='staging';
   if(variant==='module-mismatch')raw.result.modules[0].content_base64=Buffer.from('SYNTHETIC_PRIVATE_MODULE').toString('base64');
   return json(raw.result);
  }});
  assert('diagnostic_complete' in result);assert.equal(result.diagnostic_complete,true);assert.equal(result.completed,false);assert.equal(result.prepared,false);
  assert('required_configuration_check' in result);assert.equal(result.required_configuration_check,variant==='matching'?'match':'refused');
  assert.equal(api.calls.length,17);assert.equal(api.state.size,2);assert.equal(api.calls.filter(c=>c.method==='POST').length,4);
  assert(!api.calls.some(c=>['DELETE','PUT','PATCH'].includes(c.method)||/\/instances|\/tokens/.test(c.url)));
  const files=await readdir(s.evidence_directory);assert(!files.some(n=>/run-authorization|bound-grant|activated-workflow/.test(n)));
  const journal=await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8'),rows=journal.trim().split('\n').map(line=>JSON.parse(line));
  const diagnostic=rows.find(r=>r.state==='worker-version-diagnostic-complete');assert(diagnostic);
  assert.equal(diagnostic.sequence,17);assert.equal(diagnostic.accepted_configuration,false);assert.equal(diagnostic.runtime_grant_created,false);
  assert.equal(diagnostic.worker_id,ids.workflow);assert.equal(diagnostic.version_id,ids.workerVersion);assert.equal(rows.at(-1).diagnostic_complete,true);
  assert(!journal.includes('SYNTHETIC_PRIVATE_MODULE'));assert(!journal.includes(Buffer.from('SYNTHETIC_PRIVATE_MODULE').toString('base64')));
  const lease=(await budget.snapshot()).leases[digest(s)];assert.equal(lease.held_gross_cents,100);assert.equal(lease.quarantined,true);assert.equal(lease.runtime_dispatched,false);assert.equal(lease.closed,true);
 }
});

test('Retained version evidence never retries transient reads or uncertain creates and keeps every acknowledged resource',async()=>{
 for(const stage of ['preflight','second-get','lost-create'] as const){
  const s=await scope('worker-version-diagnostic'),api=provider(s,stage==='lost-create'?'lost-create':'healthy');let failures=0;
  const result=await activateAttendedChecklist(p,versionSource,s,{...api.options,purpose:'worker-version-diagnostic',synthetic_fetch:async request=>{
   const response=await api.fetch(request);
   if(stage==='preflight'&&request.url.endsWith('/account-settings')||stage==='second-get'&&request.method==='GET'&&request.url.includes('/workers/'+ids.workflow+'/versions/')){
    failures++;return new Response(canonical({success:false,errors:[{code:10400,message:'Synthetic transient'}],messages:[],result:null}),{status:503});
   }
   return response;
  }});
  assert('diagnostic_complete' in result);assert.equal(result.diagnostic_complete,false);assert.equal(result.completed,false);
  assert.equal(api.calls.length,stage==='preflight'?1:stage==='second-get'?17:7);assert.equal(failures,stage==='lost-create'?0:1);
  assert.equal(api.state.size,stage==='preflight'?0:stage==='second-get'?2:1);assert(!api.calls.some(c=>c.method==='DELETE'));
 }
});

test('App model diagnostic captures all three enum/disagreement/missing/unknown observations before unchanged cleanup and always stops',async()=>{
 const marker='private-model-marker',cases:unknown[][]=[['standard','standard','standard'],['bundled','unbound','standard'],['unbound','standard','bundled'],['standard','bundled','unbound'],
  [undefined,'standard','standard'],['standard',undefined,'standard'],['standard','standard',undefined],
  [marker,'standard','standard'],['standard',marker,'standard'],['standard','standard',marker],[null,[],{}]];
 for(const models of cases){
  const s=await scope('app-model-diagnostic'),api=provider(s);let beforeDelete=false;
  const result=await activateAttendedChecklist(p,s.source_sha256,s,{...api.options,purpose:'app-model-diagnostic',synthetic_fetch:async request=>{
   if(request.method==='DELETE'){
    const rows=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const paired=rows.find(r=>r.state==='app-model-diagnostic-paired');assert(paired);assert.equal(paired.observations.length,3);beforeDelete=true;
   }
   const response=await api.fetch(request);let at=-1;
   if(request.method==='POST'&&request.url.endsWith('/versions?deploy=true'))at=0;
   if(request.method==='GET'&&request.url.endsWith('?include=modules'))at=1;
   if(request.method==='GET'&&request.url.endsWith('/settings'))at=2;
   if(at<0)return response;
   const body=await response.json() as {result:Record<string,unknown>};
   if(models[at]===undefined)delete body.result.usage_model;else body.result.usage_model=models[at];
   return json(body.result);
  }});
  assert('diagnostic_complete' in result);assert.equal(result.diagnostic_complete,true);assert.equal(result.purpose,'app-model-diagnostic');
  assert.equal(result.billing_state,'unresolved');assert.equal(result.prepared,false);assert.equal(result.completed,false);assert.equal(result.activation_consumed,true);
  assert('required_model_check' in result);assert.equal(result.required_model_check,models.every(v=>v==='standard')?'match':'refused');assert.equal(result.work_calls,13);assert.equal(api.calls.length,15);assert(beforeDelete);
  assert.equal(api.posts(),1);assert.equal(api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/versions?deploy=true')).length,1);
  assert(api.calls.every(c=>c.url.startsWith('https://api.cloudflare.com/')),'App logic is never invoked.');
  assert(!api.calls.some(c=>['PUT','PATCH'].includes(c.method)||/\/instances|\/tokens/.test(c.url)));
  const rows=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),paired=rows.find(r=>r.state==='app-model-diagnostic-paired');
  assert(!canonical(rows).includes(marker));assert.equal(paired.worker_id,ids.app);assert.equal(paired.version_id,ids.appVersion);assert.equal(paired.account_default_context.public_enum,'standard');
  assert.deepEqual(paired.observations.map((o:{endpoint:string})=>o.endpoint),['version-create','version-get','settings-get']);
  for(const [i,o] of paired.observations.entries()){
   assert.equal(o.worker_id,ids.app);assert.equal(o.version_id,ids.appVersion);assert.equal(o.billing_state,'unresolved');assert.equal(o.accepted_configuration,false);
   assert.equal(o.response_sha256,rows.find(r=>r.state==='returned'&&r.sequence===o.sequence).response_sha256);
   assert.equal(o.model.public_enum,['standard','bundled','unbound'].includes(String(models[i]))&&typeof models[i]==='string'?models[i]:'[redacted]');
   assert.equal(o.model.presence,models[i]===undefined?'missing':'present');
  }
  const final=rows.find(r=>r.state==='bootstrap-final');assert.equal(final.work_calls,13);assert.equal(final.partial_cleanup_calls,2);assert.equal(final.acknowledged_workers.length,1);assert.equal(final.handed_off,false);
  assert.equal(final.diagnostic_complete,true);assert.equal(paired.accepted_configuration,false);assert.equal(paired.full_demo_completed,false);
  assert(!final.blockers.some((v:string)=>v.startsWith('Partial setup cleanup unverified:')));
  assert(rows.some(r=>r.state==='verified-absent'&&r.url.endsWith('/workers/'+ids.app)));
  for(const file of ['bound-grant.json','run-authorization.json','activated-workflow.jsonc'])assert(!(await readdir(s.evidence_directory)).includes(file));
 }
});
test('App model diagnostic refuses non-model identity/privacy/byte/limit/configuration mismatches without later phase progression',async()=>{
 for(const mode of ['id','bytes','limit','public','deployment','settings-limits','settings-bindings','settings-observability'] as const){
  const s=await scope('app-model-diagnostic'),api=provider(s);
  const result=await activateAttendedChecklist(p,s.source_sha256,s,{...api.options,purpose:'app-model-diagnostic',synthetic_fetch:async request=>{
   const response=await api.fetch(request);if(request.method!=='GET'||response.status!==200)return response;
   const body=await response.json() as {result:Record<string,any>};
   if(request.url.endsWith('?include=modules')){
    body.result.usage_model='unbound';
    if(mode==='id')body.result.id=ids.workerVersion;
    if(mode==='bytes')body.result.modules[0].content_base64='ZXhwb3J0IGRlZmF1bHQge307';
    if(mode==='limit')body.result.limits.subrequests=2;
    if(mode==='public')body.result.urls=['https://fixture.example.invalid'];
   }
   if(mode==='deployment'&&request.url.endsWith('/deployments'))body.result.deployments[0].versions[0].percentage=50;
   if(request.url.endsWith('/settings')){
    if(mode==='settings-limits')body.result.limits.cpu_ms=2000;
    if(mode==='settings-bindings')body.result.bindings=[];
    if(mode==='settings-observability')body.result.observability.traces.enabled=false;
   }
   return json(body.result);
  }});
  assert('diagnostic_complete' in result);assert.equal(result.diagnostic_complete,false);assert.equal(result.completed,false);assert.equal(api.posts(),1);
  const rows=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert(!rows.some(r=>r.state==='app-model-diagnostic-paired'));assert(!api.calls.some(c=>c.method==='PUT'||/\/instances|\/tokens/.test(c.url)));
 }
});
test('App model diagnostic never retries transient preflight, exact-version/settings GET, creation or cleanup',async()=>{
 for(const endpoint of ['preflight','create','version-post','version-get','settings-get','delete','cleanup-get'] as const){
  const s=await scope('app-model-diagnostic'),api=provider(s);let intercepted=0,deleted=false;
  const result=await activateAttendedChecklist(p,s.source_sha256,s,{...api.options,purpose:'app-model-diagnostic',synthetic_fetch:async request=>{
   if(request.method==='DELETE')deleted=true;
   const match=endpoint==='preflight'&&request.url.endsWith('/account-settings')||endpoint==='create'&&request.method==='POST'&&request.url.endsWith('/workers/workers')||
    endpoint==='version-post'&&request.method==='POST'&&request.url.endsWith('/versions?deploy=true')||
    endpoint==='version-get'&&request.url.endsWith('?include=modules')||endpoint==='settings-get'&&request.url.endsWith('/settings')||
    endpoint==='delete'&&request.method==='DELETE'||endpoint==='cleanup-get'&&deleted&&request.method==='GET';
   if(match){intercepted++;return new Response('{}',{status:503});}return api.fetch(request);
  }});
  assert.equal(intercepted,1);assert(result.work_calls<=13);
  const rows=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),final=rows.find(r=>r.state==='bootstrap-final');
  assert(final.partial_cleanup_calls<=2);assert(!rows.some(r=>r.state==='retry-scheduled'));
 }
});

test('Whole instance includes all phases, three app calls and conservative platform overhead; pins supported 256',()=>{
 assert.deepEqual(checklistSubrequestQualification(62,62),{scope:'whole-instance',phases:{closure:71,index:7,cold_read:67},planned_known:147,maximum_known:148,
  platform_overhead_allowance:64,total_reserved:212,configured_limit:256,provider_internal_usage_measured:false});
 assert.equal(checklistSubrequestQualification(80,80).total_reserved,248);assert.throws(()=>checklistSubrequestQualification(100,100));
 assert.equal(checklistPrivateConfigs(p,source).workflow.limits.subrequests,256);
 evidence.push({case:'whole-instance-accounting',actual_62_record_bound:212,maximum_80_record_bound:248,pinned_limit:256,synthetic_only:true});
});
test('Approval, time, paid/permission attestations and source/config/plan pins fail before credential callback or provider exchange',async()=>{
 for(const change of [{approved:false},{config_sha256:'a'.repeat(64)},{target_sha256:'a'.repeat(64)},{plan_sha256:'a'.repeat(64)},{approval_expires_at:clock},
  {existing_standard_paid_confirmed:false},{required_permissions_confirmed:['Workers Scripts Read']},{credential_reference:'some-other-token'}]){
  const s=await scope(),api=provider(s);await assert.rejects(activateAttendedChecklist(p,source,{...s,...change},api.options));assert.equal(api.calls.length,0);assert.equal(api.headers(),0);
 }
 const s=await scope(),api=provider(s);await assert.rejects(activateAttendedChecklist(p,source,s,{...api.options,mode:'approved-attended'}));assert.equal(api.headers(),0);
});
test('Private create precedes exact JSON version uploads/readback; returned version identities freeze one authorization and consumed ledger',async()=>{
 const s=await scope(),api=provider(s),result=await activateAttendedChecklist(p,source,s,api.options);
 assert.equal(result.prepared,true);assert.equal(api.posts(),2);assert.equal(api.headers(),api.calls.length);assert(api.calls.length<=32);
 assert.equal(api.state.size,0,'Synthetic bootstrap-only path performs partial-setup cleanup.');
 const bound=JSON.parse(await readFile(path.join(s.evidence_directory,'bound-grant.json'),'utf8'));
 assert.equal(bound.grant.app_version_id,ids.appVersion);assert.equal(bound.grant.workflow_version_id,ids.workerVersion);
 assert.equal(bound.grant.workflow_definition_version_id,ids.definition);assert.equal(bound.grant.workflow_id,ids.workflowId);
 assert.equal(bound.grant.config_sha256,s.config_sha256);assert.equal(checklistAuthorizationDigest(bound.grant),bound.runtime.authorization_sha256);
 const prior=api.calls.length;await assert.rejects(activateAttendedChecklist(p,source,s,api.options));assert.equal(api.calls.length,prior,'Consumed activation is never reusable.');
 assert.equal(result.work_calls,23);
 evidence.push({case:'private-json-version-ledger',work_calls:23,fixture_http_exchanges:api.calls.length,synthetic_only:true});
});
test('Collision/eligibility refusal never mutate; failed partial uploads/private/version readback clean only acknowledged session resources',async()=>{
 for(const mode of ['collision','eligibility-refusal','upload-failure','public-create','wrong-version']){
  const s=await scope(),api=provider(s,mode),result=await activateAttendedChecklist(p,source,s,api.options);assert.equal(result.completed,false);
  if(['collision','eligibility-refusal'].includes(mode))assert(api.calls.every(c=>c.method==='GET'));
  assert.equal(api.state.size,0);assert(!api.calls.some(c=>c.method==='POST'&&c.url.includes('/instances')));
 }
});

test('Settings refusal journals fixed per-field diagnostics and keeps activation consumed before Workflow/grant/instance creation',async()=>{
 for(const field of ['observability.traces.enabled','limits.subrequests','bindings','usage_model']){
  const s=await scope(),api=provider(s),marker='private-provider-data';
  const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   const response=await api.fetch(request);
   if(request.method!=='GET'||!request.url.endsWith('/settings'))return response;
   const raw=await response.json() as {result:Record<string,any>};
   if(field==='observability.traces.enabled')raw.result.observability.traces.enabled=false;
   if(field==='limits.subrequests')raw.result.limits.subrequests=2;
   if(field==='bindings')raw.result.bindings=[{name:marker,type:'secret_text',text:marker}];
   raw.result.usage_model=field==='usage_model'?'unbound':'bundled';
   raw.result[marker]=marker;return json(raw.result);
  }});
  assert.equal(result.prepared,false);assert.equal(result.activation_consumed,true);assert.equal(result.work_calls,13);
  assert(!api.calls.some(c=>c.method==='PUT'||c.url.endsWith('/instances')));
  assert(!(await readdir(s.evidence_directory)).includes('bound-grant.json'));
  const records=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const refusal=records.find(r=>r.state==='settings-validator-refused');assert(refusal);assert.equal(refusal.sequence,13);
  assert.equal(refusal.validator_stage,'bootstrap.response');assert(!canonical(refusal).includes(marker));
  assert(refusal.diagnostic.settings_diagnostic.fields.some((f:{field:string;status:string})=>f.field===field&&f.status==='different'));
  if(field==='usage_model')assert.equal(refusal.diagnostic.settings_diagnostic.fields.find((f:{field:string})=>f.field===field).observed_public_enum,'unbound');
  assert(records.some(r=>r.state==='bootstrap-refused'&&r.activation_consumed===true));
 }
});

test('Documented typed version response refusals never freeze a grant or dispatch an instance; cleanup uses acknowledged Worker ID',async()=>{
 for(const mode of ['script-put','legacy','private-id','different-version','module-bytes','module-type','binding','subrequests','public-url','pagination','observability']){
  const s=await scope(),api=provider(s);
  const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   const response=await api.fetch(request);if(response.status!==200||request.method==='DELETE')return response;
   const raw=await response.clone().json() as {result:Record<string,unknown>};
   if(request.method==='POST'&&request.url.endsWith('/versions?deploy=true')){
    if(mode==='script-put')return json({id:p.target.app_worker,startup_time_ms:12,etag:'synthetic-opaque'});
    if(mode==='legacy')return json({deployment_id:ids.appVersion});
    if(mode==='private-id')return json({...raw.result,id:ids.app});
   }
   if(request.method==='GET'&&request.url.endsWith('?include=modules')){
    const v=raw.result;
    if(mode==='different-version')v.id=ids.workerVersion;
    if(mode==='public-url')v.urls=['https://synthetic.invalid'];
    if(mode==='pagination')v.cursor='synthetic-next';
    if(mode==='binding')v.bindings=[];
    if(mode==='subrequests')v.limits={cpu_ms:1000,subrequests:999};
    if(mode==='module-bytes'||mode==='module-type'){
     const module=(v.modules as Record<string,unknown>[])[0];
     if(mode==='module-bytes')module.content_base64=Buffer.from('synthetic changed bytes').toString('base64');else module.content_type='application/javascript';
    }
    return json(v);
   }
   if(mode==='observability'&&request.method==='GET'&&request.url.endsWith('/workers/'+ids.app))return json({...raw.result,observability:{enabled:true,traces:{enabled:false}}});
   return response;
  }});
  assert.equal(result.prepared,false);assert(!(await readdir(s.evidence_directory)).includes('bound-grant.json'));
  assert(!api.calls.some(c=>c.method==='POST'&&c.url.endsWith('/instances')));
  const deletions=api.calls.filter(c=>c.method==='DELETE');assert.equal(deletions.length,1);assert(deletions[0].url.endsWith('/workers/'+ids.app));
 }
});

test('Cheap preflight verifies exactly six GETs without consuming mutation authorization or starting a Workflow',async()=>{
 const s=await scope(),api=provider(s),result=await activateAttendedChecklist(p,source,s,{...api.options,preflight_only:true});
 assert.equal(result.completed,false);assert('preflight_verified' in result&&result.preflight_verified);assert.equal(result.activation_consumed,false);
 assert.equal(api.calls.length,6);assert(api.calls.every(c=>c.method==='GET'));
 const files=await readdir(s.evidence_directory);assert.deepEqual(files,['bootstrap-reservations.jsonl']);assert.equal(api.state.size,0);
});

test('All six preflight stages accept documented coded Workflow/Worker absence without English wording; Worker diagnostic metadata stays inert',async()=>{
 const s=await scope(),api=provider(s),result=await activateAttendedChecklist(p,source,s,{...api.options,preflight_only:true,synthetic_fetch:async request=>{
  const response=await api.fetch(request);if(response.status!==404)return response;
  const workflow=request.url.endsWith('/workflows/'+p.target.workflow),worker=request.url.endsWith('/deployments');
  if(!workflow&&!worker)return response;
  return new Response(canonical({success:false,result:null,errors:[{code:worker?10007:10200,message:'Synthetic opaque missing-resource diagnostic',
   ...(worker?{documentation_url:'https://synthetic.invalid/not-fetched',source:{pointer:'/synthetic/not-read'}}:{})}],messages:[]}),{status:404});
 }});
 assert('preflight_verified' in result&&result.preflight_verified);assert.equal(result.activation_consumed,false);assert.equal(api.calls.length,6);
 assert(api.calls.every(c=>c.method==='GET'));assert.equal(api.state.size,0);assert.deepEqual(await readdir(s.evidence_directory),['bootstrap-reservations.jsonl']);
});

test('Full preflight refuses access/privilege/not-allowed denials at each coded resource before mutation or authorization consumption',async()=>{
 const denials=['You do not have access to this Workflow.','Insufficient privileges.','This operation is not allowed.',
  'Caller is not permitted to read this resource.','You cannot view this resource.'];
 for(const resource of ['workflow','app','archive'] as const)for(const message of denials){
  const s=await scope(),api=provider(s),endpoint=resource==='workflow'?'/workflows/'+p.target.workflow:
   '/workers/scripts/'+(resource==='app'?p.target.app_worker:p.target.workflow_worker)+'/deployments';
  const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   const response=await api.fetch(request);if(!request.url.endsWith(endpoint))return response;
   return new Response(canonical({success:false,result:null,errors:[{code:resource==='workflow'?10200:10007,message}],messages:[]}),{status:404});
  }});
  assert.equal(result.completed,false);assert.equal(result.activation_consumed,false);assert.equal(api.calls.length,resource==='workflow'?4:resource==='app'?5:6);
  assert(api.calls.every(c=>c.method==='GET'));assert.equal(api.posts(),0);assert.equal(api.state.size,0);
  assert.deepEqual(await readdir(s.evidence_directory),['bootstrap-reservations.jsonl']);
  const journal=await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8');
  assert(journal.includes('absence.error.authorization'));assert(journal.includes('authorization diagnostic'));assert(!journal.includes(message));
 }
});

test('Shared denial classification also blocks contradictory successful readiness-envelope messages before any mutation',async()=>{
 for(const stage of ['account-settings','namespace'] as const){
  const s=await scope(),api=provider(s),result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   const response=await api.fetch(request),selected=stage==='account-settings'?request.url.endsWith('/account-settings'):
    request.url.endsWith('/artifacts/namespaces/'+p.target.namespace);
   if(!selected)return response;const raw=JSON.parse(await response.text());
   return new Response(canonical({...raw,messages:[{code:0,message:'Insufficient privileges.'}]}));
  }});
  assert.equal(result.completed,false);assert.equal(result.activation_consumed,false);assert.equal(api.calls.length,stage==='account-settings'?1:2);
  assert(api.calls.every(c=>c.method==='GET'));assert.equal(api.posts(),0);assert.equal(api.state.size,0);
  assert.deepEqual(await readdir(s.evidence_directory),['bootstrap-reservations.jsonl']);
 }
});

test('Malformed preflight refuses at its exact stage with no consumption and no automatic 404 retry',async()=>{
 const s=await scope(),api=provider(s);const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
  await api.fetch(request);return request.url.endsWith('/repos/'+p.target.repository)?new Response(canonical({success:false,errors:[{code:10200,message:'Synthetic repository not found',source:{pointer:'/repo'}}],messages:[],result:null}),{status:404}):
   request.url.endsWith('/account-settings')?json({default_usage_model:'standard'}):json({namespace:p.target.namespace});
 }});
 assert.equal(result.completed,false);assert.equal(result.activation_consumed,false);assert.equal(api.calls.length,3);
 assert(api.calls.every(c=>c.method==='GET'));assert(!(await readdir(s.evidence_directory)).some(n=>n.endsWith('.activation-consumed.json')));
 const journal=await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8');assert(journal.includes('absence.error.fields'));assert(!journal.includes('/repo"'));
});

test('Transient preflight GETs reserve each attempt; malformed, denied and exhausted preflight stop before mutation',async()=>{
 for(const mode of ['once','exhausted','403','malformed','auth-after-four'] as const){
  const s=await scope(),api=provider(s);let tries=0;
  const result=await activateAttendedChecklist(p,source,s,{...api.options,preflight_only:true,synthetic_fetch:async request=>{
   const healthy=await api.fetch(request);if(!request.url.endsWith('/account-settings'))return healthy;tries++;
   if(mode==='once'&&tries>1)return healthy;
   if(mode==='malformed')return new Response('Synthetic invalid JSON',{status:503});
   const status=mode==='403'?403:503,errors=mode==='auth-after-four'?[...Array.from({length:4},()=>({code:10400,message:'Synthetic transient'})),{code:1000,message:'Synthetic permission denied'}]:[{code:10400,message:'Synthetic transient'}];
   return new Response(canonical({success:false,result:null,errors,messages:[]}),{status});
  }});
  assert.equal(tries,mode==='once'?2:mode==='exhausted'?3:1);assert(api.calls.every(c=>c.method==='GET'));assert.equal(result.activation_consumed,false);
  assert(!(await readdir(s.evidence_directory)).some(n=>n.endsWith('.activation-consumed.json')));
  assert.equal('preflight_verified' in result&&result.preflight_verified,mode==='once');
 }
});

test('Shared budget promotes only after full preflight; lost create is dispatched once and quarantines another same-target mutation',async()=>{
 const budgetFile=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-preflight-budget-')),'budget.json');
 const budget=await initializeChecklistSharedBudget(budgetFile,120,'b'.repeat(64),true,true);
 const old=await scope();old.shared_budget_file=budgetFile;const lost=provider(old,'lost-create');
 const failure=await activateAttendedChecklist(p,source,old,{...lost.options,shared_budget:budget});
 assert.equal(failure.activation_consumed,true);assert.equal(lost.posts(),1);const held=(await budget.snapshot()).leases[digest(old)];
 assert.equal(held.requests,lost.calls.length);assert.equal(held.held_gross_cents,100);assert.equal(held.quarantined,true);assert.equal(held.runtime_dispatched,false);
 const fresh=await scope();fresh.shared_budget_file=budgetFile;const collision=provider(fresh,'collision');
 const refused=await activateAttendedChecklist(p,source,fresh,{...collision.options,shared_budget:budget});
 assert.equal(refused.activation_consumed,false);assert(collision.calls.every(c=>c.method==='GET'));assert.equal((await budget.snapshot()).leases[digest(old)].quarantined,true);
 const next=await scope();next.shared_budget_file=budgetFile;const absent=provider(next);
 const accepted=await activateAttendedChecklist(p,source,next,{...absent.options,shared_budget:budget});
 assert.equal(accepted.prepared,false);assert.equal(accepted.activation_consumed,false);assert.equal((await budget.snapshot()).leases[digest(old)].quarantined,true);
 assert.equal(absent.calls.length,6);assert(absent.calls.every(c=>c.method==='GET'));assert.equal(absent.state.size,0);
 assert.equal((await budget.snapshot()).reserved_or_reconciled_gross_cents,222);
});

test('Transient reads across different preflight targets stop at nine physical exchanges before mutation',async()=>{
 const s=await scope(),api=provider(s),seen=new Set<string>();
 const result=await activateAttendedChecklist(p,source,s,{...api.options,preflight_only:true,synthetic_fetch:async request=>{
  const response=await api.fetch(request);if(seen.has(request.url))return response;seen.add(request.url);
  return new Response(canonical({success:false,errors:[{code:10400,message:'Synthetic transient'}],messages:[],result:null}),{status:503});
 }});
 assert.equal(api.calls.length,9);assert.equal(result.activation_consumed,false);assert.equal(result.completed,false);assert(api.calls.every(c=>c.method==='GET'));
 assert(!(await readdir(s.evidence_directory)).some(n=>n.endsWith('.activation-consumed.json')));
});

test('Complete synthetic run accounts bootstrap and attended exchanges in the same lease; wrong or exhausted common ledger makes zero requests',async()=>{
 const budgetFile=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-full-budget-')),'budget.json');
 const budget=await initializeChecklistSharedBudget(budgetFile,0,'b'.repeat(64),true,true);
 const s=await scope();s.shared_budget_file=budgetFile;const api=provider(s,'full-run');
 const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_bootstrap_only:false,shared_budget:budget});
 assert.equal(result.completed,true);const held=(await budget.snapshot()).leases[digest(s)];assert.equal(held.requests,api.calls.length);
 assert.equal(held.runtime_dispatched,true);assert.equal(held.quarantined,false);assert.equal(held.closed,true);assert(held.reserved_bytes<=67108864);
 const bad=await scope(),wrong=provider(bad);await assert.rejects(activateAttendedChecklist(p,source,bad,{...wrong.options,shared_budget:budget}));assert.equal(wrong.calls.length,0);
 const exhaustedFile=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-exhausted-budget-')),'budget.json');
 const exhausted=await initializeChecklistSharedBudget(exhaustedFile,2000,'b'.repeat(64),true,true),closed=await scope();closed.shared_budget_file=exhaustedFile;
 const none=provider(closed);await assert.rejects(activateAttendedChecklist(p,source,closed,{...none.options,shared_budget:exhausted}));assert.equal(none.calls.length,0);
});
test('Late changes to either approved bundle refuse before its version POST even when restored before final source verification',async()=>{
 for(const kind of ['app','workflow'] as const){
  const s=await scope(),api=provider(s),file=path.join(directory,kind+'-bundle.mjs'),original=await readFile(file);
  const changed=Buffer.from(original),space=original.indexOf(32);assert(space>=0);changed[space]=9;
  assert.equal(changed.length,original.length);assert.notEqual(bytesDigest(changed),bytesDigest(original),'Same-length synthetic mutation must exercise the hash check.');
  const target=ids[kind];let mutated=false,restored=false;
  try{
   const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
    const response=await api.fetch(request);
    if(request.url.endsWith('/account-settings')){await writeFile(file,changed);mutated=true;}
    if(request.method==='DELETE'){await writeFile(file,original);restored=true;}
    return response;
   }});
   assert.equal(mutated,true);assert.equal(restored,true);assert.equal(result.prepared,false);assert.equal(result.completed,false);
   assert.equal(api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/workers/'+target+'/versions?deploy=true')).length,0);
   assert.equal(api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/workers/'+ids.app+'/versions?deploy=true')).length,kind==='workflow'?1:0);
   assert.equal(api.state.size,0);assert((await readdir(s.evidence_directory)).some(name=>name.endsWith('.activation-consumed.json')));
   assert.equal((await verifyChecklistBundle(directory,repository,source,p)).source_sha256,source,'Restored disk passes source verification but cannot bless refused upload bytes.');
   const journal=await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8');
   assert(!journal.split('\n').filter(Boolean).map(line=>JSON.parse(line)).some(r=>r.method==='POST'&&r.url.endsWith('/workers/'+target+'/versions?deploy=true')));
   evidence.push({case:'late-'+kind+'-mutation-restore',approved_sha256:bytesDigest(original),changed_sha256:bytesDigest(changed),same_length:true,target_uploads:0,restored_source_verified:true,synthetic_only:true});
  }finally{await writeFile(file,original);}
 }
});
test('Both base64 uploads use the exact verified buffer despite a disk change after validation',async()=>{
 for(const kind of ['app','workflow'] as const){
  const s=await scope(),api=provider(s),file=path.join(directory,kind+'-bundle.mjs'),original=await readFile(file),target=ids[kind];
  const changed=Buffer.concat([original,Buffer.from('\n// Synthetic mutation after buffer verification.\n')]);
  let mutated=false,uploaded=false;
  try{
   const result=await activateAttendedChecklist(p,source,s,{...api.options,authorize_headers:()=>{
    const last=JSON.parse(readFileSync(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8').trim().split('\n').at(-1)!);
    if(last.method==='POST'&&last.url.endsWith('/workers/'+target+'/versions?deploy=true')){writeFileSync(file,changed);mutated=true;}
    return api.options.authorize_headers();
   },synthetic_fetch:async request=>{
    if(request.method==='POST'&&request.url.endsWith('/workers/'+target+'/versions?deploy=true')){
     assert.equal(mutated,true);
     const wire=JSON.parse(await request.clone().text());assert.equal(wire.modules[0].content_base64,Buffer.from(original).toString('base64'));assert.notEqual(wire.modules[0].content_base64,changed.toString('base64'));
     await writeFile(file,original);uploaded=true;
    }
    return api.fetch(request);
   }});
   assert.equal(result.prepared,true);assert.equal(mutated,true);assert.equal(uploaded,true);assert.equal(api.state.size,0);
   evidence.push({case:'same-'+kind+'-upload-buffer',approved_sha256:bytesDigest(original),uploaded_approved_bytes:true,synthetic_only:true});
  }finally{await writeFile(file,original);}
 }
});
test('Documented Worker DELETE acknowledgement and observed exact-ID absence verify cleanup while retaining the full cost hold',async()=>{
 const budgetFile=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-private-absence-budget-')),'budget.json');
 const budget=await initializeChecklistSharedBudget(budgetFile,0,'b'.repeat(64),true,true);
 const s=await scope();s.shared_budget_file=budgetFile;const api=provider(s,'upload-failure');
 const result=await activateAttendedChecklist(p,source,s,{...api.options,shared_budget:budget});
 assert.equal(result.completed,false);assert.equal(api.state.size,0);
 const deletion=api.calls.findIndex(c=>c.method==='DELETE');assert(deletion>=0);assert(api.calls[deletion].url.endsWith('/workers/'+ids.app));
 assert.equal(api.calls[deletion+1].method,'GET');assert.equal(api.calls[deletion+1].url,api.calls[deletion].url);
 const journal=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(journal.filter(r=>r.state==='verified-absent').length,1);assert.equal(journal.at(-1).partial_cleanup_calls,2);
 assert(!result.blockers.some(b=>b.startsWith('Partial setup cleanup unverified:')));
 const lease=(await budget.snapshot()).leases[digest(s)];assert.equal(lease.quarantined,false);assert.equal(lease.held_gross_cents,100);assert.equal(lease.actual_gross_cents,null);
 assert.equal(lease.closed,true);assert.equal(lease.requests,api.calls.length);
 evidence.push({case:'documented-delete-observed-private-absence',cleanup_calls:2,verified_absent:true,cost_hold_preserved:true,synthetic_only:true});
});
test('Retain policy survives setup failures without DELETE, preserves uncertainty and journals the exact version mismatch',async()=>{
 for(const stage of ['first-upload','second-version','workflow-definition','lost-create'] as const){
  const budgetFile=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-retain-failure-')),'budget.json');
  const budget=await initializeChecklistSharedBudget(budgetFile,0,'b'.repeat(64),true,true);
  const s=await scope();s.retention={repository:'retain',instance:'delete',workers:'retain'};s.shared_budget_file=budgetFile;
  const api=provider(s,stage==='first-upload'?'upload-failure':stage==='lost-create'?'lost-create':'healthy');
  const result=await activateAttendedChecklist(p,source,s,{...api.options,shared_budget:budget,synthetic_fetch:async request=>{
   const response=await api.fetch(request);
   if(stage==='second-version'&&request.method==='GET'&&request.url.includes('/workers/'+ids.workflow+'/versions/')){
    const raw=JSON.parse(await response.text());raw.result.bindings.find((b:{type:string})=>b.type==='service').environment='staging';return json(raw.result);
   }
   if(stage==='workflow-definition'&&request.url.endsWith('/workflows/'+p.target.workflow+'/versions?page=1&per_page=1')){
    const raw=JSON.parse(await response.text());raw.result[0].limits.steps=9;return json(raw.result);
   }
   return response;
  }});
  assert.equal(result.completed,false);assert.equal(result.activation_consumed,true);assert.equal(result.prepared,false);
  assert.equal(api.calls.filter(c=>c.method==='DELETE').length,0,'Retention forbids automatic deletion even after failed upload/readback.');
  assert.equal(api.calls.filter(c=>c.url.includes('/instances')).length,0);
  assert.equal(api.state.size,stage==='first-upload'||stage==='lost-create'?1:2);
  const journal=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const retained=journal.find(r=>r.state==='partial-setup-retained');assert(retained);
  assert.equal(retained.acknowledged_workflow,stage==='workflow-definition');
  assert.equal(retained.acknowledged_workers.length,stage==='lost-create'?0:stage==='first-upload'?1:2);
  assert.equal(journal.at(-1).partial_cleanup_calls,0);
  if(stage==='second-version'){
   assert.equal(result.work_calls,17);
   const failure=journal.find(r=>r.state==='worker-version-validator-refused');assert(failure);
   assert.equal(failure.kind,'workflow');assert.equal(failure.sequence,17);assert.equal(failure.worker_id,ids.workflow);assert.equal(failure.version_id,ids.workerVersion);
   assert.equal(failure.diagnostic.fields.find((f:{field:string})=>f.field==='bindings').status,'different');
   assert(failure.diagnostic.bindings.some((b:{public_defaults:{environment:string}})=>b.public_defaults.environment==='[redacted]'));
   assert.equal(journal.filter(r=>r.state==='verified-worker-version').length,1);
  }
  const lease=(await budget.snapshot()).leases[digest(s)];
  assert.equal(lease.closed,true);assert.equal(lease.quarantined,true);assert.equal(lease.held_gross_cents,100);assert.equal(lease.actual_gross_cents,null);assert.equal(lease.runtime_dispatched,false);
  assert.equal(lease.requests,api.calls.length);
  assert((await readdir(s.evidence_directory)).some(name=>name.endsWith('.activation-consumed.json')));
 }
});

test('Worker deletion refuses malformed/auth/errors/pagination/non-success acknowledgements and never infers absence from acknowledgement alone',async()=>{
 const valid={success:true,errors:[],messages:[]};
 const cases=[{name:'errors',body:{...valid,errors:[{code:1000,message:'Synthetic deletion failure'}]}},
  {name:'auth-message',body:{...valid,messages:[{code:1000,message:'Synthetic permission denied'}]}},
  {name:'malformed-message',body:{...valid,messages:['Synthetic malformed diagnostic']}},
  {name:'missing-messages',body:{success:true,errors:[]}},
  {name:'unsuccessful',body:{...valid,success:false}},
  {name:'cursor',body:{...valid,cursor:'Synthetic next'}},
  {name:'more-pages',body:{...valid,result_info:{count:1,total_count:2,per_page:1,page:1,total_pages:2}}},
  {name:'unexpected-result',body:{...valid,result:{deleted:true}}},
  {name:'http-denied',body:valid,status:403},
  {name:'absence-not-confirmed',body:valid,present:true}];
 for(const fixture of cases){
  const s=await scope(),api=provider(s,'upload-failure');let deleted=false;
  const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   if(request.method==='DELETE'&&request.url.endsWith('/workers/'+ids.app)){
    await api.fetch(request);deleted=true;return new Response(canonical(fixture.body),{status:fixture.status??200});
   }
   if(deleted&&fixture.present&&request.url.endsWith('/workers/'+ids.app)){
    await api.fetch(request);return json({deployments:[{id:'synthetic-retained',versions:[{version_id:ids.appVersion,percentage:100}]}]});
   }
   return api.fetch(request);
  }});
  assert.equal(result.completed,false);assert.equal(api.calls.filter(c=>c.method==='DELETE').length,1);
  const deletion=api.calls.findIndex(c=>c.method==='DELETE');assert.equal(api.calls.length-deletion-1,fixture.present?1:0,'No retry or unverified absence inference.');
  const journal=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert(!journal.some(r=>r.state==='verified-absent'));assert(result.blockers.some(b=>b.startsWith('Partial setup cleanup unverified:')));
  assert(journal.at(-1).partial_cleanup_calls<=8);evidence.push({case:'delete-refuses-'+fixture.name,verified_absent:false,synthetic_only:true});
 }
});
test('Unacknowledged create is never retried or destructively inferred from a name; exact possible remnant is retained',async()=>{
 const s=await scope(),api=provider(s,'lost-create');await activateAttendedChecklist(p,source,s,api.options);
 assert.equal(api.posts(),1);assert.equal(api.state.size,1);assert(!api.calls.some(c=>c.method==='DELETE'));
 const receipt=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).at(-1);
 assert(receipt.possible_targets.includes(p.target.app_worker));assert.equal(receipt.acknowledged_workers.length,0);
});
test('Malformed create IDs and wrong-name acknowledgements never establish owned Worker identity or dispatch another mutation',async()=>{
 for(const change of [{id:'a'.repeat(31)},{id:'a'.repeat(33)},{id:'g'.repeat(32)},{id:'11111111-1111-4111-8111-111111111111'},
  {id:ids.app+'?force=true'},{name:p.target.workflow_worker}]){
  const s=await scope(),api=provider(s);
  const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   const response=await api.fetch(request);if(request.method!=='POST')return response;
   const body=await response.json() as {result:Record<string,unknown>};return json({...body.result,...change});
  }});
  assert.equal(result.prepared,false);assert.equal(api.posts(),1);assert.equal(api.state.size,1);
  assert(!api.calls.some(c=>['PUT','DELETE'].includes(c.method)));
  const last=JSON.parse((await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').at(-1)!);
  assert.equal(last.acknowledged_workers.length,0);assert(last.possible_targets.includes(p.target.app_worker));
 }
});
test('Same-name wrong-ID private readback refuses upload; cleanup remains bound to the original acknowledged ID',async()=>{
 const s=await scope(),api=provider(s);let reads=0;
 const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
  const response=await api.fetch(request);
  if(request.method==='GET'&&request.url.endsWith('/workers/'+ids.app)&&++reads===1)
   return json({id:ids.workflow,name:p.target.app_worker,logpush:false,subdomain:{enabled:false,previews_enabled:false}});
  return response;
 }});
 assert.equal(result.prepared,false);assert.equal(api.posts(),1);assert(!api.calls.some(c=>c.method==='PUT'));
 assert.equal(api.calls.filter(c=>c.method==='DELETE').length,1);assert(api.calls.find(c=>c.method==='DELETE')!.url.endsWith('/workers/'+ids.app));
 assert(!result.blockers.some(b=>b.startsWith('Partial setup cleanup unverified:')));
 const journal=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert(journal.some(r=>r.state==='verified-absent'&&r.url.endsWith('/workers/'+ids.app)));
});
test('Worker correction does not admit 32-hex IDs as Workflow or definition UUIDs',async()=>{
 for(const endpoint of ['workflow','definition'] as const){
  const s=await scope(),api=provider(s);
  const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   const response=await api.fetch(request);if(request.method!=='GET'||response.status!==200)return response;
   if(endpoint==='workflow'&&request.url.endsWith('/workflows/'+p.target.workflow)){
    const body=await response.json() as {result:Record<string,unknown>};return json({...body.result,id:ids.app});
   }
   if(endpoint==='definition'&&request.url.endsWith('/versions?page=1&per_page=1')){
    const body=await response.json() as {result:Record<string,unknown>[]};return json([{...body.result[0],id:ids.app}]);
   }
   return response;
  }});
  assert.equal(result.prepared,false);assert(!(await readdir(s.evidence_directory)).includes('bound-grant.json'));
 }
});
test('Observed legacy settings disagreement permits a complete synthetic run and retains exact archive/Workers when selected',async()=>{
 const s=await scope();s.retention={repository:'retain',workers:'retain',instance:'delete'};
 const api=provider(s,'full-run');
 const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_bootstrap_only:false,synthetic_fetch:async request=>{
  const response=await api.fetch(request);
  if(request.method==='GET'&&request.url.endsWith('/settings')){
   const body=await response.json() as {result:Record<string,unknown>};return json({...body.result,usage_model:'bundled'});
  }
  return response;
 }});
 assert.equal(result.completed,true);assert.equal(api.state.size,2);
 const deletions=api.calls.filter(c=>c.method==='DELETE');assert.equal(deletions.length,1);assert(deletions[0].url.endsWith('/instances/'+p.target.instance_id));
 assert.equal(api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/instances')).length,1);
 const rows=(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const decisions=rows.filter(r=>r.state==='worker-model-policy');assert.equal(decisions.length,2);
 for(const decision of decisions){
  assert.equal(decision.decision,'legacy-settings-with-standard-version');assert.equal(decision.billing_state,'unresolved');
  const observations=rows.filter(r=>r.state==='worker-model-observation'&&r.worker_id===decision.worker_id);
  assert.deepEqual(observations.map(o=>o.model.public_enum),['standard','standard','bundled']);
  assert(observations.every(o=>o.version_id===decision.version_id));
  assert.deepEqual(decision.observation_sequences,observations.map(o=>o.sequence));
 }
 const resultFile=(await readdir(s.evidence_directory)).find(name=>name.endsWith('.result.json'))!;
 const saved=JSON.parse(await readFile(path.join(s.evidence_directory,resultFile),'utf8'));assert.equal(saved.result.cold_read_verified,true);
 assert.equal(saved.result.cleanup.repo_tokens_issued,saved.result.cleanup.repo_tokens_revoked);
 evidence.push({case:'legacy-settings-standard-version-retained-application',actual_provider_calls:0,synthetic_only:true,archive_cold_read:true,retained_workers:2});
});

test('Legacy settings exception requires explicit Standard on both version responses and refuses unknown settings',async()=>{
 const marker='private-provider-model';
 for(const [endpoint,value] of [
  ...['version-create','version-get'].flatMap(endpoint=>[undefined,null,'bundled','unbound',marker].map(value=>[endpoint,value])),
  ...[undefined,null,'unbound',marker].map(value=>['settings-get',value])]){
  const s=await scope(),api=provider(s);
  const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_fetch:async request=>{
   const response=await api.fetch(request);
   const at=request.method==='POST'&&request.url.endsWith('/versions?deploy=true')?'version-create':
    request.method==='GET'&&request.url.endsWith('?include=modules')?'version-get':
    request.method==='GET'&&request.url.endsWith('/settings')?'settings-get':null;
   if(!at)return response;
   const body=await response.json() as {result:Record<string,unknown>};
   if(at==='settings-get')body.result.usage_model='bundled';
   if(at===endpoint){if(value===undefined)delete body.result.usage_model;else body.result.usage_model=value;}
   return json(body.result);
  }});
  assert.equal(result.prepared,false);assert.equal(api.posts(),1);assert(result.activation_consumed);
  assert(!api.calls.some(c=>c.method==='PUT'||c.url.endsWith('/instances')));
  assert(!(await readdir(s.evidence_directory)).includes('bound-grant.json'));
  assert(!(await readFile(path.join(s.evidence_directory,'bootstrap-reservations.jsonl'),'utf8')).includes(marker));
 }
 const diagnostic=await scope('app-model-diagnostic');diagnostic.retention.workers='retain';const api=provider(diagnostic);
 await assert.rejects(activateAttendedChecklist(p,diagnostic.source_sha256,diagnostic,{...api.options,purpose:'app-model-diagnostic'}));
 assert.equal(api.calls.length,0);assert.equal(api.headers(),0);
});

test('Retained Workflow must keep its exact native identity; a different Workflow cannot substitute for it',async()=>{
 const s=await scope();s.retention={repository:'retain',workers:'retain',instance:'delete'};const api=provider(s,'full-run');let ran=false;
 const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_bootstrap_only:false,synthetic_fetch:async request=>{
  const response=await api.fetch(request);
  if(request.method==='POST'&&request.url.endsWith('/instances'))ran=true;
  if(ran&&request.method==='GET'&&request.url.endsWith('/workflows/'+p.target.workflow)){
   const body=await response.json() as {result:Record<string,unknown>};return json({...body.result,id:ids.definition});
  }
  return response;
 }});
 assert.equal(result.completed,false);assert(result.blockers.some(b=>b.includes('retention incomplete')));
 assert.equal(api.calls.filter(c=>c.method==='DELETE').length,1,'Retained resources are never deleted to repair an identity mismatch.');
});

test('Complete synthetic handoff consumes both ledgers, posts once, cold-reads all archive bytes and verifies exact cloud cleanup',async()=>{
 const s=await scope(),api=provider(s,'full-run');const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_bootstrap_only:false});
 assert.equal(result.completed,true);assert.equal(api.state.size,0);assert.equal(api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/instances')).length,1);
 assert('total_host_calls' in result);assert.equal(result.total_host_calls,api.calls.length);assert(api.calls.length<=57);
 const resultFile=(await readdir(s.evidence_directory)).find(name=>name.endsWith('.result.json'))!;
 const saved=JSON.parse(await readFile(path.join(s.evidence_directory,resultFile),'utf8'));assert.equal(saved.result.cold_read_verified,true);
 assert.equal(saved.result.cleanup.repo_tokens_issued,saved.result.cleanup.repo_tokens_revoked);assert.equal(saved.result.token_allowance_consumed,3);
 assert.deepEqual(saved.result.cumulative_reserved.workflow_subrequests,p.qualification.workflow_subrequests);
 evidence.push({case:'complete-synthetic-bootstrap-run-cleanup',provider_fixture_exchanges:api.calls.length,actual_provider_calls:0,synthetic_only:true});
});
test('Unsupported future instance encoding stops after one POST and keeps the consumed grant and uncertain cleanup evidence',async()=>{
 const s=await scope(),api=provider(s,'unsupported-create');const result=await activateAttendedChecklist(p,source,s,{...api.options,synthetic_bootstrap_only:false});
 assert.equal(result.completed,false);assert.equal(api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/instances')).length,1);
 assert(!api.calls.some(c=>c.method==='DELETE'),'No destructive inference after an unsupported/uncertain run.');
 assert((await readdir(s.evidence_directory)).some(name=>name.endsWith('.consumed.json')));
});
test('REST instance contract uses one JSON-encoded parameter string and exact native identity; documented status has versionId and no id',()=>{
 const s={workflow_id:ids.workflowId,workflow_definition_version_id:ids.definition};
 const g={format:'strata-checklist-cloud-run-grant/1',approved:true,approval_id:'synthetic-parity-only',preparation_sha256:digest(p),source_sha256:source,target_sha256:p.target_sha256,
  config_sha256:checklistConfigDigest(p,source),...s,workflow_version_id:ids.workerVersion,app_version_id:ids.appVersion,started_at:clock,expires_at:clock+60000,cleanup_expires_at:clock+180000,
  metered_charges_accepted:true,spending_limit_usd:1,retention:{repository:'delete',instance:'delete',workers:'delete'}} as ChecklistRunGrant;
 const payload={run_id:p.target.run_id,grant_sha256:digest(g),grant:g};
 const description=describeChecklistHttpRequest({action:'create-instance',target:p.target,payload,expected:s});
 assert.equal(typeof JSON.parse(description.body!).params,'string');assert.deepEqual(JSON.parse(JSON.parse(description.body!).params),payload);
 const r={success:true,errors:[],messages:[],result:{id:p.target.instance_id,status:'queued',workflow_id:ids.workflowId,version_id:ids.definition}};
 assert.equal((normalizeChecklistHttpResponse({action:'create-instance',target:p.target,payload,expected:s},200,r) as {id:string}).id,p.target.instance_id);
 assert.throws(()=>normalizeChecklistHttpResponse({action:'create-instance',target:p.target,payload,expected:s},200,{...r,result:{...r.result,version_id:ids.workerVersion}}));
 const status={success:true,errors:[],messages:[],result:{versionId:ids.definition,status:'running',steps:[]}};
 assert.deepEqual(normalizeChecklistHttpResponse({action:'status',target:p.target,expected:s},200,status),{id:p.target.instance_id,status:'running',steps:[]});
 assert.throws(()=>normalizeChecklistHttpResponse({action:'status',target:p.target,expected:s},200,{...status,result:{...status.result,versionId:ids.workerVersion}}));
 checklistNoPagination({result_info:{count:1,total_count:1,per_page:1,page:1,total_pages:1}});
 for(const i of [{count:1,total_count:2,per_page:1,page:1,total_pages:2},{count:1,total_count:1,per_page:1,cursor:'next'}])assert.throws(()=>checklistNoPagination({result_info:i}));
});
test('Multipart is bounded and preserves exact module bytes including Unicode; no keys or token bindings',()=>{
 const module=Buffer.from('export const text="synthetic \u{1f9ed}";\n'),metadata=checklistUploadMetadata(p,source,'app');
 const form=checklistMultipart(module,'app-bundle.mjs',metadata);assert(form.body.includes(module));assert(form.body.includes(Buffer.from(canonical(metadata))));
 assert(metadata.bindings.every(b=>['plain_text','version_metadata'].includes(b.type)));
 assert.throws(()=>checklistMultipart(module,'app-bundle.mjs',{oversized:'x'.repeat(65536)}));
});
after(async()=>{await mkdir('.strata',{recursive:true});await writeFile('.strata/checklist-bootstrap-qualification.json',canonical({format:'strata-checklist-bootstrap-qualification/1',
 synthetic_only:true,provider_account_calls:0,existing_credential_reads:0,real_grants_created:0,deployed:false,source_sha256:source,cases:evidence}));});
