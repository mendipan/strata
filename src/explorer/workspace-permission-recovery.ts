import { digest } from '../model.js';
import { repositoryGrantDigest, type RepositoryGrant } from './workspace-policy.js';
import type { WorkspaceState } from './workspace-state.js';

// Only the old failed permission probe is recoverable here. Any payload,
// publication or unidentified operation must retain its existing write fence.
export function recoverablePermissionChecks(state:WorkspaceState,grant:RepositoryGrant){
  const pending=state.operations.filter(o=>!['committed','cancelled_before_effect'].includes(o.phase));
  const checks=pending.filter(o=>{
    if(o.events.length!==3||o.phase!=='cleanup_unconfirmed')return false;
    const [prepared,issued,failed]=o.events;
    if(prepared.phase!=='prepared'||prepared.detail.reason!=='write-permission-test'||
      Object.keys(prepared.detail).some(k=>!['reason','provider_write_contract','provider_write_contract_sha256'].includes(k))||
      issued.phase!=='token_issue_unknown'||digest(issued.detail)!==digest({reason:'write-permission-test'})||
      failed.phase!=='cleanup_unconfirmed'||digest(failed.detail)!==digest({reason:'token-issue-not-confirmed',cleanup:'unconfirmed'}))return false;
    return state.tests.some(t=>t.kind==='test-write'&&t.error==='WORKSPACE_PROVIDER_UNAVAILABLE'&&!t.write_token_verified&&
      state.actions.some(a=>a.request_id===t.request_id&&a.action==='test-write')&&
      o.operation_id===digest({domain:'strata-studio-permission-test/1',grant:repositoryGrantDigest(grant),request_id:t.request_id}));
  });
  return checks.length===pending.length?checks:null;
}
