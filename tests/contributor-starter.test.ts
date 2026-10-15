import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BLOCK_MODEL, canonical, digest } from '../src/model.js';
import { prepareContributor, startContributor, CONTRIBUTOR_SLOTS } from '../scripts/contributor-starter.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const decode=async(file:string)=>JSON.parse(await readFile(file,'utf8'));
async function child(args:string[],input?:unknown,env:NodeJS.ProcessEnv=process.env) {
  return new Promise<{exit:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const p=spawn(process.execPath,['--import',pathToFileURL(path.join(repo,'tests/no-external-fetch.mjs')).href,...args],{cwd:repo,env,stdio:['pipe','pipe','pipe']}); let stdout='',stderr='';
    const timer=setTimeout(()=>{p.kill();reject(new Error('Finite local CLI timeout.'));},20000);
    p.stdout.on('data',data=>{stdout+=data;if(stdout.length>4*1024*1024)p.kill();});
    p.stderr.on('data',data=>{stderr+=data;if(stderr.length>65536)p.kill();});
    p.on('error',error=>{clearTimeout(timer);reject(error);});
    p.on('close',exit=>{clearTimeout(timer);resolve({exit,stdout,stderr});});
    p.stdin.end(input===undefined?'':JSON.stringify(input));
  });
}
test('fresh contributor uses public CLI, separated synthetic roles and existing Studio against one persistent broker', {timeout:180000}, async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'strata-contributor-test-')),root=path.join(parent,'new');
  let service:Awaited<ReturnType<typeof startContributor>>|undefined;
  const receipts:any[]=[];
  try {
    const prepared=await prepareContributor(root);assert.equal(prepared.prepared,true);
    await assert.rejects(prepareContributor(root));
    service=await startContributor(root);
    const lane=await decode(path.join(root,'LANE.json'));
    assert.equal(lane.config_sha256,digest(await decode(path.join(root,'strata.config.json'))));
    assert.equal(lane.backend.studio.length,8);assert(lane.backend.studio.every((view:any)=>!view.origin.includes('#')));
    let sessions=(await decode(path.join(root,'sessions.json'))).sessions;
    const cli=async(args:string[],input?:unknown,role='reader',wanted?:string)=>{
      const result=await child([path.join(repo,'dist/src/cli.js'),...args,'--project',root,'--json','--offline','--non-interactive'],input,{...process.env,STRATA_SESSION:sessions[role]});
      assert(result.stdout.length>0,'CLI returned no envelope: '+result.stderr);const envelope=JSON.parse(result.stdout);
      if(wanted){assert.equal(envelope.ok,false);assert.equal(envelope.errors[0].code,wanted,canonical(envelope.errors));assert.notEqual(result.exit,0);}
      else{assert.equal(envelope.ok,true,args.join(' ')+' '+canonical(envelope.errors));assert.equal(result.exit,0,result.stderr);}
      return envelope.data;
    };
    const input=async(name:string)=>decode(path.join(root,'inputs',name+'.json'));
    const observation=async(slot:string,stage:string)=>{
      const result=await child([path.join(repo,'examples/contributor/collection/observe.mjs'),path.join(root,slot),stage]);
      assert.equal(result.exit,0,result.stderr);return JSON.parse(result.stdout);
    };
    // The ordinary omitted-label configuration passes shape diagnostics while
    // current authority stays unverified. Never manufacture a fixture label.
    const diagnostic=await child([path.join(repo,'dist/src/cli.js'),'doctor','--project',root,'--json','--offline']);
    const doctor=JSON.parse(diagnostic.stdout);assert.equal(doctor.data.format,'strata-doctor/1');
    assert.equal(doctor.ok,true);assert.equal(diagnostic.exit,0);
    assert.equal(doctor.data.checks.find((check:any)=>check.id==='identity_policy').status,'not_checked');
    assert.equal(doctor.data.verification.find((check:any)=>check.id==='hosted_identity').status,'not_checked');
    assert.notEqual((await decode(path.join(root,'strata.config.json'))).identity_policy,'trusted-local-fixture-sessions');
    const capabilities=await cli(['capabilities']);assert.equal(capabilities.model_version,BLOCK_MODEL);
    await cli(['init','--file','-'],await input('bootstrap'),'reader','OPERATION_FORBIDDEN');
    const seed=await cli(['init','--file','-'],await input('bootstrap'),'author-a');
    const seedRef=seed.ref;
    const seedBefore=canonical(await cli(['inspect','release',seedRef]));
    const accept=async(target:any,slot:keyof typeof CONTRIBUTOR_SLOTS,baseline:string,negative=false)=>{
      const output=await cli(['materialize',target.ref,'--profile','collection-host/1','--out',CONTRIBUTOR_SLOTS[slot]],undefined,'runner');
      const realization=(await decode(output.manifest)).record;
      if(negative){
        const file=path.join(root,CONTRIBUTOR_SLOTS[slot],'collection.mjs'),bytes=await readFile(file);
        await writeFile(file,Buffer.concat([bytes,Buffer.from('\n// changed after materialization\n')]));
        await cli(['evidence','run','--file','-'],{target:target.ref,slot,profile:'collection-host/1'},'runner','OUTPUT_TAMPERED');
        await writeFile(file,bytes);
      }
      const run=await cli(['evidence','run','--file','-'],{target:target.ref,slot,profile:'collection-host/1'},'runner');
      assert.equal(run.checks_passed,true);assert.equal(run.review_pending,true);
      if(negative) await cli(['evidence','assemble','--file','-'],{realization:output.ref,run_ref:run.ref,review_refs:[]},'runner','VALIDATION_INCOMPLETE');
      const reviewRefs=[];
      for(const criterion of realization.oracle.criteria.filter((c:any)=>c.method==='review')) {
        reviewRefs.push((await cli(['criterion','review','--file','-'],{realization:output.ref,criterion,accepted:true,rationale:'Synthetic assigned reviewer checked the exact finite collection criterion.'},'reviewer')).ref);
      }
      const assembly=await cli(['evidence','assemble','--file','-'],{realization:output.ref,run_ref:run.ref,review_refs:reviewRefs},'runner');
      const validation=await cli(['validate',target.ref,'--realization',output.manifest,'--evidence','-'],assembly.evidence,'runner');
      const current=await cli(['review','state',target.ref]);
      const generation=(await cli(['capabilities'])).mediation_generation;
      const shape={format:'approval/3',project_id:'contributor-collection',model_version:BLOCK_MODEL,baseline,
        authority_sha256:current.authority_sha256,target:target.fingerprint,evidence_digest:validation.evidence_digest,generation,expires_at:null,binding:null};
      const scope=await cli(['approve','--file','-'],{...shape,kind:'scope',scope:'collection'},'scope-selector');
      if(negative){
        await cli(['approve','--file','-'],{...shape,kind:'release',scope:null},'author-a','OPERATION_FORBIDDEN');
        await cli(['release',target.ref,'--validation',validation.ref,'--approval',scope.ref],undefined,'release-manager','RELEASE_APPROVAL_REQUIRED');
      }
      const releaseApproval=await cli(['approve','--file','-'],{...shape,kind:'release',scope:null},'release-manager');
      const released=await cli(['release',target.ref,'--validation',validation.ref,'--approval',scope.ref,'--approval',releaseApproval.ref],undefined,'release-manager');
      const record=await cli(['inspect','release',released.ref]);
      assert.equal(record.format,'release/3');assert.equal(record.trust,'host-authenticated');
      receipts.push({target:target.ref,release:released.ref,realization:output.ref,run:run.ref,validation:validation.ref,
        reviews:reviewRefs,approvals:[scope.ref,releaseApproval.ref],output_tree:realization.output_tree,
        profile:realization.profile,checker:realization.checker_sha256,oracle:realization.oracle_sha256,
        observations:await observation(CONTRIBUTOR_SLOTS[slot],slot)});
      return {released,record,realization,run,validation};
    };
    const baseRecipe=await input('baseline-composition');baseRecipe.baseline=seedRef;
    const baseCandidate=await cli(['compose','--file','-'],baseRecipe,'author-a');
    const baseline=await accept(baseCandidate,'baseline',seedRef);
    const proposalRefs=[];
    for(const name of ['create-audit','change-limit']) {
      const layer=await input(name);layer.baseline=baseline.released.ref;
      const preview=await cli(['layer','preview','--file','-'],layer,'author-a');
      const draft=await cli(['layer','create','--file','-'],layer,'author-a');
      await cli(['inspect','layer',draft.ref],undefined,'reader','REF_NOT_FOUND');
      const normalized=await cli(['inspect','layer',draft.ref],undefined,'author-a');assert.equal(digest(normalized),preview.record_sha256);
      await cli(['content','review','--file','-'],{draft:normalized,expected_digest:preview.record_sha256,accepted:true,rationale:'Self-review is unavailable.'},'author-a','OPERATION_FORBIDDEN');
      const review=await cli(['content','review','--file','-'],{draft:normalized,expected_digest:preview.record_sha256,accepted:true,rationale:'Synthetic separate reviewer inspected the exact new Block or capacity proposal.'},'reviewer');
      await cli(['layer','publish',draft.ref,'--authoring-review',review.ref],undefined,'author-a');proposalRefs.push(draft.ref);
    }
    const recipe=await input('changed-composition');recipe.baseline=baseline.released.ref;recipe.proposals=proposalRefs;recipe.selected=proposalRefs;
    const changed=await cli(['compose','--file','-'],recipe,'author-a');
    const second=await accept(changed,'changed',baseline.released.ref,true);
    const audit=await cli(['inspect','block','audit','--at',second.released.ref]);assert.equal(audit.id,'audit');
    assert.equal(canonical(await cli(['inspect','release',seedRef])),seedBefore);
    const baselineRecord=canonical(baseline.record),acceptedRecord=canonical(second.record),oldToken=sessions.reader;
    const readerView=service.views.find(v=>v.role==='reader')!,viewUrl=new URL(readerView.url);
    const capability=new URLSearchParams(viewUrl.hash.slice(1)).get('session')!;
    const refresh=await fetch(new URL('/studio/v1/refresh',viewUrl.origin),{method:'POST',headers:{Authorization:'Bearer '+capability,Origin:viewUrl.origin,'Content-Type':'application/json'},body:'{}'});
    assert.equal(refresh.status,200);const refreshed:any=await refresh.json();
    const readUrl=new URL('/studio/v1/record',viewUrl.origin);readUrl.search=new URLSearchParams({type:'release',ref:second.released.ref,generation:refreshed.data.source.registry_generation}).toString();
    const ui=await fetch(readUrl,{headers:{Authorization:'Bearer '+capability}});assert.equal(ui.status,200);
    const uiRecord:any=await ui.json();const {ref:uiRef,type:uiType,status:uiStatus,...uiRelease}=uiRecord.data;
    assert.equal(uiRef,second.released.ref);assert.equal(uiType,'release');assert.equal(canonical(uiRelease),acceptedRecord);
    const capsResponse=await fetch(new URL('/studio/v1/capabilities',viewUrl.origin),{headers:{Authorization:'Bearer '+capability}});
    assert.equal(capsResponse.status,200);const caps:any=(await capsResponse.json() as any).data;
    const denied=await fetch(new URL('/studio/v1/operation',viewUrl.origin),{method:'POST',headers:{Authorization:'Bearer '+capability,Origin:viewUrl.origin,'Content-Type':'application/json'},body:JSON.stringify({command:'init',input:{record:await input('bootstrap')},idempotency_key:crypto.randomUUID(),expected_generation:caps.generation,expected_policy:caps.policy_generation})});
    assert.equal(denied.status,403);assert.equal((await denied.json() as any).error.code,'OPERATION_FORBIDDEN');
    await service.close();service=undefined;
    service=await startContributor(root);sessions=(await decode(path.join(root,'sessions.json'))).sessions;
    assert.equal((await decode(path.join(root,'LANE.json'))).lane_id,lane.lane_id);
    assert.notEqual(sessions.reader,oldToken);
    assert.equal(canonical(await cli(['inspect','release',second.released.ref])),acceptedRecord);
    assert.equal(canonical(await cli(['inspect','release',baseline.released.ref])),baselineRecord);
    const stale=await fetch(new URL('/v1/operation',service.broker),{method:'POST',headers:{'Content-Type':'application/json','X-Strata-Session':oldToken,'X-Strata-Project':'contributor-collection'},body:JSON.stringify({command:'inspect',input:{type:'release',ref:second.released.ref}})});
    const staleResult:any=await stale.json();assert.equal(staleResult.ok,false);assert.equal(staleResult.error.code,'AUTHENTICATION_REQUIRED');
    const again=await cli(['materialize',second.released.ref,'--profile','collection-host/1','--out',CONTRIBUTOR_SLOTS.independent],undefined,'runner');
    const independent=(await decode(again.manifest)).record;
    assert.equal(independent.output_tree,second.realization.output_tree);assert.deepEqual(independent.files,second.realization.files);
    assert.deepEqual(await observation(CONTRIBUTOR_SLOTS.independent,'changed'),receipts[1].observations);
    const wrong=await child([path.join(repo,'examples/contributor/collection/observe.mjs'),path.join(root,CONTRIBUTOR_SLOTS.baseline),'changed']);assert.equal(wrong.exit,6);
    await mkdir(path.join(repo,'.strata'),{recursive:true});
    await writeFile(path.join(repo,'.strata/contributor-starter-evidence.json'),canonical({format:'contributor-starter-qualification/1',synthetic:true,
      transport:'ordinary CLI processes and existing Studio HTTP; no provider',lane_id:lane.lane_id,baseline_ref:baseline.released.ref,changed_ref:second.released.ref,
      fresh_cli_processes:true,orderly_restart_exact:true,old_session_denied:true,studio_exact_read:true,independent_output_exact:true,cases:receipts})+'\n');
    // A spent policy is never silently extended by restarting this launcher.
    await service.close();service=undefined;
    const policy=await decode(path.join(root,'policy.json'));policy.generation++;for(const grant of policy.grants)grant.expires_at='2000-01-01T00:00:00.000Z';
    await writeFile(path.join(root,'policy.json'),canonical(policy));
    await assert.rejects(startContributor(root),(error:any)=>error.code==='ACCESS_REVOKED');
    assert.equal((await decode(path.join(root,'policy.json'))).generation,policy.generation);
  } finally {await service?.close();await rm(parent,{recursive:true,force:true});}
});

