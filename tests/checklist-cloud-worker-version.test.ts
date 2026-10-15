import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bytesDigest} from '../src/model.js';
import {checklistLatestDeployment} from '../src/checklist-cloud-deployments.js';
import {checklistWorkerVersionBody,checklistWorkerVersionJson,checklistWorkerVersionPreflight,checklistWorkerVersionIdentity,checklistWorkerVersionReadback,checklistWorkerVersionDiagnostic,type ChecklistWorkerVersionBody} from '../scripts/checklist-cloud-worker-version.js';
import {normalizeChecklistHttpResponse} from '../src/checklist-cloud-management.js';
import {checklistCloudFixture} from './checklist-cloud-fixture.js';
import {checklistPrivateConfigs} from '../src/checklist-cloud-config.js';
import {checklistBootstrapSettings} from '../scripts/checklist-cloud-bootstrap.js';

const fixture=async(name:string)=>JSON.parse(await readFile(new URL('../../tests/fixtures/checklist-worker-wire/'+name,import.meta.url),'utf8'));
const response=await fixture('version.json'),version=response.result,identity=checklistWorkerVersionIdentity(version);
const expected:ChecklistWorkerVersionBody={main_module:version.main_module,compatibility_date:version.compatibility_date,
 compatibility_flags:version.compatibility_flags,bindings:version.bindings,limits:version.limits,usage_model:'standard',modules:version.modules};
const clone=<T>(v:T):T=>structuredClone(v);

test('Offline preflight and actual JSON serializer retain supported top-level Standard usage and both approved runtime limits',async()=>{
 const {p}=await checklistCloudFixture(),bundle=Buffer.from('export default {};\n// synthetic Unicode: \u{1f9ed}\n');
 assert.doesNotThrow(()=>checklistWorkerVersionPreflight(p,'a'.repeat(64)));
 for(const kind of ['app','workflow'] as const){
  const body=checklistWorkerVersionBody(bundle,p,'a'.repeat(64),kind,'b'.repeat(64));
  const wire=JSON.parse(checklistWorkerVersionJson(body));
  assert(Object.hasOwn(wire,'usage_model'));assert.equal(wire.usage_model,'standard');
  assert.deepEqual(wire.limits,{cpu_ms:1000,subrequests:kind==='app'?1:256});
  assert.equal(Buffer.from(wire.modules[0].content_base64,'base64').compare(bundle),0);
  for(const value of [undefined,null,'bundled','unbound','private-model',{},['standard']]){
   const changed=clone(body);Reflect.set(changed,'usage_model',value);assert.throws(()=>checklistWorkerVersionJson(changed));
  }
  const nested=clone(body);Reflect.deleteProperty(nested,'usage_model');Reflect.set(nested,'metadata',{usage_model:'standard'});
  assert.throws(()=>checklistWorkerVersionJson(nested),'A nested model cannot substitute for the documented top-level field.');
 }
});

