import { createBuildRepository } from './build-repository-core.js';
import { readFile, open, lstat, unlink, appendFile } from 'node:fs/promises';
import { renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Engine } from './core.js';
import { BLOCK_MODEL, canonical, digest, bytesDigest, fail, type Records } from './model.js';
import { bindNodeState, noLinks } from './node-state.js';
import { loadAssetBytes } from './assets-node.js';
import { validateRecords } from './explorer/validate.js';
import { auditEvent, type AuthorityIssuer, type SecurityContext } from './security.js';
import type { Registry } from './local-broker.js';
import { PROFILE_OPERATIONS } from './build-records.js';
import type { ProfileServiceScope } from './profile-service.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION } from './build-operations.js';
import type { HostEnvironment } from './build-host.js';
import type { LocalBuildOutput } from './build-output.js';

export type LocalBuildOptions = { key?: string; expected_generation?: string; expected_policy?: string; dry_run?: boolean };
export type LocalBuildRepositoryConfig = {
  state_directory: string; issuer: AuthorityIssuer; scope: ProfileServiceScope;
  output: LocalBuildOutput; host?: () => Promise<HostEnvironment>;
  refreshAuthority?: () => void;
  // Fault hooks belong exclusively to isolated tests; no HTTP request can select them.
  beforeCommit?: (action: string) => Promise<void>;
  afterCommit?: (action: string) => Promise<void>;
};
const terminal = ['completed', 'failed', 'interrupted', 'output_incomplete'];

/** One installation owner for the existing Node descriptor/registry/artifacts/audit.
 * Do not open alongside a broker or openProfileRepository for the same directory.
 * Filesystem export and finite checking occur outside the short registry queue.
 */
