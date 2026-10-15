import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { bytesDigest } from '../src/model.js';

export async function validateLocalWorker() {
  const root=await mkdtemp(path.join(os.tmpdir(),'strata-workflow-local-'));let runtime:Miniflare|undefined;let networkDispatches=0;
  const result:Record<string,unknown>={mode:'local-only',provider_calls:0};
  const runId='a0b1c2d3e4f56789',workflowName=`strata-artifacts-flow-${runId}`,instanceId=`run-${runId}`;
  try {
    for(const kind of ['production','fixture','retry-probe'] as const){
      const entry=kind==='production'?'src/artifacts-test-worker-entry.ts':'tests/artifacts-workerd-entry.ts',file=path.join(root,kind+'.mjs'),name='strata-local-'+kind;
      await build({entryPoints:[entry],outfile:file,bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
      runtime=new Miniflare({host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},log:new Log(LogLevel.ERROR),workers:[{
        config:{name,compatibilityDate:'2026-10-03',compatibilityFlags:['nodejs_compat'],
          manifest:{mainModule:'worker.mjs',modulesRoot:root,modules:{'worker.mjs':{type:'esm',contents:await readFile(file,'utf8')}}},
          exports:{StrataArtifactsTestWorkflow:{type:'workflow',name:workflowName,limits:{steps:1},concurrency:{limit:1},
            defaultRetention:{successRetention:3600000,errorRetention:3600000}}},
          env:{STRATA_TEST_GRANT:{type:'text',value:JSON.stringify({format:'strata-artifacts-workflow-grant/1',approved:false})},
            STRATA_TEST_SCENARIO:{type:'text',value:kind},
            STRATA_TEST_WORKFLOW:{type:'workflow',name:workflowName,worker:name,exportName:'StrataArtifactsTestWorkflow',limits:{steps:1}}}},
        dev:{unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler:async()=>{networkDispatches++;throw new Error('External network prohibited in local validation.');}}}
      }]});
      const bindings=await runtime.getBindings<{STRATA_TEST_WORKFLOW:Workflow<{run_id:string}>}>();
      const instance=await bindings.STRATA_TEST_WORKFLOW.create({id:instanceId,params:{run_id:runId}});
      let status=await instance.status();
      for(let reads=0;status.status!=='complete'&&status.status!=='errored'&&reads<100;reads++){
        await new Promise(resolve=>setTimeout(resolve,50));status=await instance.status();
      }
      assert.equal(status.status,'complete',JSON.stringify(status));const data=status.output as Record<string,unknown>;
      if(kind==='production'){
        assert.equal(data.ok,false);assert.deepEqual(data.error,{code:'GRANT_REQUIRED'});
        result.production={sha256:bytesDigest(await readFile(file)),disabled_grant_refused:true,actual_workflow_engine:true,no_http_handler:true};
      }else if(kind==='fixture'){
        assert.equal((data.receipt as {ok:boolean}).ok,true);result.fixture=data;
        await assert.rejects(bindings.STRATA_TEST_WORKFLOW.create({id:instanceId,params:{run_id:runId}}));
        result.fixed_instance_duplicate_refused=true;
      }else{assert.equal(data.attempts,1);assert.equal(data.configured_retries,0);result.retry_probe=data;}
      await runtime.dispose();runtime=undefined;
    }
    assert.equal(networkDispatches,0);result.external_network_dispatches=networkDispatches;return result;
  }finally{await runtime?.dispose();await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==2){console.error('No arguments or live mode accepted.');process.exitCode=2;}
  else console.log(JSON.stringify(await validateLocalWorker(),null,2));
}
