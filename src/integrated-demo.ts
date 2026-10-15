import { Engine, normalizeLayer, snapshotFromRelease } from './core.js';
import { ArtifactRegistryStore, type LocatedRegistry } from './artifact-registry.js';
import { ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT } from './artifacts.js';
import type { ArtifactCleanupCounts } from './artifacts.js';
import { bootstrap, demoLayers, proposal, recipe } from './fixtures.js';
import { expiryRequirement } from './profile.js';
import { CONTENT_MODEL, canonical, digest, fail, normalizeSnapshot, StrataError, type Layer } from './model.js';
import { FixtureIssuer, LOCAL_PROJECT, validateEnvelope } from './security.js';
import { executeAuthorized, MUTATIONS } from './service.js';
import { publishPrepared } from './publication.js';
import { isProviderDiagnostic } from './provider-diagnostic.js';

// One finite scenario. These are application ceilings, never an invoice cap.
export const DEMO_LIMITS = Object.freeze({ events: 60, commands: 60, steps: 128, records: 96,
  record_bytes: 65536, ordinary_record_bytes: 16384, event_bytes: 32768, checkpoint_bytes: 1048576, stage_batches: 24,
  artifact_dispatches: 2000, transfer_bytes: 64 * 1024 * 1024, original_bytes: 2 * 1024 * 1024,
  duration_ms: 1800000, cleanup_ms: 120000, repo_tokens_issued: ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT,
  tools_per_actor: 20, turns_per_actor: 4, dispatches_per_apply: 100 });
export const DEMO_ACTORS = Object.freeze({
  a: { principal: 'author-a', layer: 'L-hold', block: 'booking.hold', model: 'Luna 6', reasoning: 'Medium' },
  c: { principal: 'author-c', layer: 'L-alternative', block: 'booking.hold', model: 'Luna 6', reasoning: 'Medium' },
  b: { principal: 'author-b', layer: 'L-reminder', block: 'booking.reminder', model: 'Luna 6', reasoning: 'High' }
} as const);
export type DemoActor = keyof typeof DEMO_ACTORS;
export type DemoPhase = 'new' | 'authors' | 'selection' | 'repair' | 'runner' | 'endorsement' | 'complete' | 'aborted' | 'failed';
export type DemoKind = 'bootstrap' | 'actor' | 'prepare' | 'selection' | 'realize' | 'evidence' | 'endorse' | 'stop';
export type HumanReceipt = { source: 'operator-supplied-artifact' | 'synthetic-rehearsal'; message_id: string; received_at: string;
  packet_digest: string; action: '900' | '1200' | 'defer' | 'approve-release'; text: string;
  operator_label?: string; artifact_digest?: string; capture_method?: 'operator-supplied-file' | 'local-interactive-terminal' | 'local-browser' };
export type DemoEvent = { format: 'strata-integrated-demo-event/1'; run_id: string; project_id: string;
  sequence: number; request_id: string; previous_digest: string; phase: DemoPhase; kind: DemoKind;
  source: 'host' | 'operator' | 'runner' | `actor:${DemoActor}`; input: any; input_digest: string };
type Outcome = { ok: true; data: any } | { ok: false; error: { code: string; diagnostic?: import('./provider-diagnostic.js').ProviderDiagnostic } };
export type DemoCheckpoint = { format: 'strata-integrated-demo-checkpoint/1'; run_id: string; project_id: string;
  mode: 'local-rehearsal' | 'controlled-private'; started_at: number; expires_at: number; phase: DemoPhase; sequence: number;
  registry: LocatedRegistry; heads: Engine['ownerHeads']; previous_digest: string | null;
  management_cleanup: ArtifactCleanupCounts;
  counters: { events: number; commands: number; stage_batches: number; artifact_reserved: number; transfer_reserved: number;
    original_reserved: number; tools: Record<DemoActor, number> };
  refs: { composition?: string; basis?: string; packet?: string; candidate?: string; realization?: string; validation?: string;
    released?: string; inherited?: string; reminder?: string; case_revision: number; chosen?: '900' | '1200' };
  pending: { kind: 'selection' | 'endorsement'; digest: string; expires_at: number } | null;
  receipts: HumanReceipt[]; requests: Record<string, { event_digest: string; outcome: Outcome }>;
  trace: { sequence: number; kind: DemoKind; source: DemoEvent['source']; outcome: string; phase: DemoPhase }[] };

