import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {parse as parseJavaScript} from '@babel/parser';
import {canonical,digest,bytesDigest} from '../src/model.js';
import {profileArchive,profileFor} from '../src/profile.js';
import {checklistProfileSource} from '../scripts/checklist-cloud-profile-source.js';
import {checklistCloudFixture} from './checklist-cloud-fixture.js';
import {StrictArtifacts} from './artifacts-fixture.js';
import {checklistAppWorker} from '../src/checklist-cloud-app-worker.js';
import {checklistAuthorizationDigest,CHECKLIST_STEPS,type ChecklistRunGrant} from '../src/checklist-cloud-workflow.js';
import {describeChecklistHttpRequest,verifyChecklistCloudResult} from '../scripts/checklist-cloud-run.js';
import type {ArtifactRepository} from '../src/artifacts.js';
import {checklistConfigDigest} from '../src/checklist-cloud-config.js';
import type {ChildProcess} from 'node:child_process';

const repository=process.cwd(),fixture=await checklistCloudFixture(),p=fixture.p,clock=Date.parse('2026-10-12T12:00:00Z');
const date=process.env.STRATA_CHECKLIST_QUALIFICATION_DATE??'2026-10-08';
assert(['2026-10-08','2026-10-12'].includes(date),'Explicit supplemental or matching date only, no fallback.');
const evidence:unknown[]=[];
const require=createRequire(import.meta.url);
const local=(file:string)=>JSON.stringify(path.join(repository,'dist/src',file).replaceAll('\\','/'));
// Capture the API's JSON interchange representation; optional SDK fields can be undefined in memory.
const nativeStatus=async(instance:WorkflowInstance)=>JSON.parse(JSON.stringify(await instance.status())) as Awaited<ReturnType<WorkflowInstance['status']>>&{__LOCAL_DEV_STEP_OUTPUTS:unknown[]};

