import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BLOCK_MODEL, CONTENT_MODEL, canonical, digest } from '../src/model.js';
import { normalizeLayer } from '../src/core.js';
import { adoptionFixture } from './adoption-fixture.js';
import { normalizeAdoptionInventory, validateAdoptionInventory, adoptionInventoryRef } from '../src/adoption/contract.js';
import { prepareAdoptionProposal, validateAdoptionProposal, validateAdoptionInventoryRevision } from '../src/adoption/coverage.js';
import { createAdoptionPacket } from '../src/adoption/packet.js';
import { compareAdoptionSourceSnapshot } from '../src/adoption/freshness.js';

const code = (expected: string) => (error: any) => error.code === expected;
const clone = <T>(value: T): T => structuredClone(value);
const repin = (f: Awaited<ReturnType<typeof adoptionFixture>>) => {
  f.source.manifest_sha256 = digest(f.source.entries);
  f.inventory.source = { ref: 'source-snapshot@' + digest(f.source), sha256: digest(f.source) };
};

test('selected adoption accounts for all five declared surfaces without adopting unrelated code', async () => {
  const f = await adoptionFixture(), before = canonical(f);
  const protectedBytes = await Promise.all(['protected.bin', 'protected.txt'].map(name => readFile('tests/fixtures/adoption/' + name)));
  const result = prepareAdoptionProposal(f);
  assert.equal(result.coverage.scope_accounted, true);
  assert.equal(result.coverage.scope_claim, 'selected_scope');
  assert.deepEqual(result.coverage.outside_units, ['unadopted-report']);
  assert.deepEqual(result.coverage.changed_items, ['counter/requirements.limit']);
  assert.deepEqual(result.coverage.inferred_units, ['state']);
  for (const field of ['interpretation_reviewed', 'source_fresh', 'behavior_verified', 'publication_ready', 'referenced_evidence_verified'] as const) assert.equal(result.coverage[field], false);
  assert.equal(result.coverage.freshness, 'not_checked');
  assert.equal(result.proposal.output_lane, 'selected_git_patch');
  assert.equal(result.proposal.layer_sha256, digest(result.layer));
  assert.equal(canonical(f), before);
  const after = await Promise.all(['protected.bin', 'protected.txt'].map(name => readFile('tests/fixtures/adoption/' + name)));
  assert.deepEqual(after, protectedBytes);
});

test('normalization produces identical refs across object and declared set ordering', async () => {
  const f = await adoptionFixture(), reordered = clone(f.inventory);
  reordered.units.reverse(); reordered.accounting.reverse(); reordered.protected_paths.reverse();
  for (const unit of reordered.units) { unit.files.reverse(); unit.items.reverse(); unit.criteria.reverse(); }
  const a = prepareAdoptionProposal(f), b = prepareAdoptionProposal({ ...f, inventory: reordered });
  assert.equal(adoptionInventoryRef(a.inventory), adoptionInventoryRef(b.inventory));
  assert.equal(a.proposal_ref, b.proposal_ref);
  assert.equal(canonical(a), canonical(b));
});

test('strict records cannot import freshness, behavioral acceptance, authority or executable fields', async () => {
  const f = await adoptionFixture();
  for (const field of ['source_fresh', 'behavior_verified', 'accepted', 'command', 'callback', 'principal']) {
    assert.throws(() => normalizeAdoptionInventory({ ...f.inventory, [field]: true }), code('INVALID_RECORD'));
  }
  const unit = clone(f.inventory); (unit.units[0] as any).passed = true;
  assert.throws(() => normalizeAdoptionInventory(unit), code('INVALID_RECORD'));
});

test('duplicate IDs, paths, aliases and unsafe portable paths are refused', async () => {
  const f = await adoptionFixture();
  const duplicate = clone(f.inventory); duplicate.units.push(clone(duplicate.units[0]));
  assert.throws(() => normalizeAdoptionInventory(duplicate), code('INVALID_RECORD'));
  for (const path of ['../file', '/file', 'C:/file', '.git/config', '.strata/state', 'a\\b', 'CON.txt']) {
    const input = clone(f.inventory); input.protected_paths = [path];
    assert.throws(() => normalizeAdoptionInventory(input), code('INVALID_RECORD'));
  }
  const alias = clone(f.inventory); alias.protected_paths.push('PROTECTED.TXT');
  assert.throws(() => normalizeAdoptionInventory(alias), code('INVALID_RECORD'));
  const prefix = clone(f.inventory); prefix.protected_paths.push('protected.txt/child');
  assert.throws(() => normalizeAdoptionInventory(prefix), code('INVALID_PATH'));
  const duplicateItem = clone(f.inventory); duplicateItem.units[0].items.push(duplicateItem.units[0].items[0]);
  assert.throws(() => normalizeAdoptionInventory(duplicateItem), code('INVALID_RECORD'));
});

