import path from 'node:path';
import { lstat, open, unlink } from 'node:fs/promises';
import { closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { noLinks } from '../node-state.js';
import { digest, fail } from '../model.js';
import { privateDir, readPrivate, optionalPrivate, withLease, writePrivate } from './owner-files.js';
import { namespacePolicyDigest, namespaceStateSchema, namespaceUsageSchema, type NamespacePolicy, type NamespaceState, NAMESPACE_OPERATIONS } from './namespace-policy.js';
import { workspaceHash } from './workspace-policy.js';
import { z } from 'zod';

export interface NamespacePublicationAuthority {refresh():Promise<void>;assertLive():void;}
// Prepare and flush privately, then recheck the original authority immediately
// before publishing. There is no event-loop yield between that check and the
// namespace/tombstone commit. Logout after this point preserves valid consent.
async function stagePrivate(filename:string,value:unknown){
  await noLinks(filename);const temp=filename+'.'+randomUUID();let created=false;
  try{
    const handle=await open(temp,'wx',0o600);created=true;
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    return {filename,temp};
  }catch(e){if(created)await unlink(temp).catch(()=>{});throw e;}
}
function syncPrivateDirectory(directory:string){
  if(process.platform==='win32')return;
  const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}

export class NamespaceStore {
  private queue:Promise<unknown>=Promise.resolve(); private pending=0;
  constructor(readonly directory:string,readonly policy:NamespacePolicy){}
  private async read(name:string) {
    await privateDir(this.directory);const file=path.join(this.directory,name+'.json');
    if((await lstat(file)).nlink!==1)fail('NAMESPACE_STATE_UNAVAILABLE',9,'Namespace state custody differs.');
    return readPrivate(file,16*1024**2);
  }
  async snapshot() {
    const s=namespaceStateSchema.parse(await this.read('namespace'));
    const tombstone=await optionalPrivate(path.join(this.directory,'revoked.json'));
    const revoked=tombstone===undefined?undefined:z.object({binding_sha256:workspaceHash,revision:z.number().int().min(1)}).strict().parse(tombstone);
    if(revoked&&(revoked.binding_sha256!==s.binding_sha256||!s.revoked||s.revision<revoked.revision)||s.revoked&&!revoked)
      fail('ACCESS_REVOKED',4,'Permanent namespace revocation cannot be rolled back.');
    if(s.binding_sha256!==namespacePolicyDigest(this.policy)||s.projects.length>this.policy.max_projects||
      s.connected&&(!s.approved||s.revoked)||
      s.projects.some(p=>(p.state==='ready')!==(p.genesis_sha256!==null)||!s.operations.some(o=>
        o.action===(p.origin==='import'?'import':'create')&&o.request_id===p.creation_id&&o.repository_id===p.id&&o.repository_name===p.name))||
      new Set(s.projects.map(p=>p.id)).size!==s.projects.length||new Set(s.projects.map(p=>p.name)).size!==s.projects.length||
      new Set(s.projects.map(p=>p.project_id)).size!==s.projects.length||new Set(s.operations.map(o=>o.request_id)).size!==s.operations.length||
      s.selected_repository_id!==null&&!s.projects.some(p=>p.id===s.selected_repository_id&&p.state==='ready'))
      fail('NAMESPACE_STATE_UNAVAILABLE',9,'Namespace catalog needs reconciliation.');
    return s;
  }
  private async serial<T>(work:()=>Promise<T>):Promise<T> {
    if(this.pending>=16)fail('WORKSPACE_BUSY',9,'Namespace state queue is full.');this.pending++;
    const task=this.queue.then(()=>withLease(this.directory,work));this.queue=task.catch(()=>{});
    try{return await task;}finally{this.pending--;}
  }
  update<T>(work:(state:NamespaceState)=>T|Promise<T>,authority?:NamespacePublicationAuthority) {return this.serial(async()=>{
    const state=await this.snapshot(),wasRevoked=state.revoked;await authority?.refresh();authority?.assertLive();
    const result=await work(state);namespaceStateSchema.parse(state);
    const staged:Awaited<ReturnType<typeof stagePrivate>>[]=[];
    try{
      const catalog=await stagePrivate(path.join(this.directory,'namespace.json'),state);staged.push(catalog);
      const tombstone=state.revoked&&!wasRevoked?await stagePrivate(path.join(this.directory,'revoked.json'),{binding_sha256:state.binding_sha256,revision:state.revision}):undefined;
      if(tombstone)staged.push(tombstone);
      await authority?.refresh();authority?.assertLive();
      // Exclusive link publishes a complete tombstone. An OS crash between it
      // and the catalog rename remains fail-closed under snapshot's checks.
      if(tombstone){linkSync(tombstone.temp,tombstone.filename);unlinkSync(tombstone.temp);syncPrivateDirectory(this.directory);}
      renameSync(catalog.temp,catalog.filename);syncPrivateDirectory(this.directory);
      return result;
    }finally{for(const file of staged)await unlink(file.temp).catch(()=>{});}
  });}
  private async usage() {
    const b=namespaceUsageSchema.parse(await this.read('usage'));
    if(b.binding_sha256!==namespacePolicyDigest(this.policy)||b.generation!==b.reservations.length||
      b.reservations.length>this.policy.limits.max_journal_entries||new Set(b.reservations.map(r=>r.id)).size!==b.reservations.length)
      fail('WORKSPACE_ACCOUNTING_UNAVAILABLE',9,'Namespace accounting needs reconciliation.');
    let requests=0,bytes=0;
    for(const r of b.reservations){requests++;bytes+=r.maximum_bytes;if(r.requests_after!==requests||r.bytes_after!==bytes)
      fail('WORKSPACE_ACCOUNTING_UNAVAILABLE',9,'Namespace accounting history differs.');}
    if(requests!==b.reserved_requests||bytes!==b.reserved_bytes||requests>this.policy.limits.requests||bytes>this.policy.limits.bytes)
      fail('WORKSPACE_ACCOUNTING_UNAVAILABLE',9,'Namespace accounting totals differ.');
    return b;
  }
  async ready(){await this.snapshot();await this.usage();}
  // Only call while holding the catalog's exclusive service lease. A create is
  // marked uncertain durably before POST; pending means it was never dispatched.
  async recoverInterrupted(){await this.update(s=>{let changed=false;for(const o of s.operations)if(o.phase==='pending'){o.phase='failed';o.code='SERVICE_INTERRUPTED';changed=true;}if(changed)s.revision++;});}
  async reserve(id:string,operation:string,kind:typeof NAMESPACE_OPERATIONS[number],maximumBytes:number) {
    z.string().uuid().parse(id);workspaceHash.parse(operation);z.enum(NAMESPACE_OPERATIONS).parse(kind);
    z.number().int().min(1).max(this.policy.limits.max_operation_bytes).parse(maximumBytes);
    await this.serial(async()=>{const b=await this.usage();
      if(b.reservations.some(r=>r.id===id))fail('WORKSPACE_DISPATCH_REPLAY',5,'This dispatch was already reserved.');
      const operationReservations=b.reservations.filter(r=>r.operation===operation);
      if(operationReservations.length+1>this.policy.limits.max_operation_requests||
          operationReservations.reduce((n,r)=>n+r.maximum_bytes,0)+maximumBytes>this.policy.limits.max_operation_bytes)
        fail('WORKSPACE_BUDGET_EXHAUSTED',4,'This operation allowance is exhausted; reservations are retained.');
      if(b.reserved_requests+1>this.policy.limits.requests||b.reserved_bytes+maximumBytes>this.policy.limits.bytes||b.reservations.length>=this.policy.limits.max_journal_entries)
        fail('WORKSPACE_BUDGET_EXHAUSTED',4,'Namespace allowance is exhausted; spending is retained.');
      b.reserved_requests++;b.reserved_bytes+=maximumBytes;b.generation++;
      b.reservations.push({id,operation,kind,maximum_bytes:maximumBytes,requests_after:b.reserved_requests,bytes_after:b.reserved_bytes});
      await writePrivate(path.join(this.directory,'usage.json'),b);
    });
  }
  async usageSnapshot(){const b=await this.usage();return {generation:b.generation,
    limits:{requests:this.policy.limits.requests,bytes:this.policy.limits.bytes},reserved:{requests:b.reserved_requests,bytes:b.reserved_bytes},
    remaining:{requests:this.policy.limits.requests-b.reserved_requests,bytes:this.policy.limits.bytes-b.reserved_bytes}};}
  async operationReceipt(operation:string){const b=await this.usage(),rs=b.reservations.filter(r=>r.operation===operation);return {
    binding_sha256:b.binding_sha256,origin_sha256:digest({namespace_lineage:this.policy.lineage_id}),generation:b.generation,
    reservation_ids:rs.map(r=>r.id),reserved_requests:rs.length,reserved_bytes:rs.reduce((n,r)=>n+r.maximum_bytes,0),reservations_sha256:digest(rs)};}
  budget(){return {ready:()=>this.ready(),reserve:this.reserve.bind(this),snapshot:()=>this.usageSnapshot(),operationReceipt:this.operationReceipt.bind(this)};}
}
