// ADAPTER-KIT compile-time execution starter (docs/agents/EXECUTION_CONTRACT.md §8).
// This template shows where a strata-agent-execution/1 adapter plugs in; it is
// deliberately NOT a working adapter. No native agent runtime, durable journal or
// host execution-consent store is wired, so every operation refuses instead of
// pretending readiness, and the host access port never fabricates a grant. The
// authoritative rules live in docs/agents/EXECUTION_CONTRACT.md; see
// docs/agents/EXECUTION_AUTHORING.md for how to author against them.

import { pathToFileURL } from 'node:url';
import {
  AgentExecutionError, executionDeclarationSchema, executionTaskRef,
  type AgentExecutionAccess, type AgentExecutionAdapterV1, type ExecutionContext,
  type ExecutionDeclaration, type ExecutionGrant, type ExecutionResult,
  type ExecutionSnapshot, type ExecutionTask, type ExecutionTaskRef,
} from '../../src/agent-execution.js';
import { AgentExecutionClient } from '../../src/agent-execution-client.js';
import { syntheticExecutionTask } from '../../tests/fixtures/agent-execution.js';

export const STARTER_ADAPTER_ID = 'execution-starter-template';
// A declaration is a claim to qualify, not proof: declaring runtime.kind
// 'agent-runtime' earns no compatibility status (contract §1). Replace every
// field with what the real runtime actually enforces before any review.
export const starterExecutionDeclaration: ExecutionDeclaration = executionDeclarationSchema.parse({
  format: 'strata-agent-execution-adapter/1', protocol: 'strata-agent-execution/1',
  id: STARTER_ADAPTER_ID, version: '0',
  runtime: { name: 'unwired-agent-runtime', version: '0', kind: 'agent-runtime' },
  models: ['strata/0.3-block-lifecycle-experimental'], // Replace with actually supported Strata models.
  capabilities: { submit: true, status: true, result: true, cancel: 'cooperative',
    idempotency: 'durable-task-id', recovery: 'lookup-task-id' },
  limits: { call_timeout_ms: 1000, task_runtime_ms: 60000, output_bytes: 32768 },
  authority: 'task-only',
});

export class StarterExecutionAdapter implements AgentExecutionAdapterV1 {
  describe(): ExecutionDeclaration { return structuredClone(starterExecutionDeclaration); }

  // Every operation refuses: the native runtime port is deliberately missing.
  // When wiring a real runtime, replace each body while keeping the obligations:
  // - submit: durably reserve (connection_id, task_id) and the native handle
  //   mapping BEFORE any native start, and never resubmit, replace the UUID or
  //   fall back after an ambiguous response (contract §4).
  // - status/result: one bounded observation by the original task identity;
  //   terminal results are immutable and digest-bound (§5).
  // - cancel: cooperative only; unsupported cancellation must refuse before
  //   dispatch, never silently fall back to process killing or deleting a
  //   vendor resource (§2).
  // The runtime enforces task runtime/output limits natively, separately from
  // the ten-second control call (§5); DTO checks after parsing cannot bound a
  // provider stream, heap or bill.
  async submit(_task: ExecutionTask, _context: ExecutionContext): Promise<ExecutionSnapshot> {
    throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
  }
  async status(_ref: ExecutionTaskRef, _context: ExecutionContext): Promise<ExecutionSnapshot> {
    throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
  }
  async result(_ref: ExecutionTaskRef, _context: ExecutionContext): Promise<ExecutionResult> {
    throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
  }
  async cancel(_ref: ExecutionTaskRef, _context: ExecutionContext): Promise<ExecutionSnapshot> {
    throw new AgentExecutionError('EXECUTION_UNCONFIGURED');
  }
}

// Registration is by compile-time import only (contract §2): a plain record, no
// plugin loader, dynamic import, vendor registry or automatic provider selection.
const executionAdapterRegistry: Readonly<Record<string, AgentExecutionAdapterV1>> = {
  [STARTER_ADAPTER_ID]: new StarterExecutionAdapter(),
};
export function registeredExecutionAdapterIds(): string[] { return Object.keys(executionAdapterRegistry); }
export function executionAdapterById(id: string): AgentExecutionAdapterV1 | undefined { return Object.hasOwn(executionAdapterRegistry, id) ? executionAdapterRegistry[id] : undefined; }

// The host port of contract §3 is explicitly missing. A real implementation checks
// the operation's durable admission, current owner, saved execution consent, exact
// selected source and repository revision, target identity, and the current
// session and credential generations before returning a finite grant; anything
// else refuses. Returning undefined keeps every operation pre-dispatch refused.
export const unconfiguredExecutionAccess: AgentExecutionAccess = {
  async current(): Promise<ExecutionGrant | undefined> { return undefined; },
};

// Offline refusal demonstration: with missing host ports the guarded client must
// refuse every operation before dispatch. No fake readiness is produced.
async function refusalDemonstration(): Promise<{ adapter: string; registered: string[]; hostPort: string; refusals: Record<string, string> }> {
  const adapter = executionAdapterById(STARTER_ADAPTER_ID);
  if (!adapter) throw new Error('Starter adapter is not registered.');
  const client = new AgentExecutionClient(adapter, unconfiguredExecutionAccess);
  const clientWithoutHostPort = new AgentExecutionClient(adapter);
  const task = structuredClone(syntheticExecutionTask), ref = await executionTaskRef(task);
  const refusals: Record<string, string> = {};
  const attempt = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
    try { await operation(); refusals[name] = 'unexpected-success'; }
    catch (error) { refusals[name] = error instanceof AgentExecutionError ? error.code : 'unexpected-error'; }
  };
  await attempt('submit', () => client.submit(task));
  await attempt('status', () => client.status(ref));
  await attempt('cancel', () => client.cancel(ref));
  await attempt('submit-without-host-port', () => clientWithoutHostPort.submit(task));
  return { adapter: STARTER_ADAPTER_ID, registered: registeredExecutionAdapterIds(), hostPort: 'unconfigured', refusals };
}
const expectedRefusals: Record<string, string> = {
  submit: 'EXECUTION_AUTH', status: 'EXECUTION_AUTH', cancel: 'EXECUTION_AUTH',
  'submit-without-host-port': 'EXECUTION_UNCONFIGURED',
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demonstration = await refusalDemonstration();
  console.log(JSON.stringify(demonstration));
  process.exitCode = JSON.stringify(demonstration.refusals) === JSON.stringify(expectedRefusals) ? 0 : 1;
}
