import test,{type TestContext} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {managerHostFixture} from './studio-manager-host-fixture.js';
const guarded=(name:string,fn:(t:TestContext)=>Promise<void>)=>test(name,{skip:process.platform!=='win32'&&process.getuid?.()!==0},fn);
guarded('managed owner API authenticates before routes, validates Origin/CSRF/body and refuses legacy bypass',async(t:any)=>{
  const f=await managerHostFixture();t.after(()=>f.server.close());const route='/studio/v1/owner/connections',other=f.browser();assert.equal((await other.send(route)).status,401);
  const login=await f.login(),body={action:'create',revision:0,request_id:randomUUID(),profile_id:'approved',ticket_id:f.policy.tickets[0].ticket_id,label:'Source'};
  assert.equal((await f.b.send(route,'POST',body,'wrong')).status,403);assert.equal((await f.b.send(route,'POST',body,login.csrf,{origin:'https://evil.example.test'})).status,403);assert.equal((await f.b.send(route+'?x=1')).status,400);assert.equal((await f.b.send(route,'POST',{...body,label:'x'.repeat(1500)},login.csrf)).status,413);assert.equal(f.calls(),0);
  const result=await f.b.send(route,'POST',body,login.csrf);assert.equal(result.status,200,result.text);assert.equal((await f.b.send('/explorer/v1/settings','POST',{action:'connect',connection_id:'bad',revision:0},login.csrf)).status,403);assert.equal((await f.b.send('/explorer/v1/refresh','POST',{},login.csrf)).status,403);
  const outcome=await f.b.send(route+'/operations/'+body.request_id);assert.equal(outcome.status,200);assert.equal(outcome.data.state,'completed');assert.equal(f.calls(),0);assert.ok(!result.text.includes(f.password));
});
guarded('real host cached read refuses removed source policy while owner session stays authenticated',async(t:any)=>{
  const f=await managerHostFixture();t.after(()=>f.server.close());const login=await f.login(),route='/studio/v1/owner/connections';let result=await f.b.send(route,'POST',{action:'create',revision:0,request_id:randomUUID(),profile_id:'approved',ticket_id:f.policy.tickets[0].ticket_id,label:'Source'},login.csrf);const id=result.data.selected_connection_id;
  result=await f.b.send(route,'POST',{action:'connect',revision:result.data.revision,request_id:randomUUID(),connection_id:id},login.csrf);assert.equal(result.status,200,result.text);const connection=await f.b.send('/explorer/v1/connection');assert.equal(connection.status,200,connection.text);const generation=connection.data.data.source.registry_generation;
  assert.equal((await f.b.send('/explorer/v1/records?type=release&generation='+generation)).status,200);f.setPolicy(undefined);
  const denied=await f.b.send('/explorer/v1/records?type=release&generation='+generation);assert.equal(denied.status,403);assert.equal(denied.data.error.code,'SOURCE_MANAGEMENT_REQUIRED');assert.ok(!denied.text.includes('R-start@1'));assert.equal((await f.b.send('/studio/owner/session')).data.authenticated,true);
});

guarded('owner token save performs no read, replacement invalidates cache and credential test shares the same ledger',async(t:any)=>{
  const f=await managerHostFixture();t.after(()=>f.server.close());const login=await f.login(),route='/studio/v1/owner/connections',credentials='/studio/v1/owner/credentials';
  let result=await f.b.send(route,'POST',{action:'create',revision:0,request_id:randomUUID(),profile_id:'approved',ticket_id:f.policy.tickets[0].ticket_id,label:'Source'},login.csrf);
  const credential=(action:string,revision:number,value?:string)=>({action,credential_id:'artifacts-api-token',revision,request_id:randomUUID(),...(value?{value}:{})});
  const saved=await f.b.send(credentials,'POST',credential('save',0,'synthetic-provider-value-one'),login.csrf);assert.equal(saved.status,200,saved.text);assert.equal(f.calls(),0);
  result=await f.b.send(route,'POST',{action:'connect',revision:result.data.revision,request_id:randomUUID(),connection_id:result.data.selected_connection_id},login.csrf);assert.equal(result.status,200,result.text);assert.equal(f.calls(),1);
  const replaced=await f.b.send(credentials,'POST',credential('save',saved.data.revision,'synthetic-provider-value-two'),login.csrf);assert.equal(replaced.status,200,replaced.text);assert.equal(f.calls(),1);
  assert.equal((await f.b.send(route)).data.connections[0].runtime_ready,false);assert.equal((await f.b.send('/explorer/v1/connection')).status,409);
  const input=credential('test',replaced.data.revision),tested=await f.b.send(credentials,'POST',input,login.csrf);assert.equal(tested.status,200,tested.text);assert.equal(tested.data.test.outcome,'passed');assert.equal(f.calls(),2);
  const replay=await f.b.send(credentials,'POST',input,login.csrf);assert.equal(replay.data.replayed,true);assert.equal(f.calls(),2);assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,2);
  assert.ok(!JSON.stringify(tested.data).includes('synthetic-provider-value'));assert.equal((await f.b.send('/studio/owner/session')).data.authenticated,true);
});
