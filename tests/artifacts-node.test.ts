import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeArtifactsAdapter } from '../src/artifacts-node.js';
import { bytesDigest, digest } from '../src/model.js';
import { repositoryGrantDigest } from '../src/explorer/workspace-policy.js';
import { workspaceGrant } from './workspace-fixture.js';
import type { NodeArtifactOperation } from '../src/artifacts-node.js';
const pkt=(s:string)=>(Buffer.byteLength(s)+4).toString(16).padStart(4,'0')+s;
function fixture(development=false){
 const grant=workspaceGrant(),events:any[]=[],reservations:any[]=[],calls:{url:string;method:string}[]=[];let credentials=0,live=true;
 if(development)grant.provider_contract='development-name-addressed';
 const op:NodeArtifactOperation={lease:{operation_id:digest('operation'),signal:new AbortController().signal,async refresh(){if(!live)throw Error('revoked');},assertSync(){if(!live)throw Error('revoked');}},
   budget:{async reserve(...args){reservations.push(args);}},journal:{async record(phase,detail){events.push({phase,detail});}},async credential(){credentials++;return 'synthetic-api-secret-sentinel';}};
 const proof={format:'strata-studio-provider-identity/1' as const,grant_sha256:repositoryGrantDigest(grant),expected_repository_id:grant.storage.expected_repository_id,
   guarantee:'repository-token-bound-to-immutable-id' as const,evidence_kind:'approved-disposable-test' as const,evidence_sha256:digest('synthetic-proof')};
 const text='{"synthetic":true}',hash=bytesDigest(text);let afterDiscovery:()=>void=()=>{},mode='ok';
 const transport=async(req:Request)=>{
   calls.push({url:req.url,method:req.method});assert.ok(reservations.length>0);
   const url=new URL(req.url),json=(result:unknown)=>Response.json({success:true,result});
   if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.invalid/'}});
   if(url.pathname.endsWith('/repos/workspace-test'))return json({id:mode==='wrong-id'?'replacement':grant.storage.expected_repository_id,name:grant.storage.repository,remote:grant.storage.remote,read_only:false});
   if(url.pathname.endsWith('/tokens')&&req.method==='POST'){if(mode==='mint-denied')return Response.json({success:false},{status:403});if(mode==='mint-lost')throw Error('synthetic-secret-error');const expiry=Date.now()+60_000;return json({id:'owned-synthetic-token',plaintext:'art_v1_'+'a'.repeat(40)+'?expires='+Math.floor(expiry/1000),scope:'write',expires_at:new Date(expiry).toISOString()});}
   if(url.pathname.endsWith('/tokens/owned-synthetic-token')){if(mode==='cleanup-lost')throw Error('lost-cleanup');return json({id:'owned-synthetic-token'});}
   if(url.pathname.endsWith('/info/refs')){afterDiscovery();return new Response(pkt('# service=git-receive-pack\n')+'0000'+pkt('0'.repeat(40)+' capabilities^{}\0report-status\n')+'0000');}
   if(url.pathname.endsWith('/git-receive-pack')){const body=Buffer.from(await req.arrayBuffer()).toString(),branch=body.match(/refs\/heads\/strata\/artifacts\/[a-f0-9]{64}/)![0];return new Response(pkt('unpack ok\n')+pkt('ok '+branch+'\n')+'0000');}
   if(url.pathname.endsWith('/file'))return new Response(mode==='corrupt'?'bad':text);
   throw Error('unexpected endpoint');
 };
 const make=(p:any=proof)=>new NodeArtifactsAdapter(grant,()=>op,p,transport);
 return {grant,events,reservations,calls,op,make,text,hash,setMode:(s:string)=>mode=s,revoke:()=>live=false,afterDiscovery:(f:()=>void)=>afterDiscovery=f,credentials:()=>credentials};
}
test('exact Node immutable batch is accounted, guarded, read back and owned token revoked',async()=>{
 const f=fixture(),adapter=f.make();const r=await adapter.putBatch([{hash:f.hash,bytes:f.text}]);
 assert.match(r.commit,/^[a-f0-9]{40}$/);assert.equal(r.locators[0].hash,f.hash);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/git-receive-pack')).length,1);
 assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);assert.equal(f.events.at(-1).detail.cleanup,'confirmed');
 assert.equal(f.reservations.filter(r=>r[2]==='token.revoke-owned').length,2);
 assert.deepEqual(adapter.managementCleanupCounts(),{unsettled_dispatches:0,repo_tokens_issued:1,repo_tokens_revoked:1,handles_open:0});
 assert.equal(JSON.stringify(f.events).includes('secret-sentinel'),false);
});
test('missing provider identity evidence denies writes before credential or transport',async()=>{
 const f=fixture();
 const absent=new NodeArtifactsAdapter(f.grant,()=>f.op,undefined,async()=>{throw Error('must not dispatch');});
 await assert.rejects(absent.putBatch([{hash:f.hash,bytes:f.text}]),(e:any)=>e.code==='PROVIDER_IDENTITY_GUARANTEE_REQUIRED');
 assert.equal(f.credentials(),0);assert.equal(f.calls.length,0);
});
test('wrong immutable ID refuses before mint and never discovers another repository',async()=>{
 const f=fixture();f.setMode('wrong-id');await assert.rejects(f.make().putBatch([{hash:f.hash,bytes:f.text}]),(e:any)=>e.code==='REPOSITORY_ID_MISMATCH');assert.equal(f.calls.length,1);
});
test('revocation after discovery prevents actual receive-pack and only cleans its owned token',async()=>{
 const f=fixture();f.afterDiscovery(f.revoke);await assert.rejects(f.make().putBatch([{hash:f.hash,bytes:f.text}]));
 assert.equal(f.calls.some(c=>c.url.endsWith('/git-receive-pack')),false);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
});
for(const mode of ['redirect','mint-denied','mint-lost','corrupt','cleanup-lost'])test('bounded failure '+mode+' cannot report publication',async()=>{
 const f=fixture();f.setMode(mode);await assert.rejects(f.make().putBatch([{hash:f.hash,bytes:f.text}]));
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/tokens')).length<=1,true);
 assert.equal(f.calls.filter(c=>c.method==='DELETE').length<=2,true);
 assert.equal(JSON.stringify(f.events).includes('secret-sentinel'),false);
});
test('exhausted reservation refuses before credential loading or transport',async()=>{
 const f=fixture();f.op.budget.reserve=async()=>{throw Error('exhausted');};await assert.rejects(f.make().getManyAt([]));assert.equal(f.credentials(),0);assert.equal(f.calls.length,0);
});
test('explicit write permission test issues and cleans once without Git or payload mutation',async()=>{
 const f=fixture(),adapter=f.make(),r=await adapter.testWriteAccess();assert.equal(r.write_token_verified,true);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
 assert.ok(!f.calls.some(c=>c.url.includes('/git/')));assert.equal(f.reservations.length,f.calls.length+1);
 assert.equal(JSON.stringify(f.events).includes('art_v1_'),false);
});
test('read metadata permission test does not qualify writes or issue tokens',async()=>{
 const f=fixture(),r=await f.make().testReadAccess();assert.equal(r.repository_verified,true);assert.equal(r.write_token_verified,false);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});
