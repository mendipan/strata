import { readFile } from 'node:fs/promises';
import { canonical,bytesDigest,digest,fail,parse } from '../model.js';
import { applicationCheckerPins,APPLICATION_CHECKER } from '../git-application-checker.js';
import { profileFor,profileArchive,type FixtureOracle } from '../profile.js';
import { worktreeBytes,decodeGit } from '../git-workspace.js';
import { revalidationSame as same,revalidatorDescriptorSchema,type RevalidationContext,type RevalidationRun } from '../revalidation.js';
import type { GitHost } from '../source-binding.js';
import { boundedRevalidationWorker } from '../revalidation-worker.js';
import type { TrustedRevalidator } from '../revalidation-node.js';
import { executeRecognizedCounter } from './counter-execution.js';
type CounterPacket={module_bytes:string;expected_module:string;module_sha256:string;checker_pins:RevalidationContext['plan']['checker'];oracle:unknown;criteria:RevalidationContext['criteria']};

export const COUNTER_REVALIDATOR='strata-node-git-revalidator/1';
// Trusted compiled producer registration, deliberately outside the reusable engine.
export const counterRevalidator:TrustedRevalidator<CounterPacket>={
  id:COUNTER_REVALIDATOR,
  async prepare(c:RevalidationContext,host:GitHost) {
    if(c.plan.checker.id!==APPLICATION_CHECKER)fail('REVALIDATION_UNSUPPORTED',8,'No trusted producer for the selected application checker.');
    same(c.plan.checker,applicationCheckerPins(c.plan.oracle as FixtureOracle));
    const realization=c.engine.realize(c.target.ref,'counter-fixture/1');
    // Compare the retained independently reviewed oracle with accepted intent, not generated configuration.
    same(c.plan.oracle,realization.oracle,'Reviewed oracle is inconsistent with accepted intent.');
    const bytes=await worktreeBytes(host.root,'counter.mjs'),entry=c.report.observation.entries.find(e=>e.path==='counter.mjs');
    if(!bytes||!entry||entry.kind!=='regular'||entry.presence!=='present'||entry.sha256!==bytesDigest(bytes)||entry.byte_length!==bytes.length)
      fail('REVALIDATION_SOURCE_REQUIRED',6,'Measured counter input is absent or changed.');
    const module=decodeGit(bytes),recognized=realization.files['counter.mjs'];
    if(module!==recognized)fail('REVALIDATION_UNSUPPORTED',8,'Only exact compiled counter template bytes are eligible.');
    const worker_source=executeRecognizedCounter.toString(),runner_source=boundedRevalidationWorker.toString();
    const archive:any=profileArchive('counter-fixture/1'),recognizer_source=archive.template;
    const descriptor=parse(revalidatorDescriptorSchema,{format:'strata-revalidator-descriptor/1',id:COUNTER_REVALIDATOR,profile_id:'counter-fixture/1',profile_sha256:digest(archive),profile_archive:archive,
      checker:c.plan.checker,recognizer_source,worker_source,runner_source,implementation_sha256:digest({worker_source,runner_source,recognizer_source}),oracle:c.plan.oracle,
      bounds:{milliseconds:5000,old_generation_mib:64,young_generation_mib:16,ipc_bytes:262144}});
    const packet={module_bytes:module,expected_module:recognized,module_sha256:bytesDigest(bytes),checker_pins:c.plan.checker,oracle:structuredClone(c.plan.oracle),criteria:c.criteria};
    return {descriptor,packet};
  },
  async run(prepared,signal?:AbortSignal) {
    const result=await boundedRevalidationWorker(new URL('./counter-worker.js',import.meta.url),prepared.packet,signal);
    if(result.ok!==true)fail('REVALIDATION_WORKER_FAILED',6,'The finite worker did not produce measured results.');
    return {results:result.results,observations:result.observations};
  }
};
export function verifyCounterRevalidator(c:RevalidationContext,descriptor:unknown,run:RevalidationRun) {
  const d=parse(revalidatorDescriptorSchema,descriptor);
  const realization=c.engine.realize(c.target.ref,'counter-fixture/1'),archive:any=profileArchive('counter-fixture/1');
  same(d.id,COUNTER_REVALIDATOR);same(d.profile_id,'counter-fixture/1');same(d.profile_archive,archive);
  same(d.checker,applicationCheckerPins(c.plan.oracle as FixtureOracle));same(d.oracle,realization.oracle);
  same(d.recognizer_source,archive.template);same(d.worker_source,executeRecognizedCounter.toString());same(d.runner_source,boundedRevalidationWorker.toString());
  const checks:any=(d.profile_archive as any).checker;
  same(d.checker.sha256,bytesDigest(checks.source));same(d.checker.fixture_sha256,digest({fixture:checks.fixture,criteria:(d.oracle as FixtureOracle).criteria}));
  // Pure expected measurements from the accepted oracle and verified fixed fixture; execute no code.
  const oracle=d.oracle as FixtureOracle;
  const passing:Record<string,unknown>={
    'counter.add':{passed:true,failure:null,observations:{total:2}},
    'counter.limit':{passed:true,failure:null,observations:{total:oracle.expected.maximum}},
    'counter.invalid':{passed:true,failure:null,observations:{invalid:checks.fixture.invalid}},
  };
  const mechanical=c.criteria.filter(row=>row.method==='mechanical'),selected=[...new Set(mechanical.map(row=>row.check))];
  same(run.results,mechanical.map(row=>({...row,passed:true,reviewer:null})));
  same(run.observations,{checks:Object.fromEntries(selected.map(id=>{
    if(!Object.hasOwn(passing,id))fail('REVALIDATION_UNSUPPORTED',8,'Unknown counter measurement.');
    return [id,passing[id]];
  })),oracle_sha256:digest(oracle)},'Retained counter measurements contradict the pinned oracle or fixture.');
}
