import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,bytesDigest} from '../src/model.js';
import {ExplorerReader} from '../src/explorer/read.js';
import {sample,TestSource} from './explorer-fixture.js';
async function fixture(){const records=await sample();for(const id of ['L-review','L-private']){const r=structuredClone(records['L-hold@1']);r.published=false;r.data.id=id;records[id+'@1']=r;}const source=new TestSource(records);const grant={project_id:source.connection.project_id,ref:'L-review@1',sha256:bytesDigest(canonical(records['L-review@1'].data)),expires_at:new Date(Date.now()+60000).toISOString()};return {source,grant};}
test('exact host-authorized draft review preserves unpublished state and keeps other private refs invisible',async()=>{
 const {source,grant}=await fixture();const before=canonical(source.records);const reader=new ExplorerReader(source,{reviewDraft:grant});const c=await reader.refresh();const generation=c.source!.registry_generation;const query=(route:string,q:any)=>reader.query(route,new URLSearchParams({generation,limit:'100',...q})) as any;
 const rows=query('records',{type:'layer'});const draft=rows.items.find((r:any)=>r.ref===grant.ref);assert.equal(draft.published,false);assert.equal(draft.review_required,true);assert.equal(rows.total,5);assert.equal(c.draft_review?.ref,grant.ref);
 const detail=query('record',{type:'layer',ref:grant.ref});assert.equal(detail.published,false);assert.equal(detail.review_required,true);assert.ok(detail.proposals.length);assert.throws(()=>query('record',{type:'layer',ref:'L-private@1'}),(e:any)=>e.code==='REF_NOT_FOUND');assert.equal(canonical(source.records),before);
});
test('default published reader still conceals all drafts',async()=>{
 const {source,grant}=await fixture();const reader=new ExplorerReader(source);const c=await reader.refresh();const generation=c.source!.registry_generation;assert.equal((reader.query('records',new URLSearchParams({generation,type:'layer',limit:'100'})) as any).total,4);assert.throws(()=>reader.query('record',new URLSearchParams({generation,type:'layer',ref:grant.ref})),(e:any)=>e.code==='REF_NOT_FOUND');
});
test('foreign or expired local review grant refuses before source load; hash substitution clears visibility',async()=>{
 for(const bad of [{project_id:'foreign'},{expires_at:'2000-01-01T00:00:00Z'}]){const {source,grant}=await fixture();const reader=new ExplorerReader(source,{reviewDraft:{...grant,...bad}});await assert.rejects(reader.refresh());assert.equal(source.calls,0);}
 const {source,grant}=await fixture();const reader=new ExplorerReader(source,{reviewDraft:{...grant,sha256:'0'.repeat(64)}});await assert.rejects(reader.refresh(),(e:any)=>e.code==='SOURCE_BINDING');assert.equal(reader.connection().ready,false);
});
