// Offline structural gate for the synthetic normalized Cursor Cloud Agents
// API v1 transcripts. Verifies every scenario against the shared execution/1
// schemas and rules: task identity digests, snapshot transitions, result and
// artifact digests, conservative errors, the explicitly reviewed native
// vocabulary and the claimed source pins (recomputed from the retained local
// snapshot). It validates synthetic common DTO consistency and one explicitly
// checked native subset only; it is NOT a functioning mapper, complete native
// wire schema validation, durable storage, runtime identity or Cursor
// qualification. Pin fingerprints are documentation metadata, never authentic
// execution evidence. No provider network, credentials or runtime launch.
// Uses the precompiled shared dist and Node builtins only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  executionTaskSchema, executionTaskRefSchema, executionSnapshotSchema, executionResultSchema,
  executionErrorCodeSchema, executionTaskRef, executionDigest, sameExecutionValue, assertExecutionTransition,
} from '../../../../dist/src/agent-execution.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, 'transcripts.json'), 'utf8');
const doc = JSON.parse(raw);

// Small reviewed vocabulary for the selected surface, mirroring the pinned
// OpenAPI subset evidence. Not proof of full native protocol compatibility.
const documentedCallVocabulary = new Set(['createAgent', 'getAgent', 'getRun', 'cancelRun']);
const documentedRunStatuses = new Set(['CREATING', 'RUNNING', 'FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
const documentedAgentStatuses = new Set(['ACTIVE', 'ARCHIVED']);
const reviewedNativeErrorCodes = new Set([
  'unauthorized', 'api_key_not_found', 'agent_not_found', 'run_not_found', 'agent_id_conflict',
  'agent_busy', 'run_not_cancellable', 'rate_limit_exceeded', 'usage_limit_exceeded',
  'validation_error', 'repository_required', 'repository_access',
]);
const requiredScenarios = new Set([
  'submit-succeed-result', 'duplicate-key-changed-request-conflict',
  'known-identity-observation-after-lost-reply', 'unknown-identity-remains-uncertain',
  'cancel-completion-race-completion-wins',
]);
const syntheticRepoUrl = 'https://github.com/strata-synth/cursor-mapping-synth';
const agentIdPattern = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runIdPattern = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unselectedRequestOptions = ['envVars', 'mcpServers', 'model', 'name', 'autoCreatePR', 'skipReviewerRequest', 'mode', 'customSubagents', 'env'];
const recoveryAssumptions = {
  dedicated_agent: true, exclusive_control: true,
  no_foreign_followup_runs: true, initial_run_attribution_assumed: true,
};
// Native run status -> common snapshot state normalization under review.
const nativeStateMap = { CREATING: 'queued', RUNNING: 'running', FINISHED: 'succeeded', ERROR: 'failed', CANCELLED: 'cancelled', EXPIRED: 'failed' };
const terminalRunStatuses = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

const rawDigest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Pure document checker so the negative mutations below can rerun it.
async function checkDocument(input) {
  const stats = { snapshots: 0, results: 0, errors: 0, apiCalls: 0, apiReturns: 0, apiErrors: 0, journalActions: 0, checks: 0 };
  assert.equal(input.format, 'strata-cursor-transcripts/1', 'Unexpected transcript format');
  const pinned = input.pinned;
  // The fingerprinted public schema contains authentication documentation and
  // example strings, not runtime credentials. Keep the sanity check on every
  // fixture field except that exact approved documentation text.
  const fixtureView = structuredClone(input);
  delete fixtureView.pinned.schema_subset_json;
  assert.ok(!/BEGIN PRIVATE KEY|\bsk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]+|crsr_[A-Za-z0-9]/.test(JSON.stringify(fixtureView)), 'Transcripts must not carry secret material');

  // The pinned schema facts are re-verified offline against the retained
  // snapshot and receipt; fingerprints prove nothing about live behavior.
  // Portable documentation evidence travels with this fixture, not a task-only
  // reference directory. It is public schema metadata, not native execution proof.
  assert.equal(typeof pinned.schema_subset_json, 'string', 'Embedded schema text required');
  assert.ok(Buffer.byteLength(pinned.schema_subset_json, 'utf8') <= 262144, 'Bounded embedded schema text');
  const subsetBytes = Buffer.from(pinned.schema_subset_json, 'utf8');
  assert.equal(createHash('sha256').update(subsetBytes).digest('hex'), 'f870ccc208c16223c12488fad28d1f7577d5eb79c867ae363ca7187a091fbfc9', 'Approved captured schema fingerprint');
  assert.equal(pinned.yaml_sha256, 'f61a5671e572d53086360958f9a9f1329548ff0ffc9b0ea3a32c66d6fd3b23ee', 'Approved original YAML fingerprint');
  assert.equal(pinned.yaml_url, 'https://cursor.com/docs-static/cloud-agents-openapi.yaml', 'Approved official schema source URL');
  assert.equal(pinned.yaml_bytes, 114037, 'Approved captured YAML byte count');
  const receipt = pinned.schema_receipt;
  assert.ok(receipt && typeof receipt === 'object', 'Embedded schema receipt required');
  assert.equal(receipt.preparationSubsetSha256, '5a60d9fd6d2335658a85cafe10637c48fff7c40dc909e6551cbdfeb008237c91', 'Original preparation subset provenance');
  assert.equal(createHash('sha256').update(subsetBytes).digest('hex'), pinned.subset_sha256, 'Subset checksum pin');
  assert.equal(pinned.subset_sha256, receipt.derivedSubsetSha256, 'Receipt subset checksum agreement');
  assert.equal(pinned.subset_file, receipt.derivedSubset, 'Subset path pin');
  assert.equal(pinned.yaml_url, receipt.url, 'Official YAML URL pin');
  assert.equal(pinned.yaml_bytes, receipt.bytes, 'Official YAML byte count pin');
  assert.equal(pinned.yaml_sha256, receipt.sha256, 'Official YAML SHA-256 pin');
  assert.equal(pinned.yaml_etag, receipt.etag[0], 'Official YAML ETag pin');
  assert.equal(pinned.yaml_last_modified, receipt.lastModified[0], 'Official YAML Last-Modified pin');
  assert.equal(pinned.accessed_at, receipt.accessedAt, 'Access timestamp pin');
  assert.equal(pinned.pin_meaning, receipt.pinMeaning, 'Pin meaning statement');
  const subset = JSON.parse(subsetBytes.toString('utf8'));
  assert.equal(pinned.openapi, receipt.openapi, 'OpenAPI version receipt pin');
  assert.equal(pinned.openapi, subset.openapi, 'OpenAPI version subset pin');
  assert.equal(pinned.info_version, receipt.infoVersion, 'info.version receipt pin');
  assert.equal(pinned.info_version, subset.info.version, 'info.version subset pin');
  const actualPaths = {};
  for (const [p, item] of Object.entries(subset.paths)) {
    actualPaths[p] = Object.keys(item).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).sort();
  }
  const pinnedPaths = {};
  for (const [p, methods] of Object.entries(pinned.selected_paths)) pinnedPaths[p] = [...methods].sort();
  assert.deepEqual(pinnedPaths, actualPaths, 'Selected path/method subset pin');
  assert.deepEqual(pinned.selected_paths, receipt.selectedPaths, 'Receipt selected paths agreement');
  assert.equal(pinned.docs_read.length, 3, 'Reviewed documentation inventory');
  for (const entry of pinned.docs_read) {
    assert.ok(entry.url.startsWith('https://cursor.com/docs/'), 'Documentation pin family');
    assert.equal(entry.date, '2026-10-12', 'Documentation access date');
  }
  assert.ok(Array.isArray(input.normalization) && input.normalization.length >= 5, 'Normalization notes');
  stats.checks++;

  const seen = new Set();
  for (const scenario of input.scenarios) {
    assert.equal(scenario.adapter_invoked, true, 'These scenarios all enter an adapter method');
    assert.ok(scenario.id && !seen.has(scenario.id), 'Unique scenario id');
    seen.add(scenario.id);
    const task = executionTaskSchema.parse(scenario.task);
    const ref = await executionTaskRef(task);
    executionTaskRefSchema.parse(ref);

    let conflictingRef;
    if (scenario.conflicting_task) {
      const conflicting = executionTaskSchema.parse(scenario.conflicting_task);
      conflictingRef = await executionTaskRef(conflicting);
      assert.equal(conflicting.task_id, task.task_id, 'Conflict scenario reuses the task id');
      assert.notEqual(conflictingRef.request_sha256, ref.request_sha256, 'Conflict scenario changes the request digest');
      stats.checks++;
    }

    let previousSnapshot, succeededDigest, emittedResult, lastError, lastSnapshot, frozenArtifactIds, frozenDigest;
    const calls = new Map();
    let createCalls = 0, firstCreateIndex = -1, firstReserveIndex = -1;
    let reservedAgentId, boundAgentId, boundRunId;
    let observedCreate, lastFinishedResult;
    const observedLatestRunByAgent = new Map();
    let latestObservedRunStatus;
    let sawRunning = false, sawTerminalRun, unavailableError = false;
    for (const [index, step] of scenario.steps.entries()) {
      const where = scenario.id + ' step ' + index;
      if (step.kind === 'api-call') {
        assert.ok(documentedCallVocabulary.has(step.method), where + ': undocumented native method ' + step.method);
        stats.apiCalls++;
        assert.ok(Number.isInteger(step.call) && step.call > 0 && !calls.has(step.call), where + ': unique call id');
        calls.set(step.call, step);
        if (step.method === 'createAgent') {
          assert.equal(step.op, 'submit', where + ': only submit starts native work');
          assert.equal(createCalls, 0, where + ': one native create per task lifetime');
          createCalls++; firstCreateIndex = index;
          assert.equal(step.path, '/v1/agents', where + ': create targets the pinned create path');
          const detail = step.detail;
          assert.ok(detail.agent_id_supplied === null || agentIdPattern.test(detail.agent_id_supplied), where + ': client agent id form');
          if (detail.agent_id_supplied !== null) {
            assert.notEqual(detail.agent_id_supplied, 'bc-' + task.task_id, where + ': native agent id is not the raw Strata task id');
          }
          assert.equal(detail.agent_id_supplied, reservedAgentId ?? null, where + ': create uses the id reserved with the key');
          const request = detail.request;
          for (const key of Object.keys(request)) {
            assert.ok(['prompt', 'repos', 'workOnCurrentBranch', 'agentId', '$omitted'].includes(key), where + ': unexpected request field ' + key);
          }
          assert.equal(request.agentId ?? null, detail.agent_id_supplied, where + ': request carries the reserved client agentId');
          assert.equal(request.prompt.text, task.instruction, where + ': prompt carries the task instruction');
          assert.ok(!('images' in request.prompt), where + ': image inputs are not selected');
          assert.equal(request.repos.length, 1, where + ': exactly one repository entry');
          assert.equal(request.repos[0].url, syntheticRepoUrl, where + ': synthetic repository pin');
          assert.deepEqual(Object.keys(request.repos[0]).sort(), ['startingRef', 'url'], where + ': prUrl and other repository overrides are not selected');
          assert.match(request.repos[0].startingRef, /^[a-f0-9]{40}$|^[a-f0-9]{64}$/, where + ': startingRef is a commit SHA, never a branch name');
          assert.equal(request.repos[0].startingRef, task.repository_revision, where + ': create pins the exact immutable revision');
          assert.equal(request.workOnCurrentBranch, false, where + ': commits never land on the mutable starting ref');
          for (const unselected of unselectedRequestOptions) {
            assert.ok(!(unselected in request), where + ': task-selected native option ' + unselected);
          }
          stats.checks++;
        }
        if (step.method === 'getAgent') {
          assert.equal(step.op, 'status', where + ': agent reads are status observations');
          assert.ok(agentIdPattern.test(step.detail.agent_id), where + ': agent id form');
          assert.equal(step.detail.agent_id, boundAgentId ?? reservedAgentId, where + ': reads use the retained native identity');
          assert.equal(step.path, '/v1/agents/' + step.detail.agent_id, where + ': exact agent path');
          stats.checks++;
        }
        if (step.method === 'getRun') {
          assert.ok(step.op === 'status' || step.op === 'cancel', where + ': run reads observe or resolve cancellation');
          assert.ok(boundRunId, where + ': run reads require a bound native run identity');
          assert.equal(step.detail.agent_id, boundAgentId, where + ': run read binds the agent identity');
          assert.equal(step.detail.run_id, boundRunId, where + ': run read binds the exact retained run');
          assert.equal(step.path, '/v1/agents/' + boundAgentId + '/runs/' + boundRunId, where + ': exact run path');
          stats.checks++;
        }
        if (step.method === 'cancelRun') {
          assert.equal(step.op, 'cancel', where + ': cancellation belongs to cancel');
          assert.ok(boundRunId, where + ': cancellation targets the retained run');
          assert.equal(step.detail.agent_id, boundAgentId, where + ': cancellation binds the retained agent');
          assert.equal(step.detail.run_id, boundRunId, where + ': cancellation binds the exact retained run');
          assert.ok(sawRunning, where + ': cancellation races observed running work');
          assert.equal(step.path, '/v1/agents/' + boundAgentId + '/runs/' + boundRunId + '/cancel', where + ': exact cancel path');
          stats.checks++;
        }
      } else if (step.kind === 'api-return') {
        stats.apiReturns++;
        const call = calls.get(step.call);
        assert.ok(call, where + ': return references a declared call');
        assert.ok(typeof step.body.$projection === 'string' && step.body.$projection.length > 0, where + ': native bodies are partial projections');
        if (call.method === 'createAgent') {
          assert.equal(step.status, 201, where + ': documented create success code');
          const agent = step.body.agent, run = step.body.run;
          assert.ok(agentIdPattern.test(agent.id), where + ': native agent id form');
          assert.ok(runIdPattern.test(run.id), where + ': native run id form');
          assert.equal(run.agentId, agent.id, where + ': initial run belongs to the created agent');
          assert.ok(documentedAgentStatuses.has(agent.status), where + ': documented agent status');
          assert.ok(documentedRunStatuses.has(run.status), where + ': documented run status');
          if (call.detail.agent_id_supplied !== null) {
            assert.equal(agent.id, call.detail.agent_id_supplied, where + ': server honors the client-supplied agent id');
          }
          if (typeof agent.latestRunId === 'string') assert.equal(agent.latestRunId, run.id, where + ': latest run is the initial run');
          observedCreate = { agentId: agent.id, runId: run.id };
          latestObservedRunStatus = run.status;
          if (run.status === 'RUNNING') sawRunning = true;
          stats.checks++;
        }
        if (call.method === 'getAgent') {
          assert.equal(step.status, 200, where + ': documented read success code');
          const agent = step.body.agent;
          assert.ok(agentIdPattern.test(agent.id), where + ': native agent id form');
          assert.equal(agent.id, call.detail.agent_id, where + ': reply matches the read identity');
          assert.ok(documentedAgentStatuses.has(agent.status), where + ': documented agent status');
          assert.ok(runIdPattern.test(agent.latestRunId), where + ': latestRunId run id form');
          observedLatestRunByAgent.set(agent.id, agent.latestRunId);
          stats.checks++;
        }
        if (call.method === 'getRun') {
          assert.equal(step.status, 200, where + ': documented read success code');
          const run = step.body.run;
          assert.ok(runIdPattern.test(run.id), where + ': native run id form');
          assert.equal(run.id, call.detail.run_id, where + ': reply matches the exact retained run');
          assert.equal(run.agentId, call.detail.agent_id, where + ': reply matches the agent identity');
          assert.ok(documentedRunStatuses.has(run.status), where + ': documented run status ' + run.status);
          latestObservedRunStatus = run.status;
          if (run.status === 'RUNNING') sawRunning = true;
          if (terminalRunStatuses.has(run.status)) {
            sawTerminalRun = run;
            if (run.status === 'FINISHED') {
              assert.ok(typeof run.result === 'string' && run.result.length > 0, where + ': finished runs carry final reply text');
              lastFinishedResult = run.result;
            }
          }
          if ('git' in run) {
            assert.ok(Array.isArray(run.git.branches), where + ': git projection carries branches');
            for (const branch of run.git.branches) {
              assert.ok(!branch.repoUrl.includes('://'), where + ': repoUrl is returned without the scheme');
              assert.ok(branch.branch.startsWith('cursor/'), where + ': proposed branches stay on generated cursor/ branches');
              if ('prUrl' in branch) assert.ok(branch.prUrl.startsWith('https://'), where + ': prUrl form');
            }
            stats.checks++;
          }
          stats.checks++;
        }
        if (call.method === 'cancelRun') {
          assert.equal(step.status, 200, where + ': documented cancel success code');
          assert.ok(runIdPattern.test(step.body.id), where + ': cancel receipt carries the run id');
          assert.equal(step.body.id, call.detail.run_id, where + ': receipt matches the cancelled run');
          stats.checks++;
        }
      } else if (step.kind === 'api-error') {
        stats.apiErrors++;
        const call = calls.get(step.call);
        assert.ok(call, where + ': error references a declared call');
        assert.ok(reviewedNativeErrorCodes.has(step.error.code), where + ': undocumented native error code ' + step.error.code);
        assert.deepEqual(Object.keys(step.error), ['code'], where + ': native message/help/provider text is never persisted');
        if (step.error.code === 'run_not_cancellable') {
          assert.equal(call.method, 'cancelRun', where + ': run_not_cancellable belongs to cancellation');
          assert.equal(step.status, 409, where + ': documented cancellation conflict status');
        }
        stats.checks++;
      } else if (step.kind === 'adapter') {
        if (step.action === 'reserve-key') {
          stats.journalActions++;
          firstReserveIndex = index;
          assert.equal(step.op, 'submit');
          assert.equal(step.detail.connection_id, task.connection_id, where + ': reservation binds the connection');
          assert.equal(step.detail.task_id, task.task_id, where + ': reservation binds the original task id');
          assert.equal(step.detail.request_sha256, ref.request_sha256, where + ': reservation binds the request digest');
          if (conflictingRef) assert.equal(step.detail.existing_request_sha256, conflictingRef.request_sha256,
            where + ': conflict detection compares the retained request digest');
          reservedAgentId = step.detail.agent_id_supplied ?? null;
          stats.checks++;
        } else if (step.action === 'bind-native-identity') {
          stats.journalActions++;
          if (step.detail.source === 'observed-create-reply') {
            assert.ok(observedCreate, where + ': binding requires an observed create reply');
            assert.equal(step.detail.agent_id, observedCreate.agentId, where + ': bound agent id matches observation');
            assert.equal(step.detail.run_id, observedCreate.runId, where + ': bound run id matches observation');
          } else if (step.detail.source === 'observed-agent-lookup-latestRunId') {
            assert.deepEqual(scenario.recovery_assumptions, recoveryAssumptions,
              where + ': latestRunId recovery needs explicit synthetic exclusive-control and initial-run attribution assumptions');
            assert.equal(observedLatestRunByAgent.get(step.detail.agent_id), step.detail.run_id,
              where + ': binding requires the observed latestRunId of the retained agent');
          } else {
            assert.fail(where + ': unknown identity binding source');
          }
          boundAgentId = step.detail.agent_id;
          boundRunId = step.detail.run_id;
          stats.checks++;
        } else if (step.action === 'lookup-bound-identity') {
          stats.journalActions++;
          assert.equal(step.op, 'status');
          assert.equal(step.detail.agent_id, null, where + ': no retained identity exists to look up');
          assert.equal(step.detail.run_id, null, where + ': no guessed run identity');
          const next = scenario.steps[index + 1];
          assert.ok(next && next.kind === 'adapter' && next.action === 'emit-error',
            where + ': an unresolvable lookup is an observation error');
          stats.checks++;
        } else if (step.action === 'retain-uncertain-admission' || step.action === 'block-second-start') {
          stats.journalActions++;
          assert.ok(typeof step.detail.reason === 'string' && step.detail.reason.length > 0, where + ': journal decision carries its reason');
        } else if (step.action === 'freeze-result') {
          stats.journalActions++;
          assert.ok(sawTerminalRun && sawTerminalRun.status === 'FINISHED' && typeof sawTerminalRun.result === 'string',
            where + ': freezing requires an observed finished run with final reply text');
          if (frozenDigest) {
            assert.equal(step.detail.result_sha256, frozenDigest, where + ': a frozen result digest never changes');
            assert.deepEqual(step.detail.artifact_ids, frozenArtifactIds, where + ': a frozen artifact inventory never changes');
          }
          frozenDigest = step.detail.result_sha256;
          frozenArtifactIds = step.detail.artifact_ids;
          stats.checks++;
        } else if (step.action === 'emit-snapshot') {
          const snapshot = executionSnapshotSchema.parse(step.detail.snapshot);
          stats.snapshots++;
          assert.ok(sameExecutionValue(snapshot.task, ref), where + ': snapshot binds the scenario task ref');
          if (previousSnapshot) {
            try { assertExecutionTransition(previousSnapshot, snapshot); }
            catch { assert.fail(where + ': illegal snapshot transition ' + previousSnapshot.state + '@' + previousSnapshot.sequence + ' -> ' + snapshot.state + '@' + snapshot.sequence); }
            stats.checks++;
          }
          // Normalization fidelity: a common state requires its native observation.
          assert.equal(snapshot.state, nativeStateMap[latestObservedRunStatus],
            where + ': snapshot normalizes the latest exact-run observation');
          if (snapshot.state === 'succeeded') {
            assert.ok(frozenDigest && frozenDigest === snapshot.result_sha256, where + ': success binds the frozen result digest');
            succeededDigest = snapshot.result_sha256;
          }
          if (step.op === 'cancel') {
            assert.ok(snapshot.state !== 'queued' && snapshot.state !== 'running', where + ': cancel must not answer queued/running');
          }
          previousSnapshot = snapshot; lastSnapshot = snapshot;
        } else if (step.action === 'emit-result') {
          const result = executionResultSchema.parse(step.detail.result);
          stats.results++;
          assert.ok(succeededDigest, where + ': result requires an already succeeded snapshot');
          assert.equal(await executionDigest(result), succeededDigest, where + ': every served result binds the immutable succeeded digest');
          assert.equal(succeededDigest, frozenDigest, where + ': every served result uses the frozen digest');
          if (emittedResult) assert.ok(sameExecutionValue(result, emittedResult), where + ': replayed result bytes never change');
          stats.checks++;
          assert.ok(sameExecutionValue(result.task, ref), where + ': result binds the scenario task ref');
          assert.ok(!JSON.stringify(result).includes('http'), where + ': no downloadable URLs in results or artifacts');
          assert.equal(result.summary, lastFinishedResult, where + ': summary is normalized from the observed terminal run text, never invented');
          assert.deepEqual(frozenArtifactIds ?? [], result.artifacts.map((a) => a.id), where + ': frozen artifact inventory is the served inventory');
          assert.deepEqual(Object.keys(step.detail.artifact_contents ?? {}), result.artifacts.map((a) => a.id), where + ': every artifact has a content source');
          for (const artifact of result.artifacts) {
            const content = step.detail.artifact_contents[artifact.id];
            assert.equal(typeof content, 'string', where + ': artifact content source ' + artifact.id);
            assert.equal(rawDigest(content), artifact.sha256, where + ': artifact digest binds raw content bytes');
            assert.equal(Buffer.byteLength(content, 'utf8'), artifact.bytes, where + ': artifact byte count');
            stats.checks++;
          }
          assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= task.limits.output_bytes, where + ': original normalized output budget');
          emittedResult = result;
        } else if (step.action === 'emit-error') {
          stats.errors++;
          assert.ok(executionErrorCodeSchema.parse(step.detail.error.code), where + ': finite error code');
          assert.equal(step.detail.error.dispatch, 'unknown', where + ': every failure after invocation is unknown');
          assert.deepEqual(Object.keys(step.detail.error).sort(), ['code', 'dispatch'], where + ': persisted error projection permits only code and dispatch');
          if (step.detail.error.code === 'EXECUTION_UNAVAILABLE') unavailableError = true;
          lastError = step.detail.error;
        } else {
          assert.fail(where + ': unknown adapter action ' + step.action);
        }
      } else {
        assert.fail(where + ': unknown step kind ' + step.kind);
      }
    }
    if (createCalls > 0) assert.ok(firstReserveIndex >= 0 && firstReserveIndex < firstCreateIndex,
      scenario.id + ': the key and native id are reserved before any native create');
    if (unavailableError) assert.ok(scenario.steps.some((s) => s.action === 'retain-uncertain-admission'),
      scenario.id + ': an uncertain dispatch retains its admission');
    if (scenario.id === 'duplicate-key-changed-request-conflict') {
      assert.equal(createCalls, 0, scenario.id + ': a journal conflict refuses before any native create');
      assert.ok(conflictingRef, scenario.id + ': the retained original request is recorded');
    }
    if (scenario.id === 'known-identity-observation-after-lost-reply') {
      const createCallId = scenario.steps.find((s) => s.kind === 'api-call' && s.method === 'createAgent').call;
      assert.ok(!scenario.steps.some((s) => s.kind === 'api-return' && s.call === createCallId),
        scenario.id + ': the lost create reply is not invented');
      assert.ok(scenario.steps.some((s) => s.kind === 'api-call' && s.method === 'getAgent'),
        scenario.id + ': recovery reads the retained agent id read-only');
      assert.ok(boundRunId, scenario.id + ': reconciliation binds the observed run');
    }
    if (scenario.id === 'unknown-identity-remains-uncertain') {
      assert.equal(createCalls, 1, scenario.id + ': exactly one native create; the uncertain admission never restarts');
      assert.equal(boundAgentId, undefined, scenario.id + ': no native identity was retained');
      assert.ok(scenario.steps.some((s) => s.action === 'block-second-start'), scenario.id + ': every second start stays blocked');
      assert.equal(lastSnapshot, undefined, scenario.id + ': no snapshot may be invented without observation');
    }
    if (scenario.id === 'cancel-completion-race-completion-wins') {
      assert.ok(scenario.steps.some((s) => s.kind === 'api-call' && s.method === 'cancelRun'), scenario.id + ': the race issues the documented cancel');
      assert.ok(scenario.steps.some((s) => s.kind === 'api-error' && s.error.code === 'run_not_cancellable'),
        scenario.id + ': completion winning is the documented 409 run_not_cancellable signal');
      assert.equal(lastSnapshot && lastSnapshot.state, 'succeeded', scenario.id + ': completion won the race');
    }

    const expected = scenario.expected;
    if (expected.final_state === 'error') {
      assert.ok(lastError, scenario.id + ': expected a terminal error');
      assert.equal(lastError.code, expected.error.code, scenario.id + ': expected error code');
      assert.equal(lastError.dispatch, expected.error.dispatch, scenario.id + ': expected dispatch certainty');
    } else {
      assert.ok(lastSnapshot, scenario.id + ': expected a terminal snapshot');
      assert.equal(lastSnapshot.state, expected.final_state, scenario.id + ': expected final state');
      for (const state of expected.intermediate_states ?? []) {
        assert.ok(scenario.steps.some((s) => s.action === 'emit-snapshot' && s.detail.snapshot.state === state),
          scenario.id + ': expected intermediate state ' + state);
      }
    }
    if (expected.result_available) {
      assert.ok(emittedResult && succeededDigest, scenario.id + ': expected an emitted result and succeeded digest');
      assert.equal(await executionDigest(emittedResult), succeededDigest, scenario.id + ': succeeded snapshot binds the canonical result digest');
      const frozen = scenario.steps.find((s) => s.action === 'freeze-result');
      assert.equal(frozen.detail.result_sha256, succeededDigest, scenario.id + ': the frozen digest is the served digest');
      stats.checks++;
    } else {
      assert.equal(emittedResult, undefined, scenario.id + ': no result may be emitted');
      assert.equal(succeededDigest, undefined, scenario.id + ': no succeeded snapshot may appear');
    }
    if (expected.surfaced_error) {
      assert.ok(scenario.steps.some((s) => s.action === 'emit-error' && s.detail.error.code === expected.surfaced_error.code),
        scenario.id + ': expected surfaced error ' + expected.surfaced_error.code);
    }
  }
  for (const id of requiredScenarios) assert.ok(seen.has(id), 'Missing required scenario ' + id);
  assert.equal(seen.size, requiredScenarios.size, 'No unlisted scenarios');
  return stats;
}

