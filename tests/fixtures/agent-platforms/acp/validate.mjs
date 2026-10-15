#!/usr/bin/env node
// ACP-P1 offline fixture validator (docs/agents/platforms/ACP_EXECUTION_MAPPING.md).
// It validates the five proposal outputs against fixed source/version/digest
// anchors, recomputes task/ref/result/artifact digests with the shared
// execution/1 helpers, re-derives pinned native enum vocabulary from the pinned
// schema subset, checks attribution/sequence/terminal immutability, conservative
// errors, no-second-start counts and per-scenario semantic expectations, then
// replays in-memory negative mutations expecting rejection. It is offline
// (Node builtins plus dist/src/agent-execution.js), never writes back, launches
// nothing and proves only proposal consistency — not a qualified integration.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  executionTaskSchema, executionSnapshotSchema, executionResultSchema,
  executionErrorCodeSchema, executionTaskRef, executionDigest, executionCanonical, sameExecutionValue,
  assertExecutionTransition, AgentExecutionError,
} from '../../../../dist/src/agent-execution.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Fixed anchors: documented bytes of the reviewed profile. Co-substitution of a
// different-but-internally-consistent pin set must still fail against these.
const ANCHORS = {
  sourcesFileSha256: '868c0567b27ff78d209c7202387f1fb23319b84a98108efa8261750577467455',
  sdk: { name: '@agentclientprotocol/sdk', version: '1.5.0', commit: 'f1ba3a935df42efb4455be9b62c76b06610aaf50' },
  adapter: { name: '@agentclientprotocol/codex-acp', version: '2.2.2', commit: '202e66e63343ec4f5a5e35ab590251d813d129ca' },
  resolvedCodexVersion: '0.160.1',
  schemaBytes: 373903,
  subsetSha256: '8d98a3afa1eeb1587dde12c9cf03de20c5a23b26280da2a819abdb4e91383344',
  subsetBytes: 105888,
  selectedDefinitions: 116,
  documents: 10,
  protocolVersion: 1,
};
const SCENARIO_IDS = [
  'success', 'concurrent-duplicate-admission', 'changed-digest', 'lost-session-new-response',
  'lost-prompt-completion', 'restart-with-and-without-native-identity', 'cancellation-completion-race',
  'denied-permission', 'revocation-late-output', 'output-overflow', 'unsupported-version-capability',
];
const VARIANT_IDS = {
  'restart-with-and-without-native-identity': ['with-native-identity', 'without-native-identity'],
  'cancellation-completion-race': ['completion-wins', 'abort-confirmed'],
  'unsupported-version-capability': ['unsupported-protocol-version', 'unsupported-capability'],
};
const JOURNAL_KINDS = new Set([
  'reserve', 'duplicate-serialized', 'startup-initialized', 'startup-version-refused', 'session-new-sent',
  'session-new-retained', 'session-new-response-lost', 'prompt-sent', 'update-observed',
  'completion-retained', 'completion-lost', 'completion-discarded', 'result-frozen', 'result-refused',
  'conflict-recorded', 'admission-uncertain', 'recovery-blocked', 'replay-observed',
  'restart-reconstructed', 'approval-revoked', 'cancel-notified',
]);
const CLIENT_METHODS = new Set(['initialize', 'session/new', 'session/prompt', 'session/cancel', 'session/load', 'session/list']);
const AGENT_METHODS = new Set(['session/update', 'session/request_permission']);
// Only the five documented projections actually reviewed in this fixture.
const SESSION_UPDATES = new Set(['user_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'session_info_update']);
const TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];
const TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'];
const PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
const OPERATIONS = new Set(['submit', 'status', 'result', 'cancel']);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

function fail(message) { throw new Error('ACP-P1 fixture check failed: ' + message); }
function oneOfConsts(def) {
  return def.oneOf.filter(variant => typeof variant.const === 'string').map(variant => variant.const);
}
function utf8(text) { return new TextEncoder().encode(text).length; }
function jsonBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).length; }
function clone(value) { return structuredClone(value); }

function checkSources(sources) {
  assert.equal(sources.format, 'strata-acp-public-sources/1');
  assert.equal(sources.protocolVersion, ANCHORS.protocolVersion);
  assert.equal(sources.proposalOnly, true);
  for (const side of ['sdk', 'adapter']) {
    assert.equal(sources[side].name, ANCHORS[side].name);
    assert.equal(sources[side].version, ANCHORS[side].version);
    assert.equal(sources[side].commit, ANCHORS[side].commit);
  }
  assert.equal(sources.adapter.resolvedCodex.version, ANCHORS.resolvedCodexVersion);
  assert.equal(sources.adapter.resolvedSdk.version, ANCHORS.sdk.version);
  assert.equal(sources.schema.bytes, ANCHORS.schemaBytes);
  assert.equal(sources.schema.subsetSha256, ANCHORS.subsetSha256);
  assert.equal(sources.schema.subsetBytes, ANCHORS.subsetBytes);
  assert.equal(sources.schema.selectedDefinitions, ANCHORS.selectedDefinitions);
  assert.equal(sources.documents.length, ANCHORS.documents);
  for (const document of sources.documents) {
    for (const field of ['file', 'url', 'accessedAt', 'sha256', 'bytes']) assert.ok(document[field], 'pinned document field ' + field);
  }
  const subsetBytes = Buffer.from(sources.schema.subset_json, 'utf8');
  assert.equal(subsetBytes.length, ANCHORS.subsetBytes);
  assert.equal(sha256(subsetBytes), ANCHORS.subsetSha256);
  const subset = JSON.parse(sources.schema.subset_json);
  const defs = subset.$defs;
  assert.equal(Object.keys(defs).length, ANCHORS.selectedDefinitions);
  // Pinned enum vocabulary is re-derived from the reviewed subset, not trusted from the fixture.
  assert.deepEqual(oneOfConsts(defs.StopReason).sort(), [...STOP_REASONS].sort());
  assert.deepEqual(oneOfConsts(defs.ToolCallStatus).sort(), [...TOOL_STATUSES].sort());
  assert.deepEqual(oneOfConsts(defs.PermissionOptionKind).sort(), [...PERMISSION_KINDS].sort());
  return { stopReasons: new Set(oneOfConsts(defs.StopReason)), defs };
}

