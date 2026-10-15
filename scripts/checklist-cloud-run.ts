import { mkdir, open, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, digest, fail,StrataError } from '../src/model.js';
import { CHECKLIST_CEILINGS, type PreparedChecklist } from '../src/checklist-cloud-contract.js';
import { CHECKLIST_STEPS, verifyChecklistGrant, type ChecklistCloudResult, type ChecklistRunGrant, type ChecklistRuntimePins } from '../src/checklist-cloud-workflow.js';
import { verifyChecklistObservation, boundedChecklistJson } from '../src/checklist-cloud-app-worker.js';
import { verifyChecklistBundle } from './checklist-cloud-prepare.js';
import { artifactBundle } from '../src/artifacts-git.js';
import type { FetchTransport } from '../src/artifacts-git.js';
import { describeChecklistHttpRequest, normalizeChecklistHttpResponse, type ChecklistManagementAction } from '../src/checklist-cloud-management.js';
import { checklistNativeHttpOnce } from './checklist-cloud-http.js';
import {checklistResponseDiagnostic,checklistFailureStage} from '../src/checklist-cloud-diagnostics.js';
import {checklistReadRetry} from './checklist-cloud-read-retry.js';
import type {ChecklistSharedTestBudget} from './checklist-cloud-budget.js';
export { describeChecklistHttpRequest, normalizeChecklistHttpResponse } from '../src/checklist-cloud-management.js';

// An operator-owned transport supplies credentials out of band AFTER exact deployment/use approval.
// There is intentionally no ambient credential loader, account discovery, login or remote CLI default.
export interface ChecklistManagementPort {
  mode: 'approved-attended' | 'synthetic-test-only';
  tools: { wrangler: '4.147.0'; cf: '1.0.0-beta.12' };
  call(request: { action: ChecklistManagementAction; target: PreparedChecklist['target']; payload?: { run_id: string; grant_sha256: string; grant:ChecklistRunGrant }; step?: string; attempt?: 1;
    expected?:{workflow_id:string;workflow_definition_version_id:string} }, ticket?:object): Promise<unknown>;
  wait(ms: number): Promise<void>;
}
type ManagementTicket=object;
const managementTickets=new WeakMap<ManagementTicket,{request_sha256:string;source_sha256:string;source_verified:boolean;expires_at:number;now:()=>number}>();
// Only diagnostics produced by this response sanitizer may enter the journal.
// An injected port's arbitrary exception.details are never copied.
const responseDiagnostics=new WeakMap<StrataError,ReturnType<typeof checklistResponseDiagnostic>>();
export type ChecklistHttpPortOptions={mode:'approved-attended'|'synthetic-test-only';repository:string;app_config:string;workflow_config:string;
  app_config_sha256:string;workflow_config_sha256:string;frozen_source:{directory:string;repository:string};
  authorize_headers:()=>HeadersInit;attended_terminal:()=>boolean;synthetic_fetch?:FetchTransport};
