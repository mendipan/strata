import { readFile } from 'node:fs/promises';
import { bytesDigest, canonical, digest, MODEL, type Records } from '../src/model.js';
import { connectionSchema, type ConnectionConfig, type SourceInfo } from '../src/explorer/contract.js';
import type { ExplorerSource } from '../src/explorer/source.js';
export async function sample(): Promise<Records> {return JSON.parse(await readFile('explorer/sample-records.json','utf8'));}
// All identities and responses in this file are SYNTHETIC. No live credential,
// private account ID, Artifacts call, generated code execution or hosted resource.
export function config(): ConnectionConfig {return connectionSchema.parse({format:'strata-explorer-connection/1',connection_id:'test-reader',project_id:'explorer-sample',display_name:'Synthetic booking',model_version:MODEL,registry_path:'C:/synthetic-unread-registry.json',registry_kind:'fixed-snapshot',storage:{format:'strata-artifacts-registry/1',project_id:'explorer-sample',account:'0'.repeat(32),namespace:'synthetic',repository:'synthetic-booking',mode:'remote'},auth_provider:{kind:'existing-environment',variable:'STRATA_EXPLORER_TEST_AUTH'},reader_policy:'published-project-reader',read_authorization:{project_id:'explorer-sample',principal:'test-reader',policy_generation:'test-policy-1',expires_at:new Date(Date.now()+60000).toISOString(),full_registry_read:true,operations:['repository.info','file.read'],max_requests:1000,max_bytes:40*1024*1024,timeout_ms:1000}});}
export function registry(records:Records,c=config()) {return {storage:c.storage,entries:Object.fromEntries(Object.entries(records).map(([ref,r])=>{const text=canonical(r.data),hash=bytesDigest(text);return [ref,{hash,type:r.type,published:r.published,locator:{ref:'f'.repeat(40),path:hash+'.json',hash,size_bytes:Buffer.byteLength(text)}}];})),asset_locators:{},heads:{never:'exposed'},contexts:{never:'mutated'},audit:['never exposed']};}
export class TestSource implements ExplorerSource {
  readonly connection={connection_id:'sample-test',project_id:'explorer-sample',display_name:'Synthetic booking',model_version:MODEL};
  failure:Error|null=null;authorized=true;calls=0;
  constructor(public records:Records) {}
  assertAuthorized(){if(!this.authorized)throw Object.assign(new Error('denied'),{code:'TEST_DENIED'});}
  async load(){this.calls++;if(this.failure)throw this.failure;return {records:structuredClone(this.records),assetBytes:new Map<string,Uint8Array>(),source:{mode:'sample',registry_kind:'synthetic-fixture',registry_generation:digest(this.records),verified_at:new Date().toISOString(),freshness:'fixed-snapshot',semantic_trust:'local-fixture'} as SourceInfo};}
}
