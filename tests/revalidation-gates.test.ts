import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {Engine} from '../src/core.js';
import {MODEL,canonical,digest} from '../src/model.js';
import {HostIssuer,policyStoreSchema,policyStoreV3Schema} from '../src/auth/host-issuer.js';
import {executeAuthorized} from '../src/service.js';
import {GitNodeAdapter} from '../src/git-adoption-node.js';
import {startRevalidation} from '../src/revalidation-node.js';
import {counterRevalidator} from '../src/revalidators/counter.js';
import {runGit} from '../src/git-workspace.js';
import {revalidationFixture} from './revalidation-fixture.js';
import {verifyRetainedRevalidation} from '../src/revalidation-producers.js';
import {revalidationContext,REVALIDATION_SCHEMAS,revalidationRequestSchema,revalidationBridgeSchema} from '../src/revalidation.js';
import {z} from 'zod';

test('R1-C old policies and pure JSON dispatch grant no execution or publication',async()=>{
  const f=await revalidationFixture();try{
    const capabilities=await f.cli(['capabilities'],{});assert.equal(capabilities.data.operations.some((row:any)=>row.operation.startsWith('revalidation.')),false);
    assert.throws(()=>executeAuthorized(f.engine,'drift.revalidate',f.request,f.issuer.resolve(f.token),f.issuer),(e:any)=>e.code==='REVALIDATION_PROOF_REQUIRED');
    const old={...f.policy,format:'strata-host-policy/1',grants:f.policy.grants.map(({lifetime,revalidation,...g})=>({...g,expires_at:lifetime.expires_at}))};assert.equal(policyStoreSchema.safeParse(old).success,false);
    const omitted=structuredClone(f.policy);delete (omitted.grants[0] as any).revalidation;omitted.generation++;f.issuer.reload(f.accounts,omitted);
    assert.equal((await f.submit('omitted')).errors[0].code,'REVALIDATION_AUTHORITY_REQUIRED');
    const status=await f.cli(['status'],{});assert.equal(status.data.capabilities['revalidation/1'],false);
    assert.equal(policyStoreV3Schema.safeParse({...f.policy,grants:[{...f.policy.grants[0],revalidation:{...f.policy.grants[0].revalidation,read_roots:['.','.']}}]}).success,false);
  }finally{await f.close();}
});

test('R1-C repository, inventory, checker, Block and criterion scopes each deny; expired credentials deny',async()=>{
  const f=await revalidationFixture();try{
    let generation=1;
    for(const field of ['repository_ids','read_roots','inventory_roots','checker_ids','block_ids','review_criterion_refs']as const){
      const changed=structuredClone(f.policy);changed.generation=++generation;changed.grants[0].revalidation[field]=[];f.issuer.reload(f.accounts,changed);
      assert.equal((await f.submit(field)).ok,false,field);
    }
    for(const op of ['drift.revalidate','revalidation.run','revalidation.criterion-review']){const changed=structuredClone(f.policy);changed.generation=++generation;changed.grants[0].operations=changed.grants[0].operations.filter(o=>o!==op);f.issuer.reload(f.accounts,changed);assert.equal((await f.submit(op)).ok,false,op);}
    const restored=structuredClone(f.policy);restored.generation=++generation;f.issuer.reload(f.accounts,restored);f.advance(31*60*1000);assert.equal((await f.submit('expired')).ok,false);
    assert.equal(Object.values(await f.records()).some(r=>r.type==='reconciliation-completion'),false);
  }finally{await f.close();}
});

