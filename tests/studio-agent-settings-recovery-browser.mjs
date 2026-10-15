// Real Edge, authenticated owner routes and disposable synthetic state only.
// Every HTTPS request is intercepted into loopback; no actual secret/provider.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp,writeFile,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { agentSettingsFixture } from '../dist/tests/studio-agent-settings-fixture.js';
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href),browser=await chromium.launch({channel:'msedge',headless:true}),output=await mkdtemp(path.join(tmpdir(),'strata-agent-recovery-browser-'));
const checks=[],failures=[],errors=[],blocked=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function scenario(name,exercise){
  let f=await agentSettingsFixture();const fixtures=[f],context=await browser.newContext({viewport:{width:1440,height:1000}}),network=[];context.setDefaultTimeout(6000);let lose=false,drop=false,lostBody,refuse=false;
  await context.route('**/*',async route=>{
    const original=route.request(),url=new URL(original.url());if(url.origin!==f.origin){blocked.push(url.origin);return route.abort();}
    const post=url.pathname==='/studio/v1/owner/agents'&&original.method()==='POST';network.push({path:url.pathname,method:original.method(),fixture:fixtures.indexOf(f)});
    if(refuse&&url.pathname==='/studio/v1/owner/agents'&&original.method()==='GET')return route.abort();
    if(drop&&post){drop=false;lostBody=JSON.parse(original.postData());return route.abort();}
    const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
    const response=await new Promise((resolve,reject)=>{const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(original.postDataBuffer());});
    if(lose&&post){lose=false;lostBody=JSON.parse(original.postData());return route.abort();}await route.fulfill(response);
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));const panel=page.getByRole('region',{name:'Agent connection',exact:true});
  const login=async(password=f.password)=>{await page.getByLabel('Sign-in name',{exact:true}).fill('manager.owner');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel('Password',{exact:true}).press('Enter');await page.getByText('Agent service (optional)',{exact:true}).click();await panel.getByRole('button',{name:'Refresh agent status',exact:true}).waitFor();};
  const configure=async()=>{await panel.getByRole('button',{name:'Configure agent',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-agent-revision]')?.dataset.agentRevision==='1');};
  const connect=async()=>{await configure();await panel.getByRole('button',{name:'Connect agent discovery',exact:true}).click();await panel.getByText('connected-discovery',{exact:true}).waitFor();};
  const rotate=async()=>{const session=await f.login(),password='Synthetic rotated recovery password 2026';assert.equal((await f.b.send('/studio/owner/password','POST',{request_id:randomUUID(),expected_generation:1,new_password:password},session.csrf)).status,200);await page.reload();await login(password);return password;};
  try{await page.goto(f.origin+'/#/settings');await login();await exercise({f,page,panel,network,login,configure,connect,rotate,lose:()=>lose=true,drop:()=>drop=true,lost:()=>lostBody,refuse:value=>refuse=value,switchOwner:async()=>{f=await agentSettingsFixture();fixtures.push(f);await context.clearCookies();await page.reload();await login();return f;}});}
  catch(error){failures.push({scenario:name,error:String(error)});}
  finally{await writeFile(path.join(output,name+'.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});await context.close();for(const fixture of fixtures)await fixture.server.close();}
}
try{
  for(const kind of ['missing-state','revoked-owner'])await scenario(kind,async({f,panel,connect})=>{
    await connect();const before=f.agent.counts();if(kind==='missing-state')await unlink(path.join(f.agent.stateDirectory,'state.json'));else f.owner.clear();
    await panel.getByRole('button',{name:'Refresh agent status',exact:true}).click();await panel.getByRole('alert').waitFor();
    check(kind+': refused refresh removes current discovery',await panel.getByText(/^Verified until /).count()===0&&await panel.getByText('connected-discovery',{exact:true}).count()===0);
    check(kind+': unverified actions are disabled',await panel.getByRole('button',{name:'Test agent discovery',exact:true}).isDisabled()&&await panel.getByRole('button',{name:'Connect agent discovery',exact:true}).isDisabled()&&await panel.getByRole('button',{name:'Remove agent',exact:true}).isDisabled());
    check(kind+': history remains explicitly historical',await panel.getByText(/passed .*\(historical\)/).count()===1);check(kind+': no extra probe or credential access',JSON.stringify(before)===JSON.stringify(f.agent.counts()));
    check(kind+': earlier successful feedback is replaced by unverified guidance',await panel.getByText('Service discovery verified. Engine authority and chat remain unavailable.',{exact:true}).count()===0&&await panel.getByText(/^Agent status could not be verified\./).count()===1);
  });
  await scenario('rotation-completed-outcome',async({f,page,panel,network,rotate,lose,lost})=>{
    lose();await panel.getByRole('button',{name:'Configure agent',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();const original=lost();await rotate();
    check('same owner rotation preserves original recovery UUID',await panel.getByText(original.request_id,{exact:true}).count()===1&&await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).count()===1);
    check('rotation performs no automatic lookup or action',network.filter(n=>n.path.includes('/owner/agents/operations/')).length===0&&network.filter(n=>n.path==='/studio/v1/owner/agents'&&n.method==='POST').length===1);
    await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).click();await panel.getByText('Saved agent action confirmed. No probe was replayed.',{exact:true}).waitFor();check('current same owner can explicitly inspect old receipt',f.agent.counts().dispatches===0&&(await f.agentStore.read()).operations.length===1);
  });
  await scenario('transient-refresh',async({f,panel,connect,refuse})=>{
    await connect();const before=f.agent.counts();refuse(true);await panel.getByRole('button',{name:'Refresh agent status',exact:true}).click();await panel.getByRole('alert').waitFor();
    check('transport refusal removes verified status and disables actions',await panel.getByText('Status unverified',{exact:true}).count()===1&&await panel.getByText(/^Verified until /).count()===0&&await panel.getByRole('button',{name:'Connect agent discovery',exact:true}).isDisabled());
    check('transport refusal replaces earlier successful feedback',await panel.getByText('Service discovery verified. Engine authority and chat remain unavailable.',{exact:true}).count()===0&&await panel.getByText(/^Agent status could not be verified\./).count()===1);
    refuse(false);await panel.getByRole('button',{name:'Refresh agent status',exact:true}).click();await panel.getByText('connected-discovery',{exact:true}).waitFor();
    check('successful metadata refresh restores current eligibility',await panel.getByText(/^Verified until /).count()===1&&!await panel.getByRole('button',{name:'Test agent discovery',exact:true}).isDisabled()&&!await panel.getByRole('button',{name:'Remove agent',exact:true}).isDisabled());
    check('transient refusal and recovery load no authentication or provider',JSON.stringify(before)===JSON.stringify(f.agent.counts()));
  });
  await scenario('rotation-absent-outcome',async({f,panel,network,rotate,drop,lost})=>{
    drop();await panel.getByRole('button',{name:'Configure agent',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();const original=lost();await rotate();
    check('same owner rotation retains absent original action',await panel.getByText(original.request_id,{exact:true}).count()===1&&await panel.getByRole('button',{name:'Retry exact agent action',exact:true}).count()===0);
    await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).click();await panel.getByRole('button',{name:'Dismiss unsaved agent action',exact:true}).waitFor();
    check('old generation NOT_FOUND cannot offer replay',await panel.getByRole('button',{name:'Retry exact agent action',exact:true}).count()===0&&network.filter(n=>n.path==='/studio/v1/owner/agents'&&n.method==='POST').length===1&&(await f.agentStore.read()).operations.length===0);
    await panel.getByRole('button',{name:'Dismiss unsaved agent action',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor({state:'detached'});
    check('explicit old absent receipt dismissal performs no exchange',f.agent.counts().dispatches===0&&f.agent.counts().contextLoads===0);
  });
  await scenario('cross-owner-isolation',async({f,page,panel,network,lose,lost,switchOwner})=>{
    lose();await panel.getByRole('button',{name:'Configure agent',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();const original=lost(),before=f.agent.counts(),saved=await page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage).filter(([k])=>k.startsWith('strata-studio-pending-agent/2:'))));
    const other=await switchOwner();
    check('different owner and protected state never see foreign recovery',await panel.getByText(original.request_id,{exact:true}).count()===0&&await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).count()===0);
    check('foreign pending metadata remains only in original namespace',JSON.stringify(saved)===JSON.stringify(await page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage).filter(([k])=>k.startsWith('strata-studio-pending-agent/2:'))))));
    check('owner switch performs no automatic outcome lookup or action',network.filter(n=>n.path.includes('/owner/agents/operations/')).length===0&&network.filter(n=>n.path==='/studio/v1/owner/agents'&&n.method==='POST').length===1);
    check('owner switch leaves both histories and probes unchanged',JSON.stringify(before)===JSON.stringify(f.agent.counts())&&(await f.agentStore.read()).operations.length===1&&(await other.agentStore.read()).operations.length===0&&other.agent.counts().dispatches===0&&other.agent.counts().contextLoads===0);
  });
  check('no page error or external request',errors.length===0&&blocked.length===0);await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,failures,errors,blocked,scope:'Synthetic real owner routes, real Edge, intercepted HTTPS'},null,2));process.stdout.write(JSON.stringify({passed:checks.length,failures:failures.length,output})+'\n');if(failures.length)process.exitCode=1;
}finally{await browser.close();}
