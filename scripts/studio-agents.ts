import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { OwnerAgentClient } from '../src/explorer/agent-client.js';
import { agentConnectionActionSchema } from '../src/explorer/agent-connection.js';
import { ExplorerError, problem, safeJson } from '../src/explorer/contract.js';
import { passwordInput } from './studio-connections.js';

export async function launchAgentCli(args: string[]) {
  let client: OwnerAgentClient | undefined;
  try {
    const action = args.shift();
    if (!action || !['status', 'outcome', 'configure', 'test', 'connect', 'retry', 'disconnect', 'revoke', 'remove'].includes(action)) problem('INVALID_INPUT', 400, 'Use studio agents status|outcome|configure|test|connect|retry|disconnect|revoke|remove.');
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (!['--origin', '--username', '--file', '--request-id', '--password-stdin'].includes(key) || Object.hasOwn(flags, key)) problem('INVALID_INPUT', 400, 'Unsupported or repeated agent CLI option.');
      if (key === '--password-stdin') flags[key] = true;
      else { const value = args[++i]; if (!value || value.startsWith('--')) problem('INVALID_INPUT', 400, 'Agent CLI option requires a value.'); flags[key] = value; }
    }
    let body: unknown;
    if (action === 'status') { if (flags['--file'] || flags['--request-id']) problem('INVALID_INPUT', 400, 'Status accepts no action file or request ID.'); }
    else if (action === 'outcome') { if (typeof flags['--request-id'] !== 'string' || flags['--file']) problem('INVALID_INPUT', 400, 'Outcome needs only --request-id.'); }
    else {
      if (typeof flags['--file'] !== 'string' || flags['--request-id']) problem('INVALID_INPUT', 400, 'An action requires --file with the exact nonsecret revision and request ID.');
      const bytes = await readFile(flags['--file']);
      if (bytes.byteLength > 1024) problem('INVALID_INPUT', 400, 'Agent action file exceeds one KiB.');
      const parsed = agentConnectionActionSchema.safeParse(safeJson(new TextDecoder('utf8', { fatal: true }).decode(bytes), 1024));
      if (!parsed.success || parsed.data.action !== action) problem('INVALID_INPUT', 400, 'Use the strict agent action matching the CLI operation.');
      body = parsed.data;
    }
    if (typeof flags['--origin'] !== 'string') problem('INVALID_INPUT', 400, 'Specify the approved --origin HTTPS URL.');
    client = new OwnerAgentClient(flags['--origin']);
    let username = flags['--username'];
    if (typeof username !== 'string') {
      if (!process.stdin.isTTY) problem('INVALID_INPUT', 400, 'Supply the nonsecret --username.');
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try { username = await prompt.question('Studio owner name: '); } finally { prompt.close(); }
    }
    await client.login(username, await passwordInput(!!flags['--password-stdin']));
    const result = action === 'status' ? await client.status() : action === 'outcome' ? await client.outcome(flags['--request-id'] as string) : await client.action(body);
    // One-shot CLI sessions are closed explicitly. A successful connect receipt
    // proves that exchange; sign-out invalidates ephemeral runtime readiness.
    await client.close();client=undefined;
    process.stdout.write(JSON.stringify({ ...result, client_session: { state: 'closed', readiness_retained: false } }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { code: error instanceof ExplorerError ? error.code : 'AGENT_UNAVAILABLE', message: 'Agent CLI did not confirm completion. Inspect the exact request outcome before retrying.' } }) + '\n'); process.exitCode = 1;
  } finally { await client?.close().catch(() => {}); }
}
