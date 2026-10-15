import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { namespaceFixture } from './namespace-fixture.js';
import { BLOCK_MODEL,digest } from '../src/model.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { runNamespaceStudio } from '../src/explorer/namespace-host.js';
import { StrictArtifacts } from './artifacts-fixture.js';
const local={skip:process.platform!=='win32'&&process.getuid?.()!==0?'Protected POSIX fixtures require root.':false};
test('invalid repository names fail clearly before reserving or sending a provider request',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();const before=await f.server.store.usageSnapshot();
  const result=await f.action('create',{name:'eleanors repo 1',purpose:'First project'});
  assert.equal(result.status,422);assert.equal(result.data.error.code,'INVALID_REPOSITORY_NAME');assert.equal(f.calls.length,0);
  assert.deepEqual(await f.server.store.usageSnapshot(),before);assert.ok(!(await f.server.store.snapshot()).operations.some(o=>o.action==='create'));
});
test('an uncertain creation is finished with explicit browser consent and never repeats repository creation',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();f.setMode('lost-create');
  assert.equal((await f.action('create',{name:'synthetic-partial',purpose:'Original purpose'})).status,503);
  const original=(await f.server.store.snapshot()).operations.find(o=>o.action==='create')!,repo=f.repos.get('synthetic-partial')!;f.setMode('ok');
  await f.restart();await f.login();
  const inspected=await f.action('inspect-create',{source_request_id:original.request_id});assert.equal(inspected.status,200,inspected.text);assert.equal(inspected.data.recovery.can_finish,true);
  const fields={source_request_id:original.request_id,repository_id:repo.id,purpose:'Recovered purpose',acknowledgment:'initialize-empty-repository'};
  assert.equal((await f.action('recover-create',{...fields,acknowledgment:'yes'})).status,422);
  assert.equal((await f.action('recover-create',{...fields,repository_id:'another'})).status,409);assert.equal(repo.git.pushes,0);
  const s=await f.server.store.snapshot(),body={action:'recover-create',...fields,revision:s.revision,request_id:randomUUID()};
  const result=await f.b.send('/studio/v1/owner/connections','POST',body,f.csrf);assert.equal(result.status,200,result.text);assert.equal(result.data.selected_repository_id,repo.id);assert.equal(repo.git.pushes,1);
  assert.equal(f.calls.filter(c=>c==='POST /client/v4/accounts/'+f.policy.account+'/artifacts/namespaces/development/repos').length,1);
  assert.equal(result.data.operations.find((o:any)=>o.request_id===original.request_id).phase,'completed');
  const calls=f.calls.length;assert.equal((await f.b.send('/studio/v1/owner/connections','POST',body,f.csrf)).data.replayed,true);assert.equal(f.calls.length,calls);
  await f.restart();await f.login();assert.equal((await f.server.store.snapshot()).selected_repository_id,repo.id);
});
test('creation inspection preserves nonempty repositories and authentication failures',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();f.setMode('lost-create');await f.action('create',{name:'keep-data',purpose:'Preserve'});
  const original=(await f.server.store.snapshot()).operations.find(o=>o.action==='create')!;f.setMode('denied');
  assert.equal((await f.action('inspect-create',{source_request_id:original.request_id})).status,403);
  assert.equal((await f.server.store.snapshot()).operations.find(o=>o.request_id===original.request_id)!.phase,'uncertain');
  f.setMode('ok');const repo=f.repos.get('keep-data')!;repo.git.pushes=1;
  const inspection=await f.action('inspect-create',{source_request_id:original.request_id});assert.equal(inspection.data.recovery.can_finish,false);
  assert.equal((await f.action('recover-create',{source_request_id:original.request_id,repository_id:repo.id,purpose:'Do not overwrite',acknowledgment:'initialize-empty-repository'})).status,409);assert.equal(repo.git.pushes,1);
  f.repos.delete('keep-data');const missing=await f.action('inspect-create',{source_request_id:original.request_id});assert.equal(missing.data.recovery.repository,null);
  assert.equal((await f.server.store.snapshot()).operations.find(o=>o.request_id===original.request_id)!.phase,'failed');
});
test('explicit namespace read checks retain sanitized outcomes and spending across failure, replay and restart',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  assert.equal((await f.b.send('/studio/v1/owner/credentials')).data.capabilities.test,false);
  for(const [mode,code,status] of [['denied','SOURCE_AUTH',403],['missing-namespace','NAMESPACE_NOT_FOUND',403],['rate-limited','NAMESPACE_RATE_LIMIT',503]] as const){
    f.setMode(mode);const before=await f.server.store.usageSnapshot(),s=(await f.b.send('/studio/v1/owner/connections')).data;
    const input={action:'discover',search:'',cursor:null,revision:s.revision,request_id:randomUUID()},calls=f.calls.length;
    const refused=await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf);
    assert.equal(refused.status,status,refused.text);assert.equal(refused.data.error.code,code);assert.doesNotMatch(refused.text,/synthetic-namespace-api-secret|art_v1_/);
    const spent=await f.server.store.usageSnapshot();assert.equal(spent.reserved.requests,before.reserved.requests+1);assert.equal(f.calls.length,calls+1);
    const outcome=await f.b.send('/studio/v1/owner/connections/operations/'+input.request_id);assert.equal(outcome.data.operation.phase,'failed');assert.equal(outcome.data.operation.code,code);
    const replay=await f.b.send('/studio/v1/owner/connections','POST',input,f.csrf);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.equal(f.calls.length,calls+1);assert.deepEqual(await f.server.store.usageSnapshot(),spent);
  }
  f.setMode('normal');const success=await f.action('discover',{search:'',cursor:null});assert.equal(success.status,200,success.text);assert.equal(success.data.outcome.phase,'completed');
  assert.equal(f.repos.size,0);assert.ok(f.calls.every(c=>c.startsWith('GET ')));const spent=await f.server.store.usageSnapshot(),calls=f.calls.length;
  await f.restart();await f.login();const retained=await f.b.send('/studio/v1/owner/connections');assert.equal(retained.data.approved,true);assert.equal(retained.data.operations.at(-1).phase,'completed');assert.equal(f.calls.length,calls);assert.deepEqual(retained.data.usage,spent);
});
test('namespace creates authenticated projects, drafts persist across switch/restart, and approval remains until revoked',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();assert.equal(f.calls.length,0);
  const readDraft=async(id:string)=>{const h={'x-strata-repository':id},c=await f.b.send('/studio/v1/connection','GET',undefined,undefined,h);assert.equal(c.status,200,c.text);return f.b.send('/studio/v1/record?type=layer&ref=MyDraft@1&generation='+c.data.data.source.registry_generation,'GET',undefined,undefined,h);};
  let created=await f.action('create',{name:'first',purpose:'The first project'});assert.equal(created.status,200,created.text);
  const first=created.data.projects[0],actor=(await f.b.send('/studio/actor/session','POST',{},f.csrf)).data;
  const headers={'x-strata-repository':first.id};let cap=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers);assert.equal(cap.status,200,cap.text);
  const record={id:'MyDraft',revision:1,owner:f.policy.principal_id,model_version:BLOCK_MODEL,baseline:'ProjectBaseline@1',intent:'Clarify project purpose',
    changes:[{op:'set_item',block:'root',path:'purpose',expected:{kind:'value',value:'The first project'},value:'Saved first purpose'}],created_blocks:[],
    requires_layers:[],read_set:[],assumptions:[],acceptance:[],resolution_proposals:[],derived_from:null};
  const envelope={command:'layer.create',input:{record},idempotency_key:randomUUID(),expected_generation:cap.data.data.generation,expected_policy:cap.data.data.policy_generation};
  const saved=await f.b.send('/studio/v1/operation','POST',envelope,actor.csrf,headers);assert.equal(saved.status,200,saved.text);assert.equal(saved.data.data.data.ref,'MyDraft@1');
  const usage=await f.server.store.usageSnapshot();const replay=await f.b.send('/studio/v1/operation','POST',envelope,actor.csrf,headers);assert.equal(replay.status,200,replay.text);assert.equal(replay.data.data.reused,true);assert.deepEqual(await f.server.store.usageSnapshot(),usage);
  const reviewRequired=await f.b.send('/studio/v1/operation','POST',{...envelope,command:'layer.publish',input:{ref:'MyDraft@1'},idempotency_key:randomUUID(),expected_generation:saved.data.data.generation},actor.csrf,headers);assert.equal(reviewRequired.status,409,reviewRequired.text);assert.equal(reviewRequired.data.error.code,'AUTHORING_REVIEW_REQUIRED');
  const denied=await f.b.send('/studio/v1/operation','POST',{...envelope,command:'release',input:{}},actor.csrf,headers);assert.equal(denied.status,403);
  created=await f.action('create',{name:'second',purpose:'The second project'});assert.equal(created.status,200,created.text);const second=created.data.projects[1];
  assert.notEqual(first.project_id,second.project_id);
  assert.notEqual((await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers)).status,200);
  const secondActor=await f.b.send('/studio/actor/session','POST',{},f.csrf);assert.equal(secondActor.status,200,secondActor.text);
  await f.b.send('/studio/v1/connection','GET',undefined,undefined,{'x-strata-repository':second.id});
  const missing=await readDraft(second.id);assert.equal(missing.status,404,missing.text);
  const discovered=await f.action('discover',{search:'',cursor:null});assert.equal(discovered.data.discovery.repositories.length,2);
  const selected=await f.action('select',{repository_id:first.id});assert.equal(selected.status,200,selected.text);
  await f.b.send('/studio/actor/session','POST',{},f.csrf);
  await f.b.send('/studio/v1/connection','GET',undefined,undefined,headers);
  const loaded=await readDraft(first.id);assert.equal(loaded.status,200,loaded.text);assert.match(loaded.text,/Saved first purpose/);
  const spent=await f.server.store.usageSnapshot();await f.restart();await f.login();
  const state=await f.b.send('/studio/v1/owner/connections');assert.equal(state.data.approved,true);assert.equal(state.data.selected_repository_id,first.id);assert.deepEqual(state.data.usage,spent);
  await f.b.send('/studio/actor/session','POST',{},f.csrf);await f.b.send('/studio/v1/connection','GET',undefined,undefined,headers);assert.equal((await readDraft(first.id)).status,200);
  assert.equal((await f.action('pause')).status,200);assert.notEqual((await f.b.send('/studio/v1/record?type=layer&ref=MyDraft@1','GET',undefined,undefined,headers)).status,200);
  assert.equal((await f.action('resume')).status,200);assert.equal((await f.action('revoke')).status,200);
  await f.restart();await f.login();assert.equal((await f.b.send('/studio/v1/owner/connections')).data.revoked,true);assert.equal((await f.action('resume')).status,403);
  const serialized=await readFile(path.join(f.config.catalog_directory,'namespace.json'),'utf8');assert.doesNotMatch(serialized,/synthetic-namespace-api-secret|art_v1_/);
});
test('lost creation response is retained, no duplicate create or token guessing, and absent namespace refuses creation',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();f.setMode('missing-namespace');
  const absent=await f.action('create',{name:'absent',purpose:'Missing namespace'});assert.equal(absent.status,403);assert.equal(absent.data.error.code,'NAMESPACE_NOT_FOUND');assert.equal(f.repos.size,0);
  f.setMode('lost-create');const s=(await f.b.send('/studio/v1/owner/connections')).data;
  const a={action:'create',name:'uncertain',purpose:'No automatic retry',revision:s.revision,request_id:randomUUID()};
  const lost=await f.b.send('/studio/v1/owner/connections','POST',a,f.csrf);assert.equal(lost.status,503,lost.text);assert.doesNotMatch(lost.text,/synthetic-namespace-api-secret/);
  const before=f.calls.length;const replay=await f.b.send('/studio/v1/owner/connections','POST',a,f.csrf);assert.equal(replay.data.outcome.phase,'uncertain');assert.equal(f.calls.length,before);assert.equal(f.repos.size,1);
  assert.equal((await f.action('create',{name:'uncertain',purpose:'retry'})).status,409);assert.ok(!f.calls.some(c=>c.startsWith('DELETE')));
});
test('namespace authentication, strict scope, CSRF and writer lease reject before provider work',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());
  assert.equal((await f.b.send('/studio/v1/owner/connections')).status,401);await f.login();
  let s=(await f.b.send('/studio/v1/owner/connections')).data;
  const input={action:'approve',revision:s.revision,request_id:randomUUID(),scope_sha256:s.scope_sha256,acknowledgment:'until-revoked-development-namespace'};
  assert.equal((await f.b.send('/studio/v1/owner/connections','POST',input,'wrong')).status,403);
  assert.equal((await f.b.send('/studio/v1/owner/connections','POST',{...input,scope_sha256:'another-namespace'},f.csrf)).status,403);
  assert.equal((await f.b.send('/studio/v1/owner/connections','POST',{...input,namespace:'other'},f.csrf)).status,422);
  assert.equal((await f.action('discover',{search:'',cursor:null})).status,403);
  assert.equal(f.calls.length,0);assert.equal((await f.server.store.snapshot()).approved,false);
  await assert.rejects(runNamespaceStudio(f.base.state,f.config,{publicOrigin:f.base.origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer')),e=>(e as any).code==='STATE_BUSY');
});
test('pause during a dispatched creation prevents initialization and retains uncertainty without a retry',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  f.onCreated(async()=>{assert.equal((await f.action('pause')).status,200);});
  const result=await f.action('create',{name:'interrupted',purpose:'Interruption boundary'});assert.equal(result.status,403,result.text);
  assert.equal(f.repos.size,1);assert.equal(f.repos.get('interrupted')!.git.pushes,0);
  const s=await f.server.store.snapshot();assert.equal(s.connected,false);assert.equal(s.operations.find(o=>o.action==='create')!.phase,'uncertain');
  assert.ok(!f.calls.some(c=>c.includes('/tokens')));
});
test('credential rotation invalidates actors without revoking namespace consent or resetting usage',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();const result=await f.action('create',{name:'rotation',purpose:'Rotation test'});assert.equal(result.status,200,result.text);
  const project=result.data.projects[0],h={'x-strata-repository':project.id};await f.b.send('/studio/actor/session','POST',{},f.csrf);
  assert.equal((await f.b.send('/studio/v1/connection','GET',undefined,undefined,h)).status,200);
  const spent=await f.server.store.usageSnapshot(),calls=f.calls.length,metadata=(await f.b.send('/studio/v1/owner/credentials')).data;
  const rotated=await f.b.send('/studio/v1/owner/credentials','POST',{action:'save',credential_id:'artifacts-api-token',revision:metadata.revision,request_id:randomUUID(),value:'synthetic-namespace-api-secret'},f.csrf);assert.equal(rotated.status,200,rotated.text);
  assert.equal((await f.b.send('/studio/v1/connection','GET',undefined,undefined,h)).status,401);assert.equal(f.calls.length,calls);
  assert.equal((await f.server.store.snapshot()).approved,true);assert.deepEqual(await f.server.store.usageSnapshot(),spent);
  assert.equal((await f.b.send('/studio/actor/session','POST',{},f.csrf)).status,200);assert.equal(f.calls.length,calls);
  assert.equal((await f.b.send('/studio/v1/connection','GET',undefined,undefined,h)).status,200);
});
test('catalog revocation tombstone and accounting reservations survive restart and refuse rollback or replay',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  const id=randomUUID(),operation=digest('accounting');await f.server.store.reserve(id,operation,'repository.list',100);
  await assert.rejects(f.server.store.reserve(id,operation,'repository.list',100),e=>(e as any).code==='WORKSPACE_DISPATCH_REPLAY');
  const spent=await f.server.store.usageSnapshot();await f.restart();await f.login();assert.deepEqual(await f.server.store.usageSnapshot(),spent);
  const before=await f.server.store.snapshot();assert.equal((await f.action('revoke')).status,200);
  await writePrivate(path.join(f.config.catalog_directory,'namespace.json'),before);
  await assert.rejects(f.server.store.snapshot(),e=>(e as any).code==='ACCESS_REVOKED');
});
test('same-name replacement cannot switch project authority, unsupported repositories never gain writer state',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();const result=await f.action('create',{name:'pinned',purpose:'ID pin'});assert.equal(result.status,200,result.text);
  const project=result.data.projects[0],before=await f.server.store.snapshot();f.setMode('replaced');
  const denied=await f.action('select',{repository_id:project.id});assert.equal(denied.status,403,denied.text);assert.equal(denied.data.error.code,'REPOSITORY_ID_MISMATCH');
  assert.equal((await f.server.store.snapshot()).selection_epoch,before.selection_epoch);
  assert.equal((await f.action('select',{repository_id:'foreign-project'})).status,403);
  assert.equal(f.repos.size,1);
});


