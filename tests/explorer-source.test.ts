import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bytesDigest, canonical } from '../src/model.js';
import { admitRegistry, RegistrySource, RestArtifactsReader, trustedFile, loadConfig, readRegistryFile } from '../src/explorer/source.js';
import { ExplorerError, safeJson } from '../src/explorer/contract.js';
import { config, registry, sample } from './explorer-fixture.js';
const code=(expected:string)=>(e:any)=>e.code===expected;
async function restFixture(){const c=config(),records=await sample(),index=registry(records,c),files=new Map(Object.values(records).map(r=>{const text=canonical(r.data);return[bytesDigest(text)+'.json',text];})),calls:{url:string;init:any}[]=[];let credentialCalls=0;
 const transport:typeof fetch=async(input,init)=>{const url=String(input);calls.push({url,init});assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.equal((init!.headers as any).authorization,'Bearer synthetic-test-only-never-live');assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+c.storage.account+'/artifacts/namespaces/synthetic/repos/synthetic-booking'));
 if(url.includes('/file?')){const u=new URL(url);assert.equal(u.searchParams.get('ref'),'f'.repeat(40));const file=files.get(u.searchParams.get('path')!);return file===undefined?new Response(null,{status:404}):new Response(file);}
 return Response.json({success:true,result:{name:c.storage.repository,remote:`https://${c.storage.account}.artifacts.cloudflare.net/git/${c.storage.namespace}/${c.storage.repository}.git`}});};
 const port=new RestArtifactsReader(c,async()=>{credentialCalls++;return'synthetic-test-only-never-live';},transport);const source=new RegistrySource(c,port,async()=>canonical(index),()=>port.assertAuthorized());return {c,records,index,files,calls,port,source,credentialCalls:()=>credentialCalls};}
