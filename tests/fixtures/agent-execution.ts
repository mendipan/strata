import {
  AgentExecutionError, executionDeclarationSchema, executionDigest, executionTaskRef,
  sameExecutionValue, type AgentExecutionAdapterV1, type ExecutionContext,
  type ExecutionTask, type ExecutionTaskRef, type ExecutionSnapshot, type ExecutionResult,
} from '../../src/agent-execution.js';

// Public synthetic data. No credentials, network, process spawning or model calls.
export const syntheticExecutionDeclaration = executionDeclarationSchema.parse({
  format: 'strata-agent-execution-adapter/1', protocol: 'strata-agent-execution/1',
  id: 'synthetic-agent', version: '1', runtime: { name: 'synthetic-agent-loop', version: '1', kind: 'agent-runtime' },
  models: ['strata/0.3-block-lifecycle-experimental'],
  capabilities: { submit: true, status: true, result: true, cancel: 'cooperative', idempotency: 'durable-task-id', recovery: 'lookup-task-id' },
  limits: { call_timeout_ms: 1000, task_runtime_ms: 60000, output_bytes: 32768 }, authority: 'task-only',
});
export const syntheticExecutionTask: ExecutionTask = {
  format: 'strata-agent-task/1', connection_id: 'synthetic-connection', task_id: '00000000-0000-4000-8000-000000000001',
  binding: { project_id: 'synthetic-project', model_version: 'strata/0.3-block-lifecycle-experimental', repository_id: 'synthetic-repository' },
  repository_revision: 'a'.repeat(40), instruction: 'Prepare a proposed change for review.',
  limits: { runtime_ms: 60000, output_bytes: 32768 },
};
type RecordEntry = { task: ExecutionTaskRef; snapshot: ExecutionSnapshot; result?: ExecutionResult };
// Inject/reuse across adapter reconstruction to exercise the journal contract. This
// Map is NOT durable storage and cannot qualify any provider for crash recovery.
export class SyntheticExecutionJournal {
  readonly records = new Map<string, RecordEntry>();
  starts = 0;
}
export class SyntheticExecutionAdapter implements AgentExecutionAdapterV1 {
  calls: string[] = [];
  constructor(readonly journal = new SyntheticExecutionJournal()) {}
  describe() { return structuredClone(syntheticExecutionDeclaration); }
  private entry(ref: ExecutionTaskRef): RecordEntry {
    const record = this.journal.records.get(ref.connection_id + '/' + ref.task_id);
    if (!record) throw new AgentExecutionError('EXECUTION_NOT_FOUND');
    if (!sameExecutionValue(record.task, ref)) throw new AgentExecutionError('EXECUTION_CONFLICT');
    return record;
  }
  async submit(task: ExecutionTask, _context: ExecutionContext): Promise<ExecutionSnapshot> {
    this.calls.push('submit');
    const ref = await executionTaskRef(task), key = ref.connection_id + '/' + ref.task_id;
    if (this.journal.records.has(key)) return structuredClone(this.entry(ref).snapshot);
    const snapshot: ExecutionSnapshot = { format: 'strata-agent-task-status/1', task: ref, sequence: 0, state: 'queued' };
    this.journal.records.set(key, { task: ref, snapshot });
    this.journal.starts++;
    return structuredClone(snapshot);
  }
  async status(ref: ExecutionTaskRef, _context: ExecutionContext): Promise<ExecutionSnapshot> {
    this.calls.push('status'); return structuredClone(this.entry(ref).snapshot);
  }
  async result(ref: ExecutionTaskRef, _context: ExecutionContext): Promise<ExecutionResult> {
    this.calls.push('result');
    const record = this.entry(ref);
    if (!record.result) throw new AgentExecutionError('EXECUTION_RESULT_UNAVAILABLE');
    return structuredClone(record.result);
  }
  async cancel(ref: ExecutionTaskRef, _context: ExecutionContext): Promise<ExecutionSnapshot> {
    this.calls.push('cancel');
    const record = this.entry(ref);
    if (['queued', 'running'].includes(record.snapshot.state)) {
      record.snapshot = { format: 'strata-agent-task-status/1', task: ref, sequence: record.snapshot.sequence + 1, state: 'cancel_requested' };
    }
    return structuredClone(record.snapshot);
  }
  // Test controller, deliberately outside the adapter interface.
  async advance(ref: ExecutionTaskRef, state: 'running' | 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    const record = this.entry(ref);
    const base = { format: 'strata-agent-task-status/1' as const, task: ref, sequence: record.snapshot.sequence + 1 };
    if (state === 'succeeded') {
      record.result = { format: 'strata-agent-task-result/1', task: ref, summary: 'Synthetic proposed change; review required.', artifacts: [], trust: 'agent-output' };
      record.snapshot = { ...base, state, result_sha256: await executionDigest(record.result) };
    } else if (state === 'failed') record.snapshot = { ...base, state, failure: 'TASK_FAILED' };
    else record.snapshot = { ...base, state };
  }
}
