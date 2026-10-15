import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegratedDemo, demoEvent, initialDemoCheckpoint } from '../src/integrated-demo.js';
import { runIntegratedDemoWorkflow } from '../src/integrated-demo-workflow.js';
import { demoFixture, DEMO_NOW } from './integrated-demo-fixture.js';

test('local Workflow output carries settled Artifact cleanup counts from the adapter', async () => {
  const fixture = demoFixture(), runId = '0a1b2c3d4e5f6789', storage = fixture.storage();
  const controller = new IntegratedDemo(storage, () => DEMO_NOW), initial = initialDemoCheckpoint(runId, storage, 'local-rehearsal', DEMO_NOW);
  const bootstrap = demoEvent(initial, 'bootstrap', 'host', {}, 'host-1');
  const apply = controller.apply.bind(controller);
  (controller as any).apply = async (checkpoint: any, event: any, reservation: any) => {
    const result = await apply(checkpoint, event, reservation);
    // Keep this output-path test bounded to one real mocked Artifact stage.
    return { ...result, checkpoint: { ...result.checkpoint, phase: 'complete' } };
  };
  const step = {
    async do(_name: string, _config: unknown, operation: () => Promise<unknown>) { return operation(); },
    async waitForEvent() { return { payload: bootstrap }; }
  } as any;
  const result = await runIntegratedDemoWorkflow({ payload: { run_id: runId }, instanceId: 'run-' + runId } as any, step, controller);
  assert.equal(result.ok, true);
  assert.deepEqual(result.management_cleanup, result.checkpoint.management_cleanup);
  assert.equal(result.management_cleanup.unsettled_dispatches, 0);
  assert.ok(Number.isSafeInteger(result.management_cleanup.repo_tokens_issued));
  assert.ok(Number(result.management_cleanup.repo_tokens_issued) > 0);
  assert.equal(result.management_cleanup.repo_tokens_revoked, result.management_cleanup.repo_tokens_issued);
  assert.equal(result.management_cleanup.handles_open, 0);
});
