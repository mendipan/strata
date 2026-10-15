// Local code packaging only. No service, ingress, provider or installer actions.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleStudioHost, preserveCliBoundaries } from './bundle-studio-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function releaseInventory(value) {
  const inventory=value;
  if(inventory?.format!=='strata-studio-code-inventory/1'||
      JSON.stringify(inventory.generated_directories)!==JSON.stringify(['dist/scripts/studio-runtime'])||
      !Array.isArray(inventory.files)||new Set(inventory.files).size!==inventory.files.length||
      !['licenses/babel-parser-8.0.6-LICENSE','licenses/bundle-evidence.json','licenses/claude-sdk-evidence.json','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','licenses/BUNDLED_LICENSES.txt','licenses/runner-dependencies.json','licenses/claude-agent-sdk-0.3.296-LICENSE.md','dist/scripts/studio-host.js','dist/scripts/studio-owner-control.js','dist/scripts/runner-worker.js'].every(name=>inventory.files.includes(name))||
      inventory.files.some(name=>typeof name!=='string'||!/^(LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md|licenses\/(BUNDLED_LICENSES\.txt|runner-dependencies\.json|claude-agent-sdk-0\.3\.296-LICENSE\.md|babel-parser-8\.0\.6-LICENSE|bundle-evidence\.json|claude-sdk-evidence\.json)|package\.json|explorer\/[\w-]+\.(html|js|css|svg)|dist\/scripts\/(studio-(host|owner-control)|runner-worker)\.js|dist\/src\/studio-agents\/[\w-]+\.js|dist\/studio-agent-worker\/worker\.mjs|dist\/studio-agent-runner\.zip)$/.test(name)))
    throw Error('Invalid fixed code inventory.');
  return inventory;
}

export async function releaseBundles(sourceRoot,output) {
  const host=await bundleStudioHost({sourceRoot,outdir:path.join(output,'dist/scripts'),write:false});
  const owner=await build({absWorkingDir:sourceRoot,entryPoints:['scripts/studio-owner-control.ts'],
    outfile:path.join(output,'dist/scripts/studio-owner-control.js'),bundle:true,platform:'node',
    format:'esm',target:'node22',write:false,metafile:true,plugins:[preserveCliBoundaries('studio-owner-control')]});
  const artifacts=[...host.outputFiles,...owner.outputFiles].map(file=>({
    name:path.relative(output,file.path).split(path.sep).join('/'),contents:file.contents}));
  const entries=['dist/scripts/studio-host.js','dist/scripts/studio-owner-control.js','dist/scripts/runner-worker.js'];
  if(new Set(artifacts.map(file=>file.name)).size!==artifacts.length||
      !entries.every(name=>artifacts.some(file=>file.name===name))||
      !artifacts.some(file=>file.name.startsWith('dist/scripts/studio-runtime/'))||
      artifacts.some(file=>!entries.includes(file.name)&&!/^dist\/scripts\/studio-runtime\/chunk-[A-Z0-9]{8}\.js$/.test(file.name)))
    throw Error('Unexpected generated Studio code artifact.');
  return {artifacts,bundleInputs:{'studio-host':Object.keys(host.metafile.inputs).sort(),
    'runner-worker':Object.keys(host.metafile.inputs).sort(),'studio-owner-control':Object.keys(owner.metafile.inputs).sort()}};
}

export async function releaseManifest(output,names,source,tree,bundleInputs) {
  const files=[];
  for(const name of [...names].sort()) {
    const raw=await readFile(path.join(output,name));
    files.push({path:name,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});
  }
  return {format:'strata-studio-code-release/1',source_commit:source,source_tree:tree,
    mode:'hosted-namespace',code_only:true,activation_performed:false,files,bundle_inputs:bundleInputs};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !path.isAbsolute(args[1])) {
    throw Error('Use --output with a new absolute local directory.');
  }
  const output = path.resolve(args[1]);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const source = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw Error('Package only a clean committed candidate.');
  const inventory = releaseInventory(JSON.parse(await readFile(path.join(root, 'deploy/studio/release-files.json'), 'utf8')));
  // Check every copied input before creating output. Generate checker and host as
  // one guarded graph; never copy arbitrary preexisting runtime chunks from dist.
  const bundled = new Set(['dist/scripts/studio-host.js', 'dist/scripts/studio-owner-control.js','dist/scripts/runner-worker.js']);
  for (const name of inventory.files.filter(name => !bundled.has(name))) {
    const metadata = await lstat(path.join(root, name));
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw Error('Missing regular code artifact: ' + name);
  }
  const generated=await releaseBundles(root,output);
  await mkdir(output); // Refuse an existing destination, including private state.
  for(const file of generated.artifacts) {
    const destination=path.join(output,file.name);await mkdir(path.dirname(destination),{recursive:true});
    await writeFile(destination,file.contents,{flag:'wx'});
  }
  for (const name of inventory.files.filter(name => !bundled.has(name))) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, name), destination);
  }
  if (git('rev-parse', 'HEAD') !== source || git('status', '--porcelain')) throw Error('Source changed while packaging.');
  const names=[...inventory.files.filter(name=>!bundled.has(name)),...generated.artifacts.map(file=>file.name)];
  const manifest=await releaseManifest(output,names,source,git('rev-parse','HEAD^{tree}'),generated.bundleInputs);
  await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({ source, output, files: manifest.files.length, code_only: true, activation_performed: false }));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
