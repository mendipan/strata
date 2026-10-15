import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/model.js';
import { DEMO_NOW, preparedFixture } from './integrated-demo-fixture.js';
import { runOperatorReplyCli } from '../scripts/integrated-demo-operator-reply.js';

async function withFiles(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-operator-reply-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function currentWorkflowDescription(fixture: Awaited<ReturnType<typeof preparedFixture>>['fixture']) {
  const apply = fixture.outputs.at(-1)!;
  return { result: { steps: [{ type: 'step', name: 'apply-' + fixture.checkpoint.sequence, success: true, output: apply }] } };
}

test('operator file CLI emits a packet, binds the supplied reply to it, and creates a non-live event preview', async () => withFiles(async directory => {
  const { fixture } = await preparedFixture(), statusPath = path.join(directory, 'workflow.json');
  const packetPath = path.join(directory, 'operator-packet.json'), replyPath = path.join(directory, 'operator-reply.json');
  const previewPath = path.join(directory, 'event-preview.json');
  await writeFile(statusPath, JSON.stringify(currentWorkflowDescription(fixture)));

  const packetResult = await runOperatorReplyCli(['packet', statusPath, packetPath]);
  const packet = JSON.parse(await readFile(packetPath, 'utf8'));
  assert.equal(packetResult.live_authorized, false);
  assert.equal(packet.packet_digest, fixture.checkpoint.pending!.digest);
  assert.equal(packet.decision.packet_digest, packet.packet_digest);
  assert.deepEqual(packet.allowed_actions, ['900', '1200', 'defer']);
  assert.equal(packet.reply_template.action, '');
  assert.match(packet.instructions, /separate reply JSON file/);
  assert.match(packet.attribution, /not authenticated/);

  const artifact = { ...packet.reply_template, action: '900', response_text: 'I select the 900-second option.',
    operator_label: 'Synthetic Operator', recorded_at: new Date(DEMO_NOW + 1000).toISOString() };
  await writeFile(replyPath, JSON.stringify(artifact));
  const eventResult = await runOperatorReplyCli(['event', statusPath, replyPath, previewPath], DEMO_NOW + 2000);
  const preview = JSON.parse(await readFile(previewPath, 'utf8'));
  assert.equal(eventResult.live_authorized, false); assert.equal(preview.live_authorized, false);
  assert.equal(preview.event_type, 'strata-demo-' + (fixture.checkpoint.sequence + 1));
  assert.equal(preview.payload.source, 'operator');
  assert.equal(preview.payload.input.source, 'operator-supplied-artifact');
  assert.equal(preview.payload.input.packet_digest, packet.packet_digest);
  assert.equal(preview.payload.input.artifact_digest, digest(artifact));
  assert.match(preview.attribution, /not authenticated/);

  fixture.setNow(DEMO_NOW + 2000);
  const applied = await fixture.sendEvent(preview.payload);
  assert.equal(applied.outcome.ok, true);
  assert.equal(applied.checkpoint.receipts[0].source, 'operator-supplied-artifact');
  assert.equal(applied.checkpoint.receipts[0].artifact_digest, digest(artifact));
  assert.equal(applied.checkpoint.phase, 'runner');
}));

test('local HTML review renders exact intent partitions, Block changes, dependencies and unmeasured acceptance gates', async () => withFiles(async directory => {
  const { fixture } = await preparedFixture(), statusPath = path.join(directory, 'workflow.json');
  const reviewPath = path.join(directory, 'selection-review.html');
  await writeFile(statusPath, JSON.stringify(currentWorkflowDescription(fixture)));

  const result = await runOperatorReplyCli(['review', statusPath, reviewPath]);
  const review = await readFile(reviewPath, 'utf8');
  assert.equal(result.live_authorized, false); assert.equal(result.review_only, true);
  assert.equal(result.packet_digest, fixture.checkpoint.pending!.digest);
  assert.match(review, /No choice preselected/);
  assert.match(review, /Validation status: <strong>not yet measured<\/strong>/);
  assert.match(review, /L-hold@1/); assert.match(review, /L-alternative@1/); assert.match(review, /L-reminder@1/);
  assert.match(review, /A hold expires exactly 600 seconds after it starts\./);
  assert.match(review, /A hold expires exactly 900 seconds after it starts\./);
  assert.match(review, /A hold expires exactly 1200 seconds after it starts\./);
  assert.match(review, /Send one reminder 60 seconds before hold expiry\./);
  assert.match(review, /Reminder: once at 840 seconds\./);
  assert.match(review, /Reminder: disabled\./);
  assert.match(review, /booking\.hold/); assert.match(review, /booking\.reminder/);
  assert.match(review, /booking\.expiry@1/); assert.match(review, /booking\.lifecycle@1/);
  assert.match(review, /Requires exact Layer <code>L-hold@1<\/code>/);
  assert.match(review, /separate Release approval/);
  assert.match(review, /identity or consent/);
  await assert.rejects(runOperatorReplyCli(['review', statusPath, reviewPath]), (error: any) => error.code === 'EEXIST');
}));

test('local HTML review escapes supplied text and refuses malformed mediation bytes or a stale apply', async () => withFiles(async directory => {
  const { fixture } = await preparedFixture();
  const statusPath = path.join(directory, 'workflow.json'), reviewPath = path.join(directory, 'escaped-review.html');
  const escapedDescription = structuredClone(currentWorkflowDescription(fixture));
  const escapedApply = escapedDescription.result.steps[0].output;
  escapedApply.outcome.data.business_request = '<img src=x onerror="alert(1)">';
  delete escapedApply.outcome.data.packet_digest;
  escapedApply.outcome.data.packet_digest = digest(escapedApply.outcome.data);
  escapedApply.checkpoint.pending.digest = escapedApply.outcome.data.packet_digest;
  await writeFile(statusPath, JSON.stringify(escapedDescription));
  await runOperatorReplyCli(['review', statusPath, reviewPath]);
  const escapedReview = await readFile(reviewPath, 'utf8');
  assert.ok(escapedReview.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.equal(escapedReview.includes('<img src=x onerror='), false);

  const malformedPath = path.join(directory, 'malformed.json'), malformedReview = path.join(directory, 'malformed.html');
  const malformed = structuredClone(currentWorkflowDescription(fixture)), malformedApply = malformed.result.steps[0].output;
  malformedApply.outcome.data.packet.packet_sha256 = '0'.repeat(64);
  delete malformedApply.outcome.data.packet_digest;
  malformedApply.outcome.data.packet_digest = digest(malformedApply.outcome.data);
  malformedApply.checkpoint.pending.digest = malformedApply.outcome.data.packet_digest;
  await writeFile(malformedPath, JSON.stringify(malformed));
  await assert.rejects(runOperatorReplyCli(['review', malformedPath, malformedReview]), (error: any) => error.code === 'DEMO_REVIEW_PACKET_REFUSED');
  await assert.rejects(readFile(malformedReview), (error: any) => error.code === 'ENOENT');

  const stalePath = path.join(directory, 'stale.json'), staleReview = path.join(directory, 'stale.html');
  const stale = structuredClone(currentWorkflowDescription(fixture));
  stale.result.steps.push({ type: 'step', name: 'apply-' + (fixture.checkpoint.sequence + 1), success: false, output: {} });
  await writeFile(stalePath, JSON.stringify(stale));
  await assert.rejects(runOperatorReplyCli(['review', stalePath, staleReview]), (error: any) => error.code === 'DEMO_OPERATOR_PACKET_REFUSED');
  await assert.rejects(readFile(staleReview), (error: any) => error.code === 'ENOENT');
}));

test('operator packet CLI refuses stale failed applies and reply artifacts for another packet', async () => withFiles(async directory => {
  const { fixture } = await preparedFixture(), statusPath = path.join(directory, 'workflow.json');
  const packetPath = path.join(directory, 'packet.json'), replyPath = path.join(directory, 'reply.json');
  const description = currentWorkflowDescription(fixture);
  const steps = description.result.steps;
  steps.push({ type: 'step', name: 'apply-' + (fixture.checkpoint.sequence + 1), success: false, output: {} });
  await writeFile(statusPath, JSON.stringify(description));
  await assert.rejects(runOperatorReplyCli(['packet', statusPath, packetPath]), (error: any) => error.code === 'DEMO_OPERATOR_PACKET_REFUSED');

  const validDescription = currentWorkflowDescription(fixture);
  await writeFile(statusPath, JSON.stringify(validDescription));
  await runOperatorReplyCli(['packet', statusPath, packetPath]);
  const packet = JSON.parse(await readFile(packetPath, 'utf8'));
  const badArtifact = { ...packet.reply_template, action: '900', response_text: 'Reply copied from a different packet.',
    operator_label: 'Synthetic Operator', packet_digest: 'f'.repeat(64), recorded_at: new Date(DEMO_NOW + 1000).toISOString() };
  await writeFile(replyPath, JSON.stringify(badArtifact));
  await assert.rejects(runOperatorReplyCli(['event', statusPath, replyPath, path.join(directory, 'bad-event.json')], DEMO_NOW + 2000),
    (error: any) => error.code === 'DEMO_OPERATOR_REPLY_REFUSED');
}));

test('interactive reply capture displays and confirms the exact packet, then writes a separate bound artifact', async () => withFiles(async directory => {
  const { fixture } = await preparedFixture(), statusPath = path.join(directory, 'workflow.json');
  const replyPath = path.join(directory, 'interactive-reply.json');
  await writeFile(statusPath, JSON.stringify(currentWorkflowDescription(fixture)));
  const answers = [fixture.checkpoint.pending!.digest, '900', 'I choose 900 seconds for this packet.', 'Synthetic Operator'];
  let displayed = '', closed = false;
  const result = await runOperatorReplyCli(['interactive', statusPath, replyPath], DEMO_NOW + 1000, {
    stdin_is_tty: true, stdout_is_tty: true, write: text => { displayed += text; },
    async ask() { return answers.shift()!; }, close() { closed = true; }
  });
  const artifact = JSON.parse(await readFile(replyPath, 'utf8'));
  assert.equal(result.live_authorized, false);
  assert.ok(String(result.attribution).includes('identity and consent are not authenticated'));
  assert.match(displayed, /Current Workflow decision packet/);
  assert.ok(displayed.includes(fixture.checkpoint.pending!.digest));
  assert.equal(closed, true);
  assert.equal(artifact.capture_method, 'local-interactive-terminal');
  assert.equal(artifact.packet_digest, fixture.checkpoint.pending!.digest);
  assert.equal(artifact.operator_label, 'Synthetic Operator');

  const previewPath = path.join(directory, 'interactive-event.json');
  await runOperatorReplyCli(['event', statusPath, replyPath, previewPath], DEMO_NOW + 2000);
  const preview = JSON.parse(await readFile(previewPath, 'utf8'));
  assert.equal(preview.capture_method, 'local-interactive-terminal');
  assert.equal(preview.payload.input.capture_method, 'local-interactive-terminal');
  assert.equal(preview.live_authorized, false);
}));

test('interactive reply capture refuses redirected terminals and an incorrect digest before creating a response file', async () => withFiles(async directory => {
  const { fixture } = await preparedFixture(), statusPath = path.join(directory, 'workflow.json');
  const redirectedPath = path.join(directory, 'redirected.json'), mismatchPath = path.join(directory, 'mismatch.json');
  await writeFile(statusPath, JSON.stringify(currentWorkflowDescription(fixture)));
  await assert.rejects(runOperatorReplyCli(['interactive', statusPath, redirectedPath], DEMO_NOW + 1000, {
    stdin_is_tty: false, stdout_is_tty: true, write() {}, async ask() { throw new Error('must not prompt'); }
  }), (error: any) => error.code === 'DEMO_OPERATOR_TTY_REQUIRED');
  await assert.rejects(readFile(redirectedPath), (error: any) => error.code === 'ENOENT');
  await assert.rejects(runOperatorReplyCli(['interactive', statusPath, mismatchPath], DEMO_NOW + 1000, {
    stdin_is_tty: true, stdout_is_tty: true, write() {}, async ask() { return 'f'.repeat(64); }
  }), (error: any) => error.code === 'DEMO_OPERATOR_PACKET_CONFIRMATION_REFUSED');
  await assert.rejects(readFile(mismatchPath), (error: any) => error.code === 'ENOENT');
}));
