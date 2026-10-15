import assert from 'node:assert/strict';
import {
  AgentExecutionError, assertExecutionTransition, executionDigest, executionFailureSchema, executionTaskRef,
  type AgentExecutionAccess, type AgentExecutionAdapterV1, type ExecutionContext,
  type ExecutionDeclaration, type ExecutionGrant, type ExecutionOperation,
  type ExecutionResult, type ExecutionSnapshot, type ExecutionTask, type ExecutionTaskRef,
} from '../../src/agent-execution.js';
import { AgentExecutionClient } from '../../src/agent-execution-client.js';
import { SyntheticExecutionAdapter, SyntheticExecutionJournal, syntheticExecutionTask } from './agent-execution.js';

// ADAPTER-KIT offline driver (docs/agents/EXECUTION_CONTRACT.md §8 and §9). It wraps
// any execution/1 adapter in a scriptable failure harness and replays the accepted
// lifecycle and failure scenarios through a controlled access fixture and clock, so
// a second adapter can be checked without credentials, network, provider SDKs,
// model calls or child processes. The in-memory journal proves contract behavior
// only, never process-crash durability.

export type KitLifecycleState = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type KitGenerationField = 'approval_generation' | 'selection_generation' | 'session_generation' | 'credential_generation';

// Adapter under test plus a lifecycle test controller, mirroring the synthetic
// fixture's advance() controller that deliberately stays outside the adapter interface.
export interface KitFixtureAdapter {
  adapter: AgentExecutionAdapterV1;
  advance(ref: ExecutionTaskRef, state: KitLifecycleState): Promise<void>;
}
export interface KitSubject<J = unknown> {
  name: string;
  task: ExecutionTask;
  shared(): J;
  create(shared: J): KitFixtureAdapter;
  starts?(shared: J): number | undefined;
}
export const syntheticKitSubject: KitSubject<SyntheticExecutionJournal> = {
  name: 'synthetic-agent',
  task: structuredClone(syntheticExecutionTask),
  shared: () => new SyntheticExecutionJournal(),
  create: shared => {
    const adapter = new SyntheticExecutionAdapter(shared);
    return { adapter, advance: (ref, state) => adapter.advance(ref, state) };
  },
  starts: shared => shared.starts,
};

// Failure injection around a real adapter. Each scripted mode consumes one queued
// entry per call; once the queue is empty the wrapper falls through unchanged.
export type KitFailureMode =
  | { kind: 'native-error' }                 // raw private exception escapes the adapter
  | { kind: 'lose-response' }                // real call runs, then the response is lost
  | { kind: 'hang'; afterDispatch?: () => void } // dispatched call never settles
  | { kind: 'mutate-context' }               // tamper with the dispatch grant clone
  | { kind: 'after-response'; effect: () => void } // real call runs, then a side effect
  | { kind: 'return'; value: unknown };      // crafted reply replaces the real one

