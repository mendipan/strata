import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionSchema} from '../src/explorer/contract.js';
import {config} from './explorer-fixture.js';
import {RestArtifactsReader} from '../src/explorer/source.js';
test('task auth accepts the explicitly approved inherited Cloudflare variable and refuses other variables',()=>{
  const c=config();c.auth_provider.variable='CLOUDFLARE_API_TOKEN';assert.equal(connectionSchema.safeParse(c).success,true);
  for(const variable of ['PATH','HOME','OTHER_API_TOKEN','CLOUDFLARE_API_TOKEN_OTHER']){c.auth_provider.variable=variable;assert.equal(connectionSchema.safeParse(c).success,false);}
});
test('task connection pins repository ID as well as account/namespace/name before file reads',async()=>{
 const c=config();let calls=0;const port=new RestArtifactsReader(c,async()=>'synthetic-offline-only',async()=>{calls++;return Response.json({success:true,result:{id:'recreated-repo',name:c.storage.repository,remote:`https://${c.storage.account}.artifacts.cloudflare.net/git/${c.storage.namespace}/${c.storage.repository}.git`}});},'approved-repo');await assert.rejects(port.getManyAt([]),(e:any)=>e.code==='SOURCE_BINDING');assert.equal(calls,1);
});
