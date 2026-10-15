import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { BLOCK_MODEL, canonical, digest, bytesDigest } from '../src/model.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION } from '../src/build-operations.js';
import { createNamespaceBuildRepository, namespaceBuildOutput, namespaceBuildHost, namespaceBuildStudioPort } from '../src/explorer/namespace-build.js';
import { NamespaceProfilesStudioAdapter } from '../src/explorer/namespace-profiles.js';
import { startLocalBroker, type RepositoryTransaction } from '../src/local-broker.js';
import { latestAttempt } from '../src/build-attempt-records.js';
import { validateRecords } from '../src/explorer/validate.js';
import { normalizeBuildProfile } from '../src/build-contracts.js';
import { profileInput } from '../src/build-records.js';
import { localBuildFixture } from './build-local-fixture.js';
import { workspaceRuntimeFixture } from './workspace-runtime-fixture.js';
import { prepareNamespaceBuild } from '../src/explorer/namespace-build-preparation.js';
import { writeNamespaceBuildPacket } from '../scripts/prepare-namespace-build.js';
import { HostIssuer } from '../src/auth/host-issuer.js';
const code=(name:string)=>(e:any)=>e.code===name;
async function fixture(name:string) {
  const source=await localBuildFixture('namespace-'+name),scope={project_id:source.issuer.projectId,repository_id:'immutable-test-id',source_trust:'host-authenticated' as const,authority_ref:'HostCollectionBaseline@1'};
  const f=await workspaceRuntimeFixture({seed:source.engine,principal:'release-manager',profileScope:scope,
    runtimeOperations:[...BUILD_OPERATIONS,BUILD_RECOVERY_OPERATION,'materialize','realization.register','evidence.run'],finiteProfiles:['collection-host/1']});
  let repository!:ReturnType<typeof createNamespaceBuildRepository>,broker!:Awaited<ReturnType<typeof startLocalBroker>>;
  let failCommit:(command:string,input:any)=>boolean=()=>false,loseResponse:(command:string,input:any)=>boolean=()=>false;
  const output=namespaceBuildOutput({output:{...source.output.slot,excluded_roots:[...source.output.slot.excluded_roots,f.root]}},[f.root,process.cwd()]);
  const open=async()=>{
    const active=await f.start();await active.broker.close();
    broker=await startLocalBroker(f.directories.broker,0,{issuer:f.issuer,model_version:BLOCK_MODEL,artifacts:active.runtime.store,workspace:active.runtime.brokerControls(),
      repository:{scope,build:(command,input,context,options)=>repository.execute(command,input,context,options)}});
    const transaction:RepositoryTransaction=(context,command,input,options,work)=>broker.repositoryTransaction(context,command,input,options,async(engine,registry)=>{
      const result=await work(engine,registry);if(result.write&&failCommit(command,input))throw Error('Synthetic precommit interruption');return result;
    }).then(result=>{if(loseResponse(command,input))throw Error('Synthetic committed response loss');return result;});
    repository=createNamespaceBuildRepository({issuer:f.issuer,scope,model_version:BLOCK_MODEL,output,host:namespaceBuildHost({output:output.slot}),transaction});
  };
  await open();
  try {
  const context=()=>f.issuer.resolve(f.token);
  const imp={record:{format:'strata-repository-compatibility/1',id:'NamespaceContract',revision:1,rules:[],preferences:[]},previous:null};
  await repository.review('repository.contract.import',imp,context(),{key:'review-contract'});
  const contract=(await repository.execute('repository.contract.import',imp,context(),{key:'contract'})).data;
  const attach={release_ref:source.release.ref,contract_ref:contract.ref,expected_release_sha256:digest(source.engine.read(source.release.ref))};
  await repository.review('repository.contract.attach',attach,context(),{key:'review-adopt'});
  await repository.execute('repository.contract.attach',attach,context(),{key:'adopt'});
  const {format,project_id,repository_id,previous,author,auth_receipt,derived_from,...profile}=source.profile;
  const record={...profile,id:'NamespaceProfile',contract_ref:contract.ref,contract_sha256:contract.sha256};
  const saved=(await repository.execute('profile.create',{record,expected_normalized_sha256:digest(normalizeBuildProfile(record))},context(),{key:'profile'})).data;
  const selection={release_ref:source.release.ref,profile_ref:saved.ref,destination:{kind:'local',slot_id:output.slot.id}};
  const call=async(command:string,input:any={},key?:string,headers:Record<string,string>={})=>{
    const res=await fetch(broker.url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':f.token,'x-strata-project':scope.project_id,'x-strata-artifact-adapter':'cloudflare-artifacts-remote',...headers},body:JSON.stringify({command,input,options:{idempotency_key:key}})});
    return res.json() as Promise<any>;
  };
  const records=async()=>{const registry=JSON.parse(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'));return (await broker.repositoryTransaction(context(),'build.inspect',{}, {dry_run:true},async engine=>({data:structuredClone(engine.records)})));};
  return {...f,source,scope,output,selection,context,call,records,get repository(){return repository;},get broker(){return broker;},
    fail:(predicate:typeof failCommit)=>failCommit=predicate,lose:(predicate:typeof loseResponse)=>loseResponse=predicate,
    async restart(){await repository.close();await broker.close();await open();},async close(){await repository.close();await broker.close();}};
  } catch(error) {await repository.close();await broker.close();throw error;}
}
test('namespace sole writer persists exact Local receipt, repeated original request, outputs and mechanical measurements across restart',async t=>{
  const f=await fixture('vertical');t.after(()=>f.close());
  const before=await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),counts=f.counts();
  const outputBefore=await readdir(f.output.slot.root);
  const prepared=await f.call('build.prepare',f.selection);assert.equal(prepared.ok,true,JSON.stringify(prepared));
  assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),before);assert.deepEqual(f.counts(),counts);
  assert.deepEqual(await readdir(f.output.slot.root),outputBefore);
  const request={selection:f.selection,expected_plan_sha256:prepared.data.plan_sha256};
  const result=await f.call('build.start',request,'original');assert.equal(result.ok,true,JSON.stringify({result,pending:(await f.control.snapshot()).operations.filter(o=>!['committed','cancelled_before_effect'].includes(o.phase)).map(o=>({phase:o.phase,events:o.events.map(e=>e.phase)}))}));const run=result.data;
  assert.equal(run.phase,'completed',JSON.stringify(run));assert.deepEqual(run.verification,{bytes:true,mechanical:true,fresh_semantic_validation:false});
  assert.equal(run.plan.release.ref,f.source.release.ref);assert.equal(run.plan.profile.ref,f.selection.profile_ref);
  assert.equal(run.plan.selection.destination.kind,'local');assert.equal(run.plan.source_trust,'host-authenticated');
  const index=JSON.parse(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'));
  assert.ok(index.workspace_commits);assert.ok(Object.values(index.entries).some((e:any)=>e.type==='build-child-receipt'&&e.locator));
  const stored=await f.records();assert.equal(Object.values(stored).filter(r=>r.type==='build-child-receipt').length,2);
  const outputs=(await f.call('build.outputs',{build_id:run.build_id})).data;assert.equal(outputs.files.length,run.inventory.length);
  const module=outputs.files.find((file:any)=>file.name==='collection.mjs');assert.ok(module);
  const bytes=await f.repository.download(run.build_id,module.file_id,f.context());assert.ok(bytes.includes(Buffer.from('export')));
  assert.equal(bytesDigest(bytes),bytesDigest(await readFile(path.join(f.output.slot.root,run.allocation.relative,module.name))));
  const after=f.counts();await f.restart();
  assert.deepEqual((await f.call('build.start',request,'original')).data,run);assert.deepEqual(f.counts(),after);
  assert.equal((await f.call('operation.inspect',{key:'original'})).data.result.data.build_id,run.build_id);
  assert.equal((await f.call('build.start',{...request,selection:{...f.selection,profile_ref:f.source.release.ref}},'original')).error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.call('build.reconcile',{})).error.code,'UNSUPPORTED_CAPABILITY');
  // An explicitly authorized replacement actor must get the same complete
  // historical view/CAS as Build, including the old attempt auth closure.
  const accounts=structuredClone(f.accounts),policy=structuredClone(f.policy);accounts.generation++;
  accounts.accounts.push({...accounts.accounts[0],account_id:'replacement-account',principal_id:'replacement-actor'});accounts.accounts[0].active=false;
  policy.generation++;policy.grants.push({...policy.grants[0],grant_id:'replacement-grant',principal_id:'replacement-actor'});
  f.issuer.reload(accounts,policy);const token=await f.issuer.loginOwner({}),current=f.issuer.resolve(token);
  const res=await fetch(f.broker.url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':token,'x-strata-project':f.scope.project_id},body:JSON.stringify({command:'studio.snapshot',input:{}})});
  const snapshot=(await res.json() as any).data;validateRecords(snapshot.records,f.scope.project_id,BLOCK_MODEL);
  assert.equal(snapshot.generation,(await f.repository.snapshot(current)).generation);
  await assert.rejects(f.repository.download(run.build_id,'0'.repeat(64),current),code('OUTPUT_LOCATOR_INVALID'));
  const actual=path.join(f.output.slot.root,run.allocation.relative,module.name);await writeFile(actual,'changed');
  await assert.rejects(f.repository.download(run.build_id,module.file_id,current),code('OUTPUT_TAMPERED'));
  policy.generation++;(policy.grants.find(g=>g.principal_id==='replacement-actor') as any).build_repository_ids=[];
  f.issuer.reload(accounts,policy);const denied=f.issuer.resolve(await f.issuer.loginOwner({})),unchanged=f.counts();
  await assert.rejects(f.repository.download(run.build_id,module.file_id,denied),code('REPOSITORY_FORBIDDEN'));assert.deepEqual(f.counts(),unchanged);
});

test('offline operator preparation seals an inactive exact tuple without changing writer, permissions or output',async t=>{
  const f=await fixture('preparation');t.after(()=>f.close());
  const records=await f.records(),registry=JSON.parse(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'));
  const imported={...f.imported,registry:{entries:registry.entries,storage:registry.storage,asset_locators:registry.asset_locators??{},heads:{},requests:{},contexts:{}},
    record_bytes:Object.fromEntries(Object.entries(records).map(([ref,r])=>[ref,canonical(r.data)]))};
  const policy=structuredClone(f.policy);policy.grants[0].operations=policy.grants[0].operations.filter(op=>op!=='build.reconcile');
  const grant={...f.grant,import_manifest_sha256:digest(imported),actor_binding_sha256:digest({accounts:f.accounts,policy})};
  const pin=(type:string)=>{const row=Object.entries(records).find(([,r])=>r.type===type)!;return {ref:row[0],sha256:digest(row[1].data)};};
  const input={format:'strata-namespace-build-preparation/1',source_genesis_sha256:digest('original-genesis'),source_catalog_sha256:digest('original-catalog'),
    source_grant:f.grant,proposed_manifest:{grant,imported,accounts:f.accounts,policy,baseline:null,profiles:{authority_ref:f.scope.authority_ref}},
    catalog_project:{id:f.scope.repository_id,name:grant.storage.repository,remote:grant.storage.remote,read_only:false,project_id:grant.project_id,
      creation_id:grant.grant_id,state:'ready',automatic_token_expires_at:null,model_version:BLOCK_MODEL,genesis_sha256:digest('original-genesis')},
    launcher:{format:'strata-namespace-local-build-host/1',repository_ids:[f.scope.repository_id],output:{id:f.output.slot.id,label:'Synthetic output',root:f.output.slot.root,excluded_roots:[f.root,process.cwd()]}},
    release:{ref:f.source.release.ref,sha256:digest(records[f.source.release.ref].data)},contract:pin('repository-compatibility'),adoption:pin('release-build-binding'),
    profile:{ref:f.selection.profile_ref,sha256:digest(records[f.selection.profile_ref].data)},actor_grant_id:policy.grants[0].grant_id,reviewer_grant_id:policy.grants[0].grant_id,
    acknowledge_grant_lifetimes:true,max_build_starts:1,recovery:'authenticated-existing-actor'};
  const before=canonical(input),counts=f.counts(),registryBefore=await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),outputBefore=await readdir(f.output.slot.root);
  const packet=prepareNamespaceBuild(input);assert.equal(packet.inactive,true);assert.equal(packet.activation_authorized,false);
  assert.equal(packet.proposed_genesis_sha256,digest(input.proposed_manifest));assert.equal(packet.proposed_catalog_project.genesis_sha256,packet.proposed_genesis_sha256);
  assert.equal(packet.limits.run_application,false);assert.equal(packet.limits.serve_application,false);assert.equal(packet.actor.lifetime.mode,policy.grants[0].lifetime.mode);
  assert.equal(canonical(input),before);assert.deepEqual(f.counts(),counts);assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),registryBefore);
  assert.deepEqual(await readdir(f.output.slot.root),outputBefore);
  for(const mutate of [
    (v:any)=>v.launcher.repository_ids.push('unapproved-repository'),
    (v:any)=>v.source_grant.limits.max_bytes++,
    (v:any)=>v.catalog_project.genesis_sha256='0'.repeat(64),
    (v:any)=>v.proposed_manifest.policy.grants[0].build_repository_ids=[],
    (v:any)=>v.proposed_manifest.policy.grants[0].approvals=[],
    (v:any)=>v.profile.sha256='0'.repeat(64),
    (v:any)=>v.release={ref:f.scope.authority_ref,sha256:digest(records[f.scope.authority_ref].data)},
    (v:any)=>v.proposed_manifest.profiles.authority_ref='MissingAuthority@1',
    (v:any)=>delete v.proposed_manifest.profiles,
    (v:any)=>v.proposed_manifest.policy.grants[0].operations.push('build.reconcile'),
    (v:any)=>v.acknowledge_grant_lifetimes=false,
    (v:any)=>v.recovery='unattended',
  ]){const denied=structuredClone(input);mutate(denied);
    denied.proposed_manifest.grant.actor_binding_sha256=digest({accounts:denied.proposed_manifest.accounts,policy:denied.proposed_manifest.policy});
    assert.throws(()=>prepareNamespaceBuild(denied));}
  const inputFile=path.join(f.root,'offline-preparation.json'),packetFile=path.join(f.root,'inactive-packet.json');await writeFile(inputFile,canonical(input));
  assert.equal(await writeNamespaceBuildPacket(inputFile,packetFile),packet.packet_sha256);
  assert.equal(await readFile(packetFile,'utf8'),canonical(packet));
  await assert.rejects(writeNamespaceBuildPacket(inputFile,packetFile),(e:any)=>e.code==='EEXIST');
  const absent=path.join(f.root,'new-output-root'),noOutput={...input,launcher:{...input.launcher,output:{...input.launcher.output,root:absent}}};
  prepareNamespaceBuild(noOutput);await assert.rejects(lstat(absent),(e:any)=>e.code==='ENOENT');
  assert.deepEqual(f.counts(),counts);
  await t.test('preparation and actual owner exchange refuse the same invalid stable bindings and owner mappings',async()=>{
    const cases:Array<[string,(v:any)=>void,string]>=[
      ['duplicate grant ID',v=>v.proposed_manifest.policy.grants.push(structuredClone(v.proposed_manifest.policy.grants[0])),'INVALID_POLICY'],
      ['duplicate grant principal',v=>v.proposed_manifest.policy.grants.push({...v.proposed_manifest.policy.grants[0],grant_id:'other-grant'}),'INVALID_POLICY'],
      ['duplicate account ID',v=>v.proposed_manifest.accounts.accounts.push({...v.proposed_manifest.accounts.accounts[0],principal_id:'other-principal'}),'INVALID_POLICY'],
      ['duplicate account principal',v=>v.proposed_manifest.accounts.accounts.push({...v.proposed_manifest.accounts.accounts[0],account_id:'other-account'}),'INVALID_POLICY'],
      ['unconfigured grant principal',v=>v.proposed_manifest.policy.grants.push({...v.proposed_manifest.policy.grants[0],grant_id:'orphan',principal_id:'missing-account'}),'INVALID_POLICY'],
      ['duplicate operation',v=>v.proposed_manifest.policy.grants[0].operations.push(v.proposed_manifest.policy.grants[0].operations[0]),'INVALID_POLICY'],
      ['duplicate Block assignment',v=>v.proposed_manifest.policy.grants[0].write_block_ids.push(v.proposed_manifest.policy.grants[0].write_block_ids[0]),'INVALID_POLICY'],
      ['agent owner mapping',v=>v.proposed_manifest.accounts.accounts[0].principal_kind='agent','AUTHENTICATION_REQUIRED'],
      ['ambiguous person owner mappings',v=>v.proposed_manifest.accounts.accounts.push({...v.proposed_manifest.accounts.accounts[0],account_id:'other-account',principal_id:'other-principal'}),'AUTHENTICATION_REQUIRED'],
      ['disabled owner account',v=>v.proposed_manifest.accounts.accounts[0].active=false,'AUTHENTICATION_REQUIRED'],
      ['expired owner grant',v=>v.proposed_manifest.policy.grants[0].lifetime={mode:'until',expires_at:'2000-01-01T00:00:00.000Z'},'ACCESS_REVOKED'],
    ];
    for(const [name,mutate,expected]of cases){
      const denied=structuredClone(input);mutate(denied);const m=denied.proposed_manifest;
      m.grant.actor_binding_sha256=digest({accounts:m.accounts,policy:m.policy});
      assert.throws(()=>prepareNamespaceBuild(denied),code(expected),name);
      await assert.rejects(async()=>{const issuer=new HostIssuer(m.accounts,m.policy,Date.now,async()=>f.ownerProof());
        try{await issuer.loginOwner({});}finally{issuer.clear();}},code(expected),name);
    }
    assert.equal(canonical(input),before);assert.deepEqual(f.counts(),counts);
    assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),registryBefore);assert.deepEqual(await readdir(f.output.slot.root),outputBefore);
  });
  await t.test('archiving revision two hides the logical profile and refuses preparation selecting revision one',async()=>{
    const current=profileInput(records[f.selection.profile_ref].data),revision={...current,revision:2};
    const revised=(await f.repository.execute('profile.revise',{previous:f.selection.profile_ref,record:revision,expected_normalized_sha256:digest(normalizeBuildProfile(revision))},f.context(),{key:'preparation-revision-two'})).data;
    const snapshot=async()=>{
      const all=await f.records(),index=JSON.parse(await readFile(path.join(f.directories.broker,'registry.json'),'utf8')),candidate=structuredClone(input),m=candidate.proposed_manifest;
      m.imported.registry={entries:index.entries,storage:index.storage,asset_locators:index.asset_locators??{},heads:{},requests:{},contexts:{}};
      m.imported.record_bytes=Object.fromEntries(Object.entries(all).map(([ref,r])=>[ref,canonical(r.data)]));m.grant.import_manifest_sha256=digest(m.imported);return candidate;
    };
    const unarchived=await snapshot();assert.equal(prepareNamespaceBuild(unarchived).inactive,true);
    await f.repository.execute('profile.archive',{ref:revised.ref},f.context(),{key:'preparation-archive-two'});
    assert.equal((await f.repository.execute('profile.inspect',{ref:f.selection.profile_ref},f.context())).data.archived,true);
    const archived=await snapshot(),afterWrites=f.counts(),writer=await readFile(path.join(f.directories.broker,'registry.json'),'utf8');
    assert.equal(archived.profile.ref,f.selection.profile_ref);assert.notEqual(archived.profile.ref,revised.ref);
    assert.throws(()=>prepareNamespaceBuild(archived),code('BUILD_PREPARATION_PINS'));
    archived.profile={ref:revised.ref,sha256:revised.sha256};assert.throws(()=>prepareNamespaceBuild(archived),code('BUILD_PREPARATION_PINS'));
    assert.deepEqual(f.counts(),afterWrites);assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),writer);assert.deepEqual(await readdir(f.output.slot.root),outputBefore);
  });
});
test('namespace binding, CAS, finite destination, current repository authorization and containment refuse before Build effects',async t=>{
  const f=await fixture('refusals');t.after(()=>f.close());const counts=f.counts();
  assert.equal((await f.call('build.prepare',{...f.selection,release_ref:'HostCollectionBaseline@1'})).error.code,'BUILD_BOOTSTRAP_EXCLUDED');
  assert.equal((await f.call('build.prepare',{...f.selection,profile_ref:f.source.release.ref})).ok,false);
  assert.equal((await f.call('build.prepare',{...f.selection,destination:{kind:'cloudflare-worker',slot_id:f.output.slot.id}})).ok,false);
  assert.equal((await f.call('build.prepare',{...f.selection,destination:{kind:'local',slot_id:'unconfigured'}})).error.code,'OUTPUT_SLOT_UNAVAILABLE');
  const p=(await f.call('build.prepare',f.selection)).data;
  assert.equal((await f.call('build.start',{selection:f.selection,expected_plan_sha256:p.plan_sha256},'stale',{'x-strata-expected-generation':'0'.repeat(64)})).error.code,'STALE_GENERATION');
  assert.deepEqual(f.counts(),counts);
  assert.throws(()=>namespaceBuildOutput({output:f.output.slot},[path.join(f.output.slot.root,'unlisted-protected')]),code('OUTPUT_ROOT_UNSAFE'));
  const changed=structuredClone(f.policy);changed.generation++;(changed.grants[0] as any).build_repository_ids=[];f.issuer.reload(f.accounts,changed);
  const token=await f.issuer.loginOwner({});
  await assert.rejects(f.repository.execute('build.prepare',f.selection,f.issuer.resolve(token)),code('REPOSITORY_FORBIDDEN'));
});
test('namespace response loss keeps original registration receipt and startup recovery reads it without rerunning output or checks',async t=>{
  const f=await fixture('lost-child');t.after(()=>f.close());let lost=false;
  f.lose((command)=>command==='realization.register'&&!lost&&(lost=true));
  const p=(await f.call('build.prepare',f.selection)).data,request={selection:f.selection,expected_plan_sha256:p.plan_sha256};
  const response=await f.call('build.start',request,'lost');assert.equal(response.ok,true,JSON.stringify({response,pending:(await f.control.snapshot()).operations.filter(o=>!['committed','cancelled_before_effect'].includes(o.phase)).map(o=>({phase:o.phase,events:o.events.map(e=>e.phase)}))}));const run=response.data;assert.equal(run.phase,'exporting');assert.equal(run.realization,null);
  const before=await f.records();assert.equal(Object.values(before).filter(r=>r.type==='build-child-receipt').length,1);const counts=f.counts();
  await f.restart();
  assert.equal((await f.call('build.start',request,'new-key')).error.code,'BUILD_RECOVERY_REQUIRED');
  assert.deepEqual((await f.call('build.start',request,'lost')).data,run);assert.deepEqual(f.counts(),counts);
  assert.equal(await f.repository.reconcile(f.context()),1);
  const recovered=(await f.call('build.inspect',{build_id:run.build_id})).data;
  assert.equal(recovered.phase,'interrupted');assert.ok(recovered.realization);assert.equal(recovered.host_run,null);assert.equal(recovered.verification.mechanical,null);
  assert.equal(f.counts().pushes,counts.pushes+1); // only the interrupted receipt revision
  assert.equal((await f.call('build.outputs',{build_id:run.build_id})).error.code,'OUTPUT_UNAVAILABLE');
  await assert.rejects(lstat(path.join(f.output.slot.root,run.allocation.relative,'collection.mjs')));
});



