import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_MODEL, canonical, digest, fail } from '../src/model.js';
import { HostIssuer, accountStoreSchema, policyStoreSchema } from '../src/auth/host-issuer.js';
import { hostRunner } from '../src/auth/runner.js';
import { startLocalBroker } from '../src/local-broker.js';
import { noLinks, STATE_DESCRIPTOR } from '../src/node-state.js';
import { StudioCommands, STUDIO_COMMANDS } from '../src/explorer/commands.js';
import { startExplorer } from '../src/explorer/host.js';
import { WORKFLOW_READS } from '../src/workflow.js';

export const CONTRIBUTOR_ROLES = ['author-a','author-b','reviewer','runner','scope-selector','safety-guardian','release-manager','reader'] as const;
export const CONTRIBUTOR_SLOTS = { baseline: '.strata/baseline', changed: '.strata/changed', independent: '.strata/independent' };
const project = 'contributor-collection', profile = 'collection-host/1';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inputNames = ['bootstrap','create-audit','change-limit','alternative-limit','baseline-composition','changed-composition','expectations'];
const reads = [...WORKFLOW_READS,'inspect','status','diff','conflicts'];
const roleOperations: Record<typeof CONTRIBUTOR_ROLES[number], string[]> = {
  'author-a': [...reads,'init','layer.create','layer.revise','layer.restore','layer.publish','compose','mediation.prepare','resolve'],
  'author-b': [...reads,'layer.create','layer.revise','layer.restore','layer.publish'],
  reviewer: [...reads,'content.review','criterion.review'],
  runner: [...reads,'materialize','realization.register','evidence.run','validate'],
  'scope-selector': [...reads,'approve','mediation.respond'],
  'safety-guardian': [...reads,'approve'],
  'release-manager': [...reads,'approve','release'], reader: reads
};
// This is an opt-in disposable development launcher over existing factories.
// It does not add a login/grant transport or provision a production installation.
function absolute(value: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) fail('INVALID_PATH',2,'Use one canonical absolute path for a new disposable contributor folder.');
  return value;
}
async function json(file: string, value: unknown, replace = false) {
  await noLinks(file);
  const temporary = replace ? file + '.new' : file;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(canonical(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  if (replace) await rename(temporary, file);
}
function protectedJson(file: string) {
  let current = file;
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail('INVALID_PATH',2,'Contributor configuration cannot use links.');
    if (current === file && (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || process.platform !== 'win32' && stat.mode & 0o077))
      fail('INVALID_CONFIG',2,'Contributor configuration must be a bounded private file.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return JSON.parse(readFileSync(file,'utf8'));
}
export async function prepareContributor(requested: string) {
  const root = await noLinks(absolute(requested));
  // No reuse/reset/migration of another project or partially prepared starter.
  await mkdir(root, { mode: 0o700 });
  await mkdir(path.join(root,'inputs'), { mode: 0o700 });
  await mkdir(path.join(root,'receipts'), { mode: 0o700 });
  const keys = Object.fromEntries(CONTRIBUTOR_ROLES.map(role => [role, Buffer.from(randomBytes(32)).toString('base64url')]));
  const accounts = accountStoreSchema.parse({ format:'strata-host-accounts/1', generation:1, accounts:CONTRIBUTOR_ROLES.map(role => ({
    account_id:role, principal_id:role, principal_kind:role==='runner'?'agent':'person', active:true, credential_epoch:1,
    key_sha256:createHash('sha256').update(keys[role]).digest('hex') })) });
  const policy = policyStoreSchema.parse({ format:'strata-host-policy/1', project_id:project, generation:1,
    grants:CONTRIBUTOR_ROLES.map(role => ({ grant_id:role, principal_id:role, operations:roleOperations[role],
      layer_ids:role.startsWith('author-')?null:[], write_block_ids:role==='author-a'?['collection','items','policy']:role==='author-b'?['policy']:[],
      create_under_block_ids:role==='author-a'?['collection']:[], approvals:role==='scope-selector'?['scope','resolution']:role==='safety-guardian'?['guardian']:role==='release-manager'?['release']:[],
      profiles:role==='runner'?[profile]:[], expires_at:new Date(Date.now()+8*60*60*1000).toISOString() })) });
  await json(path.join(root,'development-keys.json'),{ format:'strata-contributor-development-keys/1', keys });
  await json(path.join(root,'accounts.json'), accounts); await json(path.join(root,'policy.json'), policy);
  for (const name of inputNames) await json(path.join(root,'inputs',name+'.json'), JSON.parse(await readFile(path.join(repository,'examples/contributor/collection',name+'.json'),'utf8')));
  await json(path.join(root,'CONTRIBUTOR.json'), { format:'strata-local-contributor/1', project_id:project, model_version:BLOCK_MODEL,
    synthetic:true, policy_hours:8, session_minutes:30, slots:CONTRIBUTOR_SLOTS, profile });
  return { prepared:true, root, synthetic:true, next:'Start this folder, then follow docs/CONTRIBUTOR_STARTER.md. No baseline, review or Release has been created.' };
}
export async function startContributor(requested: string) {
  const root = await noLinks(absolute(requested));
  const marker = protectedJson(path.join(root,'CONTRIBUTOR.json'));
  if (marker.format!=='strata-local-contributor/1'||marker.synthetic!==true||marker.project_id!==project||marker.model_version!==BLOCK_MODEL||
      marker.profile!==profile||marker.policy_hours!==8||marker.session_minutes!==30||canonical(marker.slots)!==canonical(CONTRIBUTOR_SLOTS)) fail('INVALID_CONFIG',2,'This launcher requires its exact disposable contributor setup.');
  const accountsFile=path.join(root,'accounts.json'), policyFile=path.join(root,'policy.json');
  const issuer = new HostIssuer(protectedJson(accountsFile), protectedJson(policyFile));
  if (issuer.projectId !== project) fail('PROJECT_FORBIDDEN',4,'Contributor policy belongs to another project.');
  const secret = protectedJson(path.join(root,'development-keys.json'));
  if (secret.format!=='strata-contributor-development-keys/1'||canonical(Object.keys(secret.keys).sort())!==canonical([...CONTRIBUTOR_ROLES].sort())) fail('INVALID_CONFIG',2,'Development roles are incomplete.');
  const refresh = () => issuer.reload(protectedJson(accountsFile), protectedJson(policyFile));
  const sessions = Object.fromEntries(CONTRIBUTOR_ROLES.map(role=>[role,issuer.login(role,secret.keys[role])]));
  // Preflight all explicitly assigned roles before opening listeners or replacing
  // session metadata. Restart cannot extend a spent policy or repair a grant.
  for (const role of CONTRIBUTOR_ROLES) issuer.authorize(issuer.resolve(sessions[role],project),'capabilities',{});
  const broker = await startLocalBroker(path.join(root,'.strata/state'),0,{issuer,model_version:BLOCK_MODEL,refreshAuthority:refresh,
    runner:hostRunner(root,CONTRIBUTOR_SLOTS,[profile])});
  const config = { schema_version:'1', model_version:BLOCK_MODEL, project_id:project, broker:broker.url,
    artifact_adapter:'local-persistent-fake', network_policy:'loopback-only', profiles:[profile] };
  const views: { role:string; commands:StudioCommands; host:Awaited<ReturnType<typeof startExplorer>> }[]=[];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    for (const view of views) view.commands.close();
    const results = await Promise.allSettled(views.map(view=>view.host.close()));
    try { await broker.close(); } finally { issuer.clear(); }
    if (results.some(result=>result.status==='rejected')) fail('CONTRIBUTOR_STOP_FAILED',1,'A local Studio listener could not close.');
  })();
  try {
    await json(path.join(root,'strata.config.json'),config,true);
    await json(path.join(root,'sessions.json'),{format:'strata-contributor-sessions/1',synthetic:true,project_id:project,broker:broker.url,
      expires_at:new Date(Date.now()+30*60*1000).toISOString(),sessions},true);
    for (const role of CONTRIBUTOR_ROLES) {
      const commands = new StudioCommands(config,sessions[role],root,roleOperations[role].filter(op=>(STUDIO_COMMANDS as readonly string[]).includes(op)),
        CONTRIBUTOR_SLOTS,'host-authenticated',()=>{refresh();const context=issuer.resolve(sessions[role],project);issuer.authorize(context,'studio.snapshot',{});return context.policy_version;});
      commands.source.connection.display_name='Synthetic local contributor: '+role;
      const host=await startExplorer(commands.reader,{port:0,assets:path.join(repository,'explorer'),sessionMs:30*60*1000,commands});
      views.push({role,commands,host});
    }
    const accounts=protectedJson(accountsFile),policy=protectedJson(policyFile);
    await json(path.join(root,'LANE.json'),{format:'strata-contributor-lane/1',synthetic:true,project_id:project,model_version:BLOCK_MODEL,
      lane_id:digest({project,model:BLOCK_MODEL,state:path.join(root,'.strata/state'),accounts:digest(accounts),policy:digest(policy)}),
      backend:{kind:'node-development-harness',transport:'loopback-cli-and-local-preview-capability',broker:broker.url,
        studio:views.map(view=>({role:view.role,origin:view.host.origin}))},
      state_directory:path.join(root,'.strata/state'),registry_file:path.join(root,'.strata/state/registry.json'),
      state_descriptor_sha256:digest(JSON.parse(await readFile(path.join(root,'.strata/state',STATE_DESCRIPTOR),'utf8'))),
      config_sha256:digest(config),accounts_sha256:digest(accounts),policy_sha256:digest(policy),
      roles:policy.grants,output_slots:CONTRIBUTOR_SLOTS,runner_profiles:[profile],runner:'src/auth/runner.ts',
      session_minutes:30,policy_expires_at:policy.grants[0].expires_at,
      boundary:'Generated local development identity. All roles controlled by one local user; no production authentication or independent human claim.'},true);
    return { root, broker:broker.url, views:views.map(v=>({role:v.role,url:v.host.launchUrl})), close };
  } catch(error) { await close(); throw error; }
}
async function main() {
  const [command,directory,...extra]=process.argv.slice(2);
  if(command==='--help'||!command){console.log('Disposable local contributor starter (synthetic roles; no providers).\n  prepare CANONICAL_ABSOLUTE_NEW_FOLDER\n  start CANONICAL_ABSOLUTE_PREPARED_FOLDER\n30-minute sessions, eight-hour policy. Ctrl+C stops all loopback services; records/output remain. No reset or production setup.');return;}
  if(extra.length||!directory||!['prepare','start'].includes(command))fail('INVALID_ARGUMENT',2,'Use --help for the two explicit starter operations.');
  if(command==='prepare'){console.log(JSON.stringify(await prepareContributor(directory)));return;}
  const service=await startContributor(directory);
  console.log('SYNTHETIC LOCAL DEVELOPMENT ONLY: one local user controls all named roles. No independent human/production identity claim.');
  console.log('CLI config: '+path.join(service.root,'strata.config.json')+'; protected role sessions: '+path.join(service.root,'sessions.json'));
  for(const view of service.views)console.log(view.role+': '+view.url);
  console.log('Use the ordinary CLI and Studio workflow in docs/CONTRIBUTOR_STARTER.md. Ctrl+C stops services. Session links expire after 30 minutes.');
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void service.close().then(()=>{process.exitCode=0;}).catch(()=>{process.exitCode=1;});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({ok:false,code:error?.code??'CONTRIBUTOR_START_FAILED',message:'Contributor setup/start refused. Inspect the explicit folder, build, protected files, policy expiry and running starter; no automatic reset or retry.'}));process.exitCode=error?.exit??2;});
