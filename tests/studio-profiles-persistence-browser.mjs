// Real Studio shell + real LocalBuildRepository disk persistence. Namespace
// chooser/session orchestration and response faults are synthetic test seams.
// No installed host, owner data, credentials or provider is used or qualified.
import { openStudioSection } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAdapterFixture, indexedBuildRecords } from '../dist/tests/build-adapter-fixture.js';
import { StudioCommands } from '../dist/src/explorer/commands.js';
import { startExplorer } from '../dist/src/explorer/host.js';
import { LocalBuildStudioAdapter, PROFILES_BUILD_COMMANDS } from '../dist/src/build-studio.js';
import { digest, BLOCK_MODEL } from '../dist/src/model.js';

const output = process.env.STRATA_PROFILES_PERSISTENCE_OUTPUT;
assert(output && process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE, 'Explicit evidence directory and existing Playwright module required.');
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href);
const fixtures = new Map(), endpoints = new Map();
for (const id of ['profiles-a', 'profiles-b']) fixtures.set(id, await buildAdapterFixture('browser-' + id, {}, id));
async function endpoint(id, configured = true) {
  const f = fixtures.get(id), context = () => f.context('author-a');
  const commands = new StudioCommands({ project_id: f.issuer.projectId, model_version: BLOCK_MODEL }, '', f.root,
    [...PROFILES_BUILD_COMMANDS], {}, 'local-fixture', undefined,
    options => (command, input) => f.repository.execute(command, input, context(), { key: options.idempotency_key }),
    undefined, configured ? new LocalBuildStudioAdapter(f.repository, context) : undefined);
  await commands.reader.refresh();
  const host = await startExplorer(commands.reader, { assets: path.resolve('explorer'), commands });
  return { host, commands, async close() { await host.close(); commands.close(); } };
}
for (const id of fixtures.keys()) endpoints.set(id, await endpoint(id));
const origin = endpoints.get('profiles-a').host.origin;
let selected = 'profiles-a', revision = 1, fault = '', delayed = false;
const checks = [], operations = [], errors = [], consoleErrors = [], outside = [], requests = [];
const status = () => ({ mode: 'namespace', revision, selected_repository_id: selected, scope_sha256: 'f'.repeat(64),
  scope: { account: 'synthetic', namespace: 'disposable-local-repositories' }, approved: true, revoked: false, connected: true,
  projects: [...fixtures.keys()].map(id => ({ id, name: id, state: 'ready', read_only: false })), operations: [] });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
