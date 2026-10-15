import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runPrivateTest, type TestEnv } from './artifacts-test-worker.js';

// Deployment exports one Workflow class and no fetch/RPC/public handler.
export class StrataArtifactsTestWorkflow extends WorkflowEntrypoint<TestEnv, {run_id:string}> {
  run(event: WorkflowEvent<{run_id:string}>, step: WorkflowStep) {
    return runPrivateTest(event, step, this.env);
  }
}
