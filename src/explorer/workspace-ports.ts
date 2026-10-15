import type { ArtifactBinary, ArtifactCleanupCounts, ArtifactIdentity, ArtifactLocator, ArtifactObject } from '../artifacts.js';

// Trusted server ports, never parsed from browser input. A reservation admits one
// dispatch only; persisted IDs are evidence, not replayable dispatch capabilities.
export type WorkspaceDispatchKind = 'repository.info' | 'file.read' | 'token.issue' |
  'git.discover' | 'git.immutable-batch' | 'token.revoke-owned';
export interface WorkspaceAuthorityLease {
  readonly operation_id: string;
  readonly signal: AbortSignal;
  refresh(): Promise<void>;
  assertSync(phase: string): void;
}
export interface WorkspaceIoReservations {
  reserve(id: string, operation: string, kind: WorkspaceDispatchKind, maximumBytes: number): Promise<void>;
}
export type WorkspaceStagePhase = 'prepared' | 'reserved' | 'token_issue_unknown' | 'token_owned' |
  'push_unknown' | 'stage_verified' | 'cleanup_unconfirmed' | 'publication_prepared' |
  'committed' | 'cancelled_before_effect' | 'reconciliation_required';
export interface WorkspaceStageJournal {
  record(phase: WorkspaceStagePhase, detail: Record<string, unknown>): Promise<void>;
}
export interface ArtifactBatchPort {
  identity(project: string): ArtifactIdentity;
  managementCleanupCounts(): ArtifactCleanupCounts;
  getManyAt(locators: ArtifactLocator[]): Promise<(string | null)[]>;
  getBytesAt(locator: ArtifactLocator): Promise<Uint8Array | null>;
  putBatch(objects: ArtifactObject[], binary?: ArtifactBinary[]): Promise<{
    commit: string; branch: string; reused: boolean; locators: ArtifactLocator[];
  }>;
}
