import { canonical, fail } from './model.js';
import { CHECKLIST_CEILINGS, type AppPins } from './checklist-cloud-limits.js';

export type ChecklistOperation = { operation: 'add'; args: [string, string] } |
  { operation: 'get' | 'complete' | 'remove'; args: [string] } | { operation: 'list' | 'audit'; args: [] };
export interface CollectionInstance {
  add(id: string, title: string): unknown; get(id: string): unknown; list(): unknown;
  complete(id: string): unknown; remove(id: string): unknown; audit(): unknown;
}
export type AppEnvironment = { CHECKLIST_SOURCE_SHA256: string; CHECKLIST_TARGET_SHA256: string; CHECKLIST_VERSION: { id: string } };
export type AppObservation = { format: 'strata-checklist-worker-observation/1'; pins: AppPins; source_sha256: string;
  target_sha256: string; worker_version_id: string; initial: { items: unknown; audit: unknown };
  actions: { operation: string; args: string[]; result: unknown }[]; final: { items: unknown; audit: unknown };
  location: 'Worker fresh in-memory instance'; semantic_release_created: false };

export async function boundedChecklistJson(response: Response | Request, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) fail('CHECKLIST_BODY_REFUSED', 2, 'JSON body required.');
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length;
    if (size > maximum) fail('CHECKLIST_BODY_REFUSED', 2, 'JSON body exceeded the fixed byte envelope.'); chunks.push(next.value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('CHECKLIST_BODY_REFUSED', 2, 'Invalid JSON/UTF-8.'); }
}
function operations(raw: unknown): ChecklistOperation[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > CHECKLIST_CEILINGS.app_operations) fail('CHECKLIST_OPERATIONS_REFUSED', 2, 'Bounded allowlisted operations required.');
  for (const o of raw) {
    const count = o?.operation === 'add' ? 2 : ['get', 'complete', 'remove'].includes(o?.operation) ? 1 : ['list', 'audit'].includes(o?.operation) ? 0 : -1;
    if (!o || canonical(Object.keys(o).sort()) !== canonical(['args', 'operation']) || !Array.isArray(o.args) || o.args.length !== count ||
      o.args.some((a: unknown) => typeof a !== 'string' || new TextEncoder().encode(a).length > 128)) fail('CHECKLIST_OPERATIONS_REFUSED', 2, 'Invalid operation or arguments.');
  }
  return raw;
}
// Generated external entrypoint MUST statically import the exact collection.mjs and pass only its createCollection.
// No dynamic importer, profile, oracle, checker, model, provider credential or durable state.
export function checklistAppWorker(createCollection: () => CollectionInstance, pins: AppPins) {
  return { async fetch(request: Request, env: AppEnvironment) {
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/observe' || url.search || !/^[a-f0-9]{64}$/.test(env.CHECKLIST_SOURCE_SHA256) || !/^[a-f0-9]{64}$/.test(env.CHECKLIST_TARGET_SHA256) || !env.CHECKLIST_VERSION?.id) fail('CHECKLIST_APP_REFUSED', 4, 'Private pinned observation request required.');
      const raw = await boundedChecklistJson(request, 8192) as { pins: AppPins; source_sha256: string; target_sha256: string; worker_version_id: string; operations: unknown };
      if (!raw || canonical(Object.keys(raw).sort()) !== canonical(['operations', 'pins', 'source_sha256', 'target_sha256', 'worker_version_id']) || canonical(raw.pins) !== canonical(pins) || raw.source_sha256 !== env.CHECKLIST_SOURCE_SHA256 || raw.target_sha256 !== env.CHECKLIST_TARGET_SHA256 || raw.worker_version_id !== env.CHECKLIST_VERSION.id) fail('CHECKLIST_APP_REFUSED', 4, 'App/source/Release/version pins differ.');
      const calls = operations(raw.operations), app = createCollection();
      const initial = { items: app.list(), audit: app.audit() };
      const actions = calls.map(o => ({ ...o, result: (app[o.operation] as (...args: string[]) => unknown).apply(app, o.args) }));
      const body: AppObservation = { format: 'strata-checklist-worker-observation/1', pins, source_sha256: env.CHECKLIST_SOURCE_SHA256,
        target_sha256: env.CHECKLIST_TARGET_SHA256, worker_version_id: env.CHECKLIST_VERSION.id, initial, actions,
        final: { items: app.list(), audit: app.audit() }, location: 'Worker fresh in-memory instance', semantic_release_created: false };
      const text = canonical(body); if (new TextEncoder().encode(text).length > CHECKLIST_CEILINGS.app_response_bytes) fail('CHECKLIST_BODY_REFUSED', 2, 'Observation exceeded byte envelope.');
      return new Response(text, { headers: { 'content-type': 'application/json' } });
    } catch { return new Response('{"error":"CHECKLIST_APP_REFUSED"}', { status: 400, headers: { 'content-type': 'application/json' } }); }
  } };
}

