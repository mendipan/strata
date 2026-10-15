import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {canonical,digest} from '../src/model.js';
import {revalidationAuthorityIdentity} from '../src/revalidation.js';
import {counterRevalidator} from '../src/revalidators/counter.js';
import {revalidationFixture} from './revalidation-fixture.js';

async function evidence(name:string,value:unknown){if(process.env.STRATA_R1_FIX_EVIDENCE_DIR){const dir=path.resolve(process.env.STRATA_R1_FIX_EVIDENCE_DIR);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,name+'.json'),canonical(value));}}
test('R1-C replay preserves original stable authority and accepts a fresh session after restart',async()=>{
  const f=await revalidationFixture(),original=counterRevalidator.run;let starts=0;
  counterRevalidator.run=async(...args)=>{starts++;return original(...args);};
  try{
    const completed=await f.submit('original-authority');assert.equal(completed.ok,true,JSON.stringify(completed.errors));const records=await f.records(),record=records[completed.data.ref].data;
    const identity=revalidationAuthorityIdentity(record.bridge.authority);
    for(const field of Object.keys(identity)){
      const changed={...record.bridge.authority,[field]:typeof (identity as any)[field]==='number'?(identity as any)[field]+1:'changed-'+(identity as any)[field]};
      assert.notEqual(canonical(revalidationAuthorityIdentity(changed)),canonical(identity),field);
    }
    assert.deepEqual(revalidationAuthorityIdentity({...record.bridge.authority,expires_at:'2099-01-01T00:00:00.000Z'}),identity);
    f.advance(1000);const fresh=await f.restart(),args=['drift','revalidate','--file','-','--idempotency-key','original-authority'];
    const restarted=await f.cli(args,f.request,fresh);assert.equal(restarted.ok,true,JSON.stringify(restarted.errors));assert.equal(restarted.data.ref,completed.data.ref);assert.equal(starts,1);
    f.gitConfig.enabledCheckers.push('different-checker-config');const repositoryChanged=await f.cli(args,f.request,fresh);f.gitConfig.enabledCheckers.pop();
    assert.equal(repositoryChanged.ok,false);assert.equal(repositoryChanged.errors[0].code,'REVALIDATION_AUTHORITY_CHANGED');assert.equal(starts,1);
    const changed=structuredClone(f.policy);changed.generation++;f.issuer.reload(f.accounts,changed);
    const replay=await f.cli(args,f.request,fresh);assert.equal(replay.ok,false);assert.equal(replay.errors[0].code,'REVALIDATION_AUTHORITY_CHANGED');assert.equal(starts,1);
    const inspected=await f.cli(['operation','inspect','original-authority'],{},fresh);assert.equal(inspected.ok,true);assert.equal(inspected.data.result.data.completion_ref,completed.data.ref);assert.equal(inspected.data.result.data.live_source_checked,false);
    const retained=await f.records();assert.equal(Object.keys(retained).length,Object.keys(records).length);assert.equal(canonical(retained[f.release.ref].data),f.releaseRecord);assert.equal(canonical(retained[f.binding.ref].data),f.bindingRecord);
    await evidence('replay-authority',{completed,restarted,repositoryChanged,replay,inspected,worker_starts:starts,release_unchanged:true,binding_unchanged:true});
  }finally{counterRevalidator.run=original;await f.close();}
});

for(const queues of [2,3])test(`R1-C replay refuses revocation after ${queues===2?'measure assertion':'startRevalidation return'} at the final await boundary`,async()=>{
  const f=await revalidationFixture(),originalRun=counterRevalidator.run;let starts=0;
  counterRevalidator.run=async(...args)=>{starts++;return originalRun(...args);};
  const originalRefresh=f.issuer.refreshContext.bind(f.issuer);let calls=0,revoked=false;
  try{
    const completed=await f.submit('final-await');assert.equal(completed.ok,true,JSON.stringify(completed.errors));const count=Object.keys(await f.records()).length;
    f.issuer.refreshContext=async context=>{
      await originalRefresh(context);
      if(++calls===3){const schedule=(remaining:number)=>queueMicrotask(()=>{if(remaining>1)schedule(remaining-1);else{const disabled=structuredClone(f.accounts);disabled.generation++;disabled.accounts[0].active=false;f.issuer.reload(disabled,f.policy);revoked=true;}});schedule(queues);}
    };
    const replay=await f.submit('final-await');f.issuer.refreshContext=originalRefresh;
    const denied=await f.cli(['operation','inspect','final-await'],{});
    assert.equal(revoked,true);assert.equal(calls,3);assert.equal(replay.ok,false);assert.equal(replay.errors[0].code,'AUTHENTICATION_REQUIRED');assert.equal(denied.ok,false);assert.equal(starts,1);
    assert.equal(Object.keys(await f.records()).length,count);
    await evidence('replay-final-guard-'+queues,{completed,replay,subsequent_inspection:denied,revoked_before_return:revoked,refresh_calls:calls,worker_starts:starts});
  }finally{f.issuer.refreshContext=originalRefresh;counterRevalidator.run=originalRun;await f.close();}
});
