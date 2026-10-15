import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/model.js';
import {prepareWorkspaceCutover,checkWorkspaceCutover} from '../src/explorer/workspace-cutover.js';
import {workspaceRuntimeFixture} from './workspace-runtime-fixture.js';
test('pure preparation binds complete writer custody and nonzero spending; stale activation check refuses',async()=>{
 const f=await workspaceRuntimeFixture(),custody={old_catalog:digest('old catalog'),old_ledger:digest('old ledger'),old_policy:digest('old policy'),old_source:digest('old source'),writer_registry:digest(f.imported.registry),owner_binding:digest('sealed owner')};
 const imported=structuredClone(f.imported);imported.origin.old_lineage_sha256=digest(custody);
 const grant={...f.grant,import_manifest_sha256:digest(imported)},value={grant,import:imported,accounts:f.accounts,policy:f.policy,custody};
 const prepared=prepareWorkspaceCutover(value);assert.equal(prepared.initial_budget.reserved_requests,12);assert.equal(prepared.initial_budget.reserved_bytes,393020);assert.equal(prepared.initial_control.desired_connected,false);
 assert.equal(prepared.requires.provider_identity_evidence,true);assert.equal(prepared.requires.development_provider_acknowledgment,false);
 const development=prepareWorkspaceCutover({...value,grant:{...grant,provider_contract:'development-name-addressed'}});
 assert.equal(development.requires.provider_identity_evidence,false);assert.equal(development.requires.development_provider_acknowledgment,true);
 assert.notEqual(development.grant_sha256,prepared.grant_sha256);assert.equal(development.initial_budget.reserved_requests,12);
 assert.equal(checkWorkspaceCutover(prepared,value).activation_performed,false);assert.deepEqual(f.counts(),{pushes:0,mints:0,revokes:0});
 assert.throws(()=>checkWorkspaceCutover(prepared,{...value,custody:{...custody,old_ledger:digest('changed ledger')}}));
 const partial=structuredClone(value);partial.import.complete_private_state=false as any;assert.throws(()=>prepareWorkspaceCutover(partial));
 const forged=structuredClone(value);forged.accounts.accounts[0].principal_id='bootstrap';forged.policy.grants[0].principal_id='bootstrap';forged.grant.actor_binding_sha256=digest({accounts:forged.accounts,policy:forged.policy});assert.throws(()=>prepareWorkspaceCutover(forged),(e:any)=>e.code==='WORKSPACE_NOT_CONFIGURED');
});
