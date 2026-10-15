import { z } from 'zod';
import { CONTENT_MODEL, MODEL } from '../model.js';

export const API_VERSION = 'explorer-read/1';
export const LIMITS = Object.freeze({ registryBytes: 8 * 1024 * 1024, records: 1000, jsonBytes: 16 * 1024 * 1024, recordBytes: 8 * 1024 * 1024, blocks: 1000, responseBytes: 2 * 1024 * 1024, queryBytes: 8192, bodyBytes: 1024 });
export const READ_ROUTES = ['connection', 'records', 'record', 'blocks', 'block', 'relations', 'evaluation', 'diff'] as const;
export const RECORD_TYPES = ['release', 'layer', 'composition', 'resolution', 'approval', 'validation', 'realization', 'authoring-review', 'asset'] as const;
export type RecordType = typeof RECORD_TYPES[number];
const key = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/);
export const storageSchema = z.object({ format: z.literal('strata-artifacts-registry/1'), project_id: key, account: z.string().regex(/^[a-f0-9]{32}$/), namespace: key, repository: key, mode: z.literal('remote') }).strict();
export const grantSchema = z.object({ project_id: key, principal: key, policy_generation: key, expires_at: z.string().datetime(), full_registry_read: z.literal(true), operations: z.tuple([z.literal('repository.info'), z.literal('file.read')]), max_requests: z.number().int().min(1).max(5000), max_bytes: z.number().int().min(1).max(40 * 1024 * 1024), timeout_ms: z.number().int().min(100).max(10000) }).strict();
export const connectionSchema = z.object({ format: z.literal('strata-explorer-connection/1'), connection_id: key, project_id: key, display_name: z.string().min(1).max(128), model_version: z.enum([MODEL, CONTENT_MODEL]), registry_path: z.string().min(1), registry_kind: z.enum(['fixed-snapshot', 'atomic-publication-index']), storage: storageSchema, auth_provider: z.object({ kind: z.literal('existing-environment'), variable: z.string().regex(/^(?:STRATA_EXPLORER_[A-Z0-9_]+|CLOUDFLARE_API_TOKEN)$/) }).strict(), reader_policy: z.literal('published-project-reader'), initial_release_ref: z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).optional(), read_authorization: grantSchema }).strict();
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type ReadGrant = z.infer<typeof grantSchema>;
export type SourceInfo = { mode: 'sample' | 'artifacts-remote' | 'local-broker'; registry_kind: 'fixed-snapshot' | 'atomic-publication-index' | 'synthetic-fixture'; registry_generation: string; verified_at: string; freshness: 'current-generation' | 'fixed-snapshot' | 'stale-network'; semantic_trust: 'local-fixture'|'host-authenticated'|'legacy-history-authenticated-authoring' };
export class ExplorerError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly retryable = false) { super(message); }
}
export function problem(code: string, status: number, message: string, retryable = false): never { throw new ExplorerError(code, status, message, retryable); }
export function safeJson(text: string, maximum = LIMITS.registryBytes): any {
  if (Buffer.byteLength(text) > maximum) problem('READ_LIMIT', 413, 'This project exceeds the current Studio read limit.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { return problem('CORRUPT_DATA', 422, 'Project records could not be verified.'); }
  const stack = [{ value: data, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 200000 || depth > 32) problem('READ_LIMIT', 413, 'This project exceeds the current Studio read limit.');
    if (value && typeof value === 'object') for (const [k, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) problem('CORRUPT_DATA', 422, 'Project records could not be verified.');
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return data;
}
