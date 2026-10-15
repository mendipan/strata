import { z } from 'zod';
import path from 'node:path';
import { localOperationClient } from '../commands/client.js';
import { runNodeCommand, safePath } from '../commands/node.js';
import { canonical, digest, fail, parse, StrataError, type Records } from '../model.js';
import { validateEnvelope, MAX_REQUEST_BYTES } from '../security.js';
import { MUTATIONS } from '../service.js';
import type { ExplorerSource } from './source.js';
import { ExplorerReader } from './read.js';
import { problem } from './contract.js';
import { PROFILES_BUILD_COMMANDS, isProfilesBuildCommand, profilesBuildCapabilityRows, type ProfilesBuildStudioPort } from '../build-studio.js';

export const STUDIO_COMMANDS = [...PROFILES_BUILD_COMMANDS,'evidence.assemble','inspect','status','diff','conflicts','capabilities','review.inbox','review.state','layer.preview','operation.inspect','init','mediation.install','evidence.run','criterion.review','layer.create','layer.revise','layer.restore','layer.publish','content.review','compose','conflicts.report','resolve','mediation.prepare','mediation.respond','reports.dispose','approve','materialize','realization.register','validate','release','context.show','context.use'] as const;
const requestSchema=z.object({command:z.enum(STUDIO_COMMANDS),input:z.record(z.string(),z.unknown()),idempotency_key:z.string().min(1).max(100),expected_generation:z.string().regex(/^[a-f0-9]{64}$/),expected_policy:z.string().min(1).max(256),dry_run:z.boolean().optional()}).strict();
export class StudioCommands {
  readonly reader:ExplorerReader;
  readonly source:ExplorerSource;
  private policy:string|null=null;
  private principal:string|null=null;
  private active=true;
  private readAuthorityBinding:string|null=null;
  constructor(readonly config:any,private readonly selector:string,readonly projectRoot:string,private readonly allowed:string[],private readonly outputSlots:Record<string,string>={},private readonly trust:'local-fixture'|'host-authenticated'|'legacy-history-authenticated-authoring'='local-fixture',private readonly authorizeRead?:()=>string,private readonly trustedClient?:(options:any)=>(command:string,input:any)=>Promise<any>,retainedRecords?:Records,private readonly localBuild?:ProfilesBuildStudioPort) {
    if(trust!=='local-fixture'&&!authorizeRead)fail('HOSTED_AUTHORITY_REQUIRED',4,'Authenticated Studio reads require a current server-side authority check.');
    if(allowed.some(op=>!(STUDIO_COMMANDS as readonly string[]).includes(op)))fail('UNSUPPORTED_CAPABILITY',8,'Studio write configuration contains an unsupported operation.');
    const source:ExplorerSource={
      connection:{connection_id:'local-broker',project_id:config.project_id,display_name:'Local Strata project',model_version:config.model_version,...(localBuild?{repository_id:localBuild.repository.repository_id}:{})},
      assertAuthorized:()=>{
        if(!this.active)problem('SOURCE_AUTH',403,'This local writer session is closed.');
        if(this.authorizeRead)try{const binding=this.authorizeRead();if(this.readAuthorityBinding!==null&&binding!==this.readAuthorityBinding)this.reader.invalidate();this.readAuthorityBinding=binding;}catch(error){this.reader.invalidate();throw error;}
      },
      load:async()=>{
        const result=await this.client()('studio.snapshot',{}),data=result.data;
        this.policy=data.policy_generation;this.principal=data.principal_id;
        return {records:{...retainedRecords,...data.records},assetBytes:new Map(),source:{mode:'local-broker',registry_kind:'atomic-publication-index',registry_generation:data.generation,verified_at:new Date().toISOString(),freshness:'current-generation',semantic_trust:this.trust}};
      }
    };
    this.source=source;
    this.reader=new ExplorerReader(source,{ownedPrincipal:()=>this.principal,retainedRefs:retainedRecords?Object.fromEntries(Object.entries(retainedRecords).map(([ref,r])=>[ref,digest(r.data)])):undefined});
  }
  private client(options:any={}){return this.trustedClient?this.trustedClient(options):localOperationClient(this.config,this.selector,options);}
  close(){this.active=false;this.reader.invalidate();}
  async read(command:string,input:any={}) {
    this.source.assertAuthorized();
    if(isProfilesBuildCommand(command)) {
      if(!this.localBuild)fail('UNSUPPORTED_CAPABILITY',8,'This Studio host has no configured Local Profiles/Build adapter.');
      return this.localBuild.read(command,input);
    }
    if(!['evidence.assemble','capabilities','review.inbox','review.state','layer.preview','operation.inspect','inspect','conflicts'].includes(command))fail('UNSUPPORTED_CAPABILITY',8,'Unknown Studio projection.');
    const result=await this.client()(command,input);
    if(command==='capabilities') {
      const snapshot=(await this.client()('studio.snapshot',{})).data;result.data.generation=snapshot.generation;
      result.data.operations=result.data.operations.map((op:any)=>({...op,configured:this.allowed.includes(op.operation)||['evidence.assemble','inspect','status','diff','conflicts','capabilities','review.inbox','review.state','layer.preview','operation.inspect','studio.snapshot'].includes(op.operation)}));
      result.data.write_configured=this.allowed.length>0&&result.data.write_blocked!==true;result.data.output_slots=Object.keys(this.outputSlots);
      const assigned=new Map<string,any>(result.data.operations.map((row:any)=>[row.operation,row]));
      result.data.operations=[...result.data.operations.filter((row:any)=>!isProfilesBuildCommand(row.operation)),...profilesBuildCapabilityRows(!!this.localBuild, command=>this.localBuild?.supports?.(command)??!!this.localBuild).map(row=>{
        const source=assigned.get(row.operation),authorized=source?.allowed===true||source?.allowed===undefined&&source?.authorized===true;
        return {...row,...(source?.supported===false?{supported:false,...(source.reason?{reason:source.reason}:{})}:{}),
          allowed:row.configured&&this.allowed.includes(row.operation)&&authorized};
      })];
    }
    return result.data;
  }
  async operation(value:unknown) {
    this.source.assertAuthorized();
    const request=parse(requestSchema,value);
    validateEnvelope(JSON.stringify({command:request.command,input:request.input,options:{idempotency_key:request.idempotency_key}}));
    if(isProfilesBuildCommand(request.command)) {
      if(!this.localBuild)fail('UNSUPPORTED_CAPABILITY',8,'This Studio host has no configured Local Profiles/Build adapter.');
      if(!this.allowed.includes(request.command))fail('OPERATION_FORBIDDEN',4,'This Studio host has not configured that operation.');
      const result=await this.localBuild.operation(request);
      // Keep the Explorer generation aligned after a Profiles write. Failure to
      // refresh never erases an already confirmed immutable save.
      try{await this.reader.refresh();result.generation=this.reader.sourceInfo()?.registry_generation??result.generation;}
      catch(error:any){result.refresh_error=error.code??'SOURCE_UNAVAILABLE';}
      return result;
    }
    if(!['evidence.assemble','inspect','status','diff','conflicts','capabilities','review.inbox','review.state','layer.preview','operation.inspect'].includes(request.command)&&!this.allowed.includes(request.command))fail('OPERATION_FORBIDDEN',4,'This Studio host has not configured that operation.');
    const current=(await this.client()('studio.snapshot',{})).data;
    if(!request.dry_run&&!['materialize','validate','release'].includes(request.command)) {
      const receipt=(await this.client()('operation.inspect',{key:request.idempotency_key})).data;
      if(receipt.state==='committed') {
        const result=await this.client({idempotency_key:request.idempotency_key})(request.command,request.input);
        await this.reader.refresh();return {data:result.data,operation_id:result.operation_id,created:result.created??[],reused:true,refresh_error:null,generation:this.reader.sourceInfo()?.registry_generation};
      }
    }
    if(current.generation!==request.expected_generation)fail('STALE_GENERATION',5,'The saved project view changed. Refresh and inspect it before submitting.');
    if(current.policy_generation!==request.expected_policy)fail('STALE_POLICY',5,'The assigned policy changed. Refresh capabilities.');
    let input:any=structuredClone(request.input);
    if(['materialize','validate'].includes(request.command)) {
      const keys=request.command==='materialize'?['target','profile','slot']:['target','evidence','slot'];if(Object.keys(input).some(k=>!keys.includes(k)))fail('INVALID_ARGUMENT',2,'Unknown output operation field.');
      if(typeof input.slot!=='string'||!Object.hasOwn(this.outputSlots,input.slot))fail('INVALID_PATH',2,'Choose an explicitly configured output slot.');
      const slot=await safePath(this.projectRoot,this.outputSlots[input.slot]);
      if(request.command==='materialize')input={target:input.target,profile:input.profile,out:path.relative(this.projectRoot,slot)};
      else input={target:input.target,manifest:path.join(slot,'realization.json'),evidence:input.evidence};
    }
    const client=this.client({dry_run:request.dry_run,idempotency_key:request.idempotency_key,expected_generation:request.expected_generation,expected_policy:request.expected_policy});
    let response:any;
    const data=await runNodeCommand(this.projectRoot,async(command,body)=>{
      response=await client(command,body);return response.data;
    },request.command,input,request.dry_run);
    // The committed ref is returned even if refreshing the read generation fails.
    let refresh_error:string|null=null;
    try{await this.reader.refresh();}catch(error:any){refresh_error=error.code??'SOURCE_UNAVAILABLE';}
    return {data,operation_id:response?.operation_id??null,created:response?.created??[],reused:response?.reused??false,refresh_error,generation:refresh_error?null:this.reader.sourceInfo()?.registry_generation};
  }
  async downloadBuildOutput(buildId:string,fileId:string) {
    this.source.assertAuthorized();
    if(!this.localBuild)fail('UNSUPPORTED_CAPABILITY',8,'This Studio host has no configured Local Build output adapter.');
    return this.localBuild.download(buildId,fileId);
  }
}
export async function studioBody(req:AsyncIterable<Uint8Array|string>) {
  let text='',bytes=0;
  for await(const part of req){bytes+=Buffer.byteLength(part);if(bytes>MAX_REQUEST_BYTES)problem('INVALID_INPUT',413,'Studio command exceeds the bounded request limit.');text+=part;}
  try{return JSON.parse(text);}catch{problem('INVALID_INPUT',400,'Studio accepts one JSON command.');}
}
export function studioFailure(error:unknown) {
  if(error instanceof StrataError)return {code:error.code,status:error.exit===4||error.exit===7?403:error.exit===5||error.exit===6?409:error.exit===9?503:422,message:error.message,details:error.details};
  return null;
}
