// Real Edge, synthetic owner/token/catalog only. All browser HTTPS stays on loopback.
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {managerHostFixture} from '../dist/tests/studio-manager-host-fixture.js';
if(process.env.STRATA_BROWSER_ASSETS_ROOT)process.chdir(process.env.STRATA_BROWSER_ASSETS_ROOT);
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({channel:'msedge',headless:true}),output=await mkdtemp(path.join(tmpdir(),'strata-settings-loading-browser-')),checks=[],failures=[],errors=[],blocked=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function scenario(name,exercise){
  if(process.env.STRATA_SETTINGS_LOADING_CASES&&!process.env.STRATA_SETTINGS_LOADING_CASES.split(',').includes(name))return;
  const f=await managerHostFixture(),owner=await f.login(),network=[];let stall=null,stallAfter=null,stallMethod='GET',refuse=false,refuseAfterReauth=false,release,heldResolve;const gate=new Promise(resolve=>release=resolve),held=new Promise(resolve=>heldResolve=resolve);
  const saved=await f.b.send('/studio/v1/owner/credentials','POST',{action:'save',credential_id:'artifacts-api-token',revision:0,request_id:randomUUID(),value:'synthetic-saved-token-never-live'},owner.csrf);assert.equal(saved.status,200,saved.text);
  const create=await f.b.send('/studio/v1/owner/connections','POST',{action:'create',profile_id:f.policy.profiles[0].profile_id,ticket_id:f.policy.tickets[0].ticket_id,label:'Synthetic approved repository',revision:0,request_id:randomUUID()},owner.csrf);assert.equal(create.status,200,create.text);
  const test=await f.b.send('/studio/v1/owner/connections','POST',{action:'test',connection_id:create.data.selected_connection_id,revision:1,request_id:randomUUID()},owner.csrf);assert.equal(test.status,200,test.text);
  const before=f.calls(),context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(7500);
  await context.route('**/*',async route=>{
    const original=route.request(),url=new URL(original.url());if(url.origin!==f.origin){blocked.push(url.origin);return route.abort();}
    network.push({path:url.pathname,method:original.method(),...(url.pathname==='/studio/v1/owner/connections'&&original.method()==='POST'?{body:JSON.parse(original.postData())}:{})});
    if(original.method()==='GET'&&url.pathname===stall)await gate;
    if(refuse&&original.method()==='GET'&&url.pathname==='/studio/v1/owner/connections')return route.abort().catch(()=>{});
    const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
    try{const response=await new Promise((resolve,reject)=>{const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(original.postDataBuffer());});if(original.method()===stallMethod&&url.pathname===stallAfter){heldResolve(JSON.parse(response.body.toString('utf8')));await gate;}if(refuseAfterReauth&&url.pathname==='/studio/owner/reauth'&&response.status===200)refuse=true;await route.fulfill(response);}catch{await route.abort().catch(()=>{});}
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const login=async()=>{await page.getByLabel('Sign-in name',{exact:true}).fill('manager.owner');await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByLabel('Password',{exact:true}).press('Enter');};
  try{await exercise({f,page,context,network,before,owner,login,stall:route=>stall=route,stallAfter:(route,method='GET')=>{stallAfter=route;stallMethod=method;},held:()=>held,release:()=>{stall=null;stallAfter=null;release();},refuse:value=>refuse=value,refuseAfterReauth:()=>refuseAfterReauth=true});}
  catch(error){failures.push({scenario:name,error:String(error)});}
  finally{release();await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});await writeFile(path.join(output,name+'.txt'),await page.locator('body').innerText());await writeFile(path.join(output,name+'-network.json'),JSON.stringify(network,null,2));await context.close();await f.server.close();}
}
try{
  await scenario('saved-tested-disconnected',async({f,page,network,before,login})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();await page.getByText('Your API token is saved securely on this server.',{exact:false}).waitFor();
    check('tested disconnected state has explicit next action',await page.getByText('Read test passed. Connect repository to open the project. No need to enter your token again.',{exact:true}).isVisible());
    check('saved token needs no new entry',!await page.getByLabel('Artifacts API token',{exact:true}).isVisible()&&await page.getByText('Saved on server',{exact:true}).count()===2);
    check('opening Settings performs no source read',f.calls()===before&&network.filter(n=>n.method==='POST'&&n.path==='/studio/v1/owner/connections').length===0);
    await page.screenshot({path:path.join(output,'saved-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'Connect repository',exact:true}).evaluate(button=>{button.click();button.click();});await page.getByRole('button',{name:'Open project',exact:true}).waitFor();
    check('repeated Connect dispatches once under existing grant',f.calls()===before+1&&network.filter(n=>n.body?.action==='connect').length===1&&(await f.state()).grants.length===1&&(await f.state()).entries[0].desired_connection);
    await page.getByRole('button',{name:'Open project',exact:true}).click();await page.waitForURL('**/#/blocks*');check('explicit open uses verified read with no extra provider dispatch',f.calls()===before+1);
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Open project',exact:true}).waitFor();
    await page.setViewportSize({width:320,height:800});await page.screenshot({path:path.join(output,'saved-mobile.png'),fullPage:true});check('guided saved-token flow fits 320px',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:720,height:500});check('guided flow fits zoom-equivalent viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const persistence=await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,url:location.href,cookie:document.cookie}));check('saved token and owner password never enter browser persistence',!persistence.includes('synthetic-saved-token-never-live')&&!persistence.includes(f.password));
  });
  for(const kind of ['source','credential','agent'])await scenario(kind+'-timeout',async({f,page,before,login,stall,release})=>{
    const routes={source:'/studio/v1/owner/connections',credential:'/studio/v1/owner/credentials',agent:'/studio/v1/owner/agents'};stall(routes[kind]);await page.goto(f.origin+'/#/settings');await login();
    await page.getByRole('heading',{name:'Connections',exact:true}).waitFor({timeout:1500});check(kind+': Settings shell mounts before stalled metadata completes',true);
    if(kind==='source'){await page.getByText('Your API token is saved securely on this server.',{exact:false}).waitFor();await page.getByRole('button',{name:'Retry repository connection',exact:true}).waitFor();check('source timeout preserves visible saved-token status',await page.getByText('Status took too long to load. Retry this section.',{exact:true}).isVisible());release();await page.getByRole('button',{name:'Retry repository connection',exact:true}).click();}
    else{await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor({timeout:1500});if(kind==='credential'){await page.getByRole('button',{name:'Retry token status',exact:true}).waitFor();release();await page.getByRole('button',{name:'Retry token status',exact:true}).click();}else release();}
    await page.getByText('Your API token is saved securely on this server.',{exact:false}).waitFor();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check(kind+': retry recovers status without provider read or credential resubmission',f.calls()===before);
  });
  await scenario('refresh-refusal',async({f,page,before,login,refuse})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();refuse(true);await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();await page.getByText('Status unverified',{exact:true}).waitFor();
    check('refused refresh disables primary connection action',await page.getByRole('button',{name:'Connect repository',exact:true}).isDisabled());refuse(false);await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();await page.getByText('Read test passed. Connect repository to open the project. No need to enter your token again.',{exact:true}).waitFor();check('explicit metadata refresh restores eligibility without source read',f.calls()===before);
  });
  await scenario('interrupted-navigation',async({f,page,before,login,stall,release})=>{
    stall('/studio/v1/owner/connections');await page.goto(f.origin+'/#/settings');await login();await page.getByRole('heading',{name:'Connections',exact:true}).waitFor();await page.getByRole('link',{name:'Layers',exact:true}).click();release();await page.waitForURL('**/#/layers*');await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check('navigation cancels obsolete loaders and recovers cleanly without reads',f.calls()===before);
  });
  await scenario('sign-in-recovery',async({f,page,before,network,stall,release,login})=>{
    stall('/studio/session');await page.goto(f.origin+'/#/settings');await page.getByRole('button',{name:'Retry Studio',exact:true}).waitFor();
    check('unavailable session gives a bounded retry screen',await page.getByRole('heading',{name:'Studio is unavailable.',exact:true}).isVisible());release();await page.getByRole('button',{name:'Retry Studio',exact:true}).click();
    await page.getByLabel('Sign-in name',{exact:true}).fill('manager.owner');await page.getByLabel('Password',{exact:true}).fill('Synthetic wrong password');await page.getByRole('button',{name:'Sign in',exact:true}).evaluate(button=>{button.click();button.click();});
    await page.getByText('Studio sign-in was not accepted.',{exact:true}).waitFor();
    check('refused login clears password and restores submit once',await page.getByLabel('Password',{exact:true}).inputValue()===''&&await page.getByRole('button',{name:'Sign in',exact:true}).isEnabled()&&network.filter(n=>n.path==='/studio/owner/login').length===1);
    await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check('sign-in recovery needs no token resubmission or source read',f.calls()===before);
  });
  await scenario('token-confirmation-cancel',async({f,page,before,network,login})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByText('Your API token is saved securely on this server.',{exact:false}).waitFor();await page.getByText('Manage saved token',{exact:true}).click();
    const token=page.getByLabel('Artifacts API token',{exact:true});await token.fill('synthetic-unused-replacement');await page.getByRole('button',{name:'Replace stored token',exact:true}).evaluate(button=>{button.focus();button.click();button.click();});
    check('repeated replacement opens one confirmation',await page.getByRole('dialog').count()===1);await page.keyboard.press('Escape');
    check('Escape clears draft and returns keyboard focus without mutation',await token.inputValue()===''&&await page.getByRole('button',{name:'Replace stored token',exact:true}).evaluate(n=>document.activeElement===n)&&network.filter(n=>n.path==='/studio/v1/owner/credentials'&&n.method==='POST').length===0);
    await token.fill('synthetic-unused-replacement');await page.getByRole('button',{name:'Replace stored token',exact:true}).click();await page.evaluate(()=>location.hash='#/layers');await page.getByRole('dialog').waitFor({state:'detached'});
    check('navigation cancels the confirmation and clears detached secrets',f.calls()===before&&network.filter(n=>n.path==='/studio/v1/owner/credentials'&&n.method==='POST').length===0);
  });
  await scenario('fresh-password-loop',async({f,page,before,network,login})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();const originalNow=f.owner.now;f.owner.now=()=>originalNow()+300001;
    const remove=async()=>{const summary=page.getByText('Connection details and tools',{exact:true});if(!await summary.evaluate(n=>n.parentElement.open))await summary.click();await page.getByRole('button',{name:'Remove connection',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Remove connection',exact:true}).click();};
    await remove();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByText('Cancelled. No connection or approved grant was changed.',{exact:true}).waitFor();
    check('fresh-password cancellation preserves grant and source budget',f.calls()===before&&!(await f.state()).entries[0].desired_connection);
    await remove();await page.getByLabel('Current password',{exact:true}).fill('Synthetic wrong password');await page.getByRole('button',{name:'Confirm password',exact:true}).click();await page.getByRole('dialog').getByText('Studio sign-in was not accepted.',{exact:true}).waitFor();
    check('wrong confirmation clears password and restores retry',await page.getByLabel('Current password',{exact:true}).inputValue()===''&&await page.getByRole('button',{name:'Confirm password',exact:true}).isEnabled());
    await page.getByLabel('Current password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Confirm password',exact:true}).click();await page.getByText('Password confirmed. Choose the connection action again to continue.',{exact:true}).waitFor();
    check('password confirmation alone neither connects nor reads',f.calls()===before&&!(await f.state()).entries[0].desired_connection);await page.getByRole('button',{name:'Connect repository',exact:true}).click();await page.getByRole('button',{name:'Open project',exact:true}).waitFor();
    check('explicit action after reauthentication connects once',f.calls()===before+1&&network.filter(n=>n.path==='/studio/owner/reauth').length===2);
  });
  await scenario('expired-access',async({f,page,context,before,login})=>{
    f.advance(3600001);await context.addInitScript(()=>{const originalNow=Date.now;Date.now=()=>originalNow()+3600001;});await page.goto(f.origin+'/#/settings');await login();await page.getByText('Repository access expired. Your saved token is unchanged. Ask the owner for another approved read grant.',{exact:true}).waitFor();
    check('expired read access is clear with saved token intact',await page.getByRole('button',{name:'Connect repository',exact:true}).isDisabled()&&await page.getByText('Your API token is saved securely on this server.',{exact:false}).isVisible());
    check('expiry creates no replacement grant or read',(await f.state()).grants.length===1&&f.calls()===before);
  });
  await scenario('reauth-metadata-refusal',async({f,page,before,login,refuse,refuseAfterReauth})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();const originalNow=f.owner.now;f.owner.now=()=>originalNow()+300001;await page.getByText('Connection details and tools',{exact:true}).click();await page.getByRole('button',{name:'Remove connection',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Remove connection',exact:true}).click();await page.getByLabel('Current password',{exact:true}).fill(f.password);refuseAfterReauth();await page.getByRole('button',{name:'Confirm password',exact:true}).click();
    await page.getByText('Password confirmed, but connection status is unavailable. Refresh connection status before another action.',{exact:true}).waitFor();check('failed metadata after password confirmation gives a recoverable blocked state',await page.getByRole('button',{name:'Connect repository',exact:true}).isDisabled()&&f.calls()===before&&(await f.state()).entries.length===1);
    refuse(false);await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();await page.getByText('Read test passed. Connect repository to open the project. No need to enter your token again.',{exact:true}).waitFor();check('fresh-session metadata retry recovers without replaying removal',f.calls()===before&&(await f.state()).entries.length===1);
  });
  await scenario('token-removal-invalidates-view',async({f,page,before,login})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).click();await page.getByRole('button',{name:'Open project',exact:true}).waitFor();await page.getByText('Manage saved token',{exact:true}).click();await page.getByRole('button',{name:'Remove token',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Remove token',exact:true}).click();await page.locator('main').getByText('Stored token removed.',{exact:true}).waitFor();
    check('credential removal refuses cached connected presentation',await page.getByText('Status unverified',{exact:true}).isVisible()&&await page.getByRole('button',{name:'Open project',exact:true}).count()===0&&await page.getByRole('button',{name:'Connect repository',exact:true}).isDisabled());
    await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check('explicit refresh reveals token loss without a source read',f.calls()===before+1&&await page.getByText('Not saved',{exact:true}).count()===2);
  });
  await scenario('initial-token-change-race',async({f,page,before,owner,login,stallAfter,held,release})=>{
    const catalog=await f.state();const connected=await f.b.send('/studio/v1/owner/connections','POST',{action:'connect',connection_id:catalog.selected_connection_id,revision:catalog.revision,request_id:randomUUID()},owner.csrf);assert.equal(connected.status,200,connected.text);
    stallAfter('/studio/v1/owner/connections');await page.goto(f.origin+'/#/settings');await login();await page.getByText('Your API token is saved securely on this server.',{exact:false}).waitFor();check('initial race holds a measured connected reply',(await held()).connections[0].runtime_ready===true);
    await page.getByText('Manage saved token',{exact:true}).click();await page.getByRole('button',{name:'Remove token',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Remove token',exact:true}).click();await page.locator('main').getByText('Stored token removed.',{exact:true}).waitFor();release();await page.getByRole('button',{name:'Retry repository connection',exact:true}).waitFor();
    check('late initial reply cannot restore connected presentation',await page.getByRole('button',{name:'Open project',exact:true}).count()===0&&await page.getByText('Your repository is connected. Open the project to read its published records.',{exact:true}).count()===0);
    await page.getByRole('button',{name:'Retry repository connection',exact:true}).click();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check('explicit initial retry reveals removed token without new source read',f.calls()===before+1&&await page.getByText('Not saved',{exact:true}).count()===2);
  });
  await scenario('action-token-change-race',async({f,page,network,before,login,stallAfter,held,release})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();stallAfter('/studio/v1/owner/connections','POST');await page.getByRole('button',{name:'Connect repository',exact:true}).click();check('action race holds a completed measured connect reply',(await held()).connections[0].runtime_ready===true);
    await page.getByText('Manage saved token',{exact:true}).click();await page.getByRole('button',{name:'Remove token',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Remove token',exact:true}).click();await page.locator('main').getByText('Stored token removed.',{exact:true}).waitFor();release();await page.getByRole('button',{name:'Check saved action outcome',exact:true}).waitFor();
    check('stale action reply preserves reconciliation without connected UI',await page.getByRole('button',{name:'Open project',exact:true}).count()===0&&f.calls()===before+1);
    await page.getByRole('button',{name:'Check saved action outcome',exact:true}).click();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check('explicit outcome inspection does not replay completed connect',f.calls()===before+1&&network.filter(n=>n.body?.action==='connect').length===1&&await page.getByRole('button',{name:'Open project',exact:true}).count()===0);
  });
  await scenario('optional-agent',async({f,page,before,login})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check('optional agent tools stay collapsed',!await page.getByRole('button',{name:'Configure agent',exact:true}).isVisible());await page.getByText('Agent service (optional)',{exact:true}).click();await page.getByRole('button',{name:'Configure agent',exact:true}).waitFor();
    check('unconfigured agent explains exact unavailable gate',await page.getByRole('button',{name:'Configure agent',exact:true}).isDisabled()&&await page.getByRole('button',{name:'Connect agent discovery',exact:true}).isDisabled()&&f.calls()===before);
  });
  await scenario('connected-settings-entry',async({f,page,before,owner,network,login})=>{
    const catalog=await f.state();const result=await f.b.send('/studio/v1/owner/connections','POST',{action:'connect',connection_id:catalog.selected_connection_id,revision:catalog.revision,request_id:randomUUID()},owner.csrf);assert.equal(result.status,200,result.text);
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Open project',exact:true}).waitFor();check('direct Settings entry uses actual runtime readiness without automatic project reads',f.calls()===before+1&&network.filter(n=>n.path==='/explorer/v1/connection').length===0&&await page.locator('#header .source-badge').innerText()==='Check connection below');
  });
  await scenario('unverified-connected-card',async({f,page,before,login,refuse})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).click();await page.getByRole('button',{name:'Open project',exact:true}).waitFor();refuse(true);await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();await page.getByText('Status unverified',{exact:true}).waitFor();await page.getByText('Connection details and tools',{exact:true}).click();
    check('unverified card removes every current readable assertion',await page.getByText('Unverified',{exact:true}).count()===1&&await page.getByText('Published records are readable under this approved grant.',{exact:true}).count()===0&&await page.getByRole('button',{name:'Open project',exact:true}).count()===0);
    check('refused connected metadata refresh preserves spending without provider dispatch',f.calls()===before+1);
  });
  await scenario('approved-choice-focus',async({f,page,before,network,login})=>{
    await page.goto(f.origin+'/#/settings');await login();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();await page.getByText('Add an approved repository',{exact:true}).click();const profile=page.getByLabel('Approved repository',{exact:true});await profile.focus();await profile.selectOption(f.policy.profiles[0].profile_id);
    check('profile choice preserves expanded form and keyboard focus',await profile.isVisible()&&await profile.evaluate(n=>n===document.activeElement));const grant=page.getByLabel('Approved read grant',{exact:true});await grant.focus();await grant.selectOption(f.policy.tickets[2].ticket_id);
    check('grant choice preserves expanded form and focus without creation',await grant.isVisible()&&await grant.evaluate(n=>n===document.activeElement)&&f.calls()===before&&network.filter(n=>n.path==='/studio/v1/owner/connections'&&n.method==='POST').length===0);
  });
  check('no page errors or external requests',errors.length===0&&blocked.length===0);await writeFile(path.join(output,'result.json'),JSON.stringify({checks,failures,errors,blocked,scope:'Disposable synthetic owner/token/catalog; actual Edge; intercepted HTTPS'},null,2));process.stdout.write(JSON.stringify({passed:checks.length,failures:failures.length,output})+'\n');if(failures.length)process.exitCode=1;
}finally{await browser.close();}