test('lost namespace measurement response recovers only the original durable host-run and never silently reruns checks',async t=>{
  const f=await fixture('lost-measurement');t.after(()=>f.close());let lost=false;
  f.lose(command=>command==='evidence.run'&&!lost&&(lost=true));
  const p=(await f.call('build.prepare',f.selection)).data,request={selection:f.selection,expected_plan_sha256:p.plan_sha256};
  const response=await f.call('build.start',request,'measurement');assert.equal(response.ok,true,JSON.stringify(response));
  const run=response.data;assert.equal(run.phase,'checking');assert.equal(run.host_run,null);assert.equal(run.verification.mechanical,null);
  const original=await f.records();assert.equal(Object.values(original).filter(r=>r.type==='build-child-receipt').length,2);const counts=f.counts();
  await f.restart();assert.equal(await f.repository.reconcile(f.context()),1);
  const recovered=(await f.call('build.inspect',{build_id:run.build_id})).data;
  assert.equal(recovered.phase,'interrupted');assert.ok(recovered.host_run);assert.equal(recovered.verification.mechanical,true);
  assert.equal(f.counts().pushes,counts.pushes+1);assert.equal(Object.values(await f.records()).filter(r=>r.type==='host-run').length,Object.values(original).filter(r=>r.type==='host-run').length);
  assert.equal((await f.call('build.outputs',{build_id:run.build_id})).error.code,'OUTPUT_UNAVAILABLE');
});
test('namespace acceptance uncertainty is inspectable by the original request key and dispatches no output or retry',async t=>{
  const f=await fixture('acceptance-loss');t.after(()=>f.close());
  const p=(await f.call('build.prepare',f.selection)).data,request={selection:f.selection,expected_plan_sha256:p.plan_sha256};
  const before=await readFile(path.join(f.directories.broker,'registry.json'),'utf8');f.setMode('push-response-lost');
  const response=await f.call('build.start',request,'acceptance');assert.equal(response.ok,false);
  assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),before);
  const outcome=await f.call('operation.inspect',{key:'acceptance'});assert.equal(outcome.ok,true,JSON.stringify(outcome));assert.equal(outcome.data.state,'reconciliation_required');
  const counts=f.counts();f.setMode('ok');assert.equal((await f.call('build.start',request,'acceptance')).error.code,'WRITE_RECONCILIATION_REQUIRED');assert.deepEqual(f.counts(),counts);
  assert.equal(Object.values(await f.records()).filter(r=>r.type==='build-attempt-revision').length,0);
});

