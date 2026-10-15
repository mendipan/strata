import { readFile, open, appendFile, lstat, unlink } from 'node:fs/promises';
import { renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Engine } from './core.js';
import { BLOCK_MODEL, canonical, digest, bytesDigest, fail, type Records } from './model.js';
import { bindNodeState, noLinks } from './node-state.js';
import { auditEvent, type AuthorityIssuer, type SecurityContext } from './security.js';
import type { Registry } from './local-broker.js';
import { loadAssetBytes } from './assets-node.js';
import { validateRecords } from './explorer/validate.js';
import { PROFILE_MUTATIONS, verifyBuildHistory } from './build-records.js';
import { BuildProfileService, type ProfileServiceScope } from './profile-service.js';

// Local host adapter for the EXISTING node-state descriptor/artifacts/registry/
// audit/request protocol. A normal broker and this adapter cannot own the same
// state concurrently. S3 can instead invoke BuildProfileService in its existing
// transaction; no second profile database or command route is introduced here.
export async function openProfileRepository(stateDirectory: string, issuer: AuthorityIssuer, scope: ProfileServiceScope,
  controls: { faultForTest?: () => 'after-stage' | 'after-commit' | undefined; beforeCommit?: () => Promise<void> } = {}) {
  if (issuer.projectId !== scope.project_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Profile state is bound to another project.');
  const release = await bindNodeState(stateDirectory, issuer.projectId, BLOCK_MODEL);
  const registryFile = path.join(stateDirectory, 'registry.json');
  let closed = false, pending = 0, queue: Promise<unknown> = Promise.resolve();
  const bounded = async (filename: string, max: number) => {
    await noLinks(filename); const stats = await lstat(filename);
    if (!stats.isFile() || stats.size > max) fail('STORE_UNAVAILABLE', 9, 'Indexed local state exceeds its regular-file bound.');
    const text = await readFile(filename, 'utf8'); if (Buffer.byteLength(text) > max) fail('STORE_UNAVAILABLE', 9, 'Local state changed beyond its byte bound.'); return text;
  };
  async function load() {
    const text = await bounded(registryFile, 16 * 1024 ** 2), registry: Registry = JSON.parse(text);
    if (canonical(registry) !== text || !registry.entries || !registry.heads || !registry.requests || registry.storage || registry.asset_locators || Object.values(registry.entries).some(e => e.locator)) fail('STORE_BINDING_REQUIRED', 4, 'Profile adapter needs the existing canonical local registry; remote fallback is forbidden.');
    if (Object.keys(registry.entries).length > 20000 || Object.keys(registry.requests).length > 20000) fail('STORE_UNAVAILABLE', 9, 'Local registry exceeds its bounded history.');
    const records: Records = Object.create(null); let total = 0;
    for (const [ref, entry] of Object.entries(registry.entries)) {
      if (!/^[a-f0-9]{64}$/.test(entry.hash)) fail('STORE_UNAVAILABLE', 9, 'Registry artifact hash is invalid.');
      const bytes = await bounded(path.join(stateDirectory, 'artifacts', entry.hash + '.json'), 8 * 1024 ** 2);
      total += Buffer.byteLength(bytes); if (total > 64 * 1024 ** 2) fail('STORE_UNAVAILABLE', 9, 'Profile source exceeds the retained byte bound.');
      const data = JSON.parse(bytes);
      if (bytesDigest(bytes) !== entry.hash || canonical(data) !== bytes) fail('STORE_UNAVAILABLE', 9, 'Indexed artifact differs from its exact bytes.');
      records[ref] = { type: entry.type, published: entry.published, data };
    }
    validateRecords(records, scope.project_id, BLOCK_MODEL);
    const assetBytes = await loadAssetBytes(stateDirectory, records);
    return { registry, engine: new Engine(records, registry.heads, { projectId: scope.project_id, modelVersion: BLOCK_MODEL, checkerBackend: 'node', assetBytes }), text };
  }
  try { await load(); } catch (error) { await release(); throw error; }
  async function work(command: string, input: unknown, context: SecurityContext, options: { key?: string; expected_generation?: string; expected_policy?: string; review?: boolean } = {}) {
    const { registry, engine, text: beforeText } = await load();
    const service = new BuildProfileService(engine, scope, context, issuer); service.assertAuthority(command, input);
    const mutation = options.review || PROFILE_MUTATIONS.includes(command as any);
    if (mutation && (!options.key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.key))) fail('INVALID_ARGUMENT', 2, 'Profile mutation requires an exact bounded request key.');
    if (options.review && !['repository.contract.import', 'repository.contract.attach'].includes(command)) fail('INVALID_ARGUMENT', 2, 'Only exact contract/adoption requests can be reviewed.');
    const requestDigest = digest({ command, input, principal: context.principal_id, ...(options.review ? { internal_review: true } : {}) });
    const key = mutation ? `${context.tenant_id}:${context.project_id}:${context.principal_id}:${options.key}` : null;
    const auditFile = path.join(stateDirectory, 'audit.jsonl'); await noLinks(auditFile);
    try { if ((await lstat(auditFile)).size > 16 * 1024 ** 2) fail('AUDIT_UNAVAILABLE', 9, 'Local audit capacity is full.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await appendFile(auditFile, canonical(auditEvent(context, command, requestDigest.slice(0, 24), 'allowed')) + '\n');
    if (key && registry.requests[key]) {
      if (registry.requests[key].digest !== requestDigest) fail('IDEMPOTENCY_CONFLICT', 5, 'Request key binds different exact input or action.');
      const result = registry.requests[key].result;
      service.assertVisibleRecord(result.data.ref);
      if (!engine.records[result.data.ref]?.published || digest(engine.records[result.data.ref].data) !== result.data.sha256) fail('STORE_UNAVAILABLE', 9, 'Retained profile receipt lost its exact record.');
      if (options.review && !issuer.permitsApproval(context, 'release')) fail('AUTHORITY_FORBIDDEN', 4, 'Replay requires current review authority.');
      return { ...structuredClone(result), reused: true };
    }
    const before = new Set(Object.keys(engine.records));
    const expected = { generation: options.expected_generation, policy: options.expected_policy };
    if (options.review) {
      if (expected.policy !== undefined && expected.policy !== context.policy_version) fail('STALE_POLICY', 5, 'Profile policy changed before dispatch.');
      if (expected.generation !== undefined && expected.generation !== service.generation()) fail('STALE_GENERATION', 5, 'Profile repository view changed before dispatch.');
    }
    const data = options.review ? service.review(command as 'repository.contract.import' | 'repository.contract.attach', input) : service.execute(command, input, expected);
    const result = { ok: true, data, created: Object.keys(engine.records).filter(ref => !before.has(ref)), operation_id: requestDigest.slice(0, 24), dry_run: false };
    if (!mutation) return result;
    if (Object.keys(registry.requests).length >= 20000 || (registry.commit_audit?.length ?? 0) >= 20000) fail('STORE_UNAVAILABLE', 9, 'Retained request or audit capacity is full.');
    const entries: Registry['entries'] = {};
    for (const [ref, r] of Object.entries(engine.records)) {
      const bytes = canonical(r.data), hash = bytesDigest(bytes), old = registry.entries[ref];
      if (old && (old.hash !== hash || old.type !== r.type || old.published && !r.published)) fail('IMMUTABLE_REFERENCE', 5, 'Profile publication cannot rewrite indexed history.');
      const destination = path.join(stateDirectory, 'artifacts', hash + '.json'); await noLinks(destination);
      try { const handle = await open(destination, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (await bounded(destination, 8 * 1024 ** 2) !== bytes) fail('ARTIFACT_COLLISION', 9, 'Existing immutable artifact differs.'); }
      entries[ref] = { hash, type: r.type, published: r.published };
    }
    if (Object.keys(registry.entries).some(ref => !entries[ref])) fail('IMMUTABLE_REFERENCE', 5, 'Profile publication cannot drop retained history.');
    if (controls.faultForTest?.() === 'after-stage') fail('INJECTED_STAGE_FAILURE', 9, 'Fixture failure before registry publication.');
    const commit = auditEvent(context, command, result.operation_id, 'committed'); commit.references = result.created;
    const next: Registry = { ...registry, entries, heads: engine.ownerHeads, requests: { ...registry.requests, [key!]: { digest: requestDigest, result } }, commit_audit: [...(registry.commit_audit ?? []), commit] };
    // A fresh exclusive stage never reuses an uncommitted snapshot left by an
    // interrupted process. Request identity and committed receipts stay exact.
    const temporary = path.join(stateDirectory, 'registry-profile-' + requestDigest.slice(0, 24) + '-' + randomUUID() + '.tmp');
    let renamed = false, created = false;
    try {
      await noLinks(temporary);
      const handle = await open(temporary, 'wx'); created = true;
      try { await handle.writeFile(canonical(next)); await handle.sync(); } finally { await handle.close(); }
      await controls.beforeCommit?.();
      if (await bounded(registryFile, 16 * 1024 ** 2) !== beforeText) fail('STALE_GENERATION', 5, 'Registry changed during profile preparation.');
      service.assertAuthority(command, input); verifyBuildHistory(engine.records, scope.project_id);
      // Same final synchronous authority/rename boundary as the existing broker.
      renameSync(temporary, registryFile); renamed = true;
      if (process.platform !== 'win32') { const fd = openSync(stateDirectory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    } catch (error) {
      if (renamed) fail('PROFILE_DURABILITY_UNCERTAIN', 9, 'Registry was published; inspect the original request key before retrying.');
      if (created) await unlink(temporary).catch(() => {});
      throw error;
    }
    if (controls.faultForTest?.() === 'after-commit') fail('INJECTED_RESPONSE_LOSS', 9, 'Fixture response lost after registry publication.');
    return result;
  }
  return {
    execute(command: string, input: unknown, context: SecurityContext, options?: Parameters<typeof work>[3]) {
      if (closed) return Promise.reject(new Error('Profile repository is closed.'));
      if (pending >= 16) return Promise.reject(new Error('Profile repository queue is full.'));
      pending++; const operation = queue.then(() => work(command, input, context, options)); queue = operation.catch(() => {});
      return operation.finally(() => { pending--; });
    },
    async close() { if (!closed) { closed = true; await queue; await release(); } }
  };
}
