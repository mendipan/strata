import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { digest, canonical } from '../model.js';
import { noLinks } from '../node-state.js';
import { connectionSchema, problem, safeJson } from './contract.js';
import { trustedFile } from './source.js';

const id=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/), key=z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/);
export const managementActions=['create','test','select','connect','disconnect','renew','remove'] as const;
export const sourcePolicySchema=z.object({
  format:z.literal('strata-studio-source-policy/1'),installation_id:id,owner_id:id,catalog_id:id,
  policy_id:id,generation:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1),initial_catalog_sha256:hash,
  valid_until:z.string().datetime(),actions:z.array(z.enum(managementActions)).min(1).max(7),
  profiles:z.array(z.object({profile_id:key,label:z.string().min(1).max(128),registry_sha256:hash.optional()}).strict()).min(1).max(8),
  tickets:z.array(z.object({ticket_id:id,grant_id:id,profile_id:key,not_before:z.string().datetime(),
    connection:connectionSchema,expected_repository_id:key}).strict()).min(1).max(64),
}).strict().superRefine((policy,ctx)=>{
  const unique=(values:string[])=>new Set(values).size===values.length;
  if(!unique(policy.actions)||!unique(policy.profiles.map(p=>p.profile_id))||!unique(policy.tickets.map(t=>t.ticket_id))||!unique(policy.tickets.map(t=>t.grant_id)))ctx.addIssue({code:'custom',message:'Policy identifiers must be unique.'});
  const first=policy.tickets[0];
  const scope=(t:typeof first)=>canonical({project:t.connection.project_id,model:t.connection.model_version,storage:t.connection.storage,repo:t.expected_repository_id});
  for(const ticket of policy.tickets){
    const c=ticket.connection,profile=policy.profiles.find(p=>p.profile_id===ticket.profile_id);
    if(!profile||scope(ticket)!==scope(first)||c.storage.project_id!==c.project_id||c.read_authorization.project_id!==c.project_id||
      c.read_authorization.policy_generation!==`grant-${ticket.grant_id}`||Date.parse(c.read_authorization.expires_at)>Date.parse(policy.valid_until)||
      Date.parse(ticket.not_before)>=Date.parse(c.read_authorization.expires_at)||!path.isAbsolute(c.registry_path)||path.resolve(c.registry_path)!==c.registry_path||
      (c.registry_kind==='fixed-snapshot'&&!profile.registry_sha256))ctx.addIssue({code:'custom',message:'Each ticket requires an exact approved source and unique grant binding.'});
    const sibling=policy.tickets.find(t=>t.profile_id===ticket.profile_id)!;
    if(c.registry_path!==sibling.connection.registry_path||c.registry_kind!==sibling.connection.registry_kind||c.initial_release_ref!==sibling.connection.initial_release_ref)ctx.addIssue({code:'custom',message:'A profile cannot substitute its registry or initial Release.'});
  }
  if(!unique(policy.tickets.map(t=>digest({connection:t.connection,expected_repository_id:t.expected_repository_id}))))ctx.addIssue({code:'custom',message:'A grant binding cannot receive multiple ledgers.'});
});
export type SourcePolicy=z.infer<typeof sourcePolicySchema>;
export interface SourcePolicyPort { current():Promise<SourcePolicy|undefined> }
export const policyDigest=(p:SourcePolicy)=>{const {initial_catalog_sha256,...binding}=p;return digest(binding);};
export function managementRequired():never{return problem('SOURCE_MANAGEMENT_REQUIRED',403,'The host must approve this owner, source and finite read grants.');}
export function connectionRecovery():never{return problem('CONNECTION_RECOVERY_REQUIRED',503,'Protected connection state needs authenticated operator reconciliation.');}
export class FileSourcePolicy implements SourcePolicyPort {
  constructor(readonly filename:string){if(!path.isAbsolute(filename)||path.resolve(filename)!==filename)connectionRecovery();}
  async current(){
    try{
      await noLinks(this.filename);let current=this.filename;
      for(;;){const meta=await lstat(current);if(meta.isSymbolicLink()||(process.platform!=='win32'&&(meta.uid!==0||(meta.mode&0o022))))connectionRecovery();if(current===this.filename&&(!meta.isFile()||meta.size>256*1024))connectionRecovery();const parent=path.dirname(current);if(parent===current)break;current=parent;}
      const parsed=sourcePolicySchema.safeParse(safeJson(await trustedFile(this.filename,256*1024),256*1024));if(!parsed.success)connectionRecovery();return parsed.data;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  }
}
