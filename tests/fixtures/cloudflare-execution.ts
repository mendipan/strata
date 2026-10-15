import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executionTaskRef, executionDigest, type ExecutionSnapshot, type ExecutionResult, type ExecutionGrant,
  type ExecutionTaskRef, type ExecutionTask, type AgentExecutionAccess,
} from '../../src/agent-execution.js';
import { AgentExecutionClient } from '../../src/agent-execution-client.js';
import { CloudflareExecutionAdapter, type CloudflareExecutionAuthentication } from '../../src/agent-adapters/cloudflare-execution.js';
import { CloudflareExecutionJournal, type CloudflareExecutionStorage, type CloudflareExecutionTransaction } from '../../src/agent-adapters/cloudflare-execution-journal.js';
import { createCloudflareExecutionService, type CloudflareExecutionRuntime } from '../../src/agent-adapters/cloudflare-execution-service.js';
import { cloudflareExecutionDeclaration } from '../../src/agent-adapters/cloudflare-execution-protocol.js';
import { syntheticExecutionTask } from './agent-execution.js';

// Synthetic transaction storage only. Atomic file replacement survives the
// child-process exits tested below; it does NOT model Cloudflare replication,
// power-loss durability, cross-process locking or billing.
export class SyntheticCloudflareStorage implements CloudflareExecutionStorage {
  private tail: Promise<unknown> = Promise.resolve();
  afterCommit?: (values: Record<string, unknown>) => void;
  constructor(readonly filename: string) {}
  read(): Record<string, unknown> { return fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename, 'utf8')) : {}; }
  transaction<T>(closure: (tx: CloudflareExecutionTransaction) => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      const values = this.read();
      const tx: CloudflareExecutionTransaction = {
        get: async <V>(key: string) => structuredClone(values[key]) as V | undefined,
        put: async <V>(key: string, value: V) => { values[key] = structuredClone(value); },
        list: async <V>(options: { prefix: string; limit: number }) => new Map(Object.entries(values)
          .filter(([key]) => key.startsWith(options.prefix)).slice(0, options.limit).map(([key, value]) => [key, structuredClone(value) as V])),
      };
      const result = await closure(tx);
      fs.writeFileSync(this.filename + '.next', JSON.stringify(values));
      fs.renameSync(this.filename + '.next', this.filename);
      this.afterCommit?.(values);
      return structuredClone(result);
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
type NativeRecord = { handle: string; snapshot: ExecutionSnapshot; result?: ExecutionResult; deadline: number };
type NativeFile = { starts: number; records: Record<string, NativeRecord> };
export class SyntheticCloudflareRuntime implements CloudflareExecutionRuntime {
  readonly identity = { name: 'synthetic-cloudflare-task-service', version: '1' };
  calls: string[] = [];
  crash?: 'before-native' | 'after-native';
  onStart?: () => void;
  onLookup?: () => void;
  cancelOutcome: 'requested' | 'succeeded' | 'running' = 'requested';
  constructor(readonly filename: string, readonly now: () => number) {}
  read(): NativeFile { return fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename, 'utf8')) : { starts: 0, records: {} }; }
  write(value: NativeFile) { fs.writeFileSync(this.filename + '.next', JSON.stringify(value)); fs.renameSync(this.filename + '.next', this.filename); }
  reply(record: NativeRecord) { return Response.json({ handle: record.handle, snapshot: record.snapshot, ...(record.result ? { result: record.result } : {}) }); }
  async start(_task: ExecutionTask, ref: ExecutionTaskRef, deadline: number): Promise<Response> {
    this.calls.push('start');
    if (this.crash === 'before-native') process.exit(71);
    const file = this.read();
    if (file.records[ref.task_id]) throw new Error('Synthetic runtime refuses duplicate native start');
    file.starts++;
    const record: NativeRecord = { handle: 'native-' + ref.task_id, deadline,
      snapshot: { format: 'strata-agent-task-status/1', task: ref, state: 'queued', sequence: 0 } };
    file.records[ref.task_id] = record; this.write(file);
    if (this.crash === 'after-native') process.exit(72);
    this.onStart?.();
    return this.reply(record);
  }
  async lookup(ref: ExecutionTaskRef, handle: string | undefined): Promise<Response | undefined> {
    this.calls.push('lookup'); this.onLookup?.();
    const record = this.read().records[ref.task_id];
    if (!record) return undefined;
    if (handle && handle !== record.handle) throw new Error('Synthetic native handle mismatch');
    if (!['succeeded', 'failed', 'cancelled'].includes(record.snapshot.state) && record.deadline <= this.now()) {
      await this.advance(ref, 'failed', undefined, 'TASK_DEADLINE');
      return this.reply(this.read().records[ref.task_id]);
    }
    return this.reply(record);
  }
  async cancel(ref: ExecutionTaskRef, handle: string): Promise<Response> {
    this.calls.push('cancel');
    const record = this.read().records[ref.task_id];
    if (record.handle !== handle) throw new Error('Synthetic native handle mismatch');
    if (!['succeeded', 'failed', 'cancelled', 'cancel_requested'].includes(record.snapshot.state)) {
      if (this.cancelOutcome !== 'running') await this.advance(ref, this.cancelOutcome === 'succeeded' ? 'succeeded' : 'cancel_requested');
    }
    return this.reply(this.read().records[ref.task_id]);
  }
  async advance(ref: ExecutionTaskRef, state: ExecutionSnapshot['state'], summary = 'Synthetic proposed output.', failure: 'TASK_FAILED' | 'TASK_DEADLINE' | 'TASK_LIMIT' | 'TASK_POLICY' = 'TASK_FAILED') {
    const file = this.read(), record = file.records[ref.task_id];
    const base = { format: 'strata-agent-task-status/1' as const, task: ref, sequence: record.snapshot.sequence + 1 };
    if (state === 'succeeded') {
      record.result = { format: 'strata-agent-task-result/1', task: ref, summary, artifacts: [], trust: 'agent-output' };
      record.snapshot = { ...base, state, result_sha256: await executionDigest(record.result) };
    } else if (state === 'failed') record.snapshot = { ...base, state, failure };
    else record.snapshot = { ...base, state };
    this.write(file);
  }
}
export async function cloudflareFixture(directory: string, configuration: { initialize?: boolean; capacity?: number; retentionMs?: number; timeoutMs?: number; admissionLimits?: { activeTasks: number; startsPerMinute: number } } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  let time = Date.parse('2026-01-01T00:00:00Z'); const now = () => time;
  const declaration = structuredClone(cloudflareExecutionDeclaration);
  if (configuration.timeoutMs) declaration.limits.call_timeout_ms = configuration.timeoutMs;
  const task = structuredClone(syntheticExecutionTask), ref = await executionTaskRef(task);
  const target = { base_url: 'https://synthetic.invalid/execution', connection_id: task.connection_id,
    binding: task.binding, service_id: 'synthetic-service', instance_id: 'synthetic-instance', subject: 'synthetic-verified-subject',
    declaration_sha256: await executionDigest(declaration) };
  let grant: ExecutionGrant | undefined = { format: 'strata-agent-execution-grant/1', task: ref,
    declaration_sha256: target.declaration_sha256, service_id: target.service_id, instance_id: target.instance_id, subject: target.subject,
    consent: 'approved', enabled: true, approval_generation: 1, selection_generation: 1, session_generation: 1, credential_generation: 1,
    valid_until: '2026-01-01T00:05:00Z' };
  const storage = new SyntheticCloudflareStorage(path.join(directory, 'journal.json'));
  const journal = new CloudflareExecutionJournal(storage, task.connection_id, configuration.capacity, configuration.retentionMs, configuration.admissionLimits);
  if (configuration.initialize !== false) await journal.initializeEmpty();
  const runtime = new SyntheticCloudflareRuntime(path.join(directory, 'native.json'), now), invalidation = new AbortController();
  let authCalls = 0, transports = 0;
  const authorize = async () => { authCalls++; return grant && { grant: structuredClone(grant), invalidated: invalidation.signal }; };
  const service = createCloudflareExecutionService({ target, journal, runtime, authorize, declaration, now });
  const verifiedResponses = new WeakSet<Response>();
  const transport = async (url: string, init: RequestInit) => {
    transports++; const response = await service(new Request(url, init)); verifiedResponses.add(response); return response;
  };
  const authentication: CloudflareExecutionAuthentication = {
    headers: async () => ({}),
    verify: async response => {
      if (!verifiedResponses.has(response)) throw new Error('Synthetic independent service identity refused');
      return { subject: target.subject, service_id: target.service_id, instance_id: target.instance_id, expires_at: '2026-01-01T00:05:00Z' };
    },
  };
  const adapter = new CloudflareExecutionAdapter({ target, authentication, transport, declaration, now });
  const access: AgentExecutionAccess = { current: async () => structuredClone(grant) };
  return { task, ref, target, declaration, storage, journal, runtime, adapter, service, transport, authentication, access, now,
    client: new AgentExecutionClient(adapter, access, now), grant: () => grant!,
    setGrant: (next: ExecutionGrant | undefined) => { grant = next; }, invalidate: () => invalidation.abort(),
    tick: (milliseconds: number) => { time += milliseconds; }, counts: () => ({ authCalls, transports }),
  };
}

// Dedicated offline process-crash driver: exits after durable reservation, native
// start, or mapping commit. It never launches a provider/runtime SDK or fetches.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--crash') {
  const mode = process.argv[4], f = await cloudflareFixture(process.argv[3]);
  if (mode === 'before-native' || mode === 'after-native') f.runtime.crash = mode;
  else if (mode === 'after-mapping') f.storage.afterCommit = values => {
    if (Object.values(values).some(value => value && typeof value === 'object' && 'native_handle' in value)) process.exit(73);
  };
  await f.client.submit(f.task);
  throw new Error('Crash point was not reached');
}
