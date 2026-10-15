// Actual Edge, intercepted synthetic HTTPS, real owner/actor and Node broker.
// No live host, secret, grant or Artifacts request is used.
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspaceHostFixture} from '../dist/tests/workspace-host-fixture.js';
const development=process.env.STRATA_TEST_PROVIDER_CONTRACT==='development';
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href),f=await workspaceHostFixture(development),output=path.resolve('output/playwright/workspace'+(development?'-development':''));await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),checks=[],errors=[],blocked=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);process.stdout.write('PASS '+name+'\n');};let lostControl=false,sourcePosts=0,page;
await context.route('**/*',async route=>{
 const original=route.request(),url=new URL(original.url());if(url.origin!==f.origin){blocked.push(url.origin);return route.abort();}
 const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
 const response=await new Promise((resolve,reject)=>{const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(original.postDataBuffer());});
 if(url.pathname==='/studio/v1/owner/connections'&&original.method()==='POST'){sourcePosts++;if(lostControl){lostControl=false;return route.abort();}}
 await route.fulfill(response);
});
try{
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(f.origin+'/#/settings');
 await page.getByLabel('Sign-in name',{exact:true}).fill('workspace.owner');await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'Repository workspace',exact:true}).waitFor();await page.getByRole('heading',{name:'Server credentials',exact:true}).waitFor();
 check('owner Settings starts no provider work',f.counts().mints===0&&f.counts().pushes===0);
 check('workspace grant and model limits are honest',(await page.locator('main').innerText()).includes('Authenticated Release and hosted application Git are unavailable.'));
 if(development)check('development contract is truthful and keeps the no-replacement rule visible',(await page.locator('main').innerText()).includes('Do not delete, recreate or rebind it during writes or unresolved operations. Immutable token binding is not verified.'));
 check('no author auto exchange',(await f.b.send('/studio/actor/session')).data.authenticated===false);
 check('Connect waits for saved token',await page.getByRole('button',{name:'Connect repository',exact:true}).isDisabled());
 const tokenSummary=page.getByText('Save API token',{exact:true});if(!await tokenSummary.evaluate(n=>n.parentElement.open))await tokenSummary.click();await page.getByLabel('Artifacts API token',{exact:true}).fill('synthetic-workspace-browser-token');await page.getByRole('button',{name:'Save token',exact:true}).click();
 await page.locator('main').getByText('Token saved on this server. Connect your repository above.',{exact:true}).waitFor();check('save clears draft',await page.getByLabel('Artifacts API token',{exact:true}).inputValue()==='');
 await page.getByText('Connection tools',{exact:true}).click();await page.getByRole('button',{name:'Refresh status',exact:true}).click();
 await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor({state:'visible'});await page.getByRole('button',{name:'Connect repository',exact:true}).click();await page.getByRole('button',{name:'Use authoring access',exact:true}).waitFor();
 check('Connect makes no provider change',f.counts().mints===0&&f.counts().pushes===0);await page.getByRole('button',{name:'Use authoring access',exact:true}).click();await page.getByRole('button',{name:'Open project',exact:true}).waitFor();
 check('explicit author exchange makes no provider change',f.counts().mints===0&&f.counts().pushes===0);
 const cookies=await context.cookies(f.origin);check('separate protected actor cookie',cookies.some(c=>c.name==='__Host-strata_actor'&&c.httpOnly&&c.secure&&c.sameSite==='Strict'));
 const tools=page.getByText('Connection tools',{exact:true});if(!await tools.evaluate(n=>n.parentElement.open))await tools.click();await page.getByRole('button',{name:'Test write access',exact:true}).click();
 await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();check('test cancellation makes no provider change',f.counts().mints===0);
 const toolsAgain=page.getByText('Connection tools',{exact:true});if(!await toolsAgain.evaluate(n=>n.parentElement.open))await toolsAgain.click();await page.getByRole('button',{name:'Test write access',exact:true}).click();await page.getByLabel('Current password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Confirm password',exact:true}).click();
 await page.getByText('Write-token issue and cleanup verified. No repository content was published.',{exact:true}).waitFor();check('explicit permission check issues and cleans exactly once with no payload',f.counts().mints===1&&f.counts().revokes===1&&f.counts().pushes===0);
 await page.getByRole('button',{name:'Use authoring access',exact:true}).click();await page.getByRole('button',{name:'Open project',exact:true}).click();await page.getByRole('heading',{name:'Choose a Release to explore.',exact:true}).waitFor();
 await page.getByLabel('Choose exact Release',{exact:true}).first().selectOption('CounterBaseline@1');await page.getByRole('heading',{name:'Application map',exact:true}).waitFor();
 check('actual saved project opens without provider read',f.counts().pushes===0&&f.counts().mints===1);
 await page.getByRole('link',{name:'Changes',exact:true}).click();await page.getByRole('button',{name:'New change',exact:true}).waitFor();check('ordinary draft authoring is enabled',await page.getByRole('button',{name:'New change',exact:true}).isEnabled());
 await page.getByRole('button',{name:'New change',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();check('draft cancel sends no immutable push',f.counts().pushes===0);
 await page.getByRole('button',{name:'New change',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.getByLabel('New Layer ID',{exact:true}).fill('BrowserWorkspaceDraft');await page.getByLabel('Intent',{exact:true}).fill('Verify the actual browser to Studio to broker draft path');
 await page.getByLabel('Proposed purpose',{exact:true}).fill('A browser-authored purpose proposed for review');await page.getByRole('button',{name:'Add item to draft',exact:true}).click();await page.getByRole('button',{name:'Review draft',exact:true}).click();
 await page.getByRole('button',{name:'Save owned draft',exact:true}).click();await page.getByText('Saved BrowserWorkspaceDraft@1',{exact:true}).waitFor();
 check('actual proposal save dispatches one immutable push with owned token cleanup',f.counts().pushes===1&&f.counts().mints===2&&f.counts().revokes===2);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.reload();await page.getByRole('link',{name:'Inspect proposal and actions',exact:true}).waitFor();
 check('saved browser proposal survives refresh and reads back without another push',(await page.locator('main').innerText()).includes('BrowserWorkspaceDraft@1')&&f.counts().pushes===1);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('heading',{name:'Repository workspace',exact:true}).waitFor();
 await page.setViewportSize({width:375,height:812});check('mobile workspace fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'workspace-mobile.png'),fullPage:true});
 const more=page.getByText('Connection tools',{exact:true});if(!await more.evaluate(n=>n.parentElement.open))await more.click();const postsBefore=sourcePosts;lostControl=true;await page.getByRole('button',{name:'Pause connection',exact:true}).click();await page.getByRole('button',{name:'Check saved control outcome',exact:true}).waitFor();check('response loss makes no automatic control retry',sourcePosts===postsBefore+1);
 await page.getByRole('button',{name:'Check saved control outcome',exact:true}).click();await page.getByRole('button',{name:'Connect repository',exact:true}).waitFor();check('exact control replay pauses with no provider activity',f.counts().mints===2&&f.counts().pushes===1);
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,'workspace-desktop.png'),fullPage:true});
 const storage=await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,cookie:document.cookie,url:location.href}));check('secrets absent from URL/browser persistence',[f.password,'synthetic-workspace-browser-token'].every(s=>!storage.includes(s)));
 check('no browser errors or external requests',errors.length===0&&blocked.length===0);
 await writeFile(path.join(output,'checks.json'),JSON.stringify({passed:checks.length,checks,errors,blocked,scope:'Actual Edge on disposable HTTPS-intercepted owner/actor/workspace with injected provider'},null,2));process.stdout.write(JSON.stringify({passed:checks.length,output})+'\n');
}catch(e){await page?.screenshot({path:path.join(output,'failed.png'),fullPage:true});await writeFile(path.join(output,'failed.txt'),await page.locator('main').innerText());throw e;}
finally{await context.close();await browser.close();await f.server.close();}
