import assert from 'node:assert/strict';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {namespaceFixture} from './namespace-fixture.js';

// One real synthetic owner + namespace lifecycle feeding the POSIX operator
// regression. No original owner, saved credential, provider or host is opened.
export async function namespaceLoginLifecycle(){
  const f=await namespaceFixture();
  try{
    const loginFile=path.join(f.base.state.config.state_directory,'login-limit.json');
    await f.prepare();const first=await lstat(loginFile,{bigint:true});
    const other=f.browser(),pre=(await other.send('/studio/owner/session')).data;
    assert.equal((await other.send('/studio/owner/login','POST',{username:'workspace.owner',password:'Synthetic incorrect password'},pre.csrf)).status,401);
    const pre2=(await other.send('/studio/owner/session')).data;
    assert.equal((await other.send('/studio/owner/login','POST',{username:'workspace.owner',password:f.base.password},pre2.csrf)).status,200);
    const second=await lstat(loginFile,{bigint:true});assert.ok(first.ino!==second.ino||first.ctimeNs!==second.ctimeNs);
    const created=await f.action('create',{name:'rollback-synthetic',purpose:'Retain login and spent/revoked history'});assert.equal(created.status,200,created.text);
    const spent=await f.server.store.usageSnapshot();assert.ok(spent.reserved.requests>0);
    assert.equal((await f.action('revoke')).status,200);await f.restart();await f.login();
    assert.equal((await f.server.store.snapshot()).revoked,true);assert.deepEqual(await f.server.store.usageSnapshot(),spent);
    const receipt={login_limit:JSON.parse(await readFile(loginFile,'utf8')),
      namespace:JSON.parse(await readFile(path.join(f.config.catalog_directory,'namespace.json'),'utf8')),
      usage:JSON.parse(await readFile(path.join(f.config.catalog_directory,'usage.json'),'utf8')),
      tombstone:JSON.parse(await readFile(path.join(f.config.catalog_directory,'revoked.json'),'utf8'))};
    assert.equal(receipt.login_limit.attempts.length,1);assert.ok(receipt.usage.reserved_requests>0);
    if(process.env.STRATA_NAMESPACE_LOGIN_LIFECYCLE)await writeFile(process.env.STRATA_NAMESPACE_LOGIN_LIFECYCLE,JSON.stringify(receipt),{mode:0o600});
    return {checks:['successful and failed login mutate only retained limiter','synthetic project reserves spending','revoke/restart retains spending and tombstone'],provider:'strict-synthetic'};
  }finally{await f.server.close();}
}
