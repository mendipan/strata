// S4 Profiles: a mount-only plain module. The shell owns routing, repository
// selection, sessions and recovery; this view talks to an injected profileApi
// adapter only and never creates routes, endpoints, storage or credentials.
import {el, fields, pill, empty, table, titleCase, json} from './dom.js';
import {sessionRequired, unconfirmedOperation} from './operation-recovery.js';

const replaceVisible = (node, ...children) => node.replaceChildren(...children.filter(child => child !== null && child !== undefined));
const NAME_LIMIT = 80;          // S0 BUILD_LIMITS.name; a presentation gate only. The server re-validates.
const REVISION_LIMIT = 64;      // S0 BUILD_LIMITS.revisions.
const VALIDATE_DEBOUNCE_MS = 300;
const CHOICE_FIELDS = ['language', 'framework', 'runtime'];
const STAGE_LABELS = {build: 'Build', verify: 'Verify', run: 'Run'};
const SUBJECT_LABELS = {host: 'Studio host', target: 'Application target'};

const shortSha = sha => typeof sha === 'string' && sha.length >= 12 ? sha.slice(0, 12) + '…' : String(sha ?? '—');
const aborted = error => error?.name === 'AbortError' || (error instanceof DOMException && error.name === 'AbortError');
const errorText = error => error?.message || String(error);
const choicesText = choices => choices ? `${choices.language} · ${choices.framework} · ${choices.runtime}` : '—';
const materializerOpen = report => report.checks.some(c => c.category === 'materializer' && c.state !== 'satisfied');
const contextOf = lookup => lookup?.context ?? null;
function validationMatches(record, report) {
  const n = report?.normalized_profile;
  return !!n && Object.keys(n).length === Object.keys(record).length && Object.keys(record).every(k => JSON.stringify(n[k]) === JSON.stringify(record[k]))
    && report.contract_ref === record.contract_ref && report.contract_sha256 === record.contract_sha256;
}

// Per-profile status is derived from the server's own inspect report; the client
// never re-implements rule evaluation.
function profileStatus(item) {
  if (item.archived) return {label: 'Archived', kind: 'blocked'};
  const report = item.report;
  if (!report) return {label: 'Not validated (no current contract)', kind: 'neutral'};
  const open = report.checks.filter(c => c.state !== 'satisfied');
  if (open.some(c => c.state === 'invalid')) return {label: 'Needs update', kind: 'blocked'};
  if (open.length) return {label: 'Unsupported by current tooling', kind: 'blocked'};
  return report.target_ref === null
    ? {label: 'Valid for this contract; not checked against a Release', kind: 'neutral'}
    : {label: 'Valid for this contract', kind: 'safety'};
}

function checkRow(check) {
  return el('li', {},
    el('strong', {}, `${titleCase(check.category)}${check.field ? ' — ' + check.field : ''} (${check.state}, ${check.code})`),
    el('p', {}, check.message),
    check.sources.length ? el('small', {class: 'muted'}, 'Sources: ' + check.sources.map(s => `${s.kind}${s.item ? ' “' + s.item + '”' : ''} · ${s.ref}`).join(' | ')) : null);
}

function checkList(report) {
  const open = report.checks.filter(c => c.state !== 'satisfied');
  if (!open.length) return el('p', {class: 'muted'}, 'All checks satisfied against contract ' + report.contract_ref + '.');
  return el('ul', {}, open.map(checkRow));
}

