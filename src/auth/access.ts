import type { IncomingMessage,ServerResponse } from 'node:http';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { HostIssuer } from './host-issuer.js';
import { HostedAccess,type HostedOptions,type HostedReadAccess } from '../explorer/hosted.js';
import { problem } from '../explorer/contract.js';
const name='__Host-strata_actor';
const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// A separate named-account boundary. The shared H1 reader is never an actor.
export class ActorAccess implements HostedReadAccess {
  readonly origin:string;private boundaryAccess:HostedAccess;private csrf=new Map<string,{value:string;idle:number}>();private attempts:number[]=[];
  constructor(readonly issuer:HostIssuer,options:HostedOptions,private refresh=()=>{},private now=Date.now){this.boundaryAccess=new HostedAccess({...options,accessKeySha256:undefined});this.origin=this.boundaryAccess.origin;}
  boundary(req:IncomingMessage){this.boundaryAccess.boundary(req);}
  private cli(req:IncomingMessage){return req.headers['x-studio-client']==='cli'&&!req.headers.origin&&!req.headers['sec-fetch-site']&&!req.headers.cookie;}
  token(req:IncomingMessage){if(this.cli(req)){const h=req.headers.authorization;if(typeof h==='string'&&/^Bearer [A-Za-z0-9_-]{43}$/.test(h))return h.slice(7);return ''; }if(req.headers.authorization)problem('SESSION_REQUIRED',401,'Use the configured actor session.');const list=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));return list.length===1?list[0].slice(name.length+1):'';}
  require(req:IncomingMessage){this.refresh();const t=this.token(req);try{const owner=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-strata_owner='));this.issuer.assertParentCookie(t,owner.length===1?owner[0].slice('__Host-strata_owner='.length):'');this.issuer.resolve(t);}catch(e:any){if(e.code==='AUTHENTICATION_REQUIRED')problem('SESSION_REQUIRED',401,'Sign in to Studio again.');throw e;}if(this.cli(req))return;const s=this.csrf.get(t);if(!s||s.idle<=this.now()){this.issuer.logout(t);this.csrf.delete(t);problem('SESSION_REQUIRED',401,'Sign in to Studio again.');}if(req.method==='POST'&&!equal(String(req.headers['x-studio-csrf']??''),s.value))problem('LOCAL_ORIGIN',403,'Use the current actor request token.');s.idle=this.now()+15*60*1000;}
  status(req:IncomingMessage){this.refresh();try{this.require(req);const c=this.issuer.resolve(this.token(req));return {mode:'hosted-actor',configured:this.issuer.configured,authenticated:true,csrf:this.csrf.get(this.token(req))?.value??null,principal_id:c.principal_id,principal_kind:c.principal_kind};}catch{return {mode:'hosted-actor',configured:this.issuer.configured,authenticated:false,csrf:null};}}
  login(req:IncomingMessage,res:ServerResponse,input:any){this.refresh();for(const [t]of this.csrf){try{const owner=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-strata_owner='));this.issuer.assertParentCookie(t,owner.length===1?owner[0].slice('__Host-strata_owner='.length):'');this.issuer.resolve(t);}catch{this.csrf.delete(t);}}this.attempts=this.attempts.filter(x=>this.now()-x<60000);if(this.attempts.length>=10)problem('LOGIN_LIMIT',429,'Wait before trying actor sign-in again.');this.attempts.push(this.now());if(!input||typeof input!=='object'||Object.keys(input).sort().join('|')!=='access_key|account_id')problem('INVALID_INPUT',400,'Supply the provisioned account and key.');let t='';try{t=this.issuer.login(input.account_id,input.access_key);this.issuer.resolve(t);}catch{if(t)this.issuer.logout(t);problem('SESSION_REQUIRED',401,'Actor sign-in was not accepted.');}const old=this.token(req);if(old){this.issuer.logout(old);this.csrf.delete(old);}const csrf=Buffer.from(randomBytes(32)).toString('base64url');this.csrf.set(t,{value:csrf,idle:this.now()+15*60*1000});if(this.cli(req))return {token:t,expires_in:1800,project_id:this.issuer.projectId};res.setHeader('set-cookie',`${name}=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`);return {mode:'hosted-actor',configured:true,authenticated:true,csrf};}
  logout(req:IncomingMessage,res:ServerResponse){this.require(req);const t=this.token(req);this.issuer.logout(t);this.csrf.delete(t);if(!this.cli(req))res.setHeader('set-cookie',`${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);return {authenticated:false};}
  async exchangeOwner(req:IncomingMessage,res:ServerResponse,input:unknown){
    if(this.cli(req)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)problem('INVALID_INPUT',400,'Owner actor exchange accepts one empty browser request.');
    for(const [token,s]of this.csrf)try{if(s.idle<=this.now())throw Error();this.issuer.resolve(token);}catch{this.csrf.delete(token);this.issuer.logout(token);}
    const token=await this.issuer.loginOwner(req),old=this.token(req);if(old){this.issuer.logout(old);this.csrf.delete(old);}
    const csrf=Buffer.from(randomBytes(32)).toString('base64url');this.csrf.set(token,{value:csrf,idle:this.now()+15*60_000});
    const c=this.issuer.resolve(token);res.setHeader('set-cookie',`${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`);
    return {mode:'hosted-actor',configured:true,authenticated:true,csrf,principal_id:c.principal_id,principal_kind:c.principal_kind};
  }
  clear(){this.csrf.clear();this.issuer.clear();}
  // Owner metadata requests have owner CSRF. Project POST requests still use
  // require(), which independently enforces actor CSRF.
  metadata(req:IncomingMessage){try{const token=this.token(req),owner=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-strata_owner='));
    this.issuer.assertParentCookie(token,owner.length===1?owner[0].slice('__Host-strata_owner='.length):'');const c=this.issuer.resolve(token),session=this.csrf.get(token);
    if(!session||session.idle<=this.now())return {authenticated:false};return {authenticated:true,principal_id:c.principal_id,principal_kind:c.principal_kind};
  }catch{return {authenticated:false};}}
}
