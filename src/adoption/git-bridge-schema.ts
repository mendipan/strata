import { z } from 'zod';
import { MODEL } from '../model.js';

const text = z.string().min(1).max(4096), hash = z.string().regex(/^[a-f0-9]{64}$/), ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), strings = z.array(text).max(256);
export const gitBridgePinSchema = z.object({ ref, sha256: hash }).strict();
export const gitBridgeInputSchema = z.object({ publication_ref: ref, expected_bridge_sha256: hash.nullable() }).strict();
export const gitBridgeAuthoritySchema = z.object({ principal: text, grant_id: text, policy_version: text, authority_sha256: hash }).strict();
export const gitBridgeSchema = z.object({
  format: z.literal('git-adoption-bridge/1'), model_version: z.literal(MODEL), lane: z.literal('selected_git_patch'), plan_contract_sha256: hash,
  inventory_record: gitBridgePinSchema, inventory_document_sha256: hash, proposal_record: gitBridgePinSchema, proposal_document_sha256: hash,
  interpretation_review: gitBridgePinSchema, publication: gitBridgePinSchema, published_layer: gitBridgePinSchema,
  inventory_source: gitBridgePinSchema, binding_source: gitBridgePinSchema,
  source_relation: z.object({ project_id: text, repo_id: text, object_format: z.enum(['sha1','sha256']), head_commit: oid, head_tree: oid,
    inventory_scope_sha256: hash, binding_scope_sha256: hash,
    mapping: z.array(z.object({ item: text, unit_ids: strings.min(1), paths: strings.min(1), criteria: strings.min(1) }).strict()).min(1).max(256), preserved_paths: strings
  }).strict(),
  disclosure: gitBridgeAuthoritySchema.extend({ visibility: z.literal('project-visible-linkage'), trust: z.literal('local-fixture') }).strict()
}).strict();
export type GitBridge = z.infer<typeof gitBridgeSchema>;
export type BridgeAuthority = z.infer<typeof gitBridgeAuthoritySchema>;
export type BridgedPlan = { format: 'git-change-plan/2'; adoption_bridge: GitBridge; [key: string]: any };
export function isBridgedPlan(plan: any): plan is BridgedPlan { return plan?.format === 'git-change-plan/2'; }
