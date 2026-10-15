// Real Studio shell/HTTP, retained synthetic Release, disk repository and generated
// module checks. Host custody is an explicit fixture seam, not installed authority.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildAdapterFixture,indexedBuildRecords} from '../dist/tests/build-adapter-fixture.js';
import {StudioCommands} from '../dist/src/explorer/commands.js';
import {startExplorer} from '../dist/src/explorer/host.js';
import {LocalBuildStudioAdapter,PROFILES_BUILD_COMMANDS} from '../dist/src/build-studio.js';
import {digest,BLOCK_MODEL} from '../dist/src/model.js';
import {normalizeBuildProfile} from '../dist/src/build-contracts.js';

const output=process.env.STRATA_BUILD_UI_OUTPUT;
assert(output && process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE,'Explicit evidence directory and existing Playwright module required.');
await mkdir(output,{recursive:true});
const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const f=await buildAdapterFixture('s5-browser',{},'build-ui-synthetic');
const client=options=>(command,input)=>f.repository.execute(command,input,f.context(),{
  key:options.idempotency_key,expected_generation:options.expected_generation,expected_policy:options.expected_policy});
async function endpoint(configured){
  const commands=new StudioCommands({project_id:f.issuer.projectId,model_version:BLOCK_MODEL},'',f.root,
    [...PROFILES_BUILD_COMMANDS],{},'local-fixture',undefined,client,undefined,
    configured?new LocalBuildStudioAdapter(f.repository,()=>f.context()):undefined);
  await commands.reader.refresh();
  const host=await startExplorer(commands.reader,{assets:path.resolve('explorer'),commands});
  return {host,commands};
}
const configured=await endpoint(true),unconfigured=await endpoint(false);
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[],operations=[],requests=[],errors=[],outside=[];
let mode='',prepareCount=0,gateResolve,gateEntered;
const profileRequests=[];
function forward(req){return new Promise((resolve,reject)=>{
  const target=new URL(req.url());const call=request(target,{method:req.method(),headers:req.headers()},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
  });call.on('error',reject);call.end(req.postDataBuffer()??undefined);
});}
async function open(available=true){
  const host=(available?configured:unconfigured).host;
  const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
  context.setDefaultTimeout(35000);
  await context.addInitScript(()=>window.addEventListener('DOMContentLoaded',()=>{
    const note=document.createElement('p');note.className='notice';note.textContent='Synthetic workflow: real disposable Local repository and output; mocked host custody. No installed host or provider qualification.';document.body.prepend(note);
  }));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==host.origin){outside.push(req.url());return route.abort();}
    requests.push({path:url.pathname,method:req.method()});
    if(url.pathname==='/studio/v1/profiles' && mode.startsWith('pagination')){
      const cursor=url.searchParams.get('cursor'); profileRequests.push(cursor);
      if(cursor && mode==='pagination-failure')return route.fulfill({status:503,json:{error:{code:'STUDIO_RESPONSE_UNAVAILABLE',message:'Injected profile page failure. Retry the same page.'}}});
      if(cursor && mode==='pagination-stale')return route.fulfill({status:422,json:{error:{code:'INVALID_CURSOR',message:'Injected stale profile cursor. Reload choices.'}}});
      const response=await forward(req);delete response.headers['content-length'];
      if(response.status===200){
        const value=JSON.parse(response.body),items=value.data.profiles;
        value.data={profiles:items.slice(0,1),cursor:items.length>1?items[0].ref:null};
        if(mode==='pagination-empty' || cursor && mode==='pagination-empty-last')value.data={profiles:[],cursor:null};
        if(cursor && mode==='pagination-repeat')value.data.cursor=cursor;
        if(cursor && mode==='pagination-overlap')value.data.profiles=[f.saved];
        if(cursor && mode==='pagination-tamper')value.data.profiles[0].record.name='Tampered bytes';
        if(cursor && mode==='pagination-scope')value.data.profiles[0].record.repository_id='other';
        response.body=Buffer.from(JSON.stringify(value));
      }
      if(cursor && mode==='pagination-delay'){gateEntered?.();await new Promise(resolve=>gateResolve=resolve);}
      return route.fulfill(response);
    }
    if(url.pathname==='/studio/v1/build/preview'){
      prepareCount++;
      if(mode==='session')return route.fulfill({status:401,json:{error:{code:'SESSION_REQUIRED',message:'Injected expired session before admission.'}}});
      if(mode==='delay'){gateEntered?.();await new Promise(resolve=>gateResolve=resolve);}
    }
    const operation=url.pathname==='/studio/v1/operation';
    if(operation)operations.push(req.postDataJSON());

    if(!['plan-mismatch','scope-mismatch','context-filter','lost','wrong-build','incomplete-confirmation','start-forbidden'].includes(mode))return route.continue();
    if(!url.pathname.startsWith('/studio/v1/'))return route.continue();
    const response=await forward(req);delete response.headers['content-length'];
    if(mode==='lost'&&operation)return route.abort();
    if(response.status===200){
      const value=JSON.parse(response.body);
      if(mode==='start-forbidden'&&url.pathname==='/studio/v1/capabilities'){
        const row=value.data.operations.find(r=>r.operation==='build.start');assert(row);row.allowed=false;
      }
      if(mode==='plan-mismatch'&&url.pathname==='/studio/v1/build/preview')value.data.plan_sha256='f'.repeat(64);
      if(mode==='scope-mismatch'&&url.pathname==='/studio/v1/build/context')value.data.repository_id='other';
      if(mode==='context-filter'&&url.pathname==='/studio/v1/build/context'){
        value.data.releases.push({...value.data.releases[0],state:'excluded',historically_approved:false,release:{ref:'Bootstrap@fixture',sha256:'e'.repeat(64)}});
        const p=value.data.profiles[0];
        value.data.profiles.push({...p,ref:'build-profile@'+'e'.repeat(64),sha256:'e'.repeat(64),record:{...p.record,repository_id:'other',name:'Cross-repository fixture'}});
      }
      if(mode==='wrong-build'&&operation)value.data.data.request_key='wrong-original-key';
      if(mode==='incomplete-confirmation'&&operation)delete value.data.data.verification;
      response.body=Buffer.from(JSON.stringify(value));
    }
    return route.fulfill(response);
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:')&&!m.text().includes('net::ERR_FAILED'))errors.push(m.text());});
  await page.goto(host.origin+'/#session='+host.capability);
  await openStudioSection(page, 'Build');
  await page.getByRole('heading',{name:'Build',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.build-page')?.getAttribute('aria-busy')==='false');
  return {context,page};
}
async function chosen(page){
  await page.getByLabel('Approved Release',{exact:true}).selectOption(f.release.ref);
  await page.getByLabel('Saved Profile revision',{exact:true}).selectOption(f.saved.ref);
}
async function prepare(page){
  await page.getByRole('button',{name:'Prepare build',exact:true}).click();
  await page.getByRole('heading',{name:'Prepared plan',exact:true}).waitFor();
}
async function check(name,fn){if(process.env.STRATA_BUILD_UI_CHECK&&!name.includes(process.env.STRATA_BUILD_UI_CHECK))return;try{await fn();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){for(const c of browser.contexts()){for(const p of c.pages()){console.log('FAILED PAGE '+name+' '+await p.locator('main').innerText().catch(()=>''));await p.screenshot({path:path.join(output,'failed.png'),fullPage:true}).catch(()=>{});}}throw e;}}
try{
  await check('configured shell renders approved Release and exact saved Profile; excludes bootstrap/cross-repository fixture entries',async()=>{
    mode='context-filter';const {page,context}=await open();
    assert.equal(await page.locator('#build-release option').count(),2,await page.locator('.build-page').innerText());
    assert.equal(await page.locator('#build-profile option').count(),2);
    assert.equal(await page.getByLabel('Approved Release').inputValue(),'');
    assert((await page.locator('.build-page').innerText()).includes('not this browser computer'));
    assert((await page.locator('.build-page').innerText()).includes('Node ≥22'));
    assert.equal(await page.locator('.build-page input, .build-page textarea').count(),0);
    await context.close();mode='';
  });
  let completed,lostBuild;
  await check('UI prepares exact pins and one repeated-click build performs actual export, new finite measurement and byte verification',async()=>{
    const {page,context}=await open();await chosen(page);await prepare(page);
    const count=operations.length;
    await page.getByRole('button',{name:'Build on Studio host',exact:true}).evaluate(node=>{node.click();node.click();});
    await page.getByRole('heading',{name:'Retained build attempt',exact:true}).waitFor();
    assert.equal(operations.length,count+1);
    const op=operations.at(-1);assert.equal(op.command,'build.start');assert.deepEqual(op.input.selection,f.selection);
    const receipt=(await f.repository.execute('operation.inspect',{key:op.idempotency_key},f.context())).data;
    completed=receipt.result.data;
    assert.equal(completed.phase,'completed');assert.equal(completed.plan_sha256,digest(completed.plan));
    assert.equal(completed.verification.bytes,true);assert.equal(completed.verification.mechanical,true);assert.equal(completed.verification.fresh_semantic_validation,false);
    assert.notEqual(completed.host_run.ref,f.sourceRun.ref);
    const records=await indexedBuildRecords(f.state);assert.equal(records[completed.realization.ref].data.target,f.release.ref);
    assert((await page.locator('.build-page').innerText()).includes('Fresh semantic validation\nNot performed'));
    await page.getByRole('button',{name:'Refresh status',exact:true}).click();
    await page.getByRole('button',{name:'Inspect verified files',exact:true}).click();
    const file=completed.inventory.find(file=>file.name==='collection.mjs');assert(file);
    const promise=page.waitForEvent('download');await page.getByRole('button',{name:'Download collection.mjs',exact:true}).click();
    const download=await promise;await download.saveAs(path.join(output,'synthetic-collection.mjs'));
    const bytes=await readFile(path.join(output,'synthetic-collection.mjs'));
    assert.equal(bytes.toString(),records[completed.realization.ref].data.files['collection.mjs']);
    const module=await import(pathToFileURL(path.join(output,'synthetic-collection.mjs')).href),collection=module.createCollection();
    assert.deepEqual(collection.list(),[]);
    assert.deepEqual(collection.add('long','A real generated item'),{accepted:false,reason:'title_too_long'});
    assert.deepEqual(collection.add('s5','Task'),{accepted:true,item:{id:'s5',title:'Task',completed:false}});
    assert.deepEqual(collection.complete('s5'),{accepted:true,item:{id:'s5',title:'Task',completed:true}});
    assert.deepEqual(module.createCollection().list(),[]);
    await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
    await context.close();
  });
  await check('Worker planned destination invalidates Local plan and sends no preview/start',async()=>{
    const {page,context}=await open();await chosen(page);await prepare(page);const count=operations.length,previews=prepareCount;
    await page.getByLabel('Destination',{exact:true}).selectOption('cloudflare-worker');
    assert(await page.getByRole('button',{name:'Prepare build',exact:true}).isDisabled());
    assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());
    assert.equal(await page.getByRole('heading',{name:'Prepared plan',exact:true}).count(),0);
    assert.equal(operations.length,count);assert.equal(prepareCount,previews);await context.close();
  });
  await check('fresh prepare detects changed host fingerprint and refuses start',async()=>{
    const {page,context}=await open();await chosen(page);await prepare(page);const count=operations.length;
    const original=f.getHost();f.setHost({...original,label:'Changed synthetic host'});
    await page.getByRole('button',{name:'Build on Studio host',exact:true}).click();
    await page.getByText(/BUILD_PLAN_STALE:/).waitFor();assert.equal(operations.length,count);
    f.setHost(original);await context.close();
  });
  await check('prepared plan digest mismatch refuses admission',async()=>{
    mode='plan-mismatch';const {page,context}=await open();await chosen(page);
    await page.getByRole('button',{name:'Prepare build',exact:true}).click();await page.getByText(/BUILD_RESPONSE_MISMATCH:/).waitFor();
    assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());await context.close();mode='';
  });
  await check('cross-repository context refuses all selectors and start',async()=>{
    mode='scope-mismatch';const {page,context}=await open();await page.getByText(/Build data belongs to a different repository/).waitFor();
    assert.equal(await page.locator('#build-release option').count(),0);assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());
    await context.close();mode='';
  });
  await check('expired prepare retains selection and offers protected session guidance without dispatch',async()=>{
    const {page,context}=await open();await chosen(page);const count=operations.length;mode='session';
    await page.getByRole('button',{name:'Prepare build',exact:true}).click();await page.getByText(/Studio session expired/).waitFor();
    assert.equal(await page.getByLabel('Approved Release').inputValue(),f.release.ref);assert.equal(operations.length,count);
    await context.close();mode='';
  });
  await check('navigation disposes delayed prepare; no plan or mutation leaks into Profiles',async()=>{
    const {page,context}=await open();await chosen(page);const count=operations.length;mode='delay';
    const entered=new Promise(resolve=>gateEntered=resolve);
    await page.getByRole('button',{name:'Prepare build',exact:true}).click();await entered;
    await openStudioSection(page, 'Profiles');
    gateResolve();await page.getByRole('heading',{name:'Profiles',exact:true}).waitFor();
    assert.equal(await page.locator('.build-page').count(),0);assert.equal(operations.length,count);await context.close();mode='';
  });
  await check('lost committed response preserves original-key Review and blocks repeat build',async()=>{
    const {page,context}=await open();await chosen(page);await prepare(page);const count=operations.length;mode='lost';
    await page.getByRole('button',{name:'Build on Studio host',exact:true}).click();try{await page.getByText(/An operation outcome is unknown or pending/).waitFor();}catch(e){console.log(await page.locator('.build-page').innerText());throw e;}
    assert.equal(operations.length,count+1);const op=operations.at(-1);
    const retained=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('strata-studio-pending')));assert.equal(retained.key,op.idempotency_key);
    assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());
    const before=(await f.repository.execute('operation.inspect',{key:op.idempotency_key},f.context())).data.result.data;
    lostBuild=before.build_id;assert.equal((await f.repository.execute('build.inspect',{build_id:before.build_id},f.context())).data.phase,'completed');
    assert.equal(operations.length,count+1);await context.close();mode='';
  });
  await check('mismatched original request key is unknown even when other returned build pins match',async()=>{
    const {page,context}=await open();await chosen(page);await prepare(page);mode='wrong-build';
    await page.getByRole('button',{name:'Build on Studio host',exact:true}).click();try{await page.getByText(/An operation outcome is unknown or pending/).waitFor();}catch(e){console.log(await page.locator('.build-page').innerText());throw e;}
    assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());await context.close();mode='';
  });
  await check('incomplete completion confirmation preserves original-key recovery before clearing metadata',async()=>{
    const {page,context}=await open();await chosen(page);await prepare(page);mode='incomplete-confirmation';
    await page.getByRole('button',{name:'Build on Studio host',exact:true}).click();await page.getByText(/An operation outcome is unknown or pending/).waitFor();
    const retained=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('strata-studio-pending')));
    assert.equal(retained.key,operations.at(-1).idempotency_key);assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());
    await context.close();mode='';
  });
  await check('unconfigured host keeps Build visible and explicitly unavailable',async()=>{
    const {page,context}=await open(false);await page.getByText(/no configured Local Profiles\/Build adapter/).waitFor();
    assert(await page.getByRole('button',{name:'Prepare build',exact:true}).isDisabled());await context.close();
  });
  await check('missing finite runner is a host blocker and never enables preparation',async()=>{
    const original=f.getHost();f.setHost({...original,runner:null});
    try{const {page,context}=await open();await chosen(page);await page.getByText(/RUNNER_UNAVAILABLE: requires configured finite/).waitFor();
      assert(await page.getByRole('button',{name:'Prepare build',exact:true}).isDisabled());await context.close();}
    finally{f.setHost(original);}
  });
  await check('standalone module without an adapter is explicitly unavailable',async()=>{
    const {page,context}=await open();
    await page.evaluate(async()=>{const {buildView}=await import('/build.js');const view=buildView({state:{},href:s=>'#/'+s,pendingOperation:()=>null});document.querySelector('main').replaceChildren(view);await view.start();});
    await page.getByText(/this page has no authenticated Local Build adapter/).waitFor();
    assert(await page.getByRole('button',{name:'Prepare build',exact:true}).isDisabled());await context.close();
  });
  await check('prepare never grants missing current build.start action authority',async()=>{
    mode='start-forbidden';const {page,context}=await open();await chosen(page);await prepare(page);const count=operations.length;
    await page.getByText(/Build execution is unavailable under the current Studio action authority/).waitFor();
    assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());assert.equal(operations.length,count);
    await context.close();mode='';
  });
  await check('320px keyboard controls, exact pins, no overflow, external traffic or page errors',async()=>{
    const {page,context}=await open();await page.setViewportSize({width:320,height:800});await chosen(page);await prepare(page);
    await page.getByLabel('Destination').focus();assert.equal(await page.evaluate(()=>document.activeElement.id),'build-destination');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert(!(await page.locator('.build-page').innerText()).includes('nullnull'));
    assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(),0);
    await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});await context.close();
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  });
  // Real saved fixture revisions; only HTTP page size/failure timing is injected.
  for(let i=0;i<2;i++){
    const record={...f.profileRequest.record,id:'Pagination'+i,name:'Pagination profile '+i};
    await f.repository.execute('profile.create',{record,expected_normalized_sha256:digest(normalizeBuildProfile(record))},f.context('author-a'),{key:'pagination-save-'+i});
  }
  const allProfiles=(await f.repository.execute('profile.list',{limit:100},f.context())).data.profiles;
  const first=allProfiles[0],second=allProfiles[1],last=allProfiles[2];
  const more=page=>page.getByRole('button',{name:'Load more profiles',exact:true});
  const idle=page=>page.waitForFunction(()=>document.querySelector('.build-page')?.getAttribute('aria-busy')==='false');
  await check('pagination multiple pages keeps exact selection, invalidates plans, rejects repeated clicks and prepares a later-page Profile',async()=>{
    mode='pagination';const {page,context}=await open();
    assert.equal(await page.locator('#build-profile option').count(),2);
    assert.equal(await page.locator('#build-profile').inputValue(),'');
    await page.locator('#build-release').selectOption(f.release.ref);await page.locator('#build-profile').selectOption(first.ref);await prepare(page);
    const before=profileRequests.length,count=operations.length;
    await more(page).evaluate(node=>{node.click();node.click();});await idle(page);
    assert.equal(profileRequests.length,before+1);assert.equal(profileRequests.at(-1),first.ref);
    assert.equal(await page.locator('#build-profile').inputValue(),first.ref);
    assert.equal(await page.locator('#build-release').inputValue(),f.release.ref);
    assert.equal(await page.getByRole('heading',{name:'Prepared plan',exact:true}).count(),0);
    assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());
    await page.locator('#build-profile').selectOption(second.ref);
    await more(page).click();await idle(page);
    assert.equal(await page.locator('#build-profile option').count(),4);
    assert.equal(await page.locator('#build-profile').inputValue(),second.ref);assert(await more(page).isHidden());
    await page.locator('#build-profile').selectOption(last.ref);await prepare(page);
    assert((await page.locator('.build-page').innerText()).includes(last.ref));assert.equal(operations.length,count);
    await context.close();mode='';
  });
  await check('pagination empty first and empty terminal pages stop honestly without automatic selection',async()=>{
    mode='pagination-empty';let opened=await open();
    assert.equal(await opened.page.locator('#build-profile option').count(),1);assert(await more(opened.page).isHidden());
    assert((await opened.page.locator('.build-page').innerText()).includes('No valid saved Profile'));
    await opened.context.close();mode='pagination-empty-last';opened=await open();
    await opened.page.locator('#build-profile').selectOption(first.ref);await more(opened.page).click();await idle(opened.page);
    assert.equal(await opened.page.locator('#build-profile').inputValue(),first.ref);assert(await more(opened.page).isHidden());
    await opened.context.close();mode='';
  });
  await check('pagination API failure retains selection and retries the original cursor without replaying mutations',async()=>{
    mode='pagination';const {page,context}=await open();await page.locator('#build-profile').selectOption(first.ref);
    const count=operations.length;mode='pagination-failure';await more(page).click();await idle(page);
    await page.getByText(/STUDIO_RESPONSE_UNAVAILABLE:/).waitFor();assert.equal(await page.locator('#build-profile').inputValue(),first.ref);
    assert(await more(page).isEnabled());mode='pagination';await more(page).click();await idle(page);
    assert.deepEqual(profileRequests.slice(-2),[first.ref,first.ref]);assert.equal(await page.locator('#build-profile option').count(),3);
    assert.equal(operations.length,count);assert.equal(await page.getByText(/STUDIO_RESPONSE_UNAVAILABLE:/).count(),0);
    await context.close();mode='';
  });
  for(const refusal of ['repeat','stale','tamper','overlap'])await check('pagination '+refusal+' refuses the page and requires explicit reload',async()=>{
    mode='pagination';const {page,context}=await open();await page.locator('#build-profile').selectOption(first.ref);
    mode='pagination-'+refusal;
    // Overlap with a previously loaded revision, independently of sort order.
    if(refusal==='overlap')await page.route('**/studio/v1/profiles?*',async route=>{
      const url=new URL(route.request().url());if(!url.searchParams.has('cursor'))return route.fallback();
      return route.fulfill({json:{data:{profiles:[first],cursor:null}}});
    });
    await more(page).click();await idle(page);
    await page.getByText(refusal==='stale'?/INVALID_CURSOR:/:/BUILD_RESPONSE_MISMATCH:/).waitFor();
    assert.equal(await page.locator('#build-profile option').count(),2);assert.equal(await page.locator('#build-profile').inputValue(),first.ref);
    assert(await more(page).isHidden());mode='pagination';await page.getByRole('button',{name:'Reload choices',exact:true}).click();await idle(page);
    assert.equal(await page.locator('#build-profile').inputValue(),'');assert(await more(page).isEnabled());
    await context.close();mode='';
  });
  await check('pagination filters another repository and navigation discards a delayed page',async()=>{
    mode='pagination-scope';const {page,context}=await open();await more(page).click();await idle(page);
    assert.equal(await page.locator('#build-profile option').count(),2);
    mode='pagination-delay';const entered=new Promise(resolve=>gateEntered=resolve);await more(page).click();await entered;
    await openStudioSection(page, 'Profiles');gateResolve();
    await page.getByRole('heading',{name:'Profiles',exact:true}).waitFor();assert.equal(await page.locator('.build-page').count(),0);
    await context.close();mode='';
  });
  await check('pagination repository switch refuses a late API reply without rebinding CAS or leaking choices',async()=>{
    const source=(await f.repository.execute('build.context',{},f.context())).data;
    const {page,context}=await open();const count=operations.length;
    await page.evaluate(async({source,first,second})=>{
      const {buildView}=await import('/build.js'),{buildApi}=await import('/build-api.js');
      for(const failed of [false,true]){
      let epoch=0,bindings=0,reads=0,reply;
      function view(repository_id){
        const captured=epoch,ctx={state:{project_id:source.project_id,repository_id},href:s=>'#/'+s,pendingOperation:()=>null,
          check:()=>{if(captured!==epoch)throw new DOMException('Repository changed','AbortError');},
          profileBinding:async()=>{bindings++;},
          workRead:async(route,input)=>{
            if(route==='build/context')return {...source,repository_id,profiles:[]};
            if(repository_id==='switched-fixture')return {profiles:[],cursor:null};
            if(!input.cursor)return {profiles:[first],cursor:first.ref};
            reads++;return new Promise((resolve,reject)=>reply=failed?()=>reject(Object.assign(new Error('Late original repository failure'),{code:'INVALID_CURSOR'})):resolve);
          }};
        return buildView({...ctx,buildApi:buildApi(ctx)});
      }
      const old=view(source.repository_id);document.querySelector('main').replaceChildren(old);await old.start();
      document.querySelector('#build-profile').value=first.ref;
      document.querySelector('.build-page button').focus();
      [...old.querySelectorAll('button')].find(b=>b.textContent==='Load more profiles').click();
      if(reads!==1||bindings!==1)throw Error('Pagination rebound CAS or failed to enter');
      epoch++;old.dispose();const current=view('switched-fixture');document.querySelector('main').replaceChildren(current);await current.start();
      reply({profiles:[second],cursor:null});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(bindings!==2||document.querySelector('#build-profile').options.length!==1||document.querySelector('#build-profile').value!=='')throw Error('Old repository choices leaked');
      if(document.querySelector('.build-page').textContent.includes('BUILD_RESPONSE_MISMATCH'))throw Error('Late old error leaked');
      current.dispose();
      }
    },{source,first,second});
    assert.equal(operations.length,count);await context.close();assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  });
  await check('actual build attempt survives disk reopen',async()=>{await f.reopen();assert.equal((await f.repository.execute('build.inspect',{build_id:lostBuild},f.context())).data.phase,'completed');});
}finally{
  const fs=await import('node:fs/promises');
  await fs.writeFile(path.join(output,'checks.json'),JSON.stringify(checks,null,2));
  await fs.writeFile(path.join(output,'network.json'),JSON.stringify({requests,outside,pageErrors:errors},null,2));
  await browser.close();await configured.host.close();await unconfigured.host.close();configured.commands.close();unconfigured.commands.close();await f.repository.close();
}
console.log(checks.length+' real Local Build browser checks passed.');
