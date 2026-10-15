// ADAPTER-KIT starter tests (docs/agents/EXECUTION_CONTRACT.md §8): they pin the
// offline conformance runner, the scriptable failure driver and the compile-time
// starter template. Synthetic and offline only; discovery stays untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentExecutionError, executionDeclarationSchema, executionDigest, executionTaskRef,
  type AgentExecutionAdapterV1, type ExecutionContext, type ExecutionGrant, type ExecutionSnapshot, type ExecutionTask,
  type ExecutionTaskRef, type ExecutionResult,
} from '../src/agent-execution.js';
import { AgentExecutionClient } from '../src/agent-execution-client.js';
import { SyntheticExecutionAdapter, SyntheticExecutionJournal, syntheticExecutionTask } from './fixtures/agent-execution.js';
import { kitHarness, kitScenarios, syntheticKitSubject, type KitSubject } from './fixtures/agent-execution-kit.js';
import { checkAgentExecutionKit } from '../scripts/agent-execution-conformance.js';
import {
  executionAdapterById, registeredExecutionAdapterIds, STARTER_ADAPTER_ID, unconfiguredExecutionAccess, StarterExecutionAdapter,
} from '../examples/agents/execution-starter.js';

const rejects = (code: string, dispatch?: string) => (error: unknown) => {
  assert.ok(error instanceof AgentExecutionError); assert.equal(error.code, code);
  if (dispatch) assert.equal(error.dispatch, dispatch);
  assert.equal(error.message, 'Agent execution could not complete the requested operation.');
  return true;
};

