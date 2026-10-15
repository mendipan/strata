// Pure projections of retained intent. Layout and cross-reference links never
// become repository facts, dependency declarations, or permission decisions.
export const MAP_PAGE_SIZE = 48;
// A single exact proposal projection, never a composed/accepted candidate.
export function proposalSnapshot(release, layer) {
  if(layer.baseline!==release.ref||layer.model_version!==release.model_version)throw new Error('Proposal baseline mismatch.');
  const preview=structuredClone(release);
  for(const block of layer.created_blocks??[])preview.blocks[block.id]=structuredClone(block);
  for(const change of layer.changes){const block=preview.blocks[change.block],parts=change.path.split('.');if(change.path==='purpose')block.purpose=structuredClone(change.value);else if(parts.length===2)block[parts[0]][parts[1]]=structuredClone(change.value);else if(parts[0]==='contract'&&parts.length===3)block.contract[parts[1]][parts[2]]=structuredClone(change.value);else throw new Error('Unsupported proposal item.');}
  for(const criterion of layer.acceptance)preview.blocks[criterion.block].acceptance[criterion.id]=structuredClone(criterion.criterion);
  return preview;
}
export function blockTitle(id) {
  const label = String(id).split('.').at(-1).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
export function graphFromRelease(release) {
  const blocks = Object.values(release.blocks ?? {}).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const nodes = new Map(blocks.map(block => [block.id, block]));
  const edges = [], warnings = [];
  const add = edge => {
    edge.missing = !nodes.has(edge.source) || !nodes.has(edge.target);
    if (edge.missing) warnings.push(`Unavailable Block: ${!nodes.has(edge.target) ? edge.target : edge.source} (${edge.kind}).`);
    edges.push(edge);
  };
  for (const block of blocks) {
    if (block.parent) add({ kind: 'containment', source: block.parent, target: block.id, key: 'parent', statement: 'Declared parent / child' });
    for (const [key, value] of Object.entries(block.relationships ?? {})) add({ kind: 'relationship', source: block.id, target: value.target, key, statement: value.statement });
    const references = new Map();
    for (const [key, criterion] of Object.entries(block.acceptance ?? {})) for (const subject of criterion.subjects ?? []) {
      const target = subject.split('/')[0];
      if (target !== block.id) {
        if (!references.has(target)) references.set(target, new Set());
        references.get(target).add(key);
      }
    }
    for (const [target, keys] of references) add({ kind: 'acceptance', source: block.id, target, key: [...keys].join(', '), statement: 'Cross-reference derived from declared acceptance subjects; not a dependency.' });
  }
  return { nodes, edges, warnings: [...new Set(warnings)] };
}
export function neighbors(graph, id) {
  return graph.edges.filter(edge => edge.source === id || edge.target === id);
}
export function relatedIds(graph, id) {
  return new Set(neighbors(graph, id).flatMap(edge => [edge.source, edge.target]));
}
// Relationship components determine the map's reading order. Containment is
// drawn independently. Iterative traversal is safe for cycles and long chains.
export function semanticOrder(graph) {
  const adjacent = new Map([...graph.nodes.keys()].map(id => [id, []]));
  for (const edge of graph.edges) if (edge.kind === 'relationship' && !edge.missing) {
    adjacent.get(edge.source).push(edge.target); adjacent.get(edge.target).push(edge.source);
  }
  const seen = new Set(), groups = [];
  for (const id of graph.nodes.keys()) {
    if (seen.has(id)) continue;
    const queue = [id], group = []; seen.add(id);
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]; group.push(current);
      for (const next of adjacent.get(current).sort()) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0], 'en')).flat();
}
export function mapSlice(graph, { selected = '', matching, neighborhood = false, page = 0 } = {}) {
  let ids = semanticOrder(graph);
  if (matching) ids = ids.filter(id => matching.has(id));
  if (neighborhood && selected) { const nearby = relatedIds(graph, selected); nearby.add(selected); ids = ids.filter(id => nearby.has(id)); }
  // Selected Block stays available even when a filter excludes it. Marked as context in UI.
  if (selected && graph.nodes.has(selected)) ids = [selected, ...ids.filter(id => id !== selected)];
  const pages = Math.max(1, Math.ceil(ids.length / MAP_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { ids: ids.slice(current * MAP_PAGE_SIZE, (current + 1) * MAP_PAGE_SIZE), total: ids.length, page: current, pages };
}
export function layoutCards(ids, selected = '', graph) {
  const positions = new Map();
  const width = 278, height = 238, gapX = 70, gapY = 68, pad = 40;
  // The focused neighborhood has a stable centre; arrows retain their actual
  // direction, including two-way links and cycles.
  if (selected && ids.includes(selected) && ids.length <= 16 && graph) {
    const left = [], right = [];
    for (const id of ids.filter(id => id !== selected)) {
      const incoming = graph.edges.some(e => e.kind === 'relationship' && e.source === id && e.target === selected);
      (incoming ? left : right).push(id);
    }
    positions.set(selected, { x: pad + width + gapX, y: pad + Math.max(0, Math.ceil(Math.max(left.length, right.length) / 2) - 1) * (height + gapY) });
    left.forEach((id, i) => positions.set(id, { x: pad, y: pad + i * (height + gapY) }));
    right.forEach((id, i) => positions.set(id, { x: pad + 2 * (width + gapX), y: pad + i * (height + gapY) }));
  } else ids.forEach((id, i) => positions.set(id, { x: pad + (i % 3) * (width + gapX), y: pad + Math.floor(i / 3) * (height + gapY) }));
  return { positions, cardWidth: width, cardHeight: height, width: Math.max(440, ...[...positions.values()].map(p => p.x + width + pad)), height: Math.max(350, ...[...positions.values()].map(p => p.y + height + pad)) };
}
export function proposalsByBlock(layer) {
  const groups = new Map();
  for (const proposal of layer?.proposals ?? []) {
    if (!groups.has(proposal.block)) groups.set(proposal.block, []);
    groups.get(proposal.block).push(proposal);
  }
  return groups;
}
