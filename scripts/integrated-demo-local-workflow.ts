import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { rehearseIntegratedDemo } from './integrated-demo-rehearsal.js';
import { demoEventType } from '../src/integrated-demo-workflow.js';
import { checkpointDigest, DEMO_LIMITS } from '../src/integrated-demo.js';
import { bytesDigest } from '../src/model.js';

export async function validateIntegratedLocalWorkflow() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-integrated-workflow-'));
  let runtime: Miniflare | undefined, externalAttempts = 0;
  const evidence: any = { mode: 'local-native-workflow-only', live_authorized: false, provider_calls: 0, real_model_calls: 0, actual_human_replies: 0, branches: [] };
  try {
    for (const kind of ['production-disabled', '900', '1200', 'failure-probe'] as const) {
      const name = 'strata-integrated-local-' + kind, workflowName = 'strata-integrated-flow-' + kind;
      const outfile = path.join(directory, kind + '.mjs');
      const nodeRun = kind === 'production-disabled' || kind === 'failure-probe' ? null : await rehearseIntegratedDemo(kind);
      await build({ entryPoints: [kind === 'production-disabled' ? 'src/integrated-demo-worker-entry.ts' : 'tests/integrated-demo-workerd-entry.ts'],
        outfile, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*', 'cloudflare:*'], logLevel: 'silent' });
      runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, log: new Log(LogLevel.ERROR), workers: [{
        config: { name, compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
          manifest: { mainModule: 'worker.mjs', modulesRoot: directory, modules: { 'worker.mjs': { type: 'esm', contents: await readFile(outfile, 'utf8') } } },
          exports: { StrataIntegratedDemoWorkflow: { type: 'workflow', name: workflowName, limits: { steps: DEMO_LIMITS.steps }, concurrency: { limit: 1 }, defaultRetention: { successRetention: 3600000, errorRetention: 3600000 } } },
          env: { STRATA_DEMO_LOCAL_PROBE: { type: 'text', value: kind }, STRATA_DEMO_WORKFLOW: { type: 'workflow', name: workflowName, worker: name, exportName: 'StrataIntegratedDemoWorkflow', limits: { steps: DEMO_LIMITS.steps } } } },
        dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler: async () => { externalAttempts++; throw new Error('External network prohibited.'); } } }
      }] });
      const bindings = await runtime.getBindings<{ STRATA_DEMO_WORKFLOW: Workflow<{ run_id: string }> }>();
      const instance = await bindings.STRATA_DEMO_WORKFLOW.create({ id: 'run-0a1b2c3d4e5f6789', params: { run_id: '0a1b2c3d4e5f6789' } });
      await assert.rejects(bindings.STRATA_DEMO_WORKFLOW.create({ id: instance.id, params: { run_id: '0a1b2c3d4e5f6789' } }));
      if (nodeRun) for (const event of nodeRun.events) await instance.sendEvent({ type: demoEventType(event.sequence), payload: event });
      let status = await instance.status();
      for (let reads = 0; !['complete', 'errored'].includes(status.status) && reads < 400; reads++) { await new Promise(resolve => setTimeout(resolve, 25)); status = await instance.status(); }
      assert.equal(status.status, 'complete', JSON.stringify(status));
      const result: any = status.output;
      if (kind === 'failure-probe') { assert.deepEqual(result, { local_only: true, attempts: 1, configured_retries: 0 }); evidence.retry_probe = result; }
      else if (!nodeRun) { assert.deepEqual(result, { ok: false, error: { code: 'DEMO_LIVE_ACTIVATION_REQUIRED' } }); evidence.disabled_entry = { result, bundle_sha256: bytesDigest(await readFile(outfile)), no_http_handler: true }; }
      else {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.checkpoint.phase, 'complete');
        assert.equal(checkpointDigest(result.checkpoint), nodeRun.checkpoint_digest);
        assert.equal(result.mock_pushes, nodeRun.pushes);
        assert.equal(result.mock_dispatches, nodeRun.artifact_mock_calls - Object.keys(nodeRun.checkpoint.registry.entries).length * 3, 'Node adds one final cold read after the Workflow scenario');
        assert.equal(result.automatic_retries, 0); assert.ok(result.used_steps <= DEMO_LIMITS.steps);
        evidence.branches.push({ choice: kind, native_event_waits: nodeRun.events.length, used_steps: result.used_steps,
          checkpoint_bytes: result.checkpoint_bytes, checkpoint_digest: checkpointDigest(result.checkpoint),
          mock_dispatches: result.mock_dispatches, mock_pushes: result.mock_pushes, tokens_revoked: result.revoked,
          node_app_evidence_digest: nodeRun.evidence_digest, identical_node_and_workerd_checkpoint: true,
          bundle_sha256: bytesDigest(await readFile(outfile)), duplicate_fixed_instance_refused: true });
      }
      await runtime.dispose(); runtime = undefined;
    }
    assert.equal(externalAttempts, 0); evidence.external_network_attempts = externalAttempts; return evidence;
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !process.argv[2].endsWith('.json')) throw new Error('Provide a local evidence JSON path; no live mode.');
  const result = await validateIntegratedLocalWorkflow(); await writeFile(path.resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
}