test('ordinary namespace use outlives fresh confirmation but never outlives owner authentication',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  const started=Date.now();(f.server.owner as any).now=()=>started+6*60_000;
  assert.equal((await f.action('discover',{search:'',cursor:null})).status,200);
  assert.equal((await f.action('revoke')).status,403);
  const calls=f.calls.length;(f.server.owner as any).now=()=>started+61*60_000;
  assert.equal((await f.b.send('/studio/v1/owner/connections')).status,401);
  assert.equal(f.calls.length,calls);assert.equal((await f.server.store.snapshot()).approved,true);
});

test('restart closes pre-dispatch pending actions while retaining dispatched creation uncertainty',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  const pending=randomUUID(),uncertain=randomUUID();
  await f.server.store.update(s=>{for(const [id,phase]of [[pending,'pending'],[uncertain,'uncertain']] as const)s.operations.push({request_id:id,input_sha256:digest(id),action:'create',phase,code:null,repository_id:null,repository_name:'name-'+id});});
  await f.restart();const s=await f.server.store.snapshot();assert.equal(s.operations.find(o=>o.request_id===pending)!.phase,'failed');assert.equal(s.operations.find(o=>o.request_id===uncertain)!.phase,'uncertain');assert.equal(f.calls.length,0);
});

test('discovery preserves search and cursor scope; unknown repositories stay unregistered',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();f.setMode('paginated');
  for(const name of ['alpha','beta','gamma'])f.repos.set(name,{id:'remote-'+name,read_only:false,git:new StrictArtifacts()});
  const first=await f.action('discover',{search:'',cursor:null});assert.equal(first.status,200,first.text);assert.equal(first.data.discovery.repositories.length,2);assert.equal(first.data.discovery.next_cursor,'2');
  const next=await f.action('discover',{search:'',cursor:first.data.discovery.next_cursor});assert.deepEqual(next.data.discovery.repositories.map((r:any)=>r.name),['gamma']);assert.equal(next.data.discovery.next_cursor,null);
  const searched=await f.action('discover',{search:'beta',cursor:null});assert.deepEqual(searched.data.discovery.repositories.map((r:any)=>r.name),['beta']);
  assert.equal((await f.server.store.snapshot()).projects.length,0);assert.equal((await f.action('select',{repository_id:'remote-beta'})).status,403);
  assert.equal((await f.server.store.usageSnapshot()).reserved.requests,3);
});

