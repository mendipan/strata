import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat} from 'node:fs/promises';
import {z} from 'zod';
import {hostedConfigSchema} from './studio-host.js';
import {controlSchema} from '../src/explorer/bootstrap-control.js';
import {BootstrapState} from '../src/explorer/bootstrap-state.js';
import {readRootWorkspaceFile} from '../src/explorer/workspace-policy.js';
import {trustedFile} from '../src/explorer/source.js';
import {digest as byteDigest} from '../src/explorer/owner-files.js';
import {namespacePolicySchema,initialNamespaceFiles} from '../src/explorer/namespace-policy.js';
import {runNamespaceStudio} from '../src/explorer/namespace-host.js';
import {conformancePacketSchema,executeNamespaceConformance,CONFORMANCE_ACCOUNT,CONFORMANCE_NAMESPACE,CONFORMANCE_GENERATION} from '../src/explorer/namespace-conformance.js';

const preparationSchema=z.object({host:hostedConfigSchema,control:controlSchema,run_id:z.string().uuid(),lineage_id:z.string().uuid(),username:z.string().regex(/^[a-z0-9._-]{3,32}$/)}).strict();
export function prepareConformancePacket(value:unknown){
  const p=preparationSchema.parse(value),binding=p.control.owner_binding;
  if(!p.host.browser_owner||!p.host.source_management||p.host.namespace||p.host.workspace||!binding||p.control.state!=='closed'||p.control.origin!==p.host.public_origin)
    throw Error('The existing sealed managed host is required.');
  const policy=namespacePolicySchema.parse({format:'strata-studio-namespace-policy/1',installation_id:binding.installation_id,owner_id:binding.owner_id,
    lineage_id:p.lineage_id,account:CONFORMANCE_ACCOUNT,namespace:CONFORMANCE_NAMESPACE,lifetime:{mode:'until-revoked',expires_at:null},
    permissions:['discover','create','read','draft'],principal_id:'studio-conformance-author',account_id:'studio-conformance-owner',provider_contract:'development-name-addressed',
    operator_rule:'no-delete-recreate-or-rebind-during-write-or-reconciliation',automatic_creation_token:'discard-secret-and-allow-provider-expiry',automatic_token_max_lifetime_seconds:86400,
    max_projects:1,limits:{requests:160,bytes:50*1024**2,max_operation_requests:50,max_operation_bytes:16*1024**2,max_payload_bytes:4*1024**2,max_journal_entries:160}});
  return conformancePacketSchema.parse({format:'strata-studio-namespace-conformance-packet/1',run_id:p.run_id,policy,
    namespace:{policy_file:`/etc/strata-studio/namespace-conformance-policy-${p.lineage_id}.json`,
      catalog_directory:`/var/lib/private/strata-studio/namespace-conformance-catalog-${p.lineage_id}`,
      projects_directory:`/var/lib/private/strata-studio/namespace-conformance-projects-${p.lineage_id}`},
    public_origin:p.host.public_origin,username:p.username,credential_id:'artifacts-api-token',saved_credential_generation:CONFORMANCE_GENERATION});
}

function passwordFromTTY():Promise<string>{
  if(!process.stdin.isTTY||!process.stdin.setRawMode)throw Error('An interactive hidden owner password is required.');
  return new Promise((resolve,reject)=>{
    const input=process.stdin,decoder=new TextDecoder();let value='';input.setRawMode(true);input.resume();process.stdout.write('Existing Studio owner password: ');
    const stop=()=>{input.off('data',data);input.setRawMode(false);input.pause();process.stdout.write('\n');};
    const data=(b:Uint8Array)=>{for(const c of decoder.decode(b,{stream:true})){if(c==='\r'||c==='\n'){stop();const answer=value;value='';resolve(answer);return;}
      if(c==='\u0003'){stop();value='';reject(Error('cancelled'));return;}if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else value+=c;
      if(value.length>512){stop();value='';reject(Error('bounded input required'));return;}}};input.on('data',data);
  });
}

const approvalSchema=z.object({format:z.literal('strata-studio-namespace-conformance-approval/1'),action:z.literal('named-create-save-read-back'),
  approval_id:z.string().uuid(),run_id:z.string().uuid(),packet_sha256:z.string().regex(/^[a-f0-9]{64}$/),package_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  approved_at:z.string().datetime(),expires_at:z.string().datetime(),allow_saved_credential_use:z.literal(true),retain_test_repository:z.literal(true),
  automatic_token_handling:z.literal('discard-secret-no-revocation-claim')}).strict();
