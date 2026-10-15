// Real owner/actor HTTP, broker and browser. Provider/faults are synthetic only.
// The ingress harness consumes example limits; it does not qualify nginx syntax.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { namespaceFixture } from '../dist/tests/namespace-fixture.js';
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const output=process.env.STRATA_STUDIO_FIXES_EVIDENCE??await mkdtemp(path.join(tmpdir(),'strata-studio-fixes-'));
const f=await namespaceFixture(),index=f.seedExisting();await f.prepare();
assert.equal((await f.action('import',{name:'existing-project',repository_id:index.repository_id,index,acknowledgment:'open-snapshot-and-save-new-drafts'})).status,200);
const initialFiles=[...f.repos.get('existing-project').git.files].flatMap(([ref,files])=>[...files].map(([name,bytes])=>({ref,name,bytes:Buffer.from(bytes).toString('hex')})));
const config=await readFile('deploy/studio/nginx.conf.example','utf8'),size=s=>Number(s.match(/\d+/)[0])*(/m/i.test(s)?1024*1024:/k/i.test(s)?1024:1);
const defaultLimit=size(config.match(/client_max_body_size\s+(\w+);/)[1]);
const ingressLimit=pathname=>size(config.match(new RegExp('location\\s+=\\s*'+pathname+'\\s*\\{[^}]*client_max_body_size\\s+(\\w+);'))?.[1]??String(defaultLimit));
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],failures=[],errors=[],external=[],operations=[];let cookies=[];
const check=(name,value)=>{checks.push({name,passed:!!value});if(!value)failures.push(name);console.log((value?'PASS ':'FAIL ')+name);};
const loaded=page=>page.locator('main[aria-busy]').waitFor({state:'detached'});
const section=async(page,name)=>{await openStudioSection(page, name);await page.locator('main').getByRole('heading',{name:name==='Blocks'?'Application map':name==='Settings'?'Connections':name,exact:true}).waitFor();await loaded(page);};
async function scenario(name,run){
  if(process.env.STRATA_STUDIO_FIXES_SCENARIO&&process.env.STRATA_STUDIO_FIXES_SCENARIO!==name)return;
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();let fault='none';
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const original=route.request(),url=new URL(original.url());if(url.origin!==f.base.origin){external.push(url.origin);return route.abort();}
    const body=original.postDataBuffer(),operation=url.pathname==='/studio/v1/operation'&&original.method()==='POST';
    if(fault==='source-denied'&&url.pathname==='/studio/v1/review/state')return route.fulfill({status:403,json:{error:{code:'SOURCE_AUTH',message:'The source read was refused.'}}});
    if(operation)operations.push({scenario:name,...JSON.parse(original.postData()),bytes:body.length});
    const html=status=>route.fulfill({status,contentType:'text/html',body:'<html>private-provider-echo must never reach the UI</html>'});
    if(operation&&['html413','html502','malformed','empty-result'].includes(fault)){
      if(fault==='empty-result')return route.fulfill({status:200,json:{api_version:'studio/1',data:{data:{},generation:null}}});
      if(fault==='malformed')return route.fulfill({status:200,contentType:'application/json',body:'{broken'});
      return html(fault==='html413'?413:502);
    }
    if(fault==='ingress'&&body&&body.length>ingressLimit(url.pathname))return html(413);
    const headers=await original.allHeaders();headers.host='studio.example.test';headers['x-forwarded-proto']='https';
    const response=await new Promise((resolve,reject)=>{const req=request(f.server.origin+url.pathname+url.search,{method:original.method(),headers},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body);});
    if(operation&&fault==='lost-committed'){assert.equal(response.status,200);return route.abort();}
    await route.fulfill(response);
  });
  try{
    // Reuse this synthetic owner session; fresh tabs isolate recovery metadata
    // without consuming a new installation-owner session for each fault case.
    if(cookies.length)await context.addCookies(cookies);
    await page.goto(f.base.origin+'/#/blocks');
    if(!cookies.length){await page.getByLabel('Sign-in name',{exact:true}).fill('workspace.owner');await page.getByLabel('Password',{exact:true}).fill(f.base.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();}
    await page.getByText('Draft editing enabled',{exact:true}).waitFor();await page.getByRole('heading',{name:'Application map',exact:true}).waitFor();await loaded(page);
    check(name+' page identity and meaningful first view',await page.title()==='Strata Studio'&&page.url().startsWith(f.base.origin)&&await page.getByRole('heading',{name:'Application map',exact:true}).isVisible());
    await run(page,value=>fault=value);
  }catch(e){failures.push(name+': '+e.message);console.log('FAIL '+name+': '+e.message);}
  finally{cookies=await context.cookies();await page.screenshot({path:path.join(output,name+'.png'),fullPage:true}).catch(()=>{});await context.close();}
}
async function draft(page,id,value='Disposable marker v1.'){
  await section(page,'Changes');await page.getByRole('button',{name:'New change',exact:true}).click();
  const dialog=page.locator('dialog.proposal-dialog');await dialog.getByLabel('New Layer ID',{exact:true}).fill(id);await dialog.getByLabel('Intent',{exact:true}).fill('Disposable UI regression. Do not publish.');
  await dialog.getByLabel('Proposed purpose',{exact:true}).fill(value);await dialog.getByRole('button',{name:'Add item to draft',exact:true}).click();await dialog.getByRole('button',{name:'Review draft',exact:true}).click();await dialog.getByRole('button',{name:'Save owned draft',exact:true}).waitFor();return dialog;
}
try{
  await scenario('imported-review',async page=>{
    await section(page,'Changes');check('Changes explains owned versus retained drafts',(await page.locator('main').innerText()).includes('No owned drafts')&&(await page.locator('main').innerText()).includes('Layers'));
    await section(page,'Blocks');await page.getByRole('combobox',{name:'Preview a Layer',exact:true}).selectOption('WorkspaceDraft@1');await loaded(page);
    check('imported draft uses readable handoff rather than an unavailable Review link',await page.getByRole('link',{name:'Inspect imported draft',exact:true}).count()===1&&await page.getByRole('link',{name:'Review proposal',exact:true}).count()===0);
    // Direct route still enforces the backend's private-workflow boundary.
    const binding=new URL(page.url()).hash.split('?')[1],q=new URLSearchParams(binding);q.delete('view');q.delete('layer');q.set('ref','WorkspaceDraft@1');
    await page.goto(f.base.origin+'/#/review?'+q);await loaded(page);await page.locator('main').getByText('Record is not visible to this principal.',{exact:true}).waitFor();
    check('reference refusal retains connected project',(await page.locator('#header').innerText()).includes('Connected project'));
    await section(page,'Layers');check('Layers remains usable after a denied private Review',await page.getByRole('link',{name:'WorkspaceDraft@1',exact:true}).count()===1);
    await section(page,'Blocks');check('Blocks remains usable after a denied private Review',await page.getByRole('heading',{name:'Application map',exact:true}).count()===1);
  });
  await scenario('source-refusal',async(page,setFault)=>{
    setFault('source-denied');await section(page,'Review');await page.getByRole('link',{name:'CounterBaseline@1',exact:true}).click();await page.locator('main').getByText('The source read was refused.',{exact:true}).waitFor();
    check('genuine source refusal invalidates source and authoring claims',(await page.locator('#header').innerText()).includes('Not connected')&&!(await page.locator('#header').innerText()).includes('Draft editing enabled'));
  });
  for(const fault of ['html413','html502','malformed','empty-result'])await scenario(fault,async(page,setFault)=>{
    const dialog=await draft(page,'L-'+fault);setFault(fault);await dialog.getByRole('button',{name:'Save owned draft',exact:true}).click();await dialog.getByRole('alert').filter({hasText:/./}).waitFor();
    const message=await dialog.getByRole('alert').innerText();check(fault+' has actionable sanitized outcome guidance',/Review|receipt|reconcile/i.test(message)&&!/Unexpected token|private-provider-echo/.test(message));
    check(fault+' locks resubmission',await dialog.getByRole('button',{name:'Save owned draft',exact:true}).isDisabled());
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await section(page,'Review');await page.getByRole('button',{name:'Check original request receipt',exact:true}).click();await page.getByText(/Original request receipt: not_found/).waitFor();
    check(fault+' absence is not presented as proof of no effect',/does not prove|not proof/i.test(await page.locator('main').innerText()));
    await page.reload();await loaded(page);await section(page,'Changes');await page.getByRole('button',{name:'New change',exact:true}).click();
    check(fault+' recovery survives reload and prevents a fresh duplicate save',await page.getByRole('button',{name:'Save owned draft',exact:true}).count()===0&&await page.getByRole('link',{name:'Open operation recovery',exact:true}).count()===1);
    check(fault+' was dispatched only once',operations.filter(o=>o.scenario===fault).length===1);
  });
  await scenario('lost-committed',async(page,setFault)=>{
    const before=f.repos.get('existing-project').git.pushes,dialog=await draft(page,'L-lost-reply');setFault('lost-committed');await dialog.getByRole('button',{name:'Save owned draft',exact:true}).click();await dialog.getByRole('alert').filter({hasText:/./}).waitFor();
    check('lost reply locks the save',await dialog.getByRole('button',{name:'Save owned draft',exact:true}).isDisabled());
    check('lost reply really committed once',f.repos.get('existing-project').git.pushes===before+1);
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await section(page,'Review');await page.getByRole('button',{name:'Check original request receipt',exact:true}).click();await page.getByText(/Original request receipt: committed/).waitFor();
    check('lost reply reconciles its exact original key',(await page.locator('main').innerText()).includes(operations.find(o=>o.scenario==='lost-committed').idempotency_key));
    check('receipt inspection never replays the committed write',operations.filter(o=>o.scenario==='lost-committed').length===1&&f.repos.get('existing-project').git.pushes===before+1);
  });
  await scenario('large-draft',async(page,setFault)=>{
    setFault('ingress');const dialog=await draft(page,'L-normal-size','A representative purpose: '+('detailed intent '.repeat(120)));await dialog.getByRole('button',{name:'Save owned draft',exact:true}).click();await dialog.getByText('Saved L-normal-size@1',{exact:true}).waitFor();
    check('configured ingress admits a representative draft above 1 KiB',operations.find(o=>o.scenario==='large-draft').bytes>1024);
    await dialog.getByRole('link',{name:'Review saved proposal',exact:true}).click();await page.getByRole('heading',{name:'Proposed intent',exact:true}).waitFor();await loaded(page);await page.reload();await page.getByRole('heading',{name:'Proposed intent',exact:true}).waitFor();await loaded(page);check('representative draft survives reload',(await page.locator('main').innerText()).includes('A representative purpose:'));
  });
  await scenario('revision',async page=>{
    const dialog=await draft(page,'L-revision');await dialog.getByRole('button',{name:'Save owned draft',exact:true}).click();await dialog.getByText('Saved L-revision@1',{exact:true}).waitFor();await dialog.getByRole('link',{name:'Review saved proposal',exact:true}).click();await page.getByRole('heading',{name:'Proposed intent',exact:true}).waitFor();await loaded(page);
    check('satisfied gates do not display refusal codes',!(await page.locator('main').innerText()).includes('OWNER_FORBIDDEN')&&!(await page.locator('main').innerText()).includes('STALE_REVISION'));
    await page.getByText('Owned next revision — advanced input',{exact:true}).click();const editor=page.getByLabel('Owned next revision',{exact:true}),record=JSON.parse(await editor.inputValue());record.changes[0].value='Disposable marker v2.';await editor.fill(JSON.stringify(record));await page.getByRole('button',{name:'Save next revision',exact:true}).click();await page.getByText('Saved L-revision@2',{exact:true}).waitFor();await page.getByRole('button',{name:'Reload saved view',exact:true}).click();await loaded(page);
    await page.locator('main').getByText('Disposable marker v2.',{exact:true}).waitFor();
    check('saved-view action opens exact new revision',new URLSearchParams(page.url().split('?')[1]).get('ref')==='L-revision@2'&&(await page.locator('main').innerText()).includes('Disposable marker v2.'));
    await page.reload();await page.getByRole('heading',{name:'Proposed intent',exact:true}).waitFor();await loaded(page);check('new revision persists after reload',(await page.locator('main').innerText()).includes('Disposable marker v2.'));
    await section(page,'Layers');await page.getByRole('link',{name:'L-revision@1',exact:true}).click();await page.getByRole('heading',{name:'L-revision@1',exact:true}).waitFor();await loaded(page);check('previous revision remains immutable',(await page.locator('main').innerText()).includes('Disposable marker v1.'));
  });
  f.setMode('lost-push');assert.notEqual((await f.action('create',{name:'synthetic-partial',purpose:'Interrupted initial push'})).status,200);f.setMode('ok');
  const original=(await f.server.store.snapshot()).operations.find(o=>o.action==='create'&&o.repository_name==='synthetic-partial'),pushes=f.repos.get('synthetic-partial').git.pushes,providerBefore=f.calls.length;
  await scenario('partial-recovery',async page=>{
    await page.locator('#header .repository-switcher').click();await page.getByRole('button',{name:'Check unfinished setup',exact:true}).click();await page.getByText(/cannot be initialized as a new empty project/).waitFor();
    check('partial creation exposes the original request and reconciliation handoff',(await page.locator('#menu-dialog').innerText()).includes(original.request_id)&&await page.getByRole('button',{name:'Copy recovery details',exact:true}).count()===1);
    check('inspection result is focused and visible',await page.locator('#menu-dialog [role=status]').evaluate(n=>document.activeElement===n&&n.getBoundingClientRect().top>=0&&n.getBoundingClientRect().bottom<=innerHeight));
    await page.setViewportSize({width:390,height:844});check('mobile recovery fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    check('partial recovery preserves provider data with reads only',f.repos.get('synthetic-partial').git.pushes===pushes&&f.calls.slice(providerBefore).every(c=>c.startsWith('GET ')));
  });
  await scenario('session-refusal',async page=>{
    const dialog=await draft(page,'L-session-refusal');await dialog.getByRole('button',{name:'Save owned draft',exact:true}).click();await dialog.getByText('Saved L-session-refusal@1',{exact:true}).waitFor();
    check('confirmed save updates the formerly unsaved modal copy',(await dialog.innerText()).includes('Saved as an owned private draft.')&&!(await dialog.innerText()).includes('This proposal has not been saved'));
    await dialog.getByRole('link',{name:'Review saved proposal',exact:true}).click();await page.getByRole('heading',{name:'Proposed intent',exact:true}).waitFor();await loaded(page);
    await page.getByText('Owned next revision — advanced input',{exact:true}).click();const editor=page.getByLabel('Owned next revision',{exact:true}),next=JSON.parse(await editor.inputValue());next.changes[0].value='Unsaved session-expiry marker.';const edited=JSON.stringify(next);await editor.fill(edited);
    const before=f.repos.get('existing-project').git.pushes,calls=f.calls.length,dispatched=operations.length;
    // Expire the actual synthetic owner, preserving real server admission logic.
    f.server.owner.clear();
    const [reply]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/studio/v1/operation')),page.getByRole('button',{name:'Save next revision',exact:true}).click()]);
    await page.locator('.command-result [role=alert]').filter({hasText:'OWNER_SESSION_REQUIRED'}).waitFor();
    check('real expired owner session refuses at admission',reply.status()===403&&(await reply.json()).error.code==='OWNER_SESSION_REQUIRED');
    const focus=await page.locator('.command-result [role=alert]').evaluate(n=>({focused:document.activeElement===n,active:document.activeElement?.tagName,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,height:innerHeight}));console.log('Session refusal focus: '+JSON.stringify(focus));
    check('session refusal is focused and within the viewport',focus.focused&&focus.top>=0&&focus.bottom<=focus.height);
    const header=await page.locator('#header').innerText();check('expired session removes stale connected and editing claims',header.includes('Sign-in required')&&!header.includes('Connected project')&&!header.includes('Draft editing enabled'));
    check('expired session disables both revise and publish',await page.getByRole('button',{name:'Save next revision',exact:true}).isDisabled()&&await page.getByRole('button',{name:'Publish proposal',exact:true}).isDisabled());
    check('expired session preserves exact unsaved revision input',await editor.inputValue()===edited);
    const recovery=page.locator('.command-result');check('session recovery offers explicit copy and separate-tab sign-in',await recovery.getByRole('button',{name:'Copy unsaved revision',exact:true}).count()===1&&await recovery.getByRole('link',{name:'Sign in in another tab',exact:true}).getAttribute('target')==='_blank');
    check('expired save never writes provider data or automatically redispatches',f.repos.get('existing-project').git.pushes===before&&f.calls.length===calls&&operations.length===dispatched+1);
    check('unsaved session-expiry content is absent from browser persistence',!(await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage}))).includes('Unsaved session-expiry marker.'));
    await page.setViewportSize({width:390,height:844});await recovery.getByRole('button',{name:'Copy unsaved revision',exact:true}).click();
    await recovery.locator('[role=status]').filter({hasText:/Unsaved revision copied|Clipboard unavailable/}).waitFor();
    check('explicit revision copy remains available on mobile',await page.getByText('Unsaved revision copied. Keep it before refreshing this view.',{exact:true}).count()===1||await recovery.getByRole('textbox',{name:'Text to copy',exact:true}).inputValue()===JSON.stringify(next,null,2));
    check('mobile session recovery fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const [login]=await Promise.all([page.waitForEvent('popup'),recovery.getByRole('link',{name:'Sign in in another tab',exact:true}).click()]);await login.getByRole('heading',{name:'Sign in to Strata Studio.',exact:true}).waitFor();
    check('separate sign-in leaves the original edit and no replay intact',await editor.inputValue()===edited&&operations.length===dispatched+1);await login.close();
  });
  check('imported immutable bytes remain unchanged',initialFiles.every(({ref,name,bytes})=>Buffer.from(f.repos.get('existing-project').git.files.get(ref).get(name)).toString('hex')===bytes));
  check('no uncaught browser errors or external requests',errors.length===0&&external.length===0);
  await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,failures,errors,external,operations:operations.map(({scenario,command,idempotency_key,bytes})=>({scenario,command,idempotency_key,bytes})),boundary:'example-driven loopback harness, not live nginx',output},null,2));
  console.log(JSON.stringify({passed:checks.filter(c=>c.passed).length,failed:failures.length,output}));assert.deepEqual(failures,[]);
}finally{await browser.close();await f.server.close();}
