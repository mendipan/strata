import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { StrictArtifacts, budget } from './artifacts-fixture.js';
import { ArtifactRegistryStore } from '../src/artifact-registry.js';
import { CloudflareArtifactsAdapter } from '../src/artifacts.js';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer, LOCAL_PROJECT } from '../src/security.js';
import { bootstrap, demoLayers, recipe } from '../src/fixtures.js';
import { canonical, CONTENT_MODEL, bytesDigest, StrataError, type Records } from '../src/model.js';
import { crc32 } from '../src/assets.js';
import { importAsset, loadAssetBytes } from '../src/assets-node.js';
import { createBackup } from '../src/backup.js';
import { prepared, unitValidation, approvals } from './helpers.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'strata-artifact-registry-'));
after(() => rm(root, { recursive: true, force: true }));
let sequence = 0;
const fresh = () => path.join(root, String(++sequence));
const code = (expected: string) => (e: unknown) => e instanceof StrataError && e.code === expected;
const store = (fixture: StrictArtifacts) => new ArtifactRegistryStore(fixture.adapter(budget(10000, 128 * 1024 * 1024)), LOCAL_PROJECT);
async function broker(fixture: StrictArtifacts, state = fresh(), controls: Parameters<typeof startLocalBroker>[2] = {}) {
  const runtime = await startLocalBroker(state, 0, { ...controls, artifacts: store(fixture) });
  const op = async (command: string, input: unknown = {}, session = 'fixture-reader', options: unknown = {}): Promise<any> =>
    (await fetch(runtime.url + '/v1/operation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-session': session }, body: JSON.stringify({ command, input, options }) })).json();
  const index = async () => JSON.parse(await readFile(path.join(state, 'registry.json'), 'utf8'));
  return { state, runtime, op, index };
}

test('host-wired broker stages owned Layers, refuses peers, and reads cold after restart without local objects', async () => {
  const fixture = new StrictArtifacts(), f = await broker(fixture);
  try {
    assert.equal((await f.op('init', { record: bootstrap() }, 'fixture-bootstrap')).ok, true);
    assert.equal((await f.op('layer.create', { record: demoLayers().a }, 'fixture-a')).ok, true);
    const before = canonical(await f.index()), pushes = fixture.pushes;
    assert.equal((await f.op('layer.publish', { ref: 'L-hold@1' }, 'fixture-b')).error.code, 'OWNER_FORBIDDEN');
    assert.equal((await f.op('inspect', { type: 'layer', ref: 'L-hold@1' }, 'fixture-b')).error.code, 'REF_NOT_FOUND');
    assert.equal(canonical(await f.index()), before);
    assert.equal((await f.op('layer.publish', { ref: 'L-hold@1' }, 'fixture-a')).ok, true);
    assert.equal(fixture.pushes, pushes, 'Visibility change reuses the exact staged body.');
    assert.equal((await f.op('status')).data.artifact_adapter, 'cloudflare-artifacts-strict-mock');
    const registry = await f.index();
    for (const entry of Object.values(registry.entries) as any[]) assert.match(entry.locator.ref, /^[a-f0-9]{40}$/);
    assert.deepEqual(await readdir(path.join(f.state, 'artifacts')), []);
    assert.equal(JSON.stringify(registry).includes('mock-only-token'), false);
  } finally { await f.runtime.close(); }
  const cold = await broker(fixture, f.state);
  try { assert.deepEqual((await cold.op('inspect', { type: 'layer', ref: 'L-hold@1' })).data, demoLayers().a); }
  finally { await cold.runtime.close(); }
});

