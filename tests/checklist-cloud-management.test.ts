import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {canonical,digest,StrataError} from '../src/model.js';
import {checklistCloudFixture} from './checklist-cloud-fixture.js';
import {buildChecklistBundle,verifyChecklistBundle} from '../scripts/checklist-cloud-prepare.js';
import {checklistHttpPort,runAttendedChecklist,describeChecklistHttpRequest,normalizeChecklistHttpResponse} from '../scripts/checklist-cloud-run.js';
import {runChecklistCloudWorkflow,checklistAuthorizationDigest,CHECKLIST_STEPS,type ChecklistSteps,type ChecklistRunGrant} from '../src/checklist-cloud-workflow.js';
import {checklistAppWorker} from '../src/checklist-cloud-app-worker.js';
import {StrictArtifacts} from './artifacts-fixture.js';
import {checklistConfigDigest} from '../src/checklist-cloud-config.js';

const fixture=await checklistCloudFixture(),p=fixture.p,repository=process.cwd(),clock=Date.parse('2026-10-12T12:00:00Z');
const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-corrected-source-'));
const built=await buildChecklistBundle(p,directory,repository,true);
const g:ChecklistRunGrant={format:'strata-checklist-cloud-run-grant/1',approved:true,approval_id:'synthetic-corrections-only',preparation_sha256:digest(p),source_sha256:built.source.source_sha256,
  target_sha256:p.target_sha256,config_sha256:checklistConfigDigest(p,built.source.source_sha256),workflow_id:'synthetic-workflow-id',workflow_definition_version_id:'synthetic-definition-version',workflow_version_id:'synthetic-workflow-version',app_version_id:'synthetic-app-version',started_at:clock-1000,expires_at:clock+600000,cleanup_expires_at:clock+720000,
  metered_charges_accepted:true,spending_limit_usd:1,retention:{repository:'delete',instance:'delete',workers:'delete'}};
const runtime={source_sha256:g.source_sha256,grant_sha256:digest(g),authorization_sha256:checklistAuthorizationDigest(g),workflow_version_id:g.workflow_version_id,app_version_id:g.app_version_id};
const appConfig=JSON.parse(await readFile(path.join(directory,'wrangler.app.jsonc'),'utf8')),wfConfig=JSON.parse(await readFile(path.join(directory,'wrangler.workflow.jsonc'),'utf8'));
wfConfig.vars.CHECKLIST_AUTHORIZATION_SHA256=runtime.authorization_sha256;
const wfConfigFile=path.join(directory,'synthetic-activated.jsonc');await writeFile(wfConfigFile,canonical(wfConfig));
const steps=new Map<string,unknown>();
const step:ChecklistSteps={async do(name,config,callback){const output=await callback({step:{name,count:1},attempt:1,config});steps.set(name,output);return output;}};
const strict=new StrictArtifacts(),mod=await import('data:text/javascript;base64,'+Buffer.from(fixture.realization.files['collection.mjs']).toString('base64'));
const app=checklistAppWorker(mod.createCollection,p.pins);
await runChecklistCloudWorkflow(p,g,runtime,{instanceId:p.target.instance_id,payload:{run_id:p.target.run_id,grant_sha256:runtime.grant_sha256,grant:g}},step,{mode:'synthetic-test-only',now:()=>clock,provision:async()=>{},
  namespace:{get:async name=>{const handle=await strict.get(name);return{...handle,info:async()=>({remote:(await handle.info()).remote.replace('account.artifacts',p.target.account_id+'.artifacts')})};}},
  transport:request=>strict.transport(new Request(request.url.replace(p.target.account_id+'.artifacts','account.artifacts'),request)),
  app:{fetch:request=>app.fetch(request,{CHECKLIST_SOURCE_SHA256:runtime.source_sha256,CHECKLIST_TARGET_SHA256:p.target_sha256,CHECKLIST_VERSION:{id:g.app_version_id}})}});
