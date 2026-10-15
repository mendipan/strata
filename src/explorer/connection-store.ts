import path from 'node:path';
import { z } from 'zod';
import { digest } from '../model.js';
import { privateDir,readPrivate,writePrivate,withLease } from './owner-files.js';
import { connectionRecovery,policyDigest,sourcePolicySchema,type SourcePolicy } from './connection-policy.js';
import { ExplorerError,problem } from './contract.js';

const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),gen=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1);
const resultSchema=z.object({state:z.enum(['completed','failed','interrupted']),code:z.string().max(64).nullable(),revision:gen}).strict();
export const connectionStateSchema=z.object({
  format:z.literal('strata-studio-connections-state/1'),installation_id:id,owner_id:id,catalog_id:id,policy_sha256:hash,
  revision:gen,epoch:gen,selected_connection_id:id.nullable(),
  grants:z.array(z.object({grant_id:id,ticket_id:id,binding_sha256:hash,phase:z.enum(['prepared','active','retired'])}).strict()).max(64),
  entries:z.array(z.object({connection_id:id,profile_id:z.string().max(256),grant_id:id,label:z.string().min(1).max(128),desired_connection:z.boolean(),last_test:z.object({at:z.string().datetime(),outcome:z.enum(['passed','failed']),code:z.string().max(64).nullable(),registry_generation:hash.nullable().optional()}).strict().nullable()}).strict()).max(8),
  operations:z.array(z.object({request_id:id,payload_sha256:hash,action:z.string().max(16),owner_generation:gen,at:z.string().datetime(),boot_id:id,epoch:gen,connection_id:id.nullable(),result:resultSchema.nullable()}).strict()).max(1024),
}).strict();
export type ConnectionState=z.infer<typeof connectionStateSchema>;
export function initialConnectionState(policy:SourcePolicy):ConnectionState{
  const p=sourcePolicySchema.parse(policy);return connectionStateSchema.parse({format:'strata-studio-connections-state/1',installation_id:p.installation_id,owner_id:p.owner_id,catalog_id:p.catalog_id,policy_sha256:policyDigest(p),revision:0,epoch:0,selected_connection_id:null,grants:[],entries:[],operations:[]});
}
// Explicit operator preparation only; never called by service startup.
export function prepareSourcePolicy(input:SourcePolicy):SourcePolicy{const p=sourcePolicySchema.parse(input);return sourcePolicySchema.parse({...p,initial_catalog_sha256:digest(initialConnectionState(p))});}
// Pure custody validation is shared by the reader and the root mode operator.
// It neither opens private files nor constructs a connection/accounting writer.
export function validateConnectionCatalog(policy:SourcePolicy,genesisValue:unknown,stateValue:unknown):ConnectionState{
  const genesis=connectionStateSchema.parse(genesisValue);
  if(digest(genesis)!==policy.initial_catalog_sha256||digest(genesis)!==digest(initialConnectionState(policy)))connectionRecovery();
  const state=connectionStateSchema.parse(stateValue);
  if(state.policy_sha256!==policyDigest(policy)||state.installation_id!==policy.installation_id||state.owner_id!==policy.owner_id||state.catalog_id!==policy.catalog_id)connectionRecovery();
  const unique=(a:string[])=>new Set(a).size===a.length;
  if(!unique(state.grants.map(g=>g.grant_id))||!unique(state.grants.map(g=>g.ticket_id))||!unique(state.grants.map(g=>g.binding_sha256))||!unique(state.entries.map(e=>e.connection_id))||!unique(state.operations.map(o=>o.request_id)))connectionRecovery();
  for(const g of state.grants){const t=policy.tickets.find(t=>t.ticket_id===g.ticket_id&&t.grant_id===g.grant_id);if(!t||g.binding_sha256!==digest({connection:t.connection,expected_repository_id:t.expected_repository_id}))connectionRecovery();}
  for(const e of state.entries){const g=state.grants.find(g=>g.grant_id===e.grant_id&&g.phase==='active'),t=policy.tickets.find(t=>t.grant_id===e.grant_id);if(!g||!t||e.profile_id!==t.profile_id)connectionRecovery();}
  if(state.grants.some(g=>g.phase==='prepared'))connectionRecovery();
  if(state.selected_connection_id&&!state.entries.some(e=>e.connection_id===state.selected_connection_id))connectionRecovery();
  return state;
}
export class ConnectionStore {
  private queue:Promise<void>=Promise.resolve();
  constructor(readonly directory:string){if(!path.isAbsolute(directory)||path.resolve(directory)!==directory)connectionRecovery();}
  async read(policy:SourcePolicy):Promise<ConnectionState>{
    try{
      await privateDir(this.directory);
      return validateConnectionCatalog(policy,await readPrivate(path.join(this.directory,'genesis.json'),2*1024*1024),
        await readPrivate(path.join(this.directory,'state.json'),2*1024*1024));
    }catch(error){if(error instanceof ExplorerError)throw error;return connectionRecovery();}
  }
  async transaction<T>(policy:SourcePolicy,operation:(state:ConnectionState,save:()=>Promise<void>)=>Promise<T>):Promise<T>{
    const previous=this.queue;let release!:()=>void;this.queue=new Promise<void>(resolve=>release=resolve);await previous;
    try{return await withLease(this.directory,async()=>{const state=await this.read(policy);return operation(state,async()=>{const parsed=connectionStateSchema.parse(state);if(Buffer.byteLength(JSON.stringify(parsed))>2*1024*1024)problem('MANAGEMENT_CAPACITY',409,'Connection history is full; operator reconciliation is required.');await writePrivate(path.join(this.directory,'state.json'),parsed);});});}
    catch(error){if(error instanceof ExplorerError&&error.code!=='SETUP_BUSY')throw error;return connectionRecovery();}
    finally{release();}
  }
}
