import {test} from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,rename,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { canonical,digest } from '../src/model.js';
import { gitPins,runGit } from '../src/git-workspace.js';
import { revalidationFixture } from './revalidation-fixture.js';
import { verifyRetainedRevalidation } from '../src/revalidation-producers.js';
import { createBackup,verifyBackup,restoreBackup } from '../src/backup.js';
import { runCli } from '../src/cli.js';
import {counterRevalidator} from '../src/revalidators/counter.js';

test('R1-C actual named CLI execution commits closure, repeats deterministically and restores inactive backup /3',async()=>{
  const f=await revalidationFixture(),original=counterRevalidator.run;let calls=0;
  counterRevalidator.run=async(prepared,signal)=>{calls++;return original(prepared,signal);};try{
    const indexBefore=await readFile(path.join(f.state,'registry.json'),'utf8'),auditBefore=await readFile(path.join(f.state,'audit.jsonl'),'utf8').catch(()=>null);
    const dry=await f.cli(['drift','revalidate','--file','-','--dry-run']);assert.equal(dry.ok,true,JSON.stringify(dry.errors));assert.equal(dry.data.completion,false);assert.equal(dry.data.execution_checked,false);
    assert.equal(calls,0);assert.equal(await readFile(path.join(f.state,'registry.json'),'utf8'),indexBefore);assert.equal(await readFile(path.join(f.state,'audit.jsonl'),'utf8').catch(()=>null),auditBefore);
    const first=await f.submit();assert.equal(first.ok,true,JSON.stringify(first.errors));assert.equal(first.data.completion,true);assert.equal(first.data.execution_authenticated,true);
    assert.equal(first.data.release_changed,false);assert.equal(first.data.source_binding_advanced,false);assert.equal(first.data.behavior_verified,false);
    const records=await f.records(),completion=records[first.data.ref].data,run=records[first.data.run_ref].data;
    assert.equal(first.effects.created.length,6);assert.equal(run.results.length,3);assert.equal(run.results.every((r:any)=>r.method==='mechanical'&&r.passed&&r.reviewer===null),true);
    assert.equal('intent.review' in run.observations.checks,false);assert.equal(completion.bridge.historical_review_trust,'local-fixture');assert.equal(completion.bridge.historical_producer.execution_authenticated,false);
    assert.equal(run.observations_sha256,records[f.basis.ref].data.observations_sha256,'Equal deterministic basis observations are permitted in R1-C.');
    assert.equal(canonical(records[f.release.ref].data),f.releaseRecord);assert.equal(canonical(records[f.binding.ref].data),f.bindingRecord);assert.deepEqual(await gitPins(f.host),f.pins);
    assert.equal(await readFile(path.join(f.app,'counter.mjs'),'utf8'),f.desired);assert.equal(run.pre_observation.head_tree===completion.bridge.stage_tree_oid,false);
    assert.equal(verifyRetainedRevalidation(records,f.issuer.projectId).historical_completion_verified,true);
    const replay=await f.submit();assert.equal(replay.ok,true,JSON.stringify(replay.errors));assert.equal(replay.data.ref,first.data.ref);assert.equal(Object.keys(await f.records()).length,Object.keys(records).length);
    assert.equal(calls,1,'Committed original-key retry starts no worker.');
    const again=await f.submit('r1-second');assert.equal(again.ok,true,JSON.stringify(again.errors));assert.notEqual(again.data.ref,first.data.ref);assert.notEqual(again.data.run_ref,first.data.run_ref);
    assert.equal((await f.records())[again.data.run_ref].data.observations_sha256,run.observations_sha256);
    assert.equal(calls,2,'New key performs a fresh worker execution.');
    const conflict=await f.submit('r1-positive',{...f.request,criterion_reviews:[{...f.request.criterion_reviews[0],rationale:'Different explicit rationale.'}]});assert.equal(conflict.errors[0].code,'IDEMPOTENCY_CONFLICT');
    const inspected=await f.cli(['operation','inspect','r1-positive'],{});assert.equal(inspected.data.result.data.live_source_checked,false);
    const exact=await f.cli(['inspect','reconciliation-completion',first.data.ref],{});assert.equal(exact.ok,true,JSON.stringify(exact.errors));assert.equal(exact.data.live_source_checked,false);assert.equal(exact.data.live_authority_checked,false);assert.equal(exact.data.record_sha256,digest(completion));
    const reviewed=await f.cli(['review','reconciliation-completion',first.data.ref],{});assert.equal(reviewed.ok,true,JSON.stringify(reviewed.errors));assert.equal(reviewed.data.execution_checked,false);assert.equal(reviewed.data.subject.record_sha256,digest(completion));
    const authRead=await f.cli(['inspect','revalidation-auth',first.data.auth_ref],{});assert.equal(authRead.ok,true,JSON.stringify(authRead.errors));assert.equal(authRead.data.live_source_checked,false);assert.equal(authRead.data.record.format,'strata-revalidation-auth/1');
    if(process.env.STRATA_R1_EVIDENCE_DIR){const directory=path.resolve(process.env.STRATA_R1_EVIDENCE_DIR);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'completion-closure-example.json'),canonical({synthetic:true,request:f.request,result:first.data,records:Object.fromEntries(Object.entries(records).filter(([,r])=>r.data.attempt_id===completion.attempt_id)),unchanged:{release_ref:f.release.ref,release_sha256:digest(records[f.release.ref].data),binding_ref:f.binding.ref,binding_sha256:digest(records[f.binding.ref].data),head:f.pins.head_commit,index_sha256:f.pins.index_digest},same_output_repeat:{first_run:first.data.run_ref,second_run:again.data.run_ref,observations_sha256:run.observations_sha256}}));}
    await f.close();
    f.issuer.clear();await rename(f.app,f.app+'-offline');
    const created=await createBackup({state:f.state,out:path.join(f.root,'backup'),project:f.issuer.projectId,selector:'fixture-backup',maxBytes:16777216});assert.equal(created.format,'strata-local-backup/3');
    const verified=await verifyBackup({bundle:created.output,project:f.issuer.projectId,selector:'fixture-backup',expectedDigest:created.manifest_sha256,ref:first.data.ref});assert.equal(verified.historical_completion_verified,true);assert.equal(verified.live_source_checked,false);
    const restored=await restoreBackup({bundle:created.output,project:f.issuer.projectId,selector:'fixture-backup',expectedDigest:created.manifest_sha256,out:path.join(f.root,'restore')});assert.equal(restored.inactive,true);assert.equal(restored.identities_active,false);assert.equal(restored.requests_active,false);
    if(process.env.STRATA_R1_EVIDENCE_DIR)await writeFile(path.join(process.env.STRATA_R1_EVIDENCE_DIR,'inactive-backup-example.json'),canonical({synthetic:true,created,verified,restored,configured_git_path_absent:true}));
    await assert.rejects(readFile(path.join(restored.output,'registry.json')));
  }finally{counterRevalidator.run=original;await f.close();}
});

