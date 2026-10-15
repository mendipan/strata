async function tools(page){await page.locator('main[aria-busy]').waitFor({state:'detached'});const summary=page.getByText('Connection details and tools',{exact:true});await summary.waitFor();if(!await summary.evaluate(n=>n.parentElement.open))await summary.click();}
// Real Edge with synthetic owner/API state; every HTTPS request stays on loopback.
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {managerHostFixture} from '../dist/tests/studio-manager-host-fixture.js';
import {ExplorerError} from '../dist/src/explorer/contract.js';
if(process.env.STRATA_BROWSER_ASSETS_ROOT)process.chdir(process.env.STRATA_BROWSER_ASSETS_ROOT);
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const output=await mkdtemp(path.join(tmpdir(),'strata-managed-reconciliation-browser-'));
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],failures=[],errors=[],blocked=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function scenario(name,exercise){
  const f=await managerHostFixture(),network=[];let lose=false,drop=false,lostId=null;
  const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(6000);
  await context.route('**/*',async route=>{
    const original=route.request(),url=new URL(original.url());
    if(url.origin!==f.origin){blocked.push(url.origin);return route.abort();}
    const connectionPost=url.pathname==='/studio/v1/owner/connections'&&original.method()==='POST';
    network.push({path:url.pathname,method:original.method(),...(connectionPost?{body:JSON.parse(original.postData())}:{})});
    if(drop&&connectionPost){drop=false;lostId=JSON.parse(original.postData()).request_id;return route.abort();}
    const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
    const response=await new Promise((resolve,reject)=>{
      const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));
      });req.on('error',reject);req.end(original.postDataBuffer());
    });
    if(lose&&url.pathname==='/studio/v1/owner/connections'&&original.method()==='POST'){
      lose=false;lostId=JSON.parse(original.postData()).request_id;return route.abort();
    }
    await route.fulfill(response);
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(f.origin+'/#/settings');
    await page.getByLabel('Sign-in name',{exact:true}).fill('manager.owner');
    await page.getByLabel('Password',{exact:true}).fill(f.password);
    await page.getByLabel('Password',{exact:true}).press('Enter');
    await page.getByRole('heading',{name:'Approved repository connections',exact:true}).waitFor();
    await exercise({f,page,network,loseResponse:()=>lose=true,dropBeforeDispatch:()=>drop=true,lostId:()=>lostId});
    await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
  }catch(error){failures.push({scenario:name,error:String(error)});await page.screenshot({path:path.join(output,name+'-failure.png'),fullPage:true});await writeFile(path.join(output,name+'-failure.txt'),await page.locator('body').innerText());}
  finally{await context.close();await f.server.close();}
}
async function create(page){await page.getByLabel('Connection label',{exact:true}).fill('Synthetic source');await page.getByRole('button',{name:'Create connection',exact:true}).click();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();}
async function connect(page){await page.getByRole('button',{name:'Connect repository',exact:true}).click();await page.getByRole('button',{name:'Open project',exact:true}).waitFor();await tools(page);await page.getByText('Published records are readable under this approved grant.',{exact:true}).waitFor();}
async function detailsCleared(page){
  await page.getByRole('button',{name:'Connection details',exact:true}).click();
  check('source details contain no obsolete generation',await page.getByRole('dialog').getByText('None verified',{exact:true}).count()===1);
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
}
try{
  await scenario('uncertain-reload',async({f,page,network,loseResponse,lostId})=>{
    loseResponse();await page.getByRole('button',{name:'Create connection',exact:true}).click();
    await page.getByRole('button',{name:'Check saved action outcome',exact:true}).waitFor();
    const id=lostId();check('lost response commits exactly once without provider access',(await f.state()).entries.length===1&&f.calls()===0);
    await page.reload();await page.getByRole('heading',{name:'Approved repository connections',exact:true}).waitFor();
    await page.getByRole('button',{name:'Check saved action outcome',exact:true}).waitFor();
    check('reload restores the original unresolved UUID',await page.getByText(id,{exact:true}).count()===1);
    await page.getByRole('link',{name:'Layers',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Check saved action outcome',exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();
    await page.getByRole('button',{name:'Check saved action outcome',exact:true}).waitFor();
    check('navigation and coordinator refresh retain the original UUID',await page.getByText(id,{exact:true}).count()===1);
    check('reload/navigation/refresh do not inspect or replay automatically',network.filter(n=>n.path.includes('/operations/')).length===0&&network.filter(n=>n.path==='/studio/v1/owner/connections'&&n.method==='POST').length===1);
    const storage=await page.evaluate(()=>Object.values(sessionStorage));const pending=storage.map(value=>{try{return JSON.parse(value);}catch{return null;}}).find(value=>value?.format==='strata-studio-pending-connection/1');
    check('only bounded owner/catalog-scoped nonsensitive action metadata is retained',pending?.body.request_id===id&&/^[a-f0-9]{64}$/.test(pending.owner)&&/^[a-f0-9]{64}$/.test(pending.catalog)&&Object.keys(pending.body).sort().join(',')==='action,label,profile_id,request_id,revision,ticket_id'&&!JSON.stringify(storage).includes(f.password));
    const foreignId=randomUUID(),foreignKey='strata-studio-pending-connections/1:'+'a'.repeat(64);
    await page.evaluate(({key,value})=>sessionStorage.setItem(key,JSON.stringify(value)),{key:foreignKey,value:{...pending,owner:'a'.repeat(64),body:{...pending.body,request_id:foreignId}}});
    await page.reload();await page.getByRole('button',{name:'Check saved action outcome',exact:true}).waitFor();
    check('another owner namespace cannot replace this unresolved action',await page.getByText(id,{exact:true}).count()===1&&await page.getByText(foreignId,{exact:true}).count()===0);
    await page.evaluate(key=>sessionStorage.removeItem(key),foreignKey);
    await page.setViewportSize({width:320,height:800});check('unresolved UUID fits the mobile viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'uncertain-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'Check saved action outcome',exact:true}).click();
    await page.getByText(id,{exact:true}).waitFor({state:'detached'});
    check('explicit inspection uses the original GET receipt without replay',network.some(n=>n.path.endsWith('/operations/'+id)&&n.method==='GET')&&network.filter(n=>n.path==='/studio/v1/owner/connections'&&n.method==='POST').length===1);
    await page.reload();await page.getByRole('heading',{name:'Approved repository connections',exact:true}).waitFor();
    check('confirmed terminal outcome clears retained reconciliation metadata',await page.getByRole('button',{name:'Check saved action outcome',exact:true}).count()===0&&!(await page.evaluate(()=>JSON.stringify({...sessionStorage}))).includes(id));
  });
  await scenario('binding-failure',async({f,page})=>{
    await create(page);await connect(page);f.fail(new ExplorerError('SOURCE_BINDING',403,'Synthetic unsafe provider binding detail'));
    await page.getByRole('button',{name:'Test read',exact:true}).click();await page.getByText(/^failed /).waitFor({state:'attached'});await tools(page);
    await page.getByRole('alert').filter({hasText:'SOURCE_BINDING'}).waitFor();
    check('binding refusal survives coordinator reconstruction',(await f.state()).entries[0].last_test.code==='SOURCE_BINDING'&&await page.getByRole('alert').filter({hasText:'trusted registry or repository identity could not be verified'}).count()===1);
    await page.reload();await page.getByRole('alert').filter({hasText:'SOURCE_BINDING'}).waitFor();await tools(page);
    check('binding refusal remains actionable after reload',await page.getByRole('alert').filter({hasText:'host operator'}).count()===1&&await page.getByRole('button',{name:'Reconnect',exact:true}).isDisabled()&&await page.getByRole('button',{name:'Test read',exact:true}).isEnabled());
    await page.screenshot({path:path.join(output,'binding-refusal.png'),fullPage:true});
    check('raw provider refusal is never displayed',!(await page.locator('body').innerText()).includes('Synthetic unsafe provider binding detail'));
    f.fail(undefined);await page.getByRole('button',{name:'Test read',exact:true}).click();await page.getByText(/^passed /).waitFor({state:'attached'});await tools(page);
    check('an explicit successful verification clears the durable refusal',await page.getByRole('alert').filter({hasText:'SOURCE_BINDING'}).count()===0&&await page.getByRole('button',{name:'Reconnect',exact:true}).isEnabled());
  });
  await scenario('exact-retry',async({f,page,network,dropBeforeDispatch,lostId})=>{
    dropBeforeDispatch();await page.getByRole('button',{name:'Create connection',exact:true}).click();
    await page.getByRole('button',{name:'Check saved action outcome',exact:true}).waitFor();const id=lostId();
    const original=network.find(n=>n.body)?.body;
    check('an undispatched unknown action has no server effect',(await f.state()).entries.length===0&&f.calls()===0);
    const saved=await page.evaluate(()=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('strata-studio-pending-connections/1:'));return {key,value:JSON.parse(sessionStorage.getItem(key))};});
    await page.evaluate(saved=>sessionStorage.setItem(saved.key,JSON.stringify({...saved.value,catalog:'b'.repeat(64)})),saved);
    await page.reload();await page.getByRole('button',{name:'Check saved action outcome',exact:true}).click();
    await page.getByText('No action receipt exists for this request.',{exact:true}).waitFor();
    check('a changed catalog context cannot retry an unresolved action',await page.getByRole('button',{name:'Retry exact action',exact:true}).count()===0&&await page.getByText(id,{exact:true}).count()===1);
    await page.evaluate(saved=>sessionStorage.setItem(saved.key,JSON.stringify(saved.value)),saved);
    await page.reload();await page.getByRole('button',{name:'Check saved action outcome',exact:true}).click();await page.getByRole('button',{name:'Retry exact action',exact:true}).waitFor();
    check('no missing-receipt action is retried automatically',network.filter(n=>n.body).length===1);
    await page.getByRole('button',{name:'Retry exact action',exact:true}).click();await page.getByText(id,{exact:true}).waitFor({state:'detached'});
    const posts=network.filter(n=>n.body);check('explicit retry retains the exact UUID and complete original payload',posts.length===2&&JSON.stringify(posts[1].body)===JSON.stringify(original));
    check('explicit retry commits once without source dispatch',(await f.state()).entries.length===1&&f.calls()===0);
  });
  await scenario('storage-unavailable',async({f,page,network})=>{
    await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===sessionStorage)throw new DOMException('Synthetic blocked session storage','SecurityError');return original.call(this,key,value);};});
    await page.getByRole('button',{name:'Create connection',exact:true}).click();await page.getByText('This browser cannot retain the action identity. Enable session storage before dispatching a connection action.',{exact:true}).waitFor();
    check('unavailable reconciliation storage refuses dispatch',network.filter(n=>n.body).length===0&&(await f.state()).entries.length===0&&f.calls()===0);
  });
  await scenario('stale-cas',async({f,page})=>{
    await create(page);await connect(page);check('connected source initially has verified badge',await page.locator('#header .source-badge').innerText()==='Sample data');
    const login=await f.login(),status=(await f.b.send('/studio/v1/owner/connections')).data;
    const result=await f.b.send('/studio/v1/owner/connections','POST',{action:'disconnect',revision:status.revision,request_id:randomUUID(),connection_id:status.selected_connection_id},login.csrf);assert.equal(result.status,200);const calls=f.calls();
    await page.getByRole('button',{name:'Test read',exact:true}).click();await page.getByText('Selection persists.',{exact:false}).waitFor({state:'attached'});await tools(page);
    await page.locator('#header .source-badge').filter({hasText:'Check connection below'}).waitFor();
    check('stale CAS metadata reload clears the global source badge',f.calls()===calls&&(await f.b.send('/explorer/v1/connection')).status===409);
    await detailsCleared(page);
  });
  await scenario('revoked-refresh',async({f,page})=>{
    await create(page);await connect(page);await f.login();const calls=f.calls();f.setPolicy(undefined);
    await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();
    await page.getByText('The host operator must approve exact repositories, trusted publication indexes and finite read grants for this owner.',{exact:false}).waitFor();
    await page.locator('#header .source-badge').filter({hasText:'Check connection below'}).waitFor();
    check('revoked status refresh clears global source without dispatch',(await f.b.send('/explorer/v1/connection')).status===403&&f.calls()===calls);
    await detailsCleared(page);
  });
  check('no browser errors or external requests',errors.length===0&&blocked.length===0);
  await writeFile(path.join(output,'result.json'),JSON.stringify({checks,failures,errors,blocked,real_secret_reads:0,real_provider_calls:0,scope:'Synthetic intercepted HTTPS in real Edge'},null,2));
  process.stdout.write(JSON.stringify({passed:checks.length,failures:failures.length,output})+'\n');if(failures.length)process.exitCode=1;
}finally{await browser.close();}
