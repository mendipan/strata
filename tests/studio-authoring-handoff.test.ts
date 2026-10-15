import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {digest, BLOCK_MODEL, canonical} from '../src/model.js';
const ui = await import(pathToFileURL(path.resolve('explorer/draft-model.js')).href);
const draft={id:'L-audit',revision:2,owner:'author-a',model_version:BLOCK_MODEL,baseline:'R-start@1',intent:'Inspect detached audit events.',created_blocks:[],changes:[],acceptance:[],requires_layers:[],read_set:[],assumptions:[],resolution_proposals:[],derived_from:null};
const packet=()=>ui.authoringHandoff('synthetic-handoff',draft,digest(draft));
test('portable handoff hashes exact normalized content using engine canonical ordering',async()=>{
  const projected={...draft,ref:'L-audit@2',type:'layer',published:false,review_required:true,proposed_requirement_facets:[],proposals:[]};
  assert.equal(canonical(ui.normalizedDraft(projected)),canonical(draft));assert.equal(projected.ref,'L-audit@2');
  const parsed=await ui.inspectAuthoringHandoff(JSON.stringify(packet()),'synthetic-handoff',BLOCK_MODEL);
  assert.equal(parsed.draft_digest,digest(draft));assert.equal(parsed.draft_ref,'L-audit@2');
  const unicode={...draft,intent:'Audit Å, é, 東京 and detached copies.',assumptions:[{z:'終',A:'start',é:'café'}]};
  assert.equal((await ui.inspectAuthoringHandoff(JSON.stringify(ui.authoringHandoff('synthetic-handoff',unicode,digest(unicode))),'synthetic-handoff',BLOCK_MODEL)).draft_digest,digest(unicode));
});
test('changed content, envelope, subject, project and model cannot retain inspected readiness',async()=>{
  for(const change of [(p:any)=>p.draft.intent+='changed',(p:any)=>p.draft_ref='L-other@2',(p:any)=>p.project_id='foreign',(p:any)=>p.model_version='strata/0.1-facets-experimental',(p:any)=>p.session='forbidden',(p:any)=>p.draft_digest='0'.repeat(64),(p:any)=>p.draft.revision=0]){
    const p:any=packet();change(p);await assert.rejects(ui.inspectAuthoringHandoff(JSON.stringify(p),'synthetic-handoff',BLOCK_MODEL));
  }
});
test('malformed, oversized, deeply nested and dangerous field inputs are bounded before rendering',async()=>{
  await assert.rejects(ui.inspectAuthoringHandoff('{','synthetic-handoff',BLOCK_MODEL),/valid JSON/);
  await assert.rejects(ui.inspectAuthoringHandoff('é'.repeat(400001),'synthetic-handoff',BLOCK_MODEL),/UTF-8/);
  let nested:any={};for(let n=0;n<40;n++)nested={child:nested};const p=packet();p.draft.derived_from=nested;
  await assert.rejects(ui.inspectAuthoringHandoff(JSON.stringify(p),'synthetic-handoff',BLOCK_MODEL),/bounded/);
  await assert.rejects(ui.inspectAuthoringHandoff('{"__proto__":{}}','synthetic-handoff',BLOCK_MODEL),/unsupported field/);
});