context.setDefaultTimeout(12000);
await context.addInitScript(() => window.addEventListener('DOMContentLoaded', () => {
  const note = document.createElement('p'); note.className = 'notice'; note.id = 'synthetic-harness';
  note.textContent = 'Synthetic namespace/session harness; real disposable local repository persistence. No installed host or provider.';
  document.body.prepend(note);
}));
const actorStatus = () => { try { fixtures.get(selected).context('author-a'); return true; } catch { return false; } };
await context.route('**/*', async route => {
  const original = route.request(), url = new URL(original.url());
  if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
  requests.push({ path: url.pathname, method: original.method(), repository: selected });
  const json = data => route.fulfill({ status: 200, json: data });
  if (url.pathname === '/studio/session') return json({ mode: 'hosted-owner', configured: true, authenticated: true, csrf: 'synthetic-owner-csrf', workspace: true, namespace: true });
  if (url.pathname === '/studio/actor/session') {
    if (original.method() === 'POST' && !actorStatus()) {
      const f = fixtures.get(selected); f.tokens['author-a'] = f.issuer.login('author-a', f.keys['author-a']);
    }
    return json({ authenticated: actorStatus(), csrf: 'synthetic-actor-csrf', principal_id: 'author-a' });
  }
  if (url.pathname === '/studio/v1/owner/credentials') return json({ credentials: [{ id: 'artifacts-api-token', configured: true }] });
  if (url.pathname === '/studio/v1/owner/connections') {
    if (original.method() === 'GET') return json(status());
    const body = original.postDataJSON();
    if (body.action === 'select') { assert(fixtures.has(body.repository_id)); selected = body.repository_id; revision++; }
    else assert.equal(body.action, 'discover', 'The harness permits chooser reads/select only.');
    return json({ ...status(), outcome: { phase: 'completed' }, discovery: { repositories: status().projects, cursor: null } });
  }
  const operation = url.pathname === '/studio/v1/operation';
  if (operation) operations.push({ repository: selected, ...original.postDataJSON(), repository_header: original.headers()['x-strata-repository'] });
  if (url.pathname.startsWith('/studio/v1/') && !actorStatus()) return route.fulfill({ status: 401, json: { error: { code: 'SESSION_REQUIRED', message: 'Synthetic actor session expired before dispatch.' } } });
  if (delayed && url.pathname === '/studio/v1/profiles/validate') await new Promise(resolve => setTimeout(resolve, 450));
  const target = endpoints.get(selected).host;
  const headers = await original.allHeaders();
  headers.host = new URL(target.origin).host; headers.authorization = 'Bearer ' + target.capability;
  if (headers.origin) headers.origin = target.origin;
  delete headers.cookie; delete headers['x-forwarded-proto'];
  const response = await new Promise((resolve, reject) => {
    const req = request(target.origin + url.pathname + url.search, { method: original.method(), headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)])), body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end(original.postDataBuffer());
  });
  if (operation) { const result = JSON.parse(response.body); operations.at(-1).response = { status: response.status, code: result.error?.code ?? null, ref: result.data?.data?.ref ?? null }; }
  if (['/explorer/v1/connection', '/explorer/v1/refresh'].includes(url.pathname) && response.status === 200) {
    // A synthetic namespace gateway names its admitted local connection. Every
    // generation, profile/contract, validation and write result stays real.
    const result = JSON.parse(response.body); result.data.connection_id = selected; result.data.display_name = selected;
    response.body = Buffer.from(JSON.stringify(result)); delete response.headers['content-length'];
  }
  if (operation && ['lost-committed', 'wrong-confirmation', 'empty-confirmation', 'bogus-ref'].includes(fault)) {
    assert.equal(response.status, 200, response.body.toString());
    if (fault === 'lost-committed') return route.abort();
    const result = JSON.parse(response.body);
    if(fault==='empty-confirmation')result.data.data={};
    else if(fault==='bogus-ref'){result.data.data.ref='build-profile@'+'e'.repeat(64);result.data.data.sha256='e'.repeat(64);}
    else result.data.data.record.repository_id = 'wrong-repository';
    response.body = Buffer.from(JSON.stringify(result)); delete response.headers['content-length'];
  }
  await route.fulfill(response);
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const loaded = () => page.locator('main[aria-busy]').waitFor({ state: 'detached' });
const profilesLoaded = async () => { await page.getByRole('heading', { name: 'Profiles', exact: true }).waitFor(); await loaded(); };
const check = async (name, run) => { await run(); checks.push({ name, passed: true }); console.log('PASS ' + name); };
const blocksLoaded = async () => { await page.locator('main h1').filter({ hasText: /Application map|Choose a Release/ }).waitFor(); await loaded(); if (await page.getByRole('heading', { name: 'Choose a Release to explore.', exact: true }).isVisible()) { await page.getByRole('combobox', { name: 'Choose exact Release', exact: true }).first().selectOption(fixtures.get(selected).release.ref); await page.getByRole('heading', { name: 'Application map', exact: true }).waitFor(); await loaded(); } };
const section = async name => { await openStudioSection(page, name); if (name === 'Blocks') return blocksLoaded(); await page.locator('main h1').filter({ hasText: name }).waitFor(); await loaded(); };
const openNew = async name => { await page.getByRole('button', { name: 'New profile', exact: true }).click(); await page.getByLabel('Profile name', { exact: true }).fill(name); await page.getByRole('button', { name: 'Save new profile', exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('#profiles button[type=submit]').disabled); };
const saved = async name => { await page.locator('#profiles').getByText(new RegExp('Saved [“"]' + name + '[”"] as immutable revision')).waitFor(); await page.getByRole('button', { name, exact: true }).waitFor(); };
const profileList = async id => (await fixtures.get(id).repository.execute('profile.list', {}, fixtures.get(id).context('author-a'))).data.profiles;
const edit = async name => { await page.getByRole('button', { name, exact: true }).click(); await page.getByRole('button', { name: 'Edit (new revision)', exact: true }).click(); await page.getByLabel('Profile name', { exact: true }).waitFor(); };
const selectRepository = async id => { await page.locator('.repository-switcher').click(); await page.getByRole('button', { name: 'Open ' + id, exact: true }).click(); await blocksLoaded(); await section('Profiles'); };
try {
  await page.goto(origin + '/#/profiles?repo=profiles-a&at=' + encodeURIComponent(fixtures.get(selected).release.ref)); await profilesLoaded();
  await check('real Profiles route, context and unchanged Studio shell render', async () => {
    assert.equal(await page.title(), 'Strata Studio'); assert(page.url().includes('#/profiles'));
    assert(await page.getByRole('heading', { name: 'Profiles', exact: true }).isVisible());
    assert((await page.locator('#profiles').innerText()).includes(fixtures.get(selected).contract.ref));
    assert.equal(await page.locator('#profiles input[type=password], #profiles textarea').count(), 0);
    assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
    await page.screenshot({ path: path.join(output, '01-real-profiles-1280.png'), fullPage: true });
  });
  await check('create/repeated-submit uses one real mutation and disk-verified normalized digest', async () => {
    await openNew('Synthetic browser profile');
    await page.getByRole('button', { name: 'Save new profile', exact: true }).dblclick(); await saved('Synthetic browser profile');
    const matches = (await profileList(selected)).filter(p => p.record.name === 'Synthetic browser profile'); assert.equal(matches.length, 1);
    const mutation = operations.at(-1); assert.equal(mutation.input.expected_normalized_sha256, digest(mutation.input.record));
    assert.equal(operations.filter(o => o.input.record?.name === 'Synthetic browser profile').length, 1);
  });
  const first = (await profileList(selected)).find(p => p.record.name === 'Synthetic browser profile');
  await check('navigate away/back and browser history return to functional Profiles', async () => {
    await section('Blocks'); await page.goBack(); await page.getByRole('heading', { name: 'Profiles', exact: true }).waitFor(); await loaded();
    assert(await page.getByRole('button', { name: first.record.name, exact: true }).isVisible());
    await page.goForward(); await page.getByRole('heading', { name: 'Application map', exact: true }).waitFor(); await loaded(); await section('Profiles');
  });
  await check('edit produces immutable revision two with unchanged revision one', async () => {
    await edit(first.record.name); await page.getByLabel('Profile name', { exact: true }).fill('Synthetic revised profile');
    await page.getByRole('button', { name: 'Save revision 2', exact: true }).click(); await saved('Synthetic revised profile');
    const next = (await profileList(selected)).find(p => p.record.id === first.record.id);
    assert.equal(next.record.revision, 2); assert.equal(next.record.previous.ref, first.ref);
    const records = await indexedBuildRecords(fixtures.get(selected).state); assert.equal(digest(records[first.ref].data), first.sha256);
  });
  await check('real concurrent CAS refusal retains input and explicit reload saves revision four', async () => {
    await edit('Synthetic revised profile'); await page.getByLabel('Profile name', { exact: true }).fill('Retained after stale CAS');
    const f = fixtures.get(selected), previous = (await profileList(selected)).find(p => p.record.id === first.record.id);
    const record = { ...f.profileRequest.record, id: first.record.id, revision: 3, name: 'Synthetic concurrent editor' };
    await f.repository.execute('profile.revise', { previous: previous.ref, record, expected_normalized_sha256: digest(record) }, f.context('author-a'), { key: 'concurrent-ui-review' });
    await page.getByRole('button', { name: 'Save revision 3', exact: true }).click();
    await page.getByRole('button', { name: 'Reload latest revision', exact: true }).waitFor();
    assert.equal(operations.at(-1).response.code, 'STALE_GENERATION');
    assert.equal(await page.getByLabel('Profile name', { exact: true }).inputValue(), 'Retained after stale CAS');
    assert.equal((await profileList(selected)).find(p => p.record.id === first.record.id).record.revision, 3);
    await page.getByRole('button', { name: 'Reload latest revision', exact: true }).click();
    await page.getByRole('button', { name: 'Save revision 4', exact: true }).waitFor();
    const intro=await page.locator('#profiles form > p').first().innerText();
    const concurrent=(await profileList(selected)).find(p=>p.record.id===first.record.id);
    assert(intro.includes('Revision 4 of')&&intro.includes(concurrent.ref)&&!intro.includes(previous.ref));
    await page.getByRole('button', { name: 'Save revision 4', exact: true }).click(); await saved('Retained after stale CAS');
    assert.equal((await profileList(selected)).find(p => p.record.id === first.record.id).record.revision, 4);
  });
  await check('dirty navigation, browser Back, Escape and Refresh preserve drafts on cancellation', async () => {
    await openNew('Unsaved navigation marker'); await openStudioSection(page, 'Blocks');
    await page.getByRole('button', { name: 'Keep editing (cancel)', exact: true }).click();
    assert(page.url().includes('#/profiles')); assert.equal(await page.getByLabel('Profile name', { exact: true }).inputValue(), 'Unsaved navigation marker');
    // A cancelled link restored the newest entry to Profiles. The first Back
    // can therefore be a same-route entry; the next Back attempts to leave.
    await page.goBack(); if (!await page.getByRole('dialog', { name: 'Leave with an unsaved draft?', exact: true }).isVisible()) await page.goBack();
    await page.getByRole('dialog', { name: 'Leave with an unsaved draft?', exact: true }).waitFor(); await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('Profile name', { exact: true }).inputValue(), 'Unsaved navigation marker');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByRole('button', { name: 'Keep editing (cancel)', exact: true }).click();
    assert.equal(await page.getByLabel('Profile name', { exact: true }).inputValue(), 'Unsaved navigation marker');
  });
  await check('repository chooser cancellation/discard and delayed reads cannot leak drafts or records', async () => {
    await page.locator('.repository-switcher').click(); await page.getByRole('button', { name: 'Keep editing (cancel)', exact: true }).click(); assert.equal(selected, 'profiles-a');
    delayed = true; await page.getByLabel('Profile name', { exact: true }).fill('Delayed old-repository marker');
    await page.waitForTimeout(320); await page.locator('.repository-switcher').click(); await page.getByRole('button', { name: 'Discard draft and leave', exact: true }).click();
    await page.getByRole('button', { name: 'Open profiles-b', exact: true }).click(); await blocksLoaded(); await section('Profiles');
    delayed = false; await page.waitForTimeout(500);
    assert.equal(await page.getByLabel('Profile name', { exact: true }).count(), 0); assert(!(await page.locator('main').innerText()).includes('Retained after stale CAS'));
    await openNew('Synthetic second repository'); await page.getByRole('button', { name: 'Save new profile', exact: true }).click(); await saved('Synthetic second repository');
    assert.equal((await profileList('profiles-a')).some(p => p.record.name === 'Synthetic second repository'), false);
    assert.equal((await profileList('profiles-b')).some(p => p.record.name === 'Synthetic second repository'), true);
    await selectRepository('profiles-a'); assert(await page.getByRole('button', { name: 'Retained after stale CAS', exact: true }).isVisible());
  });
  await check('expired synthetic actor retains draft; shell recovery enables a real save', async () => {
    await openNew('Synthetic recovered session'); const f = fixtures.get(selected); f.issuer.logout(f.tokens['author-a']);
    await page.getByRole('button', { name: 'Save new profile', exact: true }).click(); await page.getByRole('button', { name: 'Recover session and continue', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Profile name', { exact: true }).inputValue(), 'Synthetic recovered session');
    await page.getByRole('button', { name: 'Recover session and continue', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#profiles button[type=submit]').disabled);
    await page.getByRole('button', { name: 'Save new profile', exact: true }).click(); await saved('Synthetic recovered session');
  });
  await check('options-probe session expiry recovers missing options and saves the retained draft', async()=>{
    await section('Blocks');await section('Profiles');const f=fixtures.get(selected),before=operations.length;
    f.issuer.logout(f.tokens['author-a']);
    await page.getByRole('button',{name:'New profile',exact:true}).click();
    await page.getByLabel('Profile name',{exact:true}).fill('Synthetic options expiry');
    await page.getByRole('button',{name:'Recover session and continue',exact:true}).waitFor();
    assert.equal(operations.length,before);assert(await page.getByRole('button',{name:'Save new profile',exact:true}).isDisabled());
    await page.getByRole('button',{name:'Recover session and continue',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#profiles button[type=submit]').disabled);
    assert.equal(await page.getByLabel('Profile name',{exact:true}).inputValue(),'Synthetic options expiry');
    await page.getByRole('button',{name:'Save new profile',exact:true}).click();await saved('Synthetic options expiry');
    assert.equal(operations.length,before+1);
  });
  await check('validation-read session expiry retains input and resumes through the same recovery action',async()=>{
    await openNew('Synthetic validation read');const f=fixtures.get(selected),before=operations.length;
    f.issuer.logout(f.tokens['author-a']);await page.getByLabel('Profile name',{exact:true}).fill('Synthetic resumed validation');
    await page.getByRole('button',{name:'Recover session and continue',exact:true}).waitFor();
    assert.equal(operations.length,before);
    await page.getByRole('button',{name:'Recover session and continue',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#profiles button[type=submit]').disabled);
    assert.equal(await page.getByLabel('Profile name',{exact:true}).inputValue(),'Synthetic resumed validation');
    await page.getByRole('button',{name:'Close editor',exact:true}).click();
  });
  await check('late detail replies stay discarded and an obsolete Edit control honors the dirty guard',async()=>{
    const before=operations.length;await page.getByRole('button',{name:'Local preview',exact:true}).click();
    await page.evaluate(()=>{window.__oldProfileEdit=[...document.querySelectorAll('#profiles button')].find(b=>b.textContent==='Edit (new revision)')});
    let release,started;const gate=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>started=resolve);
    const pattern='**/studio/v1/profiles/record?*';
    await page.route(pattern,async route=>{started();await gate;await route.fallback()});
    await page.getByRole('button',{name:'Reload this profile',exact:true}).click();await requested;
    await page.getByRole('button',{name:'Back to list',exact:true}).click();await openNew('Synthetic retained late-detail draft');
    const reply=page.waitForResponse(response=>new URL(response.url()).pathname==='/studio/v1/profiles/record');
    release();await (await reply).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('heading',{name:'Saved profile: Local preview',exact:true}).count(),0);
    assert.equal(await page.getByLabel('Profile name',{exact:true}).inputValue(),'Synthetic retained late-detail draft');
    await page.evaluate(()=>window.__oldProfileEdit.click());
    await page.getByRole('button',{name:'Keep editing (cancel)',exact:true}).click();
    assert.equal(await page.getByLabel('Profile name',{exact:true}).inputValue(),'Synthetic retained late-detail draft');
    assert.equal(operations.length,before);await page.unroute(pattern);await page.getByRole('button',{name:'Close editor',exact:true}).click();
  });
  for (const mode of ['lost-committed', 'wrong-confirmation', 'empty-confirmation', 'bogus-ref']) await check(mode + ' retains original recovery key across reload; Review inspects without replay', async () => {
    await openNew('Synthetic ' + mode); const before = operations.length; fault = mode;
    await page.getByRole('button', { name: 'Save new profile', exact: true }).click(); await page.getByText(/The save outcome is unknown:/).waitFor(); fault = '';
    assert.equal(await page.getByLabel('Profile name', { exact: true }).inputValue(), 'Synthetic ' + mode);
    const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('strata-studio-pending')));
    assert.equal(pending.key, operations.at(-1).idempotency_key); assert.equal(pending.connection_id, selected);
    await page.getByLabel('Profile name', { exact: true }).press('Enter'); assert.equal(operations.length, before + 1);
    await page.reload(); await profilesLoaded(); assert(await page.getByRole('button', { name: 'New profile', exact: true }).isDisabled());
    if(mode==='lost-committed'){
      await selectRepository('profiles-b'); await section('Review');
      assert.equal(await page.getByRole('button', { name: 'Check original request receipt', exact: true }).count(), 0);
      assert((await page.locator('main').innerText()).includes('Open that original repository')); await selectRepository('profiles-a');
    }
    await section('Review'); await page.getByRole('button', { name: 'Check original request receipt', exact: true }).click(); await page.getByText('Original request receipt: committed.', { exact: true }).waitFor();
    assert.equal(operations.length, before + 1); assert.equal((await profileList(selected)).filter(p => p.record.name === 'Synthetic ' + mode).length, 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('strata-studio-pending')), null); await section('Profiles');
  });
  await check('stopped/reopened real disk repository retains exact profiles after browser reload', async () => {
    const f = fixtures.get(selected), before = await profileList(selected), registry = await readFile(path.join(f.state, 'registry.json'), 'utf8');
    await endpoints.get(selected).close(); await f.reopen(); endpoints.set(selected, await endpoint(selected));
    await page.reload(); await profilesLoaded(); const after = await profileList(selected); assert.deepEqual(after, before);
    assert.equal(await readFile(path.join(f.state, 'registry.json'), 'utf8'), registry);
    assert(await page.getByRole('button', { name: 'Retained after stale CAS', exact: true }).isVisible());
  });
  await check('actual repository rule validation blocks the compiled tuple without dispatching a save', async () => {
    const f = fixtures.get('profiles-b'), input = { previous: f.contract.ref, record: { ...f.importInput.record, revision: 2,
      rules: [{ id: 'LanguageRule', field: 'language', allowed: ['python'], rationale: 'Synthetic strict contract gate.' }] } };
    await f.repository.review('repository.contract.import', input, f.context('release-manager'), { key: 'strict-contract-review' });
    await f.repository.execute('repository.contract.import', input, f.context('author-a'), { key: 'strict-contract-import' });
    await selectRepository('profiles-b'); const before = operations.length;
    await page.getByRole('button', { name: 'New profile', exact: true }).click(); await page.getByLabel('Profile name', { exact: true }).fill('Synthetic rule refusal');
    await page.getByText(/Repository valid: false/).waitFor();
    assert((await page.locator('#profiles').innerText()).includes('python')); assert(await page.getByRole('button', { name: 'Save new profile', exact: true }).isDisabled());
    assert.equal(operations.length, before); await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await selectRepository('profiles-a');
  });
  await check('actual unconfigured backend refuses Profiles and sends no mutation', async () => {
    const before = operations.length; await endpoints.get(selected).close(); endpoints.set(selected, await endpoint(selected, false));
    await page.reload(); await profilesLoaded(); assert((await page.locator('main').innerText()).includes('no configured Local Profiles/Build adapter'));
    assert(await page.getByRole('button', { name: 'New profile', exact: true }).isDisabled()); assert.equal(operations.length, before);
    await endpoints.get(selected).close(); endpoints.set(selected, await endpoint(selected)); await page.reload(); await profilesLoaded();
  });
  await check('real shell and exact profile pins fit 320px with visible keyboard focus', async () => {
    await page.setViewportSize({ width: 320, height: 850 }); assert.equal(page.viewportSize().width, 320);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'New profile', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByLabel('Profile name', { exact: true }).fill('Synthetic mobile draft');
    assert(await page.getByLabel('Profile name', { exact: true }).evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== 'none'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, '02-real-profiles-320.png'), fullPage: true });
    await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  });
  await check('zero outside-origin traffic, page errors, secret profile fields or unexpected console errors', async () => {
    assert.deepEqual(outside, []); assert.deepEqual(errors, []);
    // The real CAS test asserts STALE_GENERATION/409, session expiry injects
    // 401, unconfigured support returns 422, and one committed reply is lost.
    const unexpected = consoleErrors.filter(message => !/Failed to load resource:.*(401|409|422)|net::ERR_FAILED/.test(message)); assert.deepEqual(unexpected, []);
    assert(operations.every(o => o.repository === o.repository_header));
    const storage = await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage, url: location.href }));
    for (const marker of ['Delayed old-repository marker', 'Synthetic mobile draft', 'synthetic-owner-csrf', 'synthetic-actor-csrf']) assert(!storage.includes(marker));
  });
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(await page.locator('main').innerText()); throw error;
} finally {
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checks, operations, requests, errors, consoleErrors, outside,
    fixtures: Object.fromEntries([...fixtures].map(([id, f]) => [id, { state: f.state }])),
    scope: 'Real Studio and disk Profiles APIs; namespace sessions/chooser and response faults synthetic; no provider or installed-host qualification.' }, null, 2));
  await context.close(); await browser.close(); for (const endpoint of endpoints.values()) await endpoint.close(); for (const f of fixtures.values()) await f.repository.close();
}
console.log(JSON.stringify({ passed: checks.length, output }));
