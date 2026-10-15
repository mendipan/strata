import { fail } from './model.js';
import { OrderedSyntheticFeed, type SyntheticViewEvent } from '../demo/ordered-feed.js';
import {
  syntheticViewEvents,
  syntheticViewSummary,
  type ImportedWorkflowSnapshot,
  type SyntheticDecisionPacket,
  type SyntheticViewSummary
} from './integrated-demo-visualization.js';

export type ReplayPacket = Omit<SyntheticDecisionPacket, 'expires_at'>;

export type ReplayBranch = {
  branch: '900' | '1200';
  run_id: string;
  event_count: number;
  events: SyntheticViewEvent[];
  actors: SyntheticViewSummary['actors'];
  scripted_overlap_actors: string[];
  selection_packets: ReplayPacket[];
  endorsement: SyntheticViewSummary['endorsement'];
  release: SyntheticViewSummary['release'] & { fixture_state: 'validated' };
  provenance: {
    synthetic_only: true;
    real_model_calls: 0;
    actual_human_replies: 0;
    provider_calls: 0;
  };
};

export type IntegratedDemoReplay = {
  format: 'strata.integrated-demo-replay-view/1';
  source: 'historical-local-rehearsal-fixture';
  live_data: false;
  branches: ReplayBranch[];
};

type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DEMO_REPLAY_INPUT_REFUSED', 4, `${label} must be an object.`);
  return value as JsonRecord;
}

function overlappingFixtureActors(value: unknown): string[] {
  if (!Array.isArray(value)) fail('DEMO_REPLAY_INTERVAL_REFUSED', 4, 'Synthetic turn intervals are missing.');
  const intervals = value.map((entry, index) => {
    const interval = object(entry, `turn interval ${index + 1}`);
    if (interval.label !== 'synthetic-turn' || typeof interval.actor !== 'string' || !/^[abc]$/.test(interval.actor) ||
        typeof interval.start !== 'number' || !Number.isFinite(interval.start) ||
        typeof interval.end !== 'number' || !Number.isFinite(interval.end) || interval.end <= interval.start)
      fail('DEMO_REPLAY_INTERVAL_REFUSED', 4, 'Only bounded, explicitly synthetic actor intervals can be summarized.');
    return { actor: interval.actor.toUpperCase(), start: interval.start, end: interval.end };
  });
  const actors = new Set<string>();
  for (let left = 0; left < intervals.length; left++) {
    for (let right = left + 1; right < intervals.length; right++) {
      const a = intervals[left]!, b = intervals[right]!;
      if (a.actor !== b.actor && a.start < b.end && b.start < a.end) {
        actors.add(a.actor);
        actors.add(b.actor);
      }
    }
  }
  return [...actors].sort();
}

function fixturePublishedLayers(events: SyntheticViewEvent[], actors: SyntheticViewSummary['actors']): SyntheticViewSummary['actors'] {
  const published = new Map<string, Set<string>>();
  for (const event of events) {
    const actor = /^Actor ([ABC]) /.exec(event.actor)?.[1];
    if (event.kind !== 'actor' || event.outcome !== 'accepted' || !event.summary.startsWith('Published ') || !event.layer_ref || !actor) continue;
    const layers = published.get(actor) ?? new Set<string>();
    layers.add(event.layer_ref);
    published.set(actor, layers);
  }
  return actors.map(({ actor }) => ({ actor, layers: [...(published.get(actor) ?? [])] }));
}

function replayBranch(value: unknown): ReplayBranch {
  const rehearsal = object(value, 'rehearsal');
  const summary = syntheticViewSummary(rehearsal);
  const events = syntheticViewEvents(rehearsal);
  if (events.length !== summary.event_count || summary.synthetic_only !== true ||
      summary.real_model_calls !== 0 || summary.actual_human_replies !== 0 || summary.provider_calls !== 0)
    fail('DEMO_REPLAY_PROVENANCE_REFUSED', 4, 'Replay must be complete and explicitly synthetic.');

  const feed = new OrderedSyntheticFeed();
  for (const event of events) {
    const result = feed.accept(event);
    if (result.decision !== 'applied' || result.applied.length !== 1)
      fail('DEMO_REPLAY_ORDER_REFUSED', 4, 'Canonical fixture events are not a unique, contiguous replay.');
  }
  const orderedEvents = feed.records;
  if (orderedEvents.length !== events.length || orderedEvents.some((event, index) => event.sequence !== index + 1))
    fail('DEMO_REPLAY_ORDER_REFUSED', 4, 'Canonical fixture event history is incomplete.');

  const rawRelease = object(rehearsal.released, 'fixture Release');
  if (rawRelease.state !== 'validated' || summary.endorsement.approvals_pending !== true)
    fail('DEMO_REPLAY_RELEASE_REFUSED', 4, 'Fixture Release state must preserve its pending approval boundary.');
  const packets = summary.selection_packets.map(({ expires_at: _expiresAt, ...packet }) => packet);
  return {
    branch: summary.branch,
    run_id: summary.run_id,
    event_count: summary.event_count,
    events: orderedEvents,
    actors: fixturePublishedLayers(orderedEvents, summary.actors),
    scripted_overlap_actors: overlappingFixtureActors(rehearsal.intervals),
    selection_packets: packets,
    endorsement: summary.endorsement,
    release: { ...summary.release, fixture_state: 'validated' },
    provenance: { synthetic_only: true, real_model_calls: 0, actual_human_replies: 0, provider_calls: 0 }
  };
}

export function integratedDemoReplayData(value: unknown): IntegratedDemoReplay {
  const source = object(value, 'rehearsal collection');
  if (source.live_authorized !== false || !Array.isArray(source.rehearsals) || source.rehearsals.length !== 2)
    fail('DEMO_REPLAY_SOURCE_REFUSED', 4, 'Viewer input must be the two-branch local fixture with live activity disabled.');
  const branches = source.rehearsals.map(replayBranch).sort((left, right) => Number(left.branch) - Number(right.branch));
  if (branches[0]?.branch !== '900' || branches[1]?.branch !== '1200')
    fail('DEMO_REPLAY_SOURCE_REFUSED', 4, 'Viewer input must contain exactly the 900- and 1,200-second fixture branches.');
  return { format: 'strata.integrated-demo-replay-view/1', source: 'historical-local-rehearsal-fixture', live_data: false, branches };
}

export function renderIntegratedDemoReplayHtml(template: string, replay: IntegratedDemoReplay): string {
  const marker = '@@REPLAY_DATA@@';
  if (template.split(marker).length !== 2) fail('DEMO_REPLAY_TEMPLATE_REFUSED', 4, 'Viewer template must contain one replay data slot.');
  const payload = JSON.stringify(replay)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return template.replace(marker, payload);
}


export function renderIntegratedDemoWorkflowSnapshotHtml(template: string, snapshot: ImportedWorkflowSnapshot): string {
  const marker = '@@WORKFLOW_SNAPSHOT@@';
  if (template.split(marker).length !== 2) fail('DEMO_REPLAY_TEMPLATE_REFUSED', 4, 'Workflow snapshot template must contain one snapshot data slot.');
  const payload = JSON.stringify(snapshot)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return template.replace(marker, payload);
}
