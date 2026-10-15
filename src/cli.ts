import { admitHostConfig,hostOperationClient } from './commands/host-client.js';
import { localOperationClient } from './commands/client.js';
import { readFile, writeFile, mkdir, readdir, lstat, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, StrataError, digest, bytesDigest, MODEL, CONTENT_MODEL, SUPPORTED_MODELS, FACETS, canonical } from './model.js';
import { PROFILE_IDS } from './profile.js';
import { safePath, verifyOutput, runNodeCommand } from './commands/node.js';
export { safePath, verifyOutput } from './commands/node.js';
import { MUTATIONS } from './service.js';
import { REVALIDATION_SCHEMAS } from './revalidation.js';
import { createBackup, verifyBackup, restoreBackup, backupError } from './backup.js';

import { importAsset } from './assets-node.js';
import { FixtureIssuer } from './security.js';
import { cliBroker } from './cli-config.js';
import { doctor } from './doctor.js';
import { REVIEW_TYPES, reviewRecord, type ReviewType } from './review.js';
import { GIT_ADOPTION_SCHEMAS } from './git-adoption.js';
import { ADOPTION_RECORD_SCHEMAS } from './adoption/records.js';
import { SOURCE_BINDING_SCHEMAS } from './source-binding.js';
import { DRIFT_SCHEMAS } from './reconciliation.js';
import { parseLocalBuildCli, LOCAL_BUILD_CLI_HELP } from './commands/build-cli.js';
export const HELP = {
  protocol_version: '1', model_version: MODEL, supported_models:SUPPORTED_MODELS, version: '0.1.0', experimental: true,
  commands: ['studio agents status|outcome|configure|test|connect|disconnect|remove --origin HTTPS --username NAME [--file F | --request-id UUID]', 'studio connections status|outcome|create|test|select|connect|disconnect|renew|remove --origin HTTPS --username NAME [--file F | --request-id UUID]', 'studio [--sample | --config FILE --allow-remote-read | --project PATH --write-config FILE]', 'capabilities [--target REF]', 'review inbox [--baseline REF] [--limit N] [--cursor C]', 'review state REF', 'layer preview --file F', 'operation inspect KEY', 'mediation install --file F', 'evidence run --file F', 'evidence assemble --file F', 'criterion review --file F', 'doctor', 'review layer|validation|authoring-review EXACT_REF', 'mediation prepare --file F', 'mediation respond --file F', 'reports dispose --file F', 'content review --file F', 'migration preview RELEASE --source-digest HASH', 'assets import --file LOCAL_IMAGE --metadata F --state-dir REL_PATH', 'assets inspect EXACT_REF', 'init --file F', 'status [--candidate C]', 'inspect TYPE [REF] [--at SNAPSHOT]', 'diff LEFT RIGHT', 'layer create --file F', 'layer revise REF --file F', 'layer publish REF [--review F] [--authoring-review EXACT_REF]', 'layer restore CURRENT --from PRIOR', 'context show', 'context use TARGET --expect-generation N', 'compose --file F', 'conflicts C [--report F]', 'resolve --file F [--approval A]', 'materialize TARGET --profile PROFILE_ID --out DIR', 'materialize TARGET --profile PROFILE_ID --slot HOST_SLOT', 'distill --source MANIFEST --against TARGET --layer ID --proposal F', 'validate TARGET --realization MANIFEST --evidence F', 'validate TARGET --slot HOST_SLOT --evidence F', 'approve --file F', 'release C --validation V --approval A', 'config show', 'backup create --out NEW_DIR --max-bytes N [--state-dir REL_PATH]', 'backup verify BUNDLE --expect-project ID [--expect-digest HASH]', 'backup inspect BUNDLE --expect-project ID [--expect-digest HASH] [--ref EXACT_REF]', 'backup restore BUNDLE --out NEW_DIR --expect-project ID --expect-digest HASH'],
  block_contract: 'docs/BLOCK_CONTRACT.md',
  aliases: { mat: 'materialize', dist: 'distill', flatten: 'release' },
  flags: ['--project PATH', '--json', '--human', '--non-interactive', '--offline', '--dry-run', '--idempotency-key KEY', '--help', '--version'],
  capabilities: { changes: ['set_item', 'layer_acceptance', 'v0.3-created_blocks'], resolution_outcomes: ['select'], distillation: ['supplied_proposal'], profiles: PROFILE_IDS, evidence_formats:['legacy','strata-fixture-evidence/2','strata-host-evidence/1'], 'content/1':'explicit-v0.2', 'assets/1':'bounded-offline-node-retention', 'mediation/1':'bounded-v0.2-fixture-selection', facets: FACETS, identity: 'trusted-local-fixture-sessions', remote: false, hosted: 'explicit-configured-https-named-accounts', recovery: ['personal-context', 'owned-same-baseline-layer-restoration', 'quiesced-node-backup', 'offline-verification', 'isolated-inactive-restore'] },
  limitations: ['Checker-bound evidence format 2 requires an explicit supporting Node profile and independently supplied host expectations. The finite profile inventory also retains legacy evidence profiles. SDK checker-bound validation is unavailable.', 'v0.2 is opt-in: exact authoring review, plain text descriptions and retained PNG/JPEG backgrounds; Fresh explicitly bootstrapped v0.2 supports bounded mediation and versioned Release; policy executors require trusted test-only assignments. Active migration remains unavailable.', 'Text checks reject structural code forms; they cannot prove arbitrary prose contains no code. Explicit exact-draft authoring review is required.', 'Asset import requires an explicitly assigned operator, project visibility acknowledgement, provenance and rights; no default import grant or SDK binary backend exists.', 'Local fixture identity and imported fixture evidence are not production authentication or independent attestation.', 'v0.3 adds explicit parent-scoped Block creation through Layers and authenticated hosted review/evidence. Remove/reparent, arbitrary realization, automatic inference, live agent chat and deployment are unavailable.', 'Full private-history backup requires the separate backup operator entitlement and a stopped descriptor-bound Node broker; SDK/online backup and remote mirrors are deferred.', 'Restore requires an expected project and trusted manifest digest, produces an isolated inactive archive, and restores no login identities, live grants or request cache.']
};
HELP.commands.push('adoption prepare --file F', 'adoption review --file F', 'layer publish REF --adoption-review EXACT_REF');
HELP.commands.push(...LOCAL_BUILD_CLI_HELP);
HELP.limitations.push('Persistent adoption requires an explicitly configured local Node v0.1 Git host and assigned owner operations. Interpretation review and source freshness are separate from behavior validation; hosted v0.3 source adoption is unavailable.');
type Envelope = { protocol_version: string; command: string; ok: boolean; exit_code: number; mode: string; operation_id: string | null; data: any; errors: any[]; warnings: any[]; effects: { created: string[]; reused: string[]; paths: string[]; network: string[]; usage: any[] }; next_actions: any[] };
type Parsed = { command: string; args: string[]; flags: Record<string, string[]> };
const BOOLEAN = new Set(['json', 'human', 'non-interactive', 'offline', 'dry-run', 'help', 'version']);
const COMMON = [...BOOLEAN, 'project', 'idempotency-key'];
const OPTIONS: Record<string, string[]> = { capabilities:['target'], 'review.inbox':['baseline','limit','cursor'], 'review.state':[], 'layer.preview':['file'], 'operation.inspect':[], 'mediation.install':['file'],'evidence.assemble':['file'],'evidence.run':['file'],'criterion.review':['file'],'mediation.prepare':['file'], 'mediation.respond':['file'], 'reports.dispose':['file'], 'content.review':['file'], 'migration.preview':['source-digest'], 'assets.import':['file','metadata','state-dir'], 'assets.inspect':[],  doctor: [], review: [], init: ['file'], status: ['candidate'], inspect: ['at', 'limit', 'cursor'], diff: [], 'layer.create': ['file'], 'layer.revise': ['file'], 'layer.publish': ['review','authoring-review'], 'layer.restore': ['from'], 'context.show': [], 'context.use': ['expect-generation'], compose: ['file'], conflicts: ['report'], resolve: ['file', 'approval'], materialize: ['profile', 'out','slot'], distill: ['source', 'against', 'layer', 'proposal'], validate: ['realization', 'evidence','slot'], approve: ['file'], release: ['validation', 'approval'], 'config.show': [], 'backup.create': ['out', 'max-bytes', 'state-dir'], 'backup.verify': ['expect-project', 'expect-digest'], 'backup.inspect': ['expect-project', 'expect-digest', 'ref'], 'backup.restore': ['out', 'expect-project', 'expect-digest'] };
export function parseArgs(argv: string[]): Parsed {
  Object.assign(OPTIONS,{'adoption.prepare':['file'],'adoption.review':['file'],'layer.publish':['review','authoring-review','adoption-review']});
  Object.assign(OPTIONS,{'source.capture':['file'],'source.bind':['file'],'drift.check':['file'],'drift.propose':['file'],'drift.review':['file'],'drift.revalidate':['file'],'git.plan':['file'],'git.stage':['patch'],'git.check':['checker','oracle'],'git.evidence':['file'],'git.review':['file'],'git.apply':['review'],'git.finalize':['commit'],'git.transaction.inspect':['file'],'git.transaction.recover':['file']});
  const flags: Parsed['flags'] = {}; const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { args.push(token); continue; }
    const key = token.slice(2);
    if (!key || key.includes('=')) fail('INVALID_ARGUMENT', 2, 'Use explicit --option value arguments.');
    const value = BOOLEAN.has(key) ? 'true' : argv[++i];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT', 2, `Option --${key} requires a value.`);
    (flags[key] ??= []).push(value);
    if (key !== 'approval' && flags[key].length > 1) fail('INVALID_ARGUMENT', 2, `Option --${key} cannot repeat.`);
  }
  let command = args.shift() ?? 'help';
  command = ({ mat: 'materialize', dist: 'distill', flatten: 'release' } as Record<string, string>)[command] ?? command;
  if (['layer','config','context','backup','content','migration','assets','mediation','reports','source','git','drift','operation','evidence','criterion','adoption'].includes(command)) command += '.' + (args.shift() ?? '');
  if(command==='review' && ['inbox','state'].includes(args[0]))command+='.'+args.shift();
  if(command==='git.transaction')command+='.'+(args.shift()??'');
  if (command !== 'help' && !OPTIONS[command]) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown command.', { command });
  if (flags.json && flags.human) fail('INVALID_ARGUMENT', 2, 'Choose one output format: --json or --human.');
  for (const flag of Object.keys(flags)) if (![...COMMON, ...(OPTIONS[command] ?? [])].includes(flag)) fail('INVALID_ARGUMENT', 2, `Unknown option --${flag} for ${command}.`);
  return { command, args, flags };
}
function flag(p: Parsed, key: string, required = false): string | undefined { const value = p.flags[key]?.[0]; if (required && !value) fail('INVALID_ARGUMENT', 2, `--${key} is required.`); return value; }
function count(p: Parsed, n: number) { if (p.args.length !== n) fail('INVALID_ARGUMENT', 2, `${p.command} requires ${n} positional argument(s).`); }
async function jsonFile(file: string | undefined, stdin?: string) {
  if (!file) fail('INVALID_ARGUMENT', 2, 'A JSON input file is required.');
  try {
    if (file === '-') { let text = stdin; if (text === undefined) { text = ''; for await (const part of process.stdin) text += part; } return JSON.parse(text); }
    return JSON.parse(await readFile(path.resolve(file), 'utf8'));
  }
  catch (error) { fail('INVALID_RECORD', 2, 'Input must be one readable JSON object.', { reason: (error as Error).message }); }
}
async function findProject(explicit?: string) {
  let current = path.resolve(explicit ?? process.cwd());
  while (true) {
    try { await access(path.join(current, 'strata.config.json')); return current; } catch {}
    if (explicit || path.dirname(current) === current) fail('PROJECT_NOT_FOUND', 3, 'Use --project to select a folder with strata.config.json.');
    current = path.dirname(current);
  }
}
export async function runCli(argv: string[], stdin?: string, environment: NodeJS.ProcessEnv = process.env, controls: { issuer?:FixtureIssuer } = {}): Promise<Envelope> {
  let p: Parsed = { command: 'unknown', args: [], flags: {} };
  const envelope: Envelope = { protocol_version: '1', command: 'unknown', ok: true, exit_code: 0, mode: 'apply', operation_id: null, data: null, errors: [], warnings: [], effects: { created: [], reused: [], paths: [], network: [], usage: [] }, next_actions: [] };
  let remote:Awaited<ReturnType<typeof hostOperationClient>>|undefined;
  try {
    const localBuild = await parseLocalBuildCli(argv, stdin);
    if(localBuild) {
      envelope.command=localBuild.command;envelope.mode=localBuild.dry_run?'dry_run':'apply';
      if(localBuild.flags.help){envelope.data={commands:LOCAL_BUILD_CLI_HELP};return envelope;}
      const root=await findProject(localBuild.flags.project),config:any=await jsonFile(path.join(root,'strata.config.json'));
      const hosted=config.identity_policy==='host-accounts/1';
      const options={idempotency_key:localBuild.key,dry_run:localBuild.dry_run,expected_generation:localBuild.flags['expect-generation'],expected_policy:localBuild.flags['expect-policy']};
      if(hosted)remote=await hostOperationClient(config,environment,options);
      const response=await (remote?.call??localOperationClient(config,environment.STRATA_SESSION??'',options))(localBuild.command,localBuild.input);
      envelope.effects.network=[hosted?'configured-https-studio':'loopback-broker'];envelope.data=response.data;envelope.operation_id=response.operation_id??null;
      envelope.effects.created=localBuild.dry_run?[]:response.created??[];
      if(response.reused&&response.data?.ref)envelope.effects.reused.push(response.data.ref);
      return envelope;
    }
    p = parseArgs(argv); envelope.command = p.command; envelope.mode = flag(p, 'dry-run') ? 'dry_run' : 'apply';
    if (p.command === 'help' || flag(p, 'help') || flag(p, 'version')) { envelope.data = {...HELP,commands:[...HELP.commands,'source capture --file F','source bind --file F','drift check --file F','drift propose --file F','drift review --file F','drift revalidate --file F --idempotency-key KEY','git plan --file F','git stage PLAN --patch F','git check STAGE --checker ID --oracle F','git evidence --file F','git review --file F','git apply STAGE --review REVIEW','git finalize RECEIPT --commit OID','git transaction inspect --file F','git transaction recover --file F'],capabilities:{...HELP.capabilities,'git-patch/1':'explicit-local-Node-host','source-binding/1':'explicit-local-Node-host','source-drift/1':'explicit-local-Node-host'},limitations:[...HELP.limitations,'Git patch adoption supports bounded regular UTF-8 files and validated v0.1 intent; original index, commits and pushes remain owner-controlled. Automatic checking recognizes only the compiled synthetic counter fixture.']}; return envelope; }
    const dry = envelope.mode === 'dry_run';
    if (p.command === 'doctor') {
      count(p, 0);
      let config: any, configurationError: StrataError | undefined;
      try { config = await jsonFile(path.join(await findProject(flag(p, 'project')), 'strata.config.json')); }
      catch (error) { configurationError = error instanceof StrataError ? error : new StrataError('INVALID_RECORD', 2, 'Configuration could not be read.'); }
      const { probed, failure_exit, ...report } = await doctor(config, !!flag(p, 'offline'), HELP.capabilities, configurationError);
      envelope.data = report;
      if (probed) envelope.effects.network.push('loopback-health');
      if (failure_exit) { envelope.ok = false; envelope.exit_code = failure_exit; envelope.errors = report.checks.filter(check => check.status === 'failed').map(check => ({ code: check.code ?? 'DIAGNOSTIC_FAILED', message: check.message, retryable: false })); }
      return envelope;
    }
    if (['backup.verify', 'backup.inspect', 'backup.restore'].includes(p.command)) {
      count(p, 1);
      const input = { bundle: path.resolve(p.args[0]), project: flag(p, 'expect-project', true)!, expectedDigest: flag(p, 'expect-digest', p.command === 'backup.restore'), selector: environment.STRATA_SESSION ?? '' };
      try {
        if (p.command === 'backup.restore') { envelope.data = await restoreBackup({ ...input, expectedDigest: input.expectedDigest!, out: path.resolve(flag(p, 'out', true)!), dryRun: dry }); if (!dry) envelope.effects.paths.push(envelope.data.output); }
        else envelope.data = await verifyBackup({ ...input, ref: p.command === 'backup.inspect' ? flag(p, 'ref') : undefined });
      } catch (error) { throw backupError(error); }
      return envelope;
    }
    const root = await findProject(flag(p, 'project')); const config: any = await jsonFile(path.join(root, 'strata.config.json'));
    const hosted=config.identity_policy==='host-accounts/1';const broker=hosted?admitHostConfig(config):cliBroker(config);
    if(hosted&&['assets.import','backup.create'].includes(p.command))fail('UNSUPPORTED_CAPABILITY',8,'Hosted source/assets/backup operators are not configured.');
    if (p.command === 'config.show') { count(p, 0); envelope.data = { ...config, sources: { project: path.join(root, 'strata.config.json'), session: environment.STRATA_SESSION ? 'environment (redacted)' : 'not supplied' } }; return envelope; }
    if(p.command==='assets.import') { count(p,0); const assetIssuer=controls.issuer ?? new FixtureIssuer({project_id:config.project_id}); if(assetIssuer.projectId!==config.project_id) fail('PROJECT_FORBIDDEN',4,'Asset issuer must match the configured project.'); const source=await safePath(root,flag(p,'file',true)!,true); envelope.data=await importAsset(await safePath(root,flag(p,'state-dir',true)!,true),source,await jsonFile(flag(p,'metadata',true),stdin),environment.STRATA_SESSION ?? '',assetIssuer,dry); if(!dry) (envelope.data.reused ? envelope.effects.reused : envelope.effects.created).push(envelope.data.ref); return envelope; }
    if (p.command === 'backup.create') {
      count(p, 0); const max = flag(p, 'max-bytes', true)!;
      if (!/^[1-9][0-9]*$/.test(max)) fail('INVALID_ARGUMENT', 2, 'Use an explicit positive integer max-bytes.');
      try { envelope.data = await createBackup({ state: await safePath(root, flag(p, 'state-dir') ?? '.strata/node-state', true), out: path.resolve(root, flag(p, 'out', true)!), project: config.project_id, selector: environment.STRATA_SESSION ?? '', maxBytes: Number(max), dryRun: dry }); }
      catch (error) { throw backupError(error); }
      if (!dry) envelope.effects.paths.push(envelope.data.output);
      return envelope;
    }
    if(hosted)remote=await hostOperationClient(config,environment,{dry_run:dry,idempotency_key:flag(p,'idempotency-key')});
    const transport=remote?.call??localOperationClient(config,environment.STRATA_SESSION??'',{dry_run:dry,idempotency_key:flag(p,'idempotency-key')});
    async function call(command:string,input:unknown) {
      envelope.effects.network=[hosted?'configured-https-studio':'loopback-broker'];
      const response=await transport(command,input);
      envelope.operation_id=response.operation_id;envelope.effects.created.push(...(dry?[]:response.created??[]));
      if(response.reused&&response.data?.ref)envelope.effects.reused.push(response.data.ref);
      return response.data;
    }
    switch (p.command) {
      case 'capabilities':count(p,0);envelope.data=await call(p.command,{target:flag(p,'target')});break;
      case 'review.inbox':count(p,0);envelope.data=await call(p.command,{baseline:flag(p,'baseline'),limit:flag(p,'limit')?Number(flag(p,'limit')):25,cursor:flag(p,'cursor')});break;
      case 'review.state':count(p,1);envelope.data=await call(p.command,{ref:p.args[0]});break;
      case 'layer.preview':count(p,0);envelope.data=await call(p.command,{record:await jsonFile(flag(p,'file',true),stdin)});break;
      case 'operation.inspect':count(p,1);envelope.data=await call(p.command,{key:p.args[0]});break;
      case 'adoption.prepare': case 'adoption.review': case 'source.capture': case 'source.bind': case 'drift.check': case 'drift.propose': case 'drift.review': case 'drift.revalidate': case 'git.plan': case 'git.evidence': case 'git.review': case 'git.transaction.inspect': case 'git.transaction.recover':
        count(p,0);envelope.data=await call(p.command,await jsonFile(flag(p,'file',true),stdin));break;
      case 'git.stage': count(p,1);envelope.data=await call(p.command,{plan:p.args[0],patch:await readFile(path.resolve(flag(p,'patch',true)!),'utf8')});break;
      case 'git.check': count(p,1);envelope.data=await call(p.command,{stage:p.args[0],checker:flag(p,'checker',true),oracle:await jsonFile(flag(p,'oracle',true),stdin)});break;
      case 'git.apply':count(p,1);envelope.data=await call(p.command,{stage:p.args[0],review:flag(p,'review',true)});if(!dry)envelope.effects.paths.push(...(envelope.data.record?.paths??[]));break;
      case 'git.finalize':count(p,1);envelope.data=await call(p.command,{receipt:p.args[0],commit:flag(p,'commit',true)});break;
      case 'init': count(p, 0); envelope.data = await call('init', { record: await jsonFile(flag(p, 'file', true), stdin) }); break;
      case 'context.show': case 'context.use': {
        count(p, p.command === 'context.show' ? 0 : 1);
        const workspace = digest({ root: await realpath(root), project_id: config.project_id });
        const input: any = { workspace };
        if (p.command === 'context.use') {
          const value = flag(p, 'expect-generation', true)!;
          if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_ARGUMENT', 2, 'Use a nonnegative integer context generation.');
          input.target = p.args[0]; input.expected_generation = Number(value);
        }
        envelope.data = await call(p.command, input); break;
      }
      case 'layer.restore': count(p, 1); envelope.data = await call(p.command, { ref: p.args[0], from: flag(p, 'from', true) }); break;
      case 'status': count(p, 0); envelope.data = await call('status', { target: flag(p, 'candidate') }); break;
      case 'review': {
        count(p, 2); const [type, ref] = p.args;
        if (!REVIEW_TYPES.includes(type as ReviewType)) fail('UNSUPPORTED_CAPABILITY', 8, 'Review supports Layer, validation and authoring-review records only.');
        if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/.test(ref)) fail('INVALID_ARGUMENT', 2, 'Review requires one exact record reference.');
        const inspected=await call('inspect',{type,ref});
        envelope.data = reviewRecord(type as ReviewType, ref, Object.hasOwn(REVALIDATION_SCHEMAS,type)?inspected.record:inspected); break;
      }
      case 'inspect': {
        if (p.args.length < 1 || p.args.length > 2) fail('INVALID_ARGUMENT', 2, 'inspect requires TYPE and optional exact REF.');
        const [type, ref] = p.args; const types = ['block', 'layer', 'composition', 'resolution', 'release', 'realization', 'validation', 'approval', 'asset', 'authoring-review',...Object.keys(GIT_ADOPTION_SCHEMAS),...Object.keys(SOURCE_BINDING_SCHEMAS),...Object.keys(DRIFT_SCHEMAS),...Object.keys(ADOPTION_RECORD_SCHEMAS),...Object.keys(REVALIDATION_SCHEMAS)];
        if (!types.includes(type)) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown record type.');
        if (type === 'block' && (!ref || !flag(p, 'at'))) fail('UNSUPPORTED_CAPABILITY', 8, 'The initial Block inspector requires an ID and --at exact snapshot.');
        envelope.data = await call('inspect', { type, ref: type === 'block' ? `${flag(p, 'at')}#${ref}` : ref, limit: flag(p, 'limit') ? Number(flag(p, 'limit')) : 25, cursor: flag(p, 'cursor') }); break;
      }
      case 'diff': count(p, 2); envelope.data = await call('diff', { left: p.args[0], right: p.args[1] }); break;
      case 'layer.create': count(p, 0); envelope.data = await call(p.command, { record: await jsonFile(flag(p, 'file', true), stdin) }); break;
      case 'layer.revise': count(p, 1); envelope.data = await call(p.command, { previous: p.args[0], record: await jsonFile(flag(p, 'file', true), stdin) }); break;
      case 'layer.publish': count(p, 1); envelope.data = await call(p.command, { ref: p.args[0], review: flag(p, 'review') ? await jsonFile(flag(p, 'review'), stdin) : undefined, authoring_review:flag(p,'authoring-review'), adoption_review:flag(p,'adoption-review') }); break;
      case 'content.review': count(p,0); envelope.data=await call(p.command,{record:await jsonFile(flag(p,'file',true),stdin)}); break;
      case 'migration.preview': count(p,1); envelope.data=await call(p.command,{source:p.args[0],source_digest:flag(p,'source-digest',true)}); break;
      case 'assets.inspect': count(p,1); envelope.data=await call('inspect',{type:'asset',ref:p.args[0]}); break;
      case 'compose': count(p, 0); envelope.data = await call(p.command, { record: await jsonFile(flag(p, 'file', true), stdin) }); if (envelope.data.state === 'blocked') { envelope.ok = false; envelope.exit_code = 5; envelope.errors = envelope.data.diagnostics.map((d: any) => ({ ...d, retryable: false })); } break;
      case 'conflicts': count(p, 1); envelope.data = await call(flag(p, 'report') ? 'conflicts.report' : 'conflicts', { target: p.args[0], report: flag(p, 'report') ? await jsonFile(flag(p, 'report'), stdin) : undefined }); break;
      case 'resolve': {
        count(p, 0); const record = await jsonFile(flag(p, 'file', true), stdin); record.approvals = [...(record.approvals ?? []), ...(p.flags.approval ?? [])]; envelope.data = await call(p.command, { record }); break;
      }
      case 'evidence.assemble':case 'mediation.install':case 'evidence.run':case 'criterion.review':case 'mediation.prepare': case 'mediation.respond': case 'reports.dispose': count(p,0);envelope.data=await call(p.command,await jsonFile(flag(p,'file',true),stdin));break;
      case 'approve': count(p, 0); envelope.data = await call(p.command, { record: await jsonFile(flag(p, 'file', true), stdin) }); break;
      case 'materialize': {
        count(p, 1); envelope.data = hosted?await call(p.command,{target:p.args[0],profile:flag(p,'profile',true),slot:flag(p,'slot',true)}):await runNodeCommand(root, call, p.command, {target:p.args[0],profile:flag(p,'profile',true),out:flag(p,'out',true)},dry);
        if(!dry)envelope.effects.paths.push(envelope.data.output); break;
      }
      case 'distill': {
        count(p, 0); const source: any = await jsonFile(flag(p, 'source', true), stdin); const proposal: any = await jsonFile(flag(p, 'proposal', true), stdin);
        if (!source || Object.keys(source).some(k => !['root', 'files'].includes(k)) || typeof source.root !== 'string' || !Array.isArray(source.files)) fail('INVALID_RECORD', 2, 'Source manifest requires only an authorized root and explicit files with digests.');
        const sourceRoot = await safePath(root, source.root, true); const seen = new Set<string>(); const canonicalFiles = new Set<string>();
        for (const entry of source.files) {
          if (!entry || Object.keys(entry).some(k => !['path', 'digest'].includes(k)) || typeof entry.path !== 'string' || typeof entry.digest !== 'string' || seen.has(entry.path)) fail('INVALID_RECORD', 2, 'Source files must be unique explicit path/digest pairs.');
          seen.add(entry.path); const full = await safePath(sourceRoot, entry.path, true);
          // Canonical identity comes from the filesystem, not from resolve/lowercasing: realpath collapses case and short-name aliases on case-insensitive hosts while keeping distinct files distinct on case-sensitive ones.
          const canonicalPath = await realpath(full);
          if (canonicalFiles.has(canonicalPath)) fail('INVALID_RECORD', 2, 'Source files must be unique: multiple spellings of one file are refused.', { path: entry.path, canonical: canonicalPath });
          canonicalFiles.add(canonicalPath);
          if (bytesDigest(await readFile(full)) !== entry.digest) fail('STALE_SOURCE', 5, 'Distillation source bytes differ from the manifest.');
        }
        if (!source.files.length || !proposal.layer || !Array.isArray(proposal.traceability) || !Array.isArray(proposal.questions)) fail('INVALID_RECORD', 2, 'Supplied proposal requires layer, traceability, and questions.');
        if (Object.keys(proposal).some(k => !['layer', 'traceability', 'questions'].includes(k))) fail('INVALID_RECORD', 2, 'Unknown supplied proposal field.');
        if (proposal.layer.id !== flag(p, 'layer', true)) fail('INVALID_RECORD', 2, 'Proposal Layer ID differs from --layer.');
        for (const change of [...proposal.layer.changes, ...proposal.layer.acceptance.map((a: any) => ({ block: a.block, path: 'acceptance.' + a.id }))]) {
          const key = change.block + '/' + change.path;
          const trace = proposal.traceability.filter((t: any) => t.item === key);
          if (trace.length !== 1 || !['observed', 'inferred', 'correction', 'uncovered'].includes(trace[0].classification) || typeof trace[0].rationale !== 'string' || !trace[0].rationale.trim() || !Array.isArray(trace[0].files) || !trace[0].files.length || trace[0].files.some((f: string) => !seen.has(f))) fail('TRACEABILITY_REQUIRED', 2, 'Every change needs explicit source-file traceability and classification.', { item: key });
        }
        const target = flag(p, 'against', true)!; const against = await call('conflicts', { target });
        const record = proposal.layer;
        if (record.baseline !== against.baseline_ref) fail('MIXED_BASELINE', 5, 'Distillation must use the exact against-target baseline.');
        if (against.target_type === 'composition' && against.state === 'blocked') fail('BLOCKED_CANDIDATE', 5, 'Distillation against a Composition requires eligible effective intent.');
        // A prepared proposal carries intent; this command performs no inference or external model call.
        record.derived_from = { kind: 'supplied_proposal', source_digest: digest(source), against: target, traceability: proposal.traceability, questions: proposal.questions };
        envelope.data = await call('layer.create', { record }); envelope.data = { ...envelope.data, classification: 'supplied_proposal', source_digest: digest(source), review_required: true }; break;
      }
      case 'validate': count(p,1);if(hosted){envelope.data=await call(p.command,{target:p.args[0],slot:flag(p,'slot',true),evidence:await jsonFile(flag(p,'evidence',true),stdin)});break;} envelope.data=await runNodeCommand(root,call,p.command,{target:p.args[0],manifest:path.resolve(flag(p,'realization',true)!),evidence:await jsonFile(flag(p,'evidence',true),stdin)},dry);break;
      case 'release': count(p,1);if(hosted){envelope.data=await call(p.command,{target:p.args[0],validation:flag(p,'validation',true),approvals:p.flags.approval??[]});break;} envelope.data=await runNodeCommand(root,call,p.command,{target:p.args[0],validation:flag(p,'validation',true),approvals:p.flags.approval??[]},dry);break;
    }
    if (dry) envelope.effects = { created: [], reused: [], paths: [], network: envelope.effects.network, usage: [] };
    if (p.command.startsWith('layer.') && envelope.data?.published === false) envelope.next_actions.push({ command: 'layer publish', arguments: [envelope.data.ref], reason: 'Drafts are not selected or visible as published proposals.' });
  } catch (error) {
    const failure = error instanceof StrataError ? error : new StrataError('INTERNAL_ERROR', 1, (error as Error).message);
    if (envelope.mode === 'dry_run' && failure.exit === 6 && ['resolve','approve','release'].includes(p.command)) { envelope.ok = true; envelope.data = { execution_ready: false, blockers: [{ code: failure.code, message: failure.message }] }; }
    else { envelope.ok = false; envelope.exit_code = failure.exit; envelope.errors = [{ code: failure.code, message: failure.message, retryable: [9].includes(failure.exit), details: failure.details }]; }
  }
  finally {await remote?.close();}
  return envelope;
}
export function formatHuman(result: Envelope): string {
  const lines = [`${result.command}: ${result.ok ? 'ok' : 'blocked'} (exit ${result.exit_code}, ${result.mode})`];
  const data = result.data;
  if (data?.commands) {
    lines.push(...data.commands.map((c: string) => '  ' + c), `Block contract: ${data.block_contract}`, 'Use --human for readable output; --json for the stable machine envelope.');
    lines.push(...(data.limitations ?? []).map((limit: string) => 'Limit: ' + limit));
  }
  else if (data && typeof data === 'object') {
    if (data.format === 'strata-doctor/1') {
      for (const check of [...data.checks, ...data.verification]) lines.push(`${check.id}: ${check.status} — ${check.message}`, ...(check.next_action ? [`  Next: ${check.next_action}`] : []));
      lines.push(`Supported CLI profiles: ${data.capabilities.supported_cli_profiles.join(', ')}`, `Configured profiles: ${data.capabilities.configured_profiles.join(', ') || 'none'}`, `Runtime: ${data.capabilities.runtime ?? 'not checked'}; runtime capabilities: ${data.capabilities.runtime_capabilities}`);
      lines.push('CLI support (advertised, not runtime-verified): ' + JSON.stringify(data.capabilities.cli_support));
    }
    if (data.format === 'strata-review/1') {
      lines.push(`Review: ${data.subject.ref}; record digest: ${data.subject.record_sha256}`);
      for (const assertion of data.assertions) lines.push(`Assertion [${assertion.kind}] ${JSON.stringify(assertion)}`);
      for (const observation of data.observations) lines.push(`Observation [${observation.kind}] ${JSON.stringify(observation)}`);
      for (const limit of data.unverified) lines.push(`Unverified: ${limit}`);
    }
    for (const key of ['ref', 'state', 'fingerprint', 'target', 'scope', 'profile', 'manifest', 'model_version', 'identity_policy', 'artifact_adapter', 'records', 'generation', 'target_type', 'baseline_ref', 'candidate_state', 'output', 'manifest_sha256', 'checkpoint_sha256', 'complete', 'verified', 'restored', 'inactive', 'identities_active', 'requests_active', 'authors_authenticated', 'execution_ready']) if (data[key] !== undefined && data[key] !== null) lines.push(`${key.replaceAll('_', ' ')}: ${data[key]}`);
    if (data.purpose) lines.push(`Block ${data.id}: ${data.purpose}`, `Facets: ${(data.derived_facets ?? []).join(', ') || 'none'}`);
    for (const [id, requirement] of Object.entries(data.requirements ?? {}) as [string, any][]) lines.push(`  ${id} [${requirement.facets.join(', ')}]: ${requirement.statement}`);
    for (const [id, criterion] of Object.entries(data.acceptance ?? {}) as [string, any][]) lines.push(`  Acceptance ${id} (${criterion.method}): ${criterion.statement}`);
    if (data.items) lines.push(...data.items.map((ref: string) => '  ' + ref), `Total: ${data.total}; next cursor: ${data.next_cursor ?? 'none'}`);
    const evaluation = data.evaluation ?? data.candidate ?? data;
    if (evaluation !== data && evaluation.state) lines.push(`Candidate: ${evaluation.state}; ${evaluation.fingerprint}`);
    if (evaluation.snapshot) lines.push(`Blocks: ${Object.keys(evaluation.snapshot.blocks).length}; obligations: ${evaluation.obligations?.length ?? 'unknown'}`);
    for (const d of evaluation.diagnostics ?? data.blockers ?? []) lines.push(`  ${d.code}: ${d.message}`);
    if (data.selected_layers) lines.push(`Selected Layers: ${data.selected_layers.join(', ') || 'none'}`);
    if (data.record) lines.push('Historical record: ' + JSON.stringify(data.record, null, 2));
    if (data.recovery) lines.push(`Restored ${data.recovery.source} through new draft ${data.ref}; previous head ${data.recovery.previous}`);
    if (data.owned_heads) lines.push(`Owned Layers: ${Object.keys(data.owned_heads).join(', ') || 'none'}`);
    if (!lines.slice(1).length) lines.push(JSON.stringify(data, null, 2));
  }
  for (const e of result.errors) lines.push(`${e.code}: ${e.message}`);
  for (const next of result.next_actions) lines.push(`Next: ${next.command} ${(next.arguments ?? []).join(' ')} â€” ${next.reason}`);
  return lines.join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if(args[0]==='studio'&&args[1]==='agents'){await (await import('../scripts/studio-agents.js')).launchAgentCli(args.slice(2));}
  else if(args[0]==='studio'&&args[1]==='connections'){await (await import('../scripts/studio-connections.js')).launchConnectionCli(args.slice(2));}
  else if(['studio','explorer'].includes(args[0])){await (await import('../scripts/studio.js')).launchStudio(args.slice(1));}
  else {const result = await runCli(args);
  process.stdout.write(args.includes('--human') && !args.includes('--json') ? formatHuman(result) : JSON.stringify(result) + '\n'); process.exitCode = result.exit_code;}
}
