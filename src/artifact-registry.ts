import { type ArtifactCleanupCounts, type ArtifactIdentity, type ArtifactLocator, type ArtifactObject, type ArtifactBinary } from './artifacts.js';
import type { ArtifactBatchPort } from './explorer/workspace-ports.js';
import { ASSET_LIMITS, checkAssets } from './assets.js';
import { assetDescriptorSchema, bytesDigest, canonical, fail, parse, type Records } from './model.js';

export type LocatedEntry = { hash: string; type: string; published: boolean; locator?: ArtifactLocator };
export type StorageBinding = ArtifactIdentity & { format: 'strata-artifacts-registry/1'; project_id: string };
export type LocatedRegistry = { entries: Record<string, LocatedEntry>; storage?: StorageBinding; asset_locators?: Record<string, ArtifactLocator> };
const MAX_RECORDS = 10000;

// Storage configuration is a trusted host object, never an operation-envelope field.
// The registry contains only durable, exact-commit locators, never tokens or capabilities.
export class ArtifactRegistryStore {
  constructor(private readonly adapter: ArtifactBatchPort, readonly projectId: string) {}
  // New registry reader, same host-supplied adapter and cumulative allowance.
  // The adapter's read contract remains authoritative; no allowance is reset.
  freshReader() { return new ArtifactRegistryStore(this.adapter, this.projectId); }
  binding(): StorageBinding { return { format: 'strata-artifacts-registry/1', project_id: this.projectId, ...this.adapter.identity(this.projectId) }; }
  managementCleanupCounts(): ArtifactCleanupCounts { return this.adapter.managementCleanupCounts(); }
  assertBinding(registry: LocatedRegistry) {
    const binding = this.binding();
    if (registry.storage ? canonical(registry.storage) !== canonical(binding) : Object.keys(registry.entries).length > 0 || Object.keys(registry.asset_locators ?? {}).length > 0) fail('STORE_BINDING_MISMATCH', 4, 'Registry storage/project differs; automatic migration or local fallback is forbidden.');
    if (Object.keys(registry.entries).length > MAX_RECORDS) fail('STORE_UNAVAILABLE', 9, 'Artifact registry exceeds its record bound.');
  }
  private locator(locator: ArtifactLocator | undefined, hash: string, extension: 'json' | 'bin', maximum: number) {
    if (!locator || !/^[a-f0-9]{64}$/.test(hash) || locator.hash !== hash || locator.path !== hash + '.' + extension || !/^[a-f0-9]{40}$/.test(locator.ref) || !Number.isSafeInteger(locator.size_bytes) || locator.size_bytes! < 1 || locator.size_bytes! > maximum || Object.keys(locator).some(k => !['ref','path','hash','size_bytes'].includes(k))) fail('STORE_BINDING_MISMATCH', 4, 'Registry requires an exact commit/path/hash/size locator.');
    return locator;
  }
  async load(registry: LocatedRegistry) {
    this.assertBinding(registry);
    // Validate the complete locator envelope before any provider dispatch.
    for (const entry of Object.values(registry.entries)) {
      if (typeof entry.type !== 'string' || typeof entry.published !== 'boolean') fail('STORE_BINDING_MISMATCH', 4, 'Invalid registry entry.');
      this.locator(entry.locator, entry.hash, 'json', 8 * 1024 * 1024);
    }
    const assets = Object.entries(registry.asset_locators ?? {});
    if (assets.length > ASSET_LIMITS.versions || assets.reduce((n, [, l]) => n + (l.size_bytes ?? ASSET_LIMITS.retainedBytes + 1), 0) > ASSET_LIMITS.retainedBytes) fail('ASSET_QUOTA', 2, 'Retained asset locators exceed the bounded closure.');
    for (const [hash, locator] of assets) this.locator(locator, hash, 'bin', ASSET_LIMITS.bytes);
    const records: Records = {};
    const indexed = Object.entries(registry.entries);
    const texts = await this.adapter.getManyAt(indexed.map(([, entry]) => entry.locator!));
    for (const [position, [ref, entry]] of indexed.entries()) {
      const text = texts[position];
      if (text === null) fail('STORE_UNAVAILABLE', 9, 'Indexed remote record is missing; local fallback is forbidden.', { ref });
      let data: unknown; try { data = JSON.parse(text); } catch { fail('STORE_UNAVAILABLE', 9, 'Indexed remote record is invalid JSON.', { ref }); }
      if (canonical(data) !== text) fail('STORE_UNAVAILABLE', 9, 'Indexed remote record is not exact canonical JSON.', { ref });
      records[ref] = { type: entry.type, published: entry.published, data };
    }
    const descriptors = Object.values(records).filter(r => r.type === 'asset').map(r => parse(assetDescriptorSchema, r.data));
    if (canonical([...new Set(descriptors.map(d => d.content_sha256))].sort()) !== canonical(assets.map(([hash]) => hash).sort())) fail('ASSET_INTEGRITY', 6, 'Remote binary locator set differs from the exact retained descriptors.');
    const assetBytes = new Map<string, Uint8Array>();
    for (const [hash, locator] of assets) {
      const bytes = await this.adapter.getBytesAt(locator);
      if (bytes === null) fail('ASSET_NOT_FOUND', 3, 'Indexed remote binary asset is missing; local fallback is forbidden.');
      assetBytes.set(hash, bytes);
    }
    checkAssets(records, assetBytes, this.projectId);
    return { records, assetBytes };
  }
  async stage(records: Records, assetBytes: Map<string, Uint8Array>, previous: LocatedRegistry) {
    this.assertBinding(previous);
    if (Object.keys(records).length > MAX_RECORDS) fail('STORE_UNAVAILABLE', 9, 'Artifact registry exceeds its record bound.');
    checkAssets(records, assetBytes, this.projectId);
    const entries: LocatedRegistry['entries'] = {}, blobs: Record<string, ArtifactLocator> = {};
    const newRecords = new Map<string, ArtifactObject>(), newAssets = new Map<string, ArtifactBinary>();
    for (const [ref, record] of Object.entries(records)) {
      const bytes = canonical(record.data), hash = bytesDigest(bytes), old = previous.entries[ref];
      if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) fail('STORE_UNAVAILABLE', 9, 'Record exceeds its byte bound.');
      if (old && (old.hash !== hash || old.type !== record.type || (old.published && !record.published))) fail('IMMUTABLE_REFERENCE', 5, 'An indexed immutable record changed.', { ref });
      entries[ref] = { hash, type: record.type, published: record.published, ...(old ? { locator: this.locator(old.locator, hash, 'json', 8 * 1024 * 1024) } : {}) };
      if (!old) newRecords.set(hash, { hash, bytes });
      if (record.type === 'asset') {
        const d = parse(assetDescriptorSchema, record.data), oldBlob = previous.asset_locators?.[d.content_sha256];
        if (oldBlob) blobs[d.content_sha256] = this.locator(oldBlob, d.content_sha256, 'bin', ASSET_LIMITS.bytes);
        else newAssets.set(d.content_sha256, { hash: d.content_sha256, bytes: assetBytes.get(d.content_sha256)! });
      }
    }
    if (Object.keys(previous.entries).some(ref => !entries[ref])) fail('IMMUTABLE_REFERENCE', 5, 'Publication cannot drop retained immutable history.');
    const staged = newRecords.size || newAssets.size ? await this.adapter.putBatch([...newRecords.values()], [...newAssets.values()]) : null;
    const returned = new Map(staged?.locators.map(l => [l.path, l]) ?? []);
    for (const entry of Object.values(entries)) entry.locator ??= this.locator(returned.get(entry.hash + '.json'), entry.hash, 'json', 8 * 1024 * 1024);
    for (const hash of newAssets.keys()) blobs[hash] = this.locator(returned.get(hash + '.bin'), hash, 'bin', ASSET_LIMITS.bytes);
    return {
      entries, storage: this.binding(), asset_locators: blobs,
      receipt: staged ? { storage: this.binding(), commit: staged.commit, branch: staged.branch, reused: staged.reused, locators: staged.locators } : null
    };
  }
}