export function demoBaseline() {
  const baseline = bootstrap(); baseline.model_version = CONTENT_MODEL;
  for (const block of Object.values(baseline.blocks)) { block.description = { format: 'plain-text/1', text: '' }; block.asset_refs = {}; }
  return normalizeSnapshot(baseline);
}
// Explicitly deterministic input for rehearsal only; real actors author their own records.
export function rehearsalLayer(actor: DemoActor, repaired = false): Layer {
  const layer = demoLayers()[actor]; layer.model_version = CONTENT_MODEL;
  if (repaired) {
    if (actor !== 'b') fail('DEMO_REPAIR_REFUSED', 4, 'Only the reminder has a repair branch.');
    layer.revision = 2; layer.requires_layers = ['L-alternative@1']; layer.read_set = [{ layer: 'L-alternative@1', mode: 'required' }];
    layer.assumptions = [{ block: 'booking.hold', path: 'requirements.expiry', expected: { kind: 'value', value: expiryRequirement(1200) } }];
  }
  return normalizeLayer(layer, demoBaseline());
}
const composition = (id: string, reminder = 'L-reminder@1') => ({ ...recipe(id), model_version: CONTENT_MODEL,
  proposals: ['L-hold@1', reminder, 'L-alternative@1'], selected: ['L-hold@1', reminder, 'L-alternative@1'] });
export const checkpointDigest = (checkpoint: DemoCheckpoint) => digest(checkpoint);
export function initialDemoCheckpoint(run_id: string, storage: ArtifactRegistryStore, mode: DemoCheckpoint['mode'] = 'local-rehearsal', now = Date.now()): DemoCheckpoint {
  if (!/^[a-f0-9]{16}$/.test(run_id) || storage.projectId !== LOCAL_PROJECT) fail('DEMO_BINDING_REFUSED', 4, 'Finite booking demo requires its exact run and project.');
  return { format: 'strata-integrated-demo-checkpoint/1', run_id, project_id: LOCAL_PROJECT, mode, started_at: now,
    expires_at: now + DEMO_LIMITS.duration_ms, phase: 'new', sequence: 0, previous_digest: null,
    registry: { entries: {}, storage: storage.binding(), asset_locators: {} }, heads: {},
    management_cleanup: { unsettled_dispatches: 0, repo_tokens_issued: 0, repo_tokens_revoked: 0, handles_open: 0 },
    counters: { events: 0, commands: 0, stage_batches: 0, artifact_reserved: 0, transfer_reserved: 0, original_reserved: 0, tools: { a: 0, b: 0, c: 0 } },
    refs: { case_revision: 0 }, pending: null, receipts: [], requests: {}, trace: [] };
}
export function demoEvent(checkpoint: DemoCheckpoint, kind: DemoKind, source: DemoEvent['source'], input: any, request_id: string): DemoEvent {
  return { format: 'strata-integrated-demo-event/1', run_id: checkpoint.run_id, project_id: checkpoint.project_id,
    sequence: checkpoint.sequence + 1, request_id, previous_digest: checkpointDigest(checkpoint), phase: checkpoint.phase,
    kind, source, input: structuredClone(input), input_digest: digest(input) };
}

// The private operator vouches for fixed demo assignments. Internally these reuse
// local fixture policies; this adapter does not implement hosted membership/auth.
export class DemoAuthority {
  readonly issuer: FixtureIssuer;
  constructor(now: () => number) {
    const reads = ['status', 'inspect', 'conflicts'];
    this.issuer = new FixtureIssuer({ now, assignments: {
      ...Object.fromEntries(Object.entries(DEMO_ACTORS).map(([key, actor]) => ['demo-' + key,
        { principal: actor.principal, operations: [...reads, 'layer.create', 'layer.revise', 'layer.publish'],
          layer_ids: [actor.layer], write_block_ids: [actor.block] }])),
      'demo-content-review': { principal: 'content-reviewer', operations: ['content.review'] },
      'demo-decision-target': { principal: 'scope-selector', operations: ['layer.create', 'layer.publish'],
        layer_ids: ['L-demo-choice-1-900', 'L-demo-choice-1-1200', 'L-demo-choice-2-1200'], write_block_ids: [] }
    } });
  }
  call(engine: Engine, checkpoint: DemoCheckpoint, command: string, input: any, selector: string) {
    if (checkpoint.counters.commands >= DEMO_LIMITS.commands) fail('DEMO_COMMAND_LIMIT', 7, 'Finite command ceiling reached.');
    checkpoint.counters.commands++;
    const result = executeAuthorized(engine, command, input, this.issuer.resolve(selector, checkpoint.project_id), this.issuer);
    if (command === 'status') { result.identity_policy = 'operator-vouched-demo-assignments'; result.artifact_adapter = checkpoint.registry.storage?.mode; }
    return result;
  }
}

