import { Worker } from 'node:worker_threads';
import { canonical, fail } from './model.js';

/** Host-owned fixed worker only. Caller JSON cannot choose a module, command or limits. */
export async function boundedRevalidationWorker(url:URL,packet:unknown,signal?:AbortSignal) {
  if(signal?.aborted)fail('REVALIDATION_INTERRUPTED',5,'Revalidation was interrupted before execution.');
  const worker=new Worker(url,{workerData:packet,resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16},execArgv:[]});
  let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
  try {
    return await new Promise<any>((resolve,reject)=>{
      let received=false;
      timer=setTimeout(()=>reject(new Error('timeout')),5000);
      abort=()=>reject(new Error('interrupted'));signal?.addEventListener('abort',abort,{once:true});
      worker.once('message',message=>{
        try{if(Buffer.byteLength(canonical(message))>262144)throw new Error('IPC bound');received=true;resolve(message);}catch(e){reject(e);}
      });
      worker.once('error',reject);
      worker.once('exit',()=>{if(!received)reject(new Error('worker exited without a result'));});
    });
  } catch {
    if(signal?.aborted)fail('REVALIDATION_INTERRUPTED',5,'Revalidation was interrupted.');
    fail('REVALIDATION_WORKER_FAILED',6,'The finite worker crashed, timed out or exceeded its IPC bound.');
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    // Never publish while a worker may still be running, including error/timeout paths.
    await worker.terminate();
  }
}
