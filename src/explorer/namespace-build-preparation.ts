import { z } from 'zod';
import { Engine } from '../core.js';
import { BLOCK_MODEL, canonical, digest, fail } from '../model.js';
import { BUILD_OPERATIONS } from '../build-operations.js';
import { PROFILE_OPERATIONS, contractContext, exactBuildRecord, profileInput, verifyBuildHistory } from '../build-records.js';
import { buildPinSchema } from '../build-contracts.js';
import { inspectReleasePublication } from '../build-publication.js';
import { resolveBuildProfile } from '../build-compatibility.js';
import { HostIssuer, policyStoreV4Schema } from '../auth/host-issuer.js';
import { namespaceManifestSchema } from './namespace-host.js';
import { namespaceProjectSchema } from './namespace-policy.js';
import { repositoryGrantSchema } from './workspace-policy.js';
import { validateWriterImport } from './workspace-import.js';
import { namespaceLocalBuildHostSchema } from './namespace-build-installation.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const namespaceBuildPreparationSchema = z.object({
  format: z.literal('strata-namespace-build-preparation/1'),
  source_genesis_sha256: hash, source_catalog_sha256: hash,
  source_grant: repositoryGrantSchema,
  proposed_manifest: namespaceManifestSchema,
  catalog_project: namespaceProjectSchema,
  launcher: namespaceLocalBuildHostSchema,
  release: buildPinSchema, contract: buildPinSchema, adoption: buildPinSchema, profile: buildPinSchema,
  actor_grant_id: z.string().min(1).max(256), reviewer_grant_id: z.string().min(1).max(256),
  acknowledge_grant_lifetimes: z.literal(true),
  max_build_starts: z.number().int().min(1).max(10),
  recovery: z.literal('authenticated-existing-actor'),
}).strict();

/** Pure, offline review packet. Accepts a separately proposed sealed snapshot;
 * never edits genesis, catalog, accounts, grants, cache, credentials or outputs.
 * Hashes are content bindings, not proof of operator approval or live custody.
 */
