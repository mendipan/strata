import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { canonical, digest, CONTENT_MODEL } from '../src/model.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { ExplorerError } from '../src/explorer/contract.js';
import { sample, TestSource } from './explorer-fixture.js';
const code=(expected:string)=>(e:any)=>e.code===expected;
async function fixture(){const source=new TestSource(await sample()),reader=new ExplorerReader(source);await reader.refresh();const generation=reader.sourceInfo()!.registry_generation;const read=(route:string,q:Record<string,string>={})=>reader.query(route,new URLSearchParams({generation:reader.sourceInfo()?.registry_generation ?? generation,...q})) as any;return {source,reader,read,generation};}

test('exact bootstrap and derived Block facets preserve all obligations and baseline authority',async()=>{
 const f=await fixture();const hold=f.read('block',{at:'R0@1',id:'booking.hold'}),parent=f.read('block',{at:'R0@1',id:'booking'});
 assert.deepEqual(hold.direct_facets,['behavior','data','safety']);assert.deepEqual(parent.direct_facets,[]);assert.deepEqual(parent.subtree_facets,['behavior','data','safety']);
 assert.equal(Object.keys(hold.block.acceptance).length,4);assert.equal(hold.block.requirements.expiry.parameters.seconds,600);
 assert.equal(hold.relationships[0].source,'booking.reminder');assert.equal(hold.relationships[0].key,'hold');assert.equal(hold.authority.guardians[0].principal,'safety-guardian');
 assert.equal(hold.status.matching_validation.length,0);assert.match(hold.status.publication,/Bootstrap baseline/);
 const direct=f.read('blocks',{at:'R0@1',facets:'safety'}),subtree=f.read('blocks',{at:'R0@1',facets:'safety',match:'subtree'});
 assert.equal(direct.total,1);assert.equal(subtree.total,3);assert.equal(direct.facet_counts.design,0);assert.equal(f.read('blocks',{at:'R0@1',facets:'design'}).total,0);
 assert.equal(f.read('blocks',{at:'R0@1',facets:'safety,behavior',text:'disabled'}).total,1);assert.equal(f.read('blocks',{at:'R0@1',text:'booking.lifecycle'}).items[0].matching_items[0],'acceptance.lifecycle');
});
test('Layer proposals have exact dependency/read/assumption and do not select or modify a snapshot',async()=>{
 const f=await fixture(),before=canonical(f.source.records);const l=f.read('record',{type:'layer',ref:'L-reminder@1'});
 assert.equal(l.owner,'author-b');assert.deepEqual(l.requires_layers,['L-hold@1']);assert.equal(l.read_set[0].mode,'required');assert.equal(l.assumptions[0].expected.value.parameters.seconds,900);
 assert.equal(f.read('block',{at:'R0@1',id:'booking.reminder'}).block.requirements.timing.parameters.enabled,false);assert.equal(canonical(f.source.records),before);
});
test('blocked Composition returns no effective snapshot or semantic diff and shows complete competing proposals',async()=>{
 const f=await fixture(),e=f.read('evaluation',{ref:'C-demo@1'});
 assert.equal(e.state,'blocked');assert.equal(e.effective_available,false);assert.equal(e.snapshot,undefined);assert.ok(e.diagnostics.some((d:any)=>d.code==='ITEM_COLLISION'));assert.ok(e.diagnostics.some((d:any)=>d.code==='ALTERNATIVE_CARDINALITY'));
 assert.deepEqual(e.competing_proposals.filter((p:any)=>p.path==='requirements.expiry').map((p:any)=>p.value.parameters.seconds).sort(),[1200,900].sort());
 assert.throws(()=>f.read('diff',{left:'R0@1',right:'C-demo@1'}),code('BLOCKED_COMPARISON'));assert.throws(()=>f.read('block',{at:'C-demo@1',id:'booking.hold'}),code('BLOCKED_COMPARISON'));
});
test('published evidence and historical approvals join only exact candidate/target/profile/output/result bindings',async()=>{
 const f=await fixture(),release=Object.entries(f.source.records).find(([ref,r])=>r.type==='release' && ref!=='R0@1')![0],d=f.read('record',{type:'release',ref:release});
 assert.equal(d.status.matching_validation.length,1);assert.equal(d.status.matching_approvals.length,2);assert.ok(d.status.approval_coverage.every((c:any)=>c.recorded));
 const hold=f.read('block',{at:release,id:'booking.hold'});assert.equal(hold.matched_evidence.expiry.length,1);assert.ok(hold.provenance.find((p:any)=>p.item==='booking.hold/requirements.expiry').contributors.includes('L-hold@1'));
 const r=f.read('record',{type:'resolution',ref:d.resolutions[0]});assert.equal(r.endorsements[0].matches,true);assert.match(r.rationale,/No rationale/);
});
test('well-shaped retained mismatched evidence is visible but excluded from matching coverage',async()=>{
 const records=await sample(),v=Object.entries(records).find(([,r])=>r.type==='validation')![1];const changed=structuredClone(v);changed.data.evidence.output_tree='1'.repeat(64);changed.data.evidence_digest=digest(changed.data.evidence);
 const ref='validation@'+digest(changed.data).slice(0,24);records[ref]=changed;const source=new TestSource(records),reader=new ExplorerReader(source);await reader.refresh();
 const result=reader.query('evaluation',new URLSearchParams({generation:reader.sourceInfo()!.registry_generation,ref:'C-approved@1'})) as any;
 assert.ok(result.status.mismatched_validation.includes(ref));assert.equal(result.status.matching_validation.length,1);
});
test('atomic comparison preserves absence and comparison orientation, permits eligible existing Composition',async()=>{
 const f=await fixture(),release=Object.entries(f.source.records).find(([ref,r])=>r.type==='release' && ref!=='R0@1')![0];
 const a=f.read('diff',{left:'R0@1',right:release,limit:'100'});assert.equal(a.total,3);const added=a.items.find((r:any)=>r.path==='acceptance.layer-reminder');assert.equal(added.before.kind,'absent');assert.equal(added.after.kind,'value');
 const swapped=f.read('diff',{left:release,right:'R0@1',limit:'100'});assert.equal(swapped.items.find((r:any)=>r.path==='acceptance.layer-reminder').after.kind,'absent');
 assert.equal(f.read('diff',{left:release,right:'C-approved@1'}).total,0);assert.equal(f.read('diff',{left:'R0@1',right:'R0@1'}).total,0);
 assert.ok(f.read('diff',{left:'R0@1',right:'R0@1',all:'true',limit:'100'}).total>3);assert.throws(()=>f.read('diff',{left:'R0@1',right:'L-hold@1'}),code('REF_NOT_FOUND'));
});
test('private and absent refs are indistinguishable; visibility applies to counts and cursors',async()=>{
 const f=await fixture();const draft=structuredClone(f.source.records['L-hold@1']);draft.published=false;draft.data.id='L-private';f.source.records['L-private@1']=draft;await f.reader.refresh();
 const query=(ref:string)=>{try{f.read('record',{ref,type:'layer'});}catch(e){return {code:(e as any).code,message:(e as any).message,status:(e as any).status};}};
 assert.deepEqual(query('L-private@1'),query('L-absent@1'));assert.equal(f.read('records',{type:'layer'}).total,4);
 const paged=f.read('records',{type:'layer',limit:'1'});assert.throws(()=>f.read('records',{type:'release',cursor:paged.next_cursor}),code('STALE_CURSOR'));
});

