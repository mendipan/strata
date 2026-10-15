import { randomUUID } from 'node:crypto';
import { chmod,mkdtemp,mkdir,readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { Engine } from '../src/core.js';
import { MODEL,BLOCK_MODEL,canonical,bytesDigest,digest } from '../src/model.js';
import { HostIssuer,accountStoreV2Schema,policyStoreV2Schema,policyStoreV4Schema } from '../src/auth/host-issuer.js';
import { WORKFLOW_READS } from '../src/workflow.js';
import { WORKSPACE_WRITES,repositoryGrantDigest } from '../src/explorer/workspace-policy.js';
import { workspaceGrant,carriedUsage } from './workspace-fixture.js';
import { writerImportSchema } from '../src/explorer/workspace-import.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { initialWorkspaceBudget,FileWorkspaceBudget } from '../src/explorer/workspace-budget.js';
import { initialWorkspaceState,FileWorkspaceState } from '../src/explorer/workspace-state.js';
import { WorkspaceRuntime } from '../src/explorer/workspace-runtime.js';
import { startLocalBroker } from '../src/local-broker.js';
import { PROFILE_OPERATIONS } from '../src/build-records.js';
import type { ProfileServiceScope } from '../src/profile-service.js';
const pkt=(s:string)=>(Buffer.byteLength(s)+4).toString(16).padStart(4,'0')+s;
export async function workspaceRuntimeFixture(options: { seed?: Engine; principal?: string; profileScope?: ProfileServiceScope; runtimeOperations?: string[]; finiteProfiles?: string[] } = {}){
 const root=await mkdtemp(path.join(process.env.STRATA_TEST_TMP??tmpdir(),'strata-workspace-runtime-'));await chmod(root,0o700);
 const directories=Object.fromEntries(['broker','budget','control'].map(k=>[k,path.join(root,k)]));for(const d of Object.values(directories)){await mkdir(d,{mode:0o700});await chmod(d,0o700);}
 const cache=path.join(directories.broker,'verified-artifacts');await mkdir(cache,{mode:0o700});
 const grant=workspaceGrant(),engine=options.seed??new Engine({}, {},{projectId:grant.project_id,modelVersion:MODEL});
 grant.project_id=engine.options.projectId!;grant.model_version=engine.modelVersion() as typeof MODEL|typeof BLOCK_MODEL;
 const principal=options.principal??'named-author';
 const base=JSON.parse(await readFile('tests/fixtures/counter/bootstrap.json','utf8'));if(!options.seed)engine.init(base,'bootstrap');
 const entries=Object.fromEntries(Object.entries(engine.records).map(([ref,r])=>{const text=canonical(r.data),hash=bytesDigest(text);return [ref,{hash,type:r.type,published:r.published,locator:{ref:'f'.repeat(40),path:hash+'.json',hash,size_bytes:Buffer.byteLength(text)}}];}));
 const accounts=accountStoreV2Schema.parse({format:'strata-host-accounts/2',generation:1,accounts:[{account_id:'owner-author',principal_id:principal,principal_kind:'person',active:true,credential_epoch:1,credential:{method:'installation-owner',installation_id:grant.installation_id,owner_id:grant.owner_id}}]});
 const policy=(options.profileScope?policyStoreV4Schema:policyStoreV2Schema).parse({format:options.profileScope?'strata-host-policy/4':'strata-host-policy/2',project_id:grant.project_id,generation:1,grants:[{grant_id:'workspace-author',principal_id:principal,operations:[...WORKFLOW_READS,'inspect','status','diff','conflicts','context.show',...WORKSPACE_WRITES,...(options.profileScope?PROFILE_OPERATIONS:[]),...(options.runtimeOperations??[])],...(options.profileScope?{build_repository_ids:[options.profileScope.repository_id],approvals:['release']}:{approvals:[]}),layer_ids:null,write_block_ids:['counter'],create_under_block_ids:[],profiles:options.finiteProfiles??[],lifetime:grant.lifetime}]});
 grant.actor_binding_sha256=digest({accounts,policy});
 const imported=writerImportSchema.parse({format:options.seed?'strata-studio-owner-snapshot/1':'strata-studio-writer-import/1',project_id:grant.project_id,model_version:grant.model_version,expected_repository_id:grant.storage.expected_repository_id,
   complete_private_state:!options.seed,quiesced_at:new Date().toISOString(),source_writer:'synthetic-writer',source_generation:digest('source-generation'),
   closure_verification:{kind:options.seed?'owner-approved-snapshot':'authoritative-writer-export',receipt_sha256:digest('closure-verification')},
   registry:{entries,storage:{format:'strata-artifacts-registry/1',project_id:grant.project_id,account:grant.storage.account,namespace:grant.storage.namespace,repository:grant.storage.repository,mode:'remote'},asset_locators:{},heads:options.seed?{}:engine.ownerHeads,requests:{},contexts:{}},
   record_bytes:Object.fromEntries(Object.entries(engine.records).map(([ref,r])=>[ref,canonical(r.data)])),origin:carriedUsage()});
 grant.import_manifest_sha256=digest(imported);
 await writePrivate(path.join(directories.broker,'node-state.json'),{format:'strata-node-state/1',model_version:grant.model_version,project_id:grant.project_id},true);
 await writePrivate(path.join(directories.broker,'registry.json'),imported.registry,true);
 const remoteFiles=new Map<string,Uint8Array>();for(const [r,e]of Object.entries(entries)){const text=canonical(engine.records[r].data);const {open}=await import('node:fs/promises');const h=await open(path.join(cache,e.locator.path),'wx',0o600);try{await h.writeFile(text);}finally{await h.close();}remoteFiles.set(e.locator.path,new TextEncoder().encode(text));}
 await writePrivate(path.join(directories.budget,'budget.json'),initialWorkspaceBudget(grant,imported.origin),true);
 await writePrivate(path.join(directories.control,'workspace.json'),initialWorkspaceState(grant,digest(imported.origin)),true);
 const budget=new FileWorkspaceBudget(path.join(directories.budget,'budget.json'),grant,imported.origin),control=new FileWorkspaceState(path.join(directories.control,'workspace.json'),grant,digest(imported.origin));
 await control.action({action:'connect',revision:0,request_id:randomUUID()},async()=>{});
 let parentLive=true,credentialGeneration=digest('credential-generation'),mode='ok',pushes=0,mints=0,revokes=0;
 const issuer=new HostIssuer(accounts,policy,Date.now,async()=>({installation_id:grant.installation_id,owner_id:grant.owner_id,session_id:'synthetic-parent',authentication_generation:1,
   expires_at:new Date(Date.now()+3600000).toISOString(),assertLive(){if(!parentLive)throw Error('parent revoked');},async refresh(){if(!parentLive)throw Error('parent revoked');}}));
 const token=await issuer.loginOwner({});
 const proof={format:'strata-studio-provider-identity/1' as const,grant_sha256:repositoryGrantDigest(grant),expected_repository_id:grant.storage.expected_repository_id,
   guarantee:'repository-token-bound-to-immutable-id' as const,evidence_kind:'approved-disposable-test' as const,evidence_sha256:digest('synthetic-id-binding')};
 const transport=async(req:Request)=>{
   const u=new URL(req.url),json=(result:unknown)=>Response.json({success:true,result});
   if(u.pathname.endsWith('/repos/workspace-test'))return json({id:grant.storage.expected_repository_id,name:grant.storage.repository,remote:grant.storage.remote,read_only:false});
   if(u.pathname.endsWith('/tokens')&&req.method==='POST'){mints++;const expiry=Date.now()+60000;return json({id:'owned-'+mints,plaintext:'art_v1_'+'a'.repeat(40)+'?expires='+Math.floor(expiry/1000),scope:'write',expires_at:new Date(expiry).toISOString()});}
   if(req.method==='DELETE'){revokes++;return json({id:u.pathname.split('/').at(-1)});}
   if(u.pathname.endsWith('/info/refs'))return new Response(pkt('# service=git-receive-pack\n')+'0000'+pkt('0'.repeat(40)+' capabilities^{}\0report-status\n')+'0000');
   if(u.pathname.endsWith('/git-receive-pack')){
     pushes++;const bytes=Buffer.from(await req.arrayBuffer()),length=parseInt(bytes.subarray(0,4).toString(),16),line=bytes.subarray(4,length).toString(),branch=line.match(/refs\/heads\/strata\/artifacts\/[a-f0-9]{64}/)![0];
     let offset=length+4;assertPack(bytes,offset);const count=bytes.readUInt32BE(offset+8);offset+=12;
     for(let n=0;n<count;n++){let b=bytes[offset++],size=b&15,shift=4;const kind=(b>>4)&7;while(b&128){b=bytes[offset++];size+=(b&127)*2**shift;shift+=7;}const inflated=inflateSync(bytes.subarray(offset),{info:true}) as any;offset+=inflated.engine.bytesWritten;if(inflated.buffer.length!==size)throw Error('synthetic pack size mismatch');if(kind===3){const body=new Uint8Array(inflated.buffer);remoteFiles.set(bytesDigest(body)+'.json',body);remoteFiles.set(bytesDigest(body)+'.bin',body);}}
     if(mode==='push-response-lost')throw Error('synthetic lost push response');
     return new Response(pkt('unpack ok\n')+pkt('ok '+branch+'\n')+'0000');
   }
   if(u.pathname.endsWith('/file')){const bytes=remoteFiles.get(u.searchParams.get('path')!);return bytes?new Response(new Uint8Array(bytes)):new Response(null,{status:404});}
   throw Error('unsupported synthetic endpoint');
 };
 const runtime=()=>new WorkspaceRuntime(grant,imported,issuer,budget,control,directories.broker,async()=>credentialGeneration,async()=>'synthetic-provider-key',proof,transport);
 let qualified=false;
 const ownerProof=async()=>({installation_id:grant.installation_id,owner_id:grant.owner_id,session_id:'synthetic-parent',authentication_generation:1,expires_at:new Date(Date.now()+3600000).toISOString(),assertLive(){if(!parentLive)throw Error('parent revoked');},async refresh(){if(!parentLive)throw Error('parent revoked');}});
 const start=async(extra:any={})=>{const r=runtime();await r.ready();if(!qualified&&extra.qualify!==false){await r.test({action:'test-write',revision:(await control.snapshot()).revision,request_id:randomUUID()},ownerProof);qualified=true;}const broker=await startLocalBroker(directories.broker,0,{issuer,model_version:grant.model_version,...(options.profileScope?{repository:{scope:options.profileScope}}:{}),artifacts:r.store,workspace:{...r.brokerControls(),...extra},max_pending:4});return {runtime:r,broker,
   call:async(command:string,input:any={},key?:string,dryRun=false)=>{const res=await fetch(broker.url+'/v1/operation',{method:'POST',headers:{'content-type':'application/json','x-strata-session':token,'x-strata-project':grant.project_id,'x-strata-artifact-adapter':'cloudflare-artifacts-remote'},body:JSON.stringify({command,input,options:{idempotency_key:key,dry_run:dryRun}})});return res.json() as Promise<any>;}};};
 const layer=JSON.parse(await readFile('tests/fixtures/counter/extend.json','utf8'));layer.owner=principal;layer.id='WorkspaceDraft';
 return {root,grant,imported,accounts,policy,issuer,token,budget,control,directories,start,layer,ownerProof,transport,counts:()=>({pushes,mints,revokes}),
   revokeParent:()=>parentLive=false,rotateCredential:()=>{credentialGeneration=digest('new-credential-generation');control.changed();},setMode:(s:string)=>mode=s};
}
function assertPack(bytes:Buffer,offset:number){if(bytes.subarray(offset,offset+4).toString()!=='PACK')throw Error('synthetic pack missing');}
