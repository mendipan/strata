import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NamespaceManager } from '../src/explorer/namespace-manager.js';
import { NamespaceProvider } from '../src/explorer/namespace-provider.js';
import { namespacePolicySchema, initialNamespaceFiles } from '../src/explorer/namespace-policy.js';
import type { NamespaceStore } from '../src/explorer/namespace-store.js';
import { DEFAULT_WORKSPACE_LIMITS } from '../src/explorer/workspace-policy.js';
import { digest } from '../src/model.js';

const boundaries=['queued admission','namespace response','reserved create','dispatch staging','create response','initialization'] as const;
type Boundary=typeof boundaries[number];
function fixture(t:any,boundary?:Boundary,recovery=false) {
  let now=Date.now(),expired=false,initialized=0;const deadline=now+60_000;
  t.mock.method(Date,'now',()=>now);
  const expire=()=>{expired=true;now=deadline;};
  const policy=namespacePolicySchema.parse({format:'strata-studio-namespace-policy/1',installation_id:randomUUID(),owner_id:randomUUID(),
    lineage_id:randomUUID(),account:'a'.repeat(32),namespace:'synthetic',lifetime:{mode:'until-revoked',expires_at:null},
    permissions:['discover','create','read','draft'],principal_id:'human',account_id:'owner',provider_contract:'development-name-addressed',
    operator_rule:'no-delete-recreate-or-rebind-during-write-or-reconciliation',automatic_creation_token:'discard-secret-and-allow-provider-expiry',
    automatic_token_max_lifetime_seconds:86400,max_projects:2,limits:DEFAULT_WORKSPACE_LIMITS,
    first_project:{format:'strata-studio-first-project/1',template:'collection-host/1',authority:'single-human-author-reviewer-validator-release',
      lifetime:{mode:'until',expires_at:new Date(deadline).toISOString()},max_items:3,max_title_length:20}});
  const state=initialNamespaceFiles(policy).state;state.approved=true;state.connected=true;
  const prior=randomUUID();if(recovery)state.operations.push({request_id:prior,input_sha256:digest('original'),action:'create',phase:'uncertain',
    code:null,repository_id:null,repository_name:'fresh'});
  const calls:string[]=[],reservations:string[]=[];
  const store={policy,snapshot:async()=>structuredClone(state),usageSnapshot:async()=>({reserved:{requests:reservations.length}}),
    update:async(mutate:any,publication?:any)=>{
      await publication?.refresh();mutate(state);
      if(!expired&&(boundary==='queued admission'&&state.operations.at(-1)?.phase==='pending'||
          boundary==='dispatch staging'&&state.operations.at(-1)?.phase==='uncertain'||
          boundary==='initialization'&&state.projects.some(p=>p.state==='created')))expire();
    },reserve:async(_id:string,_op:string,kind:string)=>{reservations.push(kind);if(boundary==='reserved create'&&kind==='repository.create')expire();}};
  const metadata={id:'repository',name:'fresh',remote:`https://${policy.account}.artifacts.cloudflare.net/git/${policy.namespace}/fresh.git`,read_only:false,last_push_at:null};
  const provider=new NamespaceProvider(policy,store as unknown as NamespaceStore,async()=>'synthetic-only',async req=>{
    calls.push(req.method+' '+new URL(req.url).pathname);
    if(req.method==='POST') {
      if(boundary==='create response')expire();
      return Response.json({success:true,result:{...metadata,token:'opaque_Y7_'+'b'.repeat(42)+'?expires='+Math.floor((deadline+60_000)/1000)}});
    }
    if(boundary==='namespace response')expire();
    return Response.json({success:true,result:recovery?metadata:{name:policy.namespace}});
  });
  const manager=new NamespaceManager(store as unknown as NamespaceStore,provider,async()=>digest('synthetic-generation'),async()=>{},
    async()=>{initialized++;return digest('synthetic-genesis');},()=>{});
  const parent={installation_id:policy.installation_id,owner_id:policy.owner_id,session_id:'synthetic-session',authentication_generation:1,
    expires_at:new Date(deadline+3600_000).toISOString(),assertLive(){},async refresh(){}};
  const input=recovery?{action:'recover-create',request_id:randomUUID(),revision:0,source_request_id:prior,repository_id:'repository',purpose:'Fresh',acknowledgment:'initialize-empty-repository'}:
    {action:'create',request_id:randomUUID(),revision:0,name:'fresh',purpose:'Fresh'};
  return {state,calls,reservations,provider,expire,run:()=>manager.action(input,parent,async()=>{}),initialized:()=>initialized};
}

for(const boundary of boundaries)test(`first-project expiry during ${boundary} refuses dispatch or initialization`,async t=>{
  const f=fixture(t,boundary);
  await assert.rejects(f.run(),(error:any)=>error.code==='ACCESS_REVOKED');assert.equal(f.initialized(),0);
  const dispatched=['create response','initialization'].includes(boundary);
  assert.equal(f.calls.filter(call=>call.startsWith('POST ')).length,dispatched?1:0);
  assert.equal(f.state.projects.some(p=>p.state==='ready'),false);
  const usage=[...f.reservations],calls=[...f.calls];assert.equal((await f.run()).replayed,true);
  assert.deepEqual(f.reservations,usage);assert.deepEqual(f.calls,calls);
  if(['dispatch staging','create response','initialization'].includes(boundary))assert.equal(f.state.operations.at(-1)?.phase,'uncertain');
});
test('unexpired first-project creation still initializes exactly once',async t=>{
  const f=fixture(t);assert.equal((await f.run()).outcome?.phase,'completed');assert.equal(f.initialized(),1);
  assert.equal(f.state.projects[0].state,'ready');assert.equal((await f.run()).replayed,true);assert.equal(f.initialized(),1);
});
test('first-project recovery rechecks expiry immediately before initialization',async t=>{
  const f=fixture(t,'initialization',true);await assert.rejects(f.run(),(error:any)=>error.code==='ACCESS_REVOKED');
  assert.equal(f.initialized(),0);assert.equal(f.calls.filter(call=>call.startsWith('POST ')).length,0);
  assert.equal(f.state.projects[0].state,'created');assert.equal(f.state.operations[0].phase,'uncertain');
});
test('provider-create performs its own synchronous expiry check after dispatch staging',async t=>{
  const f=fixture(t);
  await assert.rejects(f.provider.create({refresh:async()=>{},signal:new AbortController().signal,operation_id:digest('direct-provider'),
    beforeCreateDispatch:async()=>f.expire()},'fresh'),(error:any)=>error.code==='ACCESS_REVOKED');
  assert.equal(f.calls.filter(call=>call.startsWith('POST ')).length,0);assert.equal(f.reservations.length,2);
});
