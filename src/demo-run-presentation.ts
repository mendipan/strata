import { blockFacets, digest } from './model.js';
import { integratedDemoSelectionReviewHtml } from './integrated-demo-review.js';
import type { OperatorPromptPacket } from './integrated-demo-operator-reply.js';

// Read-only projection of accepted local observations. Never an evaluator or an
// authority: decisions still use the canonical packet and the existing routes.
export type RunSourceMode = 'live-local' | 'recorded-replay' | 'synthetic-fixture' | 'imported-unverified';
const txt = (v: any): string | null => typeof v === 'string' ? v.slice(0, 2048) : null;
const refs = (v: any): string[] => Array.isArray(v) ? v.filter((x: any) => typeof x === 'string').slice(0, 96).map((x: string) => x.slice(0, 256)) : [];
const num = (v: any): number | null => Number.isFinite(v) ? v : null;
const criterion = (v: any) => ({ check: txt(v?.check), version: txt(v?.version), fixture: txt(v?.fixture), method: txt(v?.method), statement: txt(v?.statement), subjects: refs(v?.subjects) });
function value(v: any): any {
  if (v === null || ['string', 'boolean', 'number'].includes(typeof v)) return typeof v === 'string' ? txt(v) : v;
  if (!v || typeof v !== 'object') return null;
  return { statement: txt(v.statement), kind: txt(v.kind), facets: refs(v.facets), acceptance: refs(v.acceptance),
    parameters: Object.fromEntries(['seconds', 'enabled', 'lead_seconds', 'exclusive'].filter(k => ['number', 'boolean'].includes(typeof v.parameters?.[k])).map(k => [k, v.parameters[k]])) };
}
function expected(v: any) { return { kind: txt(v?.kind), value: value(v?.value), fingerprint: txt(v?.fingerprint) }; }
export function projectLayer(v: any) {
  if (!v || typeof v.id !== 'string' || !Number.isSafeInteger(v.revision)) return null;
  return { ref: v.id + '@' + v.revision, owner: txt(v.owner), baseline: txt(v.baseline), intent: txt(v.intent), publication: 'draft-observed',
    changes: (v.changes ?? []).slice(0, 32).map((c: any) => ({ op: txt(c.op), block: txt(c.block), path: txt(c.path), expected: expected(c.expected), value: value(c.value) })),
    requires_layers: refs(v.requires_layers), read_set: (v.read_set ?? []).slice(0, 32).map((r: any) => ({ layer: txt(r.layer), mode: txt(r.mode) })),
    assumptions: (v.assumptions ?? []).slice(0, 32).map((a: any) => ({ block: txt(a.block), path: txt(a.path), expected: expected(a.expected) })),
    acceptance: (v.acceptance ?? []).slice(0, 32).map((a: any) => ({ block: txt(a.block), id: txt(a.id), criterion: criterion(a.criterion) })) };
}
function projectBlocks(snapshot: any) {
  if (!snapshot?.blocks) return [];
  return Object.entries(snapshot.blocks).slice(0, 32).map(([id, b]: [string, any]) => ({ id, parent: txt(b.parent), purpose: txt(b.purpose),
    facets: blockFacets(b), requirements: Object.entries(b.requirements ?? {}).map(([id, v]) => ({ id, ...value(v) })),
    relationships: Object.entries(b.relationships ?? {}).map(([id, r]: [string, any]) => ({ id, target: txt(r.target), statement: txt(r.statement) })),
    acceptance: Object.entries(b.acceptance ?? {}).map(([id, a]) => ({ id, ...criterion(a) })) }));
}
export function projectSelection(packet: OperatorPromptPacket) {
  // Reuse the canonical renderer's digest/source/partition validation, without
  // parsing its HTML or duplicating composition evaluation.
  integratedDemoSelectionReviewHtml(packet);
  const d: any = packet.decision, p = d.packet.packet;
  const layers = d.considered.map((ref: string) => projectLayer(p.sources[ref])!);
  return { digest: packet.packet_digest, phase: packet.phase, expires_at: packet.expires_at, allowed_actions: packet.allowed_actions,
    baseline_seconds: d.baseline_seconds, baseline: layers[0].baseline, considered: refs(d.considered), repair: d.repair_required_for_initial_1200 === true,
    options: p.options.map((o: any) => ({ id: txt(o.id), selected: refs(o.selected), rejected: refs(o.rejected), executable: o.executable,
      effects: txt(o.effects), follow_up: txt(o.follow_up) })), remaining_gates: refs(p.remaining_gates), layers,
    blocks: projectBlocks(p.sources[layers[0].baseline!]) };
}
function realization(v: any) {
  return v ? { target: txt(v.target), candidate: txt(v.candidate), profile_id: txt(v.profile_id), profile: txt(v.profile), output_tree: txt(v.output_tree),
    files: Object.keys(v.files ?? {}).slice(0, 32), coverage: (v.coverage ?? []).slice(0, 96).map((c: any) => ({ item: txt(c.item), status: txt(c.status), facets: refs(c.facets) })) } : null;
}
function evidence(v: any) {
  return v ? { candidate: txt(v.candidate), profile: txt(v.profile), output_tree: txt(v.output_tree),
    results: (v.results ?? []).slice(0, 96).map((r: any) => ({ ...criterion(r), passed: typeof r.passed === 'boolean' ? r.passed : null })) } : null;
}
// Only fixture time and aggregate state counts are exposed. Resource/owner IDs,
// prompts, generated files, tool streams, provider locators and names stay out.
function observations(v: any) {
  if (!v) return null;
  return Object.fromEntries(['before_reminder', 'reminder', 'repeat_tick', 'before_expiry', 'expired'].filter(k => v[k]).map(k => [k, {
    fixture_seconds: num(v[k].now), holds: Object.keys(v[k].holds ?? {}).length, reminders: Array.isArray(v[k].reminders) ? v[k].reminders.length : null }]));
}
const cleanupKeys = ['terminal_instance_verified', 'local_dispatches_settled', 'repo_tokens_clean', 'handles_disposed', 'instance_absent', 'repository_absent',
  'namespace_empty_verified', 'workflow_retained_verified', 'worker_retained_verified', 'worker_delete_requested', 'workflow_delete_requested'];