export function prepareNamespaceBuild(value: unknown) {
  const input = namespaceBuildPreparationSchema.parse(value), m = input.proposed_manifest,
    g = m.grant, p = input.catalog_project, repository = g.storage.expected_repository_id;
  if (g.model_version !== BLOCK_MODEL || !m.profiles || m.imported.format !== 'strata-studio-owner-snapshot/1')
    fail('WRITER_IMPORT_REQUIRED', 4, 'Preparation requires a separately sealed v0.3 snapshot with explicit Profiles authority.');
  const boundary = (grant: typeof g) => { const { import_manifest_sha256, actor_binding_sha256, ...rest } = grant; return rest; };
  if (canonical(boundary(g)) !== canonical(boundary(input.source_grant)))
    fail('BUILD_PREPARATION_SCOPE', 4, 'Preparation cannot widen or replace the existing repository/provider grant.');
  if (p.id !== repository || p.project_id !== g.project_id || p.name !== g.storage.repository || p.remote !== g.storage.remote || p.read_only ||
      p.state !== 'ready' || p.model_version !== BLOCK_MODEL || p.genesis_sha256 !== input.source_genesis_sha256 ||
      canonical(input.launcher.repository_ids) !== canonical([repository]))
    fail('BUILD_PREPARATION_SCOPE', 4, 'Preparation requires one exact existing writable repository and its original catalog genesis pin.');
  const policy = policyStoreV4Schema.parse(m.policy);
  if (policy.project_id !== g.project_id || digest({ accounts: m.accounts, policy }) !== g.actor_binding_sha256)
    fail('WRITER_IMPORT_REQUIRED', 4, 'Proposed actor policy differs from its sealed grant.');
  // Use the same stable-binding and single active person-to-owner checks as
  // the actual host exchange, without creating any authenticated session.
  const ownerBinding = new HostIssuer(m.accounts, policy).ownerBinding(g.installation_id, g.owner_id);
  const operations = [...PROFILE_OPERATIONS, ...BUILD_OPERATIONS, 'materialize', 'realization.register', 'evidence.run'];
  for (const grant of policy.grants) {
    if (grant.operations.includes('build.reconcile') || grant.revalidation ||
        grant.operations.some(op => [...PROFILE_OPERATIONS, ...BUILD_OPERATIONS].includes(op as any)) &&
        (canonical(grant.build_repository_ids) !== canonical([repository]) || canonical(grant.profiles) !== canonical(['collection-host/1'])))
      fail('BUILD_PREPARATION_SCOPE', 4, 'Profile/Build grants must name only this repository and collection-host/1; unattended recovery and revalidation are excluded.');
  }
  const actor = policy.grants.find(a => a.grant_id === input.actor_grant_id), reviewer = policy.grants.find(a => a.grant_id === input.reviewer_grant_id);
  if (!actor || !reviewer || actor.principal_id !== ownerBinding.principal_id || reviewer.principal_id !== ownerBinding.principal_id ||
      operations.some(op => !actor.operations.includes(op as any)) || !reviewer.approvals.includes('release') ||
      ['repository.contract.import', 'repository.contract.attach'].some(op => !reviewer.operations.includes(op as any)))
    fail('BUILD_PREPARATION_AUTHORITY', 4, 'Explicit existing owner actor operations and Release-review authority are required.');
  const { records, assetBytes } = validateWriterImport(m.imported, g);
  // Namespace admission also refuses cross-repository supporting history.
  if (Object.values(records).some(r => r.data.repository_id && r.data.repository_id !== repository))
    fail('BUILD_PREPARATION_SCOPE', 4, 'Supporting history belongs to another repository.');
  verifyBuildHistory(records, g.project_id);
  const authority = records[m.profiles.authority_ref];
  if (!authority?.published || authority.type !== 'release' || !authority.data.authorities.release.includes(reviewer.principal_id))
    fail('BUILD_PREPARATION_AUTHORITY', 4, 'The exact retained Profiles authority must assign the proposed reviewer.');
  const publication = inspectReleasePublication({ project_id: g.project_id, records, asset_bytes: assetBytes, source_trust: 'host-authenticated' }, input.release.ref);
  if (!publication.historically_approved || publication.release?.sha256 !== input.release.sha256)
    fail('BUILD_PREPARATION_RELEASE', 6, 'The exact approved Release and complete publication closure are required.');
  const context = contractContext(records, g.project_id, repository, input.contract),
    adoption = exactBuildRecord(records, input.adoption, 'release-build-binding'),
    profile = exactBuildRecord(records, input.profile, 'build-profile');
  if (adoption.project_id !== g.project_id || adoption.repository_id !== repository || adoption.provenance !== 'post_publication_adoption' ||
      canonical(adoption.release) !== canonical(input.release) || canonical(adoption.contract) !== canonical(input.contract) ||
      profile.project_id !== g.project_id || profile.repository_id !== repository || profile.contract_ref !== input.contract.ref || profile.contract_sha256 !== input.contract.sha256 ||
      profile.materializer.id !== 'collection-host/1' || Object.values(records).some(r => r.type === 'build-profile-archive' &&
        r.data.project_id === g.project_id && r.data.repository_id === repository && records[r.data.profile.ref]?.data.id === profile.id))
    fail('BUILD_PREPARATION_PINS', 6, 'Release, reviewed adoption, contract and active finite profile must form one exact tuple.');
  const engine = new Engine(records, {}, { projectId: g.project_id, modelVersion: BLOCK_MODEL, assetBytes, historical: true, checkerBackend: 'node' }),
    compatibility = resolveBuildProfile(context, profileInput(profile), { engine, ref: input.release.ref });
  if (!compatibility.report.repository_valid || !compatibility.report.materialization_supported)
    fail('BUILD_PREPARATION_PROFILE', 8, 'The exact tuple is unsupported by collection-host/1.');
  const body = { format: 'strata-namespace-build-inactive-packet/1', inactive: true, activation_authorized: false,
    expected_source: { genesis_sha256: input.source_genesis_sha256, catalog_sha256: input.source_catalog_sha256 },
    proposed_manifest: m, proposed_genesis_sha256: digest(m), proposed_catalog_project: { ...p, genesis_sha256: digest(m) },
    namespace_local_build: input.launcher,
    tuple: { release: input.release, contract: input.contract, adoption: input.adoption, profile: input.profile },
    actor: { principal_id: actor.principal_id, grant_id: actor.grant_id, operations: actor.operations, lifetime: actor.lifetime },
    reviewer: { principal_id: reviewer.principal_id, grant_id: reviewer.grant_id, lifetime: reviewer.lifetime },
    limits: { max_build_starts: input.max_build_starts, start_count_enforcement: 'operator-session' as const,
      provider: g.limits, run_application: false, serve_application: false },
    recovery: input.recovery, startup_recovery_configured: false, compatibility: compatibility.report,
    remaining_gates: ['immutable-code-and-packet-approval', 'stopped-writer-source-CAS-and-separate-lineage-installation',
      'native-Linux-output-custody-and-runtime-qualification', 'owner-sign-in-and-exact-session-run-authorization',
      'recovery-operation-authority-if-retained-attempts-exist'],
  };
  return { ...body, packet_sha256: digest(body) };
}
