import {
  adapterDeclarationSchema,agentDiscoverySchema,approvedAgentTargetSchema,
  declarationDigest,AgentDiscoveryError,
  type AgentDiscoveryAdapterV1,type ApprovedAgentProbeContext,type AgentDiscoveryV1,
} from '../agent-discovery.js';

export const cloudflareDiscoveryDeclaration=adapterDeclarationSchema.parse({
  format:'strata-agent-adapter/1',id:'cloudflare-discovery',version:'1',
  dependencies:[{name:'agents',version:'0.26.0'}],protocols:['strata-agent-discovery/1'],
  authentication:'injected-verified-service',binding_fields:['project_id','model_version','repository_id'],
  bounds:{requests:1,bytes:32768,timeout_ms:10000},
  unsupported:['inference','chat','tasks','tools','engine-authority'],
});

async function untilAbort<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void work.catch(()=>{});throw new AgentDiscoveryError('AGENT_CANCELLED');}
  let abort!:()=>void;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{abort=()=>reject(new AgentDiscoveryError('AGENT_CANCELLED'));signal.addEventListener('abort',abort,{once:true});})]);}
  finally{signal.removeEventListener('abort',abort);}
}
async function boundedManifest(response:Response,signal:AbortSignal){
  if(!response.body)throw new AgentDiscoveryError('AGENT_PROTOCOL');
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const part=await untilAbort(reader.read(),signal);if(part.done)break;size+=part.value.byteLength;if(size>32768)throw new AgentDiscoveryError('AGENT_RESPONSE_LIMIT');chunks.push(part.value);}}
  finally{void reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return agentDiscoverySchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));}
  catch{throw new AgentDiscoveryError('AGENT_PROTOCOL');}
}

export class CloudflareDiscoveryAdapter implements AgentDiscoveryAdapterV1 {
  readonly id='cloudflare-discovery';
  describe(){return structuredClone(cloudflareDiscoveryDeclaration);}
  async probe(context:ApprovedAgentProbeContext,inputSignal:AbortSignal):Promise<AgentDiscoveryV1>{
    const parsed=approvedAgentTargetSchema.safeParse(context.target);
    if(!parsed.success)throw new AgentDiscoveryError('AGENT_TARGET');
    const target=parsed.data,now=context.now??Date.now;
    if(inputSignal.aborted)throw new AgentDiscoveryError('AGENT_CANCELLED');
    if(Date.parse(target.valid_until)<=now())throw new AgentDiscoveryError('AGENT_EXPIRED');
    if(target.declaration_sha256!==await declarationDigest(this.describe()))throw new AgentDiscoveryError('AGENT_DECLARATION');
    const signal=AbortSignal.any([inputSignal,AbortSignal.timeout(Math.min(10000,Date.parse(target.valid_until)-now()))]);
    let response:Response|undefined;
    try{
      const headers=new Headers(await untilAbort(context.authentication.headers(target,signal),signal));
      // Auth adapters cannot replace routing or forward browser/proxy identity.
      for(const header of ['host','cookie','origin','referer','forwarded','x-forwarded-host','x-forwarded-for'])if(headers.has(header))throw new AgentDiscoveryError('AGENT_AUTH');
      headers.set('accept','application/json');
      response=await untilAbort(context.transport(target.url,{method:'GET',headers,redirect:'manual',cache:'no-store',signal}),signal);
      if(response.status!==200||response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new AgentDiscoveryError('AGENT_PROTOCOL');
      const identity=await untilAbort(context.authentication.verify(response,target,signal),signal);
      if(identity.subject!==target.expected_subject||!Number.isFinite(Date.parse(identity.expires_at))||Date.parse(identity.expires_at)<=now())throw new AgentDiscoveryError('AGENT_AUTH');
      const discovery=await boundedManifest(response,signal),time=now();
      if(discovery.service_id!==target.service_id||discovery.instance_id!==target.instance_id||
        discovery.binding.project_id!==target.binding.project_id||discovery.binding.model_version!==target.binding.model_version||
        discovery.binding.repository_id!==target.binding.repository_id||discovery.authenticated_subject!==identity.subject||
        discovery.declaration_sha256!==target.declaration_sha256)throw new AgentDiscoveryError('AGENT_BINDING');
      if(Date.parse(discovery.discovered_at)>time||Date.parse(discovery.valid_until)<=time||
        Date.parse(discovery.valid_until)>Math.min(Date.parse(discovery.discovered_at)+300000,Date.parse(target.valid_until),Date.parse(identity.expires_at)))throw new AgentDiscoveryError('AGENT_EXPIRED');
      if(signal.aborted)throw new AgentDiscoveryError('AGENT_CANCELLED');
      return discovery;
    }catch(error){void response?.body?.cancel().catch(()=>{});throw error instanceof AgentDiscoveryError?error:new AgentDiscoveryError('AGENT_UNAVAILABLE');}
  }
}

export type VerifiedDiscoveryPermission={
  subject:string;service_id:string;instance_id:string;
  binding:AgentDiscoveryV1['binding'];expires_at:string;
};
export function createCloudflareDiscoveryHandler(options:{
  origin:string;pathname:string;
  authorize:(request:Request)=>Promise<VerifiedDiscoveryPermission|undefined>;
  advertisedFeatures:(permission:VerifiedDiscoveryPermission)=>Promise<string[]>;
  now?:()=>number;
}){
  // This is a separate positive route in an existing authenticated service.
  // It does not route to or instantiate the local FixtureIssuer worker.
  return async(request:Request):Promise<Response>=>{
    const headers={'content-type':'application/json','cache-control':'no-store'};
    const denied=(status:number)=>new Response(JSON.stringify({error:{code:'AGENT_DISCOVERY_DENIED'}}),{status,headers});
    try{
      const url=new URL(request.url);
      if(url.origin!==options.origin||url.pathname!==options.pathname||url.search||request.method!=='GET'||request.body!==null)return denied(400);
      const permission=await options.authorize(request),now=(options.now??Date.now)();
      if(!permission||!Number.isFinite(Date.parse(permission.expires_at))||Date.parse(permission.expires_at)<=now)return denied(403);
      const manifest=agentDiscoverySchema.parse({format:'strata-agent-discovery/1',service_id:permission.service_id,instance_id:permission.instance_id,
        binding:permission.binding,authenticated_subject:permission.subject,discovered_at:new Date(now).toISOString(),
        valid_until:new Date(Math.min(now+300000,Date.parse(permission.expires_at))).toISOString(),
        declaration_sha256:await declarationDigest(cloudflareDiscoveryDeclaration),advertised_features:await options.advertisedFeatures(permission)});
      const body=JSON.stringify(manifest);if(new TextEncoder().encode(body).byteLength>32768)return denied(503);
      return new Response(body,{status:200,headers});
    }catch{return denied(503);}
  };
}