test('namespace exact private review replay and concurrent acceptance retain one execution and current authority',async t=>{
  const f=await fixture('private-replay');t.after(()=>f.close());
  const input={record:{format:'strata-repository-compatibility/1',id:'NamespaceContract',revision:1,rules:[],preferences:[]},previous:null};
  const before=f.counts(),index=await readFile(path.join(f.directories.broker,'registry.json'),'utf8');
  const review=await f.repository.review('repository.contract.import',input,f.context(),{key:'review-contract'});
  assert.equal(review.ok,true);assert.equal(review.reused,true);assert.deepEqual(review.created,[]);assert.deepEqual(f.counts(),before);
  assert.equal(await readFile(path.join(f.directories.broker,'registry.json'),'utf8'),index);
  const saved=(await f.records())[f.selection.profile_ref].data;
  const {format,project_id,repository_id,previous,author,auth_receipt,derived_from,...record}=saved;
  const profileInput={record,expected_normalized_sha256:digest(normalizeBuildProfile(record))};
  const profile=await f.repository.execute('profile.create',profileInput,f.context(),{key:'profile'});
  assert.equal(profile.reused,true);assert.deepEqual(profile.created,[]);assert.deepEqual(f.counts(),before);
  await assert.rejects(f.repository.execute('profile.create',profileInput,f.context(),{key:'new-profile-key'}),code('BUILD_PROFILE_EXISTS'));
  const p=(await f.call('build.prepare',f.selection)).data,request={selection:f.selection,expected_plan_sha256:p.plan_sha256};
  const results=await Promise.all([f.call('build.start',request,'concurrent'),f.call('build.start',request,'concurrent')]);
  for(const result of results)assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(results[0].data.build_id,results[1].data.build_id);
  const run=(await f.call('build.inspect',{build_id:results[0].data.build_id})).data;
  assert.equal(run.phase,'completed');
  const records=await f.records();assert.equal(Object.values(records).filter(r=>r.type==='build-child-receipt').length,2);
  const counts=f.counts();assert.deepEqual((await f.call('build.start',request,'concurrent')).data,run);assert.deepEqual(f.counts(),counts);
  const changed=structuredClone(f.policy);changed.generation++;changed.grants[0].approvals=[];f.issuer.reload(f.accounts,changed);
  let token=await f.issuer.loginOwner({});
  await assert.rejects(f.repository.review('repository.contract.import',input,f.issuer.resolve(token),{key:'review-contract'}),code('AUTHORITY_FORBIDDEN'));
  changed.generation++;(changed.grants[0] as any).build_repository_ids=[];f.issuer.reload(f.accounts,changed);
  token=await f.issuer.loginOwner({});
  await assert.rejects(f.repository.review('repository.contract.import',input,f.issuer.resolve(token),{key:'review-contract'}),code('REPOSITORY_FORBIDDEN'));
});