function checkProfile(transcripts, sources) {
  assert.equal(transcripts.format, 'strata-acp-p1-transcripts/1');
  assert.equal(transcripts.proposalOnly, true);
  assert.equal(transcripts.protocolVersion, ANCHORS.protocolVersion);
  const profile = transcripts.sourceProfile;
  assert.equal(profile.sdk.name, ANCHORS.sdk.name);
  assert.equal(profile.sdk.version, ANCHORS.sdk.version);
  assert.equal(profile.sdk.commit, ANCHORS.sdk.commit);
  assert.equal(profile.adapter.name, ANCHORS.adapter.name);
  assert.equal(profile.adapter.version, ANCHORS.adapter.version);
  assert.equal(profile.adapter.commit, ANCHORS.adapter.commit);
  assert.equal(profile.resolvedCodexVersion, ANCHORS.resolvedCodexVersion);
  assert.equal(profile.schemaSubsetSha256, ANCHORS.subsetSha256);
  assert.equal(profile.sourcesFileSha256, ANCHORS.sourcesFileSha256);
  // Cross-file consistency: the fixture profile must equal the pinned sources, both also pinned above.
  assert.equal(profile.sdk.version, sources.sdk.version);
  assert.equal(profile.adapter.commit, sources.adapter.commit);
  assert.equal(profile.resolvedCodexVersion, sources.adapter.resolvedCodex.version);
  assert.equal(profile.schemaSubsetSha256, sources.schema.subsetSha256);
  const checkout = transcripts.syntheticIdentity.checkout;
  assert.ok(typeof checkout === 'string' && checkout.startsWith('/'), 'synthetic absolute checkout');
  const mapping = transcripts.stopReasonMapping;
  assert.deepEqual(mapping.map(entry => entry.stopReason), STOP_REASONS);
  assert.deepEqual(mapping.map(entry => entry.proposedOutcome),
    ['succeeded', 'failed/TASK_LIMIT', 'failed/TASK_LIMIT', 'failed/TASK_POLICY', 'cancelled']);
  for (const entry of mapping) assert.ok(entry.requirements.length > 40, 'stop reason requirements');
  assert.ok(mapping[0].requirements.includes('retained attributable'), 'end_turn requires retained bytes');
  assert.ok(mapping[4].requirements.includes('session/cancel'), 'cancelled requires the cancel notification');
  assert.ok(mapping[4].requirements.includes('AbortSignal'), 'cancelled lists non-proof signals');
}

