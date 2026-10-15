import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedRevalidationWorker} from '../src/revalidation-worker.js';
const worker=new URL('../../tests/fixtures/revalidation-worker.mjs',import.meta.url);
test('R1-C finite worker timeout, crash and oversized IPC refuse and await termination',async()=>{
  for(const mode of ['timeout','crash','ipc'])await assert.rejects(boundedRevalidationWorker(worker,{mode}),(e:any)=>e.code==='REVALIDATION_WORKER_FAILED');
});
test('R1-C worker interruption and preaborted requests produce no result',async()=>{
  const before=new AbortController();before.abort();await assert.rejects(boundedRevalidationWorker(worker,{mode:'ok'},before.signal),(e:any)=>e.code==='REVALIDATION_INTERRUPTED');
  const during=new AbortController(),timer=setTimeout(()=>during.abort(),50);
  try{await assert.rejects(boundedRevalidationWorker(worker,{mode:'timeout'},during.signal),(e:any)=>e.code==='REVALIDATION_INTERRUPTED');}finally{clearTimeout(timer);}
});