const envelope=(result:unknown)=>new Response(canonical({success:true,errors:[],messages:[],result}),{headers:{'content-type':'application/json'}});
const missing=(code=10200)=>new Response(canonical({success:false,errors:[{code,message:'Synthetic exact resource not found'}],messages:[],result:null}),{status:404});
const status={versionId:g.workflow_definition_version_id,status:'complete',steps:CHECKLIST_STEPS.map(name=>({name:name+'-1',type:'step',success:true,attempts:[{success:true}]}))};
const evidence:unknown[]=[];
function port(response:(r:Request)=>Promise<Response>){return checklistHttpPort(p,runtime,{mode:'synthetic-test-only',repository,app_config:path.join(directory,'wrangler.app.jsonc'),workflow_config:wfConfigFile,
  app_config_sha256:digest(appConfig),workflow_config_sha256:digest(wfConfig),frozen_source:{directory,repository},authorize_headers:()=>({authorization:'Bearer synthetic-public-fixture'}),attended_terminal:()=>true,synthetic_fetch:response});}
let instanceDeleted=false;
async function healthy(r:Request){
  const url=new URL(r.url);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(r.redirect,'manual');
  if(r.method==='POST'){
    assert.deepEqual(JSON.parse(await r.text()),{instance_id:p.target.instance_id,params:canonical({run_id:p.target.run_id,grant_sha256:runtime.grant_sha256,grant:g})},'Documented REST contract uses a JSON-encoded event payload.');
    instanceDeleted=false;return envelope({id:p.target.instance_id,status:'queued',version_id:g.workflow_definition_version_id,workflow_id:g.workflow_id});
  }
  if(r.method==='GET'&&url.pathname.endsWith('/step'))return envelope({status:'complete',error:null,output:steps.get(url.searchParams.get('name')!.replace(/-1$/,''))});
  if(r.method==='GET'&&url.pathname.endsWith('/instances/'+p.target.instance_id))return instanceDeleted?missing(10400):envelope(status);
  if(r.method==='DELETE'&&url.pathname.endsWith('/instances/'+p.target.instance_id))instanceDeleted=true;
  if(r.method==='GET')return missing(url.pathname.includes('/workers/scripts/')?10007:10200);return envelope(null);
}

