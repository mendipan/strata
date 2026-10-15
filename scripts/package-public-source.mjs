// Export only a clean committed tree. Never copy a checkout or publish old refs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output'||!path.isAbsolute(args[1]))throw Error('Use --output with a new absolute directory.');
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:64*1024**2});
const source=git('rev-parse','HEAD').toString().trim();
if(git('status','--porcelain').length)throw Error('Export only a clean committed candidate.');
const expected=git('ls-tree','-r','--name-only',source).toString('utf8').trim().split('\n').sort();
const forbidden=/(^|\/)(\.git|\.local|\.strata|\.wrangler|node_modules|private|local-records|external-projects)(\/|$)|\.(png|jpe?g|gif|webp|zip|tgz|gz|exe|pdf)$/i;
if(expected.some(name=>forbidden.test(name)))throw Error('Unreviewed state or binary in source inventory.');
const tar=git('archive','--format=tar',source),files=[];
for(let offset=0;offset+512<=tar.length;) {
  const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
  const field=(start,length)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
  const prefix=field(345,155),name=(prefix?prefix+'/':'')+field(0,100),size=parseInt(field(124,12).trim(),8)||0,type=field(156,1);
  const content=tar.subarray(offset+512,offset+512+size);offset+=512+Math.ceil(size/512)*512;
  if(type==='g'||type==='x'||type==='5')continue;
  if(type!==''&&type!=='0')throw Error('Nonregular source entry.');
  if(name.endsWith('.bin')&&(name!=='tests/fixtures/adoption/protected.bin'||!content.equals(Buffer.from([0,1,2,127,128,255]))))throw Error('Unreviewed binary fixture.');
  files.push({path:name,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});
}
files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
if(JSON.stringify(files.map(f=>f.path))!==JSON.stringify(expected))throw Error('Archive membership differs from reviewed Git tree.');
const output=path.resolve(args[1]);await mkdir(output);
git('archive','--format=zip','--output',path.join(output,'public-source.zip'),source);
const archive=await readFile(path.join(output,'public-source.zip'));
const report={format:'strata-public-source-inventory/1',source_commit:source,source_tree:git('rev-parse','HEAD^{tree}').toString().trim(),history_included:false,
  archive_sha256:createHash('sha256').update(archive).digest('hex'),files};
if(git('rev-parse','HEAD').toString().trim()!==source||git('status','--porcelain').length)throw Error('Source changed during export.');
await writeFile(path.join(output,'public-files.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({source,files:files.length,archive_sha256:report.archive_sha256,history_included:false}));
