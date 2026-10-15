import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/model.js';
import { demoFixture, requireDemoOk } from './integrated-demo-fixture.js';
import { checkpointDigest, DEMO_LIMITS, rehearsalLayer } from '../src/integrated-demo.js';
import { DemoHost } from '../src/integrated-demo-host.js';
import { measureDemoApp } from '../src/integrated-demo-runner.js';
import { createDemoActivationReview, createDemoActivationWorkerConfig, approveDemoActivationReview,
  readDemoActivationSource } from '../src/integrated-demo-activation.js';
import { cleanupReviewedDemoSession, startReviewedDemoSession } from '../src/integrated-demo-live.js';
import { type DemoManagementTarget } from '../src/integrated-demo-management.js';
import { WranglerCliDemoManagementProvider, type WranglerProcessInvocation, type WranglerProcessResult } from '../src/integrated-demo-management-wrangler.js';
import { parseWorkflowSnapshot, compareWorkflowSnapshots } from '../src/integrated-demo-visualization.js';
import { renderIntegratedDemoWorkflowSnapshotHtml } from '../src/integrated-demo-replay.js';
import { runOperatorReplyCli } from '../scripts/integrated-demo-operator-reply.js';
import { LOCAL_PROJECT } from '../src/security.js';

const target: DemoManagementTarget = { account_id: '1'.repeat(32), project_id: LOCAL_PROJECT, run_id: '0a1b2c3d4e5f6789',
  worker_name: 'strata-integrated-view-test', workflow_name: 'strata-integrated-view-flow', instance_id: 'run-0a1b2c3d4e5f6789',
  namespace_id: 'strata-view-test-namespace', repository_name: 'strata-view-run-0a1b2c3d4e5f6789' };

function workflowDescription(fixture: ReturnType<typeof demoFixture>, deleted: { instance: boolean; workflow: boolean; worker: boolean; repository: boolean }) {
  const steps: any[] = [{ type: 'step', name: 'claim-run', success: true, output: structuredClone(fixture.initialCheckpoint) }];
  for (let index = 0; index < fixture.outputs.length; index++) {
    const sequence = index + 1, output = fixture.outputs[index]!;
    steps.push({ type: 'waitForEvent', name: 'receive-' + sequence, success: true, event_type: 'strata-demo-' + sequence });
    steps.push({ type: 'step', name: 'reserve-' + sequence, success: true, output: { reserved: true } });
    steps.push({ type: 'step', name: 'apply-' + sequence, success: true, output: structuredClone(output) });
  }
  const cleanup = fixture.storage().managementCleanupCounts();
  return { id: target.instance_id, status: deleted.instance ? 'terminated' : ['complete', 'aborted', 'failed'].includes(fixture.checkpoint.phase) ? 'complete' : 'waiting',
    step_count: steps.length, steps, output: { checkpoint: structuredClone(fixture.checkpoint), management_cleanup: cleanup },
    workflow_deleted: deleted.workflow, worker_deleted: deleted.worker, repository_deleted: deleted.repository };
}

