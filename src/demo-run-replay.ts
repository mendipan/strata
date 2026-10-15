import { DemoRunPresentation } from './demo-run-presentation.js';
import { authoritativeDemoWorkflowOutput, decodeDemoStepOutput, demoApplySequence } from './integrated-demo-workflow-description.js';
import { canonical, bytesDigest, digest } from './model.js';

export type RunReplay = { format: 'strata-recorded-demo-replay/1'; run_id: string; provenance: string; timing: string;
  evidence_manifest: Record<string, string>; chapters: { title: string; recorded_choice?: string; view: any }[]; bundle_sha256: string };
// Receives already read local bytes. The CLI opts into the exact source directory;
// no provider access, general filesystem endpoint or executable import exists.
export function retainedRunReplay(files: Record<string, string>): RunReplay {
  const audit = JSON.parse(files['completion-audit.json']);
  if (audit.format !== 'strata.attended-demo-completion-audit/1' || !/^[a-f0-9]{16}$/.test(audit.run_id) ||
    !/^[a-f0-9]{64}$/.test(audit.source_sha256) || !Number.isFinite(audit.duration_seconds) || audit.duration_seconds < 0) throw Error('Unknown completion audit.');
  const expected = ['run/viewer-events.jsonl', 'run/workflow-export.json', 'run/actor-a.json', 'run/actor-c.json', 'run/actor-b.json', 'run/actor-b-repair.json'];
  for (const name of expected) if (!files[name] || bytesDigest(files[name]) !== audit.evidence_sha256?.[name]) throw Error('Retained evidence hash mismatch: ' + name);
  const raw = JSON.parse(files['run/workflow-export.json']);
  const decoded = authoritativeDemoWorkflowOutput(raw);
  if (decoded.checkpoint.run_id !== audit.run_id) throw Error('Run identity differs from the completion audit.');
  const description = raw.steps ? raw : raw.result;
  const outputs = new Map<number, any>();
  for (const step of description.steps) { const n = demoApplySequence(step.name); if (n !== undefined && step.success === true) outputs.set(n, decodeDemoStepOutput(step.output)); }
  const tools = new Map<number, any>();
  for (const name of expected.filter(n => n.includes('/actor-'))) {
    const actor = JSON.parse(files[name]);
    if (actor.label !== 'real-codex-subscription-cli') throw Error('Recorded actor source is not a real subscription CLI observation.');
    for (const tool of actor.tool_calls) {
      const n = tool.result?.checkpoint?.sequence;
      if (tools.has(n)) throw Error('Ambiguous actor observation.');
      if (canonical(tool.result?.outcome) !== canonical(outputs.get(n)?.outcome)) throw Error('Actor outcome is not bound to the Workflow export.');
      tools.set(n, tool);
    }
  }
  const projector = new DemoRunPresentation(audit.run_id, 'recorded-replay'), chapters: RunReplay['chapters'] = [];
  const events = files['run/viewer-events.jsonl'].trim().split(/\r?\n/).map(line => JSON.parse(line));
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type === 'workflow-event') {
      const output = outputs.get(event.sequence);
      if (!output || digest(output.checkpoint) !== event.checkpoint_digest || canonical(output.outcome) !== canonical(event.outcome)) throw Error('Viewer event differs from the validated Workflow chain.');
      const tool = tools.get(event.sequence);
      if (tool) { event.command = tool.command; if (event.outcome.ok && ['layer.create', 'layer.revise'].includes(tool.command)) event.proposal = tool.input.record; }
    }
    if (event.type === 'operator-pause') projector.review(event.packet);
    projector.accept(event, typeof event.observed_at === 'string' ? event.observed_at : null);
    const view = projector.snapshot(); if (view.incomplete) throw Error(view.incomplete);
    let title: string | undefined;
    if (event.kind === 'actor' && event.command === 'inspect' && event.outcome.data.blocks && !chapters.length) title = 'Pinned baseline';
    if (event.type === 'actor-finished' && event.actor === 'b') title = event.assigned_revision === 2 ? 'Same owner. New revision.' : 'Published owned proposals';
    if (event.type === 'operator-pause') {
      title = event.packet.phase === 'endorsement' ? 'Separate Release approval' : event.packet.allowed_actions.includes('900') ? 'First human choice' : 'Review the reminder revision';
    }
    if (event.kind === 'selection' && event.outcome.data.repair_required) title = '20 minutes requires reminder repair';
    if (event.kind === 'realize') title = 'Selected Composition and Node realization';
    if (event.type === 'release-verified') title = 'Measured Release and inherited behavior';
    if (event.type === 'cleanup-verified') title = 'Cleanup receipt';
    if (title) {
      if (event.type === 'release-verified' || event.type === 'cleanup-verified') view.report_behavior = { selected_seconds: audit.selected_seconds, reminder_at_seconds: audit.reminder_at_seconds, source: 'completion-audit.json · report-derived' };
      if (event.type === 'cleanup-verified') { view.provider = { status: audit.provider_status }; view.application = { ok: audit.application_ok, phase: audit.application_phase }; }
      const nextDecision = event.type === 'operator-pause' ? events.slice(i + 1).find(e => e.type === 'workflow-event' && e.outcome?.data?.receipt?.packet_digest === event.packet.packet_digest) : null;
      chapters.push({ title, ...(nextDecision ? { recorded_choice: nextDecision.outcome.data.receipt.action } : {}), view });
    }
  }
  if (!chapters.length || decoded.checkpoint.sequence !== projector.snapshot().checkpoint?.sequence) throw Error('Incomplete retained replay.');
  const body = { format: 'strata-recorded-demo-replay/1' as const, run_id: audit.run_id,
    provenance: 'Sanitized retained attended evidence. Workflow chain and actor outcomes checked against the local completion audit hashes. Source manifest ' + audit.source_sha256 + '. Local provenance is not independently authenticated.',
    timing: 'Original viewer events have no timestamps. Chapters preserve event order; no duration-scale invocation chart. Reported execution: ' + audit.duration_seconds + ' seconds. Replay pauses are editorial; no new live activity.',
    evidence_manifest: Object.fromEntries([...expected.map(n => [n, audit.evidence_sha256[n]]), ['completion-audit.json', bytesDigest(files['completion-audit.json'])]]), chapters };
  return { ...body, bundle_sha256: digest(body) };
}
export function parseRunReplay(value: unknown): RunReplay {
  const v = value as RunReplay, { bundle_sha256, ...body } = v;
  if (v?.format !== 'strata-recorded-demo-replay/1' || digest(body) !== bundle_sha256 || !Array.isArray(v.chapters) || v.chapters.length < 1 || v.chapters.length > 32 ||
    v.chapters.some(c => c.view?.view_format !== 'strata-demo-run-view/1' || c.view.run_id !== v.run_id || c.view.source_mode !== 'recorded-replay')) throw Error('Replay bundle integrity or mode refused.');
  return v;
}
