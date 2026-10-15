import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { fail } from '../src/model.js';

// One explicit native HTTPS request. No fetch/SDK dispatcher, retry agent, redirect or pagination helper.
export async function checklistNativeHttpOnce(input:Request):Promise<Response>{
  // Node HTTP debug output can include protected request headers. Never dispatch
  // from a debug-enabled process; certificate validation is explicit below.
  if(process.env.NODE_DEBUG?.trim())fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Protected HTTP dispatch refuses debug logging.');
  const url=new URL(input.url);
  if(url.origin!=='https://api.cloudflare.com'||!url.pathname.startsWith('/client/v4/accounts/')||input.redirect!=='manual')
    fail('CHECKLIST_MANAGEMENT_REFUSED',7,'Only the fixed approved API endpoint is admitted.');
  const body=input.body?await input.text():undefined;
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{method:input.method,headers:Object.fromEntries(input.headers),agent:false,rejectUnauthorized:true,signal:input.signal},response=>{
      try{
        // Every admitted management operation requires a bounded JSON response. Refuse no-body
        // statuses through the awaited promise, without constructing an invalid streaming Response.
        if(!response.statusCode||[204,205,304].includes(response.statusCode))throw new Error('Missing JSON-bearing HTTP status.');
        const headers=new Headers();for(const [name,value]of Object.entries(response.headers)){
          if(Array.isArray(value))for(const item of value)headers.append(name,item);else if(value!==undefined)headers.set(name,value);
        }
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>,{status:response.statusCode,statusText:response.statusMessage,headers}));
      }catch(error){
        try{response.destroy();}catch{/* Preserve the original awaited construction failure. */}
        reject(error);
      }
    });
    request.once('error',reject);
    request.end(body);
  });
}