test('each behavior/interface/error/state/test category has exact accounting or a visible none declaration', async () => {
  const f = await adoptionFixture();
  const omitted = clone(f.inventory); omitted.accounting.pop();
  assert.throws(() => normalizeAdoptionInventory(omitted), code('INVALID_RECORD'));
  const lost = clone(f.inventory); lost.accounting.find(section => section.kind === 'state')!.unit_ids = [];
  assert.throws(() => normalizeAdoptionInventory(lost), code('ADOPTION_ACCOUNTING_INCOMPLETE'));
  const noState = clone(f.inventory); noState.units = noState.units.filter(unit => unit.kind !== 'state');
  const section = noState.accounting.find(section => section.kind === 'state')!;
  section.unit_ids = []; section.none_reason = 'No state is declared in this proposed boundary; reviewer must assess that assertion.';
  normalizeAdoptionInventory(noState);
  section.none_reason = null;
  assert.throws(() => normalizeAdoptionInventory(noState), code('ADOPTION_ACCOUNTING_INCOMPLETE'));
});

test('exclusions and unknown units retain explicit rationale/questions without contradictory mappings', async () => {
  const f = await adoptionFixture();
  const noReason = clone(f.inventory); noReason.exclusions = [];
  assert.throws(() => normalizeAdoptionInventory(noReason), code('ADOPTION_MAPPING_INVALID'));
  const unknown = clone(f.inventory), unit = unknown.units.find(unit => unit.id === 'state')!;
  unit.disposition = 'unknown'; unit.items = []; unit.criteria = [];
  assert.throws(() => normalizeAdoptionInventory(unknown), code('ADOPTION_ACCOUNTING_INCOMPLETE'));
  unknown.questions.push({ id: 'state-question', unit_ids: ['state'], text: 'Is state preserved on a rejected addition?' });
  normalizeAdoptionInventory(unknown);
  unit.items = ['counter/requirements.limit'];
  assert.throws(() => normalizeAdoptionInventory(unknown), code('ADOPTION_MAPPING_INVALID'));
  const badQuestion = clone(f.inventory); badQuestion.questions.push({ id: 'bad', unit_ids: ['missing'], text: 'Unbound question.' });
  assert.throws(() => normalizeAdoptionInventory(badQuestion), code('ADOPTION_MAPPING_INVALID'));
});

test('source linkage rejects wrong project, alias refs, changed source or substituted digest', async () => {
  const f = await adoptionFixture();
  for (const alter of [
    (i: any) => i.project_id = 'another-project',
    (i: any) => i.source.ref = 'source-snapshot@' + 'c'.repeat(64),
    (i: any) => i.source.sha256 = 'd'.repeat(64)
  ]) {
    const inventory = clone(f.inventory); alter(inventory);
    assert.throws(() => validateAdoptionInventory(inventory, f.source), code('SOURCE_INTEGRITY'));
  }
  const source = clone(f.source); source.entries[0].sha256 = 'e'.repeat(64);
  assert.throws(() => validateAdoptionInventory(f.inventory, source), code('SOURCE_INTEGRITY'));
});

test('every file and dependency is an exact present ordinary captured path', async () => {
  const f = await adoptionFixture();
  const altered = clone(f.inventory); altered.units[0].files[0].sha256 = 'd'.repeat(64);
  assert.throws(() => validateAdoptionInventory(altered, f.source), code('SOURCE_COVERAGE_INCOMPLETE'));
  const missing = clone(f.inventory); missing.units[0].dependency_paths = ['not-captured.mjs'];
  assert.throws(() => validateAdoptionInventory(missing, f.source), code('SOURCE_COVERAGE_INCOMPLETE'));
  const gone = clone(f);
  const selected = gone.source.entries.find(entry => entry.path === 'selected.mjs')!;
  Object.assign(selected, { presence: 'absent', kind: null, mode: null, byte_length: null, sha256: null });
  repin(gone);
  assert.throws(() => validateAdoptionInventory(gone.inventory, gone.source), code('SOURCE_COVERAGE_INCOMPLETE'));
  const linked = clone(f), entry = linked.source.entries.find(entry => entry.path === 'selected.mjs')!;
  entry.kind = 'symlink'; entry.mode = '120000'; repin(linked);
  assert.throws(() => validateAdoptionInventory(linked.inventory, linked.source), code('SOURCE_COVERAGE_INCOMPLETE'));
});

