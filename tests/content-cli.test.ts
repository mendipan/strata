import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CONTENT_MODEL,MODEL,digest,canonical} from '../src/model.js';
import {FixtureIssuer,LOCAL_PROJECT} from '../src/security.js';
import {startLocalBroker} from '../src/local-broker.js';
import {runCli} from '../src/cli.js';
import {bootstrap} from '../src/fixtures.js';
import {crc32} from '../src/assets.js';
import {deflateSync} from 'node:zlib';
import {Buffer} from 'node:buffer';
const root=await mkdtemp(path.join(os.tmpdir(),'strata-content-cli-'));after(()=>rm(root,{recursive:true,force:true}));
const example=async(name:string)=>JSON.parse(await readFile(path.resolve('examples',name),'utf8'));
const config=(broker:string,model_version=CONTENT_MODEL)=>canonical({schema_version:'1',model_version,project_id:LOCAL_PROJECT,broker,artifact_adapter:'local-persistent-fake',profiles:[model_version===CONTENT_MODEL ? 'booking-node/2' : 'booking-node/1'],identity_policy:'trusted-local-fixture-sessions',network_policy:'loopback-only'});
test('actual v0.2 CLI routes exact review, publication, inspection and integrity failures without dry-run softening',async()=>{
  const issuer=new FixtureIssuer({assignments:{'fixture-review-s1-cli':{principal:'content-reviewer',operations:['content.review']}}});const broker=await startLocalBroker(path.join(root,'v2-state'),0,{model_version:CONTENT_MODEL,issuer});
  await writeFile(path.join(root,'strata.config.json'),config(broker.url));
  const call=(args:string[],selector='fixture-a',input?:unknown)=>runCli([...args,'--project',root,'--json','--non-interactive','--offline'],input===undefined?undefined:JSON.stringify(input),{STRATA_SESSION:selector});
  try {
    const initial=await call(['init','--file','-'],'fixture-bootstrap',await example('bootstrap-content-v2.json'));assert.equal(initial.ok,true,JSON.stringify(initial.errors));
    const draft=await call(['layer','create','--file','-'],'fixture-a',await example('L-content-v2.json'));assert.equal(draft.ok,true,JSON.stringify(draft.errors));
    const unreviewed=await call(['layer','publish',draft.data.ref,'--dry-run']);assert.equal(unreviewed.ok,false);assert.equal(unreviewed.exit_code,6);assert.equal(unreviewed.errors[0].code,'AUTHORING_REVIEW_REQUIRED');
    const input=await example('content-review-v2.json');const review=await call(['content','review','--file','-'],'fixture-review-s1-cli',input);assert.equal(review.ok,true,JSON.stringify(review.errors));
    const published=await call(['layer','publish',draft.data.ref,'--authoring-review',review.data.ref]);assert.equal(published.ok,true);
    const inspected=await call(['inspect','authoring-review',review.data.ref],'fixture-reader');assert.equal(inspected.data.draft_digest,input.expected_digest);
    const projected=await call(['review','authoring-review',review.data.ref],'fixture-reader');assert.equal(projected.ok,true);assert.equal(projected.data.assertions[0].kind,'fixture_authoring_attestation');assert.equal(projected.data.observations[0].draft_digest,input.expected_digest);assert.equal(projected.data.execution_checked,false);
    const stale=await call(['content','review','--file','-','--dry-run'],'fixture-review-s1-cli',{...input,expected_digest:'0'.repeat(64)});assert.equal(stale.ok,false);assert.equal(stale.errors[0].code,'STALE_AUTHORING_REVIEW');
    const status=await call(['status'],'fixture-reader');assert.equal(status.data.model_version,CONTENT_MODEL);assert.equal(status.data.capabilities['mediation/1'],true);
  }finally {await broker.close();}
});
test('actual migration preview CLI verifies exact source and preserves registry bytes',async()=>{
  const project=path.join(root,'v1-project');await (await import('node:fs/promises')).mkdir(project);const state=path.join(project,'state'),broker=await startLocalBroker(state,0);await writeFile(path.join(project,'strata.config.json'),config(broker.url,MODEL));
  const call=(args:string[],selector='fixture-reader',input?:unknown)=>runCli([...args,'--project',project,'--offline'],input===undefined?undefined:JSON.stringify(input),{STRATA_SESSION:selector});
  try {const source=bootstrap();assert.equal((await call(['init','--file','-'],'fixture-bootstrap',source)).ok,true);const before=await readFile(path.join(state,'registry.json'),'utf8');const stored=await call(['inspect','release','R0@1']);const result=await call(['migration','preview','R0@1','--source-digest',digest(stored.data)]);assert.equal(result.ok,true,JSON.stringify(result.errors));assert.equal(result.data.applied,false);assert.equal(result.data.proposal.model_version,CONTENT_MODEL);assert.equal(await readFile(path.join(state,'registry.json'),'utf8'),before);const invalid=await call(['migration','preview','R0@1','--source-digest','0'.repeat(64),'--dry-run']);assert.equal(invalid.ok,false);assert.equal(invalid.exit_code,6);}finally {await broker.close();}
});
test('actual offline asset CLI uses host-only assignments, creates byte pins and reports idempotent reuse',async()=>{
  const issuer=new FixtureIssuer({assignments:{'fixture-asset-s1-cli':{principal:'asset-operator',operations:['assets.import']}}});const state=path.join(root,'asset-state');const broker=await startLocalBroker(state,0,{model_version:CONTENT_MODEL,issuer});await broker.close();await writeFile(path.join(root,'strata.config.json'),config(broker.url));
  const chunk=(kind:string,body:Buffer)=>{const h=Buffer.alloc(4),t=Buffer.alloc(4),k=Buffer.from(kind);h.writeUInt32BE(body.length);t.writeUInt32BE(crc32(Buffer.concat([k,body])));return Buffer.concat([h,k,body,t]);};const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;await writeFile(path.join(root,'source.png'),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,0,0,0]))),chunk('IEND',Buffer.alloc(0))]));
  const metadata=await example('asset-import-v1.json');metadata.source.provider='synthetic-cli-fixture';metadata.source.attribution='Synthetic data';
  const args=['assets','import','--file','source.png','--metadata','-','--state-dir','asset-state','--project',root,'--offline'];
  const denied=await runCli(args,JSON.stringify(metadata),{STRATA_SESSION:'fixture-bootstrap'});assert.equal(denied.exit_code,4);assert.deepEqual(denied.effects.network,[]);
  const result=await runCli(args,JSON.stringify(metadata),{STRATA_SESSION:'fixture-asset-s1-cli'},{issuer});assert.equal(result.ok,true,JSON.stringify(result.errors));assert.equal(result.effects.created.length,1);assert.deepEqual(result.effects.network,[]);
  const reused=await runCli(args,JSON.stringify(metadata),{STRATA_SESSION:'fixture-asset-s1-cli'},{issuer});assert.equal(reused.ok,true);assert.equal(reused.effects.created.length,0);assert.deepEqual(reused.effects.reused,[result.data.ref]);
});
