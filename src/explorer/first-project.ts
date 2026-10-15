import { z } from 'zod';
import { BLOCK_MODEL, blockSnapshotSchema, digest, fail } from '../model.js';
import { accountStoreV2Schema, policyStoreV2Schema } from '../auth/host-issuer.js';
import { WORKFLOW_READS } from '../workflow.js';
import { initialCollectionBlocks } from '../profiles/collection-semantics.js';
import { recognizeHostCollection } from '../profiles/collection-host-semantics.js';
import type { NamespacePolicy } from './namespace-policy.js';

/** Operator input for NEW projects only. Namespace consent seals this exact value.
 * One named person holds these roles; this does not promise independent review. */
export const firstProjectSchema = z.object({
  format: z.literal('strata-studio-first-project/1'),
  template: z.literal('collection-host/1'),
  authority: z.literal('single-human-author-reviewer-validator-release'),
  lifetime: z.object({mode:z.literal('until'),expires_at:z.string().datetime()}).strict(),
  max_items: z.number().int().min(1).max(1000),
  max_title_length: z.number().int().min(1).max(200),
}).strict();
export type FirstProject = z.infer<typeof firstProjectSchema>;
export const FIRST_PROJECT_OPERATIONS = [...new Set([...WORKFLOW_READS,'inspect','status','diff','conflicts','context.show',
  'context.use','init','layer.create','layer.revise','layer.restore','layer.publish','content.review','compose',
  'conflicts.report','approve','materialize','realization.register','evidence.run','criterion.review','validate','release'])];
// Fixed server-owned paths. Each materialization refuses occupied output. No caller paths.
export const FIRST_PROJECT_OUTPUT_SLOTS = Object.fromEntries(
  ['baseline','change',...Array.from({length:14},(_,n)=>'run'+String(n+1).padStart(2,'0'))]
    .map(id=>[id,'.strata/releases/'+id]));

/** Pure provisioning port: caller binds returned accounts/policy into the repository
 * grant and immutable genesis before init. No sessions, files, approvals or runs. */
export function provisionFirstProject(policy:NamespacePolicy,project_id:string,purpose:string,now=Date.now()) {
  const spec=firstProjectSchema.parse(policy.first_project);
  if(Date.parse(spec.lifetime.expires_at)<=now)fail('ACCESS_REVOKED',4,'The first-project human authority has expired.');
  const principal=policy.principal_id;
  const accounts=accountStoreV2Schema.parse({format:'strata-host-accounts/2',generation:1,accounts:[{
    account_id:policy.account_id,principal_id:principal,principal_kind:'person',active:true,credential_epoch:1,
    credential:{method:'installation-owner',installation_id:policy.installation_id,owner_id:policy.owner_id}}]});
  const actorPolicy=policyStoreV2Schema.parse({format:'strata-host-policy/2',project_id,generation:1,grants:[{
    grant_id:'first-project-human',principal_id:principal,operations:FIRST_PROJECT_OPERATIONS,layer_ids:null,
    write_block_ids:['collection','items','policy','audit'],create_under_block_ids:['collection'],
    approvals:['scope','guardian','release'],profiles:['collection-host/1'],lifetime:spec.lifetime}]});
  const blocks=initialCollectionBlocks(spec);
  for(const block of Object.values(blocks))Object.assign(block,{description:{format:'plain-text/1',text:block.id==='collection'?purpose:''},asset_refs:{}});
  const baseline=blockSnapshotSchema.parse({id:'ProjectBaseline',revision:1,model_version:BLOCK_MODEL,root:'collection',blocks,
    authorities:{scopes:[{block:'collection',selectors:[principal]}],release:[principal],
      guardians:[{item:'policy/requirements.atomic',principal}]},deleted_ids:[]});
  recognizeHostCollection(baseline);
  return {accounts,policy:actorPolicy,baseline,first_project:spec,output_slots:{...FIRST_PROJECT_OUTPUT_SLOTS},
    authority_sha256:digest(spec)};
}
