import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BLOCK_MODEL, canonical, digest, fail, parse } from '../model.js';
import type { Engine } from '../core.js';
import { checkAssignment, type AuthorityIssuer, type SecurityContext } from '../security.js';
import { WORKFLOW_READS } from '../workflow.js';
import { Mediation } from '../mediation.js';
import { lifetimeSchema, lifetimeActive } from '../explorer/workspace-policy.js';
import { MODEL } from '../model.js';
import { sourcePath } from '../source-binding.js';
import { revalidationAuthSchema, revalidationRequestDigest, type RevalidationContext, type RevalidationAuthority } from '../revalidation.js';
import { PROFILE_OPERATIONS } from '../build-records.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION } from '../build-operations.js';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), hash=z.string().regex(/^[a-f0-9]{64}$/), keys=z.array(id).max(500);
export const accountStoreSchema=z.object({format:z.literal('strata-host-accounts/1'),generation:z.number().int().positive(),accounts:z.array(z.object({account_id:id,principal_id:id,principal_kind:z.enum(['person','agent']),active:z.boolean(),credential_epoch:z.number().int().positive(),key_sha256:hash}).strict()).max(100)}).strict();
const LEGACY_HOST_OPERATIONS=[...WORKFLOW_READS,'inspect','status','diff','conflicts','context.show','context.use','init','layer.create','layer.revise','layer.restore','layer.publish','content.review','compose','mediation.install','mediation.prepare','mediation.respond','reports.dispose','conflicts.report','resolve','approve','materialize','realization.register','evidence.run','criterion.review','validate','release'] as const;
export const HOST_OPERATIONS=LEGACY_HOST_OPERATIONS;
export const REVALIDATION_HOST_OPERATIONS=[...HOST_OPERATIONS,'drift.revalidate','revalidation.run','revalidation.criterion-review'] as const;
export const policyStoreSchema=z.object({format:z.literal('strata-host-policy/1'),project_id:id,generation:z.number().int().positive(),grants:z.array(z.object({grant_id:id,principal_id:id,operations:z.array(z.enum(LEGACY_HOST_OPERATIONS)).max(50),layer_ids:keys.nullable(),write_block_ids:keys,create_under_block_ids:keys,approvals:z.array(z.enum(['resolution','scope','guardian','release'])).max(4),profiles:z.array(z.string().min(1).max(128)).max(8),expires_at:z.string().datetime()}).strict()).max(100)}).strict();
export const accountStoreV2Schema=z.object({format:z.literal('strata-host-accounts/2'),generation:z.number().int().positive(),accounts:z.array(z.object({account_id:id,principal_id:id,principal_kind:z.enum(['person','agent']),active:z.boolean(),credential_epoch:z.number().int().positive(),credential:z.discriminatedUnion('method',[
  z.object({method:z.literal('key'),key_sha256:hash}).strict(),
  z.object({method:z.literal('installation-owner'),installation_id:z.string().uuid(),owner_id:z.string().uuid()}).strict(),
])}).strict()).max(100)}).strict();
export const policyStoreV2Schema=z.object({format:z.literal('strata-host-policy/2'),project_id:id,generation:z.number().int().positive(),grants:z.array(policyStoreSchema.shape.grants.element.omit({expires_at:true}).extend({lifetime:lifetimeSchema}).strict()).max(100)}).strict();
const accountsSchema=z.union([accountStoreSchema,accountStoreV2Schema]);
const root=z.string().min(1).max(240).refine(v=>{try{sourcePath(v,true);return true;}catch{return false;}});
export const revalidationGrantSchema=z.object({repository_ids:keys,read_roots:z.array(root).max(64),inventory_roots:z.array(root).max(64),checker_ids:z.array(z.string().min(1).max(128)).max(16),block_ids:keys,review_criterion_refs:z.array(z.string().min(1).max(4096)).max(256)}).strict().refine(scope=>Object.values(scope).every(values=>new Set(values).size===values.length),'Revalidation scopes must have unique members.');
export const policyStoreV3Schema=policyStoreV2Schema.extend({format:z.literal('strata-host-policy/3'),grants:z.array(policyStoreV2Schema.shape.grants.element.extend({operations:z.array(z.enum(REVALIDATION_HOST_OPERATIONS)).max(50),revalidation:revalidationGrantSchema.optional()}).strict()).max(100)}).strict();
// New operation authority is opt-in and repository-scoped in policy /4. Older
// policies and owner mappings acquire no profile/contract grants implicitly.
export const PROFILE_HOST_OPERATIONS = [...REVALIDATION_HOST_OPERATIONS, ...PROFILE_OPERATIONS, ...BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION] as const;
export const policyStoreV4Schema=policyStoreV3Schema.extend({format:z.literal('strata-host-policy/4'),grants:z.array(policyStoreV3Schema.shape.grants.element.extend({
  operations:z.array(z.enum(PROFILE_HOST_OPERATIONS)).max(64),build_repository_ids:keys.optional()
}).strict()).max(100)}).strict();
const policySchema=z.union([policyStoreSchema,policyStoreV2Schema,policyStoreV3Schema,policyStoreV4Schema]);
export interface OwnerAuthentication {
  installation_id:string;owner_id:string;session_id:string;authentication_generation:number;expires_at:string;
  assertLive():void;refresh():Promise<void>;
}
type Accounts=z.infer<typeof accountsSchema>;type Policy=z.infer<typeof policySchema>;
type Session={account:string;epoch:number;expires:number;parent?:OwnerAuthentication};
type Grant=Policy['grants'][number];
const grantActive=(g:Grant,now:number)=>'expires_at'in g?Date.parse(g.expires_at)>now:lifetimeActive(g.lifetime,now);
const accountCredential=(a:Accounts['accounts'][number])=>'key_sha256'in a?{method:'key' as const,key_sha256:a.key_sha256}:a.credential;
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
// Real named credentials, independently provisioned operations and immutable
// baseline authority. It cannot resolve public fixture selectors or reader keys.
export class HostIssuer implements AuthorityIssuer {
  private accounts:Accounts;private policy:Policy;private sessions=new Map<string,Session>();
  constructor(accounts:unknown,policy:unknown,private now=Date.now,private ownerAuthenticate?:(input:unknown)=>Promise<OwnerAuthentication>){this.accounts=parse(accountsSchema,accounts);this.policy=parse(policySchema,policy);this.check();}
  get projectId(){return this.policy.project_id;}
  get configured(){return this.accounts.accounts.some(a=>a.active);}
  time(){return this.now();}
  accessBinding(){return digest(this.policy);}
  private check(){for(const [values,field]of [[this.accounts.accounts,'account_id'],[this.accounts.accounts,'principal_id'],[this.policy.grants,'grant_id'],[this.policy.grants,'principal_id']] as const){if(new Set(values.map((v:any)=>v[field])).size!==values.length)fail('INVALID_POLICY',2,'Host accounts and grants must have unique stable bindings.');}for(const g of this.policy.grants){if(!this.accounts.accounts.some(a=>a.principal_id===g.principal_id))fail('INVALID_POLICY',2,'Grant names an unconfigured account.');if(new Set(g.operations).size!==g.operations.length||new Set(g.write_block_ids).size!==g.write_block_ids.length)fail('INVALID_POLICY',2,'Grant scopes contain duplicate members.');}}
  reload(accounts:unknown,policy:unknown){const a=parse(accountsSchema,accounts),p=parse(policySchema,policy);if(p.project_id!==this.projectId||a.generation<this.accounts.generation||p.generation<this.policy.generation||(a.generation===this.accounts.generation&&canonical(a)!==canonical(this.accounts))||(p.generation===this.policy.generation&&canonical(p)!==canonical(this.policy)))fail('POLICY_ROLLBACK',4,'Host store generations cannot change in place or roll back.');for(const old of this.accounts.accounts){const next=a.accounts.find(x=>x.account_id===old.account_id);if(!next)fail('INVALID_POLICY',4,'Retain disabled account tombstones so stable identities cannot be reassigned.');if(next&&(next.principal_id!==old.principal_id||next.principal_kind!==old.principal_kind||next.credential_epoch<old.credential_epoch||(canonical(accountCredential(next))!==canonical(accountCredential(old))&&next.credential_epoch===old.credential_epoch)))fail('INVALID_POLICY',4,'Account identity is immutable and changed keys require a new credential epoch.');}const oldA=this.accounts,oldP=this.policy;this.accounts=a;this.policy=p;try{this.check();}catch(e){this.accounts=oldA;this.policy=oldP;throw e;}for(const [token,session]of this.sessions){const account=this.accounts.accounts.find(a=>a.account_id===session.account),grant=account&&this.policy.grants.find(g=>g.principal_id===account.principal_id);if(!account?.active||account.credential_epoch!==session.epoch||session.expires<=this.now()||!grant||!grantActive(grant,this.now()))this.sessions.delete(token);}}
  login(accountId:unknown,key:unknown){if(typeof accountId!=='string'||typeof key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(key)||Buffer.from(key,'base64url').toString('base64url')!==key)fail('AUTHENTICATION_REQUIRED',4,'Host sign-in was not accepted.');const hash=createHash('sha256').update(key).digest('hex'),account=this.accounts.accounts.find(a=>a.account_id===accountId);if(!equal(hash,(account&&accountCredential(account).method==='key'?(accountCredential(account) as {key_sha256:string}).key_sha256:undefined)??'0'.repeat(64))||!account?.active)fail('AUTHENTICATION_REQUIRED',4,'Host sign-in was not accepted.');for(const [key,s]of this.sessions)if(s.expires<=this.now())this.sessions.delete(key);if(this.sessions.size>=8)fail('SESSION_LIMIT',4,'Host session capacity reached.');const token=Buffer.from(randomBytes(32)).toString('base64url');this.sessions.set(token,{account:account.account_id,epoch:account.credential_epoch,expires:this.now()+30*60*1000});return token;}
  logout(token:string){this.sessions.delete(token);}
  /** Read-only owner exchange validation shared with inactive preparation. This
   * checks configuration and grant lifetime; it authenticates no parent or session.
   */
  ownerBinding(installation_id:string,owner_id:string){
    const matches=this.accounts.accounts.filter(a=>{const c=accountCredential(a);return a.active&&a.principal_kind==='person'&&c.method==='installation-owner'&&c.installation_id===installation_id&&c.owner_id===owner_id;});
    if(matches.length!==1)fail('AUTHENTICATION_REQUIRED',4,'No exact owner-to-actor binding is assigned.');
    const account=matches[0],grant=this.policy.grants.find(g=>g.principal_id===account.principal_id);
    if(!grant||!grantActive(grant,this.now()))fail('ACCESS_REVOKED',4,'No active author grant is assigned.');
    return {account_id:account.account_id,principal_id:account.principal_id,grant_id:grant.grant_id};
  }
  async loginOwner(input:unknown){
    if(!this.ownerAuthenticate)fail('AUTHENTICATION_REQUIRED',4,'Owner actor exchange is unconfigured.');
    const parent=await this.ownerAuthenticate(input);parent.assertLive();
    const binding=this.ownerBinding(parent.installation_id,parent.owner_id),account=this.accounts.accounts.find(a=>a.account_id===binding.account_id)!;
    for(const [token,s]of this.sessions)if(s.expires<=this.now())this.sessions.delete(token);
    if(this.sessions.size>=8)fail('SESSION_LIMIT',4,'Host session capacity reached.');
    const expires=Math.min(this.now()+30*60_000,Date.parse(parent.expires_at));
    if(!Number.isFinite(expires)||expires<=this.now())fail('AUTHENTICATION_REQUIRED',4,'The parent owner session expired.');
    const token=Buffer.from(randomBytes(32)).toString('base64url');this.sessions.set(token,{account:account.account_id,epoch:account.credential_epoch,expires,parent});return token;
  }
  async refreshSession(token:string){const s=this.sessions.get(token);if(!s)fail('AUTHENTICATION_REQUIRED',4,'Host authentication is unavailable.');await s.parent?.refresh();this.resolve(token);}
  async refreshContext(context:SecurityContext){const token=[...this.sessions.keys()].find(t=>digest(t)===context.authentication_id);if(!token)fail('AUTHENTICATION_REQUIRED',4,'The host context is no longer live.');await this.refreshSession(token);this.assertLive(context);}
  assertParentCookie(token:string,ownerCookie:string){const s=this.sessions.get(token);if(s?.parent&&s.parent.session_id!==ownerCookie)fail('AUTHENTICATION_REQUIRED',4,'Actor authentication requires its exact parent owner session.');}
  clear(){this.sessions.clear();}
  resolve(token:string,project=this.projectId):SecurityContext {const s=this.sessions.get(token),a=s&&this.accounts.accounts.find(a=>a.account_id===s.account);if(!s||!a?.active||s.epoch!==a.credential_epoch||s.expires<=this.now())fail('AUTHENTICATION_REQUIRED',4,'Host session is missing, expired, disabled or rotated.');s.parent?.assertLive();if(project!==this.projectId)fail('PROJECT_FORBIDDEN',4,'Host session is bound to one configured project.');const g=this.policy.grants.find(g=>g.principal_id===a.principal_id);if(!g||!grantActive(g,this.now()))fail('ACCESS_REVOKED',4,'No active operation grant is assigned to this account.');return {trust_mode:'host_authenticated',principal_id:a.principal_id,principal_kind:a.principal_kind,account_id:a.account_id,credential_epoch:a.credential_epoch,authentication_id:digest(token),tenant_id:'host',project_id:project,allowed_operations:[...g.operations],layer_ids:g.layer_ids,write_block_ids:g.write_block_ids,create_under_block_ids:g.create_under_block_ids,grant_id:g.grant_id,delegator_id:null,expires_at:'expires_at'in g?g.expires_at:new Date(Math.min(s.expires,g.lifetime.mode==='until'?Date.parse(g.lifetime.expires_at):s.expires)).toISOString(),policy_version:'host-policy/'+this.policy.generation+'/'+digest(this.policy),authority_ref:'pinned-baseline'};}
  assertLive(c:SecurityContext){const token=[...this.sessions.keys()].find(t=>digest(t)===c.authentication_id);if(!token)fail('AUTHENTICATION_REQUIRED',4,'The request authentication is no longer live.');const fresh=this.resolve(token,c.project_id);if(fresh.policy_version!==c.policy_version)fail('STALE_POLICY',5,'Host policy changed before dispatch or publication.');if(canonical(fresh)!==canonical(c))fail('OWNER_FORBIDDEN',4,'Security context must come from the configured host authenticator.');}

