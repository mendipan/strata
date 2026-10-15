import type { Evaluation } from './core.js';
import type { Composition, Layer, Snapshot } from './model.js';
import { digest, bytesDigest } from './model.js';

export type CheckDefinition = { check: string; version: string; fixture: string; method: 'mechanical' | 'review' };
export type FixtureOracle = { format: string; snapshot_sha256: string; expected: Record<string, unknown>; criteria: CheckDefinition[] };
export type Coverage = { item: string; facets: string[]; subjects: string[]; status: 'implemented_validation_pending'; capability: string; rationale: string; outputs: { path: string; digest: string }[]; checks: { check: string; version: string; fixture: string; method: string }[]; facet_handling: Record<string, string> };
export type Realization = { protocol_version: '1'; model_version: string; target: string; candidate: string; profile_id: string; profile: string; output_tree: string; files: Record<string, string>; coverage: Coverage[]; reverse_links: Record<string, string[]>; trust: 'local-template'; asset_manifest?: Record<string, unknown>; asset_closure_sha256?: string; format?: 'strata-realization/2'; checker_sha256?: string; fixture_sha256?: string; oracle_sha256?: string; oracle?: FixtureOracle };
export type Diagnostic = { code: string; message: string; details?: unknown };
export type ScenarioContext = { composition: Composition; baseline: Snapshot; snapshot: Snapshot; proposals: Map<string, Layer> };
export type ScenarioCapability = { id: string; version: string; models: readonly string[]; evaluate(context: ScenarioContext): Diagnostic[] };
export type CheckObservation = { passed: boolean; failure: string | null; observations: Record<string, unknown> };
export type FixtureChecker = {
  entrypoint: string;
  oracleFormat: string;
  archive(): unknown;
  digest(): string;
  fixtureDigest(oracle: FixtureOracle): string;
  run(module: any, oracle: FixtureOracle): { checks: Record<string, CheckObservation>; observations: Record<string, any> };
};
// Trusted, compiled adapters only. No record may supply callbacks, code or module paths.
export type ProfileAdapter = {
  id: string;
  models: readonly string[];
  scenario: ScenarioCapability;
  defaultForScenario: boolean;
  boundEvidence: boolean;
  archive(): unknown;
  materialize(target: string, evaluation: Evaluation): Realization;
  checker: FixtureChecker;
  describeEffects(snapshot: Snapshot): string;
};
export type SelectionPartition = { id: string; selected: string[]; rejected: string[] };
export type SelectionEvaluator = {
  id: string;
  supports(model: string, scope: string): boolean;
  reason: string;
  match(baseline: Snapshot, layers: { ref: string; data: Layer }[]): SelectionPartition | null;
};
export function treeDigest(files: Record<string, string>): string {
  return digest(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, body]) => ({ path, digest: bytesDigest(body) })));
}
