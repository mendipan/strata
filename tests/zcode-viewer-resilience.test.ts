import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { StrataError } from '../src/model.js';
import { OrderedSyntheticFeed, type SyntheticViewEvent } from '../demo/ordered-feed.js';
import {
  compareWorkflowSnapshots,
  parseWorkflowSnapshot,
  type ImportedWorkflowSnapshot
} from '../src/integrated-demo-visualization.js';
import {
  integratedDemoReplayData,
  renderIntegratedDemoReplayHtml,
  renderIntegratedDemoWorkflowSnapshotHtml
} from '../src/integrated-demo-replay.js';

// Additive zcode-viewer resilience checks. Existing coverage and the exact case each test
// contributes are recorded in translation/README.md.
const root = process.cwd();
const rehearsalSource = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/demo/rehearsal.json'), 'utf8')) as unknown;
const replay = integratedDemoReplayData(rehearsalSource);
const fixtureDir = path.join(root, 'tests/fixtures/zcode-viewer');
const readFixture = (name: string) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8')) as unknown;
const importedAt = '2026-10-06T00:00:00.000Z';
const workflowStatusRefused = (error: unknown) => error instanceof StrataError && error.code === 'DEMO_STATUS_REFUSED' && error.exit === 4;

function viewEvent(patch: Partial<SyntheticViewEvent>): SyntheticViewEvent {
  const base = structuredClone(replay.branches[0]!.events[1]!) as SyntheticViewEvent;
  return { ...base, ...patch };
}
function otherRunEvent(sequence: number): SyntheticViewEvent {
  const runId = 'ffffffffffffffff';
  return viewEvent({ run_id: runId, instance_id: `run-${runId}`, sequence });
}

test('feed rejects an invalid-field mutation matrix without losing accepted state', () => {
  const feed = new OrderedSyntheticFeed();
  assert.equal(feed.accept(replay.branches[0]!.events[0]).decision, 'applied');
  const before = structuredClone(feed.records);
  const mutations: Array<Partial<SyntheticViewEvent> | unknown> = [
    null, [], 'not-an-object',
    { sequence: 0 }, { sequence: -1 }, { sequence: 1.5 }, { sequence: Number.NaN }, { sequence: 2 ** 53 }, { sequence: '2' },
    { run_id: 'xyz' }, { run_id: 'fffffffffffffff' }, { instance_id: 'run-' + 'f'.repeat(16) },
    { event_digest: 'f'.repeat(63) }, { kind: 'malicious' }, { phase_before: 'paused' }, { branch: '9000' },
    { format: 'strata.integrated-demo-view-event/2' }, { mode: 'live' },
    { actor: 'a'.repeat(81) }, { outcome: 'o'.repeat(81) }, { summary: 's'.repeat(241) },
    { layer_ref: 'bad ref@1' }, { packet_digest: 'f'.repeat(63) }
  ];
  for (const mutation of mutations) {
    const candidate = mutation && typeof mutation === 'object' && !Array.isArray(mutation)
      ? viewEvent(mutation as Partial<SyntheticViewEvent>) : mutation;
    assert.equal(feed.accept(candidate).decision, 'invalid', JSON.stringify(mutation));
    assert.equal(feed.nextSequence, 2, JSON.stringify(mutation));
  }
  assert.deepEqual(feed.records, before);
  assert.equal(feed.accept(replay.branches[0]!.events[1]).decision, 'applied', 'valid delivery still applies after refusals');
});

test('forged same-digest redelivery is deduplicated and the last accepted view is retained', () => {
  const feed = new OrderedSyntheticFeed();
  feed.accept(replay.branches[0]!.events[0]);
  const forged = { ...structuredClone(replay.branches[0]!.events[0]!), summary: 'tampered summary reusing a declared digest' };
  assert.equal(forged.event_digest, feed.records[0]!.event_digest, 'fixture setup: forged event reuses the declared digest');
  const result = feed.accept(forged);
  assert.equal(result.decision, 'duplicate');
  assert.equal(feed.records[0]!.summary, replay.branches[0]!.events[0]!.summary, 'accepted bytes are not replaced');
  // Documented trust boundary: OrderedSyntheticFeed deduplicates on the declared event_digest;
  // byte-level verification happens upstream in syntheticViewEvents, which computes the digest
  // from the source rehearsal event before any view event exists.
});