test('exact oversized request plan is refused before secrets, mint or network',async()=>{
 const f=fixture(),objects=Array.from({length:50},(_,i)=>{const bytes=JSON.stringify({i});return {hash:bytesDigest(bytes),bytes};});
 await assert.rejects(f.make().putBatch(objects),(e:any)=>e.code==='WORKSPACE_OPERATION_LIMIT');assert.equal(f.calls.length,0);assert.equal(f.credentials(),0);
});

const developmentContract=(grant:ReturnType<typeof workspaceGrant>)=>({format:'strata-studio-development-provider-contract/1' as const,
 grant_sha256:repositoryGrantDigest(grant),expected_repository_id:grant.storage.expected_repository_id,environment:'development' as const,
 contract:'repository-addressed-by-name' as const,operator_rule:'no-delete-recreate-or-rebind-during-write-or-reconciliation' as const,
 evidence_kind:'owner-acknowledgment' as const,evidence_sha256:digest('synthetic-owner-acknowledgment')});

test('explicit grant-bound development contract allows bounded writes without claiming immutable token binding',async()=>{
 const f=fixture(true),contract=developmentContract(f.grant),adapter=f.make(contract);
 assert.equal(adapter.providerIdentityVerified(),false);assert.equal(adapter.providerWriteContractAccepted(),true);
 assert.equal(adapter.providerWriteContract(),'development-name-addressed');
 const r=await adapter.putBatch([{hash:f.hash,bytes:f.text}]);assert.equal(r.locators[0].hash,f.hash);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/git-receive-pack')).length,1);
 assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
 assert.equal(f.events.find(e=>e.phase==='prepared').detail.provider_write_contract_sha256,digest(contract));
 assert.equal(JSON.stringify(f.events).includes('secret-sentinel'),false);
});

