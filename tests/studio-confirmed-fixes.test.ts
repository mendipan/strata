import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { namespaceFixture } from './namespace-fixture.js';
import { MAX_REQUEST_BYTES } from '../src/security.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const recovery=await import(pathToFileURL(path.resolve('explorer/operation-recovery.js')).href);

const local={skip:process.platform!=='win32'&&process.getuid?.()!==0?'Protected POSIX fixtures require root.':false};

test('HTML errors and malformed successful operation replies retain an unknown outcome without revealing response content',async()=>{
  for(const response of [new Response('<html>private-echo</html>',{status:413}),new Response('<html>private-echo</html>',{status:502}),new Response('{broken',{headers:{'content-type':'application/json'}}),Response.json({data:null}),Response.json({data:{ref:'unconfirmed-shape'}}),Response.json({data:{data:[]}})]){
    await assert.rejects(recovery.operationResponse(response,'original-request'),(e:any)=>e.code==='OPERATION_UNKNOWN'&&/original-request.*Review/.test(e.message)&&!e.message.includes('private-echo')&&!e.message.includes('Unexpected token'));
  }
  const reply={data:{ref:'L-saved@1'},generation:'current'};
  assert.deepEqual(await recovery.operationResponse(Response.json({data:reply}),'key'),reply);
  await assert.rejects(recovery.operationResponse(Response.json({data:{data:{}}}),'key','layer.create'),(e:any)=>e.code==='OPERATION_UNKNOWN');
  assert.deepEqual(await recovery.operationResponse(Response.json({data:reply}),'key','layer.create'),reply);
  await assert.rejects(recovery.operationResponse(Response.json({error:{code:'STALE_GENERATION',message:'Refresh the project.'}},{status:409}),'key'),(e:any)=>e.code==='STALE_GENERATION'&&e.status===409);
  assert.equal(recovery.sessionRequired({code:'OWNER_SESSION_REQUIRED',status:403}),true);
  assert.equal(recovery.sessionRequired({code:'SESSION_REQUIRED',status:401}),true);
  assert.equal(recovery.sessionRequired({code:'SOURCE_AUTH',status:403}),false);
  assert.equal(recovery.sessionRequired({code:'SOURCE_AUTH',status:401}),false);
  assert.equal(recovery.sessionRequired({code:'REF_NOT_FOUND',status:403}),false);
});

test('recovery retains only exact identity, refuses replacement and clears only the original request',()=>{
  const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)};
  const key='2be5d7de-6875-4350-97c3-12a18a17c8d0',pending={key,connection_id:'original-repository',command:'layer.create',draft:'private purpose',credential:'private credential'};
  recovery.retainOperation(pending,storage);assert.deepEqual(recovery.pendingOperation(storage),{key,connection_id:'original-repository',command:'layer.create'});
  assert.doesNotMatch([...values.values()].join(''),/private purpose|private credential/);
  assert.throws(()=>recovery.retainOperation({...pending,key:'ddc5e05b-e3d5-46b3-a67f-3438dc3e26b9',connection_id:'another-repository'},storage),(e:any)=>e.code==='OPERATION_PENDING');
  recovery.clearOperation('different-key',storage);assert.equal(recovery.pendingOperation(storage).key,key);
  recovery.clearOperation(key,storage);assert.equal(recovery.pendingOperation(storage),null);
  assert.throws(()=>recovery.retainOperation(pending,{...storage,setItem(){throw Error('storage denied');}}),(e:any)=>e.code==='OPERATION_RECOVERY_UNAVAILABLE'&&e.message.includes('No request was sent'));
});

test('ingress example admits the existing authoring byte contract without widening other routes',async()=>{
  const config=await readFile('deploy/studio/nginx.conf.example','utf8');
  assert.match(config,/client_max_body_size\s+1k;/);
  for(const route of ['operation','preview']){
    const block=config.match(new RegExp('location\\s+=\\s+/studio/v1/'+route+'\\s*\\{([^}]+)\\}'))?.[1];
    assert.ok(block,'exact bounded authoring location: '+route);
    assert.match(block,/client_max_body_size\s+1m;/);
    assert.match(block,/proxy_pass\s+http:\/\/127\.0\.0\.1:4174;/);
  }
  assert.equal(MAX_REQUEST_BYTES,1024*1024);
  assert.doesNotMatch(config,/client_max_body_size\s+0;/);
});

test('a lost initial push retains registered partial creation and inspection never repeats or overwrites it',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  f.setMode('lost-push');const failed=await f.action('create',{name:'synthetic-partial',purpose:'Preserve the original setup'});
  assert.notEqual(failed.status,200);f.setMode('ok');
  const before=await f.server.store.snapshot(),original=before.operations.find(o=>o.action==='create')!,project=before.projects.find(p=>p.name==='synthetic-partial')!,repo=f.repos.get('synthetic-partial')!;
  assert.equal(original.phase,'uncertain');assert.equal(project.state,'created');assert.equal(repo.git.pushes,1);
  const originalFiles=JSON.stringify([...repo.git.files].map(([ref,files])=>[ref,[...files]])),calls=f.calls.length;
  const inspection=await f.action('inspect-create',{source_request_id:original.request_id});
  assert.equal(inspection.status,200,inspection.text);assert.equal(inspection.data.recovery.can_finish,false);
  assert.deepEqual((await f.server.store.snapshot()).projects,before.projects);
  assert.equal(JSON.stringify([...repo.git.files].map(([ref,files])=>[ref,[...files]])),originalFiles);
  assert.ok(f.calls.slice(calls).every(c=>c.startsWith('GET ')));
  const refused=await f.action('recover-create',{source_request_id:original.request_id,repository_id:project.id,purpose:'Never replace original content',acknowledgment:'initialize-empty-repository'});
  assert.equal(refused.status,409);assert.equal(repo.git.pushes,1);
  assert.deepEqual((await f.server.store.snapshot()).projects,before.projects);
  assert.equal((await f.server.store.snapshot()).operations.find(o=>o.request_id===original.request_id)!.phase,'uncertain');
});
