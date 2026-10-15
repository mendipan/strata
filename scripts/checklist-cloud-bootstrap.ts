import {z} from 'zod';
import {readFile,writeFile,mkdir,open,stat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,digest,bytesDigest,fail,parse,StrataError} from '../src/model.js';
import {verifyPrepared,CHECKLIST_CEILINGS,type PreparedChecklist} from '../src/checklist-cloud-contract.js';
import {checklistPrivateConfigs,checklistConfigDigest,checklistUploadMetadata} from '../src/checklist-cloud-config.js';
import {checklistAuthorizationDigest,type ChecklistRunGrant} from '../src/checklist-cloud-workflow.js';
import {boundedChecklistJson} from '../src/checklist-cloud-app-worker.js';
import {checklistNoPagination,normalizeChecklistHttpResponse} from '../src/checklist-cloud-management.js';
import {noLinks} from '../src/node-state.js';
import {verifyChecklistBundle} from './checklist-cloud-prepare.js';
import {checklistNativeHttpOnce} from './checklist-cloud-http.js';
import {checklistHttpPort,runAttendedChecklist} from './checklist-cloud-run.js';
import type {FetchTransport} from '../src/artifacts-git.js';
import {checklistResponseDiagnostic,checklistFailureStage,checklistDenialMessage,type ChecklistValidatorStage} from '../src/checklist-cloud-diagnostics.js';
import {checklistReadRetry,CHECKLIST_GET_RETRY} from './checklist-cloud-read-retry.js';
import {ChecklistSharedTestBudget} from './checklist-cloud-budget.js';
import {checklistWorkerId,checklistWorkerEntityUrl,checklistPrivateWorkerIdentity,checklistWorkerDeleteAcknowledgement,checklistPrivateWorkerAbsence} from '../src/checklist-cloud-worker-identity.js';
import {checklistLatestDeployment} from '../src/checklist-cloud-deployments.js';
import {CHECKLIST_VERSION_JSON_BYTES,checklistWorkerCreateBody,checklistWorkerObservability,checklistWorkerVersionBody,checklistWorkerVersionJson,checklistWorkerVersionPreflight,checklistWorkerVersionIdentity,checklistWorkerVersionReadback,checklistWorkerVersionConfiguration,checklistWorkerVersionDiagnostic,checklistUsageModelObservation,type ChecklistWorkerVersionBody} from './checklist-cloud-worker-version.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const checklistActivationSchema=z.object({format:z.literal('strata-checklist-cloud-activation/1'),approved:z.literal(true),
 purpose:z.enum(['app-model-diagnostic','worker-version-diagnostic']).optional(),
 approval_id:z.string().min(1).max(128),approved_at:z.number().int().nonnegative(),approval_expires_at:z.number().int().positive(),
 preparation_sha256:hash,source_sha256:hash,target_sha256:hash,config_sha256:hash,plan_sha256:hash,
 evidence_directory:z.string().min(1),credential_reference:z.literal('env:CLOUDFLARE_API_TOKEN'),existing_standard_paid_confirmed:z.literal(true),
 required_permissions_confirmed:z.tuple([z.literal('Workers Scripts Write'),z.literal('Artifacts Read/Edit')]),
 spending_limit_usd:z.literal(1),local_evidence_retention_days:z.literal(30),
 shared_budget_file:z.string().min(1).max(4096),combined_gross_spending_limit_usd:z.literal(20),
 retention:z.object({repository:z.enum(['retain','delete']),instance:z.literal('delete'),workers:z.enum(['retain','delete'])}).strict()}).strict();
export type ChecklistActivation=z.infer<typeof checklistActivationSchema>;
export const CHECKLIST_BOOTSTRAP_LIMITS=Object.freeze({work_calls:24,partial_cleanup_calls:8,total_host_calls:64,
 metadata_bytes:65536,version_json_bytes:CHECKLIST_VERSION_JSON_BYTES,transfer_bytes:CHECKLIST_CEILINGS.transfer_bytes,preflight_ms:15*60000});
