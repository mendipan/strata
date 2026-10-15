import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GitNodeAdapter } from '../src/git-adoption-node.js';
import { g2NativeFixture } from './g2-native-fixture.js';
import { runGit, decodeGit } from '../src/git-workspace.js';
import { digest } from '../src/model.js';
import { gitFinalizationBindingProof } from '../src/git-finalization-proof.js';
import { validateBindingCompletion } from '../src/source-binding.js';
import { Engine } from '../src/core.js';

test('G2-REVIEW-001 last real native apply wait rechecks every original grant and actor',async()=>{
  const f=await g2NativeFixture(),original=GitNodeAdapter.prototype.verifyApplied;
  let armed=false,fired=false,role='',operation='';
  try{
    f.setPrecommit(async()=>{armed=true;});
    GitNodeAdapter.prototype.verifyApplied=async function(...args){const result=await original.apply(this,args);if(armed&&!fired){fired=true;f.narrow(role,operation);}return result;};
    const pins=await f.pins(),registry=await readFile(path.join(f.state,'registry.json'),'utf8');
    for(const [retainedRole,op,actor]of [['fixture-a','git.plan','fixture-selector'],['fixture-a','adoption.review','fixture-selector'],['fixture-runner','git.check','fixture-selector'],['fixture-selector','git.review','fixture-selector'],['fixture-preparer','git.apply','fixture-preparer']]as const){
      armed=false;fired=false;role=retainedRole;operation=op;
      const response=await f.call('git.apply',{stage:f.stage.ref,review:f.review.ref},actor,{idempotency_key:'last-native-'+role+'-'+op});
      assert.equal(fired,true);assert.equal(response.ok,false,JSON.stringify(response));assert.equal(f.issuer.active(f.assignments[role].principal),true);
      assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.old);assert.deepEqual(await f.pins(),pins);assert.equal(await readFile(path.join(f.state,'registry.json'),'utf8'),registry);
      f.resetIssuer();assert.equal((await f.ok('git.transaction.inspect',{repo_id:f.repo})).state,'rolled_back');
    }
  }finally{GitNodeAdapter.prototype.verifyApplied=original;f.setPrecommit(undefined);f.resetIssuer();await f.broker.close();}
});

test('G2-REVIEW-001 final broker publication and cached apply have a synchronous authority boundary',async()=>{
  const f=await g2NativeFixture(),originalRecheck=GitNodeAdapter.prototype.recheck,originalCached=GitNodeAdapter.prototype.cached;
  let armed=false,fired=false;
  try{
    const pins=await f.pins(),registry=await readFile(path.join(f.state,'registry.json'),'utf8');
    f.setPrecommit(async()=>{armed=true;});
    GitNodeAdapter.prototype.recheck=async function(...args){const result=await originalRecheck.apply(this,args);if(armed&&!fired&&args[1]==='git.apply'){fired=true;f.narrow('fixture-runner','git.check');}return result;};
    const refused=await f.call('git.apply',{stage:f.stage.ref,review:f.review.ref},'fixture-selector',{idempotency_key:'last-broker-return'});
    assert.equal(fired,true);assert.equal(refused.ok,false,JSON.stringify(refused));assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.old);assert.deepEqual(await f.pins(),pins);assert.equal(await readFile(path.join(f.state,'registry.json'),'utf8'),registry);
    GitNodeAdapter.prototype.recheck=originalRecheck;f.setPrecommit(undefined);f.resetIssuer();
    const receipt=await f.ok('git.apply',{stage:f.stage.ref,review:f.review.ref},'fixture-selector',{idempotency_key:'cached-authority'}),durable=await readFile(path.join(f.state,'registry.json'),'utf8');
    fired=false;GitNodeAdapter.prototype.cached=async function(...args){const result=await originalCached.apply(this,args);if(!fired&&args[0]==='git.apply'){fired=true;f.narrow('fixture-runner','git.check');}return result;};
    const retry=await f.call('git.apply',{stage:f.stage.ref,review:f.review.ref},'fixture-selector',{idempotency_key:'cached-authority'});
    assert.equal(fired,true);assert.equal(retry.ok,false,JSON.stringify(retry));assert.equal(await readFile(path.join(f.state,'registry.json'),'utf8'),durable);assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.desired);assert.deepEqual(await f.pins(),pins);
    const loaded=await f.load();assert.equal(loaded.engine.records[receipt.ref].type,'git-apply-receipt');f.resetIssuer();assert.equal((await f.ok('git.transaction.inspect',{repo_id:f.repo})).state,'committed');
  }finally{GitNodeAdapter.prototype.recheck=originalRecheck;GitNodeAdapter.prototype.cached=originalCached;f.setPrecommit(undefined);f.resetIssuer();await f.broker.close();}
});

