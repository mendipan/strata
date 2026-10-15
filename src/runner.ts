import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { type Realization, type FixtureOracle, verifyRealization, treeDigest, profileFor } from './profile.js';
import { type Evidence, fail, canonical, digest } from './model.js';

export async function runFixtureEvidence(output:string,realization:Realization,oracle?:FixtureOracle):Promise<{evidence:Evidence;observations:Record<string,any>}> {
  verifyRealization(realization);const actual:Record<string,string>={};
  const checker = profileFor(realization.profile_id).checker;
  for(const name of Object.keys(realization.files)) {const file=path.resolve(output,name);if(path.dirname(file)!==path.resolve(output) || (await lstat(file)).isSymbolicLink()) fail('OUTPUT_TAMPERED',6,'Runner input must be an ordinary pinned fixture file.');actual[name]=await readFile(file,'utf8');}
  if(canonical((await readdir(output)).sort())!==canonical([...Object.keys(realization.files),'realization.json'].sort()) || canonical(actual)!==canonical(realization.files) || treeDigest(actual)!==realization.output_tree) fail('OUTPUT_TAMPERED',6,'Runner input was not measured against the complete pinned output before import.');
  if(!oracle || oracle.format!==checker.oracleFormat) fail('ORACLE_REQUIRED',6,'Host must supply independently reviewed semantic expectations for this profile; generated configuration is not an oracle.');
  const active=[...new Map(realization.coverage.flatMap(c=>c.checks.map(check=>[canonical(check),check] as const))).values()].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  if(canonical(active)!==canonical(oracle.criteria)) fail('ORACLE_MISMATCH',6,'Host oracle criteria do not match the complete active coverage.');
  if(realization.format==='strata-realization/2' && (realization.oracle_sha256!==digest(oracle) || realization.fixture_sha256!==checker.fixtureDigest(oracle))) fail('ORACLE_MISMATCH',6,'Host expectations do not match the exact retained semantic oracle.');
  if (!Object.hasOwn(realization.files, checker.entrypoint)) fail('OUTPUT_TAMPERED', 6, 'The trusted checker entrypoint is absent from the pinned output tree.');
  const module:any=await import(pathToFileURL(path.join(output,checker.entrypoint)).href+'?tree='+realization.output_tree);
  const { checks, observations }=checker.run(module,oracle);
  const results=active.map(check=>{const observation=checks[check.check];if(!observation) fail('UNKNOWN_EVIDENCE',6,'Unknown fixture check.');return {...check,method:check.method as 'mechanical'|'review',passed:observation.passed,reviewer:check.method==='review'?'fixture-reviewer':null};});
  return {evidence:{candidate:realization.candidate,profile:realization.profile,output_tree:realization.output_tree,executor:'strata-local-fixture-runner/1',results,...(realization.format==='strata-realization/2'?{format:'strata-fixture-evidence/2' as const,checker_sha256:checker.digest(),fixture_sha256:checker.fixtureDigest(oracle),oracle_sha256:digest(oracle)}: {})},observations};
}