const stats = await checkDocument(doc);

// Controlled in-memory negative mutations: the checker must reject
// deliberate result/ref/sequence/artifact/pin/identity substitutions and
// native-vocabulary inventions. Nothing on disk is mutated and no runtime
// or network access is launched.
const mutations = [
  ['embedded schema co-substitution', (d) => {
    d.pinned.schema_subset_json += ' ';
    d.pinned.subset_sha256 = rawDigest(d.pinned.schema_subset_json);
    d.pinned.schema_receipt.derivedSubsetSha256 = d.pinned.subset_sha256;
  }],
  ['fixture secret sentinel', (d) => { d.pinned.fixture_note = 'Bearer fixture-secret-sentinel'; }],
  ['result substitution', (d) => { d.scenarios[0].steps.at(-1).detail.result.summary += ' tampered'; }],
  ['ref substitution', (d) => {
    const snapshot = d.scenarios[4].steps.find((s) => s.action === 'emit-snapshot' && s.detail.snapshot.state === 'running');
    snapshot.detail.snapshot.task.task_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  }],
  ['sequence substitution', (d) => {
    const snapshot = d.scenarios[4].steps.find((s) => s.action === 'emit-snapshot' && s.detail.snapshot.state === 'succeeded');
    snapshot.detail.snapshot.sequence = 1;
  }],
  ['artifact substitution', (d) => { d.scenarios[0].steps.at(-1).detail.artifact_contents['branch-diff-001'] += 'x'; }],
  ['mutable branch startingRef', (d) => {
    d.scenarios[0].steps.find((s) => s.kind === 'api-call' && s.method === 'createAgent').detail.request.repos[0].startingRef = 'main';
  }],
  ['pin substitution', (d) => { d.pinned.yaml_sha256 = '0'.repeat(64); }],
  ['second native create', (d) => {
    const create = d.scenarios[2].steps.find((s) => s.kind === 'api-call' && s.method === 'createAgent');
    d.scenarios[2].steps.push(Object.assign(structuredClone(create), { call: 99 }));
  }],
  ['undocumented native status', (d) => {
    d.scenarios[4].steps.filter((s) => s.kind === 'api-return').at(-1).body.run.status = 'PAUSED';
  }],
  ['dispatch downgrade', (d) => {
    d.scenarios[3].steps.find((s) => s.action === 'emit-error').detail.error.dispatch = 'not_dispatched';
  }],
  ['identity substitution', (d) => {
    d.scenarios[0].steps.find((s) => s.action === 'bind-native-identity').detail.run_id = 'run-bbbb0009-0000-4000-8000-000000000009';
  }],
  ['frozen digest substitution', (d) => {
    d.scenarios[0].steps.find((s) => s.action === 'freeze-result').detail.result_sha256 = '0'.repeat(64);
  }],
  ['native error text leak', (d) => {
    d.scenarios[4].steps.find((s) => s.kind === 'api-error').error.message = 'run already finished';
  }],
  ['PR override of exact startingRef', (d) => {
    d.scenarios[0].steps[1].detail.request.repos[0].prUrl = 'https://github.com/strata-synth/cursor-mapping-synth/pull/99';
  }],
  ['common error metadata leak', (d) => { d.scenarios[1].steps[1].detail.error.helpUrl = 'https://example.invalid/private-error'; }],
  ['cancel target substitution', (d) => { d.scenarios[4].steps[8].detail.run_id = 'run-bbbb0009-0000-4000-8000-000000000009'; }],
  ['cancel conflict HTTP status substitution', (d) => { d.scenarios[4].steps[9].status = 200; }],
  ['stale status observation', (d) => {
    const s = d.scenarios[0], stale = structuredClone(s.steps[4]);
    stale.detail.snapshot.sequence = 2;
    s.steps[8].detail.snapshot.sequence = 3;
    s.steps.splice(8, 0, stale);
  }],
  ['result before succeeded snapshot', (d) => { d.scenarios[0].steps.splice(8, 0, structuredClone(d.scenarios[0].steps.at(-1))); }],
  ['changed earlier result replay', (d) => {
    const s = d.scenarios[0], replay = structuredClone(s.steps.at(-1));
    replay.detail.result.artifacts[0].media_type = 'text/plain';
    s.steps.splice(s.steps.length - 1, 0, replay);
  }],
  ['terminal snapshot mutation', (d) => {
    const s = d.scenarios[0], terminal = structuredClone(s.steps[8]);
    terminal.detail.snapshot.sequence++;
    s.steps.push(terminal);
  }],
  ['missing recovery attribution assumptions', (d) => { delete d.scenarios[2].recovery_assumptions; }],
  ['foreign follow-up run recovery', (d) => { d.scenarios[2].recovery_assumptions.no_foreign_followup_runs = false; }],
  ['request agentId substitution', (d) => { d.scenarios[0].steps[1].detail.request.agentId = 'bc-aaaa0009-0000-4000-8000-000000000009'; }],
  ['schema source URL co-substitution', (d) => {
    d.pinned.yaml_url = 'https://example.invalid/substituted-schema.yaml';
    d.pinned.schema_receipt.url = d.pinned.yaml_url;
  }],
];
let rejected = 0;
for (const [label, mutate] of mutations) {
  const mutated = structuredClone(doc);
  mutate(mutated);
  try { await checkDocument(mutated); } catch (error) {
    assert.ok(error instanceof assert.AssertionError || error.name === 'ZodError',
      'Mutation must fail a checked assertion/schema, not a checker crash: ' + label);
    rejected++; continue;
  }
  assert.fail('Mutation was not rejected: ' + label);
}

console.log(JSON.stringify({
  scenarios: doc.scenarios.length, snapshots: stats.snapshots, results: stats.results, errors: stats.errors,
  apiCalls: stats.apiCalls, apiReturns: stats.apiReturns, apiErrors: stats.apiErrors, journalActions: stats.journalActions,
  digestAndTransitionChecks: stats.checks, rejectedMutations: rejected, failures: 0,
}));