test('preserved collection archive and checker equal the exact Node identities after the preparer bundle transform',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-profile-identity-'));
  const captured=checklistProfileSource(repository);
  await writeFile(path.join(directory,'entry.mjs'),`export {profileArchive,profileFor} from ${local('profile.js')};\n`);
  await build({entryPoints:[path.join(directory,'entry.mjs')],outfile:path.join(directory,'bundle.mjs'),bundle:true,platform:'neutral',target:'es2022',format:'esm',
    external:['node:*','cloudflare:workers'],plugins:[captured.plugin],absWorkingDir:repository,nodePaths:[path.join(repository,'node_modules')],logLevel:'silent'});
  const bundled=await import(pathToFileURL(path.join(directory,'bundle.mjs')).href);
  assert.equal(canonical(bundled.profileArchive('collection-host/1')),canonical(profileArchive('collection-host/1')));
  assert.equal(bundled.profileFor('collection-host/1').checker.digest(),profileFor('collection-host/1').checker.digest());
  assert.equal(captured.identity.profile_sha256,p.input.records[p.input.realization_ref].data.profile);
  evidence.push({case:'exact-node-profile-source-preserved',profile:captured.identity.profile_sha256,checker:captured.identity.checker_sha256,passed:true,synthetic_only:true});
});
test('cached Node identity cannot conceal a changed compiled source body during preparation',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-stale-profile-source-')),captured=checklistProfileSource(repository);
  const file=path.join(repository,'dist/src/profiles/collection-host.js'),original=await readFile(file,'utf8');
  const declaration='export function hostCollectionProgram(config) {';assert(original.includes(declaration));
  await writeFile(path.join(directory,'entry.mjs'),`export {profileArchive} from ${local('profile.js')};\n`);
  try{
    // Only private generated code in this isolated checkout; shared dependencies and producer files are untouched.
    await writeFile(file,original.replace(declaration,declaration+'\n    // Synthetic compiled-source identity mutation.'));
    await assert.rejects(build({entryPoints:[path.join(directory,'entry.mjs')],outfile:path.join(directory,'bundle.mjs'),bundle:true,platform:'neutral',target:'es2022',format:'esm',
      external:['node:*','cloudflare:workers'],plugins:[captured.plugin],absWorkingDir:repository,nodePaths:[path.join(repository,'node_modules')],logLevel:'silent'}),/Node source text or exact archive extraction sites changed/);
  }finally{await writeFile(file,original);}
  evidence.push({case:'stale-cached-node-source-refused',passed:true,synthetic_only:true});
});
test('R4 inactive originals, ambiguous bindings and mutation cannot mask executable source drift',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-binding-profile-source-'));
  const program=(profileArchive('collection-host/1') as {program:string}).program;
  const declaration='export function hostCollectionProgram(config) {';
  const entryFile=path.join(directory,'entry.mjs');await writeFile(entryFile,`export {profileArchive,profileFor} from ${local('profile.js')};\n`);
  const file=path.join(repository,'dist/src/profiles/collection-host.js'),original=await readFile(file,'utf8');
  assert(original.includes(declaration));assert(!program.includes('*/'));
  const changed=original.replace(declaration,declaration+'\n    return "// Synthetic changed executable program";');
  const cases=[
    ['inactive-block-comment',changed+'\n/* Inactive original source:\n'+program+'\n*/\n'],
    ['inactive-string',changed+'\nconst inactiveOriginal='+JSON.stringify(program)+';\n'],
    ['duplicate-binding',original+'\nfunction hostCollectionProgram(config) { return "synthetic duplicate"; }\n'],
    ['shadow-binding',original.replace('const archive = () => (','const archive = () => { const hostCollectionProgram = () => "synthetic shadow"; return (').replace("review: 'authenticated-criterion-attestation/1' });","review: 'authenticated-criterion-attestation/1' }); };" )],
    ['reassigned-binding',original+'\nhostCollectionProgram = () => "synthetic reassignment";\n']
  ];
  try{
    for(const [name,text]of cases){
      if(name!=='duplicate-binding')assert.doesNotThrow(()=>parseJavaScript(text,{sourceType:'module'}),name+' is valid executable JavaScript, not a parse-error surrogate');
      const captured=checklistProfileSource(repository);await writeFile(file,text);
      await assert.rejects(build({entryPoints:[entryFile],outfile:path.join(directory,name+'.mjs'),bundle:true,platform:'neutral',target:'es2022',format:'esm',
        external:['node:*','cloudflare:workers'],plugins:[captured.plugin],absWorkingDir:repository,nodePaths:[path.join(repository,'node_modules')],logLevel:'silent'}),/Node source text or exact archive extraction sites changed/);
      await writeFile(file,original);
    }
  }finally{await writeFile(file,original);}
  // The four original const arrow bindings also require their actual initializer range.
  const arrowFile=path.join(repository,'dist/src/profiles/collection-semantics.js'),arrowOriginal=await readFile(arrowFile,'utf8');
  const countSource=(profileArchive('collection-host/1') as {base:{semantics:{sources:{count:string}}}}).base.semantics.sources.count;
  assert(arrowOriginal.includes(countSource));assert(!countSource.includes('*/'));
  const arrowChanged=arrowOriginal.replace(countSource,'(max_items) => ({ statement: "Synthetic changed arrow" })')+'\n/* Inactive original arrow:\n'+countSource+'\n*/\n';
  assert.doesNotThrow(()=>parseJavaScript(arrowChanged,{sourceType:'module'}));
  try{
    const captured=checklistProfileSource(repository);await writeFile(arrowFile,arrowChanged);
    await assert.rejects(build({entryPoints:[entryFile],outfile:path.join(directory,'inactive-arrow.mjs'),bundle:true,platform:'neutral',target:'es2022',format:'esm',
      external:['node:*','cloudflare:workers'],plugins:[captured.plugin],absWorkingDir:repository,nodePaths:[path.join(repository,'node_modules')],logLevel:'silent'}),/Node source text or exact archive extraction sites changed/);
  }finally{await writeFile(arrowFile,arrowOriginal);}
  // A non-executable extraction spelling is not replaced or counted as a live call.
  const captured=checklistProfileSource(repository);await writeFile(file,original+'\n/* hostCollectionProgram.toString() */\nconst inactiveExtraction="hostCollectionProgram.toString()";\n');
  try{
    await build({entryPoints:[entryFile],outfile:path.join(directory,'inactive-extraction.mjs'),bundle:true,platform:'neutral',target:'es2022',format:'esm',
      external:['node:*','cloudflare:workers'],plugins:[captured.plugin],absWorkingDir:repository,nodePaths:[path.join(repository,'node_modules')],logLevel:'silent'});
    const bundled=await import(pathToFileURL(path.join(directory,'inactive-extraction.mjs')).href);
    assert.equal(canonical(bundled.profileArchive('collection-host/1')),canonical(profileArchive('collection-host/1')));
  }finally{await writeFile(file,original);}
  evidence.push({case:'R4-executable-binding-not-inactive-text',negative_cases:[...cases.map(([name])=>name),'inactive-original-arrow'],inactive_extraction_data_ignored:true,passed:true,synthetic_only:true});
});