test('R1-C strict requests and current scoped authority refuse before completion',async()=>{
  const f=await revalidationFixture();try{
    for(const input of [{...f.request,trust:'host-authenticated'},{...f.request,criterion_reviews:[]},{...f.request,criterion_reviews:[...f.request.criterion_reviews,...f.request.criterion_reviews]},
      {...f.request,criterion_reviews:[{criterion_ref:'counter/acceptance.add',accepted:true,rationale:'Mechanical override.'}]}])assert.equal((await f.submit('negative-'+digest(input),input)).ok,false);
    assert.equal((await f.cli(['drift','revalidate','--file','-'])).errors[0].code,'IDEMPOTENCY_REQUIRED');
    assert.equal((await f.cli(['drift','revalidate','--file','-','--idempotency-key','fixture'],f.request,'fixture-selector')).ok,false);
    const changed=structuredClone(f.policy);changed.generation++;changed.grants[0].revalidation.read_roots=[];f.issuer.reload(f.accounts,changed);
    assert.equal((await f.submit('no-path')).errors[0].code,'REVALIDATION_PATH_FORBIDDEN');assert.equal(Object.values(await f.records()).some(r=>r.type==='reconciliation-completion'),false);
  }finally{await f.close();}
});
test('R1-C a scope with zero review criteria completes without manufacturing a review receipt',async()=>{
  const f=await revalidationFixture(true);try{
    const changed=structuredClone(f.policy);changed.generation++;changed.grants[0].operations=changed.grants[0].operations.filter(op=>op!=='revalidation.criterion-review');f.issuer.reload(f.accounts,changed);
    const result=await f.submit('mechanical-only');assert.equal(result.ok,true,JSON.stringify(result.errors));const records=await f.records();
    assert.equal(records[result.data.ref].data.criterion_review,null);assert.equal(result.effects.created.length,4);assert.equal(Object.values(records).some(r=>r.type==='revalidation-criterion-review'),false);
  }finally{await f.close();}
});