test('R1-C proof cannot be fabricated or reused; source changes during the producer refuse',async()=>{
  const f=await revalidationFixture();await f.close();
  const adapter=new GitNodeAdapter(f.gitConfig,f.issuer.projectId,f.state);await adapter.initialize();
  const context=f.issuer.resolve(f.token),signal=new AbortController().signal;
  const unsupported=revalidationContext(f.engine.records,f.request,f.issuer.projectId);unsupported.plan.checker.id='unknown-application/1';
  await assert.rejects(counterRevalidator.prepare(unsupported,adapter.host(f.host.repoId)),(e:any)=>e.code==='REVALIDATION_UNSUPPORTED');
  const mismatched=await counterRevalidator.prepare(revalidationContext(f.engine.records,f.request,f.issuer.projectId),adapter.host(f.host.repoId));
  (mismatched.packet as any).module_sha256=digest('substituted measured input');await assert.rejects(counterRevalidator.run(mismatched,signal),(e:any)=>e.code==='REVALIDATION_WORKER_FAILED');
  const alternateAccounts=structuredClone(f.accounts),alternatePolicy=structuredClone(f.policy);alternateAccounts.accounts[0].principal_id='other-selector';alternatePolicy.grants[0].principal_id='other-selector';
  const alternate=new HostIssuer(alternateAccounts,alternatePolicy),alternateContext=alternate.resolve(alternate.login('r1-synthetic',f.key));
  await assert.rejects(startRevalidation(new Engine(structuredClone(f.engine.records),{}, {projectId:f.issuer.projectId,modelVersion:MODEL}),f.request,alternateContext,alternate,adapter,counterRevalidator,()=>{},signal,true),(e:any)=>e.code==='AUTHORITY_FORBIDDEN');
  const engine=new Engine(structuredClone(f.engine.records),{}, {projectId:f.issuer.projectId,modelVersion:MODEL});
  const operation=await startRevalidation(engine,f.request,context,f.issuer,adapter,counterRevalidator,()=>{},signal);
  assert.throws(operation.publishGuard,(e:any)=>e.code==='REVALIDATION_PROOF_REQUIRED');await operation.lateCheck();operation.publishGuard();assert.throws(operation.publishGuard,(e:any)=>e.code==='REVALIDATION_PROOF_REQUIRED');
  const failedEngine=new Engine(structuredClone(f.engine.records),{}, {projectId:f.issuer.projectId,modelVersion:MODEL});
  const failing={...counterRevalidator,run:async(prepared:any,signal?:AbortSignal)=>{const result=await counterRevalidator.run(prepared,signal);(result.results as any[])[0].passed=false;return result;}};
  await assert.rejects(startRevalidation(failedEngine,f.request,context,f.issuer,adapter,failing,()=>{},signal),(e:any)=>e.code==='REVALIDATION_FAILED');
  assert.equal(Object.values(failedEngine.records).some(r=>r.type==='git-revalidation-run'),false,'Explicit review cannot override failed mechanical checks.');
  const sourceEngine=new Engine(structuredClone(f.engine.records),{}, {projectId:f.issuer.projectId,modelVersion:MODEL});
  const racing={...counterRevalidator,run:async(prepared:any,signal?:AbortSignal)=>{const result=await counterRevalidator.run(prepared,signal);await writeFile(path.join(f.app,'preserved.txt'),'Changed during worker boundary\n');return result;}};
  await assert.rejects(startRevalidation(sourceEngine,f.request,context,f.issuer,adapter,racing,()=>{},signal),(e:any)=>e.code==='REVALIDATION_MISMATCH');
  assert.equal(Object.values(sourceEngine.records).some(r=>r.type==='git-revalidation-run'),false);
  await writeFile(path.join(f.app,'preserved.txt'),'Preserved raw bytes\n');
  const authorityEngine=new Engine(structuredClone(f.engine.records),{}, {projectId:f.issuer.projectId,modelVersion:MODEL});
  const revoking={...counterRevalidator,run:async(prepared:any,signal?:AbortSignal)=>{const result=await counterRevalidator.run(prepared,signal);const changed=structuredClone(f.accounts);changed.generation++;changed.accounts[0].active=false;f.issuer.reload(changed,f.policy);return result;}};
  await assert.rejects(startRevalidation(authorityEngine,f.request,context,f.issuer,adapter,revoking,()=>{},signal));
  assert.equal(Object.values(authorityEngine.records).some(r=>r.type==='revalidation-auth'),false);
});

test('R1-C HEAD/index/inventory changes with unchanged module bytes invalidate admission',async()=>{
  const f=await revalidationFixture();try{
    const originalIndex=await readFile(path.join(f.pins.gitDir,'index'));
    await runGit(f.app,['commit','--quiet','--allow-empty','-m','Same module, different HEAD']);assert.equal((await f.submit('head')).ok,false);
    await runGit(f.app,['reset','--soft','HEAD~1']);await runGit(f.app,['update-index','--chmod=+x','counter.mjs']);assert.equal((await f.submit('mode')).ok,false);
    await runGit(f.app,['update-index','--chmod=-x','counter.mjs']);await writeFile(path.join(f.pins.gitDir,'index'),originalIndex);await writeFile(path.join(f.app,'new.txt'),'Unmapped watch entry\n');assert.equal((await f.submit('inventory')).ok,false);
    assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.desired);assert.equal(Object.values(await f.records()).some(r=>r.type==='revalidation-auth'),false);
  }finally{await f.close();}
});

test('R1-C client interruption after artifact staging leaves no indexed completion',async()=>{
  const f=await revalidationFixture();let staged!:()=>void,released!:()=>void;const atStage=new Promise<void>(resolve=>staged=resolve),release=new Promise<void>(resolve=>released=resolve);
  try{
    f.setAfterStage(async()=>{staged();await release;});const abort=new AbortController();
    const response=fetch(f.url()+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':f.token,'x-strata-project':f.issuer.projectId},body:JSON.stringify({command:'drift.revalidate',input:f.request,options:{idempotency_key:'interrupted'}}),signal:abort.signal}).catch(()=>null);
    await atStage;abort.abort();await new Promise(resolve=>setTimeout(resolve,50));released();await response;await f.close();
    assert.equal(Object.values(await f.records()).some(r=>r.type==='reconciliation-completion'),false);
  }finally{released?.();await f.close();}
});

test('R1-C final synchronous authority refresh blocks mutation after late source capture',async()=>{
  const f=await revalidationFixture();try{
    let afterStage=false,count=0;f.setAfterStage(async()=>{afterStage=true;});
    // After stage: broker precheck, final capture's refresh, late identity refresh, final guard refresh.
    f.setRefresh(()=>{if(afterStage&&++count===4)writeFileSync(path.join(f.app,'preserved.txt'),'Changed immediately before rename\n');});
    const result=await f.submit('last-boundary');assert.equal(result.ok,false);assert.equal(Object.values(await f.records()).some(r=>r.type==='reconciliation-completion'),false);
  }finally{await f.close();}
});

test('R1-C generated record schemas are consistent',async()=>{
  for(const [name,schema]of Object.entries({...REVALIDATION_SCHEMAS,'revalidation-request':revalidationRequestSchema,'revalidation-bridge':revalidationBridgeSchema,'host-policy-v3':policyStoreV3Schema}))assert.deepEqual(JSON.parse(await readFile('schemas/'+name+'.schema.json','utf8')),z.toJSONSchema(schema));
});
