import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {namespaceFixture} from './namespace-fixture.js';
import {runNamespaceStudio} from '../src/explorer/namespace-host.js';
import {CONFORMANCE_ACCOUNT,CONFORMANCE_NAMESPACE,CONFORMANCE_REPOSITORY,CONFORMANCE_GENERATION,
  conformancePacketSchema,executeNamespaceConformance,type ConformancePorts} from '../src/explorer/namespace-conformance.js';

const local={skip:process.platform!=='win32'&&process.getuid?.()!==0?'Protected synthetic owner fixture requires root.':false};
async function fixture(){
  const f=await namespaceFixture({account:CONFORMANCE_ACCOUNT,namespace:CONFORMANCE_NAMESPACE,max_projects:1,
    limits:{requests:160,bytes:50*1024**2,max_operation_requests:50,max_operation_bytes:16*1024**2,max_payload_bytes:4*1024**2,max_journal_entries:160}});
  await f.login();assert.equal((await f.b.send('/studio/v1/owner/credentials','POST',{action:'save',credential_id:'artifacts-api-token',revision:0,request_id:randomUUID(),value:'synthetic-namespace-api-secret'},f.csrf)).status,200);
  await f.server.close();
  const packet=conformancePacketSchema.parse({format:'strata-studio-namespace-conformance-packet/1',run_id:randomUUID(),policy:f.policy,namespace:f.config,
    public_origin:f.base.origin,username:'workspace.owner',credential_id:'artifacts-api-token',saved_credential_generation:CONFORMANCE_GENERATION});
  let generation=CONFORMANCE_GENERATION,approved=true;
  const ports:ConformancePorts={transport:f.transport,generation:async()=>generation,credential:async()=>'synthetic-namespace-api-secret',
    password:async()=>f.base.password,approval:async()=>{if(!approved)throw Error('synthetic approval denied');},
    start:transport=>runNamespaceStudio(f.base.state,f.config,{publicOrigin:f.base.origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer'),transport)};
  return {f,packet,ports,setGeneration:(g:string)=>generation=g,setApproval:(v:boolean)=>approved=v};
}
async function outputs(directory:string){let text='';for(const e of await readdir(directory,{withFileTypes:true})){const p=path.join(directory,e.name);if(e.isDirectory())text+=await outputs(p);else text+=await readFile(p,'utf8');}return text;}

test('named conformance saves/revises, freshly reads provider bytes after restart, retains spend and confirms owned cleanup',local,async()=>{
  const {f,packet,ports}=await fixture();let report:any;
  try{report=await executeNamespaceConformance(packet,ports);}catch{
    const checkpoint=JSON.parse(await readFile(path.join(f.config.catalog_directory,'executor.json'),'utf8'));
    assert.fail('Synthetic conformance checkpoint: '+JSON.stringify({checkpoint,last_requests:f.calls.slice(-6)}));
  }
  assert.deepEqual(report.checks,{namespace_admission:true,read_edit:true,create:true,save:true,read_back:true,generation_match:true,automatic_expiry:true,owned_write_token_cleanup:true});
  assert.equal(report.account,CONFORMANCE_ACCOUNT);assert.equal(report.namespace,CONFORMANCE_NAMESPACE);assert.equal(report.repository,CONFORMANCE_REPOSITORY);
  assert.ok(report.reserved_requests>0&&report.reserved_requests<=160);assert.ok(report.reserved_bytes>0&&report.reserved_bytes<=50*1024**2);
  assert.equal(f.repos.size,1);assert.ok(f.calls.filter(x=>x.endsWith('/file')).length>=3);
  const state=JSON.parse(await readFile(path.join(f.config.catalog_directory,'namespace.json'),'utf8'));assert.equal(state.connected,false);assert.equal(state.projects.length,1);
  const before=f.calls.length;const replay=await executeNamespaceConformance(packet,{...ports,credential:async()=>{throw Error('replay must not access credential');},generation:async()=>{throw Error('replay must not inspect credential');}});
  assert.deepEqual(replay,report);assert.equal(f.calls.length,before);
  const text=await outputs(f.config.catalog_directory)+await outputs(f.config.projects_directory);
  assert.doesNotMatch(text,/synthetic-namespace-api-secret|art_v1_[a-f0-9]{40}\?expires/);
});

test('invalid scope/version/limits refuse without a provider dispatch or reset',local,async()=>{
  const {f,packet,ports,setGeneration}=await fixture();
  for(const mutate of [(p:any)=>p.policy.account='a'.repeat(32),(p:any)=>p.policy.namespace='other',(p:any)=>p.saved_credential_generation='0'.repeat(64),
    (p:any)=>p.policy.max_projects=2,(p:any)=>p.policy.limits.requests=161,(p:any)=>p.policy.limits.bytes=51*1024**2]){
    const value=structuredClone(packet);mutate(value);await assert.rejects(executeNamespaceConformance(value,ports));assert.equal(f.calls.length,0);}
  setGeneration('0'.repeat(64));await assert.rejects(executeNamespaceConformance(packet,ports));assert.equal(f.calls.length,0);
  await assert.rejects(executeNamespaceConformance(packet,ports),e=>(e as any).code==='CONFORMANCE_RECONCILIATION_REQUIRED');
});

for(const mode of ['missing-namespace','long-token','lost-create'] as const)test(`conformance retains ${mode} outcome and never continues or retries creation`,local,async()=>{
  const {f,packet,ports}=await fixture();f.setMode(mode);
  await assert.rejects(executeNamespaceConformance(packet,ports));const before=f.calls.length;
  assert.equal(f.calls.filter(x=>x.startsWith('POST')&&x.endsWith('/tokens')).length,0);
  assert.equal(f.calls.filter(x=>x.includes('git-receive-pack')).length,0);
  await assert.rejects(executeNamespaceConformance(packet,ports));assert.equal(f.calls.length,before);
  assert.ok(JSON.parse(await readFile(path.join(f.config.catalog_directory,'usage.json'),'utf8')).reserved_requests>0);
  assert.doesNotMatch(await outputs(f.config.catalog_directory),/art_v1_|synthetic-namespace-api-secret/);
});

test('wrong namespace identity and expiry/approval invalidation stop before provider writes',local,async()=>{
  const {f,packet,ports}=await fixture();const original=ports.transport;
  ports.transport=async req=>req.url.endsWith('/strata')?Response.json({success:true,result:{name:'different'}}):original(req);
  await assert.rejects(executeNamespaceConformance(packet,ports));assert.equal(f.repos.size,0);
  assert.equal(f.calls.filter(x=>x.startsWith('POST')).length,0);
});

test('expired approval after admission refuses before creation without refunding discovery',local,async()=>{
  const {f,packet,ports,setApproval}=await fixture();
  ports.fault=async stage=>{if(stage==='name-admitted')setApproval(false);};
  await assert.rejects(executeNamespaceConformance(packet,ports));assert.equal(f.repos.size,0);
  assert.equal(f.calls.filter(x=>x.startsWith('POST')).length,0);
  assert.ok(JSON.parse(await readFile(path.join(f.config.catalog_directory,'usage.json'),'utf8')).reserved_requests>0);
});

test('trusted namespace credential fence rejects a changed saved version before decrypting the synthetic key',local,async()=>{
  const {f,packet,ports,setGeneration}=await fixture();let accesses=0;
  const original=f.base.state.store.bind(f.base.state);
  f.base.state.store=(...args:Parameters<typeof original>)=>{const store=original(...args),read=store.withCredential.bind(store);
    store.withCredential=async operation=>{accesses++;return read(operation);};return store;};
  ports.start=transport=>runNamespaceStudio(f.base.state,f.config,{publicOrigin:f.base.origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer'),transport,undefined,
    async()=>{if(await ports.generation()!==CONFORMANCE_GENERATION)throw Error('synthetic saved version mismatch');});
  ports.fault=async stage=>{if(stage==='owner-authenticated')setGeneration('0'.repeat(64));};
  await assert.rejects(executeNamespaceConformance(packet,ports));assert.equal(accesses,0);assert.equal(f.calls.length,0);
});

test('cleanup with a mismatched owned ID cannot produce a passing report or expose token secrets',local,async()=>{
  const {f,packet,ports}=await fixture(),original=ports.transport;
  ports.transport=async req=>req.method==='DELETE'?Response.json({success:true,result:{id:'not-the-owned-token'}}):original(req);
  await assert.rejects(executeNamespaceConformance(packet,ports));
  assert.equal(f.repos.size,1);assert.doesNotMatch(await outputs(f.config.catalog_directory)+await outputs(f.config.projects_directory),/art_v1_[a-f0-9]{40}\?expires|synthetic-namespace-api-secret/);
  await assert.rejects(readFile(path.join(f.config.catalog_directory,'provider-conformance.json')));
});

test('fresh read-back corruption fails the report despite valid cached draft state',local,async()=>{
  const {f,packet,ports}=await fixture(),original=ports.transport;let corrupt=false;
  ports.fault=async stage=>{if(stage==='permission-denials')corrupt=true;};
  ports.transport=async req=>corrupt&&new URL(req.url).pathname.endsWith('/file')?new Response('corrupted synthetic provider bytes'):original(req);
  await assert.rejects(executeNamespaceConformance(packet,ports));
  await assert.rejects(readFile(path.join(f.config.catalog_directory,'provider-conformance.json')));
  const usage=JSON.parse(await readFile(path.join(f.config.catalog_directory,'usage.json'),'utf8'));assert.ok(usage.reserved_requests>0);
});

test('oversized namespace metadata stays bounded and cannot lead to creation',local,async()=>{
  const {f,packet,ports}=await fixture(),original=ports.transport;
  ports.transport=async req=>req.url.endsWith('/strata')?Response.json({success:true,result:{name:'strata',padding:'x'.repeat(9000)}}):original(req);
  await assert.rejects(executeNamespaceConformance(packet,ports));assert.equal(f.repos.size,0);
});

test('rotation after creation stops bootstrap, preserves uncertain history and never sends new saved version',local,async()=>{
  const {f,packet,ports,setGeneration}=await fixture(),original=ports.transport;
  ports.transport=async req=>{const r=await original(req);if(req.method==='POST'&&req.url.endsWith('/repos'))setGeneration('0'.repeat(64));return r;};
  await assert.rejects(executeNamespaceConformance(packet,ports));assert.equal(f.repos.size,1);
  assert.equal(f.calls.filter(x=>x.includes('/tokens')).length,0);
  const c=JSON.parse(await readFile(path.join(f.config.catalog_directory,'executor.json'),'utf8'));assert.equal(c.phase,'uncertain');
  assert.ok(JSON.parse(await readFile(path.join(f.config.catalog_directory,'usage.json'),'utf8')).reserved_requests>0);
});

test('an exhausted admitted budget is retained with no automatic refill or second request',local,async()=>{
  const f=await fixture();f.packet.policy.limits.requests=1;
  // Install the intentionally lower synthetic policy/state through the pure
  // fixture before execution; no test can mutate live policies or credentials.
  const {initialNamespaceFiles}=await import('../src/explorer/namespace-policy.js');
  const {writePrivate}=await import('../src/explorer/owner-files.js');
  await writePrivate(f.packet.namespace.policy_file,f.packet.policy);const initial=initialNamespaceFiles(f.packet.policy);
  await writePrivate(path.join(f.packet.namespace.catalog_directory,'namespace.json'),initial.state);await writePrivate(path.join(f.packet.namespace.catalog_directory,'usage.json'),initial.usage);
  await assert.rejects(executeNamespaceConformance(f.packet,f.ports));assert.equal(f.f.calls.length,1);
  const usage=JSON.parse(await readFile(path.join(f.packet.namespace.catalog_directory,'usage.json'),'utf8'));assert.equal(usage.reserved_requests,1);
  await assert.rejects(executeNamespaceConformance(f.packet,f.ports));assert.equal(f.f.calls.length,1);
});
