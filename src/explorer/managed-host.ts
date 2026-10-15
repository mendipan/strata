import path from 'node:path';
import { z } from 'zod';
import { FileSourcePolicy } from './connection-policy.js';
import { ConnectionStore } from './connection-store.js';
import { ManagedConnections } from './connection-manager.js';
import { ArtifactsManagedReaders } from './managed-reader.js';
import { BootstrapState } from './bootstrap-state.js';
import { OwnerAccess } from './owner-access.js';
import type { HostedOptions } from './hosted.js';
import { problem } from './contract.js';
const nested=(a:string,b:string)=>{const relative=path.relative(a,b);return !path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
export const sourceManagementConfigSchema=z.object({policy_file:z.string().max(4096),catalog_directory:z.string().max(4096),accounting_directory:z.string().max(4096)}).strict().superRefine((c,ctx)=>{
  const values=Object.values(c);if(values.some(p=>!path.isAbsolute(p)||path.resolve(p)!==p))ctx.addIssue({code:'custom',message:'Source management paths require canonical absolute paths.'});
  for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++)if(nested(values[i],values[j])||nested(values[j],values[i]))ctx.addIssue({code:'custom',message:'Policy, catalog and accounting paths must be distinct and disjoint.'});
});
export function createManagedOwner(state:BootstrapState,input:z.infer<typeof sourceManagementConfigSchema>,host:HostedOptions,transport:typeof fetch=fetch){
  const config=sourceManagementConfigSchema.parse(input);
  for(const value of Object.values(config))for(const protectedPath of Object.values(state.config))if(nested(value,protectedPath)||nested(protectedPath,value))throw new Error('Source management must be separate from owner/control/key/credential state.');
  const policy=new FileSourcePolicy(config.policy_file),readers=new ArtifactsManagedReaders(policy,async()=>{const owner=await state.owner();if(!owner)problem('OWNER_SESSION_REQUIRED',401,'Sign in after sealed owner setup.');return state.store(owner.manifest).withCredential(async value=>{if(!value)problem('SOURCE_AUTH',403,'Save the Artifacts credential before testing this source.');return value;});},transport);
  const manager=new ManagedConnections(policy,new ConnectionStore(config.catalog_directory),config.accounting_directory,readers);
  return new OwnerAccess(state,host,Date.now,{connections:manager});
}