export const CHECKLIST_MODEL_DIAGNOSTIC_LIMITS=Object.freeze({...CHECKLIST_BOOTSTRAP_LIMITS,work_calls:13,partial_cleanup_calls:2,total_host_calls:15});
export const CHECKLIST_VERSION_DIAGNOSTIC_LIMITS=Object.freeze({...CHECKLIST_BOOTSTRAP_LIMITS,work_calls:17,partial_cleanup_calls:0,total_host_calls:17});
const CHECKLIST_DEPLOYMENT_SETTLE_MS=60000;
type ChecklistPurpose='full-demo'|'app-model-diagnostic'|'worker-version-diagnostic';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
function refused(message='Bounded bootstrap response or target refused.',checklist_stage:ChecklistValidatorStage='bootstrap.response',details:Record<string,unknown>={}):never {
 return fail('CHECKLIST_BOOTSTRAP_REFUSED',7,message,{checklist_stage,...details});
}
const api=(p:PreparedChecklist)=>`https://api.cloudflare.com/client/v4/accounts/${p.target.account_id}`;
type Http={method:'GET'|'POST'|'PUT'|'DELETE';url:string;json?:unknown;upload?:'app'|'workflow';version_read?:true};
export function checklistBootstrapPlan(p:PreparedChecklist,source:string,purpose:ChecklistPurpose='full-demo') {
 const root=api(p),t=p.target,diagnostic=purpose==='app-model-diagnostic',versionDiagnostic=purpose==='worker-version-diagnostic',evidenceOnly=diagnostic||versionDiagnostic;
 return {format:'strata-checklist-bootstrap-plan/1',source_sha256:source,preparation_sha256:digest(p),target_sha256:p.target_sha256,
  purpose,diagnostic_only:evidenceOnly,billing_state:evidenceOnly?'unresolved':null,
  model_policy:diagnostic?'observe-only':'settings-bundled-only-with-account-create-and-exact-version-standard/1',
  retention_policy:diagnostic?'delete-diagnostic-worker':versionDiagnostic?'retain-both-private-workers-even-on-failure':'owner-selects-retain-or-delete-repository-and-workers; instance-always-delete',
  partial_setup_policy:diagnostic?'delete-acknowledged-diagnostic-worker':'honor-owner-worker-retention-even-on-failure; unresolved-setup-keeps-full-hold-and-blocks-same-target-retry',
  stop:diagnostic?'after app model observations; before second Worker or any Workflow/run':versionDiagnostic?'after second Worker exact-version comparison; before Workflow definition, instance or archive work':'attended full demo',
  config_sha256:checklistConfigDigest(p,source),limits:diagnostic?CHECKLIST_MODEL_DIAGNOSTIC_LIMITS:versionDiagnostic?CHECKLIST_VERSION_DIAGNOSTIC_LIMITS:CHECKLIST_BOOTSTRAP_LIMITS,wire_params:'json-encoded-string',get_retry:evidenceOnly?{enabled:false,maximum_attempts:1}:CHECKLIST_GET_RETRY,
  run_consumption:'after complete fresh read-only preflight, before first mutation',
  retry_semantics:evidenceOnly?'no retries for any request, including preflight and cleanup':'GET orchestration only; each reservation has one wire request and zero transport retries; Workflow step retries remain disabled',
  shared_gross_budget:{ledger:'explicit common absolute path bound in owner activation',total_cents:2000,per_attempt_cents:100,preflight_hold_cents:1},
  private_create:{endpoint:root+'/workers/workers',bodies:(diagnostic?['app'] as const:['app','workflow'] as const).map(kind=>checklistWorkerCreateBody(p,source,kind))},
  preflight:[root+'/workers/account-settings',root+`/artifacts/namespaces/${t.namespace}`,
   root+`/artifacts/namespaces/${t.namespace}/repos/${t.repository}`,root+`/workflows/${t.workflow}`,
   ...[t.app_worker,t.workflow_worker].map(name=>root+`/workers/scripts/${name}/deployments`)],
  workers:(diagnostic?[t.app_worker]:[t.app_worker,t.workflow_worker]).map(name=>({name,upload:'POST '+root+'/workers/workers/{acknowledged_worker_id}/versions?deploy=true',
   version_readback:'GET '+root+'/workers/workers/{acknowledged_worker_id}/versions/{returned_version_id}?include=modules',upload_encoding:'json-base64-exact-approved-buffer',
   subdomain:root+`/workers/scripts/${name}/subdomain`,settings:root+`/workers/scripts/${name}/settings`,deployments:root+`/workers/scripts/${name}/deployments`})),
  workflow:evidenceOnly?null:{deployment_settle_ms:CHECKLIST_DEPLOYMENT_SETTLE_MS,endpoint:root+`/workflows/${t.workflow}`,versions:root+`/workflows/${t.workflow}/versions?page=1&per_page=1`,
   body:{script_name:t.workflow_worker,class_name:'ChecklistArchiveWorkflow',limits:{steps:8},concurrency:{limit:1},default_retention:{success_retention:3600000,error_retention:3600000}}},
  late_values:diagnostic?['activation clock T/T+30/T+32','one acknowledged app Worker ID and exact version UUID','paired public model observations; billing remains unresolved']:['activation clock T/T+30/T+32','computed authorization digest','two exact returned Worker IDs for private readback/partial cleanup',
   'two exact returned Worker script version IDs',...(versionDiagnostic?['sanitized exact-version comparison; no run grant']:['exact new Workflow ID/definition version ID'])],
  exclusions:['new API credentials','renewal or rotation','permission expansion','alternate credential discovery','new namespaces','Access','tunnels','public routes','subscriptions','contributor authority']};
}
export function verifyChecklistActivation(raw:unknown,p:PreparedChecklist,source:string,now:number,synthetic=false,purpose:ChecklistPurpose='full-demo') {
 verifyPrepared(p,synthetic);const s=parse(checklistActivationSchema,raw);
 if(s.preparation_sha256!==digest(p)||s.source_sha256!==source||s.target_sha256!==p.target_sha256||s.config_sha256!==checklistConfigDigest(p,source)||
  (s.purpose??'full-demo')!==purpose||s.plan_sha256!==digest(checklistBootstrapPlan(p,source,purpose))||now<s.approved_at||now>=s.approval_expires_at||s.approval_expires_at-s.approved_at>2*3600000||
  (!synthetic&&p.input.evidence_kind!=='published-local-history'))refused('Exact unexpired owner activation and all package/config/plan pins are required.');
 if(!synthetic&&p.input.evidence_kind!=='published-local-history')refused('Only actual published local history may activate.');
 if(purpose==='app-model-diagnostic'&&(s.retention.repository!=='delete'||s.retention.workers!=='delete'))refused('Diagnostic resources must be deleted; retention is only supported for a full application run.');
 if(purpose==='worker-version-diagnostic'&&(s.retention.repository!=='retain'||s.retention.workers!=='retain'))refused('Version evidence requires retaining both Workers; no deletion authority is admitted.');
 return s;
}

