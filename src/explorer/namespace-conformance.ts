// Synthetic installation pins for the bounded conformance fixture; not a live account binding.
import {request as httpRequest, type IncomingMessage} from 'node:http';
import path from 'node:path';
import {z} from 'zod';
import {BLOCK_MODEL,bytesDigest,canonical,digest,fail} from '../model.js';
import {NodeArtifactsAdapter,type NodeArtifactOperation} from '../artifacts-node.js';
import type {FetchTransport} from '../artifacts-git.js';
import {repositoryGrantSchema,repositoryGrantDigest} from './workspace-policy.js';
import {writerRegistrySchema} from './workspace-import.js';
import {namespaceConfigSchema,namespacePolicySchema,namespacePolicyDigest,namespaceUsageSchema} from './namespace-policy.js';
import {privateDir,readPrivate,optionalPrivate,writePrivate,withLease} from './owner-files.js';
import type {runNamespaceStudio} from './namespace-host.js';
import {NamespaceStore} from './namespace-store.js';

export const CONFORMANCE_ACCOUNT='0123456789abcdef0123456789abcdef';
export const CONFORMANCE_NAMESPACE='strata';
export const CONFORMANCE_REPOSITORY='synthetic-conformance';
export const CONFORMANCE_GENERATION='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const conformancePacketSchema=z.object({format:z.literal('strata-studio-namespace-conformance-packet/1'),
  run_id:z.string().uuid(),policy:namespacePolicySchema,namespace:namespaceConfigSchema,
  public_origin:z.string().url(),username:z.string().regex(/^[a-z0-9._-]{3,32}$/),
  credential_id:z.literal('artifacts-api-token'),saved_credential_generation:z.literal(CONFORMANCE_GENERATION),
}).strict().superRefine((p,c)=>{
  const l=p.policy.limits;
  if(p.policy.account!==CONFORMANCE_ACCOUNT||p.policy.namespace!==CONFORMANCE_NAMESPACE||p.policy.max_projects!==1||
    l.requests>160||l.bytes>50*1024**2||l.max_operation_requests>50||l.max_operation_bytes>16*1024**2||
    l.max_payload_bytes>4*1024**2||l.max_journal_entries>160||p.policy.automatic_token_max_lifetime_seconds>86400||
    p.public_origin!==new URL(p.public_origin).origin||new URL(p.public_origin).protocol!=='https:')
    c.addIssue({code:'custom',message:'Conformance scope or bounds differ.'});
});
export type ConformancePacket=z.infer<typeof conformancePacketSchema>;
type Server=Awaited<ReturnType<typeof runNamespaceStudio>>;
export interface ConformancePorts{
  start(transport:FetchTransport):Promise<Server>;
  transport:FetchTransport;
  generation():Promise<string>;
  credential():Promise<string>;
  password():Promise<string>;
  approval():Promise<void>;
  now?:()=>number;
  fault?:(stage:string)=>Promise<void>;
}
const checkpointSchema=z.object({format:z.literal('strata-studio-namespace-conformance-checkpoint/1'),
  packet_sha256:z.string().regex(/^[a-f0-9]{64}$/),phase:z.enum(['running','passed','failed','uncertain']),
  stages:z.array(z.string().max(64)).max(32),code:z.string().max(64).nullable(),
  report_sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
const purpose='Bounded namespace conformance project';
const stepId=(run:string,step:string)=>{const h=digest({run,step});return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const refused=(code='CONFORMANCE_REFUSED'):never=>fail(code,4,'The bounded conformance action was refused; retain its history before any retry.');

// This client holds only in-memory owner/actor cookies. Neither password,
// response headers nor raw failure bodies enter any report/checkpoint/log.
class Client{
  readonly cookies=new Map<string,string>();
  constructor(readonly endpoint:string,readonly publicOrigin:string){}
  headers(csrf?:string,extra:Record<string,string>={}){return {host:new URL(this.publicOrigin).host,'x-forwarded-proto':'https',
    cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...(csrf?{'x-studio-csrf':csrf}:{}),...extra};}
  ownerRequest(){return {method:'GET',url:'/studio/owner/session',headers:this.headers(),socket:{remoteAddress:'127.0.0.1'}} as unknown as IncomingMessage;}
  async call(route:string,method='GET',input?:unknown,csrf?:string,extra:Record<string,string>={}){
    return new Promise<{status:number;data:any}>((resolve,reject)=>{
      const req=httpRequest(this.endpoint+route,{method,headers:this.headers(csrf,{...(method==='POST'?{origin:this.publicOrigin,'content-type':'application/json'}:{}),...extra})},res=>{
        for(const raw of res.headers['set-cookie']??[]){const pair=raw.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}
        const chunks:Buffer[]=[];let n=0;res.on('data',(b:Buffer)=>{n+=b.length;if(n>4*1024**2){res.destroy();reject(Error('CONFORMANCE_LOCAL_LIMIT'));}else chunks.push(b);});
        res.on('error',()=>reject(Error('CONFORMANCE_LOCAL_FAILURE')));res.on('end',()=>{try{resolve({status:res.statusCode??0,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Error('CONFORMANCE_LOCAL_FAILURE'));}});
      });req.on('error',()=>reject(Error('CONFORMANCE_LOCAL_FAILURE')));req.setTimeout(70000,()=>req.destroy());req.end(input===undefined?undefined:JSON.stringify(input));
    });
  }
  async ok(route:string,method='GET',input?:unknown,csrf?:string,extra?:Record<string,string>){const r=await this.call(route,method,input,csrf,extra);if(r.status!==200)refused('CONFORMANCE_ACTION_REFUSED');return r.data;}
  async login(username:string,password:string){const pre=await this.ok('/studio/owner/session');return this.ok('/studio/owner/login','POST',{username,password},pre.csrf);}
}

export async function executeNamespaceConformance(input:unknown,ports:ConformancePorts){
  const packet=conformancePacketSchema.parse(input),packetHash=digest(packet),now=ports.now??Date.now;
  const root=packet.namespace.catalog_directory,checkpointFile=path.join(root,'executor.json'),reportFile=path.join(root,'provider-conformance.json');
  await ports.approval();await privateDir(root);
  const old=await optionalPrivate(checkpointFile);
  if(old!==undefined){const c=checkpointSchema.parse(old);if(c.packet_sha256!==packetHash)refused('CONFORMANCE_PACKET_CHANGED');
    if(c.phase==='passed'){
      const report=await readPrivate(reportFile),evidence=await readPrivate(path.join(root,'conformance-evidence.json'));
      const store=new NamespaceStore(root,packet.policy);await store.ready();const usage=namespaceUsageSchema.parse(await readPrivate(path.join(root,'usage.json'),1024**2));
      if(c.report_sha256!==digest(report)||(report as any).evidence_sha256!==digest(evidence)||(evidence as any).usage_sha256!==digest(usage)||
        (report as any).reserved_requests!==usage.reserved_requests||(report as any).reserved_bytes!==usage.reserved_bytes)refused('CONFORMANCE_EVIDENCE_CHANGED');
      return report;
    }refused('CONFORMANCE_RECONCILIATION_REQUIRED');}
  let checkpoint=checkpointSchema.parse({format:'strata-studio-namespace-conformance-checkpoint/1',packet_sha256:packetHash,phase:'running',stages:[],code:null,report_sha256:null});
  await withLease(root,async()=>{if(await optionalPrivate(checkpointFile)!==undefined)refused('CONFORMANCE_BUSY');await writePrivate(checkpointFile,checkpoint,true);});
  let server:Server|undefined,ownerCsrf:string|undefined,password:string|undefined,createDispatched=false,creationObservedAt=0;
  const owned=new Map<string,{generation:string;revoked:boolean}>();
  let admitted=false;const receipts:string[]=[];
  const version=async()=>{await ports.approval();if(await ports.generation()!==packet.saved_credential_generation)refused('CONFORMANCE_GENERATION_CHANGED');};
  const stage=async(name:string)=>{checkpoint.stages.push(name);await writePrivate(checkpointFile,checkpoint);await ports.fault?.(name);};
  // NamespaceStore/NodeArtifactsAdapter reserve BEFORE this boundary. This
  // transport adds one named-route fence; it never logs headers/token responses.
  const transport:FetchTransport=async req=>{
    const u=new URL(req.url),base=`/client/v4/accounts/${CONFORMANCE_ACCOUNT}/artifacts/namespaces/${CONFORMANCE_NAMESPACE}`;
    let kind='invalid',cleanupId:string|undefined;
    if(u.origin==='https://api.cloudflare.com'&&u.pathname===base&&req.method==='GET'&&!u.search)kind='admit';
    else if(u.origin==='https://api.cloudflare.com'&&u.pathname===base+'/repos'&&req.method==='GET'&&
      u.searchParams.get('search')===CONFORMANCE_REPOSITORY&&u.searchParams.get('limit')==='50'&&u.searchParams.get('cursor')===null&&
      [...u.searchParams.keys()].every(k=>['search','limit','sort','direction'].includes(k)))kind='list';
    else if(u.origin==='https://api.cloudflare.com'&&u.pathname===base+'/repos'&&req.method==='POST')kind='create';
    else if(u.origin==='https://api.cloudflare.com'&&u.pathname===base+'/repos/'+CONFORMANCE_REPOSITORY&&req.method==='GET'&&!u.search)kind='info';
    else if(u.origin==='https://api.cloudflare.com'&&u.pathname===base+'/repos/'+CONFORMANCE_REPOSITORY+'/file'&&req.method==='GET'&&
      /^[a-f0-9]{40}$/.test(u.searchParams.get('ref')??'')&&/^[a-f0-9]{64}\.json$/.test(u.searchParams.get('path')??'')&&[...u.searchParams.keys()].every(k=>['ref','path'].includes(k)))kind='read';
    else if(u.origin==='https://api.cloudflare.com'&&u.pathname===base+'/tokens'&&req.method==='POST')kind='mint';
    else if(u.origin==='https://api.cloudflare.com'&&u.pathname.startsWith(base+'/tokens/')&&req.method==='DELETE'&&!u.search){
      cleanupId=decodeURIComponent(u.pathname.slice((base+'/tokens/').length));if(!owned.has(cleanupId)||owned.get(cleanupId)!.revoked)refused('CONFORMANCE_UNOWNED_TOKEN');kind='cleanup';}
    else if(u.origin===`https://${CONFORMANCE_ACCOUNT}.artifacts.cloudflare.net`&&u.pathname===`/git/${CONFORMANCE_NAMESPACE}/${CONFORMANCE_REPOSITORY}.git/info/refs`&&req.method==='GET'&&u.search==='?service=git-receive-pack')kind='git';
    else if(u.origin===`https://${CONFORMANCE_ACCOUNT}.artifacts.cloudflare.net`&&u.pathname===`/git/${CONFORMANCE_NAMESPACE}/${CONFORMANCE_REPOSITORY}.git/git-receive-pack`&&req.method==='POST'&&!u.search)kind='git';
    else refused('CONFORMANCE_SCOPE');
    if(req.redirect!=='manual')refused('CONFORMANCE_REDIRECT');
    // Known owned cleanup uses the pre-reserved handle/held credential from the
    // admitted generation even if rotation interrupts ordinary work.
    if(!cleanupId)await version();
    const activeServer=server??refused('CONFORMANCE_NOT_READY');const usage=await activeServer.store.usageSnapshot();
    if(usage.reserved.requests>packet.policy.limits.requests||usage.reserved.bytes>packet.policy.limits.bytes)refused('CONFORMANCE_BUDGET');
    const outgoing=req.body?Buffer.from(await req.clone().arrayBuffer()):Buffer.alloc(0);
    if(outgoing.length>packet.policy.limits.max_payload_bytes)refused('CONFORMANCE_PAYLOAD');
    if(kind==='create'){if(!admitted||createDispatched)refused('CONFORMANCE_CREATE_REPLAY');
      const b=JSON.parse(outgoing.toString('utf8'));if(canonical(b)!==canonical({name:CONFORMANCE_REPOSITORY,default_branch:'main',read_only:false}))refused('CONFORMANCE_SCOPE');
      createDispatched=true;await stage('create-dispatched');}
    if(kind==='mint'){const b=JSON.parse(outgoing.toString('utf8'));if(canonical(b)!==canonical({repo:CONFORMANCE_REPOSITORY,scope:'write',ttl:60}))refused('CONFORMANCE_SCOPE');}
    let response:Response;try{response=await ports.transport(req);}catch{refused('CONFORMANCE_PROVIDER_UNCERTAIN');}
    // Only bounded JSON metadata is inspected; returned token secrets stay in
    // transient response memory and are consumed/discarded by existing adapters.
    if(['admit','mint','cleanup'].includes(kind)&&response!.ok){
      const reader=response!.clone().body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{if(reader)for(;;){let abort:(()=>void)|undefined;
        let next:ReadableStreamReadResult<Uint8Array>;try{next=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
          abort=()=>reject(Error('interrupted'));if(req.signal.aborted)abort();else req.signal.addEventListener('abort',abort,{once:true});})]);}
        finally{if(abort)req.signal.removeEventListener('abort',abort);}
        if(next.done)break;bytes+=next.value.byteLength;if(bytes>8192)refused('CONFORMANCE_RESPONSE_LIMIT');chunks.push(next.value);}}
      finally{void reader?.cancel().catch(()=>{});}
      const raw=Buffer.concat(chunks);
      let body:any;try{body=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{refused('CONFORMANCE_RESPONSE_INVALID');}
      if(body.success!==true)refused('CONFORMANCE_RESPONSE_INVALID');
      if(kind==='admit'){if((body.result?.name??body.result?.namespace)!==CONFORMANCE_NAMESPACE)refused('CONFORMANCE_NAMESPACE_MISMATCH');admitted=true;}
      if(kind==='mint'){const id=body.result?.id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(id)||owned.has(id))refused('CONFORMANCE_TOKEN_ID');owned.set(id,{generation:packet.saved_credential_generation,revoked:false});}
      if(kind==='cleanup'){if(body.result?.id!==cleanupId)refused('CONFORMANCE_CLEANUP');owned.get(cleanupId!)!.revoked=true;}
    }
    if(!cleanupId&&kind!=='mint')await version();
    if(kind==='create')creationObservedAt=now();
    receipts.push(digest({method:req.method,origin:u.origin,path:u.pathname,kind,status:response!.status}));
    return response!;
  };
  try{
    await version();server=await ports.start(transport);
    const initial=await server.store.snapshot();if(initial.approved||initial.revoked||initial.projects.length||initial.operations.length)refused('CONFORMANCE_INITIAL_STATE');
    const browser=new Client(server.origin,packet.public_origin),anonymous=new Client(server.origin,packet.public_origin);
    if((await anonymous.call('/studio/v1/owner/connections')).status!==401)refused('CONFORMANCE_PERMISSION');
    password=await ports.password();const login=await browser.login(packet.username,password);ownerCsrf=login.csrf;await stage('owner-authenticated');
    const action=async(name:string,fields:Record<string,unknown>={})=>{
      const status=await browser.ok('/studio/v1/owner/connections');return browser.ok('/studio/v1/owner/connections','POST',
        {action:name,revision:status.revision,request_id:stepId(packet.run_id,name),...fields},ownerCsrf);
    };
    await action('approve',{scope_sha256:namespacePolicyDigest(packet.policy),acknowledgment:'until-revoked-development-namespace'});
    const listing=await action('discover',{search:CONFORMANCE_REPOSITORY,cursor:null});
    if(listing.discovery.repositories.some((r:any)=>r.name===CONFORMANCE_REPOSITORY)||listing.discovery.next_cursor!==null)refused('CONFORMANCE_NAME_OCCUPIED');
    await stage('name-admitted');
    const created=await action('create',{name:CONFORMANCE_REPOSITORY,purpose});
    const project=(await server.store.snapshot()).projects[0];
    if(!admitted||created.outcome.phase!=='completed'||!project||project.name!==CONFORMANCE_REPOSITORY||project.state!=='ready'||
      typeof project.automatic_token_expires_at!=='string'||!Number.isFinite(Date.parse(project.automatic_token_expires_at))||Date.parse(project.automatic_token_expires_at)<=creationObservedAt||
      Date.parse(project.automatic_token_expires_at)>creationObservedAt+packet.policy.automatic_token_max_lifetime_seconds*1000)refused('CONFORMANCE_AUTOMATIC_EXPIRY');
    await stage('creation-expiry-verified');
    const headers={'x-strata-repository':project.id};
    const actor=await browser.ok('/studio/actor/session','POST',{},ownerCsrf);
    const record=(revision:number)=>({id:'ConformanceDraft',revision,owner:packet.policy.principal_id,model_version:BLOCK_MODEL,baseline:'ProjectBaseline@1',
      intent:`Named conformance draft revision ${revision}`,changes:[{op:'set_item',block:'root',path:'purpose',expected:{kind:'value',value:purpose},value:`Conformance revision ${revision}`}],
      created_blocks:[],requires_layers:[],read_set:[],assumptions:[],acceptance:[],resolution_proposals:[],derived_from:null});
    for(const revision of [1,2]){const cap=await browser.ok('/studio/v1/capabilities','GET',undefined,undefined,headers);
      await browser.ok('/studio/v1/operation','POST',{command:revision===1?'layer.create':'layer.revise',
        input:revision===1?{record:record(1)}:{previous:'ConformanceDraft@1',record:record(2)},idempotency_key:stepId(packet.run_id,'draft-'+revision),
        expected_generation:cap.data.generation,expected_policy:cap.data.policy_generation},actor.csrf,headers);
      await stage('draft-'+revision+'-saved');}
    // Permission checks are local and consume zero provider reservations.
    const negativeStatus=await browser.ok('/studio/v1/owner/connections');
    const negativeCap=await browser.ok('/studio/v1/capabilities','GET',undefined,undefined,headers);
    const denials=[
      (await browser.call('/studio/v1/owner/connections','POST',{action:'create',revision:negativeStatus.revision,request_id:stepId(packet.run_id,'denied-csrf'),name:CONFORMANCE_REPOSITORY,purpose},'incorrect-csrf')).status,
      (await browser.call('/studio/v1/capabilities','GET',undefined,undefined,{'x-strata-repository':'wrong-repository'})).status,
      (await browser.call('/studio/v1/operation','POST',{command:'release',input:{},idempotency_key:stepId(packet.run_id,'denied-release'),
        expected_generation:negativeCap.data.generation,expected_policy:negativeCap.data.policy_generation},actor.csrf,headers)).status];
    await stage('permission-status-'+denials.join('-'));
    if(denials.some(status=>status!==403))refused('CONFORMANCE_PERMISSION');
    await stage('permission-denials');
    const beforeRestart=await server.store.usageSnapshot();await server.close();server=await ports.start(transport);
    const restarted=new Client(server.origin,packet.public_origin);ownerCsrf=(await restarted.login(packet.username,password)).csrf;
    if(digest(await server.store.usageSnapshot())!==digest(beforeRestart))refused('CONFORMANCE_ACCOUNTING_RESET');
    const parent=await server.owner.actorAuthentication(restarted.ownerRequest(),false);
    const projectRoot=path.join(packet.namespace.projects_directory,digest({repository_id:project.id}));
    const genesis=await readPrivate(path.join(projectRoot,'genesis.json'),1024**2);
    if(digest(genesis)!==project.genesis_sha256)refused('CONFORMANCE_GENESIS_CHANGED');
    const grant=repositoryGrantSchema.parse((genesis as any).grant),registry=writerRegistrySchema.parse(await readPrivate(path.join(projectRoot,'broker/registry.json'),4*1024**2));
    if(grant.storage.account!==CONFORMANCE_ACCOUNT||grant.storage.namespace!==CONFORMANCE_NAMESPACE||grant.storage.repository!==CONFORMANCE_REPOSITORY||
      grant.storage.expected_repository_id!==project.id||grant.project_id!==project.project_id||grant.owner_id!==packet.policy.owner_id||grant.installation_id!==packet.policy.installation_id)refused('CONFORMANCE_IDENTITY');
    const lease=await server.manager.lease(parent,digest({run:packet.run_id,step:'remote-read-back'}),project.project_id);
    const operation:NodeArtifactOperation={lease:{...lease,assertSync:()=>lease.assertSync()},budget:server.store.budget(),journal:{record:async()=>refused('CONFORMANCE_UNEXPECTED_WRITE')},
      credential:async()=>{await version();const c=await ports.credential();await version();return c;}};
    const adapter=new NodeArtifactsAdapter(grant,()=>operation,{format:'strata-studio-development-provider-contract/1',grant_sha256:repositoryGrantDigest(grant),
      expected_repository_id:project.id,environment:'development',contract:'repository-addressed-by-name',operator_rule:packet.policy.operator_rule,
      evidence_kind:'owner-acknowledgment',evidence_sha256:packetHash},transport);
    const refs=['ProjectBaseline@1','ConformanceDraft@1','ConformanceDraft@2'];
    const locators=refs.map(ref=>{const e=registry.entries[ref];if(!e||e.locator.size_bytes>packet.policy.limits.max_payload_bytes)refused('CONFORMANCE_READ_BACK');return e.locator;});
    const remote=await adapter.getManyAt(locators);
    for(let i=0;i<remote.length;i++){if(remote[i]===null||bytesDigest(remote[i]!)!==registry.entries[refs[i]].hash)refused('CONFORMANCE_READ_BACK');
      const value=JSON.parse(remote[i]!);if(i===0?value.id!=='ProjectBaseline'||value.root!=='root':value.id!=='ConformanceDraft'||value.revision!==i||value.owner!==packet.policy.principal_id||value.changes[0]?.value!==`Conformance revision ${i}`)refused('CONFORMANCE_READ_BACK');}
    await stage('remote-read-back-verified');await version();
    if(owned.size===0||[...owned.values()].some(t=>!t.revoked||t.generation!==packet.saved_credential_generation))refused('CONFORMANCE_CLEANUP');
    const s=await server.store.snapshot();await server.manager.action({action:'pause',revision:s.revision,request_id:stepId(packet.run_id,'terminal-pause')},parent,async()=>{});
    const usage=namespaceUsageSchema.parse(await readPrivate(path.join(root,'usage.json'),1024**2));
    const evidence={format:'strata-studio-namespace-conformance-evidence/1',packet_sha256:packetHash,repository_id:project.id,project_id:project.project_id,
      observed_at:new Date(now()).toISOString(),automatic_token_expires_at:project.automatic_token_expires_at,creation_observed_at:new Date(creationObservedAt).toISOString(),
      automatic_token_secret_retained:false,automatic_token_revocation_claimed:false,owned_tokens_issued:owned.size,owned_tokens_revoked:owned.size,
      refs:refs.map((ref,i)=>({ref,sha256:bytesDigest(remote[i]!)})),dispatch_receipts_sha256:digest(receipts),usage_sha256:digest(usage),stages:checkpoint.stages};
    await writePrivate(path.join(root,'conformance-evidence.json'),evidence,true);
    const report={format:'strata-studio-namespace-conformance/1',account:CONFORMANCE_ACCOUNT,namespace:CONFORMANCE_NAMESPACE,repository:CONFORMANCE_REPOSITORY,
      saved_credential_generation:packet.saved_credential_generation,checks:{namespace_admission:true,read_edit:true,create:true,save:true,read_back:true,generation_match:true,automatic_expiry:true,owned_write_token_cleanup:true},
      automatic_token_max_lifetime_seconds:packet.policy.automatic_token_max_lifetime_seconds,reserved_requests:usage.reserved_requests,reserved_bytes:usage.reserved_bytes,evidence_sha256:digest(evidence)};
    await writePrivate(reportFile,report,true);checkpoint.phase='passed';checkpoint.report_sha256=digest(report);await writePrivate(checkpointFile,checkpoint);return report;
  }catch{
    checkpoint.phase=createDispatched?'uncertain':'failed';checkpoint.code='CONFORMANCE_RECONCILIATION_REQUIRED';await writePrivate(checkpointFile,checkpoint);
    if(server)await server.store.update(s=>{s.connected=false;s.selection_epoch++;}).catch(()=>{});
    refused('CONFORMANCE_RECONCILIATION_REQUIRED');
  }finally{password=undefined;ownerCsrf=undefined;if(server)await server.close();}
}
