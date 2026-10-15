// Synthetic HTTPS-origin interception; tests the real named actor service, not live TLS.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runAuthorStudio} from '../dist/scripts/studio-author.js';
import {BLOCK_MODEL} from '../dist/src/model.js';

const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const root=await mkdtemp(path.join(os.tmpdir(),'strata-actor-browser-'));
const origin='https://studio.example.test',key=randomBytes(32).toString('base64url');
const operations=['init','layer.create','layer.revise','layer.publish','content.review','compose'];
const reads=['capabilities','review.inbox','review.state','layer.preview','studio.snapshot','operation.inspect','inspect','status','diff','conflicts'];
const accounts={format:'strata-host-accounts/1',generation:1,accounts:[{account_id:'author-a',principal_id:'author-a',principal_kind:'person',active:true,credential_epoch:1,key_sha256:createHash('sha256').update(key).digest('hex')}]};
const policy={format:'strata-host-policy/1',project_id:'synthetic-browser',generation:1,grants:[{grant_id:'author-a',principal_id:'author-a',operations:[...reads,...operations],layer_ids:null,write_block_ids:['app'],create_under_block_ids:['app'],approvals:[],profiles:[],expires_at:new Date(Date.now()+3600000).toISOString()}]};
const config={format:'strata-studio-author-host/1',project_id:policy.project_id,project_directory:root,state_directory:path.join(root,'state'),accounts_file:path.join(root,'accounts.json'),policy_file:path.join(root,'policy.json'),public_origin:origin,trusted_proxy_addresses:['127.0.0.1'],port:0,operations,output_slots:{},runner_profiles:[]};
for(const [name,value] of [['accounts',accounts],['policy',policy],['host',config]])await writeFile(path.join(root,name+'.json'),JSON.stringify(value),{mode:0o600});
const host=await runAuthorStudio(path.join(root,'host.json'),path.resolve('explorer'));
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[],errors=[],external=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
let context;
try{
  context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.route('**/*',async route=>{
    const original=route.request(),url=new URL(original.url());
    if(url.origin!==origin){external.push(url.origin);return route.abort();}
    const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
    const response=await new Promise((resolve,reject)=>{
      const req=request(host.origin+url.pathname+url.search,{method:original.method(),headers},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));
      });req.on('error',reject);req.end(original.postDataBuffer());
    });await route.fulfill(response);
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const loaded=async()=>page.locator('main[aria-busy]').waitFor({state:'detached'});
  const section=async name=>{await openStudioSection(page, name);await loaded();};
  const reload=async()=>{await page.getByRole('button',{name:'Reload saved view',exact:true}).click();await loaded();};
  await page.goto(origin);await page.getByRole('heading',{name:'Sign in to Strata Studio.'}).waitFor();
  check('named account keyboard focus',await page.getByLabel('Provisioned account').evaluate(n=>n===document.activeElement));
  await page.getByLabel('Provisioned account').fill('author-a');await page.getByLabel('Studio access key').fill(key);await page.getByLabel('Studio access key').press('Enter');
  await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();await loaded();
  const cookies=await context.cookies(origin);check('named actor has a distinct secure cookie',cookies.length===1&&cookies[0].name==='__Host-strata_actor'&&cookies[0].secure&&cookies[0].httpOnly&&cookies[0].sameSite==='Strict');
  await section('Changes');await page.getByLabel('Root purpose',{exact:true}).fill('Maintain a synthetic library.');await page.getByLabel('Responsible scope principal').fill('author-a');await page.getByLabel('Release authority principal').fill('author-a');
  await page.getByRole('button',{name:'Create baseline',exact:true}).click();await page.getByText('Saved R-start@1',{exact:true}).waitFor();await reload();
  await page.getByText('Add a Block through an owned Layer',{exact:true}).click();
  const create=page.locator('details').filter({has:page.getByText('Add a Block through an owned Layer',{exact:true})});
  await create.getByLabel('New Layer ID',{exact:true}).fill('L-catalog');await create.getByLabel('New Block ID',{exact:true}).fill('catalog');await create.getByLabel('New Block purpose',{exact:true}).fill('Catalog the synthetic books.');await create.getByLabel('Why add this Block?',{exact:true}).fill('Track the catalog as explicit intent.');
  await create.getByRole('button',{name:'Save new Block proposal'}).dblclick();await page.getByText('Saved L-catalog@1',{exact:true}).waitFor();await reload();
  await page.getByRole('link',{name:'Inspect proposal and actions',exact:true}).click();await loaded();await page.getByRole('heading',{name:'Proposed intent',exact:true}).waitFor();
  check('created Block is readable as a proposal',(await page.locator('main').innerText()).includes('Catalog the synthetic books.'));
  await page.getByLabel('Authoring review rationale',{exact:true}).fill('Reviewed the exact synthetic catalog proposal.');await page.getByRole('button',{name:'Record exact authoring review',exact:true}).click();
  const result=page.locator('.command-result');await result.getByText(/^Saved /).waitFor();const reviewRef=(await result.getByText(/^Saved /).innerText()).slice(6);
  await page.getByLabel('Exact authoring review reference',{exact:true}).fill(reviewRef);await page.getByRole('button',{name:'Publish proposal',exact:true}).click();await page.getByText('Saved L-catalog@1',{exact:true}).waitFor();
  await section('Changes');await page.getByLabel('Composition ID',{exact:true}).fill('C-catalog');await page.getByRole('button',{name:'Compose selection',exact:true}).click();await page.getByText('Saved C-catalog@1',{exact:true}).waitFor();await reload();
  await section('Review');await page.getByRole('link',{name:'C-catalog@1',exact:true}).click();await loaded();await page.getByRole('heading',{name:'Candidate intent',exact:true}).waitFor();
  check('candidate exposes actual new Block',(await page.locator('main').innerText()).includes('Catalog the synthetic books.'));
  check('unsupported generic realization remains blocked',(await page.locator('main').innerText()).includes('profile'));
  check('unconfigured materialization disabled',await page.getByRole('button',{name:'Materialize exact candidate',exact:true}).isDisabled());
  await page.screenshot({path:path.join(root,'review-desktop.png'),fullPage:true});
  await page.setViewportSize({width:375,height:812});check('named candidate fits mobile',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(root,'review-mobile.png'),fullPage:true});
  const ledger=await readFile(path.join(root,'state/audit.jsonl'),'utf8');check('repeated click creates one Layer revision',(ledger.match(/"action":"layer.create"/g)||[]).length===1);
  check('no key in persisted browser state',!(await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage,url:location.href}))).includes(key));
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('heading',{name:'Sign in to Strata Studio.'}).waitFor();check('logout clears named actor cookie',(await context.cookies(origin)).length===0);
  check('no browser errors or external access',errors.length===0&&external.length===0);
  console.log(JSON.stringify({passed:checks.length,checks,output:root}));
}catch(error){const page=context?.pages()[0];if(page){await page.screenshot({path:path.join(root,'failure.png'),fullPage:true});console.error(await page.locator('main').innerText());}throw error;}finally{await context?.close();await browser.close();await host.close();}