test('R1-C stage/source races and policy changes leave no indexed completion',async()=>{
  const f=await revalidationFixture();try{
    f.setAfterStage(async()=>{await writeFile(path.join(f.app,'preserved.txt'),'Changed after staging\n');});const failed=await f.submit('late-source');assert.equal(failed.ok,false);assert.equal(Object.values(await f.records()).some(r=>r.type==='reconciliation-completion'),false);
    await writeFile(path.join(f.app,'preserved.txt'),'Preserved raw bytes\n');f.setAfterStage(async()=>{const accounts=structuredClone(f.accounts);accounts.generation++;accounts.accounts[0].credential_epoch++;f.issuer.reload(accounts,f.policy);});
    const authorityFailed=await f.submit('late-authority');assert.equal(authorityFailed.ok,false);assert.equal(Object.values(await f.records()).some(r=>r.type==='revalidation-auth'),false);
    if(process.env.STRATA_R1_EVIDENCE_DIR)await writeFile(path.join(process.env.STRATA_R1_EVIDENCE_DIR,'late-refusal-examples.json'),canonical({synthetic:true,late_source:failed,late_credential_rotation:authorityFailed,indexed_completion_refs:[],release_ref:f.release.ref,binding_ref:f.binding.ref}));
  }finally{await f.close();}
});

test('R1-C lost response, restart with fresh session, changed-source replay and historical inspection',async()=>{
  const f=await revalidationFixture();try{
    f.setFault('after-stage');const precommit=await f.submit('precommit');assert.equal(precommit.errors[0].code,'INJECTED_STAGE_FAILURE');assert.equal(Object.values(await f.records()).some(r=>r.type==='git-revalidation-run'),false);
    f.setFault('after-commit');const lost=await f.submit('lost-response');assert.equal(lost.errors[0].code,'INJECTED_RESPONSE_LOSS');const records=await f.records();assert.equal(Object.values(records).filter(r=>r.type==='reconciliation-completion').length,1);
    f.setFault(undefined);const fresh=await f.restart(),args=['drift','revalidate','--file','-','--idempotency-key','lost-response'];const replay=await f.cli(args,f.request,fresh);assert.equal(replay.ok,true,JSON.stringify(replay.errors));assert.equal(Object.keys(await f.records()).length,Object.keys(records).length);
    await runGit(f.app,['add','--','counter.mjs']);const stale=await f.cli(args,f.request,fresh);assert.equal(stale.ok,false);
    const historic=await f.cli(['operation','inspect','lost-response'],{},fresh);assert.equal(historic.ok,true);assert.equal(historic.data.result.data.completion,true);assert.equal(historic.data.result.data.live_source_checked,false);
    if(process.env.STRATA_R1_EVIDENCE_DIR)await writeFile(path.join(process.env.STRATA_R1_EVIDENCE_DIR,'restart-replay-examples.json'),canonical({synthetic:true,precommit_refusal:precommit,postcommit_response_loss:lost,fresh_session_replay:replay,changed_index_replay_refusal:stale,historical_inspection:historic,retained_completion_refs:Object.entries(records).filter(([,r])=>r.type==='reconciliation-completion').map(([ref])=>ref)}));
  }finally{await f.close();}
});

test('R1-C historical action/attempt/producer/result substitutions fail even with content addressing repaired',async()=>{
  const f=await revalidationFixture();try{
    const completed=await f.submit();assert.equal(completed.ok,true,JSON.stringify(completed.errors));const records=await f.records();
    const edits=[(d:any)=>d.action_input.measured_input_sha256=digest('wrong input'),(d:any)=>d.action='drift.revalidate',(d:any)=>d.attempt_id=crypto.randomUUID(),(d:any)=>d.authority.policy_sha256=digest('detached policy')];
    for(const edit of edits){const copy=structuredClone(records),exact=copy[completed.data.run_ref].data.auth.ref,data=copy[exact].data;edit(data);delete copy[exact];const replacement='revalidation-auth@'+digest(data);copy[replacement]={type:'revalidation-auth',published:true,data};copy[completed.data.run_ref].data.auth={ref:replacement,sha256:digest(data)};assert.throws(()=>verifyRetainedRevalidation(copy,f.issuer.projectId));}
    const missing=structuredClone(records);delete missing[completed.data.run_ref];assert.throws(()=>verifyRetainedRevalidation(missing,f.issuer.projectId));
  }finally{await f.close();}
});
