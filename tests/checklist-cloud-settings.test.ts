// Independently written documented /settings response; no provider receipts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonical,StrataError} from '../src/model.js';
import {checklistBootstrapSettings} from '../scripts/checklist-cloud-bootstrap.js';
import {checklistWorkerObservability} from '../scripts/checklist-cloud-worker-version.js';
import {checklistCloudFixture} from './checklist-cloud-fixture.js';

const raw=JSON.parse(await readFile(new URL('../../tests/fixtures/checklist-worker-wire/settings.json',import.meta.url),'utf8'));
const {p:prepared}=await checklistCloudFixture(),p={...prepared,target_sha256:'b'.repeat(64)},source='a'.repeat(64);
const check=(result:unknown)=>checklistBootstrapSettings(result,p,source,'app');
function diagnostic(result:unknown){
 try{check(result);assert.fail('Settings mismatch must refuse.');}catch(error){
  assert(error instanceof StrataError);assert.equal(error.code,'CHECKLIST_BOOTSTRAP_REFUSED');
  const details=error.details as {checklist_stage:string;settings_diagnostic:{format:string;fields:{field:string;actual_type:string;status:string;required_public_enum?:string;observed_public_enum?:string}[];arbitrary_result_values_retained:boolean;public_enums_retained:boolean}};
  assert.equal(details.checklist_stage,'bootstrap.response');assert.equal(details.settings_diagnostic.format,'strata-checklist-settings-diagnostic/2');
  assert.equal(details.settings_diagnostic.arbitrary_result_values_retained,false);assert.equal(details.settings_diagnostic.public_enums_retained,true);return details.settings_diagnostic;
 }
}
test('Independent settings fixture accepts documented default/extra observability fields and minimal explicit enable flags',()=>{
 check(raw.result);checklistWorkerObservability(raw.result,p,source,'app');
 const minimal=structuredClone(raw.result);minimal.observability={enabled:true,traces:{enabled:true}};check(minimal);
 const reordered=structuredClone(raw.result);reordered.bindings.reverse();check(reordered);
 const unrequested=structuredClone(raw.result);unrequested.observability.head_sampling_rate=0.5;check(unrequested);
});
test('Required observability flags must be explicit booleans at their own nesting level',()=>{
 for(const [field,value] of [['observability',undefined],['observability',null],['observability',[]],
  ['observability.enabled',undefined],['observability.enabled',false],['observability.enabled','true'],
  ['observability.traces',undefined],['observability.traces',null],['observability.traces',[]],
  ['observability.traces.enabled',undefined],['observability.traces.enabled',false],['observability.traces.enabled',1]] as const){
  const result=structuredClone(raw.result),parts=field.split('.'),leaf=parts.pop()!;
  let parent=result;for(const part of parts)parent=parent[part];parent[leaf]=value;
  const d=diagnostic(result);assert(d.fields.some(f=>f.field===field&&f.status!=='match'));
  assert.throws(()=>checklistWorkerObservability(result,p,source,'app'));
 }
 const wrongLevel=structuredClone(raw.result);wrongLevel.observability={enabled:true,logs:{enabled:true},traces_enabled:true};
 assert(diagnostic(wrongLevel).fields.some(f=>f.field==='observability.traces.enabled'&&f.status==='missing'));
});
test('Exact bindings, compatibility, limits, Logpush and Standard usage still reject genuine differences and invalid shapes',()=>{
 for(const [field,value] of [['bindings',[]],['bindings',null],['bindings',[...raw.result.bindings,...raw.result.bindings]],
  ['bindings',[{type:'plain_text',name:'CHECKLIST_SOURCE_SHA256',text:'private-payload'}]],
  ['compatibility_date','2026-10-13'],['compatibility_flags',[]],['compatibility_flags','nodejs_compat'],
  ['limits',{cpu_ms:1000,subrequests:2}],['limits',{cpu_ms:2000,subrequests:1}],['limits',null],
  ['logpush',true],['logpush','false'],['usage_model','bundled'],['usage_model',null]] as const){
  const d=diagnostic({...raw.result,[field]:value});assert(d.fields.some(f=>f.field===field&&f.status!=='match'));
 }
 for(const field of ['bindings','compatibility_date','compatibility_flags','limits','logpush','usage_model']){
  const result=structuredClone(raw.result);delete result[field];
  assert(diagnostic(result).fields.some(f=>f.field===field&&f.status==='missing'));
 }
 for(const result of [undefined,null,[],true,'private-payload'])assert(diagnostic(result).fields.some(f=>f.field==='result'&&f.status!=='match'));
});
test('Fixed field diagnostics collect simultaneous mismatches without values, binding names, unknown keys or exception text',()=>{
 const marker='private-payload-credential-data',result={...raw.result,bindings:[{name:marker,type:'secret_text',text:marker}],
  compatibility_date:marker,usage_model:marker,logpush:marker,limits:{cpu_ms:marker,subrequests:marker,[marker]:marker},
  observability:{enabled:marker,traces:{enabled:marker,[marker]:marker}},[marker]:marker};
 const d=diagnostic(result),text=canonical(d);assert(!text.includes(marker));assert(!text.includes('CHECKLIST_SOURCE_SHA256'));
 assert(Buffer.byteLength(text)<8192);assert.equal(d.fields.length,13);
 for(const field of ['bindings','compatibility_date','usage_model','logpush','limits.cpu_ms','limits.subrequests','observability.enabled','observability.traces.enabled'])
  assert(d.fields.some(f=>f.field===field&&f.status!=='match'));
 const different=diagnostic({...raw.result,observability:{enabled:true,traces:{enabled:false}}});
 assert.deepEqual(different.fields.filter(f=>f.status!=='match'),[{field:'observability.traces.enabled',actual_type:'boolean',status:'different'}]);
});
test('Usage diagnostics retain only exact public enums; legacy/unknown/missing models still refuse',()=>{
 for(const observed of ['bundled','unbound','private-provider-data','STANDARD','standard\n',null,undefined,{},['standard']]){
  const d=diagnostic({...raw.result,usage_model:observed}),field=d.fields.find(f=>f.field==='usage_model')!;
  assert.notEqual(field.status,'match');assert.equal(field.required_public_enum,'standard');
  assert.equal(field.observed_public_enum,observed==='bundled'||observed==='unbound'?observed:'[redacted]');
  assert(!canonical(d).includes('private-provider-data'));
 }
 check({...raw.result,usage_model:'standard'});
});
