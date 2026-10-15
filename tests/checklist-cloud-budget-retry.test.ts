// Deterministic synthetic tests. No credentials, provider requests or paid usage.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {StrataError} from '../src/model.js';
import {checklistReadRetry} from '../scripts/checklist-cloud-read-retry.js';
import {ChecklistSharedTestBudget,initializeChecklistSharedBudget} from '../scripts/checklist-cloud-budget.js';

const target='a'.repeat(64),baseline='b'.repeat(64);
async function fixture(prior=0){const file=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-budget-')),'budget.json');
 return{file,budget:await initializeChecklistSharedBudget(file,prior,baseline,true,true)};}
const transient=(status=503)=>new StrataError('CHECKLIST_MANAGEMENT_REFUSED',7,'Synthetic transient',{checklist_stage:'http.status',http_status:status});
function retryContext(deadline=2000){let time=0;const records:unknown[]=[],waits:number[]=[];
 return{records,waits,now:()=>time,deadline:()=>deadline,wait:async(ms:number)=>{waits.push(ms);time+=ms;},record:async(v:unknown)=>{records.push(v);}};}

test('GET retries are capped at three independently reserved physical exchanges and fixed backoff',async()=>{
 const {budget}=await fixture();await budget.begin('synthetic-read',target);const context=retryContext();let calls=0;
 const value=await checklistReadRetry('GET',async()=>{await budget.reserveRequest('synthetic-read',1024);if(++calls<3)throw transient(calls===1?429:503);return'accepted';},context);
 assert.equal(value,'accepted');assert.equal(calls,3);assert.deepEqual(context.waits,[250,1000]);assert.equal((await budget.snapshot()).leases['synthetic-read'].requests,3);
 const exhausted=retryContext();calls=0;await assert.rejects(checklistReadRetry('GET',async()=>{calls++;throw transient();},exhausted));assert.equal(calls,3);
});

test('Permanent, malformed, denied, paginated and uncertain mutation errors never retry; deadline and remaining allowance stop transient reads',async()=>{
 for(const method of ['POST','PUT','PATCH','DELETE']){let calls=0;const context=retryContext();await assert.rejects(checklistReadRetry(method,async()=>{calls++;throw transient();},context));assert.equal(calls,1);assert.equal(context.waits.length,0);}
 for(const error of [new StrataError('x',7,'Synthetic',{checklist_stage:'http.status',http_status:403}),
  new StrataError('x',7,'Synthetic',{checklist_stage:'absence.error.message',http_status:404}),
  new StrataError('x',7,'Synthetic',{checklist_stage:'pagination.marker',http_status:503}),
  new StrataError('x',7,'Synthetic',{checklist_stage:'http.body',http_status:503}),
  new StrataError('x',7,'Synthetic',{checklist_stage:'absence.error.authorization',http_status:503})]){
  let calls=0;await assert.rejects(checklistReadRetry('GET',async()=>{calls++;throw error;},retryContext()));assert.equal(calls,1);
 }
 for(const context of [retryContext(200),{...retryContext(),canRetry:()=>false}]){let calls=0;await assert.rejects(checklistReadRetry('GET',async()=>{calls++;throw transient();},context));assert.equal(calls,1);}
});

test('Missing, unverified and replaced shared budget baseline fail closed; initialization never overwrites it',async()=>{
 const file=path.join(await mkdtemp(path.join(os.tmpdir(),'strata-synthetic-missing-budget-')),'budget.json');
 await assert.rejects(new ChecklistSharedTestBudget(file,true).begin('synthetic',target));
 await assert.rejects(initializeChecklistSharedBudget(file,0,baseline,false as true,true));
 const budget=await initializeChecklistSharedBudget(file,42,baseline,true,true);const before=await readFile(file,'utf8');
 await assert.rejects(initializeChecklistSharedBudget(file,0,baseline,true,true));assert.equal(await readFile(file,'utf8'),before);
 const raw=JSON.parse(before);raw.prior_includes_fees_and_taxes=false;await writeFile(file,JSON.stringify(raw));await assert.rejects(budget.begin('synthetic',target));
 assert.throws(()=>new ChecklistSharedTestBudget('relative-budget.json',true));
});

