import { canonical, digest, type Records } from '../model.js';
import type { Engine } from '../core.js';
import type { SecurityContext } from '../security.js';

export interface WorkspaceBrokerOperation {
  verifyPreparedRecords(records:Records):void;
  load(registry: unknown): Promise<{ records: Records; assetBytes: Map<string, Uint8Array> }>;
  refresh(): Promise<void>;
  assertSync(phase: string): void;
  provenance(before: unknown, next: unknown, result: unknown): Promise<unknown>;
  committed(next: unknown, result: unknown): Promise<void>;
  failed(renamed: boolean, error: unknown): Promise<void>;
  close(): void;
}
export interface WorkspaceBrokerControls {
  status(context:SecurityContext,key:string):Promise<unknown>;
  begin(context: SecurityContext, command: string, input: unknown, key: string | undefined,
    operationId: string, registry: unknown, signal:AbortSignal, dryRun:boolean): Promise<WorkspaceBrokerOperation>;
  beforeRenameForTest?: () => Promise<void>;
  directorySyncForTest?: () => void;
}
// Receipt and audit are deliberately outside this hash domain. Requests/results
// do not contain the receipt or its after hash, so provenance is nonrecursive.
export function registryPayloadDigest(value: unknown) {
  const v = value as Record<string, unknown>;
  return digest({ format: 'strata-studio-registry-payload/1', entries: v.entries,
    storage: v.storage ?? null, asset_locators: v.asset_locators ?? {}, heads: v.heads,
    contexts: v.contexts ?? {}, requests: v.requests });
}
export function verifiedRegistryText(value: unknown) { return canonical(value); }
