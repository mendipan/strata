// Synthetic HTTPS-origin interception tests UI behavior, not live TLS/provider access.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startExplorer } from '../dist/src/explorer/host.js';
import { ExplorerReader } from '../dist/src/explorer/read.js';
import { TestSource, sample } from '../dist/tests/explorer-fixture.js';

const { chromium } = await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const output = await mkdtemp(path.join(tmpdir(), 'strata-studio-browser-'));
const publicOrigin = 'https://studio.example.test';
const accessKey = Buffer.from(randomBytes(32)).toString('base64url');
const source = new TestSource(await sample()), reader = new ExplorerReader(source);
const host = await startExplorer(reader, {assets:path.resolve('explorer'),hosted:{publicOrigin,trustedProxyAddresses:['127.0.0.1'],accessKeySha256:createHash('sha256').update(accessKey).digest('hex')}});
const emptyHost = await startExplorer(new ExplorerReader(new TestSource(await sample())), {assets:path.resolve('explorer'),hosted:{publicOrigin,trustedProxyAddresses:['127.0.0.1']}});
const browser = await chromium.launch({channel:'msedge',headless:true});
const checks=[], errors=[], blocked=[];
let context;
try {
  context=await browser.newContext({viewport:{width:1440,height:1000}});
  let target=host.origin;
  await context.route('**/*', async route => {
    const original=route.request(), url=new URL(original.url());
    if(url.origin !== publicOrigin){blocked.push(url.origin);return route.abort();}
    const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
    const response=await new Promise((resolve,reject)=>{
      const req=request(target+url.pathname+url.search,{method:original.method(),headers},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));
      });req.on('error',reject);req.end(original.postDataBuffer());
    });await route.fulfill(response);
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const check=(name,value)=>{assert.ok(value,name);checks.push({name,passed:true});};
  await page.goto(publicOrigin+'/');await page.getByRole('heading',{name:'Sign in to Strata Studio.'}).waitFor();
  check('unauthenticated UI has no source read',source.calls===0);
  check('keyboard sign-in input focused',await page.locator('#studio-access-key').evaluate(node=>document.activeElement===node));
  await page.getByLabel('Studio access key').fill('x'.repeat(43));await page.getByLabel('Studio access key').press('Enter');
  await page.getByText('Studio sign-in was not accepted.').waitFor();
  check('failed key cleared',await page.getByLabel('Studio access key').inputValue()==='');
  await page.getByLabel('Studio access key').fill(accessKey);await page.getByLabel('Studio access key').press('Enter');
  await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
  check('sign-in starts no provider read',source.calls===0);
  check('hosted title',await page.title()==='Strata Studio');
  const cookies=await context.cookies(publicOrigin);check('secure host-only HttpOnly strict cookie',cookies.length===1 && cookies[0].name==='__Host-strata_studio' && cookies[0].secure && cookies[0].httpOnly && cookies[0].sameSite==='Strict');
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('heading',{name:'Connections',exact:true}).waitFor();
  await page.locator('#artifacts-credential').waitFor({state:'attached'});await page.locator('#credential-manager-key').waitFor({state:'attached'});
  check('unconfigured credentials cannot accept values',await page.locator('#artifacts-credential:disabled,#credential-manager-key:disabled').count()===2);
  await page.getByRole('button',{name:'Test read connection',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('main').textContent.includes('passed'));
  check('explicit test performs verified read',source.calls===1);
  const storage=await page.evaluate(()=>({local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage),cookie:document.cookie,url:location.href}));
  check('no key/session cookie in JS storage or URL',!JSON.stringify(storage).includes(accessKey) && !JSON.stringify(storage).includes(cookies[0].value) && storage.cookie==='');
  await page.screenshot({path:path.join(output,'settings-desktop.png'),fullPage:true});
  await page.setViewportSize({width:375,height:812});check('mobile layout fits viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'settings-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('heading',{name:'Sign in to Strata Studio.'}).waitFor();
  check('logout removes cookie',(await context.cookies(publicOrigin)).length===0);
  target=emptyHost.origin;await page.reload();await page.getByRole('heading',{name:'Studio setup required.'}).waitFor();
  check('unconfigured screen has no secret entry',await page.locator('input').count()===0);
  await page.screenshot({path:path.join(output,'unconfigured-mobile.png'),fullPage:true});
  check('no page errors or external requests',errors.length===0 && blocked.length===0);
  await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors,blocked,scope:'Synthetic HTTPS origin; no live certificate/provider/credentials tested'},null,2));
  console.log(JSON.stringify({output,checks:checks.length,errors}));
}finally{await context?.close();await browser.close();await host.close();await emptyHost.close();}
