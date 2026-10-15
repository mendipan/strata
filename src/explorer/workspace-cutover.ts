import {z} from 'zod';
import {canonical,digest,fail,MODEL} from '../model.js';
import {snapshotFromRelease} from '../core.js';
import {HostIssuer,accountStoreV2Schema,policyStoreV2Schema} from '../auth/host-issuer.js';
import {repositoryGrantSchema,repositoryGrantDigest,workspaceHash,WORKSPACE_WRITES} from './workspace-policy.js';
import {writerImportSchema,validateWriterImport,assertFreshWorkspacePrincipal} from './workspace-import.js';
import {initialWorkspaceBudget} from './workspace-budget.js';
import {initialWorkspaceState} from './workspace-state.js';
import {NODE_STATE_FORMAT} from '../node-state.js';
import {WORKFLOW_READS} from '../workflow.js';
const custodySchema=z.object({old_catalog:workspaceHash,old_ledger:workspaceHash,old_policy:workspaceHash,
  old_source:workspaceHash,writer_registry:workspaceHash,owner_binding:workspaceHash}).strict();
// Pure preparation/check only. No activation, filesystem creation, grant issuance,
// provider access or credential retrieval is reachable from this module.
export function prepareWorkspaceCutover(value:unknown){
  const input=z.object({grant:repositoryGrantSchema,import:writerImportSchema,accounts:accountStoreV2Schema,
    policy:policyStoreV2Schema,custody:custodySchema}).strict().parse(value);
  const g=input.grant,imported=input.import,validated=validateWriterImport(imported,g),a=input.accounts.accounts[0],p=input.policy.grants[0];
  new HostIssuer(input.accounts,input.policy);
  if(a)assertFreshWorkspacePrincipal(validated.records,a.principal_id);
  if(input.accounts.accounts.length!==1||input.policy.grants.length!==1||!a.active||a.principal_kind!=='person'||a.credential.method!=='installation-owner'||
    a.credential.owner_id!==g.owner_id||a.credential.installation_id!==g.installation_id||p.principal_id!==a.principal_id||input.policy.project_id!==g.project_id||
    digest({accounts:input.accounts,policy:input.policy})!==g.actor_binding_sha256||canonical(p.lifetime)!==canonical(g.lifetime)||p.approvals.length||p.profiles.length||p.create_under_block_ids.length||
    p.operations.some(o=>![...WORKFLOW_READS,'inspect','status','diff','conflicts','context.show',...WORKSPACE_WRITES].includes(o as any))||
    p.write_block_ids.some(block=>!Object.values(validated.records).some(r=>r.type==='release'&&Object.hasOwn(snapshotFromRelease(r.data).blocks,block))))
    fail('WORKSPACE_NOT_CONFIGURED',4,'The exact owner and compatible authoring scope require root approval.');
  if(digest(input.custody)!==imported.origin.old_lineage_sha256||input.custody.writer_registry!==digest(imported.registry))
    fail('WRITER_IMPORT_REQUIRED',4,'Fresh custody hashes must bind the complete writer and carried spending.');
  const prepared={format:'strata-studio-workspace-cutover/1' as const,grant_sha256:repositoryGrantDigest(g),import_sha256:digest(imported),
    actor_sha256:g.actor_binding_sha256,custody:input.custody,carried_usage:imported.origin,
    initial_descriptor:{format:NODE_STATE_FORMAT,project_id:g.project_id,model_version:MODEL},
    initial_registry_sha256:digest(imported.registry),initial_budget:initialWorkspaceBudget(g,imported.origin),initial_control:initialWorkspaceState(g,digest(imported.origin)),
    cache:Object.values(imported.registry.entries).map(e=>({path:e.locator.path,hash:e.hash,size_bytes:e.locator.size_bytes})),
    requires:{writer_stopped:true,service_stopped:true,protected_backup:true,
      provider_identity_evidence:g.provider_contract!=='development-name-addressed',
      development_provider_acknowledgment:g.provider_contract==='development-name-addressed',owner_action_time_approval:true}};
  return {...prepared,preparation_sha256:digest(prepared)};
}
export function checkWorkspaceCutover(prepared:ReturnType<typeof prepareWorkspaceCutover>,fresh:Parameters<typeof prepareWorkspaceCutover>[0]){
  const current=prepareWorkspaceCutover(fresh);
  if(canonical(current)!==canonical(prepared))fail('STALE_GENERATION',5,'Cutover custody or spending changed. Prepare and review a fresh packet.');
  return {matched:true as const,preparation_sha256:current.preparation_sha256,activation_performed:false as const};
}