test('complete seeded intent/validation fixture releases through broker, retries and inherits from remote records', async () => {
  const fixture = new StrictArtifacts(), artifacts = store(fixture), state = fresh();
  // Deterministic unit fixture approvals, not a live model or human consent.
  const { engine, candidate } = prepared(), { validation } = unitValidation(engine, candidate);
  const endorsementRefs = approvals(engine, candidate, validation.evidence_digest);
  const initial = await startLocalBroker(state, 0); await initial.close();
  const staged = await artifacts.stage(engine.records, new Map(), { entries: {} });
  await writeFile(path.join(state, 'registry.json'), canonical({ entries: staged.entries, storage: staged.storage, asset_locators: staged.asset_locators, heads: engine.ownerHeads, requests: {} }));
  const f = await broker(fixture, state);
  let release: string;
  try {
    const input = { target: candidate.ref, validation: validation.ref, approvals: endorsementRefs };
    const released = await f.op('release', input, 'fixture-release', { idempotency_key: 'remote-fixture-release' });
    assert.equal(released.ok, true, JSON.stringify(released)); release = released.data.ref;
    const retry = await f.op('release', input, 'fixture-release', { idempotency_key: 'remote-fixture-release' });
    assert.equal(retry.reused, true); assert.equal(retry.data.ref, release);
    assert.equal((await f.op('approve', { record: {} }, 'fixture-a')).error.code, 'OPERATION_FORBIDDEN');
  } finally { await f.runtime.close(); }
  const cold = await broker(fixture, state);
  try {
    const inherited = recipe('C-cold-inherited'); inherited.baseline = release!; inherited.proposals = []; inherited.selected = []; inherited.alternative_groups = [];
    const next = await cold.op('compose', { record: inherited }, 'fixture-preparer');
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.deepEqual(next.data.snapshot, candidate.snapshot);
  } finally { await cold.runtime.close(); }
});

test('failed push/read-back/cleanup never publishes an index or falls back to local bytes', async () => {
  for (const flag of ['failPush','missingRead','corruptRead','cleanupFailure'] as const) {
    const fixture = new StrictArtifacts(); fixture[flag] = true; const f = await broker(fixture);
    try {
      const response = await f.op('init', { record: bootstrap() }, 'fixture-bootstrap'); assert.equal(response.ok, false);
      await assert.rejects(f.index(), (e:any) => e.code === 'ENOENT');
      assert.deepEqual(await readdir(path.join(f.state, 'artifacts')), []);
      assert.equal(fixture.pushes, 1); assert.equal(fixture.revoked, 1);
    } finally { await f.runtime.close(); }
  }
});

test('push response loss and stage/index loss need explicit retry; deterministic branch is reused', async () => {
  for (const kind of ['push','index','response'] as const) {
    const fixture = new StrictArtifacts(); fixture.loseResponse = kind === 'push'; const f = await broker(fixture);
    try {
      const input = { record: bootstrap() }, options = { idempotency_key: 'init-remote', ...(kind === 'index' ? { fault: 'after-stage' } : kind === 'response' ? { fault: 'after-commit' } : {}) };
      assert.equal((await f.op('init', input, 'fixture-bootstrap', options)).ok, false);
      if (kind !== 'response') await assert.rejects(f.index(), (e:any) => e.code === 'ENOENT');
      if (kind === 'index') assert.match(await readFile(path.join(f.state, 'artifact-stages.jsonl'), 'utf8'), /"commit":"[a-f0-9]{40}"/);
      const retry = await f.op('init', input, 'fixture-bootstrap', { idempotency_key: 'init-remote' });
      assert.equal(retry.ok, true, JSON.stringify(retry)); assert.equal(fixture.pushes, 1);
      if (kind === 'response') assert.equal(retry.reused, true);
    } finally { await f.runtime.close(); }
  }
});

