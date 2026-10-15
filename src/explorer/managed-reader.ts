import { digest } from '../model.js';
import { FileReadBudget } from './read-budget.js';
import { RegistrySource,RestArtifactsReader,readRegistryFile } from './source.js';
import { ExplorerReader } from './read.js';
import { problem,safeJson } from './contract.js';
import type { ManagedGrant,ManagedReaderFactory } from './connection-manager.js';
import type { SourcePolicyPort } from './connection-policy.js';

// All remote dispatch goes through the manager's current authority boundary.
// No environment fallback or network discovery is available in managed mode.
export class ArtifactsManagedReaders implements ManagedReaderFactory {
  constructor(private policy:SourcePolicyPort,private credential:()=>Promise<string>,private transport:typeof fetch=fetch){}
  async build(ticket:ManagedGrant,budget:FileReadBudget,check:()=>Promise<void>){
    await check();const port=new RestArtifactsReader(ticket.connection,async()=>{await check();const token=await this.credential();await check();return token;},async(input,init)=>{await check();const response=await this.transport(input,init);try{await check();return response;}catch(error){await response.body?.cancel();throw error;}},ticket.expected_repository_id,budget);
    const source=new RegistrySource(ticket.connection,port,async()=>{
      await check();const policy=await this.policy.current(),profile=policy?.profiles.find(p=>p.profile_id===ticket.profile_id);
      if(!profile)problem('SOURCE_MANAGEMENT_REQUIRED',403,'The approved source profile is unavailable.');
      // Verify and consume one bounded read, retaining descriptor/inactive checks.
      const bytes=await readRegistryFile(ticket.connection);
      if(ticket.connection.registry_kind==='fixed-snapshot'){
        if(digest(safeJson(bytes))!==profile.registry_sha256)problem('SOURCE_BINDING',403,'The approved fixed registry changed.');
      }
      await check();return bytes;
    },()=>port.assertAuthorized());
    return new ExplorerReader({connection:source.connection,assertAuthorized:()=>source.assertAuthorized(),load:async signal=>{
      await check();
      const loaded=await source.load(signal);await check();return loaded;
    }});
  }
}
