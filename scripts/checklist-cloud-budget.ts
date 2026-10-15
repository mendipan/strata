import {open,readFile,mkdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {canonical,fail,parse} from '../src/model.js';
import {noLinks} from '../src/node-state.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const lease=z.object({target_sha256:hash,held_gross_cents:z.number().int().min(1).max(100),mode:z.enum(['preflight','mutation']),
 requests:z.number().int().min(0).max(64),reserved_bytes:z.number().int().min(0).max(67108864),
 estimated_net_cents:z.number().int().min(0).max(100),fee_tax_allowance_cents:z.number().int().min(0).max(100),
 actual_gross_cents:z.number().int().min(0).max(100).nullable(),quarantined:z.boolean(),runtime_dispatched:z.boolean(),closed:z.boolean()}).strict();
const schema=z.object({format:z.literal('strata-shared-test-budget/1'),combined_gross_limit_cents:z.literal(2000),
 prior_gross_cents:z.number().int().min(0).max(2000),prior_baseline_sha256:hash,prior_includes_fees_and_taxes:z.literal(true),
 leases:z.record(id,lease),revision:z.number().int().nonnegative()}).strict();
type State=z.infer<typeof schema>;
function denied(message:string):never{return fail('CHECKLIST_SHARED_BUDGET_REFUSED',7,message,{checklist_stage:'budget.exhausted'});}
const total=(s:State)=>s.prior_gross_cents+Object.values(s.leases).reduce((n,v)=>n+(v.actual_gross_cents??v.held_gross_cents),0);
export class ChecklistSharedTestBudget {
 constructor(readonly file:string,readonly synthetic=false){
  if(!path.isAbsolute(file))denied('An explicit absolute shared ledger path bound by the owner activation is required.');
 }
 private async change<T>(fn:(state:State)=>T):Promise<T>{
  await noLinks(this.file);let lock;
  for(let attempt=0;;attempt++){
   try{lock=await open(this.file+'.lock','wx');break;}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if(attempt>=40)denied('Shared budget remains locked; stale locks require operator reconciliation.');
    await new Promise(resolve=>setTimeout(resolve,25));
   }
  }
  try{
   const bytes=await readFile(this.file);if(bytes.length>2*1024*1024)denied('Shared ledger size refused.');
   const state=parse(schema,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))),value=fn(state);
   if(total(state)>2000)denied('Combined gross test reservations would exceed US$20.');state.revision++;
   const tmp=this.file+'.next',handle=await open(tmp,'wx');try{await handle.writeFile(canonical(state));await handle.sync();}finally{await handle.close();}
   await rename(tmp,this.file);return value;
  }finally{await lock.close();await unlink(this.file+'.lock');}
 }
 async begin(caseId:string,target:string){return this.change(state=>{
  if(!id.safeParse(caseId).success||!hash.safeParse(target).success||state.leases[caseId])denied('Existing case or malformed budget identity; never reset a lease.');
  state.leases[caseId]={target_sha256:target,held_gross_cents:1,mode:'preflight',requests:0,reserved_bytes:0,
   estimated_net_cents:0,fee_tax_allowance_cents:1,actual_gross_cents:null,quarantined:false,runtime_dispatched:false,closed:false};
 });}
 async reserveRequest(caseId:string,bytes:number){return this.change(state=>{
  const v=state.leases[caseId];if(!v||v.closed||!Number.isSafeInteger(bytes)||bytes<0||v.requests>=64||v.reserved_bytes+bytes>67108864)denied('Per-attempt request/transfer allowance exhausted.');
  v.requests++;v.reserved_bytes+=bytes;
 });}
 async assertMutation(caseId:string,target:string){return this.change(state=>{
  const v=state.leases[caseId];if(!v||v.closed||v.quarantined||v.mode!=='mutation'||v.target_sha256!==target||v.held_gross_cents!==100)denied('Exact active gross mutation reservation required.');
 });}
 async assertNoUnreconciledMutation(caseId:string){return this.change(state=>{
  const current=state.leases[caseId];if(!current||current.mode!=='preflight')denied('Only a fresh read-only preflight may reconcile setup.');
  // Script deployment absence cannot prove that an unacknowledged private Worker
  // creation settled. Retain all uncertainty; never clear it from another GET.
  if(Object.values(state.leases).some(v=>v.target_sha256===current.target_sha256&&v.quarantined))
   denied('Prior uncertain mutation requires retained exact resource/token/handle reconciliation before another mutation.');
 });}
 async promote(caseId:string,workflowTransferBytes=0){return this.change(state=>{
  const v=state.leases[caseId];if(!v||v.closed||v.quarantined||v.mode!=='preflight'||v.requests+48>64)denied('Reserve the remaining 15 bootstrap and 33 attended exchanges before mutation.');
  if(Object.entries(state.leases).some(([key,x])=>key!==caseId&&x.target_sha256===v.target_sha256&&(x.quarantined||(!x.closed&&x.mode==='mutation'))))denied('Concurrent/uncertain same-target mutation refused.');
  v.mode='mutation';v.held_gross_cents=100;v.estimated_net_cents=42;v.fee_tax_allowance_cents=58;
  if(!Number.isSafeInteger(workflowTransferBytes)||workflowTransferBytes<0||v.reserved_bytes+workflowTransferBytes>67108864)denied('Workflow transfer reservation refused.');v.reserved_bytes+=workflowTransferBytes;
 });}
 async runtimeDispatch(caseId:string){return this.change(state=>{const v=state.leases[caseId];if(!v||v.mode!=='mutation')denied('Mutating budget reservation required.');v.runtime_dispatched=true;});}
 async close(caseId:string,quarantined:boolean,runtimeDispatched=false){return this.change(state=>{
  const v=state.leases[caseId];if(!v||v.closed)denied('Unknown or already closed case.');v.closed=true;v.quarantined=quarantined;v.runtime_dispatched ||= runtimeDispatched;
  // Model estimates are informational. Never release a gross reservation from an estimate.
 });}
 async snapshot(){return this.change(state=>({combined_gross_limit_cents:2000,prior_gross_cents:state.prior_gross_cents,
  reserved_or_reconciled_gross_cents:total(state),remaining_cents:2000-total(state),leases:structuredClone(state.leases)}));}
}
// Operator supplies a conservative prior gross baseline backed by a retained receipt
// hash. Unknown prior usage/taxes is not zero; absence of this file blocks paid work.
export async function initializeChecklistSharedBudget(file:string,priorGrossCents:number,priorBaselineSha256:string,includesFeesAndTaxes:true,synthetic=false){
 const budget=new ChecklistSharedTestBudget(file,synthetic);
 const state=parse(schema,{format:'strata-shared-test-budget/1',combined_gross_limit_cents:2000,prior_gross_cents:priorGrossCents,
  prior_baseline_sha256:priorBaselineSha256,prior_includes_fees_and_taxes:includesFeesAndTaxes,leases:{},revision:0});
 await mkdir(path.dirname(file),{recursive:true});await noLinks(path.dirname(file));
 const handle=await open(file,'wx');try{await handle.writeFile(canonical(state));await handle.sync();}finally{await handle.close();}return budget;
}
