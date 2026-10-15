import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { EncryptedCredentialStore, type StoreAction } from '../src/explorer/credential-store.js';
import { CredentialApi, fileCredentialComponents } from '../src/explorer/credential-api.js';
import { startExplorer } from '../src/explorer/host.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { TestSource, sample } from './explorer-fixture.js';
import { ExplorerError } from '../src/explorer/contract.js';

const token = () => Buffer.from(randomBytes(32)).toString('base64url');
const apiToken = 'synthetic-provider-token-only';
const action = (revision: number, name: 'save' | 'remove' | 'test' = 'save', request_id = randomUUID()): StoreAction => ({ action:name, credential_id:'artifacts-api-token',revision,request_id,...(name==='save'?{value:apiToken}:{}) });
async function fixture() {
  const parent=await mkdtemp(path.join(tmpdir(),'strata-credentials-'));await chmod(parent,0o700);
  const directory=path.join(parent,'store'),key=Buffer.from(randomBytes(32));
  const store=new EncryptedCredentialStore(directory,async()=>key);
  return {parent,directory,key,store};
}
test('AES-GCM storage persists restart/replacement/removal; status and file never reveal plaintext',async()=>{
  const f=await fixture();assert.equal((await f.store.status()).revision,0);
  const saved=await f.store.action(action(0));assert.equal(saved.revision,1);assert.equal(saved.credentials[0].configured,true);
  const frame1=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(frame1.cipher,'AES-256-GCM');assert.ok(!JSON.stringify(frame1).includes(apiToken));
  assert.ok(!JSON.stringify(saved).includes(apiToken));assert.ok(!JSON.stringify(saved).includes('value'));
  if(process.platform!=='win32'){assert.equal((await lstat(f.store.file)).mode&0o777,0o600);assert.equal((await lstat(f.directory)).mode&0o777,0o700);}
  const restarted=new EncryptedCredentialStore(f.directory,async()=>f.key);assert.equal((await restarted.status()).revision,1);
  assert.equal(await restarted.withCredential(async value=>value),apiToken);
  await restarted.action({...action(1),value:'synthetic-replacement'});
  const frame2=JSON.parse(await readFile(f.store.file,'utf8'));assert.notEqual(frame1.iv,frame2.iv);assert.notEqual(frame1.data,frame2.data);
  await restarted.action(action(2,'remove'));assert.equal(await restarted.withCredential(async value=>value),undefined);assert.equal((await restarted.status()).credentials[0].configured,false);
});
test('CAS/idempotency survive restart; conflicting requests and concurrent instances fail closed',async()=>{
  const f=await fixture(),save=action(0);await f.store.action(save);
  const restart=new EncryptedCredentialStore(f.directory,async()=>f.key);
  const replay=await restart.action(save);assert.equal(replay.replayed,true);assert.equal(replay.revision,1);
  await assert.rejects(restart.action({...save,value:'changed'}),error=>error instanceof ExplorerError&&error.code==='REQUEST_CONFLICT');
  await assert.rejects(restart.action(action(0,'remove')),error=>error instanceof ExplorerError&&error.code==='CREDENTIAL_CHANGED');
  const results=await Promise.allSettled([f.store.action(action(1)),restart.action(action(1,'remove'))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await f.store.status()).revision,2);
});
test('tampering/wrong key/insecure files/missing unlock reject without overwriting an intact encrypted file',async()=>{
  const f=await fixture();await f.store.action(action(0));const original=await readFile(f.store.file,'utf8');
  await assert.rejects(new EncryptedCredentialStore(f.directory,async()=>undefined).status(),error=>error instanceof ExplorerError&&error.code==='CREDENTIAL_STORE_LOCKED');
  await assert.rejects(new EncryptedCredentialStore(f.directory,async()=>Buffer.from(randomBytes(32))).status());
  assert.equal(await readFile(f.store.file,'utf8'),original);
  const frame=JSON.parse(original);frame.tag=token().slice(0,22);await writeFile(f.store.file,JSON.stringify(frame));
  await assert.rejects(f.store.status());await assert.rejects(f.store.action(action(1,'remove')));assert.equal(await readFile(f.store.file,'utf8'),JSON.stringify(frame));
  await writeFile(f.store.file,original);await writeFile(path.join(f.directory,'.credential-store.lock'),'interrupted writer',{mode:0o600});
  await assert.rejects(f.store.action(action(1)),error=>error instanceof ExplorerError&&error.code==='CREDENTIAL_BUSY');
  // No automatic stale-lease deletion. Owner/test reconciles only this fixture.
  await unlink(path.join(f.directory,'.credential-store.lock'));assert.equal((await f.store.action(action(1,'remove'))).revision,2);
  if(process.platform!=='win32'){await chmod(f.store.file,0o644);await assert.rejects(f.store.status());}
});
test('API separates manager privilege, schema admission, locked status and masked provider testing',async()=>{
  const f=await fixture();let keyReads=0,authorized=0,tests=0,changes=0;
  const guarded=new EncryptedCredentialStore(f.directory,async()=>{keyReads++;return f.key;});
  const managerKey=token();
  const api=new CredentialApi({store:guarded,authorize:async input=>{authorized++;if(input.owner_authorization!==managerKey)throw new ExplorerError('CREDENTIAL_MANAGEMENT_REQUIRED',403,'manager required');},changed:async()=>{changes++;},tester:async()=>{tests++;return guarded.withCredential(async value=>{assert.equal(value,apiToken);return {outcome:'passed',verified_at:new Date().toISOString()};});}});
  const savedInput={...action(0),owner_authorization:managerKey};
  await assert.rejects(api.action({...savedInput,endpoint:'https://evil.invalid'}));assert.equal(authorized,0);assert.equal(keyReads,0);
  await assert.rejects(api.action({...savedInput,owner_authorization:token()}));assert.equal(keyReads,0);
  await assert.rejects(new CredentialApi({store:guarded}).action(savedInput));assert.equal(keyReads,0);
  assert.equal((await api.action(savedInput)).state,'ready');assert.equal(changes,1);
  const testInput={...action(1,'test'),owner_authorization:managerKey};const tested=await api.action(testInput);assert.equal(tested.test?.outcome,'passed');assert.equal(tests,1);assert.equal(tested.revision,2);
  const replay=await api.action(testInput);assert.equal(replay.replayed,true);assert.equal(tests,1);
  assert.ok(!JSON.stringify(tested).includes(apiToken));assert.ok(!JSON.stringify(tested).includes(managerKey));
  const locked=new CredentialApi({store:new EncryptedCredentialStore(f.directory,async()=>undefined)});assert.equal((await locked.status()).state,'locked');assert.equal((await locked.status()).credentials[0].configured,null);
  assert.equal((await new CredentialApi().status()).state,'unconfigured');
  const denied=new CredentialApi({store:guarded,authorize:async()=>{},tester:async()=>{throw new ExplorerError('SOURCE_AUTH',403,'synthetic-secret-provider-body');}});
  const result=await denied.action({...action(2,'test'),owner_authorization:managerKey});assert.equal(result.test?.outcome,'denied');assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
});
test('private file component requires separate key paths and distinct high-entropy manager proof',async()=>{
  const f=await fixture(),unlock=path.join(f.parent,'unlock'),manager=path.join(f.parent,'manager');
  const master=token(),managerKey=token();await writeFile(unlock,master+'\n',{mode:0o600});await writeFile(manager,createHash('sha256').update(managerKey).digest('hex'),{mode:0o600});
  assert.throws(()=>fileCredentialComponents({directory:f.directory,unlock_key_file:path.join(f.directory,'key'),manager_key_hash_file:manager}));
  const components=fileCredentialComponents({directory:f.directory,unlock_key_file:unlock,manager_key_hash_file:manager});
  const api=new CredentialApi(components);
  await assert.rejects(api.action({...action(0),owner_authorization:token()}));
  assert.equal((await api.action({...action(0),owner_authorization:managerKey})).revision,1);
  await unlink(unlock);assert.equal((await api.status()).state,'locked');
  assert.ok(!(await readFile(components.store.file,'utf8')).includes(master));
});
test('hosted credential route retains cookie/CSRF/origin/body gates before storage and refuses preview mode',async()=>{
  const f=await fixture(),readerKey=token(),managerKey=token();let authCalls=0;
  const api=new CredentialApi({store:f.store,authorize:async input=>{authCalls++;if(input.owner_authorization!==managerKey)throw new ExplorerError('CREDENTIAL_MANAGEMENT_REQUIRED',403,'manager required');}});
  const source=new TestSource(await sample()),reader=new ExplorerReader(source);
  const host=await startExplorer(reader,{assets:path.resolve('explorer'),credentials:api,hosted:{publicOrigin:'https://studio.example.test',trustedProxyAddresses:['127.0.0.1'],accessKeySha256:createHash('sha256').update(readerKey).digest('hex')}});
  const send=(route:string,method='GET',extra:Record<string,string>={},body?:string)=>new Promise<{status:number;headers:any;text:string;data:any}>((resolve,reject)=>{const req=request(host.origin+route,{method,headers:{host:'studio.example.test','x-forwarded-proto':'https',...(method==='POST'?{origin:'https://studio.example.test','content-type':'application/json'}:{}),...extra}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,text,data:JSON.parse(text)}));});req.on('error',reject);req.end(body);});
  try {
    assert.equal((await send('/studio/v1/credentials')).status,401);
    const login=await send('/studio/login','POST',{},JSON.stringify({access_key:readerKey})),cookie=login.headers['set-cookie'][0].split(';')[0],csrf=login.data.csrf;
    const input=JSON.stringify({...action(0),owner_authorization:managerKey});
    assert.equal((await send('/studio/v1/credentials','POST',{cookie},input)).status,403);
    assert.equal((await send('/studio/v1/credentials','POST',{cookie,'x-studio-csrf':csrf,origin:'null'},input)).status,403);
    assert.equal((await send('/studio/v1/credentials?project_id=foreign','POST',{cookie,'x-studio-csrf':csrf},input)).status,400);
    assert.equal((await send('/studio/v1/credentials','POST',{cookie,'x-studio-csrf':csrf},'x'.repeat(1025))).status,413);assert.equal(authCalls,0);
    const saved=await send('/studio/v1/credentials','POST',{cookie,'x-studio-csrf':csrf},input);assert.equal(saved.status,200);assert.ok(!saved.text.includes(apiToken));assert.ok(!saved.text.includes(managerKey));
    assert.equal((await send('/studio/v1/credentials','GET',{cookie})).data.credentials[0].configured,true);
    assert.equal((await send('/studio/v1/credentials','POST',{cookie,'x-studio-csrf':csrf},JSON.stringify({...action(1,'remove'),owner_authorization:readerKey}))).status,403);
    assert.equal(source.calls,0);
  }finally{await host.close();}
  const preview=await startExplorer(reader,{assets:path.resolve('explorer'),credentials:api});try{assert.equal((await fetch(preview.origin+'/studio/v1/credentials',{headers:{authorization:'Bearer '+preview.capability}})).status,404);}finally{await preview.close();}
});
