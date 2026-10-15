import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { canonical, bytesDigest, digest, type Records } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { APPLICATION_CHECKER } from '../src/git-application-checker.js';
import { captureGitSource, runGit, gitPins } from '../src/git-workspace.js';
import { startLocalBroker } from '../src/local-broker.js';
import { g2BridgeFixture } from './g2-bridge-fixture.js';

/** Measured native Git + actual loopback broker; seed only the reviewed contract
 * fixture records to avoid rerunning the unrelated CLI authoring flow per fault. */
export async function g2NativeFixture(binaryDependency=false) {
  const root=await mkdtemp(path.join(os.tmpdir(),'strata-g2-native-')),app=path.join(root,'app'),state=path.join(root,'state'),directory=path.join(root,'git-state');
  await mkdir(app);await mkdir(path.join(state,'artifacts'),{recursive:true});
  let old='';
  const f=await g2BridgeFixture(async(source,baseline)=>{
    const template=new Engine();template.init(baseline,'bootstrap');old=template.realize('CounterBaseline@1','counter-fixture/1').files['counter.mjs'];
    await writeFile(path.join(app,'.gitattributes'),'* -text\n');await writeFile(path.join(app,'counter.mjs'),old);
    await writeFile(path.join(app,'counter.test.mjs'),binaryDependency?new Uint8Array([0,128,255]):'// Preserved selected fixture tests; independent compiled checker is measured separately.\n');
    await writeFile(path.join(app,'protected.txt'),'Unadopted owner report\n');await writeFile(path.join(app,'protected.bin'),new Uint8Array([0,255,17,10]));
    await runGit(app,['init','--quiet','-b','main']);await runGit(app,['config','user.name','Synthetic G2 Owner']);await runGit(app,['config','user.email','fixture@example.invalid']);
    await runGit(app,['add','--','.']);await runGit(app,['commit','--quiet','-m','Synthetic original']);
    return (await captureGitSource({projectId:source.project_id,repoId:source.repo_id,root:app},source.scope,{mode:'baseline'})).snapshot;
  });
  const entries:any={};for(const [ref,record] of Object.entries(f.engine.records)){
    const bytes=canonical(record.data),hash=bytesDigest(bytes);await writeFile(path.join(state,'artifacts',hash+'.json'),bytes);entries[ref]={type:record.type,published:record.published,hash};
  }
  await writeFile(path.join(state,'registry.json'),JSON.stringify({entries,heads:f.engine.ownerHeads,requests:{}}));
  let currentIssuer=f.issuer,precommit:(()=>Promise<void>)|undefined,afterWrite:(()=>Promise<void>)|undefined,fault:'after-stage'|'after-commit'|undefined;
  const issuer=new Proxy(f.issuer,{get(_target,key){const value=(currentIssuer as any)[key];return typeof value==='function'?value.bind(currentIssuer):value;}});
  const broker=await startLocalBroker(state,0,{issuer,afterStage:async()=>{await precommit?.();},faultForTest:()=>fault,git:{repositories:[{projectId:f.project,repoId:f.repo,root:app}],directory,enabledCheckers:[APPLICATION_CHECKER],afterWriteForTest:async()=>{await afterWrite?.();}}});
  const call=async(command:string,input:any,actor='fixture-selector',options:any={})=>{
    const response=await fetch(broker.url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':actor,'x-strata-project':f.project},body:JSON.stringify({command,input,options})});
    return await response.json() as any;
  };
  const ok=async(command:string,input:any,actor?:string,options?:any)=>{const response=await call(command,input,actor,options);assert.equal(response.ok,true,JSON.stringify(response));return response.data;};
  const desired=f.accepted.realization.files['counter.mjs'],before=old.trimEnd().split('\n'),next=desired.trimEnd().split('\n');
  const patch='diff --git a/counter.mjs b/counter.mjs\n--- a/counter.mjs\n+++ b/counter.mjs\n@@ -1,'+before.length+' +1,'+next.length+' @@\n'+before.map((line,i)=>line===next[i]?' '+line:'-'+line+'\n+'+next[i]).join('\n')+'\n';
  const staged=await call('git.stage',{plan:f.result.ref,patch},'fixture-preparer');
  if(!staged.ok){await broker.close();throw Object.assign(new Error(staged.error.message),{code:staged.error.code});}
  const stage=staged.data;
  const acceptance=await ok('git.check',{stage:stage.ref,checker:APPLICATION_CHECKER,oracle:f.accepted.oracle},'fixture-runner');
  const reviewInput:any={stage:stage.ref,acceptance:acceptance.ref,release:f.accepted.release.ref,expected_target_sha256:null,accepted:true,rationale:'Review exact finite selected module and versioned bridge.'};
  const preview=await ok('git.review',reviewInput,'fixture-selector',{dry_run:true});reviewInput.expected_target_sha256=preview.target_sha256;
  const review=await ok('git.review',reviewInput);
  const load=async()=>{const registry=JSON.parse(await readFile(path.join(state,'registry.json'),'utf8')),records:Records={};for(const [ref,entry]of Object.entries(registry.entries)as any)records[ref]={type:entry.type,published:entry.published,data:JSON.parse(await readFile(path.join(state,'artifacts',entry.hash+'.json'),'utf8'))};return {registry,engine:new Engine(records,registry.heads,{projectId:f.project})};};
  return {...f,root,app,state,directory,broker,issuer,call,ok,stage,acceptance,review,reviewInput,patch,old,desired,
    pins:()=>gitPins({projectId:f.project,repoId:f.repo,root:app}),load,
    setPrecommit:(value:typeof precommit)=>{precommit=value;},setAfterWrite:(value:typeof afterWrite)=>{afterWrite=value;},setFault:(value:typeof fault)=>{fault=value;},
    replaceAssignments:(assignments:any)=>{currentIssuer=new FixtureIssuer({project_id:f.project,assignments});},resetIssuer:()=>{currentIssuer=f.issuer;},
    narrow:(role:string,operation:string)=>{const assignments=structuredClone(f.assignments);assignments[role].operations=assignments[role].operations.filter((value:string)=>value!==operation);assignments['same-principal-alternative']={...f.assignments[role]};currentIssuer=new FixtureIssuer({project_id:f.project,assignments});}
  };
}
