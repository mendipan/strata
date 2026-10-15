import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentAdapter } from '../scripts/agent-adapter-conformance.js';
import { CloudflareDiscoveryAdapter,createCloudflareDiscoveryHandler } from '../src/agent-adapters/cloudflare.js';

test('Cloudflare discovery satisfies platform-neutral synthetic conformance without execution surfaces',async()=>{
  const result=await checkAgentAdapter(new CloudflareDiscoveryAdapter());assert.equal(result.status,'synthetic-conformant');assert.equal(result.checks.length,9);
});

test('reference Worker handler authenticates before features and has no inference or instance-creation dispatch',async()=>{
  let features=0;const now=Date.now(),permission={subject:'verified-service',service_id:'service',instance_id:'existing-instance',
    binding:{project_id:'synthetic-project',model_version:'strata/0.1-facets-experimental',repository_id:'synthetic-repository'},expires_at:new Date(now+60000).toISOString()};
  const handler=createCloudflareDiscoveryHandler({origin:'https://agent.example.test',pathname:'/strata-discovery',now:()=>now,
    authorize:async req=>req.headers.get('x-fixture-auth')==='public-synthetic-proof'?permission:undefined,
    advertisedFeatures:async()=>{features++;return ['published-intent-discovery'];}});
  const route='https://agent.example.test/strata-discovery';assert.equal((await handler(new Request(route))).status,403);assert.equal(features,0);
  for(const req of [new Request(route+'?x=1'),new Request(route,{method:'POST',body:'{}'}),new Request('https://foreign.example.test/strata-discovery')])assert.equal((await handler(req)).status,400);
  assert.equal(features,0);const result=await handler(new Request(route,{headers:{'x-fixture-auth':'public-synthetic-proof'}}));assert.equal(result.status,200);const manifest=await result.json() as any;
  assert.equal(manifest.authenticated_subject,permission.subject);assert.equal(manifest.instance_id,'existing-instance');assert.equal(features,1);assert.equal(result.headers.get('cache-control'),'no-store');
});

test('handler sanitizes auth/provider errors and refuses expired permission or oversized advertisements',async()=>{
  const req=new Request('https://agent.example.test/strata-discovery');
  const base={origin:'https://agent.example.test',pathname:'/strata-discovery',advertisedFeatures:async()=>[]};
  const failed=await createCloudflareDiscoveryHandler({...base,authorize:async()=>{throw new Error('private auth value');}})(req);assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('private'));
  const expired=await createCloudflareDiscoveryHandler({...base,authorize:async()=>({subject:'s',service_id:'s',instance_id:'i',binding:{project_id:'p',model_version:'m',repository_id:'r'},expires_at:'2000-01-01T00:00:00Z'})})(req);assert.equal(expired.status,403);
  const oversized=await createCloudflareDiscoveryHandler({...base,authorize:async()=>({subject:'s',service_id:'s',instance_id:'i',binding:{project_id:'p',model_version:'m',repository_id:'r'},expires_at:new Date(Date.now()+60000).toISOString()}),advertisedFeatures:async()=>['x'.repeat(257)]})(req);assert.equal(oversized.status,503);
});
