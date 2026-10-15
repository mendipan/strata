import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lifetimeSchema, lifetimeActive, repositoryGrantSchema, repositoryGrantDigest, assertGrantActive, canonicalDisjointPaths } from '../src/explorer/workspace-policy.js';
import { digest } from '../src/model.js';
import { initialWorkspaceBudget,FileWorkspaceBudget } from '../src/explorer/workspace-budget.js';
import { carriedUsage } from './workspace-fixture.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { chmod,mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initialWorkspaceState,workspaceStateSchema } from '../src/explorer/workspace-state.js';
import { workspaceGrant } from './workspace-fixture.js';
import { connectionSchema } from '../src/explorer/contract.js';
import { config } from './explorer-fixture.js';
test('explicit until-revoked remains valid; timed lifetime expires exactly; legacy null fails',()=>{
  const g=workspaceGrant();assertGrantActive(g,Date.parse('2090-01-01T00:00:00Z'));
  assert.equal(lifetimeActive({mode:'until',expires_at:'2030-01-01T00:00:00Z'},Date.parse('2030-01-01T00:00:00Z')),false);
  assert.equal(lifetimeSchema.safeParse({mode:'until-revoked'}).success,false);
  assert.equal(lifetimeSchema.safeParse({mode:'until',expires_at:null}).success,false);
  const old=config();(old.read_authorization as any).expires_at=null;assert.equal(connectionSchema.safeParse(old).success,false);
});
test('grant fails strict extra fields, scope changes, unsafe caps and malformed dates',()=>{
  for(const mutate of [(g:any)=>g.extra=true,(g:any)=>g.provider_operations.push('repository.delete'),
    (g:any)=>g.limits.bytes=Number.MAX_SAFE_INTEGER,(g:any)=>g.storage.remote='https://evil.invalid/test',
    (g:any)=>g.not_before='2000-01-01T00:00:00Z',(g:any)=>g.model_version='strata/unsupported']){
    const g=workspaceGrant();mutate(g);assert.equal(repositoryGrantSchema.safeParse(g).success,false);
  }
});
test('canonical distinct path containment checks include child names beginning with two dots',()=>{
  const root=path.resolve('fixture-root');assert.doesNotThrow(()=>canonicalDisjointPaths([path.join(root,'owner'),path.join(root,'ledger')]));
  for(const paths of [[root,path.join(root,'..keys')],[root,root],[root,'relative'],[root,path.join(root,'sub','..','file')]])
    assert.throws(()=>canonicalDisjointPaths(paths));
});

test('provider selection preserves omitted grant digest and binds a new development grant without resetting an established budget',async()=>{
 const g=workspaceGrant();assert.equal(repositoryGrantDigest(g),digest(g));assert.equal(Object.hasOwn(g,'provider_contract'),false);
 const changed={...g,provider_contract:'development-name-addressed' as const};assert.notEqual(repositoryGrantDigest(changed),repositoryGrantDigest(g));
 assert.equal(repositoryGrantSchema.safeParse({...g,provider_contract:'best-effort'}).success,false);
 const root=await mkdtemp(path.join(tmpdir(),'strata-provider-budget-'));await chmod(root,0o700);const file=path.join(root,'budget.json'),carry=carriedUsage();
 await writePrivate(file,initialWorkspaceBudget(g,carry),true);const before=new FileWorkspaceBudget(file,g,carry);await before.ready();
 await assert.rejects(new FileWorkspaceBudget(file,changed,carry).ready());
 assert.equal((await before.snapshot()).reserved.requests,carry.reserved_requests);
});

test('journal preserves old records and accepts only complete bounded provider contract bindings',()=>{
 const state=initialWorkspaceState(workspaceGrant(),digest('origin'));
 const withDetail=(detail:any)=>({...state,operations:[{operation_id:digest('operation'),phase:'prepared',detail,events:[{phase:'prepared',detail}]}]});
 assert.equal(workspaceStateSchema.safeParse(withDetail({reason:'old-preparation'})).success,true);
 for(const mode of ['immutable-id','development-name-addressed'])assert.equal(workspaceStateSchema.safeParse(withDetail({provider_write_contract:mode,provider_write_contract_sha256:digest('contract')})).success,true);
 for(const detail of [{provider_write_contract:'development-name-addressed'},{provider_write_contract_sha256:digest('contract')},
  {provider_write_contract:'unconfigured',provider_write_contract_sha256:digest('contract')},
  {provider_write_contract:'development-name-addressed',provider_write_contract_sha256:'invalid'}])assert.equal(workspaceStateSchema.safeParse(withDetail(detail)).success,false);
});
