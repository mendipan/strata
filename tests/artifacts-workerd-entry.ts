import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import assert from 'node:assert/strict';
import { WorkerArtifactsFixture } from './artifacts-worker-fixture.js';
import { runPrivateTest, TEST_STEP_CONFIG, type TestEnv } from '../src/artifacts-test-worker.js';

// Local bundle only. No fetch handler, provider binding or external transport.
let attempts=0;
export class StrataArtifactsTestWorkflow extends WorkflowEntrypoint<TestEnv & {STRATA_TEST_SCENARIO:string}, {run_id:string}> {
  async run(event:WorkflowEvent<{run_id:string}>,step:WorkflowStep) {
    if(this.env.STRATA_TEST_SCENARIO==='retry-probe') {
      try {await step.do('synthetic-artifacts-once',TEST_STEP_CONFIG,async()=>{attempts++;throw new Error('SANITIZED_LOCAL_RETRY_PROBE');});}
      catch {return {runtime:'workerd',retry_probe:true,attempts,configured_retries:TEST_STEP_CONFIG.retries.limit};}
      throw new Error('Retry probe unexpectedly succeeded.');
    }
    const realNow=Date.now;Date.now=()=>Date.parse('2026-10-04T12:00:00Z');
    try {
      const fixture=new WorkerArtifactsFixture();
      const result=await runPrivateTest({...event,timestamp:new Date(Date.now())},step,fixture.env(),fixture.transport);
      assert.ok('ledger' in result);assert.equal(result.ok,true);assert.equal(result.ledger.dispatches,34);
      assert.equal(fixture.strict.pushes,1);assert.equal(fixture.strict.revoked,2);assert.equal(fixture.initialRevoked,1);
      assert.equal(result.phases.fresh_instance_read,true);assert.equal(result.phases.identical_retry_reused,true);
      assert.equal(result.cleanup.observed_tokens_and_handles_clean,true);
      assert.doesNotMatch(JSON.stringify(result),/LOCAL-INITIAL-TOKEN|mock-only-token|authorization|plaintext/);
      return {runtime:'workerd',fixture_only:true,native_artifacts_binding_verified:false,network_dispatches:0,
        checks:['actual-workflow-engine','zero-retry-config','real-git-pack','four-exact-readbacks','fresh-instance-cold-read',
          'explicit-identical-discovery-one-push','three-tokens-revoked','all-handles-disposed','sanitized-durable-result'],receipt:result};
    }finally{Date.now=realNow;}
  }
}