test('durable locators refuse branch refs, foreign binding, absent objects and digest changes on cold reads', async () => {
  const fixture = new StrictArtifacts(), f = await broker(fixture);
  try { assert.equal((await f.op('init', { record: bootstrap() }, 'fixture-bootstrap')).ok, true); }
  finally { await f.runtime.close(); }
  const registry = await f.index(), original = canonical(registry);
  for (const kind of ['branch','account','size','hash'] as const) {
    const copy = structuredClone(registry), entry:any = Object.values(copy.entries)[0];
    if (kind === 'account') copy.storage.account = 'foreign';
    else if (kind === 'branch') entry.locator.ref = 'refs/heads/main';
    else if (kind === 'size') entry.locator.size_bytes = -1;
    else entry.locator.hash = '0'.repeat(64);
    const calls = fixture.calls.length;
    await assert.rejects(store(fixture).load(copy), code('STORE_BINDING_MISMATCH')); assert.equal(fixture.calls.length, calls);
  }
  fixture.missingRead = true;
  const cold = await broker(fixture, f.state);
  try { assert.equal((await cold.op('status')).error.code, 'STORE_UNAVAILABLE'); }
  finally { await cold.runtime.close(); }
  fixture.missingRead = false; fixture.corruptRead = true;
  await assert.rejects(store(fixture).load(registry), code('ARTIFACT_DIGEST'));
  assert.equal(canonical(await f.index()), original);
  const local = await startLocalBroker(f.state, 0);
  try {
    const response:any = await (await fetch(local.url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':'fixture-reader'},body:JSON.stringify({command:'status',input:{}})})).json();
    assert.equal(response.error.code, 'STORE_BINDING_REQUIRED');
  } finally { await local.close(); }
});

test('store cannot silently migrate local history, drop history or mutate an immutable reference', async () => {
  const fixture = new StrictArtifacts(), artifacts = store(fixture), records:Records = { 'R0@1':{type:'release',published:true,data:bootstrap()} };
  await assert.rejects(artifacts.load({entries:{'R0@1':{hash:bytesDigest(canonical(bootstrap())),type:'release',published:true}}}),code('STORE_BINDING_MISMATCH'));
  assert.deepEqual(fixture.calls, []);
  const original = await artifacts.stage(records,new Map(),{entries:{}});
  await assert.rejects(artifacts.stage({},new Map(),original),code('IMMUTABLE_REFERENCE'));
  const changed = structuredClone(records); changed['R0@1'].data.blocks.app.purpose = 'Changed';
  await assert.rejects(artifacts.stage(changed,new Map(),original),code('IMMUTABLE_REFERENCE'));
  const duplicate = await artifacts.stage(records,new Map(),original); assert.equal(duplicate.receipt,null); assert.equal(fixture.pushes,1);
});

test('remote approval expiry/project and budget denial dispatch no provider or Git calls', async () => {
  const fixture = new StrictArtifacts();
  const setup = {mode:'remote' as const,identity:{account:'a'.repeat(32),namespace:'default'},namespace:fixture,repository:'strata-smoke',transport:fixture.transport,budget:budget(),max_repo_tokens:25,approval:{approved:true as const,repository:'strata-smoke',approval_id:'fixture-only-not-permission',project_id:LOCAL_PROJECT,expires_at:new Date(Date.now()+60000).toISOString()}};
  await assert.rejects(new ArtifactRegistryStore(new CloudflareArtifactsAdapter({...setup,approval:{...setup.approval,expires_at:'2000-01-01T00:00:00Z'}}),LOCAL_PROJECT).load({entries:{}}),code('COST_APPROVAL_REQUIRED'));
  await assert.rejects(new ArtifactRegistryStore(new CloudflareArtifactsAdapter(setup),'foreign-project').load({entries:{}}),code('STORE_BINDING_MISMATCH'));
  const denied = new ArtifactRegistryStore(fixture.adapter(budget(1)),LOCAL_PROJECT);
  await assert.rejects(denied.stage({'R0@1':{type:'release',published:true,data:bootstrap()}},new Map(),{entries:{}}),code('BUDGET_EXHAUSTED'));
  assert.deepEqual(fixture.calls,[]);
});

test('repository token ceiling refuses before the next token request and remote setups must pin a ceiling', async () => {
  const fixture = new StrictArtifacts();
  const adapter = new CloudflareArtifactsAdapter({ mode:'strict-mock', namespace:fixture, repository:'strata-smoke', budget:budget(),
    transport:fixture.transport, max_repo_tokens:1 });
  await adapter.put(bytesDigest('one'),'one');
  await assert.rejects(adapter.put(bytesDigest('two'),'two'),code('ARTIFACT_TOKEN_LIMIT'));
  assert.equal(fixture.calls.filter(call => call === 'createToken').length,1);
  assert.equal(fixture.pushes,1);
  assert.equal(fixture.disposed,2);

  const noCeiling = { mode:'remote' as const, identity:{account:'a'.repeat(32),namespace:'default'}, namespace:fixture,
    repository:'strata-smoke', transport:fixture.transport, budget:budget(),
    approval:{approved:true as const,repository:'strata-smoke',approval_id:'fixture-only-not-permission',project_id:LOCAL_PROJECT,expires_at:new Date(Date.now()+60000).toISOString()} };
  await assert.rejects(new ArtifactRegistryStore(new CloudflareArtifactsAdapter(noCeiling),LOCAL_PROJECT).load({entries:{}}),code('COST_APPROVAL_REQUIRED'));
  assert.equal(fixture.calls.filter(call => call === 'createToken').length,1);
});

test('the prepared 25-token cap fails closed at token 26 and after a lost issuance response', async () => {
  const fixture = new StrictArtifacts(), adapter = new CloudflareArtifactsAdapter({ mode:'strict-mock', namespace:fixture,
    repository:'strata-smoke', budget:budget(1000, 64 * 1024 * 1024), transport:fixture.transport, max_repo_tokens:25 });
  for (let index = 0; index < 25; index++) {
    const value = `bounded-object-${index}`; await adapter.put(bytesDigest(value), value);
  }
  await assert.rejects(adapter.put(bytesDigest('bounded-object-25'), 'bounded-object-25'),code('ARTIFACT_TOKEN_LIMIT'));
  assert.equal(fixture.calls.filter(call => call === 'createToken').length,25);
  assert.equal(fixture.pushes,25);

  const uncertain = new StrictArtifacts(); uncertain.loseTokenResponse = true;
  const uncertainAdapter = new CloudflareArtifactsAdapter({ mode:'strict-mock', namespace:uncertain, repository:'strata-smoke',
    budget:budget(), transport:uncertain.transport, max_repo_tokens:25 });
  await assert.rejects(uncertainAdapter.put(bytesDigest('ambiguous'), 'ambiguous'));
  await assert.rejects(uncertainAdapter.put(bytesDigest('must-not-retry'), 'must-not-retry'),code('ARTIFACT_TOKEN_LIMIT'));
  assert.equal(uncertain.calls.filter(call => call === 'createToken').length,1);
  assert.equal(uncertain.pushes,0);
});

test('local CLI storage expectation rejects a remote-configured broker before provider access', async () => {
  const fixture=new StrictArtifacts(),f=await broker(fixture);
  try {
    const response:any=await (await fetch(f.runtime.url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':'fixture-bootstrap','x-strata-artifact-adapter':'local-persistent-fake'},body:JSON.stringify({command:'init',input:{record:bootstrap()}})})).json();
    assert.equal(response.error.code,'COST_APPROVAL_REQUIRED');assert.deepEqual(fixture.calls,[]);
    await assert.rejects(f.index(),(e:any)=>e.code==='ENOENT');
  } finally {await f.runtime.close();}
});

test('revoked author after remote staging cannot publish; the orphan is identified without rewriting history', async () => {
  const fixture=new StrictArtifacts(),issuer=new FixtureIssuer();let revoke=false;
  const f=await broker(fixture,undefined,{issuer,afterStage:async()=>{if(revoke)issuer.suspendForTest('author-a');}});
  try {
    assert.equal((await f.op('init',{record:bootstrap()},'fixture-bootstrap')).ok,true);
    const before=canonical(await f.index());revoke=true;
    const response=await f.op('layer.create',{record:demoLayers().a},'fixture-a');
    assert.equal(response.ok,false);assert.equal(response.error.code,'ACCESS_REVOKED');assert.equal(canonical(await f.index()),before);
    const receipts=(await readFile(path.join(f.state,'artifact-stages.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(receipts.length,2);assert.match(receipts[1].commit,/^[a-f0-9]{40}$/);assert.equal(fixture.pushes,2);
  } finally {await f.runtime.close();}
});

test('account/namespace pin refuses a credential sink before token issuance or Git dispatch', async () => {
  const fixture = new StrictArtifacts();
  const adapter = new CloudflareArtifactsAdapter({mode:'strict-mock',identity:{account:'foreign',namespace:'default'},namespace:fixture,repository:'strata-smoke',transport:fixture.transport,budget:budget()});
  await assert.rejects(adapter.put(bytesDigest('{}'),'{}'),code('ARTIFACT_REMOTE'));
  assert.equal(fixture.calls.includes('createToken'),false);assert.equal(fixture.pushes,0);assert.equal(fixture.disposed,1);
  await assert.rejects(adapter.getAt({ref:'0'.repeat(40),path:bytesDigest('{}')+'.json',hash:bytesDigest('{}'),size_bytes:2}),code('ARTIFACT_REMOTE'));
  assert.equal(fixture.calls.includes('readFile'),false);assert.equal(fixture.disposed,2);
});

test('deadline after token issue reconciles its late result, revokes once and never pushes', async () => {
  const fixture = new StrictArtifacts();
  const namespace = {get:async (name:string) => {const handle=await fixture.get(name),create=handle.createToken;return {...handle,createToken:async (mode:'read'|'write',ttl:number) => {await new Promise(resolve=>setTimeout(resolve,30));return create(mode,ttl);}};}};
  const runBudget=new (await import('../src/budget.js')).RunBudget({operations:20,bytes:1024*1024,attempts:10,input_tokens:0,output_tokens:0,duration_ms:20});
  const adapter=new CloudflareArtifactsAdapter({mode:'strict-mock',namespace,repository:'strata-smoke',transport:fixture.transport,budget:runBudget});
  await assert.rejects(adapter.put(bytesDigest('{}'),'{}'),code('BUDGET_DEADLINE'));
  assert.equal(fixture.revoked,1);assert.equal(fixture.disposed,1);assert.equal(fixture.pushes,0);assert.equal(runBudget.snapshot().stopped,true);
});

test('late read capability is disposed after the deadline without a file read or retry', async () => {
  const fixture=new StrictArtifacts(),namespace={get:async(name:string)=>{await new Promise(resolve=>setTimeout(resolve,30));return fixture.get(name);}};
  const runBudget=new (await import('../src/budget.js')).RunBudget({operations:20,bytes:1024*1024,attempts:10,input_tokens:0,output_tokens:0,duration_ms:20});
  const adapter=new CloudflareArtifactsAdapter({mode:'strict-mock',namespace,repository:'strata-smoke',transport:fixture.transport,budget:runBudget});
  await assert.rejects(adapter.getAt({ref:'0'.repeat(40),hash:bytesDigest('{}'),path:bytesDigest('{}')+'.json',size_bytes:2}),code('BUDGET_DEADLINE'));
  assert.deepEqual(fixture.calls,['get','dispose']);assert.equal(fixture.disposed,1);assert.equal(fixture.pushes,0);
});

function png() {
  const chunk = (name:string,body:Buffer) => {const n=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(Buffer.concat([n,body])));return Buffer.concat([size,n,body,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);
}

test('binary asset and strict descriptor survive exact commit storage and a v0.2 broker cold load', async () => {
  const sourceState = fresh(), source = path.join(root,'synthetic.png');
  const initial = await startLocalBroker(sourceState,0,{model_version:CONTENT_MODEL});await initial.close();await writeFile(source,png());
  const issuer = new FixtureIssuer({assignments:{'fixture-asset':{principal:'asset-operator',operations:['assets.import']}}});
  const metadata={id:'reference_image',revision:1,previous:null,title:'Synthetic background',access:'project-private',acknowledge_project_visibility:true,source:{kind:'local-created',provider:'deterministic-test-fixture',attribution:'Synthetic bytes',permitted_uses:['internal-retention','backup']}};
  const asset=await importAsset(sourceState,source,metadata,'fixture-asset',issuer);
  const localRegistry=JSON.parse(await readFile(path.join(sourceState,'registry.json'),'utf8'));
  const records:Records={};for(const [ref,entry] of Object.entries(localRegistry.entries) as [string,any][]) records[ref]={type:entry.type,published:entry.published,data:JSON.parse(await readFile(path.join(sourceState,'artifacts',entry.hash+'.json'),'utf8'))};
  const bytes=await loadAssetBytes(sourceState,records), fixture=new StrictArtifacts(), artifacts=store(fixture);
  const staged=await artifacts.stage(records,bytes,{entries:{}}), state=fresh();await mkdir(state,{recursive:true});
  await writeFile(path.join(state,'registry.json'),canonical({entries:staged.entries,storage:staged.storage,asset_locators:staged.asset_locators,heads:{},requests:{}}));
  const cold=await broker(fixture,state,{model_version:CONTENT_MODEL});
  try {
    assert.deepEqual((await cold.op('inspect',{type:'asset',ref:asset.ref})).data,asset.descriptor);
    const loaded=await store(fixture).load(await cold.index());assert.deepEqual(Buffer.from(loaded.assetBytes.get(asset.descriptor.content_sha256)!),png());
    assert.deepEqual(await readdir(path.join(state,'artifacts')),[]);
  } finally {await cold.runtime.close();}
  fixture.corruptRead=true;await assert.rejects(store(fixture).load(staged),code('ARTIFACT_DIGEST'));fixture.corruptRead=false;
  const record=staged.entries[asset.ref];fixture.files.get(record.locator!.ref)!.delete(asset.descriptor.content_sha256+'.bin');
  await assert.rejects(store(fixture).load(staged),code('ASSET_NOT_FOUND'));
  await assert.rejects(importAsset(state,source,metadata,'fixture-asset',issuer),code('UNSUPPORTED_REMOTE_ASSET_IMPORT'));
  await assert.rejects(createBackup({state,out:fresh(),project:LOCAL_PROJECT,selector:'fixture-backup',maxBytes:1024*1024}),code('UNSUPPORTED_REMOTE_BACKUP'));
});
