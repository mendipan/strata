import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../model.js';
import { parseLocalBuildOperation } from '../build-operations.js';

export const LOCAL_BUILD_CLI_HELP = [
  'repo compatibility [--release REF]', 'repo contract import --file F [--previous REF]',
  'repo contract attach --release R --contract C --expect-release HASH',
  'profiles list [--contract REF] [--limit N] [--cursor REF]', 'profiles show REF',
  'profiles validate --file F [--release R]', 'profiles create --file F --expect-digest HASH',
  'profiles revise REF --file F --expect-digest HASH', 'profiles archive REF',
  'build context [--release R]', 'build plan --release R --profile-ref P --destination local --slot HOST_SLOT',
  'build --release R --profile-ref P --destination local --slot HOST_SLOT --expect-plan HASH --idempotency-key KEY',
  'build status BUILD_ID', 'build outputs BUILD_ID',
];
const options: Record<string, string[]> = {
  'repository.compatibility': ['release'], 'repository.contract.import': ['file', 'previous'],
  'repository.contract.attach': ['release', 'contract', 'expect-release'],
  'profile.list': ['contract', 'limit', 'cursor'], 'profile.inspect': [], 'profile.validate': ['file', 'release'],
  'profile.create': ['file', 'expect-digest'], 'profile.revise': ['file', 'expect-digest'], 'profile.archive': [],
  'build.context': ['release', 'limit', 'cursor'], 'build.prepare': ['release', 'profile-ref', 'slot', 'destination'],
  'build.start': ['release', 'profile-ref', 'slot', 'expect-plan', 'destination'], 'build.inspect': [], 'build.outputs': [],
};
const booleans = ['json', 'human', 'non-interactive', 'dry-run', 'help'];
export type BuildCliRequest = { command: string; input: any; flags: Record<string, string>; key?: string; dry_run: boolean };
/** Pure CLI routing/strict request construction; --profile remains the legacy materializer flag. */
export async function parseLocalBuildCli(argv: string[], stdin?: string): Promise<BuildCliRequest | null> {
  if (!['repo', 'profiles', 'build'].includes(argv[0])) return null;
  const tokens = [...argv], family = tokens.shift()!;
  const verb = tokens[0]?.startsWith('--') ? undefined : tokens.shift();
  const help = tokens.includes('--help');
  let command = family === 'profiles' ? 'profile.' + (verb === 'show' ? 'inspect' : verb ?? (help ? 'list' : '')) : family === 'build' ? 'build.' + ({ plan: 'prepare', status: 'inspect' }[verb as 'plan' | 'status'] ?? verb ?? 'start') : 'repository.' + (verb ?? (help ? 'compatibility' : ''));
  if (command === 'repository.contract') command += '.' + tokens.shift();
  if (!options[command]) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown Local Profiles/Build command.');
  const flags: Record<string, string> = {}, args: string[] = [];
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n]; if (!token.startsWith('--')) { args.push(token); continue; }
    const flag = token.slice(2);
    if (![...options[command], ...booleans, 'project', 'idempotency-key', 'expect-generation', 'expect-policy'].includes(flag) || Object.hasOwn(flags, flag)) fail('INVALID_ARGUMENT', 2, 'Unknown or repeated Local Build option.');
    const value = booleans.includes(flag) ? 'true' : tokens[++n];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT', 2, 'Local Build option needs an explicit value.'); flags[flag] = value;
  }
  if (flags.json && flags.human) fail('INVALID_ARGUMENT', 2, 'Choose one output format.');
  if (flags.help) return { command, input: {}, flags, key: flags['idempotency-key'], dry_run: !!flags['dry-run'] };
  const required = (flag: string) => { if (!flags[flag]) fail('INVALID_ARGUMENT', 2, `--${flag} is required.`); return flags[flag]; };
  const one = ['profile.inspect', 'profile.revise', 'profile.archive', 'build.inspect', 'build.outputs'].includes(command);
  if (args.length !== (one ? 1 : 0)) fail('INVALID_ARGUMENT', 2, 'Local Build positional arguments differ from the command contract.');
  let input: any = {};
  if (flags.file) {
    let text = stdin;
    try {
      if (flags.file === '-' && text === undefined) {
        text = ''; for await (const part of process.stdin) { text += part; if (Buffer.byteLength(text) > 65536) fail('INVALID_ARGUMENT', 2, 'Local Build input exceeds 64 KiB.'); }
      } else if (flags.file !== '-') {
        const filename = path.resolve(flags.file), meta = await lstat(filename);
        if (!meta.isFile() || meta.size > 65536) fail('INVALID_ARGUMENT', 2, 'Local Build input requires a regular file within 64 KiB.');
        text = await readFile(filename, 'utf8');
      }
      if (!text || Buffer.byteLength(text) > 65536) fail('INVALID_ARGUMENT', 2, 'Local Build input exceeds its byte bound.');
      input.record = JSON.parse(text);
    }
    catch { fail('INVALID_RECORD', 2, 'Expected one local JSON profile or compatibility file.'); }
  }
  if (['repository.contract.import', 'profile.validate', 'profile.create', 'profile.revise'].includes(command)) required('file');
  if (command === 'repository.compatibility' && flags.release) input.release_ref = flags.release;
  else if (command === 'build.context') input = { ...(flags.release ? { release_ref: flags.release } : {}), ...(flags.limit ? { limit: Number(flags.limit) } : {}), ...(flags.cursor ? { cursor: flags.cursor } : {}) };
  else if (command === 'repository.contract.import') input.previous = flags.previous ?? null;
  else if (command === 'repository.contract.attach') input = { release_ref: required('release'), contract_ref: required('contract'), expected_release_sha256: required('expect-release') };
  else if (command === 'profile.list') input = { ...(flags.contract ? { contract_ref: flags.contract } : {}), ...(flags.limit ? { limit: Number(flags.limit) } : {}), ...(flags.cursor ? { cursor: flags.cursor } : {}) };
  else if (['profile.inspect', 'profile.archive'].includes(command)) input.ref = args[0];
  else if (command === 'profile.validate' && flags.release) input.target_ref = flags.release;
  else if (['profile.create', 'profile.revise'].includes(command)) {
    input.expected_normalized_sha256 = required('expect-digest'); if (command === 'profile.revise') input.previous = args[0];
  } else if (['build.prepare', 'build.start'].includes(command)) {
    if (flags.destination && flags.destination !== 'local') fail('UNSUPPORTED_CAPABILITY', 8, 'Only Local (Studio host) builds are supported.');
    const selection = { release_ref: required('release'), profile_ref: required('profile-ref'), destination: { kind: 'local', slot_id: required('slot') } };
    input = command === 'build.prepare' ? selection : { selection, expected_plan_sha256: required('expect-plan') };
  } else if (['build.inspect', 'build.outputs'].includes(command)) input.build_id = args[0];
  return { command, input: parseLocalBuildOperation(command, input), flags, key: flags['idempotency-key'], dry_run: !!flags['dry-run'] };
}
export async function runLocalBuildCli(argv: string[], call: (command: string, input: unknown, options: { idempotency_key?: string; dry_run?: boolean; expected_generation?: string; expected_policy?: string }) => Promise<any>, stdin?: string) {
  const request = await parseLocalBuildCli(argv, stdin); if (!request) return null;
  if (request.flags.help) return { ok: true, data: { commands: LOCAL_BUILD_CLI_HELP } };
  return call(request.command, request.input, { idempotency_key: request.key, dry_run: request.dry_run, expected_generation: request.flags['expect-generation'], expected_policy: request.flags['expect-policy'] });
}
