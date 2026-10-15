import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import path from 'node:path';
import { workspaceHostFixture } from './workspace-host-fixture.js';
import { StrictArtifacts } from './artifacts-fixture.js';
import { initialNamespaceFiles, namespacePolicySchema, type NamespacePolicy } from '../src/explorer/namespace-policy.js';
import { privateDir, writePrivate } from '../src/explorer/owner-files.js';
import { DEFAULT_WORKSPACE_LIMITS } from '../src/explorer/workspace-policy.js';
import type { NamespaceLocalBuildConfiguration } from '../src/explorer/namespace-build.js';
import { runNamespaceStudio } from '../src/explorer/namespace-host.js';
import { canonical,bytesDigest,MODEL,digest } from '../src/model.js';
export async function namespaceFixture(overrides:Partial<NamespacePolicy>={},hostFactory=runNamespaceStudio){
  const base=await workspaceHostFixture(true);await base.server.close();
  const owner=(await base.state.owner(true,false))!;
  const policy=namespacePolicySchema.parse({format:'strata-studio-namespace-policy/1',installation_id:owner.manifest.installation_id,owner_id:owner.owner_id,
    lineage_id:randomUUID(),account:'a'.repeat(32),namespace:'development',lifetime:{mode:'until-revoked',expires_at:null},
    permissions:['discover','create','read','draft'],principal_id:'namespace-author',account_id:'namespace-owner',provider_contract:'development-name-addressed',
    operator_rule:'no-delete-recreate-or-rebind-during-write-or-reconciliation',automatic_creation_token:'discard-secret-and-allow-provider-expiry',
    automatic_token_max_lifetime_seconds:86400,limits:DEFAULT_WORKSPACE_LIMITS,max_projects:8,...overrides});
  const config={policy_file:path.join(base.root,'namespace-policy.json'),catalog_directory:path.join(base.root,'namespace-catalog'),projects_directory:path.join(base.root,'namespace-projects')};
  await writePrivate(config.policy_file,policy,true);for(const d of [config.catalog_directory,config.projects_directory])await privateDir(d,true);
  const initial=initialNamespaceFiles(policy);await writePrivate(path.join(config.catalog_directory,'namespace.json'),initial.state,true);await writePrivate(path.join(config.catalog_directory,'usage.json'),initial.usage,true);
  const repos=new Map<string,{id:string;git:StrictArtifacts;read_only:boolean}>(),tokens=new Map<string,string>(),calls:string[]=[];
  let mode='ok',seq=0,createdHook:(()=>Promise<void>)|undefined;
  const transport=async(req:Request):Promise<Response>=>{
    const u=new URL(req.url),parts=u.pathname.split('/'),repoName=parts[parts.indexOf('repos')+1];calls.push(req.method+' '+u.pathname);
    assert.equal(req.redirect,'manual');
    const result=(r:unknown,extra={})=>Response.json({success:true,result:r,...extra});
    const metadata=(name:string)=>{const r=repos.get(name)!;return {id:r.id,name,remote:`https://${policy.account}.artifacts.cloudflare.net/git/${policy.namespace}/${name}.git`,read_only:r.read_only,last_push_at:r.git.pushes?'2026-10-12T00:00:00Z':null};};
    if(u.origin==='https://api.cloudflare.com'){
      assert.equal(req.headers.get('authorization'),'Bearer synthetic-namespace-api-secret');
      assert.ok(u.pathname.startsWith(`/client/v4/accounts/${policy.account}/artifacts/namespaces/${policy.namespace}`));
      if(mode==='denied')return Response.json({success:false,errors:[{message:'synthetic-namespace-api-secret must not escape'}]},{status:403});
      if(mode==='rate-limited')return Response.json({success:false,errors:[{message:'synthetic-namespace-api-secret must not escape'}]},{status:429});
      if(u.pathname.endsWith('/'+policy.namespace))return mode==='missing-namespace'?Response.json({success:false},{status:404}):result({name:policy.namespace});
      if(u.pathname.endsWith('/repos')&&req.method==='GET'){
        if(mode==='missing-namespace')return Response.json({success:false},{status:404});
        assert.equal(u.searchParams.get('limit'),'50');assert.equal(u.searchParams.get('sort'),'name');assert.equal(u.searchParams.get('direction'),'asc');
        const names=[...repos.keys()].filter(n=>n.includes(u.searchParams.get('search')??'')).sort(),offset=Number(u.searchParams.get('cursor')??0),limit=mode==='paginated'?2:50;
        return result(names.slice(offset,offset+limit).map(metadata),{result_info:{cursor:names.length>offset+limit?String(offset+limit):null}});
      }
      if(u.pathname.endsWith('/repos')&&req.method==='POST'){
        const input=await req.json() as any;assert.deepEqual(Object.keys(input).sort(),['default_branch','name','read_only']);
        if(repos.has(input.name))return Response.json({success:false},{status:409});
        repos.set(input.name,{id:'repo_'+(++seq),git:new StrictArtifacts(),read_only:false});
        await createdHook?.();
        if(mode==='lost-create')throw Error('synthetic-namespace-api-secret must not escape');
        return result({...metadata(input.name),...(mode==='duplicate-id'?{id:'repo_1'}:{}),token:'opaque_Y7_'+'b'.repeat(42)+'?expires='+Math.floor((Date.now()+(mode==='long-token'?2:1)*86400_000)/1000)});
      }
      if(u.pathname.endsWith('/tokens')&&req.method==='POST'){
        if(mode==='lost-token')return Response.json({success:false},{status:503});
        const body=await req.json() as any;assert.equal(body.ttl,60);assert.equal(body.scope,'write');assert.ok(repos.has(body.repo));
        const id='owned_'+tokens.size;tokens.set(id,body.repo);
        return result({id,plaintext:'opaque_Z8_'+'c'.repeat(42)+'?expires='+Math.floor((Date.now()+60000)/1000),scope:'write',expires_at:new Date(Date.now()+60000).toISOString()});
      }
      if(u.pathname.endsWith('/tokens')&&req.method==='GET'){
        assert.equal(u.searchParams.get('state'),'all');assert.equal(u.searchParams.get('per_page'),'100');
        const page=Number(u.searchParams.get('page')),paginated=mode==='active-second-page',active=mode==='active-recovery-token'||paginated&&page===2;
        const rows=[{id:'old-check-'+page,scope:'write',state:active?'active':'expired',created_at:new Date(Date.now()-120000).toISOString(),expires_at:new Date(Date.now()+(active?60000:-60000)).toISOString()}];
        return result(rows,{result_info:{page,per_page:100,total_pages:paginated?2:1,count:1,total_count:mode==='incomplete-token-list'?2:paginated?2:1}});
      }
      if(req.method==='DELETE'){const id=parts.at(-1)!;assert.ok(tokens.has(id));return result({id});}
      if(repos.has(repoName)){
        if(u.pathname.endsWith('/file')){const bytes=repos.get(repoName)!.git.files.get(u.searchParams.get('ref')!)?.get(u.searchParams.get('path')!);return bytes?new Response(new Uint8Array(bytes),{headers:{'content-type':'application/octet-stream'}}):new Response(null,{status:404});}
        return result({...metadata(repoName),...(mode==='replaced'?{id:'replacement'}:{})});
      }
      return Response.json({success:false},{status:404});
    }
    assert.equal(u.origin,`https://${policy.account}.artifacts.cloudflare.net`);
    const name=parts[3].replace('.git',''),git=repos.get(name)!.git;
    assert.match(req.headers.get('authorization')??'',/^Bearer opaque_Z8_/);
    const response=await git.transport(new Request('https://account.artifacts.cloudflare.net/git/default/strata-smoke.git/'+parts.slice(4).join('/')+u.search,
      {method:req.method,headers:{...Object.fromEntries(req.headers),authorization:'Bearer mock-only-token?expires=fixture'},body:req.method==='POST'?await req.arrayBuffer():undefined,redirect:'manual'}));
    // Commit real synthetic Git bytes, then lose the response during initialization.
    if(mode==='lost-push'&&req.method==='POST'&&parts.at(-1)==='git-receive-pack')throw Error('Synthetic response lost after the initial push');
    return response;
  };
  let server=await hostFactory(base.state,config,{publicOrigin:base.origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer'),transport);
  const browser=()=>{const cookies=new Map<string,string>();return {cookies,send:(url:string,method='GET',input?:unknown,csrf?:string,extra:Record<string,string>={})=>new Promise<any>((resolve,reject)=>{
    const req=request(server.origin+url,{method,headers:{host:'studio.example.test','x-forwarded-proto':'https',...(method==='POST'?{origin:base.origin,'content-type':'application/json'}:{}),
      ...(csrf?{'x-studio-csrf':csrf}:{}),cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...extra}},res=>{
      for(const raw of res.headers['set-cookie']??[]){const pair=raw.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,text});});});req.on('error',reject);req.end(input===undefined?undefined:JSON.stringify(input));})};};
  const b=browser();let csrf='';
  const login=async()=>{const s=(await b.send('/studio/owner/session')).data,r=await b.send('/studio/owner/login','POST',{username:'workspace.owner',password:base.password},s.csrf);assert.equal(r.status,200,r.text);csrf=r.data.csrf;return r.data;};
  const action=async(action:string,fields:Record<string,unknown>={})=>{const s=(await b.send('/studio/v1/owner/connections')).data;return b.send('/studio/v1/owner/connections','POST',{action,revision:s.revision,request_id:randomUUID(),...fields},csrf);};
  const prepare=async()=>{await login();const save=await b.send('/studio/v1/owner/credentials','POST',{action:'save',credential_id:'artifacts-api-token',revision:0,request_id:randomUUID(),value:'synthetic-namespace-api-secret'},csrf);assert.equal(save.status,200,save.text);
    const s=(await b.send('/studio/v1/owner/connections')).data;const approved=await action('approve',{scope_sha256:s.scope_sha256,acknowledgment:'until-revoked-development-namespace',...(policy.first_project?{project_authority_sha256:digest(policy.first_project)}:{})});assert.equal(approved.status,200,approved.text);};
  const restart=async(buildConfiguration?:NamespaceLocalBuildConfiguration,alreadyStopped=false)=>{if(!alreadyStopped)await server.close();server=await hostFactory(base.state,config,{publicOrigin:base.origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer'),transport,undefined,undefined,undefined,buildConfiguration);};
  const seedExisting=()=>{
    const name='existing-project',id='existing-repository',git=new StrictArtifacts(),registry=structuredClone(base.imported.registry);
    Object.assign(registry.storage,{account:policy.account,namespace:policy.namespace,repository:name});
    const texts:Record<string,string>={...base.imported.record_bytes,'WorkspaceDraft@1':canonical(base.layer)};
    const hash=bytesDigest(texts['WorkspaceDraft@1']);registry.entries['WorkspaceDraft@1']={hash,type:'layer',published:false,locator:{ref:'f'.repeat(40),path:hash+'.json',hash,size_bytes:Buffer.byteLength(texts['WorkspaceDraft@1'])}};
    for(const [ref,e]of Object.entries(registry.entries)){let files=git.files.get(e.locator.ref);if(!files){files=new Map();git.files.set(e.locator.ref,files);}files.set(e.locator.path,new TextEncoder().encode(texts[ref]));}
    repos.set(name,{id,git,read_only:false});return {format:'strata-studio-repository-index/1' as const,repository_id:id,model_version:MODEL,registry};
  };
  return {base,policy,config,b,browser,login,action,prepare,restart,transport,seedExisting,get csrf(){return csrf;},get server(){return server;},repos,calls,setMode:(m:string)=>mode=m,onCreated:(hook:()=>Promise<void>)=>createdHook=hook};
}
