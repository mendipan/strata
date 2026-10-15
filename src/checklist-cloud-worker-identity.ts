import {fail} from './model.js';
import {checklistNoPagination} from './checklist-cloud-management.js';
import {checklistDenialMessage} from './checklist-cloud-diagnostics.js';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function refused():never{return fail('CHECKLIST_WORKER_IDENTITY_REFUSED',7,'Exact private Worker identity or response contract differs.');}
// The beta API documents an immutable string, not a UUID. This admission policy
// deliberately supports only the observed 32-hex shape; never normalize its case.
export const checklistWorkerId=(v:unknown):v is string=>typeof v==='string'&&v.length===32&&/^[a-f0-9]{32}$/i.test(v);
export function checklistWorkerEntityUrl(account:string,identity:string,by:'id'|'name'='id') {
 if(account.length!==32||!/^[a-f0-9]{32}$/.test(account)||!['id','name'].includes(by)||
  (by==='id'?!checklistWorkerId(identity):!/^[a-z0-9-]{1,63}$/.test(identity)||/[\r\n]/.test(identity)))refused();
 return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/workers/${encodeURIComponent(identity)}`;
}
export function checklistPrivateWorkerIdentity(raw:unknown,name:string,id?:string) {
 if(!object(raw)||raw.name!==name||!checklistWorkerId(raw.id)||(id!==undefined&&raw.id!==id)||
  !object(raw.subdomain)||raw.subdomain.enabled!==false||raw.subdomain.previews_enabled!==false||raw.logpush!==false)refused();
 return raw.id;
}
export function checklistWorkerDeleteAcknowledgement(status:number,raw:unknown) {
 // DELETE documents success/errors/messages and no result. Optional null is
 // tolerated; arbitrary result objects and unknown/pagination fields refuse.
 if(status!==200||!object(raw)||Object.keys(raw).some(k=>!['success','errors','messages','result'].includes(k))||
  raw.success!==true||!Array.isArray(raw.errors)||raw.errors.length||!Array.isArray(raw.messages)||
  raw.messages.some(m=>!object(m)||Object.keys(m).some(k=>!['code','message','documentation_url','source'].includes(k))||
   !Number.isSafeInteger(m.code)||Number(m.code)<1000||typeof m.message!=='string'||!m.message.length||checklistDenialMessage(m.message)||
   (Object.hasOwn(m,'documentation_url')&&typeof m.documentation_url!=='string')||
   (Object.hasOwn(m,'source')&&(!object(m.source)||Object.keys(m.source).some(k=>k!=='pointer')||
    (Object.hasOwn(m.source,'pointer')&&typeof m.source.pointer!=='string'))))||
  (Object.hasOwn(raw,'result')&&raw.result!==null))refused();
 checklistNoPagination(raw);return {accepted:true as const};
}
export function checklistPrivateWorkerAbsence(status:number,raw:unknown) {
 // Observed on the acknowledged immutable ID after successful DELETE in d01.
 // Callers must use that exact entity URL, never script/deployment absence.
 if(status!==404||!object(raw)||Object.keys(raw).some(k=>!['success','errors','messages','result'].includes(k))||
  raw.success!==false||raw.result!==null||!Array.isArray(raw.messages)||raw.messages.length||
  !Array.isArray(raw.errors)||raw.errors.length!==1)refused();
 const error=raw.errors[0];
 if(!object(error)||Object.keys(error).some(k=>!['code','message'].includes(k))||error.code!==10007||
  typeof error.message!=='string'||!error.message.length||error.message.length>1024||
  !/\b(not found|does not exist)\b/i.test(error.message)||checklistDenialMessage(error.message))refused();
 return {absent:true as const};
}
