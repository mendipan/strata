import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { digest, bytesDigest } from '../src/model.js';
import { createGitPlan, gitStore } from '../src/git-adoption.js';
import { bridgeAuthority } from '../src/adoption/git-bridge.js';
import { gitFinalizationBindingProof } from '../src/git-finalization-proof.js';
import { validateBindingCompletion } from '../src/source-binding.js';
import { g2BridgeFixture } from './g2-bridge-fixture.js';

const prepared=g2BridgeFixture();
/** Retained-record unit proof with synthetic OIDs and observations. Native
 * owner commit/finalization is measured separately; this is not behavior evidence. */
async function closure(bridged=true) {
  const f=await prepared,engine=new Engine(structuredClone(f.engine.records),structuredClone(f.engine.ownerHeads),{projectId:f.project});
  const plan:any=bridged?f.result:createGitPlan(engine,f.input,f.owner,f.issuer),p=plan.record;
  const source=structuredClone(f.bindingSource),resultTree='d'.repeat(40),commit='e'.repeat(40);
  source.head_commit=commit;source.head_tree=resultTree;
  source.entries=source.entries.map(e=>e.path==='counter.mjs'?{...e,byte_length:3,sha256:bytesDigest('new')}:e);source.manifest_sha256=digest(source.entries);
  const stage=gitStore(engine,'git-patch-stage',{format:'git-patch-stage/1',project_id:f.project,repo_id:f.repo,plan_ref:plan.ref,patch:'Structural proof fixture',patch_sha256:bytesDigest('Structural proof fixture'),operations:[{path:'counter.mjs',before:{content:'old',sha256:bytesDigest('old'),mode:'100644'},after:{content:'new',sha256:bytesDigest('new'),mode:'100644'}}],result_tree_oid:resultTree,result_manifest_sha256:source.manifest_sha256,unchanged_outside_write_set:true,base_index_digest:'f'.repeat(64),owner:'preparer'});
  const acceptance=gitStore(engine,'git-acceptance',{format:bridged?'git-acceptance/2':'git-acceptance/1',project_id:f.project,repo_id:f.repo,plan_ref:plan.ref,stage_ref:stage.ref,target:p.target,base_source_ref:p.base_source_ref,result_tree_oid:resultTree,result_manifest_sha256:source.manifest_sha256,acceptance_contract_sha256:p.acceptance_contract_sha256,checker:p.checker,results:p.criteria.map((c:any)=>({...c,passed:true,reviewer:c.method==='review'?'fixture-reviewer':null})),regressions:p.regressions.map((id:string)=>({id,passed:true})),producer:{principal:'fixture-runner',trust:'local-fixed-fixture',execution_authenticated:false,...(bridged?bridgeAuthority(f.issuer.resolve('fixture-runner'),f.issuer):{})},limitations:['Synthetic retained-record proof only.'],observations_sha256:digest({synthetic:true})});
  const release=engine.read(f.accepted.release.ref,'release'),target={project_id:f.project,repo_id:f.repo,stage_ref:stage.ref,stage_sha256:digest(stage.record),acceptance_ref:acceptance.ref,acceptance_sha256:digest(acceptance.record),plan_ref:plan.ref,binding_ref:f.binding.ref,release_ref:f.accepted.release.ref,release_sha256:digest(release),candidate:p.target.candidate_fingerprint,snapshot_sha256:p.target.snapshot_sha256,responsible_scope:'counter',policy_version:'fixture-policy/1',...(bridged?{adoption_bridge_sha256:digest(p.adoption_bridge),reviewer:bridgeAuthority(f.issuer.resolve('fixture-selector'),f.issuer)}:{})};
  const review=gitStore(engine,'git-apply-review',{format:bridged?'git-apply-review/2':'git-apply-review/1',target,target_sha256:digest(target),principal:'scope-selector',trust:'local-fixture',accepted:true,rationale:'Synthetic structural completion proof.'});
  const receipt=gitStore(engine,'git-apply-receipt',{format:'git-apply-receipt/1',project_id:f.project,repo_id:f.repo,transaction_id:digest({synthetic:true}),plan_ref:plan.ref,stage_ref:stage.ref,review_ref:review.ref,binding_ref:f.binding.ref,base_commit:f.bindingSource.head_commit,base_tree:f.bindingSource.head_tree,result_tree_oid:resultTree,paths:['counter.mjs'],state:'applied-awaiting-owner-commit',principal:'scope-selector'});
  const completion=gitStore(engine,'git-finalization',{format:'git-finalization/1',project_id:f.project,repo_id:f.repo,receipt_ref:receipt.ref,binding_ref:f.binding.ref,stage_ref:stage.ref,review_ref:review.ref,acceptance_ref:acceptance.ref,release_ref:f.accepted.release.ref,release_sha256:digest(release),snapshot_sha256:p.target.snapshot_sha256,candidate:p.target.candidate_fingerprint,head_commit:commit,head_tree:resultTree,base_commit:f.bindingSource.head_commit,principal:'scope-selector'});
  const payload={format:'source-binding-payload/1' as const,project_id:f.project,repo_id:f.repo,intent:{release_ref:f.accepted.release.ref,release_sha256:digest(release),snapshot_sha256:p.target.snapshot_sha256,model_version:release.model_version},source_ref:'source-snapshot@'+digest(source),source_sha256:digest(source),previous_binding_ref:f.binding.ref,completion_ref:completion.ref,basis:'validated-release-association' as const,acceptance_evidence_refs:[acceptance.ref],limitations:[]};
  return {engine,plan,stage,acceptance,review,receipt,completion,payload,source};
}

