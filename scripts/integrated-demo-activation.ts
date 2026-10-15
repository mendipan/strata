import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { canonical, digest, fail } from '../src/model.js';
import { approveDemoActivationReview, confirmDemoActivationReview, createDemoActivationReview, createDemoActivationWorkerConfig, demoActivationGrantDigest, readDemoActivationSource,
  type DemoActivationReview } from '../src/integrated-demo-activation.js';
import type { DemoManagementTarget } from '../src/integrated-demo-management.js';

const INPUT_LIMIT = 1024 * 1024;
export type ActivationTerminal = { stdin_is_tty: boolean; stdout_is_tty: boolean; write(text: string): void; ask(prompt: string): Promise<string>; close?(): void };

async function readJson(file: string) {
  const bytes = await readFile(path.resolve(file));
  if (bytes.byteLength > INPUT_LIMIT) fail('DEMO_ACTIVATION_FILE_REFUSED', 4, 'Activation input exceeds its local size bound.');
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('DEMO_ACTIVATION_FILE_REFUSED', 4, 'Activation input is not valid JSON.'); }
}
async function writeNewJson(file: string, value: unknown) {
  const target = path.resolve(file), handle = await open(target, 'wx', 0o600); let complete = false;
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); complete = true; }
  finally { await handle.close(); if (!complete) await unlink(target).catch(() => undefined); }
}
function terminal(): ActivationTerminal {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return { stdin_is_tty: process.stdin.isTTY === true, stdout_is_tty: process.stdout.isTTY === true,
    write: text => process.stdout.write(text), ask: prompt => readline.question(prompt), close: () => readline.close() };
}

export async function runDemoActivationCli(argv: string[], now?: number, suppliedTerminal?: ActivationTerminal, projectRoot = process.cwd()) {
  const [mode, inputPath, outputPath, grantId] = argv;
  if (mode === 'prepare' && inputPath && outputPath && grantId && argv.length === 4) {
    const target = await readJson(inputPath) as DemoManagementTarget;
    const source = await readDemoActivationSource(projectRoot);
    const review = createDemoActivationReview(grantId, target, source);
    await writeNewJson(outputPath, review);
    return { mode, output_path: path.resolve(outputPath), review_sha256: review.review_sha256, live_authorized: false,
      status: review.status, source_sha256: source.sha256, target_sha256: review.target_sha256,
      repo_tokens_issued_max: review.limits.repo_tokens_issued, dispatches: 0 };
  }
  if ((mode === 'attend' || mode === 'confirm') && inputPath && outputPath && argv.length === 3) {
    const terminalPort = suppliedTerminal ?? terminal();
    try {
      if (terminalPort.stdin_is_tty !== true || terminalPort.stdout_is_tty !== true)
        fail('DEMO_ACTIVATION_TTY_REQUIRED', 7, 'Activation review requires an attended local terminal.');
      const review = await readJson(inputPath) as DemoActivationReview;
      const source = await readDemoActivationSource(projectRoot), challenge = demoActivationGrantDigest(review);
      if (mode === 'attend') terminalPort.write('Prepared disabled activation review:\n' + JSON.stringify({ grant_id: review.grant_id, target: review.target,
        target_sha256: review.target_sha256, source_sha256: review.source.sha256, limits: review.limits, review_sha256: challenge }, null, 2) + '\n\n');
      else terminalPort.write(
        '\nReady to start one private demo:\n' +
        `  Account: ${review.target.account_id}\n  Namespace (kept): ${review.target.namespace_id}\n` +
        `  Temporary Worker: ${review.target.worker_name}\n  Workflow: ${review.target.workflow_name}\n` +
        `  Instance: ${review.target.instance_id}\n  Repository: ${review.target.repository_name}\n` +
        '  Three Luna 6 actors: two Medium, one High; at most two concurrent. ChatGPT subscription only.\n' +
        '  30 minutes including deletion of these temporary resources. Namespace and evidence are kept.\n' +
        '  Maximum: 180 management calls, 160 reads, 60 events, 25 scoped tokens. Other existing guards remain.\n' +
        '  US$1 is a usage stop target, not a guaranteed billing cap. Provider costs are unverified.\n' +
        '  You choose the conflict in the browser, then make a separate Release decision.\n' +
        '  A failed start stops this attempt; another run requires another review.\n' +
        `  Exact source, target and full limits: ${path.resolve(inputPath)}\n\n`);
      terminalPort.write('Your name is a self-declared local label; this does not authenticate your identity.\n');
      let operatorLabel: string, typed: string;
      if (mode === 'confirm') {
        operatorLabel = await terminalPort.ask('Your name: ');
        typed = await terminalPort.ask('Type START DEMO to start this run and authorize its cleanup, or anything else to cancel: ');
      } else {
        typed = await terminalPort.ask('Type the exact review digest to prepare this 30-minute grant: ');
        operatorLabel = await terminalPort.ask('Operator label (self-declared): ');
      }
      // Re-read after the human's input so a changed source cannot inherit approval.
      const confirmedSource = await readDemoActivationSource(projectRoot);
      const grant = mode === 'confirm'
        ? confirmDemoActivationReview(review, confirmedSource, { stdin_is_tty: true, stdout_is_tty: true,
          confirmation_text: typed, operator_label: operatorLabel }, now ?? Date.now())
        : approveDemoActivationReview(review, confirmedSource, { stdin_is_tty: true, stdout_is_tty: true,
          typed_digest: typed, operator_label: operatorLabel }, now ?? Date.now());
      const configPath = path.resolve(outputPath + '.wrangler.json'), config = createDemoActivationWorkerConfig(grant, projectRoot);
      await writeNewJson(configPath, config);
      try { await writeNewJson(outputPath, grant); } catch (error) { await unlink(configPath).catch(() => undefined); throw error; }
      return { mode, output_path: path.resolve(outputPath), grant_sha256: grant.grant_sha256, live_authorized: true,
        wrangler_config_path: configPath, wrangler_config_sha256: digest(config),
        expires_at: new Date(grant.expires_at).toISOString(), dispatches: 0,
        attribution: `attended local ${mode === 'confirm' ? 'START DEMO confirmation' : 'digest entry'}; no remote operation is dispatched by this command` };
    } finally { terminalPort.close?.(); }
  }
  fail('DEMO_ACTIVATION_USAGE', 2,
    'Usage: integrated-demo-activation prepare <exact-target.json> <new-review.json> <grant-id> | attend|confirm <review.json> <new-grant.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runDemoActivationCli(process.argv.slice(2)); console.log(canonical(result));
}