export class DemoRunPresentation {
  private seen = new Map<number, string>();
  private state: any;
  constructor(readonly runId: string, readonly mode: RunSourceMode = 'live-local') {
    this.state = { view_format: 'strata-demo-run-view/1', run_id: runId, source_mode: mode, view_revision: 0, phase: null,
      checkpoint: null, last_observed_at: null, incomplete: null, actors: {}, proposals: {}, blocks: [], review: null,
      selection: null, decisions: [], realization: null, evidence: null, observations: null, observations_digest: null,
      release: null, inherited: null, inherited_equal: null, cleanup: { status: 'unverified', checks: {}, counters: {} },
      failure: null, provider: null, application: null, refusals: [], event_order: [] };
  }
  snapshot() { return structuredClone(this.state); }
  review(packet: OperatorPromptPacket) {
    if (packet.run_id !== this.runId || this.state.incomplete) return;
    if (packet.phase === 'selection') {
      const review = projectSelection(packet); this.state.review = review;
      this.state.blocks = review.blocks;
      for (const layer of review.layers) this.state.proposals[layer.ref] = { ...layer, publication: this.state.proposals[layer.ref]?.publication ?? 'reviewed-exact-revision' };
    } else {
      const d: any = packet.decision;
      this.state.review = { digest: packet.packet_digest, phase: packet.phase, expires_at: packet.expires_at, allowed_actions: packet.allowed_actions,
        candidate_ref: txt(d.candidate_ref), candidate_fingerprint: txt(d.candidate_fingerprint), realization_ref: txt(d.realization_ref),
        scope: txt(d.scope), approvals_requested: refs(d.approvals_requested), observations_digest: txt(d.observations_digest),
        validation: { ref: txt(d.validation?.ref), checks_passed: typeof d.validation?.checks_passed === 'boolean' ? d.validation.checks_passed : null, evidence_digest: txt(d.validation?.evidence_digest) } };
    }
  }
  accept(record: any, observedAt: string | null = null) {
    if (record.run_id && record.run_id !== this.runId) return;
    const s = this.state;
    if (record.type === 'workflow-event') {
      const n = record.sequence, fingerprint = digest(JSON.parse(JSON.stringify({ ...record, observed_at: null })));
      if (!Number.isSafeInteger(n) || n < 1) { s.incomplete = 'Invalid checkpoint identity.'; return; }
      if (this.seen.has(n)) {
        if (this.seen.get(n) !== fingerprint) s.incomplete = 'Conflicting checkpoint identity. Resynchronization required.';
        return;
      }
      if (n < (s.checkpoint?.sequence ?? 0)) return;
      if (n !== (s.checkpoint?.sequence ?? 0) + 1) { s.incomplete = 'Checkpoint gap. Awaiting an authoritative snapshot.'; return; }
      if (s.incomplete) return;
      this.seen.set(n, fingerprint);
      s.phase = txt(record.phase); s.checkpoint = { sequence: n, digest: txt(record.checkpoint_digest), observed_at: observedAt };
      if (record.outcome?.ok !== true) s.refusals.push({ sequence: n, packet_digest: txt(record.decision_packet_digest), code: txt(record.outcome?.error?.code) ?? 'Outcome unavailable' });
      else {
        const d = record.outcome.data, command = record.command, priorReview = s.review;
        if (record.kind === 'stop' || d.aborted) s.review = null;
        if (record.kind === 'actor') {
          if (['layer.create', 'layer.revise'].includes(command)) {
            const layer = projectLayer(record.proposal);
            if (layer && layer.ref === d.ref) s.proposals[layer.ref] = layer;
          }
          if (command === 'layer.publish' && d.published === true && s.proposals[d.ref]) s.proposals[d.ref].publication = 'published';
          if (command === 'inspect' && d.blocks) s.blocks = projectBlocks(d);
        }
        if (d.receipt) {
          const receipt = { packet_digest: txt(d.receipt.packet_digest), action: txt(d.receipt.action), sequence: n, source: txt(d.receipt.source), capture_method: txt(d.receipt.capture_method) };
          s.decisions.push(receipt); if (s.review?.digest === receipt.packet_digest) s.review = null;
        }
        if (record.kind === 'selection' && d.candidate) {
          const option = priorReview?.options?.find((o: any) => o.id === d.receipt.action);
          s.selection = { ref: txt(d.candidate.ref), fingerprint: txt(d.candidate.fingerprint), state: txt(d.candidate.state),
            selected: refs(d.recipe?.selected ?? option?.selected), considered: refs(d.recipe?.proposals ?? priorReview?.considered),
            resolutions: refs(d.recipe?.resolutions), resolution_ref: txt(d.resolution?.ref), scope: txt(d.candidate.scope) };
          s.blocks = projectBlocks(d.candidate.snapshot);
        }
        if (record.kind === 'realize') s.realization = realization(d.realization);
        if (record.kind === 'endorse') { s.release = { ref: txt(d.released?.ref), state: txt(d.released?.state), candidate: txt(d.released?.candidate) }; s.inherited = { ref: txt(d.inherited?.ref) }; }
      }
    }
    if (record.type === 'actor-launching' || record.type === 'actor-finished') {
      if (['a', 'b', 'c'].includes(record.actor) && [1, 2].includes(record.assigned_revision)) {
        const key = record.actor + '@' + record.assigned_revision, prior = s.actors[key] ?? {};
        s.actors[key] = { ...prior, actor: record.actor, revision: record.assigned_revision, model: txt(record.model), effort: txt(record.reasoning_effort),
          ...(record.type === 'actor-launching' ? { launch_observed: true, launch_at: observedAt } : { completion_observed: true, completion_at: observedAt,
            turns: num(record.turn_starts), tools: num(record.tool_calls), execution: txt(record.execution) }) };
      }
    }
    if (!s.incomplete && record.type === 'measurement-verified' && s.realization && record.evidence?.candidate === s.realization.candidate &&
      record.evidence?.profile === s.realization.profile && record.evidence?.output_tree === s.realization.output_tree) {
      s.evidence = evidence(record.evidence); s.observations = observations(record.observations); s.observations_digest = txt(record.observations_digest);
    }
    if (!s.incomplete && record.type === 'release-verified') {
      s.release = { ref: txt(record.released?.ref), state: txt(record.released?.state), candidate: txt(record.released?.candidate) };
      s.inherited = { ref: txt(record.inherited?.ref) }; s.inherited_equal = typeof record.inherited_observations_equal === 'boolean' ? record.inherited_observations_equal : null;
      if (s.realization && record.evidence?.candidate === s.realization.candidate && record.evidence?.profile === s.realization.profile && record.evidence?.output_tree === s.realization.output_tree) s.evidence = evidence(record.evidence);
    }
    if (['cleanup-started', 'cleanup-waiting', 'cleanup-blocked', 'startup-reconciliation-required'].includes(record.type))
      s.cleanup.status = record.type === 'cleanup-blocked' || record.type === 'startup-reconciliation-required' ? 'blocked' : 'pending';
    if (record.type === 'cleanup-verified') {
      const checks = Object.fromEntries(cleanupKeys.filter(k => typeof record.cleanup?.cleanup?.[k] === 'boolean').map(k => [k, record.cleanup.cleanup[k]]));
      const counters = Object.fromEntries(['unsettled_dispatches', 'repo_tokens_issued', 'repo_tokens_revoked', 'handles_open'].filter(k => Number.isFinite(record.cleanup?.counters?.[k])).map(k => [k, record.cleanup.counters[k]]));
      s.cleanup = { status: 'verified', checks, counters, observed_at: observedAt };
    }
    if (record.type === 'run-failed') {
      s.review = null;
      s.failure = { code: txt(record.code), startup_failed: record.startup_failed === true,
        message: record.startup_failed === true ? 'The demo did not start. Your Begin response was recorded.' : 'An invocation or application step stopped. Review the last recorded proposals and cleanup status.' };
    }
    if (record.type === 'provider-outcome') {
      s.provider = { status: txt(record.provider?.status) };
      s.application = { ok: typeof record.application?.ok === 'boolean' ? record.application.ok : null, phase: txt(record.application?.phase), refusal_code: txt(record.application?.refusal_code) };
    }
    s.view_revision++; s.last_observed_at = observedAt;
    s.event_order.push({ ordinal: s.view_revision, type: txt(record.type), sequence: num(record.sequence), kind: txt(record.kind), source: txt(record.source), observed_at: observedAt });
    if (s.event_order.length > 128) s.event_order.shift();
  }
}