export class ScriptedKitAdapter implements AgentExecutionAdapterV1 {
  readonly calls: ExecutionOperation[] = [];
  private readonly queue = new Map<ExecutionOperation, KitFailureMode[]>();
  private declarationOverride?: ExecutionDeclaration;
  constructor(private readonly inner: AgentExecutionAdapterV1) {}
  script(operation: ExecutionOperation, ...modes: KitFailureMode[]): this {
    this.queue.set(operation, [...(this.queue.get(operation) ?? []), ...modes]);
    return this;
  }
  overrideDeclaration(declaration: ExecutionDeclaration): void { this.declarationOverride = declaration; }
  describe(): ExecutionDeclaration { return structuredClone(this.declarationOverride ?? this.inner.describe()); }
  private async dispatch<T>(operation: ExecutionOperation, context: ExecutionContext,
    run: (context: ExecutionContext) => Promise<T>): Promise<T> {
    this.calls.push(operation);
    const [mode, ...rest] = this.queue.get(operation) ?? [];
    if (rest.length) this.queue.set(operation, rest); else this.queue.delete(operation);
    switch (mode?.kind) {
      case undefined: return run(context);
      case 'native-error': throw new Error('private provider failure');
      case 'lose-response': await run(context); throw new Error('private provider failure');
      case 'hang': mode.afterDispatch?.(); return new Promise<T>(() => {});
      case 'mutate-context': context.grant.session_generation++; return run(context);
      case 'after-response': { const value = await run(context); mode.effect(); return value; }
      case 'return': return mode.value as T;
    }
  }
  submit(task: ExecutionTask, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return this.dispatch('submit', context, ctx => this.inner.submit(task, ctx));
  }
  status(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return this.dispatch('status', context, ctx => this.inner.status(ref, ctx));
  }
  result(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionResult> {
    return this.dispatch('result', context, ctx => this.inner.result(ref, ctx));
  }
  cancel(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return this.dispatch('cancel', context, ctx => this.inner.cancel(ref, ctx));
  }
}

// Host-side access stand-in: sealed grant facts with controllable revoke/generation
// flips. current() returning undefined models a refusing host port, never a grant.
export class KitAccessFixture implements AgentExecutionAccess {
  private grant?: ExecutionGrant;
  constructor(grant: ExecutionGrant) { this.grant = structuredClone(grant); }
  get(): ExecutionGrant | undefined { return this.grant ? structuredClone(this.grant) : undefined; }
  set(grant: ExecutionGrant | undefined): void { this.grant = grant ? structuredClone(grant) : undefined; }
  async current(): Promise<ExecutionGrant | undefined> { return this.get(); }
}

export interface KitHarness {
  readonly adapter: ScriptedKitAdapter;
  readonly task: ExecutionTask;
  readonly ref: ExecutionTaskRef;
  readonly client: AgentExecutionClient;
  grant(): ExecutionGrant | undefined;
  setGrant(grant: ExecutionGrant | undefined): void;
  revoke(): void;
  bump(field: KitGenerationField): void;
  retask(ref: ExecutionTaskRef): void;
  tick(ms: number): void;
  starts(): number | undefined;
  advance(state: KitLifecycleState): Promise<void>;
  reconstruct(): AgentExecutionClient;
  variantClient(mutate: (declaration: ExecutionDeclaration) => void): Promise<AgentExecutionClient>;
  fresh(): Promise<KitHarness>;
}

export async function kitHarness<J>(subject: KitSubject<J>): Promise<KitHarness> {
  const shared = subject.shared(), fixture = subject.create(shared), adapter = new ScriptedKitAdapter(fixture.adapter);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const task = structuredClone(subject.task), ref = await executionTaskRef(task);
  const access = new KitAccessFixture({
    format: 'strata-agent-execution-grant/1', task: ref,
    declaration_sha256: await executionDigest(adapter.describe()),
    service_id: `${subject.name}-service`, instance_id: `${subject.name}-instance`, subject: `${subject.name}-verified-subject`,
    consent: 'approved', enabled: true, approval_generation: 1, selection_generation: 1,
    session_generation: 1, credential_generation: 1, valid_until: '2026-01-01T00:01:00Z',
  });
  return {
    adapter, task, ref, client: new AgentExecutionClient(adapter, access, () => now),
    grant: () => access.get(),
    setGrant: grant => access.set(grant),
    revoke: () => access.set(undefined),
    bump: field => {
      const grant = access.get();
      if (!grant) throw new Error('Kit grant is revoked');
      const next: ExecutionGrant = { ...grant };
      next[field] = grant[field] + 1;
      access.set(next);
    },
    retask: nextRef => {
      const grant = access.get();
      if (!grant) throw new Error('Kit grant is revoked');
      access.set({ ...grant, task: nextRef });
    },
    tick: ms => { now += ms; },
    starts: () => subject.starts?.(shared),
    advance: state => fixture.advance(ref, state),
    reconstruct: () => new AgentExecutionClient(subject.create(shared).adapter, access, () => now),
    variantClient: async mutate => {
      const declaration = adapter.describe();
      mutate(declaration);
      adapter.overrideDeclaration(declaration);
      const grant = access.get();
      if (!grant) throw new Error('Kit grant is revoked');
      access.set({ ...grant, declaration_sha256: await executionDigest(declaration) });
      return new AgentExecutionClient(adapter, access, () => now);
    },
    fresh: () => kitHarness(subject),
  };
}

export function kitRejects(code: string, dispatch?: 'not_dispatched' | 'unknown'): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AgentExecutionError);
    assert.equal(error.code, code);
    if (dispatch) assert.equal(error.dispatch, dispatch);
    assert.equal(error.message, 'Agent execution could not complete the requested operation.');
    return true;
  };
}

