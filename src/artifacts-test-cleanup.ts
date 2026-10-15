import { TEST_LIMITS } from './artifacts-test-worker.js';

// Local injected coordination only; no credentials or live provider transport.
export type CleanupPort = {
  instanceQuiescent():Promise<boolean>; instanceTerminate():Promise<unknown>; instanceDelete():Promise<unknown>; instanceAbsent():Promise<boolean>;
  workflowDelete():Promise<unknown>; workflowAbsent():Promise<boolean>;
  workerDelete():Promise<unknown>; workerAbsent():Promise<boolean>;
  repositoryDelete():Promise<unknown>; repositoryAbsent():Promise<boolean>;
  namespaceEmpty():Promise<boolean>; namespaceDelete():Promise<unknown>; namespaceAbsent():Promise<boolean>;
};
export type RunOwnership = {run_id:string; instance_created_by_run:boolean; workflow_created_by_run:boolean;
  worker_created_by_run:boolean; repository_created_by_run:boolean; namespace_created_by_run:boolean; worker_dispatches:number;
  worker_pending_dispatches:number|null; observed_tokens_and_handles_clean:boolean};
export async function cleanupDedicatedRun(owner:RunOwnership,port:CleanupPort,now:()=>number=Date.now) {
  const actions:string[]=[];let pending=0;const started=now();
  const state={instance_quiescent:false,instance_absent:false,workflow_absent:false,worker_absent:false,repository_absent:false,namespace_absent:false};
  const call=async<K extends keyof CleanupPort>(name:K):Promise<Awaited<ReturnType<CleanupPort[K]>>>=>{
    const remaining=TEST_LIMITS.cleanup_ms-(now()-started);if(remaining<=0)throw new Error('DEADLINE');
    actions.push(name);pending++;let timer:ReturnType<typeof setTimeout>|undefined;
    const operation=Promise.resolve().then(()=>port[name]()).finally(()=>{pending--;});
    try {return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('UNCONFIRMED')),Math.min(5000,remaining));})]) as Awaited<ReturnType<CleanupPort[K]>>;}
    finally{clearTimeout(timer);}
  };
  try {
    if(!/^[a-f0-9]{16}$/.test(owner.run_id)||!owner.instance_created_by_run||!owner.workflow_created_by_run||!owner.worker_created_by_run||
      !owner.repository_created_by_run||!owner.namespace_created_by_run||!Number.isSafeInteger(owner.worker_dispatches)||
      owner.worker_dispatches<0||owner.worker_dispatches>TEST_LIMITS.worker_dispatches)throw new Error('OWNERSHIP');
    state.instance_quiescent=await call('instanceQuiescent');
    if(!state.instance_quiescent){await call('instanceTerminate');state.instance_quiescent=await call('instanceQuiescent');}
    if(!state.instance_quiescent)throw new Error('UNCONFIRMED');
    await call('instanceDelete');state.instance_absent=await call('instanceAbsent');if(!state.instance_absent)throw new Error('UNCONFIRMED');
    await call('workflowDelete');state.workflow_absent=await call('workflowAbsent');if(!state.workflow_absent)throw new Error('UNCONFIRMED');
    await call('workerDelete');state.worker_absent=await call('workerAbsent');if(!state.worker_absent)throw new Error('UNCONFIRMED');
    // A terminal instance/deleted Worker does not prove cancellation of a late
    // Artifacts call. Stop capable resources, but preserve data for reconciliation.
    if(owner.worker_pending_dispatches!==0||!owner.observed_tokens_and_handles_clean)throw new Error('UNCONFIRMED');
    await call('repositoryDelete');for(let i=0;i<3&&!state.repository_absent;i++)state.repository_absent=await call('repositoryAbsent');
    if(!state.repository_absent||!(await call('namespaceEmpty')))throw new Error('UNCONFIRMED');
    await call('namespaceDelete');state.namespace_absent=await call('namespaceAbsent');if(!state.namespace_absent)throw new Error('UNCONFIRMED');
    return {ok:true,run_id:owner.run_id,actions,confirmed:state,pending_actions:pending,provider_cancellation_proven:false};
  }catch{
    return {ok:false,error:{code:'CLEANUP_UNCONFIRMED'},run_id:owner.run_id,actions,confirmed:state,pending_actions:pending,provider_cancellation_proven:false};
  }
}