test('feed run switch refuses without reset, recovers via reset, and keeps history per run', () => {
  const feed = new OrderedSyntheticFeed();
  assert.equal(feed.accept(replay.branches[0]!.events[0]).decision, 'applied');
  assert.equal(feed.accept(replay.branches[0]!.events[1]).decision, 'applied');
  assert.equal(feed.accept(otherRunEvent(3)).decision, 'conflict', 'a different run identity at one feed is a conflict');
  assert.equal(feed.accept(replay.branches[0]!.events[2]).decision, 'conflict', 'the stopped feed refuses even the original run');
  assert.equal(feed.records.every(event => event.run_id === replay.branches[0]!.run_id), true, 'no foreign-run event entered history');

  feed.reset();
  assert.equal(feed.nextSequence, 1);
  assert.equal(feed.accept(otherRunEvent(1)).decision, 'applied');
  assert.equal(feed.accept(otherRunEvent(1)).decision, 'duplicate');
  assert.equal(feed.accept(replay.branches[0]!.events[0]).decision, 'conflict', 'after reset the new run identity is exclusive');
  assert.deepEqual(feed.records.map(event => event.run_id), ['ffffffffffffffff'], 'history belongs only to the selected run');
});

test('mixed-delivery chain retains the last accepted view through every refusal', () => {
  const events = replay.branches[0]!.events;
  const feed = new OrderedSyntheticFeed();
  assert.equal(feed.accept(events[0]).decision, 'applied');

  const malformed = structuredClone(events[1]!) as Partial<SyntheticViewEvent>;
  delete malformed.summary;
  assert.equal(feed.accept(malformed).decision, 'invalid');
  assert.equal(feed.nextSequence, 2);

  const forgedDuplicate = { ...structuredClone(events[0]!), summary: 'declared-digest redelivery' };
  assert.equal(feed.accept(forgedDuplicate).decision, 'duplicate');
  assert.equal(feed.nextSequence, 2);

  const partial = feed.accept(events[2]);
  assert.equal(partial.decision, 'buffered');
  assert.equal(partial.missing_sequence, 2);
  assert.equal(feed.records.length, 1, 'a gap adds nothing to the accepted history');

  const newer = feed.accept(events[1]);
  assert.equal(newer.decision, 'applied');
  assert.deepEqual(newer.applied.map(event => event.sequence), [2, 3]);
  assert.deepEqual(feed.records.map(event => event.sequence), [1, 2, 3]);
  assert.equal(feed.accept(events[1]).decision, 'duplicate', 're-delivery after acceptance does not duplicate events');

  const pruned = new OrderedSyntheticFeed(64, 1);
  pruned.accept(events[0]);
  pruned.accept(events[1]);
  assert.equal(pruned.records.length, 1, 'bounded history prunes the oldest applied event');
  assert.equal(pruned.accept(events[0]).decision, 'stale', 'a pruned sequence is stale, not duplicate');
  assert.equal(pruned.nextSequence, 3);
});

