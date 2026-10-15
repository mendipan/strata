import { CONTENT_MODEL, canonical, digest, fail } from './model.js';
import type { Evaluation } from './core.js';
import { profiles, profileFor } from './profiles.js';
import { treeDigest, type Realization } from './profile-types.js';
export { treeDigest } from './profile-types.js';
export type { Coverage, Realization, FixtureOracle } from './profile-types.js';
export { profileFor, evaluateScenario, defaultProfileForScenario, selectionEvaluator } from './profiles.js';
// Existing example imports remain available; core uses only the generic contract above.
export { PROFILE, CONTENT_PROFILE, BOUND_PROFILE, BOUND_CONTENT_PROFILE, EXPECTED_PURPOSES, EXCLUSIVE, CONTRACTS, expiryRequirement, timingRequirement } from './profiles/booking.js';

export const PROFILE_IDS = profiles.map(p => p.id);
export const boundProfile = (id: string) => profileFor(id).boundEvidence;
export const compatibleProfile = (id: string, model: string) => profiles.some(p => p.id === id && p.models.includes(model));
export const profileArchive = (id: string) => profileFor(id).archive();
export const profileFingerprint = (id: string) => digest(profileArchive(id));

export function materialize(target: string, evaluation: Evaluation, profileId: string): Realization {
  const adapter = profileFor(profileId);
  if (!adapter.models.includes(evaluation.snapshot.model_version)) fail('UNSUPPORTED_PROFILE', 8, 'Profile must support the explicit target model.');
  // Rebuild the item set from the snapshot, independently of the derived obligations.
  const expected: Record<string, unknown> = {};
  for (const block of Object.values(evaluation.snapshot.blocks)) {
    expected[block.id + '/purpose'] = block.purpose;
    for (const collection of ['requirements', 'acceptance', 'relationships'] as const) for (const [key, value] of Object.entries(block[collection])) expected[block.id + '/' + collection + '.' + key] = value;
    for (const collection of ['inputs', 'outputs', 'failures'] as const) for (const [key, value] of Object.entries(block.contract[collection])) expected[block.id + '/contract.' + collection + '.' + key] = value;
  }
  const actual = Object.fromEntries(evaluation.obligations.map(o => [o.item, o.value]));
  if (evaluation.obligations.length !== Object.keys(actual).length || canonical(expected) !== canonical(actual)) fail('OBLIGATION_CONSERVATION', 5, 'Materialization must retain every snapshot obligation exactly once.');
  const result = adapter.materialize(target, evaluation);
  const items = result.coverage.map(c => c.item).sort();
  if (canonical(items) !== canonical(Object.keys(expected).sort())) fail('OBLIGATION_CONSERVATION', 5, 'Profile coverage must retain every active obligation exactly once.');
  return verifyRealization(result);
}

export function verifyRealization(input: unknown): Realization {
  if (!input || typeof input !== 'object') fail('INVALID_RECORD', 2, 'Realization manifest is required.');
  const realization = input as Realization;
  if (!compatibleProfile(realization.profile_id, realization.model_version) || realization.profile !== profileFingerprint(realization.profile_id) || !realization.files || realization.output_tree !== treeDigest(realization.files)) fail('STALE_REALIZATION', 6, 'Realization profile or output bytes are inconsistent.');
  const adapter = profileFor(realization.profile_id);
  if (realization.model_version === CONTENT_MODEL && (realization.asset_closure_sha256 !== digest(realization.asset_manifest ?? {}) || realization.files['assets.json'] !== canonical({ format: 'background-retention/1', asset_manifest: realization.asset_manifest, executable_resources: [] }) + '\n')) fail('STALE_REALIZATION', 6, 'Background retention manifest is inconsistent.');
  if (adapter.boundEvidence) {
    if (realization.format !== 'strata-realization/2' || !realization.oracle || realization.oracle.format !== adapter.checker.oracleFormat || realization.checker_sha256 !== adapter.checker.digest() || realization.oracle_sha256 !== digest(realization.oracle) || realization.fixture_sha256 !== adapter.checker.fixtureDigest(realization.oracle)) fail('STALE_CHECKER_EVIDENCE', 6, 'Realization must pin the current checker, fixture inputs and semantic oracle.');
  } else if (realization.format !== undefined || realization.checker_sha256 !== undefined || realization.fixture_sha256 !== undefined || realization.oracle_sha256 !== undefined || realization.oracle !== undefined) fail('INVALID_RECORD', 2, 'Legacy realization fields cannot be reinterpreted as bound evidence.');
  for (const file of Object.keys(realization.files)) if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(file)) fail('INVALID_PATH', 2, 'Realization paths must be flat safe template files.');
  return realization;
}
