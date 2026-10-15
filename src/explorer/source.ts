import { open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { noLinks, INACTIVE_MARKER, STATE_DESCRIPTOR, NODE_STATE_FORMAT } from '../node-state.js';
import { ASSET_LIMITS, checkAssets } from '../assets.js';
import { bytesDigest, canonical, digest, type Records } from '../model.js';
import type { ArtifactLocator } from '../artifacts.js';
import type { LocatedRegistry } from '../artifact-registry.js';
import { connectionSchema, grantSchema, ExplorerError, LIMITS, RECORD_TYPES, problem, safeJson, type ConnectionConfig, type SourceInfo } from './contract.js';
import { MEDIATION_SCHEMAS } from '../mediation.js';
import { BUILD_RECORD_SCHEMAS } from '../build-records.js';
import { BUILD_ATTEMPT_SCHEMAS } from '../build-attempt-records.js';
import { validateRecords } from './validate.js';
import type { ReadBudgetReservations } from './read-budget.js';

// Only exact reads exist on this dependency surface. A native host can supply a
// Pick<CloudflareArtifactsAdapter, 'getManyAt' | 'getBytesAt'> with a zero token cap.
export interface ArtifactsReadPort {
  getManyAt(locators: ArtifactLocator[], signal?: AbortSignal): Promise<(string | null)[]>;
  getBytesAt(locator: ArtifactLocator, signal?: AbortSignal): Promise<Uint8Array | null>;
}
export interface ExplorerSource {
  readonly connection: { connection_id: string; project_id: string; display_name: string; model_version: string; repository_id?: string; initial_release_ref?: string; repository_identity?: { account: string; namespace: string; repository: string } };
  assertAuthorized(): void;
  load(signal?: AbortSignal): Promise<{ records: Records; assetBytes: Map<string, Uint8Array>; source: SourceInfo }>;
}
export async function trustedFile(filename: string, max: number): Promise<string> {
  if (!path.isAbsolute(filename)) problem('SOURCE_BINDING', 403, 'Project source does not match.');
  await noLinks(filename);
  const handle = await open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) problem('READ_LIMIT', 413, 'This project exceeds the current Studio read limit.');
    // Read one byte beyond the admission bound; concurrent file growth stays bounded.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) problem('SOURCE_BINDING', 403, 'The trusted registry changed during its read.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
    catch { return problem('CORRUPT_DATA', 422, 'Project records could not be verified.'); }
  } finally { await handle.close(); }
}
export async function loadConfig(filename: string) {
  const parsed = connectionSchema.safeParse(safeJson(await trustedFile(filename, 16384), 16384));
  if (!parsed.success) problem('SOURCE_BINDING', 403, 'Connection configuration could not be verified.');
  const config = parsed.data;
  if (config.storage.project_id !== config.project_id || config.read_authorization.project_id !== config.project_id || !path.isAbsolute(config.registry_path)) problem('SOURCE_BINDING', 403, 'Project source does not match.');
  return config;
}
export async function readRegistryFile(config: ConnectionConfig) {
  const directory = path.dirname(config.registry_path);
  await noLinks(directory);
  try { await lstat(path.join(directory, INACTIVE_MARKER)); problem('SOURCE_BINDING', 403, 'Inactive recovery data cannot be opened as a project.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    const descriptor = safeJson(await trustedFile(path.join(directory, STATE_DESCRIPTOR), 4096), 4096);
    if (canonical(descriptor) !== canonical({ format: NODE_STATE_FORMAT, model_version: config.model_version, project_id: config.project_id })) problem('SOURCE_BINDING', 403, 'Project source does not match.');
  } catch (error) {
    // A separately approved fixed export can have its binding in host config.
    // An active publication index must have the existing matching descriptor.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || config.registry_kind !== 'fixed-snapshot') throw error;
  }
  return trustedFile(config.registry_path, LIMITS.registryBytes);
}
export function admitRegistry(input: any, config: ConnectionConfig): LocatedRegistry {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.entries || typeof input.entries !== 'object' || Array.isArray(input.entries) || !input.storage || canonical(input.storage) !== canonical(config.storage)) problem('SOURCE_BINDING', 403, 'Project source does not match.');
  // Existing writer registries may also hold heads, requests, contexts and audit.
  // They are never part of the reader's generation or response.
  const entries = Object.entries(input.entries) as [string, any][];
  if (entries.length > LIMITS.records) problem('READ_LIMIT', 413, 'This project exceeds the current Studio read limit.');
  let total = 0;
  for (const [ref, entry] of entries) {
    if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/.test(ref) || ref.length > 256 || !entry || ![...RECORD_TYPES, 'interaction', ...Object.keys(MEDIATION_SCHEMAS), ...Object.keys(BUILD_RECORD_SCHEMAS), ...Object.keys(BUILD_ATTEMPT_SCHEMAS)].includes(entry.type) || typeof entry.published !== 'boolean' || Object.keys(entry).some(k => !['hash', 'type', 'published', 'locator'].includes(k))) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
    checkLocator(entry.locator, entry.hash, 'json', LIMITS.recordBytes);
    total += entry.locator.size_bytes;
  }
  const assets = Object.entries(input.asset_locators ?? {}) as [string, ArtifactLocator][];
  if (total > LIMITS.jsonBytes || assets.length > ASSET_LIMITS.versions || assets.reduce((n, [, l]) => n + (l.size_bytes ?? ASSET_LIMITS.retainedBytes + 1), 0) > ASSET_LIMITS.retainedBytes) problem('READ_LIMIT', 413, 'This project exceeds the current Studio read limit.');
  for (const [hash, locator] of assets) checkLocator(locator, hash, 'bin', ASSET_LIMITS.bytes);
  return { entries: structuredClone(input.entries), storage: structuredClone(input.storage), asset_locators: structuredClone(input.asset_locators ?? {}) };
}
function checkLocator(l: ArtifactLocator, hash: string, extension: string, max: number) {
  if (!l || !/^[a-f0-9]{64}$/.test(hash) || l.hash !== hash || !/^[a-f0-9]{40}$/.test(l.ref) || l.path !== `${hash}.${extension}` || !Number.isSafeInteger(l.size_bytes) || l.size_bytes! < 1 || l.size_bytes! > max || Object.keys(l).some(k => !['ref', 'path', 'hash', 'size_bytes'].includes(k))) problem('SOURCE_BINDING', 403, 'Exact record locators could not be verified.');
}