export async function openLocalBuildRepository(config: LocalBuildRepositoryConfig) {
  const { issuer, scope, output, state_directory: state } = config;
  if (issuer.projectId !== scope.project_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Local build registry belongs to another project.');
  const contains = (base: string, target: string) => { const relative = path.relative(path.resolve(base), path.resolve(target)); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  if (!output.slot.excluded_roots.some(root => contains(root, state))) fail('OUTPUT_ROOT_UNSAFE', 4, 'Output exclusion inventory must include the repository registry.');
  const release = await bindNodeState(state, scope.project_id, BLOCK_MODEL);
  let closed = false, closing = false, pending = 0, queue: Promise<unknown> = Promise.resolve();
  const registryFile = path.join(state, 'registry.json');
  const bounded = async (file: string, max: number) => {
    await noLinks(file); const stat = await lstat(file);
    if (!stat.isFile() || stat.size > max) fail('STORE_UNAVAILABLE', 9, 'Local registry exceeds its regular-file bound.');
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > max) fail('STORE_UNAVAILABLE', 9, 'Local state changed beyond its byte bound.');
    return text;
  };
  async function load() {
    const text = await bounded(registryFile, 16 * 1024 ** 2), registry: Registry = JSON.parse(text);
    if (canonical(registry) !== text || !registry.entries || !registry.heads || !registry.requests || registry.storage || registry.asset_locators || Object.values(registry.entries).some(e => e.locator))
      fail('STORE_BINDING_REQUIRED', 4, 'Local builds require the canonical existing Node registry; remote fallback is unavailable.');
    if (Object.keys(registry.entries).length > 20000 || Object.keys(registry.requests).length > 20000) fail('STORE_UNAVAILABLE', 9, 'Local history exceeds its retained bound.');
    const records: Records = Object.create(null); let total = 0;
    for (const [ref, entry] of Object.entries(registry.entries)) {
      if (!/^[a-f0-9]{64}$/.test(entry.hash)) fail('STORE_UNAVAILABLE', 9, 'Indexed artifact hash is invalid.');
      const bytes = await bounded(path.join(state, 'artifacts', entry.hash + '.json'), 8 * 1024 ** 2);
      total += Buffer.byteLength(bytes); if (total > 64 * 1024 ** 2) fail('STORE_UNAVAILABLE', 9, 'Local history exceeds its byte bound.');
      const data = JSON.parse(bytes);
      if (bytesDigest(bytes) !== entry.hash || canonical(data) !== bytes) fail('STORE_UNAVAILABLE', 9, 'Indexed artifact differs from exact immutable bytes.');
      records[ref] = { type: entry.type, published: entry.published, data };
    }
    validateRecords(records, scope.project_id, BLOCK_MODEL);
    const assetBytes = await loadAssetBytes(state, records);
    return { registry, text, engine: new Engine(records, registry.heads, { projectId: scope.project_id, modelVersion: BLOCK_MODEL, checkerBackend: 'node', assetBytes }) };
  }
  try { await load(); } catch (error) { await release(); throw error; }
  function authorize(context: SecurityContext, command: string, input: unknown, engine?: Engine) {
    config.refreshAuthority?.();
    if (context.trust_mode !== 'host_authenticated') fail('AUTHENTICATION_REQUIRED', 4, 'Local build dispatch requires an authenticated host actor.');
    issuer.authorize(context, command, input, engine);
    if (PROFILE_OPERATIONS.includes(command as any) || BUILD_OPERATIONS.includes(command as any) || command === BUILD_RECOVERY_OPERATION)
      issuer.assertRepository(context, command, scope.repository_id, []);
  }
  async function transaction<T>(context: SecurityContext, command: string, input: unknown,
    work: (engine: Engine, registry: Registry) => Promise<{ data: T; write?: boolean; receipt?: { key: string; digest: string; result: any } }>) {
    if (closed) fail('STORE_UNAVAILABLE', 9, 'Local build registry is closed.');
    if (pending >= 16) fail('QUEUE_FULL', 9, 'Local build transaction queue is full.');
    pending++;
    const task = queue.then(async () => {
      const { registry, text, engine } = await load(); authorize(context, command, input, engine);
      const before = new Set(Object.keys(engine.records));
      const result = await work(engine, registry);
      if (!result.write) return result.data;
      validateRecords(engine.records, scope.project_id, BLOCK_MODEL);
      if (Object.keys(engine.records).length > 20000 || Object.keys(registry.requests).length >= 20000 || (registry.commit_audit?.length ?? 0) >= 20000) fail('STORE_UNAVAILABLE', 9, 'Retained history capacity is full.');
      const entries: Registry['entries'] = {};
      for (const [ref, r] of Object.entries(engine.records)) {
        const bytes = canonical(r.data), hash = bytesDigest(bytes), old = registry.entries[ref];
        // Existing semantic unpublished->published transitions remain allowed;
        // the adapter never edits/drops previously admitted bytes or types.
        if (old && (old.hash !== hash || old.type !== r.type || old.published && !r.published)) fail('IMMUTABLE_REFERENCE', 5, 'Build transaction cannot rewrite indexed history.');
        const file = path.join(state, 'artifacts', hash + '.json'); await noLinks(file);
        try { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (await bounded(file, 8 * 1024 ** 2) !== bytes) fail('ARTIFACT_COLLISION', 9, 'Existing immutable artifact differs.'); }
        entries[ref] = { hash, type: r.type, published: r.published };
      }
      if (Object.keys(registry.entries).some(ref => !entries[ref])) fail('IMMUTABLE_REFERENCE', 5, 'Build transaction cannot drop history.');
      const event = auditEvent(context, command, digest({ command, input, principal: context.principal_id }).slice(0, 24), 'committed');
      event.references = Object.keys(engine.records).filter(ref => !before.has(ref));
      const audit = path.join(state, 'audit.jsonl'); await noLinks(audit);
      try { if ((await lstat(audit)).size > 16 * 1024 ** 2) fail('AUDIT_UNAVAILABLE', 9, 'Audit capacity is full.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await appendFile(audit, canonical(auditEvent(context, command, event.operation_id, 'allowed')) + '\n', { mode: 0o600 });
      const next: Registry = { ...registry, entries, heads: engine.ownerHeads, requests: { ...registry.requests }, commit_audit: [...(registry.commit_audit ?? []), event] };
      if (result.receipt) next.requests[result.receipt.key] = { digest: result.receipt.digest, result: result.receipt.result };
      const temporary = path.join(state, 'registry-build-' + randomUUID() + '.tmp');
      let staged = false, renamed = false;
      try {
        await noLinks(temporary); const handle = await open(temporary, 'wx', 0o600); staged = true;
        try { await handle.writeFile(canonical(next)); await handle.sync(); } finally { await handle.close(); }
        await config.beforeCommit?.(command);
        if (await bounded(registryFile, 16 * 1024 ** 2) !== text) fail('STALE_GENERATION', 5, 'Registry changed during build transaction.');
        authorize(context, command, input, engine);
        // No awaited work between final current authority and atomic publication.
        renameSync(temporary, registryFile); renamed = true;
        if (process.platform !== 'win32') { const fd = openSync(state, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
      } catch (error) {
        if (renamed) fail('BUILD_DURABILITY_UNCERTAIN', 9, 'Registry was published; inspect the original attempt before retrying.');
        if (staged) await unlink(temporary).catch(() => {}); throw error;
      }
      await config.afterCommit?.(command);
      return result.data;
    });
    queue = task.catch(() => {}); return task.finally(() => { pending--; });
  }
  return createBuildRepository({ ...config, transaction: (context, command, input, _options, work) => transaction(context, command, input, work),
    close: async () => { closing = true; await queue; closed = true; await release(); } });
}
export type LocalBuildRepository = ReturnType<typeof createBuildRepository>;
