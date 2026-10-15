import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import { canonical, digest, bytesDigest } from '../src/model.js';
import { prepareChecklist, verifyPrepared, verifyChecklistHandoff, CHECKLIST_CEILINGS } from '../src/checklist-cloud-contract.js';
import { checklistAppWorker, checklistSequence, verifyChecklistObservation } from '../src/checklist-cloud-app-worker.js';
import { runChecklistCloudWorkflow, checklistWorkflowEvent, CHECKLIST_STEPS, checklistAuthorizationDigest, type ChecklistSteps, type ChecklistStepContext, type ChecklistWorkflowPorts, type ChecklistRunGrant } from '../src/checklist-cloud-workflow.js';
import { runAttendedChecklist, verifyChecklistCloudResult, describeChecklistHttpRequest, normalizeChecklistHttpResponse, type ChecklistManagementPort } from '../scripts/checklist-cloud-run.js';
import { buildChecklistBundle, consumeChecklistSnapshot, verifyChecklistBundle } from '../scripts/checklist-cloud-prepare.js';
import {checklistConfigDigest} from '../src/checklist-cloud-config.js';
import { checklistCloudFixture, writeSyntheticProducer } from './checklist-cloud-fixture.js';
import { StrictArtifacts } from './artifacts-fixture.js';

const fixture = await checklistCloudFixture();
const { p, input, realization } = fixture;
const evidence: unknown[] = [];
const source = 'b'.repeat(64), now = Date.parse('2026-10-12T12:00:00Z');
const qualificationDate=process.env.STRATA_CHECKLIST_QUALIFICATION_DATE??'2026-10-08';
assert(['2026-10-08','2026-10-12'].includes(qualificationDate),'Only the explicit supplemental or required matching date is supported; no fallback.');
function runtimeGrant() {
  const g: ChecklistRunGrant = { format:'strata-checklist-cloud-run-grant/1',approved:true,approval_id:'synthetic-test-only',preparation_sha256:digest(p),source_sha256:source,
    target_sha256:p.target_sha256,config_sha256:checklistConfigDigest(p,source),workflow_id:'synthetic-workflow-id',workflow_definition_version_id:'synthetic-definition-version',workflow_version_id:'synthetic-workflow-version',app_version_id:'synthetic-app-version',started_at:now-1000,
    expires_at:now+600000,cleanup_expires_at:now+720000,metered_charges_accepted:true,spending_limit_usd:1,retention:{repository:'delete',instance:'delete',workers:'delete'} };
  return { g, runtime:{source_sha256:source,grant_sha256:digest(g),authorization_sha256:checklistAuthorizationDigest(g),workflow_version_id:g.workflow_version_id,app_version_id:g.app_version_id} };
}
class Steps implements ChecklistSteps {
  outputs = new Map<string,unknown>(); calls: string[]=[];
  attempts=new Map<string,number>();
  async do<T>(name: typeof CHECKLIST_STEPS[number], options: { retries:{limit:0;delay:number};timeout:string }, callback:(ctx:ChecklistStepContext)=>Promise<T>):Promise<T>{
    assert.equal(options.retries.limit,0); if(this.outputs.has(name))return structuredClone(this.outputs.get(name)) as T;
    const attempt=(this.attempts.get(name)??0)+1;this.attempts.set(name,attempt);
    this.calls.push(name); const value=await callback({step:{name,count:1},attempt,config:options}); this.outputs.set(name,structuredClone(value));return value;
  }
}
async function setup() {
  const f = new StrictArtifacts(), {g,runtime}=runtimeGrant();
  const mod = await import('data:text/javascript;base64,'+Buffer.from(realization.files['collection.mjs']).toString('base64'));
  const app = checklistAppWorker(mod.createCollection,p.pins);
  const ports:ChecklistWorkflowPorts={mode:'synthetic-test-only',now:()=>now,provision:async()=>{},namespace:{get:async name=>{
    const handle=await f.get(name);return {...handle,info:async()=>({remote:(await handle.info()).remote.replace('account.artifacts',p.target.account_id+'.artifacts')})};
  }},transport:request=>f.transport(new Request(request.url.replace(p.target.account_id+'.artifacts','account.artifacts'),request)),
    app:{fetch:request=>app.fetch(request,{CHECKLIST_SOURCE_SHA256:source,CHECKLIST_TARGET_SHA256:p.target_sha256,CHECKLIST_VERSION:{id:g.app_version_id}})}};
  return {f,g,runtime,ports,step:new Steps(),event:{instanceId:p.target.instance_id,payload:{run_id:p.target.run_id,grant_sha256:runtime.grant_sha256,grant:g}}};
}

