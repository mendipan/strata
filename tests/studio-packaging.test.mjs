import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import { bundleStudioHost, preserveCliBoundaries } from '../scripts/bundle-studio-host.mjs';
import { releaseBundles, releaseInventory, releaseManifest } from '../scripts/package-studio-release.mjs';
import { namespacePolicySchema } from '../dist/src/explorer/namespace-policy.js';
import { provisionFirstProject } from '../dist/src/explorer/first-project.js';
import { DEFAULT_WORKSPACE_LIMITS } from '../dist/src/explorer/workspace-policy.js';
import { digest } from '../dist/src/model.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=()=>mkdtemp(path.join(process.env.STRATA_TEST_TMP??tmpdir(),'strata-package-regression-'));
function assertNoBrokerCLI(files) {
  for(const file of files) {
    const source=Buffer.from(file.contents).toString('utf8');
    const ast=parse(source,{sourceType:'module'});
    function walk(node) {
      if(!node||typeof node!=='object'||['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))return;
      if(node.type==='IfStatement'&&node.test?.type==='BooleanLiteral') {walk(node.test.value?node.consequent:node.alternate);return;}
      if(node.type==='CallExpression'&&node.callee?.type==='Identifier')assert.notEqual(node.callee.name,'startLocalBroker');
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
    }
    walk(ast);
  }
}

test('standalone split graph suppresses the imported development broker CLI in memory',async()=>{
  const output=path.join(await temporary(),'never-written');
  const result=await bundleStudioHost({outdir:output,write:false});assertNoBrokerCLI(result.outputFiles);
  assert.ok(result.outputFiles.some(file=>file.path.endsWith('runner-worker.js')));
  assert.ok(result.outputFiles.some(file=>file.path.includes('studio-runtime')));
});
test('changed broker CLI guard fails packaging closed',async()=>{
  const directory=await temporary(),filename=path.join(directory,'local-broker.ts');await writeFile(filename,'// changed CLI boundary\n');
  const handlers=[];preserveCliBoundaries('studio-host').setup({onLoad(options,handler){handlers.push({options,handler});}});
  await assert.rejects(handlers[0].handler({path:filename}),/Broker CLI boundary changed/);
});
test('release inventory refuses the old worker-less graph and arbitrary generated directories',async()=>{
  const inventory=JSON.parse(await readFile(path.join(root,'deploy/studio/release-files.json'),'utf8'));
  assert.ok(releaseInventory(inventory).files.includes('dist/scripts/runner-worker.js'));
  assert.throws(()=>releaseInventory({...inventory,files:inventory.files.filter(file=>!file.endsWith('runner-worker.js'))}));
  assert.throws(()=>releaseInventory({...inventory,generated_directories:['../../private']}));
});
test('normal release graph and manifest retain every generated dependency and measure through the packaged checker',async()=>{
  const output=await temporary(),generated=await releaseBundles(root,output);assertNoBrokerCLI(generated.artifacts);
  await writeFile(path.join(output,'package.json'),'{"type":"module"}\n',{flag:'wx'});
  for(const file of generated.artifacts) {const target=path.join(output,file.name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.contents,{flag:'wx'});}
  // Load only the pure shared profile definitions, never a host executable.
  const runtime=generated.artifacts.find(file=>file.name.startsWith('dist/scripts/studio-runtime/'));
  const shared=await import(pathToFileURL(path.join(output,runtime.name)).href);
  const policy=namespacePolicySchema.parse({format:'strata-studio-namespace-policy/1',installation_id:'00000000-0000-4000-8000-000000000001',owner_id:'00000000-0000-4000-8000-000000000002',
    lineage_id:'00000000-0000-4000-8000-000000000003',account:'a'.repeat(32),namespace:'synthetic',lifetime:{mode:'until-revoked',expires_at:null},permissions:['discover','create','read','draft'],
    principal_id:'human',account_id:'owner',provider_contract:'development-name-addressed',operator_rule:'no-delete-recreate-or-rebind-during-write-or-reconciliation',
    automatic_creation_token:'discard-secret-and-allow-provider-expiry',automatic_token_max_lifetime_seconds:86400,limits:DEFAULT_WORKSPACE_LIMITS,max_projects:1,
    first_project:{format:'strata-studio-first-project/1',template:'collection-host/1',authority:'single-human-author-reviewer-validator-release',
      lifetime:{mode:'until',expires_at:new Date(Date.now()+3600_000).toISOString()},max_items:3,max_title_length:20}});
  const snapshot=shared.normalizeSnapshot(provisionFirstProject(policy,'synthetic-project','Packaging regression').baseline);
  const record=shared.profileFor('collection-host/1').materialize('SyntheticCandidate@1',{snapshot,state:'eligible_for_validation',fingerprint:digest(snapshot),
    input_fingerprint:digest(snapshot),provenance:{},impact:[],scope:'collection',diagnostics:[],obligations:shared.obligations(snapshot)});
  const worker=new Worker(pathToFileURL(path.join(output,'dist/scripts/runner-worker.js')),{workerData:{record}});
  try {
    const measured=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Packaged checker timeout')),10000);
      worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});});
    assert.equal(measured.ok,true);assert.ok(measured.evidence.results.length);assert.ok(measured.evidence.results.every(result=>result.passed));
  }finally{await worker.terminate();}
  const names=['package.json',...generated.artifacts.map(file=>file.name)],manifest=await releaseManifest(output,names,'a'.repeat(40),'b'.repeat(40),generated.bundleInputs);
  assert.deepEqual(manifest.files.map(file=>file.path),[...names].sort());assert.equal(manifest.activation_performed,false);
  assert.ok(manifest.bundle_inputs['runner-worker'].includes('src/auth/runner-worker.ts'));
  for(const file of manifest.files) {const bytes=await readFile(path.join(output,file.path));assert.equal(file.bytes,bytes.length);assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));}
});
import { inflateRawSync } from 'node:zlib';