export function profilesView(ctx) {
  const api = ctx.profileApi || null;
  let disposed = false, recoveryBusy = false, leaveDialog = null;
  let lookup = null, lookupError = null;
  let listItems = null, listCursor = null, listLoading = false, listError = null, listNotice = null;
  let detail = null;            // {ref, item} — the currently open saved record
  let detailRead = 0;
  let editor = null;            // draft state; see openEditor
  let sessionMessage = null;    // session-expiry banner text (mutations blocked while set)
  let writeBlockedMessage = null; // unknown save outcome: no further writes from this page
  let savedMessage = null;
  const optionsCache = {};      // contract ref -> materializer options (server-supplied)

  const headingActions = el('div', {class: 'heading-actions'});
  const bannerBox = el('div');
  const contextPane = el('div');
  const listPane = el('div');
  const detailPane = el('div');
  const editorPane = el('div');
  const root = el('section', {class: 'section workflow-page', id: 'profiles', 'aria-label': 'Profiles'},
    el('div', {class: 'heading'}, el('h1', {tabindex: '-1'}, 'Profiles'), headingActions),
    bannerBox, contextPane, listPane, detailPane, editorPane);

  function live() {
    if (disposed) return false;
    try { ctx.check?.(); } catch { return false; }
    return root.isConnected;
  }

  function paint() {
    headingActions.replaceChildren(el('button', {class: 'primary', disabled: !api || !contextOf(lookup) || listLoading || !!editor || !!sessionMessage || !!writeBlockedMessage,
      onclick: () => openEditor('create')}, 'New profile'));
    bannerBox.replaceChildren(...banners());
    if (!api) { contextPane.replaceChildren(unwiredCard()); listPane.replaceChildren(); detailPane.replaceChildren(); editorPane.replaceChildren(); return; }
    contextPane.replaceChildren(contextCard());
    detailPane.replaceChildren(...(detail ? [detailCard()] : []));
    listPane.replaceChildren(...(editor || detail ? [] : [listCard()]));
    editorPane.replaceChildren(...(editor ? [editor.root] : []));
  }

  function banners() {
    const nodes = [];
    if (api?.fixtureNote) nodes.push(el('div', {class: 'notice'}, el('p', {}, api.fixtureNote)));
    if (sessionMessage) nodes.push(el('div', {class: 'notice error'}, el('p', {}, sessionMessage),
      typeof ctx.sessionRecovery === 'function' ? el('button', {disabled: recoveryBusy, onclick: () => void recoverSession()}, recoveryBusy ? 'Recovering…' : 'Recover session and continue') : null));
    if (writeBlockedMessage) nodes.push(el('div', {class: 'notice error'}, el('p', {}, writeBlockedMessage)));
    if (savedMessage) nodes.push(el('div', {class: 'notice'}, el('p', {}, savedMessage)));
    return nodes;
  }

  function unwiredCard() {
    return el('article', {class: 'card'}, el('div', {class: 'notice error'},
      el('p', {}, 'Profiles are not wired in this build. No profile API adapter is connected, so this page cannot list saved profiles or save anything.'),
      el('p', {class: 'muted'}, 'Profile storage is unavailable in this Studio build. Existing profiles remain unchanged.')),
      fields([['Status', 'Unwired — no adapter injected'], ['Saved profiles', 'Unavailable'], ['Saving', 'Disabled'], ['What this module never does', 'It creates no routes, endpoints, storage or credentials on its own.']]),
      el('p', {class: 'muted'}, 'Saving is unavailable until profile support is enabled.'));
  }

  function missingContractCard() {
    return el('article', {class: 'card'}, el('h3', {}, 'No build compatibility contract'),
      el('p', {}, 'This repository has no profile-authoring contract yet. Every profile pins an exact contract revision, so none can be authored here until a reviewed contract exists.'),
      el('ol', {},
        el('li', {}, 'A repository owner imports a compatibility contract (repository.contract.import) that continues this repository’s designated lineage.'),
        el('li', {}, 'The import needs a retained, authorized contract review — this page cannot create, assume or bypass that review.'),
        el('li', {}, 'Once the contract head exists, New profile becomes available. There is no permissive fallback: validation and saving stay disabled.')),
      el('p', {class: 'muted'}, 'No contract was silently created for you, and no draft is being validated against invented rules.'));
  }

  function contextCard() {
    if (lookupError) return el('div', {class: 'notice error'}, el('p', {}, 'Could not read the repository build context: ' + lookupError), retryReadButton());
    if (!lookup) return el('article', {class: 'card'}, el('p', {class: 'muted'}, 'Loading repository build context…'));
    const c = contextOf(lookup);
    if (!c) return missingContractCard();
    const binding = lookup.contract_binding === 'post_publication_adoption' && lookup.binding
      ? el('span', {}, 'Adopted by Release ', el('span', {class: 'mono'}, lookup.binding.record.release.ref), ' (', shortSha(lookup.binding.record.release.sha256), ')')
      : 'Repository authoring head — not checked against a Release.';
    return el('article', {class: 'card'}, el('h3', {}, 'Repository contract context'),
      fields([['Project', c.project_id], ['Repository', c.repository_id],
        ['Contract pin', el('span', {class: 'mono'}, c.contract.ref)], ['Contract revision', 'revision ' + c.contract.record.revision + ' · sha256 ' + shortSha(c.contract.sha256)],
        ['Release binding', binding]]),
      rulesCard(c),
      el('details', {class: 'raw'}, el('summary', {}, 'Contract record (exact JSON)'), json(c.contract.record)));
  }

  function rulesCard(c) {
    const record = c.contract.record;
    const source = rule => `Source: repository rule “${rule.id}” · ${c.contract.ref}`;
    const byField = Object.fromEntries(CHOICE_FIELDS.map(f => [f, record.rules.filter(r => r.field === f)]));
    return el('div', {},
      el('h3', {}, 'Repository requirements (hard rules with provenance)'),
      el('ul', {}, CHOICE_FIELDS.flatMap(field => byField[field].length
        ? byField[field].map(r => el('li', {}, el('strong', {}, field + ' rule “' + r.id + '” allows: ' + r.allowed.join(', ')), el('p', {}, r.rationale), el('small', {class: 'muted'}, source(r))))
        : [el('li', {class: 'muted'}, 'No recorded restriction for ' + field + '. Unspecified is not a claim that every ' + field + ' is implemented.')])),
      record.preferences.length ? el('details', {}, el('summary', {}, 'Advisory preferences (' + record.preferences.length + ', collapsed) — preferences never widen hard rules'),
        el('ul', {}, record.preferences.map(p => el('li', {}, el('strong', {}, p.field + ' → ' + p.value), el('p', {}, p.rationale))))) : null,
      el('p', {class: 'muted'}, 'Hard rules above are repository decisions with their recorded rationale. The materializer’s finite support is shown separately while editing.'));
  }

  function retryReadButton() {
    return el('button', {onclick: () => void refresh()}, 'Retry reading profiles');
  }

  function listCard() {
    const c = contextOf(lookup);
    const nodes = [];
    if (listError) nodes.push(el('div', {class: 'notice error'}, el('p', {}, 'Could not list profiles: ' + listError), retryReadButton()));
    if (listNotice) nodes.push(el('div', {class: 'notice'}, el('p', {}, listNotice)));
    const toolbar = el('div', {class: 'toolbar'},
      el('button', {disabled: listLoading, onclick: () => void refresh()}, listLoading ? 'Reloading…' : 'Reload list'));
    if (listLoading && !listItems) nodes.push(el('p', {class: 'muted'}, 'Loading saved profiles…'));
    if (listItems && !listItems.length) nodes.push(empty(c ? 'No saved profiles yet. Use New profile to author the first one.' : 'No saved profiles can be listed without a contract.'));
    if (listItems?.length) nodes.push(table(
      ['Profile', 'Status', 'Choices (pinned)', 'Revision', 'Exact ref'],
      listItems.map(item => {
        const status = profileStatus(item);
        return [el('button', {class: 'text-button', onclick: () => openDetail(item)}, item.record.name),
          pill(status.label, status.kind), choicesText(item.record.choices),
          'revision ' + item.record.revision, el('span', {class: 'mono'}, item.ref)];
      })));
    if (listCursor !== null && listCursor !== undefined) nodes.push(el('div', {class: 'toolbar'}, el('button', {disabled: listLoading, onclick: () => void loadMore()}, listLoading ? 'Loading…' : 'Load more profiles')));
    nodes.push(toolbar);
    return el('article', {class: 'card'}, el('h3', {}, 'Saved profiles'), el('p', {class: 'muted'}, 'Each row is a named logical profile at its current immutable revision. Revising saves a new record; earlier revisions keep their exact refs.'), ...nodes);
  }

  async function openDetail(item) {
    if (editor && !await leaveEditor()) return;
    savedMessage = null;
    detail = {ref: item.ref, item: structuredClone(item)};
    paint();
  }

  function detailCard() {
    const {item} = detail;
    const status = profileStatus(item);
    const r = item.record;
    return el('article', {class: 'card'}, el('h3', {}, 'Saved profile: ' + r.name),
      fields([['Name', r.name], ['Logical id', r.id], ['Revision', 'revision ' + r.revision + ' (immutable)'],
        ['Exact ref', el('span', {class: 'mono'}, detail.ref)], ['Record sha256', shortSha(item.sha256)],
        ['Contract pin', el('span', {class: 'mono'}, r.contract_ref + ' · ' + shortSha(r.contract_sha256))],
        ['Choices (pinned)', choicesText(r.choices)], ['Materializer', r.materializer.id + ' · archive ' + shortSha(r.materializer.archive_sha256)],
        ['Previous revision', r.previous ? el('span', {class: 'mono'}, r.previous.ref) : 'None (first revision)'],
        ['Author (server-recorded)', r.author]]),
      el('div', {class: 'facets'}, pill(status.label, status.kind)),
      item.report ? el('div', {}, el('h3', {}, 'Current validation report'), checkList(item.report)) : el('p', {class: 'muted'}, 'Not validated: the repository has no current contract to check against.'),
      el('div', {class: 'toolbar'},
        el('button', {disabled: !contextOf(lookup) || !!sessionMessage || !!writeBlockedMessage, onclick: () => void openEditor('revise', item)}, 'Edit (new revision)'),
        el('button', {disabled: false, onclick: () => void reloadDetail()}, 'Reload this profile'),
        el('button', {onclick: () => { detail = null; paint(); }}, 'Back to list')));
  }

  async function reloadDetail() {
    const captured = detail;
    if (!captured) return;
    const request = ++detailRead;
    try {
      const fresh = await api.inspectProfile({ref: captured.ref}, {signal: ctx.signal});
      if (!live() || detail !== captured || request !== detailRead || editor) return;
      const c = contextOf(lookup);
      if (c && fresh.record.repository_id !== c.repository_id) { listNotice = 'Ignored a profile response from another repository (' + fresh.record.repository_id + ').'; paint(); return; }
      detail = {ref: fresh.ref ?? captured.ref, item: fresh};
      paint();
    } catch (e) { if (!aborted(e) && live() && detail === captured && request === detailRead && !editor) { if (readSessionRequired(e)) return; listNotice = 'Could not reload this profile: ' + errorText(e); paint(); } }
  }

  // ---- Editor -----------------------------------------------------------

  function nameGate(name) {
    if (!name.trim()) return 'Name is required (1–80 characters).';
    if (name.length > NAME_LIMIT) return 'Name is limited to ' + NAME_LIMIT + ' characters (currently ' + name.length + ').';
    return null;
  }

  function newDraftId() {
    return 'build-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  }

  function draftRecord(ed, name) {
    return {id: ed.draftId, revision: ed.draftRevision, name,
      contract_ref: ed.contract.ref, contract_sha256: ed.contract.sha256,
      choices: {...ed.options.choices}, materializer: {id: ed.options.materializer_id, archive_sha256: ed.options.archive_sha256}};
  }

  async function openEditor(mode, item) {
    if (!api) return;
    if (editor && !await leaveEditor()) return;
    const c = contextOf(lookup);
    if (!c) return;
    detail = null;
    savedMessage = null;
    editor = {
      mode, baseRecord: mode === 'revise' ? item.record : null, baseRef: mode === 'revise' ? item.ref : null,
      name: mode === 'revise' ? item.record.name : '',
      scope: {projectId: c.project_id, repositoryId: c.repository_id},
      contract: {ref: c.contract.ref, sha256: c.contract.sha256, revision: c.contract.record.revision},
      draftId: mode === 'revise' ? item.record.id : newDraftId(),
      draftRevision: mode === 'revise' ? item.record.revision + 1 : 1,
      options: null, report: null, reviewedSha: null, validating: false,
      controller: null, timer: 0, seq: 0, busy: false,
      staleHead: false, contractStale: false, scopeStale: false, revisionLimit: mode === 'revise' && item.record.revision >= REVISION_LIMIT
    };
    buildEditorDom(editor);
    paint();
    editor.nameInput.focus();
    void ensureOptions(editor);
  }

  function closeEditorSilently() {
    if (!editor) return true;
    clearTimeout(editor.timer);
    editor.controller?.abort();
    editor = null;
    paint();
    return true;
  }

  async function leaveEditor() {
    const captured = editor;
    if (!await beforeLeave() || !live() || editor && editor !== captured) return false;
    if (editor) closeEditorSilently();
    return true;
  }

  function readSessionRequired(error, ed) {
    if (!sessionRequired(error)) return false;
    sessionMessage = 'Your Studio session expired during a read. Your input is preserved; recover your session to continue. This page shows no credentials form.';
    if (ed) { setStatus(ed, 'Session expired - no save was requested by this read. Your input is preserved.', 'error'); paintEditorRegions(ed); }
    paint();
    return true;
  }

  function setStatus(ed, text, kind) {
    ed.statusText = text; ed.statusKind = kind;
    ed.statusLine.className = kind === 'error' ? 'form-error' : 'muted';
    ed.statusLine.textContent = text;
    if (kind === 'error') ctx.announce?.(text);
  }

  function scheduleValidate(ed) {
    clearTimeout(ed.timer);
    ed.timer = setTimeout(() => void validateNow(ed), VALIDATE_DEBOUNCE_MS);
  }

  // The fixed tuple and its archive digest are discovered from the server's own
  // materializer options (probe with a zero archive; the response carries the
  // registered options). Nothing here invents a second policy engine.
  async function ensureOptions(ed) {
    const cached = optionsCache[ed.contract.ref];
    if (cached) { ed.options = cached; paintEditorRegions(ed); scheduleValidate(ed); return; }
    setStatus(ed, 'Loading materializer options…');
    const seq = ++ed.seq;
    try {
      const probe = await api.validateProfile({record: {
        id: 'options-probe', revision: 1, name: 'Materializer options probe',
        contract_ref: ed.contract.ref, contract_sha256: ed.contract.sha256,
        choices: {language: 'javascript', framework: 'none', runtime: 'node'},
        materializer: {id: 'collection-host/1', archive_sha256: '0'.repeat(64)}}}, {signal: ctx.signal});
      if (!live() || editor !== ed || ed.seq !== seq) return;
      if (!probe.options) { setStatus(ed, 'No materializer options are available for this contract, so profiles cannot be authored here yet.', 'error'); paintEditorRegions(ed); return; }
      if (probe.report.repository_id !== ed.scope.repositoryId) { setStatus(ed, 'Ignored a materializer options response from another repository. Editing is blocked.', 'error'); return; }
      optionsCache[ed.contract.ref] = probe.options;
      ed.options = probe.options;
      paintEditorRegions(ed);
      scheduleValidate(ed);
    } catch (e) { if (!aborted(e) && live() && editor === ed && ed.seq === seq) { if (readSessionRequired(e, ed)) return; setStatus(ed, 'Could not load materializer options: ' + errorText(e), 'error'); } }
  }

  async function validateNow(ed) {
    if (!ed || ed.busy || !ed.options || sessionMessage || recoveryBusy) return;
    const name = ed.nameInput.value;
    ed.name = name;
    const gate = nameGate(name);
    if (gate) { ed.report = null; ed.reviewedSha = null; setStatus(ed, gate, 'error'); paintEditorRegions(ed); return; }
    ed.controller?.abort();
    const controller = new AbortController(); ed.controller = controller;
    const seq = ++ed.seq;
    const record = draftRecord(ed, name);
    ed.validating = true;
    setStatus(ed, 'Validating “' + name + '” against ' + ed.contract.ref + '…');
    try {
      const result = await api.validateProfile({record}, {signal: controller.signal});
      if (!live() || editor !== ed || ed.seq !== seq) return;
      if (ed.nameInput.value !== name) return; // edited while validating; the debounced run will replace this
      ed.validating = false;
      applyValidation(ed, result);
    } catch (e) {
      if (aborted(e) || !live() || editor !== ed || ed.seq !== seq) return;
      ed.validating = false;
      if (readSessionRequired(e, ed)) return;
      setStatus(ed, 'Validation failed: ' + errorText(e) + ' Your input is preserved.', 'error');
    }
  }

  function applyValidation(ed, {report, options}) {
    if (report.repository_id !== ed.scope.repositoryId) { setStatus(ed, 'Ignored a validation result from another repository (' + report.repository_id + ').', 'error'); return; }
    if (report.contract_ref !== ed.contract.ref) {
      ed.contractStale = true;
      ed.report = report; ed.options = options ?? ed.options;
      setStatus(ed, 'The repository contract changed while you were editing (current head ' + report.contract_ref + '). This draft keeps its old pin ' + ed.contract.ref + ' and cannot be saved; start a new draft from the current contract.', 'error');
      paintEditorRegions(ed);
      return;
    }
    ed.contractStale = false;
    ed.report = report;
    if (options) { ed.options = options; optionsCache[ed.contract.ref] = options; }
    ed.reviewedSha = report.normalized_sha256 ?? null;
    setStatus(ed, report.normalized_sha256 ? 'Validated: ' + report.checks.filter(c => c.state === 'satisfied').length + ' of ' + report.checks.length + ' checks satisfied. Normalized sha256 ' + shortSha(report.normalized_sha256) + '.' : 'Not valid yet — see the report below.', report.normalized_sha256 && report.repository_valid ? 'ok' : 'error');
    paintEditorRegions(ed);
  }

  async function save(ed) {
    if (!api || editor !== ed || ed.busy) return;
    if (sessionMessage || writeBlockedMessage) return;
    if (ed.staleHead || ed.contractStale || ed.scopeStale || ed.revisionLimit) return;
    const name = ed.nameInput.value;
    const gate = nameGate(name);
    if (gate) { setStatus(ed, gate, 'error'); return; }
    if (!ed.options) { setStatus(ed, 'Materializer options are still loading; try again in a moment.', 'error'); return; }
    ed.busy = true;
    let mutationInvoked = false;
    clearTimeout(ed.timer);
    ed.controller?.abort();
    const seq = ++ed.seq;
    const record = draftRecord(ed, name);
    setStatus(ed, 'Validating the exact draft before saving…');
    paintEditorRegions(ed);
    try {
      ctx.check?.(); // current render generation before dispatch
      const current = await api.compatibility({}, {signal: ctx.signal});
      if (!live() || editor !== ed) return;
      const c = contextOf(current);
      if (!c) { setStatus(ed, 'The repository no longer has a profile-authoring contract; this draft cannot be saved.', 'error'); return; }
      if (c.repository_id !== ed.scope.repositoryId || c.project_id !== ed.scope.projectId) {
        ed.scopeStale = true;
        setStatus(ed, 'This draft belongs to repository ' + ed.scope.repositoryId + ', but the current repository is ' + c.repository_id + '. No old-repository draft is saved into the new one — discard it and start a fresh draft here.', 'error');
        paintEditorRegions(ed); return;
      }
      if (c.contract.ref !== ed.contract.ref || c.contract.sha256 !== ed.contract.sha256) {
        ed.contractStale = true;
        setStatus(ed, 'The repository contract changed while you were editing (new head ' + c.contract.ref + '). This draft keeps its old pin and was not saved; start a new draft from the current contract.', 'error');
        paintEditorRegions(ed); return;
      }
      const result = await api.validateProfile({record}, {signal: ctx.signal});
      if (!live() || editor !== ed) return;
      if (ed.nameInput.value !== name) { setStatus(ed, 'You edited the name while validation ran. Nothing was saved — save again to submit the updated draft.', 'error'); return; }
      if (result.report.repository_id !== ed.scope.repositoryId) { setStatus(ed, 'Ignored a validation result from another repository. Nothing was saved.', 'error'); return; }
      ed.report = result.report;
      if (result.options) { ed.options = result.options; optionsCache[ed.contract.ref] = result.options; }
      paintEditorRegions(ed);
      const report = result.report;
      if (!report.normalized_sha256) { setStatus(ed, 'Cannot save: the profile did not pass schema validation.', 'error'); return; }
      if (ed.reviewedSha && report.normalized_sha256 !== ed.reviewedSha) {
        ed.reviewedSha = report.normalized_sha256;
        setStatus(ed, 'Validation changed since your last review — the report below is updated. Choose Save again to confirm this exact version; nothing was saved yet.', 'error');
        return;
      }
      if (!report.repository_valid) { setStatus(ed, 'Cannot save: resolve the reported repository or schema issues first.', 'error'); return; }
      if (materializerOpen(report)) { setStatus(ed, 'Cannot save: the compiled materializer does not support these choices.', 'error'); return; }
      ctx.check?.();
      if (!validationMatches(record, report)) { setStatus(ed, 'Validation no longer matches this exact draft and contract. Nothing was sent; validate again.', 'error'); return; }
      const normalized = structuredClone(report.normalized_profile);
      mutationInvoked = true;
      const reply = ed.mode === 'create'
        ? await api.createProfile({record: normalized, expected_normalized_sha256: report.normalized_sha256}, {signal: ctx.signal})
        : await api.reviseProfile({previous: ed.baseRef, record: normalized, expected_normalized_sha256: report.normalized_sha256}, {signal: ctx.signal});
      if (!live() || editor !== ed) return;
      if (reply.record.project_id !== ed.scope.projectId || reply.record.repository_id !== ed.scope.repositoryId) {
        handleSaveError(ed, Object.assign(new Error('The save confirmation did not match its repository. Check the original outcome in Review.'), {code: 'OPERATION_UNKNOWN', outcome_unknown: true}));
        return;
      }
      const ref = reply.ref, revision = reply.record.revision;
      closeEditorSilently();
      savedMessage = 'Saved “' + reply.record.name + '” as immutable revision ' + revision + ' · ' + ref + '.';
      ctx.announce?.(savedMessage);
      await refresh();
    } catch (e) {
      if (!live() || editor !== ed) return;
      if (aborted(e)) {
        if (!mutationInvoked) return;
        e = Object.assign(new Error('Stopped waiting after a save was sent. Check its original outcome in Review.'), {code: 'OPERATION_UNKNOWN', outcome_unknown: true});
      }
      handleSaveError(ed, e);
    } finally {
      if (editor === ed) { ed.busy = false; paintEditorRegions(ed); }
    }
  }

  function handleSaveError(ed, e) {
    const text = errorText(e);
    if (unconfirmedOperation(e)) {
      writeBlockedMessage = 'The save outcome is unknown: ' + text + ' No further saves are allowed from this page until the operation is reconciled in Review.';
      setStatus(ed, 'Save outcome unknown — nothing further will be sent from this page.', 'error');
      paint();
      return;
    }
    if (sessionRequired(e)) {
      sessionMessage = 'Your session expired while saving. Your input is preserved in this page; recover your session to continue. This page shows no credentials form.';
      setStatus(ed, 'Session expired — the save was not confirmed. Your input above is preserved.', 'error');
      paint();
      return;
    }
    if (e.code === 'STALE_REVISION') {
      ed.staleHead = true;
      setStatus(ed, 'The saved profile changed while you were editing (another revision exists). Your input is preserved. Use “Reload latest revision”, reapply anything you need, then save again.', 'error');
      paintEditorRegions(ed);
      return;
    }
    if (['STALE_GENERATION','STALE_POLICY'].includes(e.code)) {
      ed.staleView = true;
      if (ed.mode === 'revise') ed.staleHead = true;
      setStatus(ed, text + ' Your input is preserved. Reload the repository view or latest revision, review validation, then save again.', 'error');
      paintEditorRegions(ed); return;
    }
    if (e.code === 'BUILD_CONTRACT_MISSING') { ed.contractStale = true; setStatus(ed, 'The repository no longer has an authoring contract; this draft cannot be saved.', 'error'); paintEditorRegions(ed); return; }
    setStatus(ed, text + ' Your input is preserved.', 'error');
    paintEditorRegions(ed);
  }

  async function reloadLatest(ed) {
    ed.busy = true; paintEditorRegions(ed);
    try {
      const head = await findHeadById(ed.baseRecord.id);
      if (!live() || editor !== ed) return;
      if (!head) { setStatus(ed, 'Could not find the current revision of this profile in the repository list.', 'error'); return; }
      if (head.record.repository_id !== ed.scope.repositoryId) { ed.scopeStale = true; setStatus(ed, 'The current revision belongs to another repository; this draft cannot proceed.', 'error'); paintEditorRegions(ed); return; }
      if (head.ref === ed.baseRef) { ed.staleHead = false; setStatus(ed, 'You already hold the latest revision ' + head.record.revision + '. You can save now.', 'ok'); }
      else {
        editor.baseRecord = head.record; editor.baseRef = head.ref;
        editor.draftRevision = head.record.revision + 1;
        editor.revisionLimit = head.record.revision >= REVISION_LIMIT;
        editor.staleHead = false;
        setStatus(ed, 'Reloaded revision ' + head.record.revision + ' (“' + head.record.name + '”, ' + head.ref + '). Your edited name is preserved; review it and save again.', 'ok');
      }
      scheduleValidate(ed);
      ed.staleView = false;
    } catch (e) { if (!aborted(e) && live() && editor === ed) { if (!readSessionRequired(e, ed)) setStatus(ed, 'Could not reload the latest revision: ' + errorText(e), 'error'); } }
    finally { if (editor === ed) { ed.busy = false; paintEditorRegions(ed); } }
  }

  async function findHeadById(id) {
    let cursor = undefined;
    do {
      const page = await api.listProfiles({cursor}, {signal: ctx.signal});
      if (!live()) return null;
      const hit = page.profiles.find(p => p.record.id === id);
      if (hit) return hit;
      cursor = page.cursor;
    } while (cursor);
    return null;
  }

  function buildEditorDom(ed) {
    ed.nameInput = el('input', {type: 'text', id: 'profile-name', value: ed.name, autocomplete: 'off',
      oninput: e => { ed.name = e.target.value; scheduleValidate(ed); }});
    ed.statusLine = el('p', {class: 'muted', role: 'status', 'aria-live': 'polite'});
    ed.choicesBox = el('div');
    ed.optionsBox = el('div');
    ed.reportBox = el('div');
    ed.advancedBox = el('details', {class: 'raw'});
    ed.actionsBox = el('div', {class: 'toolbar'});
    const intro = ed.mode === 'create'
      ? 'A new logical profile: revision 1 pinned to the current contract ' + ed.contract.ref + '. Studio derives the record id and digest; you only choose a name.'
      : 'Revision ' + (ed.baseRecord.revision + 1) + ' of “' + ed.baseRecord.name + '”. The saved revision ' + ed.baseRecord.revision + ' stays immutable at ' + ed.baseRef + '; your save will name that exact ref as its predecessor.';
    ed.root = el('form', {class: 'card', onsubmit: e => { e.preventDefault(); void save(ed); }},
      el('h3', {}, ed.mode === 'create' ? 'New profile' : 'Revise “' + ed.baseRecord.name + '”'),
      ed.intro = el('p', {class: 'muted'}, intro),
      el('label', {for: 'profile-name'}, 'Profile name'),
      ed.nameInput,
      ed.statusLine,
      ed.choicesBox, ed.optionsBox, ed.reportBox, ed.advancedBox, ed.actionsBox);
    paintEditorRegions(ed);
  }

  function paintEditorRegions(ed) {
    // Only dependent regions are repainted; the name input node is never rebuilt,
    // so typing and focus survive validation updates.
    if (!ed || !ed.root) return;
    if (ed.mode === 'revise') {
      ed.intro.textContent = 'Revision ' + ed.draftRevision + ' of “' + ed.baseRecord.name + '”. The saved revision ' + ed.baseRecord.revision + ' stays immutable at ' + ed.baseRef + '; your save will name that exact ref as its predecessor.';
      ed.root.querySelector('h3').textContent = 'Revise “' + ed.baseRecord.name + '”';
    }

    replaceVisible(ed.choicesBox,!ed.options
      ? el('p', {class: 'muted'}, 'Materializer choices load with the options…')
      : el('div', {},
          el('h3', {}, 'Stack choices'),
          fields(CHOICE_FIELDS.map(f => [titleCase(f), ed.options.choices[f] + ' (fixed)'])),
          ed.options.options.length ? null : el('p', {class: 'muted'}, 'Fixed by materializer ' + ed.options.materializer_id + ' — this version has no configurable options, so there is nothing to select here.'),
          el('p', {class: 'muted'}, 'These are the actual values supplied by the materializer options. They are not a general language picker: only this fixed tuple is compiled today.')));

    replaceVisible(ed.optionsBox,!ed.options ? null : el('div', {},
      el('h3', {}, 'Environment requirements and destinations'),
      el('ul', {}, ed.options.requirements.map(r => el('li', {},
        el('strong', {}, STAGE_LABELS[r.stage] + ' — ' + SUBJECT_LABELS[r.subject] + ': '),
        titleCase(r.kind) + ' “' + r.id + '”' + (r.version?.min_major !== undefined ? ', major version ' + r.version.min_major + ' or later' : r.version?.exact !== undefined ? ', exactly ' + r.version.exact : '') + ' (source ' + r.source_ref + ')'))),
      el('p', {class: 'muted'}, '“Studio host” means the machine running this Studio instance — not this browser. “Application target” is where the built output runs and may differ from the Studio host. This page does not probe the host, so current readiness is unknown here.'),
      fields([
        ['Destinations', ed.options.destinations.map(d => d === 'local' ? 'Local — build output export on the Studio host' : d).join('; ') + '. Cloudflare Workers is a future destination and is not available in this version.'],
        ['Connections & credentials', 'Stay in Settings; they are separate from profile choices and never appear on this page.'],
        ['Current host readiness', 'Not evaluated in this page.'],
        ['Run application here', ed.options.run_application ? 'Supported' : 'Not supported (run_application is false in the materializer options).'],
        ['Serve application here', ed.options.serve_application ? 'Supported' : 'Not supported (serve_application is false in the materializer options).'],
        ['Release target', 'Not checked — this draft is not validated against a selected Release.']])));
    if (ed.options && ed.mode === 'revise' && CHOICE_FIELDS.some(field => ed.baseRecord.choices[field] !== ed.options.choices[field])) {
      ed.choicesBox.append(el('div', {class: 'notice'}, 'The saved revision pinned choices ' + choicesText(ed.baseRecord.choices) + '. The current materializer supports only the fixed tuple above, so this revision explicitly adopts those fixed values.'));
    }
    if (ed.options && ed.mode === 'revise' && (ed.baseRecord.contract_ref !== ed.contract.ref || ed.baseRecord.contract_sha256 !== ed.contract.sha256)) {
      ed.choicesBox.append(el('div', {class: 'notice'}, 'Explicit adoption: the saved revision pinned contract ' + ed.baseRecord.contract_ref + '; this revision adopts the current contract ' + ed.contract.ref + '. The old pin stays immutable on the saved record.'));
    }

    replaceVisible(ed.reportBox,el('div', {},
      el('h3', {}, 'Validation report'),
      !ed.report
        ? el('p', {class: 'muted'}, 'Validation feedback appears here after you enter a name.')
        : el('div', {},
          el('p', {class: 'muted'}, (ed.report.normalized_profile ? 'Normalized draft: “' + ed.report.normalized_profile.name + '” · ' + choicesText(ed.report.normalized_profile.choices) + ' · sha256 ' + shortSha(ed.report.normalized_sha256) + '. ' : '') +
            ed.report.checks.filter(c => c.state === 'satisfied').length + ' of ' + ed.report.checks.length + ' checks satisfied. Repository valid: ' + ed.report.repository_valid + '. Materialization on a Release target: not checked here.'),
          checkList(ed.report))));

    replaceVisible(ed.advancedBox,el('summary', {}, 'Advanced: exact pins, digests and the draft record'),
      fields([
        ['Draft record id', ed.draftId + ' (derived by Studio; you never type refs or hashes)'],
        ['Draft revision', String(ed.draftRevision)],
        ['Contract pin', ed.contract.ref], ['Contract sha256', ed.contract.sha256],
        ['Materializer', ed.options ? ed.options.materializer_id + ' · archive ' + ed.options.archive_sha256 : '—'],
        ['Normalized sha256 (last validation)', ed.report?.normalized_sha256 ?? 'Not validated yet'],
        ed.mode === 'revise' ? ['Previous revision (CAS pin)', ed.baseRef] : null,
        ['Project · repository', ed.scope.projectId + ' · ' + ed.scope.repositoryId]].filter(Boolean)),
      el('p', {class: 'muted'}, 'Draft record exactly as it will be submitted (BuildProfileInput — no server-authored receipt, actor or record fields are typed here):'),
      json(ed.options ? draftRecord(ed, ed.nameInput ? ed.nameInput.value : ed.name) : {note: 'options still loading'}));

    const gate = ed.nameInput ? nameGate(ed.nameInput.value) : null;
    const reportBlocksSave = ed.report && (!ed.report.repository_valid || materializerOpen(ed.report));
    const blocked = ed.busy || !!gate || !ed.options || reportBlocksSave || ed.staleHead || ed.staleView || ed.contractStale || ed.scopeStale || ed.revisionLimit || !!sessionMessage || !!writeBlockedMessage;
    replaceVisible(ed.actionsBox,
      el('button', {type: 'button', disabled: ed.busy, onclick: () => closeEditorSilently()}, 'Close editor'),
      el('button', {type: 'submit', disabled: blocked}, ed.busy ? 'Saving…' : ed.mode === 'create' ? 'Save new profile' : 'Save revision ' + (ed.baseRecord ? ed.baseRecord.revision + 1 : ed.draftRevision)),
      ed.staleHead ? el('button', {type: 'button', disabled: ed.busy, onclick: () => void reloadLatest(ed)}, 'Reload latest revision') : null,
      ed.staleView && !ed.staleHead ? el('button', {type: 'button', disabled: ed.busy, onclick: async () => { await refresh(); if (live() && editor === ed && !lookupError) { ed.staleView = false; scheduleValidate(ed); paintEditorRegions(ed); } }}, 'Reload repository view') : null);
  }

  // ---- Reads ------------------------------------------------------------

  async function refresh() {
    if (!api) { paint(); return; }
    listLoading = true; paint();
    try {
      const next = await api.compatibility({}, {signal: ctx.signal});
      if (!live()) return;
      const expected = ctx.state;
      if (next.context && expected?.repository_id && (next.context.repository_id !== expected.repository_id || expected.project_id && next.context.project_id !== expected.project_id))
        throw new Error('Ignored a compatibility response from another repository or project.');
      lookup = next; lookupError = null;
      const c = contextOf(next);
      if (editor && c) {
        if (c.repository_id !== editor.scope.repositoryId) editor.scopeStale = true;
        else if (c.contract.ref !== editor.contract.ref) editor.contractStale = true;
        paintEditorRegions(editor);
      }
      const page = await api.listProfiles({}, {signal: ctx.signal});
      if (!live()) return;
      const rid = c?.repository_id;
      if (rid && page.profiles.some(p => p.record.repository_id !== rid)) {
        listNotice = 'Ignored profiles from another repository (' + page.profiles.find(p => p.record.repository_id !== rid).record.repository_id + '). Keeping the previously loaded list.';
      } else { listItems = page.profiles; listCursor = page.cursor; listError = null; listNotice = null; }
    } catch (e) {
      if (!aborted(e) && live()) { readSessionRequired(e, editor); lookupError = errorText(e); listError = errorText(e); listNotice = null; }
    } finally {
      listLoading = false;
      if (live()) paint();
    }
  }

  async function loadMore() {
    if (listLoading || listCursor === null || listCursor === undefined) return;
    listLoading = true; paint();
    try {
      const page = await api.listProfiles({cursor: listCursor}, {signal: ctx.signal});
      if (!live()) return;
      const rid = contextOf(lookup)?.repository_id;
      if (rid && page.profiles.some(p => p.record.repository_id !== rid)) {
        listNotice = 'Ignored profiles from another repository. Keeping the previously loaded list.';
      } else { listItems = [...(listItems ?? []), ...page.profiles]; listCursor = page.cursor; }
    } catch (e) { if (!aborted(e) && live()) { if (!readSessionRequired(e, editor)) listNotice = 'Could not load more profiles: ' + errorText(e); } }
    finally { listLoading = false; if (live()) paint(); }
  }

  // ---- Session recovery (shell-owned) ------------------------------------

  async function recoverSession() {
    if (recoveryBusy || typeof ctx.sessionRecovery !== 'function') return;
    recoveryBusy = true; paint();
    try {
      const recovered = await ctx.sessionRecovery({reason: 'profiles-save'}) === true;
      if (!live()) return;
      if (recovered) {
        sessionMessage = null;
        ctx.announce?.('Session recovered. Saving is available again.');
        if (editor) {
          if (!editor.options) await ensureOptions(editor);
          else scheduleValidate(editor);
        } else await refresh();
      } else {
        sessionMessage = 'Session recovery did not complete. Your input is preserved; recover the session from the Studio shell, then continue.';
      }
    } catch { if (live()) sessionMessage = 'Session recovery failed. Your draft is preserved; recover through the Studio shell before saving.'; }
    finally { recoveryBusy = false; if (live()) paint(); }
  }

  // ---- Dirty navigation contract -----------------------------------------

  function hasUnsavedChanges() {
    if (!editor) return false;
    if (editor.busy) return true;
    return editor.mode === 'create' ? editor.name.trim().length > 0 : editor.name !== editor.baseRecord.name;
  }

  function beforeLeave() {
    if (editor?.busy) { setStatus(editor, 'A save is still being checked. Wait for its outcome before leaving; navigation does not cancel dispatched work.', 'error'); return Promise.resolve(false); }
    if (!hasUnsavedChanges()) return Promise.resolve(true);
    if (leaveDialog) return leaveDialog.promise;
    const trigger = document.activeElement;
    let resolve, settled = false;
    const promise = new Promise(r => resolve = r);
    const id = 'profiles-discard-' + crypto.randomUUID();
    const done = value => {
      if (settled) return; settled = true; leaveDialog = null;
      if (dialog.open) dialog.close(); dialog.remove();
      if (trigger?.isConnected) trigger.focus(); resolve(value);
    };
    const dialog = el('dialog', {class: 'proposal-dialog', 'aria-labelledby': id},
      el('h2', {id}, 'Leave with an unsaved draft?'),
      el('p', {}, 'Leaving discards this unsaved draft. Saved revisions stay unchanged; dispatched work is not cancelled.'),
      el('div', {class: 'toolbar'},
        el('button', {onclick: () => done(false)}, 'Keep editing (cancel)'),
        el('button', {onclick: () => { closeEditorSilently(); done(true); }}, 'Discard draft and leave')));
    dialog.addEventListener('cancel', e => { e.preventDefault(); done(false); });
    dialog.addEventListener('close', () => done(false));
    leaveDialog = {promise, cancel: () => done(false)};
    document.body.append(dialog); dialog.showModal();
    return promise;
  }

  root.start = () => {
    if (ctx.pendingOperation?.()) writeBlockedMessage = 'An earlier save requires reconciliation in its original repository in Review. No further saves are allowed from this page.';
    return refresh();
  };
  root.hasUnsavedChanges = hasUnsavedChanges;
  root.beforeLeave = beforeLeave;
  root.dispose = () => {
    disposed = true;
    leaveDialog?.cancel();
    if (editor) { clearTimeout(editor.timer); editor.controller?.abort(); }
    editor = null; detail = null; lookup = null; listItems = null;
    for (const key of Object.keys(optionsCache)) delete optionsCache[key]; // no old draft or option leakage across mounts
    root.replaceChildren();
  };

  paint();
  return root;
}