function onlyKeys(input: any, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) fail('DEMO_INPUT_REFUSED', 2, 'Unsupported finite event input.');
}
function originalReservation(checkpoint: DemoCheckpoint, event: DemoEvent, mutation: boolean) {
  if (!mutation) return 0;
  const bytes = { bootstrap: 80, actor: 16, prepare: 128, selection: 64, realize: 64, evidence: 16, endorse: 112, stop: 0 }[event.kind];
  if (event.kind === 'selection' && (event.input.action === 'defer' || event.input.action === '1200' && checkpoint.refs.case_revision === 1)) return 0;
  return (bytes ?? 0) * 1024;
}
function assignedDraft(draft: Layer, actor: DemoActor, repaired: boolean) {
  const expected = rehearsalLayer(actor, repaired), spec = DEMO_ACTORS[actor];
  if (draft.owner !== spec.principal || draft.id !== spec.layer || draft.revision !== expected.revision) fail('LAYER_SCOPE_FORBIDDEN', 4, 'Exact finite owned Layer revision is required.');
  for (const field of ['changes', 'requires_layers', 'assumptions', 'acceptance'] as const) if (canonical(draft[field]) !== canonical(expected[field])) fail('DEMO_AUTHORING_REVIEW_REFUSED', 6, 'Draft differs from the bounded assigned behavior/dependency/acceptance.');
}
function human(checkpoint: DemoCheckpoint, value: any, expected: 'selection' | 'endorsement', now: number): HumanReceipt {
  onlyKeys(value, ['source', 'message_id', 'received_at', 'packet_digest', 'action', 'text', 'operator_label', 'artifact_digest', 'capture_method']);
  if (!checkpoint.pending || checkpoint.pending.kind !== expected || value.packet_digest !== checkpoint.pending.digest || now >= checkpoint.pending.expires_at ||
      !['operator-supplied-artifact', 'synthetic-rehearsal'].includes(value.source) || (checkpoint.mode !== 'local-rehearsal' && value.source !== 'operator-supplied-artifact') ||
      typeof value.message_id !== 'string' || !value.message_id.trim() || value.message_id.length > 256 || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2048 ||
      typeof value.received_at !== 'string' ||
      !Number.isFinite(Date.parse(value.received_at)) || Date.parse(value.received_at) > now || Date.parse(value.received_at) < checkpoint.started_at ||
      value.source === 'operator-supplied-artifact' && (typeof value.operator_label !== 'string' || !value.operator_label.trim() || value.operator_label.length > 128 ||
        !/^[a-f0-9]{64}$/.test(value.artifact_digest) || !['operator-supplied-file', 'local-interactive-terminal', 'local-browser'].includes(value.capture_method)) ||
      value.source === 'synthetic-rehearsal' && (value.operator_label !== undefined || value.artifact_digest !== undefined || value.capture_method !== undefined) ||
      !['900', '1200', 'defer', 'approve-release'].includes(value.action) ||
      (expected === 'selection' ? value.action === 'approve-release' : !['defer', 'approve-release'].includes(value.action))) fail('DEMO_HUMAN_RECEIPT_REFUSED', 4, 'A current exact packet and explicit source reply are required.');
  if (checkpoint.receipts.some(receipt => receipt.message_id === value.message_id)) fail('DEMO_HUMAN_RECEIPT_REFUSED', 4, 'Reply identifier was already used.');
  return structuredClone(value);
}