async function checkVariant(scenario, variant, enums) {
  const task = executionTaskSchema.parse(scenario.task);
  const ref = await executionTaskRef(task);
  let changedRef = null;
  if (scenario.changedTask) {
    const changedTask = executionTaskSchema.parse(scenario.changedTask);
    changedRef = await executionTaskRef(changedTask);
    assert.equal(changedRef.task_id, ref.task_id);
    assert.equal(changedRef.connection_id, ref.connection_id);
    assert.notEqual(changedRef.request_sha256, ref.request_sha256);
  }

  // Journal: monotonic sequence, pinned kinds, task attribution, reserve-first, digest retention.
  const journal = variant.journal;
  assert.ok(journal.length > 0, 'journal present');
  journal.forEach((entry, index) => {
    assert.equal(entry.seq, index + 1, 'journal sequence is dense and monotonic');
    assert.ok(JOURNAL_KINDS.has(entry.kind), 'journal kind ' + entry.kind);
    assert.equal(entry.taskId, task.task_id, 'journal task attribution');
  });
  assert.equal(journal[0].kind, 'reserve', 'durable reservation precedes native work');
  assert.equal(journal[0].connectionId, ref.connection_id, 'reservation owns the exact connection key');
  assert.equal(journal[0].requestSha256, ref.request_sha256, 'reservation binds the complete digest');
  if (changedRef) {
    const conflict = journal.find(entry => entry.kind === 'conflict-recorded');
    assert.ok(conflict, 'conflict recorded');
    assert.equal(conflict.changedRequestSha256, changedRef.request_sha256, 'conflict records the changed digest');
  }
  const retainedEntry = journal.find(entry => entry.kind === 'session-new-retained');
  const retainedSessionId = retainedEntry ? retainedEntry.sessionId : null;

  // Messages: pinned vocabulary, fail-closed client capabilities, attribution outside the wire objects.
  const requests = new Map(); // id -> { method, entry }
  let initializeRequests = 0;
  const counts = { initialize: 0, 'session/new': 0, 'session/prompt': 0, 'session/cancel': 0, 'session/load': 0, 'session/list': 0 };
  let wireMessages = 0;
  let promptResponseIndex = -1, cancelNotificationIndex = -1;
  const agentChunkTexts = [];
  variant.messages.forEach((entry, index) => {
    assert.ok(entry.attribution && entry.attribution.taskId === task.task_id, 'message task attribution');
    if (entry.direction === 'annotation') { assert.ok(!entry.wire, 'annotations stay outside native wire objects'); return; }
    assert.ok(entry.direction === 'client>agent' || entry.direction === 'agent>client', 'direction');
    const wire = entry.wire;
    wireMessages += 1;
    assert.equal(wire.jsonrpc, '2.0');
    if (wire.method !== undefined) {
      if (entry.direction === 'client>agent') assert.ok(CLIENT_METHODS.has(wire.method), 'client method ' + wire.method);
      else assert.ok(AGENT_METHODS.has(wire.method), 'agent method ' + wire.method);
      const isNotification = wire.id === undefined;
      if (!isNotification) {
        assert.equal(entry.attribution.requestId, wire.id, 'request attribution equals wire id');
        requests.set(wire.id, { method: wire.method, entry, index });
      } else if (entry.attribution.requestId !== null) {
        // Notifications may attribute the in-flight turn they belong to, but only to a known request.
        assert.ok(requests.has(entry.attribution.requestId), 'notification attribution links to a known request');
      }
      if (wire.method in counts && entry.direction === 'client>agent') counts[wire.method] += 1;
      if (wire.method === 'initialize') {
        initializeRequests += 1;
        assert.equal(wire.params.protocolVersion, ANCHORS.protocolVersion, 'client pins stable v1');
        const caps = wire.params.clientCapabilities;
        assert.equal(caps.fs.readTextFile, false, 'fail-closed fs read');
        assert.equal(caps.fs.writeTextFile, false, 'fail-closed fs write');
        assert.equal(caps.terminal, false, 'fail-closed terminal');
        assert.equal(caps.auth.terminal, false, 'fail-closed terminal auth');
      }
      if (wire.method === 'session/new') {
        assert.equal(wire.params.cwd, scenario.checkout, 'operator-approved isolated checkout');
        assert.deepEqual(wire.params.mcpServers, [], 'no task-supplied MCP servers');
      }
      if (wire.method === 'session/prompt') {
        assert.equal(wire.params.sessionId, entry.attribution.sessionId, 'prompt targets the attributed session');
        assert.ok(wire.params.prompt.length > 0, 'prompt has content blocks');
        for (const block of wire.params.prompt) assert.equal(block.type, 'text', 'baseline text content only');
        assert.equal(wire.params.prompt.map(block => block.text).join(''), task.instruction, 'serialized prompt is the task instruction');
      }
      if (wire.method === 'session/cancel') {
        cancelNotificationIndex = index;
        assert.equal(wire.id, undefined, 'session/cancel is a notification');
        assert.equal(wire.params.sessionId, entry.attribution.sessionId, 'cancel targets the attributed session');
      }
      if (wire.method === 'session/load') assert.equal(wire.params.sessionId, entry.attribution.sessionId, 'load targets the attributed session');
      if (wire.method === 'session/update') {
        assert.equal(wire.id, undefined, 'session/update is a notification');
        assert.equal(wire.params.sessionId, entry.attribution.sessionId, 'update belongs to the attributed session');
        const observedRequest = requests.get(entry.attribution.requestId);
        assert.ok(observedRequest && ['session/prompt', 'session/load'].includes(observedRequest.method), 'update attributes the prompt or explicit history load, never initialization');
        assert.equal(observedRequest.entry.wire.params.sessionId, entry.attribution.sessionId, 'update request owns the same session');
        const update = wire.params.update;
        assert.ok(SESSION_UPDATES.has(update.sessionUpdate), 'sessionUpdate vocabulary ' + update.sessionUpdate);
        if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message_chunk') {
          assert.equal(update.content.type, 'text');
          if (update.sessionUpdate === 'agent_message_chunk') agentChunkTexts.push(update.content.text);
        }
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          assert.ok(typeof update.toolCallId === 'string' && update.toolCallId.length > 0);
          if (update.status !== undefined) assert.ok(TOOL_STATUSES.includes(update.status), 'tool status vocabulary');
          if (update.kind !== undefined) assert.ok(TOOL_KINDS.has(update.kind), 'tool kind vocabulary');
          if (update.content !== undefined) for (const block of update.content) {
            if (block.type === 'diff') assert.ok(block.path.startsWith('/'), 'absolute diff path');
          }
        }
      }
      if (wire.method === 'session/request_permission') {
        assert.ok(wire.params.toolCall && typeof wire.params.toolCall.toolCallId === 'string');
        assert.ok(wire.params.options.length >= 2, 'options offered');
        const optionIds = new Set(), kinds = [];
        for (const option of wire.params.options) {
          assert.ok(PERMISSION_KINDS.includes(option.kind), 'permission option kind vocabulary');
          assert.ok(typeof option.optionId === 'string' && option.optionId.length > 0);
          assert.ok(typeof option.name === 'string' && option.name.length > 0);
          assert.ok(!optionIds.has(option.optionId), 'unique option ids');
          optionIds.add(option.optionId); kinds.push(option.kind);
        }
        assert.ok(kinds.some(kind => kind === 'reject_once' || kind === 'reject_always'), 'a reject option is offered');
      }
    } else {
      // Response: must link to a prior request, carry attribution, and match the method result shape.
      assert.ok(Number.isInteger(wire.id), 'response id');
      assert.equal(entry.attribution.requestId, wire.id, 'response attribution equals wire id');
      assert.ok(!(wire.result !== undefined && wire.error !== undefined), 'result xor error');
      assert.ok(wire.result !== undefined, 'projections use results, not native error bodies');
      const request = requests.get(wire.id);
      assert.ok(request, 'response links to a prior request ' + wire.id);
      if (request.method === 'initialize') {
        assert.ok(Number.isInteger(wire.result.protocolVersion), 'negotiated protocol version');
        const expected = variant.id === 'unsupported-protocol-version' ? 2 : 1;
        assert.equal(wire.result.protocolVersion, expected, 'negotiated protocol version per variant');
        assert.equal(typeof wire.result.agentCapabilities.loadSession, 'boolean', 'loadSession is explicit');
      }
      if (request.method === 'session/new') {
        assert.ok(typeof wire.result.sessionId === 'string' && wire.result.sessionId.length > 0);
        assert.equal(entry.attribution.sessionId, wire.result.sessionId, 'retained session identity');
        if (retainedSessionId) assert.equal(retainedSessionId, wire.result.sessionId, 'journal retention matches the observed session');
      }
      if (request.method === 'session/prompt') {
        assert.ok(enums.stopReasons.has(wire.result.stopReason), 'stop reason vocabulary');
        promptResponseIndex = index;
        assert.ok(request.index < index, 'completion follows the prompt request');
      }
      if (request.method === 'session/load') assert.deepEqual(wire.result, {}, 'load returns an empty result');
      if (request.method === 'session/request_permission') {
        const outcome = wire.result.outcome;
        assert.ok(outcome.outcome === 'cancelled' || outcome.outcome === 'selected', 'permission outcome vocabulary');
        if (outcome.outcome === 'selected') {
          const offered = request.entry.wire.params.options;
          const option = offered.find(candidate => candidate.optionId === outcome.optionId);
          assert.ok(option, 'selected option was actually offered');
          if (scenario.id === 'denied-permission') assert.equal(option.kind, 'reject_once', 'denial selects the offered reject_once option');
        }
      }
    }
    // Session attribution discipline: every non-null session id is the one retained identity.
    if (entry.attribution.sessionId !== null) {
      assert.ok(retainedSessionId !== null, 'session attribution without retained identity');
      assert.equal(entry.attribution.sessionId, retainedSessionId, 'no cross-session substitution');
    }
  });
  assert.equal(initializeRequests, 1, 'exactly one supervised initialize');
  assert.deepEqual(counts, variant.nativeCounts, 'declared native counts match recomputed client calls');

  // Journal handles are proposed bindings, not trusted prose. Check all prompt
  // lifecycle entries, including cancellation, against the actual request.
  for (const entry of journal.filter(entry => ['prompt-sent', 'completion-retained', 'completion-lost', 'completion-discarded', 'result-frozen'].includes(entry.kind))) {
    const request = requests.get(entry.requestId);
    assert.equal(request?.method, 'session/prompt', 'journal lifecycle binds the original prompt request');
    assert.equal(entry.sessionId, retainedSessionId, 'journal lifecycle binds the retained session');
    assert.equal(request.entry.wire.params.sessionId, entry.sessionId, 'journal lifecycle request owns the same session');
    if (entry.kind === 'completion-retained') {
      assert.ok(variant.messages.some(message => message.direction === 'agent>client' && message.wire?.id === entry.requestId && message.wire?.result?.stopReason), 'retained completion has an attributable prompt reply');
    }
  }

  // Snapshots: strict DTOs for the computed ref, monotonic, valid transitions, terminal immutability.
  const snapshots = variant.decisions.snapshots;
  for (const snapshot of snapshots) {
    const parsed = executionSnapshotSchema.parse(snapshot);
    assert.ok(sameExecutionValue(parsed.task, ref), 'snapshot binds the exact task ref');
  }
  for (let index = 1; index < snapshots.length; index += 1) {
    assert.ok(snapshots[index].sequence > snapshots[index - 1].sequence, 'monotonic snapshot sequence');
    assertExecutionTransition(snapshots[index - 1], snapshots[index]);
  }
  const terminalAt = snapshots.findIndex(snapshot => TERMINAL_STATES.has(snapshot.state));
  if (terminalAt >= 0) {
    for (let index = terminalAt + 1; index < snapshots.length; index += 1) {
      assert.ok(sameExecutionValue(snapshots[terminalAt], snapshots[index]), 'terminal snapshots never change');
    }
    const terminal = snapshots[terminalAt];
    const succeeded = terminal.state === 'succeeded' ? terminal : snapshots.find(snapshot => snapshot.state === 'succeeded');
    if (succeeded) {
      assert.ok(variant.decisions.result, 'a succeeded snapshot has a retained immutable result');
      assert.equal(variant.decisions.completionEligibility, 'hypothetical-qualified-profile-and-retained-original-prompt', 'end_turn alone never qualifies completion');
      const completion = journal.find(entry => entry.kind === 'completion-retained');
      const frozen = journal.find(entry => entry.kind === 'result-frozen');
      const reply = variant.messages.find(entry => entry.wire?.id === completion?.requestId && entry.wire?.result?.stopReason);
      assert.ok(completion && frozen && completion.seq < frozen.seq, 'completion retained before result freeze');
      assert.equal(reply?.wire.result.stopReason, 'end_turn', 'attributable original prompt completed');
      assert.equal(completion.sessionId, retainedSessionId, 'completion owns the retained session');
      const result = executionResultSchema.parse(variant.decisions.result);
      assert.ok(sameExecutionValue(result.task, ref), 'result binds the exact task ref');
      assert.equal(await executionDigest(result), succeeded.result_sha256, 'result digest binds the succeeded snapshot');
      assert.ok(jsonBytes(result) <= Math.min(task.limits.output_bytes, 65536), 'result within the output budget');
      const diffBlocks = variant.messages
        .map(entry => entry.wire?.method === 'session/update' ? entry.wire.params.update : null)
        .filter(update => update && (update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'tool_call'))
        .flatMap(update => update.content ?? [])
        .filter(block => block.type === 'diff')
        .map(block => ({ path: block.path, oldText: block.oldText, newText: block.newText }));
      if (diffBlocks.length > 0) {
        assert.equal(result.artifacts.length, diffBlocks.length, 'one descriptor per retained diff block');
        for (let index = 0; index < result.artifacts.length; index += 1) {
          assert.equal(await executionDigest(diffBlocks[index]), result.artifacts[index].sha256, 'artifact digest covers the retained diff block');
          const artifact = result.artifacts[index];
          const bytes = variant.decisions.artifactBytes?.[artifact.id];
          assert.equal(bytes, executionCanonical(diffBlocks[index]), 'artifact bytes are the retained canonical JSON diff record');
          assert.equal(artifact.media_type, 'application/json', 'artifact type matches the retained bytes');
          assert.equal(utf8(bytes), artifact.bytes, 'artifact byte count covers the same bytes as its digest');
          assert.equal(sha256(bytes), artifact.sha256, 'artifact digest covers the exact retained bytes');
        }
      } else {
        assert.equal(result.artifacts.length, 0, 'artifacts require retained diff backing in the projection');
      }
    } else assert.equal(variant.decisions.result, null, 'failed/cancelled snapshots have no success result');
  } else {
    assert.equal(variant.decisions.result, null, 'no result without a succeeded snapshot');
  }

  // Errors: finite codes, dispatch certainty, and the exact conservative signature per scenario.
  for (const error of variant.decisions.errors) {
    assert.ok(OPERATIONS.has(error.operation), 'error operation');
    assert.ok(executionErrorCodeSchema.options.includes(error.code), 'finite error code');
    assert.ok(error.dispatch === 'not_dispatched' || error.dispatch === 'unknown', 'dispatch certainty');
    assert.equal(error.message, new AgentExecutionError(error.code, error.dispatch).message, 'persisted error message is the shared static message');
    assert.ok(typeof error.note === 'string' && error.note.length > 0, 'fixture-only explanatory annotation');
  }
  const errorSignature = variant.decisions.errors.map(error => [error.operation, error.code, error.dispatch]);
  assert.deepEqual(errorSignature, EXPECTED_ERRORS[scenario.id]?.[variant.id] ?? [], 'conservative error signature for ' + scenario.id + '/' + variant.id);
  assert.deepEqual(variant.expectations, EXPECTED_EXPECTATIONS[scenario.id][variant.id], 'expectations for ' + scenario.id + '/' + variant.id);

  // Per-scenario semantics (hand-reasoned, not regexes).
  const states = snapshots.map(snapshot => snapshot.state);
  const stopReason = (() => {
    const response = variant.messages.find(entry => entry.wire && entry.wire.id === 2 && entry.wire.result && entry.wire.result.stopReason !== undefined);
    return response ? response.wire.result.stopReason : null;
  })();
  switch (scenario.id + '/' + variant.id) {
    case 'success/primary':
      assert.deepEqual(states, ['running', 'succeeded']);
      assert.equal(stopReason, 'end_turn');
      assert.equal(variant.decisions.result.summary, agentChunkTexts.at(-1), 'summary normalizes the retained final agent message');
      assert.equal(variant.journal.at(-1).kind, 'result-frozen');
      break;
    case 'concurrent-duplicate-admission/primary': {
      assert.deepEqual(states, ['running', 'succeeded']);
      assert.ok(journal.some(entry => entry.kind === 'duplicate-serialized'), 'duplicate serialized at the reservation');
      assert.equal(counts['session/new'], 1); assert.equal(counts['session/prompt'], 1);
      break;
    }
    case 'changed-digest/primary':
      assert.deepEqual(states, ['running', 'succeeded']);
      assert.ok(journal.some(entry => entry.seq > 5 && entry.kind === 'conflict-recorded'), 'conflict after the terminal state');
      break;
    case 'lost-session-new-response/primary':
      assert.deepEqual(states, ['queued']);
      assert.equal(counts['session/new'], 1); assert.equal(counts['session/prompt'], 0);
      assert.ok(journal.some(entry => entry.kind === 'admission-uncertain'));
      break;
    case 'lost-prompt-completion/primary': {
      assert.deepEqual(states, ['running']);
      assert.equal(counts['session/load'], 1); assert.equal(counts['session/prompt'], 1);
      const replayKinds = variant.messages
        .filter(entry => entry.attribution.requestId === 3 && entry.wire?.method === 'session/update')
        .map(entry => entry.wire.params.update.sessionUpdate);
      for (const kind of ['user_message_chunk', 'agent_message_chunk', 'session_info_update']) {
        assert.ok(replayKinds.includes(kind), 'replay observed: ' + kind);
      }
      break;
    }
    case 'restart-with-and-without-native-identity/with-native-identity': {
      assert.deepEqual(states, ['running', 'succeeded']);
      const restartIndex = variant.messages.findIndex(entry => entry.direction === 'annotation' && entry.note.startsWith('Host restart'));
      assert.ok(restartIndex >= 0, 'restart annotation present');
      assert.equal(variant.messages.slice(restartIndex + 1).filter(entry => entry.wire).length, 0, 'zero native calls after restart');
      break;
    }
    case 'restart-with-and-without-native-identity/without-native-identity':
      assert.deepEqual(states, ['queued']);
      assert.equal(counts['session/load'], 0); assert.equal(counts['session/list'], 0); assert.equal(counts['session/prompt'], 0);
      break;
    case 'cancellation-completion-race/completion-wins':
      assert.deepEqual(states, ['running', 'cancel_requested', 'succeeded']);
      assert.equal(stopReason, 'end_turn');
      assert.ok(cancelNotificationIndex >= 0 && promptResponseIndex > cancelNotificationIndex, 'client reads the delayed completion after sending cancel');
      assert.deepEqual(variant.decisions.raceOrdering, { agentCommittedBeforeReceivingCancel: true, clientReadsReplyAfterSendingCancel: true }, 'completion must have won before the agent received cancellation');
      assert.ok(variant.messages.slice(0, cancelNotificationIndex).some(entry => entry.direction === 'annotation' && entry.note.startsWith('Assumed agent ordering:')), 'race timing assumption precedes cancellation');
      break;
    case 'cancellation-completion-race/abort-confirmed': {
      assert.deepEqual(states, ['running', 'cancel_requested', 'cancelled']);
      assert.equal(stopReason, 'cancelled');
      assert.ok(cancelNotificationIndex >= 0 && promptResponseIndex > cancelNotificationIndex);
      assert.ok(journal.some(entry => entry.kind === 'completion-retained' && entry.requestId === 2 && entry.sessionId === retainedSessionId), 'cancelled snapshot requires retained original-prompt completion');
      const permissionResponse = variant.messages.find(entry => entry.wire?.id === 5 && entry.wire?.result?.outcome);
      assert.equal(permissionResponse.wire.result.outcome.outcome, 'cancelled', 'pending permission answered cancelled');
      break;
    }
    case 'denied-permission/primary': {
      assert.deepEqual(states, ['running', 'succeeded']);
      assert.equal(stopReason, 'end_turn');
      const noteIds = variant.decisions.notes.map(note => note.id);
      assert.ok(noteIds.includes('local-failure-policy') && noteIds.includes('later-prompt-refusal'), 'policy qualifications present');
      break;
    }
    case 'revocation-late-output/primary': {
      assert.deepEqual(states, ['running']);
      assert.equal(counts['session/cancel'], 0, 'no cleanup cancel under the revoked grant');
      const revokeIndex = variant.messages.findIndex(entry => entry.direction === 'annotation' && entry.note.startsWith('Approval revoked'));
      const lateResponse = variant.messages.findIndex(entry => entry.wire?.id === 2 && entry.wire?.result);
      assert.ok(revokeIndex >= 0 && lateResponse > revokeIndex, 'late completion after revocation');
      break;
    }
    case 'output-overflow/primary': {
      assert.deepEqual(states, ['running']);
      const longest = Math.max(...variant.messages
        .map(entry => entry.wire?.method === 'session/update' && entry.wire.params.update.sessionUpdate === 'agent_message_chunk' ? utf8(entry.wire.params.update.content.text) : 0));
      assert.ok(longest > task.limits.output_bytes, 'observed output exceeds the task budget');
      assert.ok(journal.some(entry => entry.kind === 'result-refused'));
      break;
    }
    case 'unsupported-version-capability/unsupported-protocol-version':
      assert.deepEqual(states, []);
      assert.equal(counts['session/new'] + counts['session/prompt'] + counts['session/load'] + counts['session/list'], 0, 'no session work dispatched');
      break;
    case 'unsupported-version-capability/unsupported-capability': {
      assert.deepEqual(states, ['running']);
      const initializeResponse = variant.messages.find(entry => entry.wire?.id === 0 && entry.wire?.result);
      assert.equal(initializeResponse.wire.result.agentCapabilities.loadSession, false, 'loadSession not advertised');
      assert.equal(counts['session/load'], 0, 'session/load never sent without the capability');
      break;
    }
    default: fail('unhandled scenario ' + scenario.id + '/' + variant.id);
  }
  return { wireMessages, journalEntries: journal.length, snapshots: snapshots.length };
}

