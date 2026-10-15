import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { probeSubscriptionCli } from '../src/integrated-demo-operator.js';

const status = 'Logged in using ChatGPT';
const cleanup = 'WARNING: failed to clean up stale arg0 temp dirs: Access is denied. (os error 5)';
const pathWarning = String.raw`WARNING: proceeding, even though we could not create PATH aliases: Access is denied. (os error 5) at path "C:\\Synthetic\\.codex\\tmp\\arg0\\codex-arg0ABC123"`;
const warnings = cleanup + '\n' + pathWarning;
const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-cli-auth-status-'));
const entrypoint = path.join(directory, 'metadata-only.js');
await writeFile(entrypoint, '// Never invoked; production metadata callback is supplied.\n');
const assertStatus = async (auth: { code: number; stdout: string; stderr: string }, accepted: boolean) => {
  const result = probeSubscriptionCli(process.cwd(), { CODEX_CLI_ENTRYPOINT: entrypoint }, async (_entrypoint, args) =>
    args[0] === '--version' ? { code: 0, stdout: 'codex-cli 0.160.1', stderr: '' }
      : args.includes('--help') ? { code: 0, stdout: '--model --sandbox --ephemeral --json --ignore-user-config --skip-git-repo-check', stderr: '' } : auth);
  if (accepted) {
    assert.equal((await result).billing_mode, 'chatgpt-subscription');
  } else await assert.rejects(result, (error: any) => error.code === 'DEMO_OPERATOR_AUTH_REQUIRED');
};

for (const stdout of [true, false]) test(`accept one exact subscription status on ${stdout ? 'stdout' : 'stderr'} with the two observed Codex 0.160.1 warnings`, async () => {
  await assertStatus({ code: 0, stdout: stdout ? status + '\r\n' : '', stderr: warnings + '\n' + (stdout ? '' : status + '\n') }, true);
});

test('clean subscription status and either known stderr warning remain compatible', async () => {
  for (const stderr of ['', cleanup, pathWarning, pathWarning.replaceAll('\\\\', '\\')])
    await assertStatus({ code: 0, stdout: status, stderr }, true);
});

for (const [name, stdout, stderr, code] of [
  ['API key', '', warnings + '\nLogged in using an API key', 0],
  ['no login', '', warnings + '\nNot logged in', 0],
  ['only warnings', '', warnings, 0],
  ['conflicting status', status, warnings + '\nLogged in using an API key', 0],
  ['duplicate status across streams', status, warnings + '\n' + status, 0],
  ['duplicate status within stream', '', status + '\n' + status, 0],
  ['unknown diagnostic', status, warnings + '\nWARNING: authentication state uncertain', 0],
  ['unknown prose', status, 'Using a different account', 0],
  ['known warnings on stdout', warnings + '\n' + status, '', 0],
  ['different operating system error', status, cleanup.replace('os error 5', 'os error 2'), 0],
  ['non-arg0 PATH destination', status, pathWarning.replace('codex-arg0ABC123', 'other'), 0],
  ['relative PATH destination', status, pathWarning.replace('C:\\\\Synthetic', 'Synthetic'), 0],
  ['duplicate diagnostic', status, cleanup + '\n' + cleanup, 0],
  ['nonzero exit with successful-looking status', '', warnings + '\n' + status, 1],
] as const) test(`refuse ${name}`, async () => {
  await assertStatus({ code, stdout, stderr }, false);
});

test('production metadata probe accepts native warning layout and never forwards API keys or invokes generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-cli-auth-metadata-'));
  const entrypoint = path.join(directory, 'metadata-only.js');
  await writeFile(entrypoint, '// Never invoked; existing metadata boundary is supplied below.\n');
  const calls: string[][] = [];
  const result = await probeSubscriptionCli(process.cwd(), { CODEX_CLI_ENTRYPOINT: entrypoint, OPENAI_API_KEY: 'synthetic-not-forwarded' },
    async (_entrypoint, args, environment) => {
      assert.equal(environment.OPENAI_API_KEY, undefined);
      calls.push(args);
      return args[0] === '--version' ? { code: 0, stdout: 'codex-cli 0.160.1\n', stderr: warnings }
        : args.includes('--help') ? { code: 0, stdout: '--model --sandbox --ephemeral --json --ignore-user-config --skip-git-repo-check', stderr: warnings }
        : { code: 0, stdout: '', stderr: warnings + '\n' + status + '\n' };
    });
  assert.equal(result.version, '0.160.1');
  assert.equal(result.billing_mode, 'chatgpt-subscription');
  assert.equal(result.model_availability_verified, false);
  assert.deepEqual(calls, [['--version'], ['exec', '--help'], ['login', 'status']]);
});

test('production version and required-flag guards remain strict despite known warnings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-cli-auth-guards-'));
  const entrypoint = path.join(directory, 'metadata-only.js'); await writeFile(entrypoint, '// Never invoked.\n');
  for (const incompatible of ['version', 'flags']) {
    await assert.rejects(probeSubscriptionCli(process.cwd(), { CODEX_CLI_ENTRYPOINT: entrypoint }, async (_entrypoint, args) => ({
      code: 0, stderr: args[0] === 'login' ? warnings + '\n' + status : warnings,
      stdout: args[0] === '--version' ? `codex-cli ${incompatible === 'version' ? '0.160.2' : '0.160.1'}`
        : args.includes('--help') ? '--model --sandbox --ephemeral --json --ignore-user-config' + (incompatible === 'flags' ? '' : ' --skip-git-repo-check') : ''
    })), (error: any) => error.code === 'DEMO_OPERATOR_CLI_UNSUPPORTED');
  }
});
