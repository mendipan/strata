import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,readFile,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {digest} from '../src/model.js';
import {sourcePolicySchema,type SourcePolicy} from '../src/explorer/connection-policy.js';
import {ConnectionStore,initialConnectionState,prepareSourcePolicy} from '../src/explorer/connection-store.js';
import {ManagedConnections,type SourceOwner,type SourceOwnerAuthority,type ManagedReaderFactory} from '../src/explorer/connection-manager.js';
import {writePrivate} from '../src/explorer/owner-files.js';
import {ExplorerReader} from '../src/explorer/read.js';
import {ExplorerError} from '../src/explorer/contract.js';
import {TestSource,sample,config} from './explorer-fixture.js';
const code=(wanted:string)=>(e:any)=>e.code===wanted;
import {managerFixture} from './studio-manager-fixture.js';

test('explicit creation persists, never reads provider, exact replay and changed-payload refusal',async()=>{
  const f=await managerFixture(),request={action:'create',revision:0,request_id:randomUUID(),profile_id:'approved',ticket_id:f.policy.tickets[0].ticket_id,label:'Readable source'};
  const created=await f.manager.action(f.authority,request);assert.equal(created.connections.length,1);assert.equal(created.connections[0].state,'disconnected');assert.equal(f.calls(),0);assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,0);
  assert.equal((await f.manager.action(f.authority,request)).replayed,true);assert.equal((await f.state()).grants.length,1);
  await assert.rejects(f.manager.action(f.authority,{...request,label:'Changed'}),code('REQUEST_CONFLICT'));
  assert.equal((await f.make().status(f.authority)).selected_connection_id,created.selected_connection_id);
});
test('test remains disconnected, connect serves real snapshot, restart loses readiness without spending reset',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('test');assert.equal(f.calls(),1);await assert.rejects(f.manager.read(f.authority,r=>r.connection()),code('CONNECTION_DISCONNECTED'));
  const connected=await f.action('connect');assert.equal(connected.connections[0].runtime_ready,true);assert.equal((await f.manager.read(f.authority,r=>r.connection())).ready,true);
  assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,2);assert.equal((await f.make().status(f.authority)).connections[0].runtime_ready,false);assert.equal(f.calls(),2);
});
test('renew/remove retain old ledgers and tombstones and cannot reuse the same ticket',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('connect');const spent=JSON.stringify(await f.ledger(f.policy.tickets[0].grant_id));
  await f.action('renew',{ticket_id:f.policy.tickets[1].ticket_id});assert.equal(JSON.stringify(await f.ledger(f.policy.tickets[0].grant_id)),spent);assert.equal(f.calls(),1);assert.equal((await f.state()).grants[0].phase,'retired');
  await f.action('remove');assert.equal((await f.state()).entries.length,0);assert.equal((await f.state()).grants.length,2);
  await assert.rejects(f.action('create'),code('SOURCE_MANAGEMENT_REQUIRED'));assert.equal(JSON.stringify(await f.ledger(f.policy.tickets[0].grant_id)),spent);
});
test('cached snapshot and exact queries deny source policy revocation with owner still active',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('connect');const snapshot=await f.manager.read(f.authority,r=>r.connection());assert.equal(snapshot.ready,true);
  f.setPolicy(undefined);await assert.rejects(f.manager.read(f.authority,r=>r.query('records',new URLSearchParams({type:'release',generation:snapshot.source!.registry_generation}))),code('SOURCE_MANAGEMENT_REQUIRED'));assert.equal((await f.manager.status(f.authority)).management.state,'unavailable');assert.equal(f.calls(),1);
});
test('authority, fresh owner, exact profile, strict body and stale CAS refuse without provider',async()=>{
  const f=await managerFixture();const create={action:'create',revision:0,request_id:randomUUID(),profile_id:'approved',ticket_id:f.policy.tickets[0].ticket_id,label:'Synthetic'};f.changeOwner({fresh:false});await assert.rejects(f.manager.action(f.authority,create),code('OWNER_REAUTH_REQUIRED'));f.changeOwner({fresh:true,owner_id:randomUUID()});await assert.rejects(f.manager.action(f.authority,create),code('SOURCE_MANAGEMENT_REQUIRED'));f.changeOwner({owner_id:f.policy.owner_id});
  await assert.rejects(f.action('create',{profile_id:'unapproved'}),code('SOURCE_MANAGEMENT_REQUIRED'));await assert.rejects(f.action('create',{extra:true}),code('INVALID_INPUT'));
  await f.action('create');await assert.rejects(f.manager.action(f.authority,{action:'disconnect',connection_id:(await f.manager.status(f.authority)).selected_connection_id,revision:0,request_id:randomUUID()}),code('CONNECTION_CHANGED'));assert.equal(f.calls(),0);
});
test('disconnect during bounded test commits while network waits, late completion cannot reconnect',async()=>{
  const f=await managerFixture();await f.action('create');let release!:()=>void;f.delay(new Promise<void>(r=>release=r));const started=f.action('connect');
  while(f.calls()===0)await new Promise(r=>setTimeout(r,5));await f.action('disconnect');release();const result=await started;assert.equal(result.outcome.state,'failed');assert.equal(result.connections[0].runtime_ready,false);assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,1);
});
test('failure retains spending, replay dispatches nothing, missing ledger is not recreated',async()=>{
  const f=await managerFixture();await f.action('create');f.fail(new ExplorerError('SOURCE_AUTH',403,'unsafe provider secret detail'));const s=await f.manager.status(f.authority),input={action:'connect',revision:s.revision,connection_id:s.selected_connection_id,request_id:randomUUID()};
  const failed=await f.manager.action(f.authority,input);assert.equal(failed.outcome.code,'SOURCE_AUTH');assert.equal((await f.manager.action(f.authority,input)).replayed,true);assert.equal(f.calls(),1);assert.ok(!JSON.stringify(failed).includes('unsafe provider secret detail'));
  await unlink(path.join(f.accounting,f.policy.tickets[0].grant_id,'read-budget.json'));assert.equal((await f.manager.status(f.authority)).connections[0].error?.code,'READ_BUDGET_UNAVAILABLE');await assert.rejects(f.action('connect'),code('READ_BUDGET_UNAVAILABLE'));assert.equal(f.calls(),1);
});
test('ledger activation ambiguity burns prepared ticket and refuses another zero grant',async()=>{
  const f=await managerFixture();await import('node:fs/promises').then(fs=>fs.mkdir(path.join(f.accounting,f.policy.tickets[0].grant_id),{mode:0o700}));await writePrivate(path.join(f.accounting,f.policy.tickets[0].grant_id,'grant.json'),{existing:true},true);
  await assert.rejects(f.action('create'));const stored=await f.state();assert.equal(stored.grants[0].phase,'prepared');await assert.rejects(f.action('create',{ticket_id:f.policy.tickets[1].ticket_id}),code('CONNECTION_RECOVERY_REQUIRED'));assert.equal((await f.state()).grants.length,1);assert.equal(f.calls(),0);
});
test('missing catalog/genesis and policy replacement fail closed without automatic initialization',async()=>{
  const f=await managerFixture();await unlink(path.join(f.storeDir,'state.json'));await assert.rejects(f.manager.status(f.authority),code('CONNECTION_RECOVERY_REQUIRED'));await assert.rejects(readFile(path.join(f.storeDir,'state.json')),{code:'ENOENT'});
  const g=await managerFixture();g.setPolicy({...g.policy,generation:2});await assert.rejects(g.manager.status(g.authority),code('CONNECTION_RECOVERY_REQUIRED'));
});
test('exact duplicate grant identity, altered source/model and noncanonical path are not admissible',async()=>{
  const f=await managerFixture(),p=structuredClone(f.policy);p.tickets[1]={...p.tickets[0],ticket_id:randomUUID()};assert.equal(sourcePolicySchema.safeParse(p).success,false);
  const q=structuredClone(f.policy);q.tickets[1].connection.registry_path+=path.sep+'..'+path.sep+'different';assert.equal(sourcePolicySchema.safeParse(q).success,false);
  const r=structuredClone(f.policy);r.tickets[1].connection.storage.repository='another';assert.equal(sourcePolicySchema.safeParse(r).success,false);
  const m=structuredClone(f.policy);(m.tickets[1].connection as any).model_version='strata/0.3-block-lifecycle-experimental';assert.equal(sourcePolicySchema.safeParse(m).success,false);
});
test('stale lock refuses management without reading the provider',async()=>{
  const f=await managerFixture();await writeFile(path.join(f.storeDir,'.owner.lock'),'synthetic interrupted lease',{mode:0o600});await assert.rejects(f.action('create'),code('CONNECTION_RECOVERY_REQUIRED'));assert.equal(f.calls(),0);
});