export class IntegratedDemo {
  readonly authority: DemoAuthority;
  constructor(readonly storage: ArtifactRegistryStore, readonly now: () => number = Date.now) { this.authority = new DemoAuthority(now); }
  validate(checkpoint: DemoCheckpoint, event: DemoEvent): Outcome | null {
    if (Buffer.byteLength(canonical(event)) > DEMO_LIMITS.event_bytes || event.format !== 'strata-integrated-demo-event/1' ||
        canonical(Object.keys(event).sort()) !== canonical(['format', 'run_id', 'project_id', 'sequence', 'request_id', 'previous_digest', 'phase', 'kind', 'source', 'input', 'input_digest'].sort()) ||
        typeof event.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.request_id) || ['__proto__', 'constructor', 'prototype'].includes(event.request_id) ||
        !Number.isSafeInteger(event.sequence) || !['bootstrap', 'actor', 'prepare', 'selection', 'realize', 'evidence', 'endorse', 'stop'].includes(event.kind) ||
        !/^(host|operator|runner|actor:[abc])$/.test(event.source) || event.run_id !== checkpoint.run_id || event.project_id !== checkpoint.project_id || digest(event.input) !== event.input_digest) fail('DEMO_EVENT_REFUSED', 4, 'Event identity/digest differs.');
    this.storage.assertBinding(checkpoint.registry);
    const prior = checkpoint.requests[event.request_id];
    if (prior) { if (prior.event_digest !== digest(event)) fail('DEMO_REQUEST_CONFLICT', 5, 'Request identifier binds different content.'); return structuredClone(prior.outcome); }
    if (event.sequence !== checkpoint.sequence + 1 || event.previous_digest !== checkpointDigest(checkpoint) || event.phase !== checkpoint.phase) fail('DEMO_STALE_EVENT', 5, 'Event does not bind the current checkpoint.');
    return null;
  }
  // Persist this reservation in its own native Workflow step before apply().
  reserve(checkpoint: DemoCheckpoint, event: DemoEvent): DemoCheckpoint {
    if (this.validate(checkpoint, event)) return structuredClone(checkpoint);
    if (event.kind !== 'stop' && (this.now() >= checkpoint.expires_at - DEMO_LIMITS.cleanup_ms || ['complete', 'aborted', 'failed'].includes(checkpoint.phase))) fail('DEMO_RUN_STOPPED', 7, 'Demo has stopped or entered its cleanup window.');
    const next = structuredClone(checkpoint);
    if (++next.counters.events > DEMO_LIMITS.events) fail('DEMO_EVENT_LIMIT', 7, 'Finite event ceiling reached.');
    const input = event.kind === 'actor' ? validateEnvelope(canonical(event.input)) : null;
    const mutation = event.kind !== 'stop' && (event.kind !== 'actor' || MUTATIONS.has(input.command));
    const entries = Object.values(checkpoint.registry.entries);
    // Endorsement adds at most four records (stage <= 13 dispatches), then
    // independently reads four exact locators (<= 12). No larger run allowance.
    const dispatches = event.kind === 'stop' ? 0 : entries.length * 3 + (event.kind === 'endorse' ? 25 : mutation ? 16 : 0);
    const transfer = event.kind === 'stop' ? 0 : entries.reduce((n, entry) => n + entry.locator!.size_bytes!, 0) + (mutation ? 512 * 1024 : 0) + (event.kind === 'endorse' ? 160 * 1024 : 0);
    next.counters.artifact_reserved += dispatches; next.counters.transfer_reserved += transfer;
    next.counters.original_reserved += originalReservation(checkpoint, event, mutation);
    if (dispatches > DEMO_LIMITS.dispatches_per_apply || next.counters.artifact_reserved > DEMO_LIMITS.artifact_dispatches || next.counters.transfer_reserved > DEMO_LIMITS.transfer_bytes || next.counters.original_reserved > DEMO_LIMITS.original_bytes)
      fail('DEMO_ARTIFACT_LIMIT', 7, 'Conservative reservations exceeded the finite envelope.');
    return next;
  }
  async apply(checkpoint: DemoCheckpoint, event: DemoEvent, reserved?: DemoCheckpoint) {
    const cached = this.validate(checkpoint, event); if (cached) return { checkpoint: structuredClone(checkpoint), outcome: cached, reused: true };
    const next = reserved ? structuredClone(reserved) : this.reserve(checkpoint, event);
    // Never accept a forged reservation or lose the previous immutable index.
    if (canonical(next) !== canonical(this.reserve(checkpoint, event))) fail('DEMO_RESERVATION_REFUSED', 4, 'Reservation does not match the durable event.');
    let outcome: Outcome;
    try {
      if (event.kind === 'stop') { onlyKeys(event.input, []); if (event.source !== 'host') fail('DEMO_SOURCE_REFUSED', 4, 'Only host stops the run.'); next.phase = 'aborted'; next.pending = null; outcome = { ok: true, data: { stopped: true, cleanup_required: true } }; }
      else {
        const loaded = await this.storage.load(checkpoint.registry);
        const engine = new Engine(loaded.records, structuredClone(checkpoint.heads), { projectId: checkpoint.project_id, modelVersion: CONTENT_MODEL, checkerBackend: 'none', assetBytes: loaded.assetBytes });
        const data = this.dispatch(engine, next, event);
        if (Object.keys(engine.records).length > DEMO_LIMITS.records) fail('DEMO_RECORD_LIMIT', 7, 'Record bound exceeded.');
        const added = Object.entries(engine.records).filter(([ref]) => !checkpoint.registry.entries[ref]);
        const originalBytes = added.reduce((sum, [, record]) => sum + Buffer.byteLength(canonical(record.data)), 0);
        if (added.length > (event.kind === 'endorse' ? 4 : 8) || added.some(([, record]) => Buffer.byteLength(canonical(record.data)) > (['decision-packet', 'release', 'realization'].includes(record.type) ? DEMO_LIMITS.record_bytes : DEMO_LIMITS.ordinary_record_bytes)) || originalBytes > originalReservation(checkpoint, event, true)) fail('DEMO_RECORD_LIMIT', 7, 'Finite record/stage bound exceeded.');
        if (added.length && next.counters.stage_batches >= DEMO_LIMITS.stage_batches) fail('DEMO_STAGE_LIMIT', 7, 'Stage bound exceeded.');
        if (added.length) next.counters.stage_batches++;
        if (this.now() >= next.expires_at - DEMO_LIMITS.cleanup_ms) fail('DEMO_RUN_STOPPED', 7, 'No stage or publication in the cleanup window.');
        const staged = await this.storage.stage(engine.records, loaded.assetBytes, checkpoint.registry);
        if (this.now() >= next.expires_at - DEMO_LIMITS.cleanup_ms) fail('DEMO_RUN_STOPPED', 7, 'Staged orphan requires cleanup; expired index cannot publish.');
        next.registry = { entries: staged.entries, storage: staged.storage, asset_locators: staged.asset_locators };
        next.heads = structuredClone(engine.ownerHeads);
        if (event.kind === 'endorse' && next.phase === 'complete') {
          const refs = [next.refs.released!, next.refs.inherited!, next.refs.realization!, next.refs.validation!];
          const registry: LocatedRegistry = { storage: staged.storage, asset_locators: {},
            entries: Object.fromEntries(refs.map(ref => [ref, staged.entries[ref]])) };
          // This finite profile has no binary assets. Never silently omit one.
          if (Object.keys(staged.asset_locators).length) fail('DEMO_RELEASE_READBACK_FAILED', 6, 'Unexpected binary closure in the finite demo.');
          const fresh = await this.storage.freshReader().load(registry);
          const cold = new Engine(fresh.records, {}, { projectId: next.project_id, modelVersion: CONTENT_MODEL, checkerBackend: 'none', assetBytes: fresh.assetBytes });
          const candidate = engine.target(next.refs.candidate!), release = cold.read(next.refs.released!, 'release'),
            realization = cold.read(next.refs.realization!, 'realization'), validation = cold.read(next.refs.validation!, 'validation');
          const inherited = cold.target(next.refs.inherited!);
          const rebuilt = cold.realize(next.refs.inherited!, 'booking-node/2');
          if (this.now() >= next.expires_at - DEMO_LIMITS.cleanup_ms) fail('DEMO_RUN_STOPPED', 7, 'Read-back reached the cleanup window.');
          if (refs.some(ref => canonical(fresh.records[ref]) !== canonical(engine.records[ref])) ||
              release.candidate !== candidate.fingerprint || release.validation !== next.refs.validation ||
              validation.target !== next.refs.candidate || validation.candidate !== candidate.fingerprint || validation.realization !== next.refs.realization ||
              validation.evidence_digest !== digest(validation.evidence) || canonical(realization) !== canonical(engine.realize(next.refs.candidate!, 'booking-node/2')) ||
              canonical(snapshotFromRelease(release)) !== canonical(candidate.snapshot) || canonical(release.acceptance_manifest) !== canonical(candidate.obligations) ||
              canonical(release.provenance) !== canonical(candidate.provenance) || canonical(inherited.snapshot) !== canonical(candidate.snapshot) ||
              canonical(inherited.obligations) !== canonical(candidate.obligations) || canonical(inherited.provenance) !== canonical(candidate.provenance) ||
              canonical(rebuilt) !== canonical(data.inherited_realization)) fail('DEMO_RELEASE_READBACK_FAILED', 6, 'Stored Release differs from the exact measured candidate or inheritance.');
          data.inherited_realization = rebuilt;
          data.readback = { format: 'strata-demo-release-readback/1', registry_sha256: digest(next.registry), storage: staged.storage,
            fresh_entries: registry.entries, candidate_ref: next.refs.candidate, candidate_entry: staged.entries[next.refs.candidate!],
            candidate_read: 'earlier exact immutable locator in this apply', candidate_fingerprint: candidate.fingerprint,
            realization_ref: next.refs.realization, realization_sha256: digest(realization), validation_ref: next.refs.validation,
            evidence_digest: validation.evidence_digest, released_ref: next.refs.released, inherited_ref: next.refs.inherited,
            inherited_realization_sha256: digest(rebuilt), verified_at: this.now(), fresh_reader: true,
            boundary: 'Four final exact locators; same run budget; not a fresh read of all retained history or independent authority approval.' };
        }
        if (event.kind === 'actor' && ['layer.create', 'layer.revise', 'layer.publish'].includes(event.input.command)) {
          const actor = event.source.slice(6) as DemoActor, ref = data.ref, entry = next.registry.entries[ref];
          const refs = Object.fromEntries(Object.entries(checkpoint.registry.entries).filter(([key]) => key !== ref));
          const merged = publishPrepared({ entries: checkpoint.registry.entries, heads: checkpoint.heads }, {
            id: DEMO_ACTORS[actor].layer, principal: DEMO_ACTORS[actor].principal, expected_head: checkpoint.heads[DEMO_ACTORS[actor].layer] ?? null,
            refs, ref, entry, record: engine.records[ref], head: next.heads[DEMO_ACTORS[actor].layer] });
          if (canonical(merged.heads) !== canonical(next.heads)) fail('DEMO_PUBLICATION_REFUSED', 5, 'Publication CAS disagrees with the finite actor head.');
          // Retain the staged locators; the pure reducer is a validation/merge check.
        }
        outcome = { ok: true, data };
      }
    } catch (error) {
      const code = error instanceof StrataError ? error.code : 'DEMO_FAILED';
      const storageFailure = !(error instanceof StrataError) || code === 'DEMO_RUN_STOPPED' || /^(ARTIFACT_|STORE_|BUDGET_|DEMO_(RECORD|STAGE|COMMAND|PUBLICATION|RELEASE_READBACK))/.test(code);
      if (storageFailure) { next.phase = 'failed'; next.pending = null; }
      else { next.phase = checkpoint.phase; next.refs = structuredClone(checkpoint.refs); next.pending = structuredClone(checkpoint.pending); next.receipts = structuredClone(checkpoint.receipts); }
      next.registry = structuredClone(checkpoint.registry); next.heads = structuredClone(checkpoint.heads);
      outcome = { ok: false, error: { code, ...(error instanceof StrataError && isProviderDiagnostic(error.details) ? { diagnostic: error.details } : {}) } };
    }
    next.sequence = event.sequence; next.previous_digest = checkpointDigest(checkpoint);
    next.requests[event.request_id] = { event_digest: digest(event), outcome: structuredClone(outcome) };
    next.trace.push({ sequence: event.sequence, kind: event.kind, source: event.source, outcome: outcome.ok ? 'accepted' : outcome.error.code, phase: next.phase });
    if (Buffer.byteLength(canonical(next)) > DEMO_LIMITS.checkpoint_bytes) fail('DEMO_CHECKPOINT_LIMIT', 7, 'No truncated or oversized checkpoint can be published.');
    return { checkpoint: next, outcome, reused: false };
  }
  private dispatch(engine: Engine, next: DemoCheckpoint, event: DemoEvent): any {
    const call = (command: string, input: any, selector = 'fixture-preparer') => this.authority.call(engine, next, command, input, selector);
    if (event.kind === 'actor') {
      if (!/^actor:[abc]$/.test(event.source)) fail('DEMO_SOURCE_REFUSED', 4, 'An actor route is required.');
      const actor = event.source.slice(6) as DemoActor, envelope = validateEnvelope(canonical(event.input));
      if (envelope.options) fail('DEMO_INPUT_REFUSED', 2, 'Demo actor tools accept command/input only.');
      if (!['status', 'inspect', 'conflicts', 'layer.create', 'layer.revise', 'layer.publish'].includes(envelope.command)) fail('OPERATION_FORBIDDEN', 4, 'Actor cannot select operator operations.');
      const fields: Record<string, string[]> = { status: ['target'], inspect: ['type', 'ref', 'limit', 'cursor'], conflicts: ['target'], 'layer.create': ['record'], 'layer.revise': ['record', 'previous'], 'layer.publish': ['ref'] };
      onlyKeys(envelope.input, fields[envelope.command]);
      this.authority.issuer.authorize(this.authority.issuer.resolve('demo-' + actor), envelope.command, envelope.input, engine);
      if (next.counters.tools[actor] >= DEMO_LIMITS.tools_per_actor) fail('DEMO_TOOL_LIMIT', 7, 'Actor tool ceiling reached.');
      next.counters.tools[actor]++;
      const reading = !MUTATIONS.has(envelope.command);
      if (!reading && !(next.phase === 'authors' || next.phase === 'repair' && actor === 'b')) fail('DEMO_PHASE_REFUSED', 4, 'Authoring is frozen at the human packet.');
      if (!reading && (next.phase === 'authors' && envelope.command === 'layer.revise' || next.phase === 'repair' && envelope.command === 'layer.create')) fail('DEMO_PHASE_REFUSED', 4, 'Invalid drafts must correct before publication; only the reminder has a single revision-2 repair.');
      if (!reading && actor === 'b' && (!engine.records['L-hold@1']?.published || !engine.records['L-alternative@1']?.published)) fail('DEMO_PEERS_REQUIRED', 4, 'Reminder needs both published peer proposals.');
      const input = structuredClone(envelope.input);
      if (envelope.command === 'layer.publish') {
        const draft = engine.read(input.ref, 'layer', false);
        // Review finite behavior/dependency/acceptance, not a fabricated model response.
        assignedDraft(draft, actor, next.phase === 'repair');
        const review = call('content.review', { record: { draft, expected_digest: digest(draft), accepted: true, rationale: 'Deterministic finite-demo content check; scripted review, no independent human consent.' } }, 'demo-content-review');
        input.authoring_review = review.ref;
      }
      const result = call(envelope.command, input, 'demo-' + actor);
      if (['layer.create', 'layer.revise'].includes(envelope.command)) assignedDraft(engine.read(result.ref, 'layer', false), actor, next.phase === 'repair');
      if (envelope.command === 'layer.publish' && actor === 'b') next.refs.reminder = result.ref;
      return result;
    }
    if (event.kind === 'selection' || event.kind === 'endorse') {
      if (event.source !== 'operator') fail('DEMO_SOURCE_REFUSED', 4, 'Only the operator reply route may submit a decision artifact.');
      const receipt = human(next, event.input, event.kind === 'selection' ? 'selection' : 'endorsement', this.now());
      next.receipts.push(receipt);
      if (receipt.action === 'defer') { next.phase = 'aborted'; next.pending = null; return { aborted: true, receipt }; }
      if (event.kind === 'selection') {
        if (next.phase !== 'selection') fail('DEMO_PHASE_REFUSED', 4, 'No selection packet is pending.');
        if (receipt.action === '1200' && next.refs.case_revision === 1) { next.refs.chosen = '1200'; next.phase = 'repair'; next.pending = null; return { repair_required: true, owner: 'author-b', dependency: 'L-alternative@1', receipt }; }
        if (next.refs.case_revision === 2 && receipt.action !== '1200') fail('DEMO_CHOICE_REFUSED', 4, 'Repaired packet requires confirmation or defer.');
        const packet = engine.read(next.refs.packet!, 'decision-packet');
        const option = packet.options.find((option: any) => option.id === receipt.action);
        if (!option?.executable) fail('DEMO_CHOICE_REFUSED', 4, 'Choice is not executable.');
        const endorsement = call('mediation.respond', { packet_ref: next.refs.packet, packet_sha256: digest(packet), case_revision: packet.case_revision,
          action: 'approve_selection', option_id: receipt.action, message: receipt.text }, 'fixture-selector');
        const resolution = call('resolve', { record: { layer: option.layer, proposal_index: option.proposal_index, composition: next.refs.composition, approvals: [endorsement.ref] } });
        const selected = composition('C-demo-selected-' + next.refs.case_revision, next.refs.reminder); selected.selected = option.selected; selected.resolutions = [resolution.ref];
        const candidate = call('compose', { record: selected });
        if (candidate.state !== 'eligible_for_validation') fail('DEMO_CHOICE_REFUSED', 6, 'Selected candidate remains blocked.');
        next.refs.chosen = receipt.action as '900' | '1200'; next.refs.candidate = candidate.ref; next.phase = 'runner'; next.pending = null;
        return { candidate, receipt, resolution: { ref: resolution.ref }, recipe: selected,
          semantic_origin: 'human-fixture', host_trust: 'operator-vouched-human-receipt' };
      }
      if (next.phase !== 'endorsement' || receipt.action !== 'approve-release') fail('DEMO_PHASE_REFUSED', 4, 'Measured evidence and release endorsement are required.');
      const candidate = engine.target(next.refs.candidate!), validation = engine.read(next.refs.validation!, 'validation'), baseline = engine.read('R0@1', 'release');
      this.authority.issuer.bindMediation(engine, this.authority.issuer.resolve('fixture-release'));
      const approve = (kind: string, scope: string | null) => ({ format: 'approval/2', project_id: next.project_id, model_version: CONTENT_MODEL, baseline: 'R0@1',
        authority_sha256: digest(baseline.authorities), kind, target: candidate.fingerprint, scope, evidence_digest: validation.evidence_digest,
        generation: engine.mediation!.generation(), expires_at: null, binding: null });
      const scope = call('approve', { record: approve('scope', candidate.scope) }, 'fixture-selector');
      const releaseApproval = call('approve', { record: approve('release', null) }, 'fixture-release');
      const releaseInput = { target: next.refs.candidate, validation: next.refs.validation, approvals: [scope.ref, releaseApproval.ref] };
      const released = call('release', releaseInput, 'fixture-release');
      const replay = call('release', releaseInput, 'fixture-release');
      if (replay.ref !== released.ref) fail('DEMO_RELEASE_REPLAY_REFUSED', 6, 'Release replay differs.');
      const inheritedRecipe = { ...recipe('C-demo-inherited', released.ref), model_version: CONTENT_MODEL, proposals: [], selected: [], alternative_groups: [], resolutions: [] };
      const inherited = call('compose', { record: inheritedRecipe });
      if (canonical(inherited.snapshot.blocks) !== canonical(candidate.snapshot.blocks) || canonical(inherited.obligations) !== canonical(candidate.obligations) || canonical(inherited.provenance) !== canonical(candidate.provenance)) fail('DEMO_INHERITANCE_REFUSED', 6, 'Inherited behavior/acceptance/provenance differs.');
      next.refs.released = released.ref; next.refs.inherited = inherited.ref; next.phase = 'complete'; next.pending = null;
      return { released, replay, inherited, inherited_realization: call('materialize', { target: inherited.ref, profile: 'booking-node/2' }), receipt,
        evidence_boundary: 'Node measured fixture evidence; deterministic intent reviews; operator-vouched human endorsements, internal fixture roles' };
    }
    if (event.source !== (event.kind === 'evidence' ? 'runner' : 'host')) fail('DEMO_SOURCE_REFUSED', 4, 'Event source differs from its fixed role.');
    if (event.kind === 'bootstrap') {
      onlyKeys(event.input, []); if (next.phase !== 'new') fail('DEMO_PHASE_REFUSED', 4, 'Bootstrap is single-use.');
      const result = call('init', { record: demoBaseline() }, 'fixture-bootstrap'); next.phase = 'authors'; return result;
    }
    if (event.kind === 'prepare') {
      onlyKeys(event.input, []);
      if (!['authors', 'repair'].includes(next.phase) || !next.refs.reminder || next.phase === 'repair' && next.refs.reminder !== 'L-reminder@2') fail('DEMO_PHASE_REFUSED', 4, 'Published reminder and exact repair are required.');
      const revision = next.refs.case_revision + 1;
      const blocked = call('compose', { record: composition('C-demo-conflict-' + revision, next.refs.reminder) });
      const partitions = revision === 1 ? [{ id: '900', selected: ['L-hold@1', next.refs.reminder], rejected: ['L-alternative@1'] },
        { id: '1200', selected: ['L-alternative@1'], rejected: ['L-hold@1', next.refs.reminder] }] :
        [{ id: '1200', selected: ['L-alternative@1', next.refs.reminder], rejected: ['L-hold@1'] }];
      const analysis = call('mediation.prepare', { target: blocked.ref, case_id: 'integrated-booking', case_revision: revision,
        expires_at: new Date(next.expires_at - DEMO_LIMITS.cleanup_ms).toISOString(), goal: 'Choose booking hold duration with exact reminder dependency and preserved acceptance.',
        partitions, supersedes: next.refs.basis ?? null });
      const decisions = analysis.decision_proposals.map((option: any) => {
        const record = proposal('L-demo-choice-' + revision + '-' + option.option_id, 'scope-selector'); record.model_version = CONTENT_MODEL; record.resolution_proposals = [option.payload];
        const draft = call('layer.create', { record }, 'demo-decision-target'); call('layer.publish', { ref: draft.ref }, 'demo-decision-target');
        return { option_id: option.option_id, layer: draft.ref, proposal_index: 0 };
      });
      const packet = call('mediation.prepare', { basis_ref: analysis.ref, decisions });
      const handoff = { kind: 'selection', business_request: 'Extend the booking hold and add one reminder 60 seconds before expiry; choose 900 or 1200 seconds.',
        baseline_seconds: 600, considered: engine.read(blocked.ref, 'composition').proposals, packet,
        repair_required_for_initial_1200: revision === 1, choice_preselected: false, validation_status: 'not yet measured',
        reviews: 'Decision targets and authoring review are scripted; selection requires an actual human reply in a controlled run.' };
      next.refs.composition = blocked.ref; next.refs.basis = analysis.ref; next.refs.packet = packet.ref; next.refs.case_revision = revision;
      next.pending = { kind: 'selection', digest: digest(handoff), expires_at: next.expires_at - DEMO_LIMITS.cleanup_ms }; next.phase = 'selection';
      return { ...handoff, packet_digest: next.pending.digest };
    }
    if (event.kind === 'realize') {
      onlyKeys(event.input, []); if (next.phase !== 'runner' || next.refs.realization) fail('DEMO_PHASE_REFUSED', 4, 'Realization requires selected intent and is single-use.');
      const realization = call('materialize', { target: next.refs.candidate, profile: 'booking-node/2' });
      const registered = call('realization.register', { record: realization }); next.refs.realization = registered.ref;
      return { realization, selected_seconds: next.refs.chosen === '900' ? 900 : 1200, oracle_source: 'separate finite scenario expectations; not generated configuration' };
    }
    if (event.kind === 'evidence') {
      onlyKeys(event.input, ['evidence', 'observations_digest']);
      if (next.phase !== 'runner' || !next.refs.realization || !/^[a-f0-9]{64}$/.test(event.input.observations_digest)) fail('DEMO_PHASE_REFUSED', 4, 'Measured app realization must precede evidence.');
      const validation = call('validate', { target: next.refs.candidate, realization: next.refs.realization, evidence: event.input.evidence }, 'fixture-runner');
      if (validation.checks_passed !== true) fail('DEMO_EVIDENCE_REFUSED', 6, 'Measured checks failed.');
      const candidate = engine.target(next.refs.candidate!);
      const handoff = { kind: 'endorsement', candidate_ref: next.refs.candidate, candidate_fingerprint: candidate.fingerprint, scope: candidate.scope,
        validation, realization_ref: next.refs.realization, observations_digest: event.input.observations_digest,
        approvals_requested: ['scope', 'release'], actor_approval_allowed: false,
        review_boundary: 'Purpose reviews are scripted; generated-file and booking checks are measured by Node. One human holds both isolated demo endorsement roles.' };
      next.refs.validation = validation.ref; next.phase = 'endorsement'; next.pending = { kind: 'endorsement', digest: digest(handoff), expires_at: next.expires_at - DEMO_LIMITS.cleanup_ms };
      return { ...handoff, packet_digest: next.pending.digest };
    }
    fail('DEMO_EVENT_REFUSED', 4, 'Unknown finite event kind.');
  }
}

export function safeDemoError(error: unknown) { return { ok: false as const, error: { code: error instanceof StrataError ? error.code : 'DEMO_FAILED' } }; }