test('starter refuses altered binding and incomplete replacement without deleting evidence or retaining a broker lease',async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'strata-contributor-start-refusal-')),first=path.join(parent,'altered'),second=path.join(parent,'partial');
  try{
    await prepareContributor(first);const marker=await decode(path.join(first,'CONTRIBUTOR.json'));marker.slots.changed='../escaped';
    await writeFile(path.join(first,'CONTRIBUTOR.json'),canonical(marker));
    await assert.rejects(startContributor(first),(error:any)=>error.code==='INVALID_CONFIG');
    await assert.rejects(readFile(path.join(first,'.strata/state/.node-state.lock')),(error:any)=>error.code==='ENOENT');
    await prepareContributor(second);const incomplete=path.join(second,'strata.config.json.new');await writeFile(incomplete,'incomplete',{mode:0o600});
    await assert.rejects(startContributor(second),(error:any)=>error.code==='EEXIST');
    assert.equal(await readFile(incomplete,'utf8'),'incomplete');
    await assert.rejects(readFile(path.join(second,'.strata/state/.node-state.lock')),(error:any)=>error.code==='ENOENT');
    await assert.rejects(startContributor(second),(error:any)=>error.code==='EEXIST');
  }finally{await rm(parent,{recursive:true,force:true});}
});

test('successful doctor diagnosis does not restore a revoked named role or dispatch an authenticated operation',async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'strata-contributor-doctor-authority-')),root=path.join(parent,'new');
  let service:Awaited<ReturnType<typeof startContributor>>|undefined;
  try{
    await prepareContributor(root);service=await startContributor(root);
    const sessions=(await decode(path.join(root,'sessions.json'))).sessions;
    const accounts=await decode(path.join(root,'accounts.json'));accounts.generation++;accounts.accounts.find((account:any)=>account.account_id==='reader').active=false;
    await writeFile(path.join(root,'accounts.json'),canonical(accounts));
    const diagnostic=await child([path.join(repo,'dist/src/cli.js'),'doctor','--project',root,'--json','--offline']);
    assert.equal(diagnostic.exit,0);const report=JSON.parse(diagnostic.stdout);assert.equal(report.ok,true);
    assert.equal(report.data.verification.find((check:any)=>check.id==='hosted_identity').status,'not_checked');
    assert.deepEqual(report.effects.network,[]);assert.deepEqual(report.effects.created,[]);
    const request=['capabilities','--project',root,'--json','--offline','--non-interactive'];
    const denied=await child([path.join(repo,'dist/src/cli.js'),...request],undefined,{...process.env,STRATA_SESSION:sessions.reader});
    assert.equal(denied.exit,4);assert.equal(JSON.parse(denied.stdout).errors[0].code,'AUTHENTICATION_REQUIRED');
    const allowed=await child([path.join(repo,'dist/src/cli.js'),...request],undefined,{...process.env,STRATA_SESSION:sessions['author-a']});assert.equal(allowed.exit,0);
    assert.equal((await decode(path.join(root,'accounts.json'))).accounts.find((account:any)=>account.account_id==='reader').active,false);
  }finally{await service?.close();await rm(parent,{recursive:true,force:true});}
});

