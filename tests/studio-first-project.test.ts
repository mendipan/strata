import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BLOCK_MODEL, canonical, digest } from '../src/model.js';
import { collectionCountRequirement } from '../src/profiles/collection-semantics.js';
import { firstProjectSchema, provisionFirstProject } from '../src/explorer/first-project.js';
import { namespaceFixture } from './namespace-fixture.js';
import { type NamespacePolicy } from '../src/explorer/namespace-policy.js';

const factory=process.env.STRATA_TEST_STUDIO_HOST_BUNDLE
  ? (await import(pathToFileURL(path.resolve(process.env.STRATA_TEST_STUDIO_HOST_BUNDLE)).href)).runNamespaceStudio
  : undefined;
const fixture=(overrides:Partial<NamespacePolicy>)=>namespaceFixture(overrides,factory);

const local={skip:process.platform!=='win32'&&process.getuid?.()!==0?'Protected POSIX fixtures require root.':false};
const spec=()=>firstProjectSchema.parse({format:'strata-studio-first-project/1',template:'collection-host/1',
  authority:'single-human-author-reviewer-validator-release',lifetime:{mode:'until',expires_at:new Date(Date.now()+3600000).toISOString()},max_items:3,max_title_length:20});

test('first-project authority requires explicit exact consent and expires before provider creation',local,async t=>{
  const f=await fixture({first_project:spec()});t.after(()=>f.server.close());await f.login();
  const s=(await f.b.send('/studio/v1/owner/connections')).data;
  assert.equal(s.scope.first_project.principal_id,f.policy.principal_id);
  const input={scope_sha256:s.scope_sha256,acknowledgment:'until-revoked-development-namespace'};
  assert.equal((await f.action('approve',input)).status,403);
  assert.equal((await f.action('approve',{...input,project_authority_sha256:'a'.repeat(64)})).status,403);
  assert.equal((await f.server.store.snapshot()).approved,false);assert.equal(f.calls.length,0);
  assert.equal((await f.action('approve',{...input,project_authority_sha256:digest(f.policy.first_project)})).status,200);
  const provisioned=provisionFirstProject(f.policy,'fresh-project','Customer collection');
  assert.equal(provisioned.baseline.blocks.collection.description?.text,'Customer collection');
  assert.deepEqual(provisioned.policy.grants[0].profiles,['collection-host/1']);
  assert.equal(provisioned.policy.grants[0].operations.some(op=>op.startsWith('profile.')||op.startsWith('build.')),false);
  assert.throws(()=>provisionFirstProject(f.policy,'fresh-project','Purpose',Date.now()+3600001));
  const expired=await fixture({first_project:{...spec(),lifetime:{mode:'until',expires_at:new Date(Date.now()-1000).toISOString()}}});
  t.after(()=>expired.server.close());await expired.prepare();
  assert.equal((await expired.action('create',{name:'expired',purpose:'Never dispatch'})).status,403);assert.equal(expired.calls.length,0);
});

test('finite project capabilities supply supported Studio defaults and reject another profile',local,async t=>{
  const f=await fixture({first_project:spec()});t.after(()=>f.server.close());await f.prepare();
  const created=await f.action('create',{name:'finite-defaults',purpose:'Supported defaults'});assert.equal(created.status,200,created.text);
  const project=created.data.projects[0],headers={'x-strata-repository':project.id};
  const actor=(await f.b.send('/studio/actor/session','POST',{},f.csrf)).data;
  const response=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers);assert.equal(response.status,200,response.text);
  const caps=response.data.data;assert.deepEqual(caps.profiles,['collection-host/1']);
  assert.deepEqual(caps.scenarios,[{id:'collection.compatibility',version:'1'}]);assert.equal(caps.output_slots[0],'baseline');
  assert.ok(caps.operations.find((op:any)=>op.operation==='release').configured);
  const denied=await f.b.send('/studio/v1/operation','POST',{command:'materialize',input:{target:'ProjectBaseline@1',profile:'counter-host/1',slot:'baseline'},
    idempotency_key:randomUUID(),expected_generation:caps.generation,expected_policy:caps.policy_generation},actor.csrf,headers);
  assert.equal(denied.status,403);assert.equal(denied.data.error.code,'PROFILE_FORBIDDEN');
});

