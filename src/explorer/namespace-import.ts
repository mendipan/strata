import { z } from 'zod';
import { MODEL, BLOCK_MODEL, bytesDigest, canonical, digest, fail, type Records } from '../model.js';
import { writerRegistrySchema } from './workspace-import.js';
import { workspaceId } from './workspace-policy.js';
import { validateRecords } from './validate.js';
import { checkAssets } from '../assets.js';
import type { NamespaceProvider, NamespaceLease } from './namespace-provider.js';
import type { NamespacePolicy, NamespaceRepository } from './namespace-policy.js';

// An index is needed because immutable Git objects do not encode publication,
// project identity, or private writer state. Never invent those from branch names.
export const repositoryIndexSchema=z.object({format:z.literal('strata-studio-repository-index/1'),
  repository_id:workspaceId,model_version:z.enum([MODEL,BLOCK_MODEL]),registry:writerRegistrySchema}).strict();
export type RepositoryIndex=z.infer<typeof repositoryIndexSchema>;
export const importCatalogSchema=z.object({format:z.literal('strata-studio-import-catalog/1'),indexes:z.array(repositoryIndexSchema).max(64)}).strict();
export function admitIndex(input:unknown,repository:NamespaceRepository,policy:NamespacePolicy){
  const index=repositoryIndexSchema.parse(input),s=index.registry.storage;
  if(index.repository_id!==repository.id||s.account!==policy.account||s.namespace!==policy.namespace||s.repository!==repository.name)
    fail('REPOSITORY_ID_MISMATCH',4,'The project index belongs to another repository. Choose its matching repository.');
  const entries=Object.values(index.registry.entries),assets=Object.values(index.registry.asset_locators??{});
  if(!entries.length||entries.length+assets.length>policy.limits.max_operation_requests-2||
      [...entries.map(e=>e.locator),...assets].reduce((n,l)=>n+l.size_bytes,0)>policy.limits.max_operation_bytes-16384)
    fail('READ_LIMIT',2,'This project index exceeds the import limit. Choose a smaller complete project snapshot.');
  return index;
}
export async function fetchIndex(index:RepositoryIndex,provider:NamespaceProvider,lease:NamespaceLease){
  const records:Records={},record_bytes:Record<string,string>={},binary_bytes:Record<string,string>={},assets=new Map<string,Uint8Array>();
  for(const [ref,e] of Object.entries(index.registry.entries)){
    const bytes=await provider.file(lease,index.registry.storage.repository,e.locator);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let data;try{data=JSON.parse(text);}catch{fail('CORRUPT_DATA',2,'A repository record is not valid JSON.');}
    if(bytesDigest(bytes)!==e.hash||canonical(data)!==text)fail('CORRUPT_DATA',2,'A repository record differs from its saved index. No data was changed.');
    record_bytes[ref]=text;records[ref]={type:e.type,published:e.published,data};
  }
  validateRecords(records,index.registry.storage.project_id,index.model_version);
  for(const [hash,locator] of Object.entries(index.registry.asset_locators??{})){
    const bytes=await provider.file(lease,index.registry.storage.repository,locator);
    if(bytesDigest(bytes)!==hash)fail('CORRUPT_DATA',2,'A repository asset differs from its saved index.');
    assets.set(hash,bytes);binary_bytes[hash]=Buffer.from(bytes).toString('base64');
  }
  checkAssets(records,assets,index.registry.storage.project_id);
  if(!Object.values(records).some(r=>r.type==='release'&&r.published))fail('WRITER_IMPORT_REQUIRED',4,'This index has no published baseline to open.');
  return {records,record_bytes,binary_bytes,source_generation:digest(index)};
}
