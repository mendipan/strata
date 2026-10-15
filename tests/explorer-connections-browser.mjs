// Synthetic-only browser coverage. No model calls, live credentials or provider reads.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startExplorer } from '../dist/src/explorer/host.js';
import { ExplorerReader } from '../dist/src/explorer/read.js';
import { ExplorerConnections } from '../dist/src/explorer/connections.js';
import { ExplorerError } from '../dist/src/explorer/contract.js';
import { TestSource, sample } from '../dist/tests/explorer-fixture.js';

const modulePath = process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
const output = await mkdtemp(path.join(os.tmpdir(), 'strata-connections-browser-'));
const source = new TestSource(await sample()), reader = new ExplorerReader(source);
const second = new TestSource(await sample()); second.connection.connection_id = 'sample-second'; second.connection.display_name = 'Second host reader';
await reader.refresh();
const connections = new ExplorerConnections([{ reader, provider: 'sample' }, { reader: new ExplorerReader(second), provider: 'sample' }]);
const host = await startExplorer(reader, { assets: path.resolve('explorer'), connections });
const browser = await chromium.launch({ channel: process.env.STRATA_EXPLORER_BROWSER_CHANNEL ?? 'msedge', headless: true });
const checks = [], errors = [], requests = [];
const check = (name, result) => { checks.push({ name, passed: !!result }); assert.ok(result, name); };
let context, unavailableHost;
try {
  context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== host.origin && new URL(route.request().url()).origin !== unavailableHost?.origin) { requests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('server responded with a status of')) errors.push(message.text()); });
  const loaded = async () => { await page.locator('main[aria-busy]').waitFor({ state: 'detached' }); };
  const settings = async () => { await page.locator('#header').getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor(); await loaded(); await page.getByRole('button', { name: 'Test read connection', exact: true }).waitFor(); };
  const action = async name => {
    const response = page.waitForResponse(r => r.url().endsWith('/explorer/v1/settings') && r.request().method() === 'POST');
    await page.getByRole('button', { name, exact: true }).click(); await response;
    await page.waitForFunction(revision => document.querySelector('.connection-settings')?.dataset.connectionRevision === String(revision) && !document.querySelector('main[aria-busy]') && ![...document.querySelectorAll('main button')].find(b => b.textContent === 'Test read connection')?.disabled, connections.status().revision);
    await loaded();
  };
  const state = async value => { await page.locator('main .field').filter({ has: page.locator('dt', { hasText: /^State$/ }) }).locator('dd').filter({ hasText: new RegExp('^' + value + '$') }).waitFor(); };
  await page.goto(host.launchUrl); await loaded(); await settings();
  check('page identity and meaningful settings', await page.title() === 'Strata Studio' && page.url().includes('#/settings') && await page.getByRole('heading', { name: 'Repository connection' }).isVisible());
  check('capability removed from URL', !page.url().includes(host.capability));
  await page.getByText('Agent service (optional)',{exact:true}).click();
  check('agent service honestly unavailable', await page.getByText('Chat unavailable', { exact: true }).isVisible() && (await page.locator('main').innerText()).includes('No agent protocol or chat service is configured.'));
  check('no credential or endpoint input', await page.locator('main input,main textarea').count() === 0);
  await state('read-only');
  await page.evaluate(() => { window.__connectionEvents = []; window.addEventListener('strata:connection-change', e => window.__connectionEvents.push(e.detail)); });
  await action('Test read connection'); await state('read-only');
  check('read test verification result', (await page.locator('main').innerText()).includes('passed ·'));
  check('connection invalidation event', await page.evaluate(() => window.__connectionEvents.length === 1));
  await page.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });

  source.failure = new ExplorerError('SOURCE_UNAVAILABLE', 503, 'synthetic-secret provider body', true);
  await action('Test read connection'); await state('stale');
  check('stale result and redacted error', (await page.locator('main').innerText()).includes('last verified view is stale') && !(await page.locator('main').innerText()).includes('synthetic-secret'));
  source.failure = new ExplorerError('SOURCE_AUTH', 403, 'synthetic-secret');
  await action('Test read connection'); await state('denied');
  check('denied capability clears repository content', reader.connection().ready === false && !(await page.locator('main').innerText()).includes('synthetic-secret'));
  source.failure = null; await action('Test read connection'); await state('read-only');
  check('retry restores verified access', reader.connection().ready);
  await action('Disconnect'); await state('disconnected');
  check('disconnect clears cached generation', !reader.connection().ready);
  await action('Test read connection'); await state('disconnected');
  check('test while disconnected does not reconnect', !reader.connection().ready);
  await action('Connect repository'); await state('read-only');
  check('reconnect verifies source', reader.connection().ready);

  await page.getByRole('combobox', { name: 'Host-configured connection' }).selectOption('sample-second');
  await action('Use selected connection'); await state('disconnected');
  check('selection clears old view without provider fallback', !reader.connection().ready && second.calls === 0);
  await action('Connect repository'); await state('read-only');
  check('selected host reader supplies actual reads', connections.selectedReader.source === second && second.calls === 1);

  // Force a stale CAS revision through a local synthetic response, not an action replay.
  await page.route('**/explorer/v1/settings', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON(); body.revision = 0;
    await route.continue({ postData: JSON.stringify(body) });
  });
  const calls = second.calls; await action('Test read connection');
  check('stale settings revision reloads without retrying action', second.calls === calls);
  await page.unroute('**/explorer/v1/settings');
  await action('Test read connection');
  check('fresh retry after conflict', second.calls === calls + 1);

  // Delay a read test, cancel waiting, then navigate. A late completion cannot
  // overwrite the new page; server state is observed on the next settings visit.
  const load = second.load.bind(second); let release;
  second.load = async () => { await new Promise(resolve => { release = resolve; }); return load(); };
  await page.getByRole('button', { name: 'Test read connection', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel waiting' }).waitFor();
  await page.getByRole('button', { name: 'Cancel waiting' }).click();
  check('cancel describes server uncertainty', (await page.locator('main').innerText()).includes('Refresh status to see the host result'));
  await openStudioSection(page, 'Blocks'); await loaded();
  release(); second.load = load;
  await page.getByRole('heading', { name: 'Choose a Release to explore.' }).waitFor();
  check('late test cannot overwrite navigation', await page.getByRole('heading', { name: 'Connections', exact: true }).count() === 0);
  await settings(); await state('read-only');

  // Delay GET settings while leaving the route; cancellation prevents stale content.
  let releaseGet, sawGet;
  const seen = new Promise(resolve => { sawGet = resolve; });
  await page.route('**/explorer/v1/settings', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); sawGet();
    await new Promise(resolve => { releaseGet = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  await openStudioSection(page, 'Blocks'); await loaded();
  await page.locator('#header').getByRole('button', { name: 'Settings', exact: true }).click(); await seen;
  await openStudioSection(page, 'Blocks'); await page.waitForURL('**/#/blocks*'); await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor({state:'detached'}); await loaded(); releaseGet();
  check('late settings GET does not replace active view', await page.getByRole('heading', { name: 'Connections', exact: true }).count() === 0);
  await page.unroute('**/explorer/v1/settings'); await settings();

  // Repaint a clean disconnected state then capture the small-screen control flow.
  await action('Disconnect');
  await page.setViewportSize({ width: 375, height: 900 });
  check('mobile settings controls remain usable', await page.getByRole('button', { name: 'Connect repository', exact: true }).isVisible());
  check('mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'settings-mobile.png'), fullPage: true });
  await action('Connect repository'); await state('read-only');
  check('mobile reconnect works', connections.selectedReader.connection().ready);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  check('browser stores no connection credentials or selection', !storage.includes(host.capability) && !storage.includes('sample-second') && !storage.includes('synthetic-secret'));

  const unavailable = new TestSource(await sample()); unavailable.connection.connection_id = 'unconfigured';
  const unavailableReader = new ExplorerReader(unavailable);
  unavailableHost = await startExplorer(unavailableReader, { assets: path.resolve('explorer'), connections: new ExplorerConnections([{ reader: unavailableReader, provider: 'unavailable' }]) });
  const other = await context.newPage(); await other.goto(unavailableHost.launchUrl);
  await other.locator('#header').getByRole('button', { name: 'Settings', exact: true }).click();
  await other.getByRole('heading', { name: 'Connections', exact: true }).waitFor();
  await other.getByRole('button', { name: 'Test read connection', exact: true }).waitFor();
  check('unconfigured setup available without project reads', unavailable.calls === 0 && await other.getByRole('button', { name: 'Test read connection', exact: true }).isDisabled() && (await other.locator('main').innerText()).includes('Owner setup required'));
  await other.close();
  check('no runtime or framework errors', errors.length === 0);
  check('no external requests', requests.length === 0);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ synthetic: true, browser: 'Edge via existing Playwright', checks, errors, externalRequests: requests.length, viewports: [1440, 375], limitations: ['No live credential/provider connection or agent protocol.', 'No screen reader speech output.'] }, null, 2));
  process.stdout.write(JSON.stringify({ passed: checks.length, output, screenshots: 2 }) + '\n');
} finally { await context?.close(); await browser.close(); await host.close(); await unavailableHost?.close(); }