test('synthetic history fits the unchanged finite archive envelope; default refuses synthetic',()=>{
  assert.throws(()=>verifyChecklistHandoff(input));assert.equal(p.live_authorized,false);verifyPrepared(p,true);
  assert(p.qualification.records<=80);assert.equal(p.qualification.stage_batches,2);assert.equal(p.qualification.token_issuances,3);
  evidence.push({case:'synthetic-preparation',qualification:p.qualification,input_sha256:p.input_sha256,release_ref:p.pins.release_ref,synthetic_only:true});
});
test('exact producer layout is consumed without credentials/private drafts or producer mutation',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-checklist-producer-'));
  const {pins,snapshot}=await writeSyntheticProducer(fixture,directory);
  const original=await readFile(path.join(directory,'.strata/state/registry.json'));
  const loaded=await consumeChecklistSnapshot(snapshot,pins,true);assert.equal(loaded.release_ref,input.release_ref);assert.deepEqual(loaded.records,input.records);
  assert.deepEqual(await readFile(path.join(directory,'.strata/state/registry.json')),original);
  await assert.rejects(consumeChecklistSnapshot(snapshot,{...pins,lane_id:'0'.repeat(64)},true));
  await writeFile(path.join(directory,'.strata/state/.node-state.lock'),'synthetic');await assert.rejects(consumeChecklistSnapshot(snapshot,pins,true));
});
test('module/Release/source/target/input and closure tamper refuse before dispatch',async()=>{
  for(const key of ['module_sha256','output_tree','release_ref','realization_ref'] as const){const changed=structuredClone(input);changed[key]=key.endsWith('ref')?'missing@1':'0'.repeat(64);assert.throws(()=>prepareChecklist(changed,p.target,digest(changed),true));}
  const different=structuredClone(p);different.target.repository='wrong';assert.throws(()=>verifyPrepared(different,true));
  assert.throws(()=>prepareChecklist(input,p.target,'0'.repeat(64),true));
  for(const type of ['auth-receipt','criterion-review','authoring-review','approval','host-run'] ){
    const changed=structuredClone(input),ref=Object.keys(changed.records).find(ref=>changed.records[ref].type===type)!;delete changed.records[ref];delete changed.record_hashes[ref];assert.throws(()=>verifyChecklistHandoff(changed,true));
  }
  const losing=structuredClone(input);delete losing.records['SyntheticFour@1'];delete losing.record_hashes['SyntheticFour@1'];assert.throws(()=>verifyChecklistHandoff(losing,true));
  const s=await setup();await assert.rejects(runChecklistCloudWorkflow(p,null,s.runtime,s.event,s.step,s.ports));assert.deepEqual(s.f.calls,[]);
  for(const field of ['source_sha256','grant_sha256','authorization_sha256','workflow_version_id','app_version_id'] as const){const s=await setup();await assert.rejects(runChecklistCloudWorkflow(p,s.g,{...s.runtime,[field]:'wrong'},s.event,s.step,s.ports));assert.deepEqual(s.f.calls,[]);}
});
test('strict smart-HTTP fixture archives exact history and index, cold reads every byte, executes exact module, and disposes/revokes',async()=>{
  const s=await setup(),r=await runChecklistCloudWorkflow(p,s.g,s.runtime,s.event,s.step,s.ports);
  verifyChecklistCloudResult(r,p,s.runtime,true);assert.equal(s.f.pushes,2);assert.equal(s.f.revoked,2);assert.equal(s.f.openHandles,0);assert.equal(r.evidence_kind,'synthetic-test-only');
  assert.deepEqual(s.step.calls,[...CHECKLIST_STEPS]);assert(!canonical(r).includes('mock-only-token'));
  const before=s.f.calls.length;
  const repeated=await runChecklistCloudWorkflow(p,s.g,s.runtime,s.event,s.step,s.ports);assert.deepEqual(repeated,r);assert.equal(s.f.calls.length,before,'Completed durable steps never replenish or re-dispatch.');
  evidence.push({case:'strict-synthetic-archive-runtime',result:r,cleanup:s.f.openHandles,synthetic_only:true,native_repository_create_tested:false});
});

