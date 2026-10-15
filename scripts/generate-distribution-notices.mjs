import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { releaseBundles } from './package-studio-release.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const generated = await releaseBundles(process.cwd(), path.resolve('dist/notice-audit'));
const runner = await build({entryPoints:['scripts/studio-agent-runner.ts'],bundle:true,platform:'node',format:'esm',target:'node22',write:false,metafile:true});
const worker = JSON.parse(await readFile('dist/studio-agent-worker/bundle-meta.json','utf8'));
const inputs = new Set([...Object.values(generated.bundleInputs).flat(), ...Object.keys(runner.metafile.inputs), ...Object.keys(worker.inputs)]);
const roots = new Set();
for (const input of inputs) {
  const normalized=input.replaceAll('\\','/');
  const at=normalized.lastIndexOf('node_modules/');
  if(at<0)continue;
  const parts=normalized.slice(at+13).split('/');
  const count=parts[0].startsWith('@')?2:1;
  roots.add(normalized.slice(0,at+13)+parts.slice(0,count).join('/'));
}
const sourceLock=JSON.parse(await readFile("package-lock.json","utf8"));
const packages=[];
for (const root of [...roots].sort()) {
  const raw=await readFile(path.join(root,'package.json'));const meta=JSON.parse(raw);
  const location=path.relative(process.cwd(),path.resolve(root)).replaceAll('\\','/');
  if(sourceLock.packages[location]?.version!==meta.version)throw Error('Bundled dependency differs from lockfile: '+meta.name);
  const names=(await readdir(root)).filter(name=>/^(licen[cs]e|notice|copying|copyright)([.-]|$)/i.test(name)).sort();
  if(!names.length)throw Error('Missing bundled upstream license: '+meta.name);
  const licenses=[];
  for(const name of names){const bytes=await readFile(path.join(root,name));licenses.push({file:name,sha256:sha(bytes),text:bytes.toString('utf8')});}
  packages.push({name:meta.name,version:meta.version,license:meta.license,package_json_sha256:sha(raw),licenses});
}
packages.sort((a,b)=>a.name.localeCompare(b.name));
await writeFile('licenses/BUNDLED_LICENSES.txt','Bundled upstream licenses and notices\nGenerated from actual host, owner, checker, runner and Worker bundle inputs.\n\n'+packages.map(p=>`===== ${p.name}@${p.version} (${p.license}) =====\n`+p.licenses.map(l=>`--- ${l.file} ---\n${l.text.trim()}\n`).join('\n')).join('\n'));
const lock=JSON.parse(await readFile('deploy/studio-agent-runner/package-lock.json','utf8'));
const runnerInventory=Object.entries(lock.packages).filter(([name])=>name).map(([location,p])=>({location,name:location.slice(location.lastIndexOf('node_modules/')+13),version:p.version,declared_license:p.license??'UNDECLARED',optional:p.optional??false,peer:p.peer??false}));
await writeFile('licenses/runner-dependencies.json',JSON.stringify({format:'strata-runner-dependency-inventory/1',source:'deploy/studio-agent-runner/package-lock.json',bundled_in_runner:{zod:packages.find(p=>p.name==='zod').version},sdk_installed_separately:true,packages:runnerInventory},null,2)+'\n');
const parser=JSON.parse(await readFile('node_modules/@babel/parser/package.json','utf8'));
if(parser.version!=='8.0.6'||parser.license!=='MIT')throw Error('Parser license evidence changed');
const parserLicense=await readFile('node_modules/@babel/parser/LICENSE');
if(!parserLicense.equals(await readFile('licenses/babel-parser-8.0.6-LICENSE')))throw Error('Parser license bytes changed');
await writeFile('licenses/bundle-evidence.json',JSON.stringify({format:'strata-bundle-license-evidence/1',packages:packages.map(({licenses,...p})=>({...p,licenses:licenses.map(({text,...l})=>l)})),parser:{name:parser.name,version:parser.version,license:parser.license,license_sha256:sha(parserLicense)}},null,2)+'\n');
console.log(JSON.stringify({bundled_packages:packages.map(p=>p.name+'@'+p.version),runner_lock_entries:runnerInventory.length}));