async function native(crash:boolean){
  const directory=await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-native-bridge-'));
  const captured=checklistProfileSource(repository),source=digest({synthetic:true,identity:captured.identity});
  const g:ChecklistRunGrant={format:'strata-checklist-cloud-run-grant/1',approved:true,approval_id:'synthetic-native-only',preparation_sha256:digest(p),source_sha256:source,
    target_sha256:p.target_sha256,config_sha256:checklistConfigDigest(p,source),workflow_id:'synthetic-workflow-id',workflow_definition_version_id:'synthetic-definition-version',workflow_version_id:'synthetic-workflow-version',app_version_id:'synthetic-app-version',started_at:clock-1000,
    expires_at:clock+600000,cleanup_expires_at:clock+720000,metered_charges_accepted:true,spending_limit_usd:1,retention:{repository:'delete',instance:'delete',workers:'delete'}};
  const runtime={source_sha256:source,grant_sha256:digest(g),authorization_sha256:checklistAuthorizationDigest(g),workflow_version_id:g.workflow_version_id,app_version_id:g.app_version_id};
  // Preserve the exact REST params representation across the native event boundary.
  const create=JSON.parse(describeChecklistHttpRequest({action:'create-instance',target:p.target,payload:{run_id:p.target.run_id,grant_sha256:runtime.grant_sha256,grant:g}}).body!);
  const script=`import {WorkflowEntrypoint} from 'cloudflare:workers';
import {runChecklistCloudWorkflow,checklistWorkflowEvent} from ${local('checklist-cloud-workflow.js')};
const p=${canonical(p)},g=${canonical(g)},runtime=${canonical(runtime)};
let disposed=[];
async function rpc(action,params){const pending=disposed;disposed=[];const r=await fetch('https://fixture.invalid/rpc/'+action,{method:'POST',body:JSON.stringify({...params,disposed:pending})});if(!r.ok)throw Error('Explicit synthetic RPC refused');return r.json();}
export class SyntheticArchive extends WorkflowEntrypoint {
 async run(rawEvent,step){
  const event=checklistWorkflowEvent(rawEvent);
  const steps={do:(name,config,fn)=>step.do(name,config,async ctx=>{await rpc('context',{name,ctx});return fn(ctx);})};
  const namespace={get:async name=>{const {id}=await rpc('get',{name});return {info:()=>rpc('info',{id}),createToken:(mode,ttl)=>rpc('createToken',{id,mode,ttl}),revokeToken:token=>rpc('revokeToken',{id,token}),readFile:async params=>{const r=await rpc('readFile',{id,params});return r===null?null:new Blob([new Uint8Array(r)]);},[Symbol.dispose]:()=>{disposed.push(id);}};}};
  const transport=async request=>{const r=await fetch(request);if(${crash}&&new URL(request.url).pathname.endsWith('/git-receive-pack')&&r.ok){await rpc('settled',{});await fetch('https://fixture.invalid/barrier');}return r;};
  const result=await runChecklistCloudWorkflow(p,g,runtime,event,steps,{mode:'synthetic-test-only',now:()=>${clock},namespace,transport,provision:async()=>{},app:{fetch:request=>fetch(new Request('https://fixture.invalid/observe',request))}});
  await rpc('finished',{});return result;
 }
}`;
  await writeFile(path.join(directory,'entry.mjs'),script);
  await build({entryPoints:[path.join(directory,'entry.mjs')],outfile:path.join(directory,'bundle.mjs'),bundle:true,platform:'neutral',target:'es2022',format:'esm',
    external:['node:*','cloudflare:workers'],plugins:[captured.plugin],absWorkingDir:repository,nodePaths:[path.join(repository,'node_modules')],logLevel:'silent'});
  const cp=require('node:child_process') as typeof import('node:child_process'),originalSpawn=cp.spawn,owned:ChildProcess[]=[];
  // This public runtime override is an explicit, separately approved qualification input.
  const binary=realpathSync(process.env.MINIFLARE_WORKERD_PATH??(require('workerd').default??require('workerd')));
  const binaryHash=bytesDigest(await readFile(binary));
  cp.spawn=((command:string,args:readonly string[],options:unknown)=>{const child=Reflect.apply(originalSpawn,cp,[command,args,options]) as ChildProcess;
    if(args?.[0]==='serve'&&args.includes('--binary')&&realpathSync(command)===binary)owned.push(child);return child;}) as typeof cp.spawn;
  const {Miniflare,Response:MFResponse}=await import('miniflare');
  const strict=new StrictArtifacts(),handles=new Map<number,ArtifactRepository>(),contexts:{name:string;ctx:{step:{name:string;count:number};attempt:number}}[]=[];
  const mod=await import('data:text/javascript;base64,'+Buffer.from(fixture.realization.files['collection.mjs']).toString('base64')),app=checklistAppWorker(mod.createCollection,p.pins);
  let egress=0,settled=0,restarts=0;
  let barrierResolve!:()=>void,restartResolve!:()=>void;
  const barrier=new Promise<void>(r=>barrierResolve=r),restarted=new Promise<void>(r=>restartResolve=r);
  const bounded=<T>(promise:Promise<T>,label:string)=>Promise.race([promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error(label+' timed out')),15000).unref())]);
  const snapshot=()=>({calls:[...strict.calls],pushes:strict.pushes,tokens_issued:strict.calls.filter(c=>c==='createToken').length,tokens_revoked:strict.revoked,handles:strict.openHandles,contexts:structuredClone(contexts),settled});
  const response=(value:unknown,status=200)=>new MFResponse(canonical(value),{status,headers:{'content-type':'application/json'}});
  const worker=new Miniflare({resourcePersistencePath:path.join(directory,'storage'),telemetry:{enabled:false},unsafeHandleRuntimeRestart:()=>{restarts++;restartResolve();},
    workers:[{config:{name:'synthetic-native-archive',compatibilityDate:date,compatibilityFlags:['nodejs_compat'],
      manifest:{mainModule:'bundle.mjs',modules:{'bundle.mjs':{type:'esm',contents:await readFile(path.join(directory,'bundle.mjs'),'utf8')}}},
      env:{ARCHIVE:{type:'workflow',name:'synthetic-native-archive',worker:'synthetic-native-archive',exportName:'SyntheticArchive',limits:{steps:8}}}},
      dev:{rootPath:directory,unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler:async req=>{
        const url=new URL(req.url);
        if(url.hostname===p.target.account_id+'.artifacts.cloudflare.net'){
          const r=await strict.transport(new Request(req.url.replace(p.target.account_id+'.artifacts','account.artifacts'),{method:req.method,headers:Object.fromEntries(req.headers),
            body:req.method==='GET'?undefined:await req.arrayBuffer(),redirect:'manual'}));return new MFResponse(await r.arrayBuffer(),{status:r.status,headers:Object.fromEntries(r.headers)});
        }
        if(url.hostname!=='fixture.invalid'){egress++;return response({refused:true},403);}
        if(url.pathname==='/observe'){const r=await app.fetch(new Request(req.url,{method:req.method,body:await req.text()}),{CHECKLIST_SOURCE_SHA256:source,CHECKLIST_TARGET_SHA256:p.target_sha256,CHECKLIST_VERSION:{id:g.app_version_id}});return new MFResponse(await r.arrayBuffer(),{status:r.status,headers:Object.fromEntries(r.headers)});}
        if(url.pathname==='/barrier'){barrierResolve();return new Promise(()=>{});}
        const x=JSON.parse(await req.text()),action=url.pathname.slice('/rpc/'.length);
        for(const id of x.disposed){handles.get(id)![Symbol.dispose]();handles.delete(id);}
        if(action==='context'){contexts.push(x);return response({ok:true});}
        if(action==='settled'){settled++;assert.equal(strict.pushes,1);return response({ack:true});}
        if(action==='finished')return response({ok:true});
        if(action==='get'){const id=(contexts.length+1)*100+handles.size;handles.set(id,await strict.get(x.name));return response({id});}
        const h=handles.get(x.id);assert(h,'Exact synthetic handle');
        if(action==='info'){const info=await h.info();return response({...info,remote:info.remote.replace('account.artifacts',p.target.account_id+'.artifacts')});}
        if(action==='createToken')return response(await h.createToken(x.mode,x.ttl));
        if(action==='revokeToken')return response(await h.revokeToken(x.token));
        if(action==='readFile'){const blob=await h.readFile(x.params);return response(blob===null?null:[...new Uint8Array(await blob.arrayBuffer())]);}
        throw Error('Unknown synthetic fixture action');
      }}}}]});
  // Do not decode in the fixture host: the generated Worker must handle REST text.
  const event=()=>({id:create.instance_id,params:create.params});
  let record:Record<string,unknown>={case:crash?'full-native-post-mutation-crash':'positive-native-structured-archive',synthetic_only:true,compatibility_date:date,matching_date_qualification:date==='2026-10-12',source_identity:captured.identity.profile_sha256,qualification_binary:{path:binary,sha256:binaryHash}};
  try{
    let env=await worker.getBindings<{ARCHIVE:Workflow}>('synthetic-native-archive'),instance=await env.ARCHIVE.create(event());
    if(crash){
      await bounded(barrier,'Acknowledged mutation barrier');const before={...snapshot(),status:await nativeStatus(instance)};
      assert.equal(before.status.__LOCAL_DEV_STEP_OUTPUTS.length,2);assert.equal(owned.length,1);
      const child=owned[0];assert(child.pid&&child.exitCode===null);const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));assert(child.kill('SIGKILL'));
      const crashExit=await bounded(exit,'Owned process exit');await bounded(restarted,'Native automatic recovery');
      env=await worker.getBindings<{ARCHIVE:Workflow}>('synthetic-native-archive');instance=await env.ARCHIVE.get(create.instance_id);
      await instance.sendEvent({type:'synthetic-crash-wake',payload:{synthetic:true}});
      let status=await nativeStatus(instance);for(let n=0;n<100&&!['errored','complete','terminated'].includes(status.status);n++){await new Promise(r=>setTimeout(r,50));status=await nativeStatus(instance);}
      assert.equal(status.status,'errored');assert.match(status.error?.message??'',/First invocation\/attempt only/);
      const after={...snapshot(),status};assert.deepEqual(after.calls,before.calls);assert.deepEqual(after.status.__LOCAL_DEV_STEP_OUTPUTS,before.status.__LOCAL_DEV_STEP_OUTPUTS);
      assert.equal(after.pushes,1);assert.equal(after.tokens_issued,1);assert.equal(restarts,1);assert.equal(settled,1);
      const archiveContexts=contexts.filter(c=>c.name==='archive-closure');assert.deepEqual(archiveContexts.map(c=>[c.ctx.step.count,c.ctx.attempt]),[[1,1],[1,2]]);
      record={...record,before,after,crash_exit:crashExit,owned_runtime_pids:owned.map(c=>c.pid),native_restarts:restarts,passed:true,remote_infrastructure_qualified:false};
    }else{
      let status=await nativeStatus(instance);for(let n=0;n<100&&!['errored','complete','terminated'].includes(status.status);n++){await new Promise(r=>setTimeout(r,50));status=await nativeStatus(instance);}
      assert.equal(status.status,'complete',JSON.stringify(status));verifyChecklistCloudResult(status.output,p,runtime,true);
      assert.deepEqual(contexts.map(c=>c.name),[...CHECKLIST_STEPS]);assert(contexts.every(c=>c.ctx.attempt===1&&c.ctx.step.count===1));
      assert.equal(strict.pushes,2);assert.equal(strict.revoked,2);assert.equal(strict.openHandles,0);
      record={...record,result:status.output,artifact_io:snapshot(),passed:true,native_repository_provision_qualified:false};
    }
    assert.equal(egress,0);
  }finally{
    await bounded(worker.dispose(),'Owned runtime disposal');cp.spawn=originalSpawn;
    const partial=snapshot();for(const h of handles.values()){await h.revokeToken('mock-only-token?expires=fixture');h[Symbol.dispose]();}handles.clear();
    evidence.push({...record,external_egress:egress,partial_fixture_before_disposal:partial,local_fixture_after_disposal:snapshot(),runtime_disposed:true});
  }
}
test('positive native Workflow verifies preserved identity, exact structured event, Git closure/readback and generated app',()=>native(false));
test('full native bridge refuses attempt-two reentry after acknowledged mutation without replenishment or new dispatch',()=>native(true));
after(async()=>{await mkdir('.strata',{recursive:true});await writeFile('.strata/checklist-cloud-native-qualification.json',canonical({format:'strata-checklist-native-qualification/1',synthetic_only:true,provider_calls:0,existing_credential_reads:0,cases:evidence}));});