test('Workflow ingress decodes REST text once without changing authority or accepting malformed payloads',async()=>{
  const s=await setup(),text=canonical(s.event.payload);
  assert.deepEqual(checklistWorkflowEvent({...s.event,payload:text}),s.event);
  assert.deepEqual(checklistWorkflowEvent(s.event),s.event);
  for(const payload of ['{',canonical(text),'null','[]','1',null,{}, {...s.event.payload,extra:true},' '.repeat(CHECKLIST_CEILINGS.request_bytes)+text])
    assert.throws(()=>checklistWorkflowEvent({...s.event,payload}));
  for(const changed of [
    {...s.event.payload,run_id:'other'},
    {...s.event.payload,grant_sha256:'0'.repeat(64)},
    {...s.event.payload,grant:{...s.g,source_sha256:'0'.repeat(64)}},
    {...s.event.payload,grant:{...s.g,expires_at:now-1}}
  ]){
    const event=checklistWorkflowEvent({...s.event,payload:canonical(changed)});
    await assert.rejects(runChecklistCloudWorkflow(p,event.payload.grant,s.runtime,event,s.step,s.ports));
    assert.deepEqual(s.step.calls,[]);assert.deepEqual(s.f.calls,[]);
  }
  const event=checklistWorkflowEvent({...s.event,payload:text});
  verifyChecklistCloudResult(await runChecklistCloudWorkflow(p,event.payload.grant,s.runtime,event,s.step,s.ports),p,s.runtime,true);
  assert.deepEqual(s.step.calls,[...CHECKLIST_STEPS]);
});
test('missing/corrupt remote reads, lost write response and token cleanup failure yield no success or automatic retry',async()=>{
  for(const kind of ['corruptRead','missingRead','loseResponse','cleanupFailure'] as const){const s=await setup();s.f[kind]=true;await assert.rejects(runChecklistCloudWorkflow(p,s.g,s.runtime,s.event,s.step,s.ports));assert(s.f.pushes<=1);assert(!s.step.outputs.has('observe-app'));}
  const s=await setup();const callback=s.step.do.bind(s.step);s.step.do=async(name,config,fn)=>{if(name==='cold-read')s.f.missingRead=true;return callback(name,config,fn);};
  await assert.rejects(runChecklistCloudWorkflow(p,s.g,s.runtime,s.event,s.step,s.ports));assert.equal(s.f.pushes,2);assert.equal(s.f.openHandles,0);
  const replay=await setup();replay.f.loseResponse=true;await assert.rejects(runChecklistCloudWorkflow(p,replay.g,replay.runtime,replay.event,replay.step,replay.ports));
  const before=replay.f.calls.length;await assert.rejects(runChecklistCloudWorkflow(p,replay.g,replay.runtime,replay.event,replay.step,replay.ports));assert.equal(replay.f.calls.length,before,'Failed durable attempt cannot issue new tokens or retry a lost write.');
});
test('attended synthetic runner consumes before dispatch, reads full first-attempt steps and verifies exact cleanup; duplicates refused',async()=>{
  const s=await setup(),result=await runChecklistCloudWorkflow(p,s.g,s.runtime,s.event,s.step,s.ports),calls:string[]=[];
  const port:ChecklistManagementPort={mode:'synthetic-test-only',tools:{wrangler:'4.147.0',cf:'1.0.0-beta.12'},wait:async()=>{},call:async request=>{
    calls.push(request.action);assert.deepEqual(request.target,p.target);
    if(request.action==='create-instance')return{id:p.target.instance_id};
    if(request.action==='status')return{id:p.target.instance_id,status:'complete',steps:CHECKLIST_STEPS.map(name=>({name,attempt:1,status:'complete'}))};
    if(request.action==='full-step')return{status:'complete',error:null,output:s.step.outputs.get(request.step!)};
    if(request.action==='inspect-instance')return{absent:true,id:p.target.instance_id};
    const names={'inspect-repository':p.target.repository,'inspect-workflow':p.target.workflow,'inspect-app-worker':p.target.app_worker,'inspect-workflow-worker':p.target.workflow_worker};
    if(request.action in names)return{absent:true,name:names[request.action as keyof typeof names]};return{ok:true};
  }};
  const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-attended-'));
  const out=await runAttendedChecklist(p,s.g,s.runtime,port,directory,()=>now);assert.equal(out.completed,true);assert.deepEqual(out.result,result);assert(out.calls<=33);
  const before=calls.length;await assert.rejects(runAttendedChecklist(p,s.g,s.runtime,port,directory,()=>now));assert.equal(calls.length,before);
  const versionChanged={...s.g,workflow_version_id:'changed-synthetic-version'},runtimeChanged={...s.runtime,workflow_version_id:versionChanged.workflow_version_id,grant_sha256:digest(versionChanged)};
  await assert.rejects(runAttendedChecklist(p,versionChanged,runtimeChanged,port,directory,()=>now));assert.equal(calls.length,before,'Changing assigned version IDs cannot replenish the consumed authorization.');
  const failing={...port,call:async(request:Parameters<ChecklistManagementPort['call']>[0])=>request.action==='inspect-repository'?{absent:false}:port.call(request)};
  const failure=await runAttendedChecklist(p,s.g,s.runtime,failing,await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-cleanup-')),()=>now);assert.equal(failure.completed,false);assert(failure.blockers.length>0);
});
test('compiled static-import app runs in local workerd with both independent literal sequences, pinned bundles and no semantic infrastructure',async()=>{
  const output=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-cloud-bundle-'));
  const built=await buildChecklistBundle(p,output,process.cwd(),true),runtime=runtimeGrant().runtime;
  await verifyChecklistBundle(output,process.cwd(),built.source.source_sha256,p);
  assert.equal(bytesDigest(await readFile(path.join(output,'collection.mjs'))),input.module_sha256);
  // Pinned installed workerd supports through Oct 8; deployment package uses Oct 12 and needs matching-date qualification before activation.
  let outboundCalls=0;
  const outbound={type:'fetcher' as const,handler:()=>{outboundCalls++;return new MiniflareResponse('external egress refused',{status:403});}};
  const worker=new Miniflare({workers:[{config:{name:'synthetic-app',compatibilityDate:qualificationDate,compatibilityFlags:['nodejs_compat'],
    manifest:{mainModule:'app-bundle.mjs',modules:{'app-bundle.mjs':{type:'esm',contents:await readFile(path.join(output,'app-bundle.mjs'),'utf8')}}},
    env:{CHECKLIST_SOURCE_SHA256:{type:'text',value:built.source.source_sha256},CHECKLIST_TARGET_SHA256:{type:'text',value:p.target_sha256},CHECKLIST_VERSION:{type:'json',value:{id:runtime.app_version_id}}}},
    dev:{outboundService:outbound}},
    {config:{name:'synthetic-archive',compatibilityDate:qualificationDate,compatibilityFlags:['nodejs_compat'],
      manifest:{mainModule:'workflow-bundle.mjs',modules:{'workflow-bundle.mjs':{type:'esm',contents:await readFile(path.join(output,'workflow-bundle.mjs'),'utf8')}}},
      env:{CHECKLIST_SOURCE_SHA256:{type:'text',value:built.source.source_sha256},CHECKLIST_AUTHORIZATION_SHA256:{type:'text',value:''},CHECKLIST_VERSION:{type:'json',value:{id:'synthetic-workflow-version'}},
        CHECKLIST_ARCHIVE:{type:'workflow',name:'synthetic-flow',worker:'synthetic-archive',exportName:'ChecklistArchiveWorkflow',limits:{steps:8}}}},dev:{outboundService:outbound}}]});
  try{
    for(const unicode of [false,true]){const response=await worker.dispatchFetch('http://localhost/observe',{method:'POST',body:canonical({pins:p.pins,source_sha256:built.source.source_sha256,target_sha256:p.target_sha256,worker_version_id:runtime.app_version_id,operations:checklistSequence(unicode)})});assert.equal(response.status,200);verifyChecklistObservation(await response.json(),p.pins,built.source.source_sha256,p.target_sha256,runtime.app_version_id,unicode);}
    const bad=await worker.dispatchFetch('http://localhost/observe',{method:'POST',body:canonical({pins:{...p.pins,module_sha256:'0'.repeat(64)},operations:checklistSequence(false)})});assert.equal(bad.status,400);
    const env=await worker.getBindings<{CHECKLIST_ARCHIVE:Workflow<{run_id:string;grant_sha256:string}>}>('synthetic-archive');
    const instance=await env.CHECKLIST_ARCHIVE.create({id:'synthetic-native-refusal',params:{run_id:p.target.run_id,grant_sha256:'0'.repeat(64)}});
    let terminal=false;
    for(let n=0;n<20;n++){const state=await instance.status();if(state.status==='errored'){terminal=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal(terminal,true,'Native Workflow must refuse ungranted synthetic input.');assert.equal(outboundCalls,0);
  }finally{await worker.dispose();}
  const appConfig=JSON.parse(await readFile(path.join(output,'wrangler.app.jsonc'),'utf8')),workflowConfig=JSON.parse(await readFile(path.join(output,'wrangler.workflow.jsonc'),'utf8'));
  assert.equal(appConfig.workers_dev,false);assert.equal(workflowConfig.workers_dev,false);assert.equal(workflowConfig.preview_urls,false);assert.equal(workflowConfig.vars.CHECKLIST_AUTHORIZATION_SHA256,'');assert.equal(workflowConfig.services.length,1);assert.equal(workflowConfig.artifacts[0].remote,false);
  const workflow=await readFile(path.join(output,'workflow-entry.mjs'),'utf8');assert(!workflow.includes('fetch(request,'));assert(workflow.includes('WorkflowEntrypoint'));
  const body=await readFile(path.join(output,'app-bundle.mjs'));await writeFile(path.join(output,'app-bundle.mjs'),new Uint8Array([...body,10]));await assert.rejects(verifyChecklistBundle(output,process.cwd(),built.source.source_sha256,p));await writeFile(path.join(output,'app-bundle.mjs'),body);
  const normalized=normalizeChecklistHttpResponse({action:'status',target:p.target,expected:{workflow_id:'synthetic-workflow-id',workflow_definition_version_id:'synthetic-definition-version'}},200,{success:true,errors:[],messages:[],result:{versionId:'synthetic-definition-version',status:'complete',steps:CHECKLIST_STEPS.map(name=>({name:name+'-1',type:'step',success:true,attempts:[{success:true}]}))}});
  assert.deepEqual(normalized,{id:p.target.instance_id,status:'complete',steps:CHECKLIST_STEPS.map(name=>({name,attempt:1,status:'complete'}))});
  const request=describeChecklistHttpRequest({action:'full-step',target:p.target,step:'archive-closure',attempt:1});
  assert.equal(new URL(request.url).searchParams.get('name'),'archive-closure-1');assert.equal(request.provider_requests,1);assert.equal(request.automatic_retries,0);
  evidence.push({case:'local-workerd-static-import',synthetic_only:true,qualified_compatibility_date:qualificationDate,deployment_compatibility_date:'2026-10-12',matching_date_qualification_pending:qualificationDate!=='2026-10-12',source_sha256:built.source.source_sha256,output,source:built.source,approval_package:built.approval});
});
after(async()=>{await mkdir('.strata',{recursive:true});await writeFile('.strata/checklist-cloud-qualification.json',canonical({format:'strata-checklist-cloud-qualification/1',synthetic_only:true,provider_calls:0,credential_reads:0,real_release_available:false,cases:evidence}));});
