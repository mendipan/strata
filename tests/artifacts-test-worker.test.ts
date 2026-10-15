import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerArtifactsFixture, workerGrant } from './artifacts-worker-fixture.js';
import { artifactsTestFixture } from '../src/artifacts-test-fixture.js';
import { runPrivateTest, TEST_STEP_CONFIG, type PrivateTestStep, executeTest, TestDispatchLedger, TEST_LIMITS, validateGrant } from '../src/artifacts-test-worker.js';
// Fixed test clock keeps expiry/cutoff cases reproducible after the billing date.
const realNow=Date.now; test.before(()=>{Date.now=()=>Date.parse('2026-10-04T12:00:00Z');});test.after(()=>{Date.now=realNow;});

test('fixed four-object fixture matches existing synthetic payload', () => {
  const f = artifactsTestFixture(); assert.equal(f.originalBytes, 4974); assert.equal(f.bytes.get(f.binaryHash)!.byteLength, 69);
  assert.equal(Object.keys(f.records).length + f.bytes.size, 4); assert.equal(f.records['adapter_fixture@1'].published, false);
});
test('real adapter stages, cold-reads and discovers identical batch with bounded cleanup', async () => {
  const f = new WorkerArtifactsFixture(); const result = await runPrivateTest(f.event(),singleStep(),f.env(),f.transport);
  assert.ok('ledger' in result); assert.equal(result.ok, true); assert.equal(f.strict.pushes, 1);
  // The three canonical records now share a read capability; all 12 byte reads remain.
  assert.equal(f.initialRevoked, 1); assert.equal(f.strict.revoked, 2); assert.equal(f.strict.disposed, 5);
  assert.equal(f.strict.openHandles, 0);
  assert.equal(result.ledger.handles, result.ledger.disposed);
  assert.equal(result.ledger.dispatches, 30); assert.equal(result.ledger.counts.readFile, 12);
  assert.equal(result.ledger.counts.gitDiscovery, 2); assert.equal(result.ledger.tokens_observed, 3);
  assert.equal(result.ledger.tokens_revoked, 3); assert.equal(result.ledger.unsettled_dispatches, 0);
  assert.equal(result.ledger.reserved_transfer_bytes <= TEST_LIMITS.transfer_bytes, true);
  assert.equal(result.phases.fresh_instance_read, true); assert.equal(result.phases.identical_retry_reused, true);
  assert.equal(result.cleanup.observed_tokens_and_handles_clean, true); assert.equal(result.cleanup.repository_retained_as_claim, true);
  assert.equal(result.cleanup.external_cleanup_required, true); assert.equal(result.cleanup.repository_removed, false);
  assert.doesNotMatch(JSON.stringify(result), /LOCAL-INITIAL-TOKEN|mock-only-token|authorization|plaintext/);
});
function singleStep(attempt=1,count=1):PrivateTestStep {
  let calls=0;
  return {do:async (name:string,config:unknown,fn:(context:unknown)=>Promise<unknown>)=>{
    assert.equal(++calls,1);assert.equal(name,'synthetic-artifacts-once');assert.deepEqual(config,TEST_STEP_CONFIG);
    return fn({attempt,step:{name,count},config});
  }} as unknown as PrivateTestStep;
}
test('repository claim refuses parallel and repeated callbacks without a second successful workload', async () => {
  const f = new WorkerArtifactsFixture();
  const [a,b] = await Promise.all([runPrivateTest(f.event(),singleStep(),f.env(),f.transport),runPrivateTest(f.event(),singleStep(),f.env(),f.transport)]);
  assert.deepEqual([a.ok,b.ok].sort(),[false,true]);assert.equal(f.strict.pushes,1);assert.equal(f.strict.revoked,2);
  const refusal=await runPrivateTest(f.event(),singleStep(),f.env(),f.transport);assert.ok('ledger' in refusal);
  assert.equal(refusal.error?.code,'RUN_ALREADY_EXISTS');assert.equal(refusal.ledger.dispatches,1);
});
test('disabled/expired/foreign grants and legacy HTTP grants fail before provider I/O', async () => {
  for (const tweak of ['disabled','expired','wrong-fixture','wrong-namespace','wrong-workflow','legacy'] as const) {
    const f=new WorkerArtifactsFixture();
    if(tweak==='disabled')f.grant.approved=false;
    if(tweak==='expired'){f.grant.starts_at=new Date(Date.now()-600000).toISOString();f.grant.expires_at=new Date(Date.now()-1000).toISOString();}
    if(tweak==='wrong-fixture')f.grant.fixture_digest='d'.repeat(64);
    if(tweak==='wrong-namespace')f.grant.namespace='strata';
    if(tweak==='wrong-workflow')f.grant.workflow='shared-workflow';
    const env=f.env();if(tweak==='legacy')env.STRATA_TEST_GRANT=JSON.stringify({...f.grant,format:'strata-artifacts-worker-grant/1',access_aud:'c'.repeat(64)});
    const result=await runPrivateTest(f.event(),singleStep(),env,f.transport);assert.equal(result.ok,false,tweak);assert.equal(f.calls.length,0,tweak);
  }
});
test('private event accepts only pinned instance/workflow/run payload, trigger time and no schedule', async () => {
  const f=new WorkerArtifactsFixture();
  for(const patch of [{instanceId:'other'},{workflowName:'other'},{payload:{run_id:f.grant.run_id,url:'https://evil.test'}},
    {payload:{run_id:'other'}},{payload:'x'.repeat(257)},{timestamp:new Date(0)},{schedule:{cron:'* * * * *'}},{timestamp:new Date('invalid')}]) {
    const result=await runPrivateTest({...f.event(),...patch},singleStep(),f.env(),f.transport);assert.equal(result.ok,false);assert.equal(f.calls.length,0);
  }
});
test('replayed step context is refused even if an engine invokes callback again',async()=>{
  const f=new WorkerArtifactsFixture();for(const [attempt,count] of [[2,1],[1,2]]){
    const result=await runPrivateTest(f.event(),singleStep(attempt,count),f.env(),f.transport);
    assert.equal(result.ok,false);assert.equal(result.error?.code,'WORKFLOW_ATTEMPT_REFUSED');assert.equal(f.calls.length,0);
  }
});
test('corrupt read, wrong remote and lost push response stop work, sanitize errors and clean tokens', async () => {
  for (const fault of ['corruptRead','wrongRemote','loseResponse'] as const) {
    const f = new WorkerArtifactsFixture(); f.strict[fault] = true;
    const result = await executeTest(f.grant,f.namespace,f.transport);
    assert.equal(result.ok, false, fault); assert.equal(result.phases.fresh_instance_read, false);
    assert.equal(result.cleanup.observed_tokens_and_handles_clean, true, fault);
    assert.equal(f.strict.openHandles, 0, fault);
    assert.equal(f.strict.pushes <= 1, true); assert.equal(f.strict.revoked <= 1, true);
    assert.doesNotMatch(JSON.stringify(result), /mock-only-token|LOCAL-INITIAL-TOKEN|credential-sink/);
  }
});
test('initial revocation failure makes no adapter dispatch and no mutation retry', async () => {
  const f = new WorkerArtifactsFixture(); f.failInitialRevoke = true;
  const result = await executeTest(f.grant,f.namespace,f.transport);
  assert.equal(result.ok, false); assert.equal(result.error?.code, 'CLEANUP_FAILED');
  assert.equal(f.calls.filter(x=>x==='revokeInitial').length, 1); assert.equal(f.strict.pushes, 0);
  assert.equal(result.cleanup.observed_tokens_and_handles_clean, false); assert.equal(f.strict.disposed, 1);
});
test('Git redirects are rejected without following or forwarding the repository token', async () => {
  const f=new WorkerArtifactsFixture();let requests=0;
  const result=await executeTest(f.grant,f.namespace,async request=>{
    requests++;assert.equal(request.redirect,'manual');assert.equal(new URL(request.url).origin,new URL(f.remote).origin);
    return new Response(null,{status:302,headers:{location:'https://example.test/credential-sink'}});
  });
  assert.equal(result.ok,false);assert.equal(result.error?.code,'ARTIFACT_PROTOCOL');assert.equal(requests,1);
  assert.equal(f.strict.pushes,0);assert.equal(f.strict.revoked,1);assert.equal(result.cleanup.observed_tokens_and_handles_clean,true);
});
test('ledger charges before dispatch, leaves cleanup headroom and enforces bytes/deadlines', async () => {
  const grant = workerGrant(); let calls = 0; const ledger = new TestDispatchLedger(grant);
  for (let i=0;i<42;i++) await ledger.dispatch('fixture',0,false,async()=>{calls++;});
  assert.throws(()=>ledger.dispatch('fixture',0,false,async()=>{calls++;}), /Dedicated test/);
  for (let i=0;i<4;i++) await ledger.dispatch('cleanup',0,true,async()=>{calls++;});
  assert.throws(()=>ledger.dispatch('cleanup',0,true,async()=>{calls++;})); assert.equal(calls,46);
  const bytes = new TestDispatchLedger(grant); assert.throws(()=>bytes.dispatch('x',TEST_LIMITS.transfer_bytes+1,false,async()=>{calls++;})); assert.equal(bytes.dispatches,0);
  const expired = new TestDispatchLedger(grant,()=>Date.parse(grant.expires_at!)); assert.throws(()=>expired.dispatch('x',0,true,async()=>{calls++;}));
});
test('grant cannot extend ten minutes or cross the Artifacts billing cutoff', () => {
  const g = workerGrant(); g.expires_at = new Date(Date.parse(g.starts_at!)+600001).toISOString(); assert.throws(()=>validateGrant(JSON.stringify(g)));
  g.starts_at='2026-10-13T23:55:00Z';g.expires_at='2026-10-14T00:01:00Z';assert.throws(()=>validateGrant(JSON.stringify(g),Date.parse(g.starts_at!)));
});
