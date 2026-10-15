import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { digest, canonical } from '../src/model.js';
import { runGit, decodeGit } from '../src/git-workspace.js';
import { verifyGitAdoptionHistory, verifyGitBridgeReview, verifyGitAcceptance } from '../src/git-adoption.js';
import { gitFinalizationBindingProof } from '../src/git-finalization-proof.js';
import { authorizeGitBridgeEvidence, authorizeGitBridgeReviewer } from '../src/adoption/git-bridge.js';
import { g2NativeFixture } from './g2-native-fixture.js';
import { startLocalBroker } from '../src/local-broker.js';

const refused=(response:any)=>{assert.equal(response.ok,false,JSON.stringify(response));return response.error.code;};
const apply=(f:Awaited<ReturnType<typeof g2NativeFixture>>,key?:string)=>f.call('git.apply',{stage:f.stage.ref,review:f.review.ref},'fixture-selector',key?{idempotency_key:key}:{});

test('G2-15 native adopted binary dependency is refused before stage publication',async()=>{
  await assert.rejects(g2NativeFixture(true),{code:'UNSUPPORTED_ADOPTION_BRIDGE'});
});

test('G2-21/22/25 producer/reviewer provenance and exact validation targets are mandatory',async()=>{
  const f=await g2NativeFixture();try{
    assert.equal(f.acceptance.record.format,'git-acceptance/2');assert.equal(f.review.record.format,'git-apply-review/2');
    const {engine}=await f.load();verifyGitAdoptionHistory(engine.records,f.project);
    const {producer,...imported}=f.acceptance.record;
    refused(await f.call('git.evidence',{...imported,format:'git-acceptance/1'},'fixture-runner'));
    const observed=await f.ok('git.evidence',{...imported,format:'git-acceptance/1',observation_only:true},'fixture-runner');assert.equal(observed.record.format,'git-application-observation/1');
    refused(await f.call('git.review',{...f.reviewInput,acceptance:observed.ref}));
    assert.throws(()=>verifyGitAcceptance(engine,f.stage.ref,{...f.acceptance.record,format:'git-acceptance/1'}));
    assert.throws(()=>verifyGitBridgeReview(engine,f.result.record,{...f.review.record,format:'git-apply-review/1'},f.acceptance.record));
    const validationRef=engine.read(f.accepted.release.ref,'release').validation,original=engine.records[validationRef].data.target;
    engine.records[validationRef].data.target='DifferentComposition@1';
    assert.throws(()=>verifyGitBridgeReview(engine,f.result.record,f.review.record,f.acceptance.record),{code:'RELEASE_REQUIRED'});engine.records[validationRef].data.target=original;
    for(const [role,operation]of [['fixture-runner','git.check'],['fixture-selector','git.review'],['fixture-a','adoption.review'],['fixture-a','git.plan']] as const){
      f.narrow(role,operation);assert.equal(f.issuer.active(f.assignments[role].principal),true);refused(await apply(f));assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.old);f.resetIssuer();
    }
    const malformed=structuredClone(f.acceptance.record);malformed.producer.grant_id='missing-producer';assert.throws(()=>authorizeGitBridgeEvidence(engine,f.result.record,malformed,f.issuer));
    assert.throws(()=>authorizeGitBridgeReviewer(engine,f.result.record,{...f.review.record.target.reviewer,grant_id:'missing-reviewer'},f.issuer));
  }finally{await f.broker.close();}
});

test('G2-28/29 final broker publication remeasures broad source and original owner grant',async()=>{
  const f=await g2NativeFixture();try{
    const before=(await f.load()).registry,old=await readFile(path.join(f.app,'protected.txt'));
    f.setPrecommit(async()=>{await writeFile(path.join(f.app,'protected.txt'),'Owner changes report while stage awaits\n');});
    refused(await f.call('git.stage',{plan:f.result.ref,patch:f.patch},'fixture-preparer'));
    assert.deepEqual((await f.load()).registry,before);assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.old);
    await writeFile(path.join(f.app,'protected.txt'),old);
    f.setPrecommit(async()=>{f.narrow('fixture-a','git.plan');});
    refused(await f.call('git.stage',{plan:f.result.ref,patch:f.patch},'fixture-preparer'));assert.deepEqual((await f.load()).registry,before);
  }finally{f.setPrecommit(undefined);await f.broker.close();}
});

