import type { Engine } from './core.js';
import { digest, fail, parseLayer, type Layer } from './model.js';

// Local operational metadata, never a semantic record or authority source.
export type ContextMap = Record<string, { generation: number; target: string; fingerprint: string }>;
const exact = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/;
function inputObject(input: any, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) fail('INVALID_ARGUMENT', 2, 'Use only the documented recovery inputs.');
}
export function recoveryInput(command: string, input: any) {
  if (command === 'layer.restore') {
    inputObject(input, ['ref', 'from']);
    if (typeof input.ref !== 'string' || typeof input.from !== 'string' || !/^[A-Za-z0-9_.-]+@[1-9][0-9]*$/.test(input.ref) || !/^[A-Za-z0-9_.-]+@[1-9][0-9]*$/.test(input.from)) fail('INVALID_ARGUMENT', 2, 'Layer restore requires exact numeric current and source revisions.');
  }
  if (command === 'context.show' || command === 'context.use') {
    inputObject(input, command === 'context.show' ? ['workspace'] : ['workspace', 'target', 'expected_generation']);
    if (typeof input.workspace !== 'string' || !/^[a-f0-9]{64}$/.test(input.workspace)) fail('INVALID_ARGUMENT', 2, 'Context requires the exact local workspace fingerprint.');
    if (command === 'context.use' && (typeof input.target !== 'string' || !exact.test(input.target) || !Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0 || input.expected_generation >= Number.MAX_SAFE_INTEGER)) fail('INVALID_ARGUMENT', 2, 'Use an exact target and a nonnegative safe context generation.');
  }
}

export function restorationSource(engine: Engine, input: { ref: string; from: string }, principal: string): Layer {
  recoveryInput('layer.restore', input);
  // Use visibility checks before inspecting any private source content.
  const current = engine.inspect('layer', input.ref, principal) as Layer;
  const source = engine.inspect('layer', input.from, principal) as Layer;
  if (current.owner !== principal || source.owner !== principal) fail('OWNER_FORBIDDEN', 4, 'Only the owner may restore this Layer.');
  if (current.id !== source.id || source.revision >= current.revision) fail('RESTORE_SOURCE_MISMATCH', 2, 'Choose an older revision of the same owned Layer.');
  if (source.baseline !== current.baseline || source.model_version !== current.model_version) fail('MIXED_BASELINE', 5, 'Restore cannot change the Layer baseline or model; author a new Layer explicitly.');
  return parseLayer(source);
}

export function restoreLayer(engine: Engine, input: { ref: string; from: string }, principal: string) {
  const source = restorationSource(engine, input, principal);
  const head = engine.ownerHeads[source.id];
  if (!head || head.owner !== principal || `${source.id}@${head.head}` !== input.ref) fail('STALE_REVISION', 5, 'Restore must name the current owned head.');
  if (!Number.isSafeInteger(head.head + 1)) fail('INVALID_RECORD', 2, 'Layer revision limit reached.');
  const record = { ...structuredClone(source), revision: head.head + 1 };
  const result = engine.layer(record, principal, input.ref);
  return { ...result, recovery: { previous: input.ref, source: input.from, source_fingerprint: digest(source), result: result.ref }, evidence_reused: false, review_required: source.derived_from !== null };
}

export function personalContext(engine: Engine, contexts: ContextMap, command: string, input: any, principal: string) {
  recoveryInput(command, input);
  const key = digest({ principal, workspace: input.workspace });
  const stored = contexts[key];
  if (command === 'context.use') {
    if ((stored?.generation ?? 0) !== input.expected_generation) fail('STALE_CONTEXT', 5, 'Context changed; inspect it before selecting again.', { generation: stored?.generation ?? 0 });
    // Inspector checks exact type/visibility. Navigation may select a blocked candidate.
    const type = engine.records[input.target]?.type;
    if (type !== 'release' && type !== 'composition') fail('REF_NOT_FOUND', 3, 'Context target must be an exact available Release or Composition.');
    const record = engine.inspect(type, input.target, principal);
    const data = type === 'composition' ? engine.read(input.target, 'composition') : record;
    contexts[key] = { generation: input.expected_generation + 1, target: input.target, fingerprint: digest(data) };
  }
  const selected = contexts[key];
  if (!selected) return { state: 'unset', workspace: input.workspace, principal, generation: 0, target: null };
  const type = engine.records[selected.target]?.type;
  if (type !== 'release' && type !== 'composition') fail('REF_NOT_FOUND', 3, 'Selected context target is no longer available.');
  const record = engine.inspect(type, selected.target, principal);
  const data = type === 'composition' ? engine.read(selected.target, 'composition') : record;
  if (digest(data) !== selected.fingerprint) fail('CONTEXT_TARGET_CHANGED', 9, 'Selected immutable target differs from its recorded fingerprint.');
  const evaluation = engine.target(selected.target);
  return { state: 'selected', workspace: input.workspace, principal, generation: selected.generation, target: selected.target, target_type: type, fingerprint: selected.fingerprint, candidate_fingerprint: evaluation.fingerprint, candidate_state: evaluation.state, baseline_ref: type === 'release' ? selected.target : data.baseline, selected_layers: type === 'composition' ? [...data.selected] : [] };
}

export function commitReferences(command: string, input: any, result: { data: any; created: string[] }): string[] {
  if(command==='drift.revalidate')return [input.review.ref,input.basis_evidence.ref,result.data.completion_ref,result.data.run_ref,...result.created.filter(ref=>ref!==result.data.completion_ref&&ref!==result.data.run_ref)];
  if (command === 'layer.restore') return [input.ref, input.from, 'sha256:' + result.data.recovery.source_fingerprint, result.data.ref];
  if (command === 'context.use') return [input.target];
  return result.created.slice(0, 20);
}