test('authority-only snapshot changes show exact Release, scope and guardian policies in both orientations',async()=>{
 const records=await sample(), changed=structuredClone(records['R0@1']);changed.data.id='R-authority';
 changed.data.authorities.release=['new-release-operator'];
 changed.data.authorities.scopes[0].selectors=['new-scope-selector'];
 changed.data.authorities.guardians[0].principal='new-guardian';records['R-authority@1']=changed;
 const source=new TestSource(records),reader=new ExplorerReader(source);await reader.refresh();const original=canonical(source.records);
 const read=(left:string,right:string,extra={})=>reader.query('diff',new URLSearchParams({generation:reader.sourceInfo()!.registry_generation,left,right,limit:'100',...extra})) as any;
 const forward=read('R0@1','R-authority@1');assert.equal(forward.total,3);assert.ok(forward.items.every((r:any)=>r.kind==='authority' && r.changed));
 const release=forward.items.find((r:any)=>r.path==='authorities.release');assert.deepEqual(release.after.value,['new-release-operator']);assert.deepEqual(release.before.value,records['R0@1'].data.authorities.release);
 assert.ok(forward.items.some((r:any)=>r.path.startsWith('authorities.scopes.') && r.after.value[0].selectors[0]==='new-scope-selector'));
 assert.ok(forward.items.some((r:any)=>r.path.startsWith('authorities.guardians.') && r.after.value[0].principal==='new-guardian'));
 const reverse=read('R-authority@1','R0@1');for(const row of forward.items){const swapped=reverse.items.find((r:any)=>r.path===row.path);assert.deepEqual(swapped.before,row.after);assert.deepEqual(swapped.after,row.before);}
 assert.match(forward.coverage,/current approvals and evidence.*separately/);assert.equal(canonical(source.records),original);
});

