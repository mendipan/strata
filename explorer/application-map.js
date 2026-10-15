import { el, pill, facets, empty, raw, refLink } from './dom.js';
import { graphFromRelease, mapSlice, layoutCards, neighbors, relatedIds, blockTitle, proposalsByBlock, proposalSnapshot } from './semantic-model.js';
import { readableValue, proposalCard } from './readable.js';
import { openProposal, openFeatureRequest } from './proposals.js';

const edgeNames = { relationship: 'Declared relationship', containment: 'Parent contains child', acceptance: 'Acceptance cross-reference (derived)' };
const svgNode = (tag, attrs = {}, text) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  return node;
};

export async function applicationMap(ctx, releasePicker) {
  const at = ctx.state.at;
  const [release, layers, matches] = await Promise.all([
    ctx.api('record', { type: 'release', ref: at }),
    ctx.all('records', { type: 'layer', baseline: at }),
    ctx.all('blocks', { at, text: ctx.state.text, facets: ctx.state.facets.join(','), match: ctx.state.match, authority: ctx.state.authority })
  ]);
  ctx.check();
  let layer = null;
  if (ctx.state.layer) {
    if (layers.items.some(l => l.ref === ctx.state.layer)) layer = await ctx.api('record', { type: 'layer', ref: ctx.state.layer });
    else throw Object.assign(new Error('This Layer is not visible on the selected baseline. Choose its exact baseline first.'), { code: 'REF_NOT_FOUND' });
  }
  let detail = null;
  if (ctx.state.block && release.blocks[ctx.state.block]) detail = await ctx.api('block', { at, id: ctx.state.block });
  ctx.check();
  const proposed=!!layer&&ctx.state.view==='proposal', shown=proposed?proposalSnapshot(release,layer):release;
  const graph = graphFromRelease(shown), changed = proposalsByBlock(layer), matching = new Set(matches.items.map(b => b.id));
  if(proposed&&!ctx.state.text&&!ctx.state.facets.length)for(const id of graph.nodes.keys())matching.add(id);
  if(proposed&&ctx.state.block&&shown.blocks[ctx.state.block]){const b=shown.blocks[ctx.state.block];detail={...(detail??{at,provenance:[],authority:{nearest_scope:null}}),block:b,direct_facets:[...new Set(Object.values(b.requirements).flatMap(r=>r.facets))]};}
  const selected = ctx.state.block, related = relatedIds(graph, selected);
  let page = 0, neighborhood = !!selected, zoom = 1, showContainment = true, showAcceptance = false, listMode = false;
  const surface = el('div', { class: 'map-surface' });
  const viewport = el('div', { class: 'map-viewport', tabindex: '0', role: 'region', 'aria-label': 'Application map. Scroll to pan. Tab to Blocks; Enter to open. Arrow keys pan the canvas.' }, surface);
  const mapStatus = el('p', { class: 'muted map-status', 'aria-live': 'polite' });
  const previous = el('button', { onclick: () => { page--; draw(); viewport.scrollTo(0, 0); } }, 'Previous Blocks');
  const next = el('button', { onclick: () => { page++; draw(); viewport.scrollTo(0, 0); } }, 'Next Blocks');
  const zoomStatus = el('output', { 'aria-label': 'Map zoom' }, '100%');
  let geometry, world;
  const applyZoom = () => {
    if (!world || listMode) return;
    world.style.transform = `scale(${zoom})`; surface.style.width = `${geometry.width * zoom}px`; surface.style.height = `${geometry.height * zoom}px`; zoomStatus.textContent = `${Math.round(zoom * 100)}%`;
  };
  function draw() {
    const slice = mapSlice(graph, { selected, matching, neighborhood, page }); page = slice.page;
    geometry = layoutCards(slice.ids, selected, graph);
    world = el('div', { class: 'map-world' }); world.style.width = `${geometry.width}px`; world.style.height = `${geometry.height}px`;
    const svg = svgNode('svg', { class: 'map-edges', width: geometry.width, height: geometry.height, 'aria-hidden': 'true' });
    const definitions = svgNode('defs');
    for (const kind of Object.keys(edgeNames)) {
      const marker = svgNode('marker', { id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      marker.append(svgNode('path', { d: 'M1 1L9 5L1 9Z', class: `arrow-fill ${kind}` })); definitions.append(marker);
    }
    svg.append(definitions);
    const visible = new Set(slice.ids);
    const candidates = graph.edges.filter(e => visible.has(e.source) && visible.has(e.target) && (e.kind !== 'containment' || showContainment) && (e.kind !== 'acceptance' || showAcceptance));
    // Avoid unbounded SVG work on dense graphs; full relation lists remain available.
    const shownEdges = (selected ? [...candidates.filter(e => e.source === selected || e.target === selected), ...candidates.filter(e => e.source !== selected && e.target !== selected)] : candidates).slice(0, 160);
    shownEdges.forEach((edge, i) => {
      const a = geometry.positions.get(edge.source), b = geometry.positions.get(edge.target);
      const isSelected = edge.source === selected || edge.target === selected;
      let d;
      if (edge.source === edge.target) d = `M${a.x + 235} ${a.y}C${a.x + 315} ${a.y - 38},${a.x + 320} ${a.y + 55},${a.x + 278} ${a.y + 55}`;
      else if (a.x === b.x) {
        const x = a.x + 278, ay = a.y + 75, by = b.y + 150, bend = x + 25 + i % 3 * 8;
        d = `M${x} ${ay}C${bend} ${ay},${bend} ${by},${x} ${by}`;
      } else {
        const forward = a.x < b.x, ax = a.x + (forward ? 278 : 0), bx = b.x + (forward ? 0 : 278), ay = a.y + 102 + i % 3 * 12, by = b.y + 102 + i % 3 * 12, mid = (ax + bx) / 2;
        d = `M${ax} ${ay}C${mid} ${ay},${mid} ${by},${bx} ${by}`;
      }
      const path = svgNode('path', { d, class: `semantic-edge ${edge.kind}${isSelected ? ' connected' : selected ? ' subdued' : ''}`, 'marker-end': `url(#arrow-${edge.kind})` });
      path.append(svgNode('title', {}, `${edge.source} → ${edge.target}: ${edge.key}. ${edge.statement}`)); svg.append(path);
      if (isSelected && edge.kind === 'relationship') {
        const label = edge.key.length > 20 ? edge.key.slice(0, 18) + '…' : edge.key;
        const x = a.x === b.x ? a.x + 290 : (a.x + b.x + 278) / 2;
        const y = (a.y + b.y) / 2 + 88 + i % 3 * 16;
        svg.append(svgNode('rect', { x: x - label.length * 3.2 - 4, y: y - 12, width: label.length * 6.4 + 8, height: 17, rx: 3, class: 'edge-label-background' }), svgNode('text', { x, y, 'text-anchor': 'middle', class: 'edge-label' }, label));
      }
    });
    world.append(svg);
    for (const id of slice.ids) {
      const b = graph.nodes.get(id), p = geometry.positions.get(id), requirements = Object.values(b.requirements ?? {}), count = Object.keys(b.acceptance ?? {}).length;
      const card = el('a', { class: `intent-block${id === selected ? ' selected' : related.has(id) ? ' related' : selected ? ' distant' : ''}${changed.has(id) ? ' changed' : ''}`, href: ctx.href('blocks', { block: id, layer: ctx.state.layer, view: 'map' }), 'aria-current': id === selected ? 'true' : undefined, 'aria-label': `Open Block ${id}: ${b.purpose}` },
        el('div', { class: 'intent-block-top' }, el('span', { class: 'eyebrow' }, 'Block'), changed.has(id) ? pill(`${changed.get(id).length} proposed`, 'proposal') : b.parent === null ? pill('Root') : null),
        el('h3', {}, blockTitle(id)), el('code', { class: 'block-id' }, id),
        el('p', { class: 'block-purpose' }, b.purpose),
        el('div', { class: 'block-card-footer' }, el('span', {}, `${requirements.length} rules · ${count} criteria`), el('span', { class: 'facet-dots', 'aria-label': [...new Set(requirements.flatMap(r => r.facets))].join(', ') }, [...new Set(requirements.flatMap(r => r.facets))].map(f => el('i', { class: f, title: f })))),
        el('small', { class: 'block-parent' }, !matching.has(id) ? 'Selected context · outside filter' : b.parent ? `Within ${b.parent}` : 'Application boundary'));
      card.style.left = `${p.x}px`; card.style.top = `${p.y}px`; world.append(card);
    }
    viewport.classList.toggle('as-list', listMode);
    surface.replaceChildren(world); applyZoom();
    if (listMode) { surface.style.width = ''; surface.style.height = ''; }
    if (!slice.ids.length) { surface.style.width = ''; surface.style.height = ''; surface.replaceChildren(empty(graph.nodes.size ? 'No Blocks match. Clear the filters to return to the application.' : 'This Release contains no Blocks.')); }
    mapStatus.textContent = `${slice.total} ${neighborhood && selected ? 'Blocks in this neighborhood' : 'matching Blocks'} · ${slice.ids.length ? page * 48 + 1 : 0}–${Math.min((page + 1) * 48, slice.total)} shown${shownEdges.length < candidates.length ? ' · Some lines omitted; complete relationships are in the focused Block.' : ''}`;
    previous.disabled = page === 0; next.disabled = page === slice.pages - 1;
  }
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport) return;
    const offsets = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] };
    if (offsets[event.key]) { event.preventDefault(); viewport.scrollBy(...offsets[event.key]); }
  });
  // Drag only the canvas background. Links retain native click and keyboard behavior.
  let drag = null;
  viewport.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('a,button') || listMode) return;
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', event => { if (drag) viewport.scrollTo(drag.left + drag.x - event.clientX, drag.top + drag.y - event.clientY); });
  const endDrag = () => { drag = null; };
  viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag); viewport.addEventListener('lostpointercapture', endDrag);
  const toggle = (label, value, change) => el('label', { class: 'map-toggle' }, el('input', { type: 'checkbox', checked: value, onchange: e => { change(e.target.checked); draw(); } }), label);
  const toolbar = el('div', { class: 'map-tools' },
    el('div', { class: 'map-zoom' }, el('button', { 'aria-label': 'Zoom out', onclick: () => { zoom = Math.max(.5, zoom - .15); applyZoom(); } }, '−'), zoomStatus, el('button', { 'aria-label': 'Zoom in', onclick: () => { zoom = Math.min(1.6, zoom + .15); applyZoom(); } }, '+'), el('button', { onclick: () => { zoom = Math.max(.5, Math.min(1, (viewport.clientWidth - 16) / geometry.width)); applyZoom(); viewport.scrollTo(0, 0); } }, 'Fit'), el('button', { onclick: () => { zoom = 1; applyZoom(); viewport.scrollTo(0, 0); } }, '100%')),
    selected ? toggle('Only neighborhood', neighborhood, v => { neighborhood = v; page = 0; }) : null,
    toggle('Card list', listMode, v => { listMode = v; }), previous, next);
  const layerChoice = el('select', { 'aria-label': 'Preview a Layer', onchange: e => ctx.navigate('blocks', { layer: e.target.value, view:ctx.state.view==='proposal'?'proposal':'map' }) }, el('option', { value: '' }, 'Baseline only'), layers.items.map(l => el('option', { value: l.ref, selected: l.ref === ctx.state.layer }, `${l.ref} · ${l.owner} · ${l.proposed_item_count} items${l.published ? '' : ' · draft'}`)));
  const filters = el('div', { class: 'map-filters' },
    el('label', {}, 'Find a Block', el('input', { id: 'map-search', type: 'search', value: ctx.state.text, placeholder: 'Purpose, rule or Block ID', oninput: e => ctx.filter({ text: e.target.value }, 'map-search') })),
    el('div', { class: 'facets' }, ['behavior', 'design', 'data', 'safety'].map(f => el('button', { class: `facet-filter ${f}`, 'aria-pressed': ctx.state.facets.includes(f) ? 'true' : 'false', onclick: () => ctx.filter({ facets: ctx.state.facets.includes(f) ? ctx.state.facets.filter(x => x !== f) : [...ctx.state.facets, f] }) }, blockTitle(f)))),
    ctx.state.text || ctx.state.facets.length || ctx.state.authority ? el('button', { class: 'text-button', onclick: () => ctx.filter({ text: '', facets: [], authority: '' }) }, 'Clear filters') : null);
  draw();
  requestAnimationFrame(() => {
    if (viewport.isConnected && viewport.clientWidth > 0) {
      zoom = viewport.clientWidth < 600 ? 1 : Math.max(.8, Math.min(1, (viewport.clientWidth - 12) / geometry.width)); applyZoom();
      if (selected && geometry.positions.has(selected)) {
        const p = geometry.positions.get(selected);
        viewport.scrollTo(Math.max(0, p.x * zoom - (viewport.clientWidth - 278 * zoom) / 2), Math.max(0, p.y * zoom - 35));
      }
    }
  });
  return el('div', { class: 'application-page' },
    el('div', { class: 'application-heading' }, el('div', {}, el('p', { class: 'eyebrow' }, 'Your application, as intent'), el('h1', { tabindex: '-1' }, 'Application map'), el('p', { class: 'muted' }, `${graph.nodes.size} Blocks · ${graph.edges.filter(e => e.kind === 'relationship').length} declared relationships · ${proposed?'Proposed intent only':release.status.publication}`)),
      el('div', { class: 'application-actions' }, el('button', { onclick: () => openFeatureRequest(ctx, release, graph) }, 'Describe a feature'), el('button', { class: 'primary-button', onclick: () => openProposal(ctx, release, selected) }, 'Prepare a proposal'))),
    el('div', { class: 'map-selection' }, releasePicker(ctx), el('label', {}, 'Preview a Layer against this Release', layerChoice), el('a', { class: 'view-switch', href: ctx.href('blocks', { block: selected, view: 'outline', layer: '' }) }, 'Outline & full details')),
    layer ? el('div', { class: 'layer-overlay-notice' }, pill('Proposal overlay', 'proposal'), el('strong', {}, layer.intent), el('p', {}, `${changed.size} Blocks touched by ${layer.owner}. ${proposed?'Proposed values are foregrounded; accepted baseline is unchanged.':'Baseline cards with change markers.'} This is an unselected proposal; selection, validation and approval are separate.`), refLink(ctx, layer.ref, 'layer'), el('div',{class:'toolbar'},el('a',{href:ctx.href('blocks',{view:proposed?'map':'proposal',layer:layer.ref})},proposed?'Read accepted baseline':'Read proposed intent'),ctx.workflow&&(layer.published||layer.owner===ctx.workflow.principal_id)?el('a',{href:ctx.href('review',{ref:layer.ref})},'Review proposal'):el('a',{href:ctx.href('layers',{ref:layer.ref,type:'layer'})},layer.published===false?'Inspect imported draft':'Inspect Layer')),layer.published===false&&layer.owner!==ctx.workflow?.principal_id?el('p',{},'This retained draft belongs to ',el('code',{},layer.owner),'. Inspect its proposed content here, or create a separate owned draft in Changes. Its workflow Review page is available to its recorded author.'):null) : null,
    filters,
    el('div', { class: `map-workspace${selected ? ' has-selection' : ''}` },
      el('section', { class: 'map-panel', 'aria-label': 'Release application map' },
        el('div', { class: 'map-legend' }, el('span', { class: 'legend-line relationship' }, '→ Declared relationship'), toggle('Parent → child', showContainment, v => { showContainment = v; }), toggle('Acceptance references · derived', showAcceptance, v => { showAcceptance = v; })),
        toolbar, viewport, mapStatus, el('p', { class: 'map-help muted' }, 'Cards are ordered by declared relationship neighborhoods. Position and proximity do not imply a dependency. Select a Block to read every relationship and its meaning.'),
        graph.warnings.length ? el('div', { class: 'notice' }, graph.warnings.map(w => el('p', {}, w))) : null),
      detail ? focusedBlock(ctx, detail, graph, release, changed.get(selected) ?? []) : el('aside', { class: 'map-introduction' }, el('span', { class: 'eyebrow' }, 'Read the application'), el('h2', {}, 'Every Block has a reason.'), el('p', {}, 'Open a card to read what it promises, what must hold, and how it relates to its neighbors.'), el('ol', {}, el('li', {}, 'Explore an exact, immutable Release.'), el('li', {}, 'Preview what an owned Layer proposes.'), el('li', {}, 'Prepare a change for review.')))));
}

