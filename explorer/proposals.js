import { el, empty, pill, raw } from './dom.js';
import { blockTitle, graphFromRelease, relatedIds } from './semantic-model.js';
import { proposalCard } from './readable.js';
import { draftChange, draftText, makeLayerDraft } from './draft-model.js';
import { unconfirmedOperation,sessionRequired } from './operation-recovery.js';

export function modal(ctx, title) {
  if (document.querySelector('.proposal-dialog[open]')) return null;
  const trigger = document.activeElement;
  const id = 'proposal-dialog-' + ctx.unique();
  const dialog = el('dialog', { class: 'proposal-dialog', 'aria-labelledby': id });
  const close = () => dialog.close();
  dialog.append(el('div', { class: 'dialog-head' }, el('h2', { id }, title), el('button', { onclick: close }, 'Cancel')));
  const invalidate = () => { if (dialog.open) dialog.close(); };
  window.addEventListener('strata:connection-change', invalidate);
  window.addEventListener('strata:view-change', invalidate);
  dialog.addEventListener('close', () => {
    window.removeEventListener('strata:connection-change', invalidate); window.removeEventListener('strata:view-change', invalidate);
    dialog.remove(); if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  document.body.append(dialog);
  return dialog;
}
export async function copyText(text, output, message) {
  try { await navigator.clipboard.writeText(text); output.textContent = message; }
  catch { output.replaceChildren(el('p', {}, 'Clipboard unavailable. Select and copy this text:'), el('textarea', { readonly: true, rows: 8, 'aria-label': 'Text to copy', value: text })); }
}
function projected(change) { return { ...change, baseline_value: { exists: change.expected.kind === 'value', value: change.expected.value } }; }

export function openProposal(ctx, release, selected) {
  const dialog = modal(ctx, 'Prepare an owned Layer proposal');
  if (!dialog) return;
  const retained=ctx.pendingOperation?.();
  if(retained){dialog.append(el('p',{class:'notice'},'An earlier operation has an unconfirmed outcome. Inspect its original request before saving another draft.'),el('p',{},'Original repository: ',el('code',{},retained.connection_id)),el('a',{href:ctx.href('review',{ref:''})},'Open operation recovery'));dialog.showModal();return;}
  const contentModel = release.model_version !== 'strata/0.1-facets-experimental';
  const error = el('p', { class: 'form-error', role: 'alert',tabindex:'-1' }), message = el('div', { role: 'status' });
  const changes = [], criteria = [], pending = el('div'), review = el('div');
  let reviewed = null,unresolved=false;
  const saveState=el('p',{},'This proposal has not been saved, selected, validated or published. Review its exact values before saving the owned draft or copying it to the CLI.');
  const owner = el('input', { name: 'owner', required: true, maxlength: 128, placeholder: 'Your authenticated Strata principal', value:ctx.workflow?.principal_id??'', readonly:!!ctx.workflow });
  const layerId = el('input', { name: 'layer-id', required: true, maxlength: 128, placeholder: 'L-feature-name' });
  const intent = el('textarea', { name: 'intent', required: true, rows: 2, maxlength: 4096, placeholder: 'What should change, and why?' });
  const blocks = Object.values(release.blocks ?? {});
  const blockSelect = el('select', { 'aria-label': 'Proposal Block' }, blocks.map(b => el('option', { value: b.id, selected: b.id === selected }, `${blockTitle(b.id)} · ${b.id}`)));
  const itemSelect = el('select', { 'aria-label': 'Proposal item' });
  const editor = el('div', { class: 'proposal-editor' });
  let readEditor;
  const invalidateReview = () => { reviewed = null; review.replaceChildren(); message.replaceChildren(); };
  const renderEditor = () => {
    invalidateReview();
    const b = release.blocks[blockSelect.value], path = itemSelect.value;
    if (!b) { editor.replaceChildren(empty('There are no existing Blocks to patch.')); readEditor = () => { throw new Error('This baseline has no Blocks.'); }; return; }
    if (path === 'purpose') {
      const input = el('textarea', { rows: 4, 'aria-label': 'Proposed purpose', value: b.purpose, maxlength: 4096 });
      editor.replaceChildren(el('label', {}, 'Proposed purpose', input));
      readEditor = () => ({ block: b.id, path, value: draftText(input.value, 'Purpose', contentModel) });
      return;
    }
    const existing = path === 'new' ? null : b.requirements[path.slice(13)];
    const key = el('input', { 'aria-label': 'New requirement key', placeholder: 'clear_requirement_name', maxlength: 128 });
    const statement = el('textarea', { rows: 3, 'aria-label': 'Requirement statement', value: existing?.statement ?? '', maxlength: 4096 });
    const kind = el('select', { 'aria-label': 'Requirement kind' }, ['rule', 'invariant'].map(k => el('option', { value: k, selected: k === existing?.kind }, blockTitle(k))));
    const facets = ['behavior', 'design', 'data', 'safety'].map(f => ({ f, input: el('input', { type: 'checkbox', checked: (existing?.facets ?? ['behavior']).includes(f), 'aria-label': `Requirement facet ${f}` }) }));
    const acceptance = Object.keys(b.acceptance).map(k => ({ k, input: el('input', { type: 'checkbox', checked: existing?.acceptance.includes(k), 'aria-label': `Link criterion ${k}` }) }));
    const parameters = Object.entries(existing?.parameters ?? {}).map(([k, v]) => ({ k, v, input: typeof v === 'number' ? el('input', { type: 'number', step: 'any', value: v, 'aria-label': `Parameter ${k}` }) : typeof v === 'boolean' ? el('input', { type: 'checkbox', checked: v, 'aria-label': `Parameter ${k}` }) : null }));
    const addCriterion = el('input', { type: 'checkbox', 'aria-label': 'Add new acceptance criterion' });
    const criterionKey = el('input', { 'aria-label': 'Acceptance key', placeholder: 'feature_check' });
    const criterionStatement = el('textarea', { rows: 2, 'aria-label': 'Acceptance statement', maxlength: 4096 });
    const check = el('input', { 'aria-label': 'Acceptance check', placeholder: 'registered.check.id' });
    const version = el('input', { 'aria-label': 'Acceptance check version', placeholder: '1' });
    const fixture = el('input', { 'aria-label': 'Acceptance fixture', placeholder: 'registered fixture ID' });
    const method = el('select', { 'aria-label': 'Acceptance method' }, el('option', { value: 'review' }, 'Review'), el('option', { value: 'mechanical' }, 'Mechanical'));
    const criterionFields = el('div', { class: 'criterion-fields', hidden: true }, el('p', { class: 'muted' }, 'Name an actual check and fixture supported by your realization profile. This form does not implement or execute the check.'), el('label', {}, 'Unique acceptance key', criterionKey), el('label', {}, 'Acceptance statement', criterionStatement), el('div', { class: 'form-grid' }, el('label', {}, 'Check', check), el('label', {}, 'Version', version), el('label', {}, 'Fixture', fixture), el('label', {}, 'Method', method)));
    addCriterion.addEventListener('change', () => { criterionFields.hidden = !addCriterion.checked; });
    editor.replaceChildren(el('div', {}, path === 'new' ? el('label', {}, 'New requirement key', key) : el('p', { class: 'muted' }, `Complete replacement of ${path}. Linked inherited acceptance remains required.`), el('label', {}, 'Requirement statement', statement), el('label', {}, 'Kind', kind), el('fieldset', {}, el('legend', {}, 'Facets'), facets.map(({ f, input }) => el('label', { class: 'check-label' }, input, blockTitle(f)))), parameters.length ? el('fieldset', {}, el('legend', {}, 'Parameters'), parameters.map(({ k, input, v }) => el('label', {}, k, input ?? el('p', { class: 'muted' }, 'Preserved: ' + JSON.stringify(v))))) : null, el('fieldset', {}, el('legend', {}, 'Acceptance criteria'), acceptance.map(({ k, input }) => el('label', { class: 'check-label' }, input, k)), el('label', { class: 'check-label' }, addCriterion, 'Add new acceptance criterion'), criterionFields)));
    readEditor = () => {
      const itemKey = path === 'new' ? key.value.trim() : path.slice(13);
      if (!/^[A-Za-z0-9_-]+$/.test(itemKey)) throw new Error('Requirement keys use letters, numbers, underscores and hyphens.');
      if (path === 'new' && Object.hasOwn(b.requirements, itemKey)) throw new Error('That requirement exists. Select it from the item list to edit it.');
      const linked = acceptance.filter(a => a.input.checked).map(a => a.k);
      if (contentModel && existing?.acceptance.some(k => !linked.includes(k))) throw new Error('Inherited acceptance cannot be removed.');
      const parameterValues = structuredClone(existing?.parameters ?? {});
      for (const { k, input, v } of parameters) if (input) {
        if (typeof v === 'number') { if (!input.value.trim() || !Number.isFinite(Number(input.value))) throw new Error(`Parameter ${k} needs a finite number.`); parameterValues[k] = Number(input.value); }
        else parameterValues[k] = input.checked;
      }
      let criterion;
      if (addCriterion.checked) {
        const id = criterionKey.value.trim(); linked.push(id);
        criterion = { block: b.id, id, criterion: { statement: criterionStatement.value.trim(), check: check.value.trim(), version: version.value.trim(), fixture: fixture.value.trim(), method: method.value, subjects: [`${b.id}/requirements.${itemKey}`] } };
      }
      return { block: b.id, path: 'requirements.' + itemKey, value: { statement: draftText(statement.value, 'Requirement statement', contentModel), kind: kind.value, facets: facets.filter(f => f.input.checked).map(f => f.f), acceptance: linked, parameters: parameterValues }, criterion };
    };
  };
  const renderItems = () => { const b = release.blocks[blockSelect.value]; itemSelect.replaceChildren(el('option', { value: 'purpose' }, 'Purpose'), ...Object.keys(b?.requirements ?? {}).map(key => el('option', { value: 'requirements.' + key }, 'Rule: ' + key)), el('option', { value: 'new' }, 'Add a requirement')); renderEditor(); };
  blockSelect.addEventListener('change', renderItems); itemSelect.addEventListener('change', renderEditor);
  function renderPending() {
    pending.replaceChildren(...changes.map((change, i) => el('div', { class: 'pending-change' }, el('span', {}, `${change.block} / ${change.path}`), el('button', { type: 'button', 'aria-label': `Remove ${change.block}/${change.path}`, onclick: () => { const removed = changes.splice(i, 1)[0]; for (let j = criteria.length - 1; j >= 0; j--) if (criteria[j].criterion.subjects.includes(`${removed.block}/${removed.path}`)) criteria.splice(j, 1); invalidateReview(); renderPending(); } }, 'Remove'))));
  }
  const form = el('form', { onsubmit: async event => {
    event.preventDefault(); if(unresolved)return;error.textContent = '';
    try {
      ctx.check();
      reviewed = makeLayerDraft(release, { id: layerId.value.trim(), owner: owner.value.trim(), intent: intent.value, changes, acceptance: criteria });
      if (ctx.releases.some(r => r.ref === `${reviewed.id}@1`)) throw new Error('That record reference exists; choose a new Layer ID.');
      if(ctx.workflow) {const preview=await ctx.workRead('preview',{record:reviewed});ctx.check();reviewed=preview.record;}
      const graph = graphFromRelease(release), affected = [...new Set(changes.map(c => c.block))];
      const context = new Set(affected.flatMap(id => [...relatedIds(graph, id)]).filter(id => !affected.includes(id)));
      review.replaceChildren(el('h3', { tabindex: '-1' }, 'Review before handoff'), el('p', {}, `${changes.length + criteria.length} proposed items across ${affected.length} Blocks. Requested owner: ${reviewed.owner}.`), el('p', { class: 'muted' }, `Connected Blocks to review (not predicted changes): ${[...context].join(', ') || 'None'}.`), ...changes.map(c => proposalCard(ctx, projected(c))), ...criteria.map(a => proposalCard(ctx, {block:a.block,path:'acceptance.'+a.id,value:a.criterion,expected:{kind:'absent'},baseline_value:{exists:false}})), raw(reviewed), saveState, el('div', { class: 'toolbar' }, el('button', { type: 'button', class: 'primary-button', onclick: async () => { try { ctx.check(); if (!reviewed) throw new Error('Review the edited draft first.'); await copyText(JSON.stringify(reviewed, null, 2), message, 'Layer draft copied. The repository is unchanged.'); } catch (e) { error.textContent = e.message; } } }, 'Copy Layer draft'), el('button', { type: 'button', 'data-studio-command':'layer.create',disabled: !ctx.workflow?.operations?.some(o=>o.operation==='layer.create'&&o.configured&&o.authorized), onclick:async event=>{event.target.disabled=true;try{ctx.check();const result=await ctx.command('layer.create',{record:reviewed});saveState.textContent='Saved as an owned private draft. Selection, validation, publication and Release approval remain separate.';message.replaceChildren(el('p',{role:'status'},'Saved '+result.data.ref),el('a',{href:ctx.href('review',{ref:result.data.ref})},'Review saved proposal'));}catch(e){error.textContent=(e.code?e.code+': ':'')+e.message;unresolved=unconfirmedOperation(e)||sessionRequired(e);if(unresolved){form.querySelectorAll('input,textarea,select,button').forEach(node=>{if(node.textContent!=='Copy Layer draft')node.disabled=true;});message.replaceChildren();if(sessionRequired(e))ctx.sessionRecovery?.(message);if(unconfirmedOperation(e))message.append(el('p',{},'The original request is retained. Checking its receipt does not repeat the save.'),el('a',{href:ctx.href('review',{ref:''})},'Open operation recovery'));}else event.target.disabled=false;error.focus({preventScroll:true});error.scrollIntoView({block:'nearest'});}} }, ctx.workflow?'Save owned draft':'Save to repository unavailable')));
      review.querySelector('h3').focus();
    } catch (e) { reviewed = null; error.textContent = e.name === 'AbortError' ? 'The view changed. Reopen the proposal on the current connection.' : e.message;if(sessionRequired(e)){message.replaceChildren();ctx.sessionRecovery?.(message);}error.focus({preventScroll:true});error.scrollIntoView({block:'nearest'}); }
  } }, el('p', {}, 'Prepare a draft against ', el('code', {}, release.ref), '. Your Release stays immutable.'), el('p', { class: 'muted' }, 'Drafts exist only in this dialog until you save or copy them. Cancel before saving discards them. The server verifies the exact principal and baseline.'), el('div', { class: 'form-grid' }, el('label', {}, 'New Layer ID', layerId), el('label', {}, 'Requested Layer owner', owner)), el('label', {}, 'Intent', intent), el('div', { class: 'form-grid' }, el('label', {}, 'Block', blockSelect), el('label', {}, 'Item', itemSelect)), editor,
  el('button', { type: 'button', onclick: () => {
    error.textContent = ''; invalidateReview();
    try {
      ctx.check(); const input = readEditor(), change = draftChange(release, input);
      if (changes.some(c => c.block === change.block && c.path === change.path)) throw new Error('This item is already in your draft. Remove it before adding an updated version.');
      // Run the same form checks used at review, with temporary valid metadata.
      makeLayerDraft(release, { id: 'L-check', owner: 'pending-owner', intent: 'Pending review', changes: [...changes, change], acceptance: [...criteria, ...(input.criterion ? [input.criterion] : [])] });
      changes.push(change); if (input.criterion) criteria.push(input.criterion); renderPending();
      message.textContent = 'Added to this local draft. Nothing has been saved to the repository.';
    } catch (e) { error.textContent = e.message; }
  } }, 'Add item to draft'), pending, error, el('button', { type: 'submit', class: 'primary-button' }, 'Review draft'), review, message);
  for (const input of [owner, layerId, intent]) input.addEventListener('input', invalidateReview);
  renderItems(); dialog.append(form, el('p', { class: 'muted' }, 'New Blocks are not supported by the current Layer contract. Use “Describe a feature” to prepare a new-Block request for your agent.')); dialog.showModal();
}

export function openFeatureRequest(ctx, release, graph) {
  const dialog = modal(ctx, 'Describe a feature');
  if (!dialog) return;
  const request = el('textarea', { rows: 3, maxlength: 4096, required: true, placeholder: 'What should the application do?', 'aria-label': 'Feature request' });
  const output = el('div'), error = el('p', { role: 'alert', class: 'form-error' });
  const blocks = [...graph.nodes.values()].map(b => ({ b, input: el('input', { type: 'checkbox', checked: b.id === ctx.state.block, 'aria-label': `Request context ${b.id}` }) }));
  const invalidate = () => output.replaceChildren();
  request.addEventListener('input', invalidate); blocks.forEach(({ input }) => input.addEventListener('change', invalidate));
  const form = el('form', { onsubmit: event => {
    event.preventDefault(); error.textContent = '';
    try {
      ctx.check(); const feature = draftText(request.value, 'Feature request');
      const selected = blocks.filter(({ input }) => input.checked).map(({ b }) => b);
      const handoff = ['Strata feature request — human-authored, not an agent-generated plan', `Project: ${ctx.connection?.project_id ?? 'Use the connected project'}`, `Baseline: ${release.ref}`, `Model: ${release.model_version}`, '', feature, '', 'Human-selected context Blocks:', ...selected.map(b => `- ${b.id}: ${b.purpose}`), selected.length ? '' : '- None selected; ask the author to establish scope.', '', 'Inspect these exact baseline Blocks and their declared relationships. Propose the affected items and owned Layers for review before any write. Use the same authenticated Strata repository and its layer.create/revise validation. Do not mutate the Release, invent ownership, publish, approve, or deploy. New Block creation is unsupported by the current Layer set_item contract; report that limitation if required.'].join('\n');
      output.replaceChildren(el('h3', {}, 'Ready to hand to your agent'), el('p', {}, `${selected.length} context Blocks selected by you. No affected items have been predicted and no agent has run.`), ...selected.map(b => el('p', {}, pill('Context only'), ' ', el('code', {}, b.id), ' — ', b.purpose)), el('textarea', { readonly: true, rows: 10, 'aria-label': 'Agent handoff', value: handoff }), el('button', { type: 'button', class: 'primary-button', onclick: async () => { try { ctx.check(); await copyText(handoff, error, 'Handoff copied. Paste it into your authorized agent.'); } catch { error.textContent = 'The connection changed. Reopen this request.'; } } }, 'Copy agent handoff'));
    } catch (e) { error.textContent = e.message; }
  } }, el('p', {}, 'Prepare a request against ', el('code', {}, release.ref), '.'), el('p', { class: 'notice' }, 'Agent chat is not connected. This prepares an explicit handoff for your existing agent; it does not send a message or generate a plan.'), el('label', {}, 'Feature request', request), el('details', { open: true }, el('summary', {}, 'Choose context Blocks yourself'), el('div', { class: 'context-block-choices' }, blocks.map(({ b, input }) => el('label', { class: 'check-label' }, input, el('span', {}, blockTitle(b.id), el('small', {}, b.id)))))), error, el('button', { type: 'submit', class: 'primary-button' }, 'Prepare agent handoff'), output);
  dialog.append(form); dialog.showModal();
}
