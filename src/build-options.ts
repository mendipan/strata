import { digest, fail } from './model.js';
import { profileFor } from './profiles.js';
import type { ProfileAdapter } from './profile-types.js';
import type { BuildChoices, EnvironmentRequirement } from './build-contracts.js';

export type BuildOptions = {
  format: 'strata-build-options/1'; materializer_id: string; archive_sha256: string;
  choices: BuildChoices; options: readonly []; scope: 'whole-output'; requirements: EnvironmentRequirement[];
  destinations: readonly ['local']; output_layout: 'flat-text'; run_application: false; serve_application: false;
};
/** Metadata beside the compiled adapter. It never enters archive() or alters files. */
export function describeBuildOptions(adapter: ProfileAdapter): BuildOptions {
  const registered = profileFor(adapter.id);
  if (adapter !== registered || adapter.id !== 'collection-host/1') fail('UNSUPPORTED_BUILD_OPTIONS', 8, 'No reviewed build-choice mapping exists for this exact compiled materializer.', { id: adapter.id });
  const archive_sha256 = digest(adapter.archive());
  const node = (stage: 'build' | 'verify' | 'run', subject: 'host' | 'target'): EnvironmentRequirement => ({
    stage, subject, kind: 'runtime', id: 'node', version: { min_major: 22 }, allowed_values: null, source_ref: 'collection-host@1'
  });
  return {
    format: 'strata-build-options/1', materializer_id: adapter.id, archive_sha256,
    choices: { language: 'javascript', framework: 'none', runtime: 'node' }, options: [], scope: 'whole-output',
    requirements: [node('build', 'host'), node('verify', 'host'), node('run', 'target')],
    destinations: ['local'], output_layout: 'flat-text', run_application: false, serve_application: false
  };
}
