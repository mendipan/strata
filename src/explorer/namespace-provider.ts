import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, fail } from '../model.js';
import { artifactTokenSchema } from '../artifacts-token.js';
import type { FetchTransport } from '../artifacts-git.js';
import { namespaceRepositorySchema, type NamespacePolicy } from './namespace-policy.js';
import type { NamespaceStore } from './namespace-store.js';
import type { ArtifactLocator } from '../artifacts.js';

export interface NamespaceLease {refresh():Promise<void>;assertSync?:()=>void;signal:AbortSignal;operation_id:string;beforeCreateDispatch?:()=>Promise<void>;}
// Only this fixed provider origin receives the saved API credential. There is no
// arbitrary URL, repository deletion, automatic retry or token-ID inference.
export class NamespaceProvider {
  private readonly base:string;
  constructor(readonly policy:NamespacePolicy,private store:NamespaceStore,
    private credential:()=>Promise<string>,private transport:FetchTransport=request=>fetch(request)) {
    this.base=`https://api.cloudflare.com/client/v4/accounts/${policy.account}/artifacts/namespaces/${encodeURIComponent(policy.namespace)}`;
  }
  private unavailable():never {return fail('NAMESPACE_PROVIDER_UNAVAILABLE',9,'The Artifacts response could not be verified. Inspect the retained outcome before retrying a creation.');}
  private async json(lease:NamespaceLease,kind:'namespace.info'|'repository.list'|'repository.info'|'repository.create'|'token.list',route:string,body?:unknown){
    await lease.refresh();const outgoing=body===undefined?undefined:JSON.stringify(body),maximum=['repository.list','token.list'].includes(kind)?65536:8192;
    await this.store.reserve(randomUUID(),lease.operation_id,kind,maximum+Buffer.byteLength(outgoing??''));
    const secret=await this.credential();await lease.refresh();
    if(!secret||/[\r\n]/.test(secret))this.unavailable();
    const signal=AbortSignal.any([lease.signal,AbortSignal.timeout(15_000)]);
    let onAbort:(()=>void)|undefined;
    const bounded=async<T>(work:Promise<T>):Promise<T>=>{
      void work.catch(()=>{});if(signal.aborted)this.unavailable();
      try{return await Promise.race([work,new Promise<never>((_,reject)=>{onAbort=()=>reject(new Error('interrupted'));signal.addEventListener('abort',onAbort,{once:true});})]);}
      finally{if(onAbort)signal.removeEventListener('abort',onAbort);}
    };
    try{
      if(kind==='repository.create'){await lease.beforeCreateDispatch?.();await lease.refresh();}
      const request=new Request(this.base+route,{method:body===undefined?'GET':'POST',
        headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:outgoing,redirect:'manual',signal});
      if(kind==='repository.create'){
        if(this.policy.first_project&&Date.parse(this.policy.first_project.lifetime.expires_at)<=Date.now())
          fail('ACCESS_REVOKED',4,'First-project authority expired before repository creation dispatch.');
        lease.assertSync?.();
      }
      const response=await bounded(this.transport(request));
      // Provider errors are untrusted and may echo secrets. Never return them.
      if(response.status<200||response.status>=300||!response.headers.get('content-type')?.includes('application/json')){
        void response.body?.cancel().catch(()=>{});if(response.status===401||response.status===403)fail('SOURCE_AUTH',4,'The saved credential cannot perform this namespace operation.');
        if(response.status===404&&['namespace.info','repository.list'].includes(kind))fail('NAMESPACE_NOT_FOUND',4,'The configured Artifacts namespace was not found.');
        if(response.status===404&&kind==='repository.info')fail('REPOSITORY_NOT_FOUND',4,'This repository was not found in the connected namespace.');
        if(response.status===429)fail('NAMESPACE_RATE_LIMIT',9,'Cloudflare limited this request. Wait before explicitly retrying; prior reservations remain.');
        this.unavailable();}
      const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{if(reader)for(;;){const next=await bounded(reader.read());if(next.done)break;bytes+=next.value.byteLength;if(bytes>maximum)this.unavailable();chunks.push(next.value);}}
      finally{void reader?.cancel().catch(()=>{});}
      await lease.refresh();const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(parsed?.success!==true||parsed.result===undefined)this.unavailable();return parsed;
    }catch(e:any){if(['SOURCE_AUTH','ACCESS_REVOKED','OWNER_SESSION_REQUIRED','NAMESPACE_NOT_FOUND','REPOSITORY_NOT_FOUND','NAMESPACE_RATE_LIMIT'].includes(e?.code))throw e;this.unavailable();}
  }
  repository(value:unknown){
    const parsed=namespaceRepositorySchema.safeParse(value);if(!parsed.success)this.unavailable();const r=parsed.data;
    if(r.remote!==`https://${this.policy.account}.artifacts.cloudflare.net/git/${this.policy.namespace}/${r.name}.git`)this.unavailable();return r;
  }
  private project(value:any){return this.repository({id:value?.id,name:value?.name,remote:value?.remote,read_only:value?.read_only});}
  async list(lease:NamespaceLease,search:string,cursor:string|null){
    const q=new URLSearchParams({limit:'50',sort:'name',direction:'asc',search});if(cursor)q.set('cursor',cursor);
    const result=await this.json(lease,'repository.list','/repos?'+q);
    if(!Array.isArray(result.result)||result.result.length>50)this.unavailable();
    const repositories=result.result.map((r:any)=>this.project(r));
    if(new Set(repositories.map((r:ReturnType<NamespaceProvider['repository']>)=>r.id)).size!==repositories.length||new Set(repositories.map((r:ReturnType<NamespaceProvider['repository']>)=>r.name)).size!==repositories.length)this.unavailable();
    const next=z.string().max(512).nullable().safeParse(result.result_info?.cursor??null);if(!next.success)this.unavailable();
    return {repositories,next_cursor:next.data};
  }
  async info(lease:NamespaceLease,name:string){return this.project((await this.json(lease,'repository.info','/repos/'+encodeURIComponent(name))).result);}
  async noLiveTokens(lease:NamespaceLease,name:string,repositoryId:string){
    const before=await this.info(lease,name);
    if(before.id!==repositoryId||before.read_only)fail('REPOSITORY_ID_MISMATCH',4,'Repository identity or writable state changed.');
    const tokenSchema=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),scope:z.enum(['read','write']),state:z.enum(['active','expired','revoked']),created_at:z.string().datetime(),expires_at:z.string().datetime()});
    const tokens:z.infer<typeof tokenSchema>[]=[],ids=new Set<string>();let total:number|undefined;
    for(let page=1;page<=20;page++){
      const response=await this.json(lease,'token.list','/repos/'+encodeURIComponent(name)+'/tokens?state=all&per_page=100&page='+page);
      const info=z.object({page:z.number().int(),per_page:z.literal(100),total_pages:z.number().int().min(0).max(20),count:z.number().int().min(0).max(100),total_count:z.number().int().min(0).max(2000)}).safeParse(response.result_info);
      const rows=z.array(tokenSchema).max(100).safeParse(response.result);
      if(!info.success||!rows.success||info.data.page!==page||info.data.count!==rows.data.length||total!==undefined&&total!==info.data.total_count)this.unavailable();
      total=info.data.total_count;
      for(const token of rows.data){if(ids.has(token.id)||Date.parse(token.expires_at)<=Date.parse(token.created_at))this.unavailable();ids.add(token.id);tokens.push(token);}
      if(page>=info.data.total_pages){if(tokens.length!==total)this.unavailable();break;}
      if(page===20)this.unavailable();
    }
    // No token identity is inferred and no token is deleted. A complete inventory
    // must show that nothing from the old unknown issue can remain usable.
    if(tokens.some(t=>t.state!=='revoked'&&Date.parse(t.expires_at)>Date.now()))
      fail('DRAFT_TOKEN_STILL_ACTIVE',9,'A repository token is still active. Wait for it to expire, then choose Resume draft saving again. Existing tokens have not been changed.');
    const after=await this.info(lease,name);if(after.id!==repositoryId||after.read_only)this.unavailable();await lease.refresh();
    return {format:'strata-studio-inactive-token-proof/1' as const,repository_id:repositoryId,verified_at:new Date().toISOString(),token_count:tokens.length,inventory_sha256:digest(tokens),io_receipt:await this.store.operationReceipt(lease.operation_id)};
  }
  async unfinished(lease:NamespaceLease,name:string){
    try{const value=(await this.json(lease,'repository.info','/repos/'+encodeURIComponent(name))).result;
      return {...this.project(value),empty:value?.last_push_at===null};
    }catch(e:any){if(e?.code==='REPOSITORY_NOT_FOUND')return null;throw e;}
  }
  async file(lease:NamespaceLease,name:string,locator:ArtifactLocator){
    await lease.refresh();const maximum=locator.size_bytes!;
    if(!/^[a-f0-9]{40}$/.test(locator.ref)||!new RegExp('^'+locator.hash+'\\.(json|bin)$').test(locator.path)||!Number.isSafeInteger(maximum)||maximum<1)
      fail('CORRUPT_DATA',2,'The project index must contain exact immutable file locations.');
    await this.store.reserve(randomUUID(),lease.operation_id,'file.read',maximum);
    const secret=await this.credential();await lease.refresh();
    const signal=AbortSignal.any([lease.signal,AbortSignal.timeout(15_000)]);
    try{
      const response=await this.transport(new Request(this.base+'/repos/'+encodeURIComponent(name)+'/file?'+new URLSearchParams({ref:locator.ref,path:locator.path}),
        {headers:{authorization:'Bearer '+secret},redirect:'manual',signal}));
      if(!response.ok){void response.body?.cancel().catch(()=>{});
        if([401,403].includes(response.status))fail('SOURCE_AUTH',4,'The saved token cannot read this repository. Check Artifacts Read permission for this account.');
        fail('IMPORT_FILE_UNAVAILABLE',4,'A file in the project index is unavailable. Use the current index for this repository.');}
      const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{if(reader)for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>maximum)fail('CORRUPT_DATA',2,'An imported file exceeds its recorded size.');chunks.push(r.value);}}
      finally{void reader?.cancel().catch(()=>{});}
      await lease.refresh();if(size!==maximum)fail('CORRUPT_DATA',2,'An imported file differs from its recorded size.');return new Uint8Array(Buffer.concat(chunks));
    }catch(e:any){if(['SOURCE_AUTH','ACCESS_REVOKED','OWNER_SESSION_REQUIRED','IMPORT_FILE_UNAVAILABLE','CORRUPT_DATA'].includes(e?.code))throw e;this.unavailable();}
  }
  async create(lease:NamespaceLease,name:string){
    // Artifacts can auto-create a missing namespace on repository creation. An
    // existing namespace is an admission prerequisite; no namespace POST exists.
    const existing=await this.json(lease,'namespace.info','');
    if(!existing.result||typeof existing.result!=='object'||Array.isArray(existing.result))this.unavailable();
    const r=(await this.json(lease,'repository.create','/repos',{name,default_branch:'main',read_only:false})).result;
    const repository=this.repository({id:r?.id,name:r?.name,remote:r?.remote,read_only:false});
    if(repository.name!==name||!artifactTokenSchema.safeParse(r.token).success)this.unavailable();
    const expires=Number(r.token.split('?expires=')[1])*1000;
    // The public create API supplies plaintext+expiry but no owned token ID.
    // Discard the secret; do not list/diff other tokens or guess an ID to delete.
    if(!Number.isSafeInteger(expires)||expires<=Date.now()||expires>Date.now()+this.policy.automatic_token_max_lifetime_seconds*1000)this.unavailable();
    return {...repository,automatic_token_expires_at:new Date(expires).toISOString()};
  }
}