// Submit may return any current snapshot, including a synchronously completed
// terminal one (§5); terminal snapshots never change once reached.
const terminalStates: readonly ExecutionSnapshot['state'][] = ['succeeded', 'failed', 'cancelled'];
const isTerminal = (snapshot: ExecutionSnapshot): boolean => terminalStates.includes(snapshot.state);

export interface KitScenario {
  name: string;
  contract: string;
  run: (harness: KitHarness) => Promise<void>;
}
export const kitScenarios: readonly KitScenario[] = [
  {
    name: 'lifecycle-status-result-digest', contract: '§5', run: async h => {
      // Submit returns the current snapshot: queued, running or a synchronously
      // completed terminal state are all contract-legal (§5), so intermediate
      // states are driven only while the task has not reached them yet.
      let current = await h.client.submit(h.task);
      if (current.state === 'queued') { await h.advance('running'); current = await h.client.status(h.ref, current); }
      if (current.state !== 'succeeded') { await h.advance('succeeded'); current = await h.client.status(h.ref, current); }
      assert.equal(current.state, 'succeeded');
      const result = await h.client.result(h.task, current);
      assert.equal(result.trust, 'agent-output');
      assert.equal(h.adapter.calls[0], 'submit');
      assert.equal(h.adapter.calls.at(-1), 'result');
      assert.equal(h.starts(), 1);
    },
  },
  {
    name: 'idempotent-resubmit-and-payload-conflict', contract: '§4', run: async h => {
      const first = await h.client.submit(h.task), second = await h.client.submit(h.task);
      // Same ID and complete request are one task; the second submit returns the
      // current snapshot, which may have advanced legally since the first (§4, §5).
      assertExecutionTransition(first, second); assert.equal(h.starts(), 1);
      const changed = { ...h.task, instruction: 'Different instruction' };
      // Host approves the changed digest so the adapter's duplicate boundary is tested.
      h.retask(await executionTaskRef(changed));
      await assert.rejects(h.client.submit(changed), kitRejects('EXECUTION_CONFLICT', 'unknown'));
      assert.equal(h.starts(), 1);
    },
  },
  {
    name: 'adapter-reconstruction-preserves-identity', contract: '§4', run: async h => {
      const admitted = await h.client.submit(h.task);
      const client = h.reconstruct();
      const observed = await client.status(h.ref); // initial authorized lookup
      assertExecutionTransition(admitted, observed);
      const resubmitted = await client.submit(h.task);
      assertExecutionTransition(observed, resubmitted);
      assert.equal(h.starts(), 1);
    },
  },
  {
    name: 'lost-submit-response-recovers-by-status', contract: '§4 §6', run: async h => {
      h.adapter.script('submit', { kind: 'lose-response' });
      await assert.rejects(h.client.submit(h.task), kitRejects('EXECUTION_UNAVAILABLE', 'unknown'));
      // Recovery is an explicit status lookup on the original identity; the state
      // is whatever the runtime legally reached, not necessarily queued (§4).
      await h.client.status(h.ref);
      assert.equal(h.starts(), 1);
      assert.deepEqual(h.adapter.calls, ['submit', 'status']);
    },
  },
  {
    name: 'pre-dispatch-refusals', contract: '§2 §3', run: async h => {
      for (const bad of [
        { ...h.task, token: 'private' }, { ...h.task, url: 'https://unapproved.example.test' },
        { ...h.task, repository_revision: 'main' }, { ...h.task, format: 'strata-agent-task/2' },
      ]) await assert.rejects(h.client.submit(bad as typeof h.task), kitRejects('EXECUTION_INVALID', 'not_dispatched'));
      const overRuntime = h.adapter.describe().limits.task_runtime_ms + 1;
      // The task schema has a separate one-hour cap. A schema-invalid request
      // fails INVALID; a valid task exceeding a lower adapter limit fails LIMIT.
      const runtimeRefusal = overRuntime > 3600000 ? 'EXECUTION_INVALID' : 'EXECUTION_LIMIT';
      await assert.rejects(h.client.submit({ ...h.task, limits: { ...h.task.limits, runtime_ms: overRuntime } }), kitRejects(runtimeRefusal, 'not_dispatched'));
      await assert.rejects(h.client.submit({ ...h.task, instruction: '🌐'.repeat(8192) }), kitRejects('EXECUTION_LIMIT', 'not_dispatched'));
      await assert.rejects(h.client.submit({ ...h.task, binding: { ...h.task.binding, model_version: 'strata/unknown' } }), kitRejects('EXECUTION_VERSION', 'not_dispatched'));
      await assert.rejects(new AgentExecutionClient().submit(h.task), kitRejects('EXECUTION_UNCONFIGURED', 'not_dispatched'));
      // A declaration variant re-digests the grant, so it runs on a fresh harness.
      const unsup = await h.fresh();
      const unsupported = await unsup.variantClient(declaration => { declaration.capabilities.cancel = 'unsupported'; });
      await assert.rejects(unsupported.cancel(unsup.ref), kitRejects('EXECUTION_UNSUPPORTED', 'not_dispatched'));
      assert.equal(unsup.adapter.calls.length, 0);
      h.tick(60000);
      await assert.rejects(h.client.submit(h.task), kitRejects('EXECUTION_EXPIRED', 'not_dispatched'));
      h.retask({ ...h.ref, repository_revision: 'b'.repeat(40) });
      await assert.rejects(h.client.submit(h.task), kitRejects('EXECUTION_BINDING', 'not_dispatched'));
      h.revoke();
      await assert.rejects(h.client.submit(h.task), kitRejects('EXECUTION_AUTH', 'not_dispatched'));
      assert.equal(h.adapter.calls.length, 0);
    },
  },
  {
    name: 'authority-generation-flips-reject-late-success', contract: '§3', run: async h => {
      for (const field of [undefined, 'approval_generation', 'selection_generation', 'session_generation', 'credential_generation'] as const) {
        const f = await h.fresh();
        f.adapter.script('submit', { kind: 'after-response', effect: () => (field ? f.bump(field) : f.revoke()) });
        await assert.rejects(f.client.submit(f.task), kitRejects(field ? 'EXECUTION_STALE' : 'EXECUTION_AUTH', 'unknown'));
        assert.equal(f.starts(), 1); // Refusal does not claim rollback of admitted work.
      }
    },
  },
  {
    name: 'abort-discipline', contract: '§5', run: async h => {
      const pre = new AbortController(); pre.abort();
      await assert.rejects(h.client.submit(h.task, pre.signal), kitRejects('EXECUTION_ABORTED', 'not_dispatched'));
      assert.equal(h.adapter.calls.length, 0);
      const during = new AbortController();
      h.adapter.script('submit', { kind: 'hang', afterDispatch: () => during.abort() });
      await assert.rejects(h.client.submit(h.task, during.signal), kitRejects('EXECUTION_ABORTED', 'unknown'));
    },
  },
  {
    name: 'call-deadline', contract: '§5', run: async h => {
      const variant = await h.variantClient(declaration => { declaration.limits.call_timeout_ms = 20; });
      // Keep Node alive while AbortSignal.timeout uses an unref timer.
      const heartbeat = setInterval(() => {}, 100);
      try {
        const hung: AgentExecutionAccess = { current: async () => new Promise<ExecutionGrant | undefined>(() => {}) };
        await assert.rejects(new AgentExecutionClient(h.adapter, hung).submit(h.task), kitRejects('EXECUTION_TIMEOUT', 'not_dispatched'));
        h.adapter.script('submit', { kind: 'hang' });
        await assert.rejects(variant.submit(h.task), kitRejects('EXECUTION_TIMEOUT', 'unknown'));
      } finally { clearInterval(heartbeat); }
    },
  },
  {
    name: 'cooperative-cancellation-race', contract: '§5', run: async h => {
      if (h.adapter.describe().capabilities.cancel === 'unsupported') {
        await assert.rejects(h.client.cancel(h.ref), kitRejects('EXECUTION_UNSUPPORTED', 'not_dispatched'));
        assert.equal(h.adapter.calls.length, 0);
        assert.equal(h.starts(), 0);
        return;
      }
      const submitted = await h.client.submit(h.task);
      const cancelling = await h.client.cancel(h.ref, submitted);
      // Cancel returns cancel_requested, or an already terminal snapshot when the
      // task finished before the request landed (§5).
      if (cancelling.state === 'cancel_requested') {
        await h.advance('cancelled'); const cancelled = await h.client.status(h.ref, cancelling);
        assert.equal(cancelled.state, 'cancelled');
        assert.equal((await h.client.cancel(h.ref, cancelled)).state, 'cancelled');
        await assert.rejects(h.client.result(h.task, cancelled), kitRejects('EXECUTION_RESULT_UNAVAILABLE', 'not_dispatched'));
      } else assert.ok(isTerminal(cancelling));
      const race = await h.fresh(), raceSubmitted = await race.client.submit(race.task);
      if (raceSubmitted.state !== 'succeeded') await race.advance('succeeded');
      const raced = await race.client.cancel(race.ref, raceSubmitted);
      assert.ok(isTerminal(raced)); // a completion race may finish; cancel cannot restart it
      const unsup = await h.fresh();
      const unsupported = await unsup.variantClient(declaration => { declaration.capabilities.cancel = 'unsupported'; });
      await assert.rejects(unsupported.cancel(unsup.ref), kitRejects('EXECUTION_UNSUPPORTED', 'not_dispatched'));
      assert.equal(unsup.adapter.calls.length, 0);
    },
  },
  {
    name: 'transition-and-binding-discipline', contract: '§5', run: async h => {
      const submitted = await h.client.submit(h.task);
      let observed = submitted;
      if (observed.state === 'queued') { await h.advance('running'); observed = await h.client.status(h.ref, observed); }
      // The shared transition guard refuses reversed observations, same-sequence
      // mutations and terminal changes for any valid snapshot pair (§5).
      const running = { format: 'strata-agent-task-status/1' as const, task: h.ref, sequence: 7, state: 'running' as const };
      assert.throws(() => assertExecutionTransition(running, { ...running, sequence: 6, state: 'queued' as const }), kitRejects('EXECUTION_PROTOCOL'));
      assert.throws(() => assertExecutionTransition(running, { ...running, state: 'succeeded' as const, result_sha256: 'a'.repeat(64) }), kitRejects('EXECUTION_PROTOCOL'));
      const failedBase = { format: 'strata-agent-task-status/1' as const, task: h.ref, sequence: 7, state: 'failed' as const, failure: 'TASK_FAILED' as const };
      const resurrected = { format: 'strata-agent-task-status/1' as const, task: h.ref, sequence: 99, state: 'succeeded' as const, result_sha256: 'a'.repeat(64) };
      assert.throws(() => assertExecutionTransition(failedBase, resurrected), kitRejects('EXECUTION_PROTOCOL'));
      if (!isTerminal(observed)) {
        await h.advance('failed'); const failed = await h.client.status(h.ref, observed);
        assert.equal(failed.state, 'failed');
        assert.ok(executionFailureSchema.options.includes(failed.failure)); // any finite failure code (§5)
      }
      h.adapter.script('status', { kind: 'return', value: { ...observed, task: { ...h.ref, task_id: '00000000-0000-4000-8000-000000000009' } } });
      await assert.rejects(h.client.status(h.ref, observed), kitRejects('EXECUTION_BINDING', 'unknown'));
      const unknown = await h.fresh();
      await assert.rejects(unknown.client.status(unknown.ref), kitRejects('EXECUTION_NOT_FOUND', 'unknown'));
    },
  },
  {
    name: 'fail-closed-results', contract: '§5 §6', run: async h => {
      const submitted = await h.client.submit(h.task);
      if (submitted.state !== 'succeeded') await h.advance('succeeded');
      const done = await h.client.status(h.ref), original = await h.client.result(h.task, done);
      h.adapter.script('result', { kind: 'return', value: { ...original, summary: 'substituted' } });
      await assert.rejects(h.client.result(h.task, done), kitRejects('EXECUTION_BINDING', 'unknown'));
      h.adapter.script('result', { kind: 'return', value: { ...original, trust: 'host-measured' } });
      await assert.rejects(h.client.result(h.task, done), kitRejects('EXECUTION_PROTOCOL', 'unknown'));
      h.adapter.script('result', { kind: 'return', value: { ...original, summary: '🌐'.repeat(8192) } });
      await assert.rejects(h.client.result(h.task, done), kitRejects('EXECUTION_LIMIT', 'unknown'));
      h.adapter.script('status', { kind: 'return', value: { ...done, raw_error: 'private provider error' } });
      await assert.rejects(h.client.status(h.ref), kitRejects('EXECUTION_PROTOCOL', 'unknown'));
    },
  },
  {
    name: 'grant-tamper-isolation', contract: '§3', run: async h => {
      h.adapter.script('submit', { kind: 'mutate-context' });
      await h.client.submit(h.task); // any current snapshot; grant isolation is the checked fact
      assert.equal(h.grant()!.session_generation, 1);
    },
  },
];
