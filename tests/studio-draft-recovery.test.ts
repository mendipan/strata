import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import path from 'node:path';
import { namespaceFixture } from './namespace-fixture.js';
import { digest } from '../src/model.js';
import { writePrivate } from '../src/explorer/owner-files.js';
const local={skip:process.platform!=='win32'&&process.getuid?.()!==0?'Protected POSIX fixtures require root.':false};
async function paused(t:any){
  const f=await namespaceFixture();t.after(()=>f.server.close());const index=f.seedExisting();await f.prepare();
  assert.equal((await f.action('import',{name:'existing-project',repository_id:index.repository_id,index,acknowledgment:'open-snapshot-and-save-new-drafts'})).status,200);
  const h={'x-strata-repository':index.repository_id},actor=await f.b.send('/studio/actor/session','POST',{},f.csrf),cap=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,h);
  f.setMode('lost-token');const failed=await f.b.send('/studio/v1/operation','POST',{command:'layer.create',input:{record:{...f.base.layer,id:'AttemptedDraft',owner:cap.data.data.principal_id}},idempotency_key:randomUUID(),expected_generation:cap.data.data.generation,expected_policy:cap.data.data.policy_generation},actor.data.csrf,h);assert.equal(failed.status,503,failed.text);f.setMode('ok');
  const project=(await f.server.store.snapshot()).projects[0],root=path.join(f.config.projects_directory,digest({repository_id:project.id,import_id:project.creation_id}));
  return {f,index,h,root,control:path.join(root,'control','workspace.json'),registry:path.join(root,'broker','registry.json')};
}
test('browser recovery retains history and credentials, qualifies saving and preserves imported drafts across restart',local,async t=>{
  const {f,index,h,root,control,registry}=await paused(t),before=await readFile(registry,'utf8'),old=JSON.parse(await readFile(control,'utf8')),credential=(await f.b.send('/studio/v1/owner/credentials')).data,usage=await f.server.store.usageSnapshot();
  const cap0=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,h);assert.equal(cap0.data.data.write_recovery_available,true);
  const s=await f.server.store.snapshot(),body={action:'resume-drafts',repository_id:index.repository_id,revision:s.revision,request_id:randomUUID()};
  const resumed=await f.b.send('/studio/v1/owner/connections','POST',body,f.csrf);assert.equal(resumed.status,200,resumed.text);
  assert.equal(await readFile(registry,'utf8'),before);assert.equal(f.repos.get('existing-project')!.git.pushes,0);
  const state=JSON.parse(await readFile(control,'utf8')),resolved=state.operations.find((o:any)=>o.operation_id===old.operations[0].operation_id);
  assert.deepEqual(resolved.events.slice(0,3),old.operations[0].events);assert.equal(resolved.phase,'cancelled_before_effect');assert.deepEqual(state.tests[0],old.tests[0]);
  assert.equal((await readdir(path.join(root,'broker','permission-recovery'))).length,1);assert.deepEqual((await f.b.send('/studio/v1/owner/credentials')).data,credential);
  assert.ok((await f.server.store.usageSnapshot()).reserved.requests>usage.reserved.requests);
  const count=f.calls.length;assert.equal((await f.b.send('/studio/v1/owner/connections','POST',body,f.csrf)).data.replayed,true);assert.equal(f.calls.length,count);
  const actor=await f.b.send('/studio/actor/session','POST',{},f.csrf),cap=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,h);assert.equal(cap.data.data.write_blocked,false);assert.equal(cap.data.data.write_configured,true);
  const saved=await f.b.send('/studio/v1/operation','POST',{command:'layer.create',input:{record:{...f.base.layer,id:'AfterRecovery',owner:cap.data.data.principal_id}},idempotency_key:randomUUID(),expected_generation:cap.data.data.generation,expected_policy:cap.data.data.policy_generation},actor.data.csrf,h);assert.equal(saved.status,200,saved.text);assert.equal(f.repos.get('existing-project')!.git.pushes,1);
  await f.restart();await f.login();assert.equal((await f.b.send('/studio/actor/session','POST',{},f.csrf)).status,200);
  const c=await f.b.send('/studio/v1/connection','GET',undefined,undefined,h),records=await f.b.send('/studio/v1/records?type=layer&generation='+c.data.data.source.registry_generation,'GET',undefined,undefined,h);
  assert.deepEqual(records.data.data.items.map((r:any)=>r.ref).sort(),['AfterRecovery@1','WorkspaceDraft@1']);
});
test('active tokens, partial inventories and foreign repository selections cannot clear the pause',local,async t=>{
  const {f,index,control,registry}=await paused(t),before=await readFile(control,'utf8'),indexBefore=await readFile(registry,'utf8');
  const calls=f.calls.length;assert.equal((await f.action('resume-drafts',{repository_id:'foreign'})).status,403);assert.equal(f.calls.length,calls);
  for(const mode of ['active-recovery-token','active-second-page','incomplete-token-list','denied']){
    f.setMode(mode);const result=await f.action('resume-drafts',{repository_id:index.repository_id});assert.notEqual(result.status,200,mode);
    assert.equal(await readFile(control,'utf8'),before);assert.equal(await readFile(registry,'utf8'),indexBefore);assert.equal(f.repos.get('existing-project')!.git.pushes,0);
  }
});
test('a real payload operation is never treated as a recoverable permission test',local,async t=>{
  const {f,index,control}=await paused(t),s=JSON.parse(await readFile(control,'utf8'));const o=s.operations[0];o.events.splice(2,0,{phase:'push_unknown',detail:{commit:'a'.repeat(40),branch:'refs/heads/strata/artifacts/'+'b'.repeat(64)}});await writePrivate(control,s);
  const before=await readFile(control,'utf8'),calls=f.calls.length;assert.notEqual((await f.action('resume-drafts',{repository_id:index.repository_id})).status,200);
  assert.equal(await readFile(control,'utf8'),before);assert.equal(f.calls.length,calls);
});
