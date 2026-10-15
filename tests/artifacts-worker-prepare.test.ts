import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { prepareWorker } from '../scripts/artifacts-worker-prepare.js';
test('sealed local plan is one private Workflow, keeps grants disabled and has no HTTP/Access route',async()=>{
  const m=await prepareWorker('a0b1c2d3e4f56789', 'a'.repeat(32));
  assert.equal(m.live_enabled,false);assert.equal(m.grant.approved,false);assert.equal(m.grant.approval_id,null);
  // The generated config lives in ignored .strata/, so its source/schema paths
  // must still resolve to the project when Wrangler reads that config location.
  assert.equal(path.resolve('.strata', m.config.main), path.resolve('src/artifacts-test-worker-entry.ts'));
  await access(path.resolve('.strata', m.config['$schema']));
  assert.equal(m.config.workers_dev,false);assert.equal(m.config.preview_urls,false);assert.equal(m.config.send_metrics,false);
  assert.equal(m.config.artifacts.length,1);assert.equal(m.config.artifacts[0].namespace,'strata-test-a0b1c2d3e4f56789');
  assert.equal(m.grant.repository,'run-a0b1c2d3e4f56789');assert.equal(m.config.workflows.length,1);
  assert.equal(m.config.workflows[0].limits.steps,1);assert.equal(m.config.workflows[0].concurrency.limit,1);
  assert.equal(m.invocation.step_config.retries.limit,0);assert.equal(m.invocation.planned_instances,1);assert.equal(m.invocation.no_fetch_handler,true);
  assert.equal(m.grant.source_digest,m.bundle.sha256);assert.match(m.bundle.sha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.keys(m.bundle.input_sha256).some(name=>name.startsWith('tests/')),false);
  assert.equal(m.workload.original_bytes,4974);assert.equal(m.workload.maximum_models,0);
  assert.equal(m.cost.provider_invoice_cap_proven,false);assert.equal(m.invocation.new_credentials,0);
  assert.equal('access' in m,false);assert.equal('routes' in m.config,false);
  assert.equal(m.management.actions.reduce((n,a)=>n+a.maximum_logical_requests,0),m.management.maximum_logical_requests);
  assert.equal(m.cleanup.provider_resource_and_instance_deletion_reversible,false);
});
test('preparation neither assumes personal billing state nor assigns a default account',async()=>{
  const m=await prepareWorker('a0b1c2d3e4f56789','b'.repeat(32));
  assert.equal(m.grant.account_id,'b'.repeat(32));assert.equal(m.config.account_id,m.grant.account_id);
  assert.equal(m.cost.estimates_available,false);assert.equal(m.cost.requires_current_provider_pricing,true);
  assert.equal(m.state.retention_deployment_acceptance_verified,false);
  await assert.rejects(prepareWorker('a0b1c2d3e4f56789',undefined as any));
  await assert.rejects(prepareWorker('a0b1c2d3e4f56789','invalid'));
});
test('prepare refuses variable resource names before bundling',async()=>{
  await assert.rejects(prepareWorker('../../strata','a'.repeat(32)));await assert.rejects(prepareWorker('strata','a'.repeat(32)));
});
