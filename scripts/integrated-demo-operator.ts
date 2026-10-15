import { open, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { canonical, fail } from '../src/model.js';
import { type DemoActivationGrant, createDemoActivationWorkerConfig, readDemoActivationSource, validateDemoActivationGrant } from '../src/integrated-demo-activation.js';
import { runAttendedDemo, type OperatorOptions, type OperatorTerminal } from '../src/integrated-demo-operator.js';

export const OPERATOR_USAGE = 'Usage: npm run demo:operator -- start <attended-grant.json> <new-output-directory> | check-cli';
async function durableJson(file: string, value: unknown) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
}
export async function runDemoOperatorCli(argv: string[], overrides: Partial<Omit<OperatorOptions, 'grant' | 'config_path' | 'journal_path'>> = {}) {
  const root = path.resolve(overrides.root ?? process.cwd());
  if (argv.length === 1 && argv[0] === '--help') return { usage: OPERATOR_USAGE, live_authorized: false };
  if (argv.length === 1 && argv[0] === 'check-cli') {
    const { probeSubscriptionCli } = await import('../src/integrated-demo-operator.js');
    return (overrides.probe ?? probeSubscriptionCli)(root);
  }
  if (argv.length !== 3 || argv[0] !== 'start') fail('DEMO_OPERATOR_USAGE', 2, OPERATOR_USAGE);
  const bytes = await readFile(path.resolve(argv[1]));
  if (bytes.byteLength > 1024 * 1024) fail('DEMO_OPERATOR_GRANT_REFUSED', 4, 'Grant input exceeds its size bound.');
  const grant = JSON.parse(Buffer.from(bytes).toString('utf8')) as DemoActivationGrant;
  validateDemoActivationGrant(grant, await readDemoActivationSource(root), (overrides.now ?? Date.now)());
  const output = path.resolve(argv[2]);
  // New directory + grant-specific journal: existing runs cannot be silently reset.
  const { mkdir } = await import('node:fs/promises'); await mkdir(output, { mode: 0o700 });
  const config = path.join(output, 'activation.wrangler.json');
  await writeFile(config, JSON.stringify(createDemoActivationWorkerConfig(grant, root)), { flag: 'wx', mode: 0o600 });
  const events = await open(path.join(output, 'viewer-events.jsonl'), 'wx', 0o600);
  const controller = new AbortController();
  const readline = overrides.terminal ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const terminal: OperatorTerminal = overrides.terminal ?? { stdin_is_tty: process.stdin.isTTY === true,
    stdout_is_tty: process.stdout.isTTY === true, write: text => process.stdout.write(text), ask: prompt => readline!.question(prompt) };
  const interrupt = () => { controller.abort(); readline?.close(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const timer = setTimeout(interrupt, Math.max(1, grant.expires_at - 150_000 - (overrides.now ?? Date.now)()));
  let observed: unknown = null;
  try {
    const result = await runAttendedDemo({ ...overrides, root, grant, config_path: config,
      actor_options: { ...overrides.actor_options, save_evidence: async evidence => {
        await durableJson(path.join(output, `actor-${evidence.actor}${evidence.assigned_revision === 2 ? '-repair' : ''}.json`), evidence);
        await overrides.actor_options?.save_evidence?.(evidence);
      } },
      journal_path: path.join(output, 'management-journal.json'), terminal,
      on_admit: async () => {
        const claims = path.join(root, '.strata', 'demo-grants'); await mkdir(claims, { recursive: true });
        try { await writeFile(path.join(claims, grant.grant_sha256 + '.json'), JSON.stringify({ grant_sha256: grant.grant_sha256,
          target: grant.target, output, claimed_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
        catch (error: any) { if (error.code === 'EEXIST') fail('DEMO_OPERATOR_GRANT_CONSUMED', 7, 'This grant already has an operator launch claim. Preserve it and reconcile; do not reset or retry.'); throw error; }
      }, signal: overrides.signal ? AbortSignal.any([overrides.signal, controller.signal]) : controller.signal,
      emit: async (record, workflowExport) => {
        await events.write(canonical(record) + '\n'); await events.sync();
        if ((record as any).type === 'execution-observed') observed = record;
        const { outcome: _outcome, ...summary } = record as any;
        const display = summary.type === 'cleanup-verified' ? { type: summary.type, cleanup: summary.cleanup.cleanup, counters: summary.cleanup.counters }
          : summary.type === 'operator-pause' ? { type: summary.type, phase: summary.packet.phase, packet_digest: summary.packet.packet_digest } : summary;
        if (grant.format === 'strata.integrated-demo-activation-grant/2' && overrides.decide) {
          const message = summary.message ?? (summary.type === 'actor-launching' ? `Starting coding actor ${summary.actor.toUpperCase()}…`
            : summary.type === 'actor-finished' ? `Coding actor ${summary.actor.toUpperCase()} finished.`
            : summary.type === 'operator-pause' ? (summary.packet.phase === 'selection' ? 'Your conflict choice is ready in the browser.' : 'Your separate Release decision is ready in the browser.')
            : summary.type === 'workflow-event' ? `Workflow checkpoint: ${summary.phase}.`
            : summary.type === 'cleanup-verified' ? 'Cleanup verified. Temporary resources are absent; namespace and evidence are retained.'
            : summary.type === 'cleanup-blocked' ? 'Cleanup is not verified. The operator must reconcile this exact run; preserve the evidence.'
            : summary.type === 'startup-reconciliation-required' ? 'Startup failed before coding actors launched. Exact resource reconciliation is required.'
            : summary.type);
          terminal.write(message + '\n');
        } else terminal.write(canonical(display) + '\n');
        if (workflowExport !== undefined) {
          const file = path.join(output, 'workflow-export.json');
          await writeFile(file + '.tmp', JSON.stringify(workflowExport, null, 2), { mode: 0o600 }); await rename(file + '.tmp', file);
        }
        await overrides.emit?.(record, workflowExport);
      } });
    await durableJson(path.join(output, 'result.json'), { ok: true, ...result, observed });
    return result;
  } catch (error: any) {
    await durableJson(path.join(output, 'result.json'), { ok: false, code: error.code ?? 'DEMO_OPERATOR_FAILED',
      ...(error.cleanup_error ? { cleanup_code: error.cleanup_error.code ?? 'DEMO_OPERATOR_CLEANUP_FAILED' } : {}), observed,
      boundary: 'Partial local evidence only; failure does not attest Release, retained publication, provider cancellation or cleanup.' });
    throw error;
  } finally { clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); readline?.close(); await events.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result: any = await runDemoOperatorCli(process.argv.slice(2));
    console.log(canonical(result.cleanup ? { released: result.released, cleanup: result.cleanup.cleanup, counters: result.cleanup.counters } : result)); }
  catch (error: any) { console.error(canonical({ ok: false, code: error.code ?? 'DEMO_OPERATOR_FAILED', message: error.message, ...(error.cleanup_error ? { cleanup_code: error.cleanup_error.code ?? 'DEMO_OPERATOR_CLEANUP_FAILED' } : {}) })); process.exitCode = error.exit ?? 7; }
}