export class RegistrySource implements ExplorerSource {
  readonly connection;
  constructor(readonly config: ConnectionConfig, private readonly port: ArtifactsReadPort, private readonly registry = () => readRegistryFile(config), private readonly authorized = () => {}) {
    this.connection = { connection_id: config.connection_id, project_id: config.project_id, display_name: config.display_name, model_version: config.model_version, initial_release_ref: config.initial_release_ref, repository_identity: { account: config.storage.account, namespace: config.storage.namespace, repository: config.storage.repository } };
  }
  assertAuthorized() {
    if (!grantSchema.safeParse(this.config.read_authorization).success || this.config.read_authorization.project_id !== this.config.project_id || Date.parse(this.config.read_authorization.expires_at) <= Date.now()) problem('SOURCE_AUTH', 403, 'Source access needs attention.');
    this.authorized();
  }
  async load(signal?: AbortSignal) {
    this.assertAuthorized();
    const registry = admitRegistry(safeJson(await this.registry()), this.config);
    const indexed = Object.entries(registry.entries), records: Records = Object.create(null);
    const texts = await this.port.getManyAt(indexed.map(([, entry]) => entry.locator!), signal);
    if (texts.length !== indexed.length) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
    for (const [i, [ref, entry]] of indexed.entries()) {
      const text = texts[i];
      if (text === null || Buffer.byteLength(text) !== entry.locator!.size_bytes || bytesDigest(text) !== entry.hash) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
      const data = safeJson(text, LIMITS.recordBytes);
      if (canonical(data) !== text) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
      records[ref] = { type: entry.type, published: entry.published, data };
    }
    validateRecords(records, this.config.project_id, this.config.model_version);
    const assetBytes = new Map<string, Uint8Array>();
    const descriptors = [...new Set(Object.values(records).filter(r=>r.type==='asset').map(r=>r.data.content_sha256))].sort();
    if (canonical(descriptors) !== canonical(Object.keys(registry.asset_locators ?? {}).sort())) problem('CORRUPT_DATA',422,'Project records could not be verified.');
    for (const [hash, locator] of Object.entries(registry.asset_locators ?? {})) {
      const bytes = await this.port.getBytesAt(locator, signal);
      if (!bytes || bytes.byteLength !== locator.size_bytes || bytesDigest(bytes) !== hash) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
      assetBytes.set(hash, bytes);
    }
    try { checkAssets(records, assetBytes, this.config.project_id); } catch { problem('CORRUPT_DATA', 422, 'Project records could not be verified.'); }
    this.assertAuthorized();
    return { records, assetBytes, source: { mode: 'artifacts-remote' as const, registry_kind: this.config.registry_kind, registry_generation: digest(registry), verified_at: new Date().toISOString(), freshness: this.config.registry_kind === 'fixed-snapshot' ? 'fixed-snapshot' as const : 'current-generation' as const, semantic_trust: 'local-fixture' as const } };
  }
}