test('fresh authenticated namespace reaches measured baseline and changed approved Release through Studio operations',local,async t=>{
  const f=await fixture({first_project:spec()});t.after(()=>f.server.close());await f.prepare();
  const created=await f.action('create',{name:'collection-project',purpose:'Customer finite collection'});assert.equal(created.status,200,created.text);
  const project=created.data.projects[0],headers={'x-strata-repository':project.id};
  let actor=(await f.b.send('/studio/actor/session','POST',{},f.csrf)).data;
  async function send(command:string,input:any,key=randomUUID()) {
    const caps=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers);assert.equal(caps.status,200,caps.text);
    return f.b.send('/studio/v1/operation','POST',{command,input,idempotency_key:key,
      expected_generation:caps.data.data.generation,expected_policy:caps.data.data.policy_generation},actor.csrf,headers);
  }
  async function op(command:string,input:any){const r=await send(command,input);assert.equal(r.status,200,r.text);return r.data.data.data;}
  const genesis=await op('inspect',{type:'release',ref:'ProjectBaseline@1'}),original=canonical(genesis);
  assert.equal(genesis.root,'collection');assert.equal(genesis.validation,undefined);
  const candidate=(id:string,baseline:string,selected:string[]=[])=>({id,revision:1,model_version:BLOCK_MODEL,baseline,
    proposals:selected,selected,alternative_groups:[],resolutions:[],scenario:{id:'bounded-collection',checks:[{id:'collection.compatibility',version:'1'}]}});
  const first=await op('compose',{record:candidate('FirstCandidate','ProjectBaseline@1')});
  async function accept(target:string,baseline:string,slot:string){
    const materialized=await op('materialize',{target,profile:'collection-host/1',slot});
    const realization=await op('inspect',{type:'realization',ref:materialized.ref});
    const measured=await op('evidence.run',{target,profile:'collection-host/1',slot});
    assert.equal(measured.checks_passed,true);assert.equal(measured.review_pending,true);assert.equal(measured.run.trust,'host-measured');
    assert.equal((await send('evidence.assemble',{realization:materialized.ref,run_ref:measured.ref,review_refs:[]})).status,409);
    const reviews=[];for(const criterion of realization.oracle.criteria.filter((c:any)=>c.method==='review')) {
      const review=await op('criterion.review',{realization:materialized.ref,criterion,accepted:true,rationale:'Human reviewed this exact synthetic criterion.'});reviews.push(review.ref);
    }
    const assembled=await op('evidence.assemble',{realization:materialized.ref,run_ref:measured.ref,review_refs:reviews});
    const validation=await op('validate',{target,slot,evidence:assembled.evidence});
    assert.equal((await send('release',{target,validation:validation.ref,approvals:[]})).status,409);
    const authority=await op('inspect',{type:'release',ref:baseline}),view=await op('review.state',{ref:target}),caps=await op('capabilities',{});
    const shape={format:'approval/3',project_id:project.project_id,model_version:BLOCK_MODEL,baseline,
      authority_sha256:digest(authority.authorities),target:view.candidate,evidence_digest:validation.evidence_digest,generation:caps.mediation_generation,expires_at:null,binding:null};
    const endorsements=[];for(const [kind,scope]of [['scope',view.responsible_scope],['guardian','policy/requirements.atomic'],['release',null]])
      endorsements.push((await op('approve',{record:{...shape,kind,scope}})).ref);
    const released=await op('release',{target,validation:validation.ref,approvals:endorsements});
    const release=await op('inspect',{type:'release',ref:released.ref});assert.equal(release.state,'validated');assert.equal(release.trust,'host-authenticated');
    return {released,release,realization,assembled,materialized};
  }
  const accepted=await accept(first.ref,'ProjectBaseline@1','baseline');
  const oldRelease=canonical(accepted.release);
  const layer={id:'IncreaseCapacity',revision:1,model_version:BLOCK_MODEL,owner:f.policy.principal_id,baseline:accepted.released.ref,intent:'Increase capacity to five items.',
    changes:[{op:'set_item',block:'policy',path:'requirements.count',expected:{kind:'value',value:collectionCountRequirement(3)},value:collectionCountRequirement(5)}],
    requires_layers:[],read_set:[],assumptions:[],acceptance:[],resolution_proposals:[],created_blocks:[],derived_from:null};
  await op('layer.create',{record:layer});
  assert.equal((await send('layer.publish',{ref:'IncreaseCapacity@1'})).status,409);
  const draft=await op('inspect',{type:'layer',ref:'IncreaseCapacity@1'}),review=await op('content.review',{record:{draft,expected_digest:digest(draft),accepted:true,rationale:'Human reviewed this exact capacity change.'}});
  await op('layer.publish',{ref:'IncreaseCapacity@1',authoring_review:review.ref});
  const next=await op('compose',{record:candidate('ChangedCandidate',accepted.released.ref,['IncreaseCapacity@1'])});
  const changed=await accept(next.ref,accepted.released.ref,'change');
  assert.equal(changed.realization.oracle.expected.max_items,5);assert.notEqual(changed.realization.output_tree,accepted.realization.output_tree);
  assert.equal((await send('validate',{target:next.ref,slot:'change',evidence:accepted.assembled.evidence})).status,409);
  assert.equal(canonical(await op('inspect',{type:'release',ref:'ProjectBaseline@1'})),original);
  assert.equal(canonical(await op('inspect',{type:'release',ref:accepted.released.ref})),oldRelease);
  const manifest=path.join(f.config.projects_directory,digest({repository_id:project.id}),'broker','.strata/releases/change/collection.mjs');
  const bytes=await readFile(manifest,'utf8');await writeFile(manifest,bytes+'\n// tampered');
  assert.equal((await send('evidence.run',{target:next.ref,profile:'collection-host/1',slot:'change'})).status,409);await writeFile(manifest,bytes);
  const usage=await f.server.store.usageSnapshot(),calls=f.calls.length;
  await f.restart();await f.login();actor=(await f.b.send('/studio/actor/session','POST',{},f.csrf)).data;
  assert.equal(f.calls.length,calls);assert.deepEqual(await f.server.store.usageSnapshot(),usage);
  assert.equal(canonical(await op('inspect',{type:'release',ref:changed.released.ref})),canonical(changed.release));
  assert.equal((await f.action('pause')).status,200);
  assert.equal((await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers)).status,403);
});
