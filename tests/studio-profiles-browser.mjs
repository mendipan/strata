// Focused real-browser checks for the S4 Profiles module (explorer/profiles.js).
//
// Environment:
//   STRATA_EXPLORER_PLAYWRIGHT_MODULE — supplied playwright-core index.mjs (channel msedge, headless)
//   STRATA_PROFILES_UI_OUTPUT         — directory for screenshots and QA receipts (outside the workspace)
//
// The suite serves ONLY the new fixture page, the new module and the allowed
// existing public explorer files on an ephemeral 127.0...1 port. All
// non-loopback requests are intercepted and aborted. No existing browser
// profile is touched: a fresh disposable headless Microsoft Edge context is
// launched. No live API, provider or Studio host is contacted.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProfilesFixture} from './fixtures/studio-profiles.mjs';

const WORKSPACE = process.cwd();
const OUTPUT_DIR = process.env.STRATA_PROFILES_UI_OUTPUT;
const PLAYWRIGHT_MODULE = process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE;
if (!OUTPUT_DIR || !PLAYWRIGHT_MODULE) {
  console.error('Required environment STRATA_PROFILES_UI_OUTPUT and STRATA_EXPLORER_PLAYWRIGHT_MODULE are not set.');
  process.exit(2);
}
fs.mkdirSync(OUTPUT_DIR, {recursive: true});

const fixture = createProfilesFixture();
const checks = [];
const consoleErrors = [];
const expectedResourceErrors = [];
const pageErrors = [];
const requests = [];
let abortedExternal = 0;
let failedApiResponses = 0;