export function checklistExistingTokenHeaders():HeadersInit {
 // Deferred until the activation/source/ledger checks have succeeded. No discovery,
 // login, fallback, token creation, refresh, rotation or permission repair exists.
 const value=process.env.CLOUDFLARE_API_TOKEN;
 if(typeof value!=='string'||!/^\S{1,4096}$/.test(value)||/[^\x21-\x7e]/.test(value))refused('Protected existing credential unavailable.');
 return {authorization:'Bearer '+value};
}
export function checklistMultipart(bundle:Uint8Array,filename:'app-bundle.mjs'|'workflow-bundle.mjs',metadata:unknown) {
 const json=canonical(metadata),boundary='strata-checklist-'+bytesDigest(bundle).slice(0,32);
 if(Buffer.byteLength(json)>CHECKLIST_BOOTSTRAP_LIMITS.metadata_bytes||new TextDecoder().decode(bundle).includes(boundary))refused('Multipart metadata/boundary bound refused.');
 const prefix=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}\r\nContent-Disposition: form-data; name="${filename}"; filename="${filename}"\r\nContent-Type: application/javascript+module\r\n\r\n`);
 const body=Buffer.concat([prefix,Buffer.from(bundle),Buffer.from(`\r\n--${boundary}--\r\n`)]);
 if(body.length-bundle.length>CHECKLIST_BOOTSTRAP_LIMITS.metadata_bytes)refused('Multipart overhead bound refused.');
 return {body,content_type:'multipart/form-data; boundary='+boundary};
}
function envelope(raw:unknown,count=1):unknown {
 if(!object(raw))refused();checklistNoPagination(raw,count);
 if(raw.success!==true||!Array.isArray(raw.errors)||raw.errors.length||!Array.isArray(raw.messages)||
  raw.messages.some(m=>!object(m)||!Number.isSafeInteger(m.code)||Number(m.code)<0||typeof m.message!=='string'||checklistDenialMessage(m.message))||!Object.hasOwn(raw,'result'))refused();
 return raw.result;
}
export function checklistBootstrapSettings(raw:unknown,p:PreparedChecklist,source:string,kind:'app'|'workflow',authorization='') {
 return checkSettings(raw,p,source,kind,authorization,false);
}
function checkSettings(raw:unknown,p:PreparedChecklist,source:string,kind:'app'|'workflow',authorization:string,deferModel:boolean,standardVersionConfirmed=false) {
 const expected=checklistUploadMetadata(p,source,kind,authorization);
 const sortedBindings=(v:unknown)=>{
  if(!Array.isArray(v)||v.some(b=>!object(b)||typeof b.name!=='string')||new Set(v.map(b=>b.name)).size!==v.length)return undefined;
  return [...v].sort((a,b)=>a.name.localeCompare(b.name));
 };
 const value=object(raw)?raw:{},observability=object(value.observability)?value.observability:{},traces=object(observability.traces)?observability.traces:{};
 const bindings=sortedBindings(value.bindings);
 const type=(v:unknown)=>v===undefined?'missing':v===null?'null':Array.isArray(v)?'array':typeof v;
 const equal=(a:unknown,b:unknown)=>{try{return a!==undefined&&canonical(a)===canonical(b);}catch{return false;}};
 const field=(name:string,actual:unknown,wanted:unknown,valid:boolean)=>({field:name,actual_type:type(actual),
  status:actual===undefined?'missing':!valid?'invalid-shape':equal(actual,wanted)?'match':'different'});
 // /settings is ScriptAndVersionSettings, not /script-settings. Preserve exact
 // runtime/binding checks; reuse the private-entity required enable-flag projection.
 let observabilityMatches=true;
 try{checklistWorkerObservability(raw,p,source,kind);}catch{observabilityMatches=false;}
 const diagnostic={format:'strata-checklist-settings-diagnostic/2',fields:[
  field('result',raw,raw,object(raw)),
  field('bindings',bindings??value.bindings,sortedBindings(expected.bindings),bindings!==undefined),
  field('compatibility_date',value.compatibility_date,expected.compatibility_date,typeof value.compatibility_date==='string'),
  field('compatibility_flags',value.compatibility_flags,expected.compatibility_flags,Array.isArray(value.compatibility_flags)&&value.compatibility_flags.every(v=>typeof v==='string')),
  field('limits',value.limits,expected.limits,object(value.limits)),
  field('limits.cpu_ms',object(value.limits)?value.limits.cpu_ms:undefined,expected.limits.cpu_ms,object(value.limits)&&typeof value.limits.cpu_ms==='number'),
  field('limits.subrequests',object(value.limits)?value.limits.subrequests:undefined,expected.limits.subrequests,object(value.limits)&&typeof value.limits.subrequests==='number'),
  field('observability',value.observability,value.observability,object(value.observability)),
  field('observability.enabled',observability.enabled,expected.observability.enabled,typeof observability.enabled==='boolean'),
  field('observability.traces',observability.traces,observability.traces,object(observability.traces)),
  field('observability.traces.enabled',traces.enabled,expected.observability.traces.enabled,typeof traces.enabled==='boolean'),
  field('logpush',value.logpush,false,typeof value.logpush==='boolean'),
  {...field('usage_model',value.usage_model,'standard',typeof value.usage_model==='string'),required_public_enum:'standard',
   observed_public_enum:typeof value.usage_model==='string'&&['standard','bundled','unbound'].includes(value.usage_model)?value.usage_model:'[redacted]'}],
  arbitrary_result_values_retained:false,public_enums_retained:true};
 // The d01 API returned Standard on account/create/exact-version GET but Bundled
 // on this legacy surface. Admit only that combination, after exact version/module
 // and active deployment checks. This is not an assertion about billed charges.
 const legacyBundled=standardVersionConfirmed&&value.usage_model==='bundled';
 if(!observabilityMatches||diagnostic.fields.some(f=>f.status!=='match'&&(!(deferModel||legacyBundled)||f.field!=='usage_model')))
  refused('Reviewed settings fields must read back.','bootstrap.response',{settings_diagnostic:diagnostic});
}
export type ChecklistBootstrapOptions={mode:'approved-attended'|'synthetic-test-only';repository:string;package_directory:string;
 purpose?:'app-model-diagnostic'|'worker-version-diagnostic';
 evidence_directory:string;attended_terminal:()=>boolean;authorize_headers:()=>HeadersInit;now?:()=>number;synthetic_fetch?:FetchTransport;
 // Synthetic qualification may stop after bootstrap; production always hands off to the consumed attended runner.
 synthetic_bootstrap_only?:boolean;preflight_only?:boolean;shared_budget?:ChecklistSharedTestBudget};

export async function activateAttendedChecklist(p:PreparedChecklist,source:string,rawApproval:unknown,options:ChecklistBootstrapOptions) {
 const synthetic=options.mode==='synthetic-test-only',now=options.now??Date.now,purpose=options.purpose??'full-demo',diagnostic=purpose==='app-model-diagnostic',versionDiagnostic=purpose==='worker-version-diagnostic',evidenceOnly=diagnostic||versionDiagnostic;
 const limits=diagnostic?CHECKLIST_MODEL_DIAGNOSTIC_LIMITS:versionDiagnostic?CHECKLIST_VERSION_DIAGNOSTIC_LIMITS:CHECKLIST_BOOTSTRAP_LIMITS;
 const diagnosticOutput=evidenceOnly?{purpose,diagnostic_only:true,billing_state:'unresolved',diagnostic_complete:false}:{};
 if(!synthetic&&(options.synthetic_fetch||options.synthetic_bootstrap_only))refused('Production cannot substitute synthetic transport or omit its attended run.');
 const scope=verifyChecklistActivation(rawApproval,p,source,now(),synthetic,purpose);
 if(!path.isAbsolute(scope.shared_budget_file)||
  (options.shared_budget&&path.resolve(scope.shared_budget_file)!==path.resolve(options.shared_budget.file))||
  (!synthetic&&(!options.shared_budget||options.shared_budget.synthetic)))refused('The owner-bound common gross ledger with a reconciled prior baseline is required.','budget.exhausted');
 if(!options.attended_terminal()||path.resolve(scope.evidence_directory)!==path.resolve(options.evidence_directory)||
  !path.relative(path.resolve(options.repository),path.resolve(options.evidence_directory)).startsWith('..'))refused('Exact external attended evidence directory required.');
 const verifiedSource=await verifyChecklistBundle(options.package_directory,options.repository,source,p);
 if((verifiedSource.purpose??'full-demo')!==purpose)refused('Frozen disabled-package purpose differs from CLI/activation/plan.');
 const disabled=checklistPrivateConfigs(p,source);
 for(const [file,expected] of [['wrangler.app.jsonc',disabled.app],['wrangler.workflow.jsonc',disabled.workflow]] as const)
  if(canonical(JSON.parse(await readFile(path.join(options.package_directory,file),'utf8')))!==canonical(expected))refused('Disabled reviewed configuration differs.');
 checklistWorkerVersionPreflight(p,source);
 // External artifacts may never be placed in a different Git checkout either.
 for(let ancestor=path.resolve(options.evidence_directory);path.dirname(ancestor)!==ancestor;ancestor=path.dirname(ancestor)){
  try{await stat(path.join(ancestor,'.git'));refused('Evidence cannot be written into a product checkout.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
 await mkdir(options.evidence_directory,{recursive:true});await noLinks(options.evidence_directory);
 if((await readdir(options.evidence_directory)).length)refused('A new empty external evidence directory is required; never resume a consumed activation.');
 const budget=options.shared_budget,caseId=digest(scope);await budget?.begin(caseId,p.target_sha256);
 const journal=await open(path.join(options.evidence_directory,'bootstrap-reservations.jsonl'),'ax');
 let work=0,cleanup=0,bytes=0,deadline=Math.min(scope.approval_expires_at,now()+limits.preflight_ms),authorization='',lastResponseSha='';
 let handedOff=false,complete=false,activationConsumed=false,preflightPhase=true,mutationDispatches=0,diagnosticComplete=false;const owned:{kind:'app'|'workflow';name:string;id:string}[]=[];
 const verifiedAbsent=new Set<string>();
 let ownedWorkflow=false;const possible:string[]=[],blockers:string[]=[];
 const append=async(record:unknown)=>{await journal.write(canonical(record)+'\n');await journal.sync();};
 const root=api(p),t=p.target;
 const uploadExpectations=new Map<'app'|'workflow',ChecklistWorkerVersionBody>();
 const observations:unknown[]=[];let accountModel:ReturnType<typeof checklistUsageModelObservation>|null=null;
 async function observe(endpoint:'version-create'|'version-get'|'settings-get',raw:unknown,workerId:string,versionId:string,workerName:string){
  const observation={endpoint,sequence:work+cleanup,response_sha256:lastResponseSha,worker_id:workerId,version_id:versionId,
   worker_name:workerName,model:checklistUsageModelObservation(raw),billing_state:'unresolved',accepted_configuration:false};
  await append({state:diagnostic?'app-model-observation':'worker-model-observation',purpose,...observation});observations.push(observation);return observation;
 }
 async function exchange(description:Http,isCleanup=false) {
  if(!options.attended_terminal()||now()>=deadline||(isCleanup?cleanup>=limits.partial_cleanup_calls:work>=limits.work_calls)||work+cleanup>=limits.total_host_calls||work+cleanup>=limits.work_calls+limits.partial_cleanup_calls)refused('Reserved bootstrap time/call allowance exhausted.');
  if(preflightPhase&&work>=(diagnostic?6:CHECKLIST_GET_RETRY.maximum_preflight_exchanges))refused('Read-only preflight exchange allowance exhausted.','budget.exhausted');
  const u=new URL(description.url);if(u.origin!=='https://api.cloudflare.com'||!u.pathname.startsWith(`/client/v4/accounts/${t.account_id}/`)||u.username||u.password||u.hash)refused();
  let body:Buffer|undefined,content='application/json';
  if(description.upload){const filename=(description.upload+'-bundle.mjs') as 'app-bundle.mjs'|'workflow-bundle.mjs';
   const expected=verifiedSource.outputs.find(output=>output.path===filename),bundle=await readFile(path.join(options.package_directory,filename));
   // Bind the actual upload buffer to the approved manifest, then use that same
   // buffer for base64 construction. A later disk restore cannot bless bytes.
   if(!expected||bundle.length!==expected.size_bytes||bytesDigest(bundle)!==expected.sha256)refused('Actual upload bytes differ from the approved bundle.');
   const expectedBody=checklistWorkerVersionBody(bundle,p,source,description.upload,authorization);
   const json=checklistWorkerVersionJson(expectedBody);if(Buffer.byteLength(json)>CHECKLIST_BOOTSTRAP_LIMITS.version_json_bytes)refused('Bounded base64 version upload exceeded.');
   body=Buffer.from(json);uploadExpectations.set(description.upload,expectedBody);
  }else if(description.json!==undefined){const json=canonical(description.json);if(Buffer.byteLength(json)>CHECKLIST_CEILINGS.request_bytes)refused();body=Buffer.from(json);}
  const responseLimit=description.version_read||description.upload?CHECKLIST_BOOTSTRAP_LIMITS.version_json_bytes:CHECKLIST_CEILINGS.response_bytes;
  const reservedBytes=(body?.length??0)+8192+responseLimit;
  if(bytes+reservedBytes+p.qualification.reservations.bytes+33*(CHECKLIST_CEILINGS.request_bytes+CHECKLIST_CEILINGS.response_bytes)>CHECKLIST_CEILINGS.transfer_bytes)refused('Aggregate bootstrap/run transfer reservation exhausted.');
  await budget?.reserveRequest(caseId,reservedBytes);
  if(isCleanup)cleanup++;else work++;bytes+=reservedBytes;
  await append({phase:isCleanup?'partial-cleanup':'bootstrap',sequence:work+cleanup,method:description.method,url:description.url,
   body_sha256:body?bytesDigest(body):null,...(description.upload?{requested_usage_model:'standard'}:{}),
   reserved_bytes:reservedBytes,state:'reserved-before-dispatch',time:now()});
  const headers=new Headers(options.authorize_headers());
  if([...headers.keys()].some(k=>k!=='authorization')||!/^Bearer [\x21-\x7e]{1,4096}$/.test(headers.get('authorization')??''))refused('Only protected existing Bearer header is admitted.');
  headers.set('content-type',content);
  if(now()>=deadline)refused('Bootstrap reservation expired before dispatch.');
  const input=new Request(description.url,{method:description.method,headers,body:body?new TextDecoder('utf-8',{fatal:true}).decode(body):undefined,redirect:'manual',signal:AbortSignal.timeout(Math.min(30000,deadline-now()))});
  if(description.method!=='GET')mutationDispatches++;
  const response=await(synthetic?options.synthetic_fetch??(()=>{throw Error('Explicit synthetic transport required.');}):checklistNativeHttpOnce)(input);
  if(response.status>=300&&response.status<400)refused('No redirect is allowed.','http.redirect');
  if(response.headers.has('link'))refused('No pagination followup is allowed.','http.pagination-header');
  let raw:unknown;try{raw=await boundedChecklistJson(response,responseLimit);}catch{
   await append({sequence:work+cleanup,state:'response-body-refused',http_status:response.status,validator_stage:'http.body'});refused('Bounded JSON response required.','http.body');}
  const responseDiagnostic=checklistResponseDiagnostic(response.status,raw);
  lastResponseSha=digest(raw);
  await append({sequence:work+cleanup,state:'returned',http_status:response.status,response_sha256:lastResponseSha,diagnostic:responseDiagnostic});
  if(CHECKLIST_GET_RETRY.transient_statuses.includes(response.status as typeof CHECKLIST_GET_RETRY.transient_statuses[number]))
   refused('Transient HTTP response; only safe GET retry may be admitted.',
    responseDiagnostic.authorization_present?'absence.error.authorization':'http.status',{http_status:response.status});
  return {raw,status:response.status};
 }
 async function call(description:Http,isCleanup=false){if(evidenceOnly)return exchange(description,isCleanup);return checklistReadRetry(description.method,()=>exchange(description,isCleanup),{
  now,deadline:()=>deadline,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),record:append,
  canRetry:()=>options.attended_terminal()&&(isCleanup?cleanup<8:work<24)&&(!preflightPhase||work<CHECKLIST_GET_RETRY.maximum_preflight_exchanges)});}
 async function validate<T>(callback:()=>T,fallback:ChecklistValidatorStage){try{return callback();}catch(error){
  await append({state:'response-validator-refused',sequence:work+cleanup,validator_stage:checklistFailureStage(error,fallback)});throw error;}}
 async function success(description:Http,count=1){const r=await call(description);return validate(()=>{
  if(r.status<200||r.status>=300)refused('Successful HTTP response required.','http.status',{http_status:r.status});return envelope(r.raw,count);},'bootstrap.response');}
 async function requireAbsent(action:'inspect-repository'|'inspect-workflow'|'inspect-app-worker'|'inspect-workflow-worker',url:string){
  const r=await call({method:'GET',url});const v=await validate(()=>normalizeChecklistHttpResponse({action,target:t},r.status,r.raw),'bootstrap.absence');
  if(!object(v)||v.absent!==true)refused('Approved names must all be absent before any mutation.');
 }
 try{
  const account=await success({method:'GET',url:root+'/workers/account-settings'});
  accountModel=checklistUsageModelObservation(account,'default_usage_model');await append({state:diagnostic?'app-model-account-context':'worker-model-account-context',purpose,sequence:work,response_sha256:lastResponseSha,model:accountModel,billing_state:'unresolved'});
  if(!object(account)||account.default_usage_model!=='standard')refused('Existing Standard account settings required; no subscription change.');
  const ns=await success({method:'GET',url:root+`/artifacts/namespaces/${t.namespace}`});
  if(!object(ns)||ns.namespace!==t.namespace)refused('Exact existing eligible Artifacts namespace required.');
  await requireAbsent('inspect-repository',root+`/artifacts/namespaces/${t.namespace}/repos/${t.repository}`);
  await requireAbsent('inspect-workflow',root+`/workflows/${t.workflow}`);
  await requireAbsent('inspect-app-worker',root+`/workers/scripts/${t.app_worker}/deployments`);
  await requireAbsent('inspect-workflow-worker',root+`/workers/scripts/${t.workflow_worker}/deployments`);
  preflightPhase=false;
  if(options.preflight_only)return{...diagnosticOutput,prepared:false,preflight_verified:true,activation_consumed:false,completed:false,synthetic_only:synthetic,work_calls:work,mutations:0,blockers:[] as string[]};
  await budget?.assertNoUnreconciledMutation(caseId);
  await budget?.promote(caseId,p.qualification.reservations.bytes);
  const consumed=await open(path.join(options.evidence_directory,digest(scope)+'.activation-consumed.json'),'wx');
  try{await consumed.writeFile(canonical({format:'strata-checklist-activation-consumed/1',activation_sha256:digest(scope),config_sha256:scope.config_sha256,time:now(),synthetic_only:synthetic}));await consumed.sync();}finally{await consumed.close();}
  activationConsumed=true;
  const started=now();if(started>=scope.approval_expires_at)refused();deadline=started+CHECKLIST_CEILINGS.run_ms;
  const base={format:'strata-checklist-cloud-run-grant/1' as const,approved:true as const,approval_id:scope.approval_id,
   preparation_sha256:digest(p),source_sha256:source,target_sha256:p.target_sha256,config_sha256:scope.config_sha256,
   started_at:started,expires_at:deadline,cleanup_expires_at:deadline+CHECKLIST_CEILINGS.cleanup_ms,
   metered_charges_accepted:true as const,spending_limit_usd:1,retention:scope.retention};
  authorization=diagnostic?'':versionDiagnostic?digest({purpose,activation_sha256:digest(scope),runtime_authorized:false}):digest(base);
  const active=checklistPrivateConfigs(p,source,authorization);
  if(!evidenceOnly){
   await writeFile(path.join(options.evidence_directory,'run-authorization.json'),canonical({authorization:base,authorization_sha256:authorization}));
   await writeFile(path.join(options.evidence_directory,'activated-workflow.jsonc'),canonical(active.workflow));}
  const versions:Partial<Record<'app'|'workflow',string>>={};
  for(const kind of (diagnostic?['app'] as const:['app','workflow'] as const)){
   const name=kind==='app'?t.app_worker:t.workflow_worker;possible.push(name);
   const created=await success({method:'POST',url:root+'/workers/workers',json:checklistWorkerCreateBody(p,source,kind)});
   // Capture acknowledged ownership before checking other response properties.
   if(!object(created)||created.name!==name||!checklistWorkerId(created.id))refused();owned.push({kind,name,id:created.id});
   await append({state:'owned-worker',kind,name,id:created.id});checklistPrivateWorkerIdentity(created,name);
   const entity=checklistWorkerEntityUrl(t.account_id,created.id);
   const privateRead=await success({method:'GET',url:entity});
   checklistPrivateWorkerIdentity(privateRead,name,created.id);checklistWorkerObservability(privateRead,p,source,kind);
   const uploadRaw=await success({method:'POST',url:entity+'/versions?deploy=true',upload:kind}),uploaded=checklistWorkerVersionIdentity(uploadRaw);
   const createModel=await observe('version-create',uploadRaw,created.id,uploaded.id,name);
   const versionRaw=await success({method:'GET',url:entity+'/versions/'+encodeURIComponent(uploaded.id)+'?include=modules',version_read:true});
   checklistWorkerVersionIdentity(versionRaw,uploaded.id);
   const versionModel=await observe('version-get',versionRaw,created.id,uploaded.id,name);
   if(versionDiagnostic&&kind==='workflow'){
    const comparison=checklistWorkerVersionDiagnostic(versionRaw,uploaded,uploadExpectations.get(kind)!);
    let required_configuration_check:'match'|'refused'='match';
    try{checklistWorkerVersionReadback(versionRaw,uploaded,uploadExpectations.get(kind)!);}catch{required_configuration_check='refused';}
    await append({state:'worker-version-diagnostic-complete',purpose,sequence:work,worker_id:created.id,version_id:uploaded.id,
     response_sha256:lastResponseSha,diagnostic:comparison,required_configuration_check,accepted_configuration:false,
     billing_state:'unresolved',app_executed:false,runtime_grant_created:false,archive_written:false});
    diagnosticComplete=true;blockers.push('Version evidence collected only; no Workflow instance, archive work or application execution was authorized.');
    return{...diagnosticOutput,diagnostic_complete:true,required_configuration_check,prepared:false,completed:false,
     activation_consumed:activationConsumed,synthetic_only:synthetic,work_calls:work,blockers};
   }
   let proof;
   try{proof=(diagnostic?checklistWorkerVersionConfiguration:checklistWorkerVersionReadback)(versionRaw,uploaded,uploadExpectations.get(kind)!);}
   catch(error){
    await append({state:'worker-version-validator-refused',sequence:work+cleanup,kind,worker_id:created.id,version_id:uploaded.id,response_sha256:lastResponseSha,
     diagnostic:checklistWorkerVersionDiagnostic(versionRaw,uploaded,uploadExpectations.get(kind)!)});
    throw error;
   }
   await append({state:'verified-worker-version',kind,worker_id:created.id,...proof});
   versions[kind]=uploaded.id;
   const deployment=checklistLatestDeployment(await success({method:'GET',url:root+`/workers/scripts/${name}/deployments`}),true);
   if(deployment.versions[0].version_id!==uploaded.id)refused('Exact uploaded version at 100% is required.');
   const sub=await success({method:'GET',url:root+`/workers/scripts/${name}/subdomain`});
   if(!object(sub)||sub.enabled!==false||sub.previews_enabled!==false)refused('Public endpoints must remain disabled.');
   const settingsRead=await success({method:'GET',url:root+`/workers/scripts/${name}/settings`});
   const settingsModel=await observe('settings-get',settingsRead,created.id,uploaded.id,name);
   const standardVersionConfirmed=[accountModel,createModel.model,versionModel.model].every(v=>v?.predicate==='match');
   try{checkSettings(settingsRead,p,source,kind,authorization,diagnostic,standardVersionConfirmed);}catch(error){
    // Only this fixed per-field diagnostic is persisted, never response values or
    // arbitrary exception details/text. The pure validator constructs it above.
    if(error instanceof StrataError&&error.code==='CHECKLIST_BOOTSTRAP_REFUSED')
     await append({state:'settings-validator-refused',sequence:work+cleanup,validator_stage:'bootstrap.response',diagnostic:error.details});
    throw error;
   }
   if(!diagnostic)await append({state:'worker-model-policy',kind,worker_id:created.id,version_id:uploaded.id,
    policy:checklistBootstrapPlan(p,source).model_policy,billing_state:'unresolved',
    decision:settingsModel.model.public_enum==='bundled'?'legacy-settings-with-standard-version':'standard-settings',
    observation_sequences:[createModel.sequence,versionModel.sequence,settingsModel.sequence]});
   if(diagnostic){
    const modelCheck=[createModel,versionModel,settingsModel].every(v=>v?.model.predicate==='match')?'match':'refused';
    await append({state:'app-model-diagnostic-paired',purpose,format:'strata-app-model-diagnostic/1',billing_state:'unresolved',
     source_sha256:source,preparation_sha256:digest(p),target_sha256:p.target_sha256,config_sha256:scope.config_sha256,plan_sha256:scope.plan_sha256,activation_sha256:digest(scope),
     worker_id:created.id,version_id:uploaded.id,account_default_context:accountModel,observations,required_model_check:modelCheck,
     accepted_configuration:false,app_executed:false,full_demo_completed:false});
    diagnosticComplete=true;blockers.push('Diagnostic only; billing remains unresolved. No full demo or run grant was produced.');
    return{...diagnosticOutput,diagnostic_complete:true,required_model_check:modelCheck,prepared:false,completed:false,
     activation_consumed:activationConsumed,synthetic_only:synthetic,work_calls:work,blockers};
   }
  }
  if(evidenceOnly)refused('Diagnostic collection cannot enter Workflow or run phases.');
  // Control deployment timing before the first Workflow write. This is not a
  // readiness assertion or a retry of a failed/uncertain instance.
  await append({state:'deployment-settle-start',duration_ms:CHECKLIST_DEPLOYMENT_SETTLE_MS,time:now(),synthetic_only:synthetic});
  if(!synthetic)await new Promise(resolve=>setTimeout(resolve,CHECKLIST_DEPLOYMENT_SETTLE_MS));
  await append({state:'deployment-settle-finish',time:now(),synthetic_only:synthetic});
  possible.push(t.workflow);
  await success({method:'PUT',url:root+`/workflows/${t.workflow}`,json:checklistBootstrapPlan(p,source).workflow!.body});
  ownedWorkflow=true;await append({state:'owned-workflow',name:t.workflow});
  const wf=await success({method:'GET',url:root+`/workflows/${t.workflow}`});
  if(!object(wf)||!uuid(wf.id)||wf.name!==t.workflow||wf.script_name!==t.workflow_worker||wf.class_name!=='ChecklistArchiveWorkflow'||
    wf.script_deleted===true||(wf.schedules!==undefined&&canonical(wf.schedules)!=='[]'))refused('Exact native Workflow metadata differs.');
  const listed=await success({method:'GET',url:root+`/workflows/${t.workflow}/versions?page=1&per_page=1`});
  if(!Array.isArray(listed)||listed.length!==1||!object(listed[0])||!uuid(listed[0].id)||listed[0].workflow_id!==wf.id||
   listed[0].class_name!=='ChecklistArchiveWorkflow'||listed[0].language!=='javascript'||canonical(listed[0].limits)!==canonical({steps:8})||
   canonical(listed[0].concurrency)!==canonical({limit:1})||canonical(listed[0].default_retention)!==canonical({success_retention:3600000,error_retention:3600000}))refused('One exact native Workflow definition version with reviewed limits is required.');
  const grant:ChecklistRunGrant={...base,app_version_id:versions.app!,workflow_version_id:versions.workflow!,workflow_id:wf.id,workflow_definition_version_id:listed[0].id};
  if(checklistAuthorizationDigest(grant)!==authorization)refused('Predeployment authorization cycle refused.');
  const runtime={source_sha256:source,grant_sha256:digest(grant),authorization_sha256:authorization,workflow_version_id:grant.workflow_version_id,app_version_id:grant.app_version_id};
  await writeFile(path.join(options.evidence_directory,'bound-grant.json'),canonical({grant,runtime,active_config_sha256:digest(active.workflow)}));
  if(synthetic&&options.synthetic_bootstrap_only){complete=true;const result={prepared:true,synthetic_only:true,grant,runtime,work_calls:work,blockers:[] as string[]};return result as typeof result&{completed?:boolean;activation_consumed?:boolean};}
  const port=checklistHttpPort(p,runtime,{mode:options.mode,repository:options.repository,app_config:path.join(options.package_directory,'wrangler.app.jsonc'),
   workflow_config:path.join(options.evidence_directory,'activated-workflow.jsonc'),app_config_sha256:digest(active.app),workflow_config_sha256:digest(active.workflow),
   frozen_source:{directory:options.package_directory,repository:options.repository},authorize_headers:options.authorize_headers,attended_terminal:options.attended_terminal,synthetic_fetch:options.synthetic_fetch});
  const attended={...port,async call(request:Parameters<typeof port.call>[0],ticket?:object){
   if(request.action==='create-instance'){await budget?.runtimeDispatch(caseId);handedOff=true;await append({state:'instance-dispatch-boundary',instance_id:t.instance_id,grant_sha256:digest(grant)});}
   return port.call(request,ticket);
  }};
  const run=await runAttendedChecklist(p,grant,runtime,attended,options.evidence_directory,now,{directory:options.package_directory,repository:options.repository},budget?{budget,caseId}:undefined);
  complete=run.completed;const result={...run,bootstrap_work_calls:work,total_host_calls:work+run.calls,synthetic_only:synthetic};
  return result as typeof result&{prepared?:boolean;activation_consumed?:boolean};
 }catch(error){
  await append({state:'bootstrap-refused',validator_stage:checklistFailureStage(error,'bootstrap.response'),activation_consumed:activationConsumed});
  blockers.push(activationConsumed?'Mutation phase failed or uncertain; activation remains consumed. Reconcile before another same-target attempt.':'Read-only preflight refused; no mutating authorization was consumed.');
  return {...diagnosticOutput,prepared:false,completed:false,synthetic_only:synthetic,activation_consumed:activationConsumed,work_calls:work,blockers};
 }finally{
  if(!handedOff&&scope.retention.workers==='delete'){
   deadline=Math.min(deadline+CHECKLIST_CEILINGS.cleanup_ms,now()+CHECKLIST_CEILINGS.cleanup_ms);
   const remove=async(description:Http,inspect:Http,action:'inspect-workflow'|'inspect-app-worker'|'inspect-workflow-worker')=>{
    try{const d=await call(description,true);if(d.status<200||d.status>=300)refused();
     await validate(()=>action==='inspect-workflow'?envelope(d.raw):checklistWorkerDeleteAcknowledgement(d.status,d.raw),'bootstrap.response');
     const r=await call(inspect,true),v=await validate(()=>action==='inspect-workflow'?normalizeChecklistHttpResponse({action,target:t},r.status,r.raw):checklistPrivateWorkerAbsence(r.status,r.raw),'bootstrap.absence');
     if(!object(v)||v.absent!==true)refused();verifiedAbsent.add(inspect.url);await append({state:'verified-absent',url:description.url});
    }catch{blockers.push('Partial setup cleanup unverified: '+description.url);}
   };
   if(ownedWorkflow)await remove({method:'DELETE',url:root+`/workflows/${t.workflow}`},{method:'GET',url:root+`/workflows/${t.workflow}`},'inspect-workflow');
   for(const worker of [...owned].reverse())await remove({method:'DELETE',url:checklistWorkerEntityUrl(t.account_id,worker.id)},
    {method:'GET',url:checklistWorkerEntityUrl(t.account_id,worker.id)},worker.kind==='app'?'inspect-app-worker':'inspect-workflow-worker');
  }else if(!handedOff&&possible.length){
   // Retention is an authorization boundary on failure as well as success. Keep
   // acknowledged identities and uncertainty; never turn retain into DELETE.
   await append({state:'partial-setup-retained',retention:scope.retention,acknowledged_workers:owned,acknowledged_workflow:ownedWorkflow,
    possible_targets:possible,readback_complete:false,runtime_dispatched:false});
   blockers.push('Setup resources retained as requested; incomplete setup keeps the full reservation and blocks another same-target attempt.');
  }
  const unverified=possible.filter(name=>{
   if(name===t.workflow)return !verifiedAbsent.has(root+`/workflows/${name}`);
   const worker=owned.find(w=>w.name===name);
   return !worker||!verifiedAbsent.has(checklistWorkerEntityUrl(t.account_id,worker.id));
  });
  let budgetFinalizationFailed=false;
  try{await budget?.close(caseId,mutationDispatches>0&&((handedOff&&!complete)||(!handedOff&&unverified.length>0)),handedOff);}
  catch{budgetFinalizationFailed=true;complete=false;blockers.push('Shared budget finalization unverified; retain the full reservation and reconcile its lease before another mutation.');}
  try{await append({...diagnosticOutput,...(evidenceOnly?{diagnostic_complete:diagnosticComplete}:{}),state:'bootstrap-final',work_calls:work,partial_cleanup_calls:cleanup,reserved_transfer_bytes:bytes,handed_off:handedOff,activation_consumed:activationConsumed,mutation_dispatches:mutationDispatches,
    completed:complete,possible_targets:possible,acknowledged_workers:owned,acknowledged_workflow:ownedWorkflow,blockers});
  }finally{await journal.close();}
  if(budgetFinalizationFailed)refused('Shared budget finalization unverified.','budget.exhausted');
 }
}

export function checklistBootstrapCliOptions(mode?:string):Pick<ChecklistBootstrapOptions,'purpose'|'preflight_only'> {
 if(mode==='--app-model-diagnostic')return{purpose:'app-model-diagnostic'};
 if(mode==='--worker-version-diagnostic')return{purpose:'worker-version-diagnostic'};
 if(mode===undefined||mode==='--preflight')return{preflight_only:mode==='--preflight'};
 return refused('Only --preflight or an explicitly approved --app-model-diagnostic / --worker-version-diagnostic purpose is supported.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [directory,approvalFile,evidence,repository,mode,...extra]=process.argv.slice(2),cliOptions=checklistBootstrapCliOptions(mode);
 if(extra.length)refused('Unexpected bootstrap arguments.');
 if(![directory,approvalFile,evidence,repository].every(Boolean))refused('Explicit reviewed package, owner approval, new external evidence directory and repository are required.');
 const p=JSON.parse(await readFile(path.join(directory,'preparation.json'),'utf8')) as PreparedChecklist;
 const source=JSON.parse(await readFile(path.join(directory,'source-manifest.json'),'utf8')).source_sha256 as string;
 const approval=JSON.parse(await readFile(approvalFile,'utf8'));
 const result=await activateAttendedChecklist(p,source,approval,{mode:'approved-attended',repository,
  package_directory:directory,evidence_directory:evidence,attended_terminal:()=>!!(process.stdin.isTTY&&process.stdout.isTTY),authorize_headers:checklistExistingTokenHeaders,
  shared_budget:new ChecklistSharedTestBudget(approval.shared_budget_file),...cliOptions});
 console.log(canonical(result));
}