const EXPECTED_ERRORS = {
  'changed-digest': { primary: [['submit', 'EXECUTION_CONFLICT', 'unknown']] },
  'lost-session-new-response': { primary: [['submit', 'EXECUTION_UNAVAILABLE', 'unknown']] },
  'lost-prompt-completion': { primary: [['result', 'EXECUTION_RESULT_UNAVAILABLE', 'not_dispatched']] },
  'restart-with-and-without-native-identity': { 'without-native-identity': [['result', 'EXECUTION_RESULT_UNAVAILABLE', 'not_dispatched']] },
  'cancellation-completion-race': { 'abort-confirmed': [['result', 'EXECUTION_RESULT_UNAVAILABLE', 'not_dispatched']] },
  'revocation-late-output': { primary: [['submit', 'EXECUTION_STALE', 'unknown'], ['status', 'EXECUTION_AUTH', 'not_dispatched']] },
  'output-overflow': { primary: [['status', 'EXECUTION_LIMIT', 'unknown']] },
  'unsupported-version-capability': {
    'unsupported-protocol-version': [['submit', 'EXECUTION_VERSION', 'unknown']],
    'unsupported-capability': [['status', 'EXECUTION_UNSUPPORTED', 'unknown']],
  },
};
const EXPECTED_EXPECTATIONS = {
  success: { primary: { submitReturns: 'running', promptReturnedPromptly: true, finalState: 'succeeded', endTurnAloneIsNotQualification: true, resultDigestBound: true } },
  'concurrent-duplicate-admission': { primary: { duplicatesSerializeAtReservation: true, secondSubmitStartsNoNativeWork: true, singleAdmission: true, sessionNewCount: 1, sessionPromptCount: 1 } },
  'changed-digest': { primary: { conflictEvenAfterTerminal: true, noReplacementTaskId: true, nativeCountsUnchanged: true, errorCode: 'EXECUTION_CONFLICT', errorDispatch: 'unknown' } },
  'lost-session-new-response': { primary: { uncertainAdmissionRetained: true, secondSessionNewBlocked: true, resubmitReturnsRetainedQueuedSnapshot: true, uncertaintyOutsideStatusDto: true, sessionNewCount: 1, sessionPromptCount: 0 } },
  'lost-prompt-completion': { primary: { historyReplayIsNotACompletionReceipt: true, assistantTextIsNotAReceipt: true, titleAndTimeAreNotReceipts: true, noSecondPrompt: true, resultUnavailable: 'EXECUTION_RESULT_UNAVAILABLE', statusRemainsRunning: true, sessionPromptCount: 1 } },
  'restart-with-and-without-native-identity': {
    'with-native-identity': { committedImmutableResultRetrieved: true, postRestartNativeCalls: 0, terminalSnapshotUnchanged: true, resultDigestMatches: true },
    'without-native-identity': { noSessionLoadWithoutIdentity: true, noSessionListSubstitution: true, noSecondStart: true, missingCompletionUncertain: true, sessionLoadCount: 0, sessionListCount: 0, sessionPromptCount: 0 },
  },
  'cancellation-completion-race': {
    'completion-wins': { cancelRequestedEmitted: true, completionAlreadyWon: true, terminalStateAfterCancelRequest: 'succeeded', cancelledConfirmationAbsent: true, resultAvailable: true },
    'abort-confirmed': { promptCancelledReplyConfirmsAbort: true, pendingPermissionAnsweredCancelled: true, terminalState: 'cancelled', genericSignalsAreNotStopProof: true, resultUnavailable: true },
  },
  'denied-permission': { primary: { selectedOptionWasOffered: true, selectedOptionKind: 'reject_once', permissionWideningRefused: true, toolDenialAloneIsNotTaskFailure: true } },
  'revocation-late-output': { primary: { lateOutputDiscarded: true, noSuccessAfterRevoke: true, noCleanupCancelUnderRevokedGrant: true, rollbackNotClaimed: true, sessionCancelCount: 0 } },
  'output-overflow': { primary: { successRefused: true, unknownOngoingWorkRetained: true, nativeHardStopNotClaimed: true, observedOutputBytesExceedBudget: true, noFabricatedTaskLimit: true } },
  'unsupported-version-capability': {
    'unsupported-protocol-version': { agentReturnedProtocolVersion: 2, clientDisconnected: true, errorCode: 'EXECUTION_VERSION', errorDispatch: 'unknown', nativeSessionCalls: 0 },
    'unsupported-capability': { loadSessionAdvertised: false, sessionLoadNeverSent: true, errorCode: 'EXECUTION_UNSUPPORTED', errorDispatch: 'unknown', uncertaintyRetained: true, sessionLoadCount: 0 },
  },
};