// Documented local REST transport. Credentials arrive only through an explicitly
// supplied host callback, after scope/budget checks. No login, token creation,
// token refresh, discovery, branch fallback, or private Wrangler API is involved.
export class RestArtifactsReader implements ArtifactsReadPort {
  private requests = 0; private bytes = 0;
  constructor(private readonly config: ConnectionConfig, private readonly credential: () => Promise<string>, private readonly transport: typeof fetch = fetch, private readonly expectedRepositoryId?: string, private readonly budget?: ReadBudgetReservations) {}
  assertAuthorized() {
    if (!grantSchema.safeParse(this.config.read_authorization).success || this.config.read_authorization.project_id !== this.config.project_id || this.config.storage.project_id !== this.config.project_id || Date.parse(this.config.read_authorization.expires_at) <= Date.now()) problem('SOURCE_AUTH', 403, 'Source access needs attention.');
  }
  private async request(suffix: string, maximum: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (signal?.aborted) problem('SOURCE_UNAVAILABLE', 503, 'Artifacts could not be reached.', true);
    this.assertAuthorized();
    const grant = this.config.read_authorization;
    if (this.requests + 1 > grant.max_requests || this.bytes + maximum > grant.max_bytes) problem('READ_SESSION_LIMIT', 403, 'Read session limit reached.');
    this.requests++; this.bytes += maximum; // reserve before credential/provider dispatch
    if (this.budget) await this.budget.reserve(maximum);
    this.assertAuthorized();
    if (signal?.aborted) problem('SOURCE_UNAVAILABLE', 503, 'Artifacts could not be reached.', true);
    const timeout = AbortSignal.timeout(Math.min(grant.timeout_ms, Date.parse(grant.expires_at) - Date.now()));
    const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const token = await Promise.race([this.credential(), new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new ExplorerError('SOURCE_UNAVAILABLE', 503, 'Artifacts could not be reached.', true)), { once: true }))]);
      if (!token || /[\r\n]/.test(token)) problem('SOURCE_AUTH', 403, 'Source access needs attention.');
      if (deadline.aborted) problem('SOURCE_UNAVAILABLE', 503, 'Artifacts could not be reached.', true);
      this.assertAuthorized();
      const s = this.config.storage;
      const response = await this.transport(`https://api.cloudflare.com/client/v4/accounts/${s.account}/artifacts/namespaces/${encodeURIComponent(s.namespace)}/repos/${encodeURIComponent(s.repository)}${suffix}`, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: suffix ? 'application/octet-stream' : 'application/json' }, signal: deadline, redirect: 'manual' });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); problem('SOURCE_AUTH', 403, 'Source access needs attention.'); }
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); problem('SOURCE_UNAVAILABLE', 503, 'Artifacts could not be reached.', true); }
      const reader = response.body?.getReader(); if (!reader) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maximum) problem('CORRUPT_DATA', 422, 'Project records could not be verified.'); chunks.push(next.value); } }
      finally { await reader.cancel(); }
      this.assertAuthorized();
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) { if (error instanceof ExplorerError) throw error; return problem('SOURCE_UNAVAILABLE', 503, 'Artifacts could not be reached.', true); }
  }
  private async identity(signal?: AbortSignal) {
    const bytes = await this.request('', 65536, signal);
    if (!bytes) problem('SOURCE_BINDING', 403, 'Project source does not match.');
    const data = safeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes!), 65536), s = this.config.storage;
    if (this.expectedRepositoryId && data.result?.id !== this.expectedRepositoryId) problem('SOURCE_BINDING', 403, 'Project source does not match the approved repository identity.');
    if (data.success !== true || data.result?.name !== s.repository || data.result?.remote !== `https://${s.account}.artifacts.cloudflare.net/git/${s.namespace}/${s.repository}.git`) problem('SOURCE_BINDING', 403, 'Project source does not match.');
  }
  private async file(locator: ArtifactLocator, signal?: AbortSignal) {
    checkLocator(locator, locator.hash, locator.path.endsWith('.json') ? 'json' : 'bin', locator.path.endsWith('.json') ? LIMITS.recordBytes : ASSET_LIMITS.bytes);
    const bytes = await this.request(`/file?ref=${locator.ref}&path=${locator.path}`, locator.size_bytes!, signal);
    if (bytes && (bytes.byteLength !== locator.size_bytes || bytesDigest(bytes) !== locator.hash)) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
    return bytes;
  }
  async getManyAt(locators: ArtifactLocator[], signal?: AbortSignal) {
    // Validate all input addresses before even the repository identity request.
    for (const l of locators) checkLocator(l, l.hash, 'json', LIMITS.recordBytes);
    await this.identity(signal); const output: (string | null)[] = [];
    for (const l of locators) { const b = await this.file(l, signal); try { output.push(b === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(b)); } catch { problem('CORRUPT_DATA', 422, 'Project records could not be verified.'); } }
    return output;
  }
  async getBytesAt(locator: ArtifactLocator, signal?: AbortSignal) { checkLocator(locator, locator.hash, 'bin', ASSET_LIMITS.bytes); await this.identity(signal); return this.file(locator, signal); }
}