test('G2-REVIEW-001 stage/check/review/finalize/successor final awaits retain exact authority',async()=>{
  const f=await g2NativeFixture(),original=GitNodeAdapter.prototype.recheck;
  let command='',role='',operation='',fired=false;
  try{
    GitNodeAdapter.prototype.recheck=async function(...args){const result=await original.apply(this,args);if(args[1]===command&&!fired){fired=true;f.narrow(role,operation);}return result;};
    const refuse=async(cmd:string,input:any,actor:string,retained:string,op:string)=>{
      command=cmd;role=retained;operation=op;fired=false;const pins=await f.pins(),bytes=await readFile(path.join(f.app,'counter.mjs')),registry=await readFile(path.join(f.state,'registry.json'),'utf8');
      const response=await f.call(cmd,input,actor);assert.equal(fired,true,cmd);assert.equal(response.ok,false,JSON.stringify(response));assert.equal(f.issuer.active(f.assignments[role].principal),true);
      assert.deepEqual(await f.pins(),pins);assert.deepEqual(await readFile(path.join(f.app,'counter.mjs')),bytes);assert.equal(await readFile(path.join(f.state,'registry.json'),'utf8'),registry);f.resetIssuer();command='';
    };
    await refuse('git.stage',{plan:f.result.ref,patch:f.patch},'fixture-preparer','fixture-a','git.plan');
    await refuse('git.check',{stage:f.stage.ref,checker:'counter-application/1',oracle:f.accepted.oracle},'fixture-runner','fixture-runner','git.check');
    await refuse('git.review',f.reviewInput,'fixture-selector','fixture-runner','git.check');
    const receipt=await f.ok('git.apply',{stage:f.stage.ref,review:f.review.ref});await runGit(f.app,['add','--','counter.mjs']);await runGit(f.app,['commit','--quiet','-m','Synthetic corrected G2 owner']);const commit=decodeGit(await runGit(f.app,['rev-parse','HEAD'])).trim();
    await refuse('git.finalize',{receipt:receipt.ref,commit},'fixture-selector','fixture-a','git.plan');
    const completion=await f.ok('git.finalize',{receipt:receipt.ref,commit});
    const fresh=await f.ok('source.capture',{repo_id:f.repo,scope:f.bindingSource.scope,expected_head:commit});
    const loaded=await f.load(),release=loaded.engine.read(f.accepted.release.ref,'release'),source=loaded.engine.read(fresh.ref,'source-snapshot');
    const payload={format:'source-binding-payload/1' as const,project_id:f.project,repo_id:f.repo,intent:{release_ref:f.accepted.release.ref,release_sha256:digest(release),snapshot_sha256:completion.record.snapshot_sha256,model_version:release.model_version},source_ref:fresh.ref,source_sha256:fresh.source_sha256,previous_binding_ref:f.binding.ref,completion_ref:completion.ref,basis:'validated-release-association' as const,acceptance_evidence_refs:[f.acceptance.ref],limitations:[]};
    gitFinalizationBindingProof(loaded.engine.records,completion.ref);validateBindingCompletion(loaded.engine,payload,source);
    for(const edit of [(records:any)=>{delete records[f.result.ref];},(records:any)=>{const {adoption_bridge,...base}=records[f.result.ref].data;records[f.result.ref].data={...base,format:'git-change-plan/1'};},(records:any)=>{records[f.result.ref].type='git-apply-review';}]){
      const records=structuredClone(loaded.engine.records);edit(records);const altered=new Engine(records,structuredClone(loaded.engine.ownerHeads),{projectId:f.project});assert.throws(()=>gitFinalizationBindingProof(records,completion.ref));assert.throws(()=>validateBindingCompletion(altered,payload,source));
    }
    const request={payload,expected_payload_sha256:digest(payload),rationale:'Measured corrected native successor.',review_refs:[]};
    await refuse('source.bind',request,'fixture-selector','fixture-selector','git.review');
    assert.ok((await f.ok('source.bind',request)).ref.startsWith('source-binding@'));
  }finally{GitNodeAdapter.prototype.recheck=original;f.resetIssuer();await f.broker.close();}
});
