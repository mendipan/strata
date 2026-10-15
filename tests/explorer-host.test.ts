import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { request } from 'node:http';
import { startExplorer } from '../src/explorer/host.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { sample, TestSource } from './explorer-fixture.js';
async function host(){const source=new TestSource(await sample()),reader=new ExplorerReader(source);await reader.refresh();const server=await startExplorer(reader,{assets:path.resolve('explorer')});const auth={authorization:'Bearer '+server.capability};return {source,reader,server,auth};}
test('loopback host requires capability, exact origin and positive route/method/key allowlists before project access',async()=>{
 const f=await host();try{
  for(const [url,init,status] of [
   ['/explorer/v1/connection',{},401],['/explorer/v1/connection',{headers:{...f.auth,origin:'https://evil.invalid'}},403],['/explorer/v1/connection',{headers:{...f.auth,origin:'null'}},403],['/explorer/v1/connection',{headers:{...f.auth,'sec-fetch-site':'cross-site'}},403],['/v1/operation',{method:'POST',headers:f.auth},404],['/explorer/v1/record?type=layer&ref=L-hold%401&project_id=foreign',{headers:f.auth},400],['/explorer/v1/connection',{method:'POST',headers:f.auth},405],['/explorer/v1/connection?identity=fixture-bootstrap',{headers:f.auth},400],['/explorer/v1/records?type=layer&type=release',{headers:f.auth},400]
  ] as [string,RequestInit,number][]){const response=await fetch(f.server.origin+url,init);assert.equal(response.status,status,url);assert.ok(!(await response.text()).includes('600 seconds'));}
  const wrongHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(f.server.origin+'/explorer/v1/connection',{headers:{...f.auth,host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.once('error',reject);req.end();});assert.equal(wrongHost,403);
  assert.equal(f.source.calls,1);const r=await fetch(f.server.origin+'/explorer/v1/connection',{headers:f.auth});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy')!,/frame-ancestors 'none'/);const data:any=await r.json();assert.equal(data.data.ready,true);assert.equal(data.source.mode,'sample');assert.ok(!JSON.stringify(data).includes(f.server.capability));
 }finally{await f.server.close();}
});
test('static shell and assets contain no project record/capability; traversal and unknown files are refused',async()=>{
 const f=await host();try{const response=await fetch(f.server.origin+'/');const text=await response.text();assert.equal(response.status,200);assert.ok(!text.includes('600 seconds'));assert.ok(!text.includes(f.server.capability));assert.equal((await fetch(f.server.origin+'/sample-records.json')).status,404);assert.equal((await fetch(f.server.origin+'/src/explorer/source.ts')).status,404);}finally{await f.server.close();}
});
test('refresh accepts only explicit empty JSON from same origin and cannot accept write/provider/options fields',async()=>{
 const f=await host();try{const request=(body:string,extra={})=>fetch(f.server.origin+'/explorer/v1/refresh',{method:'POST',headers:{...f.auth,origin:f.server.origin,'content-type':'application/json',...extra},body});
 assert.equal((await request('{"command":"release"}')).status,400);assert.equal((await request('[]')).status,400);assert.equal((await request('x'.repeat(1025))).status,413);assert.equal((await request('{}',{origin:'https://evil.invalid'})).status,403);assert.equal(f.source.calls,1);assert.equal((await request('{}')).status,200);assert.equal(f.source.calls,2);
 }finally{await f.server.close();}
});
test('expired local session clears access even when source generation remains valid',async()=>{
 const source=new TestSource(await sample()),reader=new ExplorerReader(source);await reader.refresh();const server=await startExplorer(reader,{assets:path.resolve('explorer'),sessionMs:1});try{await new Promise(resolve=>setTimeout(resolve,5));assert.equal((await fetch(server.origin+'/explorer/v1/connection',{headers:{authorization:'Bearer '+server.capability}})).status,401);}finally{await server.close();}
});
