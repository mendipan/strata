import { digest, fail } from './model.js';
import { CHECKLIST_CEILINGS } from './checklist-cloud-limits.js';
import type { PreparedChecklist } from './checklist-cloud-contract.js';

// Whole-instance accounting. Paid supports this value (10,000 default; 10,000,000 max).
export const CHECKLIST_WORKFLOW_SUBREQUESTS = 256;
export function checklistSubrequestQualification(uniqueObjects:number,records:number) {
  const phases={closure:uniqueObjects+9,index:7,cold_read:records+5};
  const archive=Object.values(phases).reduce((a,b)=>a+b,0);
  // Eight additional platform/lifecycle/state exchanges per step is conservative
  // headroom, not measured provider usage. The native limit is the hard stop.
  const platform_overhead_allowance=8*8;
  const maximum_known=archive+CHECKLIST_CEILINGS.app_requests;
  const total_reserved=maximum_known+platform_overhead_allowance;
  if(total_reserved>CHECKLIST_WORKFLOW_SUBREQUESTS)fail('CHECKLIST_SUBREQUEST_REFUSED',7,'Whole-instance allowance exceeds the supported pinned configuration.');
  return {scope:'whole-instance' as const,phases,planned_known:archive+2,maximum_known,
    platform_overhead_allowance,total_reserved,configured_limit:CHECKLIST_WORKFLOW_SUBREQUESTS,provider_internal_usage_measured:false as const};
}
export function checklistPrivateConfigs(p:PreparedChecklist,source:string,authorization='') {
  const common={account_id:p.target.account_id,compatibility_date:'2026-10-12',compatibility_flags:['nodejs_compat'],no_bundle:true,
    workers_dev:false,preview_urls:false,routes:[],send_metrics:false,observability:{enabled:true,traces:{enabled:true}},
    version_metadata:{binding:'CHECKLIST_VERSION'},vars:{CHECKLIST_SOURCE_SHA256:source,CHECKLIST_TARGET_SHA256:p.target_sha256}};
  const app={...common,name:p.target.app_worker,main:'app-bundle.mjs',limits:{cpu_ms:1000,subrequests:1}};
  const workflow={...common,name:p.target.workflow_worker,main:'workflow-bundle.mjs',limits:{cpu_ms:1000,subrequests:CHECKLIST_WORKFLOW_SUBREQUESTS},
    vars:{...common.vars,CHECKLIST_AUTHORIZATION_SHA256:authorization},
    artifacts:[{binding:'ARTIFACTS',namespace:p.target.namespace,remote:false}],services:[{binding:'CHECKLIST_APP',service:p.target.app_worker,environment:'production'}],
    workflows:[{binding:'CHECKLIST_ARCHIVE',name:p.target.workflow,class_name:'ChecklistArchiveWorkflow',limits:{steps:8},concurrency:{limit:1},
      default_retention:{success_retention:3600000,error_retention:3600000}}]};
  return {app,workflow};
}
export function checklistConfigDigest(p:PreparedChecklist,source:string) {
  const c=checklistPrivateConfigs(p,source);
  return digest({app_sha256:digest(c.app),workflow_sha256:digest(c.workflow)});
}
export function checklistUploadMetadata(p:PreparedChecklist,source:string,kind:'app'|'workflow',authorization='') {
  const config=checklistPrivateConfigs(p,source,authorization)[kind];
  const bindings:Record<string,string>[]=[...Object.entries(config.vars).map(([name,text])=>({type:'plain_text',name,text})),{type:'version_metadata',name:'CHECKLIST_VERSION'}];
  if(kind==='workflow')bindings.push({type:'artifacts',name:'ARTIFACTS',namespace:p.target.namespace},
    // Exact-version GET returns the service's production environment explicitly.
    // Pin it in the request too; keep version/settings equality fully strict.
    {type:'service',name:'CHECKLIST_APP',service:p.target.app_worker,environment:'production'},
    {type:'workflow',name:'CHECKLIST_ARCHIVE',workflow_name:p.target.workflow,class_name:'ChecklistArchiveWorkflow',script_name:p.target.workflow_worker});
  return {main_module:config.main,compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags,
    bindings,limits:config.limits,observability:config.observability,usage_model:'standard',logpush:false};
}
