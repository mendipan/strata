import path from 'node:path';
import { canonical, fail } from './model.js';

export type DemoLabTarget = { account_id: string; worker_name: string; workflow_name: string; namespace_id: string };

// Trusted host binding; no account or retained-resource default.
export function parseDemoLabTarget(value: unknown): DemoLabTarget {
  const v = value as DemoLabTarget;
  if (!v || typeof v !== 'object' || canonical(Object.keys(v).sort()) !== canonical(['account_id', 'namespace_id', 'worker_name', 'workflow_name']) ||
    !/^[a-f0-9]{32}$/.test(v.account_id) || ![v.worker_name, v.workflow_name, v.namespace_id].every(s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(s)))
    fail('DEMO_LAB_IDENTITY_REFUSED', 7, 'Configure the exact account, Worker, Workflow and namespace in the host lab profile.');
  return { ...v };
}

export function demoLabWorkerConfig(root: string, sourceSha256: string, target: DemoLabTarget) {
  const DEMO_LAB = parseDemoLabTarget(target);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('A complete reviewed source digest is required.');
  return { name: DEMO_LAB.worker_name, main: path.resolve(root, 'src/demo-lab-worker.ts'), account_id: DEMO_LAB.account_id,
    compatibility_date: '2026-10-03', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
    send_metrics: false, observability: { enabled: false }, limits: { cpu_ms: 1000, subrequests: 100 },
    version_metadata: { binding: 'STRATA_LAB_VERSION' },
    vars: { STRATA_LAB_SOURCE_SHA256: sourceSha256, STRATA_LAB_TARGET: JSON.stringify(DEMO_LAB) },
    artifacts: [{ binding: 'ARTIFACTS', namespace: DEMO_LAB.namespace_id }],
    workflows: [{ binding: 'STRATA_DEMO_WORKFLOW', name: DEMO_LAB.workflow_name, class_name: 'StrataIntegratedDemoWorkflow',
      limits: { steps: 128 }, concurrency: { limit: 1 }, default_retention: { success_retention: 3600000, error_retention: 3600000 } }] };
}
