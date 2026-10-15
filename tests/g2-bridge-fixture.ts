import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine, snapshotFromRelease } from '../src/core.js';
import { MODEL, canonical, digest } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { runFixtureEvidence } from '../src/runner.js';
import { createSourceHostProof, executeSourceBinding, type SourceSnapshot } from '../src/source-binding.js';
import { executeAdoption, publicationGate } from '../src/adoption/persistent.js';
import { applicationCheckerPins, APPLICATION_CHECKER } from '../src/git-application-checker.js';
import { createGitPlan } from '../src/git-adoption.js';
import { adoptionFixture } from './adoption-fixture.js';

/** Structural unit fixture: source OIDs/proof are synthetic, not host measurements.
 * Profile evidence below is measured separately; this is not native Git qualification. */
export async function g2BridgeFixture(measureSource?: (source: SourceSnapshot, baseline: any) => Promise<SourceSnapshot>) {
  const fixture = await adoptionFixture(), project = fixture.source.project_id, repo = fixture.source.repo_id;
  const engine = new Engine({}, {}, {projectId:project}); engine.init(fixture.baseline,'bootstrap');
  const aliases:Record<string,string>={'selected.mjs':'counter.mjs','selected.test.mjs':'counter.test.mjs'};
  const rename = (name:string)=>aliases[name]??name;
  let source=structuredClone(fixture.source);
  source.entries=source.entries.map(e=>({...e,path:rename(e.path)})).sort((a,b)=>a.path.localeCompare(b.path));
  source.scope.paths=source.entries.map(e=>e.path);source.scope.mapping=source.scope.mapping.map(m=>({...m,paths:m.paths.map(rename)}));
  source.scope_sha256=digest(source.scope);source.manifest_sha256=digest(source.entries);
  if(measureSource)source=await measureSource(source,fixture.baseline);
  const sourceRef='source-snapshot@'+digest(source);engine.store(sourceRef,'source-snapshot',source);
  const inventory=structuredClone(fixture.inventory);inventory.source={ref:sourceRef,sha256:digest(source)};
  inventory.protected_paths=inventory.protected_paths.map(rename);
  inventory.units=inventory.units.map(u=>({...u,files:u.files.map(f=>({...f,path:rename(f.path)})),dependency_paths:u.dependency_paths.map(rename)}));
  if(measureSource)for(const unit of inventory.units)for(const file of unit.files){const entry=source.entries.find(entry=>entry.path===file.path)!;file.sha256=entry.sha256!;}
  const testUnit=inventory.units.find(u=>u.id==='tests')!;
  testUnit.items=Object.keys(fixture.baseline.blocks.counter.acceptance).map(id=>'counter/acceptance.'+id).sort();testUnit.criteria=[...testUnit.items];
  const basic=new FixtureIssuer(),assignments:any={};
  const operations=['adoption.prepare','adoption.review','layer.publish','source.capture','source.bind','git.plan','git.stage','git.check','git.evidence','git.review','git.apply','git.finalize','git.transaction.inspect','git.transaction.recover'];
  for(const role of ['fixture-a','fixture-preparer','fixture-runner','fixture-selector']) {
    const context=basic.resolve(role);
    assignments[role]={principal:context.principal_id,operations:[...context.allowed_operations,...operations],repositories:[repo],git_paths:source.scope.paths,git_checkers:[APPLICATION_CHECKER],
      ...(role==='fixture-runner'?{executor:'strata-local-fixture-runner/1',reviewers:['fixture-reviewer']}:{}),...(role==='fixture-selector'?{approvals:['scope','resolution']}: {})};
  }
  const issuer=new FixtureIssuer({project_id:project,assignments}),owner=issuer.resolve('fixture-a');
  const oracleFor=(target:string,maximum:number)=>({format:'counter-oracle/1',snapshot_sha256:digest(engine.target(target).snapshot),expected:{maximum},criteria:Object.values(fixture.baseline.blocks.counter.acceptance).map(c=>({check:c.check,version:c.version,fixture:c.fixture,method:c.method})).sort((a,b)=>canonical(a).localeCompare(canonical(b)))});
  async function accept(target:string,maximum:number) {
    const realization=engine.realize(target,'counter-fixture/1'),registered=engine.registerRealization(realization),oracle=oracleFor(target,maximum);
    const directory=await mkdtemp(path.join(os.tmpdir(),'strata-g2-unit-profile-'));
    for(const [name,text] of Object.entries(realization.files))await writeFile(path.join(directory,name),text);
    await writeFile(path.join(directory,'realization.json'),'{}');
    const measured=await runFixtureEvidence(directory,realization,oracle as any),validation=engine.validate(target,registered.ref,measured.evidence),evaluation=engine.target(target);
    const approvals=[engine.approve({kind:'scope',target:evaluation.fingerprint,scope:evaluation.scope,evidence_digest:validation.evidence_digest},'scope-selector').ref,engine.approve({kind:'release',target:evaluation.fingerprint,scope:null,evidence_digest:validation.evidence_digest},'release-manager').ref];
    return {release:engine.release(target,validation.ref,approvals),validation,realization,oracle};
  }
  const recipe={id:'G2Baseline',revision:1,model_version:MODEL,baseline:'CounterBaseline@1',proposals:[],selected:[],alternative_groups:[],scenario:{id:'bounded-counter',checks:[{id:'counter.compatibility',version:'1'}]},resolutions:[]};
  const original=engine.compose(recipe),acceptedBaseline=await accept(original.ref,6);
  const layer={...fixture.layer,baseline:acceptedBaseline.release.ref};
  const prepared:any=executeAdoption(engine,'adoption.prepare',{inventory,layer},owner,issuer);
  const interpretation=executeAdoption(engine,'adoption.review',{proposal_ref:prepared.ref,expected_proposal_sha256:prepared.proposal_sha256,accepted:true,rationale:'Structural unit interpretation, not a measured source claim.'},owner,issuer);
  const proof=(s:SourceSnapshot)=>createSourceHostProof(s,{format:'git-observation/1',project_id:project,repo_id:repo,object_format:s.object_format,head_commit:s.head_commit,head_tree:s.head_tree,index_sha256:'f'.repeat(64),scope_sha256:s.scope_sha256,entries:s.entries,manifest_sha256:s.manifest_sha256,status:[],outside_scope_dirty:false,ignored_count:0,excluded_count:0,unsupported:[],coherence:'stable',trust:'local-measurement'});
  const publicationData=publicationGate(engine,prepared.draft_ref,interpretation.ref,owner,issuer,proof(source)),publicationRef='adoption-publication@'+digest(publicationData);
  engine.store(publicationRef,'adoption-publication',publicationData,false);
  engine.adoptionPublication=()=>({ref:publicationRef});engine.publish(prepared.draft_ref,'author-a',undefined,undefined,interpretation.ref);engine.adoptionPublication=undefined;
  const changed=engine.compose({...recipe,id:'G2Changed',baseline:acceptedBaseline.release.ref,proposals:[prepared.draft_ref],selected:[prepared.draft_ref]}),accepted=await accept(changed.ref,12);
  const bindingSource=structuredClone(source);bindingSource.scope.paths=['counter.mjs','counter.test.mjs'];bindingSource.entries=source.entries.filter(e=>bindingSource.scope.paths.includes(e.path));
  bindingSource.scope.mapping=source.scope.mapping.map(m=>({...m,paths:m.item.startsWith('counter/acceptance.')?['counter.mjs','counter.test.mjs']:['counter.mjs']}));
  bindingSource.scope_sha256=digest(bindingSource.scope);bindingSource.manifest_sha256=digest(bindingSource.entries);
  const bindingSourceRef='source-snapshot@'+digest(bindingSource);engine.store(bindingSourceRef,'source-snapshot',bindingSource);
  const release=engine.read(acceptedBaseline.release.ref,'release'),payload={format:'source-binding-payload/1',project_id:project,repo_id:repo,intent:{release_ref:acceptedBaseline.release.ref,release_sha256:digest(release),snapshot_sha256:digest(snapshotFromRelease(release)),model_version:MODEL},source_ref:bindingSourceRef,source_sha256:digest(bindingSource),previous_binding_ref:null,completion_ref:null,basis:'validated-release-association',acceptance_evidence_refs:[],limitations:['Unit-test source pins are synthetic.']};
  const binding=executeSourceBinding(engine,'source.bind',{payload,expected_payload_sha256:digest(payload),rationale:'Structural baseline association.',review_refs:[]},issuer.resolve('fixture-selector'),issuer,proof(bindingSource));
  const input={binding_ref:binding.ref,target_ref:changed.ref,write_paths:['counter.mjs'],checker:applicationCheckerPins(accepted.oracle as any),oracle:accepted.oracle,regressions:['unrelated-byte-preservation']};
  const preview:any=createGitPlan(engine,{...input,adoption:{publication_ref:publicationRef,expected_bridge_sha256:null}},owner,issuer,true);
  const result:any=createGitPlan(engine,{...input,adoption:{publication_ref:publicationRef,expected_bridge_sha256:preview.bridge_sha256}},owner,issuer);
  return {engine,issuer,assignments,owner,source,bindingSource,inventory,prepared,interpretation,publicationRef,layer,changed,accepted,acceptedBaseline,input,preview,result,project,repo,binding};
}
