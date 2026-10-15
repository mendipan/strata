import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runIntegratedDemoWorkflow, DEMO_STEP_CONFIG } from '../src/integrated-demo-workflow.js';
import { IntegratedDemo } from '../src/integrated-demo.js';
import { demoFixture, DEMO_NOW } from './integrated-demo-fixture.js';

// Explicit local-only fixture bundle. No remote binding or fallback transport.
let failureAttempts = 0;
export class StrataIntegratedDemoWorkflow extends WorkflowEntrypoint<{ STRATA_DEMO_LOCAL_PROBE?: string }, { run_id: string }> {
  async run(event: WorkflowEvent<{ run_id: string }>, step: WorkflowStep) {
    if (this.env.STRATA_DEMO_LOCAL_PROBE === 'failure-probe') {
      try { await step.do('local-failure-probe', DEMO_STEP_CONFIG, async () => { failureAttempts++; throw new Error('LOCAL-DEMO-FAILURE-PROBE'); }); }
      catch { return { local_only: true, attempts: failureAttempts, configured_retries: DEMO_STEP_CONFIG.retries.limit }; }
      throw new Error('Unexpected successful failure probe');
    }
    const fixture = demoFixture();
    const result = await runIntegratedDemoWorkflow(event, step, new IntegratedDemo(fixture.storage(), () => DEMO_NOW));
    return { ...result, fixture_only: true, real_model_calls: 0, actual_human_replies: 0, provider_calls: 0,
      mock_dispatches: fixture.strict.calls.filter(call => call !== 'dispose').length,
      mock_pushes: fixture.strict.pushes, revoked: fixture.strict.revoked, disposed: fixture.strict.disposed };
  }
}
