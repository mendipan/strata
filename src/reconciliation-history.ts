import { canonical, digest, fail, parse, type Records } from './model.js';
import { RECONCILIATION_LIMITS as L, RECONCILIATION_V2_SCHEMAS, parseReconciliationRecord, readPinned,
  recordPin, same, type Pin, type TypedEdge, type ReconciliationType, type TypedRecordReader } from './reconciliation-records.js';

/** Explicit typed edges; never search arbitrary strings for apparent references. */
export function reconciliationReferences(type: string, input: unknown): TypedEdge[] {
  if (!Object.hasOwn(RECONCILIATION_V2_SCHEMAS, type)) fail('RECONCILIATION_VERSION', 8, 'Unsupported reconciliation record type.');
  const d = parseReconciliationRecord(type as ReconciliationType, input), edges: TypedEdge[] = [];
  const add = (pin: Pin | null, kind: string) => { if (pin) edges.push({ pin, type: kind }); };
  const many = (pins: Pin[], kind: string) => pins.forEach(pin => add(pin, kind));
  const target = (value: any) => add({ ref: value.release_ref, sha256: value.release_sha256 }, 'release');
  const bridge = (value: any) => {
    add(value.predecessor, 'source-binding'); target(value.old_intent); target(value.target);
    value.semantic_records.forEach((edge: TypedEdge) => add(edge.pin, edge.type));
  };
  switch (type) {
    case 'reconciliation-git-object': case 'reconciliation-producer-descriptor': break;
    case 'reconciliation-source-proof':
      if (d.phase === 'planned') { add(d.predecessor, 'source-binding'); add(d.report, 'drift-report'); add(d.bound_source, 'source-snapshot'); many(d.objects, 'reconciliation-git-object'); }
      else { add(d.prepared, 'reconciliation-source-proof'); add(d.plan, 'reconciliation-proposal'); add(d.source_snapshot, 'source-snapshot'); many(d.additional_objects, 'reconciliation-git-object'); }
      break;
    case 'reconciliation-proposal': {
      const b = d.body; add(d.auth, 'reconciliation-auth'); add(b.report, 'drift-report'); add(b.predecessor, 'source-binding');
      target(b.old_intent); target(b.target); b.layer_refs.forEach((r: string) => {
        const retained = b.historical_bridge.semantic_records.find((e: TypedEdge) => e.type === 'layer' && e.pin.ref === r);
        if (!retained) fail('RECONCILIATION_EDGE', 6, 'Layer ref lacks its exact typed semantic pin.'); add(retained.pin, 'layer');
      });
      bridge(b.historical_bridge); add(b.source_proof, 'reconciliation-source-proof'); add(b.producer_descriptor, 'reconciliation-producer-descriptor'); break;
    }
    case 'reconciliation-auth': {
      const i = d.action_input;
      switch (i.action) {
        case 'drift.reconcile.prepare': add(i.request.report, 'drift-report'); add(i.request.target_release, 'release');
          many(i.layer_pins, 'layer'); break;
        case 'drift.reconcile.check': add(i.request.plan, 'reconciliation-proposal'); break;
        case 'drift.reconcile.approve': add(i.request.plan, 'reconciliation-proposal'); add(i.request.evidence, 'reconciliation-evidence'); break;
        case 'drift.reconcile.complete': add(i.request.plan, 'reconciliation-proposal'); add(i.request.evidence, 'reconciliation-evidence'); many(i.request.approvals, 'reconciliation-review'); break;
        case 'reconciliation.run': add(i.plan, 'reconciliation-proposal'); add(i.source_proof, 'reconciliation-source-proof'); add(i.producer_descriptor, 'reconciliation-producer-descriptor'); break;
        case 'reconciliation.criterion-review': add(i.plan, 'reconciliation-proposal'); break;
        case 'reconciliation.role-approval': add(i.plan, 'reconciliation-proposal'); add(i.evidence, 'reconciliation-evidence'); break;
      } break;
    }
    case 'reconciliation-run': add(d.plan, 'reconciliation-proposal'); target(d.target); add(d.producer_descriptor, 'reconciliation-producer-descriptor');
      add(d.source_proof, 'reconciliation-source-proof'); add(d.auth, 'reconciliation-auth'); if (d.final_source) add(d.final_source.source_snapshot, 'source-snapshot'); break;
    case 'reconciliation-criterion-review': add(d.plan, 'reconciliation-proposal'); target(d.target); add(d.auth, 'reconciliation-auth'); break;
    case 'reconciliation-evidence': add(d.plan, 'reconciliation-proposal'); add(d.planned_run, 'reconciliation-run');
      add(d.criterion_review, 'reconciliation-criterion-review'); target(d.target); add(d.producer_descriptor, 'reconciliation-producer-descriptor'); break;
    case 'reconciliation-review': add(d.subject.plan, 'reconciliation-proposal'); add(d.subject.evidence, 'reconciliation-evidence');
      target(d.subject.target); bridge(d.subject.historical_bridge); add(d.auth, 'reconciliation-auth'); break;
    case 'reconciliation-completion': add(d.plan, 'reconciliation-proposal'); add(d.evidence, 'reconciliation-evidence'); many(d.reviews, 'reconciliation-review');
      add(d.auth, 'reconciliation-auth'); bridge(d.historical_bridge); add(d.source_snapshot, 'source-snapshot'); add(d.source_proof, 'reconciliation-source-proof');
      add(d.final_run, 'reconciliation-run'); target(d.successor_payload.intent); add(d.successor_payload.predecessor, 'source-binding'); many(d.successor_payload.evidence, 'reconciliation-evidence'); break;
    case 'source-binding': target(d.payload.intent); add(d.payload.source, 'source-snapshot'); add(d.payload.predecessor, 'source-binding'); many(d.payload.evidence, 'reconciliation-evidence');
      add(d.acceptance.completion, 'reconciliation-completion'); add(d.acceptance.source_approval, 'reconciliation-review'); add(d.acceptance.finalizer_auth, 'reconciliation-auth'); break;
  }
  const unique = new Map<string, TypedEdge>();
  for (const edge of edges) {
    const prior = unique.get(edge.pin.ref);
    if (prior && canonical(prior) !== canonical(edge)) fail('RECONCILIATION_EDGE', 6, 'Conflicting typed edges for one ref.');
    unique.set(edge.pin.ref, edge);
  }
  return [...unique.values()].sort((a, b) => a.pin.ref < b.pin.ref ? -1 : a.pin.ref > b.pin.ref ? 1 : 0);
}
export type AtomicPublication = { result: { completion: Pin; source_binding: Pin }; commit_audit: { completion: Pin; source_binding: Pin } };
function assertPublishedAssociation(ref: string, row: Records[string]): void {
  if ((row.type === 'source-binding' && row.data.format === 'source-binding/2' ||
    row.type === 'reconciliation-completion' && row.data.format === 'reconciliation-completion/2') && row.published !== true)
    fail('RECONCILIATION_PUBLICATION', 6, `New association record must be published: ${ref}`);
}
/** Derived only from indexed bindings, never unindexed artifact files or a caller consumer lookup. */
export function completionBindingConsumers(index: Records): Map<string, Pin[]> {
  const result = new Map<string, Pin[]>();
  for (const [ref, row] of Object.entries(index)) if (row.published === true && row.type === 'source-binding' && row.data.format === 'source-binding/2') {
    const b = parseReconciliationRecord('source-binding', row.data), pin = recordPin('source-binding', b);
    same(ref, pin.ref, 'Indexed binding has a wrong full-digest ref.'); same(b.payload_sha256, digest(b.payload), 'Binding payload digest disagrees.');
    const completion = index[b.acceptance.completion.ref];
    if (!completion || completion.type !== 'reconciliation-completion' || completion.data.format !== 'reconciliation-completion/2')
      fail('RECONCILIATION_CLOSURE', 6, 'Published binding requires its indexed /2 completion.');
    assertPublishedAssociation(b.acceptance.completion.ref, completion);
    const key = b.acceptance.completion.ref, consumers = result.get(key) ?? [];
    consumers.push(pin); result.set(key, consumers);
  }
  return result;
}
export function verifyCompletionBindingEdge(read: TypedRecordReader, completion: Pin, consumers: Pin[], publications: AtomicPublication[]): TypedEdge {
  // The indexed reader must enforce published state for /2 completion/binding records.
  if (consumers.length !== 1) fail('RECONCILIATION_BINDING_CONSUMER', 6, 'Completion requires exactly one indexed binding consumer.');
  const c = parseReconciliationRecord('reconciliation-completion', readPinned(read, completion, 'reconciliation-completion'));
  const b = parseReconciliationRecord('source-binding', readPinned(read, consumers[0], 'source-binding'));
  same(b.acceptance.completion, completion, 'Binding completion pin disagrees.');
  same([b.payload, b.payload_sha256, b.acceptance.finalizer_auth], [c.successor_payload, c.successor_payload_sha256, c.auth], 'Binding differs from completed payload/finalizer.');
  same(c.successor_payload_sha256, digest(c.successor_payload), 'Completed payload digest disagrees.');
  same([b.payload.project_id, b.payload.repo_id, b.payload.source], [c.project_id, c.repo_id, c.source_snapshot], 'Completed source/project differs from binding.');
  if (!c.reviews.some((p: Pin) => canonical(p) === canonical(b.acceptance.source_approval))) fail('RECONCILIATION_BINDING_CONSUMER', 6, 'Binding source approval is not a selected completion review.');
  const review = parseReconciliationRecord('reconciliation-review', readPinned(read, b.acceptance.source_approval, 'reconciliation-review'));
  same([review.subject.plan, review.subject.evidence, review.subject.target], [c.plan, c.evidence, c.historical_bridge.target], 'Binding source approval belongs to another subject.');
  const sourceRole = review.subject.required_roles.find((r: string) => r.startsWith('source:'));
  if (!sourceRole || !review.roles.includes(sourceRole)) fail('RECONCILIATION_BINDING_CONSUMER', 6, 'Binding source approval does not cover its source role.');
  const selected = publications.filter(p => p.result.completion.ref === completion.ref || p.commit_audit.completion.ref === completion.ref);
  if (selected.length !== 1) fail('RECONCILIATION_ATOMIC_LINK', 6, 'Completion requires exactly one retained result/commit-audit pair.');
  const expected = { completion, source_binding: consumers[0] };
  same(selected[0].result, expected, 'Atomic result differs from indexed completion/binding.');
  same(selected[0].commit_audit, expected, 'Commit audit differs from indexed completion/binding.');
  return { pin: consumers[0], type: 'source-binding' };
}
/** S1 traversal scaffold. S5 additionally verifies semantic, action/time and producer history. */
export function collectReconciliationClosure(index: Records, roots: TypedEdge[], legacyReferences: (type: string, data: unknown) => TypedEdge[], publications: AtomicPublication[]) {
  if (Object.keys(index).length > 20000) fail('RECONCILIATION_INDEX_LIMIT', 8, 'Indexed reverse lookup exceeds the existing 20,000-record project bound.');
  const read: TypedRecordReader = (pin, type) => {
    const row = index[pin.ref]; if (!row || row.type !== type) fail('RECONCILIATION_CLOSURE', 6, 'Missing or wrong-type indexed record.');
    assertPublishedAssociation(pin.ref, row); return row.data;
  };
  const consumers = completionBindingConsumers(index), visited = new Map<string, TypedEdge>(), records: Records = {};
  let encodedBytes = 0;
  const queue = [...roots];
  while (queue.length) {
    const next = queue.pop()!, row = index[next.pin.ref];
    if (!row || row.type !== next.type) fail('RECONCILIATION_CLOSURE', 6, 'Missing typed closure record.');
    const edge = next;
    const previous = visited.get(edge.pin.ref);
    if (previous) { same(previous, edge, 'Closure edge pin/type disagrees.'); continue; }
    readPinned(read, edge.pin, edge.type); visited.set(edge.pin.ref, edge);
    if (visited.size > L.closureRecords) fail('RECONCILIATION_CLOSURE_LIMIT', 8, 'Reconciliation closure exceeds 16,384 records.');
    const size = Buffer.byteLength(canonical(row.data));
    if (size > L.recordBytes) fail('RECONCILIATION_RECORD_LIMIT', 8, 'Closure record exceeds 768 KiB.');
    encodedBytes += size;
    if (encodedBytes > L.closureBytes) fail('RECONCILIATION_CLOSURE_BYTES', 8, 'Reconciliation encoded closure exceeds 64 MiB.');
    records[edge.pin.ref] = row;
    const schema = Object.hasOwn(RECONCILIATION_V2_SCHEMAS, row.type) ? RECONCILIATION_V2_SCHEMAS[row.type as ReconciliationType] : null;
    // Legacy shapes dispatch to their unchanged external reader, rather than widening /1.
    if (schema && schema.safeParse(row.data).success) {
      queue.push(...reconciliationReferences(row.type, row.data));
      if (row.type === 'reconciliation-completion') queue.push(verifyCompletionBindingEdge(read, edge.pin, consumers.get(edge.pin.ref) ?? [], publications));
    } else {
      const oldFormats: Record<string, string> = { 'source-binding': 'source-binding/1', 'reconciliation-proposal': 'reconciliation-proposal/1',
        'reconciliation-review': 'reconciliation-review/1', 'reconciliation-completion': 'reconciliation-completion/1' };
      if (schema && row.data.format !== oldFormats[row.type])
        fail('RECONCILIATION_VERSION', 8, 'Malformed new record cannot fall back to a legacy parser.');
      queue.push(...legacyReferences(row.type, row.data));
    }
  }
  return { records, encoded_bytes: encodedBytes, structural_closure_collected: true as const,
    live_source_checked: false as const, live_authority_checked: false as const };
}