test('Current typed version fixture binds exact version, module bytes and configuration with documented optional fields',()=>{
 const proof=checklistWorkerVersionReadback(version,identity,expected);
 assert.equal(proof.version_id,version.id);assert.equal(proof.module_sha256,bytesDigest(Buffer.from(version.modules[0].content_base64,'base64')));
 assert.deepEqual(checklistWorkerVersionIdentity({id:version.id,number:1,created_on:version.created_on,urls:[]}),identity);
});
test('Direct script PUT, legacy compatibility data, script name, private Worker ID and compact legacy hex cannot become version identities',async()=>{
 assert.throws(()=>checklistWorkerVersionIdentity((awaitedPut)));
 for(const raw of [{deployment_id:version.id,id:undefined},{id:'synthetic-checklist-app'},{id:'1'.repeat(32)},{id:version.id.replaceAll('-','')},
  {id:undefined},{number:0},{urls:['https://fixture.example.invalid']},{urls:undefined},{created_on:'invalid'},{cursor:'synthetic'}])
  assert.throws(()=>checklistWorkerVersionIdentity({...version,...raw}));
});
const awaitedPut=(await fixture('script-put.json')).result;
test('Version diagnostics identify binding/default differences without accepting them or leaking arbitrary provider values',async()=>{
 const {p}=await checklistCloudFixture(),body=checklistWorkerVersionBody(Buffer.from('synthetic private module'),p,'a'.repeat(64),'workflow','b'.repeat(64));
 // Reproduce the historical omitted-environment request independently of the
 // corrected builder. The diagnostic itself must never normalize this difference.
 delete body.bindings.find(b=>b.type==='service')!.environment;
 const raw={...clone(body),...identity,urls:[]};
 const service=raw.bindings.find(b=>b.type==='service')!;
 service.environment='production';service.entrypoint='default';
 const diagnostic=checklistWorkerVersionDiagnostic(raw,identity,body);
 assert.equal(diagnostic.fields.find(f=>f.field==='bindings')!.status,'different');
 const binding=diagnostic.bindings[raw.bindings.indexOf(service)];
 assert.equal(binding.additional_property_count,2);assert.equal(binding.fields.find(f=>f.field==='environment')!.status,'different');
 assert.deepEqual(binding.public_defaults,{environment:'production',entrypoint:'default'});
 assert.throws(()=>checklistWorkerVersionReadback(raw,identity,body),'Observed public defaults remain strict mismatches.');
 const marker='SYNTHETIC_PRIVATE_VALUE_DO_NOT_LOG';
 for(const b of raw.bindings){b[marker]=marker;if(b.type==='plain_text')b.text=marker;}
 service.environment=marker;service.entrypoint=marker;service.service=marker;
 raw.modules[0].content_base64=Buffer.from(marker).toString('base64');
 Reflect.set(raw,'unexpected_'+marker,marker);
 const serialized=JSON.stringify(checklistWorkerVersionDiagnostic(raw,identity,body));
 assert(!serialized.includes(marker));assert(!serialized.includes(Buffer.from(marker).toString('base64')));assert(!serialized.includes('b'.repeat(64)));
 assert.throws(()=>checklistWorkerVersionReadback(raw,identity,body));
});
test('Explicit production service environment matches the observed readback while omitted or changed environments and targets remain refused',async()=>{
 const {p}=await checklistCloudFixture(),source='a'.repeat(64),authorization='b'.repeat(64);
 const body=checklistWorkerVersionBody(Buffer.from('export default {}; // synthetic'),p,source,'workflow',authorization);
 const service={type:'service',name:'CHECKLIST_APP',service:p.target.app_worker,environment:'production'};
 assert.deepEqual(body.bindings.find(b=>b.type==='service'),service);
 assert.deepEqual(checklistPrivateConfigs(p,source,authorization).workflow.services,[{binding:'CHECKLIST_APP',service:p.target.app_worker,environment:'production'}]);
 const raw={...clone(body),...identity,urls:[]};raw.bindings=raw.bindings.map(b=>b.type==='service'?{...service}:b);
 const legacy=clone(body);delete legacy.bindings.find(b=>b.type==='service')!.environment;
 assert.throws(()=>checklistWorkerVersionReadback(raw,identity,legacy));
 assert.doesNotThrow(()=>checklistWorkerVersionReadback(raw,identity,body));
 const settings={...(await fixture('settings.json')).result,bindings:raw.bindings,limits:raw.limits,
  compatibility_date:raw.compatibility_date,compatibility_flags:raw.compatibility_flags,usage_model:'standard'};
 assert.doesNotThrow(()=>checklistBootstrapSettings(settings,p,source,'workflow',authorization));
 for(const patch of [{environment:undefined},{environment:'staging'},{environment:null},{environment:''},{service:'synthetic-other-worker'},
  {entrypoint:'default'},{unexpected:'synthetic'}]){
  const changed=clone(raw);Object.assign(changed.bindings.find(b=>b.type==='service')!,patch);
  assert.throws(()=>checklistWorkerVersionReadback(changed,identity,body));
  assert.throws(()=>checklistBootstrapSettings({...settings,bindings:changed.bindings},p,source,'workflow',authorization));
 }
});
test('Version diagnostics distinguish limits, modules, missing and duplicate bindings while all refusals remain strict',()=>{
 const cases=[{limits:{cpu_ms:1000,subrequests:999},field:'limits.subrequests'},
  {modules:[],field:'modules.count'},{bindings:undefined,field:'bindings'},
  {bindings:[...version.bindings,...version.bindings],field:'bindings'}];
 for(const {field,...patch} of cases){
  const raw={...clone(version),...patch},diagnostic=checklistWorkerVersionDiagnostic(raw,identity,expected);
  assert.notEqual(diagnostic.fields.find(f=>f.field===field)!.status,'match');
  assert.throws(()=>checklistWorkerVersionReadback(raw,identity,expected));
  if(field==='limits.subrequests'){const limit=diagnostic.fields.find(f=>f.field===field)!;assert('actual_number' in limit);assert.equal(limit.actual_number,999);}
 }
 const invalid=checklistWorkerVersionDiagnostic(null,identity,expected);
 assert.equal(invalid.fields.find(f=>f.field==='result')!.status,'invalid-shape');
 assert(!JSON.stringify(invalid).includes(version.modules[0].content_base64));
});
test('Specific version readback refuses missing/changed identity, clock, binding, limits, module type/name/bytes or extra modules',()=>{
 for(const patch of [{id:'44444444-4444-4444-8444-444444444444'},{created_on:'2026-10-13T03:00:00Z'},{number:2},{bindings:[]},
  {bindings:[...version.bindings,...version.bindings]},{limits:{cpu_ms:1000,subrequests:256}},{compatibility_flags:[]},{modules:[]},
  {modules:[...version.modules,...version.modules]},{main_module:'other.mjs'},{usage_model:'bundled'}])
  assert.throws(()=>checklistWorkerVersionReadback({...version,...patch},identity,expected));
 for(const patch of [{name:'other.mjs'},{content_type:'application/javascript'},{content_base64:'%%%%'},{content_base64:version.modules[0].content_base64+'\n'},
  {content_base64:Buffer.from('export default {};\n// changed\n').toString('base64')}]){
  const raw=clone(version);Object.assign(raw.modules[0],patch);assert.throws(()=>checklistWorkerVersionReadback(raw,identity,expected));
 }
});
test('Documented deployment object supplies versions[].version_id, separately from deployment id, in bootstrap and runtime management',async()=>{
 const raw=await fixture('deployments.json'),latest=checklistLatestDeployment(raw.result,true),{p}=await checklistCloudFixture();
 assert.notEqual(latest.id,version.id);assert.equal(latest.versions[0].version_id,version.id);
 assert.deepEqual(normalizeChecklistHttpResponse({action:'inspect-app-worker',target:p.target},200,raw),{retained:true,name:p.target.app_worker,version_id:version.id});
 for(const result of [raw.result.deployments,[],{}, {deployments:[]}, {deployments:[{...latest,versions:[{version_id:latest.id,percentage:50}]}]},
  {deployments:[{...latest,strategy:undefined}]},{deployments:[latest,latest]}])assert.throws(()=>checklistLatestDeployment(result));
});

