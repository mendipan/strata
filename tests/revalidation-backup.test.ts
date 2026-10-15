import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp,readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {canonical,digest,type Records} from '../src/model.js';
import {createBackup,verifyBackup} from '../src/backup.js';
import {revalidationFixture} from './revalidation-fixture.js';
import {recordPin} from '../src/revalidation.js';
import {INACTIVE_MARKER} from '../src/node-state.js';
import {verifyRetainedRevalidation} from '../src/revalidation-producers.js';

async function forgeBundle(original:string,out:string,records:Records,edit:(records:Records,replacements:Map<string,string>)=>void) {
  await cp(original,out,{recursive:true});const replacements=new Map<string,string>();edit(records,replacements);
  const checkpoint=JSON.parse(await readFile(path.join(out,'checkpoint.json'),'utf8'));
  const manifest=JSON.parse(await readFile(path.join(out,'manifest.json'),'utf8'));
  const mapRef=(ref:string)=>replacements.get(ref)??ref;
  for(const entry of Object.values(checkpoint.entries)as any[])await unlink(path.join(out,'artifacts',entry.hash+'.json'));
  checkpoint.entries={};
  for(const [ref,r]of Object.entries(records)){const hash=digest(r.data);await writeFile(path.join(out,'artifacts',hash+'.json'),canonical(r.data));checkpoint.entries[ref]={hash,type:r.type,published:r.published};}
  checkpoint.commit_audit.forEach((e:any)=>e.references=e.references.map(mapRef));
  for(const receipt of checkpoint.historical_requests){receipt.result.created=receipt.result.created.map(mapRef);for(const field of ['ref','completion_ref','run_ref','auth_ref'])if(receipt.result.data[field])receipt.result.data[field]=mapRef(receipt.result.data[field]);}
  await writeFile(path.join(out,'checkpoint.json'),canonical(checkpoint));
  const audit=(await readFile(path.join(out,'audit.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));audit.forEach(e=>e.references=e.references.map(mapRef));await writeFile(path.join(out,'audit.jsonl'),audit.map(e=>canonical(e)).join('\n')+'\n');
  const paths=manifest.inventory.filter((i:any)=>!i.path.startsWith('artifacts/')).map((i:any)=>i.path);
  paths.push(...[...new Set(Object.values(checkpoint.entries).map((e:any)=>'artifacts/'+e.hash+'.json'))]);
  manifest.inventory=[];for(const name of paths.sort()){const body=await readFile(path.join(out,name));manifest.inventory.push({path:name,sha256:digestBytes(body),bytes:body.length});}
  manifest.roots=Object.keys(checkpoint.entries).sort();manifest.checkpoint_sha256=digestBytes(await readFile(path.join(out,'checkpoint.json')));
  const sha=digest(manifest);await writeFile(path.join(out,'manifest.json'),canonical(manifest));await writeFile(path.join(out,'COMPLETE.json'),canonical({format:'strata-backup-complete/1',manifest_sha256:sha}));
  await writeFile(path.join(out,INACTIVE_MARKER),canonical({format:'strata-recovery-inactive/1',project_id:manifest.project_id,manifest_sha256:sha,identities_active:false,requests_active:false}));
  return {sha,records};
}
import {bytesDigest as digestBytes} from '../src/model.js';
function replace(records:Records,replacements:Map<string,string>,ref:string,edit:(data:any)=>void) {
  const {type,published,data}=records[ref];edit(data);delete records[ref];const next=type+'@'+digest(data);records[next]={type,published,data};replacements.set(ref,next);return recordPin(next,data);
}
test('R1-C history and backup refuse fully rehashed action, measurement and expiry contradictions',async()=>{
  const f=await revalidationFixture();try{
    const completed=await f.submit();assert.equal(completed.ok,true,JSON.stringify(completed.errors));const records=await f.records();await f.close();
    const exported=await createBackup({state:f.state,out:path.join(f.root,'original'),project:f.issuer.projectId,selector:'fixture-backup',maxBytes:16777216});
    const baseline=await verifyBackup({bundle:exported.output,project:f.issuer.projectId,selector:'fixture-backup',expectedDigest:exported.manifest_sha256});assert.equal(baseline.historical_completion_verified,true);
    const run=records[completed.data.run_ref].data;assert.ok(Date.parse(records[run.auth.ref].data.issued_at)>=Date.parse(run.finished_at));assert.equal(verifyRetainedRevalidation(records,f.issuer.projectId).verified,true);
    const outcomes:Record<string,unknown>={baseline};
    const modes=['action','runner','missing','add-total','add-missing','add-extra','limit-total','invalid-values','run-before-start','run-at-finish','run-at-completion','review-at-completion'];
    for(const mode of modes){
      const out=path.join(f.root,mode),forged=await forgeBundle(exported.output,out,structuredClone(records),(copy,map)=>{
        const completion=copy[completed.data.ref].data,run=copy[completed.data.run_ref].data;
        if(mode==='missing'){delete copy[completed.data.run_ref];return;}
        if(mode==='action')run.auth=replace(copy,map,run.auth.ref,d=>{d.action='drift.revalidate';d.action_input={action:'drift.revalidate',request:completion.request,bridge_sha256:d.bridge_sha256};d.input_sha256=digest(d.action_input);});
        else if(mode==='runner'){run.descriptor.runner_source+='\n// Substituted implementation';run.descriptor.implementation_sha256=digest({worker_source:run.descriptor.worker_source,runner_source:run.descriptor.runner_source,recognizer_source:run.descriptor.recognizer_source});run.descriptor_sha256=digest(run.descriptor);}
        else if(mode.startsWith('run-')){
          const expiry=mode==='run-before-start'?new Date(Date.parse(run.started_at)-1000).toISOString():mode==='run-at-finish'?run.finished_at:completion.completed_at;
          run.auth=replace(copy,map,run.auth.ref,d=>{d.expires_at=expiry;d.issued_at=new Date(Date.parse(expiry)-1000).toISOString();});
        }else if(mode==='review-at-completion'){
          const review=copy[completion.criterion_review.ref].data;
          review.auth=replace(copy,map,review.auth.ref,d=>{d.expires_at=completion.completed_at;d.issued_at=new Date(Date.parse(d.expires_at)-1000).toISOString();});
          completion.criterion_review=replace(copy,map,completion.criterion_review.ref,()=>{});
        }else{
          const checks=run.observations.checks;
          if(mode==='add-total')checks['counter.add'].observations.total=999;
          if(mode==='add-missing')delete checks['counter.add'].observations.total;
          if(mode==='add-extra')checks['counter.add'].observations.extra='unobserved';
          if(mode==='limit-total')checks['counter.limit'].observations.total=999;
          if(mode==='invalid-values')checks['counter.invalid'].observations.invalid=[0];
          run.observations_sha256=digest(run.observations);
        }
        completion.run=replace(copy,map,completed.data.run_ref,()=>{});replace(copy,map,completed.data.ref,()=>{});
      });
      const expected=mode.startsWith('run-')||mode==='review-at-completion'?'REVALIDATION_AUTH_EXPIRED':undefined;
      let historyCode:string|undefined,backupCode:string|undefined;
      assert.throws(()=>verifyRetainedRevalidation(forged.records,f.issuer.projectId),(e:any)=>{historyCode=e.code;return !expected||e.code===expected;});
      await assert.rejects(verifyBackup({bundle:out,project:f.issuer.projectId,selector:'fixture-backup',expectedDigest:forged.sha}),(e:any)=>{backupCode=e.code;return !expected||e.code===expected;});
      outcomes[mode]={history_refusal:historyCode,backup_refusal:backupCode,manifest_sha256:forged.sha};
    }
    if(process.env.STRATA_R1_FIX_EVIDENCE_DIR){await writeFile(path.join(process.env.STRATA_R1_FIX_EVIDENCE_DIR,'history-backup-refusals.json'),canonical(outcomes));}
  }finally{await f.close();}
});