test('bounded receipt capacity refuses new actions while preserving an existing exact replay',async()=>{
  const f=await managerFixture(),request={action:'create',revision:0,request_id:randomUUID(),profile_id:'approved',ticket_id:f.policy.tickets[0].ticket_id,label:'Readable source'};
  await f.manager.action(f.authority,request);const state=await f.state(),original=state.operations[0];
  for(let i=1;i<1024;i++)state.operations.push({...original,request_id:randomUUID(),payload_sha256:digest({synthetic:i})});
  await writePrivate(path.join(f.storeDir,'state.json'),state);const before=await readFile(path.join(f.storeDir,'state.json'),'utf8');
  await assert.rejects(f.action('disconnect'),code('MANAGEMENT_CAPACITY'));
  assert.equal((await f.manager.action(f.authority,request)).replayed,true);assert.equal(await readFile(path.join(f.storeDir,'state.json'),'utf8'),before);assert.equal(f.calls(),0);
});

test('denied cached reads invalidate readiness and expiry during a read cannot return data',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('connect');const policy=f.policy;f.setPolicy(undefined);
  await assert.rejects(f.manager.read(f.authority,r=>r.connection()),code('SOURCE_MANAGEMENT_REQUIRED'));f.setPolicy(policy);
  assert.equal((await f.manager.status(f.authority)).connections[0].runtime_ready,false);await f.action('connect');
  await assert.rejects(f.manager.read(f.authority,async r=>{const value=r.connection();f.advance(3600001);return value;}),code('SOURCE_AUTH'));
  assert.equal((await f.manager.status(f.authority)).connections[0].runtime_ready,false);assert.equal(f.calls(),2);
});