function mockWranglerProcess(fixture: ReturnType<typeof demoFixture>, invocations: WranglerProcessInvocation[]) {
  const deleted = { instance: false, workflow: false, worker: false, repository: false };
  const results: WranglerProcessResult[] = [];
  const respond = (invocation: WranglerProcessInvocation, code: number, stdout = '', stderr = '') => {
    const result = { code, stdout, stderr }; invocations.push(structuredClone(invocation)); results.push(result); return result;
  };
  const runner = async (invocation: WranglerProcessInvocation): Promise<WranglerProcessResult> => {
    const args = invocation.args, joined = args.join(' ');
    if (joined.includes('workflows trigger')) return respond(invocation, 0, JSON.stringify({ id: target.instance_id }));
    if (joined.includes('workflows instances describe')) {
      if (deleted.instance) {
        const endpoint = `/accounts/${target.account_id}/workflows/${target.workflow_name}/instances/${target.instance_id}`;
        return respond(invocation, 1, '', `X [ERROR] A request to the Cloudflare API (${endpoint}) failed.\n\n  This Workflow instance was not found.\n`);
      }
      return respond(invocation, 0, JSON.stringify(workflowDescription(fixture, deleted)));
    }
    if (joined.includes('workflows instances send-event')) {
      const payloadIndex = args.indexOf('--payload');
      assert.ok(payloadIndex >= 0 && args[payloadIndex + 1]);
      const event = JSON.parse(args[payloadIndex + 1]!);
      await fixture.sendEvent(event);
      return respond(invocation, 0, JSON.stringify({ success: true }));
    }
    if (joined.includes('workflows instances delete')) {
      deleted.instance = true;
      return respond(invocation, 0, JSON.stringify({ deleted: [{ id: target.instance_id }], errors: [] }));
    }
    if (joined.includes('workflows list')) return respond(invocation, 0, JSON.stringify(deleted.workflow ? [] : [{ name: target.workflow_name }]));
    if (joined.includes('workflows delete')) { deleted.workflow = true; return respond(invocation, 0, '{}'); }
    if (joined.includes('deployments list')) {
      if (deleted.worker) {
        const endpoint = `/accounts/${target.account_id}/workers/scripts/${target.worker_name}/deployments`;
        return respond(invocation, 1, '', `X [ERROR] A request to the Cloudflare API (${endpoint}) failed.\n\n  This Worker does not exist on your account. [code: 10007]\n`);
      }
      return respond(invocation, 0, '[]');
    }
    if (args.includes('delete') && !joined.includes('artifacts repos delete')) { deleted.worker = true; return respond(invocation, 0); }
    if (joined.includes('artifacts repos list')) return respond(invocation, 0, JSON.stringify(deleted.repository ? [] : [{ name: target.repository_name }]));
    if (joined.includes('artifacts repos delete')) {
      deleted.repository = true;
      return respond(invocation, 0, JSON.stringify({ deleted: true, name: target.repository_name, namespace: target.namespace_id }));
    }
    throw new Error('Unexpected mocked Wrangler command: ' + joined);
  };
  return { runner, deleted, results };
}