// Management deliberately does not execute Wrangler/cf. Only one explicit native HTTPS request performs the exchange.
// Credential custody is a separately reviewed pure header supplier; no discovery/loader or SDK retry wrapper.
export function checklistHttpPort(p:PreparedChecklist,runtime:ChecklistRuntimePins,options:ChecklistHttpPortOptions):ChecklistManagementPort {
  if(options.mode==='approved-attended'&&options.synthetic_fetch)fail('CHECKLIST_MANAGEMENT_REFUSED',7,'A production transport cannot substitute an opaque HTTP callback.');
  let syntheticSourceVerified=false;
  return{mode:options.mode,tools:{wrangler:'4.147.0',cf:'1.0.0-beta.12'},wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),async call(request,ticket){
    const reservation=ticket&&managementTickets.get(ticket);
    if(!reservation||reservation.request_sha256!==digest(request)||reservation.source_sha256!==runtime.source_sha256||reservation.now()>=reservation.expires_at)
      fail('CHECKLIST_MANAGEMENT_REFUSED',7,'A fresh reserved request ticket from the consumed attended run is required.');
    managementTickets.delete(ticket!); // Consumed even when configuration, headers, HTTP, decoding or cleanup fails.
    if(canonical(request.target)!==canonical(p.target))fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Management target differs.');
    // Native HTTPS uses the already loaded host graph. The production runner verifies it immediately before the run;
    // there is no subsequent CLI/process code load. Synthetic standalone qualification verifies before its first exchange.
    if(!reservation.source_verified&&!syntheticSourceVerified){await verifyChecklistBundle(options.frozen_source.directory,options.frozen_source.repository,runtime.source_sha256,p);syntheticSourceVerified=true;}
    const appAction=request.action.includes('app-worker'),configFile=appAction?options.app_config:options.workflow_config;
    const bytes=await readFile(configFile),config=JSON.parse(new TextDecoder().decode(bytes));
    if(digest(config)!==(appAction?options.app_config_sha256:options.workflow_config_sha256)||config.account_id!==p.target.account_id||config.name!==(appAction?p.target.app_worker:p.target.workflow_worker)||
      config.workers_dev!==false||config.preview_urls!==false||config.routes?.length!==0||config.vars?.CHECKLIST_SOURCE_SHA256!==runtime.source_sha256||
      config.vars?.CHECKLIST_TARGET_SHA256!==p.target_sha256||(!appAction&&config.vars?.CHECKLIST_AUTHORIZATION_SHA256!==runtime.authorization_sha256))
      fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Exact approved private configuration required.');
    if(['delete-app-worker','delete-workflow-worker'].includes(request.action)&&!options.attended_terminal())fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Worker deletion requires the approved attended operator.');
    const description=describeChecklistHttpRequest(request);
    const headers=new Headers(options.authorize_headers());
    if([...headers.keys()].some(k=>k!=='authorization')||!/^Bearer [\x21-\x7e]{1,4096}$/.test(headers.get('authorization')??''))fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Only the protected approved Bearer header may be supplied.');
    headers.set('content-type','application/json');
    const requestBytes=new TextEncoder().encode(canonical({url:description.url,method:description.method,headers:[...headers],body:description.body??''})).length;
    if(requestBytes>CHECKLIST_CEILINGS.request_bytes||reservation.now()>=reservation.expires_at)fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Reserved request byte/time bound exceeded.');
    const input=new Request(description.url,{method:description.method,headers,body:description.body,redirect:'manual',signal:AbortSignal.timeout(Math.min(30000,reservation.expires_at-reservation.now()))});
    const response=await(options.mode==='synthetic-test-only'?options.synthetic_fetch??(()=>{throw Error('Explicit synthetic HTTP fixture required.');}):checklistNativeHttpOnce)(input);
    // Exactly one exchange: no pagination helper, SDK, CLI, redirect follow or retry path.
    if(response.status>=300&&response.status<400)fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Redirect refused.',{checklist_stage:'http.redirect'});
    if(response.headers.has('link'))fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Pagination/link refused.',{checklist_stage:'http.pagination-header'});
    let raw:unknown;try{raw=await boundedChecklistJson(response,CHECKLIST_CEILINGS.response_bytes);}catch{
      fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Bounded JSON body refused.',{checklist_stage:'http.body',http_status:response.status});}
    try{return normalizeChecklistHttpResponse(request,response.status,raw);}catch(error){
      const diagnostic=checklistResponseDiagnostic(response.status,raw);
      const safe=new StrataError('CHECKLIST_MANAGEMENT_REFUSED',7,'Sanitized response validation refused.',{
        checklist_stage:diagnostic.authorization_present?'absence.error.authorization':checklistFailureStage(error,'management.other'),http_status:response.status});
      responseDiagnostics.set(safe,diagnostic);throw safe;
    }
  }};
}