test('owner authentication changes during a test retain spending and an interrupted receipt',async()=>{
  const f=await managerFixture();await f.action('create');let release!:()=>void;f.delay(new Promise<void>(r=>release=r));const running=f.action('connect');
  while(!f.calls())await new Promise(r=>setTimeout(r,5));f.changeOwner({authentication_generation:2});release();
  await assert.rejects(running,code('SOURCE_MANAGEMENT_REQUIRED'));assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,1);
  const restarted=await f.make().status(f.authority);assert.equal(restarted.connections[0].state,'interrupted');assert.equal(restarted.connections[0].runtime_ready,false);assert.equal(f.calls(),1);
});

test('a disconnected status read does not cancel an explicitly running connection test',async()=>{
  const f=await managerFixture();await f.action('create');let release!:()=>void;f.delay(new Promise<void>(r=>release=r));const running=f.action('connect');
  while(!f.calls())await new Promise(r=>setTimeout(r,5));await assert.rejects(f.manager.read(f.authority,r=>r.connection()),code('CONNECTION_DISCONNECTED'));release();
  const result=await running;assert.equal(result.outcome.state,'completed');assert.equal(result.connections[0].runtime_ready,true);assert.equal(f.calls(),1);
});

test('a failed final receipt write cannot install a verified reader for an already connected entry',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('connect');const transaction=f.store.transaction.bind(f.store);
  f.store.transaction=(policy,operation)=>transaction(policy,(state,save)=>operation(state,async()=>{
    if(state.operations.at(-1)?.action==='test'&&state.operations.at(-1)?.result)throw new ExplorerError('CONNECTION_RECOVERY_REQUIRED',503,'Synthetic failed receipt save');
    await save();
  }));
  await assert.rejects(f.action('test'),code('CONNECTION_RECOVERY_REQUIRED'));
  assert.equal((await f.manager.status(f.authority)).connections[0].runtime_ready,false);assert.equal((await f.state()).operations.at(-1).result,null);
  await assert.rejects(f.manager.read(f.authority,r=>r.connection()),code('CONNECTION_DISCONNECTED'));assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,2);
});

