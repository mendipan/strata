import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupDedicatedRun,type CleanupPort,type RunOwnership } from '../src/artifacts-test-cleanup.js';
const owner:RunOwnership={run_id:'a0b1c2d3e4f56789',instance_created_by_run:true,workflow_created_by_run:true,
  worker_created_by_run:true,repository_created_by_run:true,namespace_created_by_run:true,worker_dispatches:34,
  worker_pending_dispatches:0,observed_tokens_and_handles_clean:true};
function fixture(){const calls:string[]=[];const port:CleanupPort={instanceQuiescent:async()=>true,instanceTerminate:async()=>{calls.push('instanceTerminate');},
  instanceDelete:async()=>{calls.push('instanceDelete');},instanceAbsent:async()=>true,workflowDelete:async()=>{calls.push('workflowDelete');},workflowAbsent:async()=>true,
  workerDelete:async()=>{calls.push('workerDelete');},workerAbsent:async()=>true,repositoryDelete:async()=>{calls.push('repositoryDelete');},repositoryAbsent:async()=>true,
  namespaceEmpty:async()=>true,namespaceDelete:async()=>{calls.push('namespaceDelete');},namespaceAbsent:async()=>true};return {port,calls};}
test('cleanup verifies quiescence and removes instance, Workflow and Worker before synthetic repository',async()=>{
  const f=fixture(),r=await cleanupDedicatedRun(owner,f.port);assert.equal(r.ok,true);
  assert.deepEqual(r.actions,['instanceQuiescent','instanceDelete','instanceAbsent','workflowDelete','workflowAbsent','workerDelete','workerAbsent',
    'repositoryDelete','repositoryAbsent','namespaceEmpty','namespaceDelete','namespaceAbsent']);
  assert.equal(r.provider_cancellation_proven,false);assert.equal(r.pending_actions,0);
});
test('one termination and one recheck; unconfirmed execution prevents resource/data deletion',async()=>{
  const f=fixture();f.port.instanceQuiescent=async()=>false;const r=await cleanupDedicatedRun(owner,f.port);
  assert.equal(r.ok,false);assert.deepEqual(r.actions,['instanceQuiescent','instanceTerminate','instanceQuiescent']);assert.deepEqual(f.calls,['instanceTerminate']);
});
test('no delete without run ownership; unconfirmed Workflow or Worker removal prevents repository deletion',async()=>{
  const f=fixture();assert.deepEqual((await cleanupDedicatedRun({...owner,repository_created_by_run:false},f.port)).actions,[]);
  f.port.workflowAbsent=async()=>false;assert.equal((await cleanupDedicatedRun(owner,f.port)).ok,false);assert.equal(f.calls.includes('repositoryDelete'),false);
  f.port.workflowAbsent=async()=>true;f.port.workerAbsent=async()=>false;assert.equal((await cleanupDedicatedRun(owner,f.port)).ok,false);assert.equal(f.calls.includes('repositoryDelete'),false);
});
test('repository absence checks are at most three with no delete retry',async()=>{
  const f=fixture();f.port.repositoryAbsent=async()=>false;const r=await cleanupDedicatedRun(owner,f.port);
  assert.equal(r.ok,false);assert.equal(r.actions.filter(x=>x==='repositoryAbsent').length,3);assert.equal(f.calls.filter(x=>x==='repositoryDelete').length,1);
});
test('late or unconfirmed provider work and dirty tokens preserve repository after capable resources are removed',async()=>{
  for(const patch of [{worker_pending_dispatches:1},{worker_pending_dispatches:null},{observed_tokens_and_handles_clean:false}]){
    const f=fixture();const r=await cleanupDedicatedRun({...owner,...patch},f.port);assert.equal(r.ok,false);
    assert.equal(r.confirmed.worker_absent,true);assert.equal(r.confirmed.workflow_absent,true);assert.equal(f.calls.includes('repositoryDelete'),false);
  }
});
test('cleanup deadline stops further work and provider errors are sanitized',async()=>{
  const f=fixture();let now=0;f.port.instanceQuiescent=async()=>{now=30000;return true;};const r=await cleanupDedicatedRun(owner,f.port,()=>now);
  assert.equal(r.ok,false);assert.deepEqual(f.calls,[]);
  f.port.instanceQuiescent=async()=>{throw new Error('mock credential body');};assert.doesNotMatch(JSON.stringify(await cleanupDedicatedRun(owner,f.port)),/credential/);
});
