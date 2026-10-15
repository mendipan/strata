import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { digest, canonical, parse } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { createGitPlan, gitPlanV2Schema, gitPlanRequestSchema, verifyGitAdoptionHistory, gitAdoptionArchiveReferences } from '../src/git-adoption.js';
import { verifyGitBridge, authorizeGitBridge, verifyGitBridgeStage, gitBridgePrivateEdges } from '../src/adoption/git-bridge.js';
import { g2BridgeFixture } from './g2-bridge-fixture.js';

const prepared=g2BridgeFixture();
async function trial(){const f=await prepared;return {...f,engine:new Engine(structuredClone(f.engine.records),structuredClone(f.engine.ownerHeads),{projectId:f.project}),result:structuredClone(f.result)};}
test('G2-01/02/12 deterministic broad/narrow bridge and preview preserve legacy bytes',async()=>{
  const f=await trial(),before=Object.keys(f.engine.records);
  const preview:any=createGitPlan(f.engine,{...f.input,adoption:{publication_ref:f.publicationRef,expected_bridge_sha256:null}},f.owner,f.issuer,true);
  assert.deepEqual(Object.keys(f.engine.records),before);assert.equal(preview.bridge_sha256,f.preview.bridge_sha256);assert.equal(preview.execution_ready,false);
  assert.notEqual(preview.bridge.inventory_source.ref,preview.bridge.binding_source.ref);assert.deepEqual(preview.bridge.source_relation.preserved_paths,['counter.test.mjs','protected.bin','protected.txt']);
  const legacy:any=createGitPlan(f.engine,f.input,f.owner,f.issuer);assert.equal(legacy.record.format,'git-change-plan/1');assert.ok(!('adoption_bridge' in legacy.record));assert.equal(legacy.ref,'git-change-plan@'+digest(legacy.record));
  const again:any=createGitPlan(f.engine,f.input,f.owner,f.issuer);assert.equal(again.ref,legacy.ref);assert.equal(canonical(again.record),canonical(legacy.record));
  verifyGitAdoptionHistory(f.engine.records,f.project);
});
test('G2-03 disclosure is exact to target, oracle, authority and non-dry plan',async()=>{
  const f=await trial(),input={...f.input,adoption:{publication_ref:f.publicationRef,expected_bridge_sha256:null}};
  assert.throws(()=>createGitPlan(f.engine,input,f.owner,f.issuer),{code:'ADOPTION_DISCLOSURE_REQUIRED'});
  input.adoption.expected_bridge_sha256='0'.repeat(64) as any;assert.throws(()=>createGitPlan(f.engine,input,f.owner,f.issuer),{code:'ADOPTION_DISCLOSURE_REQUIRED'});
  const plan=structuredClone(f.result.record);plan.oracle.expected.maximum=13;assert.throws(()=>verifyGitBridge(f.engine,plan));
});
test('G2-04 strict versioned input and record reject extra fields, missing bridge and wrong formats',async()=>{
  const f=await trial();for(const bad of [{...f.input,unknown:true},{...f.input,adoption:{publication_ref:f.publicationRef}},{...f.input,adoption:{publication_ref:f.publicationRef,expected_bridge_sha256:null,grant_id:'forged'}}])assert.throws(()=>parse(gitPlanRequestSchema,bad),{code:'INVALID_RECORD'});
  const {adoption_bridge,...without}=f.result.record;assert.throws(()=>parse(gitPlanV2Schema,without));
  assert.throws(()=>parse(gitPlanV2Schema,{...f.result.record,format:'git-change-plan/3'}));
});
test('G2-05/06 other owners cannot preview private lineage and public projection retains no prose',async()=>{
  const f=await trial(),request={...f.input,adoption:{publication_ref:f.publicationRef,expected_bridge_sha256:null}};
  assert.throws(()=>createGitPlan(f.engine,request,f.issuer.resolve('fixture-selector'),f.issuer,true),{code:'REF_NOT_FOUND'});
  for(const edge of gitBridgePrivateEdges(f.result.record))assert.equal(f.engine.canInspect(edge.ref,'scope-selector'),false);
  assert.equal(f.engine.canInspect(f.result.ref,'scope-selector'),true);
  const publicText=canonical(f.result.record.adoption_bridge);for(const unit of f.inventory.units){assert.ok(!publicText.includes(unit.description));assert.ok(!publicText.includes(unit.rationale));}
});
test('G2-07/08 exact private pins and published revision cannot be swapped or laundered',async()=>{
  for(const name of ['inventory_record','proposal_record','interpretation_review','publication','published_layer'] as const){const f=await trial(),plan=structuredClone(f.result.record);plan.adoption_bridge[name].sha256='0'.repeat(64);assert.throws(()=>verifyGitBridge(f.engine,plan));}
  const f=await trial();f.engine.records[f.prepared.draft_ref].published=false;assert.throws(()=>verifyGitBridge(f.engine,f.result.record));
});
test('G2-09 selection and considered set must each retain the exact single adopted Layer',async()=>{
  for(const field of ['selected','proposals'] as const){const f=await trial();f.engine.records[f.changed.ref].data[field]=[];assert.throws(()=>verifyGitBridge(f.engine,f.result.record));}
  const f=await trial();f.engine.records[f.changed.ref].data.resolutions=['missing@1'];assert.throws(()=>verifyGitBridge(f.engine,f.result.record));
});
test('G2-11/13/14 source identity, mapping, dependencies and outside adoption cannot be invented',async()=>{
  for(const mutate of [(p:any)=>{p.adoption_bridge.source_relation.head_tree='c'.repeat(40);},(p:any)=>{p.adoption_bridge.source_relation.mapping[0].paths=[];},(p:any)=>{p.adoption_bridge.source_relation.mapping[0].unit_ids=[];},(p:any)=>{p.adoption_bridge.source_relation.mapping[0].criteria=[];},(p:any)=>{p.adoption_bridge.source_relation.mapping[0].paths.push('protected.bin');}]){const f=await trial(),plan=structuredClone(f.result.record);mutate(plan);assert.throws(()=>verifyGitBridge(f.engine,plan));}
});
test('G2-17/18 only one existing module modification is allowed',async()=>{
  const f=await trial();for(const paths of [['counter.test.mjs'],['counter.mjs','counter.test.mjs'],['protected.bin']]){const plan=structuredClone(f.result.record);plan.write_paths=paths;assert.throws(()=>verifyGitBridge(f.engine,plan));}
  const state={content:'old',sha256:'a'.repeat(64),mode:'100644'},operation={path:'counter.mjs',before:state,after:{...state,content:'new'}};
  verifyGitBridgeStage(f.result.record,{operations:[operation]});
  for(const operations of [[],[operation,operation],[{...operation,path:'counter.test.mjs'}],[{...operation,after:{...operation.after,mode:'100755'}}],[{...operation,before:{content:null,sha256:null,mode:null}}],[{...operation,after:state}]])assert.throws(()=>verifyGitBridgeStage(f.result.record,{operations}),{code:'PATCH_SCOPE'});
});
test('G2-24/25 original owner grant cannot be replaced by another active grant',async()=>{
  const f=await trial(),assignments=structuredClone(f.assignments);assignments['same-principal']={...assignments['fixture-a']};assignments['fixture-a'].operations=assignments['fixture-a'].operations.filter((x:string)=>x!=='git.plan');
  const changed=new FixtureIssuer({project_id:f.project,assignments});assert.equal(changed.active('author-a'),true);
  assert.throws(()=>authorizeGitBridge(f.engine,f.result.record,changed.resolve('fixture-selector'),changed),{code:'OPERATION_FORBIDDEN'});
  assignments['fixture-a'].principal='different-owner';const replaced=new FixtureIssuer({project_id:f.project,assignments});assert.throws(()=>authorizeGitBridge(f.engine,f.result.record,replaced.resolve('fixture-selector'),replaced),{code:'ENDORSEMENT_REVOKED'});
  const expiredAssignments=structuredClone(f.assignments);expiredAssignments['same-principal']={...expiredAssignments['fixture-a']};expiredAssignments['fixture-a'].expires_at='2000-01-01T00:00:00Z';
  const expired=new FixtureIssuer({project_id:f.project,assignments:expiredAssignments});assert.equal(expired.active('author-a'),true);assert.throws(()=>authorizeGitBridge(f.engine,f.result.record,expired.resolve('fixture-selector'),expired),{code:'ENDORSEMENT_REVOKED'});
});
test('G2-26/27 later author head and inactive grant do not rewrite structural history',async()=>{
  const f=await trial();f.engine.layer({...f.layer,revision:2},'author-a',f.prepared.draft_ref);
  verifyGitBridge(f.engine,f.result.record);authorizeGitBridge(f.engine,f.result.record,f.issuer.resolve('fixture-selector'),f.issuer);
  const changed=new FixtureIssuer({project_id:f.project,assignments:f.assignments});changed.suspendForTest('author-a');verifyGitAdoptionHistory(f.engine.records,f.project);
  assert.throws(()=>authorizeGitBridge(f.engine,f.result.record,changed.resolve('fixture-selector'),changed));
});
test('G2-37/38 typed private archive closure rejects missing, public and foreign-owner lineage',async()=>{
  const f=await trial();assert.ok(gitAdoptionArchiveReferences('git-change-plan',f.result.record).includes(f.publicationRef));
  for(const action of ['missing','published','owner'] as const){const t=await trial(),edge=gitBridgePrivateEdges(t.result.record)[0];if(action==='missing')delete t.engine.records[edge.ref];else if(action==='published')t.engine.records[edge.ref].published=true;else t.engine.records[edge.ref].data.owner='foreign-owner';assert.throws(()=>verifyGitAdoptionHistory(t.engine.records,t.project));}
});
