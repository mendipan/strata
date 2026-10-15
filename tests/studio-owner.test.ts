import nodeTest, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,readFile,writeFile,unlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {BootstrapState,browserOwnerConfigSchema} from '../src/explorer/bootstrap-state.js';
import {hostedConfigSchema} from '../scripts/studio-host.js';
import {OwnerAccess} from '../src/explorer/owner-access.js';
import {armControl,publishControl} from '../src/explorer/bootstrap-control.js';
import {approvePending,inspectCompletion,sealCompletion,closeControl,inspectPending,inspectLeases,reconcileOwnerLease,resumePreparedEnrollment} from '../scripts/studio-owner-control.js';
import {startExplorer} from '../src/explorer/host.js';
import {ExplorerReader} from '../src/explorer/read.js';
import {TestSource,sample} from './explorer-fixture.js';
import {digest} from '../src/explorer/owner-files.js';
import {PasswordWork,ownerPassword} from '../src/explorer/owner-password.js';
const origin='https://studio.example.test',password='Synthetic only password — 2026';
const test=(name:string,fn:(t:TestContext)=>void|Promise<void>)=>nodeTest(name,{skip:process.platform!=='win32'&&process.getuid?.()!==0?'Protected root-control fixtures require root on Linux.':false},fn);
async function fixture(){
  const parent=await mkdtemp(path.join(process.platform==='win32'?tmpdir():'/run','strata-owner-fixture-'));await chmod(parent,0o700);
  const config={control_file:path.join(parent,'control.json'),state_directory:path.join(parent,'state'),key_directory:path.join(parent,'keys'),credential_directory:path.join(parent,'credentials')};
  let now=Date.now(),control=armControl(origin,randomUUID(),now),count=0;
  await publishControl(config.control_file,control);const state=new BootstrapState(config,origin,()=>now);await state.readyDirectories();
  const access=new OwnerAccess(state,{publicOrigin:origin,trustedProxyAddresses:['127.0.0.1']},()=>now,{tester:async()=>{count++;return {outcome:'passed',verified_at:new Date(now).toISOString()};}});
  const reader=new ExplorerReader(new TestSource(await sample()));const server=await startExplorer(reader,{assets:path.resolve('explorer'),owner:access});
  const browser=()=>{
    const cookies=new Map<string,string>();
    const send=(url:string,method='GET',input?:unknown,csrf?:string,extra:Record<string,string>={})=>new Promise<{status:number;data:any;text:string;headers:any}>((resolve,reject)=>{
      const req=request(server.origin+url,{method,headers:{host:'studio.example.test','x-forwarded-proto':'https',...(method==='POST'?{origin,'content-type':'application/json'}:{}),...(csrf?{'x-studio-csrf':csrf}:{}),cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...extra}},res=>{for(const raw of res.headers['set-cookie']??[]){const [pair]=raw.split(';'),i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode!,data,text,headers:res.headers});});});req.on('error',reject);req.end(input===undefined?undefined:JSON.stringify(input));
    });return {send,cookies};
  };
  const b=browser();
  const start=async()=>{const s=await b.send('/studio/setup');const p=await b.send('/studio/setup/request','POST',{request_id:randomUUID(),expected_generation:s.data.generation},s.data.csrf);assert.equal(p.status,200,p.text);return p.data;};
  const approve=async(code:string)=>{control=await approvePending(config,control,code,now);await publishControl(config.control_file,control);return (await b.send('/studio/setup')).data;};
  const seal=async()=>{const receipt=await inspectCompletion(config);control=await sealCompletion(config,control,receipt.binding,now);await publishControl(config.control_file,control);return receipt;};
  const enroll=async()=>{const p=await start(),s=await approve(p.request.code);const input={request_id:randomUUID(),expected_generation:s.generation,username:'Fixture.Owner',password,key_storage_policy:'host-bound'};const r=await b.send('/studio/setup/complete','POST',input,s.csrf);assert.equal(r.status,202,r.text);await seal();return input;};
  const login=async()=>{const s=await b.send('/studio/owner/session');const r=await b.send('/studio/owner/login','POST',{username:'fixture.owner',password},s.data.csrf);assert.equal(r.status,200,r.text);return r.data;};
  return {config,state,access,server,b,browser,start,approve,seal,enroll,login,get control(){return control;},get now(){return now;},setControl:async(next:typeof control)=>{control=next;await publishControl(config.control_file,next);},advance:(ms:number)=>{now+=ms;},count:()=>count};
}
test('browser binding, independent seal, owner sign-in, masked credential CAS/replay and restart',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const other=f.browser(),p=await f.start();
  assert.equal((await f.b.send('/studio/setup/complete','POST',{request_id:randomUUID(),expected_generation:0,username:'fixture.owner',password,key_storage_policy:'host-bound'},p.csrf)).status,403);
  const approved=await f.approve(p.request.code);
  assert.equal((await other.send('/studio/setup')).data.state,'disabled');
  const input={request_id:randomUUID(),expected_generation:approved.generation,username:'Fixture.Owner',password,key_storage_policy:'host-bound'};
  const created=await f.b.send('/studio/setup/complete','POST',input,approved.csrf);assert.equal(created.status,202,created.text);
  const session=await f.b.send('/studio/owner/session');assert.equal(session.data.authenticated,false);assert.equal(session.data.configured,false);
  assert.equal((await f.b.send('/studio/setup/outcome')).data.state,'finishing');assert.equal((await f.b.send('/studio/v1/owner/credentials')).status,401);
  const receipt=await f.seal();assert.equal((await f.b.send('/studio/setup/outcome')).data.state,'complete');assert.equal((await f.b.send('/studio/owner/session')).data.authenticated,false);
  const login=await f.login();assert.match(f.b.cookies.get('__Host-strata_owner')!,/^[A-Za-z0-9_-]{43}$/);
  let status=await f.b.send('/studio/v1/owner/credentials');assert.equal(status.data.revision,0);assert.equal(status.data.management.authorization,'owner-session');
  const action={action:'save',credential_id:'artifacts-api-token',revision:0,request_id:randomUUID(),value:'synthetic-provider-token-only'};
  const saved=await f.b.send('/studio/v1/owner/credentials','POST',action,login.csrf);assert.equal(saved.status,200,saved.text);assert.equal(saved.data.revision,1);assert.ok(!saved.text.includes(action.value));assert.equal(f.count(),0);
  assert.equal((await f.b.send('/studio/v1/owner/credentials','POST',action,login.csrf)).data.replayed,true);
  assert.equal((await f.b.send('/studio/v1/owner/credentials','POST',{...action,value:'different'},login.csrf)).status,409);
  assert.equal((await f.b.send('/studio/v1/operation','POST',{},login.csrf)).status,403);
  assert.equal((await f.b.send('/studio/v1/credentials')).status,404);
  const restarted=new BootstrapState(f.config,origin);assert.equal((await restarted.owner())!.manifest.key_id,receipt.binding.key_id);assert.equal((await restarted.store((await restarted.owner())!.manifest).status()).revision,1);
  f.access.clear();assert.equal((await f.b.send('/studio/v1/owner/credentials')).status,401);
});
test('expiry, Origin, CSRF, query/body bounds and another browser cannot claim setup',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const p=await f.start();await f.approve(p.request.code);
  const body={request_id:randomUUID(),expected_generation:f.control.control_generation,username:'fixture.owner',password,key_storage_policy:'host-bound'};
  assert.equal((await f.b.send('/studio/setup/complete','POST',body,'wrong')).status,403);
  assert.equal((await f.b.send('/studio/setup/complete','POST',body,p.csrf,{origin:'https://evil.example.test'})).status,403);
  assert.equal((await f.b.send('/studio/setup?code='+p.request.code)).status,400);
  assert.equal((await f.b.send('/studio/setup/complete','POST',{...body,password:'x'.repeat(1500)},p.csrf)).status,413);
  assert.equal((await f.browser().send('/studio/setup/complete','POST',body,p.csrf)).status,403);
  f.advance(11*60_000);assert.equal((await f.b.send('/studio/setup/complete','POST',body,p.csrf)).data.error.code,'SETUP_EXPIRED');
  assert.equal((await f.state.owner()),undefined);
});
test('prepared exact resume preserves key, changed input conflicts and sealed file loss cannot reenroll',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const input=await f.enroll(),active=JSON.parse(await readFile(path.join(f.config.state_directory,'active.json'),'utf8'));
  const keyfile=path.join(f.config.key_directory,active.key_id+'.json'),key=await readFile(keyfile,'utf8');
  await unlink(keyfile);assert.equal((await f.b.send('/studio/setup')).data.state,'recovery-required');
  assert.equal((await f.b.send('/studio/setup/request','POST',{request_id:randomUUID(),expected_generation:f.control.control_generation},(await f.b.send('/studio/setup')).data.csrf)).status,403);
  await writeFile(keyfile,key,{mode:0o600});await unlink(path.join(f.config.state_directory,'active.json'));
  assert.equal((await f.b.send('/studio/setup')).data.state,'recovery-required');
  assert.ok((await readdir(f.config.key_directory)).length===1);assert.ok(input.request_id);
});
test('freshness and authentication generation revoke writes without losing saved token',async t=>{
  const f=await fixture();t.after(()=>f.server.close());await f.enroll();let s=await f.login();
  const saved=await f.b.send('/studio/v1/owner/credentials','POST',{action:'save',credential_id:'artifacts-api-token',revision:0,request_id:randomUUID(),value:'synthetic-saved-token'},s.csrf);assert.equal(saved.status,200,saved.text);
  f.advance(5*60_000);assert.equal((await f.b.send('/studio/v1/owner/credentials','POST',{action:'remove',credential_id:'artifacts-api-token',revision:1,request_id:randomUUID()},s.csrf)).data.error.code,'OWNER_REAUTH_REQUIRED');
  const oldCookie=f.b.cookies.get('__Host-strata_owner');s=(await f.b.send('/studio/owner/reauth','POST',{password},s.csrf)).data;assert.notEqual(oldCookie,f.b.cookies.get('__Host-strata_owner'));
  const owner=await f.state.owner(),key=owner!.key_id;
  const changed=await f.b.send('/studio/owner/password','POST',{request_id:randomUUID(),expected_generation:1,new_password:'Different synthetic password — 2026'},s.csrf);assert.equal(changed.status,200,changed.text);assert.equal((await f.state.owner())!.key_id,key);assert.equal((await f.state.store(owner!.manifest).status()).revision,1);assert.equal((await f.b.send('/studio/v1/owner/credentials')).status,401);
});
nodeTest('password verifier is salted, normalized, bounded and never a fast password digest',async()=>{
  const work=new PasswordWork(),a=await work.create(password),b=await work.create(password);assert.notEqual(a.salt,b.salt);assert.notEqual(a.hash,digest(password));assert.equal(await work.verify(password,a),true);assert.equal(await work.verify('wrong',a),false);assert.throws(()=>ownerPassword('short'));assert.equal(ownerPassword('é'.repeat(128)), 'é'.repeat(128));
});
test('exact prepared retries keep the DEK; changed password/request conflict',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const p=await f.start(),a=await f.approve(p.request.code),cookie=f.b.cookies.get('__Host-strata_setup')!,input={request_id:randomUUID(),expected_generation:a.generation,username:'fixture.owner',password,key_storage_policy:'host-bound' as const};
  let failed=false;const injected=new BootstrapState(f.config,origin,Date.now,async stage=>{if(stage==='prepared'&&!failed){failed=true;throw new Error('synthetic interruption');}});
  await assert.rejects(()=>injected.complete(digest(cookie),input));
  const keys=await readdir(f.config.key_directory),key=await readFile(path.join(f.config.key_directory,keys[0]),'utf8');
  await assert.rejects(()=>f.state.complete(digest(cookie),{...input,password:'Changed synthetic password value'}),(e:any)=>e.code==='REQUEST_CONFLICT');
  await assert.rejects(()=>f.state.complete(digest(cookie),{...input,request_id:randomUUID()}),(e:any)=>e.code==='REQUEST_CONFLICT');
  await f.state.complete(digest(cookie),input);assert.equal(await readFile(path.join(f.config.key_directory,keys[0]),'utf8'),key);await f.seal();
});
for(const stage of ['reservation','verifier','key','ciphertext'])test('interruption after '+stage+' refuses incomplete preparation without regenerating',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const p=await f.start(),a=await f.approve(p.request.code),cookie=f.b.cookies.get('__Host-strata_setup')!,input={request_id:randomUUID(),expected_generation:a.generation,username:'fixture.owner',password,key_storage_policy:'host-bound' as const};
  const injected=new BootstrapState(f.config,origin,Date.now,async s=>{if(s===stage)throw new Error('synthetic interruption');});await assert.rejects(()=>injected.complete(digest(cookie),input));
  const keys=await readdir(f.config.key_directory);await assert.rejects(()=>f.state.complete(digest(cookie),input),(e:any)=>e.code==='SETUP_RECOVERY_REQUIRED');assert.deepEqual(await readdir(f.config.key_directory),keys);assert.throws(()=>closeControl(f.control));
});
test('approval anchor survives expiry, closure refusal and app evidence loss',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const p=await f.start();await f.approve(p.request.code);assert.throws(()=>closeControl(f.control));f.advance(31*60_000);assert.throws(()=>closeControl(f.control));await unlink(path.join(f.config.state_directory,'pending.json'));
  assert.equal((await f.b.send('/studio/setup')).data.state,'disabled');await assert.rejects(()=>inspectPending(f.config,f.control));assert.equal(f.control.state,'approved');
});
test('new root epoch frees pending capacity and malformed pending is never empty management state',async t=>{
  const f=await fixture();t.after(()=>f.server.close());await f.start();await writeFile(path.join(f.config.state_directory,'pending.json'),'{}');await assert.rejects(()=>inspectPending(f.config,f.control));
  const next={...armControl(origin,f.control.installation_id),control_generation:1};await f.setControl(next);await unlink(path.join(f.config.state_directory,'pending.json'));assert.equal((await f.start()).state,'pending');
});
test('password recovery requires bound purpose/generation and preserves key/ciphertext',async t=>{
  const f=await fixture();t.after(()=>f.server.close());await f.enroll();let login=await f.login();const original=(await f.state.owner())!;
  await f.b.send('/studio/v1/owner/credentials','POST',{action:'save',credential_id:'artifacts-api-token',revision:0,request_id:randomUUID(),value:'synthetic-preserved-token'},login.csrf);
  const ciphertext=await readFile(f.state.store(original.manifest).file,'utf8'),sealed=f.control.owner_binding;
  const recovery={...armControl(origin,f.control.installation_id),control_generation:f.control.control_generation+1,purpose:'recover-owner-password' as const,expected_owner_generation:1,owner_binding:sealed,recovery:{owner_id:original.owner_id,authentication_generation:1}};await f.setControl(recovery);
  const p=await f.start(),a=await f.approve(p.request.code),input={request_id:randomUUID(),expected_generation:a.generation,expected_authentication_generation:1,new_password:'Recovered synthetic password value'};
  const wrong=await f.b.send('/studio/setup/recover','POST',{...input,expected_authentication_generation:2},a.csrf);assert.equal(wrong.status,409);
  assert.equal((await f.b.send('/studio/setup/recover','POST',input,a.csrf)).status,200);
  assert.equal((await f.b.send('/studio/setup/recover','POST',input,a.csrf)).status,200);
  const current=(await f.state.owner())!;assert.equal(current.key_id,original.key_id);assert.equal(current.authentication_generation,2);assert.equal(await readFile(f.state.store(current.manifest).file,'utf8'),ciphertext);assert.deepEqual(f.control.owner_binding,sealed);assert.equal((await f.b.send('/studio/v1/owner/credentials')).status,401);
});
test('repeated creation ID returns the original bound request and cannot reserve another slot',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const initial=(await f.b.send('/studio/setup')).data,input={request_id:randomUUID(),expected_generation:initial.generation};
  const first=await f.b.send('/studio/setup/request','POST',input,initial.csrf),second=await f.b.send('/studio/setup/request','POST',input,initial.csrf);assert.equal(second.status,200);assert.equal(second.data.request.code,first.data.request.code);assert.equal((await inspectPending(f.config,f.control)).length,1);
  const other=f.browser(),pre=(await other.send('/studio/setup')).data;assert.equal((await other.send('/studio/setup/request','POST',input,pre.csrf)).status,409);
});
test('concurrent create requests establish one initialization, key and owner only',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const p=await f.start(),a=await f.approve(p.request.code),input={request_id:randomUUID(),expected_generation:a.generation,username:'fixture.owner',password,key_storage_policy:'host-bound'};
  const results=await Promise.all([f.b.send('/studio/setup/complete','POST',input,a.csrf),f.b.send('/studio/setup/complete','POST',input,a.csrf)]);assert.ok(results.some(r=>r.status===202));assert.ok(results.every(r=>[202,409].includes(r.status)));assert.equal((await readdir(f.config.key_directory)).length,1);assert.equal((await readdir(f.config.credential_directory)).length,1);await f.seal();assert.ok(await f.state.owner());
});
test('maximum allowed Unicode password fits the real one-KiB setup route',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const p=await f.start(),a=await f.approve(p.request.code),input={request_id:randomUUID(),expected_generation:a.generation,username:'unicode.owner',password:'🦉'.repeat(128),key_storage_policy:'host-bound'};assert.ok(Buffer.byteLength(JSON.stringify(input))<1024);const result=await f.b.send('/studio/setup/complete','POST',input,a.csrf);assert.equal(result.status,202,result.text);await f.seal();assert.equal(await f.state.passwords.verify(input.password,(await f.state.owner())!.verifier),true);
});
test('KDF serial queue bounds excess work while loaded server status remains responsive',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const operations=[f.state.passwords.create(password),f.state.passwords.create(password),f.state.passwords.create(password)];await assert.rejects(()=>f.state.passwords.create(password),(e:any)=>e.code==='OWNER_BUSY');const started=Date.now(),response=await f.b.send('/studio/setup');assert.equal(response.status,200);assert.ok(Date.now()-started<1500);await Promise.all(operations);
});
test('active leases cannot be cleared and dead exact leases require explicit reconciliation',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const filename=path.join(f.config.state_directory,'.owner.lock'),active=JSON.stringify({format:'strata-owner-lease/1',pid:process.pid});await writeFile(filename,active,{mode:0o600});const inspected=await inspectLeases(f.config,f.control);assert.equal(inspected[0].pid,process.pid);assert.ok(!JSON.stringify(inspected).includes(password));await assert.rejects(()=>reconcileOwnerLease(f.config,process.pid,digest(active)));await unlink(filename);
  const dead=JSON.stringify({format:'strata-owner-lease/1',pid:2147483647});await writeFile(filename,dead,{mode:0o600});await assert.rejects(()=>reconcileOwnerLease(f.config,2147483647,'0'.repeat(64)));assert.equal((await reconcileOwnerLease(f.config,2147483647,digest(dead))).reconciled,true);
});
test('expired unused and approved resume epochs renew only the pinned preparation and preserve all artifacts',async t=>{
  const f=await fixture();t.after(()=>f.server.close());const p=await f.start(),approved=await f.approve(p.request.code),originalCookie=f.b.cookies.get('__Host-strata_setup')!,input={request_id:randomUUID(),expected_generation:approved.generation,username:'fixture.owner',password,key_storage_policy:'host-bound' as const};
  const injected=new BootstrapState(f.config,origin,()=>f.now,async stage=>{if(stage==='prepared')throw new Error('synthetic prepared interruption');});await assert.rejects(()=>injected.complete(digest(originalCookie),input));
  const init=(await inspectPending(f.config,f.control,f.now))[0].reservation.initialization_id,record=JSON.parse(await readFile(path.join(f.config.state_directory,'initial-'+init+'.json'),'utf8')),sha=digest(JSON.stringify(record.manifest)),keyfile=path.join(f.config.key_directory,record.manifest.key_id+'.json'),authfile=path.join(f.config.state_directory,'auth-'+record.manifest.authentication_id+'.json'),store=f.state.store(record.manifest),initial=await Promise.all([readFile(keyfile,'utf8'),readFile(authfile,'utf8'),readFile(store.file,'utf8')]);
  await assert.rejects(()=>resumePreparedEnrollment(f.config,{...f.control,installation_id:randomUUID()},init,sha,f.now));await assert.rejects(()=>resumePreparedEnrollment(f.config,f.control,init,'0'.repeat(64),f.now));
  const lease=path.join(f.config.state_directory,'.owner.lock');await writeFile(lease,JSON.stringify({format:'strata-owner-lease/1',pid:process.pid}),{mode:0o600});await assert.rejects(()=>resumePreparedEnrollment(f.config,f.control,init,sha,f.now));await unlink(lease);
  await f.setControl(await resumePreparedEnrollment(f.config,f.control,init,sha,f.now));const firstEpoch=f.control.enrollment_epoch;f.advance(31*60_000);assert.throws(()=>closeControl(f.control));await f.setControl(await resumePreparedEnrollment(f.config,f.control,init,sha,f.now));assert.notEqual(f.control.enrollment_epoch,firstEpoch);
  const resumed=await f.start();await f.approve(resumed.request.code);f.advance(11*60_000);await assert.rejects(()=>f.state.complete(digest(f.b.cookies.get('__Host-strata_setup')!),{...input,expected_generation:f.control.control_generation}));
  await assert.rejects(()=>resumePreparedEnrollment(f.config,{...f.control,resume:{initialization_id:randomUUID(),initial_manifest_sha256:sha}},init,sha,f.now));await f.setControl(await resumePreparedEnrollment(f.config,f.control,init,sha,f.now));
  const finalPending=await f.start(),finalApproval=await f.approve(finalPending.request.code);await assert.rejects(()=>f.state.complete(digest(originalCookie),{...input,expected_generation:f.control.control_generation}));
  const completed=await f.b.send('/studio/setup/complete','POST',{...input,expected_generation:finalApproval.generation},finalApproval.csrf);assert.equal(completed.status,202,completed.text);await assert.rejects(()=>resumePreparedEnrollment(f.config,f.control,init,sha,f.now));await f.seal();await f.login();
  assert.deepEqual(await Promise.all([readFile(keyfile,'utf8'),readFile(authfile,'utf8'),readFile(store.file,'utf8')]),initial);assert.equal((await f.state.owner())!.key_id,record.manifest.key_id);assert.equal((await readdir(f.config.key_directory)).length,1);assert.equal(f.count(),0);
});
nodeTest('canonical distinct disjoint owner paths are enforced by shared host schema and direct constructor',()=>{
  const base=path.resolve(tmpdir(),'strata-config-boundaries'),config={control_file:path.join(base,'control.json'),state_directory:path.join(base,'owner'),key_directory:path.join(base,'security'),credential_directory:path.join(base,'credentials')},host={format:'strata-studio-host/1',public_origin:origin,trusted_proxy_addresses:['127.0.0.1'],port:4174,browser_owner:config};
  assert.equal(browserOwnerConfigSchema.safeParse(config).success,true);assert.equal(hostedConfigSchema.safeParse(host).success,true);assert.doesNotThrow(()=>new BootstrapState(config,origin));
  const invalid=[{...config,state_directory:path.join(base,'unused')+path.sep+'..'+path.sep+'owner'},{...config,state_directory:'owner'},{...config,state_directory:config.state_directory+path.sep},{...config,key_directory:config.state_directory},{...config,key_directory:path.join(config.state_directory,'keys')},{...config,key_directory:path.join(config.state_directory,'..keys')},{...config,credential_directory:path.join(config.key_directory,'store')},{...config,unexpected:path.join(base,'extra')}];
  for(const value of invalid){assert.equal(browserOwnerConfigSchema.safeParse(value).success,false);assert.equal(hostedConfigSchema.safeParse({...host,browser_owner:value}).success,false);assert.throws(()=>new BootstrapState(value,origin));}
});