test('bounded buffer refuses unsafe gaps and a full buffer without applying anything', () => {
  const gapFeed = new OrderedSyntheticFeed(2);
  assert.equal(gapFeed.accept(viewEvent({ sequence: 3 })).decision, 'buffered');
  assert.equal(gapFeed.accept(viewEvent({ sequence: 4 })).decision, 'conflict', 'gap wider than the buffer stops the feed');
  assert.equal(gapFeed.nextSequence, 1);
  assert.equal(gapFeed.accept(replay.branches[0]!.events[0]).decision, 'conflict');

  const fullFeed = new OrderedSyntheticFeed(3);
  for (const sequence of [2, 3, 4]) assert.equal(fullFeed.accept(viewEvent({ sequence })).decision, 'buffered');
  assert.equal(fullFeed.accept(viewEvent({ sequence: 5 })).decision, 'conflict', 'a wider gap against a full buffer stops the feed');
  assert.equal(fullFeed.nextSequence, 1);
  assert.equal(fullFeed.records.length, 0);

  const drainFeed = new OrderedSyntheticFeed(3);
  for (const sequence of [2, 3, 4]) assert.equal(drainFeed.accept(viewEvent({ sequence })).decision, 'buffered');
  const drained = drainFeed.accept(replay.branches[0]!.events[0]);
  assert.equal(drained.decision, 'applied');
  assert.deepEqual(drained.applied.map(event => event.sequence), [1, 2, 3, 4], 'the in-range filler applies and drains a full buffer in order');
});

test('snapshot run switch is an explicit view replacement, never a merge', () => {
  const current = parseWorkflowSnapshot(readFixture('description.json'), importedAt);
  assert.equal(current.completeness, 'checkpoint');
  assert.equal(compareWorkflowSnapshots(null, current).decision, 'accept', 'first import becomes the view');

  const otherRun: ImportedWorkflowSnapshot = { ...structuredClone(current), run_id: 'ffffffffffffffff',
    instance_id: 'run-ffffffffffffffff', sequence: 1, checkpoint_digest: 'd'.repeat(64) };
  const switched = compareWorkflowSnapshots(current, otherRun);
  assert.equal(switched.decision, 'accept', 'a different run is accepted for viewing');
  assert.equal(switched.message, 'Snapshot selected for viewing.');
  assert.notEqual(otherRun.checkpoint_digest, current.checkpoint_digest);
  assert.notEqual(otherRun.run_id, current.run_id);
  assert.equal(otherRun.decision_receipts.length, current.decision_receipts.length, 'fixture setup: same receipt count');
  assert.equal(otherRun.decision_receipts.some(receipt => current.decision_receipts.includes(receipt)), false,
    'run switch swaps identities; receipts are per-snapshot and never merged into the previous run');
});

test('snapshot reconnect chain keeps last good state and refuses changed history or receipts', () => {
  const complete = parseWorkflowSnapshot(readFixture('description-completed.json'), importedAt);
  const sequence = complete.sequence!;
  const same = { ...structuredClone(complete), imported_at: '2026-10-06T00:01:00.000Z' };
  const statusOnly: ImportedWorkflowSnapshot = { ...structuredClone(complete), sequence: null, checkpoint_digest: null,
    completeness: 'status-only', phase: null, trace: [], pending_packet: null };
  assert.equal(compareWorkflowSnapshots(complete, statusOnly).decision, 'partial');
  assert.equal(compareWorkflowSnapshots(complete, { ...structuredClone(complete), sequence: sequence - 1, checkpoint_digest: 'a'.repeat(64) }).decision, 'stale');
  assert.equal(compareWorkflowSnapshots(complete, same).decision, 'duplicate');
  assert.deepEqual(same.decision_receipts.map(receipt => receipt.receipt_digest), complete.decision_receipts.map(receipt => receipt.receipt_digest),
    'duplicate delivery adds no receipt');
  assert.equal(compareWorkflowSnapshots(complete, { ...structuredClone(complete), checkpoint_digest: 'b'.repeat(64) }).decision, 'conflict');

  const extended = (trace: ImportedWorkflowSnapshot['trace'], receipts?: ImportedWorkflowSnapshot['decision_receipts']): ImportedWorkflowSnapshot =>
    ({ ...structuredClone(complete), sequence: sequence + 1, checkpoint_digest: 'c'.repeat(64),
      trace, ...(receipts ? { decision_receipts: receipts } : {}) });
  const nextTrace = [...structuredClone(complete.trace), { ...structuredClone(complete.trace.at(-1)!), sequence: sequence + 1 }];
  assert.equal(compareWorkflowSnapshots(complete, extended(nextTrace)).decision, 'accept', 'newer checkpoint with a matching prefix is accepted');

  const tamperedPrefix = structuredClone(nextTrace);
  tamperedPrefix[0] = { ...tamperedPrefix[0]!, outcome: 'tampered-outcome' };
  assert.equal(compareWorkflowSnapshots(complete, extended(tamperedPrefix)).decision, 'conflict', 'changed trace prefix is refused');

  const tamperedReceipts = structuredClone(complete.decision_receipts);
  tamperedReceipts[0] = { ...tamperedReceipts[0]!, receipt_digest: '9'.repeat(64) };
  assert.equal(compareWorkflowSnapshots(complete, extended(nextTrace, tamperedReceipts)).decision, 'conflict', 'changed prior receipt is refused');
});