test('G2-29/30 late grant refusal rolls back own writes while preserving third-party bytes',async()=>{
  const f=await g2NativeFixture();try{
    const pins=await f.pins(),before=(await f.load()).registry;
    f.setAfterWrite(async()=>{f.narrow('fixture-runner','git.check');});refused(await apply(f));
    assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.old);assert.deepEqual(await f.pins(),pins);assert.deepEqual((await f.load()).registry,before);
    assert.equal((await f.ok('git.transaction.inspect',{repo_id:f.repo})).state,'rolled_back');f.resetIssuer();
    f.setAfterWrite(async()=>{await writeFile(path.join(f.app,'protected.txt'),'Independent owner bytes\n');});refused(await apply(f));
    assert.equal(await readFile(path.join(f.app,'protected.txt'),'utf8'),'Independent owner bytes\n');assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.old);
    await writeFile(path.join(f.app,'protected.txt'),'Unadopted owner report\n');
    f.setAfterWrite(async()=>{await writeFile(path.join(f.app,'counter.mjs'),'Third party module\n');});assert.equal(refused(await apply(f)),'GIT_RECOVERY_REQUIRED');
    assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),'Third party module\n');assert.equal((await f.ok('git.transaction.inspect',{repo_id:f.repo})).state,'recovery_required');
    f.setAfterWrite(undefined);await writeFile(path.join(f.app,'counter.mjs'),f.old);assert.equal((await f.ok('git.transaction.recover',{repo_id:f.repo})).state,'rolled_back');
  }finally{await f.broker.close();}
});

test('G2-31/32/34/35/36/38/40 exact retry, owner commit and transitive completion retain closed history',async()=>{
  const f=await g2NativeFixture();try{
    const pins=await f.pins(),preserved=await readFile(path.join(f.app,'protected.bin'));
    const planInput={...f.input,adoption:{publication_ref:f.publicationRef,expected_bridge_sha256:f.preview.bridge_sha256}};
    f.setFault('after-commit');refused(await f.call('git.plan',planInput,'fixture-a',{idempotency_key:'lost-plan'}));f.setFault(undefined);
    assert.equal((await f.ok('git.plan',planInput,'fixture-a',{idempotency_key:'lost-plan'})).ref,f.result.ref);assert.deepEqual(await f.pins(),pins);
    const retainedReview=await f.ok('git.review',f.reviewInput,'fixture-selector',{idempotency_key:'retained-review'});
    const metadata=structuredClone(f.assignments);metadata['unrelated-status-only']={principal:'unrelated-fixture',operations:['status']};f.replaceAssignments(metadata);
    assert.equal((await f.ok('git.review',f.reviewInput,'fixture-selector',{idempotency_key:'retained-review'})).ref,retainedReview.ref);f.resetIssuer();
    f.setFault('after-commit');refused(await apply(f,'lost-apply'));assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.desired);f.setFault(undefined);
    const receipt=await f.ok('git.apply',{stage:f.stage.ref,review:f.review.ref},'fixture-selector',{idempotency_key:'lost-apply'});
    const retry=await f.ok('git.apply',{stage:f.stage.ref,review:f.review.ref},'fixture-selector',{idempotency_key:'lost-apply'});assert.equal(retry.ref,receipt.ref);assert.deepEqual(await f.pins(),pins);
    assert.equal(refused(await f.call('git.apply',{stage:f.stage.ref,review:'missing@1'},'fixture-selector',{idempotency_key:'lost-apply'})),'IDEMPOTENCY_CONFLICT');
    refused(await f.call('git.finalize',{receipt:receipt.ref,commit:pins.head_commit}));
    await runGit(f.app,['add','--','counter.mjs']);await runGit(f.app,['commit','--quiet','-m','Synthetic owner accepts']);const commit=decodeGit(await runGit(f.app,['rev-parse','HEAD'])).trim();
    refused(await apply(f,'lost-apply'));assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.desired);
    f.narrow('fixture-a','git.plan');refused(await f.call('git.finalize',{receipt:receipt.ref,commit}));assert.equal((await f.pins()).head_commit,commit);f.resetIssuer();
    f.setFault('after-commit');refused(await f.call('git.finalize',{receipt:receipt.ref,commit},'fixture-selector',{idempotency_key:'lost-finalize'}));f.setFault(undefined);
    const finalization=await f.ok('git.finalize',{receipt:receipt.ref,commit},'fixture-selector',{idempotency_key:'lost-finalize'});
    const loaded=await f.load();gitFinalizationBindingProof(loaded.engine.records,finalization.ref);verifyGitAdoptionHistory(loaded.engine.records,f.project);
    const c=structuredClone(finalization.record),ref='git-finalization@'+digest({...c,acceptance_ref:'missing@1'});loaded.engine.records[ref]={type:'git-finalization',published:true,data:{...c,acceptance_ref:'missing@1'}};assert.throws(()=>gitFinalizationBindingProof(loaded.engine.records,ref));delete loaded.engine.records[ref];
    const oldReview=loaded.engine.records[f.review.ref].data;loaded.engine.records[f.review.ref].data={...oldReview,format:'git-apply-review/1'};assert.throws(()=>gitFinalizationBindingProof(loaded.engine.records,finalization.ref));loaded.engine.records[f.review.ref].data=oldReview;
    f.narrow('fixture-runner','git.check');verifyGitAdoptionHistory(loaded.engine.records,f.project);refused(await f.call('git.finalize',{receipt:receipt.ref,commit},'fixture-selector',{idempotency_key:'lost-finalize'}));f.resetIssuer();
    assert.deepEqual(await readFile(path.join(f.app,'protected.bin')),preserved);
    await runGit(f.app,['commit','--allow-empty','--quiet','-m','Synthetic subsequent owner commit']);
    const indirect=decodeGit(await runGit(f.app,['rev-parse','HEAD'])).trim();assert.equal(refused(await f.call('git.finalize',{receipt:receipt.ref,commit:indirect})),'FINALIZATION_MISMATCH');
    refused(await f.call('git.finalize',{receipt:receipt.ref,commit},'fixture-selector',{idempotency_key:'lost-finalize'}));
    assert.equal((await f.ok('git.transaction.inspect',{repo_id:f.repo})).state,'committed');
    assert.ok(canonical(loaded.engine.records[finalization.ref].data).includes(commit));
  }finally{await f.broker.close();}
});

