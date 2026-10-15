import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { namespaceFixture } from './namespace-fixture.js';
import { digest } from '../src/model.js';
import { NAMESPACE_JOURNAL_CAPACITY, namespaceStateSchema } from '../src/explorer/namespace-policy.js';
import { runNamespaceStudio } from '../src/explorer/namespace-host.js';

const local={skip:process.platform!=='win32'&&process.getuid?.()!==0?'Protected POSIX fixtures require root.':false};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};

for(const boundary of ['queued admission','flushed private staging'] as const)
for(const invalidation of ['logout','absolute expiry','freshness expiry','control invalidation'] as const)
test(`pending namespace approval refuses ${invalidation} during ${boundary}`,local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.login();
  const before=await f.server.store.snapshot(),usage=await f.server.store.usageSnapshot();
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  if(boundary==='queued admission'){
    const update=f.server.store.update.bind(f.server.store);let first=true;
    t.mock.method(f.server.store,'update',async (...args:Parameters<typeof update>)=>{
      if(first){first=false;entered.resolve();await release.promise;}return update(...args);
    });
  }else{
    const open=fsPromises.open;let first=true;
    const mock=t.mock.method(fsPromises,'open',async (...args:Parameters<typeof open>)=>{
      const handle=await open(...args);
      if(first&&String(args[0]).startsWith(path.join(f.config.catalog_directory,'namespace.json')+'.')){
        first=false;const close=handle.close.bind(handle);
        handle.close=async()=>{await close();entered.resolve();await release.promise;};
      }
      return handle;
    });
    syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  }
  const waiting=f.action('approve',{scope_sha256:before.binding_sha256,acknowledgment:'until-revoked-development-namespace'});
  await entered.promise;
  if(invalidation==='logout')assert.equal((await f.b.send('/studio/owner/logout','POST',{},f.csrf)).status,200);
  else if(invalidation==='control invalidation')f.server.manager.changed();
  else {const deadline=Date.now()+(invalidation==='absolute expiry'?61:6)*60_000;(f.server.owner as any).now=()=>deadline;}
  release.resolve();const response=await waiting;
  const expected=invalidation==='control invalidation'?'ACCESS_REVOKED':invalidation==='freshness expiry'?'OWNER_REAUTH_REQUIRED':'OWNER_SESSION_REQUIRED';
  assert.equal(response.status,invalidation==='logout'||invalidation==='absolute expiry'?401:403,response.text);
  assert.equal(response.data.error.code,expected);assert.deepEqual(await f.server.store.snapshot(),before);
  assert.deepEqual(await f.server.store.usageSnapshot(),usage);assert.equal(f.calls.length,0);
  await f.restart();await f.login();assert.deepEqual(await f.server.store.snapshot(),before);
  assert.deepEqual(await f.server.store.usageSnapshot(),usage);assert.equal(f.calls.length,0);
});

test('committed namespace approval survives logout/restart with exact replay and no new authority',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.login();
  const s=await f.server.store.snapshot(),input={action:'approve',revision:s.revision,request_id:randomUUID(),scope_sha256:s.binding_sha256,acknowledgment:'until-revoked-development-namespace'};
  assert.equal((await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf)).status,200);
  const committed=await f.server.store.snapshot();assert.equal(committed.approved,true);assert.equal(committed.operations[0].phase,'completed');
  assert.equal((await f.b.send('/studio/owner/logout','POST',{},f.csrf)).status,200);
  await f.restart();await f.login();
  const replay=await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf);assert.equal(replay.status,200,replay.text);assert.equal(replay.data.replayed,true);
  assert.deepEqual(await f.server.store.snapshot(),committed);
  const conflict=await f.b.send('/studio/v1/owner/connections','POST',{...input,revision:input.revision+1},f.csrf);assert.equal(conflict.status,409);assert.equal(conflict.data.error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal(f.calls.length,0);
});

async function fullHistory(f:Awaited<ReturnType<typeof namespaceFixture>>){
  await f.prepare();
  await f.server.store.reserve(randomUUID(),digest('retained namespace spend'),'repository.list',123);
  await f.server.store.update(s=>{
    while(s.operations.length<NAMESPACE_JOURNAL_CAPACITY){const request_id=randomUUID(),revision=s.operations.length;
      s.operations.push({request_id,input_sha256:digest({action:'resume',revision,request_id}),action:'resume',phase:'completed',code:null,repository_id:null,repository_name:null});}
    s.revision=NAMESPACE_JOURNAL_CAPACITY;s.selection_epoch=NAMESPACE_JOURNAL_CAPACITY;
  });
  return {before:await f.server.store.snapshot(),usage:await f.server.store.usageSnapshot()};
}

