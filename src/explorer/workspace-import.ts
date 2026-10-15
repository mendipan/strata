import path from 'node:path';
import { lstat, open, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { MODEL, BLOCK_MODEL, bytesDigest, canonical, digest, fail, type Records } from '../model.js';
import { ArtifactRegistryStore, type LocatedRegistry } from '../artifact-registry.js';
import { checkAssets, ASSET_LIMITS } from '../assets.js';
import { validateRecords } from './validate.js';
import { privateDir, syncDirectory } from './owner-files.js';
import { noLinks } from '../node-state.js';
import { trustedFile } from './source.js';
import { repositoryGrantSchema, workspaceHash, workspaceId, type RepositoryGrant } from './workspace-policy.js';
import { budgetOriginSchema } from './workspace-budget.js';
import { registryPayloadDigest } from './workspace-broker.js';
import type { ArtifactBatchPort } from './workspace-ports.js';
import type { ArtifactBinary, ArtifactLocator, ArtifactObject } from '../artifacts.js';
import { repositoryStepSchema } from '../repository-receipts.js';
const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const locator = z.object({ ref:z.string().regex(/^[a-f0-9]{40}$/),path:z.string().regex(/^[a-f0-9]{64}\.(json|bin)$/),
  hash:workspaceHash,size_bytes:count.min(1).max(8*1024**2) }).strict();
export const writerRegistrySchema=z.object({
  entries:z.record(ref,z.object({hash:workspaceHash,type:z.string().min(1).max(64),published:z.boolean(),locator}).strict()),
  storage:z.object({format:z.literal('strata-artifacts-registry/1'),project_id:workspaceId,account:z.string(),namespace:z.string(),repository:z.string(),mode:z.literal('remote')}).strict(),
  asset_locators:z.record(workspaceHash,locator).optional(),
  heads:z.record(workspaceId,z.object({owner:workspaceId,head:count.min(1)}).strict()),
  requests:z.record(z.string().max(512),z.object({digest:workspaceHash,result:z.unknown(),repository_step:repositoryStepSchema.optional()}).strict()),
  contexts:z.record(z.string().max(512),z.object({generation:count,target:ref,fingerprint:workspaceHash}).strict()).optional(),
  commit_audit:z.array(z.unknown()).max(20000).optional(),workspace_commits:z.record(workspaceHash,z.unknown()).optional(),
}).strict();
// Existing writer history still requires a complete sealed import. Namespace
// creation may establish an explicitly empty v0.3 genesis, never recover history.
export const writerImportSchema=z.object({format:z.enum(['strata-studio-writer-import/1','strata-studio-empty-genesis/1','strata-studio-owner-snapshot/1']),
  project_id:workspaceId,model_version:z.enum([MODEL,BLOCK_MODEL]),expected_repository_id:workspaceId,
  complete_private_state:z.boolean(),quiesced_at:z.string().datetime(),source_writer:workspaceId,
  source_generation:workspaceHash,closure_verification:z.object({kind:z.enum(['authoritative-writer-export','new-empty-repository','owner-approved-snapshot']),receipt_sha256:workspaceHash}).strict(),
  registry:writerRegistrySchema,record_bytes:z.record(ref,z.string().max(8*1024**2)),
  binary_bytes:z.record(workspaceHash,z.string().max(4*Math.ceil(ASSET_LIMITS.bytes/3))).optional(),
  origin:budgetOriginSchema,
}).strict();
export type WriterImport=z.infer<typeof writerImportSchema>;
export function validateWriterImport(value:unknown,grant:RepositoryGrant){
  const imported=writerImportSchema.parse(value),g=repositoryGrantSchema.parse(grant);
  if(imported.format==='strata-studio-owner-snapshot/1'){
    if(imported.complete_private_state||imported.closure_verification.kind!=='owner-approved-snapshot'||Object.keys(imported.registry.heads).length||Object.keys(imported.registry.requests).length||Object.keys(imported.registry.contexts??{}).length||Object.keys(imported.registry.workspace_commits??{}).length||imported.registry.commit_audit?.length)
      fail('WRITER_IMPORT_REQUIRED',4,'Snapshot import starts a fresh author without inheriting historical writer authority.');
  }else if(!imported.complete_private_state)fail('WRITER_IMPORT_REQUIRED',4,'A writer export must contain complete private state.');
  if(imported.format==='strata-studio-writer-import/1'&&(imported.model_version!==MODEL||imported.closure_verification.kind!=='authoritative-writer-export'))
    fail('WRITER_IMPORT_REQUIRED',4,'Existing writer history requires the supported complete authoritative export.');
  if(imported.format==='strata-studio-empty-genesis/1'&&(imported.model_version!==BLOCK_MODEL||imported.closure_verification.kind!=='new-empty-repository'||(imported.registry.commit_audit?.length??0)||
      Object.keys(imported.registry.entries).length||Object.keys(imported.registry.requests).length||
      Object.keys(imported.registry.heads).length||Object.keys(imported.registry.contexts??{}).length||
      Object.keys(imported.registry.workspace_commits??{}).length||Object.keys(imported.record_bytes).length||
      Object.keys(imported.registry.asset_locators??{}).length||Object.keys(imported.binary_bytes??{}).length))
    fail('WRITER_IMPORT_REQUIRED',4,'A new namespace project must start from an empty, authenticated v0.3 genesis.');
  if(digest(imported)!==g.import_manifest_sha256||imported.project_id!==g.project_id||imported.model_version!==g.model_version||
      imported.expected_repository_id!==g.storage.expected_repository_id||imported.registry.storage.project_id!==g.project_id||
      ['account','namespace','repository'].some(k=>(imported.registry.storage as any)[k]!== (g.storage as any)[k]))
    fail('WRITER_IMPORT_REQUIRED',4,'Complete writer import differs from the sealed workspace binding.');
  const records:Records={},assetBytes=new Map<string,Uint8Array>();
  if(canonical(Object.keys(imported.record_bytes).sort())!==canonical(Object.keys(imported.registry.entries).sort()))
    fail('WRITER_IMPORT_REQUIRED',4,'Writer export must retain the complete indexed record set.');
  for(const [r,e]of Object.entries(imported.registry.entries)){
    const text=imported.record_bytes[r],l=e.locator;
    if(bytesDigest(text)!==e.hash||l.hash!==e.hash||l.path!==e.hash+'.json'||l.size_bytes!==Buffer.byteLength(text))
      fail('WRITER_IMPORT_REQUIRED',4,'Writer export requires exact immutable record locators.');
    let data;try{data=JSON.parse(text);}catch{fail('WRITER_IMPORT_REQUIRED',4,'Writer export record is invalid.');}
    if(canonical(data)!==text)fail('WRITER_IMPORT_REQUIRED',4,'Writer export record must be canonical.');
    records[r]={type:e.type,published:e.published,data};
  }
  validateRecords(records,g.project_id,g.model_version);
  const binaries=imported.binary_bytes??{},locators=imported.registry.asset_locators??{};
  if(canonical(Object.keys(binaries).sort())!==canonical(Object.keys(locators).sort()))fail('WRITER_IMPORT_REQUIRED',4,'Writer export requires complete binary closure.');
  for(const [hash,text]of Object.entries(binaries)){
    const bytes=Buffer.from(text,'base64'),l=locators[hash];
    if(bytes.toString('base64')!==text||bytesDigest(bytes)!==hash||l.hash!==hash||l.path!==hash+'.bin'||l.size_bytes!==bytes.byteLength)
      fail('WRITER_IMPORT_REQUIRED',4,'Writer export binary locator differs.');
    assetBytes.set(hash,new Uint8Array(bytes));
  }
  checkAssets(records,assetBytes,g.project_id);
  for(const [id,head]of Object.entries(imported.registry.heads)){
    const layer=records[id+'@'+head.head];if(!layer||layer.type!=='layer'||layer.data.owner!==head.owner)
      fail('WRITER_IMPORT_REQUIRED',4,'Private owner heads must match retained Layers.');
  }
  for(const context of Object.values(imported.registry.contexts??{}))if(!records[context.target])fail('WRITER_IMPORT_REQUIRED',4,'Retained context target is absent.');
  return {imported,records,assetBytes,initial_registry_payload_sha256:registryPayloadDigest(imported.registry)};
}
export function assertFreshWorkspacePrincipal(records:Records,principal:string){
  const reserved=new Set(['bootstrap','reader','backup-operator','author-a','author-b','author-c','preparer','interaction-reviewer','fixture-runner','scope-selector','release-manager','safety-guardian']);
  const visit=(value:any,key='')=>{if(!value||typeof value!=='object')return;
    for(const [name,v]of Object.entries(value)){
      if(['owner','principal','reviewer','producer'].includes(name)&&typeof v==='string')reserved.add(v);
      if(['selectors','release'].includes(name)&&Array.isArray(v))for(const id of v)if(typeof id==='string')reserved.add(id);
      if(v&&typeof v==='object')visit(v,name);
    }};
  for(const record of Object.values(records))visit(record.data);
  if(principal.startsWith('fixture-')||reserved.has(principal))fail('WORKSPACE_NOT_CONFIGURED',4,'Workspace authoring requires a fresh principal, not a fixture or imported historical identity.');
}
export class CachedWorkspaceArtifacts implements ArtifactBatchPort {
  constructor(private directory:string,private remote:ArtifactBatchPort){}
  identity(project:string){return this.remote.identity(project);}
  managementCleanupCounts(){return this.remote.managementCleanupCounts();}
  private async cached(l:ArtifactLocator){
    if(!/^[a-f0-9]{64}\.(json|bin)$/.test(l.path)||l.path!==l.hash+(l.path.endsWith('.bin')?'.bin':'.json'))fail('STORE_BINDING_MISMATCH',4,'Verified cache requires an exact content-addressed locator.');
    await privateDir(this.directory);const file=path.join(this.directory,l.path);await noLinks(file);
    const meta=await lstat(file).catch(error=>{
      if((error as NodeJS.ErrnoException).code==='ENOENT')fail('STORE_UNAVAILABLE',9,'Indexed immutable namespace cache is missing; authenticated operator reconciliation is required.');
      throw error;
    });
    if(!meta.isFile()||meta.nlink!==1||process.platform!=='win32'&&((meta.mode&0o077)||meta.uid!==process.getuid?.())||
        !/^[a-f0-9]{64}\.(json|bin)$/.test(l.path)||l.path!==l.hash+(l.path.endsWith('.bin')?'.bin':'.json')||
        !l.size_bytes||meta.size!==l.size_bytes)fail('STORE_UNAVAILABLE',9,'Verified immutable host cache needs reconciliation.');
    const bytes=new Uint8Array(await readFile(file));if(bytesDigest(bytes)!==l.hash)fail('STORE_UNAVAILABLE',9,'Verified immutable cache bytes differ.');return bytes;
  }
  async getManyAt(locators:ArtifactLocator[]){const output:string[]=[];for(const l of locators){const bytes=await this.cached(l);try{output.push(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('STORE_UNAVAILABLE',9,'Verified record encoding differs.');}}return output;}
  getBytesAt(l:ArtifactLocator){return this.cached(l);}
  async putBatch(objects:ArtifactObject[],binary:ArtifactBinary[]=[]){
    const result=await this.remote.putBatch(objects,binary),files=[...objects.map(o=>({...o,path:o.hash+'.json'})),...binary.map(o=>({...o,path:o.hash+'.bin'}))];
    await privateDir(this.directory);
    for(const object of files){
      const file=path.join(this.directory,object.path);await noLinks(file);
      try{const handle=await open(file,'wx',0o600);try{await handle.writeFile(object.bytes);await handle.sync();}finally{await handle.close();}}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await this.cached(result.locators.find(l=>l.path===object.path)!);}
    }
    await syncDirectory(this.directory);return result;
  }
}
