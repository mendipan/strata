import { problem,safeJson } from './contract.js';
import { managedConnectionActionSchema } from './connection-manager.js';

// A memory-only owner session. No local file mutation, actor token or provider
// credential is accepted by this client.
export class OwnerSessionClient {
  private cookies=new Map<string,string>();private csrf='';
  readonly origin:string;
  constructor(origin:string,private transport:typeof fetch=fetch){const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)problem('INVALID_INPUT',400,'Use the exact approved Studio HTTPS origin.');this.origin=origin;}
  protected async send(route:string,input?:unknown){
    const text=input===undefined?undefined:JSON.stringify(input);if(text&&Buffer.byteLength(text)>1024)problem('INVALID_INPUT',400,'This owner action exceeds its bounded JSON size.');
    const response=await this.transport(this.origin+route,{method:text?'POST':'GET',headers:{accept:'application/json',cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(text?{origin:this.origin,'content-type':'application/json','x-studio-csrf':this.csrf}:{})},body:text,redirect:'manual',signal:AbortSignal.timeout(10000),cache:'no-store'});
    for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('='),name=pair.slice(0,i),secret=pair.slice(i+1);if(['__Host-strata_pre','__Host-strata_owner'].includes(name)){if(/^[A-Za-z0-9_-]{43}$/.test(secret))this.cookies.set(name,secret);else this.cookies.delete(name);}}
    if(!response.body)problem('SOURCE_UNAVAILABLE',503,'Studio response is unavailable.');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536)problem('READ_LIMIT',413,'Studio response exceeds its bounded metadata size.');chunks.push(next.value);}}finally{await reader.cancel();}
    let result:any;try{result=safeJson(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)),65536);}catch{problem('SOURCE_UNAVAILABLE',503,'Studio returned invalid bounded metadata.');}
    if(!response.ok)problem(typeof result?.error?.code==='string'?result.error.code:'SOURCE_UNAVAILABLE',response.status,'Studio refused this action. Inspect current status and the exact request outcome.');return result;
  }
  async login(username:string,password:string){try{const pre=await this.send('/studio/owner/session');this.csrf=pre.csrf;const session=await this.send('/studio/owner/login',{username,password});if(!session.authenticated||!session.csrf)problem('OWNER_SESSION_REQUIRED',401,'Studio owner sign-in was not accepted.');this.csrf=session.csrf;}catch(error){this.cookies.clear();this.csrf='';throw error;}}
  async close(){try{if(this.csrf)await this.send('/studio/owner/logout',{});}finally{this.cookies.clear();this.csrf='';}}
}
export class OwnerConnectionClient extends OwnerSessionClient {
  status(){return this.send('/studio/v1/owner/connections');}
  action(input:unknown){const parsed=managedConnectionActionSchema.safeParse(input);if(!parsed.success)problem('INVALID_INPUT',400,'Use a strict connection action with revision and request ID.');return this.send('/studio/v1/owner/connections',parsed.data);}
  outcome(id:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))problem('INVALID_INPUT',400,'Use the exact action UUID.');return this.send('/studio/v1/owner/connections/operations/'+id);}
}