test('Gross prior usage plus fee/tax reserves bounds all attempts; unknown actual usage never releases a hold',async()=>{
 const {budget}=await fixture(1800);await budget.begin('synthetic-one',target);await budget.promote('synthetic-one');await budget.close('synthetic-one',false);
 await budget.begin('synthetic-two','c'.repeat(64));await budget.promote('synthetic-two');await budget.close('synthetic-two',false);
 assert.equal((await budget.snapshot()).reserved_or_reconciled_gross_cents,2000);await assert.rejects(budget.begin('synthetic-three','d'.repeat(64)));
 const first=(await budget.snapshot()).leases['synthetic-one'];assert.equal(first.actual_gross_cents,null);assert.equal(first.held_gross_cents,100);assert.equal(first.estimated_net_cents+first.fee_tax_allowance_cents,100);
 await assert.rejects(budget.begin('synthetic-one',target));await assert.rejects(budget.close('synthetic-one',false));
});

test('Separate processes share one atomic reservation total; concurrent lanes cannot each reserve the remaining US$1',async()=>{
 const {file,budget}=await fixture(1898),module=pathToFileURL(path.resolve('dist/scripts/checklist-cloud-budget.js')).href;
 const child=async(id:string,t:string)=>new Promise<string>((resolve,reject)=>{
  const code=`import {ChecklistSharedTestBudget} from ${JSON.stringify(module)};const b=new ChecklistSharedTestBudget(${JSON.stringify(file)},true);try{await b.begin(${JSON.stringify(id)},${JSON.stringify(t)});await b.promote(${JSON.stringify(id)});console.log('reserved');}catch{console.log('refused');}`;
  const process=spawn(globalThis.process.execPath,['--input-type=module','--eval',code],{windowsHide:true,env:{PATH:globalThis.process.env.PATH,SystemRoot:globalThis.process.env.SystemRoot,TEMP:os.tmpdir(),TMP:os.tmpdir()}});
  let text='';process.stdout.on('data',data=>text+=data);process.on('error',reject);process.on('exit',exit=>exit===0?resolve(text.trim()):reject(new Error('Synthetic child failed')));
 });
 const outcomes=await Promise.all([child('synthetic-process-one',target),child('synthetic-process-two','c'.repeat(64))]);assert.deepEqual(outcomes.sort(),['refused','reserved']);
 const snapshot=await budget.snapshot();assert(snapshot.reserved_or_reconciled_gross_cents<=2000);assert.equal(Object.values(snapshot.leases).filter(v=>v.mode==='mutation').length,1);
});

test('Fresh GET absence never clears setup or runtime/token uncertainty; active same-target leases also block promotion',async()=>{
 const {budget}=await fixture();await budget.begin('synthetic-old',target);await budget.promote('synthetic-old');
 await budget.begin('synthetic-fresh',target);await assert.rejects(budget.promote('synthetic-fresh'));
 await budget.close('synthetic-old',true);await assert.rejects(budget.promote('synthetic-fresh'));
 await assert.rejects(budget.assertNoUnreconciledMutation('synthetic-fresh'));assert.equal((await budget.snapshot()).leases['synthetic-old'].quarantined,true);
 await budget.begin('synthetic-runtime','c'.repeat(64));await budget.promote('synthetic-runtime');await budget.runtimeDispatch('synthetic-runtime');await budget.close('synthetic-runtime',true);
 await budget.begin('synthetic-next','c'.repeat(64));await assert.rejects(budget.assertNoUnreconciledMutation('synthetic-next'));await assert.rejects(budget.promote('synthetic-next'));
 assert.equal((await budget.snapshot()).leases['synthetic-runtime'].quarantined,true);
});

test('Physical exchanges and bytes never exceed retained per-attempt bounds; remaining bootstrap/run capacity is reserved before mutation',async()=>{
 const {budget}=await fixture();await budget.begin('synthetic-read',target);
 for(let n=0;n<17;n++)await budget.reserveRequest('synthetic-read',1);await assert.rejects(budget.promote('synthetic-read'));
 for(let n=17;n<64;n++)await budget.reserveRequest('synthetic-read',1);await assert.rejects(budget.reserveRequest('synthetic-read',1));
 await budget.begin('synthetic-bytes','c'.repeat(64));await budget.reserveRequest('synthetic-bytes',67108864);await assert.rejects(budget.reserveRequest('synthetic-bytes',1));
 await assert.rejects(budget.assertMutation('synthetic-bytes','c'.repeat(64)));assert.equal((await budget.snapshot()).leases['synthetic-read'].requests,64);
});
