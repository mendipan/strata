export type WorkSpan = { actor: string; phase: string; start_ms: number; end_ms: number };
export function measuredOverlap(spans: WorkSpan[], phases: string[]) {
  const included = spans.filter(s => phases.includes(s.phase) && s.end_ms > s.start_ms);
  const events = included.flatMap(s => [{ time: s.start_ms, delta: 1, actor: s.actor }, { time: s.end_ms, delta: -1, actor: s.actor }]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  const active = new Map<string, number>(); let peak = 0, overlap_ms = 0, last = events[0]?.time ?? 0;
  for (const event of events) {
    if (active.size > 1) overlap_ms += event.time - last;
    const count = (active.get(event.actor) ?? 0) + event.delta;
    if (count) active.set(event.actor, count); else active.delete(event.actor);
    peak = Math.max(peak, active.size); last = event.time;
  }
  return { peak_distinct_actors: peak, overlap_ms, positive_duration_spans: included.length, zero_duration_spans: spans.filter(s => phases.includes(s.phase) && s.end_ms === s.start_ms).length, timestamp_resolution_ms: 1, interval_policy: 'half-open; zero-duration spans excluded; no queue/request intervals counted' };
}
export function latencies(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50_ms: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? null, p95_ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, max_ms: sorted.at(-1) ?? null };
}
export function formatStressEvidence(report: any): string {
  const overlap = report.actual_server_work_overlap ?? report.partial_server_work_overlap;
  const lines = [
    `${report.status}: ${report.completed_actors ?? report.actors}/${report.actors} scripted local SDK actors`,
    `Model calls: ${report.model_calls ?? 0}; Codex subprocess agents: ${report.codex_subprocess_agents ?? 0}; cloud calls: ${report.cloud_calls ?? 0}`,
    `Measured server work peak: ${overlap?.peak_distinct_actors ?? 'unavailable'} actors; overlap: ${overlap?.overlap_ms ?? 'unavailable'} ms`,
    `Storage peak: ${report.storage_io_overlap?.peak_distinct_actors ?? 'unavailable'}; publication peak: ${report.publication_overlap?.peak_distinct_actors ?? 'unavailable'} (serialized)`,
    'Counts use server hash/persistence spans; queued requests and zero-duration spans do not count.'
  ];
  if (report.actor_elapsed_ms !== undefined) lines.push(`Author/publish phase: ${(report.actor_elapsed_ms / 1000).toFixed(3)} s; request window: ${report.max_open_actor_requests}`);
  for (const [command, latency] of Object.entries(report.latency ?? {}) as [string, any][]) lines.push(`  ${command}: ${latency.samples} samples; p50 ${latency.p50_ms?.toFixed(1)} ms; p95 ${latency.p95_ms?.toFixed(1)} ms`);
  if (report.integrity) lines.push(`Integrity: ${report.integrity.verified_immutable_layers} exact Layers; baseline unchanged: ${report.integrity.baseline_unchanged}; expected collisions: ${report.integrity.expected_collision_diagnostics}`, `Compatible selection: ${report.integrity.compatible_selected}; coalesced contributors: ${report.integrity.coalesced_expiry_contributors}`);
  if (report.local_test_data_bytes !== undefined) lines.push(`Local data: ${(report.local_test_data_bytes / 1048576).toFixed(2)} MiB; per-run cap: 256 MiB`);
  if (report.budget) lines.push(`Reserved requests: ${report.budget.reserved.operations}/${report.budget.limits.operations}; attempts: ${report.budget.reserved.attempts}/${report.budget.limits.attempts}; provider billing cap: none`);
  if (report.message) lines.push(`Stopped: ${report.message}`);
  if (report.evidence?.result) lines.push(`Evidence: ${report.evidence.result}`);
  return lines.join('\n') + '\n';
}