type Status = { id: string; status: 'queued' | 'running' | 'complete' | 'errored' | 'terminated'; steps: { name: string; attempt: 1; status: 'pending' | 'complete' | 'errored' }[] };
function status(raw: unknown, p: PreparedChecklist): Status {
  const s = raw as Status;
  if (!s || s.id !== p.target.instance_id || !['queued','running','complete','errored','terminated'].includes(s.status) || !Array.isArray(s.steps) || s.steps.length > CHECKLIST_STEPS.length || new Set(s.steps.map(x => x.name)).size !== s.steps.length || s.steps.some(x => !CHECKLIST_STEPS.includes(x.name as typeof CHECKLIST_STEPS[number]) || x.attempt !== 1 || !['pending','complete','errored'].includes(x.status))) fail('CHECKLIST_MANAGEMENT_REFUSED', 7, 'Exact finite instance status required.');
  // Keep only validated public status values; injected extras can contain secrets.
  return { id:s.id,status:s.status,steps:s.steps.map(({name,attempt,status})=>({name,attempt,status})) };
}
// Preserve complete first-attempt Workflow outputs; bounded host GET retries do
// not admit retried Workflow steps, previews, redaction or truncation.
function fullStep(raw: unknown) {
  const s = raw as { status: string; error: unknown; output: unknown };
  if (!s || s.status !== 'complete' || s.error !== null || s.output === null || s.output === undefined || s.output === '[REDACTED]' || (typeof s.output === 'string' && s.output.endsWith('[truncated output]'))) fail('CHECKLIST_MANAGEMENT_REFUSED', 7, 'Complete unredacted first-attempt step output required.');
  if(typeof s.output==='string'){try{return JSON.parse(s.output);}catch{fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Full step output is not complete JSON.');}}
  return structuredClone(s.output);
}
export function verifyChecklistCloudResult(raw: unknown, p: PreparedChecklist, runtime: ChecklistRuntimePins, synthetic = false): ChecklistCloudResult {
  const r = raw as ChecklistCloudResult;
  if (!r || r.format !== 'strata-checklist-cloud-result/1' || r.evidence_kind !== (synthetic ? 'synthetic-test-only' : 'remote-observation') || r.run_id !== p.target.run_id || r.instance_id !== p.target.instance_id || r.source_sha256 !== runtime.source_sha256 || r.target_sha256 !== p.target_sha256 || r.preparation_sha256 !== digest(p) || canonical(r.pins) !== canonical(p.pins) || r.cold_read_verified !== true || r.semantic_location !== 'Node' || r.runtime_location !== 'Worker' || r.invoice_cap !== false || !Array.isArray(r.observations) || r.observations.length !== 2 || r.cleanup?.unsettled_dispatches !== 0 || r.cleanup?.handles_open !== 0 || r.cleanup?.repo_tokens_issued !== (synthetic?2:3) || r.cleanup?.repo_tokens_issued !== r.cleanup?.repo_tokens_revoked || r.token_allowance_consumed !== 3 || canonical(r.cumulative_reserved) !== canonical({ ...p.qualification.reservations, repo_tokens: 3, stage_batches: 2,workflow_subrequests:p.qualification.workflow_subrequests })) fail('CHECKLIST_RESULT_REFUSED', 6, 'Complete same-Release archive/observation/cleanup result required.');
  const l = r.archive_index;
  if (!l || !/^[a-f0-9]{40}$/.test(l.ref) || !/^[a-f0-9]{64}$/.test(l.hash) || l.path !== l.hash + '.json' || !Number.isSafeInteger(l.size_bytes) || l.size_bytes! < 1 || l.size_bytes! > p.qualification.index_max_bytes || canonical(Object.keys(r.registry.entries).sort()) !== canonical(Object.keys(p.input.records).sort()) || r.registry.storage?.repository !== p.target.repository || r.registry.storage?.account !== p.target.account_id || r.registry.storage?.namespace !== p.target.namespace || r.registry.storage?.project_id !== p.target.project_id) fail('CHECKLIST_RESULT_REFUSED', 6, 'Exact archive locators required.');
  for (const [ref, e] of Object.entries(r.registry.entries)) if (e.hash !== p.input.record_hashes[ref] || e.type !== p.input.records[ref].type || e.published !== true || e.locator?.ref !== p.qualification.closure_commit || e.locator.path !== e.hash + '.json' || e.locator.hash !== e.hash || e.locator.size_bytes !== Buffer.byteLength(canonical(p.input.records[ref].data))) fail('CHECKLIST_RESULT_REFUSED', 6, 'Archive closure locator changed.');
  const storage={format:'strata-artifacts-registry/1',project_id:p.target.project_id,account:p.target.account_id,namespace:p.target.namespace,repository:p.target.repository,mode:synthetic?'strict-mock':'remote'};
  if(canonical(r.registry.storage)!==canonical(storage)||canonical(r.registry.asset_locators)!==canonical({}))fail('CHECKLIST_RESULT_REFUSED',6,'Archive storage envelope changed.');
  const indexBytes=canonical({format:'strata-checklist-cloud-archive-index/1',preparation_sha256:digest(p),source_sha256:runtime.source_sha256,target_sha256:p.target_sha256,pins:p.pins,registry:r.registry,location_claim:p.location_claim,authority_active:false,live_project_restore:false});
  const indexHash=digest(JSON.parse(indexBytes)),commit=artifactBundle([{hash:indexHash,bytes:indexBytes}]).commit;
  if(l.hash!==indexHash||l.ref!==commit||l.size_bytes!==Buffer.byteLength(indexBytes))fail('CHECKLIST_RESULT_REFUSED',6,'Archive index immutable commit/hash/size changed.');
  r.observations.forEach((o, i) => verifyChecklistObservation(o, p.pins, runtime.source_sha256, p.target_sha256, runtime.app_version_id, i === 1));
  return r;
}

export async function runAttendedChecklist(p: PreparedChecklist, rawGrant: unknown, runtime: ChecklistRuntimePins, port: ChecklistManagementPort,
  ledgerDirectory: string, now: () => number = Date.now, frozenSource?: { directory: string; repository: string },shared?:{budget:ChecklistSharedTestBudget;caseId:string}) {
  const synthetic = port.mode === 'synthetic-test-only';
  const grant: ChecklistRunGrant = verifyChecklistGrant(rawGrant, p, runtime, now(), synthetic);
  if (!synthetic) {
    if(!shared||shared.budget.synthetic)fail('CHECKLIST_SHARED_BUDGET_REFUSED',7,'The active common gross reservation is required.');
    await shared.budget.assertMutation(shared.caseId,p.target_sha256);
    if (!frozenSource) fail('CHECKLIST_SOURCE_REFUSED', 6, 'Fresh verification of the reviewed source/bundles is required before live dispatch.');
    await verifyChecklistBundle(frozenSource.directory,frozenSource.repository,runtime.source_sha256,p);
  }
  if (port.tools.wrangler !== '4.147.0' || port.tools.cf !== '1.0.0-beta.12') fail('CHECKLIST_TOOLS_REFUSED', 7, 'Pinned attended tools required.');
  // wx consumption precedes all dispatches. Never delete this ledger or resume/restart with a spent grant.
  await mkdir(ledgerDirectory, { recursive: true });
  const consumption = path.join(ledgerDirectory, runtime.authorization_sha256 + '.consumed.json');
  const file = await open(consumption, 'wx');
  try { await file.writeFile(canonical({ format: 'strata-checklist-consumed/1', grant_sha256: digest(grant), target_sha256: p.target_sha256,
    preparation_sha256: digest(p), config_sha256:grant.config_sha256,started_at: now(), evidence_kind: synthetic ? 'synthetic-test-only' : 'attended-dispatch' })); await file.sync(); } finally { await file.close(); }
  let calls = 0, work = 0, cleanup = 0, instanceAbsenceReads = 0, result: ChecklistCloudResult | undefined, terminal = false;
  let latestStatus: Status | null = null;
  const pending = new Set<Promise<unknown>>();
  const receipts: unknown[] = [], blockers: string[] = [];
  const checkpoint = async () => writeFile(consumption + '.progress.json', canonical({ calls, work, cleanup, unsettled_dispatches:pending.size,receipts, blockers, terminal, latest_status:latestStatus, result_sha256: result ? digest(result) : null }));
  async function exchange(action: ChecklistManagementAction, isCleanup: boolean, stepName?: string) {
    if (now() >= (isCleanup ? grant.cleanup_expires_at : grant.expires_at) || calls >= 33 || (isCleanup ? cleanup >= 12 : work >= 21)) fail('CHECKLIST_MANAGEMENT_BUDGET', 7, 'Prepaid attended management envelope exhausted.');
    if(isCleanup&&action==='inspect-instance'&&instanceAbsenceReads>=3)fail('CHECKLIST_CLEANUP_REFUSED',9,'Instance absence read allowance exhausted.');
    const request = { action, target: p.target,expected:{workflow_id:grant.workflow_id,workflow_definition_version_id:grant.workflow_definition_version_id},
      ...(action === 'create-instance' ? { payload: { run_id: p.target.run_id, grant_sha256: runtime.grant_sha256,grant } } : {}), ...(stepName ? { step: stepName, attempt: 1 as const } : {}) };
    if (Buffer.byteLength(canonical(request)) > CHECKLIST_CEILINGS.request_bytes) fail('CHECKLIST_MANAGEMENT_BUDGET', 7, 'Management request too large.');
    await shared?.budget.reserveRequest(shared.caseId,CHECKLIST_CEILINGS.request_bytes+CHECKLIST_CEILINGS.response_bytes);
    calls++; if (isCleanup) cleanup++; else work++;
    if(isCleanup&&action==='inspect-instance')instanceAbsenceReads++;
    receipts.push({ sequence: calls, action, request_sha256: digest(request), reserved_at: now(), state: 'reserved-before-dispatch' }); await checkpoint();
    const ticket:ManagementTicket={};managementTickets.set(ticket,{request_sha256:digest(request),source_sha256:runtime.source_sha256,source_verified:!synthetic,expires_at:isCleanup?grant.cleanup_expires_at:grant.expires_at,now});
    const dispatch = Promise.resolve().then(()=>port.call(request,ticket));pending.add(dispatch);
    void dispatch.then(()=>pending.delete(dispatch),()=>pending.delete(dispatch));
    let timer:ReturnType<typeof setTimeout>|undefined;
    let response:unknown;
    try { response=await Promise.race([dispatch,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Bounded management dispatch uncertain.')),Math.min(30000,(isCleanup?grant.cleanup_expires_at:grant.expires_at)-now()));})]); }
    catch(error){
      receipts.push({sequence:calls,action,state:'dispatch-refused',validator_stage:checklistFailureStage(error,'http.transport'),
        ...(error instanceof StrataError&&responseDiagnostics.has(error)?{diagnostic:responseDiagnostics.get(error)}:{})});await checkpoint();throw error;
    }
    finally {clearTimeout(timer);}
    if (Buffer.byteLength(canonical(response)) > CHECKLIST_CEILINGS.response_bytes) fail('CHECKLIST_MANAGEMENT_REFUSED', 7, 'Management response too large.');
    receipts.push({ sequence: calls, action, response_sha256: digest(response), state: 'returned' }); await checkpoint();
    return response;
  }
  async function call(action:ChecklistManagementAction,isCleanup:boolean,stepName?:string){
    const description=describeChecklistHttpRequest({action,target:p.target,...(stepName?{step:stepName,attempt:1 as const}:{}),
      ...(action==='create-instance'?{payload:{run_id:p.target.run_id,grant_sha256:runtime.grant_sha256,grant}}:{})});
    return checklistReadRetry(description.method,()=>exchange(action,isCleanup,stepName),{now,deadline:()=>isCleanup?grant.cleanup_expires_at:grant.expires_at,
      wait:ms=>port.wait(ms),canRetry:()=>pending.size===0&&calls<33&&(isCleanup?cleanup<12:work<21)&&(!isCleanup||action!=='inspect-instance'||instanceAbsenceReads<3),record:async record=>{receipts.push({action,...record as object});await checkpoint();}});
  }
  try {
    const created = await call('create-instance', false) as { id?: string };
    if (created?.id !== p.target.instance_id) fail('CHECKLIST_MANAGEMENT_REFUSED', 7, 'Instance creation identity differs; no retry.');
    let latest: Status | undefined;
    for (let n = 0; n < 12; n++) {
      latest = status(await call('status', false), p);
      latestStatus = latest; await checkpoint();
      if (['complete','errored','terminated'].includes(latest.status)) { terminal = true; break; }
      await port.wait(Math.min(30000, Math.max(0, grant.expires_at - now())));
    }
    if (latest?.status !== 'complete') fail('CHECKLIST_RESULT_REFUSED', 6, 'Workflow did not complete in the bounded status schedule.');
    if (latest.steps.length !== CHECKLIST_STEPS.length || latest.steps.some(s => s.status !== 'complete')) fail('CHECKLIST_RESULT_REFUSED', 6, 'All first-attempt Workflow steps required.');
    const outputs: Record<string, unknown> = {};
    for (const name of CHECKLIST_STEPS) outputs[name] = fullStep(await call('full-step', false, name));
    // Native wrapper returns the result in observe-app's full step output for exact attended reconstruction.
    result = verifyChecklistCloudResult(outputs['observe-app'], p, runtime, synthetic);
    const filename = path.join(ledgerDirectory, digest(grant) + '.result.json');
    await writeFile(filename, canonical({ result, result_sha256: digest(result), full_steps: outputs }));
  } catch { blockers.push('Run failed or uncertain; grant remains consumed. Preserve exact receipts, do not replay.'); }
  finally {
    try {
      if(pending.size){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}finally{clearTimeout(timer);}}
      if(pending.size)fail('CHECKLIST_CLEANUP_REFUSED',9,'Unsettled management dispatch requires operator reconciliation.');
      if (!terminal) {
        await call('terminate-instance', true);
        latestStatus = status(await call('status', true), p);
        terminal = ['complete','errored','terminated'].includes(latestStatus.status);
      }
      if (!terminal) fail('CHECKLIST_CLEANUP_REFUSED', 9, 'Terminal instance unverified.');
      // A failed/uncertain run cannot prove repository tokens settled. Do not delete away reconciliation evidence.
      if (!result) fail('CHECKLIST_CLEANUP_REFUSED', 9, 'Token/handle cleanup unverified; operator reconciliation required.');
      await call('delete-instance', true);
      let instanceAbsent=false;
      // Retries and polls share one allowance, reserved at each physical exchange.
      while(instanceAbsenceReads<3){
        const inspected=await call('inspect-instance',true);
        if(canonical(inspected)===canonical({absent:true,id:p.target.instance_id})){instanceAbsent=true;break;}
        // An acknowledged deletion can briefly leave the completed instance
        // readable. Poll only that exact terminal identity; never resend DELETE.
        if(status(inspected,p).status!=='complete')fail('CHECKLIST_CLEANUP_REFUSED',9,'Deleted instance unexpectedly changed state.');
        if(instanceAbsenceReads<3)await port.wait(Math.min(30000,Math.max(0,grant.cleanup_expires_at-now())));
      }
      if(!instanceAbsent)fail('CHECKLIST_CLEANUP_REFUSED',9,'Instance absence unverified.');
      if (grant.retention.repository === 'delete') {
        await call('delete-repository', true);
        if (canonical(await call('inspect-repository', true)) !== canonical({ absent: true, name: p.target.repository })) fail('CHECKLIST_CLEANUP_REFUSED', 9, 'Repository absence unverified.');
      } else if (canonical(await call('inspect-repository', true)) !== canonical({ retained: true, name: p.target.repository })) fail('CHECKLIST_CLEANUP_REFUSED', 9, 'Repository retention unverified.');
      for (const [resource, name] of [['workflow', p.target.workflow], ['app-worker', p.target.app_worker], ['workflow-worker', p.target.workflow_worker]] as const) {
        if (grant.retention.workers === 'delete') await call(('delete-' + resource) as ChecklistManagementAction, true);
        const expected = grant.retention.workers === 'delete' ? { absent: true, name } : resource === 'workflow' ?
          { retained: true, name, workflow_id: grant.workflow_id } : { retained: true, name, version_id: resource === 'app-worker' ? runtime.app_version_id : runtime.workflow_version_id };
        if (canonical(await call(('inspect-' + resource) as ChecklistManagementAction, true)) !== canonical(expected)) fail('CHECKLIST_CLEANUP_REFUSED', 9, 'Exact Worker/Workflow retention/absence unverified.');
      }
    } catch { blockers.push('Cleanup or retention incomplete. Same-target mutation remains blocked pending exact reconciliation.'); }
    await checkpoint();
  }
  return { evidence_kind: synthetic ? 'synthetic-test-only' : 'attended-operation', completed: !!result && blockers.length === 0, result:result??null,
    blockers, calls, work_calls: work, cleanup_calls: cleanup, consumed_ledger: consumption, live_invoice_verified: false };
}
