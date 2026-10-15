import { el, pill, facets, raw, empty, titleCase } from './dom.js';

// Render record values as text nodes, never interpreted HTML or Markdown.
export function readableValue(value) {
  if (value === null) return el('p', {}, 'None');
  if (typeof value !== 'object') return el('p', { class: 'intent-statement' }, String(value));
  if (Array.isArray(value)) return value.length ? el('ul', {}, value.map(v => el('li', {}, readableValue(v)))) : empty('None recorded.');
  const primary = value.statement ?? value.text;
  const known = new Set(['statement', 'text', 'kind', 'facets', 'acceptance', 'parameters', 'target', 'subjects', 'method', 'check', 'version', 'fixture', 'format']);
  return el('div', { class: 'readable-value' },
    value.kind ? pill(titleCase(value.kind), value.kind) : null,
    primary ? el('p', { class: 'intent-statement' }, primary) : null,
    value.target ? el('p', {}, 'Related Block: ', el('code', {}, value.target)) : null,
    value.facets ? facets(value.facets) : null,
    value.parameters && Object.keys(value.parameters).length ? el('dl', { class: 'parameter-list' }, Object.entries(value.parameters).map(([key, v]) => el('div', {}, el('dt', {}, titleCase(key.replaceAll('_', ' '))), el('dd', {}, typeof v === 'object' ? readableValue(v) : String(v))))) : null,
    value.acceptance ? el('p', { class: 'muted' }, value.acceptance.length ? 'Acceptance: ' + value.acceptance.join(', ') : 'No acceptance linked.') : null,
    value.method ? el('p', { class: 'muted' }, `${titleCase(value.method)} · ${value.check}@${value.version} · ${value.fixture}`) : null,
    value.subjects ? el('p', { class: 'muted' }, 'Checks: ' + value.subjects.join(', ')) : null,
    Object.entries(value).filter(([key]) => !known.has(key)).map(([key, v]) => el('div', { class: 'field' }, el('strong', {}, titleCase(key.replaceAll('_', ' '))), readableValue(v))));
}
export function proposalCard(ctx, proposal, baseline = ctx.state.at) {
  return el('article', { class: 'card proposal-card' },
    el('div', { class: 'card-head' }, el('h3', {}, el('a', { href: ctx.href('blocks', { at: baseline, block: proposal.block, item: proposal.path, view: 'outline', layer: '' }) }, proposal.block), el('small', {}, ' / ' + proposal.path)), pill(proposal.baseline_value?.exists ? 'Change' : 'Add', 'proposal')),
    el('div', { class: 'values' },
      el('div', {}, el('h4', {}, 'Baseline'), proposal.baseline_value?.exists ? readableValue(proposal.baseline_value.value) : empty('Not present in the baseline.')),
      el('div', {}, el('h4', {}, 'Proposed'), readableValue(proposal.value))),
    el('details', {}, el('summary', {}, 'Exact precondition and item'), raw({ expected: proposal.expected, value: proposal.value })));
}
