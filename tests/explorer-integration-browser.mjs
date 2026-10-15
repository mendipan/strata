// Combined settings/map/draft coverage with one project and synthetic host readers.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../dist/src/model.js';
import { ExplorerReader } from '../dist/src/explorer/read.js';
import { ExplorerConnections } from '../dist/src/explorer/connections.js';
import { startExplorer } from '../dist/src/explorer/host.js';
import { TestSource } from '../dist/tests/explorer-fixture.js';
import { visualRecords } from '../dist/tests/explorer-visual-fixture.js';

const { chromium } = await import(pathToFileURL(path.resolve(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE)).href);
const output = await mkdtemp(path.join(os.tmpdir(), 'strata-explorer-integration-'));
const source = new TestSource(visualRecords()); source.connection.display_name = 'Primary workspace';
const alternateRelease = structuredClone(source.records['WorkspaceBaseline@1']);
alternateRelease.data.id = 'WorkspaceOther'; alternateRelease.data.blocks.records.purpose = 'Keep records clear in the second verified view.';
const alternate = new TestSource({ 'WorkspaceOther@1': alternateRelease }); alternate.connection.connection_id = 'workspace-alternate'; alternate.connection.display_name = 'Alternate workspace';
const before = canonical(source.records), alternateBefore = canonical(alternate.records);
const reader = new ExplorerReader(source); await reader.refresh();
const connections = new ExplorerConnections([{ reader, provider: 'sample' }, { reader: new ExplorerReader(alternate), provider: 'sample' }]);
const host = await startExplorer(reader, { assets: path.resolve('explorer'), connections });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
const checks = [], errors = [], external = [], writes = [];
const check = (name, result) => { checks.push({ name, passed: !!result }); assert.ok(result, name); };
await context.route('**/*', route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== host.origin) { external.push(url.origin); return route.abort(); }
  if (request.method() !== 'GET' && !['/explorer/v1/settings', '/explorer/v1/refresh'].includes(url.pathname)) writes.push(url.pathname);
  return route.continue();
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: host.origin });
const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('server responded with a status of')) errors.push(m.text()); });
const loaded = () => page.locator('main[aria-busy]').waitFor({ state: 'detached' });
const settings = async () => { await page.locator('#header').getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor(); await loaded(); };
const action = async name => {
  const response = page.waitForResponse(r => r.url().endsWith('/explorer/v1/settings') && r.request().method() === 'POST');
  await page.getByRole('button', { name, exact: true }).click(); await response;
  await page.waitForFunction(revision => document.querySelector('.connection-settings')?.dataset.connectionRevision === String(revision) && !document.querySelector('main[aria-busy]') && ![...document.querySelectorAll('main button')].find(b => b.textContent === 'Test read connection')?.disabled, connections.status().revision);
};
try {
  await page.goto(host.launchUrl); await loaded();
  await page.getByRole('combobox', { name: 'Choose exact Release' }).selectOption('WorkspaceBaseline@1'); await loaded();
  check('combined map loads through existing protected reader', await page.locator('.intent-block').count() === 8 && await page.title() === 'Strata Studio');
  await page.getByRole('combobox', { name: 'Preview a Layer' }).selectOption('L-clear-review@1'); await loaded();
  await page.getByRole('button', { name: 'Prepare a proposal', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Prepare an owned Layer proposal' });
  await dialog.getByLabel('New Layer ID', { exact: true }).fill('L-integration-review');
  await dialog.getByLabel('Requested Layer owner', { exact: true }).fill('author');
  await dialog.getByLabel('Intent', { exact: true }).fill('Review exact context before an owned proposal.');
  await dialog.getByRole('combobox', { name: 'Proposal Block' }).selectOption('review');
  await dialog.getByRole('textbox', { name: 'Proposed purpose' }).fill('Review the exact baseline and neighboring intent.');
  await dialog.getByRole('button', { name: 'Add item to draft' }).click();
  await dialog.getByRole('button', { name: 'Review draft', exact: true }).click();
  check('combined proposal remains an explicit read-only handoff', await dialog.getByRole('button', { name: 'Save to repository unavailable' }).isDisabled());
  await page.evaluate(() => {
    window.__staleExport = [...document.querySelectorAll('.proposal-dialog button')].find(b => b.textContent === 'Copy Layer draft');
    window.__clipboardWrites = []; const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = text => { window.__clipboardWrites.push(text); return original(text); };
    window.__connectionEvents = []; window.addEventListener('strata:connection-change', e => window.__connectionEvents.push(e.detail));
  });
  // A same-document route change is possible while a modal is open (Back/address bar).
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor(); await loaded();
  check('settings navigation discards an open reviewed draft', await page.locator('.proposal-dialog').count() === 0);

  // Capture one old-generation graph response, then switch connections before delivery.
  let releaseRead, seenRead;
  const seen = new Promise(resolve => { seenRead = resolve; });
  await page.route('**/explorer/v1/blocks?**', async route => {
    const response = await route.fetch(); seenRead();
    await new Promise(resolve => { releaseRead = resolve; });
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await page.evaluate(() => { location.hash = '#/blocks?at=WorkspaceBaseline%401&view=map&layer=L-clear-review%401'; });
  await seen; await settings();
  await page.getByRole('combobox', { name: 'Host-configured connection' }).selectOption('workspace-alternate');
  await action('Use selected connection');
  check('connection selection clears the old verified generation', !reader.connection().ready && connections.status().connections[1].state === 'disconnected');
  await action('Reconnect');
  check('actual settings callback announces both connection operations', await page.evaluate(() => window.__connectionEvents.length === 2));
  await page.evaluate(() => window.__staleExport.click());
  check('old detached export refuses after the connection epoch changed', await page.evaluate(() => window.__clipboardWrites.length === 0));
  await openStudioSection(page, 'Blocks'); await loaded();
  await page.getByRole('combobox', { name: 'Choose exact Release' }).selectOption('WorkspaceOther@1'); await loaded();
  releaseRead();
  await page.locator('.intent-block').filter({ has: page.locator('.block-id', { hasText: /^records$/ }) }).click(); await loaded();
  check('late old graph cannot overwrite selected connection data', (await page.locator('main').innerText()).includes('Keep records clear in the second verified view.') && !page.url().includes('L-clear-review'));
  check('old Layer overlay is absent on the new source', await page.getByRole('combobox', { name: 'Preview a Layer' }).inputValue() === '');
  await page.screenshot({ path: path.join(output, 'combined-desktop.png'), fullPage: false });
  await page.getByRole('button', { name: 'Describe a feature', exact: true }).click();
  const handoff = page.getByRole('dialog', { name: 'Describe a feature', exact: true });
  await handoff.getByRole('textbox', { name: 'Feature request' }).fill('Keep the reviewed record context understandable.');
  await handoff.getByRole('button', { name: 'Prepare agent handoff' }).click();
  check('agent handoff binds the current project and exact baseline without chat', (await handoff.getByRole('textbox', { name: 'Agent handoff' }).inputValue()).includes('Baseline: WorkspaceOther@1') && (await handoff.innerText()).includes('no agent has run'));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('strata:connection-change')));
  await handoff.waitFor({ state: 'detached' });
  check('connection invalidation closes prepared agent handoff', await page.locator('.proposal-dialog').count() === 0);
  await page.setViewportSize({ width: 375, height: 900 });
  check('combined settings and graph retain mobile layout', !await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await page.screenshot({ path: path.join(output, 'combined-mobile.png'), fullPage: false });
  await settings(); await action('Disconnect');
  await page.locator('#header').getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Project menu' }).getByRole('link', { name: 'Blocks', exact: true }).click(); await loaded();
  check('disconnect removes graph and authoring controls', await page.locator('.intent-block,.proposal-dialog').count() === 0 && await page.getByRole('button', { name: 'Prepare a proposal', exact: true }).count() === 0);
  check('no records changed through the combined workflows', canonical(source.records) === before && canonical(alternate.records) === alternateBefore);
  check('no external requests, repository writes, or browser errors', external.length === 0 && writes.length === 0 && errors.length === 0);
  console.log(JSON.stringify({ passed: checks.length, output, external: external.length, writes: writes.length, errors }));
} catch (error) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); console.error(JSON.stringify({ output, checks, errors })); throw error;
} finally { await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ checks, errors, external, writes }, null, 2)); await context.close(); await browser.close(); await host.close(); }
