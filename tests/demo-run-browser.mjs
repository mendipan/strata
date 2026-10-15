// Real Chrome + actual local launcher/controller/packet endpoints. Actor and
// management seams are deterministic offline fixtures; every external request is
// denied. Never invokes a provider, credential flow, or paid model.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startMockRunBrowser } from '../dist/tests/demo-run-browser-fixture.js';
import { createDemoDashboard } from '../dist/src/integrated-demo-dashboard.js';
import { parseRunReplay } from '../dist/src/demo-run-replay.js';

let library = process.env.STRATA_DEMO_PLAYWRIGHT_MODULE;
if (!library) {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache/_npx');
  for (const directory of await readdir(cache).catch(() => [])) {
    const candidate = path.join(cache, directory, 'node_modules/playwright/index.mjs');
    if (await readFile(candidate).then(() => true).catch(() => false)) { library = candidate; break; }
  }
}
if (!library) throw Error('Browser plugin not available; set STRATA_DEMO_PLAYWRIGHT_MODULE to an installed Playwright index.mjs. No download is attempted.');
const { chromium } = await import(pathToFileURL(path.resolve(library)).href);
const output = path.resolve(process.env.STRATA_DEMO_BROWSER_EVIDENCE || path.join(os.tmpdir(), 'strata-run-browser-qa-20261007'));
await mkdir(output, { recursive: true });
const report = { environment: { method: 'Playwright with installed Chrome', browser_plugin: 'not available', external_requests: 'denied', mocked: 'actor + management boundaries; actual launcher, lab and dashboard', viewports: ['1440x900', '1280x800', '390x844', '320x800'] }, checks: [], console: [], screenshots: [], unexpected_external_requests: [], status: 'running' };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const check = (name, value, detail = '') => { report.checks.push({ name, passed: !!value, detail }); assert.ok(value, name + ': ' + detail); };
const wait = (page, selector, text) => page.locator(selector).filter({ hasText: text }).waitFor({ timeout: 15000 });
const screenshot = async (page, name) => { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file); };
async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const origin = new URL(url).origin;
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { report.unexpected_external_requests.push(route.request().url()); return route.abort(); } return route.continue(); });
  page.on('pageerror', error => report.console.push({ kind: 'pageerror', message: error.message }));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push({ kind: message.type(), message: message.text() }); });
  await page.goto(url); await wait(page, '#mode', 'Synthetic');
  check('Page identity and meaningful shell', await page.title() === 'Strata — Run demo' && (await page.locator('body').innerText()).includes('SOURCE CONTROL'));
  return page;
}
async function begin(page, label) {
  await page.locator('#open-setup').click(); await page.locator('#begin').waitFor({ state: 'visible' });
  check(label + ': empty identity and consent', await page.locator('#operator').inputValue() === '' && !(await page.locator('#consent').isChecked()));
  await page.locator('#begin').click(); check(label + ': Begin requires identity/consent', (await page.locator('#begin-error').innerText()).includes('Enter your name'));
  await page.locator('#operator').fill('SYNTHETIC QA'); await page.locator('#consent').check(); await page.locator('#begin').dblclick();
}
async function choose(page, seconds, text) {
  await wait(page, '#headline', 'hold duration'); await page.getByRole('radio', { name: seconds / 60 + ' minutes', exact: true }).check();
  await page.locator('#reason').fill(text); await page.locator('#submit').click();
}
try {
  const mock = await startMockRunBrowser(); let page;
  try {
    page = await open(mock.url); check('A01,A02: readiness alone launches no actors', mock.starts() === 0);
    await begin(page, 'A02,A03'); await wait(page, '#headline', 'Choose the hold duration');
    check('A03: repeated Begin creates one run', mock.starts() === 1);
    check('A09: no option preselected', !(await page.getByRole('radio', { name: '15 minutes', exact: true }).isChecked()) && !(await page.getByRole('radio', { name: '20 minutes', exact: true }).isChecked()));
    check('A09: initial 20-minute candidate leaves reminder off', (await page.locator('#stage').innerText()).includes('This packet leaves the reminder off'));
    await page.locator('#defer').click(); check('A09,A13: defer also requires a reason', (await page.locator('#reason-error').innerText()).includes('Explain'));
    await page.locator('#reason').fill('SYNTHETIC twenty-minute direction'); await page.locator('#reason').focus();
    await page.waitForTimeout(1700); check('A30: polling preserves focused reason', await page.locator('#reason').inputValue() === 'SYNTHETIC twenty-minute direction' && await page.locator('#reason').evaluate(e => e === document.activeElement));
    await page.getByRole('radio', { name: '15 minutes', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    check('A30: native keyboard radio choice', await page.getByRole('radio', { name: '20 minutes', exact: true }).isChecked());
    await screenshot(page, 'live-mock-first-choice-1440');
    await page.setViewportSize({ width: 1280, height: 800 });
    check('A28: primary action visible in first desktop viewport', (await page.locator('#submit').boundingBox()).y < 756);
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, 'live-mock-first-choice-390');
    check('A29: no phone horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 320, height: 800 }); check('A29: 320px / 400% reflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' }); check('A30,A31: forced colors and reduced motion remain readable', await page.locator('#reason').isVisible());
    await page.setViewportSize({ width: 720, height: 450 });
    check('A29: 200% equivalent CSS viewport reflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' }); await page.setViewportSize({ width: 1440, height: 900 });
    let decisionPosts = 0;
    await page.route('**/decision', async route => { decisionPosts++; if (decisionPosts === 1) { await route.fetch(); await route.abort(); } else await route.continue(); });
    await page.locator('#submit').click();
    await wait(page, '#feedback', 'local controller'); check('A15,A16: lost POST response recovers via GET without retry', decisionPosts === 1);
    await wait(page, '#headline', 'Review the reminder revision');
    check('A10,A12: new packet clears prior reason and choice', await page.locator('#reason').inputValue() === '' && !(await page.getByRole('radio', { name: '20 minutes', exact: true }).isChecked()));
    check('A10,A12: revision/dependency change and expected behavior', (await page.locator('#stage').innerText()).includes('L-reminder@1 → L-reminder@2') && (await page.locator('#stage').innerText()).includes('expected, not yet measured'));
    await page.getByRole('radio', { name: '20 minutes', exact: true }).check(); await page.locator('#reason').fill('SYNTHETIC repaired packet'); await page.locator('#submit').click();
    await wait(page, '#headline', 'Approve this measured Release');
    check('A14: six mechanical rows and four scripted review rows before approval', await page.locator('#stage .result-grid').first().locator('.result-row').count() === 10);
    check('A14: approval is separate and starts with an empty reason', await page.locator('#reason').inputValue() === '' && (await page.locator('#submit').innerText()) === 'Approve this Release');
    await screenshot(page, 'live-mock-release-gate-1440');
    let disconnected = true;
    await page.route('**/state', async route => disconnected ? route.abort() : route.continue());
    await wait(page, '#connection', 'Connection lost'); check('A16,A18: disconnect freezes last known diagram and disables mutation', !(await page.locator('#submit').count()) && (await page.locator('#stage').innerText()).includes('Mechanical checks'));
    disconnected = false; await page.locator('#reconnect').click(); await page.locator('#reason').waitFor();
    await page.locator('#reason').fill('SYNTHETIC separate Release approval'); await page.locator('#submit').dblclick();
    await wait(page, '#review', 'CLEANUP VERIFIED'); await mock.settled();
    check('A21,A23: Release, inheritance and cleanup independently rendered', (await page.locator('#stage').innerText()).includes('INHERITED BEHAVIOR VERIFIED') && (await page.locator('#review').innerText()).includes('Private Worker retained'));
    check('A16: successful GET clears the obsolete transport error', (await page.locator('#error').innerText()) === '');
    check('A15: stale Workflow waiting feedback cleared', !(await page.locator('#feedback').innerText()).includes('Waiting for the Workflow'));
    check('A03,A15: exactly three decision POSTs after interrupted/repeated interactions', decisionPosts === 3);
    await screenshot(page, 'live-mock-receipt-1440');
    await page.locator('#review-run').click(); check('A26: earlier evidence has no consent controls', await page.locator('#inspection').isVisible() && await page.locator('#submit').count() === 0);
    await page.locator('#history-next').click(); check('A26: earlier stage navigation stays read-only', (await page.locator('#history-position').innerText()).includes('2 /') && await page.locator('#submit').count() === 0);
    await page.locator('#return-current').click(); await page.locator('#fresh').click(); await mock.settled(); await page.waitForTimeout(1700);
    check('A02,A26: fresh preparation does not start or reuse consent', mock.starts() === 1 && !(await page.locator('#consent').isChecked()) && await page.locator('#operator').inputValue() === '');
  } finally { await page?.close(); await mock.close(); }

  for (const scenario of ['fifteen-defer-release', 'three-process-repair', 'stop', 'actor-failure', 'startup-failure', 'cleanup-blocked']) {
    const mock = await startMockRunBrowser({ repair: scenario !== 'three-process-repair', actor_failure: scenario === 'actor-failure', startup_failure: scenario === 'startup-failure', cleanup_blocked: scenario === 'cleanup-blocked' }); let page;
    try {
      page = await open(mock.url); await begin(page, scenario);
      if (scenario === 'actor-failure' || scenario === 'startup-failure') { await mock.settled(); await wait(page, '#review', 'Run needs review'); check('A13: ' + scenario + ' does not fabricate Release', !(await page.locator('#stage').innerText()).includes('RELEASE VALIDATED')); continue; }
      await wait(page, '#headline', 'Choose the hold duration');
      if (scenario === 'stop') { page.once('dialog', d => d.accept()); await page.locator('#stop').click(); await mock.settled(); await wait(page, '#review', 'CLEANUP VERIFIED'); check('A13: stop preserves no-release outcome', !(await page.locator('#stage').innerText()).includes('RELEASE VALIDATED')); continue; }
      await choose(page, scenario === 'three-process-repair' ? 1200 : 900, 'SYNTHETIC fixture direction');
      if (scenario === 'three-process-repair') { await mock.settled(); await wait(page, '#review', 'Run needs review'); check('A11: three-process repair stops without B@2', !(await page.locator('#stage').innerText()).includes('L-reminder@2')); continue; }
      await wait(page, '#headline', 'Approve this measured Release'); await page.locator('#reason').fill('SYNTHETIC Release decision');
      await page.locator(scenario === 'cleanup-blocked' ? '#submit' : '#defer').click(); await mock.settled(); await wait(page, '#review', scenario === 'cleanup-blocked' ? 'CLEANUP BLOCKED' : 'CLEANUP VERIFIED');
      check('A13,A22: ' + scenario, scenario === 'cleanup-blocked' ? (await page.locator('#stage').innerText()).includes('RELEASE VALIDATED') && !(await page.locator('#fresh').isVisible()) : !(await page.locator('#stage').innerText()).includes('RELEASE VALIDATED'));
    } finally { await page?.close(); await mock.close(); }
  }
  const replay = parseRunReplay(JSON.parse(await readFile('examples/replay/synthetic-run.json', 'utf8'))), server = await createDemoDashboard(replay.run_id, () => {}, undefined, { source_mode: 'recorded-replay', replay });
  const replayPage = await browser.newPage({ viewport: { width: 1440, height: 960 } }); let mutations = 0;
  await replayPage.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
  replayPage.on('request', r => { if (r.method() === 'POST') mutations++; });
  try {
    await replayPage.goto(server.url); await wait(replayPage, '#mode', 'Recorded');
    await replayPage.clock.install(); await replayPage.locator('#play').click(); await replayPage.clock.fastForward(30000); await replayPage.clock.fastForward(30000);
    check('A24,A31: autoplay pauses at recorded decision', (await replayPage.locator('#play').innerText()) === 'Play replay' && (await replayPage.locator('#review').innerText()).includes('Recorded choice: 20 minutes'));
    await replayPage.locator('#previous').click(); await replayPage.locator('#previous').click();
    for (let i = 0; i < replay.chapters.length; i++) {
      check('A24,A26: replay stage ' + (i + 1) + ' keeps mode and no live controls', (await replayPage.locator('#mode').innerText()).includes('read-only') && await replayPage.locator('#submit').count() === 0 && !(await replayPage.locator('#begin').isVisible()));
      if (i === 0 || i === 2 || i === 9) await screenshot(replayPage, 'recorded-replay-stage-' + i + '-1440');
      if (i < replay.chapters.length - 1) await replayPage.locator('#next').click();
    }
    await replayPage.locator('#previous').click(); await replayPage.locator('#play').click(); check('A31: autoplay is explicitly pausable', (await replayPage.locator('#play').innerText()) === 'Pause replay'); await replayPage.locator('#play').click();
    check('A26: replay navigation performs no POST', mutations === 0);
    // Browser-render the supplied vector illustrations for direct image inspection.
    for (const name of ['01-owned-layers', '02-human-choice', '03-release-receipt', '04-phone-choice']) {
      const svg = await readFile(path.join('docs/design/demo-run', name + '.svg'), 'utf8');
      const native = name.startsWith('04') ? { width: 390, height: 1320 } : { width: 1440, height: 960 };
      await replayPage.setViewportSize(native); await replayPage.setContent('<body style="margin:0">' + svg + '</body>'); await screenshot(replayPage, 'reference-' + name);
    }
  } finally { await replayPage.close(); await server.close(); }
  const statusServer = await createDemoDashboard('imported-status-only', () => { throw Error('Read-only status must not stop anything'); }, undefined, { source_mode: 'imported-unverified' });
  const statusPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await statusPage.route('**/*', route => new URL(route.request().url()).origin === new URL(statusServer.url).origin ? route.continue() : route.abort());
  try {
    await statusServer.emit({ type: 'provider-outcome', provider: { status: 'complete' }, application: { ok: false, phase: 'failed', refusal_code: 'SYNTHETIC_REFUSAL' } });
    await statusPage.goto(statusServer.url); await wait(statusPage, '#mode', 'unverified');
    check('A25: unverified status-only source renders no invented Layer or Block', (await statusPage.locator('#stage').innerText()).includes('Status only') && !(await statusPage.locator('#stage').innerText()).includes('Actor A'));
    check('A19: provider complete and application false do not become overall success', (await statusPage.locator('#review').innerText()).includes('Recorded failure') && (await statusPage.locator('#review').innerText()).includes('SYNTHETIC_REFUSAL') && !(await statusPage.locator('#stage').innerText()).includes('RELEASE VALIDATED'));
    check('A25: status-only import has no Begin or decision controls', !(await statusPage.locator('#begin').isVisible()) && await statusPage.locator('#submit').count() === 0);
    await screenshot(statusPage, 'imported-status-only-1280');
  } finally { await statusPage.close(); await statusServer.close(); }
  check('No unexpected external requests', report.unexpected_external_requests.length === 0);
  function ratio(a,b){const luminance=h=>{const c=h.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
  check('A30: specified text and focus palette contrast', ['201d18','62594d','a94f13','42654d','9b4835','24516b'].every(color=>ratio(color,'fffdf8')>=4.5));
  check('No framework overlay / application script errors', !report.console.some(e => e.kind === 'pageerror' || (!e.message.includes('net::ERR_FAILED') && e.message.includes('Content Security Policy'))));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error.stack || error); throw error; }
finally { await browser.close(); await writeFile(path.join(output, 'browser-evidence.json'), JSON.stringify(report, null, 2)); console.log('Browser evidence: ' + path.join(output, 'browser-evidence.json') + ' (' + report.status + ', ' + report.checks.length + ' checks)'); }
