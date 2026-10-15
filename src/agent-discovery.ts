import { z } from 'zod';

const key = z.string().regex(/^[A-Za-z0-9_.:/-]{1,256}$/);
export const agentBindingSchema = z.object({project_id:key,model_version:key,repository_id:key}).strict();
export const adapterDeclarationSchema = z.object({
  format:z.literal('strata-agent-adapter/1'),id:key,version:key,
  dependencies:z.array(z.object({name:key,version:key}).strict()).max(16),
  protocols:z.array(z.literal('strata-agent-discovery/1')).length(1),
  authentication:z.literal('injected-verified-service'),
  binding_fields:z.tuple([z.literal('project_id'),z.literal('model_version'),z.literal('repository_id')]),
  bounds:z.object({requests:z.literal(1),bytes:z.literal(32768),timeout_ms:z.literal(10000)}).strict(),
  unsupported:z.tuple([z.literal('inference'),z.literal('chat'),z.literal('tasks'),z.literal('tools'),z.literal('engine-authority')]),
}).strict();
export const agentDiscoverySchema = z.object({
  format:z.literal('strata-agent-discovery/1'),service_id:key,instance_id:key,
  binding:agentBindingSchema,authenticated_subject:key,
  discovered_at:z.string().datetime(),valid_until:z.string().datetime(),
  declaration_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  advertised_features:z.array(key).max(32),
}).strict();
export const approvedAgentTargetSchema = z.object({
  profile_id:key,url:z.string().max(2048),service_id:key,instance_id:key,
  expected_subject:key,binding:agentBindingSchema,valid_until:z.string().datetime(),
  declaration_sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(target => {
  try { const url=new URL(target.url);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.href===target.url; }
  catch { return false; }
}, 'Discovery requires one exact approved HTTPS destination without query or credentials.');

export type AdapterDeclarationV1=z.infer<typeof adapterDeclarationSchema>;
export type AgentDiscoveryV1=z.infer<typeof agentDiscoverySchema>;
export type ApprovedAgentTarget=z.infer<typeof approvedAgentTargetSchema>;
export type VerifiedAgentIdentity={subject:string;expires_at:string};
export interface AgentAuthentication {
  headers(target:ApprovedAgentTarget,signal:AbortSignal):Promise<Headers>;
  verify(response:Response,target:ApprovedAgentTarget,signal:AbortSignal):Promise<VerifiedAgentIdentity>;
}
export interface ApprovedAgentProbeContext {
  target:ApprovedAgentTarget;
  authentication:AgentAuthentication;
  transport:typeof fetch;
  now?:()=>number;
}
export interface AgentDiscoveryAdapterV1 {
  readonly id:string;
  describe():AdapterDeclarationV1;
  probe(context:ApprovedAgentProbeContext,signal:AbortSignal):Promise<AgentDiscoveryV1>;
}
export class AgentDiscoveryError extends Error {
  constructor(readonly code:string){super('Agent discovery did not verify the approved service.');}
}
export const unconfiguredAgentAuthentication:AgentAuthentication={
  async headers(){throw new AgentDiscoveryError('AGENT_AUTH_UNCONFIGURED');},
  async verify(){throw new AgentDiscoveryError('AGENT_AUTH_UNCONFIGURED');},
};

function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
// Web Crypto keeps this contract usable in a Worker without importing the engine
// or its Node runtime. Hashing is pure metadata; it grants no capability.
export async function declarationDigest(declaration:AdapterDeclarationV1){
  const bytes=new TextEncoder().encode(canonical(adapterDeclarationSchema.parse(declaration)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export const discoveryProjection=(discovery:AgentDiscoveryV1)=>({
  discovery,engine_authority:{state:'unconfigured' as const,operations:[]},
  effective:{authoring:false as const,execution:false as const,chat:false as const},
});
