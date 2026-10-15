import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeLayer, snapshotFromRelease } from '../src/core.js';
import { CONTENT_MODEL, canonical } from '../src/model.js';
import { visualRecords } from './explorer-visual-fixture.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { TestSource } from './explorer-fixture.js';
const moduleAt = (name: string) => import(pathToFileURL(path.resolve('explorer', name)).href);
const { graphFromRelease, semanticOrder, mapSlice, layoutCards, neighbors } = await moduleAt('semantic-model.js');
const { draftChange, makeLayerDraft } = await moduleAt('draft-model.js');
const baseline = () => ({ ...structuredClone(visualRecords()['WorkspaceBaseline@1'].data), ref: 'WorkspaceBaseline@1' });

test('map distinguishes declared relationships, containment and derived acceptance; preserves cycles', () => {
  const release = baseline(), before = canonical(release), graph = graphFromRelease(release);
  assert.equal(graph.nodes.size, 8);
  assert.equal(graph.edges.filter((e: any) => e.kind === 'relationship').length, 7);
  assert.equal(graph.edges.filter((e: any) => e.kind === 'containment').length, 7);
  assert.equal(graph.edges.filter((e: any) => e.kind === 'acceptance').length, 1);
  assert.ok(neighbors(graph, 'review').some((e: any) => e.source === 'records' && e.target === 'review'));
  assert.equal(new Set(semanticOrder(graph)).size, 8);
  assert.equal(canonical(release), before);
});
test('empty, sparse, missing references and cyclic containment remain bounded without invented nodes', () => {
  assert.equal(mapSlice(graphFromRelease({ blocks: {} })).total, 0);
  const graph = graphFromRelease({ blocks: { a: { id: 'a', parent: 'b', relationships: { missing: { target: 'missing', statement: 'Missing' } } }, b: { id: 'b', parent: 'a' } } });
  assert.equal(graph.nodes.size, 2); assert.equal(graph.warnings.length, 1);
  assert.deepEqual(new Set(semanticOrder(graph)), new Set(['a', 'b']));
  const layout = layoutCards(semanticOrder(graph)); assert.ok(Number.isFinite(layout.height));
});
test('1000-Block graph pages deterministically with no overlap or missing pages', () => {
  const blocks = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`b${i}`, { id: `b${i}`, parent: i ? 'b0' : null, relationships: { next: { target: `b${(i + 1) % 1000}`, statement: 'Cyclic link' } } }]));
  const graph = graphFromRelease({ blocks }), all: string[] = [];
  for (let page = 0; page < 21; page++) {
    const slice = mapSlice(graph, { page }); assert.ok(slice.ids.length <= 48); all.push(...slice.ids);
    const { positions } = layoutCards(slice.ids);
    assert.equal(new Set([...positions.values()].map((p: any) => `${p.x}:${p.y}`)).size, slice.ids.length);
  }
  assert.equal(all.length, 1000); assert.equal(new Set(all).size, 1000);
  assert.equal(mapSlice(graph, { page: 999 }).page, 20);
});
test('filtered selection remains explicit context and neighborhood contains only actual links', () => {
  const graph = graphFromRelease(baseline());
  const selected = mapSlice(graph, { selected: 'review', matching: new Set(['storage']) });
  assert.deepEqual(selected.ids, ['review', 'storage']);
  const near = mapSlice(graph, { selected: 'review', neighborhood: true });
  assert.ok(!near.ids.includes('storage')); assert.ok(near.ids.includes('records'));
});
test('human draft uses real Layer contract, baseline preconditions and authoritative normalization', () => {
  const release = baseline(), before = canonical(release);
  const change = draftChange(release, { block: 'review', path: 'purpose', value: 'Review every proposed item with readable context.' });
  const layer = makeLayerDraft(release, { id: 'L-human', owner: 'human-author', intent: 'Improve review context.', changes: [change] });
  const normalized = normalizeLayer(layer, snapshotFromRelease(release));
  assert.equal(normalized.owner, 'human-author');
  const expected = normalized.changes[0].expected; assert.equal(expected.kind, 'value');
  assert.equal(expected.kind === 'value' && expected.value, release.blocks.review.purpose);
  assert.equal(canonical(release), before);
});
test('new requirement plus criterion normalizes in both supported models without new Block operations', () => {
  for (const content of [false, true]) {
    const release = baseline();
    if (content) { release.model_version = CONTENT_MODEL; for (const b of Object.values(release.blocks) as any[]) { b.description = { format: 'plain-text/1', text: '' }; b.asset_refs = {}; } }
    const change = draftChange(release, { block: 'review', path: 'requirements.clarity', value: { statement: 'Explain all proposed item changes.', kind: 'rule', facets: ['design'], parameters: {}, acceptance: ['clarity'] } });
    const acceptance = [{ block: 'review', id: 'clarity', criterion: { statement: 'A reviewer can read each change.', method: 'review', check: 'clarity.review', version: '1', fixture: 'clarity', subjects: ['review/requirements.clarity'] } }];
    const layer = makeLayerDraft(release, { id: 'L-clarity', owner: 'human-author', intent: 'Improve clarity.', changes: [change], acceptance });
    assert.equal(normalizeLayer(layer, snapshotFromRelease(release)).acceptance.length, 1);
  }
});
test('draft rejects stale baseline, absent Block, duplicate writes, no-op and malformed inputs', () => {
  const release = baseline(), change = draftChange(release, { block: 'review', path: 'purpose', value: 'Updated review purpose.' });
  const make = (changes: any[], extra = {}) => makeLayerDraft(release, { id: 'L-test', owner: 'human-author', intent: 'Review.', changes, ...extra });
  assert.throws(() => make([]), /1–25/); assert.throws(() => make([change, change]), /only once/);
  assert.throws(() => make([change], { owner: '' }), /owner.*required/i);
  assert.throws(() => draftChange(release, { block: 'absent', path: 'purpose', value: 'New' }), /existing Block/);
  assert.throws(() => draftChange(release, { block: 'review', path: 'purpose', value: release.blocks.review.purpose }), /Change the item/);
  release.blocks.review.purpose = 'Another baseline value'; assert.throws(() => make([change]), /baseline item changed/);
});
test('reader refuses orphan/missing targets; a semantic relationship cycle is valid and read-only', async () => {
  const records = visualRecords(), before = canonical(records), reader = new ExplorerReader(new TestSource(records));
  await reader.refresh(); assert.equal(canonical(records), before);
  for (const mutate of [(b: any) => b.review.parent = 'absent', (b: any) => b.review.relationships.records.target = 'absent']) {
    const bad = structuredClone(records); mutate(bad['WorkspaceBaseline@1'].data.blocks);
    await assert.rejects(new ExplorerReader(new TestSource(bad)).refresh());
  }
});
