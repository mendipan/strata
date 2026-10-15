import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from '../src/core.js';
import {bootstrap,recipe} from '../src/fixtures.js';
import {CONTENT_MODEL,canonical,MODEL} from '../src/model.js';
import {LOCAL_PROJECT} from '../src/security.js';
import {runCli} from '../src/cli.js';
import {startLocalBroker} from '../src/local-broker.js';
import {runFixtureEvidence} from '../src/runner.js';
import {fixtureOracle} from '../src/booking-checker.js';
import {createBackup,verifyBackup,restoreBackup} from '../src/backup.js';
const root=await mkdtemp(path.join(os.tmpdir(),'strata-drift-cli-'));after(()=>rm(root,{recursive:true,force:true}));
const recovery=await mkdtemp(path.join(os.tmpdir(),'strata-drift-recovery-'));after(()=>rm(recovery,{recursive:true,force:true}));
const code=(name:string)=>(e:any)=>e.code===name;
test('checker-bound CLI evidence, exact approvals and Release round-trip through existing backup1',async()=>{
  const state=path.join(root,'state'),broker=await startLocalBroker(state,0);await writeFile(path.join(root,'strata.config.json'),canonical({schema_version:'1',model_version:MODEL,project_id:LOCAL_PROJECT,broker:broker.url,artifact_adapter:'local-persistent-fake',profiles:['booking-node/3'],identity_policy:'trusted-local-fixture-sessions',network_policy:'loopback-only'}));
  const cli=(args:string[],selector:string,record?:unknown)=>runCli([...args,'--project',root,'--json','--offline'],record===undefined?undefined:JSON.stringify(record),{STRATA_SESSION:selector});
  try {
    assert.equal((await cli(['init','--file','-'],'fixture-bootstrap',bootstrap())).ok,true);const composition={...recipe('C-bound'),proposals:[],selected:[],alternative_groups:[],resolutions:[]};const c=await cli(['compose','--file','-'],'fixture-preparer',composition);assert.equal(c.ok,true);
    const m=await cli(['materialize',c.data.ref,'--profile','booking-node/3','--out','.strata/bound-output'],'fixture-preparer');assert.equal(m.ok,true,JSON.stringify(m.errors));const manifest=JSON.parse(await readFile(m.data.manifest,'utf8')),run=await runFixtureEvidence(path.dirname(m.data.manifest),manifest.record,fixtureOracle(c.data.snapshot));assert(run.evidence.results.every(r=>r.passed));
    const input=path.join(root,'evidence.json');await writeFile(input,JSON.stringify(run.evidence));const v=await cli(['validate',c.data.ref,'--realization',m.data.manifest,'--evidence',input],'fixture-runner');assert.equal(v.ok,true,JSON.stringify(v.errors));
    await writeFile(input,JSON.stringify({...run.evidence,checker_sha256:'0'.repeat(64)}));const stale=await cli(['validate',c.data.ref,'--realization',m.data.manifest,'--evidence',input,'--dry-run'],'fixture-runner');assert.equal(stale.ok,false);assert.equal(stale.errors[0].code,'STALE_CHECKER_EVIDENCE');
    const refs:string[]=[];for(const [kind,selector,scope] of [['scope','fixture-selector',c.data.scope],['release','fixture-release',null]]) {const a=await cli(['approve','--file','-'],selector!,{kind,target:c.data.fingerprint,scope,evidence_digest:v.data.evidence_digest});assert.equal(a.ok,true);refs.push(a.data.ref);}
    const release=await cli(['release',c.data.ref,'--validation',v.data.ref,'--approval',refs[0],'--approval',refs[1]],'fixture-release');assert.equal(release.ok,true,JSON.stringify(release.errors));
  }finally {await broker.close();}
  const bundle=path.join(root,'bundle'),backup=await createBackup({state,out:bundle,project:LOCAL_PROJECT,selector:'fixture-backup',maxBytes:64*1024*1024});assert.equal(backup.format,'strata-local-backup/1');const verified=await verifyBackup({bundle,project:LOCAL_PROJECT,selector:'fixture-backup',expectedDigest:backup.manifest_sha256});assert.equal(verified.verified,true);const restored=path.join(recovery,'inactive');await restoreBackup({bundle,project:LOCAL_PROJECT,selector:'fixture-backup',expectedDigest:backup.manifest_sha256,out:restored});await assert.rejects(()=>startLocalBroker(restored,0),code('RECOVERY_INACTIVE'));
});
test('v0.2 bound profile accepts fresh evidence but cannot Release; SDK retains only its explicit legacy checker capability',async()=>{
  const snapshot=bootstrap();snapshot.model_version=CONTENT_MODEL;for(const b of Object.values(snapshot.blocks)) {b.description={format:'plain-text/1',text:''};b.asset_refs={};}const e=new Engine({}, {},{projectId:LOCAL_PROJECT,assetBytes:new Map()});e.init(snapshot,'bootstrap');const candidate=e.compose({...recipe('C-v2-bound'),model_version:CONTENT_MODEL,proposals:[],selected:[],alternative_groups:[],resolutions:[]}),r=e.realize(candidate.ref,'booking-node/4'),registered=e.registerRealization(r),output=path.join(root,'v2-out');await mkdir(output);for(const [name,body] of Object.entries(r.files)) await writeFile(path.join(output,name),body);await writeFile(path.join(output,'realization.json'),JSON.stringify({record:r,realization_ref:registered.ref}));const run=await runFixtureEvidence(output,r,fixtureOracle(candidate.snapshot));assert(run.evidence.results.every(row=>row.passed));const v=e.validate(candidate.ref,registered.ref,run.evidence);assert.throws(()=>e.release(candidate.ref,v.ref,[]),code('UNSUPPORTED_CAPABILITY'));assert.equal(Object.values(e.records).filter(r=>r.type==='release').length,1);
  const sdk=new Engine(e.records,e.ownerHeads,{projectId:LOCAL_PROJECT,checkerBackend:'none'});assert.throws(()=>sdk.realize(candidate.ref,'booking-node/4'),code('UNSUPPORTED_CHECKER_BACKEND'));assert.throws(()=>sdk.validate(candidate.ref,registered.ref,run.evidence),code('UNSUPPORTED_CHECKER_BACKEND'));assert.doesNotThrow(()=>sdk.realize(candidate.ref,'booking-node/2'));
});
