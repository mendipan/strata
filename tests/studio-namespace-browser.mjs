// Actual browser, real owner/actor HTTP and broker, synthetic provider Git packs.
// Browser traffic is intercepted to loopback; global external fetch is blocked.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {namespaceFixture} from '../dist/tests/namespace-fixture.js';
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const f=await namespaceFixture(),output=process.env.STRATA_NAMESPACE_EVIDENCE??path.resolve('output/playwright/namespace');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),checks=[],errors=[],blocked=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
let loseRead=false;
await context.route('**/*',async route=>{
  const original=route.request(),url=new URL(original.url());if(url.origin!==f.base.origin){blocked.push(url.origin);return route.abort();}
  const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
  const response=await new Promise((resolve,reject)=>{const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(original.postDataBuffer());});
  if(loseRead&&url.pathname==='/studio/v1/owner/connections'&&original.method()==='POST'&&JSON.parse(original.postData()).action==='discover'){loseRead=false;return route.abort();}
  await route.fulfill(response);
});
const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
const login=async()=>{await page.getByLabel('Sign-in name',{exact:true}).fill('workspace.owner');await page.getByLabel('Password',{exact:true}).fill(f.base.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();};
const picker=async()=>{await page.locator('#header .repository-switcher').click();await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor();};
const create=async(name,purpose)=>{await picker();await page.getByText('New Strata repository',{exact:true}).click();await page.getByLabel('Repository name',{exact:true}).fill(name);await page.getByLabel('Project purpose',{exact:true}).fill(purpose);await page.getByRole('button',{name:'Create Strata project',exact:true}).click();await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor({state:'hidden',timeout:90000});await page.getByRole('heading',{name:'Application map',exact:true}).waitFor();};
try{
  await page.goto(f.base.origin+'/#/settings');await login();await page.getByRole('heading',{name:'Artifacts namespace',exact:true}).waitFor();
  check('identity and meaningful Settings screen',await page.title()==='Strata Studio'&&page.url().startsWith(f.base.origin));
  check('metadata performs no provider requests',f.calls.length===0);
  check('no unusable token test or Connect before token save',await page.getByRole('button',{name:'Test saved token',exact:true}).count()===0&&await page.getByRole('button',{name:'Connect',exact:true}).count()===0);
  const tokenSummary=page.getByText('Save API token',{exact:true});if(!await tokenSummary.evaluate(n=>n.parentElement.open))await tokenSummary.click();
  await page.getByLabel('Artifacts API token',{exact:true}).fill('synthetic-namespace-api-secret');await page.getByRole('button',{name:'Save token',exact:true}).click();
  await page.getByRole('button',{name:'Connect',exact:true}).waitFor();
  check('consent required and save does not probe',await page.getByRole('button',{name:'Connect',exact:true}).isDisabled()&&f.calls.length===0);
  check('saved token field is cleared',await page.getByLabel('Artifacts API token',{exact:true}).inputValue()==='');
  await page.getByRole('checkbox',{name:'Allow access to this namespace until I revoke it.',exact:true}).check();
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.locator('main').getByText('Connected to development.',{exact:false}).waitFor();
  check('Connect approves then discovers without provider mutations',f.calls.length===1&&f.calls[0].startsWith('GET ')&&f.repos.size===0);
  for(const mode of ['denied','rate-limited']){
    f.setMode(mode);const before=f.calls.length;
    await page.getByRole('button',{name:mode==='denied'?'Refresh repositories':'Connect with saved token',exact:true}).click();
    await page.getByRole('button',{name:'Connect with saved token',exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('main').textContent.includes('Connecting…'));
    check(mode+': actionable failure and direct retry',await page.getByRole('button',{name:'Connect with saved token',exact:true}).isEnabled()&&f.calls.length===before+1);
    check(mode+': no provider error body leak',!(await page.locator('body').innerText()).includes('synthetic-namespace-api-secret'));
  }
  f.setMode('normal');loseRead=true;const beforeLost=f.calls.length;
  await page.getByRole('button',{name:'Connect with saved token',exact:true}).click();
  await page.getByRole('button',{name:'Connect with saved token',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('main').textContent.includes('Connecting…'));
  await page.reload();await page.getByRole('heading',{name:'Artifacts namespace',exact:true}).waitFor();
  check('lost response and reload never redispatch',f.calls.length===beforeLost+1);
  await page.getByRole('button',{name:'Connect with saved token',exact:true}).click();await page.locator('main').getByText('Connected to development.',{exact:false}).waitFor();
  await page.locator('main h1').focus();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,'settings-connected-desktop.png'),fullPage:true});
  const beforeChooser=f.calls.length;await page.getByRole('button',{name:'Choose repository',exact:true}).click();await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor();
  check('Settings chooser reuses connected repository results',f.calls.length===beforeChooser&&await page.getByRole('button',{name:'Refresh repositories',exact:true}).isEnabled());await page.keyboard.press('Escape');
  await create('browser-first','The first browser project');check('real creation persists initial intent',f.repos.get('browser-first').git.pushes===1);
  await openStudioSection(page, 'Changes');await page.getByRole('button',{name:'New change',exact:true}).click();
  await page.getByRole('dialog').getByLabel('New Layer ID',{exact:true}).fill('BrowserDraft');await page.getByRole('dialog').getByLabel('Intent',{exact:true}).fill('Persist a purpose change in the first repository');
  await page.getByLabel('Proposed purpose',{exact:true}).fill('A saved purpose for independent review');await page.getByRole('button',{name:'Add item to draft',exact:true}).click();await page.getByRole('button',{name:'Review draft',exact:true}).click();
  await page.getByRole('button',{name:'Save owned draft',exact:true}).click();await page.getByText('Saved BrowserDraft@1',{exact:true}).waitFor();
  check('draft save uses provider Git and survives read-back',f.repos.get('browser-first').git.pushes===2);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await create('browser-second','A separate second project');await openStudioSection(page, 'Changes');
  await page.getByRole('button',{name:'New change',exact:true}).waitFor();check('second repository does not display first private draft',!(await page.locator('main').innerText()).includes('BrowserDraft'));
  await picker();await page.getByRole('button',{name:'Refresh repositories',exact:true}).click();await page.getByText('Repository list updated.',{exact:true}).waitFor();
  check('switcher has no placeholder text artifacts',!(await page.getByRole('dialog',{name:'Repository switcher',exact:true}).innerText()).includes('null'));
  await page.screenshot({path:path.join(output,'repository-switcher-desktop.png'),fullPage:true});check('switcher lists two provider repositories',(await page.locator('.repository-list article').count())===2);
  await page.getByRole('button',{name:'Open browser-first',exact:true}).click();await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor({state:'hidden'});
  await openStudioSection(page, 'Changes');await page.getByRole('link',{name:'Inspect proposal and actions',exact:true}).waitFor();check('switching back restores saved draft',(await page.locator('main').innerText()).includes('BrowserDraft@1'));
  await f.restart();await page.reload();await login();await page.getByRole('link',{name:'Inspect proposal and actions',exact:true}).waitFor();check('restart and finite re-login preserve namespace and draft',(await page.locator('main').innerText()).includes('BrowserDraft@1'));
  await page.getByRole('link',{name:'Inspect proposal and actions',exact:true}).click();await page.getByRole('heading',{name:'Proposed intent',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'saved-draft-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await picker();check('mobile switcher has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'repository-switcher-mobile.png'),fullPage:true});await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor({state:'hidden'});check('keyboard Escape closes switcher',!(await page.locator('#menu-dialog').evaluate(n=>n.open)));
  await page.evaluate(()=>{location.hash='#/changes?repo=another-repository&at=ProjectBaseline%401';});await page.getByRole('heading',{name:'Choose a Strata repository.',exact:true}).waitFor();check('foreign-repository hash links never reuse the current project view',!(await page.locator('main').innerText()).includes('BrowserDraft'));
  const storage=await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,cookie:document.cookie,url:location.href}));check('provider secrets absent from browser persistence',!storage.includes('synthetic-namespace-api-secret')&&!storage.includes('art_v1_'));
  check('no page runtime errors or external browser requests',errors.length===0&&blocked.length===0);
  await writeFile(path.join(output,'browser-checks.json'),JSON.stringify({checks,errors,blocked,viewports:['1440x1000','390x844'],scope:'Real browser and application; synthetic provider only.'},null,2));
}catch(e){await writeFile(path.join(output,'failure.txt'),String(e)+'\n'+await page.locator('body').innerText());await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw e;}
finally{await browser.close();await f.server.close();}
