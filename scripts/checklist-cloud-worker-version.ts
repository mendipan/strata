import {canonical,bytesDigest,fail} from '../src/model.js';
import {checklistPrivateConfigs,checklistUploadMetadata} from '../src/checklist-cloud-config.js';
import {checklistNoPagination} from '../src/checklist-cloud-management.js';
import type {PreparedChecklist} from '../src/checklist-cloud-contract.js';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export const CHECKLIST_VERSION_JSON_BYTES=2*1024*1024;
function refused():never{return fail('CHECKLIST_WORKER_VERSION_REFUSED',7,'Typed Worker version identity/configuration/module readback differs.');}
export function checklistWorkerCreateBody(p:PreparedChecklist,source:string,kind:'app'|'workflow') {
 const config=checklistPrivateConfigs(p,source)[kind];
 return{name:config.name,logpush:false,subdomain:{enabled:false,previews_enabled:false},tags:[],tail_consumers:[],observability:config.observability};
}
export function checklistWorkerObservability(raw:unknown,p:PreparedChecklist,source:string,kind:'app'|'workflow') {
 const expected=checklistPrivateConfigs(p,source)[kind].observability;
 // The provider may add documented default fields. The two reviewed enable flags
 // must be explicit; no arbitrary object equality against a partial request.
 if(!object(raw)||!object(raw.observability)||raw.observability.enabled!==expected.enabled||
  !object(raw.observability.traces)||raw.observability.traces.enabled!==expected.traces.enabled)refused();
}
export function checklistWorkerVersionBody(bundle:Uint8Array,p:PreparedChecklist,source:string,kind:'app'|'workflow',authorization:string) {
 const metadata=checklistUploadMetadata(p,source,kind,authorization);
 return{main_module:metadata.main_module,compatibility_date:metadata.compatibility_date,compatibility_flags:metadata.compatibility_flags,
  bindings:metadata.bindings,limits:metadata.limits,usage_model:metadata.usage_model,
  modules:[{name:metadata.main_module,content_type:'application/javascript+module',content_base64:Buffer.from(bundle).toString('base64')}]};
}
export type ChecklistWorkerVersionBody=ReturnType<typeof checklistWorkerVersionBody>;
// Current beta create still documents this deprecated top-level JSON field.
// Deprecation does not establish normalization or pricing equivalence.
export function checklistWorkerVersionJson(body:ChecklistWorkerVersionBody) {
 if(body.usage_model!=='standard')refused();
 const json=canonical(body);
 if(JSON.parse(json).usage_model!=='standard')refused();
 return json;
}
export function checklistWorkerVersionPreflight(p:PreparedChecklist,source:string) {
 // Exercise the actual builder/serializer before credentials, reservation or
 // private Worker creation. The real upload still verifies its exact buffer.
 for(const kind of ['app','workflow'] as const)
  checklistWorkerVersionJson(checklistWorkerVersionBody(new Uint8Array(),p,source,kind,''));
}
// Official beta Version has required id/created_on/number/urls. Require private
// URLs and leave omitted optional properties optional in the upload acknowledgement.
export function checklistWorkerVersionIdentity(raw:unknown,expectedId?:string) {
 if(!object(raw))refused();checklistNoPagination(raw);
 if(!uuid(raw.id)||(expectedId!==undefined&&raw.id!==expectedId)||typeof raw.created_on!=='string'||!Number.isFinite(Date.parse(raw.created_on))||
  !Number.isSafeInteger(raw.number)||Number(raw.number)<1||!Array.isArray(raw.urls)||raw.urls.length)refused();
 return{id:raw.id,created_on:raw.created_on,number:raw.number};
}
export function checklistWorkerVersionReadback(raw:unknown,identity:ReturnType<typeof checklistWorkerVersionIdentity>,expected:ChecklistWorkerVersionBody) {
 const proof=checklistWorkerVersionConfiguration(raw,identity,expected);
 if(!object(raw)||(raw.usage_model!==undefined&&raw.usage_model!==expected.usage_model))refused();
 return proof;
}
// Diagnostics do not change any acceptance predicate. Emit only fixed field names,
// comparison outcomes, bounded counts/numbers and explicitly public defaults.
// In particular, binding text, unknown property names and module bytes never escape.
export function checklistWorkerVersionDiagnostic(raw:unknown,identity:ReturnType<typeof checklistWorkerVersionIdentity>,expected:ChecklistWorkerVersionBody) {
 const value=object(raw)?raw:{},type=(v:unknown)=>v===undefined?'missing':v===null?'null':Array.isArray(v)?'array':typeof v;
 const equal=(a:unknown,b:unknown)=>{try{return a===undefined||b===undefined?a===b:canonical(a)===canonical(b);}catch{return false;}};
 const field=(name:string,actual:unknown,wanted:unknown,valid=true)=>({field:name,actual_type:type(actual),
  status:actual===undefined&&wanted!==undefined?'missing':!valid?'invalid-shape':equal(actual,wanted)?'match':'different'});
 const sorted=(v:unknown)=>Array.isArray(v)&&v.every(b=>object(b)&&typeof b.name==='string')&&new Set(v.map(b=>b.name)).size===v.length?
  [...v].sort((a,b)=>a.name.localeCompare(b.name)):undefined;
 const bindings=sorted(value.bindings),limits=object(value.limits)?value.limits:{},modules=Array.isArray(value.modules)?value.modules:[],module=object(modules[0])?modules[0]:{};
 const extra=(actual:unknown,wanted:unknown)=>object(actual)&&object(wanted)?Object.keys(actual).filter(k=>!Object.hasOwn(wanted,k)).length:null;
 const number=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER?v:null;
 const bindingFields=['name','type','text','namespace','service','workflow_name','class_name','script_name','environment','entrypoint'] as const;
 return{format:'strata-checklist-version-diagnostic/1',fields:[
  field('result',raw,raw,object(raw)),field('id',value.id,identity.id),field('created_on',value.created_on,identity.created_on),field('number',value.number,identity.number),field('urls',value.urls,[]),
  field('main_module',value.main_module,expected.main_module),field('compatibility_date',value.compatibility_date,expected.compatibility_date),
  field('compatibility_flags',value.compatibility_flags,expected.compatibility_flags),field('limits',value.limits,expected.limits,object(value.limits)),
  {...field('limits.cpu_ms',limits.cpu_ms,expected.limits.cpu_ms),actual_number:number(limits.cpu_ms)},
  {...field('limits.subrequests',limits.subrequests,expected.limits.subrequests),actual_number:number(limits.subrequests)},
  field('bindings',bindings??value.bindings,sorted(expected.bindings),bindings!==undefined),field('modules.count',Array.isArray(value.modules)?modules.length:undefined,1),
  field('modules[0].name',module.name,expected.modules[0].name),field('modules[0].content_type',module.content_type,expected.modules[0].content_type),
  field('modules[0].content_base64',module.content_base64,expected.modules[0].content_base64),field('usage_model',value.usage_model,expected.usage_model)],
  limits_additional_property_count:extra(value.limits,expected.limits),binding_count:Array.isArray(value.bindings)?value.bindings.length:null,
  bindings:expected.bindings.map((wanted,binding_index)=>{
   const matches=Array.isArray(value.bindings)?value.bindings.filter(b=>object(b)&&b.name===wanted.name):[],actual=matches.length===1?matches[0]:undefined;
   const record=object(actual)?actual:{};
   return{binding_index,matching_name_count:matches.length,additional_property_count:extra(actual,wanted),
    fields:bindingFields.map(key=>field(key,record[key],wanted[key])),
    // These two documented optional fields are common sources of representational
    // differences. Observe their public defaults without accepting normalization.
    public_defaults:{environment:record.environment===undefined?'missing':record.environment==='production'?'production':'[redacted]',
     entrypoint:record.entrypoint===undefined?'missing':record.entrypoint==='default'?'default':'[redacted]'}};
  }),arbitrary_result_values_retained:false};
}
// Diagnostic collection may defer only the model predicate, never these checks.
export function checklistWorkerVersionConfiguration(raw:unknown,identity:ReturnType<typeof checklistWorkerVersionIdentity>,expected:ChecklistWorkerVersionBody) {
 if(canonical(checklistWorkerVersionIdentity(raw,identity.id))!==canonical(identity)||!object(raw))refused();
 const sortedBindings=(v:unknown)=>{
  if(!Array.isArray(v)||v.some(b=>!object(b)||typeof b.name!=='string')||new Set(v.map(b=>b.name)).size!==v.length)refused();
  return [...v].sort((a,b)=>a.name.localeCompare(b.name));
 };
 if(raw.main_module!==expected.main_module||raw.compatibility_date!==expected.compatibility_date||
  canonical(raw.compatibility_flags)!==canonical(expected.compatibility_flags)||canonical(raw.limits)!==canonical(expected.limits)||
  canonical(sortedBindings(raw.bindings))!==canonical(sortedBindings(expected.bindings))||
  !Array.isArray(raw.modules)||raw.modules.length!==1)refused();
 const module=raw.modules[0],approved=expected.modules[0];
 if(!object(module)||module.name!==approved.name||module.content_type!==approved.content_type||typeof module.content_base64!=='string'||
  module.content_base64!==approved.content_base64)refused();
 const bytes=Buffer.from(module.content_base64,'base64');
 if(bytes.toString('base64')!==module.content_base64)refused();
 return{version_id:identity.id,module_sha256:bytesDigest(bytes),module_size_bytes:bytes.length};
}
export function checklistUsageModelObservation(raw:unknown,field:'usage_model'|'default_usage_model'='usage_model') {
 const value=object(raw)?raw[field]:undefined,present=object(raw)&&Object.hasOwn(raw,field);
 return{presence:present?'present':'missing',actual_type:value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value,
  public_enum:typeof value==='string'&&['standard','bundled','unbound'].includes(value)?value:'[redacted]',
  required_public_enum:'standard',predicate:value==='standard'?'match':!present?'missing':typeof value!=='string'?'invalid-shape':'different'};
}
