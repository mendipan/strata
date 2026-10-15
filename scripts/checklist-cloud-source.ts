import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fail } from '../src/model.js';

// A finite local code inventory, not a scan of operator config/cache/credentials.
// Package trees intentionally over-cover dynamic chunks, data/native assets and require paths.
export async function checklistToolExecutionFiles(repository:string) {
  const installedRoot=await realpath(path.join(repository,'node_modules'));
  const rootRequire=createRequire(path.join(repository,'package.json'));
  const files=new Set<string>(),packages=new Set<string>();
  function inside(file:string){const relative=path.relative(installedRoot,file);if(relative.startsWith('..')||path.isAbsolute(relative))fail('CHECKLIST_SOURCE_REFUSED',6,'Tool dependency escaped the installed dependency root.');}
  async function resolvePackage(name:string,request:NodeJS.Require):Promise<string>{
    // Native/data-only optional packages need not export a JS main or package.json.
    for(const search of request.resolve.paths(name)??[]){
      const candidate=path.join(search,name),relative=path.relative(installedRoot,candidate);
      if(relative.startsWith('..')||path.isAbsolute(relative))continue;
      try{const p=JSON.parse(await readFile(path.join(candidate,'package.json'),'utf8'));if(p.name===name){const root=await realpath(candidate);inside(root);return root;}}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    let entry:string;
    try{entry=request.resolve(name+'/package.json');}catch{entry=request.resolve(name);}
    let current=path.dirname(await realpath(entry));
    while(true){
      inside(current);
      try{const p=JSON.parse(await readFile(path.join(current,'package.json'),'utf8'));if(p.name===name)return current;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(current===installedRoot||path.dirname(current)===current)fail('CHECKLIST_SOURCE_REFUSED',6,'Installed tool package root could not be pinned.');current=path.dirname(current);
    }
  }
  async function walk(directory:string){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.name==='node_modules')continue; // resolved recursively by each owning package's actual runtime dependency resolution
      const file=path.join(directory,entry.name);inside(file);
      if(entry.isSymbolicLink())fail('CHECKLIST_SOURCE_REFUSED',6,'Installed package contains an unqualified link.');
      if(/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.npmrc)$/i.test(entry.name))fail('CHECKLIST_SOURCE_REFUSED',6,'Credential-like package file is outside code-freeze scope.');
      if(entry.isDirectory())await walk(file);else if(entry.isFile()){files.add(file);if(files.size>30000)fail('CHECKLIST_SOURCE_REFUSED',6,'Tool code inventory exceeded its finite file guard.');}
    }
  }
  async function visit(name:string,request:NodeJS.Require){
    const root=await resolvePackage(name,request);if(packages.has(root))return;packages.add(root);
    if(packages.size>2048)fail('CHECKLIST_SOURCE_REFUSED',6,'Tool dependency inventory exceeded its finite package guard.');
    const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    await walk(root);const scoped=createRequire(path.join(root,'package.json'));
    const optional=new Set(Object.keys(metadata.optionalDependencies??{}));
    const peers=new Set(Object.keys(metadata.peerDependencies??{}));
    for(const dependency of Object.keys({...metadata.dependencies,...metadata.optionalDependencies,...metadata.peerDependencies}).sort()){
      try{await visit(dependency,scoped);}catch(error){if((optional.has(dependency)||peers.has(dependency))&&(error as NodeJS.ErrnoException).code==='MODULE_NOT_FOUND')continue;throw error;}
    }
  }
  for(const [name,version]of [['wrangler','4.147.0'],['cf','1.0.0-beta.12'],['esbuild','0.28.2'],['@babel/parser','8.0.6']]){
    const root=await resolvePackage(name,rootRequire),metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    if(metadata.version!==version)fail('CHECKLIST_SOURCE_REFUSED',6,'Installed execution tool differs from its pinned reviewed version.');
    await visit(name,rootRequire);
  }
  const aliases:Record<string,string>={};
  for(const file of files){
    const relative=path.relative(installedRoot,file).replaceAll('\\','/');
    // Keep portable package-relative paths; the dependency junction is read-only and is never changed.
    aliases[path.join(repository,'node_modules',relative)]=file;
  }
  return{files:Object.keys(aliases).sort(),package_count:packages.size,file_count:files.size};
}
