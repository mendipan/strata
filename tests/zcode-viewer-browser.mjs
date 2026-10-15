// zcode-viewer browser evidence driver. Plain Node (no new dependencies).
//
// Reliability contract:
// - Browser discovery checks an explicit candidate list (env override, per-user and
//   machine-wide Chrome/Edge paths, PATH entries) and reports "blocked" (exit 3) when
//   nothing exists. An env override is authoritative: it is not silently replaced.
// - The DevTools endpoint is proven to belong to THIS driver's newly launched process:
//   Chrome is launched with --remote-debugging-port=0 on a fresh throwaway user-data-dir
//   and the endpoint is read from <profile>/DevToolsActivePort, then cross-checked against
//   /json/version (both bounded). No port is ever guessed or scanned, so another
//   browser/task is never contacted or stopped. Only this child process (and its own pid
//   tree) is cleaned up.
// - The whole lifecycle is guarded from profile creation onward: synchronous spawn throws,
//   asynchronous child 'error' events, endpoint/version failures, CDP connection setup,
//   and every RPC (bounded per call; pending requests are rejected when the socket
//   closes) all reach the same bounded cleanup. Unsuccessful cleanup itself fails the run.
// - Cleanup is bounded and runs on startup failure, assertion failure, and success; its
//   outcome is recorded in the evidence JSON.
// - Evidence distinguishes assertions (checks, pass/fail) from informational observations.
//
// Test-only hooks (documented, no effect on evidence claims unless stated):
//   STRATA_VIEWER_BROWSER (executable override), STRATA_VIEWER_EVIDENCE (evidence path),
//   STRATA_VIEWER_PAGES_DIR (generated pages dir), STRATA_VIEWER_TEST_FORCE_FAIL
//   (one forced failing assertion to exercise the assertion-failure path),
//   STRATA_VIEWER_TEST_STOP_EARLY (minimal page subset for failure-path runs),
//   STRATA_VIEWER_TEST_BROKEN_WS (connect to an invalid target path on our own endpoint),
//   STRATA_VIEWER_TEST_HANG_RPC (issue one RPC that never resolves), and
//   STRATA_VIEWER_RPC_BOUND_MS (override the per-RPC bound for failure-path runs).
//
// Screen-reader output is NOT exercised and is reported as unverified. Touch activation
// via synthesized tap gestures and real browser zoom are NOT exercised; see notes.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { integratedDemoReplayData, renderIntegratedDemoReplayHtml, renderIntegratedDemoWorkflowSnapshotHtml } from '../dist/src/integrated-demo-replay.js';
import { parseWorkflowSnapshot } from '../dist/src/integrated-demo-visualization.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = process.env.STRATA_VIEWER_PAGES_DIR ? path.resolve(process.env.STRATA_VIEWER_PAGES_DIR) : path.join(root, '.strata/zcode-viewer/browser');
const evidencePath = process.env.STRATA_VIEWER_EVIDENCE ? path.resolve(process.env.STRATA_VIEWER_EVIDENCE) : path.join(root, '.strata/test-results/viewer/browser-evidence.json');
const stopEarly = process.env.STRATA_VIEWER_TEST_STOP_EARLY === '1';
const widths = stopEarly ? [320, 1280] : [320, 375, 768, 1280];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const record = {
  driver: 'tests/zcode-viewer-browser.mjs', status: 'fatal', generated_pages: [],
  checks: [], observations: [], blocked_requests: [], screenshots: [], notes: [], cleanup: null
};
const check = (name, page, pass, detail) => {
  record.checks.push({ name, page, status: pass ? 'pass' : 'fail', detail });
  if (!pass) process.stderr.write(`FAIL ${name} (${page}): ${detail}\n`);
};
const observe = (name, page, detail) => record.observations.push({ name, page, detail });

function findBrowser() {
  const override = process.env.STRATA_VIEWER_BROWSER;
  if (override) {
    const resolved = path.resolve(override);
    return existsSync(resolved) ? resolved : null; // authoritative: never fall through to another executable
  }
  const candidates = [];
  for (const dir of [process.env.LOCALAPPDATA, process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'chrome.exe'), path.join(dir, 'msedge.exe'), path.join(dir, 'chrome'), path.join(dir, 'msedge'));
  }
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

