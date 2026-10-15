// Real browser/host/broker; synthetic Artifacts only. No external requests.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {namespaceFixture} from '../dist/tests/namespace-fixture.js';
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const f=await namespaceFixture(),output=process.env.STRATA_NAMESPACE_EVIDENCE;await mkdir(output,{recursive:true});await f.prepare();
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),checks=[],errors=[],blocked=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
await context.route('**/*',async route=>{
  const original=route.request(),url=new URL(original.url());if(url.origin!==f.base.origin){blocked.push(url.origin);return route.abort();}
  const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
  const response=await new Promise((resolve,reject)=>{const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(original.postDataBuffer());});
  await route.fulfill(response);
});
const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
const login=async()=>{await page.getByLabel('Sign-in name',{exact:true}).fill('workspace.owner');await page.getByLabel('Password',{exact:true}).fill(f.base.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();};
const picker=async()=>{await page.locator('#header .repository-switcher').click();await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor();};
const submit=()=>page.getByRole('button',{name:'Create Strata project',exact:true});
try{
  await page.goto(f.base.origin+'/#/blocks');await login();await picker();await page.getByText('New Strata repository',{exact:true}).click();
  await page.getByLabel('Repository name',{exact:true}).fill('eleanors repo 1');await page.getByLabel('Project purpose',{exact:true}).fill('A browser-created project');
  const before=f.calls.length;await submit().click();
  check('spaces receive helpful browser validation without a provider request',(await page.getByLabel('Repository name',{exact:true}).evaluate(n=>n.validationMessage)).includes('no spaces')&&f.calls.length===before);
  await page.screenshot({path:path.join(output,'create-name-validation.png'),fullPage:true});
  await page.getByLabel('Repository name',{exact:true}).fill('eleanors-repo-1');await submit().click();await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor({state:'hidden',timeout:90000});
  await page.getByText('Draft editing enabled',{exact:true}).waitFor();check('opaque provider tokens create and open a new Strata project',f.repos.get('eleanors-repo-1').git.pushes===1);
  await picker();await page.getByText('New Strata repository',{exact:true}).click();await page.getByLabel('Repository name',{exact:true}).fill('synthetic-partial');await page.getByLabel('Project purpose',{exact:true}).fill('test making new repo');
  f.setMode('lost-create');await submit().click();await page.getByRole('button',{name:'Check unfinished setup',exact:true}).waitFor();
  await page.getByRole('button',{name:'Check unfinished setup',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#menu-dialog button').disabled);
  check('an unfinished creation leaves other repositories available',await page.getByRole('button',{name:'Open eleanors-repo-1',exact:true}).isEnabled());
  f.setMode('ok');await page.getByRole('button',{name:'Close',exact:true}).click();await page.reload();await picker();
  await page.getByRole('button',{name:'Check unfinished setup',exact:true}).waitFor();
  check('unfinished setup survives reload',await page.getByRole('button',{name:'Check unfinished setup',exact:true}).count()===1);
  await page.getByRole('button',{name:'Check unfinished setup',exact:true}).click();await page.getByRole('heading',{name:'Finish synthetic-partial',exact:true}).waitFor();
  await page.getByLabel('Project purpose',{exact:true}).filter({visible:true}).first().fill('test making new repo');
  await page.getByRole('checkbox',{name:'Initialize this empty repository as a Strata project.',exact:true}).check();
  await page.screenshot({path:path.join(output,'finish-existing-repository.png'),fullPage:true});
  const creations=f.calls.filter(c=>c.endsWith('/repos')&&c.startsWith('POST ')).length;
  await page.getByRole('button',{name:'Finish creating synthetic-partial',exact:true}).click();await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor({state:'hidden',timeout:90000});
  await page.getByText('Draft editing enabled',{exact:true}).waitFor();
  check('finish uses the existing repository with one initial push and no duplicate create',f.repos.size===2&&f.repos.get('synthetic-partial').git.pushes===1&&f.calls.filter(c=>c.endsWith('/repos')&&c.startsWith('POST ')).length===creations);
  for(const name of ['Layers','Blocks']){await openStudioSection(page, name);await page.waitForFunction(()=>!document.querySelector('main').hasAttribute('aria-busy'));check('finished project stays selected in '+name,(await page.locator('#header .repository-switcher').innerText()).includes('synthetic-partial'));}
  await page.setViewportSize({width:390,height:844});await picker();check('mobile picker fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'created-repositories-mobile.png'),fullPage:true});
  check('no runtime errors or external traffic',errors.length===0&&blocked.length===0);
  const storage=await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,cookie:document.cookie}));check('provider secrets never enter browser persistence',!storage.includes('synthetic-namespace-api-secret')&&!storage.includes('art_v1_'));
  await writeFile(path.join(output,'creation-checks.json'),JSON.stringify({checks,errors,blocked},null,2));
}catch(e){await writeFile(path.join(output,'creation-failure.txt'),String(e)+'\n'+await page.locator('body').innerText());await page.screenshot({path:path.join(output,'creation-failure.png'),fullPage:true});throw e;}
finally{await browser.close();await f.server.close();}
