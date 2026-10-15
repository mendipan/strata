import path from 'node:path';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentExecutionError, executionCanonical, sameExecutionValue } from '../agent-execution.js';
import { noLinks } from '../node-state.js';
import { digest, privateDir, readPrivate, withLease } from '../explorer/owner-files.js';
import type { CloudflareExecutionStorage, CloudflareExecutionTransaction } from './cloudflare-execution-journal.js';

const format = 'strata-local-execution-storage/1', filename = 'execution.json';
const maxBytes = 32 * 1024 * 1024, maxKeys = 1024;
const keySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_./:-]+$/)
  .refine(key => !['__proto__', 'constructor', 'prototype'].includes(key));
const bindingSchema = z.object({ role: z.enum(['host', 'service']),
  owner_id: z.string().min(1).max(256), connection_id: z.string().min(1).max(256) }).strict();
export type LocalExecutionStorageBinding = z.infer<typeof bindingSchema>;
export interface LocalExecutionStorageCustody {
  // REQUIRED on Windows. An independently configured host must check directory
  // ownership/ACLs and inherited file custody; Node mode bits cannot do so.
  assertWindowsCustody?: (directory: string) => Promise<void>;
}
const envelopeSchema = z.object({ format: z.literal(format), binding: bindingSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  values: z.record(keySchema, z.unknown()), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Envelope = z.infer<typeof envelopeSchema>;
function refuse(code: 'EXECUTION_PROTOCOL' | 'EXECUTION_INVALID' | 'EXECUTION_LIMIT' | 'EXECUTION_UNCONFIGURED' = 'EXECUTION_PROTOCOL'): never {
  throw new AgentExecutionError(code);
}

// This local port persists JSON journal values, not arbitrary structured-clone
// classes. Reject lossy serialization before staging any bytes.
function jsonValue(value: unknown): unknown {
  const stack = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const { value: child, depth } = stack.pop()!;
    if (++nodes > 200000 || depth > 32) refuse('EXECUTION_LIMIT');
    if (child === null || typeof child === 'string' || typeof child === 'boolean') continue;
    if (typeof child === 'number' && Number.isFinite(child)) continue;
    if (typeof child !== 'object' || !child ||
        (!Array.isArray(child) && Object.getPrototypeOf(child) !== Object.prototype && Object.getPrototypeOf(child) !== null)) refuse('EXECUTION_INVALID');
    if (Array.isArray(child) && Object.keys(child).length !== child.length) refuse('EXECUTION_INVALID');
    for (const [key, item] of Object.entries(child)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) refuse('EXECUTION_INVALID');
      stack.push({ value: item, depth: depth + 1 });
    }
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) refuse('EXECUTION_LIMIT');
  return JSON.parse(text);
}
function encode(binding: LocalExecutionStorageBinding, revision: number, values: Record<string, unknown>) {
  if (!Number.isSafeInteger(revision) || Object.keys(values).length > maxKeys) refuse('EXECUTION_LIMIT');
  const body = { format, binding, revision, values };
  jsonValue(body); // Aggregate node/depth bounds must survive reconstruction.
  const envelope = { ...body, sha256: digest(executionCanonical(body)) };
  jsonValue(envelope); // Include the checksum node in the reader's bound.
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) > maxBytes) refuse('EXECUTION_LIMIT');
  return text;
}
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return; // No Windows directory-fsync claim.
  const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Trusted local constructor only. One private directory per host/service and
 * owner/connection. Explicit provisioning, cooperative process exclusion, no
 * stale-lease stealing, no native calls or automatic journal initialization.
 */
