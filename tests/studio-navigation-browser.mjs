// Real local Studio surfaces with synthetic records and namespace state only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { startExplorer } from '../dist/src/explorer/host.js';
import { ExplorerReader } from '../dist/src/explorer/read.js';
import { TestSource, sample } from '../dist/tests/explorer-fixture.js';
import { namespaceFixture } from '../dist/tests/namespace-fixture.js';
import { openStudioSection } from './studio-navigation.mjs';

const { chromium } = await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const output = process.env.STRATA_STUDIO_NAV_EVIDENCE ?? await mkdtemp(path.join(os.tmpdir(), 'strata-studio-navigation-'));
await mkdir(output, { recursive: true });
const reader = new ExplorerReader(new TestSource(await sample()));
await reader.refresh();
const host = await startExplorer(reader, { assets: path.resolve('explorer') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const expectedSections = ['blocks', 'changes', 'layers', 'compositions', 'review', 'compare', 'profiles', 'build', 'evidence', 'agent', 'settings'];
const labels = ['Intent', 'Proposals', 'Compose & review', 'Implementation', 'Workspace'];
const groups = { blocks: 'intent', changes: 'proposals', layers: 'proposals', compositions: 'candidates', review: 'candidates', compare: 'candidates', profiles: 'implementation', build: 'implementation', evidence: 'implementation', agent: 'workspace', settings: 'workspace' };
const checks = [], errors = [], warnings = [], external = [], failedAssets = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const observe = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400 && /\.(js|css|svg)$/.test(new URL(response.url()).pathname)) failedAssets.push(new URL(response.url()).pathname); });
};
const loaded = async (page, section) => {
  await page.waitForFunction(section => {
    const main = document.querySelector('main'), current = document.querySelector('#sidebar a[aria-current="page"]');
    return main && !main.hasAttribute('aria-busy') && main.querySelector('h1') && current?.textContent.trim().toLowerCase() === section;
  }, section);
};
const group = (page, id, scope = '#sidebar') => page.locator(scope + ' .nav-group[data-nav-group="' + id + '"]');
const open = locator => locator.evaluate(node => node.open);
const expandAll = async (page, scope) => {
  for (const id of ['intent', 'proposals', 'candidates', 'implementation', 'workspace']) {
    const node = group(page, id, scope);
    if (!await open(node)) await node.locator('summary').click();
  }
};
const verifyIcons = async (page, scope, name) => {
  await expandAll(page, scope);
  const icons = await page.locator(scope + ' .nav-icon').evaluateAll(nodes => nodes.map(svg => {
    const shape = svg.querySelector('path'), box = shape.getBBox();
    return { path: shape.getAttribute('d'), width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, hidden: svg.getAttribute('aria-hidden'), bounds: box.width > 0 && box.height > 0 && box.x >= 0.6 && box.y >= 0.6 && box.x + box.width <= 17.4 && box.y + box.height <= 17.4, color: getComputedStyle(shape).stroke === getComputedStyle(svg.closest('a')).color };
  }));
  check(name + ': all 11 distinct icons fit and inherit selected colors', icons.length === 11 && new Set(icons.map(icon => icon.path)).size === 11 && icons.every(icon => icon.path !== 'M3 4h12 M3 9h12 M3 14h12' && icon.width === 18 && icon.height === 18 && icon.hidden === 'true' && icon.bounds && icon.color));
};
const launch = (section, params = {}) => host.origin + '/#/' + section + '?' + new URLSearchParams({ ...params, session: host.capability });
let namespace;
try {
  const local = await browser.newContext({ viewport: { width: 1440, height: 1040 }, reducedMotion: 'reduce' });
  await local.route('**/*', route => {
    if (new URL(route.request().url()).origin !== host.origin) { external.push(new URL(route.request().url()).origin); return route.abort(); }
    return route.continue();
  });
  const page = await local.newPage(); observe(page);
  await page.goto(launch('blocks')); await loaded(page, 'blocks');
  check('Studio identity and meaningful first screen', await page.title() === 'Strata Studio' && (await page.locator('main').innerText()).trim().length > 40);
  check('no framework error overlay', await page.locator('vite-error-overlay, nextjs-portal, #webpack-dev-server-client-overlay').count() === 0);
  check('five one-level groups follow the model', JSON.stringify(await page.locator('#sidebar .nav-group > summary').allTextContents()) === JSON.stringify(labels) && await page.locator('#sidebar .nav-group .nav-group').count() === 0);
  check('initial sidebar opens only Intent', await page.locator('#sidebar .nav-group[open]').count() === 1 && await open(group(page, 'intent')));
  check('all original section routes remain reachable in model order', JSON.stringify(await page.locator('#sidebar .project-nav a').allTextContents()) === JSON.stringify(expectedSections.map(section => section.charAt(0).toUpperCase() + section.slice(1))));
  await page.screenshot({ path: path.join(output, 'grouped-sidebar.png'), clip: { x: 0, y: 0, width: 232, height: 820 } });
  await group(page, 'intent').locator('summary').click();
  check('current group cannot hide the selected page', await open(group(page, 'intent')));
  const proposalSummary = group(page, 'proposals').locator('summary');
  await proposalSummary.focus(); await page.keyboard.press('Enter');
  check('Enter opens an inactive group', await open(group(page, 'proposals')) && await group(page, 'proposals').getByRole('link', { name: 'Changes', exact: true }).isVisible());
  await page.keyboard.press('Space');
  check('Space collapses an inactive group without losing focus', !await open(group(page, 'proposals')) && await proposalSummary.evaluate(node => node === document.activeElement));
  await page.getByRole('combobox', { name: 'Choose exact Release' }).selectOption('R0@1'); await loaded(page, 'blocks');
  for (const section of expectedSections) {
    const label = section.charAt(0).toUpperCase() + section.slice(1);
    await openStudioSection(page, label); await loaded(page, section);
    check(label + ': route, selected group and pinned Release are retained', await open(group(page, groups[section])) && new URLSearchParams(page.url().split('?')[1]).get('at') === 'R0@1');
  }
  await page.goBack(); await loaded(page, 'agent');
  check('browser Back keeps the selected Workspace open', await open(group(page, 'workspace')));
  await page.goBack(); await loaded(page, 'evidence');
  check('browser Back opens the selected Implementation group', await open(group(page, 'implementation')));
  await page.goForward(); await loaded(page, 'agent');
  check('browser Forward restores the selected group', await open(group(page, 'workspace')));
  await verifyIcons(page, '#sidebar', 'desktop');
  await page.goto('about:blank');
  await page.goto(launch('compositions', { at: 'R0@1' })); await loaded(page, 'compositions');
  check('fresh deep link opens only the current model stage', await page.locator('#sidebar .nav-group[open]').count() === 1 && await open(group(page, 'candidates')));
  await page.screenshot({ path: path.join(output, 'grouped-candidate-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('#menu-dialog').waitFor({ state: 'visible' });
  check('mobile menu opens the current group', await open(group(page, 'candidates', '#menu-dialog')) && await page.locator('#menu-dialog .nav-group[open]').count() === 1);
  await page.screenshot({ path: path.join(output, 'grouped-mobile-menu.png') });
  await group(page, 'proposals', '#menu-dialog').locator('summary').click();
  check('mobile and desktop disclosure state stay synchronized', await open(group(page, 'proposals')) && await open(group(page, 'proposals', '#menu-dialog')));
  await openStudioSection(page, 'Changes', '#menu-dialog'); await loaded(page, 'changes');
  check('mobile section navigation closes the menu', !await page.locator('#menu-dialog').isVisible() && await open(group(page, 'proposals')));
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await verifyIcons(page, '#menu-dialog', 'mobile');
  await page.keyboard.press('Escape');
  check('Escape dismisses the menu', !await page.locator('#menu-dialog').isVisible());
  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    check('local layout fits ' + width + 'px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await local.close();

  namespace = await namespaceFixture();
  const hosted = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await hosted.route('**/*', async route => {
    const original = route.request(), url = new URL(original.url());
    if (url.origin !== namespace.base.origin) { external.push(url.origin); return route.abort(); }
    const headers = await original.allHeaders(); headers.host = 'studio.example.test'; headers['x-forwarded-proto'] = 'https';
    const response = await new Promise((resolve, reject) => {
      const req = request(namespace.server.origin + url.pathname + url.search, { method: original.method(), headers }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)])), body: Buffer.concat(chunks) }));
      });
      req.on('error', reject); req.end(original.postDataBuffer());
    });
    await route.fulfill(response);
  });
  const ownerPage = await hosted.newPage(); observe(ownerPage);
  await ownerPage.goto(namespace.base.origin + '/#/settings');
  await ownerPage.getByLabel('Sign-in name', { exact: true }).fill('workspace.owner');
  await ownerPage.getByLabel('Password', { exact: true }).fill(namespace.base.password);
  await ownerPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await loaded(ownerPage, 'settings');
  await ownerPage.getByRole('heading', { name: 'Artifacts namespace', exact: true }).waitFor();
  check('hosted mobile navigation keeps Workspace open', await open(group(ownerPage, 'workspace', '#mobile-project-sections')));
  await ownerPage.screenshot({ path: path.join(output, 'grouped-hosted-mobile.png') });
  await group(ownerPage, 'implementation', '#mobile-project-sections').locator('summary').click();
  check('hosted mobile groups can expand without hiding the current section', await open(group(ownerPage, 'implementation', '#mobile-project-sections')) && await open(group(ownerPage, 'workspace', '#mobile-project-sections')));
  await group(ownerPage, 'implementation', '#mobile-project-sections').locator('summary').click();
  check('hosted mobile groups collapse', !await open(group(ownerPage, 'implementation', '#mobile-project-sections')));
  await openStudioSection(ownerPage, 'Build', '#mobile-project-sections'); await loaded(ownerPage, 'build');
  check('hosted mobile navigation opens the selected Implementation group', await open(group(ownerPage, 'implementation', '#mobile-project-sections')));
  await verifyIcons(ownerPage, '#mobile-project-sections', 'hosted mobile');
  for (const width of [360, 390, 768, 1024]) {
    await ownerPage.setViewportSize({ width, height: 844 });
    check('hosted layout fits ' + width + 'px', await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  check('navigation performs no provider requests', namespace.calls.length === 0);
  await hosted.close();
  check('no JavaScript errors, warnings, failed assets or external requests', !errors.length && !warnings.length && !external.length && !failedAssets.length);
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checks, errors, warnings, external, failedAssets, viewports: ['1440x1040', '360x844', '390x844', '768x844', '1024x844'], fixtureLimit: 'The reader-only sample has expected authoring/namespace/credential API refusals; no live provider or production host is used.' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, warnings, external, failedAssets, output }));
} finally {
  await browser.close();
  await host.close();
  await namespace?.server.close();
}
