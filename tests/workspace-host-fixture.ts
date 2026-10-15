import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import path from 'node:path';
import {BootstrapState} from '../src/explorer/bootstrap-state.js';
import {OwnerAccess} from '../src/explorer/owner-access.js';
import {armControl,publishControl} from '../src/explorer/bootstrap-control.js';
import {approvePending,inspectCompletion,sealCompletion} from '../scripts/studio-owner-control.js';
import {startExplorer} from '../src/explorer/host.js';
import {ExplorerReader} from '../src/explorer/read.js';
import {TestSource,sample} from './explorer-fixture.js';
import {workspaceRuntimeFixture} from './workspace-runtime-fixture.js';
import {runWorkspaceStudio} from '../src/explorer/workspace-host.js';
import {writePrivate} from '../src/explorer/owner-files.js';
import {digest} from '../src/model.js';
import {repositoryGrantDigest} from '../src/explorer/workspace-policy.js';
import {initialWorkspaceBudget} from '../src/explorer/workspace-budget.js';
import {initialWorkspaceState} from '../src/explorer/workspace-state.js';
export async function workspaceHostFixture(development=false){
 const f=await workspaceRuntimeFixture(),origin='https://studio.example.test',password='Disposable workspace owner password 2026';
 const config={control_file:path.join(f.root,'owner-control.json'),state_directory:path.join(f.root,'owner-state'),key_directory:path.join(f.root,'owner-keys'),credential_directory:path.join(f.root,'owner-credentials')};
 let control=armControl(origin);await publishControl(config.control_file,control);const state=new BootstrapState(config,origin);await state.readyDirectories();
 let server:any=await startExplorer(new ExplorerReader(new TestSource(await sample())),{assets:path.resolve('explorer'),owner:new OwnerAccess(state,{publicOrigin:origin,trustedProxyAddresses:['127.0.0.1']})});
 const browser=()=>{const cookies=new Map<string,string>();return {cookies,send:(url:string,method='GET',input?:unknown,csrf?:string,extra:Record<string,string>={})=>new Promise<any>((resolve,reject)=>{
   const req=request(server.origin+url,{method,headers:{host:'studio.example.test','x-forwarded-proto':'https',...(method==='POST'?{origin,'content-type':'application/json'}:{}),...(csrf?{'x-studio-csrf':csrf}:{}),cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...extra}},res=>{
     for(const raw of res.headers['set-cookie']??[]){const [pair]=raw.split(';'),i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,text,headers:res.headers});});});req.on('error',reject);req.end(input===undefined?undefined:JSON.stringify(input));})};};
 const b=browser(),s=(await b.send('/studio/setup')).data,p=(await b.send('/studio/setup/request','POST',{request_id:randomUUID(),expected_generation:s.generation},s.csrf)).data;
 control=await approvePending(config,control,p.request.code);await publishControl(config.control_file,control);
 const approved=(await b.send('/studio/setup')).data;await b.send('/studio/setup/complete','POST',{request_id:randomUUID(),expected_generation:approved.generation,username:'workspace.owner',password,key_storage_policy:'host-bound'},approved.csrf);
 const completion=await inspectCompletion(config);control=await sealCompletion(config,control,completion.binding);await publishControl(config.control_file,control);await server.close();
 const active=(await state.owner())!,grant=f.grant;grant.installation_id=active.manifest.installation_id;grant.owner_id=active.owner_id;
 if(development)grant.provider_contract='development-name-addressed';
 f.accounts.accounts[0].credential={method:'installation-owner',installation_id:grant.installation_id,owner_id:grant.owner_id};grant.actor_binding_sha256=digest({accounts:f.accounts,policy:f.policy});
 const files={grant_file:path.join(f.root,'workspace-grant.json'),actor_accounts_file:path.join(f.root,'workspace-accounts.json'),actor_policy_file:path.join(f.root,'workspace-policy.json'),import_file:path.join(f.root,'workspace-import.json'),provider_identity_file:path.join(f.root,'workspace-provider-proof.json'),broker_state_directory:f.directories.broker,budget_directory:f.directories.budget,control_directory:f.directories.control};
 await writePrivate(files.grant_file,grant,true);await writePrivate(files.actor_accounts_file,f.accounts,true);await writePrivate(files.actor_policy_file,f.policy,true);await writePrivate(files.import_file,f.imported,true);
 await writePrivate(files.provider_identity_file,development?{format:'strata-studio-development-provider-contract/1',grant_sha256:repositoryGrantDigest(grant),expected_repository_id:grant.storage.expected_repository_id,
  environment:'development',contract:'repository-addressed-by-name',operator_rule:'no-delete-recreate-or-rebind-during-write-or-reconciliation',evidence_kind:'owner-acknowledgment',evidence_sha256:digest('synthetic-only')}:
  {format:'strata-studio-provider-identity/1',grant_sha256:repositoryGrantDigest(grant),expected_repository_id:grant.storage.expected_repository_id,guarantee:'repository-token-bound-to-immutable-id',evidence_kind:'approved-disposable-test',evidence_sha256:digest('synthetic-only')},true);
 await writePrivate(path.join(f.directories.budget,'budget.json'),initialWorkspaceBudget(grant,f.imported.origin));await writePrivate(path.join(f.directories.control,'workspace.json'),initialWorkspaceState(grant,digest(f.imported.origin)));
 server=await runWorkspaceStudio(state,files,{publicOrigin:origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer'),f.transport);
 const login=async()=>{const s=(await b.send('/studio/owner/session')).data;return (await b.send('/studio/owner/login','POST',{username:'workspace.owner',password},s.csrf)).data;};
 const restart=async()=>{await server.close();server=await runWorkspaceStudio(state,files,{publicOrigin:origin,trustedProxyAddresses:['127.0.0.1']},0,path.resolve('explorer'),f.transport);};
 return {...f,state,get server(){return server;},restart,files,config,b,browser,login,password,origin};
}
