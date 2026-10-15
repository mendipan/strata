import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline packaging only. One split graph preserves shared profile/model code
// (including source-based archive pins and Error identity) across host and worker.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bundling relocates import.meta.url. Suppress imported executable entrypoints
// before esbuild can turn their source-file guards into host executable guards.
export function preserveCliBoundaries(entry) {
  return {name:'preserve-cli-boundaries',setup(builder) {
    builder.onLoad({filter:/src[\\/]local-broker\.ts$/},async({path:filename})=>{
      const contents=await readFile(filename,'utf8');
      const guard='if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {';
      if(!contents.includes(guard))throw Error('Broker CLI boundary changed.');
      return {contents:contents.replace(guard,'if(false){'),loader:'ts'};
    });
    builder.onLoad({filter:/scripts[\\/]studio-host\.ts$/},async({path:filename})=>{
      let contents=await readFile(filename,'utf8');
      if(entry!=='studio-host') {
        const previous=contents;
        contents=contents.replace(/if\s*\(process\.argv\[1\]\s*&&\s*path\.resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)\)\s*main\(\)/,'if(false)main()');
        if(contents===previous)throw Error('Host CLI boundary changed.');
      }
      return {contents,loader:'ts'};
    });
  }};
}

export function bundleStudioHost({sourceRoot=root,outdir=path.join(sourceRoot,'dist/scripts'),write=true}={}) {
  return build({absWorkingDir:sourceRoot,entryPoints:{'studio-host':'scripts/studio-host.ts',
    'runner-worker':'src/auth/runner-worker.ts'},outdir,bundle:true,splitting:true,
    chunkNames:'studio-runtime/[name]-[hash]',platform:'node',target:'node22',format:'esm',
    write,metafile:true,plugins:[preserveCliBoundaries('studio-host')]});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await bundleStudioHost();