test('authority additions and removals preserve absence, paging, and unchanged policy order is not a change',async()=>{
 const records=await sample();for(const ref of Object.keys(records))if(ref!=='R0@1')delete records[ref];
 records['R0@1'].data.authorities.scopes=records['R0@1'].data.authorities.scopes.filter((s:any)=>s.block!=='booking.hold');
 records['R0@1'].data.authorities.release.push('second-release-operator');
 records['R0@1'].data.authorities.scopes[0].selectors.push('second-selector');
 records['R0@1'].data.authorities.guardians.push({...records['R0@1'].data.authorities.guardians[0],principal:'second-guardian'});
 const changed=structuredClone(records['R0@1']);changed.data.id='R-authority';
 changed.data.authorities.scopes.push({block:'booking.hold',selectors:['selector-hold']});changed.data.authorities.guardians=[];records['R-authority@1']=changed;
 const source=new TestSource(records),reader=new ExplorerReader(source);await reader.refresh();
 const read=(extra={})=>reader.query('diff',new URLSearchParams({generation:reader.sourceInfo()!.registry_generation,left:'R0@1',right:'R-authority@1',limit:'1',...extra})) as any;
 const first=read(),second=read({cursor:first.next_cursor});assert.equal(first.total,2);assert.equal(second.next_cursor,null);
 const rows=[...first.items,...second.items];assert.equal(rows.find((r:any)=>r.path==='authorities.scopes.booking.hold').before.kind,'absent');assert.equal(rows.find((r:any)=>r.path.startsWith('authorities.guardians.')).after.kind,'absent');
 const equivalent=structuredClone(records['R0@1']);equivalent.data.id='R-authority';equivalent.data.authorities.release.reverse();equivalent.data.authorities.scopes.reverse();for(const scope of equivalent.data.authorities.scopes)scope.selectors.reverse();equivalent.data.authorities.guardians.reverse();source.records['R-authority@1']=equivalent;await reader.refresh();
 assert.equal(read().total,0);const all=read({all:'true',limit:'100'});assert.ok(all.items.some((r:any)=>r.kind==='authority'));assert.ok(all.items.every((r:any)=>!r.changed));
 equivalent.published=false;await reader.refresh();assert.throws(()=>read(),code('REF_NOT_FOUND'));
});
test('paging beyond 100 records is complete and generation/cursor changes never silently restart',async()=>{
 const f=await fixture();for(let i=0;i<130;i++){const r=structuredClone(f.source.records['L-hold@1']);r.data.id='Page-'+String(i).padStart(3,'0');f.source.records[r.data.id+'@1']=r;}await f.reader.refresh();
 const generation=f.reader.sourceInfo()!.registry_generation;const read=(q:any)=>f.reader.query('records',new URLSearchParams({generation,type:'layer',limit:'100',...q})) as any;
 const first=read({}),second=read({cursor:first.next_cursor});assert.equal(first.items.length,100);assert.equal(second.items.length,34);assert.equal(new Set([...first.items,...second.items].map(r=>r.ref)).size,134);
 const old=first.next_cursor;delete f.source.records['Page-000@1'];await f.reader.refresh();assert.throws(()=>read({cursor:old}),code('STALE_GENERATION'));assert.throws(()=>f.reader.query('records',new URLSearchParams({generation:f.reader.sourceInfo()!.registry_generation,type:'layer',cursor:old})),code('STALE_CURSOR'));
});
test('network failure retains explicitly stale authorized generation; denial/corruption clears it',async()=>{
 const f=await fixture();f.source.failure=new ExplorerError('SOURCE_UNAVAILABLE',503,'Synthetic network failure',true);await assert.rejects(f.reader.refresh());assert.equal(f.reader.sourceInfo()!.freshness,'stale-network');assert.equal(f.read('blocks',{at:'R0@1'}).total,4);
 f.source.failure=null;await f.reader.refresh();assert.equal(f.reader.sourceInfo()!.freshness,'fixed-snapshot');
 f.source.failure=new ExplorerError('SOURCE_AUTH',403,'Synthetic denied');await assert.rejects(f.reader.refresh());assert.equal(f.reader.connection().ready,false);assert.throws(()=>f.read('blocks',{at:'R0@1'}),code('CONNECTION_NOT_READY'));
 f.source.failure=null;await f.reader.refresh();f.source.records['R0@1'].data.blocks['booking.hold'].parent='missing';await assert.rejects(f.reader.refresh(),code('CORRUPT_DATA'));assert.equal(f.reader.connection().ready,false);
});
test('refresh is single flight and rechecks permission after load; cached projections reauthorize',async()=>{
 const f=await fixture();let finish!:()=>void;const wait=new Promise<void>(resolve=>{finish=resolve;});const original=f.source.load.bind(f.source);f.source.load=async()=>{await wait;return original();};
 const pending=f.reader.refresh();await assert.rejects(f.reader.refresh(),code('REFRESH_BUSY'));f.source.authorized=false;finish();await assert.rejects(pending);assert.throws(()=>f.read('blocks',{at:'R0@1'}));
 f.source.authorized=true;assert.equal(f.reader.connection().ready,false);
});
test('all Explorer reads and refresh leave fixture records unchanged and invoke no Engine writer method',async()=>{
 const forbidden=['store','init','layer','publish','compose','resolution','approve','realize','registerRealization','validate','release'];const originals=new Map<string,any>();
 for(const name of forbidden){originals.set(name,(Engine.prototype as any)[name]);(Engine.prototype as any)[name]=()=>{throw new Error('Writer invoked: '+name);};}
 try{const f=await fixture(),before=canonical(f.source.records);for(const type of ['release','layer','composition','resolution','approval','validation','realization']) {const rows=f.read('records',{type});for(const r of rows.items)f.read('record',{type,ref:r.ref});}f.read('blocks',{at:'R0@1'});f.read('block',{at:'R0@1',id:'booking.hold'});f.read('relations',{at:'R0@1',id:'booking.hold'});f.read('evaluation',{ref:'C-demo@1'});f.read('diff',{left:'R0@1',right:'C-approved@1'});await f.reader.refresh();assert.equal(canonical(f.source.records),before);}finally{for(const[name,method]of originals)(Engine.prototype as any)[name]=method;}
});
test('v0.2 reader reports structural-only and does not manufacture current mediation or comparison eligibility',async()=>{
 const records=await sample();for(const key of Object.keys(records))if(!['R0@1','L-hold@1','L-reminder@1','L-alternative@1','C-demo@1'].includes(key))delete records[key];
 for(const r of Object.values(records))r.data.model_version=CONTENT_MODEL;
 for(const b of Object.values(records['R0@1'].data.blocks) as any[]){b.description={format:'plain-text/1',text:'Synthetic background'};b.asset_refs={};}
 const source=new TestSource(records);(source.connection as any).model_version=CONTENT_MODEL;const reader=new ExplorerReader(source);await reader.refresh();const generation=reader.sourceInfo()!.registry_generation;
 const e=reader.query('evaluation',new URLSearchParams({generation,ref:'C-demo@1'})) as any;assert.equal(e.coverage,'structural-only');assert.equal(e.effective_available,false);assert.equal(e.status.authority_coverage,'Current authority checks unavailable');
});
