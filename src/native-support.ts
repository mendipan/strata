import { MODEL } from './model.js';
import type { SecurityContext } from './security.js';

// Trusted runtime metadata only. Never accepts roots, proof flags or operation inputs.
export type NativeBackend = { repositories: number; enabled_checkers: readonly string[]; revalidation_configured?:boolean };
const operations = ['source.capture', 'source.bind', 'adoption.prepare', 'adoption.review',
  'git.plan', 'git.stage', 'git.check', 'git.evidence', 'git.review', 'git.apply', 'git.finalize',
  'git.transaction.inspect', 'git.transaction.recover', 'drift.check', 'drift.propose', 'drift.review','drift.revalidate'] as const;
const modelNeutral = new Set<string>(['source.capture', 'git.transaction.inspect', 'git.transaction.recover']);
const historical = new Set<string>(['drift.check', 'drift.propose', 'drift.review']);
type Blocker = { code: string; exit: number; message: string };

/** Configuration support, not preflight or authority. No filesystem, checker or journal access. */
export function describeNativeSupport(model: string, context?: SecurityContext, backend?: NativeBackend) {
  const local = context?.trust_mode === 'local_fixture';
  const sourceBlocker: Blocker | null = !local
    ? { code: 'UNSUPPORTED_SOURCE_BACKEND', exit: 8, message: 'Native repository authority is unavailable for this trust mode.' }
    : !backend
    ? { code: 'UNSUPPORTED_SOURCE_BACKEND', exit: 8, message: 'No trusted Node source backend is configured.' }
    : !backend.repositories
    ? { code: 'REPOSITORY_FORBIDDEN', exit: 4, message: 'No application repository is configured on this Node host.' }
    : null;
  const rows = operations.map(operation => {
    const modelBlocker: Blocker | null = !modelNeutral.has(operation) && model !== MODEL
      ? { code: 'UNSUPPORTED_MODEL_VERSION', exit: 8, message: 'Native intent association and delivery require v0.1 intent records.' } : null;
    const completionBlocker:Blocker|null=operation==='drift.revalidate' ? !backend?.revalidation_configured||context?.trust_mode!=='host_authenticated'
      ? {code:'REVALIDATION_AUTHORITY_REQUIRED',exit:4,message:'Explicit named policy /3 revalidation authority is required.'}
      : !backend.repositories||!backend.enabled_checkers.length ? {code:'REVALIDATION_UNSUPPORTED',exit:8,message:'A trusted local repository and producer are required.'}:null:null;
    const blocker = modelBlocker ?? (operation==='drift.revalidate'?completionBlocker:historical.has(operation) && local ? null : sourceBlocker)
      ?? (operation === 'git.check' && !backend?.enabled_checkers.length
        ? { code: 'UNSUPPORTED_CHECKER', exit: 8, message: 'No compiled application checker is enabled on this Node host.' } : null);
    const localSource = (operation === 'drift.check' || operation === 'drift.review')
      ? { supported: !modelBlocker && !sourceBlocker, unsupported_reason: modelBlocker ?? sourceBlocker } : null;
    return { operation, supported: !blocker, authorized: context?.allowed_operations.includes(operation) ?? false,
      supported_models: modelNeutral.has(operation) ? null : [MODEL], unsupported_reason: blocker,
      // Historical imported reports/proposals/dispositions do not imply a fresh local observation.
      ...(localSource ? { local_source: localSource } : {}),
      execution_ready: false as const };
  });
  return { format: 'strata-native-support/1', model_version: model, trust_mode: context?.trust_mode ?? null, adapter_present: !!backend,
    configured_repositories: backend?.repositories ?? 0, enabled_checkers: [...(backend?.enabled_checkers ?? [])],
    operations: rows, execution_ready: false as const,
    not_checked: ['repository/path/checker grants', 'exact intent and record closure', 'source freshness', 'evidence and approval', 'transaction state'],
    limitations: ['Configuration support is not authorization or exact-operation preflight.',
      'Drift supports imported observations and historical planning; local_source describes fresh measurement or plan approval. Approved plans are not reconciliation completion.'] };
}

export function nativeOperationSupport(report: ReturnType<typeof describeNativeSupport>, operation: string) {
  const row = report.operations.find(r => r.operation === operation);
  if (row) return row;
  if (/^(source|git|drift|adoption)\./.test(operation)) return { supported: false,
    unsupported_reason: { code: 'UNSUPPORTED_CAPABILITY', exit: 8, message: 'Unknown native operation.' }, execution_ready: false as const };
  return null;
}

export function nativeCapabilityFlags(report: ReturnType<typeof describeNativeSupport>) {
  const supported = (operation: string) => report.operations.find(r => r.operation === operation)!.supported;
  return { 'git-patch/1': supported('git.plan'), 'source-binding/1': supported('source.bind'),
    'source-drift/1': report.operations.find(r => r.operation === 'drift.check')!.local_source!.supported,
    'adoption/1': supported('adoption.prepare'), 'revalidation/1':supported('drift.revalidate'),
    adoption_selected_git_bridge_v1: supported('adoption.prepare') && report.enabled_checkers.includes('counter-application/1') };
}