test('G2-REVIEW-002 positive versioned and genuine legacy retained completion proofs',async()=>{
  for(const bridged of [true,false]){const f=await closure(bridged),before=digest(f.engine.records);assert.deepEqual(gitFinalizationBindingProof(f.engine.records,f.completion.ref),f.completion.record);validateBindingCompletion(f.engine,f.payload,f.source);assert.equal(digest(f.engine.records),before);}
});

const faults:[string,(f:Awaited<ReturnType<typeof closure>>)=>void][]=[
  ['missing plan',f=>{delete f.engine.records[f.plan.ref];}],
  ['unverified legacy downgrade',f=>{const {adoption_bridge,...base}=f.plan.record;f.engine.records[f.plan.ref].data={...base,format:'git-change-plan/1'};}],
  ['wrong plan type',f=>{f.engine.records[f.plan.ref].type='git-apply-review';}],
  ['unpublished plan',f=>{f.engine.records[f.plan.ref].published=false;}],
  ['unknown plan format',f=>{f.engine.records[f.plan.ref].data.format='git-change-plan/3';}],
  ['missing receipt',f=>{delete f.engine.records[f.receipt.ref];}],
  ['wrong receipt type',f=>{f.engine.records[f.receipt.ref].type='git-change-plan';}],
  ['receipt content substitution',f=>{f.engine.records[f.receipt.ref].data.plan_ref='missing@1';}],
  ['unverified acceptance downgrade',f=>{f.engine.records[f.acceptance.ref].data.format='git-acceptance/1';}],
  ['unverified review downgrade',f=>{f.engine.records[f.review.ref].data.format='git-apply-review/1';}],
];
for(const [name,edit]of faults)test('G2-REVIEW-002 completion refuses '+name,async()=>{
  const f=await closure();edit(f);const before=digest(f.engine.records);
  assert.throws(()=>gitFinalizationBindingProof(f.engine.records,f.completion.ref));
  assert.throws(()=>validateBindingCompletion(f.engine,f.payload,f.source));assert.equal(digest(f.engine.records),before);
});

test('G2-REVIEW-002 valid legacy plan cannot downgrade retained versioned endorsements',async()=>{
  const f=await closure(),{adoption_bridge,...base}=f.plan.record;
  const plan=gitStore(f.engine,'git-change-plan',{...base,format:'git-change-plan/1'});
  const stage=gitStore(f.engine,'git-patch-stage',{...f.stage.record,plan_ref:plan.ref});
  const acceptance=gitStore(f.engine,'git-acceptance',{...f.acceptance.record,plan_ref:plan.ref,stage_ref:stage.ref});
  const target={...f.review.record.target,plan_ref:plan.ref,stage_ref:stage.ref,stage_sha256:digest(stage.record),acceptance_ref:acceptance.ref,acceptance_sha256:digest(acceptance.record)};
  const review=gitStore(f.engine,'git-apply-review',{...f.review.record,target,target_sha256:digest(target)});
  const receipt=gitStore(f.engine,'git-apply-receipt',{...f.receipt.record,plan_ref:plan.ref,stage_ref:stage.ref,review_ref:review.ref});
  const completion=gitStore(f.engine,'git-finalization',{...f.completion.record,receipt_ref:receipt.ref,stage_ref:stage.ref,review_ref:review.ref,acceptance_ref:acceptance.ref});
  const payload={...f.payload,completion_ref:completion.ref,acceptance_evidence_refs:[acceptance.ref]};
  assert.throws(()=>gitFinalizationBindingProof(f.engine.records,completion.ref),{code:'SOURCE_COMPLETION_REQUIRED'});
  assert.throws(()=>validateBindingCompletion(f.engine,payload,f.source),{code:'SOURCE_COMPLETION_REQUIRED'});
});