async function checkTranscripts(transcripts, sources, enums) {
  checkProfile(transcripts, sources);
  assert.deepEqual(transcripts.scenarios.map(scenario => scenario.id), SCENARIO_IDS, 'exact eleven scenario ids in order');
  const totals = { wireMessages: 0, journalEntries: 0, snapshots: 0 };
  for (const scenario of transcripts.scenarios) {
    const expectedVariants = VARIANT_IDS[scenario.id] ?? ['primary'];
    assert.deepEqual(scenario.variants.map(variant => variant.id), expectedVariants, 'variant ids for ' + scenario.id);
    scenario.checkout = transcripts.syntheticIdentity.checkout;
    for (const variant of scenario.variants) {
      const counts = await checkVariant(scenario, variant, enums);
      totals.wireMessages += counts.wireMessages;
      totals.journalEntries += counts.journalEntries;
      totals.snapshots += counts.snapshots;
    }
  }
  return totals;
}

// In-memory negative mutations: each must be rejected. Nothing is written back.
function scenarioOf(transcripts, id) { return transcripts.scenarios.find(scenario => scenario.id === id); }
function variantOf(transcripts, id, variantId = 'primary') { return scenarioOf(transcripts, id).variants.find(variant => variant.id === variantId); }
function flipHex(digest) { return (digest[0] === '1' ? '2' : '1') + digest.slice(1); }
function succeededSnapshot(requestSha, resultSha, sequence) {
  return { format: 'strata-agent-task-status/1', sequence, state: 'succeeded', result_sha256: resultSha, task: {
    connection_id: 'acp-p1-conn', task_id: '7e1c9a42-5b36-4c0d-8f2a-9d4b6e8a0c1f',
    binding: { project_id: 'acp-p1-project', model_version: 'strata/acp-p1-synthetic', repository_id: 'acp-p1-repo' },
    repository_revision: 'a1b2c3d4e5f60718293a4b5c6d7e8f90aabbccdd', request_sha256: requestSha } };
}
const forgedResult = requestSha => ({ format: 'strata-agent-task-result/1', task: succeededSnapshot(requestSha, '0'.repeat(64), 2).task,
  summary: 'Forged history completion.', artifacts: [], trust: 'agent-output' });

