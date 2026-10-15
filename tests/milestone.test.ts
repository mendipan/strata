import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunBudget } from '../src/budget.js';
import { publishPrepared, type PreparedLayer, type Registry } from '../src/publication.js';
import { measuredOverlap } from '../src/trace.js';
import { formatHuman, runCli } from '../src/cli.js';
import { StrataError } from '../src/model.js';

const error = (code: string) => (e: unknown) => e instanceof StrataError && e.code === code;
test('budget reservations are atomic across simultaneous dispatches, charge failure and reject retries/deadline/stop', async () => {
  let now = 0;
  const budget = new RunBudget({ operations: 2, bytes: 10, input_tokens: 0, output_tokens: 0, attempts: 2, duration_ms: 100 }, () => now);
  const dispatched: number[] = [];
  const results = await Promise.allSettled([0, 1, 2].map(async i => { budget.reserve({ operations: 1, attempts: 1, bytes: 5 }); dispatched.push(i); await Promise.resolve(); if (i === 0) throw new Error('ambiguous request'); }));
  assert.deepEqual(dispatched, [0, 1]); assert.equal(results.filter(r => r.status === 'rejected').length, 2);
  assert.deepEqual(budget.snapshot().reserved, { operations: 2, attempts: 2, bytes: 10, input_tokens: 0, output_tokens: 0 });
  assert.throws(() => budget.reserve({ input_tokens: 1 }), error('BUDGET_EXHAUSTED'));
  assert.throws(() => budget.reserve({ operations: -1 }), error('INVALID_BUDGET'));
  now = 100; assert.throws(() => budget.check(), error('BUDGET_DEADLINE')); budget.stop(); assert.throws(() => budget.check(), error('RUN_STOPPED'));
});
test('deadline bounds a stalled provider mock and forbids any subsequent dispatch', async () => {
  const budget = new RunBudget({ operations: 1, bytes: 0, input_tokens: 0, output_tokens: 0, attempts: 1, duration_ms: 10 });
  budget.reserve({ operations: 1, attempts: 1 });
  await assert.rejects(budget.bounded(() => new Promise<never>(() => {})), error('BUDGET_DEADLINE'));
  assert.equal(budget.snapshot().stopped, true); assert.equal(budget.snapshot().reserved.operations, 1);
  assert.throws(() => budget.reserve({ operations: 0 }), error('RUN_STOPPED'));
});
const prepared = (id: string): PreparedLayer => ({ id, principal: 'author-a', expected_head: null, refs: {}, ref: id + '@1', entry: { type: 'layer', hash: id, published: false }, record: { type: 'layer', data: { id, revision: 1, owner: 'author-a' }, published: false }, head: { owner: 'author-a', head: 1 } });
test('concurrent preparations merge into current registry; head/reference CAS and immutable collision fail closed', () => {
  const empty: Registry = { entries: {}, heads: {} }, a = prepared('A'), b = prepared('B');
  const merged = publishPrepared(publishPrepared(empty, a), b); assert.deepEqual(Object.keys(merged.entries), ['A@1', 'B@1']);
  assert.throws(() => publishPrepared(merged, a), error('STALE_REVISION'));
  const peer = { ...a, principal: 'author-b' }; assert.throws(() => publishPrepared(merged, peer), error('OWNER_FORBIDDEN'));
  const reference = { ...b, expected_head: merged.heads.B, refs: { 'A@1': { ...merged.entries['A@1'], published: true } } }; assert.throws(() => publishPrepared(merged, reference), error('STALE_REVISION'));
  const collision = { ...b, expected_head: merged.heads.B, entry: { ...b.entry, hash: 'different' } }; assert.throws(() => publishPrepared(merged, collision), error('IMMUTABLE_REFERENCE'));
});
test('overlap excludes zero-duration/queued spans, counts distinct actors and handles touching intervals', () => {
  const spans = [
    { actor: 'A', phase: 'storage-io', start_ms: 0, end_ms: 10 }, { actor: 'A', phase: 'hash', start_ms: 1, end_ms: 9 },
    { actor: 'B', phase: 'hash', start_ms: 5, end_ms: 10 }, { actor: 'C', phase: 'storage-io', start_ms: 10, end_ms: 20 },
    { actor: 'D', phase: 'storage-io', start_ms: 2, end_ms: 2 }, { actor: 'E', phase: 'queue', start_ms: 0, end_ms: 20 }
  ];
  const result = measuredOverlap(spans, ['hash', 'storage-io']); assert.equal(result.peak_distinct_actors, 2); assert.equal(result.overlap_ms, 5); assert.equal(result.zero_duration_spans, 1);
});
test('readable CLI explains capabilities/errors while JSON/default retains its stable envelope', async () => {
  const help = await runCli(['--help', '--human']); assert.match(formatHuman(help), /layer create/); assert.match(formatHuman(help), /stable machine envelope/);
  const failed = await runCli(['status', '--human', '--json']); assert.equal(failed.exit_code, 2); assert.match(formatHuman(failed), /INVALID_ARGUMENT/);
  const version = await runCli(['--version']); assert.equal(version.protocol_version, '1'); assert.equal(version.exit_code, 0);
});
