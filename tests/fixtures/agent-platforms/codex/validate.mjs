// Offline structural gate for the synthetic normalized Codex transcripts.
// Verifies every scenario against the shared execution/1 schemas and rules:
// task identity digests, snapshot transitions, result digests, artifact
// digests, conservative errors and selected source-reviewed native fields.
// This does not execute a mapper or validate complete native wire schemas.
// No provider network, credentials or native runtime launch. Build first.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  executionTaskSchema, executionTaskRefSchema, executionSnapshotSchema, executionResultSchema,
  executionErrorCodeSchema, executionTaskRef, executionDigest, sameExecutionValue, assertExecutionTransition,
} from '../../../../dist/src/agent-execution.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, 'transcripts.json'), 'utf8');
const doc = JSON.parse(raw);

// Small reviewed vocabulary for synthetic projections, not proof of full
// native protocol compatibility or runtime guarantees.
const documentedVocabulary = new Set([
  'initialize', 'initialized',
  'thread/start', 'thread/started', 'thread/status/changed', 'thread/read',
  'turn/start', 'turn/completed', 'turn/interrupt',
  'item/started', 'item/agentMessage/delta',
]);
const requiredScenarios = new Set([
  'submit-succeed-result', 'cancel-race-success-wins', 'cancel-interrupt-wins',
  'deadline-triggered-interruption', 'native-usage-limit-failed', 'ambiguous-dispatch-reconcile',
  'duplicate-id-changed-digest-conflict', 'sandbox-policy-refusal', 'control-call-before-initialize',
]);

assert.equal(doc.format, 'strata-codex-transcripts/1', 'Unexpected transcript format');
assert.equal(doc.pinned.cli_package, '@openai/codex', 'CLI package pin');
assert.equal(doc.pinned.cli_version, '0.162.1', 'CLI version pin');
assert.equal(doc.pinned.release_tag, 'rust-v0.162.1', 'Release tag pin');
assert.equal(doc.pinned.transport_selected, 'stdio', 'Transport pin');
assert.ok(doc.pinned.schema_pin.includes('0.162.1'), 'Schema pin must name the pinned CLI version');
assert.equal(doc.pinned.upstream_commit, '092d3acd6bec3e3a14bdc7e7a2810ab628ab759d', 'Immutable source commit');
assert.equal(doc.pinned.schema_tree_git_sha, '3613a5054c1c9af876fccba53c995f0ac8425b85', 'Schema tree');
assert.equal(doc.pinned.schema_sources.length, 11, 'Reviewed schema snapshot inventory');
for (const source of doc.pinned.schema_sources) {
  assert.match(source.path, /^codex-rs\/app-server-protocol\/schema\/json\/v[12]\/[A-Za-z]+\.json$/);
  assert.match(source.git_blob_sha, /^[a-f0-9]{40}$/);
}
assert.ok(doc.pinned.surface.includes('stdio'), 'Surface pin');
assert.ok(!/BEGIN PRIVATE KEY|\bsk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]+/.test(raw), 'Transcripts must not carry secret material');
assert.ok(Array.isArray(doc.normalization) && doc.normalization.length >= 4, 'Normalization notes');

const rawDigest = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(n => n.toString(16).padStart(2, '0')).join('');

