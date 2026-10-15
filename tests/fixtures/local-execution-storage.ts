import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { LocalExecutionStorage, type LocalExecutionStorageBinding } from '../../src/agent-adapters/local-execution-storage.js';
import { CloudflareExecutionJournal, type CloudflareExecutionStorage } from '../../src/agent-adapters/cloudflare-execution-journal.js';
import { createCloudflareExecutionService } from '../../src/agent-adapters/cloudflare-execution-service.js';
import { CloudflareExecutionAdapter } from '../../src/agent-adapters/cloudflare-execution.js';
import { ExecutionAdmissionJournal, ExecutionAdmissionCore } from '../../src/agent-execution-admission.js';
import { ExecutionAccess } from '../../src/agent-execution-access.js';
import { AgentExecutionClient } from '../../src/agent-execution-client.js';
import { SyntheticExecutionMetadata, syntheticMetadata } from './execution-admission.js';
import { cloudflareFixture } from './cloudflare-execution.js';
import { AgentExecutionError } from '../../src/agent-execution.js';

// This attests ONLY to test-local synthetic custody. It checks no Windows ACL
// and must never be copied as a production verifier. No real state/credentials.
export const syntheticLocalCustody = { assertWindowsCustody: async (_directory: string) => {} };
export const localBinding = (role: 'host' | 'service', connection = 'synthetic-connection'): LocalExecutionStorageBinding =>
  ({ role, owner_id: 'synthetic-owner', connection_id: connection });
export function localStorage(directory: string, role: 'host' | 'service', connection?: string) {
  return new LocalExecutionStorage(directory, localBinding(role, connection), syntheticLocalCustody);
}
export async function provisionLocal(directory: string, role: 'host' | 'service', connection?: string) {
  fs.mkdirSync(directory, { mode: 0o700 });
  const storage = localStorage(directory, role, connection); await storage.provisionEmpty(); return storage;
}
export const localFile = (directory: string) => path.join(directory, 'execution.json');
export const localValues = (directory: string): Record<string, any> => JSON.parse(fs.readFileSync(localFile(directory), 'utf8')).values;

export async function localExecutionFixture(directory: string, initialize = true, retentionMs = 300000,
  wrap: (storage: CloudflareExecutionStorage, role: 'host' | 'service') => CloudflareExecutionStorage = storage => storage) {
  const f = await cloudflareFixture(path.join(directory, 'synthetic-runtime'), { initialize: false });
  const hostDirectory = path.join(directory, 'host'), serviceDirectory = path.join(directory, 'service');
  const make = async (dir: string, role: 'host' | 'service') => initialize
    ? provisionLocal(dir, role, f.task.connection_id) : localStorage(dir, role, f.task.connection_id);
  const hostStorage = await make(hostDirectory, 'host'), serviceStorage = await make(serviceDirectory, 'service');
  const hostJournal = new ExecutionAdmissionJournal(wrap(hostStorage, 'host'), 'synthetic-owner', f.task.connection_id, { resultRetentionMs: retentionMs });
  const serviceJournal = new CloudflareExecutionJournal(wrap(serviceStorage, 'service'), f.task.connection_id, undefined, retentionMs);
  if (initialize) { await hostJournal.initializeEmpty(); await serviceJournal.initializeEmpty(); }
  const metadata = new SyntheticExecutionMetadata(syntheticMetadata(f.task, f.grant()));
  const service = createCloudflareExecutionService({ target: f.target, journal: serviceJournal, runtime: f.runtime,
    authorize: async () => ({ grant: f.grant(), invalidated: new AbortController().signal }), declaration: f.declaration, now: f.now });
  const replies = new WeakSet<Response>(); let transports = 0;
  const adapter = new CloudflareExecutionAdapter({ target: f.target, declaration: f.declaration, now: f.now,
    transport: async (url, init) => { transports++; const response = await service(new Request(url, init)); replies.add(response); return response; },
    authentication: { headers: async () => ({}), verify: async response => {
      if (!replies.has(response)) throw new Error('Synthetic response mismatch');
      return { subject: f.target.subject, service_id: f.target.service_id, instance_id: f.target.instance_id, expires_at: f.grant().valid_until };
    } },
  });
  const access = new ExecutionAccess(metadata, hostJournal, f.now);
  const core = new ExecutionAdmissionCore(hostJournal, access, new AgentExecutionClient(adapter, access, f.now), f.now);
  return { ...f, core, metadata, access, hostStorage, serviceStorage, hostJournal, serviceJournal, hostDirectory, serviceDirectory,
    counts: () => ({ transports }), reconstruct: () => localExecutionFixture(directory, false, retentionMs) };
}

// Synthetic child driver. Patches are confined to this process and only the
// task-local host file. No production hooks or fault injection in the storage.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  const f = await localExecutionFixture(directory, false);
  if (mode === 'compete') {
    process.send?.('ready'); await new Promise<void>(resolve => process.once('message', () => resolve()));
    try {
      const reservation = await f.serviceJournal.reserve(f.task, f.grant(), f.now(), () => {});
      if (reservation.fresh) await f.runtime.start(f.task, f.ref, reservation.record.deadline_at);
      process.send?.({ fresh: reservation.fresh });
    } catch (error) { process.send?.({ code: error instanceof AgentExecutionError ? error.code : 'unexpected' }); }
    process.disconnect?.();
  } else if (mode === 'stage-crash' || mode === 'rename-crash') {
    const original = fs.renameSync;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) !== localFile(f.hostDirectory)) return original(from, to);
      if (mode === 'stage-crash') process.exit(91);
      original(from, to); process.exit(92);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    await f.core.submit(f.task);
    throw new Error('Synthetic file crash was not reached');
  } else {
    if (mode === 'native-crash') f.runtime.crash = 'after-native';
    if (mode === 'admission-crash') {
      const original = f.hostStorage.transaction.bind(f.hostStorage);
      f.hostStorage.transaction = async closure => {
        const value = await original(closure);
        if (localValues(f.hostDirectory)['strata-execution-host/1/' + f.ref.task_id]) process.exit(93);
        return value;
      };
    }
    if (mode === 'result-crash') {
      await f.core.submit(f.task); await f.runtime.advance(f.ref, 'succeeded'); await f.core.status(f.ref);
      const original = f.hostStorage.transaction.bind(f.hostStorage);
      f.hostStorage.transaction = async closure => {
        const value = await original(closure);
        if (localValues(f.hostDirectory)['strata-execution/1/' + f.ref.task_id]?.result) process.exit(94);
        return value;
      };
      await f.core.result(f.ref);
    } else await f.core.submit(f.task);
    throw new Error('Synthetic journal crash was not reached');
  }
}
