import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startExplorer } from '../src/explorer/host.js';
import { HostedAccess } from '../src/explorer/hosted.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { TestSource, sample } from './explorer-fixture.js';
import { loadHostedConfig } from '../scripts/studio-host.js';

const publicOrigin = 'https://studio.example.test';
const key = Buffer.from(randomBytes(32)).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
const headers = {host:'studio.example.test','x-forwarded-proto':'https'};
async function fixture(configured = true) {
  const source = new TestSource(await sample()), reader = new ExplorerReader(source);
  const server = await startExplorer(reader, {assets:path.resolve('explorer'),hosted:{publicOrigin,trustedProxyAddresses:['127.0.0.1'],accessKeySha256:configured ? hash : undefined}});
  const send = (url: string, method = 'GET', extra: Record<string,string> = {}, body?: string) => new Promise<{status:number; headers:any; text:string; data:any}>((resolve,reject) => {
    const req = request(server.origin + url, {method,headers:{...headers,...(method === 'POST' ? {origin:publicOrigin,'content-type':'application/json'} : {}),...extra}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => {let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode!,headers:res.headers,text,data});});
    }); req.once('error',reject); req.end(body);
  });
  const login = async (cookie?: string) => {
    const response = await send('/studio/login','POST',cookie ? {cookie} : {},JSON.stringify({access_key:key}));
    assert.equal(response.status,200);
    return {cookie:response.headers['set-cookie'][0].split(';')[0],csrf:response.data.csrf,response};
  };
  return {source,reader,server,send,login};
}
test('hosted mode requires exact proxy, HTTPS Host/Origin and no forwarding chain before source reads',async()=>{
  const f=await fixture();try{
    const deniedHeaders: Record<string,string>[] = [{host:'foreign.test'},{'x-forwarded-proto':'http'},{origin:'null'},{origin:'https://foreign.test'},{'sec-fetch-site':'cross-site'},{'x-forwarded-for':'127.0.0.1'},{'x-forwarded-host':'studio.example.test'},{forwarded:'for=127.0.0.1'},{'x-real-ip':'127.0.0.1'}];
    for(const extra of deniedHeaders) assert.equal((await f.send('/studio/session','GET',extra)).status,403);
    assert.equal((await fetch(f.server.origin + '/')).status,403);
    assert.equal(f.source.calls,0);
    const untrusted = new HostedAccess({publicOrigin,trustedProxyAddresses:['192.0.2.10'],accessKeySha256:hash});
    assert.throws(()=>untrusted.boundary({socket:{remoteAddress:'127.0.0.1'},headers} as any),/configured HTTPS proxy/);
    for(const options of [{publicOrigin:'http://studio.example.test',trustedProxyAddresses:['127.0.0.1']},{publicOrigin, trustedProxyAddresses:[]},{publicOrigin, trustedProxyAddresses:['0.0.0.0/0']},{publicOrigin, trustedProxyAddresses:['127.0.0.1'],sessionMs:9*60*60*1000}]) assert.throws(()=>new HostedAccess(options));
  }finally{await f.server.close();}
});
test('unconfigured hosted service serves secret-free static shell and denies every data/settings route',async()=>{
  const f=await fixture(false);try{
    assert.equal(f.server.capability,'');assert.equal(f.server.launchUrl,publicOrigin+'/');
    const status=await f.send('/studio/session');assert.equal(status.data.configured,false);assert.equal(status.data.csrf,null);
    for(const url of ['/explorer/v1/connection','/explorer/v1/settings','/studio/v1/records?type=release']) assert.equal((await f.send(url)).status,503);
    assert.equal((await f.send('/studio/login','POST',{},JSON.stringify({access_key:key}))).status,503);
    for(const url of ['/','/app.js','/session.js','/style.css']){const r=await f.send(url);assert.equal(r.status,200);assert.ok(!r.text.includes(key));assert.ok(!r.text.includes(hash));}
    assert.equal((await f.send('/sample-records.json')).status,404);assert.equal((await f.send('/src/explorer/hosted.ts')).status,404);
    assert.equal(f.source.calls,0);
  }finally{await f.server.close();}
});
test('protected login uses secure opaque cookie, bounded attempts, session rotation and POST CSRF',async()=>{
  const f=await fixture();try{
    assert.equal((await f.send('/explorer/v1/settings')).status,401);
    assert.equal((await f.send('/studio/login','POST',{origin:'https://foreign.test'},JSON.stringify({access_key:key}))).status,403);
    assert.equal((await f.send('/studio/login?access_key='+key,'POST',{},'{}')).status,400);
    assert.equal((await f.send('/studio/login','POST',{},JSON.stringify({access_key:key,principal:'owner'}))).status,400);
    assert.equal((await f.send('/studio/login','POST',{},JSON.stringify({access_key:'x'.repeat(43)}))).status,401);
    const session=await f.login();assert.match(session.response.headers['set-cookie'][0],/Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800/);
    assert.ok(!session.response.text.includes(key));assert.ok(!session.response.text.includes(hash));assert.ok(!session.response.text.includes(session.cookie));
    assert.equal((await f.send('/studio/session','GET',{cookie:session.cookie})).data.csrf,session.csrf);
    assert.equal((await f.send('/explorer/v1/settings','GET',{cookie:session.cookie})).status,200);
    assert.equal((await f.send('/studio/v1/settings','GET',{cookie:session.cookie})).status,200);
    assert.equal((await f.send('/explorer/v1/settings','GET',{cookie:session.cookie,authorization:'Bearer preview'})).status,401);
    assert.equal((await f.send('/explorer/v1/refresh','POST',{cookie:session.cookie},'{}')).status,403);assert.equal(f.source.calls,0);
    assert.equal((await f.send('/explorer/v1/refresh','POST',{cookie:session.cookie,'x-studio-csrf':session.csrf},'{}')).status,200);assert.equal(f.source.calls,1);
    assert.equal((await f.send('/v1/operation','POST',{cookie:session.cookie,'x-studio-csrf':session.csrf},'{}')).status,404);
    const replacement=await f.login(session.cookie);assert.notEqual(replacement.cookie,session.cookie);
    assert.equal((await f.send('/explorer/v1/settings','GET',{cookie:session.cookie})).status,401);
    assert.equal((await f.send('/studio/logout','POST',{cookie:replacement.cookie},'{}')).status,403);
    assert.equal((await f.send('/studio/logout','POST',{cookie:replacement.cookie,'x-studio-csrf':replacement.csrf},'{}')).status,200);
    assert.equal((await f.send('/explorer/v1/settings','GET',{cookie:replacement.cookie})).status,401);
    for(let i=0;i<12;i++) await f.send('/studio/login','POST',{},JSON.stringify({access_key:'x'.repeat(43)}));
    assert.equal((await f.send('/studio/login','POST',{},JSON.stringify({access_key:key}))).status,429);
  }finally{await f.server.close();}
});
test('idle and absolute expiry are independent; restart clears sessions',()=>{
  let now=1000;const access=new HostedAccess({publicOrigin,trustedProxyAddresses:['127.0.0.1'],accessKeySha256:hash,sessionMs:1000,idleMs:100},()=>now);
  const response={setHeader(_name:string,value:string){this.cookie=value.split(';')[0];},cookie:''};
  const request={headers:{},method:'POST'} as any;
  access.login(request,response as any,{access_key:key});const auth={headers:{cookie:response.cookie},method:'GET'} as any;
  now=1090;access.require(auth);now=1180;access.require(auth);now=1281;assert.throws(()=>access.require(auth),/Sign in/);
  now=2000;access.login(request,response as any,{access_key:key});auth.headers.cookie=response.cookie;
  for(now=2090;now<3000;now+=90)access.require(auth);now=3000;assert.throws(()=>access.require(auth),/Sign in/);
  access.login(request,response as any,{access_key:key});auth.headers.cookie=response.cookie;access.clear();assert.throws(()=>access.require(auth),/Sign in/);
});
test('hosted owner config rejects token/endpoint/grant fields and requires private key hash and repository pin',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'studio-config-')),filename=path.join(directory,'host.json'),hashfile=path.join(directory,'access.sha256');
  const config={format:'strata-studio-host/1',public_origin:publicOrigin,trusted_proxy_addresses:['127.0.0.1'],port:4174};
  await writeFile(filename,JSON.stringify({...config,api_key:key}));await assert.rejects(loadHostedConfig(filename));
  await writeFile(filename,JSON.stringify({...config,connection_config:path.join(directory,'connection.json')}));await assert.rejects(loadHostedConfig(filename));
  await writeFile(hashfile,hash+'\n',{mode:0o600});await chmod(hashfile,0o600);
  await writeFile(filename,JSON.stringify({...config,access_key_hash_file:hashfile}));assert.equal((await loadHostedConfig(filename)).accessKeySha256,hash);
  if(process.platform!=='win32'){await chmod(hashfile,0o644);await assert.rejects(loadHostedConfig(filename));}
});