let snapshots = 0, results = 0, errors = 0, syntheticRequests = 0, checks = 0;
const seen = new Set();
for (const scenario of doc.scenarios) {
  assert.equal(scenario.adapter_invoked, true, 'These scenarios all enter an adapter method');
  assert.ok(scenario.id && !seen.has(scenario.id), 'Unique scenario id');
  seen.add(scenario.id);
  const task = executionTaskSchema.parse(scenario.task);
  const ref = await executionTaskRef(task);
  executionTaskRefSchema.parse(ref);

  if (scenario.conflicting_task) {
    const conflicting = executionTaskSchema.parse(scenario.conflicting_task);
    const conflictingRef = await executionTaskRef(conflicting);
    assert.equal(conflicting.task_id, task.task_id, 'Conflict scenario reuses the task id');
    assert.notEqual(conflictingRef.request_sha256, ref.request_sha256, 'Conflict scenario changes the request digest');
    checks++;
  }

  let previousSnapshot;
  let succeededDigest;
  let emittedResult;
  let lastError;
  let lastSnapshot;
  const requests = new Map();
  for (const [index, step] of scenario.steps.entries()) {
    const where = scenario.id + ' step ' + index;
    if (step.kind === 'request' || step.kind === 'notification') {
      assert.ok(documentedVocabulary.has(step.method), where + ': undocumented native method ' + step.method);
      if (step.kind === 'request') {
        syntheticRequests++;
        assert.ok(Number.isInteger(step.id) && step.id > 0 && !requests.has(step.id), where + ': unique request id');
        requests.set(step.id, step);
        if (step.method === 'thread/start') {
          assert.equal(step.params?.approvalPolicy, 'never', where + ': reviewed approval literal');
          assert.equal(step.params?.sandbox, 'workspace-write', where + ': thread-start sandbox mode');
          assert.equal(step.params?.ephemeral, false, where + ': retained thread requested');
          assert.ok(!('sandboxPolicy' in step.params), where + ': turn policy is not a thread-start field');
          assert.equal(typeof step.params?.cwd, 'string', where + ': cwd bound to the approved checkout');
        }
        if (step.method === 'turn/start') {
          assert.equal(typeof step.params?.threadId, 'string', where + ': turn thread binding');
          assert.deepEqual(step.params.input, [{ type: 'text', text: task.instruction }], where + ': instruction as reviewed text input');
        }
        if (step.method === 'turn/interrupt') {
          assert.deepEqual(Object.keys(step.params).sort(), ['threadId', 'turnId'], where + ': interrupt requires both handles');
          const observed = scenario.steps.find(s => s.method === 'turn/completed' && s.params.threadId === step.params.threadId);
          assert.equal(step.params.turnId, observed?.params.turn.id, where + ': interrupt binds observed turn');
        }
      }
      const info = step.params?.turn?.error?.codexErrorInfo;
      if (info !== undefined) assert.ok(['usageLimitExceeded', 'sandboxError'].includes(info), where + ': reviewed simple camel-case error variant');
    } else if (step.kind === 'response') {
      assert.ok(Number.isInteger(step.id) && step.id > 0, where + ': response correlates to a request id');
      assert.ok(requests.has(step.id), where + ': response has a preceding request');
      assert.ok(step.result !== undefined || step.error !== undefined, where + ': response carries result or error');
    } else if (step.kind === 'adapter') {
      if (step.action === 'emit-snapshot') {
        const snapshot = executionSnapshotSchema.parse(step.detail.snapshot);
        snapshots++;
        assert.ok(sameExecutionValue(snapshot.task, ref), where + ': snapshot binds the scenario task ref');
        if (previousSnapshot) {
          try { assertExecutionTransition(previousSnapshot, snapshot); } // throws EXECUTION_PROTOCOL on violation
          catch { assert.fail(where + ': illegal snapshot transition ' + previousSnapshot.state + '@' + previousSnapshot.sequence + ' -> ' + snapshot.state + '@' + snapshot.sequence); }
          checks++;
        }
        if (snapshot.state === 'succeeded') succeededDigest = snapshot.result_sha256;
        if (step.op === 'cancel') {
          assert.ok(snapshot.state !== 'queued' && snapshot.state !== 'running', where + ': cancel must not answer queued/running');
        }
        previousSnapshot = snapshot; lastSnapshot = snapshot;
      } else if (step.action === 'emit-result') {
        const result = executionResultSchema.parse(step.detail.result);
        results++;
        assert.ok(sameExecutionValue(result.task, ref), where + ': result binds the scenario task ref');
        assert.ok(!JSON.stringify(result).includes('http'), where + ': no downloadable URLs in artifacts');
        assert.equal(Object.keys(step.detail.artifact_contents ?? {}).length, result.artifacts.length, where + ': every artifact has a content source');
        for (const artifact of result.artifacts) {
          const content = step.detail.artifact_contents[artifact.id];
          assert.equal(typeof content, 'string', where + ': artifact content source ' + artifact.id);
          assert.equal(await rawDigest(content), artifact.sha256, where + ': artifact digest binds raw content bytes');
          assert.equal(new TextEncoder().encode(content).length, artifact.bytes, where + ': artifact byte count');
          checks++;
        }
        emittedResult = result;
      } else if (step.action === 'emit-error') {
        errors++;
        assert.ok(executionErrorCodeSchema.parse(step.detail.error.code), where + ': finite error code');
        assert.equal(step.detail.error.dispatch, 'unknown', where + ': every failure after invocation is unknown');
        assert.ok(!('message' in step.detail.error), where + ': no native message text in persisted errors');
        lastError = step.detail.error;
      }
    } else {
      assert.fail(where + ': unknown step kind ' + step.kind);
    }
  }

  const expected = scenario.expected;
  if (expected.final_state === 'error') {
    assert.ok(lastError, scenario.id + ': expected a terminal error');
    assert.equal(lastError.code, expected.error.code, scenario.id + ': expected error code');
    assert.equal(lastError.dispatch, expected.error.dispatch, scenario.id + ': expected dispatch certainty');
  } else {
    assert.ok(lastSnapshot, scenario.id + ': expected a terminal snapshot');
    assert.equal(lastSnapshot.state, expected.final_state, scenario.id + ': expected final state');
    if (expected.failure) assert.equal(lastSnapshot.failure, expected.failure, scenario.id + ': expected failure code');
    for (const state of expected.intermediate_states ?? []) {
      assert.ok(scenario.steps.some(s => s.action === 'emit-snapshot' && s.detail.snapshot.state === state),
        scenario.id + ': expected intermediate state ' + state);
    }
  }
  if (expected.result_available) {
    assert.ok(emittedResult && succeededDigest, scenario.id + ': expected an emitted result and succeeded digest');
    assert.equal(await executionDigest(emittedResult), succeededDigest, scenario.id + ': succeeded snapshot binds the canonical result digest');
    checks++;
  } else {
    assert.equal(emittedResult, undefined, scenario.id + ': no result may be emitted');
    assert.equal(succeededDigest, undefined, scenario.id + ': no succeeded snapshot may appear');
  }
  if (expected.surfaced_error) {
    assert.ok(scenario.steps.some(s => s.action === 'emit-error' && s.detail.error.code === expected.surfaced_error.code),
      scenario.id + ': expected surfaced error ' + expected.surfaced_error.code);
  }
}

for (const id of requiredScenarios) assert.ok(seen.has(id), 'Missing required scenario ' + id);
console.log(JSON.stringify({ scenarios: doc.scenarios.length, snapshots, results, errors, syntheticRequests, digestAndTransitionChecks: checks, failures: 0 }));
