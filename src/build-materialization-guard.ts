import { digest, fail, type Records } from './model.js';
import { describeBuildOptions } from './build-options.js';
import { profileFor } from './profiles.js';
import { assertRepositoryChoices } from './build-compatibility.js';
import { contractContext, verifyBuildHistory } from './build-records.js';

// Attached policy is enforced even through raw materialize/register calls. Unbound
// historical inputs retain their existing behavior; no archive bytes are changed.
export function assertBoundReleaseMaterializer(records: Records, project: string | undefined, target: string, materializer: string) {
  if (records[target]?.type !== 'release') return;
  const bindings = Object.values(records).filter(r => r.type === 'release-build-binding' && r.data?.release?.ref === target);
  if (!bindings.length) return;
  if (!project) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Bound materialization requires admitted project identity.');
  verifyBuildHistory(records, project);
  if (bindings.length !== 1 || !bindings[0].published) fail('BUILD_BINDING_CONFLICT', 5, 'Release has an inconsistent adoption binding.');
  const b = bindings[0].data;
  if (b.release.sha256 !== digest(records[target].data)) fail('BUILD_PIN_MISMATCH', 6, 'Adoption does not bind exact historical Release bytes.');
  const context = contractContext(records, project, b.repository_id, b.contract);
  // Unknown actual choice mappings refuse; the saved profile cannot invent them.
  assertRepositoryChoices(context, describeBuildOptions(profileFor(materializer)).choices);
}
