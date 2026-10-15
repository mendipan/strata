import { cliBroker } from '../cli-config.js';
import { fail } from '../model.js';
import { MUTATIONS } from '../service.js';
import { presentOperationEffects } from './replay-effects.js';
export function localOperationClient(config:any,selector:string,options:{dry_run?:boolean;idempotency_key?:string;expected_generation?:string;expected_policy?:string}={}) {
  const broker=cliBroker(config);
  return async (command:string,input:any) => {
    let response:any;
    try {
      const result=await fetch(new URL('/v1/operation',broker),{method:'POST',headers:{'content-type':'application/json','x-strata-session':selector,'x-strata-project':config.project_id,'x-strata-artifact-adapter':config.artifact_adapter,...(options.expected_generation?{'x-strata-expected-generation':options.expected_generation}:{}),...(options.expected_policy?{'x-strata-expected-policy':options.expected_policy}:{})},body:JSON.stringify({command,input,options:{dry_run:options.dry_run??false,idempotency_key:MUTATIONS.has(command)?options.idempotency_key:undefined}}),signal:AbortSignal.timeout(command.startsWith('git.')||command.startsWith('source.')||command.startsWith('drift.')?60000:15000),redirect:'error'});
      response=await result.json();
    } catch { fail('BROKER_UNAVAILABLE',9,'Start the local broker; this command does not start servers, refresh remote state, or install dependencies.'); }
    if(!response.ok)fail(response.error.code,response.error.exit,response.error.message,response.error.details);
    return presentOperationEffects(response);
  };
}