test('status-only duplicates never replace a complete checkpoint and complete always upgrades', () => {
  const statusOnly = parseWorkflowSnapshot(readFixture('description-status-only.json'), importedAt);
  assert.equal(statusOnly.completeness, 'status-only');
  assert.equal(statusOnly.phase, null);
  assert.equal(statusOnly.sequence, null);
  assert.equal(compareWorkflowSnapshots(null, statusOnly).decision, 'accept', 'a status-only import can be the first view');
  assert.equal(compareWorkflowSnapshots(statusOnly, { ...structuredClone(statusOnly), imported_at: '2026-10-06T00:02:00.000Z' }).decision, 'partial',
    'repeated metadata-only imports stay partial');
  const complete = parseWorkflowSnapshot(readFixture('description.json'), '2026-10-06T00:03:00.000Z');
  assert.equal(compareWorkflowSnapshots(statusOnly, complete).decision, 'accept', 'a complete checkpoint upgrades a status-only view');
  assert.equal(compareWorkflowSnapshots(complete, statusOnly).decision, 'partial', 'and never the reverse');
});

test('snapshot parser refuses wrong nested types and stays inert or status-only', () => {
  const description = readFixture('description.json') as Record<string, unknown>;
  assert.throws(() => parseWorkflowSnapshot(null, importedAt), /must be an object/);
  assert.throws(() => parseWorkflowSnapshot('text', importedAt), /must be an object/);
  assert.throws(() => parseWorkflowSnapshot([...(description.steps as unknown[])], importedAt), /must be an object/);
  assert.throws(() => parseWorkflowSnapshot({ ...description, status: 'live' }, importedAt), /supported status/);
  assert.throws(() => parseWorkflowSnapshot({ ...description, id: 'run-' + 'f'.repeat(16) }, importedAt), workflowStatusRefused);
  const brokenStep = structuredClone(description) as { steps: unknown[] };
  brokenStep.steps[3] = 'not-an-object';
  assert.throws(() => parseWorkflowSnapshot(brokenStep, importedAt), /Workflow step must be an object/);

  const nonArraySteps = parseWorkflowSnapshot({ ...description, steps: 'nope' }, importedAt);
  assert.equal(nonArraySteps.completeness, 'status-only', 'a non-array steps value degrades to status-only, not a crash');
  assert.equal(nonArraySteps.phase, null);

  const brokenSequence = structuredClone(description) as { steps: any[] };
  const lastApply = brokenSequence.steps.filter((step: any) => /^apply-\d+$/.test(step.name)).at(-1)!;
  lastApply.output.checkpoint.sequence = 'not-a-number';
  assert.throws(() => parseWorkflowSnapshot(brokenSequence, importedAt), workflowStatusRefused);

  const stringOutputs = structuredClone(description) as { steps: any[] };
  for (const step of stringOutputs.steps) if (/^apply-\d+$/.test(step.name)) step.output = JSON.stringify(step.output);
  const fromStrings = parseWorkflowSnapshot(stringOutputs, importedAt);
  assert.equal(fromStrings.completeness, 'checkpoint', 'string-encoded step outputs are parsed, not trusted');
  assert.equal(fromStrings.checkpoint_digest, parseWorkflowSnapshot(description, importedAt).checkpoint_digest);

  const wrapped = parseWorkflowSnapshot({ result: structuredClone(description) }, importedAt);
  assert.equal(wrapped.completeness, 'checkpoint', 'a result-wrapped description unwraps to the same checkpoint');
  assert.equal(wrapped.checkpoint_digest, parseWorkflowSnapshot(description, importedAt).checkpoint_digest);
});

