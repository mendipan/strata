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
  await page.goto(f.base.origin+'/#/blocks');await login();await picker();await page.getByRole('button',{name:'Open existing-project',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Import and open',exact:true}).click();
  await page.getByRole('dialog',{name:'Repository switcher',exact:true}).waitFor({state:'hidden',timeout:90000});await page.getByText('Draft editing enabled',{exact:true}).waitFor();
  const draft=async id=>{await openStudioSection(page, 'Changes');await page.getByRole('button',{name:'New change',exact:true}).click();await page.getByLabel('New Layer ID',{exact:true}).fill(id);await page.getByLabel('Intent',{exact:true}).fill('Save a draft after restoring writing access');await page.getByLabel('Proposed purpose',{exact:true}).fill('A browser-saved purpose');await page.getByRole('button',{name:'Add item to draft',exact:true}).click();await page.getByRole('button',{name:'Review draft',exact:true}).click();};
  await draft('InterruptedBrowserDraft');f.setMode('lost-token');
  const [failed]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/studio/v1/operation')&&r.request().method()==='POST'),page.getByRole('button',{name:'Save owned draft',exact:true}).click()]);check('failed permission check does not push a draft',failed.status()===503&&f.repos.get('existing-project').git.pushes===0);
  f.setMode('active-recovery-token');await page.reload();await page.getByText('Draft saving paused',{exact:true}).waitFor();await page.getByRole('button',{name:'Resume draft saving',exact:true}).click();await page.getByText(/A repository token is still active\./).waitFor();
  check('active token has a clear retry path',await page.getByRole('button',{name:'Resume draft saving',exact:true}).isEnabled());
  await page.screenshot({path:path.join(output,'recovery-wait.png'),fullPage:true});
  f.setMode('ok');await page.getByRole('button',{name:'Resume draft saving',exact:true}).click();await page.getByText('Draft editing enabled',{exact:true}).waitFor();
  check('browser recovery enables drafts without pushing or creating records',f.repos.get('existing-project').git.pushes===0);
  // Restored access does not erase the original unconfirmed browser request.
  // Inspect its receipt and actual history before explicitly clearing the notice.
  await openStudioSection(page, 'Review');await page.getByRole('button',{name:'Check original request receipt',exact:true}).click();await page.getByText('Original request receipt: not_found.',{exact:true}).waitFor();
  check('writer recovery retains the original request until outcome inspection',await page.getByRole('button',{name:'Clear inspected browser notice',exact:true}).isDisabled());
  await openStudioSection(page, 'Layers');await page.getByRole('link',{name:'WorkspaceDraft@1',exact:true}).waitFor();
  check('inspected history confirms the failed draft was never stored',await page.getByRole('link',{name:'InterruptedBrowserDraft@1',exact:true}).count()===0&&f.repos.get('existing-project').git.pushes===0);
  await openStudioSection(page, 'Review');await page.getByRole('button',{name:'Check original request receipt',exact:true}).click();await page.getByText('Original request receipt: not_found.',{exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'I have checked the original project history and choose to clear only this browser recovery notice.',exact:true}).check();await page.getByRole('button',{name:'Clear inspected browser notice',exact:true}).click();
  check('explicit browser notice clearance never repeats the failed save',f.repos.get('existing-project').git.pushes===0);
  await draft('RecoveredBrowserDraft');await page.getByRole('button',{name:'Save owned draft',exact:true}).click();await page.getByText('Saved RecoveredBrowserDraft@1',{exact:true}).waitFor();check('resumed browser saves an owned draft',f.repos.get('existing-project').git.pushes===1);
  await page.screenshot({path:path.join(output,'recovered-draft-saved.png'),fullPage:true});
  await page.reload();await openStudioSection(page, 'Layers');await page.getByText('WorkspaceDraft@1',{exact:true}).first().waitFor();await page.getByText('RecoveredBrowserDraft@1',{exact:true}).first().waitFor();
  check('historical and newly saved drafts survive reload',await page.getByText('Draft editing enabled',{exact:true}).count()===1);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'recovered-layers-mobile.png'),fullPage:true});check('mobile view fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const storage=await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,cookie:document.cookie}));check('no provider secrets in browser persistence',!storage.includes('synthetic-namespace-api-secret')&&!storage.includes('opaque_Z8_'));
  check('no runtime errors or external browser traffic',errors.length===0&&blocked.length===0);await writeFile(path.join(output,'draft-recovery-checks.json'),JSON.stringify({checks,errors,blocked},null,2));
}catch(e){await writeFile(path.join(output,'recovery-failure.txt'),String(e)+'\n'+await page.locator('body').innerText());await page.screenshot({path:path.join(output,'recovery-failure.png'),fullPage:true});throw e;}
finally{await browser.close();await f.server.close();}
