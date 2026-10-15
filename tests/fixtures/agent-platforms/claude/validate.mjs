// Offline structural gate for the synthetic normalized Claude Agent SDK
// transcripts. Verifies every scenario against the shared execution/1
// schemas and rules: task identity digests, snapshot transitions, result
// digests, artifact digests, conservative errors, reviewed interface
// literals and the claimed source pins. It validates synthetic common DTO
// consistency and one explicitly checked interface subset only; it is NOT
// a functioning mapper, complete native wire schema validation, durable
// storage, runtime identity or native qualification. No provider network,
// credentials or native runtime launch. Uses the precompiled shared dist.
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

// Small reviewed vocabulary for the selected surface, mirroring the pinned
// sdk.d.ts/doc evidence. Not proof of full native protocol compatibility.
const documentedCallVocabulary = new Set(['query', 'query.interrupt', 'getSessionInfo', 'getSessionMessages']);
const documentedEventVocabulary = new Set(['system', 'assistant', 'result']);
const reviewedPermissionModes = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']);
const reviewedResultSubtypes = new Set(['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd']);
const requiredScenarios = new Set([
  'submit-succeed-result', 'duplicate-id-changed-digest-conflict',
  'known-session-observation-after-lost-reply', 'unknown-session-remains-uncertain',
  'cancel-completion-race-success-wins',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const platformBinaries = [
  '@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl', '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  '@anthropic-ai/claude-agent-sdk-darwin-x64', '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-win32-x64', '@anthropic-ai/claude-agent-sdk-win32-arm64',
];

const rawDigest = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(n => n.toString(16).padStart(2, '0')).join('');

// Pure document checker so the negative mutations below can rerun it.
async function checkDocument(input) {
  const stats = { snapshots: 0, results: 0, errors: 0, sdkCalls: 0, sdkEvents: 0, journalActions: 0, checks: 0 };
  assert.equal(input.format, 'strata-claude-transcripts/1', 'Unexpected transcript format');
  const pinned = input.pinned;
  assert.equal(pinned.sdk_package, '@anthropic-ai/claude-agent-sdk', 'SDK package pin');
  assert.equal(pinned.sdk_version, '0.3.296', 'SDK version pin');
  assert.equal(pinned.sdk_registry_shasum, '255c4d284de2262fa8447a94a06d2541c0f5d20c', 'SDK registry shasum pin');
  assert.equal(pinned.sdk_registry_integrity, 'sha512-Y+cZ2BT8X94mQ9GJOVyIqhjC/nWGvwozUVLjdkzX7aSt+zuo5tgk7Hdv9V7tEUQ9fKnEuiL6moYNWDeHqCD4Lw==', 'SDK registry integrity pin');
  assert.equal(pinned.sdk_engines_node, '>=18.0.0', 'SDK engines pin');
  assert.deepEqual(pinned.sdk_peer_dependencies, {
    zod: '^4.0.0', '@anthropic-ai/sdk': '>=0.93.0', '@modelcontextprotocol/sdk': '^1.29.0',
  }, 'SDK peer dependency pins');
  assert.equal(pinned.interface_file, 'sdk.d.ts', 'Interface file pin');
  assert.equal(pinned.interface_mirror, 'https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.296/sdk.d.ts', 'Versioned interface mirror pin');
  assert.ok(!pinned.interface_mirror.includes('sdk@latest'), 'latest is not a pin');
  assert.equal(pinned.interface_read_date, '2026-10-12', 'Interface read date');
  assert.equal(pinned.interface_content_sha256, 'fc2866dfe2c01468edb19b1d94f26156bfacecdf1e7f1452b276ed2f8cc0b08f', 'Versioned mirror text fingerprint only');
  assert.equal(pinned.interface_fingerprint_provenance, 'Versioned unpkg text mirror; not publisher attestation or installed-interface verification', 'Fingerprint provenance');
  assert.equal(pinned.github_tag, 'v0.3.296', 'Release tag pin');
  assert.equal(pinned.upstream_commit, '85d8f8e0772199ec7965a0c2e874ac88343f2a01', 'Immutable source commit');
  assert.equal(pinned.repo_commit_contains_sdk_source, false, 'Repo commit ships no SDK source; interface pin rests on the package');
  assert.equal(pinned.bundled_claude_code_version, '2.1.296', 'Bundled Claude Code version pin');
  assert.deepEqual([...pinned.platform_binary_optional_dependencies].sort(), [...platformBinaries].sort(), 'Platform binary package pins');
  assert.equal(pinned.claude_code_package, '@anthropic-ai/claude-code', 'Launcher package pin');
  assert.equal(pinned.claude_code_registry_shasum, 'c07c326b6fdff6f1c20c8a1b863a9af7fa395ba5', 'Launcher registry shasum pin');
  assert.deepEqual(pinned.claude_code_bin, { claude: 'bin/claude.exe' }, 'Launcher bin pin');
  assert.equal(pinned.docs_read.length, 5, 'Reviewed documentation inventory');
  for (const entry of pinned.docs_read) {
    assert.ok(entry.url.startsWith('https://code.claude.com/docs/en/agent-sdk/'), 'Documentation pin family');
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

    let previousSnapshot, succeededDigest, emittedResult, lastError, lastSnapshot, frozenArtifactIds;
    const calls = new Map();
    let queryCalls = 0, firstQueryIndex = -1, firstReserveIndex = -1, bindSessionId;
    const observedSessions = new Set();
    let sawSuccessResult = false, sawRunning = false, unavailableError = false;
    for (const [index, step] of scenario.steps.entries()) {
      const where = scenario.id + ' step ' + index;
      if (step.kind === 'sdk-call') {
        assert.ok(documentedCallVocabulary.has(step.method), where + ': undocumented native method ' + step.method);
        stats.sdkCalls++;
        assert.ok(Number.isInteger(step.call) && step.call > 0 && !calls.has(step.call), where + ': unique call id');
        calls.set(step.call, step);
        if (step.method === 'query') {
          assert.equal(step.op, 'submit', where + ': only submit starts native work');
          assert.equal(queryCalls, 0, where + ': one native start per task lifetime');
          queryCalls++;
          firstQueryIndex = index;
          assert.match(step.detail.prompt.$synthetic, /^AsyncIterable<SDKUserMessage>/, where + ': streaming input is an iterable projection, not a string');
          assert.equal(step.detail.prompt.messages.length, 1, where + ': exactly one user input');
          const message = step.detail.prompt.messages[0];
          assert.equal(message.type, 'user');
          assert.deepEqual(message.message, { role: 'user', content: task.instruction });
          assert.equal(message.parent_tool_use_id, null);
          assert.ok(uuid.test(message.uuid), where + ': input UUID');
          assert.equal(step.detail.streaming_input, true, where + ': interrupt needs streaming input mode');
          const options = step.detail.options;
          assert.equal(typeof options.cwd, 'string', where + ': operator-owned cwd');
          assert.ok(!/[A-Za-z]:[\\/]/.test(options.cwd), where + ': cwd is not a personal local path');
          assert.equal(typeof options.sandbox, 'object', where + ': sandbox settings present');
          assert.ok(reviewedPermissionModes.has(options.permissionMode), where + ': reviewed permission mode');
          assert.notEqual(options.permissionMode, 'bypassPermissions', where + ': bypassPermissions is not a reviewed literal');
          assert.equal(typeof options.canUseTool, 'object', where + ': fail-closed permission callback configured');
          assert.equal(options.persistSession, true, where + ': session persistence retained for recovery');
          assert.equal(typeof options.sessionStore, 'object', where + ': transcript mirror configured');
          assert.ok(uuid.test(options.sessionId), where + ': host-derived session UUID');
          assert.notEqual(options.sessionId, task.task_id, where + ': native session id is not the Strata task id');
          assert.ok(Number.isInteger(options.maxTurns) && options.maxTurns > 0, where + ': bounded agentic turns');
          assert.ok(typeof options.maxBudgetUsd === 'number' && options.maxBudgetUsd > 0, where + ': bounded client-side budget');
          assert.equal(options.abortController, true, where + ': grant-bounded abort controller wired');
          stats.checks++;
        }
        if (step.method === 'query.interrupt') {
          assert.equal(step.op, 'cancel', where + ': interrupt belongs to cancel');
          const target = calls.get(step.detail.call);
          assert.ok(target && target.method === 'query' && target.detail.streaming_input === true, where + ': interrupt targets a streaming query');
          assert.ok(sawRunning, where + ': interrupt happens against observed running work');
          const receipt = scenario.steps[index + 1];
          assert.ok(receipt && receipt.kind === 'sdk-return' && receipt.call === step.call, where + ': receipt is the interrupt method return');
          assert.ok(Array.isArray(receipt.value.still_queued) && receipt.value.still_queued.every(v => uuid.test(v)), where + ': receipt UUID list');
          assert.ok(!('cancelled' in receipt.value), where + ': query.interrupt never sends cancel_queued');
          stats.checks++;
        }
        if (step.method === 'getSessionInfo' || step.method === 'getSessionMessages') {
          assert.equal(step.op, 'status', where + ': session reads are status observations');
          if (step.detail.session_id === null) {
            const next = scenario.steps[index + 1];
            assert.ok(next && next.kind === 'adapter' && next.action === 'emit-error',
              where + ': an unresolvable lookup is an observation error');
          } else {
            assert.ok(bindSessionId === step.detail.session_id, where + ': reads use the bound native identity');
          }
          stats.checks++;
        }
      } else if (step.kind === 'sdk-event') {
        stats.sdkEvents++;
        const event = step.event;
        assert.ok(documentedEventVocabulary.has(event.type), where + ': undocumented event type ' + event.type);
        if (event.type === 'system') {
          assert.equal(event.subtype, 'init', where + ': init system message');
          assert.ok(uuid.test(event.session_id), where + ': session identity is a UUID');
          observedSessions.add(event.session_id);
        }
        if (event.type === 'assistant') {
          assert.ok(uuid.test(event.session_id), where + ': assistant event carries the session identity');
          assert.ok(Array.isArray(event.message?.content), where + ': assistant content blocks');
        }
        if (event.type === 'result') {
          assert.ok(reviewedResultSubtypes.has(event.subtype), where + ': reviewed result subtype');
          assert.ok(uuid.test(event.session_id), where + ': result carries the session identity');
          assert.ok(Number.isInteger(event.duration_api_ms) && event.duration_api_ms > 0, where + ': bounded api duration');
          assert.ok(typeof event.total_cost_usd === 'number' && event.total_cost_usd >= 0, where + ': client-side cost estimate');
          assert.equal(typeof event.usage, 'object', where + ': usage object');
          assert.equal(typeof event.result, 'string', where + ': pinned success final text field');
          assert.equal(event.session_id, bindSessionId, where + ': completion binds the observed session');
          if (event.subtype === 'success') sawSuccessResult = true;
          stats.checks++;
        }
      } else if (step.kind === 'session-history') {
        assert.ok(['user', 'assistant', 'system'].includes(step.event.type), where + ': history is not a terminal result');
        assert.equal(step.event.session_id, bindSessionId, where + ': history binds the observed session');
      } else if (step.kind === 'sdk-return') {
        assert.equal(calls.get(step.call)?.method, 'query.interrupt', where + ': method return belongs to interrupt');
      } else if (step.kind === 'adapter') {
        if (step.action === 'read-retained-completion') {
          stats.journalActions++;
          assert.equal(step.op, 'status');
          assert.equal(step.detail.source, 'original-query-stream');
          assert.equal(step.detail.request_sha256, ref.request_sha256, where + ': retained completion binds original request');
          assert.equal(step.detail.session_id, bindSessionId, where + ': retained completion binds native identity');
          const completion = step.detail.completion;
          assert.equal(completion.session_id, bindSessionId);
          assert.equal(completion.type, 'result');
          assert.equal(completion.subtype, 'success');
          assert.equal(typeof completion.result, 'string');
          sawSuccessResult = true; // Explicit synthetic retained-record assumption, not a history inference.
          stats.checks++;
        } else if (step.action === 'lookup-bound-session') {
          stats.journalActions++;
          assert.equal(bindSessionId, undefined);
          assert.equal(step.detail.session_id, null);
          assert.equal(step.op, 'status');
        } else if (step.action === 'reserve-key') {
          stats.journalActions++;
          firstReserveIndex = index;
          assert.equal(step.detail.connection_id, task.connection_id, where + ': reservation binds the connection');
          assert.equal(step.detail.task_id, task.task_id, where + ': reservation binds the original task id');
          assert.equal(step.detail.request_sha256, ref.request_sha256, where + ': reservation binds the request digest');
          if (conflictingRef) assert.equal(step.detail.existing_request_sha256, conflictingRef.request_sha256,
            where + ': conflict detection compares the retained request digest');
          stats.checks++;
        } else if (step.action === 'bind-session') {
          stats.journalActions++;
          assert.ok(observedSessions.has(step.detail.session_id), where + ': native identity is bound only after observation');
          if (calls.size > 0) {
            const query = [...calls.values()].find(c => c.method === 'query');
            if (query) assert.equal(query.detail.options.sessionId, step.detail.session_id,
              where + ': observed identity matches the host-derived session UUID');
          }
          bindSessionId = step.detail.session_id;
        } else if (step.action === 'retain-uncertain-admission' || step.action === 'block-second-start') {
          stats.journalActions++;
          assert.ok(typeof step.detail.reason === 'string' && step.detail.reason.length > 0, where + ': journal decision carries its reason');
        } else if (step.action === 'freeze-result') {
          stats.journalActions++;
          assert.ok(sawSuccessResult, where + ': freezing requires an observed native success result');
          frozenArtifactIds = step.detail.artifact_ids;
        } else if (step.action === 'emit-snapshot') {
          const snapshot = executionSnapshotSchema.parse(step.detail.snapshot);
          stats.snapshots++;
          assert.ok(sameExecutionValue(snapshot.task, ref), where + ': snapshot binds the scenario task ref');
          if (previousSnapshot) {
            try { assertExecutionTransition(previousSnapshot, snapshot); }
            catch { assert.fail(where + ': illegal snapshot transition ' + previousSnapshot.state + '@' + previousSnapshot.sequence + ' -> ' + snapshot.state + '@' + snapshot.sequence); }
            stats.checks++;
          }
          if (snapshot.state === 'running') sawRunning = true;
          if (snapshot.state === 'succeeded') {
            assert.ok(sawSuccessResult && frozenArtifactIds, where + ': success requires retained completion and frozen result, never history alone');
            succeededDigest = snapshot.result_sha256;
          }
          if (step.op === 'cancel') {
            assert.ok(snapshot.state !== 'queued' && snapshot.state !== 'running', where + ': cancel must not answer queued/running');
          }
          previousSnapshot = snapshot; lastSnapshot = snapshot;
        } else if (step.action === 'emit-result') {
          const result = executionResultSchema.parse(step.detail.result);
          stats.results++;
          assert.ok(sameExecutionValue(result.task, ref), where + ': result binds the scenario task ref');
          assert.ok(!JSON.stringify(result).includes('http'), where + ': no downloadable URLs in artifacts');
          assert.deepEqual(frozenArtifactIds ?? [], result.artifacts.map(a => a.id), where + ': frozen artifact inventory is the served inventory');
          assert.deepEqual(Object.keys(step.detail.artifact_contents ?? {}), result.artifacts.map(a => a.id), where + ': every artifact has a content source');
          for (const artifact of result.artifacts) {
            const content = step.detail.artifact_contents[artifact.id];
            assert.equal(typeof content, 'string', where + ': artifact content source ' + artifact.id);
            assert.equal(await rawDigest(content), artifact.sha256, where + ': artifact digest binds raw content bytes');
            assert.equal(new TextEncoder().encode(content).length, artifact.bytes, where + ': artifact byte count');
            stats.checks++;
          }
          assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= task.limits.output_bytes, where + ': original normalized output budget');
          emittedResult = result;
        } else if (step.action === 'emit-error') {
          stats.errors++;
          assert.ok(executionErrorCodeSchema.parse(step.detail.error.code), where + ': finite error code');
          assert.equal(step.detail.error.dispatch, 'unknown', where + ': every failure after invocation is unknown');
          assert.ok(!('message' in step.detail.error), where + ': no native message text in persisted errors');
          if (step.detail.error.code === 'EXECUTION_UNAVAILABLE') unavailableError = true;
          lastError = step.detail.error;        } else {
          assert.fail(where + ': unknown adapter action ' + step.action);
        }
      } else {
        assert.fail(where + ': unknown step kind ' + step.kind);
      }
    }
    if (queryCalls > 0) assert.ok(firstReserveIndex >= 0 && firstReserveIndex < firstQueryIndex,
      scenario.id + ': the key is reserved before any native start');
    if (unavailableError) assert.ok(scenario.steps.some(s => s.action === 'retain-uncertain-admission'),
      scenario.id + ': an uncertain dispatch retains its admission');
    if (scenario.id === 'unknown-session-remains-uncertain') {
      assert.equal(queryCalls, 1, 'Exactly one native start; the uncertain admission never restarts');
      assert.equal(bindSessionId, undefined, 'No native identity was retained');
      assert.ok(scenario.steps.some(s => s.action === 'block-second-start'), 'Every second start stays blocked');
      assert.equal(lastSnapshot, undefined, 'No snapshot may be invented without observation');
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
        assert.ok(scenario.steps.some(s => s.action === 'emit-snapshot' && s.detail.snapshot.state === state),
          scenario.id + ': expected intermediate state ' + state);
      }
    }
    if (expected.result_available) {
      assert.ok(emittedResult && succeededDigest, scenario.id + ': expected an emitted result and succeeded digest');
      assert.equal(await executionDigest(emittedResult), succeededDigest, scenario.id + ': succeeded snapshot binds the canonical result digest');
      const frozen = scenario.steps.find(s => s.action === 'freeze-result');
      assert.equal(frozen.detail.result_sha256, succeededDigest, scenario.id + ': the frozen digest is the served digest');
      stats.checks++;
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
  assert.equal(seen.size, requiredScenarios.size, 'No unlisted scenarios');
  return stats;
}

assert.ok(!/BEGIN PRIVATE KEY|\bsk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]+/.test(raw), 'Transcripts must not carry secret material');
const stats = await checkDocument(doc);

// Controlled in-memory negative mutations: the checker must reject
// deliberate result/ref/sequence/artifact/pin substitution. Nothing on
// disk is mutated and no runtime is launched.
const mutations = [
  ['result substitution', d => { d.scenarios[0].steps.at(-1).detail.result.summary += ' tampered'; }],
  ['ref substitution', d => {
    const snapshot = d.scenarios[4].steps.find(s => s.action === 'emit-snapshot' && s.detail.snapshot.state === 'running');
    snapshot.detail.snapshot.task.task_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  }],
  ['sequence substitution', d => {
    const snapshot = d.scenarios[4].steps.find(s => s.action === 'emit-snapshot' && s.detail.snapshot.state === 'succeeded');
    snapshot.detail.snapshot.sequence = 1;
  }],
  ['artifact substitution', d => { d.scenarios[0].steps.at(-1).detail.artifact_contents['change-001'] += 'x'; }],
  ['string prompt called streaming', d => { d.scenarios[0].steps.find(s=>s.method==='query').detail.prompt = d.scenarios[0].task.instruction; }],
  ['cancelled receipt from plain interrupt', d => { d.scenarios[4].steps.find(s=>s.kind==='sdk-return').value.cancelled = []; }],
  ['history without completion', d => { d.scenarios[2].steps = d.scenarios[2].steps.filter(s=>s.action!=='read-retained-completion'); }],
  ['completion request substitution', d => { d.scenarios[2].steps.find(s=>s.action==='read-retained-completion').detail.request_sha256 = '0'.repeat(64); }],
  ['pin substitution', d => { d.pinned.upstream_commit = '0000000000000000000000000000000000000000'; }],
];
let rejected = 0;
for (const [label, mutate] of mutations) {
  const mutated = structuredClone(doc);
  mutate(mutated);
  try { await checkDocument(mutated); } catch { rejected++; continue; }
  assert.fail('Mutation was not rejected: ' + label);
}

console.log(JSON.stringify({
  scenarios: doc.scenarios.length, snapshots: stats.snapshots, results: stats.results, errors: stats.errors,
  sdkCalls: stats.sdkCalls, sdkEvents: stats.sdkEvents, journalActions: stats.journalActions,
  digestAndTransitionChecks: stats.checks, rejectedMutations: rejected, failures: 0,
}));