for(const pauseFirst of [false,true])test(`full namespace history retains ${pauseFirst?'pause then revoke':'direct revoke'}, exact replay and restart`,local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());const {before,usage}=await fullHistory(f);
  if(pauseFirst){
    const input={action:'pause',revision:before.revision,request_id:randomUUID()};
    const paused=await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf);assert.equal(paused.status,200,paused.text);
    const state=await f.server.store.snapshot();assert.equal(state.connected,false);assert.equal(state.operations.length,NAMESPACE_JOURNAL_CAPACITY+1);
    assert.equal(state.operations.at(-1)!.phase,'completed');assert.deepEqual(state.operations.slice(0,NAMESPACE_JOURNAL_CAPACITY),before.operations);
    await f.restart();await f.login();assert.deepEqual(await f.server.store.snapshot(),state);
    const replay=await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf);assert.equal(replay.status,200,replay.text);assert.equal(replay.data.replayed,true);
    const resume=await f.action('resume');assert.equal(resume.status,503);assert.equal(resume.data.error.code,'NAMESPACE_STATE_UNAVAILABLE');
    assert.deepEqual(await f.server.store.snapshot(),state);
  }
  const s=await f.server.store.snapshot(),input={action:'revoke',revision:s.revision,request_id:randomUUID()};
  const revoked=await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf);assert.equal(revoked.status,200,revoked.text);
  const final=await f.server.store.snapshot();assert.equal(final.revoked,true);assert.equal(final.connected,false);
  assert.equal(final.operations.length,NAMESPACE_JOURNAL_CAPACITY+(pauseFirst?2:1));assert.equal(final.operations.at(-1)!.phase,'completed');
  assert.deepEqual(final.operations.slice(0,NAMESPACE_JOURNAL_CAPACITY),before.operations);assert.deepEqual(await f.server.store.usageSnapshot(),usage);
  const tombstone=JSON.parse(await readFile(path.join(f.config.catalog_directory,'revoked.json'),'utf8'));assert.equal(tombstone.revision,final.revision);
  await f.restart();await f.login();assert.deepEqual(await f.server.store.snapshot(),final);
  const replay=await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf);assert.equal(replay.status,200,replay.text);assert.equal(replay.data.replayed,true);
  const conflict=await f.b.send('/studio/v1/owner/connections','POST',{...input,revision:input.revision+1},f.csrf);assert.equal(conflict.status,409);
  assert.deepEqual(await f.server.store.snapshot(),final);assert.deepEqual(await f.server.store.usageSnapshot(),usage);assert.equal(f.calls.length,0);
  const invalid=structuredClone(final);invalid.operations[NAMESPACE_JOURNAL_CAPACITY].action='resume';assert.equal(namespaceStateSchema.safeParse(invalid).success,false);
  invalid.operations[NAMESPACE_JOURNAL_CAPACITY].action='pause';invalid.connected=true;assert.equal(namespaceStateSchema.safeParse(invalid).success,false);
});

test('failure between full-history revoke tombstone and catalog publication stays revoked across restart',local,async t=>{
  const f=await namespaceFixture();let closed=false;t.after(()=>closed?undefined:f.server.close());const {before,usage}=await fullHistory(f);
  const rename=fs.renameSync;const mock=t.mock.method(fs,'renameSync',(...args:Parameters<typeof rename>)=>{
    if(String(args[1])===path.join(f.config.catalog_directory,'namespace.json'))throw Object.assign(Error('synthetic publication interruption'),{code:'EIO'});
    return rename(...args);
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const result=await f.action('revoke');assert.notEqual(result.status,200);
  mock.mock.restore();syncBuiltinESMExports();
  const retained=JSON.parse(await readFile(path.join(f.config.catalog_directory,'namespace.json'),'utf8'));
  assert.deepEqual(retained,before);assert.ok(JSON.parse(await readFile(path.join(f.config.catalog_directory,'revoked.json'),'utf8')).revision>before.revision);
  await assert.rejects(f.server.store.snapshot(),e=>(e as any).code==='ACCESS_REVOKED');
  assert.deepEqual(await f.server.store.usageSnapshot(),usage);assert.equal(f.calls.length,0);
  await f.server.close();closed=true;
  await assert.rejects(runNamespaceStudio(f.base.state,f.config,{publicOrigin:f.base.origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer')),e=>(e as any).code==='ACCESS_REVOKED');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.config.catalog_directory,'namespace.json'),'utf8')),before);assert.equal(f.calls.length,0);
});
