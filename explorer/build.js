import {el, fields, pill} from './dom.js';
import {canonicalDigest} from './draft-model.js';
import {pendingOperation, sessionRequired, unconfirmedOperation} from './operation-recovery.js';

const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const sameSelection = (a, b) => a?.release_ref === b?.release_ref && a?.profile_ref === b?.profile_ref
  && a?.destination?.kind === 'local' && b?.destination?.kind === 'local' && a.destination.slot_id === b.destination.slot_id;
const phases = ['accepted','materializing','exporting','verifying_bytes','checking','completed','failed','interrupted','output_incomplete'];
const problem = message => Object.assign(new Error(message), {code:'BUILD_RESPONSE_MISMATCH'});
const replace = (node, ...children) => node.replaceChildren(...children.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false));
const short = ref => ref.length > 28 ? ref.slice(0, 24) + '…' : ref;

/** Read/prepare is nonexecuting. Only the shell's authenticated start seam admits effects. */
export function buildView(ctx) {
  const api = ctx.buildApi;
  const abort = new AbortController();
  let disposed = false, serial = 0, busy = false, context = null, prepared = null, run = null;
  let session = false, unknown = false, runUnknown = false, message = '', errorCode = '', inventory = null;
  let profileCursor = null, profilePages = 0;
  const profileCursors = new Set();
  const releases = el('select', {id:'build-release', onchange:invalidate});
  const profiles = el('select', {id:'build-profile', onchange:invalidate});
  const destination = el('select', {id:'build-destination', onchange:invalidate},
    el('option', {value:'local'}, 'Local (Studio host)'),
    el('option', {value:'cloudflare-worker'}, 'Cloudflare Worker — planned, unavailable'));
  const preview = el('button', {onclick:prepare}, 'Prepare build');
  const start = el('button', {onclick:startBuild}, 'Build on Studio host');
  const reload = el('button', {onclick:load}, 'Reload choices');
  const moreProfiles = el('button', {onclick:loadMoreProfiles}, 'Load more profiles');
  const profileNotice = el('p', {class:'muted','aria-live':'polite'});
  const recover = el('button', {onclick:recoverSession}, 'Refresh Studio session');
  const notice = el('div', {role:'status','aria-live':'polite'});
  const readiness = el('div');
  const planBox = el('div');
  const runBox = el('div');
  const root = el('div', {class:'page profiles-page build-page'},
    el('div', {class:'heading'}, el('div', {}, el('h1', {tabindex:'-1'}, 'Build'),
      el('p', {class:'purpose'}, 'Materialize an approved flattened Release with an exact saved Profile.')),
      el('div', {class:'heading-actions'}, reload)),
    ctx.synthetic ? el('p', {class:'notice'}, 'Synthetic local workflow. Disposable repository and mocked custody; no installed host or provider qualification.') : null,
    el('p', {}, 'Local means the Studio host, not this browser computer. Output uses a controlled host directory separate from source repositories. Build does not run or serve an application.'),
    notice,
    el('section', {class:'card'}, el('h2', {}, 'Choose build inputs'),
      el('label', {for:'build-release'}, 'Approved Release'), releases,
      el('label', {for:'build-profile'}, 'Saved Profile revision'), profiles,
      profileNotice, moreProfiles,
      el('label', {for:'build-destination'}, 'Destination'), destination,
      el('p', {class:'muted'}, 'Release choices come from verified publication history. Profile validity is repository-specific; Prepare checks its support for the selected Release.'),
      el('div', {class:'heading-actions'}, preview, start)), readiness, planBox, runBox,
    el('p', {class:'muted'}, 'Cloudflare Worker is planned and unavailable. Connections belong in ', el('a', {href:ctx.href('settings')}, 'Settings'), '. Profiles contain no secrets.'));

  function check(ticket) {
    ctx.check?.();
    if (disposed || abort.signal.aborted || ticket !== undefined && ticket !== serial) throw new DOMException('Interrupted','AbortError');
  }
  function pending() { return (ctx.pendingOperation ?? pendingOperation)(); }
  function selection() {
    if (!context || destination.value !== 'local' || !releases.value || !profiles.value) return null;
    const host = context.destinations.find(d => d.kind === 'local')?.host;
    return host?.slot_id ? {release_ref:releases.value, profile_ref:profiles.value, destination:{kind:'local',slot_id:host.slot_id}} : null;
  }
  function invalidate() { ++serial; busy = false; prepared = null; replace(planBox); message = ''; errorCode = ''; render(); }
  function render() {
    const blocked = unknown || runUnknown || !!pending();
    const host = context?.destinations.find(d => d.kind === 'local')?.host;
    const available = !!selection() && host?.verify === true;
    for (const node of [releases, profiles, destination, reload]) node.disabled = busy;
    preview.disabled = !api || busy || session || blocked || !available;
    const startAllowed = api?.canStart?.() === true;
    start.disabled = !prepared || busy || session || blocked || !available || !startAllowed;
    reload.disabled = busy || !api || runUnknown;
    moreProfiles.hidden = !profileCursor;
    moreProfiles.disabled = busy || session || !api?.listProfiles || !context;
    replace(profileNotice, context ? (profiles.options.length > 1 ? 'Choose an exact saved Profile revision.' : 'No valid saved Profile is available in the loaded pages. Inspect readiness in ') : null,
      context && profiles.options.length <= 1 ? el('a', {href:ctx.href('profiles')}, 'Profiles') : null);
    recover.disabled = busy || !ctx.sessionRecovery;
    root.setAttribute('aria-busy', String(busy));
    const worker = destination.value === 'cloudflare-worker';
    replace(notice,
      !api ? el('p', {class:'notice'}, 'Build unavailable: this page has no authenticated Local Build adapter.') : null,
      api && context && !startAllowed ? el('p', {class:'notice'}, 'Build execution is unavailable under the current Studio action authority. Preparation does not grant execution permission.') : null,
      worker ? el('p', {class:'notice'}, 'Cloudflare Worker is planned only. No build or deployment is available for this destination.') : null,
      message ? el('p', {class:'notice'}, errorCode ? errorCode + ': ' + message : message) : null,
      session ? el('div', {class:'notice'}, el('p', {}, 'Studio session expired. Selections are retained; refresh the protected session and prepare again.'), recover) : null,
      blocked ? el('p', {class:'notice'}, 'An operation outcome is unknown or pending. Inspect the original receipt in ', el('a', {href:ctx.href('review')}, 'Review'), ' before another build. No request is replayed.') : null);
  }
  function error(error, ticket, mutation = false) {
    try { check(ticket); } catch { return; }
    if (error.name === 'AbortError') return;
    if (unconfirmedOperation(error) || mutation && error.code === 'BUILD_RESPONSE_MISMATCH') unknown = true;
    else if (sessionRequired(error)) session = true;
    prepared = null; replace(planBox);
    message = error.message; errorCode = error.code ?? ''; render();
  }
  function scoped(data) {
    if (data?.project_id !== ctx.state.project_id || data?.repository_id !== ctx.state.repository_id) throw problem('Build data belongs to a different repository. Reload the original repository.');
  }
  async function profilePage(page, ticket, cursor) {
    if (!Array.isArray(page?.profiles) || page.profiles.length > 100 || page.cursor !== null && !/^build-profile@[a-f0-9]{64}$/.test(page.cursor ?? '')
      || page.cursor && (page.cursor !== page.profiles.at(-1)?.ref || page.cursor === cursor || profileCursors.has(page.cursor) || profilePages >= 19)) throw problem('Saved Profile pagination is malformed or repeated. Reload choices.');
    const refs = new Set(cursor ? context.profiles.map(p => p.ref) : []);
    for (const p of page.profiles) {
      if (typeof p?.ref !== 'string' || refs.has(p.ref)) throw problem('Saved Profile pagination repeats an immutable revision. Reload choices.');
      refs.add(p.ref);
    }
    const valid = page.profiles.filter(p => !p.archived && p.record?.project_id === ctx.state.project_id
      && p.record?.repository_id === ctx.state.repository_id && p.report?.repository_valid === true
      && p.report.repository_id === ctx.state.repository_id && p.report.contract_ref === p.record.contract_ref
      && p.report.contract_sha256 === p.record.contract_sha256 && p.ref === 'build-profile@' + p.sha256 && hash(p.sha256));
    for (const p of valid) { if (await canonicalDigest(p.record) !== p.sha256) throw problem('A saved Profile differs from its immutable digest.'); check(ticket); }
    return valid;
  }
  const profileOptions = items => items.map(p => el('option', {value:p.ref}, p.record.name + ' · revision ' + p.record.revision));
  async function loadMoreProfiles() {
    if (moreProfiles.disabled || busy || !profileCursor || disposed) return;
    const cursor = profileCursor, ticket = ++serial;
    busy = true; prepared = null; replace(planBox); message = ''; errorCode = ''; render();
    try {
      const page = await api.listProfiles({limit:100,cursor},{signal:abort.signal}); check(ticket);
      const valid = await profilePage(page,ticket,cursor); check(ticket);
      context.profiles.push(...page.profiles); profiles.append(...profileOptions(valid));
      profileCursors.add(cursor); profileCursor = page.cursor; ++profilePages;
    } catch(e) {
      try { check(ticket); } catch { return; }
      if (['BUILD_RESPONSE_MISMATCH','INVALID_CURSOR','STALE_CURSOR'].includes(e.code)) profileCursor = null;
      error(e,ticket);
    } finally { if (!disposed && ticket === serial) {busy = false; if(run)showRun(); render();} }
  }
  async function load() {
    if (!api || busy || disposed) return render();
    const ticket = ++serial; busy = true; prepared = null; run = null; inventory = null;
    context = null; profileCursor = null; profilePages = 0; profileCursors.clear();
    replace(releases); replace(profiles); replace(readiness);
    replace(planBox); replace(runBox); message = ''; errorCode = ''; render();
    try {
      const pages = [], seen = new Set(); let cursor;
      do {
        const page = await api.context({limit:100,...(cursor ? {cursor} : {})},{signal:abort.signal}); check(ticket); scoped(page);
        if (page.format !== 'strata-local-build-context/1' || !Array.isArray(page.releases) || !Array.isArray(page.profiles)
          || !Array.isArray(page.excluded) || !Array.isArray(page.destinations) || page.run_application !== false || page.serve_application !== false) throw problem('Build context is malformed or claims unsupported application execution.');
        pages.push(page); cursor = page.cursor;
        if (cursor && (typeof cursor !== 'string' || seen.has(cursor) || pages.length >= 20)) throw problem('Build context pagination is unavailable. Narrow the repository history.');
        seen.add(cursor);
      } while (cursor);
      context = {...pages[0], releases:pages.flatMap(p => p.releases), excluded:pages.flatMap(p => p.excluded)};
      const approved = context.releases.filter(p => p.format === 'strata-build-publication-report/1' && p.state === 'approved'
        && p.historically_approved === true && p.release?.ref && hash(p.release.sha256));
      const page = await api.listProfiles({limit:100},{signal:abort.signal}); check(ticket);
      const valid = await profilePage(page,ticket); check(ticket);
      context.profiles = page.profiles; profileCursor = page.cursor; profilePages = 1;
      replace(releases, el('option', {value:''}, 'Choose an approved Release'), approved.map(p => el('option', {value:p.release.ref}, short(p.release.ref))));
      replace(profiles, el('option', {value:''}, 'Choose a saved Profile'), profileOptions(valid));
      const host = context.destinations.find(d => d.kind === 'local')?.host;
      replace(readiness, el('section', {class:'section'}, el('h2', {}, 'Studio host readiness'),
        host ? fields([['Host',host.host?.label ?? 'Unknown'],['Operating system',host.host?.os ?? 'Unknown'],['Node runtime',host.host?.node_version ?? 'Unknown'],['Output slot',host.slot_label ?? host.slot_id],['Finite verification',host.verify === true ? 'Available' : 'Unavailable'],['Application run / serve','Unavailable']]) : el('p', {class:'notice'}, 'No configured host output slot is available.'),
        host?.blockers?.length ? el('ul', {}, host.blockers.map(b => el('li', {}, b.code + ': requires ' + b.required + '; observed ' + (b.observed ?? 'unavailable')))) : null,
        el('p', {class:'muted'}, 'Build and verify require Node ≥22 on the Studio host. The generated module targets Node ≥22; target compatibility does not enable application execution.'),
        !approved.length ? el('p', {class:'notice'}, 'No approved flattened Release is available. Bootstrap and missing publication history cannot be built.') : null,
        context.excluded.length ? el('details', {}, el('summary', {}, 'Excluded Release history'), el('ul', {}, context.excluded.map(r => el('li', {}, r.code + ': ' + r.message)))) : null));
      session = false;
    } catch (e) { try { check(ticket); } catch { return; } context = null; profileCursor = null; replace(releases); replace(profiles); replace(readiness); error(e, ticket); }
    finally { if (!disposed && ticket === serial) {busy = false; if(run)showRun(); render();} }
  }
  async function assertPlan(value, chosen) {
    const plan = value?.plan; scoped(plan);
    const release = context?.releases.find(p=>p.release?.ref === chosen.release_ref);
    const profile = context?.profiles.find(p=>p.ref === chosen.profile_ref);
    if (plan?.format !== 'strata-build-plan/1' || !hash(value.plan_sha256) || !sameSelection(plan.selection, chosen)
      || plan.release?.ref !== chosen.release_ref || plan.profile?.ref !== chosen.profile_ref
      || plan.release?.sha256 !== release?.release?.sha256 || plan.profile?.sha256 !== profile?.sha256
      || plan.contract?.ref !== profile?.record?.contract_ref || plan.contract?.sha256 !== profile?.record?.contract_sha256
      || plan.materializer?.archive_sha256 !== profile?.record?.materializer?.archive_sha256
      || plan.compatibility?.repository_id !== ctx.state.repository_id || plan.compatibility?.target_ref !== chosen.release_ref
      || plan.compatibility?.repository_valid !== true || plan.compatibility?.materialization_supported !== true
      || plan.compatibility?.runnable_here !== true || plan.compatibility?.checks?.some(c => c.state !== 'satisfied')
      || !plan.binding?.ref || !plan.contract?.ref || plan.materializer?.id !== 'collection-host/1'
      || !plan.output_root?.identity || await canonicalDigest(plan) !== value.plan_sha256) throw problem('The prepared plan does not match the exact selected inputs, support or immutable digest.');
  }
  function showPlan() {
    const p = prepared.plan;
    replace(planBox, el('section', {class:'section'}, el('h2', {}, 'Prepared plan'),
      el('p', {}, 'Preparation has not built anything. Build checks this exact plan again before admission.'),
      fields([['Release',p.release.ref],['Profile revision',p.profile.ref],['Repository contract',p.contract.ref],['Post-publication adoption',p.binding.ref],['Materializer',p.materializer.id],['Plan SHA-256',prepared.plan_sha256]]),
      el('details', {}, el('summary', {}, 'Compatibility decisions and sources'),
        el('ul', {}, p.compatibility.checks.map(c => el('li', {}, c.category + ' · ' + c.code + ': ' + c.message,
          c.sources?.length ? el('p', {class:'mono'}, c.sources.map(s=>s.ref + (s.item ? ' · ' + s.item : '')).join('; ')) : null)))),
      el('p', {class:'muted'}, 'Repository rules, Release semantics, materializer support and host readiness were checked by the shared backend. Adoption is explicit and occurred after Release publication.')));
  }
  async function prepare() {
    if (preview.disabled || busy) return;
    const chosen = selection(), ticket = ++serial; busy = true; prepared = null; message = ''; render();
    try { const value = await api.prepare(chosen,{signal:abort.signal}); check(ticket); await assertPlan(value, chosen); check(ticket); prepared = value; showPlan(); }
    catch (e) { error(e, ticket); }
    finally { if (!disposed && ticket === serial) {busy = false; if(run)showRun(); render();} }
  }
  async function assertRun(value, expected) {
    scoped(value);
    if (value?.format !== 'strata-build-run/1' || !hash(value.build_id) || !phases.includes(value.phase)
      || value.plan_sha256 !== expected.plan_sha256 || !Array.isArray(value.events)
      || value.verification?.fresh_semantic_validation !== false) throw problem('The retained build result is malformed or belongs to another plan.');
    await assertPlan({plan:value.plan,plan_sha256:value.plan_sha256}, expected.plan.selection);
    if (value.phase === 'completed' && (value.verification.bytes !== true || value.verification.mechanical !== true)) throw problem('Completion lacks retained exact-byte and finite mechanical verification.');
  }
  async function startBuild() {
    if (start.disabled || busy) return;
    const expected = prepared, chosen = structuredClone(expected.plan.selection), ticket = ++serial;
    let dispatched = false;
    busy = true; message = ''; render();
    try {
      const fresh = await api.prepare(chosen,{signal:abort.signal}); check(ticket); await assertPlan(fresh, chosen); check(ticket);
      if (fresh.plan_sha256 !== expected.plan_sha256) throw Object.assign(new Error('Inputs, policy or host readiness changed. Prepare and review a new plan.'),{code:'BUILD_PLAN_STALE'});
      if (pending()) throw Object.assign(new Error('Inspect the pending original operation in Review.'),{code:'OPERATION_PENDING'});
      dispatched = true;
      const value = await api.startBuild({selection:chosen,expected_plan_sha256:expected.plan_sha256}); check(ticket);
      await assertRun(value, expected); check(ticket); run = value; prepared = null; replace(planBox); showRun();
    } catch (e) { if(dispatched && !e.code)e.outcome_unknown=true; error(e, ticket, dispatched); }
    finally { if (!disposed && ticket === serial) {busy = false; if(run)showRun(); render();} }
  }
  function showRun() {
    runUnknown = !['completed','failed','interrupted','output_incomplete'].includes(run.phase) && run.error?.code === 'BUILD_RECONCILIATION_REQUIRED';
    const verified = run.phase === 'completed' && run.verification.bytes === true && run.verification.mechanical === true;
    replace(runBox, el('section', {class:'section'}, el('h2', {}, 'Retained build attempt'), pill(verified ? 'Completed — bytes and finite checks verified' : run.phase, verified ? 'safety' : 'neutral'),
      fields([['Build ID',run.build_id],['Exact bytes',run.verification.bytes ? 'Verified' : 'Not verified'],['Finite mechanical checks',run.verification.mechanical === true ? 'Passed' : run.verification.mechanical === false ? 'Failed' : 'Not measured'],['Fresh semantic validation','Not performed'],['Application run / serve','Unavailable']]),
      run.error ? el('p', {class:'notice'}, run.error.code + ': ' + run.error.message) : null,
      el('ol', {}, run.events.map(e => el('li', {}, e.phase + ' · ' + e.at))),
      el('div', {class:'heading-actions'}, el('button', {disabled:busy,onclick:refreshRun}, 'Refresh status'),
        el('button', {disabled:busy || !run.verification.bytes || !['completed','failed'].includes(run.phase),onclick:loadOutputs}, 'Inspect verified files')),
      inventory ? el('ul', {}, inventory.files.map(file => el('li', {}, file.name + ' · ' + file.bytes + ' bytes ', el('button', {onclick:()=>download(file)}, 'Download ' + file.name)))) : null));
  }
  async function readRun(action) {
    if (busy || !run || disposed) return;
    const current = run, ticket = ++serial; busy = true; message = ''; render(); showRun();
    try { await action(current,ticket); check(ticket); showRun(); }
    catch (e) { error(e,ticket); }
    finally { if (!disposed && ticket === serial) {busy = false; showRun(); render();} }
  }
  function refreshRun() { return readRun(async(current,ticket)=>{
    const value = await api.inspectBuild({build_id:current.build_id},{signal:abort.signal}); check(ticket);
    await assertRun(value,{plan:current.plan,plan_sha256:current.plan_sha256}); check(ticket);
    if (value.build_id !== current.build_id) throw problem('Status belongs to another attempt.');
    run = value; inventory = null;
  }); }
  function loadOutputs() { return readRun(async(current,ticket)=>{
    const value = await api.outputs({build_id:current.build_id},{signal:abort.signal}); check(ticket);
    if (value?.build_id !== current.build_id || value.verification?.bytes !== true || value.verification?.fresh_semantic_validation !== false
      || !['completed','failed'].includes(value.state) || !Array.isArray(value.files)
      || value.files.some(f => !hash(f.file_id) || !hash(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || typeof f.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(f.name))) throw problem('Verified output inventory is unavailable or malformed.');
    inventory = value;
  }); }
  function download(file) { return readRun(async(current,ticket)=>{
    const blob = await api.download({build_id:current.build_id,file_id:file.file_id},{signal:abort.signal}); check(ticket);
    if (!(blob instanceof Blob) || blob.size !== file.bytes || await canonicalBytesDigest(blob) !== file.sha256) throw problem('Downloaded output differs from the verified inventory.');
    check(ticket); const url = URL.createObjectURL(blob), link = el('a', {href:url,download:file.name}); root.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }); }
  async function recoverSession() {
    if (busy || !ctx.sessionRecovery || disposed) return;
    const ticket = ++serial; busy = true; prepared = null; replace(planBox); render();
    try { const ok = await ctx.sessionRecovery(); check(ticket); session = !ok; message = ok ? 'Session refreshed. Prepare the retained selection again.' : 'Open a new protected Studio session.'; }
    catch(e) {error(e,ticket);}
    finally {if(!disposed && ticket === serial){busy=false;render();}}
  }
  root.start = load;
  root.dispose = () => {disposed = true; ++serial; abort.abort();};
  root.hasUnsavedChanges = () => false;
  root.beforeLeave = async() => true;
  ctx.signal?.addEventListener('abort',root.dispose,{once:true});
  render(); return root;
}
async function canonicalBytesDigest(blob) {
  const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