export class LocalExecutionStorage implements CloudflareExecutionStorage {
  private readonly binding: LocalExecutionStorageBinding;
  private readonly windowsCustody?: (directory: string) => Promise<void>;
  readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(directory: string, binding: LocalExecutionStorageBinding, custody: LocalExecutionStorageCustody = {}) {
    if (!path.isAbsolute(directory)) refuse('EXECUTION_INVALID');
    const parsed = bindingSchema.safeParse(binding);
    if (!parsed.success) refuse('EXECUTION_INVALID');
    this.binding = structuredClone(parsed.data); this.directory = path.resolve(directory);
    this.windowsCustody = custody.assertWindowsCustody;
    if (process.platform === 'win32' && typeof this.windowsCustody !== 'function') refuse('EXECUTION_UNCONFIGURED');
  }
  private async custody() {
    await privateDir(this.directory);
    if (process.platform === 'win32') await this.windowsCustody!(this.directory);
  }
  private async entries(provision = false) {
    const entries = (await readdir(this.directory)).filter(name => name !== '.owner.lock');
    // Interrupted stage files remain quarantined for explicit reconciliation.
    if (entries.some(name => name !== filename)) refuse();
    if (provision && entries.length) throw new AgentExecutionError('EXECUTION_CONFLICT');
  }
  private async read(): Promise<Envelope> {
    const file = path.join(this.directory, filename);
    try {
      await noLinks(file);
      const meta = await lstat(file);
      if (meta.nlink !== 1 || (process.platform !== 'win32' && meta.uid !== process.getuid?.())) refuse();
      const parsed = envelopeSchema.safeParse(await readPrivate(file, maxBytes));
      if (!parsed.success) refuse();
      const { sha256, ...body } = parsed.data;
      if (!sameExecutionValue(body.binding, this.binding)) throw new AgentExecutionError('EXECUTION_BINDING');
      if (Object.keys(body.values).length > maxKeys || sha256 !== digest(executionCanonical(body))) refuse();
      jsonValue(body.values);
      return parsed.data;
    } catch (error) {
      if (error instanceof AgentExecutionError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse('EXECUTION_UNCONFIGURED');
      return refuse();
    }
  }
  private async publish(text: string, guards: Set<() => void>) {
    const target = path.join(this.directory, filename), temp = target + '.' + randomUUID();
    let created = false;
    try {
      const handle = await open(temp, 'wx', 0o600); created = true;
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await this.custody();
      // Same registered journal authority, checked AFTER asynchronous staging.
      // No event-loop yield between this fence and the sole publication point.
      for (const guard of guards) if (guard() !== undefined) refuse('EXECUTION_INVALID');
      renameSync(temp, target);
      syncDirectory(this.directory);
    } finally { if (created) await unlink(temp).catch(() => {}); }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 16) return Promise.reject(new AgentExecutionError('EXECUTION_LIMIT'));
    this.pending++;
    const result = this.tail.then(async () => {
      try {
        await this.custody();
        // Independent processes are excluded by the repository lease. A busy
        // or abandoned lease refuses; closures and provider calls never retry.
        return await withLease(this.directory, work);
      } catch (error) {
        if (error instanceof AgentExecutionError) throw error;
        throw new AgentExecutionError('EXECUTION_UNAVAILABLE');
      }
    });
    this.tail = result.catch(() => {});
    return result.finally(() => { this.pending--; });
  }
  /** Explicit trusted provisioning of a pre-created EMPTY private directory.
   * A separate journal.initializeEmpty() then provisions accepted /1 metadata.
   */
  provisionEmpty(): Promise<void> {
    return this.serial(async () => {
      await this.entries(true);
      await this.publish(encode(this.binding, 0, {}), new Set());
    });
  }
  transaction<T>(closure: (transaction: CloudflareExecutionTransaction) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.entries();
      const state = await this.read(), guards = new Set<() => void>();
      let active = true, dirty = false;
      const check = () => { if (!active) refuse('EXECUTION_INVALID'); };
      const tx: CloudflareExecutionTransaction = {
        beforeCommit: guard => { check(); if (typeof guard !== 'function') refuse('EXECUTION_INVALID'); guards.add(guard); },
        get: async <V>(key: string) => { check(); if (!keySchema.safeParse(key).success) refuse('EXECUTION_INVALID'); return structuredClone(state.values[key]) as V | undefined; },
        put: async <V>(key: string, value: V) => {
          check(); if (!keySchema.safeParse(key).success) refuse('EXECUTION_INVALID');
          state.values[key] = jsonValue(value); dirty = true;
          if (Object.keys(state.values).length > maxKeys) refuse('EXECUTION_LIMIT');
        },
        list: async <V>({ prefix, limit }: { prefix: string; limit: number }) => {
          check(); if (typeof prefix !== 'string' || prefix.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > maxKeys) refuse('EXECUTION_INVALID');
          return new Map(Object.keys(state.values).filter(key => key.startsWith(prefix)).sort().slice(0, limit)
            .map(key => [key, structuredClone(state.values[key]) as V]));
        },
      };
      let result: T;
      try { result = structuredClone(await closure(tx)); } finally { active = false; }
      if (dirty) await this.publish(encode(this.binding, state.revision + 1, state.values), guards);
      else for (const guard of guards) if (guard() !== undefined) refuse('EXECUTION_INVALID');
      return result;
    });
  }
}
