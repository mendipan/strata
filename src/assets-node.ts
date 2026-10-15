import { open, mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ASSET_LIMITS, checkAssets, inspectImage, type ByteStore } from './assets.js';
import { assetInputSchema, assetDescriptorSchema, CONTENT_MODEL, bytesDigest, canonical, digest, fail, parse, type Records } from './model.js';
import { acquireStateLease, assertQuiesced, noLinks, STATE_DESCRIPTOR, INACTIVE_MARKER } from './node-state.js';
import { FixtureIssuer, auditEvent } from './security.js';

async function boundedFile(file: string, maximum: number=ASSET_LIMITS.bytes): Promise<Buffer> {
  await noLinks(file); const handle=await open(file,'r'); try { const before=await handle.stat(); if(!before.isFile() || before.size<1 || before.size>maximum) fail('INVALID_ASSET',2,'Asset source must be a bounded regular file.'); const buffer=Buffer.alloc(before.size); let offset=0; while(offset<buffer.length) { const read=await handle.read(buffer,offset,buffer.length-offset,offset); if(!read.bytesRead) fail('ASSET_INTEGRITY',6,'Asset source changed during its bounded read.'); offset+=read.bytesRead; } const after=await handle.stat(); if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs) fail('ASSET_INTEGRITY',6,'Asset source changed during its bounded read.'); return buffer; } finally {await handle.close();}
}
export class NodeByteStore implements ByteStore {
  constructor(readonly state: string) {}
  file(hash:string) { if(!/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_ARGUMENT',2,'Blob identity must be SHA-256.'); return path.join(this.state,'assets','blobs',hash); }
  async read(hash:string) { const bytes=await boundedFile(this.file(hash)); if(bytesDigest(bytes)!==hash) fail('ASSET_INTEGRITY',6,'Stored blob hash is inconsistent.'); return bytes; }
  async put(hash:string,bytes:Uint8Array) { if(bytesDigest(bytes)!==hash) fail('ASSET_INTEGRITY',6,'ByteStore refuses mismatched bytes.'); const file=this.file(hash); await noLinks(file); await mkdir(path.dirname(file),{recursive:true}); try {await writeFile(file,bytes,{flag:'wx'});} catch(error:any) { if(error.code!=='EEXIST') throw error; if(bytesDigest(await this.read(hash))!==hash) fail('ASSET_INTEGRITY',6,'Existing blob differs.'); } }
}
export async function loadAssetBytes(state: string,records:Records) { const descriptors=Object.values(records).filter(r=>r.type==='asset').map(r=>parse(assetDescriptorSchema,r.data)); if(descriptors.length>ASSET_LIMITS.versions || [...new Map(descriptors.map(d=>[d.content_sha256,d.byte_length])).values()].reduce((a,b)=>a+b,0)>ASSET_LIMITS.retainedBytes) fail('ASSET_QUOTA',2,'Retained asset closure exceeds its bounded count or bytes.'); const store=new NodeByteStore(state); const result=new Map<string,Uint8Array>(); for(const r of Object.values(records).filter(r=>r.type==='asset')) {const d=parse(assetDescriptorSchema,r.data); if(!result.has(d.content_sha256)) {try {result.set(d.content_sha256,await store.read(d.content_sha256));} catch(error:any) {if(error.code==='ENOENT') fail('ASSET_NOT_FOUND',3,'Retained binary asset is missing.'); throw error;}}} return result; }
export async function importAsset(state: string,source: string,metadata:unknown,selector:string,issuer=new FixtureIssuer(),dryRun=false) {
  const input=parse(assetInputSchema,metadata); const context=issuer.resolve(selector,issuer.projectId); issuer.authorize(context,'assets.import',{});
  await noLinks(state); try {await lstat(path.join(state,INACTIVE_MARKER)); fail('RECOVERY_INACTIVE',4,'Restored recovery data cannot accept active imports.');} catch(error:any) {if(error.code!=='ENOENT') throw error;}
  const descriptorFile=path.join(state,STATE_DESCRIPTOR); const descriptorText=new TextDecoder('utf8',{fatal:true}).decode(await boundedFile(descriptorFile,8192)); const descriptor=JSON.parse(descriptorText); if(Object.keys(descriptor).length!==3 || descriptor.format!=='strata-node-state/1' || descriptor.model_version!==CONTENT_MODEL || descriptor.project_id!==context.project_id) fail('UNSUPPORTED_MODEL_VERSION',8,'Offline import requires a matching explicit v0.2 Node state.');
  if(dryRun) await assertQuiesced(state); const release=dryRun ? undefined : await acquireStateLease(state,'backup'); const temp=path.join(state,'asset-registry-'+randomUUID()+'.tmp');
  try {
    const file=path.join(state,'registry.json'); await noLinks(file); let registry:any; try {registry=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await boundedFile(file,8*1024*1024)));} catch(error:any) {if(error.code!=='ENOENT') throw error; registry={entries:{},heads:{},requests:{}};}
    if(registry.storage || registry.asset_locators || Object.values(registry.entries).some((e:any)=>e.locator)) fail('UNSUPPORTED_REMOTE_ASSET_IMPORT',8,'Offline local import cannot modify a remotely indexed registry.');
    const assetEntries=(Object.entries(registry.entries) as [string,any][]).filter(([,entry])=>entry.type==='asset'); if(assetEntries.length>ASSET_LIMITS.versions) fail('ASSET_QUOTA',2,'Retained asset versions exceed the bounded limit.');
    const records:Records={}; for(const [ref,entry] of assetEntries) {if(!/^[a-f0-9]{64}$/.test(entry.hash)) fail('INVALID_RECORD',2,'Invalid asset registry artifact hash.'); const artifact=path.join(state,'artifacts',entry.hash+'.json'); await noLinks(artifact); const bytes=await boundedFile(artifact,ASSET_LIMITS.descriptorBytes); if(bytesDigest(bytes)!==entry.hash) fail('ASSET_INTEGRITY',6,'Registry artifact hash is inconsistent.'); records[ref]={...entry,data:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes))};}
    const bytes=await boundedFile(source), image=inspectImage(bytes); const {acknowledge_project_visibility: acknowledgement,...retained}=input; const data=parse(assetDescriptorSchema,{...retained,format:'strata-asset/1',project_id:context.project_id,content_sha256:bytesDigest(bytes),byte_length:bytes.length,...image,validation:'bounded-structure/1',imported_by:context.principal_id});
    // Strip the input-only visibility acknowledgement before strict descriptor parsing.
    const ref='asset@'+digest(data); const reused=!!records[ref];
    const assetBytes=await loadAssetBytes(state,records); assetBytes.set(data.content_sha256,bytes); records[ref]={type:'asset',published:true,data}; checkAssets(records,assetBytes,context.project_id);
    if(new TextDecoder('utf8',{fatal:true}).decode(await boundedFile(descriptorFile,8192))!==descriptorText) fail('STATE_CHANGED',5,'Node state descriptor changed during import.');
    if(dryRun) {await assertQuiesced(state);return {ref,reused,descriptor:data,dry_run:true};}
    if(reused) return {ref,reused:true,descriptor:data,dry_run:false};
    await new NodeByteStore(state).put(data.content_sha256,bytes); const text=canonical(data),hash=bytesDigest(text),artifact=path.join(state,'artifacts',hash+'.json'); await noLinks(artifact); await mkdir(path.dirname(artifact),{recursive:true}); try {await writeFile(artifact,text,{flag:'wx'});} catch(error:any) {if(error.code!=='EEXIST') throw error; if(await readFile(artifact,'utf8')!==text) fail('ASSET_INTEGRITY',6,'Asset descriptor collision.');}
    issuer.authorize(context,'assets.import',{}); const event=auditEvent(context,'assets.import',digest(data).slice(0,24),'committed'); event.references=[ref]; if((registry.commit_audit?.length ?? 0)>=20000) fail('AUDIT_UNAVAILABLE',9,'Commit audit ledger is full.');
    const next={...registry,entries:{...registry.entries,[ref]:{hash,type:'asset',published:true}},commit_audit:[...(registry.commit_audit ?? []),event]}; await writeFile(temp,canonical(next),{flag:'wx'}); await rename(temp,file); return {ref,reused:false,descriptor:data,dry_run:false};
  } finally {try {await unlink(temp);} catch(error:any) {if(error.code!=='ENOENT') throw error;} await release?.();}
}
