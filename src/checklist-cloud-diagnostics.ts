import {canonical,StrataError} from './model.js';

export const CHECKLIST_DIAGNOSTIC_BYTES=8192;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const kind=(v:unknown)=>v===undefined?'missing':v===null?'null':Array.isArray(v)?'array':typeof v;
const count=(n:number)=>Math.min(n,1000000);
const fields=(v:Record<string,unknown>,names:readonly string[])=>({
 known:Object.fromEntries(names.map(name=>[name,kind(v[name])])),
 unknown_fields:count(Object.keys(v).filter(name=>!names.includes(name)).length)
});
export function checklistDenialMessage(value:unknown):boolean {
 // Fail closed on access-control terminology or action prohibitions even when
 // a response also carries a missing-resource code. Shared by gates and logs.
 if(typeof value!=='string')return false;
 return /auth|permission|deni|deny|forbidden|token|bearer|credential|secret|access|privileg|entitl|allow|permit|prohibit|restrict|blocked|reject|insufficient|capabilit|eligib|\brole\b|\bscope\b|\bgrant\b|\brights?\b/i.test(value)||
  /\b(?:cannot|can['’]t|can\s+not|may\s+not|must\s+not|do\s+not|does\s+not|don['’]t|doesn['’]t|not\s+able\s+to|unable\s+to)\s+(?:view|read|use|call|list|inspect|retrieve|get|fetch|see|query|manage|modify|update|edit|write|create|delete|remove|deploy|execute|invoke|perform)\b/i.test(value);
}
function message(v:unknown){
 // Never persist arbitrary server text: it may echo keys, URLs, headers or payloads.
 // Fixed classifications retain the predicates that matter for absence validation.
 if(typeof v!=='string')return{type:kind(v),safe_text:'[redacted]',length:0,not_found_phrase:false,authorization_phrase:false};
 const not_found_phrase=/\b(not found|does not exist)\b/i.test(v),authorization_phrase=checklistDenialMessage(v);
 return{type:'string',length:count(v.length),not_found_phrase,authorization_phrase,
  safe_text:authorization_phrase?'authorization diagnostic':not_found_phrase?'not found diagnostic':'[redacted]'};
}
function diagnosticEntry(v:unknown){
 if(!object(v))return{type:kind(v)};
 const code=Number.isSafeInteger(v.code)&&Number(v.code)>=0&&Number(v.code)<=999999?v.code:null;
 return{type:'object',fields:fields(v,['code','message','documentation_url','source']),code,
  message:message(v.message),source:object(v.source)?fields(v.source,['pointer']):{type:kind(v.source)}};
}
function entries(v:unknown){return Array.isArray(v)?{type:'array',count:count(v.length),truncated:v.length>4,
 entries:v.slice(0,4).map(diagnosticEntry)}:{type:kind(v)};}
export function checklistResponseDiagnostic(httpStatus:number,raw:unknown){
 const authorization_present=object(raw)&&[raw.errors,raw.messages].some(v=>Array.isArray(v)&&v.some(e=>object(e)&&message(e.message).authorization_phrase));
 const snapshot={format:'strata-checklist-response-diagnostic/1',http_status:httpStatus,raw_type:kind(raw),
  authorization_present,
  ...(object(raw)?{fields:fields(raw,['success','errors','messages','result','result_info','pagination','cursor','next_cursor','has_more']),
   success:typeof raw.success==='boolean'?raw.success:null,errors:entries(raw.errors),messages:entries(raw.messages),
   result_info:object(raw.result_info)?fields(raw.result_info,['count','per_page','total_count','page','total_pages','cursor']):{type:kind(raw.result_info)}}:{}),
  arbitrary_text_retained:false,result_values_retained:false,headers_retained:false};
 if(new TextEncoder().encode(canonical(snapshot)).length>CHECKLIST_DIAGNOSTIC_BYTES)throw new Error('Fixed diagnostic bound exceeded.');
 return snapshot;
}
export const CHECKLIST_VALIDATOR_STAGES=[
 'response.kind','pagination.marker','pagination.info.kind','pagination.info.fields','pagination.info.counts',
 'absence.envelope.fields','absence.success','absence.errors','absence.messages','absence.result',
 'absence.error.fields','absence.error.message','absence.error.authorization','http.status','success.envelope','management.other',
 'bootstrap.response','bootstrap.absence','http.redirect','http.pagination-header','http.body','http.transport','preflight.identity',
 'budget.exhausted','mutation.uncertain'
] as const;
export type ChecklistValidatorStage=typeof CHECKLIST_VALIDATOR_STAGES[number];
export function checklistFailureStage(error:unknown,fallback:ChecklistValidatorStage){
 if(error instanceof StrataError&&object(error.details)&&CHECKLIST_VALIDATOR_STAGES.includes(error.details.checklist_stage as ChecklistValidatorStage))
  return error.details.checklist_stage as ChecklistValidatorStage;
 return fallback;
}
export function checklistTransientGetFailure(error:unknown){
 // Only explicit transient transport codes or tagged HTTP statuses are eligible.
 // Never copy messages/stacks or infer transience from arbitrary text.
 return object(error)&&(['ETIMEDOUT','ECONNRESET','EAI_AGAIN'].includes(String(error.code))||
  (error instanceof StrataError&&object(error.details)&&error.details.checklist_stage==='http.status'&&
   [408,429,500,502,503,504].includes(Number(error.details.http_status))));
}