test('reordered, repeated and failed authoritative applies refuse without replacing the accepted snapshot', () => {
  const description = readFixture('description.json') as { steps: unknown[] };
  const canonical = parseWorkflowSnapshot(description, importedAt);
  let accepted = canonical;
  const acceptedBytes = JSON.stringify(accepted);
  const importNext = (next: unknown) => { accepted = parseWorkflowSnapshot(next, importedAt); };
  const refusesWithoutReplacement = (next: unknown) => {
    assert.throws(() => importNext(next), workflowStatusRefused);
    assert.strictEqual(accepted, canonical);
    assert.equal(JSON.stringify(accepted), acceptedBytes, 'refusal preserves the complete accepted view');
  };
  refusesWithoutReplacement({ ...structuredClone(description), steps: [...description.steps].reverse() });

  const failedLatest = structuredClone(description) as { steps: Array<{ name: string; success: boolean }> };
  const applies = failedLatest.steps.filter(step => /^apply-\d+$/.test(step.name));
  applies.at(-1)!.success = false;
  refusesWithoutReplacement(failedLatest);

  const repeated = structuredClone(description) as { steps: Array<{ name: string; success: boolean }> };
  repeated.steps.push(structuredClone(repeated.steps.filter(step => /^apply-\d+$/.test(step.name)).at(-1)!));
  refusesWithoutReplacement(repeated);

  // An actual earlier complete export remains valid. Do not manufacture that
  // fallback by ignoring a failed authoritative step in a newer export.
  const prior = structuredClone(description) as { steps: Array<{ name: string }> };
  const newestName = prior.steps.filter(step => /^apply-\d+$/.test(step.name)).at(-1)!.name;
  prior.steps = prior.steps.filter(step => step.name !== newestName);
  const earlier = parseWorkflowSnapshot(prior, importedAt);
  assert.equal(earlier.completeness, 'checkpoint');
  assert.equal(earlier.sequence, canonical.sequence! - 1);
  assert.equal(earlier.pending_packet, null);
  assert.equal(compareWorkflowSnapshots(accepted, earlier).decision, 'stale');
  assert.equal(JSON.stringify(accepted), acceptedBytes);
});

