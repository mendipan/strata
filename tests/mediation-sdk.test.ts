import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {CONTENT_MODEL,canonical,digest} from '../src/model.js';
import {proposal} from '../src/fixtures.js';
import {snapshot,FIXTURE_NOW} from './mediation-helpers.js';
import {fixtureOracle} from '../src/booking-checker.js';
import {runFixtureEvidence} from '../src/runner.js';

test('local Agents SDK exercises asset-free v0.2 human packet, Resolution, measured legacy profile and Release',async()=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'strata-mediation-sdk-'));
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));
  const child=spawn(process.execPath,[path.resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--ip','127.0.0.1','--port',String(port),'--persist-to',path.join(scratch,'state')],{cwd:process.cwd(),env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  const url=`http://127.0.0.1:${port}`;
  async function call(command:string,input:any,selector='fixture-preparer',key?:string):Promise<any> {const response:any=await (await fetch(url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':selector},body:JSON.stringify({command,input,options:key?{idempotency_key:key}:{}})})).json();assert.equal(response.ok,true,JSON.stringify(response.error));return response.data;}
  try {
    let ready=false;const until=Date.now()+45000;while(Date.now()<until && child.exitCode===null){try{ready=(await fetch(url+'/health',{signal:AbortSignal.timeout(500)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,250));}assert(ready,log.slice(-2000));
    await call('init',{record:snapshot()},'fixture-bootstrap');
    // No-op owned alternatives exercise the mediation boundary without adding a
    // default content-review or executor assignment to the production fixture table.
    const refs:string[]=[];for(const [id,owner,selector]of [['L-sdk-a','author-a','fixture-a'],['L-sdk-b','author-b','fixture-b']]){const l=proposal(id,owner);l.model_version=CONTENT_MODEL;const d=await call('layer.create',{record:l},selector);await call('layer.publish',{ref:d.ref},selector);refs.push(d.ref);}
    const c={id:'C-sdk-mediation',revision:1,model_version:CONTENT_MODEL,baseline:'R0@1',proposals:refs,selected:refs,alternative_groups:[{id:'choice',members:refs,min:1,max:1}],scenario:{id:'booking-sdk-human',checks:[{id:'booking.compatibility',version:'1'}]},resolutions:[]};const blocked=await call('compose',{record:c});assert.equal(blocked.state,'blocked');
    const analysis=await call('mediation.prepare',{target:blocked.ref,case_id:'sdk-human',case_revision:1,expires_at:new Date(Date.now()+3600000).toISOString(),goal:'Choose one already-authored no-op alternative.',partitions:refs.map((r,i)=>({id:'option-'+i,selected:[r],rejected:refs.filter(x=>x!==r)})),supersedes:null});assert.equal(analysis.basis.policy_status,'unresolved');
    const decisions=[];for(const [i,d]of analysis.decision_proposals.entries()){const l=proposal('L-sdk-decision-'+i,'author-a');l.model_version=CONTENT_MODEL;l.resolution_proposals=[d.payload];const draft=await call('layer.create',{record:l},'fixture-a');await call('layer.publish',{ref:draft.ref},'fixture-a');decisions.push({option_id:d.option_id,layer:draft.ref,proposal_index:0});}
    const packet=await call('mediation.prepare',{basis_ref:analysis.ref,decisions});const input={packet_ref:packet.ref,packet_sha256:packet.packet_sha256,case_revision:1,action:'approve_selection',option_id:'option-0',message:'Exact local SDK fixture selection.'};
    const responses=await Promise.all([call('mediation.respond',input,'fixture-selector','same'),call('mediation.respond',input,'fixture-selector','other')]);assert.equal(responses[0].ref,responses[1].ref);
    const resolution=await call('resolve',{record:{layer:decisions[0].layer,proposal_index:0,composition:blocked.ref,approvals:[responses[0].ref]}});const chosen={...c,id:'C-sdk-selected',selected:[refs[0]],resolutions:[resolution.ref]};const candidate=await call('compose',{record:chosen});assert.equal(candidate.state,'eligible_for_validation');
    const realization=await call('materialize',{target:candidate.ref,profile:'booking-node/2'}),registered=await call('realization.register',{record:realization});const out=path.join(scratch,'output');await mkdir(out);for(const [name,body]of Object.entries(realization.files))await writeFile(path.join(out,name),body as string);await writeFile(path.join(out,'realization.json'),canonical(realization));
    const oracle=fixtureOracle(candidate.snapshot);assert.deepEqual(oracle.expected,{seconds:600,enabled:false,lead_seconds:60});const measured=await runFixtureEvidence(out,realization,oracle);assert(measured.evidence.results.every(r=>r.passed));const validation=await call('validate',{target:candidate.ref,realization:registered.ref,evidence:measured.evidence},'fixture-runner');
    const status=await call('status',{},'fixture-reader');assert.equal(status.capabilities['mediation/1'],true);
    const base={format:'approval/2',project_id:'strata-local-demo',model_version:CONTENT_MODEL,baseline:'R0@1',authority_sha256:digest(snapshot().authorities),target:candidate.fingerprint,evidence_digest:validation.evidence_digest,generation:status.mediation_generation,expires_at:null,binding:null};const scope=await call('approve',{record:{...base,kind:'scope',scope:candidate.scope}},'fixture-selector');const project=await call('approve',{record:{...base,kind:'release',scope:null}},'fixture-release');const released=await call('release',{target:candidate.ref,validation:validation.ref,approvals:[scope.ref,project.ref]},'fixture-release');assert.equal(released.state,'validated');
    const report=await call('conflicts.report',{target:candidate.ref,report:{id:'sdk-late',message:'Pending selection must reconsider this new report.',affected_items:['booking.hold/requirements.expiry'],contributors:[refs[0]],evidence_refs:[validation.ref]}},'fixture-reviewer');assert.equal(report.state,'blocked');
    const stale:any=await (await fetch(url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':'fixture-selector'},body:JSON.stringify({command:'mediation.respond',input,options:{idempotency_key:'same'}})})).json();assert.equal(stale.ok,false);assert.equal(stale.error.code,'MEDIATION_STALE');
  }finally{if(child.exitCode===null){if(process.platform==='win32')await new Promise<void>(resolve=>execFile('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,timeout:10000},()=>resolve()));else child.kill();}await new Promise<void>(r=>{if(child.exitCode!==null)r();else child.once('exit',()=>r());});await rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
