import path from 'node:path';
import { z } from 'zod';
import { fail } from '../model.js';
import { unixOutputProtection } from '../build-output.js';
import { namespaceBuildOutput, type NamespaceLocalBuildConfiguration } from './namespace-build.js';

const absolute = z.string().min(1).max(4096).refine(p => path.isAbsolute(p) && path.resolve(p) === p);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
/** Trusted installation input only. No executable, UID, credential or recovery
 * selector is configurable here. Linux uses the running service identity.
 */
export const namespaceLocalBuildHostSchema = z.object({
  format: z.literal('strata-namespace-local-build-host/1'),
  repository_ids: z.array(id).min(1).max(64).refine(ids => new Set(ids).size === ids.length),
  output: z.object({ id, label: z.string().min(1).max(128), root: absolute,
    excluded_roots: z.array(absolute).min(1).max(128) }).strict(),
}).strict();
export type NamespaceLocalBuildHostConfig = z.infer<typeof namespaceLocalBuildHostSchema>;

export function namespaceLocalBuildInstallation(value: unknown, protectedRoots: readonly string[]): NamespaceLocalBuildConfiguration {
  const config = namespaceLocalBuildHostSchema.parse(value);
  if (process.platform !== 'linux') fail('OUTPUT_PROTECTION_UNSUPPORTED', 8, 'The namespace launcher Local Build slot currently requires Linux native service custody.');
  const configuration = { repository_ids: config.repository_ids,
    output: { ...config.output, protection: unixOutputProtection() } };
  // Validate inventory at composition time; preflight later qualifies existing
  // storage. Neither construction nor Prepare creates the output root.
  namespaceBuildOutput(configuration, protectedRoots);
  return configuration;
}
