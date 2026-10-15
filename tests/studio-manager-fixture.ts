import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,readFile,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {digest} from '../src/model.js';
import {sourcePolicySchema,type SourcePolicy} from '../src/explorer/connection-policy.js';
import {ConnectionStore,initialConnectionState,prepareSourcePolicy} from '../src/explorer/connection-store.js';
import {ManagedConnections,type SourceOwner,type SourceOwnerAuthority,type ManagedReaderFactory} from '../src/explorer/connection-manager.js';
import {writePrivate} from '../src/explorer/owner-files.js';
import {ExplorerReader} from '../src/explorer/read.js';
import {ExplorerError} from '../src/explorer/contract.js';
import {TestSource,sample,config} from './explorer-fixture.js';
const code=(wanted:string)=>(e:any)=>e.code===wanted;
export async function managerFixture(factoryOverride?:ManagedReaderFactory){
  const directory=await mkdtemp(path.join(tmpdir(),'strata-source-manager-'));await chmod(directory,0o700);
  const storeDir=path.join(directory,'catalog'),accounting=path.join(directory,'accounting');
  await import('node:fs/promises').then(async fs=>{await fs.mkdir(storeDir,{mode:0o700});await fs.mkdir(accounting,{mode:0o700});});
  let now=Date.now();const ticket=(index:number)=>{const grant=randomUUID(),c=config();c.connection_id='grant-'+grant;c.registry_path=path.join(directory,'trusted-registry.json');c.read_authorization.policy_generation='grant-'+grant;c.read_authorization.expires_at=new Date(now+3600000*(index+1)).toISOString();return {ticket_id:randomUUID(),grant_id:grant,profile_id:'approved',not_before:new Date(now-1000).toISOString(),connection:c,expected_repository_id:'synthetic-repo'};};
  let policy:SourcePolicy|undefined=prepareSourcePolicy(sourcePolicySchema.parse({format:'strata-studio-source-policy/1',installation_id:randomUUID(),owner_id:randomUUID(),catalog_id:randomUUID(),policy_id:randomUUID(),generation:1,initial_catalog_sha256:'0'.repeat(64),valid_until:new Date(now+8*3600000).toISOString(),actions:['create','test','select','connect','disconnect','renew','remove'],profiles:[{profile_id:'approved',label:'Synthetic approved repository',registry_sha256:'0'.repeat(64)}],tickets:[ticket(0),ticket(1),ticket(2)]}));
  const initial=initialConnectionState(policy);await writePrivate(path.join(storeDir,'genesis.json'),initial,true);await writePrivate(path.join(storeDir,'state.json'),initial,true);
  let owner:SourceOwner={installation_id:policy.installation_id,owner_id:policy.owner_id,authentication_generation:1,fresh:true},calls=0;
  const authority:SourceOwnerAuthority={current:async()=>({...owner})},policyPort={current:async()=>policy?structuredClone(policy):undefined},store=new ConnectionStore(storeDir);
  const records=await sample();let failure:Error|undefined,delay:Promise<void>|undefined;
  const factory:ManagedReaderFactory=factoryOverride??{build:async(ticket,budget,check)=>{
    const source=new TestSource(records);return new ExplorerReader({connection:{...source.connection,connection_id:ticket.connection.connection_id},assertAuthorized:()=>source.assertAuthorized(),load:async signal=>{await check();await budget.reserve(1);calls++;if(delay)await delay;await check();if(failure)throw failure;return source.load();}});
  }};
  const make=()=>new ManagedConnections(policyPort,store,accounting,factory,()=>now),manager=make();
  const action=async(kind:string,extra:Record<string,unknown>={})=>{const s=await manager.status(authority);return manager.action(authority,{action:kind,revision:s.revision,request_id:randomUUID(),...(kind==='create'?{profile_id:'approved',ticket_id:policy!.tickets[0].ticket_id,label:'Readable source'}:{connection_id:s.selected_connection_id}),...extra});};
  return {directory,storeDir,accounting,store,authority,policyPort,manager,make,action,get policy(){return policy!;},setPolicy:(p:SourcePolicy|undefined)=>policy=p,changeOwner:(o:Partial<SourceOwner>)=>owner={...owner,...o},advance:(ms:number)=>now+=ms,calls:()=>calls,fail:(e:Error|undefined)=>failure=e,delay:(p:Promise<void>|undefined)=>delay=p,state:async()=>JSON.parse(await readFile(path.join(storeDir,'state.json'),'utf8')),ledger:async(grant:string)=>JSON.parse(await readFile(path.join(accounting,grant,'read-budget.json'),'utf8'))};
}

