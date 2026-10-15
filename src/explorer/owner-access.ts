import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HostedAccess, type HostedOptions, type HostedReadAccess } from './hosted.js';
import { BootstrapState, type ActiveOwner } from './bootstrap-state.js';
import { digest, secret, optionalPrivate, writePrivate, withLease } from './owner-files.js';
import { problem } from './contract.js';
import { CREDENTIAL_ID, type CredentialTest } from './credential-store.js';
import { ManagedConnections, type SourceOwnerAuthority } from './connection-manager.js';
import { OwnerAgentSettings } from './agent-settings.js';
import type { OwnerAuthentication } from '../auth/host-issuer.js';

const proof = (a:string,b:string) => {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const cookie = (req:IncomingMessage,name:string) => {const parts=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));return parts.length===1&&/^[A-Za-z0-9_-]{43}$/.test(parts[0].slice(name.length+1))?parts[0].slice(name.length+1):undefined;};
const setCookie = (res:ServerResponse,name:string,value:string,seconds:number) => {const old=res.getHeader('set-cookie');res.setHeader('set-cookie',[...(Array.isArray(old)?old:old?[String(old)]:[]),`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`]);};
const requestSchema=z.object({request_id:z.string().uuid(),expected_generation:z.number().int().min(0)}).strict();
const completeSchema=requestSchema.extend({username:z.string().max(32),password:z.string().max(512),key_storage_policy:z.literal('host-bound')}).strict();
const loginSchema=z.object({username:z.string().max(32),password:z.string().max(512)}).strict();
const actionCommon={credential_id:z.literal(CREDENTIAL_ID),revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),request_id:z.string().uuid()};
const actionSchema=z.discriminatedUnion('action',[
  z.object({...actionCommon,action:z.literal('save'),value:z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/)}).strict(),
  z.object({...actionCommon,action:z.literal('remove')}).strict(),z.object({...actionCommon,action:z.literal('test')}).strict(),
]);
type Session={owner_id:string;generation:number;csrf:string;expires:number;idle:number;fresh:number};
export class OwnerAccess implements HostedReadAccess {
  readonly origin:string;
  private boundaryAccess:HostedAccess;
  private sessions=new Map<string,Session>();
  private pre=new Map<string,{csrf:string;expires:number}>();
  private agentSessions=new Set<string>();
  private authorityEpoch=0;
  constructor(readonly state:BootstrapState,options:HostedOptions,private now=Date.now,private credentialOptions:{tester?:(signal:AbortSignal)=>Promise<CredentialTest>;changed?:()=>Promise<void>;invalidated?:()=>void;metadataOnly?:boolean;workspaceMode?:boolean;namespaceMode?:boolean;connections?:ManagedConnections;agents?:OwnerAgentSettings;workspaceConnections?:(req:IncomingMessage,input?:unknown,operation?:string)=>Promise<unknown>}={}) {
    if(options.accessKeySha256)throw new Error('Owner and shared-reader modes cannot be mixed.');
    this.boundaryAccess=new HostedAccess(options);this.origin=this.boundaryAccess.origin;
  }
  private activeOwner(requireSeal=true){return this.state.owner(requireSeal,!this.credentialOptions.metadataOnly);}
  boundary(req:IncomingMessage){this.boundaryAccess.boundary(req);}
  private invalidateAgents(id?:string){if(id===undefined||this.agentSessions.delete(id)){this.credentialOptions.agents?.changed();this.agentSessions.clear();}}
  private invalidateAuthority(){this.authorityEpoch++;this.credentialOptions.invalidated?.();}
  clear(){this.invalidateAuthority();this.invalidateAgents();this.sessions.clear();this.pre.clear();}
  private prune(){for(const [id,s]of this.sessions)if(this.now()>=s.expires||this.now()>=s.idle){this.invalidateAgents(id);this.sessions.delete(id);}for(const [id,s]of this.pre)if(this.now()>=s.expires)this.pre.delete(id);}
  private preSession(req:IncomingMessage,res?:ServerResponse){
    this.prune();let id=cookie(req,'__Host-strata_pre'),current=id?this.pre.get(id):undefined;
    if(!current&&res){if(this.pre.size>=64)problem('LOGIN_LIMIT',429,'Sign-in request capacity is temporarily full.');const next=secret();id=next;current={csrf:secret(),expires:this.now()+10*60_000};this.pre.set(next,current);setCookie(res,'__Host-strata_pre',next,600);}
    return current;
  }
  private async current(req:IncomingMessage,touch=false){
    this.prune();const id=cookie(req,'__Host-strata_owner'),session=id?this.sessions.get(id):undefined;
    if(!session)return undefined;
    const owner=await this.activeOwner();if(!owner||owner.owner_id!==session.owner_id||owner.authentication_generation!==session.generation){this.invalidateAgents(id!);this.sessions.delete(id!);return undefined;}
    if(touch)session.idle=Math.min(session.expires,this.now()+15*60_000);return {id:id!,session,owner};
  }
  async require(req:IncomingMessage){const current=await this.current(req,true);if(!current)problem('OWNER_SESSION_REQUIRED',401,'Sign in to Studio again.');if(req.method==='POST'&&!proof(String(req.headers['x-studio-csrf']??''),current.session.csrf))problem('LOCAL_ORIGIN',403,'Use the current Studio request token.');}
  async status(req:IncomingMessage,touch=false){try{const current=await this.current(req,touch);const owner=await this.activeOwner(false);return {mode:'hosted-owner',...(this.credentialOptions.workspaceMode?{workspace:true,...(this.credentialOptions.namespaceMode?{namespace:true}:{})}:{}),configured:!!owner,authenticated:!!current,csrf:current?.session.csrf??null,...(current?{authentication_generation:current.owner.authentication_generation,fresh_until:new Date(current.session.fresh+5*60_000).toISOString()}:{} )};}catch{return {mode:'hosted-owner',...(this.credentialOptions.workspaceMode?{workspace:true,...(this.credentialOptions.namespaceMode?{namespace:true}:{})}:{}),configured:false,authenticated:false,csrf:null};}}
  private issue(req:IncomingMessage,res:ServerResponse,owner:ActiveOwner,old?:string){
    this.invalidateAuthority();
    this.prune();const previous=old??cookie(req,'__Host-strata_owner');if(previous){this.invalidateAgents(previous);this.sessions.delete(previous);}
    if(this.sessions.size>=4)problem('LOGIN_LIMIT',429,'Studio has reached its owner session limit.');
    const id=secret(),now=this.now(),session={owner_id:owner.owner_id,generation:owner.authentication_generation,csrf:secret(),expires:now+60*60_000,idle:now+15*60_000,fresh:now};this.sessions.set(id,session);setCookie(res,'__Host-strata_owner',id,3600);return {mode:'hosted-owner',...(this.credentialOptions.workspaceMode?{workspace:true,...(this.credentialOptions.namespaceMode?{namespace:true}:{})}:{}),configured:true,authenticated:true,csrf:session.csrf,authentication_generation:owner.authentication_generation,fresh_until:new Date(now+5*60_000).toISOString()};
  }
  private async verifyLogin(username:string,password:string,owner:ActiveOwner){
    // Persistent installation-wide limit survives restarts, never uses guessed client IPs.
    const file=path.join(this.state.config.state_directory,'login-limit.json');
    const schema=z.object({format:z.literal('strata-owner-login-limit/1'),attempts:z.array(z.object({id:z.string(),time:z.number()}).strict()).max(5)}).strict(),attemptId=secret();
    await withLease(this.state.config.state_directory,async()=>{
      const old=await optionalPrivate(file),attempts=old?schema.parse(old).attempts.filter(t=>this.now()-t.time<60_000):[];
      if(attempts.length>=5)problem('LOGIN_LIMIT',429,'Wait before trying Studio sign-in again.');attempts.push({id:attemptId,time:this.now()});await writePrivate(file,{format:'strata-owner-login-limit/1',attempts});
    });
    const verified=await this.state.passwords.verify(password,owner.verifier);
    if(!verified||username.toLowerCase()!==owner.username)problem('OWNER_SESSION_REQUIRED',401,'Studio sign-in was not accepted.');
    const current=await this.activeOwner();if(!current||current.authentication_generation!==owner.authentication_generation)problem('OWNER_SESSION_REQUIRED',401,'Owner authentication changed. Sign in again.');
    await withLease(this.state.config.state_directory,async()=>{const old=schema.parse(await optionalPrivate(file));await writePrivate(file,{...old,attempts:old.attempts.filter(t=>t.id!==attemptId)});});
  }
  async login(req:IncomingMessage,res:ServerResponse,input:unknown){
    const pre=this.preSession(req);if(!pre||!proof(String(req.headers['x-studio-csrf']??''),pre.csrf))problem('LOCAL_ORIGIN',403,'Refresh the sign-in form before continuing.');
    const parsed=loginSchema.safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Sign-in requires a bounded name and password.');
    const owner=await this.activeOwner();if(!owner)problem('SETUP_DISABLED',403,'Complete owner setup before sign-in.');
    await this.verifyLogin(parsed.data.username,parsed.data.password,owner);return this.issue(req,res,owner);
  }
  async logout(req:IncomingMessage,res:ServerResponse){await this.require(req);this.invalidateAuthority();const id=cookie(req,'__Host-strata_owner');if(id){this.invalidateAgents(id);this.sessions.delete(id);}setCookie(res,'__Host-strata_owner','',0);return {authenticated:false};}
  async actorAuthentication(req:IncomingMessage,fresh=true):Promise<OwnerAuthentication>{
    await this.require(req);
    const current=fresh?await this.authorize(req):await this.current(req),epoch=this.authorityEpoch;
    if(!current)problem('OWNER_SESSION_REQUIRED',401,'Sign in to Studio again.');
    const assertLive=()=>{const session=this.sessions.get(current.id);if(this.authorityEpoch!==epoch||session!==current.session||this.now()>=session.expires||this.now()>=session.idle)problem('OWNER_SESSION_REQUIRED',401,'The parent owner authentication is no longer live.');};
    assertLive();
    return {installation_id:current.owner.manifest.installation_id,owner_id:current.owner.owner_id,session_id:current.id,
      authentication_generation:current.owner.authentication_generation,expires_at:new Date(current.session.expires).toISOString(),assertLive,
      refresh:async()=>{const fresh=await this.current(req);assertLive();if(!fresh||fresh.id!==current.id||fresh.owner.authentication_generation!==current.owner.authentication_generation)problem('OWNER_SESSION_REQUIRED',401,'The parent owner authentication changed.');}};
  }
  get managedConnections(){return this.credentialOptions.connections;}
  sourceAuthority(req:IncomingMessage):SourceOwnerAuthority{return {current:async fresh=>{
    await this.require(req);const current=fresh?await this.authorize(req):await this.current(req);if(!current)problem('OWNER_SESSION_REQUIRED',401,'Sign in to Studio again.');
    return {installation_id:current.owner.manifest.installation_id,owner_id:current.owner.owner_id,authentication_generation:current.owner.authentication_generation,fresh:this.now()-current.session.fresh<5*60_000};
  }};}
  async agents(req:IncomingMessage,input?:unknown,operation?:string,signal?:AbortSignal){
    await this.require(req);const settings=this.credentialOptions.agents??new OwnerAgentSettings();
    // The lifecycle projects OWNER_REAUTH_REQUIRED from verified freshness;
    // don't convert the host's thrown fresh-auth refusal into missing identity.
    const authority={current:()=>this.sourceAuthority(req).current(false)};
    if(operation)return settings.outcome(authority,operation);
    if(req.method!=='POST')return settings.status(authority);
    const probe=!!this.credentialOptions.agents&&!!input&&typeof input==='object'&&'action'in input&&['test','connect','retry'].includes(String(input.action));
    const current=probe?await this.current(req):undefined,wasTracked=current?this.agentSessions.has(current.id):false;
    if(current)this.agentSessions.add(current.id);
    const result=await settings.action(authority,input,signal);
    // Exact completed replay loads no secret/transport and cannot adopt runtime
    // from another session. A metadata-only CLI close must not invalidate it.
    if(result.replayed&&current&&!wasTracked)this.agentSessions.delete(current.id);
    return result;
  }
  async connections(req:IncomingMessage,input?:unknown,operation?:string){
    await this.require(req);const manager=this.managedConnections;
    if(this.credentialOptions.workspaceConnections)return this.credentialOptions.workspaceConnections(req,input,operation);
    if(!manager){if(req.method!=='GET')problem('SOURCE_MANAGEMENT_REQUIRED',403,'The host must configure approved sources and finite read grants.');return {format:'strata-studio-owner-connections/1',mode:'legacy',revision:null,selected_connection_id:null,management:{state:'unavailable',code:'SOURCE_MANAGEMENT_REQUIRED'},profiles:[],tickets:[],connections:[],operations:[]};}
    const authority=this.sourceAuthority(req);return operation?manager.outcome(authority,operation):req.method==='POST'?manager.action(authority,input):manager.status(authority);
  }
  private async authorize(req:IncomingMessage,freshMs=5*60_000){await this.require(req);const current=await this.current(req);if(!current)problem('OWNER_SESSION_REQUIRED',401,'Sign in to Studio again.');if(this.now()-current.session.fresh>=freshMs)problem('OWNER_REAUTH_REQUIRED',403,'Confirm your password before managing credentials.');return current;}
  async credentials(req:IncomingMessage,input?:unknown){
    await this.require(req);const current=await this.current(req);if(!current)problem('OWNER_SESSION_REQUIRED',401,'Sign in to Studio again.');
    let outcome:{replayed:boolean;test?:CredentialTest}|undefined;
    if(req.method==='POST'){
      const parsed=actionSchema.safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Credential settings require one bounded action, current revision and request ID.');
      await this.authorize(req);
      if(parsed.data.action!=='test')this.invalidateAuthority();
      const manager=this.managedConnections;
      const tester=manager?async(signal:AbortSignal)=>{
        if(signal.aborted)problem('SOURCE_UNAVAILABLE',503,'The credential test was interrupted.');const status=await manager.status(this.sourceAuthority(req));if(status.revision===null||!status.selected_connection_id)problem('CONNECTION_NOT_READY',409,'Select an approved connection in Settings before testing.');
        const result=await manager.action(this.sourceAuthority(req),{action:'test',connection_id:status.selected_connection_id,revision:status.revision,request_id:parsed.data.request_id});
        return {outcome:result.outcome.code==='SOURCE_AUTH'?'denied' as const:result.outcome.state==='completed'?'passed' as const:'error' as const,verified_at:new Date(this.now()).toISOString()};
      }:this.credentialOptions.tester;
      outcome=await this.state.credentialAction(current.owner,async()=>{await this.authorize(req);},async store=>store.action(parsed.data,tester,async()=>{await this.authorize(req);}));
      if(parsed.data.action!=='test'){await this.managedConnections?.changed();await this.credentialOptions.changed?.();}
    }
    const metadata=await this.state.store(current.owner.manifest).status();
    return {format:'strata-studio-owner-credentials/1',state:'ready',...metadata,management:{state:'required',authorization:'owner-session',reauth_required:this.now()-current.session.fresh>=5*60_000},capabilities:{save:true,remove:true,test:!!(this.credentialOptions.tester||this.managedConnections)&&metadata.credentials[0].configured},...(outcome?{replayed:outcome.replayed,...(outcome.test?{test:outcome.test}:{})}:{})};
  }
  async handle(req:IncomingMessage,res:ServerResponse,pathname:string,input?:unknown){
    if(pathname==='/studio/session'||pathname==='/studio/owner/session'){
      const status=await this.status(req);return {...status,csrf:status.csrf??this.preSession(req,res)!.csrf};
    }
    if(pathname==='/studio/owner/login')return this.login(req,res,input);
    if(pathname==='/studio/owner/logout')return this.logout(req,res);
    if(pathname==='/studio/owner/reauth'){
      await this.require(req);const parsed=z.object({password:z.string().max(512)}).strict().safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Enter your current password.');
      const current=await this.current(req);if(!current)problem('OWNER_SESSION_REQUIRED',401,'Sign in to Studio again.');await this.verifyLogin(current.owner.username,parsed.data.password,current.owner);this.invalidateAgents(current.id);return this.issue(req,res,current.owner,current.id);
    }
    if(pathname==='/studio/owner/password'){
      const current=await this.authorize(req,60_000);const parsed=z.object({request_id:z.string().uuid(),expected_generation:z.number().int().min(1),new_password:z.string().max(512)}).strict().safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Password change needs a current generation, request ID and new password.');
      if(current.owner.authentication_generation!==parsed.data.expected_generation)problem('SETUP_CHANGED',409,'Authentication changed. Sign in again.');
      this.invalidateAuthority();
      const generation=await this.state.rotate(current.owner,parsed.data.new_password,parsed.data.request_id,async()=>{await this.authorize(req,60_000);});this.clear();setCookie(res,'__Host-strata_owner','',0);return {changed:true,authentication_generation:generation};
    }
    const setupCookie=cookie(req,'__Host-strata_setup'),cookieDigest=setupCookie?digest(setupCookie):undefined;
    if(pathname==='/studio/setup'||pathname==='/studio/setup/outcome'){
      const status=await this.state.status(cookieDigest);return {...status,csrf:status.csrf??this.preSession(req,res)!.csrf};
    }
    if(pathname==='/studio/setup/request'){
      const pre=this.preSession(req);if(!pre||!proof(String(req.headers['x-studio-csrf']??''),pre.csrf))problem('LOCAL_ORIGIN',403,'Refresh setup before continuing.');
      const parsed=requestSchema.safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Setup request needs a request ID and current generation.');
      const existing=setupCookie?await this.state.pending(digest(setupCookie)):undefined;
      if(existing&&existing.creation_id===parsed.data.request_id&&existing.pre_cookie_sha256===digest(cookie(req,'__Host-strata_pre')!))return this.state.status(digest(setupCookie!));
      const nextCookie=secret();await this.state.request(digest(nextCookie),parsed.data.expected_generation,parsed.data.request_id,digest(cookie(req,'__Host-strata_pre')!));setCookie(res,'__Host-strata_setup',nextCookie,900);return this.state.status(digest(nextCookie));
    }
    if(!cookieDigest)problem('SETUP_NOT_APPROVED',403,'Return to the original browser setup request.');
    const pending=await this.state.pending(cookieDigest);if(!pending||!proof(String(req.headers['x-studio-csrf']??''),pending.csrf))problem('LOCAL_ORIGIN',403,'Setup requires its original browser and request token.');
    if(pathname==='/studio/setup/cancel'){
      const parsed=requestSchema.safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Cancellation requires its current setup generation.');await this.state.cancel(cookieDigest,parsed.data.expected_generation);setCookie(res,'__Host-strata_setup','',0);return {cancelled:true};
    }
    if(pathname==='/studio/setup/complete'){
      const parsed=completeSchema.safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Owner setup requires bounded sign-in fields and explicit host-bound storage acknowledgement.');res.statusCode=202;return this.state.complete(cookieDigest,parsed.data);
    }
    if(pathname==='/studio/setup/recover'){
      const parsed=z.object({request_id:z.string().uuid(),expected_generation:z.number().int().min(0),expected_authentication_generation:z.number().int().min(1),new_password:z.string().max(512)}).strict().safeParse(input);
      if(!parsed.success)problem('INVALID_INPUT',400,'Recovery requires exact current generations and a new password.');
      const result=await this.state.recoverPassword(cookieDigest,parsed.data);this.clear();return result;
    }
    problem('NOT_FOUND',404,'Owner route is unavailable.');
  }
}