test('preview CLI fails closed on malformed input and never overwrites output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zcode-viewer-cli-'));
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/no-external-fetch.mjs')).href,
      path.join(root, 'dist/scripts/integrated-demo-replay-preview.js'), ...args], { cwd: root, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    const full = readFileSync(path.join(fixtureDir, 'description.json'), 'utf8');
    const truncatedPath = path.join(directory, 'truncated.json');
    await writeFile(truncatedPath, full.slice(0, Math.floor(full.length * 0.6)), 'utf8');
    const truncated = await run(['snapshot', truncatedPath, path.join(directory, 'truncated.html')]);
    assert.equal(truncated.code, 1, truncated.stderr);
    assert.match(truncated.stderr, /Could not prepare local replay preview/);
    assert.equal(existsSync(path.join(directory, 'truncated.html')), false, 'no output is written for malformed input');

    const brokenTypes = path.join(directory, 'broken.json');
    await writeFile(brokenTypes, JSON.stringify({ id: 'run-' + 'a'.repeat(16), status: 'paused', steps: ['not-an-object'] }), 'utf8');
    const broken = await run(['snapshot', brokenTypes, path.join(directory, 'broken.html')]);
    assert.equal(broken.code, 1, broken.stderr);
    assert.equal(existsSync(path.join(directory, 'broken.html')), false);

    const goodPath = path.join(directory, 'snapshot.html');
    const good = await run(['snapshot', path.join(fixtureDir, 'description.json'), goodPath]);
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, /origin unverified/);
    const html = readFileSync(goodPath, 'utf8');
    assert.match(html, /Imported JSON - origin unverified/);
    assert.equal(html.includes('@@WORKFLOW_SNAPSHOT@@'), false);

    const overwrite = await run(['snapshot', path.join(fixtureDir, 'description.json'), goodPath]);
    assert.equal(overwrite.code, 1, 'existing output files are never overwritten');
    assert.match(overwrite.stderr, /Could not prepare local replay preview/);

    const replayPath = path.join(directory, 'replay.html');
    const replayRun = await run([path.join(root, 'tests/fixtures/demo/rehearsal.json'), replayPath]);
    assert.equal(replayRun.code, 0, replayRun.stderr);
    const replayHtml = readFileSync(replayPath, 'utf8');
    assert.match(replayHtml, /Synthetic fixture replay/);
    assert.match(replayHtml, /"real_model_calls":0/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('snapshot template safely renders hostile receipt labels, step names, and metadata strings', () => {
  const template = readFileSync(path.join(root, 'demo/integrated-demo-workflow-snapshot.template.html'), 'utf8');
  const hostile = '</script><script>alert(1)</script>';
  const hostileMeta = 'controlled-private live operator - not authenticated';
  const description = structuredClone(readFixture('description-completed.json')) as {
    steps: Array<{ name?: string; event_type?: string; output?: { checkpoint: { receipts: Array<{ operator_label?: string }> } } }> };
  for (const step of description.steps) {
    if (step.name === 'wait-for-selection') { step.name = '<img src=x onerror=alert(2)>'; step.event_type = hostile; }
    if (step.name?.startsWith('receive-')) step.name = hostile;
  }
  const applies = description.steps.filter(step => /^apply-\d+$/.test(step.name ?? ''));
  const lastCheckpoint = applies.at(-1)!.output!.checkpoint;
  lastCheckpoint.receipts[0]!.operator_label = hostile;
  lastCheckpoint.receipts[1]!.operator_label = hostileMeta;

  const snapshot = parseWorkflowSnapshot(description, importedAt);
  assert.equal(snapshot.decision_receipts.length, 2, 'hostile labels are data and do not block parsing');
  assert.equal(snapshot.decision_receipts[0]!.declared_operator_label, hostile);
  assert.equal(snapshot.decision_receipts.every(receipt => receipt.authenticated === false), true, 'labels never elevate trust');
  const html = renderIntegratedDemoWorkflowSnapshotHtml(template, snapshot);
  assert.equal(html.includes(hostile), false, 'no raw script-closing bytes in the data slot');
  assert.equal(html.includes('<img src=x onerror=alert(2)>'), false);
  assert.equal(html.split('\\u003c/script\\u003e').length - 1 >= 3, true, 'payload slot escapes hostile angle brackets');
  assert.equal((html.match(/Imported JSON - origin unverified/g) ?? []).length, 1, 'the unverified-origin banner is exactly the static label');
  assert.match(html, /Identity and consent are not authenticated/);
  assert.match(html, /controlled-private live operator - not authenticated/);
  assert.throws(() => renderIntegratedDemoWorkflowSnapshotHtml(`${template}\n<!-- @@WORKFLOW_SNAPSHOT@@ -->`, snapshot), /one snapshot data slot/);
});

test('browser harness failure paths are bounded, cleaned up, and accurately reported', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zcode-viewer-harness-'));
  const runDriver = (env: Record<string, string>) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/no-external-fetch.mjs')).href,
      path.join(root, 'tests/zcode-viewer-browser.mjs')], { cwd: root, windowsHide: true, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    // Blocked discovery: an authoritative executable override that does not exist must not
    // fall through to another browser; nothing is launched.
    const blocked = await runDriver({ STRATA_VIEWER_BROWSER: path.join(directory, 'missing-browser.exe'),
      STRATA_VIEWER_EVIDENCE: path.join(directory, 'blocked.json'), STRATA_VIEWER_PAGES_DIR: path.join(directory, 'pages') });
    assert.equal(blocked.code, 3, blocked.stderr);
    assert.match(blocked.stdout, /BLOCKED/);
    const blockedEvidence = JSON.parse(readFileSync(path.join(directory, 'blocked.json'), 'utf8')) as { status: string };
    assert.equal(blockedEvidence.status, 'blocked');

    // Bounded startup failure: an executable that is not a browser exits before exposing an
    // endpoint; the driver fails within its startup bound and removes its throwaway profile.
    const startup = await runDriver({ STRATA_VIEWER_BROWSER: process.execPath,
      STRATA_VIEWER_EVIDENCE: path.join(directory, 'startup.json'), STRATA_VIEWER_PAGES_DIR: path.join(directory, 'pages') });
    assert.equal(startup.code, 1, startup.stderr);
    assert.match(startup.stderr, /before exposing a DevTools endpoint|DevTools endpoint did not appear/);
    const startupEvidence = JSON.parse(readFileSync(path.join(directory, 'startup.json'), 'utf8')) as { status: string; cleanup: { profile_removed: boolean } };
    assert.equal(startupEvidence.status, 'fatal');
    assert.equal(startupEvidence.cleanup.profile_removed, true, JSON.stringify(startupEvidence.cleanup));

    // An existing but invalid executable: spawn fails synchronously or asynchronously
    // (UNKNOWN). The whole lifecycle from profile creation onward must still be cleaned up.
    const invalidExe = path.join(directory, 'invalid-browser.exe');
    await writeFile(invalidExe, 'this file exists but is not a valid executable\n', 'utf8');
    const invalid = await runDriver({ STRATA_VIEWER_BROWSER: invalidExe,
      STRATA_VIEWER_EVIDENCE: path.join(directory, 'invalid.json'), STRATA_VIEWER_PAGES_DIR: path.join(directory, 'pages') });
    assert.equal(invalid.code, 1, invalid.stderr);
    const invalidEvidence = JSON.parse(readFileSync(path.join(directory, 'invalid.json'), 'utf8')) as {
      status: string; fatal?: string; cleanup: { browser_exited: boolean; profile_removed: boolean } | null };
    assert.equal(invalidEvidence.status, 'fatal');
    assert.ok(invalidEvidence.cleanup, 'cleanup must be recorded even when the browser never started');
    assert.equal(invalidEvidence.cleanup!.profile_removed, true, JSON.stringify(invalidEvidence.cleanup));

    // Assertion failure: a forced failing check yields exit 1, recorded evidence, and bounded cleanup.
    const browser = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(candidate => existsSync(candidate));
    if (!browser) { process.stdout.write('no local Chromium/Edge runtime: browser-dependent harness runs skipped\n'); return; }
    const forced = await runDriver({ STRATA_VIEWER_BROWSER: browser, STRATA_VIEWER_TEST_FORCE_FAIL: '1', STRATA_VIEWER_TEST_STOP_EARLY: '1',
      STRATA_VIEWER_EVIDENCE: path.join(directory, 'forced.json'), STRATA_VIEWER_PAGES_DIR: path.join(directory, 'pages') });
    assert.equal(forced.code, 1, forced.stderr);
    const forcedEvidence = JSON.parse(readFileSync(path.join(directory, 'forced.json'), 'utf8')) as {
      status: string; checks: Array<{ name: string; status: string }>; cleanup: { browser_exited: boolean; profile_removed: boolean } };
    assert.equal(forcedEvidence.status, 'fail');
    assert.ok(forcedEvidence.checks.some(item => item.name === 'forced-failure-probe' && item.status === 'fail'));
    assert.equal(forcedEvidence.cleanup.browser_exited, true, JSON.stringify(forcedEvidence.cleanup));
    assert.equal(forcedEvidence.cleanup.profile_removed, true, JSON.stringify(forcedEvidence.cleanup));

    // CDP connection failure: an invalid target path on the driver's OWN endpoint must be
    // rejected within the connection bound, with verified cleanup.
    const brokenWs = await runDriver({ STRATA_VIEWER_BROWSER: browser, STRATA_VIEWER_TEST_BROKEN_WS: '1',
      STRATA_VIEWER_EVIDENCE: path.join(directory, 'broken-ws.json'), STRATA_VIEWER_PAGES_DIR: path.join(directory, 'pages') });
    assert.equal(brokenWs.code, 1, brokenWs.stderr);
    const brokenWsEvidence = JSON.parse(readFileSync(path.join(directory, 'broken-ws.json'), 'utf8')) as {
      status: string; fatal?: string; cleanup: { browser_exited: boolean; profile_removed: boolean } };
    assert.equal(brokenWsEvidence.status, 'fatal');
    assert.match(String(brokenWsEvidence.fatal ?? ''), /CDP (connection|WebSocket)/);
    assert.equal(brokenWsEvidence.cleanup.browser_exited, true, JSON.stringify(brokenWsEvidence.cleanup));
    assert.equal(brokenWsEvidence.cleanup.profile_removed, true, JSON.stringify(brokenWsEvidence.cleanup));

    // RPC failure: a request that never resolves must be rejected by its per-RPC bound.
    const hangRpc = await runDriver({ STRATA_VIEWER_BROWSER: browser, STRATA_VIEWER_TEST_HANG_RPC: '1', STRATA_VIEWER_RPC_BOUND_MS: '2500',
      STRATA_VIEWER_EVIDENCE: path.join(directory, 'hang-rpc.json'), STRATA_VIEWER_PAGES_DIR: path.join(directory, 'pages') });
    assert.equal(hangRpc.code, 1, hangRpc.stderr);
    const hangRpcEvidence = JSON.parse(readFileSync(path.join(directory, 'hang-rpc.json'), 'utf8')) as {
      status: string; fatal?: string; cleanup: { browser_exited: boolean; profile_removed: boolean } };
    assert.equal(hangRpcEvidence.status, 'fatal');
    assert.match(String(hangRpcEvidence.fatal ?? ''), /exceeded its 2500ms bound/);
    assert.equal(hangRpcEvidence.cleanup.browser_exited, true, JSON.stringify(hangRpcEvidence.cleanup));
    assert.equal(hangRpcEvidence.cleanup.profile_removed, true, JSON.stringify(hangRpcEvidence.cleanup));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('evidence labels stay accurate: synthetic replay zeros and unverified imported execution mode', () => {
  const replayHtml = renderIntegratedDemoReplayHtml(
    readFileSync(path.join(root, 'demo/integrated-demo-replay.template.html'), 'utf8'), replay);
  assert.match(replayHtml, /Synthetic fixture replay · not actual observed data/);
  assert.match(replayHtml, /"real_model_calls":0/);
  assert.match(replayHtml, /"actual_human_replies":0/);
  assert.match(replayHtml, /"provider_calls":0/);
  assert.match(replayHtml, /Fixture events are not actual observed actor or human activity/);
  assert.match(replayHtml, /do not author Layers, submit a choice, create approval, or publish a Release/);

  const snapshot = parseWorkflowSnapshot(readFixture('description.json'), importedAt);
  assert.equal(snapshot.execution_mode, 'controlled-private', 'execution mode passes through as declared metadata');
  assert.equal(snapshot.source, 'operator-supplied-json-unverified');
  assert.match(snapshot.message, /unverified/i);
  const snapshotHtml = renderIntegratedDemoWorkflowSnapshotHtml(
    readFileSync(path.join(root, 'demo/integrated-demo-workflow-snapshot.template.html'), 'utf8'), snapshot);
  assert.match(snapshotHtml, /Imported JSON - origin unverified/);
  assert.match(snapshotHtml, /This page itself performs no Cloudflare, model, or network call/);
  assert.match(snapshotHtml, /controlled-private/);
  assert.equal((snapshotHtml.match(/Authenticated/g) ?? []).length, 0, 'no authentication is claimed for imported data');
});
