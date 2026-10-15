// Actual browser, real owner/actor HTTP and broker, synthetic provider Git packs.
// Browser traffic is intercepted to loopback; global external fetch is blocked.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {namespaceFixture} from '../dist/tests/namespace-fixture.js';
import {digest} from '../dist/src/model.js';
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const f=await namespaceFixture(),index=f.seedExisting(),output=process.env.STRATA_NAMESPACE_EVIDENCE??path.resolve('output/playwright/namespace');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),checks=[],errors=[],blocked=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
let loseRead=false;
const indexPath=path.join(f.base.root,'import-indexes.json');
await writeFile(indexPath,JSON.stringify({format:'strata-studio-import-catalog/1',indexes:[index]}),{mode:0o600});
f.config.import_catalog_file=indexPath;await f.restart();await f.prepare();
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
try{
  await page.goto(f.base.origin+'/#/blocks');await login();
  await page.getByText('No repository selected',{exact:true}).waitFor();check('unselected repository is not described as read only',!(await page.locator('#header').innerText()).includes('Read only'));
  await picker();await page.getByRole('button',{name:'Open existing-project',exact:true}).click();
  check('retained project opens without an upload or terminal',await page.getByLabel('Strata project index',{exact:true}).count()===0);
  check('import requires explicit owner consent',await page.getByRole('button',{name:'Import and open',exact:true}).isDisabled());
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Import and open',exact:true}).click();
  await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor({state:'hidden',timeout:90000});
  await page.getByText('Draft editing enabled',{exact:true}).waitFor();check('legacy project opens with real draft editing',f.repos.get('existing-project').git.pushes===0);
  await page.goto(f.base.origin+'/#/settings');await page.reload();await page.getByRole('heading',{name:'Connections',exact:true}).waitFor();
  for(const name of ['Blocks','Layers','Settings','Blocks']){
    await openStudioSection(page, name);
    await page.waitForFunction(()=>!document.querySelector('main').hasAttribute('aria-busy'));
    check('Settings entry retains selected repository on '+name,(await page.locator('#header .repository-switcher').innerText()).includes('existing-project')&&!(await page.locator('main').innerText()).includes('Choose a Strata repository.'));
  }
  await openStudioSection(page, 'Layers');await page.getByText('WorkspaceDraft@1',{exact:true}).first().waitFor();
  check('imported private draft remains visible',await page.getByText('WorkspaceDraft@1',{exact:true}).count()>0);
  await openStudioSection(page, 'Changes');await page.getByRole('button',{name:'New change',exact:true}).click();
  await page.getByLabel('New Layer ID',{exact:true}).fill('BrowserImportedDraft');await page.getByLabel('Intent',{exact:true}).fill('Change imported project');
  await page.getByLabel('Proposed purpose',{exact:true}).fill('A change in the existing project');await page.getByRole('button',{name:'Add item to draft',exact:true}).click();await page.getByRole('button',{name:'Review draft',exact:true}).click();
  await page.getByRole('button',{name:'Save owned draft',exact:true}).click();await page.getByText('Saved BrowserImportedDraft@1',{exact:true}).waitFor();
  check('browser saves a new draft in the existing repository',f.repos.get('existing-project').git.pushes===1);
  await page.screenshot({path:path.join(output,'imported-project-draft.png'),fullPage:true});
  const selected=(await f.server.store.snapshot()).projects[0],controlPath=path.join(f.config.projects_directory,digest({repository_id:selected.id,import_id:selected.creation_id}),'control','workspace.json');
  const control=JSON.parse(await readFile(controlPath,'utf8')),detail={reason:'token-issue-not-confirmed',cleanup:'unconfirmed'};
  control.operations.push({operation_id:digest('synthetic unresolved write check'),phase:'cleanup_unconfirmed',detail,events:[{phase:'prepared',detail:{reason:'write-permission-test'}},{phase:'token_issue_unknown',detail:{reason:'write-permission-test'}},{phase:'cleanup_unconfirmed',detail}]});
  await writeFile(controlPath,JSON.stringify(control),{mode:0o600});const calls=f.calls.length;
  await f.restart();await page.goto(f.base.origin+'/#/settings');await page.reload();await login();await page.getByText('Draft saving paused',{exact:true}).waitFor();
  for(const name of ['Blocks','Layers','Changes','Settings','Blocks']){
    await openStudioSection(page, name);await page.waitForFunction(()=>!document.querySelector('main').hasAttribute('aria-busy'));
    check('pending write check still permits '+name,(await page.locator('#header .repository-switcher').innerText()).includes('existing-project')&&!(await page.locator('main').innerText()).includes('Choose a Strata repository.'));
  }
  check('navigation never repeats provider write checks',f.calls.length===calls);
  check('import selection survives restart with pending check',(await f.server.store.snapshot()).selected_repository_id===index.repository_id);
  await page.setViewportSize({width:390,height:844});await picker();check('mobile import picker fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'imported-project-mobile.png'),fullPage:true});
  const storage=await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,cookie:document.cookie}));check('secrets never enter browser storage',!storage.includes('synthetic-namespace-api-secret')&&!storage.includes('art_v1_'));
  check('no runtime errors or external requests',errors.length===0&&blocked.length===0);
  await writeFile(path.join(output,'import-browser-checks.json'),JSON.stringify({checks,errors,blocked},null,2));
}catch(e){await writeFile(path.join(output,'import-failure.txt'),String(e)+'\n'+await page.locator('body').innerText());await page.screenshot({path:path.join(output,'import-failure.png'),fullPage:true});throw e;}
finally{await browser.close();await f.server.close();}