test('unknown adopted scope is visible and blocks both delivery lanes without preventing draft preparation', async () => {
  const f = await adoptionFixture(), unit = f.inventory.units.find(unit => unit.id === 'state')!;
  unit.disposition = 'unknown'; unit.items = []; unit.criteria = [];
  f.inventory.questions.push({ id: 'state-question', unit_ids: ['state'], text: 'State behavior is not established.' });
  for (const mode of ['incremental', 'reconstruct_declared_scope'] as const) {
    f.inventory.mode = mode;
    const result = prepareAdoptionProposal(f);
    assert.equal(result.coverage.scope_accounted, false);
    assert.equal(result.coverage.scope_claim, 'incomplete');
    assert.deepEqual(result.coverage.blockers.map(blocker => blocker.code), ['ADOPTION_SCOPE_INCOMPLETE', 'ADOPTION_QUESTIONS_UNRESOLVED']);
  }
});

test('in-scope exclusions block reconstruction; outside exclusions support only its declared boundary', async () => {
  const f = await adoptionFixture(); f.inventory.mode = 'reconstruct_declared_scope';
  const complete = prepareAdoptionProposal(f);
  assert.equal(complete.coverage.scope_claim, 'complete_declared_scope');
  assert.equal(complete.proposal.output_lane, 'independent_reconstruction');
  const unit = f.inventory.units.find(unit => unit.id === 'state')!;
  unit.disposition = 'excluded'; unit.items = []; unit.criteria = [];
  f.inventory.exclusions.push({ unit_id: 'state', reason: 'State remains unreviewed inside the selected boundary.' });
  assert.equal(prepareAdoptionProposal(f).coverage.scope_accounted, false);
});

test('scope questions are blockers and empty adopted scope cannot claim completeness', async () => {
  const f = await adoptionFixture();
  f.inventory.questions.push({ id: 'boundary', unit_ids: [], text: 'Confirm the declared boundary.' });
  assert.equal(prepareAdoptionProposal(f).coverage.scope_accounted, false);
  // An empty Layer is useful for a baseline interpretation, but still needs adopted units.
  f.layer.changes = []; f.inventory.questions = [];
  for (const unit of f.inventory.units.filter(unit => unit.scope === 'adopted')) {
    unit.scope = 'outside'; unit.disposition = 'excluded'; unit.items = []; unit.criteria = [];
    f.inventory.exclusions.push({ unit_id: unit.id, reason: 'Outside the proposed boundary.' });
  }
  assert.equal(prepareAdoptionProposal(f).coverage.blockers[0].code, 'ADOPTION_SCOPE_EMPTY');
});

test('mapped items and acceptance conserve the actual proposed obligation links', async () => {
  const f = await adoptionFixture();
  const dangling = clone(f); dangling.inventory.units[0].items.push('counter/requirements.missing');
  assert.throws(() => prepareAdoptionProposal(dangling), code('ADOPTION_MAPPING_INVALID'));
  const omitted = clone(f); omitted.inventory.units[0].criteria.pop();
  assert.throws(() => prepareAdoptionProposal(omitted), code('ADOPTION_MAPPING_INVALID'));
  const extra = clone(f); extra.inventory.units[0].criteria.push('counter/acceptance.invalid');
  assert.throws(() => prepareAdoptionProposal(extra), code('ADOPTION_MAPPING_INVALID'));
  const unmapped = clone(f);
  for (const unit of unmapped.inventory.units.filter(unit => unit.items.includes('counter/requirements.limit'))) {
    unit.items = ['counter/purpose']; unit.criteria = ['counter/acceptance.review'];
  }
  assert.throws(() => prepareAdoptionProposal(unmapped), code('ADOPTION_MAPPING_INVALID'));
});

test('added Layer acceptance needs its own adopted source-linked inventory item', async () => {
  const f = await adoptionFixture();
  f.layer.acceptance.push({ block: 'counter', id: 'new_case', criterion: {
    statement: 'A newly proposed preservation case.', method: 'mechanical', check: 'new.case', version: '1', fixture: 'literal', subjects: ['counter/requirements.limit']
  } });
  assert.throws(() => prepareAdoptionProposal(f), code('ADOPTION_MAPPING_INVALID'));
  const unit = f.inventory.units.find(unit => unit.id === 'tests')!;
  unit.items.push('counter/acceptance.new_case'); unit.criteria.push('counter/acceptance.new_case');
  assert.equal(prepareAdoptionProposal(f).coverage.scope_accounted, true);
  assert.equal(prepareAdoptionProposal(f).coverage.behavior_verified, false);
});

