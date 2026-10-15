import path from 'node:path';
import { z } from 'zod';
import { digest } from '../model.js';
import { connectionSchema, ExplorerError, problem, type ConnectionConfig } from './contract.js';
import { privateDir, readPrivate, withLease, writePrivate } from './owner-files.js';

// This port reserves an entire declared response before any credential access.
// It does not issue a grant, refund failed reads, initialize or reset a ledger.
export interface ReadBudgetReservations { reserve(maximumBytes: number): Promise<void> }
const ledgerSchema = z.object({
  format: z.literal('strata-studio-read-budget/1'),
  binding_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reserved_requests: z.number().int().min(0).max(5000),
  reserved_bytes: z.number().int().min(0).max(40 * 1024 * 1024),
}).strict();
// Operator validation can inspect accounting without constructing a writer or
// reading any credential. Keep one schema for runtime and transition checks.
export { ledgerSchema as readBudgetSchema };
const repositoryId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

// Pure operator preparation only. The service never calls this to create state.
export function initialReadBudget(connection: ConnectionConfig, expectedRepositoryId: string) {
  const config = connectionSchema.parse(connection);
  const id = repositoryId.parse(expectedRepositoryId);
  return ledgerSchema.parse({ format: 'strata-studio-read-budget/1',
    binding_sha256: digest({ connection: config, expected_repository_id: id }),
    reserved_requests: 0, reserved_bytes: 0 });
}
function unavailable(): never {
  return problem('READ_BUDGET_UNAVAILABLE', 503, 'Protected read accounting needs authenticated operator reconciliation.');
}
export class FileReadBudget implements ReadBudgetReservations {
  private readonly binding: string;
  private readonly config: ConnectionConfig;
  private readonly directory: string;
  constructor(private readonly filename: string, connection: ConnectionConfig, expectedRepositoryId: string) {
    if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) unavailable();
    this.directory = path.dirname(filename);
    this.config = structuredClone(connectionSchema.parse(connection));
    this.binding = initialReadBudget(this.config, expectedRepositoryId).binding_sha256;
  }
  private authorized() {
    if (this.config.storage.project_id !== this.config.project_id ||
        this.config.read_authorization.project_id !== this.config.project_id ||
        Date.parse(this.config.read_authorization.expires_at) <= Date.now())
      problem('SOURCE_AUTH', 403, 'Source access needs attention.');
  }
  private async read() {
    const parsed = ledgerSchema.safeParse(await readPrivate(this.filename, 1024));
    const grant = this.config.read_authorization;
    if (!parsed.success || parsed.data.binding_sha256 !== this.binding ||
        parsed.data.reserved_requests > grant.max_requests || parsed.data.reserved_bytes > grant.max_bytes) unavailable();
    return parsed.data;
  }
  private async protectedOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await privateDir(this.directory);
      return await withLease(this.directory, operation);
    } catch (error) {
      if (error instanceof ExplorerError && ['SOURCE_AUTH', 'READ_SESSION_LIMIT'].includes(error.code)) throw error;
      return unavailable();
    }
  }
  // Readiness is verified without creating state, reading secrets or dispatching.
  async ready() { await this.protectedOperation(async () => { await this.read(); }); }
  async reserve(maximumBytes: number) {
    this.authorized();
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) unavailable();
    await this.protectedOperation(async () => {
      this.authorized();
      const ledger = await this.read(), grant = this.config.read_authorization;
      if (ledger.reserved_requests + 1 > grant.max_requests || ledger.reserved_bytes + maximumBytes > grant.max_bytes)
        problem('READ_SESSION_LIMIT', 403, 'Read session limit reached.');
      // Durable replacement (file fsync, atomic rename, directory fsync) finishes
      // before release of the exclusive lease and before credentials/provider.
      await writePrivate(this.filename, { ...ledger,
        reserved_requests: ledger.reserved_requests + 1, reserved_bytes: ledger.reserved_bytes + maximumBytes });
    });
  }
}