// Second adapter reuse: a deliberately non-conforming adapter that ignores the
// retained admission and always restarts the native task (contract §4 defect).
class DuplicateStartAdapter implements AgentExecutionAdapterV1 {
  constructor(private readonly inner: SyntheticExecutionAdapter) {}
  describe() { return this.inner.describe(); }
  async submit(task: ExecutionTask, context: ExecutionContext): Promise<ExecutionSnapshot> {
    const ref = await executionTaskRef(task);
    this.inner.journal.records.delete(ref.connection_id + '/' + ref.task_id);
    return this.inner.submit(task, context);
  }
  async status(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> { return this.inner.status(ref, context); }
  async result(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionResult> { return this.inner.result(ref, context); }
  async cancel(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> { return this.inner.cancel(ref, context); }
}
const duplicateStartSubject: KitSubject<SyntheticExecutionJournal> = {
  name: 'duplicate-start-agent',
  task: structuredClone(syntheticExecutionTask),
  shared: () => new SyntheticExecutionJournal(),
  create: shared => {
    const nativeFixture = new SyntheticExecutionAdapter(shared);
    return { adapter: new DuplicateStartAdapter(nativeFixture), advance: (ref, state) => nativeFixture.advance(ref, state) };
  },
  starts: shared => shared.starts,
};

// Positive profile regressions: submit may return any current snapshot — work
// that starts immediately, or completes synchronously, is contract-legal (§5).
// Both conforming profiles must pass the same conformance as the queued shape.
function conformingProfileSubject(profile: 'immediate-running' | 'synchronous-completion' | 'unsupported-cancel' | 'runtime-120000' | 'runtime-3600000'): KitSubject<SyntheticExecutionJournal> {
  return {
    name: `${profile}-agent`, task: structuredClone(syntheticExecutionTask),
    shared: () => new SyntheticExecutionJournal(), starts: journal => journal.starts,
    create: journal => {
      const native = new SyntheticExecutionAdapter(journal);
      return {
        adapter: {
          describe: () => {
            const declaration = native.describe();
            if (profile === 'unsupported-cancel') declaration.capabilities.cancel = 'unsupported';
            if (profile === 'runtime-120000') declaration.limits.task_runtime_ms = 120000;
            if (profile === 'runtime-3600000') declaration.limits.task_runtime_ms = 3600000;
            return declaration;
          },
          submit: async (task: ExecutionTask, context: ExecutionContext) => {
            const ref = await executionTaskRef(task), admitted = await native.submit(task, context);
            if (admitted.state === 'queued' && (profile === 'immediate-running' || profile === 'synchronous-completion')) {
              await native.advance(ref, profile === 'synchronous-completion' ? 'succeeded' : 'running');
            }
            return native.status(ref, context);
          },
          status: (ref: ExecutionTaskRef, context: ExecutionContext) => native.status(ref, context),
          result: (ref: ExecutionTaskRef, context: ExecutionContext) => native.result(ref, context),
          cancel: (ref: ExecutionTaskRef, context: ExecutionContext) => {
            assert.notEqual(profile, 'unsupported-cancel', 'unsupported cancel must never reach the native fixture');
            return native.cancel(ref, context);
          },
        },
        advance: async (ref, state) => {
          const record = journal.records.get(ref.connection_id + '/' + ref.task_id);
          if (record && ['succeeded', 'failed', 'cancelled'].includes(record.snapshot.state)) {
            throw new AgentExecutionError('EXECUTION_PROTOCOL');
          }
          await native.advance(ref, state);
        },
      };
    },
  };
}

test('kit conformance passes every offline scenario for the synthetic subject', async () => {
  const receipt = await checkAgentExecutionKit(syntheticKitSubject);
  assert.equal(receipt.subject, 'synthetic-agent');
  assert.deepEqual(receipt.checks.map(check => check.name), kitScenarios.map(scenario => scenario.name));
  assert.deepEqual(receipt.checks.map(check => check.ok), kitScenarios.map(() => true));
  assert.equal(receipt.failures, 0);
});

test('kit conformance detects a non-conforming second adapter and keeps passing unrelated checks', async () => {
  const receipt = await checkAgentExecutionKit(duplicateStartSubject);
  const failed = receipt.checks.filter(check => !check.ok);
  assert.ok(failed.length >= 1);
  assert.ok(failed.every(check => typeof check.detail === 'string' && check.detail.length > 0));
  assert.ok(failed.some(check => check.name === 'idempotent-resubmit-and-payload-conflict'));
  assert.ok(failed.some(check => check.name === 'adapter-reconstruction-preserves-identity'));
  assert.ok(receipt.checks.some(check => check.ok));
});

test('kit conformance accepts immediate-running submission', async () => {
  const receipt = await checkAgentExecutionKit(conformingProfileSubject('immediate-running'));
  assert.equal(receipt.checks.length, kitScenarios.length);
  assert.deepEqual(receipt.checks.filter(check => !check.ok), []);
});

test('kit conformance accepts synchronous completion without rewinding terminal state', async () => {
  const subject = conformingProfileSubject('synchronous-completion');
  const receipt = await checkAgentExecutionKit(subject);
  assert.equal(receipt.checks.length, kitScenarios.length);
  assert.deepEqual(receipt.checks.filter(check => !check.ok), []);
  const harness = await kitHarness(subject);
  const completed = await harness.client.submit(harness.task);
  assert.equal(completed.state, 'succeeded');
  await assert.rejects(harness.advance('running'), rejects('EXECUTION_PROTOCOL'));
  assert.deepEqual(await harness.client.status(harness.ref, completed), completed);
});

test('kit conformance accepts declared unsupported cancellation', async () => {
  const receipt = await checkAgentExecutionKit(conformingProfileSubject('unsupported-cancel'));
  assert.equal(receipt.checks.length, kitScenarios.length);
  assert.deepEqual(receipt.checks.filter(check => !check.ok), []);
});

test('kit conformance derives runtime refusal from a 120-second declaration', async () => {
  const receipt = await checkAgentExecutionKit(conformingProfileSubject('runtime-120000'));
  assert.equal(receipt.checks.length, kitScenarios.length);
  assert.deepEqual(receipt.checks.filter(check => !check.ok), []);
});

test('kit runtime refusal respects the separate one-hour task schema boundary', async () => {
  const receipt = await checkAgentExecutionKit(conformingProfileSubject('runtime-3600000'));
  assert.equal(receipt.checks.length, kitScenarios.length);
  assert.deepEqual(receipt.checks.filter(check => !check.ok), []);
});

test('failure driver scripts exactly one call, then falls through to the real adapter', async () => {
  const h = await kitHarness(syntheticKitSubject);
  h.adapter.script('status', { kind: 'native-error' });
  await h.client.submit(h.task);
  await assert.rejects(h.client.status(h.ref), rejects('EXECUTION_UNAVAILABLE', 'unknown'));
  assert.equal((await h.client.status(h.ref)).state, 'queued');
  assert.deepEqual(h.adapter.calls, ['submit', 'status', 'status']);
});

test('starter template registers at compile time and refuses offline with explicit missing host ports', async () => {
  assert.deepEqual(registeredExecutionAdapterIds(), [STARTER_ADAPTER_ID]);
  const adapter = executionAdapterById(STARTER_ADAPTER_ID);
  assert.ok(adapter);
  assert.equal(executionDeclarationSchema.safeParse(adapter.describe()).success, true);
  const task = structuredClone(syntheticExecutionTask), ref = await executionTaskRef(task);
  assert.equal(await unconfiguredExecutionAccess.current(ref, 'submit', AbortSignal.timeout(1000)), undefined);
  const client = new AgentExecutionClient(adapter, unconfiguredExecutionAccess);
  await assert.rejects(client.submit(task), rejects('EXECUTION_AUTH', 'not_dispatched'));
  await assert.rejects(client.status(ref), rejects('EXECUTION_AUTH', 'not_dispatched'));
  await assert.rejects(client.cancel(ref), rejects('EXECUTION_AUTH', 'not_dispatched'));
  // Even a syntactically valid granted context cannot make the unwired template work.
  const grant: ExecutionGrant = {
    format: 'strata-agent-execution-grant/1', task: ref,
    declaration_sha256: await executionDigest(adapter.describe()),
    service_id: 'starter-service', instance_id: 'starter-instance', subject: 'starter-verified-subject',
    consent: 'approved', enabled: true, approval_generation: 1, selection_generation: 1,
    session_generation: 1, credential_generation: 1, valid_until: '2026-01-01T00:01:00Z',
  };
  await assert.rejects(adapter.submit(task, { grant, signal: AbortSignal.timeout(1000) }), rejects('EXECUTION_UNCONFIGURED', 'not_dispatched'));
});


test('conformance receipts never serialize arbitrary fixture exception text', async () => {
  const secret = 'private-fixture-detail-for-redaction-check';
  const receipt = await checkAgentExecutionKit({ ...syntheticKitSubject, create: () => { throw new Error(secret); } });
  assert.equal(receipt.failures, kitScenarios.length);
  assert.equal(JSON.stringify(receipt).includes(secret), false);
});

test('starter registry refuses prototype names as unknown adapter IDs', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) assert.equal(executionAdapterById(name), undefined);
});

// Correct second fixture: production adapter exposes only the execution port;
// its lifecycle controller remains separate test instrumentation.
class StarterBackedFixtureAdapter extends StarterExecutionAdapter {
  constructor(private readonly nativeFixture: SyntheticExecutionAdapter) { super(); }
  override submit(task: ExecutionTask, context: ExecutionContext) { return this.nativeFixture.submit(task, context); }
  override status(ref: ExecutionTaskRef, context: ExecutionContext) { return this.nativeFixture.status(ref, context); }
  override result(ref: ExecutionTaskRef, context: ExecutionContext) { return this.nativeFixture.result(ref, context); }
  override cancel(ref: ExecutionTaskRef, context: ExecutionContext) { return this.nativeFixture.cancel(ref, context); }
}
test('starter-backed adapter reuses conformance with lifecycle control outside the production port', async () => {
  const subject: KitSubject<SyntheticExecutionJournal> = {
    name: 'starter-backed-fixture', task: structuredClone(syntheticExecutionTask),
    shared: () => new SyntheticExecutionJournal(), starts: journal => journal.starts,
    create: journal => {
      const nativeFixture = new SyntheticExecutionAdapter(journal);
      const adapter = new StarterBackedFixtureAdapter(nativeFixture);
      assert.equal('advance' in adapter, false);
      return { adapter, advance: (ref, state) => nativeFixture.advance(ref, state) };
    },
  };
  const receipt = await checkAgentExecutionKit(subject);
  assert.equal(receipt.checks.length, kitScenarios.length);
  assert.equal(receipt.failures, 0);
});
