import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, fail, canonical } from './model.js';
import { profileFor, type FixtureOracle } from './profile.js';
import { runFixtureEvidence } from './runner.js';
import { worktreeBytes, decodeGit } from './git-workspace.js';
import type { Engine } from './core.js';
import type { GitPlan, GitStage } from './git-adoption.js';

export const APPLICATION_CHECKER = 'counter-application/1';
export function applicationCheckerPins(oracle: FixtureOracle) {
  const checker = profileFor('counter-fixture/1').checker;
  return { id: APPLICATION_CHECKER, version: '1', sha256: checker.digest(), fixture_sha256: checker.fixtureDigest(oracle), oracle_sha256: digest(oracle) };
}
// This compiled fixture checks only exact recognized counter-template bytes. It is
// intentionally not an arbitrary application-code runner or package-script runner.
export async function checkGitApplication(engine: Engine, plan: GitPlan, stage: GitStage, sandbox: string, directory: string) {
  if (plan.checker.id !== APPLICATION_CHECKER || canonical(plan.checker) !== canonical(applicationCheckerPins(plan.oracle as FixtureOracle))) fail('UNSUPPORTED_CHECKER', 8, 'Only the pinned compiled counter application fixture is supported.');
  if (plan.regressions.some(r => r !== 'unrelated-byte-preservation')) fail('UNSUPPORTED_CHECKER', 8, 'Unknown compiled regression obligation.');
  const realization = engine.realize(plan.target.ref, 'counter-fixture/1');
  const bytes = await worktreeBytes(sandbox, 'counter.mjs');
  if (!bytes || decodeGit(bytes) !== realization.files['counter.mjs']) fail('UNSUPPORTED_CHECKER', 8, 'Automatic fixture execution requires exact recognized counter module bytes. Supply separately run application evidence for other implementations.');
  const output = await mkdtemp(path.join(directory, 'counter-check-'));
  for (const [name, text] of Object.entries(realization.files)) await writeFile(path.join(output,name),name==='counter.mjs'?bytes:text,{flag:'wx'});
  await writeFile(path.join(output,'realization.json'), '{}', {flag:'wx'});
  const measured = await runFixtureEvidence(output,realization,plan.oracle as FixtureOracle);
  return { results: plan.criteria.map(c => { const result = measured.evidence.results.find(r=>r.check===c.check&&r.version===c.version&&r.fixture===c.fixture&&r.method===c.method); if(!result)fail('VALIDATION_INCOMPLETE',6,'Compiled fixture did not supply a required criterion.'); return {...c,passed:result.passed,reviewer:result.reviewer}; }), regressions:plan.regressions.map(id=>({id,passed:stage.unchanged_outside_write_set})), observations_sha256:digest(measured.observations),limitations:['Local compiled fixture measurements and fixture review assertions; execution is not independently authenticated.','Regressions establish only unchanged bytes outside the patch write set.'] };
}