test('G2-33 real process crash and corrupted journal retain guarded recovery',async()=>{
  const f=await g2NativeFixture();await f.broker.close();
  const configFile=path.join(f.root,'crash-config.json'),git={repositories:[{projectId:f.project,repoId:f.repo,root:f.app}],directory:f.directory,enabledCheckers:['counter-application/1']};
  await writeFile(configFile,JSON.stringify({state:f.state,project:f.project,assignments:f.assignments,git}));
  const program='import {readFile} from "node:fs/promises";import {startLocalBroker} from '+JSON.stringify(new URL('../src/local-broker.js',import.meta.url).href)+';import {FixtureIssuer} from '+JSON.stringify(new URL('../src/security.js',import.meta.url).href)+';const c=JSON.parse(await readFile(process.argv[1],"utf8"));const b=await startLocalBroker(c.state,0,{issuer:new FixtureIssuer({project_id:c.project,assignments:c.assignments}),git:{...c.git,afterWriteForTest:async()=>process.exit(45)}});process.stdout.write(b.url+"\\n");';
  const child=spawn(process.execPath,['--input-type=module','-e',program,configFile],{windowsHide:true,stdio:['ignore','pipe','pipe']}),closed=once(child,'close');let output='';
  const url=await new Promise<string>((resolve,reject)=>{child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.includes('\n'))resolve(output.trim());});child.once('error',reject);child.once('exit',()=>{if(!output)reject(new Error('Synthetic crash broker did not start.'));});});
  await assert.rejects(fetch(url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':'fixture-selector'},body:JSON.stringify({command:'git.apply',input:{stage:f.stage.ref,review:f.review.ref}})}));
  assert.deepEqual(await closed,[45,null]);assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.desired);
  // Remove only this harness lease after the exact child exit is confirmed.
  await unlink(path.join(f.state,'.node-state.lock'));
  const broker=await startLocalBroker(f.state,0,{issuer:f.issuer,git});
  const call=async(command:string,input:any)=>{const result=await fetch(broker.url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':'fixture-selector'},body:JSON.stringify({command,input})});return await result.json() as any;};
  try{
    assert.equal(refused(await call('git.apply',{stage:f.stage.ref,review:f.review.ref})),'GIT_RECOVERY_REQUIRED');
    const file=path.join(f.directory,'transaction-'+digest({project:f.project,repo:f.repo})+'.json'),original=await readFile(file,'utf8'),bad=JSON.parse(original);bad.journal.base_commit='0'.repeat(40);bad.sha256=digest(bad.journal);await writeFile(file,JSON.stringify(bad));
    assert.equal(refused(await call('git.transaction.recover',{repo_id:f.repo})),'GIT_RECOVERY_REQUIRED');assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.desired);
    await writeFile(file,original);const recovered=await call('git.transaction.recover',{repo_id:f.repo});assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.equal(recovered.data.state,'rolled_back');assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.old);
  }finally{await broker.close();}
});
