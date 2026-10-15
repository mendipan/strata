// Pure review contract. No transport, credential, filesystem or budget operation.
import {z} from 'zod';
import {digest,fail,parse} from './model.js';
import {checklistNoPagination} from './checklist-cloud-management.js';
import {checklistResponseDiagnostic} from './checklist-cloud-diagnostics.js';
import {checklistWorkerEntityUrl,checklistPrivateWorkerIdentity,checklistWorkerDeleteAcknowledgement} from './checklist-cloud-worker-identity.js';

const hash=z.string().length(64).regex(/^[a-f0-9]{64}$/),commit=z.string().length(40).regex(/^[a-f0-9]{40}$/);
const identitySchema=z.object({account_id:z.string().length(32).regex(/^[a-f0-9]{32}$/),name:z.string().regex(/^[a-z0-9-]{1,63}$/).refine(v=>!/[\r\n]/.test(v)),
 id:z.string().length(32).regex(/^[a-f0-9]{32}$/i),created_on:z.string().datetime({offset:true}),updated_on:z.string().datetime({offset:true})}).strict();
const readSchema=z.object({method:z.literal('GET'),url:z.string(),http_status:z.literal(200),response_sha256:hash,identity:identitySchema}).strict();
export const checklistWorkerRecoverySchema=z.object({format:z.literal('strata-checklist-worker-recovery/1'),
 bridge_candidate_commit:commit,source_sha256:hash,target_sha256:hash,reconciliation_plan_sha256:hash,
 consumed_activation_sha256:hash,original_POST_response_sha256:hash,identity:identitySchema,
 exact_name_read:readSchema,exact_id_read:readSchema}).strict();
export type ChecklistWorkerRecovery=z.infer<typeof checklistWorkerRecoverySchema>;
export const checklistWorkerCleanupAuthoritySchema=z.object({format:z.literal('strata-checklist-worker-cleanup-authority/1'),
 approved:z.literal(true),cleanup_only:z.literal(true),approval_id:z.string().min(1).max(128),approved_at:z.number().int().nonnegative(),
 expires_at:z.number().int().positive(),candidate_commit:commit,contract_sha256:hash,recovery_sha256:hash,
 consumed_activation_sha256:hash,identity:identitySchema,maximum_deletes:z.literal(1),force:z.literal(false),
 preserve_quarantine:z.literal(true),preserve_cost_hold:z.literal(true)}).strict();
export type ChecklistWorkerCleanupAuthority=z.infer<typeof checklistWorkerCleanupAuthoritySchema>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function refused():never{return fail('CHECKLIST_WORKER_CLEANUP_REFUSED',7,'Cleanup-only authority, exact recovered ownership or unchanged private state differs.');}
function identityEqual(a:unknown,b:unknown){return digest(a)===digest(b);}
export function verifyChecklistWorkerRecovery(raw:unknown,reviewedRecoverySha256:string) {
 const p=parse(checklistWorkerRecoverySchema,raw),i=p.identity;
 if(!/^[a-f0-9]{64}$/.test(reviewedRecoverySha256)||digest(p)!==reviewedRecoverySha256)refused();
 for(const [read,url] of [[p.exact_name_read,checklistWorkerEntityUrl(i.account_id,i.name,'name')],
  [p.exact_id_read,checklistWorkerEntityUrl(i.account_id,i.id)]] as const)
  if(read.url!==url||read.response_sha256!==p.original_POST_response_sha256||!identityEqual(read.identity,i))refused();
 return p;
}
export function checklistWorkerCleanupPlan(raw:unknown,reviewedRecoverySha256:string) {
 const p=verifyChecklistWorkerRecovery(raw,reviewedRecoverySha256),i=p.identity;
 const request=(url:string,method:'GET'|'DELETE')=>({url,method,provider_requests:1 as const,automatic_retries:0 as const,
  pagination:'refuse' as const,redirect:'manual' as const});
 return {format:'strata-checklist-worker-cleanup-contract/1' as const,recovery_sha256:digest(p),identity:i,
  fresh_read:request(checklistWorkerEntityUrl(i.account_id,i.id),'GET'),
  delete:request(checklistWorkerEntityUrl(i.account_id,i.id),'DELETE'),maximum_deletes:1 as const,force:false as const,
  absence_reads:[request(checklistWorkerEntityUrl(i.account_id,i.id),'GET'),request(checklistWorkerEntityUrl(i.account_id,i.name,'name'),'GET')],
  absence_contract:'unqualified-private-entity-404' as const,quarantine_release:false as const,cost_hold_release:false as const,
  execution_enabled:false as const};
}
function successWorker(status:number,raw:unknown){
 if(status!==200||!object(raw))refused();checklistNoPagination(raw);
 if(Object.keys(raw).some(k=>!['success','errors','messages','result'].includes(k))||raw.success!==true||
  !Array.isArray(raw.errors)||raw.errors.length||!Array.isArray(raw.messages)||raw.messages.length||!object(raw.result))refused();
 checklistNoPagination(raw.result);return raw.result;
}
export type ChecklistWorkerFreshRead={method:'GET';url:string;http_status:number;raw:unknown;observed_at:number};
export function verifyChecklistWorkerCleanupFreshRead(p:ChecklistWorkerRecovery,fresh:ChecklistWorkerFreshRead,now:number) {
 const i=p.identity;
 if(fresh.method!=='GET'||fresh.url!==checklistWorkerEntityUrl(i.account_id,i.id)||!Number.isSafeInteger(now)||
  !Number.isSafeInteger(fresh.observed_at)||fresh.observed_at>now||now-fresh.observed_at>60000)refused();
 const w=successWorker(fresh.http_status,fresh.raw);
 checklistPrivateWorkerIdentity(w,i.name,i.id);
 // Require explicit null: a missing optional deployed_on is not proof of never
 // deployed. URLs may be present even with private flags, per the current API.
 const refs=w.references;if(!object(refs))refused();
 if(w.created_on!==i.created_on||w.updated_on!==i.updated_on||!Object.hasOwn(w,'deployed_on')||w.deployed_on!==null||
  Object.keys(refs).length!==5||
  ['dispatch_namespace_outbounds','domains','durable_objects','queues','workers'].some(k=>!Array.isArray(refs[k])||(refs[k] as unknown[]).length)||
  !Array.isArray(w.tags)||w.tags.length||!Array.isArray(w.tail_consumers)||w.tail_consumers.length||
  Object.hasOwn(w,'previews_base_config')||digest(fresh.raw)!==p.original_POST_response_sha256)refused();
 return {response_sha256:digest(fresh.raw),observed_at:fresh.observed_at};
}
// A reducer models the durable execution journal the parent must implement.
// Persist its returned reservation exclusively and fsync BEFORE dispatch. On a
// crash, missing acknowledgement or failed persistence, never replay DELETE.
// This module is deliberately not wired to bootstrap or a production CLI.
export type ChecklistWorkerCleanupState={format:'strata-checklist-worker-cleanup-state/1';recovery_sha256:string;
 phase:'fresh-read-required'|'delete-reserved-uncertain'|'delete-acknowledged';delete_reservations:0|1;
 reservation?:{authority_sha256:string;request_sha256:string;fresh_response_sha256:string;time:number};
 acknowledgement?:{response_sha256:string;diagnostic:ReturnType<typeof checklistResponseDiagnostic>}};
