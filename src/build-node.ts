import { hostRunner } from './auth/runner.js';
import type { Engine } from './core.js';
import type { SecurityContext } from './security.js';
import { LocalBuildOutput, type OutputAllocation } from './build-output.js';
import { digest, fail } from './model.js';

/** Private runner seam for S3. Invoke only inside authorized evidence.run dispatch;
 * that dispatch must supply its Engine auth receipt and persist the measured host-run.
 * It preserves existing static slots and does not add client path/command fields.
 */
export async function runLocalBuildChecks(output: LocalBuildOutput, engine: Engine, context: SecurityContext, input: {
  build_id: string; target: string; profile: 'collection-host/1'; allocation: OutputAllocation
}) {
  if (!/^[a-f0-9]{64}$/.test(input.build_id) || input.profile !== 'collection-host/1' || input.allocation.relative.split(/[\\/]/).at(-1) !== input.build_id) fail('OUTPUT_LOCATOR_INVALID', 4, 'Runner output must belong to this exact build.');
  await output.directory(input.allocation);
  const slot = 'build-' + digest({ build: input.build_id, allocation: input.allocation });
  return hostRunner(output.slot.root, { [slot]: input.allocation.relative }, ['collection-host/1'])(engine, { target: input.target, slot, profile: input.profile }, context);
}