  receiptLive(principal:string,epoch:number){return this.accounts.accounts.some(a=>a.principal_id===principal&&a.active&&a.credential_epoch===epoch);}
  active(principal:string){return this.accounts.accounts.some(a=>a.principal_id===principal&&a.active)&&this.policy.grants.some(g=>g.principal_id===principal&&grantActive(g,this.now()));}
  permitsApproval(c:SecurityContext,kind:string){this.assertLive(c);return this.policy.grants.find(g=>g.grant_id===c.grant_id)?.approvals.includes(kind as any)??false;}
  narrowSelectionExecutor(){return false;}
  retainedActive(principal:string,operation:string,kind?:string){const grant=this.policy.grants.find(g=>g.principal_id===principal);return this.active(principal)&&!!grant&&grant.operations.includes(operation as any)&&(!kind||grant.approvals.includes(kind as any));}
  bindMediation(engine:Engine,c:SecurityContext){engine.retainedAuthority=(p,o,k,epoch)=>this.retainedActive(p,o,k)&&(epoch===undefined||this.receiptLive(p,epoch));if(engine.modelVersion()===BLOCK_MODEL)engine.mediation=new Mediation(engine,this,c,{generation:this.policy.generation,policies:[],grants:[]});}
  authorize(c:SecurityContext,command:string,input:any,engine?:Engine){this.assertLive(c);if(command.startsWith('revalidation.'))fail('UNSUPPORTED_CAPABILITY',8,'Internal revalidation actions are not public endpoints.');if(command.startsWith('revalidation.'))fail('UNSUPPORTED_CAPABILITY',8,'Internal revalidation actions are not public endpoints.');if(!PROFILE_HOST_OPERATIONS.includes(command as any)||!c.allowed_operations.includes(command))fail('OPERATION_FORBIDDEN',4,'Account has no grant for this operation.');if(engine){this.bindMediation(engine,c);if(engine.modelVersion()!==BLOCK_MODEL&&['init','content.review','resolve','approve','validate','release','mediation.prepare','mediation.respond','reports.dispose','evidence.run','criterion.review'].includes(command))fail('UNSUPPORTED_HOSTED_AUTHORITY',8,'Authenticated authority/evidence require a fresh explicit v0.3 project.');}const g=this.policy.grants.find(g=>g.grant_id===c.grant_id)!;if(['materialize','evidence.run'].includes(command)&&input.profile&&!g.profiles.includes(input.profile))fail('PROFILE_FORBIDDEN',4,'Account is not assigned this finite profile.');if(engine&&['release','resolve'].includes(command)){const refs=command==='resolve'?input.record?.approvals??[]:input.approvals??[];for(const ref of refs){const a=engine.read(ref,'approval');const auth=engine.read(a.auth_receipt,'auth-receipt');if(!this.receiptLive(a.principal,auth.credential_epoch)||!this.retainedActive(a.principal,a.kind==='resolution'?'mediation.respond':'approve',a.kind))fail('ENDORSEMENT_REVOKED',6,'An endorsement no longer has its required active operation/kind grant.');}}checkAssignment(c,command,input,engine,{principal:c.principal_id,operations:g.operations,approvals:g.approvals},this);}
  assertRepository(c?:SecurityContext,command='',repository='',paths:string[]=[]){
    if(!c)fail('UNSUPPORTED_SOURCE_BACKEND',8,'Hosted repository writes are unconfigured.');
    this.assertLive(c); const grant=this.policy.grants.find(g=>g.grant_id===c.grant_id);
    if(PROFILE_OPERATIONS.includes(command as any) || BUILD_OPERATIONS.includes(command as any) || command === BUILD_RECOVERY_OPERATION) {
      if(!c.allowed_operations.includes(command)||!grant||!('build_repository_ids'in grant)||!grant.build_repository_ids?.includes(repository)||paths.length)
        fail('REPOSITORY_FORBIDDEN',4,'Profile operation requires an explicitly assigned repository scope.');
      return;
    }
    fail('UNSUPPORTED_SOURCE_BACKEND',8,'Hosted repository writes are unconfigured.');
  }
  assertGitEvidence(){fail('UNSUPPORTED_SOURCE_BACKEND',8,'Hosted repository execution is unconfigured.');}
  revalidationConfigured(c:SecurityContext) {
    this.assertLive(c);const g=this.policy.grants.find(g=>g.grant_id===c.grant_id);
    return ['strata-host-policy/3','strata-host-policy/4'].includes(this.policy.format)&&!!g&&'revalidation'in g&&!!g.revalidation&&['drift.revalidate','revalidation.run'].every(op=>g.operations.includes(op as any));
  }
  assertRevalidationPath(c:SecurityContext,repo:string,name:string,inventory=false) {
    this.assertLive(c);const g=this.policy.grants.find(g=>g.grant_id===c.grant_id);
    const scope=g&&'revalidation'in g?g.revalidation:undefined;
    sourcePath(name,inventory);
    if(!scope?.repository_ids.includes(repo))fail('REPOSITORY_FORBIDDEN',4,'No explicit revalidation repository scope.');
    const roots=inventory?scope.inventory_roots:scope.read_roots;
    if(!roots.some(root=>root==='.'||root===name||name.startsWith(root+'/')))fail('REVALIDATION_PATH_FORBIDDEN',4,'Read or inventory exceeds the revalidation scope.');
  }
  revalidationAuthority(c:SecurityContext,context:RevalidationContext,repositoryDigest:string):RevalidationAuthority {
    this.assertLive(c);
    if(!this.revalidationConfigured(c))fail('REVALIDATION_AUTHORITY_REQUIRED',4,'Explicit policy /3 named revalidation grants are required.');
    const g=this.policy.grants.find(g=>g.grant_id===c.grant_id)!;
    const scope='revalidation'in g?g.revalidation:undefined;
    if(!scope||context.snapshot.model_version!==MODEL||context.review.project_id!==c.project_id)fail('REVALIDATION_UNSUPPORTED',8,'Explicit v0.1 local revalidation is required.');
    if(context.review.reviewer!==c.principal_id||!context.snapshot.authorities.scopes.some(s=>s.block===context.responsible&&s.selectors.includes(c.principal_id)))fail('AUTHORITY_FORBIDDEN',4,'The named account must still be the approved scope selector/reviewer.');
    const blocks=[...new Set(context.source.scope.items.map(i=>i.split('/')[0]))];
    if(blocks.some(b=>!scope.block_ids.includes(b)||!c.write_block_ids?.includes(b)))fail('BLOCK_SCOPE_FORBIDDEN',4,'Selected Blocks are not assigned for revalidation.');
    if(!scope.checker_ids.includes(context.plan.checker.id))fail('EVIDENCE_PRODUCER_FORBIDDEN',4,'Checker is not assigned for revalidation.');
    for(const name of context.source.scope.paths)this.assertRevalidationPath(c,context.review.repo_id,name);
    for(const name of context.source.scope.watch_roots)this.assertRevalidationPath(c,context.review.repo_id,name,true);
    if(context.request.criterion_reviews.length&&(!g.operations.includes('revalidation.criterion-review')||context.request.criterion_reviews.some(r=>!scope.review_criterion_refs.includes(r.criterion_ref))))fail('CRITERION_REVIEW_FORBIDDEN',4,'Explicit review criterion/action is not assigned.');
    const token=[...this.sessions.keys()].find(t=>digest(t)===c.authentication_id)!,session=this.sessions.get(token)!;
    const a=this.accounts.accounts.find(a=>a.account_id===session.account)!;
    const expires=Math.min(session.expires,Date.parse(c.expires_at!));
    return {account_id:a.account_id,principal_id:a.principal_id,principal_kind:a.principal_kind,credential_epoch:a.credential_epoch,
      policy_generation:this.policy.generation,policy_sha256:digest(this.policy),account_generation:this.accounts.generation,accounts_sha256:digest(this.accounts),
      grant_id:g.grant_id,grant_scope_sha256:digest(g),repository_configuration_sha256:repositoryDigest,responsible_scope:context.responsible,expires_at:new Date(expires).toISOString()};
  }
  issueRevalidationAuth(c:SecurityContext,context:RevalidationContext,authority:RevalidationAuthority,attemptId:string,bridgeDigest:string,actionInput:unknown) {
    const fresh=this.revalidationAuthority(c,context,authority.repository_configuration_sha256);
    if(canonical(fresh)!==canonical(authority))fail('REVALIDATION_AUTHORITY_CHANGED',5,'Account, policy or scoped grant changed since admission.');
    const action=(actionInput as any)?.action;
    if(!c.allowed_operations.includes(action))fail('OPERATION_FORBIDDEN',4,'The internal authenticated action is not assigned.');
    return parse(revalidationAuthSchema,{format:'strata-revalidation-auth/1',model_version:MODEL,project_id:c.project_id,repo_id:context.review.repo_id,
      attempt_id:attemptId,bridge_sha256:bridgeDigest,action,action_input:actionInput,input_sha256:digest(actionInput),request_sha256:revalidationRequestDigest(context.request,c.principal_id),
      authority,issued_at:new Date(this.time()).toISOString(),expires_at:authority.expires_at,trust:'host-authenticated'});
  }
}
