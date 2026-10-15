import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {HostIssuer,accountStoreSchema,policyStoreSchema} from '../src/auth/host-issuer.js';
import {workspaceRuntimeFixture} from './workspace-runtime-fixture.js';
test('new owner actor stays finite under until-revoked grant and loses parent authority before its own deadline',async()=>{
 const f=await workspaceRuntimeFixture(),c=f.issuer.resolve(f.token);assert.equal(c.principal_id,'named-author');assert.equal(c.account_id,'owner-author');
 assert.ok(Date.parse(c.expires_at!)<=Date.now()+30*60_000);f.revokeParent();assert.throws(()=>f.issuer.resolve(f.token));await assert.rejects(f.issuer.refreshSession(f.token));
});
test('owner binding cannot be signed in with a key, a fixture name or caller-supplied proof',async()=>{
 const f=await workspaceRuntimeFixture();assert.throws(()=>f.issuer.login('owner-author',Buffer.from(randomBytes(32)).toString('base64url')));
 const absent=new HostIssuer(f.accounts,f.policy);await assert.rejects(absent.loginOwner({owner_id:f.grant.owner_id,installation_id:f.grant.installation_id}));
 assert.throws(()=>absent.resolve('bootstrap'));assert.throws(()=>accountStoreSchema.parse(f.accounts));assert.throws(()=>policyStoreSchema.parse(f.policy));
});
test('policy generation and disabled account invalidate existing actor contexts and replay authority',async()=>{
 const f=await workspaceRuntimeFixture(),context=f.issuer.resolve(f.token),policy=structuredClone(f.policy);policy.generation++;
 f.issuer.reload(f.accounts,policy);assert.throws(()=>f.issuer.assertLive(context));
 const accounts=structuredClone(f.accounts);accounts.generation++;accounts.accounts[0].active=false;f.issuer.reload(accounts,policy);assert.throws(()=>f.issuer.resolve(f.token));
});
test('timed new actor grant refuses exactly at deadline; finite owner and actor expiry do not renew it',async()=>{
 const f=await workspaceRuntimeFixture();let now=Date.now();const policy=structuredClone(f.policy);policy.grants[0].lifetime={mode:'until',expires_at:new Date(now+1000).toISOString()};
 const issuer=new HostIssuer(f.accounts,policy,()=>now,async()=>({installation_id:f.grant.installation_id,owner_id:f.grant.owner_id,session_id:'synthetic-parent',authentication_generation:1,expires_at:new Date(now+60_000).toISOString(),assertLive(){},async refresh(){}}));
 const token=await issuer.loginOwner({});assert.equal(issuer.resolve(token).expires_at,policy.grants[0].lifetime.expires_at);now+=1000;assert.throws(()=>issuer.resolve(token));await assert.rejects(issuer.loginOwner({}));
});
