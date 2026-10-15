// Inventory-only static package regression. No production packaging, builds,
// provider, installed host, custody, credentials or writer are involved.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,lstat,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {startExplorer} from '../dist/src/explorer/host.js';
import {ExplorerReader} from '../dist/src/explorer/read.js';
import {TestSource,sample} from '../dist/tests/explorer-fixture.js';

const output=process.env.STRATA_STUDIO_PACKAGE_OUTPUT;
assert(output && path.isAbsolute(output) && process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE,
  'Explicit external evidence directory and an existing Playwright module are required.');
await mkdir(output,{recursive:true});
const inventory=JSON.parse(await readFile('deploy/studio/release-files.json','utf8'));
assert.equal(inventory.format,'strata-studio-code-inventory/1');
assert(Array.isArray(inventory.files) && new Set(inventory.files).size===inventory.files.length);
const assets=inventory.files.filter(file=>file.startsWith('explorer/'));
assert(assets.every(file=>/^explorer\/[\w-]+\.(html|js|css|svg)$/.test(file)));
const root=await mkdtemp(path.join(output,'static-package-'));
const checks=[],requests=[],outside=[],errors=[],files=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function copyAssets(target,omit){
  await mkdir(path.join(target,'explorer'),{recursive:true});
  for(const name of assets.filter(name=>name!==omit)){
    const source=path.resolve(name),destination=path.join(target,name),metadata=await lstat(source);
    assert(metadata.isFile() && !metadata.isSymbolicLink(),name);
    await copyFile(source,destination);
    const raw=await readFile(destination);
    assert.equal(hash(raw),hash(await readFile(source)),name);
    if(!omit)files.push({path:name,bytes:raw.length,sha256:hash(raw)});
  }
}
const closure=target=>build({entryPoints:[path.join(target,'explorer/app.js')],
  bundle:true,write:false,metafile:true,platform:'browser',format:'esm',target:'esnext',logLevel:'silent'});
async function check(name,fn){await fn();checks.push({name,passed:true});console.log('PASS '+name);}
let browser,context,page,host;
try{
  await check('fixed release inventory copies both eager Build imports with exact source bytes',async()=>{
    assert(assets.includes('explorer/build.js'));assert(assets.includes('explorer/build-api.js'));
    await copyAssets(root);
    // This is only the static subset copied by the release packager, not a full release.
    await writeFile(path.join(root,'manifest.json'),JSON.stringify({format:'strata-synthetic-static-package/1',files},null,2)+'\n');
  });
  await check('packaged app has a complete local module import closure',async()=>{
    const result=await closure(root),inputs=Object.keys(result.metafile.inputs).map(name=>path.resolve(name));
    for(const module of ['app','build','build-api','profiles','profile-api'])assert(inputs.includes(path.join(root,'explorer',module+'.js')),module);
    const shipped=new Set(files.map(file=>path.join(root,file.path)));
    assert(inputs.every(name=>shipped.has(name)),'Every resolved browser input must come from the package inventory.');
    const html=await readFile(path.join(root,'explorer/index.html'),'utf8');
    for(const [,url] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g))assert(shipped.has(path.join(root,'explorer',url.slice(1))),url);
  });
  for(const omitted of ['explorer/build.js','explorer/build-api.js']){
    await check('missing '+omitted+' fails the package import closure',async()=>{
      const negative=await mkdtemp(path.join(output,'missing-module-'));await copyAssets(negative,omitted);
      await assert.rejects(closure(negative),error=>error.errors?.some(row=>row.text.includes(path.basename(omitted))));
    });
  }
  await check('inventory-only package serves both Build modules and mounts the real Studio shell',async()=>{
    const reader=new ExplorerReader(new TestSource(await sample()));await reader.refresh();
    host=await startExplorer(reader,{assets:path.join(root,'explorer')});
    const {chromium}=await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
    browser=await chromium.launch({channel:'msedge',headless:true});context=await browser.newContext({viewport:{width:1280,height:900}});
    context.setDefaultTimeout(15000);
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());if(url.origin!==host.origin){outside.push(url.origin);return route.abort();}
      requests.push({path:url.pathname,method:route.request().method()});return route.continue();
    });
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error' && !message.text().startsWith('Failed to load resource:'))errors.push(message.text());});
    for(const module of ['build','build-api']){
      const response=await context.request.get(host.origin+'/'+module+'.js');assert.equal(response.status(),200);
      assert.equal(await response.text(),await readFile(path.join(root,'explorer',module+'.js'),'utf8'));
    }
    await page.goto(host.launchUrl);
    for(const section of ['Profiles','Build'])await page.locator('#sidebar').getByRole('link',{name:section,exact:true,includeHidden:true}).waitFor({state:'attached'});
    await page.waitForFunction(()=>!!document.querySelector('main h1'));
    await page.getByRole('heading',{name:'Choose a Release to explore.',exact:true}).waitFor();
    assert(!(await page.locator('main').innerText()).includes('Connecting to the local read host'));
    assert.equal(await page.title(),'Strata Studio');
  });
  await check('packaged Build page mounts with honest unavailable execution and no module errors',async()=>{
    await openStudioSection(page, 'Build');
    await page.getByRole('heading',{name:'Build',exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.build-page')?.getAttribute('aria-busy')==='false');
    assert(await page.getByRole('button',{name:'Prepare build',exact:true}).isDisabled());
    assert(await page.getByRole('button',{name:'Build on Studio host',exact:true}).isDisabled());
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,'packaged-build.png'),fullPage:true});
    assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
    for(const module of ['build','build-api'])assert(requests.some(row=>row.path==='/'+module+'.js'));
  });
}finally{
  // Quiesce the disposable browser before closing the host. This does not fix
  // the existing Profiles restart/shutdown stall in its unmodified harness.
  if(page)await page.goto('about:blank').catch(()=>{});
  if(context)await context.close();if(browser)await browser.close();if(host)await host.close();
  await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,files,packageRoot:root,
    scope:'Fixed-inventory static subset; real shell/host, synthetic read-only source. Not a full production package or deployment.',
    shutdown:'Browser quiesced before host close; existing unmodified Profiles shutdown stall remains separate.'},null,2)+'\n');
  await writeFile(path.join(output,'network.json'),JSON.stringify({requests,outside,pageErrors:errors},null,2)+'\n');
}
console.log(checks.length+' packaging/import-closure checks passed.');