// Literal independent operation sequence: no generated config/oracle determines capacity or expected history.
export function checklistSequence(unicode: boolean): ChecklistOperation[] {
  const calls: ChecklistOperation[] = unicode ? [{ operation: 'add', args: ['unicode', '😀'.repeat(20)] }, { operation: 'remove', args: ['unicode'] }] : [];
  for (let n = 1; n <= 7; n++) calls.push({ operation: 'add', args: ['item' + n, 'Task ' + n] });
  calls.push({ operation: 'add', args: ['extra', 'Task 8'] }, { operation: 'complete', args: ['item1'] },
    { operation: 'complete', args: ['item1'] }, { operation: 'add', args: ['extra', 'Task 8'] }, { operation: 'remove', args: ['item1'] });
  if (!unicode) calls.push({ operation: 'add', args: ['replacement', 'Replacement'] });
  calls.push({ operation: 'list', args: [] }, { operation: 'audit', args: [] });
  return calls;
}
export function verifyChecklistObservation(raw: unknown, pins: AppPins, source: string, target: string, version: string, unicode: boolean): AppObservation {
  const o = raw as AppObservation, calls = checklistSequence(unicode), offset = unicode ? 2 : 0;
  const refused = () => fail('CHECKLIST_OBSERVATION_REFUSED', 6, 'Literal seven/audit observation or identity differed.');
  if (!o || o.format !== 'strata-checklist-worker-observation/1' || canonical(o.pins) !== canonical(pins) || o.source_sha256 !== source || o.target_sha256 !== target || o.worker_version_id !== version || o.location !== 'Worker fresh in-memory instance' || o.semantic_release_created !== false || canonical(o.initial) !== canonical({ items: [], audit: [] }) || o.actions?.length !== calls.length) refused();
  const accepted = (i: number) => (o.actions[i]?.result as { accepted?: boolean })?.accepted === true;
  o.actions.forEach((a, i) => { if (a.operation !== calls[i].operation || canonical(a.args) !== canonical(calls[i].args)) refused(); });
  for (let i = 0; i < offset + 7; i++) if (!accepted(i)) refused();
  for (const i of [offset + 7, offset + 10]) if (canonical(o.actions[i].result) !== canonical({ accepted: false, reason: 'limit' })) refused();
  for (const i of [offset + 8, offset + 9, offset + 11, ...(!unicode ? [offset + 12] : [])]) if (!accepted(i)) refused();
  const audit = o.final.audit as { sequence: number; operation: string }[], items = o.final.items as { id: string }[];
  const expectedOperations = [...(unicode ? ['add', 'remove'] : []), ...Array(7).fill('add'), 'complete', 'remove', ...(!unicode ? ['add'] : [])];
  const expectedIds = [...Array.from({ length: 6 }, (_, i) => 'item' + (i + 2)), ...(!unicode ? ['replacement'] : [])].sort();
  if (!Array.isArray(audit) || canonical(audit.map(a => a.sequence)) !== canonical(Array.from({ length: unicode ? 11 : 10 }, (_, i) => i + 1)) || canonical(audit.map(a => a.operation)) !== canonical(expectedOperations) || !Array.isArray(items) || canonical(items.map(i => i.id)) !== canonical(expectedIds) || canonical(o.actions.at(-1)?.result) !== canonical(audit) || canonical(o.actions.at(-2)?.result) !== canonical(items)) refused();
  return o;
}
