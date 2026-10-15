import { digest, StrataError } from './model.js';
import { LocalBuildOutput, type OutputRootReceipt } from './build-output.js';
import type { EnvironmentRequirement } from './build-contracts.js';

export type HostEnvironment = {
  label: string; os: string; arch: string; node_version: string | null;
  toolchains: ReadonlyArray<{ id: string; version: string }>;
  runner: { id: string; profile_ids: readonly string[] } | null;
};
export type HostBlocker = { code: string; required: string; observed: string | null };
export type LocalHostReport = {
  format: 'strata-local-build-host/1'; host: HostEnvironment; slot_id: string; slot_label: string;
  requirements: EnvironmentRequirement[]; blockers: HostBlocker[]; output: OutputRootReceipt | null;
  materialize: boolean; verify: boolean; run_application: false; serve_application: false; fingerprint: string;
};
/** Inspect the running Studio process, never a repository/PATH-selected executable. */
export function currentBuildHost(label: string, runner: HostEnvironment['runner']): HostEnvironment {
  return { label, os: process.platform, arch: process.arch, node_version: process.version,
    toolchains: [{ id: 'strata-node', version: process.version }], runner };
}
export async function preflightLocalHost(host: HostEnvironment, output: LocalBuildOutput, requirements: EnvironmentRequirement[]): Promise<LocalHostReport> {
  const blockers: HostBlocker[] = [];
  const block = (code: string, required: string, observed: string | null) => blockers.push({ code, required, observed });
  if (!['linux', 'win32'].includes(host.os)) block('TARGET_OS_INCOMPATIBLE', 'linux or win32 Studio host', host.os);
  if (!['x64', 'arm64'].includes(host.arch)) block('TARGET_ARCH_INCOMPATIBLE', 'x64 or arm64', host.arch);
  const version = host.node_version?.match(/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  if (host.node_version === null) block('HOST_RUNTIME_MISSING', 'Node >=22', null);
  else if (!version || Number(version[1]) < 22) block('HOST_RUNTIME_VERSION_UNSUPPORTED', 'Node >=22 stable', host.node_version);
  if (!host.toolchains.some(t => t.id === 'strata-node' && t.version === host.node_version)) block('TOOLCHAIN_MISSING', 'installed Strata Node toolchain matching host runtime', null);
  if (!host.runner?.profile_ids.includes('collection-host/1')) block('RUNNER_UNAVAILABLE', 'configured finite collection-host/1 runner', null);
  for (const r of requirements) if (r.kind !== 'runtime' || r.id !== 'node' || !r.version || !('min_major' in r.version) || r.version.min_major !== 22 || r.allowed_values !== null || !((r.subject === 'host' && ['build', 'verify'].includes(r.stage)) || (r.subject === 'target' && r.stage === 'run'))) block('ENVIRONMENT_REQUIREMENT_UNSUPPORTED', r.source_ref + ':' + r.id, null);
  let receipt: OutputRootReceipt | null = null;
  try { receipt = await output.preflight(); }
  catch (e) { block(e instanceof StrataError ? e.code : 'OUTPUT_ROOT_UNAVAILABLE', 'protected configured output root', null); }
  const materialize = !blockers.some(b => b.code !== 'RUNNER_UNAVAILABLE');
  const body = { format: 'strata-local-build-host/1' as const, host, slot_id: output.slot.id, slot_label: output.slot.label,
    requirements, blockers, output: receipt, materialize, verify: materialize && !blockers.length, run_application: false as const, serve_application: false as const };
  return { ...body, fingerprint: digest(body) };
}
