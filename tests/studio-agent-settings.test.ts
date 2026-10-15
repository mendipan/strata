import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, writeFile, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { agentSettingsFixture } from './studio-agent-settings-fixture.js';
import { deferred, agentFixture } from './studio-agent-connection-fixture.js';
import { OwnerAgentClient } from '../src/explorer/agent-client.js';
import { OwnerAgentSettings } from '../src/explorer/agent-settings.js';
const route='/studio/v1/owner/agents';
const errorCode=(code:string)=>(error:any)=>error.code===code;

for(const [kind,revoke,code] of [
  ['source',(f:Awaited<ReturnType<typeof agentSettingsFixture>>)=>f.agent.setSource(undefined),'AGENT_SOURCE_UNCONFIGURED'],
  ['target',(f:Awaited<ReturnType<typeof agentSettingsFixture>>)=>f.agent.setApproval(undefined),'AGENT_APPROVAL_REQUIRED'],
  ['authentication',(f:Awaited<ReturnType<typeof agentSettingsFixture>>)=>f.agent.setMetadata(undefined),'AGENT_AUTH_UNCONFIGURED'],
] as const)test('HTTP final owner projection cannot retain revoked '+kind+' discovery',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const login=await f.login();
  for(const action of ['configure','connect']){const status=await f.status();const result=await f.b.send(route,'POST',{action,revision:status.data.revision,request_id:randomUUID(),...(action==='configure'?{target_profile_id:'synthetic'}:{})},login.csrf);assert.equal(result.status,200,result.text);}
  assert.equal((await f.status()).data.connection.runtime_ready,true);
  const originalStatus=f.agentManager.status.bind(f.agentManager),originalOwner=f.bootstrapState.owner.bind(f.bootstrapState),reached=deferred(),release=deferred();let armed=false,gated=false;
  f.agentManager.status=async authority=>{const status=await originalStatus(authority);armed=true;return status;};
  f.bootstrapState.owner=async(...args)=>{if(armed&&!gated){gated=true;reached.resolve();await release.promise;}return originalOwner(...args);};
  const before=f.agent.counts(),response=f.status();let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([reached.promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Final owner projection was not reached')),5000))]);}finally{clearTimeout(timer);}
  revoke(f);f.settings.changed();release.resolve();const returned=await response,fresh=await f.status();
  assert.equal(returned.status,200,returned.text);assert.equal(returned.data.connection.runtime_ready,false);assert.equal(returned.data.connection.current_discovery,null);assert.equal(returned.data.connection.state,'blocked');assert.equal(returned.data.capabilities.test,false);assert.equal(returned.data.capabilities.connect,false);
  assert.equal(fresh.data.management.code,code);assert.deepEqual(f.agent.counts(),before);assert.deepEqual(returned.data.effective,{authoring:false,execution:false,chat:false});assert.equal((await f.agentStore.read()).operations.length,2);assert.equal((await f.agentStore.read()).probe_times.length,1);
});
for(const kind of ['direct lifecycle invalidation','discovery expiry'] as const)test('HTTP final projection rejects '+kind,async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const login=await f.login();for(const action of ['configure','connect'])await f.b.send(route,'POST',{action,revision:(await f.status()).data.revision,request_id:randomUUID(),...(action==='configure'?{target_profile_id:'synthetic'}:{})},login.csrf);
  const originalStatus=f.agentManager.status.bind(f.agentManager),originalOwner=f.bootstrapState.owner.bind(f.bootstrapState);let armed=false,fired=false;
  f.agentManager.status=async authority=>{const result=await originalStatus(authority);armed=true;return result;};
  f.bootstrapState.owner=async(...args)=>{if(armed&&!fired){fired=true;if(kind==='direct lifecycle invalidation'){f.agent.setMetadata(undefined);f.agentManager.changed();}else f.agent.advance(60_001);}return originalOwner(...args);};
  const before=f.agent.counts(),returned=await f.status();assert.equal(fired,true);assert.equal(returned.status,200,returned.text);assert.equal(returned.data.connection.runtime_ready,false);assert.equal(returned.data.connection.current_discovery,null);assert.equal(returned.data.management.code,kind==='discovery expiry'?'AGENT_EXPIRED':'AGENT_CHANGED');assert.deepEqual(f.agent.counts(),before);
});
test('stable recovery identity does not permit owner generation changes during final projection',async()=>{
  const f=await agentFixture(),settings=new OwnerAgentSettings(f.manager,['synthetic']),originalStatus=f.manager.status.bind(f.manager),originalCurrent=f.authority.current.bind(f.authority);let armed=false,fired=false;
  f.manager.status=async authority=>{const status=await originalStatus(authority);armed=true;return status;};f.authority.current=async(...args)=>{if(armed&&!fired){fired=true;f.setOwner({authentication_generation:2});settings.changed();}return originalCurrent(...args);};
  await assert.rejects(settings.status(f.authority),errorCode('OWNER_SESSION_REQUIRED'));assert.equal(fired,true);assert.equal(f.counts().dispatches,0);
});

