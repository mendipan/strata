import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out'||!path.isAbsolute(args[1]))throw Error('Explicit absolute output directory required');
const out=args[1];await fs.mkdir(out,{recursive:true});
if((await fs.readdir(out)).length)throw Error('New empty package directory required');
await build({absWorkingDir:root,entryPoints:['scripts/studio-namespace-conformance.ts'],bundle:true,platform:'node',format:'esm',target:'node22',
  outfile:path.join(out,'studio-namespace-conformance.mjs'),plugins:[{name:'qualified-imported-cli-boundaries',setup(b){
    b.onLoad({filter:/scripts[\\/]studio-host\.ts$/},async a=>{const source=await fs.readFile(a.path,'utf8'),edited=source.replace(/if\s*\(process\.argv\[1\]\s*&&\s*path\.resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)\)\s*main\(\)/,'if(false)main()');if(edited===source)throw Error('Host CLI boundary differs');return{contents:edited,loader:'ts'};});
    b.onLoad({filter:/src[\\/]local-broker\.ts$/},async a=>{const source=await fs.readFile(a.path,'utf8'),guard='if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {';if(source.split(guard).length!==2)throw Error('Broker CLI boundary differs');return{contents:source.replace(guard,'if(false){'),loader:'ts'};});
  }}]});
for(const name of ['namespace-conformance.py','namespace-mode.py'])await fs.copyFile(path.join(root,'deploy/studio',name),path.join(out,name));
const files=[];
for(const name of ['namespace-conformance.py','namespace-mode.py','studio-namespace-conformance.mjs']){const raw=await fs.readFile(path.join(out,name));files.push({name,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});}
const manifest=Buffer.from(JSON.stringify({format:'strata-studio-namespace-conformance-package/1',source_commit:'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',files},null,2)+'\n');
await fs.writeFile(path.join(out,'manifest.json'),manifest);console.log(JSON.stringify({package:out,package_sha256:createHash('sha256').update(manifest).digest('hex'),credential_material_packaged:false}));