async function writeEvidence() {
  try {
    record.counts = { checks: record.checks.length, failed: record.checks.filter(item => item.status === 'fail').length };
    record.completed_at = new Date().toISOString();
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (error) {
    process.stderr.write(`Evidence write failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function generatePages() {
  await mkdir(pagesDir, { recursive: true });
  const rehearsal = JSON.parse(await readFile(path.join(root, 'tests/fixtures/demo/rehearsal.json'), 'utf8'));
  const replayTemplate = await readFile(path.join(root, 'demo/integrated-demo-replay.template.html'), 'utf8');
  const snapshotTemplate = await readFile(path.join(root, 'demo/integrated-demo-workflow-snapshot.template.html'), 'utf8');
  const importedAt = '2026-10-06T00:00:00.000Z';
  const pages = [];

  const replay = integratedDemoReplayData(rehearsal);
  const replayPath = path.join(pagesDir, 'replay.html');
  await writeFile(replayPath, renderIntegratedDemoReplayHtml(replayTemplate, replay), 'utf8');
  pages.push({ name: 'replay', file: replayPath });

  const hostile = '<script>window.zcodeViewerXssExecuted=true</script> & "quotes" ' + 'L'.repeat(200);
  const hostileReplay = structuredClone(replay);
  hostileReplay.branches[0].selection_packets[0].business_request = hostile;
  hostileReplay.branches[0].selection_packets[0].options[0].effects = hostile + hostile;
  const hostileReplayPath = path.join(pagesDir, 'replay-hostile.html');
  await writeFile(hostileReplayPath, renderIntegratedDemoReplayHtml(replayTemplate, hostileReplay), 'utf8');
  pages.push({ name: 'replay-hostile', file: hostileReplayPath });

  for (const [name, fixture] of [['snapshot-paused', 'description.json'], ['snapshot-completed', 'description-completed.json']]) {
    const snapshot = parseWorkflowSnapshot(JSON.parse(await readFile(path.join(root, 'tests/fixtures/zcode-viewer', fixture), 'utf8')), importedAt);
    const file = path.join(pagesDir, `${name}.html`);
    await writeFile(file, renderIntegratedDemoWorkflowSnapshotHtml(snapshotTemplate, snapshot), 'utf8');
    pages.push({ name, file });
  }

  const hostileDescription = JSON.parse(await readFile(path.join(root, 'tests/fixtures/zcode-viewer/description-completed.json'), 'utf8'));
  for (const step of hostileDescription.steps) {
    if (step.name === 'wait-for-selection') { step.name = '<img src=x onerror=alert(2)> ' + 'N'.repeat(110); step.event_type = hostile; }
  }
  const lastApply = hostileDescription.steps.filter(step => /^apply-\d+$/.test(step.name)).at(-1);
  lastApply.output.checkpoint.receipts[0].operator_label = '<script>alert(3)</script> ' + 'O'.repeat(98);
  const hostileSnapshot = parseWorkflowSnapshot(hostileDescription, importedAt);
  const hostileSnapshotPath = path.join(pagesDir, 'snapshot-hostile.html');
  await writeFile(hostileSnapshotPath, renderIntegratedDemoWorkflowSnapshotHtml(snapshotTemplate, hostileSnapshot), 'utf8');
  pages.push({ name: 'snapshot-hostile', file: hostileSnapshotPath });
  record.generated_pages = pages.map(page => path.relative(root, page.file));
  return pages;
}

// --- Launch with an endpoint proven to belong to this driver's process ------------------------

const STARTUP_BOUND_MS = 12_000;
// The session this driver currently owns. Set the moment its profile directory is created, so
// every later failure — synchronous spawn throw, asynchronous child 'error', endpoint timeout,
// ownership-check failure, CDP connection/setup failure, assertion failure, or success — finds
// it and runs the same bounded cleanup. Only this child's pid tree and profile are touched.
let activeSession = null;
let activeSessionCleaned = false;

async function launchBrowser(executable) {
  const session = { child: null, profileDir: null, client: null };
  activeSession = session;
  activeSessionCleaned = false;
  const owned = error => Object.assign(error instanceof Error ? error : new Error(String(error)), { session });
  try {
    session.profileDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-viewer-chrome-'));
    try {
      session.child = spawn(executable, [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${session.profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--disable-gpu', '--remote-allow-origins=*', '--window-size=1280,900', '--touch-events=enabled',
        '--host-resolver-rules=MAP * ~NOTFOUND'
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) { throw owned(error); } // synchronous spawn throw (e.g. invalid executable)
    let childError = null;
    // Asynchronous spawn errors (an existing but invalid executable reports UNKNOWN/ENOENT
    // here). The listener also stays attached for the child's whole life so the 'error' event
    // is never unhandled and can never crash the driver.
    session.child.on('error', error => { childError ??= error; });
    let stderr = '';
    session.child.stderr.on('data', bytes => { stderr += bytes; });
    const endpointFile = path.join(session.profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + STARTUP_BOUND_MS;
    let port = null, browserWsPath = null;
    while (Date.now() < deadline) {
      if (childError)
        throw owned(new Error(`Launching the browser failed: ${childError.message} (code ${childError.code ?? 'UNKNOWN'})`));
      if (session.child.exitCode !== null)
        throw owned(new Error(`Launched browser exited with code ${session.child.exitCode} before exposing a DevTools endpoint: ${stderr.slice(0, 500)}`));
      try {
        const [portLine, pathLine] = (await readFile(endpointFile, 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(portLine)) { port = Number(portLine); browserWsPath = pathLine; break; }
      } catch { /* not written yet */ }
      await sleep(150);
    }
    if (port === null)
      throw owned(new Error(`DevTools endpoint did not appear within ${STARTUP_BOUND_MS}ms in this process's throwaway profile. stderr: ${stderr.slice(0, 500)}`));
    let version = null;
    const fetched = await withBound(fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json()), 8000, 'endpoint version fetch');
    if (!(fetched instanceof Error)) version = fetched;
    if (!version || version.webSocketDebuggerUrl !== `ws://127.0.0.1:${port}${browserWsPath}`)
      throw owned(new Error('DevTools endpoint ownership check failed: /json/version did not match the endpoint written in this process\'s profile.'));
    session.port = port;
    session.browserWsPath = browserWsPath;
    session.version = version;
    return session;
  } catch (error) {
    throw error?.session ? error : owned(error);
  }
}

function cdpClient(webSocketDebuggerUrl, { connectBoundMs = 8000, rpcBoundMs = Number(process.env.STRATA_VIEWER_RPC_BOUND_MS) || 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket = null;
    let opened = false;
    const pending = new Map();
    const listeners = [];
    let nextId = 0;
    const rejectPending = error => {
      const waiting = pending.size;
      for (const { rej } of pending.values()) rej(error);
      pending.clear();
      return waiting;
    };
    const connectTimer = setTimeout(() => {
      if (opened) return;
      try { socket?.close(); } catch { /* never opened */ }
      reject(new Error(`CDP connection did not open within ${connectBoundMs}ms`));
    }, connectBoundMs);
    socket = new WebSocket(webSocketDebuggerUrl);
    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(connectTimer);
      resolve({
        socket,
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP RPC ${method} exceeded its ${rpcBoundMs}ms bound`));
            }, rpcBoundMs);
            pending.set(id, { res: value => { clearTimeout(timer); res(value); }, rej: error => { clearTimeout(timer); rej(error); } });
            try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
            catch (error) { clearTimeout(timer); pending.delete(id); rej(error); }
          });
        },
        onEvent(listener) { listeners.push(listener); }
      });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? rej(new Error(`${message.error.message} (${message.error.code})`)) : res(message.result);
      } else for (const listener of listeners) listener(message);
    });
    socket.addEventListener('close', () => {
      if (!opened) { clearTimeout(connectTimer); reject(new Error('CDP connection closed before opening')); return; }
      rejectPending(new Error('CDP WebSocket closed before all requests resolved'));
    });
    socket.addEventListener('error', () => {
      if (!opened) { clearTimeout(connectTimer); reject(new Error('CDP WebSocket error during connection')); }
      else rejectPending(new Error('CDP WebSocket error; pending requests rejected'));
    });
  });
}

// --- Bounded cleanup: runs on startup failure, assertion failure, and success -----------------

const withBound = (promise, ms, label) => Promise.race([
  Promise.resolve(promise).catch(error => error),
  sleep(ms).then(() => new Error(`${label} exceeded its ${ms}ms bound`))
]);

async function boundedCleanup(session, teardown) {
  const cleanup = { browser_exited: false, forced_kill: false, profile_removed: false, context_disposed: false, errors: [] };
  const note = value => { if (value instanceof Error) cleanup.errors.push(value.message); return value; };
  try {
    if (teardown) {
      const closed = await withBound(teardown(), 4000, 'CDP teardown');
      if (closed instanceof Error) note(closed); else cleanup.context_disposed = true;
    }
  } catch (error) { cleanup.errors.push(String(error)); }
  try { session.client?.socket?.close(); } catch { /* already closed */ }
  if (session.child) {
    const alreadyExited = () => session.child.exitCode !== null || session.child.signalCode !== null;
    const waitForExit = () => withBound(new Promise(resolve => session.child.once('exit', () => resolve(true))), 5000, 'exit wait');
    try {
      if (alreadyExited()) cleanup.browser_exited = true;
      else {
        session.child.kill();
        cleanup.browser_exited = (await waitForExit()) === true || alreadyExited();
      }
    } catch (error) { cleanup.errors.push(String(error)); }
    if (!cleanup.browser_exited) {
      cleanup.forced_kill = true;
      try {
        if (process.platform === 'win32') {
          await withBound(new Promise(resolve => {
            const killer = spawn('taskkill', ['/PID', String(session.child.pid), '/T', '/F'], { stdio: 'ignore' });
            killer.once('close', () => resolve());
            killer.once('error', () => resolve());
          }), 5000, 'taskkill');
        } else session.child.kill('SIGKILL');
        cleanup.browser_exited = (await waitForExit()) === true || alreadyExited();
      } catch (error) { cleanup.errors.push(String(error)); }
    }
  } else cleanup.browser_exited = true;
  if (session.profileDir) {
    const removed = await withBound(rm(session.profileDir, { recursive: true, force: true }), 5000, 'profile removal');
    cleanup.profile_removed = !(removed instanceof Error);
    if (removed instanceof Error) cleanup.errors.push(removed.message);
  } else cleanup.profile_removed = true; // no profile was ever created
  return cleanup;
}

const allowedUrl = url => {
  try {
    const parsed = new URL(url);
    if (['file:', 'about:', 'chrome:', 'devtools:', 'data:'].includes(parsed.protocol)) return true;
    if (['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return true;
    return false;
  } catch { return false; }
};

const domAudit = `(() => {
  const identity = el => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return tag + '#' + el.id;
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    return tag + '[' + name + ']';
  };
  const focusable = [...document.querySelectorAll('a[href], button, summary, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
  const visible = focusable.filter(el => { const st = getComputedStyle(el); const r = el.getBoundingClientRect();
    return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !el.matches(':disabled'); });
  const interactive = visible.map(el => { const r = el.getBoundingClientRect(); return { identity: identity(el),
    x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; });
  return { interactive, forms: document.querySelectorAll('form, input, select, textarea').length,
    liveRegions: [...document.querySelectorAll('[aria-live]')].map(el => ({ id: el.id || null, live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic') })),
    buttonsWithNames: visible.filter(el => el.tagName === 'BUTTON').every(el => (el.getAttribute('aria-label') || el.textContent || '').trim().length > 0) };
})()`;
const overflowAudit = `(() => {
  const doc = document.documentElement;
  const layout = doc.clientWidth;
  const offenders = [...document.querySelectorAll('body *')].filter(el => {
    if (['HTML', 'BODY'].includes(el.tagName)) return false;
    const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden') return false;
    return r.right > layout + 1 || r.left < -1;
  }).slice(0, 6).map(el => ({ identity: (el.id ? el.tagName.toLowerCase() + '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]).slice(0, 50),
    right: Math.round(el.getBoundingClientRect().right), layout }));
  const rootBoxes = doc.scrollWidth > layout + 1 && offenders.length === 0
    ? { htmlWidth: Math.round(doc.getBoundingClientRect().width), bodyWidth: Math.round(document.body.getBoundingClientRect().width),
        bodyMinWidth: getComputedStyle(document.body).minWidth, visualViewport: window.visualViewport ? Math.round(window.visualViewport.width) : null } : null;
  return { innerWidth: window.innerWidth, clientWidth: layout, scrollWidth: doc.scrollWidth, scrollX: window.scrollX, offenders, rootBoxes };
})()`;
const activeIdentity = `(() => { const el = document.activeElement; if (!el || el === document.body) return null;
  const tag = el.tagName.toLowerCase();
  if (el.id) return tag + '#' + el.id;
  return tag + '[' + (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) + ']'; })()`;

// WCAG 2.5.8 spacing exception: an undersized target is acceptable when a 24px-diameter
// circle centered on its bounding box intersects no other target's bounding box.
function targetSizeAudit(interactive) {
  const undersized = interactive.filter(item => Math.min(item.width, item.height) < 24);
  const circleIntersectsBox = (item, other) => {
    const cx = item.x + item.width / 2, cy = item.y + item.height / 2, radius = 12;
    const nearestX = Math.max(other.x, Math.min(cx, other.x + other.width));
    const nearestY = Math.max(other.y, Math.min(cy, other.y + other.height));
    return Math.hypot(cx - nearestX, cy - nearestY) <= radius + 1;
  };
  const spacing = undersized.map(item => ({
    target: item.identity, size: `${item.width}x${item.height}`,
    exceptionSatisfied: !interactive.some(other => other !== item && circleIntersectsBox(item, other))
  }));
  return { undersized: undersized.map(item => `${item.identity}:${item.width}x${item.height}`), spacing };
}

async function main() {
  const executable = findBrowser();
  if (!executable) {
    record.status = 'blocked';
    record.notes.push('No local Chromium/Edge executable found by explicit candidate and PATH discovery; browser checks not performed.');
    process.stdout.write('BLOCKED: no local Chromium/Edge runtime found; browser checks not performed. Keyboard/mobile/accessibility criteria remain unverified.\n');
    return 3;
  }
  const pages = await generatePages();
  const selectedPages = stopEarly ? pages.slice(0, 1) : pages;
  const session = await launchBrowser(executable);
  let teardown = null;
  try {
  record.environment = {
    executable, browser: session.version.Browser, userAgent: session.version['User-Agent'], pid: session.child.pid,
    endpoint: { source: 'DevToolsActivePort written inside this driver\'s throwaway user-data-dir', port: session.port, browserPath: session.browserWsPath,
      ownershipVerified: 'launched with --remote-debugging-port=0; /json/version webSocketDebuggerUrl matched the profile-written endpoint' },
    profile: 'throwaway user-data-dir (mkdtemp)', dns: 'host-resolver-rules MAP * ~NOTFOUND', protocol: 'CDP over local WebSocket'
  };

  // Test hook: connect to an invalid target path on THIS process's own endpoint, so the
  // connection-setup failure path is exercised without ever touching another browser.
  const wsUrl = process.env.STRATA_VIEWER_TEST_BROKEN_WS === '1'
    ? `ws://127.0.0.1:${session.port}/devtools/browser/00000000-0000-0000-0000-000000000000`
    : session.version.webSocketDebuggerUrl;
  let client;
  try { client = await cdpClient(wsUrl); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { session }); }
  session.client = client;
  client.onEvent(message => {
    if (message.method === 'Fetch.requestPaused') {
      const url = message.params.request.url;
      const respond = allowedUrl(url)
        ? client.send('Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId)
        : (record.blocked_requests.push(url), client.send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'BlockedByClient' }, message.sessionId));
      respond.catch(error => record.notes.push(`fetch-intercept error: ${error.message}`));
    }
  });

  const browserContext = await client.send('Target.createBrowserContext');
  const target = await client.send('Target.createTarget', { url: 'about:blank', browserContextId: browserContext.browserContextId });
  const sessionId = (await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  const send = (method, params = {}) => client.send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
    return result.result.value;
  };
  // Apply the viewport twice with a settle delay: the first override after navigation can
  // transiently report a scrollbar-inflated innerWidth, which must not poison measurement.
  const setViewport = async (width, scale = 1) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 768, scale });
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 768, scale });
    await sleep(150);
  };
  const key = (type, name, code, keyCode, modifiers = 0, text) => send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, ...(text !== undefined ? { text } : {}) });
  const tab = async shift => { await key('rawKeyDown', 'Tab', 'Tab', 9, shift ? 8 : 0); await key('keyUp', 'Tab', 'Tab', 9, shift ? 8 : 0); };
  const activate = async (name, code, keyCode, text) => { await key('keyDown', name, code, keyCode, 0, text); await key('keyUp', name, code, keyCode); };
  const screenshot = async name => {
    const image = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(path.dirname(evidencePath), `screenshot-${name}.png`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(image.data, 'base64'));
    record.screenshots.push(path.relative(root, file));
  };
  const navigateTo = async page => {
    await send('Page.navigate', { url: pathToFileURL(page.file).href });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate('document.readyState') === 'complete') break;
      await sleep(100);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  if (process.env.STRATA_VIEWER_TEST_HANG_RPC === '1') {
    // Test hook: an RPC that never resolves must be rejected by its per-RPC bound, not hang the driver.
    await send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true, returnByValue: true });
    throw new Error('test hook: the deliberately hanging RPC unexpectedly completed');
  }

  // Warmup: the first navigation combined with the first viewport override can transiently
  // report a scrollbar-inflated extent. Load and re-configure the first page once before
  // any measurement so the recorded numbers are the settled state.
  await navigateTo(selectedPages[0]);
  await setViewport(widths[0]);
  await send('Page.reload');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate('document.readyState') === 'complete') break;
    await sleep(100);
  }
  await setViewport(widths[0]);

  for (const page of selectedPages) {
    await navigateTo(page);
    for (const width of widths) {
      await setViewport(width);
      const audit = await evaluate(overflowAudit);
      if (Math.abs(audit.innerWidth - width) > 1)
        observe('emulation-viewport-deviation', `${page.name}@${width}`, `innerWidth ${audit.innerWidth} differs from the requested ${width} (scrollbar or emulator artifact)`);
      // Assert against the layout viewport (clientWidth): an oversized innerWidth or an
      // oversized layout viewport cannot hide clipping here.
      const overflowFree = audit.scrollWidth <= audit.clientWidth + 1 && audit.clientWidth <= width + 1 && audit.offenders.length === 0;
      check('no-horizontal-overflow', `${page.name}@${width}`, overflowFree, JSON.stringify(audit));
      if (process.env.STRATA_VIEWER_TEST_FORCE_FAIL === '1' && !record.checks.some(item => item.name === 'forced-failure-probe'))
        check('forced-failure-probe', 'harness', false, 'STRATA_VIEWER_TEST_FORCE_FAIL requested a failing assertion to exercise the assertion-failure path.');
      if (width === 320 || width === 1280) await screenshot(`${page.name}-${width}`);
    }
    if (stopEarly) break;
    await setViewport(320);
    const dom = await evaluate(domAudit);
    check('read-only-no-form-controls', page.name, dom.forms === 0, `form/input/select/textarea count ${dom.forms}`);
    check('accessible-names-present', page.name, dom.buttonsWithNames, 'every visible button has a non-empty name');
    const identities = dom.interactive.map(item => item.identity);
    check('control-identities-unique', page.name, new Set(identities).size === identities.length,
      `${identities.length} interactive controls, ${new Set(identities).size} unique identities; duplicates: ${JSON.stringify(identities.filter((id, i) => identities.indexOf(id) !== i))}`);
    const targetSizes = targetSizeAudit(dom.interactive);
    check('wcag-2.5.8-target-size-minimum-or-spacing-exception', `${page.name}@320`,
      targetSizes.undersized.length === 0 || targetSizes.spacing.every(item => item.exceptionSatisfied),
      `undersized targets: ${JSON.stringify(targetSizes.undersized)}; spacing exception: ${JSON.stringify(targetSizes.spacing)}`);
    observe('touch-target-inventory', `${page.name}@320`, JSON.stringify(dom.interactive.map(item => `${item.identity}:${item.width}x${item.height}`)));
    observe('live-regions', page.name, JSON.stringify(dom.liveRegions));

    // Keyboard: complete traversal — every tabbable control on the page is visited by real
    // Tab presses and must match the exact unique identities in DOM order. Tabbing past the
    // last control legitimately moves focus out of the document (activeElement becomes body),
    // recorded as a null final entry.
    await setViewport(1280);
    await evaluate('document.activeElement.blur()');
    const expected = identities;
    const visited = [];
    for (let step = 0; step < expected.length; step++) { await tab(false); visited.push(await evaluate(activeIdentity)); }
    const leftDocumentAtEnd = visited[expected.length - 1] === null;
    check('tab-order-follows-dom-identities', page.name,
      JSON.stringify(visited.slice(0, -1)) === JSON.stringify(expected.slice(0, -1)) &&
      (visited[expected.length - 1] === expected[expected.length - 1] || leftDocumentAtEnd),
      `complete traversal of ${expected.length} tabbable controls; expected ${JSON.stringify(expected)} visited ${JSON.stringify(visited)}`);
    if (leftDocumentAtEnd) await tab(true); // Shift+Tab returns focus to the last control
    const lastControl = await evaluate(activeIdentity);
    check('tab-reaches-last-control', page.name, lastControl === expected[expected.length - 1],
      `expected ${JSON.stringify(expected[expected.length - 1])}, active ${JSON.stringify(lastControl)}`);
    await tab(true);
    const afterShift = await evaluate(activeIdentity);
    check('shift-tab-reverses-exactly', page.name, afterShift === expected[expected.length - 2],
      `after one more Shift+Tab expected ${JSON.stringify(expected[expected.length - 2])}, active ${JSON.stringify(afterShift)}`);
    const focusStyle = await evaluate(`(() => { const el = document.activeElement; const st = getComputedStyle(el); const tag = el.tagName.toLowerCase();
      const identity = el.id ? tag + '#' + el.id : tag + '[' + (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) + ']';
      return { identity, outlineStyle: st.outlineStyle, outlineWidth: st.outlineWidth, outlineColor: st.outlineColor }; })()`);
    const visibleFocus = focusStyle && focusStyle.outlineStyle !== 'none' && (focusStyle.outlineWidth !== '0px' || focusStyle.outlineStyle === 'auto');
    check('keyboard-focus-indicator', page.name, Boolean(visibleFocus), JSON.stringify(focusStyle));
  }

  teardown = async () => {
    await send('Fetch.disable');
    await client.send('Target.closeTarget', { targetId: target.targetId });
    await client.send('Target.disposeBrowserContext', { browserContextId: browserContext.browserContextId });
    return true;
  };
  if (!stopEarly) {
      // Replay interactions on a fresh load, keyboard driven, focus logged per step.
      const replayPage = pages.find(page => page.name === 'replay');
      const loadReplay = async () => { await navigateTo(replayPage); await setViewport(1280); };
      const focusTrail = [];
      const noteFocus = async label => { const focus = await evaluate(activeIdentity); focusTrail.push({ step: label, focus }); return focus; };
      await loadReplay();
      await evaluate('document.activeElement.blur()');
      await noteFocus('start');
      for (let step = 0; step < 4; step++) { await tab(false); await noteFocus('tab-' + (step + 1)); }
      const onBranch = await noteFocus('before-enter');
      await activate('Enter', 'Enter', 13, '\r');
      await sleep(150);
      const afterEnter = await evaluate(`(() => ({ count: document.getElementById('control-count').textContent,
        pressed1200: document.querySelector('[data-branch="1200"]').getAttribute('aria-pressed'),
        focus: (d => (d && d.branch) || null)(document.activeElement.dataset) }))()`);
      check('enter-activates-branch-button', 'replay', Boolean(onBranch) && /1,200 second branch/.test(onBranch || '') && afterEnter.pressed1200 === 'true' && afterEnter.count === '1 / 25', `focus ${JSON.stringify(onBranch)} -> pressed1200=${afterEnter.pressed1200}, count ${afterEnter.count}`);
      check('branch-switch-visible-change', 'replay', afterEnter.count === '1 / 25', `count ${afterEnter.count}`);
      check('focus-retention-after-enter', 'replay', afterEnter.focus === '1200', `focused ${JSON.stringify(afterEnter.focus)}`);
      observe('keyboard-focus-trail', 'replay', JSON.stringify(focusTrail));

      await tab(false);
      const onJump = await noteFocus('before-space');
      await activate(' ', 'Space', 32, ' ');
      await sleep(150);
      const afterSpace = await evaluate(`(() => ({ current: document.querySelectorAll('.event-jump[aria-current="step"]').length,
        valueNow: document.getElementById('sequence-progress').getAttribute('aria-valuenow') }))()`);
      check('space-activates-event-jump', 'replay', Boolean(onJump) && /event 1:/i.test(onJump || '') && afterSpace.current === 1 && afterSpace.valueNow === '1', `focus ${JSON.stringify(onJump)} -> current=${afterSpace.current} valuenow=${afterSpace.valueNow}`);

      // Shift+Tab from a fresh page wraps to the LAST tabbable control: the Next button.
      await loadReplay();
      await evaluate('document.activeElement.blur()');
      await tab(true);
      const beforeNext = await evaluate(`(() => ({ focus: document.activeElement.id || null, valueNow: document.getElementById('sequence-progress').getAttribute('aria-valuenow') }))()`);
      await activate('Enter', 'Enter', 13, '\r');
      await sleep(150);
      const afterNextEnter = await evaluate(`(() => ({ focus: document.activeElement.id || null, valueNow: document.getElementById('sequence-progress').getAttribute('aria-valuenow'), count: document.getElementById('control-count').textContent }))()`);
      check('enter-activates-next-button', 'replay', beforeNext.focus === 'next' && afterNextEnter.valueNow === '2' && afterNextEnter.count === '2 / 18' && afterNextEnter.focus === 'next', `${JSON.stringify(beforeNext)} -> ${JSON.stringify(afterNextEnter)}`);

      // Pointer activation at 320px (scroll the target into view first; smooth scrolling
      // must be neutralized so the measured position is final).
      await loadReplay();
      await setViewport(320);
      await evaluate(`(() => { const el = document.querySelectorAll('.event-jump')[1];
        document.documentElement.style.scrollBehavior = 'auto';
        const top = el.getBoundingClientRect().top + window.scrollY;
        window.scrollTo(0, Math.max(0, top - window.innerHeight / 2 + el.getBoundingClientRect().height / 2)); })()`);
      await sleep(200);
      const tapTarget = await evaluate(`(() => { const el = document.querySelectorAll('.event-jump')[1]; const r = el.getBoundingClientRect();
        return { x: Math.min(Math.max(r.x + r.width / 2, 8), window.innerWidth - 8), y: Math.min(Math.max(r.y + r.height / 2, 8), window.innerHeight - 8), scrolledTo: window.scrollY }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tapTarget.x, y: tapTarget.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tapTarget.x, y: tapTarget.y, button: 'left', clickCount: 1 });
      await sleep(200);
      const afterPointer = await evaluate(`(() => ({ current: (document.querySelectorAll('.event-jump')[1] || {}).getAttribute('aria-current'), valueNow: document.getElementById('sequence-progress').getAttribute('aria-valuenow') }))()`);
      check('pointer-activates-event-jump-at-320', 'replay@320', afterPointer.current === 'step' && afterPointer.valueNow === '2', `point ${JSON.stringify(tapTarget)} -> ${JSON.stringify(afterPointer)}`);
      record.notes.push('Touch activation via synthesized tap gestures was NOT exercised (Input.synthesizeTapGesture/dispatchTouchEvent did not produce activation in this headless Chromium during development); the check above uses synthesized pointer input. Touch evidence is otherwise geometric target sizes plus keyboard Enter/Space activation.');

      // Reduced motion must disable transitions and smooth scrolling.
      await setViewport(1280);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const motion = await evaluate(`(() => { const st = getComputedStyle(document.querySelector('.progress-track span'));
        return { transitionDuration: st.transitionDuration, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior }; })()`);
      check('reduced-motion-respected', 'replay', motion.transitionDuration === '0s' && motion.scrollBehavior === 'auto', JSON.stringify(motion));
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

      // Snapshot keyboard: Enter and Space toggle the native details/summary controls.
      const snapshotPage = pages.find(page => page.name === 'snapshot-completed');
      await navigateTo(snapshotPage);
      await setViewport(1280);
      await evaluate('document.activeElement.blur()');
      await tab(false);
      const summaryFocus = await evaluate(activeIdentity);
      const closedBefore = await evaluate('document.querySelector("details")?.open ?? null');
      await activate('Enter', 'Enter', 13, '\r');
      await sleep(100);
      const openAfterEnter = await evaluate('document.querySelector("details")?.open ?? null');
      check('enter-toggles-details', 'snapshot-completed', openAfterEnter === true && closedBefore === false, `focus ${JSON.stringify(summaryFocus)} open ${closedBefore} -> ${openAfterEnter}`);
      await activate(' ', 'Space', 32, ' ');
      await sleep(100);
      const openAfterSpace = await evaluate('document.querySelector("details")?.open ?? null');
      check('space-toggles-details', 'snapshot-completed', openAfterSpace === false, `open after space: ${openAfterSpace}`);

      // Hostile pages: no execution, no unescaped payload, wrapping holds.
      for (const hostilePage of pages.filter(page => page.name.endsWith('-hostile'))) {
        await navigateTo(hostilePage);
        await setViewport(320);
        const executed = await evaluate('(window.zcodeViewerXssExecuted || false)');
        const scriptCount = await evaluate('document.querySelectorAll("script:not([type])").length');
        const html = await readFile(hostilePage.file, 'utf8');
        check('hostile-payload-inert', hostilePage.name, executed === false, 'no script marker executed');
        check('single-inline-driver', hostilePage.name, scriptCount <= 1, `inline classic script elements: ${scriptCount}`);
        check('hostile-bytes-escaped', hostilePage.name, !html.includes('window.zcodeViewerXssExecuted=true</script>') && !html.includes('<script>alert(3)</script>'), 'raw hostile strings absent from rendered file');
        const overflow = await evaluate(overflowAudit);
        check('hostile-long-inputs-wrap', `${hostilePage.name}@320`, overflow.scrollWidth <= overflow.clientWidth + 1 && overflow.clientWidth <= 320 + 1 && overflow.offenders.length === 0, JSON.stringify(overflow));
      }

      // Zoom emulation: browser zoom shrinks the CSS layout viewport; 200% of 1280 = 640.
      // 200% of 320 (160 CSS px) sits below the WCAG 1.4.10 reflow floor and is recorded
      // as an observation, not an assertion.
      for (const zoomCase of [{ page: 'replay', width: 640 }, { page: 'replay', width: 160 }, { page: 'snapshot-completed', width: 640 }]) {
        const zoomTarget = pages.find(item => item.name === zoomCase.page);
        await navigateTo(zoomTarget);
        await setViewport(zoomCase.width);
        const overflow = await evaluate(overflowAudit);
        const overflowFree = overflow.scrollWidth <= overflow.clientWidth + 1 && overflow.clientWidth <= zoomCase.width + 1 && overflow.offenders.length === 0;
        if (zoomCase.width === 640) check('zoom-200-percent-reflows', `${zoomCase.page}@640`, overflowFree, JSON.stringify(overflow));
        else observe('zoom-200-percent-below-reflow-floor', `${zoomCase.page}@${zoomCase.width}`, JSON.stringify(overflow));
      }

      check('no-external-network-requests', 'all-pages', record.blocked_requests.length === 0, `blocked attempts: ${JSON.stringify(record.blocked_requests)}`);
    }
  } finally {
    record.cleanup = await boundedCleanup(session, teardown);
    activeSessionCleaned = true;
  }

  // Unsuccessful cleanup prevents an overall passing result.
  if (record.cleanup)
    check('harness-cleanup-succeeded', 'harness',
      record.cleanup.browser_exited && record.cleanup.profile_removed && record.cleanup.errors.length === 0,
      JSON.stringify(record.cleanup));

  record.notes.push('Keyboard traversal checks visit every tabbable control on every page (complete traversal), not just the first few controls.');
  record.notes.push('Screen-reader output was not exercised; aria-live/role/name checks are DOM-level evidence only.');
  record.notes.push('Real browser zoom was not exercised; zoom is emulated as a proportionally smaller CSS layout viewport (200% of 1280 = 640 CSS px), which matches media-query re-evaluation but not OS-level zoom rendering.');
  const failures = record.checks.filter(item => item.status === 'fail');
  record.status = failures.length ? 'fail' : 'pass';
  process.stdout.write(`Browser evidence written to ${path.relative(root, evidencePath)} (status ${record.status}: ${record.checks.length} assertions, ${failures.length} failures, ${record.observations.length} observations, ${record.screenshots.length} screenshots, cleanup ${JSON.stringify(record.cleanup)}).\n`);
  return failures.length ? 1 : 0;
}

main().then(code => {
  process.exitCode = code;
  return writeEvidence();
}).catch(async error => {
  process.stderr.write(`Browser driver failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  record.status = 'fatal';
  record.fatal = String(error instanceof Error ? error.message : error);
  // Every failure from profile creation onward reaches a cleanup: the error carries its
  // session, or the module-level activeSession (tracked from mkdtemp) is cleaned if the
  // failure escaped main's try/finally before cleanup ran.
  const partial = error?.session ?? (activeSessionCleaned ? null : activeSession);
  if (partial) record.cleanup = await boundedCleanup(partial, null);
  process.exitCode = 1;
  await writeEvidence();
});