test('normal Layer preconditions, baseline and model checks are reused', async () => {
  const f = await adoptionFixture();
  const stale = clone(f); stale.layer.changes[0].expected = { kind: 'absent' };
  assert.throws(() => prepareAdoptionProposal(stale), code('BASELINE_PRECONDITION'));
  assert.throws(() => prepareAdoptionProposal({ ...f, baseline_ref: 'Other@1' }), code('MIXED_BASELINE'));
  const decision = clone(f); decision.layer.resolution_proposals.push({
    input_fingerprint: 'a'.repeat(64), scope: 'counter', impact: ['counter'], outcome: { kind: 'select', selected: [], rejected: [] }
  }); decision.layer.changes = [];
  assert.throws(() => prepareAdoptionProposal(decision), code('INVALID_DECISION_LAYER'));
  const unknown = clone(f); (unknown.layer as any).model_version = 'strata/0.3-unknown';
  assert.throws(() => prepareAdoptionProposal(unknown), code('INVALID_RECORD'));
});

test('proposal linkage rejects changed inventory, baseline, author, Layer and delivery lane', async () => {
  const f = await adoptionFixture(), prepared = prepareAdoptionProposal(f);
  validateAdoptionProposal(prepared.proposal, f);
  for (const alter of [
    (p: any) => p.inventory_sha256 = 'a'.repeat(64),
    (p: any) => p.layer_sha256 = 'b'.repeat(64),
    (p: any) => p.baseline_snapshot_sha256 = 'c'.repeat(64),
    (p: any) => p.author = 'another-author',
    (p: any) => p.output_lane = 'independent_reconstruction'
  ]) {
    const proposal = clone(prepared.proposal); alter(proposal);
    assert.throws(() => validateAdoptionProposal(proposal, f), code('STALE_ADOPTION_PROPOSAL'));
  }
  const revised = clone(f); revised.layer.revision = 2;
  assert.throws(() => validateAdoptionProposal(prepared.proposal, revised), code('STALE_ADOPTION_PROPOSAL'));
  const changedInventory = clone(f); changedInventory.inventory.units[0].rationale += ' Revised interpretation.';
  assert.throws(() => validateAdoptionProposal(prepared.proposal, changedInventory), code('STALE_ADOPTION_PROPOSAL'));
});

test('inventory revision cannot silently drop a declared unit or change the boundary', async () => {
  const f = await adoptionFixture(), next = clone(f.inventory);
  next.units = next.units.filter(unit => unit.id !== 'state');
  const section = next.accounting.find(section => section.kind === 'state')!;
  section.unit_ids = []; section.none_reason = 'No longer declared.';
  assert.throws(() => validateAdoptionInventoryRevision(f.inventory, next, f.source), code('ADOPTION_INVENTORY_LOSS'));
  const explicit = clone(f.inventory), state = explicit.units.find(unit => unit.id === 'state')!;
  state.disposition = 'excluded'; state.items = []; state.criteria = [];
  explicit.exclusions.push({ unit_id: 'state', reason: 'Retain this unit visibly pending a different reviewed boundary.' });
  validateAdoptionInventoryRevision(f.inventory, explicit, f.source);
  explicit.declared_scope = 'Different scope.';
  assert.throws(() => validateAdoptionInventoryRevision(f.inventory, explicit, f.source), code('ADOPTION_SCOPE_CHANGED'));
});

test('referenced evidence stays unverified and outside uncertainty stays visible', async () => {
  const f = await adoptionFixture();
  f.inventory.units[0].evidence_refs = ['validation@' + 'a'.repeat(64)];
  const outside = f.inventory.units.find(unit => unit.scope === 'outside')!;
  outside.disposition = 'unknown'; f.inventory.exclusions = [];
  f.inventory.questions.push({ id: 'outside-question', unit_ids: [outside.id], text: 'Outside report semantics have not been interpreted.' });
  const result = prepareAdoptionProposal(f);
  assert.equal(result.coverage.scope_accounted, true);
  assert.equal(result.coverage.referenced_evidence_verified, false);
  assert.equal(result.inventory.questions.length, 1);
  assert.equal(result.coverage.publication_ready, false);
});