test('credential invalidation remains active during durable finalization and blocks late cache installation',async()=>{
  const f=await managerFixture();await f.action('create');let release!:()=>void,reached!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>reached=r),transaction=f.store.transaction.bind(f.store);
  f.store.transaction=(policy,operation)=>transaction(policy,(state,save)=>operation(state,async()=>{
    if(state.operations.at(-1)?.action==='connect'&&state.operations.at(-1)?.result){reached();await gate;}
    await save();
  }));
  const running=f.action('connect');await waiting;await f.manager.changed();release();await running;
  assert.equal((await f.manager.status(f.authority)).connections[0].runtime_ready,false);assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,1);
});

test('approved scope and exact verified generation persist without exposing host paths or credentials',async()=>{
  const f=await managerFixture(),created=await f.action('create');assert.equal(created.connections[0].binding.repository_identity.id,'synthetic-repo');assert.equal(created.profiles[0].binding?.project_id,'explorer-sample');
  const tested=await f.action('test');assert.match(tested.connections[0].last_test!.registry_generation!,/^[a-f0-9]{64}$/);
  assert.equal((await f.make().status(f.authority)).connections[0].last_test!.registry_generation,tested.connections[0].last_test!.registry_generation);
  assert.ok(!JSON.stringify(tested).includes(f.directory));assert.equal(f.calls(),1);
});

test('credential invalidation after cached projection refuses the projected result',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('connect');
  await assert.rejects(f.manager.read(f.authority,async reader=>{
    const projected=reader.connection();assert.equal(projected.ready,true);
    await f.manager.changed();return projected;
  }),code('CONNECTION_CHANGED'));
  assert.equal((await f.manager.status(f.authority)).connections[0].runtime_ready,false);
  assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,1);
});

test('credential invalidation during final asynchronous authorization refuses cached data',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('connect');
  const current=f.authority.current;let projected=false,invalidated=false;
  f.authority.current=async fresh=>{
    if(projected&&!invalidated){invalidated=true;await f.manager.changed();}
    return current(fresh);
  };
  await assert.rejects(f.manager.read(f.authority,reader=>{
    const value=reader.connection();projected=true;return value;
  }),code('CONNECTION_CHANGED'));
  assert.equal(invalidated,true);
  assert.equal((await f.manager.status(f.authority)).connections[0].runtime_ready,false);
  assert.equal(f.calls(),1);
});

test('a replacement runtime with the same catalog epoch cannot authorize an older projection',async()=>{
  const f=await managerFixture();await f.action('create');await f.action('connect');
  const epoch=(await f.state()).epoch;
  await assert.rejects(f.manager.read(f.authority,async reader=>{
    const value=reader.connection();await f.action('test');
    assert.equal((await f.state()).epoch,epoch);return value;
  }),code('CONNECTION_CHANGED'));
  assert.equal((await f.manager.status(f.authority)).connections[0].runtime_ready,false);
  assert.equal((await f.ledger(f.policy.tickets[0].grant_id)).reserved_requests,2);
});

test('reconciliation metadata survives revocation/restart/authentication rotation and stays scoped to owner/installation/catalog',async()=>{
  const f=await managerFixture(),scope=(await f.manager.status(f.authority)).reconciliation_scope;
  assert.match(scope.owner,/^[a-f0-9]{64}$/);assert.match(scope.catalog!,/^[a-f0-9]{64}$/);
  assert.deepEqual((await f.make().status(f.authority)).reconciliation_scope,scope);
  const policy=f.policy;f.setPolicy(undefined);
  const revoked=(await f.manager.status(f.authority)).reconciliation_scope;
  assert.equal(revoked.owner,scope.owner);assert.equal(revoked.catalog,null);
  f.changeOwner({authentication_generation:2});assert.equal((await f.manager.status(f.authority)).reconciliation_scope.owner,scope.owner);
  f.changeOwner({owner_id:randomUUID()});assert.notEqual((await f.manager.status(f.authority)).reconciliation_scope.owner,scope.owner);
  f.changeOwner({owner_id:policy.owner_id,installation_id:randomUUID()});assert.notEqual((await f.manager.status(f.authority)).reconciliation_scope.owner,scope.owner);
  f.changeOwner({installation_id:policy.installation_id});f.setPolicy(policy);
  assert.deepEqual((await f.manager.status(f.authority)).reconciliation_scope,scope);
  assert.ok(!JSON.stringify(scope).includes(policy.owner_id));assert.ok(!JSON.stringify(scope).includes(policy.installation_id));
});
