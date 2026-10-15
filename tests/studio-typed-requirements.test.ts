import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {canonical,digest,normalizeSnapshot} from '../src/model.js';
import {normalizeLayer} from '../src/core.js';
import {recognizeHostCollection} from '../src/profiles/collection-host-semantics.js';
const ui=await import(pathToFileURL(path.resolve('explorer/draft-model.js')).href);
const read=async(name:string)=>JSON.parse(await readFile(path.resolve('examples/contributor/collection',name+'.json'),'utf8'));
const input=()=>({add:false,key:'copies',statement:'Audit reads return detached event copies.',kind:'rule',facets:['safety','data'],acceptance:['events'],parameters:[{name:'limit',type:'number',value:'7.5'},{name:'enabled',type:'boolean',value:false}]});
test('typed requirement edits produce the exact existing normalized Layer with all unrelated content retained',async()=>{
  const baseline=normalizeSnapshot(await read('bootstrap')),draft=normalizeLayer(await read('create-audit'),baseline),before=canonical(draft),fields=input();
  const typed=ui.typedBlockRequirement(draft,'audit',fields),manual=structuredClone(draft);
  manual.revision++;manual.created_blocks![0].requirements.copies={statement:fields.statement,kind:'rule',facets:['safety','data'],acceptance:['events'],parameters:{limit:7.5,enabled:false}};
  assert.equal(canonical(normalizeLayer(typed,baseline)),canonical(normalizeLayer(manual,baseline)));assert.equal(digest(normalizeLayer(typed,baseline)),digest(normalizeLayer(manual,baseline)));
  assert.equal(canonical(draft),before);assert.equal(canonical(typed.created_blocks[0].contract),canonical(draft.created_blocks![0].contract));assert.equal(canonical(typed.created_blocks[0].acceptance),canonical(draft.created_blocks![0].acceptance));
  const restored=structuredClone(typed);restored.revision=draft.revision;restored.created_blocks[0].requirements.copies=structuredClone(draft.created_blocks![0].requirements.copies);assert.equal(canonical(restored),before);
});
test('new requirements use explicit existing criterion links without fabricated criteria or subjects',async()=>{
  const baseline=normalizeSnapshot(await read('bootstrap')),draft=normalizeLayer(await read('create-audit'),baseline),fields={...input(),add:true,key:'retention'};
  const edited=ui.typedBlockRequirement(draft,'audit',fields);normalizeLayer(edited,baseline);
  assert.equal(edited.created_blocks[0].requirements.retention.parameters.enabled,false);assert.equal(canonical(edited.created_blocks[0].acceptance),canonical(draft.created_blocks![0].acceptance));
  assert.throws(()=>ui.typedBlockRequirement(draft,'audit',{...fields,key:'copies'}),/already exists/);
});
test('statement-only typed edit preserves exact normalized whitespace parameter keys and the full content digest',async()=>{
  const baseline=normalizeSnapshot(await read('bootstrap')),source=await read('create-audit');
  source.created_blocks[0].requirements.copies.parameters={' padded ':false,limit:7.5,'\ttabbed\t':true};
  const draft=normalizeLayer(source,baseline),requirement=draft.created_blocks![0].requirements.copies;
  const fields={add:false,key:'copies',...requirement,statement:'Audit copies remain detached after an exact statement edit.',parameters:Object.entries(requirement.parameters).map(([name,value])=>({name,type:typeof value==='boolean'?'boolean':'number',value:typeof value==='number'?String(value):value}))};
  const manual=structuredClone(draft);manual.revision++;manual.created_blocks![0].requirements.copies.statement=fields.statement;
  const typed=normalizeLayer(ui.typedBlockRequirement(draft,'audit',fields),baseline);
  assert.equal(canonical(typed),canonical(normalizeLayer(manual,baseline)));assert.equal(digest(typed),digest(normalizeLayer(manual,baseline)));
  assert.deepEqual(typed.created_blocks![0].requirements.copies.parameters,requirement.parameters);assert.equal(canonical(draft),canonical(normalizeLayer(source,baseline)));
  const distinct=structuredClone(draft);distinct.created_blocks![0].requirements.copies.parameters.padded=3;
  const exactFields={...fields,parameters:[...fields.parameters,{name:'padded',type:'number',value:'3'}]};
  assert.deepEqual(ui.typedBlockRequirement(distinct,'audit',exactFields).created_blocks[0].requirements.copies.parameters,distinct.created_blocks![0].requirements.copies.parameters);
});
test('unchanged normalized whitespace parameter form refuses instead of manufacturing a revision',async()=>{
  const baseline=normalizeSnapshot(await read('bootstrap')),source=await read('create-audit');
  source.created_blocks[0].requirements.copies.parameters={' padded ':false,limit:7.5,'\ttabbed\t':true};
  const draft=normalizeLayer(source,baseline),requirement=draft.created_blocks![0].requirements.copies;
  const fields={add:false,key:'copies',...requirement,parameters:Object.entries(requirement.parameters).map(([name,value])=>({name,type:typeof value==='boolean'?'boolean':'number',value:typeof value==='number'?String(value):value}))};
  assert.throws(()=>ui.typedBlockRequirement(draft,'audit',fields),/Change the requirement/);
});
test('blank/markup statements, keys, facets, links and unsupported or ambiguous parameters refuse locally',async()=>{
  const baseline=normalizeSnapshot(await read('bootstrap')),draft=normalizeLayer(await read('create-audit'),baseline);
  const invalid:any[]=[{statement:''},{statement:'<script>run</script>'},{statement:'é'.repeat(2049)},{key:'bad.key'},{key:'__proto__'},{kind:'new-type'},{facets:[]},{facets:['behavior','behavior']},{acceptance:[]},{acceptance:['missing']},{parameters:[{name:'x',type:'number',value:''}]},{parameters:[{name:'x',type:'number',value:'Infinity'}]},{parameters:[{name:'x',type:'boolean',value:'true'}]},{parameters:[{name:'x',type:'string',value:'text'}]},{parameters:[{name:'x',type:'number',value:'1'},{name:'x',type:'boolean',value:true}]},{parameters:[{name:'constructor',type:'number',value:'1'}]},{parameters:Array.from({length:33},(_,i)=>({name:'p'+i,type:'number',value:'1'}))}];
  invalid.push({parameters:[{name:' constructor ',type:'number',value:'1'}]},{parameters:[{name:'   ',type:'number',value:'1'}]});
  for(const bad of invalid)assert.throws(()=>ui.typedBlockRequirement(draft,'audit',{...input(),...bad}));
  assert.throws(()=>ui.typedBlockRequirement(draft,'policy',input()),/exact saved Layer/);
  assert.throws(()=>ui.typedBlockRequirement({...draft,model_version:'strata/0.2-content-mediation-experimental'},'audit',input()),/v0.3/);
  assert.throws(()=>ui.typedBlockRequirement(draft,'audit',{...input(),kind:'invariant'}),/guardian assignment/);
  const invariant=structuredClone(draft);invariant.created_blocks![0].requirements.copies.kind='invariant';assert.throws(()=>normalizeLayer(invariant,baseline),(e:any)=>e.code==='GUARDIAN_ASSIGNMENT_REQUIRED');
  const original=draft.created_blocks![0].requirements.copies;
  assert.throws(()=>ui.typedBlockRequirement(draft,'audit',{add:false,key:'copies',...original,parameters:[]}),/Change the requirement/);
  const both=structuredClone(draft);both.created_blocks![0].requirements.copies.facets=['data','design'];assert.throws(()=>ui.typedBlockRequirement(both,'audit',{add:false,key:'copies',...original,facets:['design','data'],parameters:[]}),/Change the requirement/);
});
test('model-valid typed edits do not invent finite profile support',async()=>{
  const baseline=normalizeSnapshot(await read('bootstrap')),draft=normalizeLayer(await read('create-audit'),baseline),next=normalizeLayer(ui.typedBlockRequirement(draft,'audit',input()),baseline);
  const snapshot=structuredClone(baseline);snapshot.blocks.audit=next.created_blocks![0];
  // Unchanged public parent links are supplied exactly from the existing fixture.
  snapshot.blocks.collection.relationships.audit=draft.changes.find(c=>c.path==='relationships.audit')!.value as any;
  snapshot.blocks.collection.contract.outputs.audit=draft.changes.find(c=>c.path==='contract.outputs.audit')!.value as any;
  snapshot.blocks.collection.acceptance.audit=draft.acceptance[0].criterion;
  assert.throws(()=>recognizeHostCollection(snapshot),(e:any)=>e.code==='UNSUPPORTED_OBLIGATION');
});
