import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadHostedConfig} from '../scripts/studio-host.js';
import {sourceManagementConfigSchema,createManagedOwner} from '../src/explorer/managed-host.js';
import {BootstrapState} from '../src/explorer/bootstrap-state.js';

async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'strata-managed-launcher-'));
 const config={format:'strata-studio-host/1',public_origin:'https://studio.example.test',trusted_proxy_addresses:['127.0.0.1'],port:4174,
  browser_owner:{control_file:path.join(root,'control.json'),state_directory:path.join(root,'owner'),key_directory:path.join(root,'keys'),credential_directory:path.join(root,'credentials')},
  source_management:{policy_file:path.join(root,'policy.json'),catalog_directory:path.join(root,'catalog'),accounting_directory:path.join(root,'accounting')}};
 const load=async(value:unknown)=>{const file=path.join(root,'host.json');await writeFile(file,JSON.stringify(value));return loadHostedConfig(file);};
 return {root,config,load};
}
test('explicit managed mode loads metadata only, cannot mix any legacy source or reader access',async()=>{
 const {config,load,root}=await fixture();assert.deepEqual((await load(config)).config.source_management,config.source_management);
 const {browser_owner,...reader}=config;await assert.rejects(load(reader),/browser owner/);
 for(const extra of [{connection_config:path.join(root,'connection.json')},{expected_repository_id:'synthetic-repo'},{read_budget_file:path.join(root,'ledger.json')},{access_key_hash_file:path.join(root,'reader-hash')}])await assert.rejects(load({...config,...extra}));
});
test('legacy startup triplet is preserved without managed factory or authority initialization',async()=>{
 const {config,load,root}=await fixture(),{source_management,...legacy}=config;
 const triplet={connection_config:path.join(root,'source','connection.json'),expected_repository_id:'synthetic-repo',read_budget_file:path.join(root,'budget','read-budget.json')};
 const loaded=await load({...legacy,...triplet});assert.equal(loaded.config.source_management,undefined);for(const [key,value]of Object.entries(triplet))assert.equal((loaded.config as any)[key],value);
});
test('managed paths are canonical, disjoint and cannot overlap owner control/key/store state',async()=>{
 const {config}=await fixture(),management=config.source_management;
 for(const invalid of [{...management,accounting_directory:'relative'},{...management,catalog_directory:management.accounting_directory},{...management,catalog_directory:path.join(management.accounting_directory,'..keys')}])assert.equal(sourceManagementConfigSchema.safeParse(invalid).success,false);
 const state=new BootstrapState(config.browser_owner,config.public_origin);
 const host={publicOrigin:config.public_origin,trustedProxyAddresses:config.trusted_proxy_addresses};
 for(const protectedPath of Object.values(config.browser_owner))assert.throws(()=>createManagedOwner(state,{...management,accounting_directory:protectedPath},host));
 const owner=createManagedOwner(state,management,host,async()=>{throw new Error('No dispatch during construction');});assert.ok(owner.managedConnections);
});