test('owner agent routes deny anonymous, pre-session and foreign request authority before dispatch',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const input={action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'};
  assert.equal((await f.b.send(route)).status,401);await f.b.send('/studio/owner/session');assert.equal((await f.b.send(route)).status,401);
  const login=await f.login();
  for(const [extra,want]of [[{origin:'https://wrong.example.test'},403],[{'x-studio-csrf':'wrong'},403],[{'content-type':'text/plain'},403],[{authorization:'Bearer asserted-reader'},400]] as const)assert.equal((await f.b.send(route,'POST',input,login.csrf,extra)).status,want);
  assert.equal((await f.b.send(route+'?target=x')).status,400);assert.equal((await f.b.send(route,'PUT',input,login.csrf)).status,405);
  assert.equal((await f.b.send(route,'GET',undefined,undefined,{'content-length':'1'})).status,400);
  assert.equal((await f.b.send(route,'POST',{...input,token:'x'.repeat(1500)},login.csrf)).status,413);
  assert.equal((await f.b.send(route,'POST',{...input,url:'https://unapproved.example.test'},login.csrf)).status,400);
  assert.equal((await f.b.send(route,'POST',{...input,target_profile_id:'not-listed'},login.csrf)).status,403);
  assert.equal((await f.agentStore.read()).revision,0);assert.equal(f.agent.counts().contextLoads,0);assert.equal(f.agent.counts().dispatches,0);
});
test('ordinary owner host returns truthful unconfigured metadata and denies every lifecycle action',async t=>{
  const f=await agentSettingsFixture(false);t.after(()=>f.server.close());const login=await f.login(),status=await f.status();assert.equal(status.status,200);assert.equal(status.data.revision,null);assert.equal(status.data.management.state,'unconfigured');assert.deepEqual(status.data.profiles,[]);assert.ok(Object.values(status.data.capabilities).every(v=>v===false));
  for(const action of ['configure','test','connect','disconnect','remove'])assert.equal((await f.b.send(route,'POST',{action,revision:0,request_id:randomUUID(),...(action==='configure'?{target_profile_id:'synthetic'}:{})},login.csrf)).data.error.code,'AGENT_TARGET_UNCONFIGURED');
  assert.equal(f.agent.counts().contextLoads,0);assert.equal(f.calls(),0);
});
test('missing protected agent state fails closed without reconstruction or authentication loading',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const session=await f.login(),file=path.join(f.agent.stateDirectory,'state.json');await unlink(file);
  assert.equal((await f.status()).data.error.code,'AGENT_STATE_UNAVAILABLE');assert.equal((await f.b.send(route,'POST',{action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'},session.csrf)).data.error.code,'AGENT_STATE_UNAVAILABLE');
  await assert.rejects(access(file));assert.equal(f.agent.counts().contextLoads,0);assert.equal(f.agent.counts().dispatches,0);
});
test('HTTP final-write failure leaves original pending outcome; retry never redispatches',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const session=await f.login();await f.b.send(route,'POST',{action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'},session.csrf);
  const transaction=f.agentStore.transaction.bind(f.agentStore);let saves=0;
  f.agentStore.transaction=operation=>transaction((state,save)=>operation(state,async()=>{if(++saves===2)throw Error('synthetic final write refusal');await save();}));
  const body={action:'connect',revision:1,request_id:randomUUID()},result=await f.b.send(route,'POST',body,session.csrf);assert.equal(result.status,503);assert.equal((await f.b.send(route+'/operations/'+body.request_id)).data.state,'pending');
  assert.equal((await f.b.send(route,'POST',body,session.csrf)).data.error.code,'AGENT_RECOVERY_REQUIRED');assert.equal(f.agent.counts().dispatches,1);assert.equal((await f.status()).data.connection.runtime_ready,false);
});
test('authenticated API configure/test/connect/outcome/replay/disconnect/remove share durable lifecycle',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const login=await f.login();
  const run=async(action:string)=>{const status=await f.status(),body={action,revision:status.data.revision,request_id:randomUUID(),...(action==='configure'?{target_profile_id:'synthetic'}:{})};return {body,result:await f.b.send(route,'POST',body,login.csrf)};};
  await run('configure');assert.equal(f.agent.counts().dispatches,0);assert.equal(f.agent.counts().contextLoads,0);
  const tested=await run('test');assert.equal(tested.result.status,200,tested.result.text);assert.equal(tested.result.data.connection.runtime_ready,false);assert.equal(f.agent.counts().dispatches,1);
  const connected=await run('connect');assert.equal(connected.result.data.connection.runtime_ready,true);assert.deepEqual(connected.result.data.engine_authority.operations,[]);assert.deepEqual(connected.result.data.effective,{authoring:false,execution:false,chat:false});
  const before=f.agent.counts();assert.equal((await f.b.send(route+'/operations/'+connected.body.request_id)).data.state,'completed');assert.equal((await f.b.send(route,'POST',connected.body,login.csrf)).data.replayed,true);assert.deepEqual(f.agent.counts(),before);
  assert.equal((await f.b.send(route,'POST',{...connected.body,revision:connected.body.revision+1},login.csrf)).data.error.code,'REQUEST_CONFLICT');
  const disconnected=await run('disconnect');assert.equal(disconnected.result.data.connection.runtime_ready,false);await run('remove');assert.equal((await f.status()).data.connection,null);assert.equal((await f.agentStore.read()).operations.length,5);assert.equal((await f.agentStore.read()).probe_times.length,2);
});
test('stale CAS and stale freshness refuse changes without dispatch; owner reauthentication is explicit',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());let login=await f.login();const body={action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'};
  await f.b.send(route,'POST',body,login.csrf);assert.equal((await f.b.send(route,'POST',{...body,request_id:randomUUID()},login.csrf)).data.error.code,'AGENT_CHANGED');
  f.agent.advance(5*60_000);assert.equal((await f.b.send(route,'POST',{action:'remove',revision:1,request_id:randomUUID()},login.csrf)).data.error.code,'OWNER_REAUTH_REQUIRED');
  login=(await f.b.send('/studio/owner/reauth','POST',{password:f.password},login.csrf)).data;
  assert.equal((await f.b.send(route,'POST',{action:'remove',revision:1,request_id:randomUUID()},login.csrf)).status,200);assert.equal(f.agent.counts().dispatches,0);
});
test('response loss cancels local discovery wait and retains inspectable terminal receipt',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const login=await f.login();await f.b.send(route,'POST',{action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'},login.csrf);
  const delay=deferred();f.agent.delay(delay.promise);const id=randomUUID();
  const req=request(f.server.origin+route,{method:'POST',headers:{host:'studio.example.test','x-forwarded-proto':'https',origin:f.origin,'content-type':'application/json','x-studio-csrf':login.csrf,cookie:[...f.b.cookies].map(([k,v])=>k+'='+v).join('; ')} });req.on('error',()=>{});req.end(JSON.stringify({action:'connect',revision:1,request_id:id}));await f.agent.started.promise;req.destroy();
  let outcome:any;for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));outcome=await f.b.send(route+'/operations/'+id);if(outcome.data?.state==='failed')break;}
  assert.equal(outcome.data.state,'failed');assert.equal(outcome.data.code,'AGENT_CANCELLED');assert.equal((await f.status()).data.connection.runtime_ready,false);assert.equal(f.agent.counts().dispatches,1);assert.equal((await f.agentStore.read()).probe_times.length,1);delay.resolve();
});
test('logout immediately cancels an in-flight exchange; subsequent session cannot revive it',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const login=await f.login();await f.b.send(route,'POST',{action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'},login.csrf);
  const delay=deferred();f.agent.delay(delay.promise);const id=randomUUID(),waiting=f.b.send(route,'POST',{action:'connect',revision:1,request_id:id},login.csrf);await f.agent.started.promise;
  assert.equal((await f.b.send('/studio/owner/logout','POST',{},login.csrf)).status,200);await waiting;assert.equal((await f.status()).status,401);await f.login();assert.equal((await f.status()).data.connection.runtime_ready,false);assert.equal(f.agent.counts().dispatches,1);delay.resolve();
});
test('password rotation revokes cached discovery and retains history without granting a new probe',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const session=await f.login();await f.b.send(route,'POST',{action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'},session.csrf);await f.b.send(route,'POST',{action:'connect',revision:1,request_id:randomUUID()},session.csrf);assert.equal((await f.status()).data.connection.runtime_ready,true);
  const password='New synthetic owner password 2026';assert.equal((await f.b.send('/studio/owner/password','POST',{request_id:randomUUID(),expected_generation:1,new_password:password},session.csrf)).status,200);assert.equal((await f.status()).status,401);
  const pre=await f.b.send('/studio/owner/session');assert.equal((await f.b.send('/studio/owner/login','POST',{username:'manager.owner',password},pre.data.csrf)).status,200);const status=await f.status();assert.equal(status.data.connection.runtime_ready,false);assert.equal(status.data.connection.last_test.outcome,'passed');assert.equal(f.agent.counts().dispatches,1);assert.equal((await f.agentStore.read()).operations.length,2);
});

test('same owner rotation retains recovery scope and inspection but refuses original-generation replay',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const session=await f.login(),before=(await f.status()).data.reconciliation_scope;
  const body={action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'};assert.equal((await f.b.send(route,'POST',body,session.csrf)).status,200);
  const password='Rotated synthetic receipt password 2026';assert.equal((await f.b.send('/studio/owner/password','POST',{request_id:randomUUID(),expected_generation:1,new_password:password},session.csrf)).status,200);
  const pre=await f.b.send('/studio/owner/session'),login=await f.b.send('/studio/owner/login','POST',{username:'manager.owner',password},pre.data.csrf);assert.equal(login.status,200);
  const after=(await f.status()).data.reconciliation_scope;assert.equal(after.owner,before.owner);assert.equal(after.state,before.state);assert.equal(after.authentication_generation,2);assert.equal(before.authentication_generation,1);
  assert.equal((await f.b.send(route+'/operations/'+body.request_id)).data.state,'completed');const replay=await f.b.send(route,'POST',body,login.data.csrf);assert.equal(replay.status,401,replay.text);assert.equal(replay.data.error.code,'OWNER_SESSION_REQUIRED');
  assert.equal((await f.agentStore.read()).operations.length,1);assert.equal(f.agent.counts().dispatches,0);assert.equal(f.agent.counts().contextLoads,0);
});
test('agent client uses memory-only owner cookies, CSRF and exact actions through real host',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());let posts=0;
  const transport:typeof fetch=async(input,options={})=>{
    const url=new URL(String(input));assert.equal(url.origin,f.origin);if(options.method==='POST'&&url.pathname===route)posts++;
    const result=await new Promise<Response>((resolve,reject)=>{const req=request(f.server.origin+url.pathname,{method:options.method,headers:{...Object.fromEntries(new Headers(options.headers)),host:'studio.example.test','x-forwarded-proto':'https'}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{const headers=new Headers();for(const [key,value]of Object.entries(res.headers))for(const item of Array.isArray(value)?value:[value!])headers.append(key,item);resolve(new Response(text,{status:res.statusCode,headers}));});});req.on('error',reject);req.end(options.body as string|undefined);});return result;
  };
  const client=new OwnerAgentClient(f.origin,transport);await client.login('manager.owner',f.password);assert.equal((await client.status()).revision,0);const body={action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'};await client.action(body);await client.outcome(body.request_id);await client.action(body);assert.equal(posts,2);assert.equal(f.agent.counts().dispatches,0);await client.close();await assert.rejects(client.status(),errorCode('OWNER_SESSION_REQUIRED'));
});
test('client refuses secret/endpoint/unknown-field inputs and redirects without a retry',async()=>{
  let calls=0;const client=new OwnerAgentClient('https://studio.example.test',async()=>{calls++;return new Response('redirect',{status:302,headers:{location:'https://wrong.example.test'}});});
  for(const extra of [{url:'https://wrong.example.test'},{token:'never'},{operation:'approve'}])assert.throws(()=>client.action({action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'p',...extra}),errorCode('INVALID_INPUT'));
  assert.equal(calls,0);await assert.rejects(client.status());assert.equal(calls,1);assert.throws(()=>new OwnerAgentSettings(undefined,['p','p']));
});
test('public CLI dispatch rejects malformed agent flags/actions without password/provider access',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'strata-agent-cli-')),file=path.join(dir,'action.json');await writeFile(file,JSON.stringify({action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'p',secret:'synthetic-denied'}));
  for(const args of [['status','--origin','http://studio.example.test','--username','owner'],['configure','--origin','https://studio.example.test','--username','owner','--file',file],['status','--password','never-allowed']]){
    const result=await new Promise<{code:number|null;text:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--import','./tests/no-external-fetch.mjs','dist/src/cli.js','studio','agents',...args],{stdio:['pipe','pipe','pipe']});let text='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>text+=c);child.on('error',reject);child.on('exit',code=>resolve({code,text}));child.stdin.end();});assert.equal(result.code,1);assert.match(result.text,/INVALID_INPUT/);assert.ok(!result.text.includes('synthetic-denied'));
  }
});
test('real one-shot CLI uses protected stdin and the same owner routes/receipts, with no retained readiness',async t=>{
  const f=await agentSettingsFixture();t.after(()=>f.server.close());const dir=await mkdtemp(path.join(tmpdir(),'strata-agent-cli-parity-'));
  const cli=async(action:string,body?:unknown,id?:string)=>{
    const file=path.join(dir,'public-action.json');if(body)await writeFile(file,JSON.stringify(body));
    const args=['--unhandled-rejections=strict','--import','./tests/no-external-fetch.mjs','--import','./tests/studio-agent-cli-preload.mjs','dist/src/cli.js','studio','agents',action,'--origin',f.origin,'--username','manager.owner','--password-stdin',...(body?['--file',file]:id?['--request-id',id]:[])];
    return new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,args,{env:{...process.env,STRATA_AGENT_CLI_FIXTURE_LOOPBACK:f.server.origin},stdio:['pipe','pipe','pipe']});let out='',error='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('exit',code=>{assert.equal(code,0,error);assert.ok(!out.includes(f.password)&&!error.includes(f.password));resolve(JSON.parse(out));});child.stdin.end(f.password+'\n');});
  };
  assert.equal((await cli('status')).revision,0);const configured={action:'configure',revision:0,request_id:randomUUID(),target_profile_id:'synthetic'};await cli('configure',configured);assert.equal(f.agent.counts().contextLoads,0);
  const connected={action:'connect',revision:1,request_id:randomUUID()},result=await cli('connect',connected);assert.equal(result.outcome.state,'completed');assert.deepEqual(result.client_session,{state:'closed',readiness_retained:false});assert.equal(f.agent.counts().dispatches,1);
  assert.equal((await cli('outcome',undefined,connected.request_id)).state,'completed');await cli('connect',connected);assert.equal(f.agent.counts().dispatches,1);assert.equal((await cli('status')).connection.runtime_ready,false);
  const browser=await f.login(),body={action:'connect',revision:(await f.status()).data.revision,request_id:randomUUID()};await f.b.send(route,'POST',body,browser.csrf);assert.equal((await f.status()).data.connection.runtime_ready,true);
  await cli('status');await cli('outcome',undefined,body.request_id);await cli('connect',body);
  assert.equal((await f.status()).data.connection.runtime_ready,true,'Closing metadata/exact-replay CLI sessions cannot disconnect another owner browser session');assert.equal(f.agent.counts().dispatches,2);
});