test('documented REST exact-file path integrates genuine byte/hash verification with trusted registry; dispatch surface is GET only',async()=>{
 const f=await restFixture(),before=canonical(f.index),result=await f.source.load();assert.equal(canonical(result.records),canonical(f.records));assert.equal(result.source.mode,'artifacts-remote');assert.equal(result.source.freshness,'fixed-snapshot');assert.equal(f.calls.length,15);assert.ok(f.calls.every(c=>c.init.method==='GET' && !/token|push|receive-pack|log\?/.test(c.url)));assert.equal(canonical(f.index),before);assert.equal(f.credentialCalls(),15);
});
test('binding, complete locator envelope and total declared-byte admission fail before credential or transport dispatch',async()=>{
 for(const change of [(f:any)=>f.index.storage.project_id='foreign',(f:any)=>f.index.entries['R0@1'].locator.ref='main',(f:any)=>f.index.entries['R0@1'].locator.path='../secret.json',(f:any)=>f.index.entries['R0@1'].locator.hash='0'.repeat(64),(f:any)=>f.index.entries['R0@1'].locator.size_bytes=9*1024*1024]){const f=await restFixture();change(f);await assert.rejects(f.source.load());assert.equal(f.calls.length,0);assert.equal(f.credentialCalls(),0);}
 const f=await restFixture();const entry=f.index.entries['R0@1'];for(let i=0;i<3;i++)f.index.entries['Large-'+i+'@1']={...entry,locator:{...entry.locator,size_bytes:8*1024*1024}};await assert.rejects(f.source.load(),code('READ_LIMIT'));assert.equal(f.calls.length,0);
});
test('missing, corrupt and noncanonical bytes refuse complete generation; no sample fallback exists',async()=>{
 for(const mutation of ['missing','corrupt','noncanonical']){const f=await restFixture();const entry=f.index.entries['R0@1'];if(mutation==='missing')f.files.delete(entry.locator.path);else if(mutation==='corrupt')f.files.set(entry.locator.path,'{}');else {const text=JSON.stringify(f.records['R0@1'].data,null,2),hash=bytesDigest(text);f.files.set(hash+'.json',text);entry.hash=hash;entry.locator={ref:'f'.repeat(40),path:hash+'.json',hash,size_bytes:Buffer.byteLength(text)};}await assert.rejects(f.source.load(),code('CORRUPT_DATA'));}
});
test('provider auth/binding errors are sanitized and redirects cannot forward credentials',async()=>{
 for(const status of [401,403,302]){const c=config(),calls:any[]=[];const port=new RestArtifactsReader(c,async()=>'synthetic-secret',async(url,init)=>{calls.push([url,init]);return new Response('private provider body should not leak',{status,headers:{location:'https://evil.invalid'}});});await assert.rejects(port.getManyAt([]),(e:any)=>{assert.ok(!e.message.includes('private'));return e.code===(status===302?'SOURCE_UNAVAILABLE':'SOURCE_AUTH');});assert.equal(calls.length,1);assert.equal(calls[0][1].redirect,'manual');}
 const c=config(),port=new RestArtifactsReader(c,async()=>'synthetic-secret',async()=>Response.json({success:true,result:{name:'foreign',remote:'https://evil.invalid'}}));await assert.rejects(port.getManyAt([]),code('SOURCE_BINDING'));
});
test('expired or exhausted grant refuses before credentials; byte and request budgets accumulate across refresh',async()=>{
 const f=await restFixture();f.c.read_authorization.expires_at='2000-01-01T00:00:00Z';await assert.rejects(f.source.load(),code('SOURCE_AUTH'));assert.equal(f.credentialCalls(),0);
 const g=await restFixture();g.c.read_authorization.max_requests=1;await assert.rejects(g.source.load(),code('READ_SESSION_LIMIT'));assert.equal(g.calls.length,1);
 const h=await restFixture();h.c.read_authorization.max_bytes=1;await assert.rejects(h.source.load(),code('READ_SESSION_LIMIT'));assert.equal(h.credentialCalls(),0);
});
test('untrusted legacy prose is retained as data; prototype keys/depth limits and explicit foreign project records fail closed',async()=>{
 assert.throws(()=>safeJson('{"__proto__":{"secret":true}}'),code('CORRUPT_DATA'));assert.throws(()=>safeJson('['.repeat(40)+'0'+']'.repeat(40)),code('READ_LIMIT'));
 const f=await restFixture();f.records['L-hold@1'].data.intent='<script>fetch("https://evil.invalid")</script> javascript:evil';const text=canonical(f.records['L-hold@1'].data),hash=bytesDigest(text);f.index.entries['L-hold@1'].hash=hash;f.index.entries['L-hold@1'].locator={ref:'f'.repeat(40),path:hash+'.json',hash,size_bytes:Buffer.byteLength(text)};f.files.set(hash+'.json',text);assert.equal((await f.source.load()).records['L-hold@1'].data.intent,f.records['L-hold@1'].data.intent);
 const g=await restFixture();const r=Object.entries(g.records).find(([,r])=>r.type==='validation')!;r[1].data.project_id='foreign';const text2=canonical(r[1].data),hash2=bytesDigest(text2);g.index.entries[r[0]].hash=hash2;g.index.entries[r[0]].locator={ref:'f'.repeat(40),path:hash2+'.json',hash:hash2,size_bytes:Buffer.byteLength(text2)};g.files.set(hash2+'.json',text2);await assert.rejects(g.source.load(),code('CORRUPT_DATA'));
});
test('trusted file reader and config loader are read-only and refuse relative paths and link traversal',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'explorer-file-test-')),file=path.join(dir,'registry.json');await writeFile(file,'{}');assert.equal(await trustedFile(file,1024),'{}');assert.equal(await readFile(file,'utf8'),'{}');await assert.rejects(trustedFile('relative.json',1024),code('SOURCE_BINDING'));
 const cfg=config();cfg.registry_path=file;const configFile=path.join(dir,'connection.json');await writeFile(configFile,canonical(cfg));assert.equal((await loadConfig(configFile)).project_id,'explorer-sample');
 const linked=path.join(dir,'link');await symlink(dir,linked,'junction');await assert.rejects(trustedFile(path.join(linked,'registry.json'),1024));
});
test('unsupported registry types and narrowed authorization operations fail before any credential read',async()=>{
 const f=await restFixture();f.index.entries['R0@1'].type='unsupported';await assert.rejects(f.source.load(),code('CORRUPT_DATA'));assert.equal(f.credentialCalls(),0);
 const g=await restFixture();(g.c.read_authorization.operations as any) = ['repository.info','file.write'];await assert.rejects(g.source.load(),code('SOURCE_AUTH'));assert.equal(g.credentialCalls(),0);
});
test('active registries require matching descriptors; fixed exports and inactive recovery markers never create or mutate state',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'explorer-descriptor-test-')),c=config();c.registry_path=path.join(dir,'registry.json');await writeFile(c.registry_path,'{}');assert.equal(await readRegistryFile(c),'{}');
 c.registry_kind='atomic-publication-index';await assert.rejects(readRegistryFile(c));
 const descriptor=path.join(dir,'node-state.json');await writeFile(descriptor,canonical({format:'strata-node-state/1',model_version:c.model_version,project_id:c.project_id}));assert.equal(await readRegistryFile(c),'{}');
 const before=await readFile(descriptor,'utf8');await writeFile(path.join(dir,'RECOVERY_INACTIVE.json'),'{}');await assert.rejects(readRegistryFile(c),code('SOURCE_BINDING'));assert.equal(await readFile(descriptor,'utf8'),before);
});