export async function readConformanceApproval(filename:string,binding:{run_id:string;packet_sha256:string;package_sha256:string;approval_sha256:string},now=Date.now()){
  // Validate root-controlled ancestors/no links first; parse and authenticate
  // the same bounded raw read. No snapshot, chmod, key or credential is copied.
  await readRootWorkspaceFile(filename,4096);
  const meta=await lstat(filename);
  if(meta.uid!==0||(meta.mode&0o777)!==0o644||meta.nlink!==1)throw Error('Readable root-controlled approval required.');
  const raw=await trustedFile(filename,4096);
  if(byteDigest(raw)!==binding.approval_sha256)throw Error('Exact approval bytes changed or revoked.');
  const a=approvalSchema.parse(JSON.parse(raw)),begin=Date.parse(a.approved_at),end=Date.parse(a.expires_at);
  if(a.run_id!==binding.run_id||a.packet_sha256!==binding.packet_sha256||a.package_sha256!==binding.package_sha256||
    begin>now||now>=end||end-begin>900000||end<=begin)throw Error('Exact fresh owner approval required.');
  return a;
}
async function main(){
  if(process.argv.slice(2).join(' ')==='--initial-stdin'){
    const chunks:Buffer[]=[];let n=0;for await(const b of process.stdin){n+=b.length;if(n>32768)throw Error('Bound exceeded');chunks.push(b);}
    const packet=conformancePacketSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write(JSON.stringify(initialNamespaceFiles(packet.policy))+'\n');return;
  }
  if(process.argv.slice(2).join(' ')==='--prepare-stdin'){
    const chunks:Buffer[]=[];let n=0;for await(const b of process.stdin){n+=b.length;if(n>32768)throw Error('Bound exceeded');chunks.push(b);}
    process.stdout.write(JSON.stringify(prepareConformancePacket(JSON.parse(Buffer.concat(chunks).toString('utf8'))))+'\n');return;
  }
  const args=process.argv.slice(2);
  if(args.length!==10||args[0]!=='--packet'||args[2]!=='--packet-sha256'||args[4]!=='--approval'||args[6]!=='--package-sha256'||args[8]!=='--approval-sha256'||
    process.platform!=='linux'||process.getuid?.()===0)throw Error('The reviewed nonroot service context is required.');
  const [packetFile,packetSha,approvalFile,packageSha]=[args[1],args[3],args[5],args[7]];
  const approvalSha=z.string().regex(/^[a-f0-9]{64}$/).parse(args[9]);
  const packet=conformancePacketSchema.parse(await readRootWorkspaceFile(packetFile));
  if(packetFile!==`/etc/strata-studio/namespace-conformance-${packet.run_id}-packet.json`||
    byteDigest(await trustedFile(packetFile,32768))!==packetSha||approvalFile!==`/etc/strata-studio/namespace-conformance-${packet.run_id}-approval.json`)
    throw Error('Exact packet/approval paths and bytes required.');
  const host=hostedConfigSchema.parse(await readRootWorkspaceFile('/etc/strata-studio/host.json'));
  if(!host.browser_owner||!host.source_management||host.namespace||host.workspace||host.public_origin!==packet.public_origin)throw Error('Existing host changed.');
  const id=packet.policy.lineage_id;
  if(packet.namespace.policy_file!==`/etc/strata-studio/namespace-conformance-policy-${id}.json`||
    packet.namespace.catalog_directory!==`/var/lib/private/strata-studio/namespace-conformance-catalog-${id}`||
    packet.namespace.projects_directory!==`/var/lib/private/strata-studio/namespace-conformance-projects-${id}`)throw Error('Separate conformance paths required.');
  const state=new BootstrapState(host.browser_owner,host.public_origin),owner=await state.owner(true,false);
  if(!owner||owner.owner_id!==packet.policy.owner_id||owner.manifest.installation_id!==packet.policy.installation_id||owner.username!==packet.username)throw Error('Sealed owner differs.');
  const store=state.store(owner.manifest);
  const approve=async()=>{await readConformanceApproval(approvalFile,{run_id:packet.run_id,packet_sha256:packetSha,package_sha256:packageSha,approval_sha256:approvalSha});};
  await approve();
  const report=await executeNamespaceConformance(packet,{approval:approve,generation:()=>store.encryptedGeneration(),password:passwordFromTTY,
    credential:async()=>{await approve();if(await store.encryptedGeneration()!==packet.saved_credential_generation)throw Error('Saved version differs.');
      const secret=await store.withCredential(async v=>{if(!v)throw Error('Saved credential unavailable.');return v;});
      if(await store.encryptedGeneration()!==packet.saved_credential_generation)throw Error('Saved version differs.');return secret;},
    transport:req=>fetch(req),start:transport=>runNamespaceStudio(state,packet.namespace,{publicOrigin:host.public_origin,trustedProxyAddresses:host.trusted_proxy_addresses},0,
      '/opt/strata-studio/releases/9a94e0cca11d-managed-code-20261011/explorer',transport,undefined,async()=>{
        await approve();if(await store.encryptedGeneration()!==packet.saved_credential_generation)throw Error('Saved version differs.');})});
  process.stdout.write(JSON.stringify({status:'conformance-passed',report_file:path.join(packet.namespace.catalog_directory,'provider-conformance.json'),
    evidence_file:path.join(packet.namespace.catalog_directory,'conformance-evidence.json'),reserved_requests:(report as any).reserved_requests,reserved_bytes:(report as any).reserved_bytes})+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
  process.stderr.write('Namespace conformance refused. Retain the named project, writer, reservations and checkpoint for review.\n');process.exitCode=1;
});