test('development acknowledgment cannot weaken an omitted/default or explicit immutable-ID grant',async()=>{
 for(const explicit of [false,true]){
  const f=fixture();if(explicit)f.grant.provider_contract='immutable-id';const a=f.make(developmentContract(f.grant));
  await assert.rejects(a.putBatch([{hash:f.hash,bytes:f.text}]),(e:any)=>e.code==='PROVIDER_IDENTITY_GUARANTEE_REQUIRED');
  await assert.rejects(a.testWriteAccess(),(e:any)=>e.code==='PROVIDER_IDENTITY_GUARANTEE_REQUIRED');
  assert.equal(a.providerWriteContractAccepted(),false);assert.equal(f.credentials(),0);assert.equal(f.calls.length,0);
 }
});

test('development mode refuses absent, mismatched, broadened or invented acknowledgment before provider access',async()=>{
 const mutations=[(p:any)=>p.grant_sha256=digest('different-grant'),(p:any)=>p.expected_repository_id='replacement',
  (p:any)=>p.environment='production',(p:any)=>p.operator_rule='best-effort',(p:any)=>p.evidence_kind='approved-disposable-test',
  (p:any)=>p.evidence_sha256='invalid',(p:any)=>p.extra=true];
 for(const mutate of mutations){const f=fixture(true),p=developmentContract(f.grant);mutate(p);const a=f.make(p);
  await assert.rejects(a.testWriteAccess(),(e:any)=>e.code==='PROVIDER_IDENTITY_GUARANTEE_REQUIRED');assert.equal(f.credentials(),0);assert.equal(f.calls.length,0);}
 const f=fixture(true);await assert.rejects(f.make().testWriteAccess(),(e:any)=>e.code==='PROVIDER_IDENTITY_GUARANTEE_REQUIRED');
 const absent=new NodeArtifactsAdapter(f.grant,()=>f.op,undefined);await assert.rejects(absent.testWriteAccess(),(e:any)=>e.code==='PROVIDER_IDENTITY_GUARANTEE_REQUIRED');
 assert.equal(f.credentials(),0);assert.equal(f.calls.length,0);
});

test('observed same-name replacement in development mode refuses receive-pack and cleans only its owned token',async()=>{
 const f=fixture(true),a=f.make(developmentContract(f.grant));f.afterDiscovery(()=>f.setMode('wrong-id'));
 await assert.rejects(a.putBatch([{hash:f.hash,bytes:f.text}]),(e:any)=>e.code==='REPOSITORY_ID_MISMATCH');
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/tokens')).length,1);
 assert.equal(f.calls.some(c=>c.url.endsWith('/git-receive-pack')),false);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
 assert.equal(f.events.at(-1).phase,'reconciliation_required');
});

test('development write-token test remains explicit and reserves before secrets with owned cleanup',async()=>{
 const f=fixture(true),a=f.make(developmentContract(f.grant));assert.equal(f.calls.length,0);
 assert.equal((await a.testWriteAccess()).write_token_verified,true);assert.equal(a.providerIdentityVerified(),false);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
 assert.equal(f.calls.some(c=>c.url.includes('/git/')),false);assert.equal(f.reservations.length,f.calls.length+1);
});
