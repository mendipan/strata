// Check product documentation/UI targets and fragments without contacting a host.
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd(), skip=new Set(['.git','node_modules','dist','.strata','.wrangler','.playwright-mcp','output','.local','qa','private','external-projects','local-records']);
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(skip.has(entry.name)||entry.isSymbolicLink())continue;const f=path.join(dir,entry.name);if(entry.isDirectory())walk(f);else if(/\.(md|html|svg)$/i.test(f))files.push(f);}}
walk(root);
const ids=new Map(), failures=[];let checked=0;
const relative=f=>path.relative(root,f).replaceAll('\\','/');
function anchors(file){if(ids.has(file))return ids.get(file);const text=fs.readFileSync(file,'utf8'), found=new Set([...text.matchAll(/\bid=["']([^"']+)["']/g)].map(m=>m[1]));
 if(file.endsWith('.md')){const counts=new Map();for(const m of text.replace(/```[\s\S]*?```/g,'').matchAll(/^#{1,6}\s+(.+)$/gm)){const slug=m[1].trim().toLowerCase().replace(/<[^>]*>/g,'').replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/\s/g,'-');const n=counts.get(slug)||0;counts.set(slug,n+1);found.add(slug+(n?'-'+n:''));}}
 ids.set(file,found);return found;}
function check(file,url){url=url.trim().replace(/^<|>$/g,'');const repo='https://github.com/mendipan/strata/blob/main/';let fromRepo=false;if(url.startsWith(repo)){url=url.slice(repo.length);fromRepo=true;}
 if(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)||!url||url.includes('${'))return;
 const [raw,fragment]=url.split('#');let name;try{name=decodeURIComponent(raw.split('?')[0]);}catch{return;}
 const webRoot='explorer';
 const target=fromRepo?path.resolve(root,name):name.startsWith('/')?path.join(root,webRoot,name):name?path.resolve(path.dirname(file),name):file;
 checked++;
 if(!fs.existsSync(target)){failures.push(`${relative(file)} -> missing ${url}`);return;}
 if(fragment&&/\.(md|html|svg)$/i.test(target)&&!anchors(target).has(decodeURIComponent(fragment)))failures.push(`${relative(file)} -> missing fragment ${url}`);
}
for(const file of files){let text=fs.readFileSync(file,'utf8');if(file.endsWith('.md')){text=text.replace(/```[\s\S]*?```/g,'');for(const m of text.matchAll(/!?\[[^\]\n]+\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g))check(file,m[1]);for(const m of text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm))check(file,m[1]);}
 else for(const m of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g))check(file,m[1]);}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}console.log(JSON.stringify({files:files.length,links:checked,failures:failures.length}));
