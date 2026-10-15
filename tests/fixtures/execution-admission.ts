import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executionTaskRef, type ExecutionTask, type ExecutionGrant, type ExecutionContext,
  type ExecutionSnapshot, type ExecutionTaskRef, type ExecutionResult, type AgentExecutionAdapterV1,
} from '../../src/agent-execution.js';
import { AgentExecutionClient } from '../../src/agent-execution-client.js';
import { ExecutionAdmissionCore, ExecutionAdmissionJournal, type ExecutionJournalOptions } from '../../src/agent-execution-admission.js';
import { ExecutionAccess, type TrustedExecutionMetadata, type TrustedExecutionState } from '../../src/agent-execution-access.js';
import { CloudflareExecutionAdapter } from '../../src/agent-adapters/cloudflare-execution.js';
import { cloudflareFixture, SyntheticCloudflareStorage } from './cloudflare-execution.js';
import { ScriptedKitAdapter } from './agent-execution-kit.js';

// Test authority only. Changes notify all callers synchronously, and never load
// a credential or accept authority from a task/response DTO.
export class SyntheticExecutionMetadata implements TrustedExecutionMetadata {
  private listeners = new Set<() => void>();
  constructor(private state: TrustedExecutionState | undefined) {}
  read() { return structuredClone(this.state); }
  set(state: TrustedExecutionState | undefined, notify = true) {
    this.state = structuredClone(state);
    if (notify) for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get waits() { return this.listeners.size; }
}
export function syntheticMetadata(task: ExecutionTask, grant: ExecutionGrant): TrustedExecutionState {
  return {
    owner: { id: 'synthetic-owner', authenticated: true }, enabled: true,
    consent: {
      kind: 'execution', owner_id: 'synthetic-owner', connection_id: task.connection_id,
      binding: task.binding, repository_revision: task.repository_revision,
      declaration_sha256: grant.declaration_sha256, service_id: grant.service_id, instance_id: grant.instance_id, subject: grant.subject,
      approval_generation: grant.approval_generation, operations: ['submit', 'status', 'result', 'cancel'], limits: task.limits,
    },
    source: { binding: task.binding, repository_revision: task.repository_revision, revision_verified: true,
      selection_generation: grant.selection_generation },
    session: { authenticated: true, generation: grant.session_generation, valid_until: grant.valid_until },
    credential_generation: grant.credential_generation,
  };
}

export async function admissionFixture(directory: string, options: ExecutionJournalOptions & { initialize?: boolean; timeoutMs?: number } = {}) {
  const f = await cloudflareFixture(path.join(directory, 'service'), { initialize: options.initialize, timeoutMs: options.timeoutMs });
  const metadata = new SyntheticExecutionMetadata(syntheticMetadata(f.task, f.grant()));
  const storage = new SyntheticCloudflareStorage(path.join(directory, 'host.json'));
  const journal = new ExecutionAdmissionJournal(storage, 'synthetic-owner', f.task.connection_id, options);
  if (options.initialize !== false) await journal.initializeEmpty();
  const access = new ExecutionAccess(metadata, journal, f.now);
  const scripted = new ScriptedKitAdapter(f.adapter);
  const client = new AgentExecutionClient(scripted, access, f.now);
  const core = new ExecutionAdmissionCore(journal, access, client, f.now);
  return { ...f, directory, metadata, storage, journal, access, scripted, core,
    serviceStorage: f.storage, serviceJournal: f.journal,
    reconstruct: () => admissionFixture(directory, { ...options, initialize: false }),
  };
}

// KIT supplies controlled grants to its adapter subject, not a host-access hook.
// This bridge is test instrumentation: its supplied fixture grants are translated
// into trusted metadata before the REAL core/client/CF adapter/service pair runs.
// Production exports have no context-to-authority conversion.
export class AdmissionKitBridge implements AgentExecutionAdapterV1 {
  private fixture?: Awaited<ReturnType<typeof admissionFixture>>;
  constructor(private readonly directory: string) {}
  private async ready(task: ExecutionTask | undefined, context: ExecutionContext) {
    if (!this.fixture) this.fixture = await admissionFixture(this.directory, { initialize: !fs.existsSync(path.join(this.directory, 'host.json')) });
    const f = this.fixture;
    const bound = task ?? { ...f.task, task_id: context.grant.task.task_id, binding: context.grant.task.binding,
      repository_revision: context.grant.task.repository_revision };
    f.metadata.set(syntheticMetadata(bound, context.grant)); f.setGrant(context.grant);
    // KIT's subject name is fixed to the CF fixture's independently verified
    // target identity; declaration overrides are intercepted by KIT externally.
    return f;
  }
  describe() { return new CloudflareExecutionAdapter().describe(); }
  async submit(task: ExecutionTask, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return (await this.ready(task, context)).core.submit(task, context.signal);
  }
  async status(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return (await this.ready(undefined, context)).core.status(ref, context.signal);
  }
  async result(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionResult> {
    return (await this.ready(undefined, context)).core.result(ref, context.signal);
  }
  async cancel(ref: ExecutionTaskRef, context: ExecutionContext): Promise<ExecutionSnapshot> {
    return (await this.ready(undefined, context)).core.cancel(ref, context.signal);
  }
  async advance(ref: ExecutionTaskRef, state: 'running' | 'succeeded' | 'failed' | 'cancelled') {
    if (!this.fixture) throw new Error('Synthetic task was not admitted');
    return this.fixture.runtime.advance(ref, state);
  }
}

// Actual process exits at host boundaries. Uses only synthetic files and the
// already published CF service/runtime; external fetch is blocked by the driver.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--crash') {
  const mode = process.argv[4], f = await admissionFixture(process.argv[3]);
  if (mode === 'after-admission') f.storage.afterCommit = values => {
    if (Object.keys(values).includes('strata-execution-host/1/' + f.ref.task_id)) process.exit(81);
  };
  else if (mode === 'after-native') f.runtime.crash = 'after-native';
  else if (mode === 'after-host-observation') f.storage.afterCommit = values => {
    const record = values['strata-execution/1/' + f.ref.task_id] as { native_handle?: string } | undefined;
    if (record?.native_handle) process.exit(83);
  };
  else if (mode === 'lost-response') f.scripted.script('submit', { kind: 'lose-response' });
  try { await f.core.submit(f.task); }
  catch { if (mode === 'lost-response') process.exit(84); throw new Error('Synthetic crash driver failed before its boundary'); }
  if (mode === 'after-host-result') {
    await f.runtime.advance(f.ref, 'succeeded'); await f.core.status(f.ref);
    f.storage.afterCommit = values => {
      if ((values['strata-execution/1/' + f.ref.task_id] as { result?: unknown } | undefined)?.result) process.exit(85);
    };
    await f.core.result(f.ref);
  }
  throw new Error('Synthetic crash point was not reached');
}
