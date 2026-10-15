export type SyntheticViewEvent = {
  format: 'strata.integrated-demo-view-event/1';
  mode: 'synthetic-replay';
  branch: '900' | '1200';
  run_id: string;
  instance_id: string;
  sequence: number;
  event_digest: string;
  kind: string;
  actor: string;
  phase_before: string;
  phase_after: string;
  outcome: string;
  summary: string;
  layer_ref?: string;
  packet_digest?: string;
  fixture_action?: string;
};

export type FeedDecision = 'applied' | 'buffered' | 'duplicate' | 'stale' | 'conflict' | 'invalid';
export type FeedResult = { decision: FeedDecision; applied: SyntheticViewEvent[]; next_sequence: number; missing_sequence?: number };

const hash = /^[a-f0-9]{64}$/;
const phases = new Set(['new', 'authors', 'selection', 'repair', 'runner', 'endorsement', 'complete', 'aborted', 'failed']);
const kinds = new Set(['bootstrap', 'actor', 'prepare', 'selection', 'realize', 'evidence', 'endorse', 'stop']);

function valid(value: unknown): value is SyntheticViewEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Partial<SyntheticViewEvent>;
  return e.format === 'strata.integrated-demo-view-event/1' && e.mode === 'synthetic-replay' && (e.branch === '900' || e.branch === '1200') &&
    typeof e.run_id === 'string' && /^[a-f0-9]{16}$/.test(e.run_id) && e.instance_id === 'run-' + e.run_id &&
    Number.isSafeInteger(e.sequence) && Number(e.sequence) > 0 && typeof e.event_digest === 'string' && hash.test(e.event_digest) &&
    typeof e.kind === 'string' && kinds.has(e.kind) && typeof e.actor === 'string' && e.actor.length <= 80 &&
    typeof e.phase_before === 'string' && phases.has(e.phase_before) && typeof e.phase_after === 'string' && phases.has(e.phase_after) &&
    typeof e.outcome === 'string' && e.outcome.length <= 80 && typeof e.summary === 'string' && e.summary.length <= 240 &&
    (e.layer_ref === undefined || (typeof e.layer_ref === 'string' && /^[a-zA-Z0-9._-]{1,64}@[1-9][0-9]{0,7}$/.test(e.layer_ref))) &&
    (e.packet_digest === undefined || (typeof e.packet_digest === 'string' && hash.test(e.packet_digest))) &&
    (e.fixture_action === undefined || (typeof e.fixture_action === 'string' && e.fixture_action.length <= 80));
}

export class OrderedSyntheticFeed {
  private expected = 1;
  private identity: string | null = null;
  private readonly appliedBySequence = new Map<number, SyntheticViewEvent>();
  private readonly buffered = new Map<number, SyntheticViewEvent>();
  private stopped = false;
  constructor(private readonly maxBuffered = 64, private readonly maxHistory = 256) {}

  get nextSequence() { return this.expected; }
  get lastApplied() { return this.expected - 1; }
  get records() { return [...this.appliedBySequence.values()]; }

  reset() {
    this.expected = 1; this.identity = null; this.appliedBySequence.clear(); this.buffered.clear(); this.stopped = false;
  }

  accept(value: unknown): FeedResult {
    if (!valid(value)) return { decision: 'invalid', applied: [], next_sequence: this.expected };
    const event = structuredClone(value);
    const identity = `${event.run_id}:${event.branch}`;
    if (this.identity !== null && this.identity !== identity) {
      this.stopped = true; return { decision: 'conflict', applied: [], next_sequence: this.expected };
    }
    const prior = this.appliedBySequence.get(event.sequence) ?? this.buffered.get(event.sequence);
    if (prior) {
      if (prior.event_digest !== event.event_digest) { this.stopped = true; return { decision: 'conflict', applied: [], next_sequence: this.expected }; }
      return { decision: 'duplicate', applied: [], next_sequence: this.expected, ...(this.buffered.size ? { missing_sequence: this.expected } : {}) };
    }
    if (this.stopped) return { decision: 'conflict', applied: [], next_sequence: this.expected };
    this.identity ??= identity;
    if (event.sequence < this.expected) return { decision: 'stale', applied: [], next_sequence: this.expected };
    if (event.sequence > this.expected) {
      if (event.sequence - this.expected > this.maxBuffered || this.buffered.size >= this.maxBuffered) {
        this.stopped = true; return { decision: 'conflict', applied: [], next_sequence: this.expected };
      }
      this.buffered.set(event.sequence, event);
      return { decision: 'buffered', applied: [], next_sequence: this.expected, missing_sequence: this.expected };
    }

    const applied: SyntheticViewEvent[] = [event];
    this.apply(event);
    while (this.buffered.has(this.expected)) {
      const next = this.buffered.get(this.expected)!;
      this.buffered.delete(this.expected); applied.push(next); this.apply(next);
    }
    return { decision: 'applied', applied, next_sequence: this.expected, ...(this.buffered.size ? { missing_sequence: this.expected } : {}) };
  }

  private apply(event: SyntheticViewEvent) {
    this.appliedBySequence.set(event.sequence, event); this.expected++;
    while (this.appliedBySequence.size > this.maxHistory) this.appliedBySequence.delete(this.appliedBySequence.keys().next().value!);
  }
}
