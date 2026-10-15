import { canonical, fail, parse } from './model.js';
import { CHECKLIST_CEILINGS, targetSchema, type ChecklistTarget } from './checklist-cloud-contract.js';
import { CHECKLIST_STEPS } from './checklist-cloud-workflow.js';
import {checklistDenialMessage,type ChecklistValidatorStage} from './checklist-cloud-diagnostics.js';
import {checklistLatestDeployment} from './checklist-cloud-deployments.js';
export type ChecklistManagementAction = 'create-instance' | 'status' | 'full-step' | 'terminate-instance' | 'delete-instance' |
  'inspect-instance' | 'delete-repository' | 'inspect-repository' | 'delete-workflow' | 'inspect-workflow' |
  'delete-app-worker' | 'inspect-app-worker' | 'delete-workflow-worker' | 'inspect-workflow-worker';
export type ChecklistManagementRequest = { action: ChecklistManagementAction; target: ChecklistTarget; payload?: unknown; step?: string; attempt?: 1;
  expected?:{workflow_id:string;workflow_definition_version_id:string} };
export type ChecklistHttpDescription = { url: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: string;
  provider_requests: 1; automatic_retries: 0; pagination: 'refuse'; redirect: 'manual' };
function refused(checklist_stage:ChecklistValidatorStage='management.other',details:Record<string,unknown>={}):never {
  return fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Exact one-request management response is missing, malformed, paginated or uncertain.',{checklist_stage,...details});
}
export function describeChecklistHttpRequest(request: ChecklistManagementRequest): ChecklistHttpDescription {
  const t=parse(targetSchema,request.target),root=`https://api.cloudflare.com/client/v4/accounts/${t.account_id}`;
  const workflow=root+'/workflows/'+encodeURIComponent(t.workflow),instance=workflow+'/instances/'+encodeURIComponent(t.instance_id);
  const repo=root+'/artifacts/namespaces/'+encodeURIComponent(t.namespace)+'/repos/'+encodeURIComponent(t.repository);
  const worker=root+'/workers/scripts/'+encodeURIComponent(request.action.includes('app-worker')?t.app_worker:t.workflow_worker);
  let url:string,method:ChecklistHttpDescription['method']='GET',body:string|undefined;
  switch(request.action){
    case 'create-instance':
      if(!object(request.payload))refused();
      url=workflow+'/instances';method='POST';body=canonical({instance_id:t.instance_id,params:canonical(request.payload)});break;
    case 'status':case 'inspect-instance':url=instance;break;
    case 'terminate-instance':url=instance+'/status';method='PATCH';body=canonical({status:'terminate'});break;
    case 'delete-instance':url=instance;method='DELETE';break;
    case 'inspect-repository':url=repo;break;
    case 'delete-repository':url=repo;method='DELETE';break;
    case 'inspect-workflow':url=workflow;break;
    case 'delete-workflow':url=workflow;method='DELETE';break;
    case 'inspect-app-worker':case 'inspect-workflow-worker':url=worker+'/deployments';break;
    case 'delete-app-worker':case 'delete-workflow-worker':url=worker;method='DELETE';break;
    case 'full-step':
      if(!CHECKLIST_STEPS.includes(request.step as typeof CHECKLIST_STEPS[number])||request.attempt!==1)refused();
      url=instance+'/step?'+new URLSearchParams({name:request.step+'-1',type:'step',attempt:'1'});break;
    default:return refused();
  }
  if(body&&new TextEncoder().encode(body).length>8192)refused();
  return{url,method,...(body?{body}:{}),provider_requests:1,automatic_retries:0,pagination:'refuse',redirect:'manual'};
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function checklistNoPagination(raw:Record<string,unknown>,count=1){
  if(['pagination','cursor','next_cursor','has_more'].some(k=>Object.hasOwn(raw,k)))refused('pagination.marker');
  if(Object.hasOwn(raw,'result_info')){
    const i=raw.result_info;
    // A complete single-page envelope is admissible; a cursor or further page is not.
    if(!object(i))refused('pagination.info.kind');
    if(Object.keys(i).some(k=>!['count','per_page','total_count','page','total_pages'].includes(k)))refused('pagination.info.fields');
    if(i.count!==count||i.total_count!==count||!Number.isSafeInteger(i.per_page)||Number(i.per_page)<count||
      (i.page!==undefined&&i.page!==1)||(i.total_pages!==undefined&&i.total_pages!==1))refused('pagination.info.counts');
  }
}
export function normalizeChecklistHttpResponse(request:ChecklistManagementRequest,httpStatus:number,raw:unknown):unknown {
  const t=request.target;
  if(!object(raw))return refused('response.kind');checklistNoPagination(raw);
  const errors=raw.errors,messages=raw.messages;
  const validErrors=Array.isArray(errors)&&errors.every(e=>object(e)&&Number.isSafeInteger(e.code)&&Number(e.code)>0&&typeof e.message==='string'&&e.message.length>0);
  if(httpStatus===404&&request.action.startsWith('inspect-')){
    // A failed named-resource response is evidence only with a complete, unambiguous envelope.
    // Workflow/Worker absence uses the exact endpoint's pinned provider code,
    // rather than English prose. All diagnostic metadata is inert: never fetched,
    // followed or used to select a target.
    const repositoryAbsence=request.action==='inspect-repository';
    const workflowAbsence=request.action==='inspect-workflow';
    const instanceAbsence=request.action==='inspect-instance';
    const workerAbsence=request.action==='inspect-app-worker'||request.action==='inspect-workflow-worker';
    const missingCode=repositoryAbsence||workflowAbsence?10200:workerAbsence?10007:instanceAbsence?10400:undefined;
    if(missingCode!==undefined)parse(targetSchema,t);
    if(Object.keys(raw).some(k=>!['success','errors','messages','result'].includes(k)))return refused('absence.envelope.fields');
    if(raw.success!==false)return refused('absence.success');
    if(!validErrors||errors.length<1)return refused('absence.errors');
    // Pinned Wrangler identifies named Workflow NOT_FOUND as 10200 and named
    // Worker NOT_FOUND as 10007. Do not admit legacy-environment code 10090.
    if(missingCode!==undefined&&errors.some(e=>e.code!==missingCode))return refused('absence.errors');
    if(!Array.isArray(messages)||messages.length!==0)return refused('absence.messages');
    if(raw.result!==null&&raw.result!==undefined)return refused('absence.result');
    const errorFields=workerAbsence?['code','message','documentation_url','source']:repositoryAbsence?['code','message','documentation_url']:['code','message'];
    if(errors.some(e=>Object.keys(e).some(k=>!errorFields.includes(k))||
      (Object.hasOwn(e,'documentation_url')&&typeof e.documentation_url!=='string')||
      (Object.hasOwn(e,'source')&&(!object(e.source)||Object.keys(e.source).some(k=>k!=='pointer')||
        (Object.hasOwn(e.source,'pointer')&&typeof e.source.pointer!=='string')))))return refused('absence.error.fields');
    // Exact-instance GET after acknowledged deletion returns this public code and
    // machine-readable message. It is not an English "not found" sentence.
    if(!workflowAbsence&&!workerAbsence&&errors.some(e=>!(instanceAbsence&&e.message==='workflows.api.error.instance.not_found')&&!/\b(not found|does not exist)\b/i.test(e.message)))return refused('absence.error.message');
    if(errors.some(e=>checklistDenialMessage(e.message)))return refused('absence.error.authorization');
    return request.action==='inspect-instance'?{absent:true,id:t.instance_id}:{absent:true,name:request.action==='inspect-repository'?t.repository:request.action==='inspect-workflow'?t.workflow:request.action==='inspect-app-worker'?t.app_worker:t.workflow_worker};
  }
  if(httpStatus<200||httpStatus>=300)return refused('http.status',{http_status:httpStatus});
  // Full step GET documents a flat body too. Other operations require the API envelope.
  let result:unknown;
  if(request.action==='full-step'&&!Object.hasOwn(raw,'success'))result=raw;
  else{
    if(raw.success!==true||!validErrors||errors.length!==0||!Array.isArray(messages)||!Object.hasOwn(raw,'result'))return refused('success.envelope');
    result=raw.result;
  }
  if(object(result))checklistNoPagination(result);
  if(request.action.startsWith('delete-')||request.action==='terminate-instance')return{accepted:true};
  if(request.action==='full-step'){
    if(!object(result)||result.status!=='complete'||result.error!==null||result.output===null||result.output===undefined||result.output==='[REDACTED]'||
      (typeof result.output==='string'&&result.output.endsWith('[truncated output]')))return refused();
    return result;
  }
  if(request.action==='create-instance'){
    if(!object(result)||result.id!==t.instance_id||!request.expected||result.version_id!==request.expected.workflow_definition_version_id||
      result.workflow_id!==request.expected.workflow_id||!['queued','running','complete','errored','terminated','waiting'].includes(String(result.status)))return refused();
    return{id:result.id,workflow_id:result.workflow_id,version_id:result.version_id};
  }
  if(request.action==='status'||request.action==='inspect-instance'){
    if(!object(result)||!request.expected||result.versionId!==request.expected.workflow_definition_version_id||(result.id!==undefined&&result.id!==t.instance_id)||
      !Array.isArray(result.steps)||result.steps.length>CHECKLIST_STEPS.length)return refused();
    const steps=result.steps.map((s:unknown)=>{
      if(!object(s)||typeof s.name!=='string'||s.type!=='step'||!Array.isArray(s.attempts)||s.attempts.length>1||
        (s.success===true&&(s.attempts.length!==1||!object(s.attempts[0])||s.attempts[0].success!==true)))return refused();
      const name=s.name.replace(/-1$/,'');if(!CHECKLIST_STEPS.includes(name as typeof CHECKLIST_STEPS[number]))return refused();
      return{name,attempt:1 as const,status:s.success===true?'complete':s.success===false?'errored':'pending'};
    });
    if(new Set(steps.map(s=>s.name)).size!==steps.length)return refused();
    return{id:t.instance_id,status:result.status==='waiting'?'running':result.status,steps};
  }
  if(request.action==='inspect-repository'){
    if(!object(result)||result.name!==t.repository)return refused();return{retained:true,name:t.repository};
  }
  if(request.action==='inspect-workflow'){
    if(!object(result)||result.name!==t.workflow||result.script_name!==t.workflow_worker||result.class_name!=='ChecklistArchiveWorkflow'||typeof result.id!=='string'||!result.id)return refused();
    return{retained:true,name:t.workflow,workflow_id:result.id};
  }
  if(request.action==='inspect-app-worker'||request.action==='inspect-workflow-worker'){
    const latest=checklistLatestDeployment(result);
    return{retained:true,name:request.action==='inspect-app-worker'?t.app_worker:t.workflow_worker,version_id:latest.versions[0].version_id};
  }
  return refused();
}