function focusedBlock(ctx, data, graph, release, changes) {
  const b = data.block, relations = neighbors(graph, b.id), requirements = Object.entries(b.requirements ?? {}), criteria = Object.entries(b.acceptance ?? {});
  const group = (kind, label) => {
    const edges = relations.filter(e => e.kind === kind);
    return edges.length ? el('details', { open: kind === 'relationship' }, el('summary', {}, `${label} · ${edges.length}`), edges.map(edge => {
      const other = edge.source === b.id ? edge.target : edge.source;
      return el('div', { class: 'neighbor-row' }, el('small', {}, kind === 'relationship' ? edge.source === b.id ? 'This Block refers to →' : '← Refers to this Block' : kind === 'containment' ? edge.source === b.id ? 'Contains →' : 'Within →' : 'Acceptance subject reference'),
        graph.nodes.has(other) ? el('a', { href: ctx.href('blocks', { block: other, layer: ctx.state.layer, view: 'map' }) }, blockTitle(other), el('code', {}, other)) : el('strong', {}, other + ' · unavailable'), el('p', {}, edge.statement), el('small', { class: 'mono' }, edge.key));
    })) : null;
  };
  return el('aside', { class: 'focused-block', 'aria-label': `Focused Block ${b.id}` },
    el('div', { class: 'focus-top' }, el('span', { class: 'eyebrow' }, 'Focused Block'), el('a', { href: ctx.href('blocks', { block: '', layer: ctx.state.layer, view: 'map' }), 'aria-label': 'Close focused Block' }, 'Close ×')),
    el('h2', { tabindex: '-1', id: 'focused-block-title' }, blockTitle(b.id)), el('code', { class: 'block-id' }, b.id), el('p', { class: 'focus-purpose' }, b.purpose), facets(data.direct_facets),
    el('div', { class: 'focus-actions' }, el('button', { onclick: () => openProposal(ctx, release, b.id) }, 'Propose a change'), el('a', { href: ctx.href('blocks', { block: b.id, view: 'outline' }) }, 'Full Block details')),
    changes.length ? el('details', { open: true, class: 'focused-changes' }, el('summary', {}, `${changes.length} proposed changes`), changes.map(p => proposalCard(ctx, p))) : null,
    el('section', {}, el('h3', {}, `Rules & constraints · ${requirements.length}`), requirements.length ? requirements.map(([key, r]) => el('article', { class: 'obligation' }, el('small', { class: 'mono' }, key), readableValue(r))) : empty('No rules recorded on this Block.')),
    el('details', { open: criteria.length <= 3 }, el('summary', {}, `Acceptance · ${criteria.length}`), criteria.map(([key, criterion]) => el('article', { class: 'obligation' }, el('small', { class: 'mono' }, key), readableValue(criterion)))),
    el('section', { class: 'focus-neighbors' }, el('h3', {}, 'Connected Blocks'), group('relationship', 'Declared relationships'), group('containment', 'Containment'), group('acceptance', 'Derived acceptance references'), !relations.length ? empty('No connected Blocks recorded.') : null),
    el('details', {}, el('summary', {}, 'Contract'), Object.entries(b.contract).map(([key, entries]) => el('section', {}, el('h3', {}, blockTitle(key)), Object.values(entries).length ? Object.values(entries).map(readableValue) : empty('None recorded.')))),
    el('details', {}, el('summary', {}, 'Provenance & authority'), el('p', {}, 'At ', el('code', {}, data.at)), data.provenance.map(p => el('p', { class: 'provenance-item' }, el('code', {}, p.item), el('br'), p.contributors.length ? p.contributors.map(ref => refLink(ctx, ref, 'layer')) : `Retained from ${p.baseline}; no item contributor recorded.`)), el('p', {}, 'Baseline selectors: ' + (data.authority.nearest_scope?.selectors.join(', ') || 'None declared')), el('p', { class: 'muted' }, 'Layer owners author their own proposals. Baseline authority is not Block ownership or current write permission.')),
    b.description?.text ? el('details', {}, el('summary', {}, 'Background'), el('p', {}, b.description.text)) : null,
    raw(b));
}
