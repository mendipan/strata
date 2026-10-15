import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {writePrivate} from '../src/explorer/owner-files.js';
import path from 'node:path';
import {workspaceRuntimeFixture} from './workspace-runtime-fixture.js';
test('zero-effect broker dry runs need no write qualification and leave no intent across restart, same/new-key writes and replay',async t=>{
 const f=await workspaceRuntimeFixture();let active=await f.start({qualify:false});t.after(()=>active.broker.close());
 const key=randomUUID(),index=await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),usage=await f.budget.snapshot(),state=await f.control.snapshot();
 const dry=await active.call('layer.create',{record:f.layer},key,true);assert.equal(dry.ok,true,JSON.stringify(dry));assert.equal(dry.dry_run,true);assert.deepEqual(dry.created,[]);
 assert.deepEqual(await f.control.snapshot(),state);assert.deepEqual(await f.budget.snapshot(),usage);assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),index);assert.deepEqual(f.counts(),{pushes:0,mints:0,revokes:0});
 await active.broker.close();active=await f.start({qualify:false});
 assert.equal((await active.call('operation.inspect',{key})).data.state,'not_found');
 assert.equal((await active.call('layer.create',{record:f.layer},key)).error.code,'WRITE_PERMISSION_UNVERIFIED');assert.deepEqual(await f.control.snapshot(),state);
 await active.runtime.test({action:'test-write',revision:state.revision,request_id:randomUUID()},f.ownerProof);
 assert.equal((await active.call('layer.create',{record:f.layer},key)).ok,true);assert.equal(f.counts().pushes,1);
 const afterWrite=await f.budget.snapshot();assert.equal((await active.call('layer.create',{record:f.layer},key)).reused,true);assert.deepEqual(await f.budget.snapshot(),afterWrite);
 const second={...f.layer,id:'DryThenNewKey'},secondKey=randomUUID(),afterState=await f.control.snapshot();
 assert.equal((await active.call('layer.create',{record:second},secondKey,true)).ok,true);assert.deepEqual(await f.control.snapshot(),afterState);assert.deepEqual(await f.budget.snapshot(),afterWrite);
 assert.equal((await active.call('layer.create',{record:second},randomUUID())).ok,true);assert.equal(f.counts().pushes,2);
 const beforeFailedDry=await f.control.snapshot(),failure={...f.layer,owner:'another-person'};assert.equal((await active.call('layer.create',{record:failure},randomUUID(),true)).ok,false);
 assert.deepEqual(await f.control.snapshot(),beforeFailedDry);assert.ok(beforeFailedDry.operations.every(o=>['committed','cancelled_before_effect'].includes(o.phase)));assert.equal(beforeFailedDry.operations.filter(o=>o.phase==='committed').length,2);
});
test('real v0.1 draft create/publish/compose persists through immutable Node adapter and cold restart with no replay push',async t=>{
 const f=await workspaceRuntimeFixture();let active=await f.start();t.after(()=>active.broker.close());const key=randomUUID();
 const first=await active.call('layer.create',{record:f.layer},key);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(f.counts().pushes,1);
 const replay=await active.call('layer.create',{record:f.layer},key);assert.equal(replay.ok,true);assert.equal(replay.reused,true);assert.equal(f.counts().pushes,1);
 const publish=await active.call('layer.publish',{ref:'WorkspaceDraft@1'},randomUUID());assert.equal(publish.ok,true,JSON.stringify(publish));assert.equal(f.counts().pushes,1);
 const compose=await active.call('compose',{record:{id:'WorkspaceCandidate',revision:1,model_version:f.grant.model_version,baseline:'CounterBaseline@1',proposals:['WorkspaceDraft@1'],selected:['WorkspaceDraft@1'],alternative_groups:[],scenario:{id:'counter-workspace',checks:[{id:'counter.compatibility',version:'1'}]},resolutions:[]}},randomUUID());assert.equal(compose.ok,true,JSON.stringify(compose));assert.equal(f.counts().pushes,2);
 const before=await f.budget.snapshot();await active.broker.close();active=await f.start();
 assert.equal((await active.call('layer.create',{record:f.layer},key)).reused,true);assert.deepEqual(await f.budget.snapshot(),before);assert.equal(f.counts().pushes,2);
 const index=JSON.parse(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'));assert.ok(index.workspace_commits);assert.ok(!Object.values(index.entries).some((e:any)=>e.type==='auth-receipt'));
});
test('revocation during pending-index preparation blocks generic rename and preserves old index',async t=>{
 const f=await workspaceRuntimeFixture(),before=await readFile(path.join(f.directories.broker,'registry.json'),'utf8');
 const active=await f.start({beforeRenameForTest:async()=>f.rotateCredential()});t.after(()=>active.broker.close());
 const r=await active.call('layer.create',{record:f.layer},randomUUID());assert.equal(r.ok,false);assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),before);assert.equal(f.counts().pushes,1);
});
test('rename followed by directory fsync failure retains receipt, permits exact outcome, blocks fresh mutation',async t=>{
 const f=await workspaceRuntimeFixture(),active=await f.start({directorySyncForTest:()=>{throw Error('synthetic fsync failure');}});t.after(()=>active.broker.close());const key=randomUUID();
 const result=await active.call('layer.create',{record:f.layer},key);assert.equal(result.error.code,'WORKSPACE_DURABILITY_UNCERTAIN');
 assert.equal((await active.call('operation.inspect',{key})).data.state,'committed');
 assert.equal((await active.call('layer.create',{record:f.layer},key)).reused,true);assert.equal(f.counts().pushes,1);
 const second=structuredClone(f.layer);second.id='DifferentDraft';const denied=await active.call('layer.create',{record:second},randomUUID());assert.equal(denied.error.code,'WRITE_RECONCILIATION_REQUIRED');assert.equal(f.counts().pushes,1);
});
test('lost push response survives restart as unresolved, with no automatic mint or publication',async t=>{
 const f=await workspaceRuntimeFixture();f.setMode('push-response-lost');let active=await f.start();t.after(()=>active.broker.close());
 const key=randomUUID(),result=await active.call('layer.create',{record:f.layer},key);assert.equal(result.ok,false);assert.equal(f.counts().pushes,1);await active.broker.close();active=await f.start();f.setMode('ok');
 const status=(await active.call('operation.inspect',{key})).data;assert.equal(status.state,'reconciliation_required');assert.equal(status.phase,'reconciliation_required');assert.equal(f.counts().pushes,1);
 const denied=await active.call('layer.create',{record:f.layer},randomUUID());assert.equal(denied.error.code,'WRITE_RECONCILIATION_REQUIRED');assert.equal(f.counts().mints,2);
});
test('permission check is explicit, durable and exact UUID replay performs no new provider action',async t=>{
 const f=await workspaceRuntimeFixture(),active=await f.start({qualify:false});t.after(()=>active.broker.close());
 assert.equal((await active.call('layer.create',{record:f.layer},randomUUID())).error.code,'WRITE_PERMISSION_UNVERIFIED');assert.equal(f.counts().mints,0);
 const input={action:'test-write',revision:(await f.control.snapshot()).revision,request_id:randomUUID()};
 await active.runtime.test(input,f.ownerProof);const usage=await f.budget.snapshot();assert.equal(f.counts().mints,1);assert.equal(f.counts().pushes,0);
 await active.runtime.test(input,f.ownerProof);assert.deepEqual(await f.budget.snapshot(),usage);assert.equal(f.counts().mints,1);
 assert.equal((await active.call('layer.create',{record:f.layer},randomUUID())).ok,true);assert.equal(f.counts().pushes,1);
});
test('credential generation change requires a new explicit write check and never resets usage',async t=>{
 const f=await workspaceRuntimeFixture(),active=await f.start();t.after(()=>active.broker.close());const before=await f.budget.snapshot();
 f.rotateCredential();assert.equal((await active.call('layer.create',{record:f.layer},randomUUID())).error.code,'WRITE_PERMISSION_UNVERIFIED');assert.deepEqual(await f.budget.snapshot(),before);assert.equal(f.counts().pushes,0);
});
test('explicit committed-index reconciliation repairs lagging journal without another provider call',async t=>{
 const f=await workspaceRuntimeFixture(),active=await f.start({directorySyncForTest:()=>{throw Error('synthetic fsync failure');}});t.after(()=>active.broker.close());
 const key=randomUUID(),r=await active.call('layer.create',{record:f.layer},key),before=f.counts(),receipt=(await active.call('operation.inspect',{key})).data.result;
 assert.equal(r.error.code,'WORKSPACE_DURABILITY_UNCERTAIN');const repaired=await active.runtime.reconcileCommitted(receipt.operation_id,f.ownerProof);assert.equal(repaired.state,'committed');assert.deepEqual(f.counts(),before);
 assert.equal((await f.control.snapshot()).operations.find(o=>o.operation_id===receipt.operation_id)?.phase,'committed');
});
test('v0.1 hosted evidence/approval/Release and another owner draft remain refused',async t=>{
 const f=await workspaceRuntimeFixture(),active=await f.start();t.after(()=>active.broker.close());
 for(const command of ['approve','evidence.run','validate','release'])assert.equal((await active.call(command,{},randomUUID())).ok,false);
 const wrong={...f.layer,owner:'author-a'};assert.equal((await active.call('layer.create',{record:wrong},randomUUID())).ok,false);assert.equal(f.counts().pushes,0);
});
test('pause resumes the same allowance; permanent tombstone refuses an older restored control',async()=>{
 const f=await workspaceRuntimeFixture(),before=await f.control.snapshot(),usage=await f.budget.snapshot();
 await f.control.action({action:'disconnect',revision:before.revision,request_id:randomUUID()},async()=>{});
 await f.control.action({action:'connect',revision:before.revision+1,request_id:randomUUID()},async()=>{});assert.deepEqual(await f.budget.snapshot(),usage);
 await f.control.action({action:'revoke',revision:before.revision+2,request_id:randomUUID()},async()=>{});
 await assert.rejects(f.control.action({action:'connect',revision:before.revision+3,request_id:randomUUID()},async()=>{}),(e:any)=>e.code==='REPOSITORY_ACCESS_REVOKED');
 await writePrivate(path.join(f.directories.control,'workspace.json'),before);await assert.rejects(f.control.snapshot(),(e:any)=>e.code==='REPOSITORY_ACCESS_REVOKED');assert.deepEqual(await f.budget.snapshot(),usage);
});
test('parallel authenticated metadata queries serialize in-process without false reconciliation or spending',async()=>{
 const f=await workspaceRuntimeFixture(),before=await f.budget.snapshot();
 const results=await Promise.all(Array.from({length:24},async()=>{const state=await f.control.assertCurrent();const usage=await f.budget.snapshot();return {revision:state.revision,usage};}));
 assert.equal(results.length,24);assert.ok(results.every(r=>r.revision===1));assert.deepEqual(await f.budget.snapshot(),before);assert.deepEqual(f.counts(),{mints:0,pushes:0,revokes:0});
});
