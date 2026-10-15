import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../model.js';
import { privateDir,readPrivate,writePrivate } from './owner-files.js';
import { ExplorerReader } from './read.js';
import { ExplorerError,problem } from './contract.js';
import { FileReadBudget,initialReadBudget } from './read-budget.js';
import { connectionRecovery,managementRequired,managementActions,sourcePolicySchema,policyDigest,type SourcePolicy,type SourcePolicyPort } from './connection-policy.js';
import { ConnectionStore,type ConnectionState } from './connection-store.js';

const id=z.string().uuid(),common={revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),request_id:id};
export const managedConnectionActionSchema=z.discriminatedUnion('action',[
  z.object({...common,action:z.literal('create'),profile_id:z.string().max(256),ticket_id:id,label:z.string().trim().min(1).max(128)}).strict(),
  z.object({...common,action:z.literal('renew'),connection_id:id,ticket_id:id}).strict(),
  ...(['test','select','connect','disconnect','remove'] as const).map(action=>z.object({...common,action:z.literal(action),connection_id:id}).strict()),
]);
export type ManagedConnectionAction=z.infer<typeof managedConnectionActionSchema>;
export type SourceOwner={installation_id:string;owner_id:string;authentication_generation:number;fresh:boolean};
export interface SourceOwnerAuthority { current(fresh?:boolean):Promise<SourceOwner> }
export type ManagedGrant=SourcePolicy['tickets'][number];
export interface ManagedReaderFactory { build(ticket:ManagedGrant,budget:FileReadBudget,check:()=>Promise<void>):Promise<ExplorerReader> }
const messages:Record<string,string>={SOURCE_AUTH:'Source credentials or the approved read grant need attention.',SOURCE_BINDING:'The trusted registry or repository identity could not be verified.',SOURCE_UNAVAILABLE:'The source could not be reached within its bounded read.',READ_SESSION_LIMIT:'This approved grant has exhausted its read budget.',READ_BUDGET_UNAVAILABLE:'Protected read accounting needs operator reconciliation.',CORRUPT_DATA:'Project records could not be verified.',CONNECTION_CHANGED:'The connection changed during the operation.',CONNECTION_RECOVERY_REQUIRED:'Protected connection state needs operator reconciliation.'};
const safeCode=(error:unknown)=>error instanceof ExplorerError&&Object.hasOwn(messages,error.code)?error.code:'CORRUPT_DATA';
export class ManagedConnections {
  readonly bootId=randomUUID();
  private readers=new Map<string,{reader:ExplorerReader;grant:string;epoch:number}>();
  private inflight=new Map<string,AbortController>();
  constructor(readonly policyPort:SourcePolicyPort,readonly store:ConnectionStore,readonly accountingDirectory:string,private factory:ManagedReaderFactory,private now=Date.now){
    if(!path.isAbsolute(accountingDirectory)||path.resolve(accountingDirectory)!==accountingDirectory)connectionRecovery();
    const rel=path.relative(store.directory,accountingDirectory),back=path.relative(accountingDirectory,store.directory);
    const nested=(r:string)=>!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);if(nested(rel)||nested(back))connectionRecovery();
  }
  private async authorize(authority:SourceOwnerAuthority,action?:string){
    const owner=await authority.current(['create','renew','remove'].includes(action??''));
    if(['create','renew','remove'].includes(action??'')&&!owner.fresh)problem('OWNER_REAUTH_REQUIRED',403,'Confirm your password before managing approved sources.');
    const raw=await this.policyPort.current();if(!raw)managementRequired();const policy=sourcePolicySchema.parse(raw);
    if(owner.owner_id!==policy.owner_id||owner.installation_id!==policy.installation_id||this.now()>=Date.parse(policy.valid_until)||(action&&!policy.actions.includes(action as typeof managementActions[number])))managementRequired();
    return {owner,policy};
  }
  private async unchanged(authority:SourceOwnerAuthority,owner:SourceOwner,policy:SourcePolicy,action?:string){const current=await this.authorize(authority,action);if(current.owner.authentication_generation!==owner.authentication_generation||policyDigest(current.policy)!==policyDigest(policy))managementRequired();}
  private ticket(policy:SourcePolicy,grant:string){const ticket=policy.tickets.find(t=>t.grant_id===grant);if(!ticket)connectionRecovery();return ticket;}
  private binding(ticket:ManagedGrant){const c=ticket.connection;return {project_id:c.project_id,model_version:c.model_version,repository_identity:{account:c.storage.account,namespace:c.storage.namespace,repository:c.storage.repository,id:ticket.expected_repository_id},registry_kind:c.registry_kind};}
  private entry(state:ConnectionState,id:string){const entry=state.entries.find(e=>e.connection_id===id);if(!entry)problem('INVALID_INPUT',400,'Choose an existing connection.');return entry;}
  private budget(ticket:ManagedGrant){return new FileReadBudget(path.join(this.accountingDirectory,ticket.grant_id,'read-budget.json'),ticket.connection,ticket.expected_repository_id);}
  private invalidate(abortInflight=true){for(const {reader}of this.readers.values())reader.invalidate();this.readers.clear();if(abortInflight)for(const abort of this.inflight.values())abort.abort();}
  async changed(){this.invalidate();}
  private async grantReady(ticket:ManagedGrant){
    try{const directory=path.join(this.accountingDirectory,ticket.grant_id);await privateDir(directory);const manifest=await readPrivate(path.join(directory,'grant.json'),32768);if(digest(manifest)!==digest(ticket))connectionRecovery();await this.budget(ticket).ready();}
    catch(error){if(error instanceof ExplorerError)throw error;connectionRecovery();}
  }
  private validGrant(ticket:ManagedGrant){if(this.now()<Date.parse(ticket.not_before)||this.now()>=Date.parse(ticket.connection.read_authorization.expires_at))problem('SOURCE_AUTH',403,'The approved grant is outside its activation window.');}
  async status(authority:SourceOwnerAuthority){
    // Public reconciliation namespaces confer no authority; requests still reauthorize.
    const owner=await authority.current(),ownerScope=digest({installation_id:owner.installation_id,owner_id:owner.owner_id});let policy:SourcePolicy|undefined;
    try{policy=await this.policyPort.current();if(!policy||policy.owner_id!==owner.owner_id||policy.installation_id!==owner.installation_id||this.now()>=Date.parse(policy.valid_until))managementRequired();policy=sourcePolicySchema.parse(policy);}
    catch(error){this.invalidate();return {format:'strata-studio-owner-connections/1',reconciliation_scope:{owner:ownerScope,catalog:null},revision:null,selected_connection_id:null,management:{state:'unavailable',code:error instanceof ExplorerError?error.code:'CONNECTION_RECOVERY_REQUIRED'},profiles:[],tickets:[],connections:[],operations:[]};}
    const state=await this.store.read(policy),used=new Set(state.grants.map(g=>g.ticket_id));
    const connections=[];
    for(const entry of state.entries){const ticket=this.ticket(policy,entry.grant_id);let code:string|null=null;
      try{this.validGrant(ticket);await this.grantReady(ticket);}catch(error){code=safeCode(error);this.readers.get(entry.connection_id)?.reader.invalidate();this.readers.delete(entry.connection_id);}
      const runtime=this.readers.get(entry.connection_id),ready=runtime?.grant===entry.grant_id&&runtime.epoch===state.epoch&&entry.desired_connection;
      const interrupted=state.operations.some(o=>o.connection_id===entry.connection_id&&!o.result&&o.boot_id!==this.bootId);
      const actions=Object.fromEntries(managementActions.map(action=>[action,{allowed:policy!.actions.includes(action)&&!interrupted,reason_code:interrupted?'CONNECTION_RECOVERY_REQUIRED':policy!.actions.includes(action)?null:'SOURCE_MANAGEMENT_REQUIRED'}]));
      connections.push({connection_id:entry.connection_id,profile_id:entry.profile_id,grant_id:entry.grant_id,display_name:entry.label,binding:this.binding(ticket),selected:state.selected_connection_id===entry.connection_id,desired_connection:entry.desired_connection,state:code?'blocked':interrupted?'interrupted':ready?'read-only':'disconnected',runtime_ready:!!ready&&!code,expires_at:ticket.connection.read_authorization.expires_at,limits:{requests:ticket.connection.read_authorization.max_requests,bytes:ticket.connection.read_authorization.max_bytes},usage:{reserved_requests:null,reserved_bytes:null},error:code?{code,message:messages[code]}:null,last_test:entry.last_test,actions});
    }
    await this.unchanged(authority,owner,policy);
    return {format:'strata-studio-owner-connections/1',reconciliation_scope:{owner:ownerScope,catalog:digest({catalog_id:policy.catalog_id})},revision:state.revision,selected_connection_id:state.selected_connection_id,management:{state:'delegated',actions:policy.actions,reauth_required:!owner.fresh,remaining_tickets:policy.tickets.length-used.size},profiles:policy.profiles.map(p=>{const t=policy!.tickets.find(t=>t.profile_id===p.profile_id);return {profile_id:p.profile_id,label:p.label,binding:t?this.binding(t):null};}),tickets:policy.tickets.filter(t=>!used.has(t.ticket_id)).map(t=>({ticket_id:t.ticket_id,profile_id:t.profile_id,expires_at:t.connection.read_authorization.expires_at,not_before:t.not_before,eligible:this.now()>=Date.parse(t.not_before)&&this.now()<Date.parse(t.connection.read_authorization.expires_at),requests:t.connection.read_authorization.max_requests,bytes:t.connection.read_authorization.max_bytes})),connections,operations:state.operations.filter(o=>!o.result).map(o=>({request_id:o.request_id,action:o.action,state:o.boot_id===this.bootId?'pending':'interrupted'}))};
  }
  async outcome(authority:SourceOwnerAuthority,id:string){const {policy}=await this.authorize(authority);const state=await this.store.read(policy);const op=state.operations.find(o=>o.request_id===id);if(!op)problem('NOT_FOUND',404,'No action receipt exists for this request.');return {request_id:op.request_id,action:op.action,state:op.result?.state??(op.boot_id===this.bootId?'pending':'interrupted'),code:op.result?.code??null,revision:op.result?.revision??null};}
  async action(authority:SourceOwnerAuthority,input:unknown){
    const parsed=managedConnectionActionSchema.safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Connections require one bounded action, current revision and request ID.');
    const action=parsed.data,{owner,policy}=await this.authorize(authority,action.action),payload=digest(action);
    let replayed=false,operation:ConnectionState['operations'][number]|undefined,ticket:ManagedGrant|undefined;
    await this.store.transaction(policy,async(state,save)=>{
      await this.unchanged(authority,owner,policy,action.action);const old=state.operations.find(o=>o.request_id===action.request_id);
      if(old){if(old.payload_sha256!==payload)problem('REQUEST_CONFLICT',409,'This request ID already identifies a different action.');if(!old.result)problem('CONNECTION_RECOVERY_REQUIRED',503,'The existing action has no confirmed outcome; inspect it before continuing.');replayed=true;return;}
      if(state.revision!==action.revision)problem('CONNECTION_CHANGED',409,'Refresh connection settings before trying again.');
      if(state.grants.some(g=>g.phase==='prepared'))connectionRecovery();
      if(state.operations.length>=1024)problem('MANAGEMENT_CAPACITY',409,'Connection history requires operator archival.');
      const entry=action.action==='create'?undefined:this.entry(state,action.connection_id);
      if(entry&&state.operations.some(o=>o.connection_id===entry.connection_id&&!o.result&&o.boot_id!==this.bootId))connectionRecovery();
      if(action.action==='create'||action.action==='renew'){
        ticket=policy.tickets.find(t=>t.ticket_id===action.ticket_id);if(!ticket||(action.action==='create'?ticket.profile_id!==action.profile_id:ticket.profile_id!==entry!.profile_id))managementRequired();this.validGrant(ticket);
        if(state.grants.some(g=>g.ticket_id===ticket!.ticket_id||g.grant_id===ticket!.grant_id))managementRequired();
        if(action.action==='create'&&state.entries.length>=8)problem('MANAGEMENT_CAPACITY',409,'This catalog holds at most eight connections.');
      }
      if((action.action==='test'||action.action==='connect')&&state.operations.some(o=>!o.result&&o.boot_id===this.bootId))problem('CONNECTION_BUSY',409,'A bounded source test is already in progress.');
      if((action.action==='test'||action.action==='connect')&&state.selected_connection_id!==entry!.connection_id)problem('INVALID_INPUT',400,'Select this connection before testing or reconnecting.');
      operation={request_id:action.request_id,payload_sha256:payload,action:action.action,owner_generation:owner.authentication_generation,at:new Date(this.now()).toISOString(),boot_id:this.bootId,epoch:state.epoch,connection_id:entry?.connection_id??null,result:null};state.operations.push(operation);
      if(ticket){state.grants.push({grant_id:ticket.grant_id,ticket_id:ticket.ticket_id,binding_sha256:digest({connection:ticket.connection,expected_repository_id:ticket.expected_repository_id}),phase:'prepared'});await save();
        // This explicit authorized activation is the only manager ledger initializer.
        await privateDir(this.accountingDirectory);const dir=path.join(this.accountingDirectory,ticket.grant_id);await privateDir(dir,true);
        await writePrivate(path.join(dir,'grant.json'),ticket,true);await writePrivate(path.join(dir,'read-budget.json'),initialReadBudget(ticket.connection,ticket.expected_repository_id),true);await this.budget(ticket).ready();
        await this.unchanged(authority,owner,policy,action.action);state.grants.find(g=>g.grant_id===ticket!.grant_id)!.phase='active';
        if(action.action==='create'){const created={connection_id:randomUUID(),profile_id:ticket.profile_id,grant_id:ticket.grant_id,label:action.label,desired_connection:false,last_test:null};state.entries.push(created);operation.connection_id=created.connection_id;if(!state.selected_connection_id)state.selected_connection_id=created.connection_id;}
        else{state.grants.find(g=>g.grant_id===entry!.grant_id)!.phase='retired';entry!.grant_id=ticket.grant_id;entry!.desired_connection=false;entry!.last_test=null;}
      }
      if(action.action==='select'){state.selected_connection_id=entry!.connection_id;for(const e of state.entries)e.desired_connection=false;}
      if(action.action==='disconnect')entry!.desired_connection=false;
      if(action.action==='remove'){state.grants.find(g=>g.grant_id===entry!.grant_id)!.phase='retired';state.entries=state.entries.filter(e=>e!==entry);if(state.selected_connection_id===entry!.connection_id)state.selected_connection_id=null;}
      if(action.action!=='test'&&action.action!=='connect'){state.epoch++;this.invalidate();state.revision++;operation.result={state:'completed',code:null,revision:state.revision};}
      else{ticket=this.ticket(policy,entry!.grant_id);this.validGrant(ticket);await this.grantReady(ticket);}
      await this.unchanged(authority,owner,policy,action.action);await save();
    });
    if(replayed)return {...await this.status(authority),replayed:true,outcome:await this.outcome(authority,action.request_id)};
    if(action.action==='test'||action.action==='connect'){
      const op=operation!,grant=ticket!,abort=new AbortController();this.inflight.set(op.request_id,abort);
      this.readers.get(op.connection_id!)?.reader.invalidate();this.readers.delete(op.connection_id!);
      const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]);let reader:ExplorerReader|undefined,code:string|null=null;
      const check=async()=>{try{await this.unchanged(authority,owner,policy,action.action);const s=await this.store.read(policy);const e=this.entry(s,op.connection_id!);if(s.epoch!==op.epoch||e.grant_id!==grant.grant_id||s.selected_connection_id!==e.connection_id||signal.aborted)problem('CONNECTION_CHANGED',409,'The connection changed during its read.');this.validGrant(grant);}catch(error){this.invalidate();throw error;}};
      try{await check();reader=await this.factory.build(grant,this.budget(grant),check);await reader.refresh({signal});await check();}catch(error){code=safeCode(error);}
      try{await this.store.transaction(policy,async(state,save)=>{
        await this.unchanged(authority,owner,policy,action.action);const receipt=state.operations.find(o=>o.request_id===op.request_id)!;
        const entry=state.entries.find(e=>e.connection_id===op.connection_id);if(state.epoch!==op.epoch||!entry||entry.grant_id!==grant.grant_id||signal.aborted)code='CONNECTION_CHANGED';
        try{this.validGrant(grant);}catch(error){code=safeCode(error);}let install:string|undefined;
        if(entry&&state.epoch===op.epoch){entry.last_test={at:new Date(this.now()).toISOString(),outcome:code?'failed':'passed',code,registry_generation:code?null:reader?.connection().source?.registry_generation??null};if(action.action==='connect')entry.desired_connection=!code;
          if(!code&&entry.desired_connection&&reader)install=entry.connection_id;else reader?.invalidate();}
        state.revision++;receipt.result={state:code?'failed':'completed',code,revision:state.revision};await this.unchanged(authority,owner,policy,action.action);await save();
        // No reader becomes usable before durable receipt/pointer confirmation.
        await this.unchanged(authority,owner,policy,action.action);this.validGrant(grant);
        if(install&&reader&&!signal.aborted)this.readers.set(install,{reader,grant:grant.grant_id,epoch:state.epoch});else reader?.invalidate();
      });}catch(error){reader?.invalidate();this.readers.delete(op.connection_id!);throw error;}finally{this.inflight.delete(op.request_id);}
    }
    return {...await this.status(authority),replayed:false,outcome:await this.outcome(authority,action.request_id)};
  }
  async read<T>(authority:SourceOwnerAuthority,query:(reader:ExplorerReader)=>T|Promise<T>):Promise<T>{
    try{const {owner,policy}=await this.authorize(authority);const state=await this.store.read(policy);const entry=state.entries.find(e=>e.connection_id===state.selected_connection_id),runtime=entry?this.readers.get(entry.connection_id):undefined;
      if(!entry||!entry.desired_connection||!runtime||runtime.grant!==entry.grant_id||runtime.epoch!==state.epoch)problem('CONNECTION_DISCONNECTED',409,'Reconnect the selected source in Settings.');
      const currentRuntime=()=>{if(this.readers.get(entry.connection_id)!==runtime)problem('CONNECTION_CHANGED',409,'The source connection changed.');};
      const ticket=this.ticket(policy,entry.grant_id);this.validGrant(ticket);await this.grantReady(ticket);await this.unchanged(authority,owner,policy);currentRuntime();
      const value=await query(runtime.reader);const current=await this.store.read(policy);await this.unchanged(authority,owner,policy);this.validGrant(ticket);
      if(current.epoch!==state.epoch)problem('CONNECTION_CHANGED',409,'The source selection changed.');
      // Cached projections must still belong to the admitted runtime after every await.
      currentRuntime();return value;}
    catch(error){this.invalidate(!(error instanceof ExplorerError&&error.code==='CONNECTION_DISCONNECTED'));throw error;}
  }
}
