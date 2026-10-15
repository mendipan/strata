import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { canonical, digest, fail, parse, BLOCK_MODEL } from '../model.js';
import { verifyOutput, safePath } from '../commands/node.js';
import { hostRunSchema } from './records.js';
import type { Engine } from '../core.js';
import type { SecurityContext } from '../security.js';
import path from 'node:path';
// Slots and finite profiles are operator-owned configuration, never caller paths.
export function hostRunner(root:string,slots:Record<string,string>,profiles:string[]){return async(engine:Engine,input:unknown,context:SecurityContext)=>{
  const request=parse(z.object({target:z.string(),slot:z.string(),profile:z.string()}).strict(),input);if(!Object.hasOwn(slots,request.slot)||!profiles.includes(request.profile))fail('PROFILE_FORBIDDEN',4,'Choose a configured finite runner/output slot.');
  const output=await safePath(root,slots[request.slot]),manifest=await verifyOutput(root,path.join(output,'realization.json')),record=engine.read(manifest.realization_ref,'realization');
  if(canonical(record)!==canonical(manifest.record)||record.profile_id!==request.profile||record.target!==request.target||record.model_version!==BLOCK_MODEL||record.format!=='strata-realization/2'||canonical(engine.realize(request.target,request.profile))!==canonical(record))fail('STALE_REALIZATION',6,'Runner needs the exact retained v0.3 candidate output.');
  const worker=new Worker(new URL('./runner-worker.js',import.meta.url),{workerData:{output,record},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16}});
  const measured:any=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Finite runner timeout.'));},5000);worker.once('message',message=>{clearTimeout(timer);resolve(message);});worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('exit',code=>{if(code!==0){clearTimeout(timer);reject(new Error('Finite runner stopped.'));}});}).catch(()=>fail('RUNNER_FAILED',6,'The configured finite runner failed or exceeded its resource bound.'));await worker.terminate();
  if(!measured.ok)fail('RUNNER_FAILED',6,'Measured finite checks did not complete.');
  // Recheck all bytes after measurement, before retaining an observation receipt.
  await verifyOutput(root,path.join(output,'realization.json'));
  const results=measured.evidence.results.filter((r:any)=>r.method==='mechanical').map(({check,version,fixture,passed}:any)=>({check,version,fixture,passed}));
  const data=parse(hostRunSchema,{format:'strata-host-run/1',project_id:context.project_id,model_version:BLOCK_MODEL,candidate:record.candidate,realization:manifest.realization_ref,profile:record.profile,profile_id:record.profile_id,output_tree:record.output_tree,checker_sha256:record.checker_sha256,fixture_sha256:record.fixture_sha256,oracle_sha256:record.oracle_sha256,producer:context.principal_id,results,observations_sha256:digest(measured.observations),auth_receipt:engine.authReceipt('evidence.run'),trust:'host-measured'});
  const ref='host-run@'+digest(data);engine.store(ref,'host-run',data);return {ref,run:data,checks_passed:results.every((r:{passed:boolean})=>r.passed),review_pending:true};
};}