async function runMutations(sources, transcripts, enums) {
  const successVariant = () => variantOf(transcripts, 'success');
  const requestSha = successVariant().decisions.snapshots[0].task.request_sha256;
  const resultSha = successVariant().decisions.snapshots[1].result_sha256;
  const mutations = [];
  const add = (name, run) => mutations.push({ name, run });

  add('pin.subset-sha', () => {
    const mutated = clone(sources); mutated.schema.subsetSha256 = '0'.repeat(64);
    assert.throws(() => checkSources(mutated));
  });
  add('pin.sdk-cosubstitution', () => {
    const mutatedSources = clone(sources); mutatedSources.sdk.version = '1.6.0';
    const mutatedTranscripts = clone(transcripts); mutatedTranscripts.sourceProfile.sdk.version = '1.6.0';
    assert.throws(() => checkSources(mutatedSources));
    assert.throws(() => checkProfile(mutatedTranscripts, mutatedSources));
  });
  add('pin.codex-version-swap', () => {
    const mutatedSources = clone(sources); mutatedSources.adapter.resolvedCodex.version = '0.162.1';
    const mutatedTranscripts = clone(transcripts); mutatedTranscripts.sourceProfile.resolvedCodexVersion = '0.162.1';
    assert.throws(() => checkSources(mutatedSources));
    assert.throws(() => checkProfile(mutatedTranscripts, mutatedSources));
  });
  add('digest.task-ref', () => {
    const mutated = clone(transcripts);
    variantOf(mutated, 'success').decisions.snapshots[0].task.request_sha256 = flipHex(requestSha);
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('digest.result', () => {
    const mutated = clone(transcripts);
    variantOf(mutated, 'success').decisions.snapshots[1].result_sha256 = flipHex(resultSha);
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('sequence.reversal', () => {
    const mutated = clone(transcripts);
    variantOf(mutated, 'cancellation-completion-race', 'completion-wins').decisions.snapshots[1].sequence = 0;
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('attribution.session-substitution', () => {
    const mutated = clone(transcripts);
    const message = variantOf(mutated, 'success').messages.find(entry => entry.wire?.method === 'session/update');
    message.attribution.sessionId = 'acp-other-session';
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('attribution.request-substitution', () => {
    const mutated = clone(transcripts);
    const message = variantOf(mutated, 'cancellation-completion-race', 'completion-wins').messages
      .find(entry => entry.wire?.id === 2 && entry.wire?.result);
    message.attribution.requestId = 99;
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('attribution.task-substitution', () => {
    const mutated = clone(transcripts);
    variantOf(mutated, 'concurrent-duplicate-admission').messages[2].attribution.taskId = '3c9d2e51-7a4b-4f80-b1c3-2d5e7f9a1b0d';
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('lost-response.resubmit', () => {
    const mutated = clone(transcripts);
    variantOf(mutated, 'lost-session-new-response').messages.push({
      attribution: { taskId: '7e1c9a42-5b36-4c0d-8f2a-9d4b6e8a0c1f', sessionId: null, requestId: 9 },
      direction: 'client>agent',
      wire: { jsonrpc: '2.0', id: 9, method: 'session/new', params: { cwd: '/srv/checkout/acp-p1-synthetic', mcpServers: [] } },
    });
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('false-history-success', () => {
    const mutated = clone(transcripts);
    const variant = variantOf(mutated, 'lost-prompt-completion');
    variant.decisions.snapshots.push(succeededSnapshot(requestSha, resultSha, 2));
    variant.decisions.result = forgedResult(requestSha);
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('permission.widening', () => {
    const mutated = clone(transcripts);
    const message = variantOf(mutated, 'denied-permission').messages
      .find(entry => entry.wire?.id === 5 && entry.wire?.result?.outcome);
    message.wire.result.outcome.optionId = 'allow-once';
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('revoked.success', () => {
    const mutated = clone(transcripts);
    const variant = variantOf(mutated, 'revocation-late-output');
    variant.decisions.snapshots.push(succeededSnapshot(requestSha, resultSha, 2));
    variant.decisions.result = forgedResult(requestSha);
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('unsupported.version-masked', () => {
    const mutated = clone(transcripts);
    const message = variantOf(mutated, 'unsupported-version-capability', 'unsupported-protocol-version').messages
      .find(entry => entry.wire?.id === 0 && entry.wire?.result);
    message.wire.result.protocolVersion = 1;
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('unsupported.capability-call', () => {
    const mutated = clone(transcripts);
    const variant = variantOf(mutated, 'unsupported-version-capability', 'unsupported-capability');
    variant.messages.find(entry => entry.wire?.id === 0 && entry.wire?.result).wire.result.agentCapabilities.loadSession = true;
    variant.messages.push({
      attribution: { taskId: '7e1c9a42-5b36-4c0d-8f2a-9d4b6e8a0c1f', sessionId: 'acp-syn-session-11', requestId: 3 },
      direction: 'client>agent',
      wire: { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: 'acp-syn-session-11', cwd: '/srv/checkout/acp-p1-synthetic', mcpServers: [] } },
    });
    variant.nativeCounts['session/load'] = 1;
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });
  add('terminal.mutation-same-sequence', () => {
    const mutated = clone(transcripts);
    const snapshots = variantOf(mutated, 'success').decisions.snapshots;
    snapshots[1].sequence = snapshots[0].sequence;
    return assert.rejects(checkTranscripts(mutated, sources, enums));
  });

  for (const [name, change] of [
    ['reservation.digest', t => variantOf(t, 'success').journal[0].requestSha256 = '0'.repeat(64)],
    ['reservation.connection', t => variantOf(t, 'success').journal[0].connectionId = 'another-connection'],
    ['artifact.byte-content', t => variantOf(t, 'success').decisions.artifactBytes['acp-p1-diff-1'] += 'x'],
    ['artifact.byte-count', t => variantOf(t, 'success').decisions.result.artifacts[0].bytes += 1],
    ['completion.end-turn-only', t => variantOf(t, 'success').decisions.completionEligibility = 'end_turn-only'],
    ['completion.missing-retention', t => variantOf(t, 'success').journal.find(j => j.kind === 'completion-retained').kind = 'completion-lost'],
    ['cancel.race-agent-order', t => variantOf(t, 'cancellation-completion-race', 'completion-wins').decisions.raceOrdering.agentCommittedBeforeReceivingCancel = false],
    ['error.version-certainty', t => variantOf(t, 'unsupported-version-capability', 'unsupported-protocol-version').decisions.errors[0].dispatch = 'not_dispatched'],
    ['error.capability-certainty', t => variantOf(t, 'unsupported-version-capability', 'unsupported-capability').decisions.errors[0].dispatch = 'not_dispatched'],
    ['native.unreviewed-update', t => variantOf(t, 'success').messages.find(m => m.wire?.method === 'session/update').wire.params.update.sessionUpdate = 'notice'],
    ['attribution.update-initialize', t => variantOf(t, 'success').messages.find(m => m.wire?.method === 'session/update').attribution.requestId = 0],
    ['attribution.frozen-result-initialize', t => variantOf(t, 'success').journal.find(j => j.kind === 'result-frozen').requestId = 0],
    ['cancel.missing-completion-retention', t => variantOf(t, 'cancellation-completion-race', 'abort-confirmed').journal.find(j => j.kind === 'completion-retained').kind = 'completion-lost'],
    ['cancel.completion-wrong-request', t => variantOf(t, 'cancellation-completion-race', 'abort-confirmed').journal.find(j => j.kind === 'completion-retained').requestId = 0],
  ]) add(name, () => { const changed = clone(transcripts); change(changed); return assert.rejects(checkTranscripts(changed, sources, enums)); });

  let rejected = 0;
  for (const mutation of mutations) {
    const result = mutation.run();
    if (result && typeof result.then === 'function') await result;
    rejected += 1;
  }
  return rejected;
}

async function main() {
  const outputs = ['sources.json', 'transcripts.json', 'README.md', 'validate.mjs']
    .map(name => path.join(here, name))
    .concat([path.join(root, 'docs', 'agents', 'platforms', 'ACP_EXECUTION_MAPPING.md')]);
  for (const output of outputs) assert.ok(fs.existsSync(output), 'missing output ' + output);

  // Git can check text out with CRLF on Windows. Pin the original UTF-8 LF
  // snapshot after this one text normalization; embedded upstream hashes and
  // the mechanically copied schema subset still bind their exact bytes.
  const sourcesBytes = Buffer.from(fs.readFileSync(path.join(here, 'sources.json'), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  assert.equal(sha256(sourcesBytes), ANCHORS.sourcesFileSha256, 'sources.json matches the pinned UTF-8 LF snapshot');
  const sources = JSON.parse(sourcesBytes.toString('utf8'));
  const { stopReasons } = checkSources(sources);

  const transcripts = JSON.parse(fs.readFileSync(path.join(here, 'transcripts.json'), 'utf8'));
  const totals = await checkTranscripts(transcripts, sources, { stopReasons });
  const mutations = await runMutations(sources, transcripts, { stopReasons });

  console.log(JSON.stringify({
    files: outputs.length, scenarios: transcripts.scenarios.length,
    variants: transcripts.scenarios.reduce((sum, scenario) => sum + scenario.variants.length, 0),
    nativeMessages: totals.wireMessages, journalEntries: totals.journalEntries,
    snapshots: totals.snapshots, mutations, failures: 0,
  }));
  return 0;
}

process.exitCode = await main();