test('Documented active list head binds downstream version despite later or equal historical timestamps; fresh bootstrap remains single-deployment',async()=>{
 const raw=await fixture('deployments-active-head.json'),{p}=await checklistCloudFixture();
 const head=raw.result.deployments[0],history=raw.result.deployments[1],expected=head.versions[0].version_id;
 assert(Date.parse(history.created_on)>Date.parse(head.created_on));
 for(const historicalClock of [history.created_on,head.created_on]){
  const response=clone(raw);response.result.deployments[1].created_on=historicalClock;
  assert.equal(checklistLatestDeployment(response.result).id,head.id);
  for(const action of ['inspect-app-worker','inspect-workflow-worker'] as const){
   const normalized=normalizeChecklistHttpResponse({action,target:p.target},200,response);
   assert.deepEqual(normalized,{retained:true,name:action==='inspect-app-worker'?p.target.app_worker:p.target.workflow_worker,version_id:expected});
   assert.notEqual((normalized as {version_id:string}).version_id,history.versions[0].version_id);
   assert.notEqual((normalized as {version_id:string}).version_id,head.id);
  }
  assert.throws(()=>checklistLatestDeployment(response.result,true),'Fresh upload readback still requires exactly one deployment.');
 }
 const reversed=clone(raw);reversed.result.deployments.reverse();
 assert.equal(checklistLatestDeployment(reversed.result).versions[0].version_id,history.versions[0].version_id,'Only the documented list head supplies active identity.');
 for(const patch of [{versions:[{version_id:expected,percentage:50}]},{versions:[]},{versions:[{version_id:p.target.app_worker,percentage:100}]}]){
  const refused=clone(raw);Object.assign(refused.result.deployments[0],patch);
  assert.throws(()=>normalizeChecklistHttpResponse({action:'inspect-app-worker',target:p.target},200,refused),'Malformed head cannot fall through to a valid historical entry.');
 }
});
