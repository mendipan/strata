import { fail,type Records } from './model.js';
import { APPLICATION_CHECKER } from './git-application-checker.js';
import { verifyRevalidationHistory } from './revalidation.js';
import { COUNTER_REVALIDATOR,verifyCounterRevalidator } from './revalidators/counter.js';
/** Trusted producer registry. Adding an application requires a separately reviewed producer. */
export function verifyRetainedRevalidation(records:Records,project:string) {
  return verifyRevalidationHistory(records,project,(c,d,run)=>{
    if(c.plan.checker.id!==APPLICATION_CHECKER||d.id!==COUNTER_REVALIDATOR)fail('REVALIDATION_UNSUPPORTED',8,'No trusted historical verifier for this producer.');
    verifyCounterRevalidator(c,d,run);
  });
}
