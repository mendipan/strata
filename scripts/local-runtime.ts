import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// SDK fixture databases add long namespace/hash/journal names below this root.
// A checkout-relative runtime directory can exceed native Windows SQLite paths.
// Keep each test run separate and retained; this is not a persistent app store.
export async function sdkRuntimeDirectory() {
  return mkdtemp(path.join(tmpdir(), 'strata-sdk-'));
}
export async function localRuntime(root: string, directory: string) {
  await mkdir(directory, { recursive: true });
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', path.join(directory, 'state')], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', X_LOCAL_OBSERVABILITY: 'false', X_LOCAL_EXPLORER: 'false', CI: 'true' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; const append = (b: Buffer) => { if (log.length < 2 * 1024 * 1024) log += b.toString(); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    await writeFile(path.join(directory, 'runtime.log'), log);
    let listenerClosed = false;
    for (let i = 0; i < 20; i++) {
      try { await fetch(url + '/health', { signal: AbortSignal.timeout(200) }); } catch { listenerClosed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!listenerClosed) throw new Error('The local runtime listener did not close.');
  };
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { if ((await fetch(url + '/health', { signal: AbortSignal.timeout(500) })).ok) return { url, port, close }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Local Cloudflare runtime did not become ready. See runtime.log.');
  } catch (error) { await close(); throw error; }
}