test('F1 exact endpoints reserve one HTTP exchange, no SDK/CLI pagination or retries',async()=>{
  let requests=0;const actual=port(async r=>{requests++;return healthy(r);});
  await assert.rejects(actual.call({action:'inspect-repository',target:p.target}));assert.equal(requests,0,'No consumed run/reservation means no HTTP.');
  const run=await runAttendedChecklist(p,g,runtime,actual,await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-http-run-')),()=>clock);
  assert.equal(run.completed,true);assert.equal(requests,run.calls);assert(requests<=33);
  const description=describeChecklistHttpRequest({action:'inspect-repository',target:p.target});
  assert.equal(new URL(description.url).pathname,`/client/v4/accounts/${p.target.account_id}/artifacts/namespaces/${p.target.namespace}/repos/${p.target.repository}`);
  assert.equal(description.pagination,'refuse');assert.equal(description.automatic_retries,0);assert.equal(description.provider_requests,1);
  evidence.push({case:'F1-single-exchange-reservations',requests,calls:run.calls,passed:true,synthetic_only:true});
});
test('F1 transport errors, 500, redirects and advertised 41 pages never cause a second exchange for the action',async()=>{
  for(const mode of ['throw','500','redirect','41-pages'] as const){
    let attempted=0,total=0;
    const actual=port(async r=>{total++;if(r.method==='POST'){attempted++;
      if(mode==='throw')throw new TypeError('Synthetic transport failure');
      if(mode==='500')return new Response('{}',{status:500});
      if(mode==='redirect')return new Response('{}',{status:302,headers:{location:'https://other.invalid'}});
      return new Response(canonical({success:true,errors:[],messages:[],result:{id:p.target.instance_id},result_info:{page:1,per_page:20,total_count:820}}));}
      return healthy(r);});
    const run=await runAttendedChecklist(p,g,runtime,actual,await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-http-refusal-')),()=>clock);
    assert.equal(run.completed,false);assert.equal(attempted,1);assert.equal(total,run.calls);assert(run.blockers.length>0);
    const printed=JSON.parse(canonical(run));assert.equal(printed.result,null);assert.deepEqual(printed.blockers,run.blockers);
  }
  evidence.push({case:'F1-pagination-retry-redirect-refusal',passed:true,synthetic_only:true});
});

test('Injected transport exception text and arbitrary diagnostics never enter retained receipts',async()=>{
 const secret='synthetic-exception-DO-NOT-RETAIN',ledger=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-exception-ledger-'));
 const actual=port(async request=>{if(request.method==='POST')throw new StrataError('synthetic',7,secret,{diagnostic:{headers:{authorization:secret},message:secret},checklist_stage:secret});return healthy(request);});
 const run=await runAttendedChecklist(p,g,runtime,actual,ledger,()=>clock);assert.equal(run.completed,false);
 const progress=await readFile(run.consumed_ledger+'.progress.json','utf8');assert(!progress.includes(secret));assert(progress.includes('http.transport'));
});

test('Failed Workflow startup remains serializable, retains resources and records only public status',async()=>{
 const secret='synthetic-startup-extra-DO-NOT-RETAIN',actions:string[]=[];
 const ledger=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-startup-failure-'));
 const actual={mode:'synthetic-test-only' as const,tools:{wrangler:'4.147.0' as const,cf:'1.0.0-beta.12' as const},
  wait:async()=>{},async call(request:{action:string}){
   actions.push(request.action);
   if(request.action==='create-instance')return{id:p.target.instance_id};
   if(request.action==='status')return{id:p.target.instance_id,status:'errored',steps:[],error:{message:secret},output:secret};
   throw Error('No cleanup or repeat mutation is allowed for unverified startup.');
  }};
 const run=await runAttendedChecklist(p,g,runtime,actual,ledger,()=>clock);
 const printed=JSON.parse(canonical(run));assert.equal(printed.completed,false);assert.equal(printed.result,null);
 assert.equal(printed.blockers.length,2);assert.equal(printed.cleanup_calls,0);
 assert.deepEqual(actions,['create-instance','status']);
 const bytes=await readFile(run.consumed_ledger+'.progress.json','utf8'),progress=JSON.parse(bytes);
 assert.equal(progress.terminal,true);assert.equal(progress.result_sha256,null);
 assert.deepEqual(progress.latest_status,{id:p.target.instance_id,status:'errored',steps:[]});
 assert(!bytes.includes(secret));assert(!canonical(run).includes(secret));
 await assert.rejects(runAttendedChecklist(p,g,runtime,actual,ledger,()=>clock),{code:'EEXIST'});
 assert.deepEqual(actions,['create-instance','status'],'Consumed grant must not dispatch again.');
});
test('F2 malformed/empty lists never prove repository or Workflow absence, and cleanup stays blocked',async()=>{
  for(const action of ['inspect-repository','inspect-workflow'] as const){
    for(const result of [[{unexpected:'missing resource name'}],[],[{name:p.target.repository}],{name:42},null])
      assert.throws(()=>normalizeChecklistHttpResponse({action,target:p.target},200,{success:true,errors:[],messages:[],result}));
    assert.throws(()=>normalizeChecklistHttpResponse({action,target:p.target},404,{success:false,errors:[],messages:[],result:null}));
    assert.throws(()=>normalizeChecklistHttpResponse({action,target:p.target},404,{success:false,errors:[{code:10000,message:'Authentication not found'}],messages:[],result:null}));
    const endpoint=describeChecklistHttpRequest({action,target:p.target}).url;
    const actual=port(async r=>r.url===endpoint?envelope([{unexpected:'missing resource name'}]):healthy(r));
    const run=await runAttendedChecklist(p,g,runtime,actual,await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-malformed-cleanup-')),()=>clock);
    assert.equal(run.completed,false);assert(run.blockers.some(b=>b.includes('Cleanup')));
  }
  evidence.push({case:'F2-malformed-absence-cleanup-refusal',passed:true,synthetic_only:true});
});

test('Instance absence requires exact 10400 response and refuses denial or ambiguous envelopes',()=>{
 const request={action:'inspect-instance' as const,target:p.target};
 const raw={success:false,errors:[{code:10400,message:'workflows.api.error.instance.not_found'}],messages:[],result:null};
 assert.deepEqual(normalizeChecklistHttpResponse(request,404,raw),{absent:true,id:p.target.instance_id});
 for(const bad of [
  {...raw,errors:[]},{...raw,success:true},{...raw,result:{}},{...raw,messages:[{code:10000,message:'Denied'}]},
  ...[10000,10007,10200,'10400'].map(code=>({...raw,errors:[{...raw.errors[0],code}]})),
  {...raw,errors:[{code:10400,message:'Authentication not found; permission denied'}]},
  {...raw,errors:[{code:10400,message:'Unknown failure'}]},
  {...raw,errors:[{...raw.errors[0],extra:true}]}
 ])assert.throws(()=>normalizeChecklistHttpResponse(request,404,bad));
 assert.throws(()=>normalizeChecklistHttpResponse(request,200,raw));
});

test('Delayed instance deletion polls only bounded GETs and never repeats the deletion',async()=>{
 for(const mode of ['eventual','still-present','denied'] as const){
  let deletionCalls=0,absenceReads=0,waits=0;
  const endpoint=describeChecklistHttpRequest({action:'inspect-instance',target:p.target}).url;
  const actual=port(async r=>{
   if(r.url===endpoint&&r.method==='DELETE')deletionCalls++;
   if(r.url===endpoint&&r.method==='GET'&&deletionCalls){
    absenceReads++;
    if(mode==='denied')return missing(10000);
    if(mode==='still-present'||absenceReads===1)return envelope(status);
    return new Response(canonical({success:false,errors:[{code:10400,message:'workflows.api.error.instance.not_found'}],messages:[],result:null}),{status:404});
   }
   return healthy(r);
  });
  actual.wait=async ms=>{assert(ms>0&&ms<=30000);waits++;};
  const run=await runAttendedChecklist(p,g,runtime,actual,await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-instance-delete-')),()=>clock);
  assert.equal(deletionCalls,1);assert.equal(run.completed,mode==='eventual');
  assert.equal(absenceReads,mode==='eventual'?2:mode==='still-present'?3:1);
  assert.equal(waits,mode==='eventual'?1:mode==='still-present'?2:0);
  assert(run.cleanup_calls<=12);assert(run.calls<=33);assert(run.result);
 }
});
test('Post-delete transient retries and delayed visibility share three physical instance GETs',async()=>{
 for(const responses of [[503,'complete','absent'],[503,'complete',503,'absent'],[503,503,'complete','absent']] as const){
  let deletionCalls=0,absenceReads=0,requests=0,time=clock;
  const waits:number[]=[],endpoint=describeChecklistHttpRequest({action:'inspect-instance',target:p.target}).url;
  const actual=port(async request=>{
   requests++;
   if(request.url===endpoint&&request.method==='DELETE')deletionCalls++;
   if(request.url===endpoint&&request.method==='GET'&&deletionCalls){
    const response=responses[absenceReads++];
    if(response===503)return new Response(canonical({success:false,errors:[],messages:[],result:null}),{status:503});
    if(response==='complete')return envelope(status);
    assert.equal(response,'absent','No reads beyond the synthetic visibility sequence.');
    return missing(10400);
   }
   return healthy(request);
  });
  actual.wait=async ms=>{waits.push(ms);time+=ms;};
  const run=await runAttendedChecklist(p,g,runtime,actual,await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-instance-read-cap-')),()=>time);
  const resolved=responses.length===3;
  assert.equal(absenceReads,3,'Transient attempts and later polls spend the same physical-read allowance.');
  assert.equal(deletionCalls,1,'DELETE is never replayed.');
  assert.equal(run.completed,resolved);assert(run.result,'Verified execution evidence survives unresolved cleanup.');
  assert.deepEqual(waits,resolved?[250,30000]:responses[1]==='complete'?[250,30000]:[250,1000]);
  assert.equal(run.cleanup_calls,resolved?12:4);assert.equal(requests,run.calls);assert(run.calls<=33);
  assert(time<g.cleanup_expires_at);
  if(!resolved)assert(run.blockers.some(blocker=>blocker.includes('Cleanup or retention incomplete')));
  const progress=JSON.parse(await readFile(run.consumed_ledger+'.progress.json','utf8'));
  const reservations=progress.receipts.filter((receipt:{action:string;state:string})=>receipt.action==='inspect-instance'&&receipt.state==='reserved-before-dispatch');
  assert.equal(reservations.length,3);assert.equal(progress.unsettled_dispatches,0);
  const failedReads=progress.receipts.filter((receipt:{action:string;state:string})=>receipt.action==='inspect-instance'&&receipt.state==='read-failed');
  if(responses[2]===503)assert.equal(failedReads.at(-1).retry_admitted,false,'Exhausting the shared allowance cannot admit another retry.');
 }
});
test('REST create uses the documented JSON-encoded payload and one exact instance',async()=>{
  const payload={run_id:p.target.run_id,grant_sha256:runtime.grant_sha256,grant:g};
  const described=describeChecklistHttpRequest({action:'create-instance',target:p.target,payload});
  assert.deepEqual(JSON.parse(described.body!),{instance_id:p.target.instance_id,params:canonical(payload)});
  assert.throws(()=>describeChecklistHttpRequest({action:'create-instance',target:p.target,payload:canonical(payload)}));
  const cli=await readFile(path.join(repository,'node_modules/wrangler/wrangler-dist/cli.js'),'utf8');
  assert(cli.includes('instance_id: args.id'));assert(cli.includes('params: parsedParams'));
  evidence.push({case:'R1-pinned-create-structured-payload',passed:true,synthetic_only:true});
});
test('R2 malformed, unknown or authentication-bearing failed envelope messages retain cleanup blockers',async()=>{
  const negatives=[undefined,42,null,{},[{code:10000,message:'Authentication failed; permission denied'}],['Synthetic unknown diagnostic']];
  for(const messages of negatives){
    const raw={success:false,errors:[{code:10200,message:'Synthetic exact resource not found'}],messages,result:null};
    for(const action of ['inspect-repository','inspect-workflow','inspect-app-worker'] as const)assert.throws(()=>normalizeChecklistHttpResponse({action,target:p.target},404,
      {...raw,errors:[{...raw.errors[0],code:action==='inspect-app-worker'?10007:10200}]}));
    const endpoint=describeChecklistHttpRequest({action:'inspect-repository',target:p.target}).url;
    const actual=port(async r=>r.url===endpoint?new Response(canonical(raw),{status:404}):healthy(r));
    const run=await runAttendedChecklist(p,g,runtime,actual,await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-404-cleanup-')),()=>clock);
    assert.equal(run.completed,false);assert(run.blockers.some(b=>b.includes('Cleanup')));
  }
  assert.throws(()=>normalizeChecklistHttpResponse({action:'inspect-repository',target:p.target},404,{success:false,errors:[{code:10200,message:'Synthetic exact resource not found',unknown:'diagnostic'}],messages:[],result:null}));
  assert.throws(()=>normalizeChecklistHttpResponse({action:'inspect-repository',target:p.target},404,{success:false,errors:[{code:10200,message:'Synthetic exact resource not found'}],messages:[],result:null,unknown:'diagnostic'}));
  evidence.push({case:'R2-complete-failed-envelope-cleanup-refusal',passed:true,synthetic_only:true});
});
test('R3 native HTTPS callback failures settle the awaited promise, dispose the response and never redispatch',async()=>{
  const compiled=await readFile(path.join(repository,'dist/scripts/checklist-cloud-http.js'),'utf8');
  const script=compiled.replace(/^import .*;\r?\n/gm,'').replace('export async function checklistNativeHttpOnce','async function checklistNativeHttpOnce')+'\nthis.http=checklistNativeHttpOnce;';
  for(const mode of [204,205,304,99,'headers','stream'] as const){
    let requests=0,destroyed=0,outside:unknown;
    const response={statusCode:typeof mode==='number'?mode:200,statusMessage:'Synthetic',headers:mode==='headers'?{'bad\nheader':'value'}:{},destroy(){destroyed++;}};
    const sandbox={URL,Headers,Response,process:{env:{}},Readable:{toWeb(){throw new TypeError('Synthetic stream conversion failure');}},fail(){throw new Error('Synthetic endpoint refusal');},
      httpsRequest(_url:unknown,options:{rejectUnauthorized:boolean;agent:boolean},callback:(r:typeof response)=>void){assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);requests++;queueMicrotask(()=>{try{callback(response);}catch(e){outside=e;}});return{once(){return this;},end(){}};},http:undefined as unknown};
    runInNewContext(script,sandbox);
    const http=sandbox.http as (input:Request)=>Promise<Response>;
    await assert.rejects(http(new Request('https://api.cloudflare.com/client/v4/accounts/'+p.target.account_id+'/workflows/synthetic',{redirect:'manual'})));
    assert.equal(outside,undefined);assert.equal(requests,1);assert.equal(destroyed,1);
  }
  evidence.push({case:'R3-native-callback-promise-refusal',passed:true,synthetic_only:true});
});
test('F3 complete host graphs and CLI/dependency bytes are frozen; private inert tampering rejects late verification',async()=>{
  const required=['src/node-state.ts','dist/src/node-state.js','node_modules/wrangler/bin/wrangler.js','node_modules/wrangler/wrangler-dist/cli.js','node_modules/cf/bin/cf','node_modules/cf/dist/index.mjs','node_modules/@babel/parser/lib/index.js'];
  for(const file of required)assert(built.source.inputs.some(e=>e.path===file),file+' must be frozen');
  assert(built.source.inputs.some(e=>e.path.startsWith('node_modules/cf/dist/')&&e.path.includes('workflows-')),'Dynamic CLI chunks are frozen too.');
  const mirror=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-code-pin-mirror-'));
  const changed=structuredClone(built.source),copies=new Map<string,string>();
  for(const entry of changed.inputs)if(required.includes(entry.path)){
    const output=path.join(mirror,entry.path);await mkdir(path.dirname(output),{recursive:true});await copyFile(path.resolve(repository,entry.path),output);
    copies.set(entry.path,output);entry.path=path.relative(repository,output).replaceAll('\\','/');
  }
  for(const entry of changed.outputs)await copyFile(path.join(directory,entry.path),path.join(mirror,entry.path));
  const {source_sha256,...body}=changed;changed.source_sha256=digest(body);await writeFile(path.join(mirror,'source-manifest.json'),canonical(changed));
  await verifyChecklistBundle(mirror,repository,changed.source_sha256,p);
  for(const [name,file]of copies){const bytes=await readFile(file);try{await writeFile(file,new Uint8Array([...bytes,10]));await assert.rejects(verifyChecklistBundle(mirror,repository,changed.source_sha256,p),name);}finally{await writeFile(file,bytes);}}
  evidence.push({case:'F3-complete-source-late-tamper-refusal',required,frozen_inputs:built.source.inputs.length,passed:true,synthetic_only:true});
});
test('endpoint/query shapes agree with the pinned installed tool source without executing it',async()=>{
  const wrangler=await readFile(path.join(repository,'node_modules/wrangler/wrangler-dist/cli.js'),'utf8');
  assert(wrangler.includes('async function getRepo('));assert(wrangler.includes('getArtifactsRepoPath(accountId, namespace, name2)'));
  const inputs=built.source.inputs.filter(e=>e.path.startsWith('node_modules/cf/dist/workflows-')&&e.path.endsWith('.mjs'));
  assert(inputs.length>0);const cf=await readFile(path.resolve(repository,inputs[0].path),'utf8');assert(cf.includes('/step'));assert(cf.includes('query:a'));assert(cf.includes('attempt:t.attempt'));
  const d=describeChecklistHttpRequest({action:'full-step',target:p.target,step:'cold-read',attempt:1});
  assert.equal(new URL(d.url).search,'?name=cold-read-1&type=step&attempt=1');
});
after(async()=>{await mkdir('.strata',{recursive:true});await writeFile('.strata/checklist-cloud-corrections.json',canonical({format:'strata-checklist-cloud-correction-qualification/1',synthetic_only:true,live_provider_calls:0,existing_credential_reads:0,source_sha256:built.source.source_sha256,package_directory:directory,cases:evidence}));});