export function initialChecklistWorkerCleanupState(p:ChecklistWorkerRecovery):ChecklistWorkerCleanupState {
 return {format:'strata-checklist-worker-cleanup-state/1',recovery_sha256:digest(p),phase:'fresh-read-required',delete_reservations:0};
}
export function reserveChecklistWorkerCleanupDelete(raw:unknown,reviewedRecoverySha256:string,rawAuthority:unknown,
 reviewedCandidateCommit:string,state:ChecklistWorkerCleanupState,fresh:ChecklistWorkerFreshRead,now:number) {
 const p=verifyChecklistWorkerRecovery(raw,reviewedRecoverySha256),plan=checklistWorkerCleanupPlan(p,reviewedRecoverySha256);
 const a=parse(checklistWorkerCleanupAuthoritySchema,rawAuthority);
 if(a.recovery_sha256!==digest(p)||a.contract_sha256!==digest(plan)||a.candidate_commit!==reviewedCandidateCommit||
  !/^[a-f0-9]{40}$/.test(reviewedCandidateCommit)||a.consumed_activation_sha256!==p.consumed_activation_sha256||!identityEqual(a.identity,p.identity)||
  a.approved_at>now||now>=a.expires_at||a.expires_at-a.approved_at>15*60000||fresh.observed_at<a.approved_at||
  digest(a)===p.consumed_activation_sha256||state.format!=='strata-checklist-worker-cleanup-state/1'||
  state.recovery_sha256!==digest(p)||state.phase!=='fresh-read-required'||state.delete_reservations!==0||state.reservation||state.acknowledgement)refused();
 const read=verifyChecklistWorkerCleanupFreshRead(p,fresh,now);
 const next:ChecklistWorkerCleanupState={format:state.format,recovery_sha256:state.recovery_sha256,phase:'delete-reserved-uncertain',delete_reservations:1,
  reservation:{authority_sha256:digest(a),request_sha256:digest(plan.delete),fresh_response_sha256:read.response_sha256,time:now}};
 return {state:next,request:plan.delete};
}
export function acknowledgeChecklistWorkerCleanupDelete(p:ChecklistWorkerRecovery,state:ChecklistWorkerCleanupState,url:string,status:number,raw:unknown) {
 const plan=checklistWorkerCleanupPlan(p,digest(p));
 if(state.recovery_sha256!==digest(p)||state.phase!=='delete-reserved-uncertain'||state.delete_reservations!==1||
  state.reservation?.request_sha256!==digest(plan.delete)||url!==plan.delete.url)refused();
 checklistWorkerDeleteAcknowledgement(status,raw);
 return {...state,phase:'delete-acknowledged' as const,acknowledgement:{response_sha256:digest(raw),diagnostic:checklistResponseDiagnostic(status,raw)}};
}
export function observeChecklistWorkerCleanupAbsence(p:ChecklistWorkerRecovery,state:ChecklistWorkerCleanupState,url:string,status:number,raw:unknown) {
 const plan=checklistWorkerCleanupPlan(p,digest(p));
 if(state.recovery_sha256!==digest(p)||state.delete_reservations!==1||!['delete-reserved-uncertain','delete-acknowledged'].includes(state.phase)||
  !plan.absence_reads.some(r=>r.url===url))refused();
 // Store hashes/safe types only. Even a well-formed 404 remains unqualified;
 // ambiguity, auth denial, same-name replacements and transport loss cannot
 // turn into absence or re-arm DELETE. No guessed provider error code exists.
 return {url,http_status:status,response_sha256:digest(raw),diagnostic:checklistResponseDiagnostic(status,raw),
  verified_absent:false as const,quarantine_preserved:true as const,cost_hold_preserved:true as const,
  blocker:'private-entity-negative-contract-unqualified' as const};
}
