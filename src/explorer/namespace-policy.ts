import path from 'node:path';
import { z } from 'zod';
import { MODEL, BLOCK_MODEL, digest } from '../model.js';
import { workspaceHash, workspaceId, workspaceLimitsSchema, WORKSPACE_PROVIDER_OPERATIONS } from './workspace-policy.js';
import { firstProjectSchema } from './first-project.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const NAMESPACE_OPERATIONS = ['namespace.info', 'repository.list', 'repository.create', 'token.list', ...WORKSPACE_PROVIDER_OPERATIONS] as const;
export const namespacePolicySchema = z.object({
  format: z.literal('strata-studio-namespace-policy/1'), installation_id: z.string().uuid(), owner_id: z.string().uuid(),
  lineage_id: z.string().uuid(), account: z.string().regex(/^[a-f0-9]{32}$/), namespace: workspaceId,
  lifetime: z.object({mode:z.literal('until-revoked'),expires_at:z.null()}).strict(),
  permissions: z.tuple([z.literal('discover'),z.literal('create'),z.literal('read'),z.literal('draft')]),
  principal_id: workspaceId, account_id: workspaceId,
  provider_contract: z.literal('development-name-addressed'),
  operator_rule: z.literal('no-delete-recreate-or-rebind-during-write-or-reconciliation'),
  automatic_creation_token: z.literal('discard-secret-and-allow-provider-expiry'),
  automatic_token_max_lifetime_seconds:z.number().int().min(60).max(366*86400),
  limits: workspaceLimitsSchema, max_projects: z.number().int().min(1).max(64),
  first_project: firstProjectSchema.optional(),
}).strict();
export type NamespacePolicy = z.infer<typeof namespacePolicySchema>;
export const namespacePolicyDigest = (policy:NamespacePolicy) => digest(namespacePolicySchema.parse(policy));
const absolute = z.string().max(4096).refine(p=>path.isAbsolute(p)&&path.resolve(p)===p);
export const namespaceConfigSchema = z.object({policy_file:absolute,catalog_directory:absolute,projects_directory:absolute,import_catalog_file:absolute.optional()}).strict();
export type NamespaceConfig = z.infer<typeof namespaceConfigSchema>;
export const namespaceRepositorySchema = z.object({id:workspaceId,name:workspaceId,remote:z.string().max(1024),read_only:z.boolean()}).strict();
export type NamespaceRepository = z.infer<typeof namespaceRepositorySchema>;
export const namespaceProjectSchema = namespaceRepositorySchema.extend({project_id:workspaceId,creation_id:z.string().uuid(),
  state:z.enum(['created','ready']),automatic_token_expires_at:z.string().datetime().nullable(),model_version:z.enum([MODEL,BLOCK_MODEL]).optional(),origin:z.literal('import').optional(),genesis_sha256:workspaceHash.nullable()}).strict();
export type NamespaceProject = z.infer<typeof namespaceProjectSchema>;
const receipt = z.object({request_id:z.string().uuid(),input_sha256:workspaceHash,action:z.enum(['approve','pause','resume','revoke','discover','select','create','import','inspect-create','recover-create','resume-drafts']),
  phase:z.enum(['pending','completed','uncertain','failed']),code:z.string().max(128).nullable(),
  repository_id:workspaceId.nullable(),repository_name:workspaceId.nullable()}).strict();
export const NAMESPACE_JOURNAL_CAPACITY = 2048;
export const namespaceStateSchema = z.object({format:z.literal('strata-studio-namespace-state/1'),binding_sha256:workspaceHash,
  revision:count,approved:z.boolean(),revoked:z.boolean(),connected:z.boolean(),selection_epoch:count,
  selected_repository_id:workspaceId.nullable(),projects:z.array(namespaceProjectSchema).max(64),
  // Full ordinary history retains one pause slot and a terminal revoke slot.
  // A direct revoke needs only one slot. No resume or new work can consume them.
  operations:z.array(receipt).max(NAMESPACE_JOURNAL_CAPACITY+2),
}).strict().superRefine((s,ctx)=>{
  const tail=s.operations.slice(NAMESPACE_JOURNAL_CAPACITY);
  if(tail.some(o=>o.phase!=='completed'||!['pause','revoke'].includes(o.action))||
    tail.length===2&&(tail[0].action!=='pause'||tail[1].action!=='revoke')||
    tail.length>0&&(s.connected||tail.some(o=>o.action==='revoke')&&!s.revoked))
    ctx.addIssue({code:'custom',message:'Reserved namespace history is only for durable pause then revoke.'});
});
export type NamespaceState = z.infer<typeof namespaceStateSchema>;
export const namespaceUsageSchema = z.object({format:z.literal('strata-studio-namespace-usage/1'),binding_sha256:workspaceHash,
  generation:count,reserved_requests:count,reserved_bytes:count,
  reservations:z.array(z.object({id:z.string().uuid(),operation:workspaceHash,kind:z.enum(NAMESPACE_OPERATIONS),maximum_bytes:count,
    requests_after:count,bytes_after:count}).strict()).max(20000),
}).strict();
// Pure provisioning output. Service startup never recreates missing state. This
// lineage is new; migration/carrying old writer or accounting is deliberately absent.
export function initialNamespaceFiles(value:NamespacePolicy) {
  const p=namespacePolicySchema.parse(value),binding_sha256=namespacePolicyDigest(p);
  return {state:namespaceStateSchema.parse({format:'strata-studio-namespace-state/1',binding_sha256,revision:0,
    approved:false,revoked:false,connected:false,selection_epoch:0,selected_repository_id:null,projects:[],operations:[]}),
    usage:namespaceUsageSchema.parse({format:'strata-studio-namespace-usage/1',binding_sha256,generation:0,
      reserved_requests:0,reserved_bytes:0,reservations:[]})};
}
