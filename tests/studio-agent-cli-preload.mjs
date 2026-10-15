// Child-process synthetic transport only. All HTTPS URLs stay pinned; the
// owner's public fixture password arrives via stdin, never a file/URL/env/log.
import { request } from 'node:http';
const loopback=process.env.STRATA_AGENT_CLI_FIXTURE_LOOPBACK;
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(loopback??''))throw Error('Missing bounded CLI fixture');
globalThis.fetch=async(input,options={})=>{
  const url=new URL(String(input));if(url.origin!=='https://studio.example.test'||!/^\/studio\/(owner\/(session|login|logout)|v1\/owner\/agents(?:\/operations\/[a-f0-9-]{36})?)$/.test(url.pathname)||url.search)throw Error('External fixture transport refused');
  return new Promise((resolve,reject)=>{
    const req=request(loopback+url.pathname,{method:options.method,headers:{...Object.fromEntries(new Headers(options.headers)),host:'studio.example.test','x-forwarded-proto':'https'},signal:options.signal},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const headers=new Headers();for(const [key,value]of Object.entries(res.headers))for(const item of Array.isArray(value)?value:[value])if(item!==undefined)headers.append(key,item);resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers}));});});req.on('error',reject);req.end(options.body);
  });
};