function runnerZipMembers(raw) {
  const members=new Map();let offset=0;
  while(raw.readUInt32LE(offset)===0x04034b50) {
    assert.equal(raw.readUInt16LE(offset+8),8);
    const compressed=raw.readUInt32LE(offset+18),length=raw.readUInt32LE(offset+22),names=raw.readUInt16LE(offset+26),extra=raw.readUInt16LE(offset+28);
    const name=raw.subarray(offset+30,offset+30+names).toString('utf8');assert.ok(!members.has(name));assert.ok(!name.includes('..'));
    const start=offset+30+names+extra,data=inflateRawSync(raw.subarray(start,start+compressed));assert.equal(data.length,length);
    members.set(name,data);offset=start+compressed;
  }
  assert.equal(raw.readUInt32LE(offset),0x02014b50);return members;
}

test('release requires project and full upstream notices and rejects missing notices',async()=>{
  const inventory=JSON.parse(await readFile(path.join(root,'deploy/studio/release-files.json'),'utf8'));
  for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','licenses/BUNDLED_LICENSES.txt','licenses/babel-parser-8.0.6-LICENSE','licenses/bundle-evidence.json','licenses/runner-dependencies.json','licenses/claude-agent-sdk-0.3.296-LICENSE.md','licenses/claude-sdk-evidence.json']) {
    assert.ok(releaseInventory(inventory).files.includes(name));
    assert.throws(()=>releaseInventory({...inventory,files:inventory.files.filter(file=>file!==name)}));
  }
  const evidence=JSON.parse(await readFile(path.join(root,'licenses/bundle-evidence.json'),'utf8'));
  const zod=evidence.packages.find(p=>p.name==='zod');assert.equal(zod.version,'4.6.5');assert.equal(zod.license,'MIT');
  const notice=await readFile(path.join(root,'licenses/BUNDLED_LICENSES.txt'),'utf8');
  for(const p of evidence.packages)assert.ok(notice.includes(p.name+'@'+p.version));
  assert.ok(notice.includes((await readFile(path.join(root,'node_modules/zod/LICENSE'),'utf8')).trim()));
  const parser=await readFile(path.join(root,'licenses/babel-parser-8.0.6-LICENSE'));
  assert.equal(evidence.parser.license_sha256,createHash('sha256').update(parser).digest('hex'));
  assert.deepEqual(parser,await readFile(path.join(root,'node_modules/@babel/parser/LICENSE')));
});

test('runner ZIP contains exact notices and a complete independently checked per-file manifest',async()=>{
  const members=runnerZipMembers(await readFile(path.join(root,'dist/studio-agent-runner.zip')));
  const manifest=JSON.parse(members.get('manifest.json').toString('utf8'));
  assert.equal(manifest.format,'strata-studio-runner-package/1');assert.equal(manifest.optional_sdk_bundled,false);
  assert.deepEqual(new Set(members.keys()),new Set(['manifest.json',...manifest.files.map(file=>file.path)]));
  for(const file of manifest.files) {const bytes=members.get(file.path);assert.equal(file.bytes,bytes.length);assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));}
  for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','licenses/BUNDLED_LICENSES.txt','licenses/babel-parser-8.0.6-LICENSE','licenses/bundle-evidence.json','licenses/runner-dependencies.json','licenses/claude-agent-sdk-0.3.296-LICENSE.md','licenses/claude-sdk-evidence.json'])assert.deepEqual(members.get(name),await readFile(path.join(root,name)));
  const lock=JSON.parse(members.get('package-lock.json').toString('utf8')),inventory=JSON.parse(members.get('licenses/runner-dependencies.json').toString('utf8'));
  assert.equal(inventory.packages.length,Object.keys(lock.packages).length-1);
  for(const p of inventory.packages){assert.equal(p.version,lock.packages[p.location].version);assert.equal(p.declared_license,lock.packages[p.location].license);}
  assert.equal(inventory.packages.find(p=>p.name==='@anthropic-ai/claude-agent-sdk').declared_license,'SEE LICENSE IN README.md');
  assert.ok(inventory.packages.some(p=>p.declared_license==='BSD-3-Clause'));assert.ok(inventory.packages.some(p=>p.declared_license==='Unlicense'));
  assert.ok(![...members.keys()].some(name=>name.includes('node_modules')||/\.(exe|png|jpe?g)$/i.test(name)));
});