test('creation-token expiry beyond the approved bound leaves an uncertain outcome and never guesses cleanup',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();f.setMode('long-token');
  const result=await f.action('create',{name:'overlong-token',purpose:'Expiry bound test'});assert.equal(result.status,503,result.text);
  const s=await f.server.store.snapshot();assert.equal(s.projects.length,0);assert.equal(s.operations.find(o=>o.action==='create')!.phase,'uncertain');
  assert.equal(f.repos.size,1);assert.ok(!f.calls.some(c=>c.includes('/tokens')));assert.doesNotMatch(JSON.stringify(s),/art_v1_|synthetic-namespace-api-secret/);
});


test('active project requests refresh owner idle time but never the absolute owner deadline',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  const created=await f.action('create',{name:'active-session',purpose:'Active authoring session'});assert.equal(created.status,200,created.text);
  const h={'x-strata-repository':created.data.projects[0].id};assert.equal((await f.b.send('/studio/actor/session','POST',{},f.csrf)).status,200);
  const started=Date.now(),calls=f.calls.length;
  for(const minutes of [14,28,42,56]){(f.server.owner as any).now=()=>started+minutes*60_000;const r=await f.b.send('/studio/v1/connection','GET',undefined,undefined,h);assert.equal(r.status,200,r.text);}
  (f.server.owner as any).now=()=>started+61*60_000;const expired=await f.b.send('/studio/v1/connection','GET',undefined,undefined,h);assert.equal(expired.status,403);assert.equal(expired.data.error.code,'OWNER_SESSION_REQUIRED');
  assert.equal(f.calls.length,calls);assert.equal((await f.server.store.snapshot()).approved,true);
});

test('a conflicting creation identity cannot corrupt the existing catalog or initialize another writer',local,async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  assert.equal((await f.action('create',{name:'original-id',purpose:'Original project'})).status,200);const before=await f.server.store.snapshot();
  f.setMode('duplicate-id');const result=await f.action('create',{name:'conflicting-id',purpose:'Provider identity conflict'});assert.equal(result.status,403,result.text);
  const s=await f.server.store.snapshot();assert.deepEqual(s.projects,before.projects);assert.equal(s.selected_repository_id,before.selected_repository_id);
  assert.equal(s.operations.at(-1)!.phase,'uncertain');assert.equal(f.repos.get('conflicting-id')!.git.pushes,0);
});
