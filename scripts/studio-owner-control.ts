import path from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hostedConfigSchema } from './studio-host.js';
import { controlSchema, armControl, readControl, publishControl, type BootstrapControl, type OwnerBinding } from '../src/explorer/bootstrap-control.js';
import { initialManifestSchema, reservationSchema, type BrowserOwnerConfig } from '../src/explorer/bootstrap-state.js';
import { digest, readPrivate, optionalPrivate } from '../src/explorer/owner-files.js';
import { trustedFile } from '../src/explorer/source.js';
import { safeJson } from '../src/explorer/contract.js';
import { noLinks } from '../src/node-state.js';

const pendingSchema=z.object({format:z.literal('strata-owner-pending/1'),enrollment_epoch:z.string().uuid(),requests:z.array(z.object({reservation:reservationSchema,creation_id:z.string().uuid(),pre_cookie_sha256:z.string().regex(/^[a-f0-9]{64}$/),public_code:z.string().regex(/^[a-f0-9]{32}$/),csrf:z.string().regex(/^[A-Za-z0-9_-]{43}$/),cancelled:z.boolean()}).strict()).max(8),attempts:z.array(z.number()).max(5)}).strict();
// Sanitized fixed-path reads only: no verifier, key or credential file access.
export async function inspectPending(config:BrowserOwnerConfig,control:BootstrapControl,now=Date.now()) {
  const data=await optionalPrivate(path.join(config.state_directory,'pending.json'));if(data===undefined&&control.state!=='approved')return [];const pool=pendingSchema.parse(data);
  if(pool.enrollment_epoch!==control.enrollment_epoch)return [];
  return pool.requests.filter(p=>!p.cancelled&&now<Date.parse(p.reservation.expires_at)).map(p=>({code:p.public_code,reservation:p.reservation,reservation_sha256:digest(JSON.stringify(p.reservation))}));
}
export async function inspectLeases(config:BrowserOwnerConfig,control:BootstrapControl) {
  const entries=[{kind:'owner',file:path.join(config.state_directory,'.owner.lock'),initialization_id:undefined as string|undefined},...(control.owner_binding?[{kind:'credentials',file:path.join(config.credential_directory,control.owner_binding.initialization_id,'.credential-store.lock'),initialization_id:control.owner_binding.initialization_id}]:[])];
  const result=[];
  for(const e of entries){let raw:string;try{raw=await trustedFile(e.file,1024);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}const lease=z.object({format:z.literal(e.kind==='owner'?'strata-owner-lease/1':'strata-credential-lease/1'),pid:z.number().int().min(2)}).strict().parse(safeJson(raw,1024));result.push({kind:e.kind,pid:lease.pid,sha256:digest(raw),...(e.initialization_id?{initialization_id:e.initialization_id}:{})});}
  return result;
}
export async function inspectCompletion(config:BrowserOwnerConfig) {
  const pointer=z.object({format:z.literal('strata-owner-active/1'),initialization_id:z.string().uuid(),owner_id:z.string().uuid(),key_id:z.string().uuid(),authentication_id:z.string().uuid(),authentication_generation:z.number().int().min(1),request_id:z.string().uuid(),recovery_approval_id:z.string().uuid().optional()}).strict().parse(await readPrivate(path.join(config.state_directory,'active.json')));
  const prepared=z.object({format:z.literal('strata-owner-preparation/1'),phase:z.literal('prepared'),manifest:initialManifestSchema}).strict().parse(await readPrivate(path.join(config.state_directory,'initial-'+pointer.initialization_id+'.json')));
  const m=prepared.manifest;
  if(pointer.owner_id!==m.owner_id||pointer.key_id!==m.key_id||pointer.initialization_id!==m.initialization_id)throw new Error('Completion binding changed.');
  const binding:OwnerBinding={installation_id:m.installation_id,initialization_id:m.initialization_id,owner_id:m.owner_id,key_id:m.key_id,initial_manifest_sha256:digest(JSON.stringify(m))};
  return {format:'strata-owner-completion/1' as const,binding,approval_id:m.approval_id,enrollment_epoch:m.enrollment_epoch,authentication_generation:pointer.authentication_generation};
}
export async function approvePending(config:BrowserOwnerConfig,control:BootstrapControl,code:string,now=Date.now()):Promise<BootstrapControl> {
  if(control.state!=='armed'||now>=Date.parse(control.expires_at)||!/^[a-f0-9]{32}$/.test(code))throw new Error('Approval window or code is invalid.');
  const pending=(await inspectPending(config,control,now)).find(p=>p.code===code);if(!pending)throw new Error('Exact supplied browser request was not found.');
  const r=pending.reservation;if(r.installation_id!==control.installation_id||r.enrollment_epoch!==control.enrollment_epoch||r.purpose!==control.purpose||r.expected_owner_generation!==control.expected_owner_generation||Date.parse(r.expires_at)>Date.parse(control.expires_at))throw new Error('Pending request does not match the protected control.');
  return controlSchema.parse({...control,state:'approved',control_generation:control.control_generation+1,approval:{approval_id:randomUUID(),pending_id:pending.reservation.pending_id,browser_cookie_sha256:pending.reservation.browser_cookie_sha256,reservation_sha256:pending.reservation_sha256,scope:'installation-owner',expires_at:new Date(Math.min(now+10*60_000,Date.parse(control.expires_at),Date.parse(pending.reservation.expires_at))).toISOString()}});
}
export function closeControl(control:BootstrapControl):BootstrapControl {
  if((control.state==='approved'||control.purpose==='resume-owner-enrollment')&&!control.owner_binding)throw new Error('Approved incomplete enrollment must retain its independent anchor.');
  return controlSchema.parse({...control,state:'closed',approval:undefined,control_generation:control.control_generation+1});
}
export async function resumePreparedEnrollment(config:BrowserOwnerConfig,control:BootstrapControl,initialization_id:string,manifest_sha256:string,now=Date.now()):Promise<BootstrapControl> {
  const init=z.string().uuid().parse(initialization_id),sha=z.string().regex(/^[a-f0-9]{64}$/).parse(manifest_sha256);
  if(control.owner_binding || control.state==='closed' || !['enroll-owner','resume-owner-enrollment'].includes(control.purpose))throw new Error('Exact unsealed prepared enrollment required.');
  if(await optionalPrivate(path.join(config.state_directory,'active.json'))!==undefined)throw new Error('Durable completion requires exact sealing.');
  if(await optionalPrivate(path.join(config.state_directory,'.owner.lock'))!==undefined)throw new Error('Enrollment transaction requires explicit lease reconciliation.');
  const prepared=z.object({format:z.literal('strata-owner-preparation/1'),phase:z.literal('prepared'),manifest:initialManifestSchema}).strict().parse(await readPrivate(path.join(config.state_directory,'initial-'+init+'.json')));
  const m=prepared.manifest;
  if(m.installation_id!==control.installation_id || m.initialization_id!==init || digest(JSON.stringify(m))!==sha)throw new Error('Prepared transaction binding changed.');
  if(control.purpose==='resume-owner-enrollment') {
    if(control.resume?.initialization_id!==init || control.resume.initial_manifest_sha256!==sha)throw new Error('Independent prepared enrollment anchor changed.');
  } else if(control.state!=='approved' || !control.approval || m.approval_id!==control.approval.approval_id || m.enrollment_epoch!==control.enrollment_epoch)throw new Error('Prepared transaction does not match its independent approval.');
  return controlSchema.parse({...armControl(control.origin,control.installation_id,now),purpose:'resume-owner-enrollment',control_generation:control.control_generation+1,resume:{initialization_id:init,initial_manifest_sha256:sha}});
}
export async function reconcileOwnerLease(config:BrowserOwnerConfig,expectedPid:number,expectedSha:string,initialization_id?:string) {
  const filename=initialization_id?path.join(config.credential_directory,z.string().uuid().parse(initialization_id),'.credential-store.lock'):path.join(config.state_directory,'.owner.lock');
  const raw=await trustedFile(filename,1024),lease=z.object({format:z.literal(initialization_id?'strata-credential-lease/1':'strata-owner-lease/1'),pid:z.number().int().min(2)}).strict().parse(safeJson(raw,1024));
  if(lease.pid!==expectedPid||digest(raw)!==expectedSha)throw new Error('Exact stale lease changed.');
  try{process.kill(lease.pid,0);throw new Error('Lease process is still present.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  // The external authenticated adapter must stop the fixed service first.
  // No HTTP request or elapsed timeout can call this function.
  if(await trustedFile(filename,1024)!==raw)throw new Error('Exact stale lease changed.');await unlink(filename);
  return {format:'strata-owner-lease-reconciliation/1',reconciled:true};
}
export async function sealCompletion(config:BrowserOwnerConfig,control:BootstrapControl,expected:OwnerBinding,now=Date.now(),reconcile=false):Promise<BootstrapControl> {
  const receipt=await inspectCompletion(config);
  if(control.owner_binding){if(JSON.stringify(control.owner_binding)!==JSON.stringify(expected))throw new Error('An independent owner seal already exists.');return control;}
  const resumed=control.purpose==='resume-owner-enrollment'&&control.resume?.initialization_id===receipt.binding.initialization_id&&control.resume.initial_manifest_sha256===receipt.binding.initial_manifest_sha256;
  if(control.state!=='approved'||!control.approval||(!reconcile&&now>=Date.parse(control.approval.expires_at))||(!resumed&&(receipt.approval_id!==control.approval.approval_id||receipt.enrollment_epoch!==control.enrollment_epoch))||JSON.stringify(receipt.binding)!==JSON.stringify(expected))throw new Error('Exact completion does not match its protected approval.');
  return controlSchema.parse({...control,state:'closed',approval:undefined,control_generation:control.control_generation+1,owner_binding:receipt.binding});
}
async function main(){
  if(process.platform!=='linux'||process.getuid?.()!==0)throw new Error('Authenticated Linux root management required.');
  const args=process.argv.slice(2),values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1]||values.has(args[i]))throw new Error('Explicit operator arguments required.');values.set(args[i],args[i+1]);}
  const command=values.get('--operation'),filename=values.get('--host-config');
  if(!filename||!path.isAbsolute(filename)||!command||![ 'inspect','arm','approve','completion','seal','reconcile-seal','close','recover-arm','resume-arm','reconcile-lease'].includes(command))throw new Error('Unknown management operation.');
  const extra:Record<string,string[]>={inspect:[],completion:[],arm:[],close:[],approve:['--code'],seal:['--initialization-id','--owner-id','--key-id','--manifest-sha256'],'reconcile-seal':['--initialization-id','--owner-id','--key-id','--manifest-sha256'],'recover-arm':['--owner-id','--authentication-generation'],'resume-arm':['--initialization-id','--manifest-sha256'],'reconcile-lease':['--lease-pid','--lease-sha256','--initialization-id']};
  const allowed=new Set(['--host-config','--operation',...(['inspect','completion'].includes(command)?[]:['--installation-id','--expected-generation']),...extra[command]]);
  if([...values.keys()].some(k=>!allowed.has(k)))throw new Error('Unknown management argument.');
  const host=hostedConfigSchema.parse(safeJson(await trustedFile(filename,16384),16384));if(!host.browser_owner)throw new Error('Explicit browser owner mode required.');
  const config=host.browser_owner,control=await readControl(config.control_file,host.public_origin);
  if(command==='inspect'){process.stdout.write(JSON.stringify({format:'strata-owner-inspection/1',control:control??null,pending:control?await inspectPending(config,control):[],leases:control?await inspectLeases(config,control):[]})+'\n');return;}
  if(command==='completion'){process.stdout.write(JSON.stringify(await inspectCompletion(config))+'\n');return;}
  const expected=Number(values.get('--expected-generation'));if(!Number.isSafeInteger(expected)||expected<0)throw new Error('Exact expected generation required.');
  const installation=z.string().uuid().parse(values.get('--installation-id'));
  if(control&&(control.control_generation!==expected||control.installation_id!==installation))throw new Error('Protected control changed.');
  if(!control&&expected!==0)throw new Error('Protected control is absent.');
  const lock=config.control_file+'.lock';await noLinks(lock);const handle=await open(lock,'wx',0o600);
  try{
    const latest=await readControl(config.control_file,host.public_origin);if(JSON.stringify(latest)!==JSON.stringify(control))throw new Error('Protected control changed.');
    if(command==='reconcile-lease'){const pid=Number(values.get('--lease-pid')),sha=z.string().regex(/^[a-f0-9]{64}$/).parse(values.get('--lease-sha256')),init=values.get('--initialization-id');if(!control||!Number.isSafeInteger(pid)||pid<2||(init&&init!==control.owner_binding?.initialization_id))throw new Error('Exact known installation and lease required.');process.stdout.write(JSON.stringify(await reconcileOwnerLease(config,pid,sha,init))+'\n');return;}
    let next:BootstrapControl;
    if(command==='recover-arm'){
      if(!control?.owner_binding)throw new Error('Independent owner seal required for recovery.');
      const owner=z.string().uuid().parse(values.get('--owner-id')),generation=Number(values.get('--authentication-generation'));
      if(owner!==control.owner_binding.owner_id||!Number.isSafeInteger(generation)||generation<1)throw new Error('Exact existing owner authentication required.');
      next=controlSchema.parse({...armControl(host.public_origin,installation),purpose:'recover-owner-password',expected_owner_generation:generation,control_generation:control.control_generation+1,owner_binding:control.owner_binding,recovery:{owner_id:owner,authentication_generation:generation}});
    }else if(command==='resume-arm'){
      if(!control)throw new Error('Exact approved incomplete enrollment required.');
      next=await resumePreparedEnrollment(config,control,values.get('--initialization-id')??'',values.get('--manifest-sha256')??'');
    }else if(command==='arm'){
      if(control?.owner_binding||control?.state==='approved'||control?.purpose==='resume-owner-enrollment')throw new Error('Existing owner/approved transaction requires exact reconciliation.');
      next={...armControl(host.public_origin,installation),control_generation:(control?.control_generation??0)+1};
    }else{
      if(!control)throw new Error('Protected control absent.');
      if(command==='approve')next=await approvePending(config,control,values.get('--code')??'');
      else if(command==='close')next=closeControl(control);
      else{
        const binding={installation_id:installation,initialization_id:z.string().uuid().parse(values.get('--initialization-id')),owner_id:z.string().uuid().parse(values.get('--owner-id')),key_id:z.string().uuid().parse(values.get('--key-id')),initial_manifest_sha256:z.string().regex(/^[a-f0-9]{64}$/).parse(values.get('--manifest-sha256'))};
        next=await sealCompletion(config,control,binding,Date.now(),command==='reconcile-seal');
      }
    }
    await publishControl(config.control_file,next);process.stdout.write(JSON.stringify({format:'strata-owner-control-result/1',installation_id:next.installation_id,control_generation:next.control_generation,state:next.state,owner_binding:next.owner_binding??null})+'\n');
  }finally{await handle.close();await unlink(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Owner management refused. Verify exact operation, protected control and bounded pending/completion metadata.\n');process.exitCode=1;});
