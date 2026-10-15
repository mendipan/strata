import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { demoAt } from './demo.js';
const require = createRequire(import.meta.url), exec = promisify(execFile), root = process.cwd();
const directory = path.join(root, '.strata/agents-check-' + Date.now()); await mkdir(directory, { recursive: true });
const binaries = process.platform === 'win32' ? { esbuild: 'node_modules/@esbuild/win32-x64/esbuild.exe', workerd: 'node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe' } : { esbuild: require.resolve('@esbuild/linux-x64/bin/esbuild'), workerd: require.resolve('@cloudflare/workerd-linux-64/bin/workerd') };
const checks = await Promise.all(Object.entries(binaries).map(async ([name, file]) => {
  try { const { stdout } = await exec(path.resolve(file), ['--version'], { timeout: 10000, windowsHide: true }); return { name, runnable: true, version: stdout.trim() }; }
  catch (error) { return { name, runnable: false, error: (error as NodeJS.ErrnoException).code ?? 'EXECUTION_BLOCKED', message: (error as Error).message }; }
}));
if (checks.some(c => !c.runnable)) {
  const report = { status: 'blocked', cloudflare_agents_exercised: false, checks, next_step: 'Run this check on a machine where the installed native compiler and workerd are allowed by the administrator. This tool never changes OS security policy.' };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = 9;
} else {
  const port = 9876;
  const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', path.join(directory, 'state')], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  try {
    let ready = false; const end = Date.now() + 45000;
    while (Date.now() < end && child.exitCode === null) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break; await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Local Cloudflare broker did not become ready.');
    const result = await demoAt(root, `http://127.0.0.1:${port}`, 'cloudflare-agents');
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: 'passed', ...result }, null, 2) + '\n'); process.stdout.write(JSON.stringify({ status: 'passed', cloudflare_agents_exercised: true, release: result.release, result_file: path.join(directory, 'result.json') }) + '\n');
  } catch (error) {
    const report = { status: 'blocked-or-failed', cloudflare_agents_exercised: false, message: (error as Error).message }; await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = 9;
  } finally { child.kill(); await writeFile(path.join(directory, 'runtime.log'), log); }
}
