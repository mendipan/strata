import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactsTestFixture } from '../src/artifacts-test-fixture.js';
import { bytesDigest } from '../src/model.js';
import { TEST_LIMITS, TEST_STEP_CONFIG, type TestGrant } from '../src/artifacts-test-worker.js';

export async function prepareWorker(runId: string, accountId: string, root = process.cwd()) {
  if (!/^[a-f0-9]{16}$/.test(runId)) throw new Error('Expected one fixed 16-hex run ID.');
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('An explicit account ID is required; no account is selected by default.');
  const fixture = artifactsTestFixture();
  const bundle = await build({ absWorkingDir: root, entryPoints: ['src/artifacts-test-worker-entry.ts'], bundle: true,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*','cloudflare:*'], write: false, metafile: true, logLevel: 'silent' });
  const sourceDigest = bytesDigest(bundle.outputFiles[0].contents);
  const inputs: Record<string,string> = {};
  for (const name of Object.keys(bundle.metafile!.inputs).sort()) inputs[name] = bytesDigest(await readFile(path.resolve(root,name)));
  const grant: TestGrant = { format: 'strata-artifacts-workflow-grant/1', approved: false, approval_id: null, run_id: runId,
    account_id: accountId, namespace: `strata-test-${runId}`, repository: `run-${runId}`,
    worker: `strata-artifacts-test-${runId}`, workflow:`strata-artifacts-flow-${runId}`,instance_id:`run-${runId}`,
    project_id: fixture.projectId, source_digest: sourceDigest, fixture_digest: fixture.fixtureDigest, starts_at: null, expires_at: null };
  const config = { '$schema': path.resolve(root, 'node_modules/wrangler/config-schema.json'), name: grant.worker,
    main: path.resolve(root, 'src/artifacts-test-worker-entry.ts'),
    account_id: grant.account_id, compatibility_date: '2026-10-03', compatibility_flags: ['nodejs_compat'],
    workers_dev: false, preview_urls: false, send_metrics: false, observability: { enabled: false },
    limits: { cpu_ms: TEST_LIMITS.cpu_ms, subrequests: TEST_LIMITS.subrequests },
    workflows:[{binding:'STRATA_TEST_WORKFLOW',name:grant.workflow,class_name:'StrataArtifactsTestWorkflow',limits:{steps:1},concurrency:{limit:1},
      default_retention:{success_retention:TEST_LIMITS.retention_ms,error_retention:TEST_LIMITS.retention_ms}}],
    artifacts: [{ binding: 'ARTIFACTS', namespace: grant.namespace }], vars: { STRATA_TEST_GRANT: JSON.stringify(grant) } };
  const actions = [
    {phase:'preflight', action:'Verify existing account/auth pin and exact Worker, Workflow, instance and namespace absence; never adopt existing resources', mutations:0, maximum_logical_requests:5},
    {phase:'setup', action:'Create exact isolated Artifacts namespace', mutations:1, maximum_logical_requests:1},
    {phase:'setup', action:'Deploy exact private Worker and its one Workflow after approved grant/time finalization; no routes or URL activation', mutations:'one Worker + one Workflow definition', maximum_logical_requests:1},
    {phase:'verify', action:'Verify deployed source/version, private URL/route configuration, Workflow class/step/concurrency/retention settings and exact Artifacts namespace binding', mutations:0, maximum_logical_requests:4},
    {phase:'run', action:'One explicit control-plane trigger with fixed instance ID and only run_id JSON payload; no restart/resume/retrigger/automatic CLI retry', mutations:1, maximum_logical_requests:1},
    {phase:'run', action:'At most three bounded control-plane status reads; save sanitized receipt locally; ambiguous result stops work', mutations:0, maximum_logical_requests:3},
    {phase:'cleanup', action:'Confirm instance terminal; if needed terminate once and recheck once; delete instance and verify absence', mutations:2, maximum_logical_requests:5},
    {phase:'cleanup', action:'Delete exact run-owned Workflow definition; verify absence before deleting Worker or repository', mutations:1, maximum_logical_requests:2},
    {phase:'cleanup', action:'Delete dedicated Worker and verify absence before repository deletion', mutations:1, maximum_logical_requests:2},
    {phase:'cleanup', action:'Delete exact run-owned synthetic repository, at most three absence checks', mutations:1, maximum_logical_requests:4, included_in_artifacts_dispatch_envelope:true},
    {phase:'cleanup', action:'Check isolated namespace empty, delete it and verify absence', mutations:1, maximum_logical_requests:3},
    {phase:'billing', action:'Read existing test-window metrics/billing with reporting timestamps; no new services', mutations:0, maximum_logical_requests:2}
  ];
  return { format:'strata-private-workflow-approval-manifest/1', live_enabled:false, grant, config,
    bundle:{sha256:sourceDigest,bytes:bundle.outputFiles[0].contents.byteLength,input_sha256:inputs},
    invocation:{transport:'supported Wrangler Workflows authenticated control plane; ordinary deployed execution',
      public_endpoints:0,new_credentials:0,preview_proxy:false,planned_instances:1,instance_id:grant.instance_id,payload:{run_id:runId},
      step_name:'synthetic-artifacts-once',step_config:TEST_STEP_CONFIG,automatic_application_retries:0,automatic_workflow_step_retries:0,
      manual_restart_resume_or_second_trigger_authorized:false,provider_infrastructure_replay_cannot_be_absolutely_excluded:true,
      distributed_claim:'create fixed repository once; ALREADY_EXISTS refuses without token issuance or push',
      run_wall_time_ms:TEST_LIMITS.grant_ms,work_cutoff_before_expiry_ms:TEST_LIMITS.cleanup_ms,maximum_status_reads:TEST_LIMITS.status_reads,
      no_fetch_handler:true,no_ai:true,no_cron:true,no_external_service_bindings:true,
      trigger_command:['wrangler','workflows','trigger',grant.workflow,JSON.stringify({run_id:runId}),'--id',grant.instance_id,'--json','--config','.strata/artifacts-test.wrangler.json'],
      status_command:['wrangler','workflows','instances','describe',grant.workflow,grant.instance_id,'--json','--config','.strata/artifacts-test.wrangler.json']},
    workload:{...TEST_LIMITS,objects:4,original_bytes:fixture.originalBytes,fixture_sha256:fixture.fixtureDigest,
      expected_worker_dispatches:34,maximum_dispatches_with_final_repository_removal:50,dispatch_limit_is_account_wide:false,
      expected_tokens:3,automatic_initial_token:1,explicit_write_tokens:{count:2,ttl_seconds:60},expected_pushes:1,
      expected_discovery_reads:2,expected_raw_file_reads:12,fresh_instance_only:true,maximum_models:0,automatic_retries:0,
      explicit_identical_batch_discovery_phases:1,resource_removal_inside_workflow:false},
    state:{maximum_payload_json_bytes:256,maximum_receipt_json_bytes:32768,maximum_managed_json_bytes_payload_plus_step_plus_result:65792,
      provider_metadata_overhead_bytes:'unmeasured; application JSON bound is not a billed-state ceiling',
      configured_success_and_error_retention_ms:3600000,retention_deployment_acceptance_verified:false,
      token_plaintext_persisted:false,raw_provider_exceptions_persisted:false},
    management:{actions,maximum_logical_requests:actions.reduce((n,a)=>n+a.maximum_logical_requests,0),
      underlying_cli_http_dispatches_bounded:false,no_automatic_cli_retries_authorized:true,
      cleanup_port:'local injected coordinator; supported live operator transport not implemented',
      cleanup_deadline_ms:TEST_LIMITS.cleanup_ms,unconfirmed_cleanup_stops_further_deletion:true,
      pending_provider_work_or_unclean_tokens_preserve_repository_after_capable_resources_removed:true},
    cost: { provider_invoice_cap_proven: false, estimates_available: false, requires_current_provider_pricing: true },
    cleanup:{local_edits_reversible:true,synthetic_fixture_reproducible:true,provider_resource_and_instance_deletion_reversible:false,
      accrued_charges_reversible:false,no_shared_or_retained_strata_resources_targeted:true} };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 5 || process.argv[2] !== '--plan') { console.error('Use --plan <16-hex-run-id> <account-id>. Local bundling only; no live mode.'); process.exitCode=2; }
  else console.log(JSON.stringify(await prepareWorker(process.argv[3], process.argv[4]),null,2));
}
