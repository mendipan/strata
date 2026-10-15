import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Engine,obligations } from '../src/core.js';
import { MODEL,canonical,digest,normalizeSnapshot,type Records } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { HostIssuer,HOST_OPERATIONS } from '../src/auth/host-issuer.js';
import { GitNodeAdapter } from '../src/git-adoption-node.js';
import { runGit,gitPins } from '../src/git-workspace.js';
import { applicationCheckerPins,APPLICATION_CHECKER } from '../src/git-application-checker.js';
import { runFixtureEvidence } from '../src/runner.js';
import { startLocalBroker,type Registry } from '../src/local-broker.js';
import { runCli } from '../src/cli.js';
import { normalizeRevalidationRequest,recordPin } from '../src/revalidation.js';
import type { SourceScope } from '../src/source-binding.js';

export async function revalidationFixture(mechanicalOnly=false) {
  const root=await mkdtemp(path.join(os.tmpdir(),'strata-r1-c-')),app=path.join(root,'app'),project=path.join(root,'intent'),state=path.join(project,'state'),directory=path.join(root,'git-state');
  await Promise.all([mkdir(app),mkdir(project),mkdir(directory)]);
  const legacy=new FixtureIssuer({assignments:{'fixture-r1':{principal:'scope-selector',operations:[...HOST_OPERATIONS,'source.capture','source.bind','git.plan','git.stage','git.evidence','drift.check','drift.propose','drift.review'],repositories:['counter-repo'],git_paths:['counter.mjs','preserved.txt'],git_checkers:[APPLICATION_CHECKER],executor:'synthetic-r1-basis',reviewers:['fixture-reviewer'],approvals:['scope']}}});
  const engine=new Engine({}, {},{projectId:legacy.projectId,modelVersion:MODEL});
  const base=normalizeSnapshot(JSON.parse(await readFile('tests/fixtures/counter/bootstrap.json','utf8')));engine.init(base,'bootstrap');
  const composition=JSON.parse(await readFile('tests/fixtures/counter/composition.json','utf8'));composition.proposals=[];composition.selected=[];
  const candidate=engine.compose(composition),realization=engine.realize(candidate.ref,'counter-fixture/1');
  const generated=path.join(root,'historical-generated');await mkdir(generated);
  for(const [name,body]of Object.entries(realization.files))await writeFile(path.join(generated,name),body);
  await writeFile(path.join(generated,'realization.json'),'{}');
  const evidence=await runFixtureEvidence(generated,realization,realization.oracle);
  const registered=engine.registerRealization(realization),validated=engine.validate(candidate.ref,registered.ref,evidence.evidence);
  const approvalRefs=[engine.approve({kind:'scope',target:candidate.fingerprint,scope:'counter',evidence_digest:validated.evidence_digest},'scope-selector').ref,
    engine.approve({kind:'release',target:candidate.fingerprint,scope:null,evidence_digest:validated.evidence_digest},'release-manager').ref];
  const release=engine.release(candidate.ref,validated.ref,approvalRefs),desired=engine.realize(release.ref,'counter-fixture/1').files['counter.mjs'];
  // A synthetic source edit is repaired to accepted recognized bytes. HEAD stays dirty.
  const before=desired.replace('let total = 0;','let total = 1;');
  await runGit(app,['init','--quiet']);await runGit(app,['config','user.name','R1-C Synthetic']);await runGit(app,['config','user.email','r1-c@example.invalid']);
  await writeFile(path.join(app,'counter.mjs'),before);await writeFile(path.join(app,'preserved.txt'),'Preserved raw bytes\n');await runGit(app,['add','--','.']);await runGit(app,['commit','--quiet','-m','Synthetic source baseline']);
  const host={projectId:legacy.projectId,repoId:'counter-repo',root:app},gitConfig={repositories:[host],directory,enabledCheckers:[APPLICATION_CHECKER]},adapter=new GitNodeAdapter(gitConfig,legacy.projectId,state);await adapter.initialize();
  const actor=legacy.resolve('fixture-r1'),call=(command:string,input:any)=>adapter.execute(engine,command,input,actor,legacy,false,'fixture-history');
  const active=obligations(engine.target(release.ref).snapshot).filter(o=>!mechanicalOnly||!['counter/purpose','counter/acceptance.review'].includes(o.item));
  const scope:SourceScope={format:'source-scope/1',coverage:'selected-scope',paths:['counter.mjs','preserved.txt'],watch_roots:['.'],exclusions:[],items:active.map(o=>o.item).sort(),
    mapping:active.map(o=>({item:o.item,paths:['counter.mjs','preserved.txt'],criteria:[...o.criteria].sort()})).sort((a,b)=>a.item.localeCompare(b.item)),limitations:['Finite counter plus scoped preserved bytes.']};
  const source=await call('source.capture',{repo_id:host.repoId,scope});
  const payload={format:'source-binding-payload/1',project_id:legacy.projectId,repo_id:host.repoId,intent:{release_ref:release.ref,release_sha256:digest(engine.read(release.ref)),snapshot_sha256:digest(engine.target(release.ref).snapshot),model_version:MODEL},
    source_ref:source.ref,source_sha256:digest(engine.read(source.ref)),previous_binding_ref:null,completion_ref:null,basis:'validated-release-association',acceptance_evidence_refs:[],limitations:['Owner-accepted validated Release association; completion does not advance it.']};
  const binding=await call('source.bind',{payload,expected_payload_sha256:digest(payload),rationale:'Explicit synthetic source association.',review_refs:[]});
  const oracle=engine.realize(release.ref,'counter-fixture/1').oracle!;
  const plan=await call('git.plan',{binding_ref:binding.ref,target_ref:release.ref,write_paths:['counter.mjs'],checker:applicationCheckerPins(oracle),oracle,regressions:['unrelated-byte-preservation']});
  const lines=before.trimEnd().split('\n'),next=desired.trimEnd().split('\n');
  const patch='diff --git a/counter.mjs b/counter.mjs\n--- a/counter.mjs\n+++ b/counter.mjs\n@@ -1,'+lines.length+' +1,'+next.length+' @@\n'+lines.map((line,i)=>line===next[i]?' '+line:'-'+line+'\n+'+next[i]).join('\n')+'\n';
  const stage=await call('git.stage',{plan:plan.ref,patch});
  const p=engine.read(plan.ref),s=engine.read(stage.ref);
  const basis=await call('git.evidence',{format:'git-acceptance/1',project_id:legacy.projectId,repo_id:host.repoId,plan_ref:plan.ref,stage_ref:stage.ref,target:p.target,base_source_ref:source.ref,
    result_tree_oid:s.result_tree_oid,result_manifest_sha256:s.result_manifest_sha256,acceptance_contract_sha256:p.acceptance_contract_sha256,checker:p.checker,
    results:p.criteria.map((c:any)=>({...c,passed:false,reviewer:c.method==='review'?'fixture-reviewer':null})),regressions:[{id:'unrelated-byte-preservation',passed:false}],
    limitations:['Historical imported failed basis; contract only.'],observations_sha256:digest({checks:Object.fromEntries(Object.entries(evidence.observations.checks).filter(([id])=>id!=='intent.review')),oracle_sha256:digest(oracle)}),observation_only:true});
  await writeFile(path.join(app,'counter.mjs'),desired);
  const checked=await call('drift.check',{binding_ref:binding.ref,evidence_refs:[basis.ref]}),report=engine.read(checked.ref);
  const proposed=await call('drift.propose',{report_ref:checked.ref,expected_report_sha256:digest(report),action:'revalidate',rationale:'Revalidate full selected scope.',paths:scope.paths,items:scope.items,
    layer_refs:[],patch_refs:[],evidence_refs:[basis.ref],questions:[],supersedes:null});
  const reviewed=await call('drift.review',{proposal_ref:proposed.ref,expected_proposal_sha256:digest(engine.read(proposed.ref)),decision:'approve_plan',rationale:'Explicit historic approval only.',questions:[]});
  const request=normalizeRevalidationRequest({review:recordPin(reviewed.ref,engine.read(reviewed.ref)),basis_evidence:recordPin(basis.ref,engine.read(basis.ref)),expected_observation_sha256:digest(report.observation),
    criterion_reviews:mechanicalOnly?[]:[{criterion_ref:'counter/acceptance.review',accepted:true,rationale:'I reviewed the exact pinned accepted intent, criterion and measured source.'}]});
  await mkdir(path.join(state,'artifacts'),{recursive:true});const registry:Registry={entries:{},heads:engine.ownerHeads,requests:{}};
  for(const [ref,r]of Object.entries(engine.records)){const text=canonical(r.data),hash=digest(r.data);await writeFile(path.join(state,'artifacts',hash+'.json'),text);registry.entries[ref]={hash,type:r.type,published:r.published};}
  await writeFile(path.join(state,'registry.json'),canonical(registry));
  const key=Buffer.alloc(32,93).toString('base64url');
  const accounts={format:'strata-host-accounts/1',generation:1,accounts:[{account_id:'r1-synthetic',principal_id:'scope-selector',principal_kind:'person',active:true,credential_epoch:1,key_sha256:createHash('sha256').update(key).digest('hex')}]};
  const policy={format:'strata-host-policy/3',project_id:legacy.projectId,generation:1,grants:[{grant_id:'r1-grant',principal_id:'scope-selector',operations:['inspect','status','capabilities','operation.inspect','review.state','drift.revalidate','revalidation.run','revalidation.criterion-review'],layer_ids:null,write_block_ids:['counter'],create_under_block_ids:[],approvals:[],profiles:[],lifetime:{mode:'until',expires_at:new Date(Date.now()+3600000).toISOString()},
    revalidation:{repository_ids:[host.repoId],read_roots:['.'],inventory_roots:['.'],checker_ids:[APPLICATION_CHECKER],block_ids:['counter'],review_criterion_refs:['counter/acceptance.review']}}]};
  let offset=0;const issuer=new HostIssuer(accounts,policy,()=>Date.now()+offset),token=issuer.login('r1-synthetic',key);
  let fault:'after-stage'|'after-commit'|undefined,afterStage:(()=>Promise<void>)|undefined,refresh:(()=>void)|undefined;
  const start=()=>startLocalBroker(state,0,{issuer,git:gitConfig,faultForTest:()=>fault,afterStage:async()=>afterStage?.(),refreshAuthority:()=>refresh?.()});
  let broker=await start();
  const config=JSON.parse(await readFile('strata.config.json','utf8'));config.broker=broker.url;await writeFile(path.join(project,'strata.config.json'),JSON.stringify(config));
  const cli=(args:string[],input:any=request,session=token)=>runCli([...args,'--project',project,'--json','--offline'],JSON.stringify(input),{...process.env,STRATA_SESSION:session});
  const submit=(id='r1-positive',input:any=request)=>cli(['drift','revalidate','--file','-','--idempotency-key',id],input);
  const records=async()=>{const index=JSON.parse(await readFile(path.join(state,'registry.json'),'utf8')),result:Records={};for(const [ref,e]of Object.entries(index.entries)as any)result[ref]={type:e.type,published:e.published,data:JSON.parse(await readFile(path.join(state,'artifacts',e.hash+'.json'),'utf8'))};return result;};
  return {root,app,project,state,directory,engine,request,host,gitConfig,issuer,token,key,accounts,policy,release,binding,plan,stage,basis,reviewed,desired,cli,submit,records,
    pins:await gitPins(host),sourceRecord:canonical(engine.read(source.ref)),releaseRecord:canonical(engine.read(release.ref)),bindingRecord:canonical(engine.read(binding.ref)),
    setFault:(f:typeof fault)=>{fault=f;},setAfterStage:(f:typeof afterStage)=>{afterStage=f;},setRefresh:(f:typeof refresh)=>{refresh=f;},close:()=>broker.close(),url:()=>broker.url,advance:(ms:number)=>{offset+=ms;},
    restart:async()=>{await broker.close();issuer.clear();const fresh=issuer.login('r1-synthetic',key);broker=await start();config.broker=broker.url;await writeFile(path.join(project,'strata.config.json'),JSON.stringify(config));return fresh;}};
}
