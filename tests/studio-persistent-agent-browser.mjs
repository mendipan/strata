// Real Edge and actual loopback host restarts; public synthetic auth/transport.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentSettingsFixture } from '../dist/tests/studio-agent-settings-fixture.js';
import { OwnerAgentSettings } from '../dist/src/explorer/agent-settings.js';
import { OwnerAccess } from '../dist/src/explorer/owner-access.js';
import { startExplorer } from '../dist/src/explorer/host.js';
import { ExplorerReader } from '../dist/src/explorer/read.js';
import { TestSource, sample } from '../dist/tests/explorer-fixture.js';
const { chromium } = await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const output = await mkdtemp(path.join(tmpdir(), 'strata-persistent-agent-browser-'));
const f = await agentSettingsFixture();
f.agent.setSource({ ...f.agent.source(), valid_until: null });
f.agent.setApproval({ ...f.agent.approval(), target: { ...f.agent.approval().target, valid_until: null } });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(10000);
const checks = [], errors = [], network = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
await context.route('**/*', async route => {
  const original = route.request(), url = new URL(original.url());
  if (url.origin !== f.origin) throw new Error('External browser request forbidden: ' + url.origin);
  network.push({ path: url.pathname, method: original.method() });
  const headers = await original.allHeaders(); headers.host = 'studio.example.test'; headers['x-forwarded-proto'] = 'https';
  const response = await new Promise((resolve, reject) => {
    const req = request(f.server.origin + url.pathname + url.search, { method: original.method(), headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)])), body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end(original.postDataBuffer());
  });
  await route.fulfill(response);
});
const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
const panel = page.getByRole('region', { name: 'Agent connection', exact: true });
async function openPanel(signIn = false) {
  if (page.url().startsWith(f.origin)) await page.reload();
  else await page.goto(f.origin + '/#/settings');
  if (signIn) {
    await page.getByLabel('Sign-in name', { exact: true }).fill('manager.owner');
    await page.getByLabel('Password', { exact: true }).fill(f.password);
    await page.getByLabel('Password', { exact: true }).press('Enter');
  }
  await page.getByText('Agent service (optional)', { exact: true }).click();
  await panel.getByRole('button', { name: 'Refresh agent status', exact: true }).waitFor();
}
async function restart() {
  await f.server.close();
  const manager = f.agent.make(f.agentStore), settings = new OwnerAgentSettings(manager, ['synthetic']);
  const owner = new OwnerAccess(f.bootstrapState, { publicOrigin: f.origin, trustedProxyAddresses: ['127.0.0.1'] }, () => Date.parse(f.agent.iso()), { connections: f.manager, agents: settings });
  f.server = await startExplorer(new ExplorerReader(new TestSource(await sample())), { assets: path.resolve('explorer'), owner });
}
try {
  await openPanel(true);
  await panel.getByRole('button', { name: 'Configure agent', exact: true }).click();
  await panel.getByText('Saved until you revoke it', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Connect agent discovery', exact: true }).click();
  await panel.getByText('connected-discovery', { exact: true }).waitFor();
  await openPanel();
  check('browser reload retains consent and enabled intent', await panel.getByText('Saved until you revoke it', { exact: true }).count() === 1 && await panel.getByText('Enabled; retained across restarts', { exact: true }).count() === 1);
  check('browser reload does not dispatch discovery', f.agent.counts().dispatches === 1);
  await restart(); await openPanel(true);
  check('actual server restart retains consent without setup', await panel.getByText('Saved until you revoke it', { exact: true }).count() === 1 && await panel.getByRole('button', { name: 'Configure agent', exact: true }).count() === 0);
  check('restart shows disconnected health, historical evidence and no automatic probe', await panel.getByText('Not verified for current use', { exact: true }).count() === 1 && f.agent.counts().dispatches === 1);
  await panel.getByRole('button', { name: 'Retry agent connection', exact: true }).click();
  await panel.getByText('connected-discovery', { exact: true }).waitFor();
  check('retry restores bounded discovery without repeating consent', f.agent.counts().dispatches === 2);
  await panel.getByRole('button', { name: 'Revoke agent connection', exact: true }).click(); await page.keyboard.press('Escape');
  check('cancel revocation restores focus and keeps consent', (await f.agentStore.read()).connection.authorization.state === 'approved' && await panel.getByRole('button', { name: 'Revoke agent connection', exact: true }).evaluate(n => document.activeElement === n));
  await panel.getByRole('button', { name: 'Revoke agent connection', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke agent connection', exact: true }).click();
  await panel.getByText('Revoked', { exact: true }).waitFor();
  await restart(); await openPanel(true);
  check('revocation persists through second server restart', await panel.getByText('Revoked', { exact: true }).count() === 1 && await panel.getByRole('button', { name: 'Retry agent connection', exact: true }).isDisabled() && f.agent.counts().dispatches === 2);
  check('fresh owner can explicitly approve a new connection after revocation', await panel.getByRole('button', { name: 'Configure agent', exact: true }).isEnabled());
  check('revoked status reports revoked health', await panel.getByText('revoked', { exact: true }).count() === 2);
  await page.setViewportSize({ width: 320, height: 800 });
  check('persistent controls fit 320px viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'revoked-mobile.png'), fullPage: true });
  check('browser has no script errors', errors.length === 0);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ checks, errors, network, counts: f.agent.counts() }, null, 2));
  process.stdout.write(JSON.stringify({ output, checks, counts: f.agent.counts() }) + '\n');
} catch (e) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText()); throw e;
} finally { await context.close(); await browser.close(); await f.server.close(); }
