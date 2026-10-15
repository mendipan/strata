import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { FixtureIssuer } from '../src/security.js';
import { GitNodeAdapter } from '../src/git-adoption-node.js';
import { g2BridgeFixture } from './g2-bridge-fixture.js';

test('G2-REVIEW-001 exact acting expiry refuses despite an active same-principal alternative',async()=>{
  const f=await g2BridgeFixture(),assignments=structuredClone(f.assignments);let now=Date.now();
  assignments['fixture-preparer'].expires_at=new Date(now+1000).toISOString();assignments['acting-alternative']={...f.assignments['fixture-preparer']};
  const issuer=new FixtureIssuer({project_id:f.project,assignments,now:()=>now}),context=issuer.resolve('fixture-preparer');
  const engine=new Engine(structuredClone(f.engine.records),structuredClone(f.engine.ownerHeads),{projectId:f.project}),adapter=new GitNodeAdapter({repositories:[],directory:'unused-unit-test-directory'},f.project);
  assert.equal(adapter.bridgeAuthorityGate(engine,'git.stage',{plan:f.result.ref,patch:'unused structural fixture'},context,issuer),true);
  now+=1001;assert.equal(issuer.active(context.principal_id),true);
  assert.throws(()=>adapter.bridgeAuthorityGate(engine,'git.stage',{plan:f.result.ref,patch:'unused structural fixture'},context,issuer),{code:'ACCESS_REVOKED'});
});
