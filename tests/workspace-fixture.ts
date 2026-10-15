import { randomUUID } from 'node:crypto';
import { MODEL, digest } from '../src/model.js';
import { DEFAULT_WORKSPACE_LIMITS, repositoryGrantSchema, WORKSPACE_PROVIDER_OPERATIONS } from '../src/explorer/workspace-policy.js';
import type { RepositoryGrant } from '../src/explorer/workspace-policy.js';
export function workspaceGrant():RepositoryGrant { return repositoryGrantSchema.parse({
  format:'strata-studio-repository-grant/1',installation_id:randomUUID(),owner_id:randomUUID(),lineage_id:randomUUID(),
  grant_id:randomUUID(),policy_generation:1,issued_at:'2026-01-01T00:00:00Z',not_before:'2026-01-01T00:00:00Z',
  lifetime:{mode:'until-revoked',expires_at:null},project_id:'workspace-test',model_version:MODEL,
  storage:{account:'1'.repeat(32),namespace:'bounded-test',repository:'workspace-test',expected_repository_id:'immutable-test-id',
    remote:'https://'+'1'.repeat(32)+'.artifacts.cloudflare.net/git/bounded-test/workspace-test.git'},
  import_manifest_sha256:digest('synthetic-import'),actor_binding_sha256:digest('synthetic-actor'),credential_id:'artifacts-api-token',
  access:'read-write',provider_operations:[...WORKSPACE_PROVIDER_OPERATIONS],limits:{...DEFAULT_WORKSPACE_LIMITS},
}); }
export const carriedUsage=()=>({format:'strata-studio-budget-carry/1' as const,old_lineage_sha256:digest('retained-old-lineage'),reserved_requests:12,reserved_bytes:393020});
