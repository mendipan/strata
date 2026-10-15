import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Engine, snapshotFromRelease } from '../src/core.js';
import { CONTENT_MODEL, MODEL, digest, parse } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { createGitPlan, gitStore, verifyGitAcceptance } from '../src/git-adoption.js';
import { deriveGitBridge, verifyGitBridge, authorizeGitBridge, authorizeGitBridgeReviewer } from '../src/adoption/git-bridge.js';
import { executeAdoption, publicationGate } from '../src/adoption/persistent.js';
import { createSourceHostProof, validateSourceScope, sourcePath, validateSourceSnapshot } from '../src/source-binding.js';
import { g2BridgeFixture } from './g2-bridge-fixture.js';

const prepared=g2BridgeFixture();
async function trial(){const f=await prepared;return {...f,engine:new Engine(structuredClone(f.engine.records),structuredClone(f.engine.ownerHeads),{projectId:f.project})};}

test('G2-04 malformed and oversized versioned records cannot fall back to legacy',async()=>{
  const f=await trial();for(const edit of [(p:any)=>{p.target.ref='bad';},(p:any)=>{p.adoption_bridge.publication.sha256='bad';},(p:any)=>{p.format='git-change-plan/3';},(p:any)=>{p.adoption_bridge.extra=true;}]){const p=structuredClone(f.result.record);edit(p);assert.throws(()=>gitStore(f.engine,'git-change-plan',p));}
  assert.throws(()=>gitStore(f.engine,'git-change-plan',{...f.result.record,oracle:{huge:'x'.repeat(768*1024)}}),{code:'GIT_LIMIT'});
});
test('G2-07/08 independently valid alternate interpretation cannot replace selected private pin',async()=>{
  const f=await trial(),other:any=executeAdoption(f.engine,'adoption.review',{proposal_ref:f.prepared.ref,expected_proposal_sha256:f.prepared.proposal_sha256,accepted:true,rationale:'A separately retained valid interpretation review.'},f.owner,f.issuer);
  const p=structuredClone(f.result.record);p.adoption_bridge.interpretation_review={ref:other.ref,sha256:digest(f.engine.records[other.ref].data)};assert.throws(()=>verifyGitBridge(f.engine,p));
  const next=f.engine.layer({...f.layer,revision:2},'author-a',f.prepared.draft_ref);p.adoption_bridge.published_layer={ref:next.ref,sha256:digest(f.engine.read(next.ref,'layer',false))};assert.throws(()=>verifyGitBridge(f.engine,p));
});
test('G2-10 authenticated acting context is refused without a trust conversion',async()=>{
  const f=await trial();assert.throws(()=>authorizeGitBridge(f.engine,f.result.record,{...f.owner,trust_mode:'host_authenticated'},f.issuer),{code:'UNSUPPORTED_ADOPTION_BRIDGE'});
  const p=structuredClone(f.result.record);p.adoption_bridge.model_version='strata/0.2-content-experimental';assert.throws(()=>verifyGitBridge(f.engine,p));
  const other=new Engine({}, {},{projectId:f.project,modelVersion:CONTENT_MODEL});assert.throws(()=>createGitPlan(other,{...f.input,adoption:{publication_ref:f.publicationRef,expected_bridge_sha256:null}},f.owner,f.issuer,true),{code:'UNSUPPORTED_MODEL_VERSION'});
});
test('G2-10 valid reconstruction interpretation stays outside selected bridge delivery',async()=>{
  const f=await trial(),inventory={...structuredClone(f.inventory),mode:'reconstruct_declared_scope' as const};
  const proposal:any=executeAdoption(f.engine,'adoption.prepare',{inventory,layer:{...f.layer,id:'ReconstructionOnly'}},f.owner,f.issuer);
  const review:any=executeAdoption(f.engine,'adoption.review',{proposal_ref:proposal.ref,expected_proposal_sha256:proposal.proposal_sha256,accepted:true,rationale:'Valid declared reconstruction interpretation.'},f.owner,f.issuer);
  const s=f.source,proof=createSourceHostProof(s,{format:'git-observation/1',project_id:f.project,repo_id:f.repo,object_format:s.object_format,head_commit:s.head_commit,head_tree:s.head_tree,index_sha256:'f'.repeat(64),scope_sha256:s.scope_sha256,entries:s.entries,manifest_sha256:s.manifest_sha256,status:[],outside_scope_dirty:false,ignored_count:0,excluded_count:0,unsupported:[],coherence:'stable',trust:'local-measurement'});
  const publication=publicationGate(f.engine,proposal.draft_ref,review.ref,f.owner,f.issuer,proof),ref='adoption-publication@'+digest(publication);f.engine.store(ref,'adoption-publication',publication,false);
  f.engine.adoptionPublication=()=>({ref});f.engine.publish(proposal.draft_ref,'author-a',undefined,undefined,review.ref);f.engine.adoptionPublication=undefined;
  assert.throws(()=>createGitPlan(f.engine,{...f.input,adoption:{publication_ref:ref,expected_bridge_sha256:null}},f.owner,f.issuer,true),{code:'UNSUPPORTED_ADOPTION_BRIDGE'});
});
test('G2-15 absent, watched, excluded and unsupported source entries cannot become adopted relations',async()=>{
  for(const edit of [(s:any)=>{s.entries[0]={...s.entries[0],presence:'absent',kind:null,mode:null,sha256:null,byte_length:null};},(s:any)=>{s.scope.watch_roots=['.'];},(s:any)=>{s.entries[0].kind='symlink';},(s:any)=>{s.scope.exclusions=[{path:'counter.mjs',reason:'Exclude mapped input'}];}]){
    const f=await trial();edit(f.engine.records[f.result.record.adoption_bridge.inventory_source.ref].data);assert.throws(()=>verifyGitBridge(f.engine,f.result.record));
  }
});
test('G2-16 shared path and canonical set rules refuse aliases and traversal',async()=>{
  const f=await trial();for(const bad of ['../counter.mjs','/counter.mjs','C:/counter.mjs','.git/config','src/../counter.mjs'])assert.throws(()=>sourcePath(bad));
  for(const paths of [['counter.mjs','counter.mjs'],['counter.test.mjs','counter.mjs'],['counter.mjs','Counter.mjs'],['counter.mjs','counter.mjs/file']])assert.throws(()=>validateSourceScope({...f.bindingSource.scope,paths}));
});
test('G2-19 exact validated baseline and proposal binding cannot be weakened',async()=>{
  for(const edit of [(e:Engine,f:any)=>{e.records[f.binding.ref].data.payload.basis='owner-accepted-bootstrap-association';},(e:Engine,f:any)=>{e.records[f.prepared.draft_ref].data.baseline='CounterBaseline@1';},(e:Engine,f:any)=>{e.records[f.acceptedBaseline.release.ref].data.state='bootstrap';}]){const f=await trial();edit(f.engine,f);assert.throws(()=>verifyGitBridge(f.engine,f.result.record));}
});
test('G2-20 finite criterion metadata, obligation membership and recognized checker remain complete',async()=>{
  for(const edit of [(p:any)=>{p.criteria.pop();},(p:any)=>{p.criteria[0].check='unknown';},(p:any)=>{p.checker.id='arbitrary-app/1';},(p:any)=>{p.adoption_bridge.source_relation.mapping[0].criteria.push('counter/acceptance.invented');}]){const f=await trial(),p=structuredClone(f.result.record);edit(p);assert.throws(()=>verifyGitBridge(f.engine,p));}
});
test('G2-23 responsible bound source scope is required even when target scope permits reviewer',async()=>{
  const f=await trial(),evaluation=f.engine.target(f.changed.ref),snapshot=f.engine.records[f.acceptedBaseline.release.ref].data;
  snapshot.authorities.scopes.find((scope:any)=>scope.block==='counter').selectors=[];
  snapshot.authorities.scopes.push({block:'target-only-unit-seam',selectors:['scope-selector']});
  const binding=structuredClone(f.engine.records[f.binding.ref].data);binding.payload.intent.release_sha256=digest(snapshot);binding.payload.intent.snapshot_sha256=digest(snapshotFromRelease(snapshot));binding.payload_sha256=digest(binding.payload);
  const bindingRef='source-binding@'+digest(binding);f.engine.store(bindingRef,'source-binding',binding);
  const plan={...f.result.record,binding_ref:bindingRef};f.engine.target=()=>({...evaluation,scope:'target-only-unit-seam'});
  // This isolated seam exercises the dual-scope predicate. The finite counter
  // happy path currently resolves both responsibilities to counter.
  assert.throws(()=>authorizeGitBridgeReviewer(f.engine,plan,{...f.result.record.adoption_bridge.disclosure,principal:'scope-selector',grant_id:'fixture-selector'},f.issuer),{code:'AUTHORITY_FORBIDDEN'});
});
test('G2-25 exact source-read scope and grant expiry refuse despite same-principal alternative',async()=>{
  const f=await trial();for(const role of ['fixture-a','fixture-selector'] as const){const assignments=structuredClone(f.assignments);assignments['alternative']={...assignments[role]};assignments[role].git_paths=['counter.mjs'];const issuer=new FixtureIssuer({project_id:f.project,assignments});assert.equal(issuer.active(assignments[role].principal),true);assert.throws(()=>authorizeGitBridge(f.engine,f.result.record,issuer.resolve('fixture-selector'),issuer));}
});
test('G2-39 opt-out on an adopted Layer stays immutable legacy-unbridged',async()=>{
  const f=await trial(),legacy:any=createGitPlan(f.engine,f.input,f.owner,f.issuer);assert.equal(legacy.bridge,'legacy-unbridged');assert.equal(legacy.record.format,'git-change-plan/1');assert.ok(!('adoption_bridge'in legacy.record));
});
for(const entry of ['git-record-schemas','git-finalization-proof','git-adoption','git-adoption-node','adoption/git-bridge-schema','adoption/git-bridge'])test('G2 independent module entry: '+entry,async()=>{
  const run=promisify(execFile),url=new URL('../src/'+entry+'.js',import.meta.url).href;
  const result=await run(process.execPath,['--input-type=module','--eval','await import('+JSON.stringify(url)+');'],{windowsHide:true,timeout:10000});assert.equal(result.stderr,'');
});
