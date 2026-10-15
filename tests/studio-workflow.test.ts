import { HostIssuer,HOST_OPERATIONS } from '../src/auth/host-issuer.js';
import { createHash } from 'node:crypto';
import { executeAuthorized } from '../src/service.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core.js';
import { bootstrap,demoLayers,recipe } from '../src/fixtures.js';
import { BLOCK_MODEL,MODEL,canonical,digest,normalizeSnapshot,parseLayer } from '../src/model.js';
import { FixtureIssuer } from '../src/security.js';
import { startLocalBroker } from '../src/local-broker.js';
import { runCli } from '../src/cli.js';
import { StudioCommands } from '../src/explorer/commands.js';
import { startExplorer } from '../src/explorer/host.js';
import { workflow } from '../src/workflow.js';

function rootBlock(id='app',parent:string|null=null) {return {id,parent,purpose:'Maintain the synthetic inventory.',description:{format:'plain-text/1' as const,text:'Synthetic intent fixture.'},asset_refs:{},requirements:{},acceptance:{purpose:{statement:'Review the inventory purpose.',method:'review' as const,check:'intent-purpose',version:'1',fixture:'synthetic/1',subjects:[id+'/purpose']}},relationships:{},contract:{inputs:{},outputs:{},failures:{}}};}
function blockBaseline() {return {id:'R-start',revision:1,model_version:BLOCK_MODEL,root:'app',blocks:{app:rootBlock()},authorities:{scopes:[{block:'app',selectors:['scope-selector']}],release:['release-manager'],guardians:[]},deleted_ids:[]};}
function blockLayer(id='L-add',owner='author-a') {return {id,revision:1,model_version:BLOCK_MODEL,owner,baseline:'R-start@1',intent:'Add an inventory child.',created_blocks:[rootBlock('inventory','app')],changes:[],acceptance:[],read_set:[],requires_layers:[],assumptions:[],resolution_proposals:[],derived_from:null};}
test('v0.3 Block creations retain exact ownership, baseline authority, obligations and collisions',()=>{
  const engine=new Engine({}, {}, {modelVersion:BLOCK_MODEL,projectId:'strata-local-demo'});
  const key=Buffer.alloc(32,7).toString('base64url'),issuer=new HostIssuer({format:'strata-host-accounts/1',generation:1,accounts:[{account_id:'reviewer',principal_id:'reviewer',principal_kind:'person',active:true,credential_epoch:1,key_sha256:createHash('sha256').update(key).digest('hex')}]},{format:'strata-host-policy/1',project_id:'strata-local-demo',generation:1,grants:[{grant_id:'review',principal_id:'reviewer',operations:[...HOST_OPERATIONS],layer_ids:null,write_block_ids:['app'],create_under_block_ids:['app'],approvals:[],profiles:[],expires_at:new Date(Date.now()+3600000).toISOString()}]});
  const context=issuer.resolve(issuer.login('reviewer',key));executeAuthorized(engine,'init',{record:blockBaseline()},context,issuer);
  const contentReview=(record:any)=>executeAuthorized(engine,'content.review',{record},context,issuer);
  const layer=blockLayer();engine.layer(layer,'author-a');
  assert.throws(()=>engine.publish('L-add@1','author-a'),(e:any)=>e.code==='AUTHORING_REVIEW_REQUIRED');
  const review=contentReview({draft:layer,expected_digest:digest(layer),accepted:true,rationale:'Reviewed exact synthetic content.'});engine.publish('L-add@1','author-a',undefined,review.ref);
  const composition={id:'C-add',revision:1,model_version:BLOCK_MODEL,baseline:'R-start@1',proposals:['L-add@1'],selected:['L-add@1'],alternative_groups:[],scenario:{id:'structural',checks:[{id:'intent-structure',version:'1'}]},resolutions:[]};
  const evaluated=engine.compose(composition);assert.equal(evaluated.state,'eligible_for_validation');assert.equal(evaluated.scope,'app');assert.deepEqual(evaluated.provenance['inventory/purpose'],['L-add@1']);assert(evaluated.obligations.some(o=>o.item==='inventory/purpose'));
  assert.equal(engine.read('R-start@1').blocks.inventory,undefined);assert.throws(()=>engine.realize(evaluated.ref,'booking-node/2'),(e:any)=>e.code==='UNSUPPORTED_PROFILE');
  const other=blockLayer('L-other','author-b');engine.layer(other,'author-b');const r=contentReview({draft:other,expected_digest:digest(other),accepted:true,rationale:'Review other exact content.'});engine.publish('L-other@1','author-b',undefined,r.ref);
  const collided=engine.compose({...composition,id:'C-collision',proposals:['L-add@1','L-other@1'],selected:['L-add@1','L-other@1']});assert(collided.diagnostics.some(d=>d.code==='BLOCK_CREATION_COLLISION'));
  assert.throws(()=>parseLayer({...layer,model_version:MODEL}),(e:any)=>e.code==='INVALID_RECORD');
  for(const b of [rootBlock('app','app'),rootBlock('new',null),rootBlock('new','missing')])assert.throws(()=>engine.layer({...blockLayer('L-invalid'),created_blocks:[b]},'author-a'));
  assert.throws(()=>engine.layer({...blockLayer('L-edit-new'),changes:[{op:'set_item',block:'inventory',path:'purpose',expected:{kind:'absent'},value:'Override another proposal.'}]},'author-a'));
});
test('workflow projection is pure, owner-filtered and distinguishes missing evidence from unsupported execution',()=>{
  const engine=new Engine();engine.init(bootstrap(),'bootstrap');const layer=demoLayers().a;engine.layer(layer,'author-a');
  const before=canonical({records:engine.records,heads:engine.ownerHeads});
  const preview:any=workflow(engine,'layer.preview',{record:layer},'author-a');assert.equal(preview.accepted,false);assert.equal(preview.snapshot.blocks['booking.hold'].requirements.expiry.parameters.seconds,900);
  assert.equal((workflow(engine,'review.inbox',{},'reader') as any).items.some((r:any)=>r.ref==='L-hold@1'),false);
  assert.throws(()=>workflow(engine,'review.state',{ref:'L-hold@1'},'reader'),(e:any)=>e.code==='REF_NOT_FOUND');
  assert.equal((workflow(engine,'review.state',{ref:'R0@1'},'reader') as any).publication,'bootstrap');
  assert.equal(canonical({records:engine.records,heads:engine.ownerHeads}),before);
});
test('Studio and CLI share saved refs, stale guards, durable retries and origin/auth refusals',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'strata-studio-test-')),state=path.join(root,'state');
  let broker=await startLocalBroker(state,0), host:Awaited<ReturnType<typeof startExplorer>>|undefined;
  const config={...JSON.parse(await readFile('strata.config.json','utf8')),broker:broker.url};await writeFile(path.join(root,'strata.config.json'),JSON.stringify(config));
  const cli=(args:string[],record?:any,selector='fixture-a')=>runCli([...args,'--project',root,'--json'],record?JSON.stringify(record):undefined,{...process.env,STRATA_SESSION:selector});
  try {
    assert.equal((await cli(['init','--file','-'],bootstrap(),'fixture-bootstrap')).ok,true);
    const commands=new StudioCommands(config,'fixture-a',root,['layer.create','layer.revise','layer.publish']);await commands.reader.refresh();
    host=await startExplorer(commands.reader,{port:0,assets:path.resolve('explorer'),commands});
    const layer=demoLayers().a, snapshot=(await commands.read('capabilities'));
    const request={command:'layer.create',input:{record:layer},idempotency_key:'draft-1',expected_generation:commands.reader.sourceInfo()!.registry_generation,expected_policy:snapshot.policy_generation};
    const saved=await commands.operation(request);assert.equal(saved.data.ref,'L-hold@1');
    assert.equal((await cli(['inspect','layer','L-hold@1'])).data.owner,'author-a');
    assert.equal((await commands.operation(request)).reused,true);
    await assert.rejects(()=>commands.operation({...request,input:{record:{...layer,intent:'Changed retry'}}}),(e:any)=>e.code==='IDEMPOTENCY_CONFLICT');
    const newer={...layer,revision:2,intent:'Revised from the CLI.'};assert.equal((await cli(['layer','revise','L-hold@1','--file','-'],newer)).ok,true);
    await assert.rejects(()=>commands.operation({...request,command:'layer.revise',idempotency_key:'new-key',input:{previous:'L-hold@1',record:newer}}),(e:any)=>e.code==='STALE_GENERATION');
    const noAuth=await fetch(host.origin+'/studio/v1/review/inbox');assert.equal(noAuth.status,401);
    const wrongOrigin=await fetch(host.origin+'/studio/v1/operation',{method:'POST',headers:{authorization:'Bearer '+host.capability,origin:'https://untrusted.invalid','content-type':'application/json'},body:JSON.stringify(request)});assert.equal(wrongOrigin.status,403);
    await host.close();host=undefined;await broker.close();broker=await startLocalBroker(state,0);config.broker=broker.url;await writeFile(path.join(root,'strata.config.json'),JSON.stringify(config));
    assert.equal((await cli(['inspect','layer','L-hold@2'])).data.intent,newer.intent);
    const receipt=await cli(['operation','inspect','draft-1']);assert.equal(receipt.data.state,'committed');
    const hidden=await cli(['operation','inspect','draft-1'],undefined,'fixture-b');assert.equal(hidden.data.state,'not_found');
  } finally {await host?.close();await broker.close();}
});
test('creation scope is explicitly assigned and cannot be inherited from general author access',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'strata-block-scope-'));
  const issuer=new FixtureIssuer({assignments:{'fixture-create':{principal:'creator',operations:['init','inspect','layer.create'],create_under_block_ids:['app']}}});
  const engine=new Engine({}, {}, {modelVersion:BLOCK_MODEL});engine.init(blockBaseline(),'bootstrap');
  assert.throws(()=>issuer.authorize(issuer.resolve('fixture-a'),'layer.create',{record:blockLayer()},engine),(e:any)=>e.code==='BLOCK_SCOPE_FORBIDDEN');
  const record=blockLayer('L-create','creator');assert.doesNotThrow(()=>issuer.authorize(issuer.resolve('fixture-create'),'layer.create',{record},engine));
  assert.throws(()=>issuer.authorize(issuer.resolve('fixture-create'),'layer.create',{record:{...record,created_blocks:[rootBlock('child','other')]}},engine),(e:any)=>e.code==='BLOCK_SCOPE_FORBIDDEN');
});