const powershell=spawnSync('pwsh',['-NoProfile','-Command','$PSVersionTable.PSVersion.Major'],{encoding:'utf8',timeout:5000});
test('checked-in attended PowerShell recipe creates two accepted Releases and performs exact restarted readback',
  {timeout:180000,skip:powershell.status!==0||Number(powershell.stdout.trim())<7?'PowerShell 7 is required for the attended recipe.':false},async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'strata-contributor-recipe-')),root=path.join(parent,'new');
  let service:Awaited<ReturnType<typeof startContributor>>|undefined;
  const recipe=async(readback=false)=>new Promise<{exit:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const p=spawn('pwsh',['-NoProfile','-File',path.join(repo,'examples/contributor/collection/walkthrough.ps1'),'-Project',root,...(readback?['-Readback']:['-Capacity','7','-AlternateCapacity','4','-ChangeLayerId','ContributorSeven'])],
      {cwd:repo,env:{...process.env,NODE_OPTIONS:'--import '+pathToFileURL(path.join(repo,'tests/no-external-fetch.mjs')).href},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>{p.kill();reject(new Error('Attended recipe synthetic qualification timed out.'));},120000);
    p.stdout.on('data',data=>{stdout+=data;if(stdout.length>2*1024*1024)p.kill();});p.stderr.on('data',data=>{stderr+=data;if(stderr.length>65536)p.kill();});
    p.on('error',error=>{clearTimeout(timer);reject(error);});p.on('close',exit=>{clearTimeout(timer);resolve({exit,stdout,stderr});});
    // Public synthetic test decisions, never actual owner or human attestations.
    p.stdin.end(readback?'':'ACCEPT\n'.repeat(64));
  });
  try{
    await prepareContributor(root);service=await startContributor(root);
    const first=await recipe();assert.equal(first.exit,0,first.stderr+'\n'+first.stdout.slice(-3000));
    const saved=await decode(path.join(root,'receipts/walkthrough-result.json'));
    assert.equal(saved.baseline.observations.capacity,3);assert.equal(saved.changed.observations.capacity,7);assert.equal(saved.changed.observations.audit,true);
    assert.equal(saved.changed.mediation.considered.length,3);assert.equal(saved.changed.mediation.selected.length,2);assert.equal(saved.changed.mediation.rejected.length,1);
    assert(saved.changed.mediation.selected.includes('ContributorSeven@1'));assert(saved.changed.mediation.rejected.includes('StarterAlternative@1'));
    assert.equal(saved.changed.record.baseline,saved.baseline.release);assert(saved.changed.reviews.length>0);assert.equal(saved.changed.approvals.length,2);
    await service.close();service=undefined;service=await startContributor(root);
    const again=await recipe(true);assert.equal(again.exit,0,again.stderr+'\n'+again.stdout.slice(-3000));
    const readback=await decode(path.join(root,'receipts/readback-result.json'));
    assert.equal(readback.exact_release,saved.changed.release);assert.equal(readback.output_tree,saved.changed.output_tree);
    await mkdir(path.join(repo,'.strata'),{recursive:true});
    await writeFile(path.join(repo,'.strata/contributor-walkthrough-evidence.json'),canonical({format:'contributor-recipe-qualification/1',synthetic:true,
      powershell_major:Number(powershell.stdout.trim()),attended_recipe_mechanically_exercised:true,independent_human_acceptance:false,
      baseline:saved.baseline.release,changed:saved.changed.release,readback,provider_access:false})+'\n');
  }finally{await service?.close();await rm(parent,{recursive:true,force:true});}
});