test('mocked Wrangler-to-viewer lifecycle preserves packet boundaries through pause, reconnect, completion, and cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strata-demo-viewer-lifecycle-'));
  const startedAt = Date.now(), now = () => startedAt + 60_000;
  try {
    const source = await readDemoActivationSource(process.cwd()), review = createDemoActivationReview('viewer-lifecycle-test', target, source);
    const grant = approveDemoActivationReview(review, source, { stdin_is_tty: true, stdout_is_tty: true,
      typed_digest: review.review_sha256, operator_label: 'SYNTHETIC TEST ONLY - no activation' }, startedAt);
    const configPath = path.join(directory, 'target.wrangler.json');
    await writeFile(configPath, JSON.stringify(createDemoActivationWorkerConfig(grant)));
    const fixture = demoFixture('controlled-private', startedAt), invocations: WranglerProcessInvocation[] = [];
    fixture.setNow(now());
    const mock = mockWranglerProcess(fixture, invocations);
    const provider = new WranglerCliDemoManagementProvider({ project_directory: process.cwd(), config_path: configPath, activation_grant: grant,
      base_environment: { PATH: process.env.PATH }, interactive_terminal: () => true, run_process: mock.runner });
    const session = await startReviewedDemoSession({ project_directory: process.cwd(), journal_path: path.join(directory, 'journal.json'),
      config_path: configPath, grant, attendance: { stdin_is_tty: true, stdout_is_tty: true, typed_digest: grant.grant_sha256,
        operator_label: 'SYNTHETIC TEST ONLY - no attended live run' }, provider, now, sleep: async () => undefined });
    assert.equal(session.initial_workflow_export && (session.initial_workflow_export as any).id, target.instance_id);
    assert.equal(session.plan.live_authorized, true, 'grant authorizes only this mocked adapter run; no external command runs');
    assert.equal(invocations.length, 2, 'launcher boundary saw one trigger and one initial structured describe');

    const host = new DemoHost(session.initial_checkpoint, session.dispatch, () => performance.now(), 'synthetic-turn');
    for (const actor of ['a', 'b', 'c'] as const) host.bindThread('test-' + actor, actor);
    requireDemoOk(await host.event('bootstrap', 'host', {}));
    for (const actor of ['a', 'c', 'b'] as const) {
      const thread = 'test-' + actor; host.beginTurn(thread);
      try {
        const record = rehearsalLayer(actor);
        requireDemoOk(await host.actorOperation(thread, { command: 'layer.create', input: { record } }));
        requireDemoOk(await host.actorOperation(thread, { command: 'layer.publish', input: { ref: record.id + '@' + record.revision } }));
      } finally { host.endTurn(thread); }
    }
    const preparedDispatch = await host.event('prepare', 'host', {}), prepared = requireDemoOk(preparedDispatch);
    const selectionExport = preparedDispatch.workflow_export as any;
    assert.equal(prepared.kind, 'selection');
    assert.equal(selectionExport.id, target.instance_id);
    assert.equal(selectionExport.steps.at(-1).name, 'apply-' + host.checkpoint.sequence);
    assert.equal(host.checkpoint.phase, 'selection', 'the incompatible authored options pause at human choice');
    assert.deepEqual(selectionExport && parseWorkflowSnapshot(selectionExport, new Date(startedAt + 5).toISOString()).pending_packet?.allowed_actions,
      ['900', '1200', 'defer']);

    const firstSnapshot = parseWorkflowSnapshot(selectionExport, new Date(startedAt + 5).toISOString());
    assert.equal(firstSnapshot.source, 'operator-supplied-json-unverified');
    assert.equal(firstSnapshot.execution_mode, 'controlled-private');
    assert.equal(firstSnapshot.run_id, target.run_id); assert.equal(firstSnapshot.sequence, host.checkpoint.sequence);
    assert.ok(firstSnapshot.trace.every(item => item.event_digest && /^[a-f0-9]{64}$/.test(item.event_digest)));
    assert.equal(firstSnapshot.pending_packet?.digest, host.checkpoint.pending?.digest);
    assert.ok(firstSnapshot.pending_packet?.content_sha256 && firstSnapshot.pending_packet?.packet_ref === 'decision-packet@' + firstSnapshot.pending_packet.content_sha256);

    const disconnected = parseWorkflowSnapshot({ id: target.instance_id, status: 'waiting', step_count: selectionExport.step_count, steps: [] }, new Date(startedAt + 6).toISOString());
    assert.equal(disconnected.completeness, 'status-only');
    assert.equal(compareWorkflowSnapshots(firstSnapshot, disconnected).decision, 'partial', 'disconnect status must keep the last complete checkpoint');
    assert.equal(compareWorkflowSnapshots(firstSnapshot, parseWorkflowSnapshot(selectionExport, new Date(startedAt + 7).toISOString())).decision, 'duplicate',
      'reconnect reimport with the same host checkpoint is stable');

    const conflictingExport = structuredClone(selectionExport), lastApply = [...conflictingExport.steps].reverse().find((step: any) => /^apply-\d+$/.test(step.name));
    lastApply.output.checkpoint.management_cleanup = { ...lastApply.output.checkpoint.management_cleanup, handles_open: 1 };
    conflictingExport.output.checkpoint = structuredClone(lastApply.output.checkpoint);
    const conflictSnapshot = parseWorkflowSnapshot(conflictingExport, new Date(startedAt + 8).toISOString());
    assert.equal(compareWorkflowSnapshots(firstSnapshot, conflictSnapshot).decision, 'conflict', 'same-sequence checkpoint conflict pauses ingestion');

    const replyPrefix = path.join(directory, 'selection');
    const statusPath = replyPrefix + '-workflow.json', packetPath = replyPrefix + '-packet.json', replyPath = replyPrefix + '-reply.json', eventPath = replyPrefix + '-event.json';
    await writeFile(statusPath, JSON.stringify(selectionExport));
    await runOperatorReplyCli(['packet', statusPath, packetPath], now());
    const packet = JSON.parse(await readFile(packetPath, 'utf8'));
    const artifact = { ...packet.reply_template, action: '900', response_text: 'SYNTHETIC TEST ONLY: choose the 900-second option; no human replied.',
      operator_label: 'SYNTHETIC TEST ONLY - no human reply', recorded_at: new Date(startedAt + 10_000).toISOString() };
    await writeFile(replyPath, JSON.stringify(artifact));
    const eventPreview = await runOperatorReplyCli(['event', statusPath, replyPath, eventPath], now());
    const preview = JSON.parse(await readFile(eventPath, 'utf8'));
    assert.equal(eventPreview.live_authorized, false); assert.equal(preview.live_authorized, false);
    assert.equal(preview.payload.input.artifact_digest, digest(artifact));
    assert.match(artifact.operator_label, /^SYNTHETIC TEST ONLY/);
    const selected = await session.dispatch(preview.payload); requireDemoOk(selected); host.checkpoint = selected.checkpoint;
    assert.equal(host.checkpoint.phase, 'runner');
    assert.equal(host.checkpoint.receipts[0].source, 'operator-supplied-artifact');
    assert.equal(host.checkpoint.receipts[0].operator_label, 'SYNTHETIC TEST ONLY - no human reply');

    const selectionUpdated = parseWorkflowSnapshot(selected.workflow_export, new Date(startedAt + 11).toISOString());
    assert.equal(compareWorkflowSnapshots(firstSnapshot, selectionUpdated).decision, 'accept', 'reconnected checkpoint extends the exact trace and receipt prefix');
    const materialized = requireDemoOk(await host.event('realize', 'host', {})).realization;
    const realized = await session.port.describeInstance() as any;
    assert.equal(realized.workflow_export.id, target.instance_id);
    assert.ok(realized.checkpoint.refs.realization);
    const measured = await measureDemoApp(materialized, 900);
    const endorsementDispatch = await host.event('evidence', 'runner', { evidence: measured.evidence, observations_digest: measured.observations_digest });
    const endorsementResult = requireDemoOk(endorsementDispatch);
    assert.equal(endorsementResult.kind, 'endorsement');
    const endorsementExport = endorsementDispatch.workflow_export as any;
    const endorsementSnapshot = parseWorkflowSnapshot(endorsementExport, new Date(startedAt + 12).toISOString());
    assert.equal(endorsementSnapshot.pending_packet?.kind, 'endorsement');
    assert.equal(endorsementSnapshot.pending_packet?.packet_ref, null);
    assert.ok(endorsementSnapshot.pending_packet?.digest);
    assert.equal(endorsementSnapshot.decision_receipts.length, 1, 'human choice remains separate from the later Release gate');

    const releaseStatusPath = path.join(directory, 'release-workflow.json'), releasePacketPath = path.join(directory, 'release-packet.json');
    const releaseReplyPath = path.join(directory, 'release-reply.json'), releaseEventPath = path.join(directory, 'release-event.json');
    await writeFile(releaseStatusPath, JSON.stringify(endorsementExport));
    await runOperatorReplyCli(['packet', releaseStatusPath, releasePacketPath], now());
    const releasePacket = JSON.parse(await readFile(releasePacketPath, 'utf8'));
    const releaseArtifact = { ...releasePacket.reply_template, action: 'approve-release',
      response_text: 'SYNTHETIC TEST ONLY: exercise the distinct Release approval path; no human approval occurred.',
      operator_label: 'SYNTHETIC TEST ONLY - no human approval', recorded_at: new Date(startedAt + 20_000).toISOString() };
    await writeFile(releaseReplyPath, JSON.stringify(releaseArtifact));
    await runOperatorReplyCli(['event', releaseStatusPath, releaseReplyPath, releaseEventPath], now());
    const releasePreview = JSON.parse(await readFile(releaseEventPath, 'utf8'));
    assert.equal(releasePreview.live_authorized, false);
    const completed = await session.dispatch(releasePreview.payload); requireDemoOk(completed); host.checkpoint = completed.checkpoint;
    assert.equal(host.checkpoint.phase, 'complete');
    assert.equal(host.checkpoint.receipts.length, 2);
    assert.equal(host.checkpoint.receipts[0].action, '900');
    assert.equal(host.checkpoint.receipts[1].action, 'approve-release');
    assert.notEqual(host.checkpoint.receipts[0].packet_digest, host.checkpoint.receipts[1].packet_digest);
    const finalSnapshot = parseWorkflowSnapshot(completed.workflow_export, new Date(startedAt + 21).toISOString());
    assert.equal(finalSnapshot.release_ref, host.checkpoint.refs.released);
    assert.deepEqual(finalSnapshot.decision_receipts.map(receipt => receipt.kind), ['selection', 'endorsement']);
    assert.ok(finalSnapshot.decision_receipts.every(receipt => receipt.source === 'operator-supplied-artifact' && receipt.authenticated === false &&
      /^SYNTHETIC TEST ONLY/.test(receipt.declared_operator_label ?? '')));
    assert.equal(compareWorkflowSnapshots(selectionUpdated, finalSnapshot).decision, 'accept');

    const template = await readFile(path.join(process.cwd(), 'demo/integrated-demo-workflow-snapshot.template.html'), 'utf8');
    const html = renderIntegratedDemoWorkflowSnapshotHtml(template, finalSnapshot);
    assert.match(html, /operator-supplied-json-unverified/);
    assert.match(html, /no reply, selection, approval, or Release controls/);
    assert.match(html, /SYNTHETIC TEST ONLY - no human reply/);
    assert.match(html, /SYNTHETIC TEST ONLY - no human approval/);
    const previewPath = process.env.STRATA_WORKFLOW_VIEWER_PREVIEW_PATH;
    if (previewPath) await writeFile(path.resolve(previewPath), html, 'utf8');

    assert.equal(host.usage().real_model_calls, 0); assert.deepEqual(host.usage().turns, { a: 1, b: 1, c: 1 });
    assert.ok(Object.values(host.usage().tools).every(count => count <= DEMO_LIMITS.tools_per_actor));
    const beforeCleanup = await session.port.snapshot();
    assert.ok(beforeCleanup.counters.event_sends <= session.plan.limits.event_sends);
    assert.ok(beforeCleanup.counters.calls <= session.plan.limits.calls - session.plan.limits.cleanup_reserve_calls);
    assert.ok(beforeCleanup.counters.status_reads <= session.plan.limits.status_reads - session.plan.limits.cleanup_reserve_status_reads);
    assert.ok(beforeCleanup.counters.request_bytes <= session.plan.limits.request_bytes);
    assert.ok(beforeCleanup.counters.response_bytes <= session.plan.limits.response_bytes);
    assert.ok(fixture.checkpoint.counters.artifact_reserved <= DEMO_LIMITS.artifact_dispatches);
    assert.ok(endorsementExport.step_count <= DEMO_LIMITS.steps);
    assert.equal(invocations.every(call => call.cwd === process.cwd() && call.args[0].endsWith(path.join('wrangler', 'bin', 'wrangler.js'))), true);
    assert.equal(invocations.some(call => call.args.includes('--local')), false);
    assert.ok(mock.results.every(result => result.code === 0 || result.stderr.includes('/accounts/' + target.account_id + '/')));

    const final = await cleanupReviewedDemoSession(session.port);
    assert.equal(final.cleanup.terminal_instance_verified, true);
    assert.equal(final.cleanup.instance_absent, true); assert.equal(final.cleanup.workflow_absent, true);
    assert.equal(final.cleanup.worker_absent, true); assert.equal(final.cleanup.repository_absent, true);
    assert.equal(final.cleanup.namespace_empty_verified, true);
    assert.ok(final.counters.cleanup_calls <= session.plan.limits.cleanup_reserve_calls);
    assert.equal(mock.deleted.instance && mock.deleted.workflow && mock.deleted.worker && mock.deleted.repository, true);
    assert.ok(invocations.length <= session.plan.limits.calls);
    assert.equal(checkpointDigest(host.checkpoint), finalSnapshot.checkpoint_digest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
