import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, contextFingerprint, normalizeComposition } from '../src/core.js';
import { canonical, digest, normalizeSnapshot, item, matches, MODEL, StrataError } from '../src/model.js';
import { bootstrap, demoLayers, proposal, recipe, criterion } from '../src/fixtures.js';
import { expiryRequirement, timingRequirement, EXCLUSIVE, treeDigest } from '../src/profile.js';
import { prepared, unitValidation, approvals } from './helpers.js';
const error = (code: string) => (e: unknown) => e instanceof StrataError && e.code === code;
test('canonical objects and declared sets are stable; ordinary parameter lists retain order', () => {
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  const a = bootstrap(), b = bootstrap(); b.blocks['booking.hold'].requirements.exclusive.facets.reverse();
  assert.equal(digest(normalizeSnapshot(a)), digest(normalizeSnapshot(b)));
  assert.notEqual(digest({ steps: ['one', 'two'] }), digest({ steps: ['two', 'one'] }));
  const c = recipe(), d = recipe(); d.proposals.reverse(); d.selected.reverse(); assert.equal(digest(normalizeComposition(c)), digest(normalizeComposition(d)));
});
test('duplicate or unknown facets and unknown normative fields fail closed', () => {
  const a = bootstrap(); a.blocks['booking.hold'].requirements.exclusive.facets.push('safety'); assert.throws(() => normalizeSnapshot(a), error('INVALID_RECORD'));
  const b: any = bootstrap(); b.blocks['booking.hold'].requirements.expiry.facets = ['magic']; assert.throws(() => normalizeSnapshot(b), error('INVALID_RECORD'));
  const c: any = bootstrap(); c.blocks.app.type = 'logic'; assert.throws(() => normalizeSnapshot(c), error('INVALID_RECORD'));
});
test('one rooted acyclic Block tree, reserved IDs, and dangling subjects are enforced', () => {
  const a = bootstrap(); a.blocks.booking.parent = 'booking.hold'; assert.throws(() => normalizeSnapshot(a), error('INVALID_TREE'));
  const b = bootstrap(); b.deleted_ids.push('booking'); assert.throws(() => normalizeSnapshot(b), error('INVALID_TREE'));
  const c = bootstrap(); c.blocks.app.acceptance.review.subjects = ['missing/purpose']; assert.throws(() => normalizeSnapshot(c), error('DANGLING_REFERENCE'));
});
test('relationship cycles are valid while hierarchy cycles are not', () => {
  const a = bootstrap(); a.blocks['booking.hold'].relationships.reminder = { target: 'booking.reminder', statement: 'Consumes reminder state.', acceptance: ['exclusive'] }; assert.doesNotThrow(() => normalizeSnapshot(a));
});
test('absence differs from a present null value', () => {
  const b = normalizeSnapshot(bootstrap()).blocks.app;
  assert.equal(matches(item(b, 'parent'), { kind: 'absent' }), false);
  assert.equal(matches(item(b, 'parent'), { kind: 'value', value: null }), true);
  assert.equal(matches(item(b, 'requirements.missing'), { kind: 'absent' }), true);
});
test('owner fields cannot spoof broker identity; peer writes and private draft reads are refused', () => {
  const engine = new Engine(); engine.init(bootstrap(), 'bootstrap'); const a = demoLayers().a;
  assert.throws(() => engine.layer(a, 'author-b'), error('OWNER_FORBIDDEN'));
  engine.layer(a, 'author-a'); assert.throws(() => engine.publish('L-hold@1', 'author-b'), error('OWNER_FORBIDDEN'));
  assert.throws(() => engine.inspect('layer', 'L-hold@1', 'author-b'), error('REF_NOT_FOUND'));
  engine.publish('L-hold@1', 'author-a'); assert.equal(engine.inspect('layer', 'L-hold@1', 'author-b').owner, 'author-a');
});
test('owned revisions require the exact head and cannot silently rebase', () => {
  const { engine, a } = prepared(); const next = { ...a, revision: 2 };
  assert.throws(() => engine.layer(next, 'author-b', 'L-hold@1'), error('OWNER_FORBIDDEN'));
  assert.throws(() => engine.layer(next, 'author-a', 'L-hold@0'), error('STALE_REVISION'));
  engine.layer(next, 'author-a', 'L-hold@1'); assert.throws(() => engine.layer({ ...a, revision: 3 }, 'author-a', 'L-hold@1'), error('STALE_REVISION'));
});
test('unsupported operations, identity paths, duplicate writes, and baseline preconditions are rejected', () => {
  const engine = new Engine(); engine.init(bootstrap(), 'bootstrap'); const a: any = demoLayers().a;
  a.changes[0].op = 'remove_item'; assert.throws(() => engine.layer(a, 'author-a'), error('UNSUPPORTED_CAPABILITY'));
  const b = demoLayers().a; b.changes[0].path = 'id'; assert.throws(() => engine.layer(b, 'author-a'), error('UNSUPPORTED_CAPABILITY'));
  const c = demoLayers().a; c.changes.push(structuredClone(c.changes[0])); assert.throws(() => engine.layer(c, 'author-a'), error('DUPLICATE_WRITE'));
  const d = demoLayers().a; d.changes[0].expected = { kind: 'value', value: expiryRequirement(601) }; assert.throws(() => engine.layer(d, 'author-a'), error('BASELINE_PRECONDITION'));
});
test('required reads need exact selected peer revisions', () => {
  const engine = new Engine(); engine.init(bootstrap(), 'bootstrap'); const b = demoLayers().b; b.requires_layers = [];
  assert.throws(() => engine.layer(b, 'author-b'), error('DEPENDENCY_REQUIRED'));
  const { engine: e } = prepared(); const c = recipe('C-missing'); c.proposals = ['L-reminder@1']; c.selected = ['L-reminder@1']; c.alternative_groups = [];
  assert.ok(e.compose(c).diagnostics.some(d => d.code === 'MISSING_DEPENDENCY'));
});
test('dependency cycles and mixed baselines block composition', () => {
  const { engine } = prepared(); const a = engine.read('L-hold@1', 'layer'); a.requires_layers = ['L-reminder@1']; engine.records['L-hold@1'].data = a;
  assert.ok(engine.compose({ ...recipe('C-cycle'), proposals: ['L-hold@1', 'L-reminder@1'], selected: ['L-hold@1', 'L-reminder@1'], alternative_groups: [] }).diagnostics.some(d => d.code === 'DEPENDENCY_CYCLE'));
  a.requires_layers = []; a.baseline = 'other@1'; engine.records['L-hold@1'].data = a;
  assert.ok(engine.compose(recipe('C-mixed')).diagnostics.some(d => d.code === 'MIXED_BASELINE'));
});
test('identical atomic writes coalesce with all provenance', () => {
  const { engine, a } = prepared(); const twin = { ...a, id: 'L-twin', owner: 'author-c' }; engine.layer(twin, 'author-c'); engine.publish('L-twin@1', 'author-c');
  const composition = recipe('C-coalesce'); composition.proposals = composition.selected = ['L-hold@1', 'L-twin@1']; composition.alternative_groups = [];
  const result = engine.compose(composition); assert.equal(result.state, 'eligible_for_validation'); assert.deepEqual(result.provenance['booking.hold/requirements.expiry'], ['L-hold@1', 'L-twin@1']);
});
test('differing writes conflict without application-order precedence', () => {
  const { engine, blocked } = prepared(); assert.ok(blocked.diagnostics.some(d => d.code === 'ITEM_COLLISION'));
  const reverse = recipe('C-order'); reverse.selected.reverse(); reverse.proposals.reverse(); const result = engine.compose(reverse);
  assert.deepEqual(result.diagnostics, blocked.diagnostics); assert.equal(result.state, 'blocked');
});
test('independent facet edits remain whole-requirement atomic collisions', () => {
  const e = new Engine(); e.init(bootstrap(), 'bootstrap'); const base = EXCLUSIVE;
  for (const [id, owner, facets] of [['one', 'author-a', ['behavior', 'safety']], ['two', 'author-b', ['behavior', 'data']]] as const) {
    const l = proposal(id, owner, [{ op: 'set_item', block: 'booking.hold', path: 'requirements.exclusive', expected: { kind: 'value', value: base }, value: { ...base, facets } }]); e.layer(l, owner); e.publish(id + '@1', owner);
  }
  const c = recipe('C-facets'); c.proposals = c.selected = ['one@1', 'two@1']; c.alternative_groups = [];
  assert.ok(e.compose(c).diagnostics.some(d => d.code === 'ITEM_COLLISION'));
});
test('disjoint edits with an incompatible final assumption cannot coexist', () => {
  const { engine } = prepared(); const c = recipe('C-assumption'); c.proposals = c.selected = ['L-alternative@1', 'L-reminder@1']; c.alternative_groups = [];
  assert.ok(engine.compose(c).diagnostics.some(d => d.code === 'ASSUMPTION_FAILED'));
});
test('unknown compatibility checks and undeclared reminder compatibility block intent', () => {
  const { engine } = prepared(); const c = recipe('C-unknown'); c.scenario.checks.push({ id: 'unknown', version: '1' }); assert.ok(engine.compose(c).diagnostics.some(d => d.code === 'UNKNOWN_CHECK'));
  const b = engine.read('L-reminder@1', 'layer'); b.assumptions = []; engine.records['L-reminder@1'].data = b;
  assert.ok(engine.compose(recipe('C-no-assumption')).diagnostics.some(d => d.code === 'COMPATIBILITY_UNKNOWN'));
});
test('Layer acceptance is normalized before collision checks and retained in the candidate', () => {
  const { candidate } = prepared(); assert.ok(candidate.snapshot.blocks['booking.reminder'].acceptance['layer-reminder']); assert.deepEqual(candidate.provenance['booking.reminder/acceptance.layer-reminder'], ['L-reminder@1']);
});
test('responsible authority includes baseline consumers and cannot be self-authorized', () => {
  const { engine, unsigned, request } = prepared(); assert.equal(unsigned.scope, 'booking');
  assert.throws(() => engine.approve({ kind: 'resolution', target: unsigned.target, scope: 'booking', evidence_digest: null }, 'author-a'), error('AUTHORITY_FORBIDDEN'));
  const d = proposal('bad-decision', 'author-a'); d.resolution_proposals = [{ input_fingerprint: engine.target('C-demo@1').input_fingerprint, impact: ['booking.hold'], scope: 'booking.hold', outcome: { kind: 'select', selected: ['L-hold@1', 'L-reminder@1'], rejected: ['L-alternative@1'] } }]; engine.layer(d, 'author-a'); engine.publish('bad-decision@1', 'author-a');
  assert.throws(() => engine.resolution({ ...request, layer: 'bad-decision@1' }, 'author-a', true), error('AUTHORITY_SCOPE'));
});
test('decision-only Layers and whole-proposal outcomes prohibit free-value repairs', () => {
  const { engine } = prepared(); const d: any = demoLayers().a; d.id = 'bad'; d.resolution_proposals = [{ input_fingerprint: 'a'.repeat(64), scope: 'booking', impact: [], outcome: { kind: 'select', selected: [], rejected: [] } }];
  assert.throws(() => engine.layer(d, 'author-a'), error('INVALID_DECISION_LAYER'));
  d.changes = []; d.resolution_proposals[0].outcome.value = 1050; assert.throws(() => engine.layer(d, 'author-a'), error('INVALID_RECORD'));
});
test('changing the considered set invalidates a sealed decision', () => {
  const { engine, resolution, a } = prepared(); engine.layer({ ...a, id: 'extra', owner: 'author-c' }, 'author-c'); engine.publish('extra@1', 'author-c');
  const c = recipe('C-stale'); c.proposals.push('extra@1'); c.selected = ['L-hold@1', 'L-reminder@1']; c.resolutions = [resolution.ref];
  assert.ok(engine.compose(c).diagnostics.some(d => d.code === 'STALE_RESOLUTION'));
});
test('materialization coverage includes every inherited and standalone obligation', () => {
  const { engine, candidate } = prepared(); const realization = engine.realize(candidate.ref, 'booking-node/1');
  assert.equal(realization.coverage.length, candidate.obligations.length); assert.ok(realization.coverage.some(c => c.item === 'booking.hold/acceptance.lifecycle')); assert.ok(realization.coverage.some(c => c.item === 'booking.reminder/acceptance.layer-reminder'));
  assert.ok(realization.coverage.some(c => c.item.includes('/relationships.'))); assert.ok(realization.coverage.some(c => c.item.includes('/contract.')));
});
test('unsupported design intent and unknown prose cannot silently materialize or release', () => {
  const { engine } = prepared();
  for (const kind of ['design', 'prose']) {
    const layer = { ...demoLayers().a, id: 'L-unsupported-' + kind };
    if (kind === 'design') (layer.changes[0].value as any).facets.push('design'); else (layer.changes[0].value as any).statement = 'Also collect a payment.';
    engine.layer(layer, 'author-a'); engine.publish(layer.id + '@1', 'author-a');
    const c = recipe('C-unsupported-' + kind); c.proposals = c.selected = [layer.id + '@1']; c.alternative_groups = [];
    const candidate = engine.compose(c); assert.equal(candidate.state, 'eligible_for_validation');
    assert.throws(() => engine.realize(candidate.ref, 'booking-node/1'), error('UNSUPPORTED_OBLIGATION'));
  }
});
test('missing, failed, unknown, stale, and arbitrary executor evidence fail closed', () => {
  const { engine, candidate } = prepared(); const { evidence, registration } = unitValidation(engine, candidate);
  const missing = structuredClone(evidence); missing.results.pop(); assert.throws(() => engine.validate(candidate.ref, registration.ref, missing), error('VALIDATION_INCOMPLETE'));
  const failed = structuredClone(evidence); failed.results[0].passed = false; assert.throws(() => engine.validate(candidate.ref, registration.ref, failed), error('VALIDATION_INCOMPLETE'));
  const unknown = structuredClone(evidence); unknown.results[0].version = '99'; assert.throws(() => engine.validate(candidate.ref, registration.ref, unknown), error('UNKNOWN_EVIDENCE'));
  assert.throws(() => engine.validate(candidate.ref, registration.ref, { ...evidence, candidate: 'f'.repeat(64) }), error('STALE_EVIDENCE'));
  assert.throws(() => engine.validate(candidate.ref, registration.ref, { ...evidence, executor: 'arbitrary-pass' }), error('INVALID_RECORD'));
});
test('profile/output mutation invalidates evidence and immutable realization bytes', () => {
  const { engine, candidate } = prepared(); const { realization, evidence, registration } = unitValidation(engine, candidate);
  assert.throws(() => engine.validate(candidate.ref, registration.ref, { ...evidence, profile: 'a'.repeat(64) }), error('STALE_EVIDENCE'));
  const tampered = structuredClone(realization); tampered.files['booking.mjs'] += '// edit'; tampered.output_tree = treeDigest(tampered.files); assert.throws(() => engine.registerRealization(tampered), error('STALE_REALIZATION'));
});
test('passing checks alone never authorize Release; exact scope and release approvals are required', () => {
  const { engine, candidate } = prepared(); const { validation } = unitValidation(engine, candidate);
  assert.throws(() => engine.release(candidate.ref, validation.ref, []), error('ENDORSEMENT_REQUIRED'));
  const list = approvals(engine, candidate, validation.evidence_digest); assert.throws(() => engine.release(candidate.ref, validation.ref, [list[0]]), error('RELEASE_APPROVAL_REQUIRED'));
  assert.throws(() => engine.approve({ kind: 'release', target: candidate.fingerprint, scope: null, evidence_digest: validation.evidence_digest }, 'author-a'), error('AUTHORITY_FORBIDDEN'));
});
test('a facet amendment to a protected invariant still needs its baseline guardian', () => {
  const e = new Engine(); e.init(bootstrap(), 'bootstrap'); const l = proposal('L-guardian', 'author-a', [{ op: 'set_item', block: 'booking.hold', path: 'requirements.exclusive', expected: { kind: 'value', value: EXCLUSIVE }, value: { ...EXCLUSIVE, facets: ['behavior', 'data'] } }]); e.layer(l, 'author-a'); e.publish('L-guardian@1', 'author-a');
  const c = recipe('C-guardian'); c.proposals = c.selected = ['L-guardian@1']; c.alternative_groups = []; const candidate = e.compose(c); const { validation } = unitValidation(e, candidate); const list = approvals(e, candidate, validation.evidence_digest);
  assert.throws(() => e.release(candidate.ref, validation.ref, list), error('GUARDIAN_REQUIRED'));
  list.push(e.approve({ kind: 'guardian', target: candidate.fingerprint, scope: 'booking.hold/requirements.exclusive', evidence_digest: validation.evidence_digest }, 'safety-guardian').ref); assert.equal(e.release(candidate.ref, validation.ref, list).state, 'validated');
});
test('flatten is idempotent and complete Release snapshots work without Layer replay', () => {
  const { engine, candidate } = prepared(); const { validation } = unitValidation(engine, candidate); const list = approvals(engine, candidate, validation.evidence_digest);
  const first = engine.release(candidate.ref, validation.ref, list); const retry = engine.release(candidate.ref, validation.ref, [...list].reverse()); assert.equal(first.ref, retry.ref); assert.equal(retry.reused, true);
  const release = engine.read(first.ref, 'release'); const standalone = new Engine({ [first.ref]: { type: 'release', published: true, data: release } });
  const c = recipe('C-inherit', first.ref); c.proposals = []; c.selected = []; c.alternative_groups = []; const next = standalone.compose(c);
  assert.equal(next.snapshot.blocks['booking.hold'].requirements.expiry.parameters.seconds, 900); assert.equal(next.snapshot.blocks['booking.reminder'].requirements.timing.parameters.enabled, true); assert.ok(next.snapshot.blocks['booking.reminder'].acceptance['layer-reminder']); assert.deepEqual(next.snapshot.blocks['booking.hold'].requirements.exclusive.facets, ['behavior', 'data', 'safety']);
  assert.deepEqual(next.provenance['booking.hold/requirements.expiry'], ['L-hold@1']); assert.deepEqual(next.provenance['booking.reminder/acceptance.layer-reminder'], ['L-reminder@1']);
});
test('immutable references cannot be overwritten and lists expose a stable explicit cursor', () => {
  const { engine } = prepared(); assert.throws(() => engine.store('C-demo@1', 'composition', recipe('different')), error('IMMUTABLE_REFERENCE'));
  const first: any = engine.inspect('layer', undefined, 'reader', 2); assert.equal(first.items.length, 2); assert.ok(first.next_cursor); const second: any = engine.inspect('layer', undefined, 'reader', 2, first.next_cursor); assert.ok(!first.items.some((r: string) => second.items.includes(r)));
});
