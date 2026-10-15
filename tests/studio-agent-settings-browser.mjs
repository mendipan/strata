// Real Edge, synthetic owner/files and intercepted HTTPS. No external provider,
// credential provisioning, inference or production agent service is exercised.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { agentSettingsFixture } from '../dist/tests/studio-agent-settings-fixture.js';
import { deferred } from '../dist/tests/studio-agent-connection-fixture.js';
const { chromium }=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const output=await mkdtemp(path.join(tmpdir(),'strata-agent-settings-browser-')),browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[],errors=[],blocked=[],network=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function scenario(name,configured,exercise){
  const f=await agentSettingsFixture(configured),context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(6000);let lose=false,drop=false,lostId;
  await context.route('**/*',async route=>{
    const original=route.request(),url=new URL(original.url());if(url.origin!==f.origin){blocked.push(url.origin);return route.abort();}
    const action=url.pathname==='/studio/v1/owner/agents'&&original.method()==='POST';
    network.push({scenario:name,path:url.pathname,method:original.method(),...(action?{body:JSON.parse(original.postData())}:{})});
    if(drop&&action){drop=false;lostId=JSON.parse(original.postData()).request_id;return route.abort();}
    const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
    const response=await new Promise((resolve,reject)=>{const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(original.postDataBuffer());});
    if(lose&&action){lose=false;lostId=JSON.parse(original.postData()).request_id;return route.abort();}await route.fulfill(response);
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(f.origin+'/#/settings');await page.getByLabel('Sign-in name',{exact:true}).fill('manager.owner');await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByLabel('Password',{exact:true}).press('Enter');
    await page.getByText('Agent service (optional)',{exact:true}).click();const panel=page.getByRole('region',{name:'Agent connection',exact:true});await panel.getByRole('button',{name:'Refresh agent status',exact:true}).waitFor();
    await exercise({f,page,panel,loseResponse:()=>lose=true,dropBeforeDispatch:()=>drop=true,lostId:()=>lostId});
    await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
  }catch(error){await page.screenshot({path:path.join(output,name+'-failure.png'),fullPage:true});await writeFile(path.join(output,name+'-failure.txt'),await page.locator('body').innerText());throw error;}
  finally{await context.close();await f.server.close();}
}
try{
  await scenario('lifecycle',true,async({f,page,panel,loseResponse,lostId})=>{
    check('opening settings/status loads no agent secret or provider',f.agent.counts().contextLoads===0&&f.agent.counts().dispatches===0&&f.calls()===0);
    check('only approved profile is selectable',await panel.getByLabel('Approved agent service').locator('option').count()===1);
    await panel.getByRole('button',{name:'Configure agent',exact:true}).press('Enter');await panel.getByRole('button',{name:'Test agent discovery',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-agent-revision]')?.dataset.agentRevision==='1');
    check('keyboard configure persists disconnected without exchange',f.agent.counts().contextLoads===0&&!(await f.agentStore.read()).connection.last_test);
    await panel.getByRole('button',{name:'Test agent discovery',exact:true}).evaluate(n=>{n.click();n.click();});await panel.getByText('Discovery test passed. The agent remains disconnected.',{exact:true}).waitFor();check('repeated click performs one explicit test and stays disconnected',f.agent.counts().dispatches===1&&await panel.getByText('Not verified for current use',{exact:true}).count()===1);
    await panel.getByRole('button',{name:'Connect agent discovery',exact:true}).click();await panel.getByText('connected-discovery',{exact:true}).waitFor();check('explicit connect verifies current discovery',f.agent.counts().dispatches===2&&await panel.getByText('Verified until',{exact:false}).count()===1);
    check('advertised features never become engine authority or chat',await panel.getByText('Not configured',{exact:true}).count()===1&&await panel.getByText('Unavailable',{exact:true}).count()===1&&await page.getByRole('textbox',{name:/chat/i}).count()===0);
    await panel.getByRole('button',{name:'Refresh agent status',exact:true}).click();check('metadata refresh never probes',f.agent.counts().dispatches===2);
    await panel.getByRole('button',{name:'Remove agent',exact:true}).click();await page.keyboard.press('Escape');check('Escape cancels remove and restores focus',!!(await f.agentStore.read()).connection&&await panel.getByRole('button',{name:'Remove agent',exact:true}).evaluate(n=>document.activeElement===n));
    await page.setViewportSize({width:320,height:800});await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});check('320px layout fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:720,height:500});check('200-percent equivalent viewport fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1000});
    loseResponse();await panel.getByRole('button',{name:'Disconnect agent',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();const id=lostId();check('lost response retains exactly one committed action',(await f.agentStore.read()).operations.filter(o=>o.request_id===id).length===1);
    const posts=network.filter(n=>n.scenario==='lifecycle'&&n.path==='/studio/v1/owner/agents'&&n.method==='POST').length;await page.reload();await page.getByText('Agent service (optional)',{exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();check('reload keeps original UUID without auto inspect/replay',await panel.getByText(id,{exact:true}).count()===1&&network.filter(n=>n.path.includes('/owner/agents/operations/')).length===0&&network.filter(n=>n.scenario==='lifecycle'&&n.path==='/studio/v1/owner/agents'&&n.method==='POST').length===posts);
    await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor({state:'detached'});check('outcome GET resolves without dispatch',f.agent.counts().dispatches===2&&network.some(n=>n.path.endsWith('/operations/'+id)&&n.method==='GET'));
    check('historical discovery after reload is never current',await panel.getByText('Not verified for current use',{exact:true}).count()===1);
    f.agent.advance(5*60_000);await panel.getByRole('button',{name:'Refresh agent status',exact:true}).click();await panel.getByRole('button',{name:'Confirm agent changes',exact:true}).waitFor();check('stale freshness disables remove with a visible next action',await panel.getByRole('button',{name:'Remove agent',exact:true}).isDisabled());
    await panel.getByRole('button',{name:'Confirm agent changes',exact:true}).click();await page.getByLabel('Current password',{exact:true}).fill(f.password);await page.getByLabel('Current password',{exact:true}).press('Enter');await panel.getByRole('button',{name:'Confirm agent changes',exact:true}).waitFor({state:'detached'});check('explicit password confirmation makes no discovery request',f.agent.counts().dispatches===2);
    const storage=await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,url:location.href,cookie:document.cookie}));check('no owner/provider/service secret in browser storage',!storage.includes(f.password)&&!storage.includes('public-fixture-only'));
  });
  await scenario('exact-retry-cancel',true,async({f,page,panel,dropBeforeDispatch,lostId})=>{
    dropBeforeDispatch();await panel.getByRole('button',{name:'Configure agent',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();const id=lostId();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).click();await panel.getByRole('button',{name:'Retry exact agent action',exact:true}).waitFor();await panel.getByRole('button',{name:'Retry exact agent action',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-agent-revision]')?.dataset.agentRevision==='1');check('explicit absent-receipt retry preserves exact UUID/payload',(await f.agentStore.read()).operations[0].request_id===id&&f.agent.counts().dispatches===0);
    const waiting=deferred();f.agent.delay(waiting.promise);await panel.getByRole('button',{name:'Connect agent discovery',exact:true}).click();await f.agent.started.promise;await panel.getByRole('button',{name:'Cancel agent waiting',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();
    check('cancel text does not claim remote rollback',await panel.getByText('Stopped waiting. Check the saved outcome; dispatched work may have continued.',{exact:true}).count()===1);
    waiting.resolve();for(let i=0;i<100;i++){if((await f.agentStore.read()).operations.at(-1).result)break;await new Promise(resolve=>setTimeout(resolve,10));}
    await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).click();await panel.getByText('Saved agent action confirmed. No probe was replayed.',{exact:true}).waitFor();
    await panel.getByText('connected-discovery',{exact:true}).waitFor();
    check('late completion is shown truthfully after explicit outcome inspection',(await f.agentStore.read()).probe_times.length===1&&f.agent.counts().dispatches===1&&await panel.getByText('connected-discovery',{exact:true}).count()===1);
    await panel.getByRole('button',{name:'Remove agent',exact:true}).click();await page.getByRole('button',{name:'Remove agent connection',exact:true}).click();await panel.getByRole('button',{name:'Configure agent',exact:true}).waitFor();check('remove retains original receipts and spending',(await f.agentStore.read()).operations.length===3&&(await f.agentStore.read()).probe_times.length===1);
  });
  await scenario('unconfigured',false,async({f,panel})=>{
    check('unconfigured host displays exact missing service gate',await panel.getByText(/AGENT_TARGET_UNCONFIGURED/).count()===1);check('unconfigured actions disabled',await panel.getByRole('button',{name:'Configure agent',exact:true}).isDisabled()&&await panel.getByRole('button',{name:'Connect agent discovery',exact:true}).isDisabled());check('unconfigured has no provider or secret call',f.agent.counts().contextLoads===0&&f.calls()===0);
  });
  await scenario('stale-revision',true,async({f,panel})=>{
    await panel.getByRole('button',{name:'Configure agent',exact:true}).click();await panel.getByRole('button',{name:'Disconnect agent',exact:true}).waitFor();
    const session=await f.login();await f.b.send('/studio/v1/owner/agents','POST',{action:'disconnect',revision:1,request_id:crypto.randomUUID()},session.csrf);
    await panel.getByRole('button',{name:'Test agent discovery',exact:true}).click();await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).waitFor();
    check('stale revision retains original action and dispatches nothing',f.agent.counts().dispatches===0);
    await panel.getByRole('button',{name:'Check saved agent outcome',exact:true}).click();await panel.getByRole('button',{name:'Dismiss unsaved agent action',exact:true}).waitFor();await panel.getByRole('button',{name:'Dismiss unsaved agent action',exact:true}).click();check('dismissal follows verified absence without automatic retry',f.agent.counts().dispatches===0&&(await f.agentStore.read()).operations.length===2);
  });
  check('no page errors or external requests',errors.length===0&&blocked.length===0);await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors,blocked,network,scope:'Synthetic intercepted HTTPS in real Edge; no live compatibility'},null,2));process.stdout.write(JSON.stringify({passed:checks.length,output})+'\n');
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,blocked,network,error:String(error)},null,2));process.stderr.write('Failure evidence: '+output+'\n');throw error;}finally{await browser.close();}