const check = async (id, run) => {
  try {
    const detail = await run();
    checks.push({id, ok: true, detail: detail ?? ''});
    console.log('PASS ' + id + (detail ? ' — ' + detail : ''));
  } catch (error) {
    checks.push({id, ok: false, detail: error.message});
    console.log('FAIL ' + id + ' — ' + error.message);
  }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const MIME = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html'};
const STATIC_FILES = {
  '/': path.join(WORKSPACE, 'tests', 'fixtures', 'studio-profiles.html'),
  '/explorer/profiles.js': path.join(WORKSPACE, 'explorer', 'profiles.js'),
  '/explorer/dom.js': path.join(WORKSPACE, 'explorer', 'dom.js'),
  '/explorer/operation-recovery.js': path.join(WORKSPACE, 'explorer', 'operation-recovery.js'),
  '/explorer/style.css': path.join(WORKSPACE, 'explorer', 'style.css')
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const send = (status, type, body) => { response.writeHead(status, {'content-type': type, 'cache-control': 'no-store'}); response.end(body); };
  try {
    if (request.method === 'GET' && url.pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
    if (request.method === 'GET' && STATIC_FILES[url.pathname]) {
      const file = STATIC_FILES[url.pathname];
      return send(200, MIME[path.extname(file)] ?? 'text/plain', fs.readFileSync(file));
    }
    if (request.method === 'POST' && url.pathname === '/fixture-api') {
      const body = JSON.parse(await readBody(request));
      try {
        return send(200, 'application/json', JSON.stringify({data: await fixture.execute(body.command, body.input)}));
      } catch (error) {
        const status = error.status === 401 ? 401 : error.outcome_unknown === true ? 502 : 400;
        failedApiResponses += 1; // expected console "Failed to load resource" noise from injected failures
        return send(status, 'application/json', JSON.stringify({error: {code: error.code ?? 'OPERATION_UNKNOWN', message: error.message, outcome_unknown: error.outcome_unknown === true}}));
      }
    }
    if (request.method === 'POST' && url.pathname === '/fixture-control') {
      const body = JSON.parse(await readBody(request));
      return send(200, 'application/json', JSON.stringify({data: fixture.control(body.action, body.value)}));
    }
    send(404, 'text/plain', 'not found');
  } catch (error) {
    send(500, 'text/plain', 'fixture server error: ' + error.message);
  }
});
const readBody = request => new Promise((resolve, reject) => {
  let data = '';
  request.on('data', chunk => { data += chunk; });
  request.on('end', () => resolve(data));
  request.on('error', reject);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const isLoopback = hostname => ['127.0.0.1', 'localhost', '::1'].includes(hostname);

let browser, context, page;
try {
  const {chromium} = await import(pathToFileURL(PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({channel: 'msedge', headless: true});
} catch (error) {
  console.error('Edge launch is blocked in this environment: ' + error.message);
  server.close();
  process.exit(2);
}
context = await browser.newContext({viewport: {width: 1280, height: 900}});
await context.route('**/*', route => {
  const hostname = new URL(route.request().url()).hostname;
  if (new URL(route.request().url()).origin === ORIGIN) return route.continue();
  abortedExternal += 1;
  return route.abort();
});
context.on('request', request => requests.push({method: request.method(), path: new URL(request.url()).pathname + new URL(request.url()).search, hostname: new URL(request.url()).hostname}));

const gone = () => fixture.control('reset');

async function open(options = {}) {
  await gone();
  await page.goto(ORIGIN + '/');
  await page.evaluate(opts => window.__fixture.mount(opts), options);
}
const bodyText = () => page.evaluate(() => document.body.innerText);
const waitForText = (text, timeout = 12000) =>
  page.waitForFunction(value => document.body.innerText.includes(value), text, {timeout, polling: 150}).catch(() => {
    throw new Error('timeout waiting for text: ' + text);
  });
const waitForAbsent = async (text, timeout = 4000) => {
  await page.waitForFunction(value => !document.body.innerText.includes(value), text, {timeout, polling: 150}).catch(() => {});
  assert(!(await bodyText()).includes(text), 'unexpected text still present: ' + text);
};
const button = name => page.getByRole('button', {name});
const waitEnabled = async (namePattern, timeout = 12000) => {
  await page.waitForFunction(source => [...document.querySelectorAll('button')]
    .some(b => new RegExp(source).test(b.textContent) && !b.disabled), namePattern.source, {timeout, polling: 150}).catch(() => {
    throw new Error('timeout waiting for enabled button: ' + namePattern.source);
  });
};
const dispatchCount = command => fixture.stats().dispatches[command] ?? 0;
const screenshot = async name => { await page.evaluate(() => scrollTo(0, 0)); return page.screenshot({path: path.join(OUTPUT_DIR, name), fullPage: true}); };
// Walk the (page-sized) list until every head is loaded, so row-level checks
// do not depend on which two records happened to sort onto page one.
const loadFullList = async () => {
  await waitForText('Saved profiles');
  for (let i = 0; i < 6; i++) {
    const more = page.getByRole('button', {name: 'Load more profiles'});
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click();
    await page.waitForTimeout(120);
  }
};

page = await context.newPage();
page.on('console', message => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Intentionally injected 4xx/5xx fixture responses make the browser log a
  // resource error line each (the message carries no URL). Every non-loopback
  // request is route-blocked, so these can only be our own fixture calls.
  if (text.startsWith('Failed to load resource')) expectedResourceErrors.push(text);
  else consoleErrors.push(text);
});
page.on('pageerror', error => pageErrors.push(error.message));

await check('unwired-default', async () => {
  await open({unwired: true});
  await waitForText('Profiles are not wired in this build');
  await waitForText('No profile API adapter is connected');
  assert(await button('New profile').isDisabled(), 'New profile must be disabled when unwired');
  const text = await bodyText();
  assert(!text.includes('Collection site build') && !text.includes('Old contract draft'), 'unwired page must not list any saved profiles');
  assert(await page.evaluate(() => document.querySelector('#profiles table') === null), 'unwired page must render no profile table');
  const reads = Object.values(fixture.stats().dispatches).reduce((a, b) => a + b, 0);
  assert(reads === 0, 'unwired page must dispatch nothing, dispatched ' + reads);
  await screenshot('01-unwired.png');
  return 'banner + disabled New profile + zero dispatches';
});

await check('context-rules-statuses', async () => {
  await open({repository: 'demo-repo'});
  await waitForText('Repository contract context');
  await waitForText('revision 2');
  await waitForText('Repository authoring head — not checked against a Release.');
  await waitForText('language rule “language-reviewed” allows: javascript');
  await waitForText('Only reviewed collection-host output is admitted.');
  await waitForText('No recorded restriction for framework. Unspecified is not a claim that every framework is implemented.');
  const preferences = page.locator('details', {hasText: 'Advisory preferences'});
  assert(await preferences.count() >= 1, 'advisory preferences block missing');
  assert(!(await preferences.first().getAttribute('open')), 'advisory preferences must be collapsed by default');
  await loadFullList();
  for (const status of ['Valid', 'Needs update', 'Unsupported by current tooling']) await waitForText(status);
  await waitForText('Old contract draft');
  await waitForText('Legacy adapter pin');
  await screenshot('02-context-rules.png');
  return 'contract pin rev2, rule provenance, collapsed preferences, three truthful statuses';
});

await check('pagination-truthful', async () => {
  await open({repository: 'demo-repo'});
  await waitForText('Saved profiles');
  const before = dispatchCount('profile.list');
  assert(await button('Load more profiles').isEnabled(), 'cursor must offer Load more');
  await button('Load more profiles').click();
  await waitForText('Old contract draft');
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === 'Load more profiles'), null, {timeout: 10000});
  assert(dispatchCount('profile.list') === before + 1, 'exactly one additional list page read');
  return '3 seeded heads over two pages, cursor exhausted';
});

await check('keyboard-new-save', async () => {
  await open({repository: 'demo-repo'});
  await waitEnabled(/New profile/);
  await button('New profile').focus();
  await page.keyboard.press('Enter');                 // open editor via keyboard
  await waitForText('A new logical profile: revision 1');
  await page.keyboard.press('KeyA');                  // stray key before typing: still empty
  await page.keyboard.press('Backspace');
  await page.locator('#profile-name').pressSequentially('Nightly collection export');
  await waitForText('Validated:');
  await waitForText('javascript (fixed)');
  await waitForText('none (fixed)');
  await waitForText('node (fixed)');
  await waitForText('no configurable options');
  await waitEnabled(/^Save new profile/);
  // Tab from the name input to the submit button, then activate with Enter.
  for (let i = 0; i < 8; i++) {
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    if (/^Save new profile/.test(focused)) break;
    await page.keyboard.press('Tab');
  }
  const focusedLabel = await page.evaluate(() => document.activeElement?.textContent ?? '');
  assert(/^Save new profile/.test(focusedLabel), 'keyboard focus did not reach Save, at: ' + focusedLabel);
  await page.keyboard.press('Enter');
  await waitForText('Saved “Nightly collection export” as immutable revision 1');
  const stats = fixture.stats();
  assert(stats.dispatches['profile.create'] === 1, 'exactly one create dispatched');
  const created = stats.created.at(-1);
  assert(created.expected_normalized_sha256.match(/^[a-f0-9]{64}$/), 'create must send expected_normalized_sha256');
  const record = stats.heads.find(h => h.name === 'Nightly collection export');
  assert(record && record.revision === 1 && record.repositoryId === 'demo-repo', 'server-stored head must be revision 1 in demo-repo');
  await screenshot('03-saved.png');
  return 'keyboard New/name/Tab/Enter save, exact digest CAS accepted, revision 1';
});

await check('host-target-destinations-honesty', async () => {
  // Editor from the previous check already proved save works; this check pins
  // the honest operational wording the saved profile carried with it.
  await open({repository: 'demo-repo'});
  await waitEnabled(/New profile/);
  await button('New profile').click();
  await waitForText('Stack choices');
  await page.locator('#profile-name').pressSequentially('Readiness prose check');
  await waitForText('Validated:');
  await waitForText('Build — Studio host: Runtime “node”, major version 22 or later');
  await waitForText('Verify — Studio host: Runtime “node”');
  await waitForText('Run — Application target: Runtime “node”');
  await waitForText('not this browser');
  await waitForText('Current host readiness');
  await waitForText('Not evaluated in this page');
  await waitForText('Cloudflare Workers is a future destination and is not available in this version');
  await waitForText('Stay in Settings');
  await waitForText('Not supported (run_application is false in the materializer options)');
  await waitForText('Not supported (serve_application is false in the materializer options)');
  await waitForText('Not checked — this draft is not validated against a selected Release');
  await waitEnabled(/^Save new profile/);
  await button('Save new profile').click();
  await waitForText('as immutable revision 1');
  const secretInputs = await page.evaluate(() =>
    document.querySelectorAll('input[type=password],input[name*=secret i],input[name*=token i],input[name*=credential i],input[name*=password i]').length);
  assert(secretInputs === 0, 'no credential/token/password inputs may exist, found ' + secretInputs);
  await screenshot('04-editor-honesty.png');
  return 'Node>=22 host/target split, Worker future, Settings separation, false/false, save allowed while readiness unevaluated';
});

await check('reload-edit-immutable-revision', async () => {
  await open({repository: 'demo-repo'});
  await loadFullList();
  await waitForText('Collection site build');
  const demoHead = fixture.stats().heads.find(h => h.id === 'build-demosite');
  const rev1Digest = fixture.recordDigest(demoHead.ref);
  await button('Collection site build').click();
  await waitForText('Saved profile: Collection site build');
  await waitForText('None (first revision)');
  await button('Back to list').click();
  const listBefore = dispatchCount('profile.list');
  await button('Reload list').click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Reload list' && !b.disabled), null, {timeout: 10000});
  assert(dispatchCount('profile.list') > listBefore, 'Reload list must re-read the repository');
  await loadFullList();
  await button('Collection site build').click();
  await waitForText('Saved profile: Collection site build');
  await button('Edit (new revision)').click();
  await waitForText('Revise “Collection site build”');
  await page.locator('details summary', {hasText: 'Advanced: exact pins, digests and the draft record'}).click();
  await waitForText('Previous revision (CAS pin)');
  await waitForText(demoHead.ref);
  await page.locator('#profile-name').fill('Collection site build v2');
  await waitForText('Validated:');
  await waitEnabled(/^Save revision/);
  await button(/Save revision/).click();
  await waitForText('as immutable revision 2');
  const stats = fixture.stats();
  assert(stats.dispatches['profile.revise'] === 1, 'exactly one revise dispatched');
  const head = stats.heads.find(h => h.id === 'build-demosite');
  assert(head.revision === 2, 'head must now be revision 2');
  assert(fixture.recordDigest(demoHead.ref) === rev1Digest, 'revision 1 bytes must stay immutable after revise');
  assert(!rev1Digest || head.ref !== demoHead.ref, 'revision 2 must be a new exact ref');
  await screenshot('05-revised.png');
  return 'reload, edit, CAS revise to revision 2, revision 1 digest unchanged';
});

await check('name-feedback-no-dispatch', async () => {
  await open({repository: 'demo-repo'});
  await button('New profile').click();
  await waitForText('Stack choices');
  await waitForText('Name is required');
  let before = dispatchCount('profile.validate');
  await button(/Save new profile/).click().catch(() => {});
  assert(dispatchCount('profile.validate') === before, 'empty-name save must not dispatch validation');
  await waitForText('Name is required');
  await page.locator('#profile-name').fill('x'.repeat(81));
  await waitForText('limited to 80 characters');
  assert(dispatchCount('profile.validate') === before, 'over-length name must not dispatch validation');
  await page.locator('#profile-name').fill('Draft keeper');
  await waitForText('Validated:');
  await waitForText('4 of 4 checks satisfied');
  await screenshot('06-name-feedback.png');
  return 'required + length gates with zero server validates, then clean 4/4 report';
});

await check('delayed-validation-stale-drop', async () => {
  await open({repository: 'demo-repo'});
  fixture.control('set-delay', {command: 'profile.validate', ms: 700});
  await button('New profile').click();
  await waitForText('Stack choices');
  const before = dispatchCount('profile.validate');
  await page.locator('#profile-name').pressSequentially('Alpha');
  await page.waitForTimeout(450);                          // let the Alpha validation dispatch and hang
  await page.locator('#profile-name').pressSequentially(' Beta');
  await waitForText('Validated:');
  const text = await bodyText();
  assert(text.includes('“Alpha Beta”'), 'report must show the edited name Alpha Beta');
  assert(!text.includes('Normalized draft: “Alpha”'), 'stale Alpha-only report must be dropped');
  assert(dispatchCount('profile.validate') === before + 2, 'exactly two name validations dispatched (Alpha, Alpha Beta), got ' + (dispatchCount('profile.validate') - before));
  assert(await page.evaluate(() => document.activeElement?.id) === 'profile-name', 'focus must stay in the name input across validation');
  fixture.control('clear-behaviors');
  return 'late Alpha report dropped, Alpha Beta applied, focus retained';
});

await check('missing-contract-handoff', async () => {
  await open({repository: 'no-contract-repo'});
  await waitForText('No build compatibility contract');
  await waitForText('repository.contract.import');
  await waitForText('cannot create, assume or bypass that review');
  await waitForText('No contract was silently created for you');
  assert(await button('New profile').isDisabled(), 'New profile must be disabled without a contract');
  assert(dispatchCount('profile.create') === 0, 'no writes may be attempted');
  await screenshot('07-missing-contract.png');
  return 'honest authoring handoff, no silent contract creation';
});

await check('strict-rules-block-save', async () => {
  await open({repository: 'strict-repo'});
  await waitForText('language rule “python-only” allows: python');
  await button('New profile').click();
  await page.locator('#profile-name').pressSequentially('Try javascript here');
  await waitForText('Repository — language (invalid, BUILD_CHOICE_FORBIDDEN)');
  await waitForText('Repository policy: only the Python service language');
  assert(await button(/Save new profile/).isDisabled(), 'Save must be disabled on hard-rule violation');
  assert(dispatchCount('profile.create') === 0, 'no create may be dispatched');
  return 'repository rule (allowed: python) blocks the fixed javascript tuple with field-level summary';
});

await check('open-repo-unspecified-honesty', async () => {
  await open({repository: 'open-repo'});
  await waitForText('No recorded restriction for language. Unspecified is not a claim that every language is implemented.');
  await button('New profile').click();
  await page.locator('#profile-name').pressSequentially('Open choice draft');
  await waitForText('Validated:');
  await waitForText('no configurable options');
  await waitEnabled(/^Save new profile/);
  assert(dispatchCount('profile.create') === 0, 'this check saves nothing');
  return 'unspecified stays honest, fixed tuple still the only compiled choice, save permitted';
});

await check('old-contract-needs-update', async () => {
  await open({repository: 'demo-repo'});
  await loadFullList();
  await waitForText('Old contract draft');
  await button('Old contract draft').click();
  await waitForText('Saved profile: Old contract draft');
  await waitForText('Repository — contract_ref (invalid, BUILD_CONTRACT_PIN_MISMATCH)');
  const stats = fixture.stats();
  const old = stats.heads.find(h => h.id === 'build-oldpin');
  const oldDigest = fixture.recordDigest(old.ref);
  const text = await bodyText();
  assert(text.includes(old.ref), 'detail must show the old exact ref');
  await button('Edit (new revision)').click();
  await waitForText('Explicit adoption: the saved revision pinned contract repository-compatibility@');
  await waitForText('this revision adopts the current contract');
  const currentHead = stats.contractHead;
  assert((await bodyText()).includes(currentHead), 'editor advanced panel must pin the current contract head');
  assert(fixture.recordDigest(old.ref) === oldDigest, 'old pin must stay immutable');
  await screenshot('08-old-contract.png');
  return 'Needs update status, old pin immutable, edit offers explicit adoption only';
});

await check('stale-head-refusal-reload', async () => {
  await open({repository: 'demo-repo'});
  await loadFullList();
  await waitForText('Collection site build');
  await button('Collection site build').click();
  await button('Edit (new revision)').click();
  await page.locator('#profile-name').fill('Concurrent edit attempt');
  await waitForText('Validated:');
  await waitEnabled(/^Save revision/);
  fixture.control('advance-profile-head', 'build-demosite');
  await button(/Save revision/).click();
  await waitForText('changed while you were editing');
  assert(await page.locator('#profile-name').inputValue() === 'Concurrent edit attempt', 'input must be preserved on stale refusal');
  assert(await button(/Save revision/).isDisabled(), 'Save must be disabled after stale refusal');
  await button('Reload latest revision').click();
  await waitForText('Reloaded revision 2');
  assert(await page.locator('#profile-name').inputValue() === 'Concurrent edit attempt', 'edited name must survive reload of latest');
  await waitForText('Validated:');                      // wait until the reloaded draft's review digest is current
  await waitEnabled(/^Save revision/);
  await button(/Save revision/).click();
  await waitForText('as immutable revision 3');
  const stats = fixture.stats();
  assert(stats.dispatches['profile.revise'] === 2, 'one refused revise plus one accepted revise');
  const head = stats.heads.find(h => h.id === 'build-demosite');
  assert(head.revision === 3, 'head must be revision 3 after reload-and-save');
  return 'STALE_REVISION refusal retains input; explicit reload latest; revision 3 accepted';
});

await check('repository-mismatch-rejection', async () => {
  await open({repository: 'demo-repo'});
  await waitForText('Collection site build');
  const rowsBefore = (await bodyText()).match(/revision 1/g)?.length ?? 0;
  fixture.control('corrupt-repository', true);
  await button('Reload list').click();
  await waitForText('Ignored profiles from another repository (foreign-repo)');
  const text = await bodyText();
  assert(text.includes('Collection site build'), 'previously loaded truthful list must be kept');
  assert(!text.includes('foreign-repo</'), 'no foreign record may render');
  assert((text.match(/revision 1/g)?.length ?? 0) >= rowsBefore, 'list must not shrink to foreign data');
  fixture.control('corrupt-repository', false);
  return 'cross-repository list rejected, previous truthful list retained';
});

await check('session-expiry-retention-recovery', async () => {
  await open({repository: 'demo-repo'});
  await button('New profile').click();
  await page.locator('#profile-name').pressSequentially('Session kept draft');
  await waitForText('Validated:');
  fixture.control('expire-session');
  await button('Save new profile').click();
  await waitForText('Your session expired while saving');
  await waitForText('This page shows no credentials form');
  assert(await page.locator('#profile-name').inputValue() === 'Session kept draft', 'input must be preserved on session expiry');
  assert(await button(/Save new profile/).isDisabled(), 'mutations must be blocked until refreshed');
  await screenshot('09-session-expired.png');
  await button('Recover session and continue').click();
  await waitForAbsent('Your session expired while saving');
  await waitEnabled(/^Save new profile/);
  await button('Save new profile').click();
  await waitForText('Saved “Session kept draft” as immutable revision 1');
  const stats = fixture.stats();
  assert(stats.dispatches['profile.create'] === 2, 'one expired attempt then one fresh success');
  return '401 keeps draft, shell recovery unblocks, second save succeeds (no replay of the first)';
});

await check('unknown-save-no-resubmit', async () => {
  await open({repository: 'demo-repo'});
  await button('New profile').click();
  await page.locator('#profile-name').pressSequentially('Unknown outcome draft');
  await waitForText('Validated:');
  fixture.control('set-failure', {command: 'profile.create', code: 'OPERATION_UNKNOWN',
    message: 'Synthetic unknown outcome: Studio did not return a confirmed result for this save. Inspect the operation in Review before another save.',
    outcome_unknown: true, times: 1});
  await button('Save new profile').click();
  await waitForText('The save outcome is unknown');
  await waitForText('No further saves are allowed from this page');
  assert(await button(/Save new profile/).isDisabled(), 'Save must be disabled after an unknown outcome');
  await page.locator('#profile-name').press('Enter');   // form-submit bypass attempt
  await page.waitForTimeout(400);
  assert(dispatchCount('profile.create') === 1, 'no second mutation may be dispatched, got ' + dispatchCount('profile.create'));
  assert(fixture.stats().heads.every(h => h.name !== 'Unknown outcome draft'), 'unknown save must not be silently retried');
  await screenshot('10-unknown-outcome.png');
  fixture.control('clear-behaviors');
  return 'single dispatch, blocked button and blocked Enter path, no replay';
});

await check('dirty-switch-discard-late-response', async () => {
  await open({repository: 'demo-repo'});
  fixture.control('set-delay', {command: 'profile.validate', ms: 600});
  await button('New profile').click();
  await waitForText('Stack choices');
  await page.locator('#profile-name').pressSequentially('Cross repo draft');
  await page.selectOption('#harness-repository', 'strict-repo');
  await waitForText('Leave with an unsaved draft?');
  await button('Keep editing (cancel)').click();
  await waitForAbsent('Leave with an unsaved draft?');
  assert(await page.locator('#profile-name').inputValue() === 'Cross repo draft', 'cancel must keep the draft mounted');
  assert(await page.evaluate(() => document.getElementById('harness-repository').value) === 'demo-repo', 'cancel must revert the repository choice');
  await page.selectOption('#harness-repository', 'strict-repo');
  await waitForText('Leave with an unsaved draft?');
  await button('Discard draft and leave').click();
  await waitForText('language rule “python-only” allows: python');
  await page.waitForTimeout(900);                      // let the late validation response land
  const text = await bodyText();
  assert(!text.includes('Cross repo draft'), 'discarded draft must not leak into the new repository view');
  assert(text.includes('strict-repo'), 'new view must show the strict repository context');
  assert(dispatchCount('profile.create') === 0, 'no old-repository draft may be saved into the new one');
  fixture.control('clear-behaviors');
  return 'cancel keeps draft, discard switches cleanly, late response writes nothing';
});

// Narrow 320px layout on a fresh page in the same disposable context.
const narrow = await context.newPage();
await narrow.setViewportSize({width: 320, height: 800});
narrow.on('console', message => { if (message.type() === 'error') consoleErrors.push('[narrow] ' + message.text()); });
narrow.on('pageerror', error => pageErrors.push('[narrow] ' + error.message));
await check('narrow-320-overflow-focus', async () => {
  await narrow.goto(ORIGIN + '/');
  assert(await narrow.evaluate(() => innerWidth) === 320, 'the actual narrow viewport must be 320px');
  await narrow.evaluate(() => window.__fixture.mount({repository: 'demo-repo'}));
  await narrow.waitForFunction(() => document.body.innerText.includes('Collection site build'), null, {timeout: 12000});
  await narrow.getByRole('button', {name: 'New profile'}).click();
  await narrow.locator('#profile-name').pressSequentially('Narrow draft');
  await narrow.waitForFunction(() => document.body.innerText.includes('Validated:'), null, {timeout: 12000});
  const overflow = await narrow.evaluate(() => ({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth}));
  assert(overflow.scroll <= overflow.client, 'horizontal overflow at 320px: scrollWidth ' + overflow.scroll + ' > clientWidth ' + overflow.client);
  await narrow.getByRole('button', {name: 'New profile'}).focus().catch(() => {});
  for (let i = 0; i < 8; i++) {
    const focused = await narrow.evaluate(() => document.activeElement?.textContent ?? '');
    if (/Save new profile/.test(focused)) break;
    await narrow.keyboard.press('Tab');
  }
  const rect = await narrow.evaluate(() => {
    const r = document.activeElement?.getBoundingClientRect();
    return r ? {left: r.left, right: r.right, width: innerWidth} : null;
  });
  assert(rect && rect.left >= 0 && rect.right <= rect.width + 1, 'focused control must stay inside the 320px viewport: ' + JSON.stringify(rect));
  await narrow.screenshot({path: path.join(OUTPUT_DIR, '11-narrow-320.png'), fullPage: true});
  await narrow.close();
  return 'no horizontal overflow at 320px, keyboard focus visible in viewport';
});

await check('review-first-viewport-and-no-null-text', async () => {
  await open({repository: 'demo-repo'});
  await page.evaluate(() => scrollTo(0, 0));
  const rect = await button('New profile').boundingBox();
  assert(rect && rect.y >= 0 && rect.y + rect.height <= 900, 'New profile belongs in the first viewport');
  const stray = await page.evaluate(() => { const w = document.createTreeWalker(document.getElementById('profiles'), NodeFilter.SHOW_TEXT); let n, count=0; while(n=w.nextNode()) if(n.textContent.trim()==='null') count++; return count; });
  assert(stray===0, 'empty panes must not render literal null');
  assert((await bodyText()).includes('not checked against a Release'), 'status must preserve target uncertainty');
  await screenshot('20-reviewed-desktop.png');
});
await check('review-escape-cancels-dirty-switch', async () => {
  await open({repository: 'demo-repo'});
  await button('New profile').click(); await page.locator('#profile-name').fill('Escape preserved draft');
  await page.evaluate(() => { window.escapeOutcome='pending'; void window.__fixture.switchRepository('open-repo').then(r=>window.escapeOutcome=r); });
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.escapeOutcome==='cancelled', null, {timeout:2000});
  assert(await page.locator('#profile-name').inputValue()==='Escape preserved draft', 'Escape preserves draft and cancels navigation');
});
await check('review-unknown-session-error-never-replays', async () => {
  await open({repository:'demo-repo'}); await button('New profile').click();
  await page.locator('#profile-name').fill('Uncertain expired save'); await waitForText('Validated:');
  fixture.control('set-failure',{command:'profile.create',code:'OWNER_SESSION_REQUIRED',status:401,outcome_unknown:true,message:'Synthetic uncertain session response'});
  await waitEnabled(/^Save new profile/); await button(/Save new profile/).click();
  await waitForText('save outcome is unknown');
  assert(await button(/Save new profile/).isDisabled(), 'unknown takes precedence over session recovery');
  assert(await button('Recover session and continue').count()===0, 'session recovery cannot clear uncertainty');
  const calls=dispatchCount('profile.create'); await button(/Save new profile/).evaluate(b=>b.click());
  await new Promise(r=>setTimeout(r,350)); assert(dispatchCount('profile.create')===calls, 'no second save');
});

await check("review-mismatched-save-confirmation-is-unknown", async () => {
  await open({repository:"demo-repo"}); await button("New profile").click();
  await page.locator("#profile-name").fill("Foreign confirmation guard"); await waitForText("Validated:");
  fixture.control("corrupt-repository",true); await waitEnabled(/^Save new profile/); await button(/Save new profile/).click();
  await waitForText("save outcome is unknown"); const calls=dispatchCount("profile.create");
  assert(calls===1 && await button(/Save new profile/).isDisabled(),"one admitted mutation with no trusted confirmation must block resubmission");
  assert(fixture.stats().heads.some(h=>h.name==="Foreign confirmation guard"),"the fixture committed a save, so the UI must not claim rollback");
  await button(/Save new profile/).evaluate(b=>b.click()); await new Promise(r=>setTimeout(r,300));
  assert(dispatchCount("profile.create")===calls,"mismatched confirmation never authorizes a second save");
});

await check('clean-run-console-network-storage', async () => {
  const nonLoopback = requests.filter(r => !isLoopback(r.hostname));
  assert(abortedExternal === 0 && nonLoopback.length === 0, 'external traffic attempted: aborted=' + abortedExternal + ' seen=' + nonLoopback.length);
  assert(consoleErrors.length === 0, 'console errors: ' + JSON.stringify(consoleErrors));
  assert(pageErrors.length === 0, 'page errors: ' + JSON.stringify(pageErrors));
  assert(expectedResourceErrors.length <= failedApiResponses, 'more resource errors (' + expectedResourceErrors.length + ') than intentional failed fixture responses (' + failedApiResponses + ')');
  const storage = await page.evaluate(() => ({local: localStorage.length, session: sessionStorage.length}));
  assert(storage.local === 0 && storage.session === 0, 'module must not write web storage: ' + JSON.stringify(storage));
  const paths = [...new Set(requests.map(r => r.path.split('?')[0]))];
  return 'all ' + requests.length + ' requests loopback (' + paths.join(', ') + '), zero unexpected console/page errors (' + expectedResourceErrors.length + ' expected from injected failures), storage empty';
});

await browser.close();
server.close();

const failed = checks.filter(c => !c.ok);
fs.writeFileSync(path.join(OUTPUT_DIR, 'checks.json'), JSON.stringify({origin: ORIGIN, total: checks.length, passed: checks.length - failed.length, checks}, null, 2));
fs.writeFileSync(path.join(OUTPUT_DIR, 'network-summary.json'), JSON.stringify({
  totalRequests: requests.length,
  nonLoopback: requests.filter(r => !isLoopback(r.hostname)).length,
  externalAttemptedAndBlocked: abortedExternal,
  byPath: requests.reduce((acc, r) => { acc[r.path] = (acc[r.path] ?? 0) + 1; return acc; }, {})
}, null, 2));
fs.writeFileSync(path.join(OUTPUT_DIR, 'console.json'), JSON.stringify({consoleErrors, expectedResourceErrorsFromInjectedFailures: expectedResourceErrors, pageErrors}, null, 2));
console.log('');
console.log('Profiles S4 browser suite: ' + (checks.length - failed.length) + '/' + checks.length + ' checks passed. Receipts in STRATA_PROFILES_UI_OUTPUT.');
process.exit(failed.length ? 1 : 0);
