import {checklistFailureStage,checklistTransientGetFailure} from '../src/checklist-cloud-diagnostics.js';
export const CHECKLIST_GET_RETRY=Object.freeze({maximum_attempts:3,backoff_ms:[250,1000] as const,maximum_preflight_exchanges:9,
 transient_statuses:[408,429,500,502,503,504] as const,mutation_retries:0});
export async function checklistReadRetry<T>(method:string,dispatch:()=>Promise<T>,context:{now:()=>number;deadline:()=>number;
 wait:(ms:number)=>Promise<void>;record:(value:unknown)=>Promise<void>;canRetry?:()=>boolean}){
 for(let attempt=1;;attempt++){
  try{return await dispatch();}catch(error){
   const retry=method==='GET'&&attempt<CHECKLIST_GET_RETRY.maximum_attempts&&checklistTransientGetFailure(error)&&context.canRetry?.()!==false;
   const delay=CHECKLIST_GET_RETRY.backoff_ms[attempt-1]??0;
   const admitted=retry&&context.now()+delay<context.deadline();
   await context.record({state:method==='GET'?'read-failed':'mutation-uncertain',attempt,
    validator_stage:checklistFailureStage(error,method==='GET'?'http.transport':'mutation.uncertain'),retry_admitted:admitted,
    ...(admitted?{backoff_ms:delay}:{})});
   if(!admitted)throw error;await context.wait(delay);
  }
 }
}