test('agent packet pins allowed files and response shape without granting identity or execution', async () => {
  const f = await adoptionFixture(), result = createAdoptionPacket(f);
  assert.equal(result.packet_sha256, digest(result.packet));
  assert.equal(result.packet.owner_hint_is_authority, false);
  assert.deepEqual(Object.values(result.packet.authority), [false, false, false, false, false]);
  assert.deepEqual(result.packet.protected_paths, ['protected.bin', 'protected.txt']);
  assert.equal(result.packet.allowed_files.length, 4);
  assert(result.packet.baseline_items.some(item => item.item === 'counter/requirements.limit'));
  assert.equal(result.packet.prepared_layer.baseline, f.baseline_ref);
  assert.equal(canonical(result).includes('head_commit'), false);
  assert.equal(canonical(result).includes('C:/'), false);
  assert.equal(canonical(result).includes('accepted":true'), false);
  const large = clone(f); for (const unit of large.inventory.units) unit.description = 'x'.repeat(4096);
  assert.throws(() => createAdoptionPacket(large), code('ADOPTION_PACKET_LIMIT'));
});

test('supplied capture comparison detects source changes without asserting live freshness or host authority', async () => {
  const f = await adoptionFixture();
  const same = compareAdoptionSourceSnapshot(f.inventory, f.source, clone(f.source));
  assert.equal(same.captured_source_matches, true);
  assert.equal(same.source_fresh, false); assert.equal(same.host_authority_verified, false);
  const changed = clone(f.source); changed.entries[0].sha256 = 'd'.repeat(64);
  changed.manifest_sha256 = digest(changed.entries); changed.head_commit = 'c'.repeat(40);
  const result = compareAdoptionSourceSnapshot(f.inventory, f.source, changed);
  assert.equal(result.captured_source_matches, false);
  assert.deepEqual(result.changed_fields, ['head_commit', 'manifest_sha256']);
  const wrongRepo = clone(f.source); wrongRepo.repo_id = 'other-repository';
  assert.deepEqual(compareAdoptionSourceSnapshot(f.inventory, f.source, wrongRepo).changed_fields, ['repo_id']);
});

test('record and collection limits fail before a proposal can become a publishable claim', async () => {
  const f = await adoptionFixture();
  const oversized = clone(f.inventory); oversized.units = Array.from({ length: 256 }, (_, i) => ({
    ...clone(f.inventory.units[0]), id: 'unit-' + i, description: 'x'.repeat(4096), rationale: 'x'.repeat(4096)
  }));
  oversized.accounting = oversized.accounting.map(section => ({ ...section,
    unit_ids: section.kind === 'behavior' ? oversized.units.map(unit => unit.id) : [],
    none_reason: section.kind === 'behavior' ? null : 'None declared.'
  }));
  oversized.exclusions = [];
  assert.throws(() => normalizeAdoptionInventory(oversized), code('SOURCE_LIMIT'));
  const tooMany = clone(f.inventory); tooMany.questions = Array.from({ length: 257 }, (_, i) => ({ id: 'q-' + i, unit_ids: [], text: 'Question.' }));
  assert.throws(() => normalizeAdoptionInventory(tooMany), code('INVALID_RECORD'));
});


test('new Block lifecycle cannot silently enter legacy adoption scope accounting', async () => {
  const f = await adoptionFixture();
  f.baseline.model_version = CONTENT_MODEL; f.layer.model_version = CONTENT_MODEL;
  for (const block of Object.values(f.baseline.blocks)) {
    block.description = { format: 'plain-text/1', text: 'Synthetic baseline content.' }; block.asset_refs = {};
  }
  assert.equal(prepareAdoptionProposal(f).coverage.scope_accounted, true);
  f.baseline.model_version = BLOCK_MODEL; f.layer.model_version = BLOCK_MODEL;
  f.layer.created_blocks = [{ id: 'unaccounted-child', parent: f.baseline.root, purpose: 'Retain a synthetic child.',
    description: { format: 'plain-text/1', text: 'A valid new Block outside legacy accounting.' }, asset_refs: {},
    requirements: {}, acceptance: { purpose: { statement: 'Review the child purpose.', method: 'review',
      check: 'intent-purpose', version: '1', fixture: 'synthetic/1', subjects: ['unaccounted-child/purpose'] } },
    relationships: {}, contract: { inputs: {}, outputs: {}, failures: {} } }];
  assert.equal(normalizeLayer(f.layer, f.baseline).created_blocks?.[0].id, 'unaccounted-child');
  assert.throws(() => prepareAdoptionProposal(f), code('UNSUPPORTED_MODEL_VERSION'));
  assert.throws(() => createAdoptionPacket(f), code('UNSUPPORTED_MODEL_VERSION'));
});
