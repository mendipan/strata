import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { readControl, type BootstrapControl, type OwnerBinding } from './bootstrap-control.js';
import { digest, secret, privateDir, readPrivate, optionalPrivate, writePrivate, withLease, recovery } from './owner-files.js';
import { PasswordWork, ownerName, ownerPassword, verifierSchema } from './owner-password.js';
import { EncryptedCredentialStore } from './credential-store.js';
import { problem } from './contract.js';

const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), gen = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1);
export const browserOwnerConfigSchema = z.object({ control_file:z.string().max(4096), state_directory:z.string().max(4096), key_directory:z.string().max(4096), credential_directory:z.string().max(4096) }).strict().superRefine((config,ctx)=>{
  const entries=Object.entries(config);
  for(const [field,value] of entries)if(!path.isAbsolute(value)||path.resolve(value)!==value)ctx.addIssue({code:'custom',path:[field],message:'Owner storage requires a canonical absolute path.'});
  for(let i=0;i<entries.length;i++)for(let j=0;j<entries.length;j++)if(i!==j){
    const relative=path.relative(entries[i][1],entries[j][1]);
    if(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep))ctx.addIssue({code:'custom',path:[entries[j][0]],message:'Owner control, state, key and credential paths must be distinct and disjoint.'});
  }
});
export type BrowserOwnerConfig = z.infer<typeof browserOwnerConfigSchema>;
export const reservationSchema = z.object({ format:z.literal('strata-owner-reservation/1'), installation_id:id, enrollment_epoch:id, pending_id:id, initialization_id:id, browser_cookie_sha256:hash, purpose:z.enum(['enroll-owner','resume-owner-enrollment','recover-owner-password']), expected_owner_generation:gen, created_at:z.string().datetime(), expires_at:z.string().datetime() }).strict();
const pendingSchema = z.object({ reservation:reservationSchema, creation_id:id, pre_cookie_sha256:hash, public_code:z.string().regex(/^[a-f0-9]{32}$/), csrf:z.string().regex(/^[A-Za-z0-9_-]{43}$/), cancelled:z.boolean() }).strict();
const poolSchema = z.object({ format:z.literal('strata-owner-pending/1'), enrollment_epoch:id, requests:z.array(pendingSchema).max(8), attempts:z.array(z.number()).max(5) }).strict();
export const initialManifestSchema = z.object({ format:z.literal('strata-owner-initialization/1'), installation_id:id, initialization_id:id, enrollment_epoch:id, approval_id:id, owner_id:id, key_id:id, authentication_id:id, authentication_generation:z.literal(1), request_id:id, key_storage_policy:z.literal('host-bound') }).strict();
export type InitialManifest = z.infer<typeof initialManifestSchema>;
const preparationSchema = z.object({ format:z.literal('strata-owner-preparation/1'), phase:z.enum(['preparing','prepared']), manifest:initialManifestSchema }).strict();
const pointerSchema = z.object({ format:z.literal('strata-owner-active/1'), initialization_id:id, owner_id:id, key_id:id, authentication_id:id, authentication_generation:gen, request_id:id, recovery_approval_id:id.optional() }).strict();
const authSchema = z.object({ format:z.literal('strata-owner-auth/1'), owner_id:id, generation:gen, username:z.string().regex(/^[a-z0-9._-]{3,32}$/), verifier:verifierSchema }).strict();
const keySchema = z.object({format:z.literal('strata-owner-store-key/1'),key:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
export type Pending = z.infer<typeof pendingSchema>;
export type ActiveOwner = z.infer<typeof pointerSchema> & { username:string; verifier:z.infer<typeof verifierSchema>; manifest:InitialManifest };
export type SetupStatus = { format:'strata-studio-setup/1'; state:'disabled'|'available'|'pending'|'approved'|'finishing'|'complete'|'recovery-required'; generation:number|null; origin:string; purpose:string|null; authentication_generation?:number; operation_id?:string; request?:{code:string;expires_at:string}; csrf?:string; message?:string };

export class BootstrapState {
  readonly passwords = new PasswordWork();
  constructor(readonly config:BrowserOwnerConfig, readonly origin:string, readonly now = Date.now, private fault?:(stage:string)=>Promise<void>) {
    browserOwnerConfigSchema.parse(config);
  }
  private file(name:string) { return path.join(this.config.state_directory,name); }
  private transaction(init:string) { return this.file('initial-'+id.parse(init)+'.json'); }
  private authFile(auth:string) { return this.file('auth-'+id.parse(auth)+'.json'); }
  private keyFile(key:string) { return path.join(this.config.key_directory,id.parse(key)+'.json'); }
  private storeDir(init:string) { return path.join(this.config.credential_directory,id.parse(init)); }
  async control() { return readControl(this.config.control_file,this.origin); }
  async readyDirectories() {
    for(const directory of [this.config.state_directory,this.config.key_directory,this.config.credential_directory]) await privateDir(directory,true);
  }
  private async pool(control:BootstrapControl, reset = false) {
    await privateDir(this.config.state_directory);
    const parsed = await optionalPrivate(this.file('pending.json'));
    if (parsed===undefined) { if(control.state==='approved')recovery(); return {format:'strata-owner-pending/1' as const,enrollment_epoch:control.enrollment_epoch,requests:[] as Pending[],attempts:[] as number[]}; }
    const result = poolSchema.parse(parsed);
    if(result.enrollment_epoch!==control.enrollment_epoch) {
      if(!reset) return {format:'strata-owner-pending/1' as const,enrollment_epoch:control.enrollment_epoch,requests:[] as Pending[],attempts:[] as number[]};
      return {format:'strata-owner-pending/1' as const,enrollment_epoch:control.enrollment_epoch,requests:[] as Pending[],attempts:[] as number[]};
    }
    return result;
  }
  private validControl(control:BootstrapControl|undefined) {
    if(!control || control.state==='closed') problem('SETUP_DISABLED',403,'Browser setup has not been armed by the owner.');
    if(this.now()>=Date.parse(control.expires_at)) problem('SETUP_EXPIRED',409,'The setup approval window expired. Ask for a new bound request.');
    return control;
  }
  async pending(cookieDigest:string):Promise<Pending|undefined> {
    const control = await this.control(); if(!control) return undefined;
    const pool = await this.pool(control);
    return pool.requests.find(p=>p.reservation.browser_cookie_sha256===cookieDigest && !p.cancelled && this.now()<Date.parse(p.reservation.expires_at));
  }
  async status(cookieDigest?:string):Promise<SetupStatus> {
    const base = {format:'strata-studio-setup/1' as const,origin:this.origin,generation:null,purpose:null};
    try {
      const control=await this.control();
      const pointer=await optionalPrivate(this.file('active.json'));
      const recovering=control?.purpose==='recover-owner-password'&&control.state!=='closed'&&this.now()<Date.parse(control.expires_at)&&(control.state==='armed'||!pointer||pointerSchema.parse(pointer).recovery_approval_id!==control.approval?.approval_id);
      if((pointer!==undefined || control?.owner_binding)&&!recovering) {
        const owner=await this.owner(false);
        return {...base,state:owner?'complete':'finishing',generation:control?.control_generation??null,purpose:control?.purpose??null};
      }
      if(!control || control.state==='closed' || this.now()>=Date.parse(control.expires_at)|| (control.approval&&this.now()>=Date.parse(control.approval.expires_at))) return {...base,state:'disabled'};
      const pending=cookieDigest?await this.pending(cookieDigest):undefined;
      if(control.state==='approved' && !pending) return {...base,state:'disabled',generation:control.control_generation};
      let operation_id:string|undefined;
      if(pending&&control.approval?.pending_id===pending.reservation.pending_id&&control.purpose!=='recover-owner-password'){
        const prepared=await optionalPrivate(this.transaction(pending.reservation.initialization_id));
        if(prepared){const p=preparationSchema.parse(prepared);if(p.phase!=='prepared')recovery();await this.artifacts(p.manifest);operation_id=p.manifest.request_id;}
        else if((await readdir(this.config.key_directory)).length||(await readdir(this.config.credential_directory)).length)recovery();
      }
      return {...base,state:pending?(control.approval?.pending_id===pending.reservation.pending_id?'approved':'pending'):'available',generation:control.control_generation,purpose:control.purpose,...(operation_id?{operation_id}:{}),...(control.recovery?{authentication_generation:control.recovery.authentication_generation}:{}),...(pending?{request:{code:pending.public_code,expires_at:pending.reservation.expires_at},csrf:pending.csrf}:{})};
    }catch{return {...base,state:'recovery-required',message:'Protected owner state needs operator reconciliation.'};}
  }
  async request(cookieDigest:string, expected:number, creation_id= randomUUID() as string, preCookieDigest=cookieDigest) {
    await this.readyDirectories();
    return withLease(this.config.state_directory,async()=>{
      const control=this.validControl(await this.control());
      if(control.state!=='armed'||control.control_generation!==expected) problem('SETUP_CHANGED',409,'Setup changed. Refresh before starting.');
      if(control.owner_binding && control.purpose==='enroll-owner') recovery();
      const active=await optionalPrivate(this.file('active.json'));
      if(active && control.purpose==='enroll-owner') problem('SETUP_ALREADY_COMPLETE',409,'Owner setup is already complete.');
      if(control.purpose!=='enroll-owner') {
        if(control.purpose==='recover-owner-password') {
          const owner=await this.owner(); if(!owner || owner.owner_id!==control.recovery?.owner_id || owner.authentication_generation!==control.recovery.authentication_generation) recovery();
        } else {
          const prepared=preparationSchema.parse(await readPrivate(this.transaction(control.resume!.initialization_id)));
          if(prepared.phase!=='prepared'||digest(JSON.stringify(prepared.manifest))!==control.resume!.initial_manifest_sha256) recovery();
        }
      } else if(!active) {
        const unknown=(await readdir(this.config.state_directory)).filter(n=>!['pending.json','.owner.lock','login-limit.json'].includes(n));
        if(unknown.length || (await readdir(this.config.key_directory)).length || (await readdir(this.config.credential_directory)).length) recovery();
      }
      const pool=await this.pool(control,true),now=this.now();
      if(pool.requests.some(p=>p.creation_id===creation_id))problem('REQUEST_CONFLICT',409,'This setup request was already dispatched. Check its original browser outcome.');
      pool.requests=pool.requests.filter(p=>!p.cancelled&&now<Date.parse(p.reservation.expires_at));pool.attempts=pool.attempts.filter(t=>now-t<60_000);
      const old=pool.requests.find(p=>p.reservation.browser_cookie_sha256===cookieDigest);if(old)return old;
      if(pool.requests.length>=8||pool.attempts.length>=5)problem('SETUP_BUSY',429,'Setup request capacity is temporarily full. Try again shortly.');
      const pending:Pending={reservation:{format:'strata-owner-reservation/1',installation_id:control.installation_id,enrollment_epoch:control.enrollment_epoch,pending_id:randomUUID(),initialization_id:control.resume?.initialization_id??randomUUID(),browser_cookie_sha256:cookieDigest,purpose:control.purpose,expected_owner_generation:control.expected_owner_generation,created_at:new Date(now).toISOString(),expires_at:new Date(Math.min(now+15*60_000,Date.parse(control.expires_at))).toISOString()},creation_id,pre_cookie_sha256:preCookieDigest,public_code:randomUUID().replaceAll('-',''),csrf:secret(),cancelled:false};
      pool.requests.push(pending);pool.attempts.push(now);await writePrivate(this.file('pending.json'),pool);return pending;
    });
  }
  async cancel(cookieDigest:string, expected:number) {
    return withLease(this.config.state_directory,async()=>{
      const control=this.validControl(await this.control());if(control.control_generation!==expected)problem('SETUP_CHANGED',409,'Setup changed. Refresh before cancellation.');
      const pool=await this.pool(control),pending=pool.requests.find(p=>p.reservation.browser_cookie_sha256===cookieDigest);
      if(pending)pending.cancelled=true;await writePrivate(this.file('pending.json'),pool);
    });
  }
  private async approval(cookieDigest:string, expected:number) {
    const control=this.validControl(await this.control()),pending=await this.pending(cookieDigest);
    if(control.state!=='approved'||!control.approval||!pending)problem('SETUP_NOT_APPROVED',403,'This browser request is awaiting owner confirmation.');
    if(control.control_generation!==expected)problem('SETUP_CHANGED',409,'Setup approval changed. Refresh before continuing.');
    if(this.now()>=Date.parse(control.approval.expires_at))problem('SETUP_EXPIRED',409,'This browser approval expired.');
    if(control.approval.pending_id!==pending.reservation.pending_id||control.approval.browser_cookie_sha256!==cookieDigest||control.approval.reservation_sha256!==digest(JSON.stringify(pending.reservation)))problem('SETUP_NOT_APPROVED',403,'This approval belongs to a different browser.');
    return {control,pending};
  }
  async complete(cookieDigest:string,input:{request_id:string;expected_generation:number;username:string;password:string;key_storage_policy:'host-bound'}) {
    const username=ownerName(input.username),password=ownerPassword(input.password,username);
    return withLease(this.config.state_directory,async()=>{
      const {control,pending}=await this.approval(cookieDigest,input.expected_generation);
      if(control.purpose==='recover-owner-password')problem('INVALID_INPUT',400,'Password recovery requires its separate action.');
      if(control.owner_binding)problem('SETUP_ALREADY_COMPLETE',409,'Owner setup is already complete.');
      const init=pending.reservation.initialization_id,transaction=this.transaction(init),previous=await optionalPrivate(transaction);
      let preparation:z.infer<typeof preparationSchema>;
      if(previous!==undefined){
        preparation=preparationSchema.parse(previous);if(preparation.phase!=='prepared')recovery();
        const auth=authSchema.parse(await readPrivate(this.authFile(preparation.manifest.authentication_id)));
        if((control.purpose==='enroll-owner'&&preparation.manifest.request_id!==input.request_id) || (control.resume&&(control.resume.initialization_id!==preparation.manifest.initialization_id||control.resume.initial_manifest_sha256!==digest(JSON.stringify(preparation.manifest)))) || auth.username!==username || !await this.passwords.verify(password,auth.verifier))problem('REQUEST_CONFLICT',409,'Prepared setup requires the exact original request and sign-in values.');
        await this.artifacts(preparation.manifest);
      }else{
        if(control.purpose!=='enroll-owner'||await optionalPrivate(this.file('active.json')))recovery();
        if((await readdir(this.config.key_directory)).length||(await readdir(this.config.credential_directory)).length||(await readdir(this.config.state_directory)).some(n=>!['pending.json','.owner.lock','login-limit.json'].includes(n)))recovery();
        const manifest:InitialManifest={format:'strata-owner-initialization/1',installation_id:control.installation_id,initialization_id:init,enrollment_epoch:control.enrollment_epoch,approval_id:control.approval!.approval_id,owner_id:randomUUID(),key_id:randomUUID(),authentication_id:randomUUID(),authentication_generation:1,request_id:id.parse(input.request_id),key_storage_policy:'host-bound'};
        preparation={format:'strata-owner-preparation/1',phase:'preparing',manifest};await writePrivate(transaction,preparation,true);await this.fault?.('reservation');
        const verifier=await this.passwords.create(password);
        await writePrivate(this.authFile(manifest.authentication_id),{format:'strata-owner-auth/1',owner_id:manifest.owner_id,generation:1,username,verifier},true);
        await this.fault?.('verifier');
        await writePrivate(this.keyFile(manifest.key_id),{format:'strata-owner-store-key/1',key:secret()},true);
        await this.fault?.('key');
        await this.store(manifest).initialize();
        await this.fault?.('ciphertext');preparation.phase='prepared';await writePrivate(transaction,preparation);await this.fault?.('prepared');
      }
      const again=await this.approval(cookieDigest,input.expected_generation);
      if(again.control.approval!.approval_id!==control.approval!.approval_id)problem('SETUP_CHANGED',409,'Setup authorization changed before activation.');
      const m=preparation.manifest;
      const pointer={format:'strata-owner-active/1',initialization_id:m.initialization_id,owner_id:m.owner_id,key_id:m.key_id,authentication_id:m.authentication_id,authentication_generation:1,request_id:m.request_id};
      const current=await optionalPrivate(this.file('active.json'));
      if(current && JSON.stringify(pointerSchema.parse(current))!==JSON.stringify(pointer))problem('SETUP_ALREADY_COMPLETE',409,'A different owner activation already exists.');
      await this.fault?.('before-activation');if(!current)await writePrivate(this.file('active.json'),pointer,true);await this.fault?.('activation');
      return {state:'finishing',initialization_id:m.initialization_id};
    });
  }
  private async artifacts(manifest:InitialManifest) {
    const key=keySchema.parse(await readPrivate(this.keyFile(manifest.key_id),1024));
    if(Buffer.from(key.key,'base64url').length!==32)recovery();
    await this.store(manifest).status();
  }
  store(manifest:Pick<InitialManifest,'initialization_id'|'key_id'>) {
    return new EncryptedCredentialStore(this.storeDir(manifest.initialization_id),async()=>{
      const key=keySchema.parse(await readPrivate(this.keyFile(manifest.key_id),1024));return Buffer.from(key.key,'base64url');
    },true);
  }
  async owner(requireSeal=true,validateCredentialStore=true):Promise<ActiveOwner|undefined> {
    await privateDir(this.config.state_directory);
    const control=await this.control(),value=await optionalPrivate(this.file('active.json'));
    if(!control) { if(value!==undefined)recovery(); return undefined; }
    if(value===undefined){if(control?.owner_binding)recovery();return undefined;}
    const pointer=pointerSchema.parse(value),prepared=preparationSchema.parse(await readPrivate(this.transaction(pointer.initialization_id)));
    const m=prepared.manifest;
    if(prepared.phase!=='prepared'||m.owner_id!==pointer.owner_id||m.key_id!==pointer.key_id||m.installation_id!==control?.installation_id)recovery();
    const binding:OwnerBinding={installation_id:m.installation_id,initialization_id:m.initialization_id,owner_id:m.owner_id,key_id:m.key_id,initial_manifest_sha256:digest(JSON.stringify(m))};
    const auth=authSchema.parse(await readPrivate(this.authFile(pointer.authentication_id)));
    if(auth.owner_id!==pointer.owner_id||auth.generation!==pointer.authentication_generation)recovery();
    if(validateCredentialStore)await this.artifacts(m);
    if(!control.owner_binding){if(requireSeal)problem('SETUP_NOT_APPROVED',403,'Owner setup is awaiting its independent completion record.');return undefined;}
    if(JSON.stringify(control.owner_binding)!==JSON.stringify(binding))recovery();
    return {...pointer,username:auth.username,verifier:auth.verifier,manifest:m};
  }
  async rotate(owner:ActiveOwner,newPassword:string,request_id:string,authorize:()=>Promise<void>) {
    return withLease(this.config.state_directory,async()=>{
      const current=await this.owner();if(!current)recovery();await authorize();
      if(current.request_id===request_id){if(!await this.passwords.verify(newPassword,current.verifier))problem('REQUEST_CONFLICT',409,'Password replay requires the exact original value.');return current.authentication_generation;}
      if(current.authentication_generation!==owner.authentication_generation)problem('OWNER_SESSION_REQUIRED',401,'Owner authentication changed. Sign in again.');
      const authentication_id=randomUUID(),generation=current.authentication_generation+1;
      if(generation>=Number.MAX_SAFE_INTEGER)recovery();
      const verifier=await this.passwords.create(ownerPassword(newPassword,current.username));
      await writePrivate(this.authFile(authentication_id),{format:'strata-owner-auth/1',owner_id:current.owner_id,generation,username:current.username,verifier},true);
      await authorize();
      const {username:_name,verifier:_verifier,manifest:_manifest,...pointer}=current;
      await writePrivate(this.file('active.json'),{...pointer,authentication_id,authentication_generation:generation,request_id});return generation;
    });
  }
  async credentialAction<T>(owner:ActiveOwner,authorize:()=>Promise<void>,operation:(store:EncryptedCredentialStore)=>Promise<T>) {
    return withLease(this.config.state_directory,async()=>{const current=await this.owner();await authorize();if(!current||current.authentication_generation!==owner.authentication_generation)problem('OWNER_SESSION_REQUIRED',401,'Owner authentication changed. Sign in again.');return operation(this.store(current.manifest));});
  }
  async recoverPassword(cookieDigest:string,input:{request_id:string;expected_generation:number;expected_authentication_generation:number;new_password:string}) {
    return withLease(this.config.state_directory,async()=>{
      const {control}=await this.approval(cookieDigest,input.expected_generation);
      if(control.purpose!=='recover-owner-password'||!control.recovery||!control.owner_binding)problem('SETUP_NOT_APPROVED',403,'This request does not authorize password recovery.');
      const owner=await this.owner();if(!owner)recovery();
      if(owner.recovery_approval_id===control.approval!.approval_id){
        if(owner.request_id!==input.request_id||!await this.passwords.verify(input.new_password,owner.verifier))problem('REQUEST_CONFLICT',409,'Recovery replay requires the exact original request and password.');
        return {state:'complete',authentication_generation:owner.authentication_generation};
      }
      if(owner.owner_id!==control.recovery.owner_id||owner.authentication_generation!==control.recovery.authentication_generation||owner.authentication_generation!==input.expected_authentication_generation)problem('SETUP_CHANGED',409,'Owner authentication changed before recovery.');
      const generation=owner.authentication_generation+1,authentication_id=randomUUID(),verifier=await this.passwords.create(ownerPassword(input.new_password,owner.username));
      await writePrivate(this.authFile(authentication_id),{format:'strata-owner-auth/1',owner_id:owner.owner_id,generation,username:owner.username,verifier},true);
      const again=await this.approval(cookieDigest,input.expected_generation);if(again.control.approval!.approval_id!==control.approval!.approval_id)problem('SETUP_CHANGED',409,'Recovery authorization changed.');
      const {username:_name,verifier:_verifier,manifest:_manifest,...pointer}=owner;
      await writePrivate(this.file('active.json'),{...pointer,authentication_id,authentication_generation:generation,request_id:input.request_id,recovery_approval_id:control.approval!.approval_id});
      return {state:'complete',authentication_generation:generation};
    });
  }
}
