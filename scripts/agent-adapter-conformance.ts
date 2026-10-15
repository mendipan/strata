import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  declarationDigest,discoveryProjection,unconfiguredAgentAuthentication,
  type AgentDiscoveryAdapterV1,type ApprovedAgentProbeContext,type AgentDiscoveryV1,
} from '../src/agent-discovery.js';
import { CloudflareDiscoveryAdapter } from '../src/agent-adapters/cloudflare.js';

// A public synthetic runner. Every transport is replaced; no network, provider,
// model, task, chat, tool, account credential or executable agent is available.
export async function checkAgentAdapter(adapter:AgentDiscoveryAdapterV1){
  const now=Date.now(),validUntil=new Date(now+60000).toISOString(),checks:string[]=[];
  const target={profile_id:'synthetic',url:'https://agent.example.test/strata-discovery',service_id:'synthetic-service',instance_id:'synthetic-instance',
    expected_subject:'synthetic-verified-subject',binding:{project_id:'synthetic-project',model_version:'strata/0.1-facets-experimental',repository_id:'synthetic-repo'},
    valid_until:validUntil,declaration_sha256:await declarationDigest(adapter.describe())};
  const manifest:AgentDiscoveryV1={format:'strata-agent-discovery/1',service_id:target.service_id,instance_id:target.instance_id,binding:target.binding,
    authenticated_subject:target.expected_subject,discovered_at:new Date(now).toISOString(),valid_until:validUntil,declaration_sha256:target.declaration_sha256,
    advertised_features:['inference','engine:approve','task:create']};
  let dispatches=0,authCalls=0;
  const context:ApprovedAgentProbeContext={target,now:()=>now,
    authentication:{headers:async()=>{authCalls++;return new Headers({'x-synthetic-proof':'public-fixture'});},verify:async()=>({subject:target.expected_subject,expires_at:validUntil})},
    transport:async(input,options)=>{dispatches++;assert.equal(String(input),target.url);assert.equal(options?.method,'GET');assert.equal(options?.body,undefined);assert.equal(options?.redirect,'manual');return Response.json(manifest);}};
  const probe=(changes:Partial<ApprovedAgentProbeContext>={})=>adapter.probe({...context,...changes},new AbortController().signal);
  const result=await probe();assert.deepEqual(result,manifest);assert.equal(dispatches,1);assert.equal(authCalls,1);checks.push('one authenticated exact GET and strict binding');
  const projection=discoveryProjection(result);assert.deepEqual(projection.effective,{authoring:false,execution:false,chat:false});assert.deepEqual(projection.engine_authority,{state:'unconfigured',operations:[]});checks.push('hostile capability advertisements never grant engine or execution authority');
  for(const mutate of [
    (m:any)=>m.service_id='foreign', (m:any)=>m.instance_id='foreign', (m:any)=>m.binding.project_id='foreign',
    (m:any)=>m.binding.model_version='foreign', (m:any)=>m.binding.repository_id='foreign', (m:any)=>m.authenticated_subject='self-asserted',
    (m:any)=>m.declaration_sha256='0'.repeat(64), (m:any)=>m.format='unknown', (m:any)=>m.extra='unapproved',
    (m:any)=>m.discovered_at=new Date(now+1).toISOString(), (m:any)=>m.valid_until=new Date(now-1).toISOString(),
    (m:any)=>m.valid_until=new Date(now+300001).toISOString(),
  ]){const changed=structuredClone(manifest);mutate(changed);await assert.rejects(probe({transport:async()=>Response.json(changed)}));}
  checks.push('service/instance/project/model/repository/subject/declaration/version/shape/time refusals');
  const before=dispatches;await assert.rejects(probe({authentication:unconfiguredAgentAuthentication}));assert.equal(dispatches,before);checks.push('unconfigured auth denies before transport');
  await assert.rejects(probe({authentication:{...context.authentication,verify:async()=>({subject:'wrong',expires_at:validUntil})}}));checks.push('verified identity must match independently of response claims');
  for(const url of ['http://agent.example.test/strata-discovery','https://user:secret@agent.example.test/strata-discovery',target.url+'?x=1'])await assert.rejects(probe({target:{...target,url}}));assert.equal(dispatches,before+1);checks.push('invalid routing refuses before dispatch');
  await assert.rejects(probe({transport:async()=>new Response(null,{status:302,headers:{location:'https://elsewhere.example.test'}})}));
  await assert.rejects(probe({transport:async()=>new Response('x'.repeat(32769),{headers:{'content-type':'application/json'}})}));
  await assert.rejects(probe({transport:async()=>Response.json({...manifest,advertised_features:Array(33).fill('feature')})}));checks.push('redirect/oversize/feature bounds refuse without fallback');
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(adapter.probe(context,cancelled.signal));assert.equal(dispatches,before+1);checks.push('pre-cancel causes zero dispatch');
  const cancel=new AbortController(),waiting=adapter.probe({...context,transport:async()=>new Promise(()=>{})},cancel.signal);setTimeout(()=>cancel.abort(),10);await assert.rejects(waiting);checks.push('uncooperative transport remains cancellation bounded');
  return {format:'strata-agent-conformance/1',adapter_id:adapter.id,status:'synthetic-conformant',checks,scope:'Synthetic discovery only; no deployment, service auth, inference or task compatibility'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  checkAgentAdapter(new CloudflareDiscoveryAdapter()).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{process.stderr.write('Synthetic adapter conformance failed.\n');process.exitCode=1;});
}
