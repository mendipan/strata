import path from 'node:path';
import { readFileSync } from 'node:fs';
import { canonical, digest, fail } from './model.js';
import { DEMO_LIMITS } from './integrated-demo.js';
import { demoApplySequence, isPendingDemoWorkflowStep } from './integrated-demo-workflow-description.js';
import { DEMO_MANAGEMENT_LIMITS, validateDemoManagementTarget, type DemoManagementTarget } from './integrated-demo-management.js';

export const PINNED_CF_VERSION = '1.0.0-beta.12';
export type DemoFullStep = { name: string; type: 'step'; attempt: 1 };
export type DemoSupplementalRead = <T>(step: DemoFullStep, operation: () => Promise<T>) => Promise<T>;
const refused = (): never => fail('DEMO_FULL_STEP_REFUSED', 7, 'Full Workflow step output is unavailable, changed, redacted or inconsistent; preserve evidence without replay.');

export function validateDemoFullStep(step: DemoFullStep) {
  if (!step || canonical(Object.keys(step).sort()) !== canonical(['attempt', 'name', 'type']) || step.type !== 'step' || step.attempt !== 1 ||
      (!/^claim-run(?:-1)?$/.test(step.name) && demoApplySequence(step.name) === undefined)) refused();
}

export function describeDemoFullStepCommand(target: DemoManagementTarget, step: DemoFullStep, projectDirectory: string) {
  validateDemoManagementTarget(target); validateDemoFullStep(step);
  let version: unknown;
  try { version = JSON.parse(readFileSync(path.join(projectDirectory, 'node_modules/cf/package.json'), 'utf8')).version; } catch { /* Refuse below. */ }
  if (version !== PINNED_CF_VERSION) fail('DEMO_CF_VERSION_REFUSED', 7, `Expected installed cf ${PINNED_CF_VERSION}.`);
  return { executable: process.execPath, args: [path.resolve(projectDirectory, 'node_modules/cf/bin/cf'), 'workflows', 'instances', 'step', 'get',
    target.instance_id, '--workflow-name', target.workflow_name, '--name', step.name, '--type', 'step', '--attempt', '1'],
    cwd: path.resolve(projectDirectory), interactive: false, timeout_ms: 30_000,
    max_output_bytes: DEMO_MANAGEMENT_LIMITS.max_response_bytes_per_call };
}

export function parseDemoFullStepResponse(stdout: string): unknown {
  if (Buffer.byteLength(stdout) > DEMO_MANAGEMENT_LIMITS.max_response_bytes_per_call) refused();
  let raw: any;
  try { raw = JSON.parse(stdout); } catch { return refused(); }
  // The documented body is flat; the pinned cf CLI returns the API envelope.
  // Unwrap only the observed successful shape, never an error or mixed body.
  if (raw && typeof raw === 'object' && ['success', 'errors', 'messages', 'result'].some(key => Object.hasOwn(raw, key))) {
    if (canonical(Object.keys(raw).sort()) !== canonical(['errors', 'messages', 'result', 'success']) ||
        raw.success !== true || !Array.isArray(raw.errors) || raw.errors.length !== 0 || !Array.isArray(raw.messages)) refused();
    raw = raw.result;
  }
  // Do not accept a stream preview or a sensitive/redacted value as a checkpoint.
  if (!raw || raw.status !== 'complete' || raw.error !== null || !Object.hasOwn(raw, 'output') ||
      raw.output === null || raw.output === '[REDACTED]' ||
      (typeof raw.output === 'string' && raw.output.endsWith('[truncated output]'))) refused();
  return structuredClone(raw.output);
}

export class DemoFullStepOutputs {
  private readonly completed = new Map<string, { preview: string; output: unknown }>();
  async hydrate(raw: any, target: DemoManagementTarget, read: (step: DemoFullStep) => Promise<unknown>): Promise<any> {
    if (raw?.id !== target.instance_id || !Array.isArray(raw.steps) || raw.steps.length > DEMO_LIMITS.steps) refused();
    const hydrated = structuredClone(raw), seen = new Set<number>();
    let pending = false;
    // Validate the entire provider descriptor set before making a supplemental
    // read, so a duplicate/lookalike cannot cause an unintended request.
    for (const step of hydrated.steps) {
      if (!step || typeof step.name !== 'string') refused();
      const sequence = /^claim-run(?:-1)?$/.test(step?.name) ? 0 : demoApplySequence(step?.name);
      if (sequence === undefined) { if (/^(claim-run|apply-)/.test(step?.name)) refused(); continue; }
      if (pending || seen.has(sequence) || step.type !== 'step') refused();
      seen.add(sequence);
      if (isPendingDemoWorkflowStep(hydrated, step)) { pending = true; continue; }
      if (step.success !== true ||
          (Array.isArray(step.attempts) && (step.attempts.length !== 1 || step.attempts[0]?.success !== true))) refused();
    }
    for (const step of hydrated.steps) {
      const relevant = /^claim-run(?:-1)?$/.test(step?.name) || demoApplySequence(step?.name) !== undefined;
      if (!relevant || typeof step.output !== 'string' || !step.output.endsWith('[truncated output]')) continue;
      const spec: DemoFullStep = { name: step.name, type: 'step', attempt: 1 };
      const key = digest({ target, step: spec }), preview = digest(step.output), cached = this.completed.get(key);
      if (cached && cached.preview !== preview) refused();
      const output = cached ? cached.output : await read(spec);
      // Keep the complete transport value; the shared authoritative decoder
      // still validates the entire checkpoint chain after hydration.
      if (Buffer.byteLength(canonical(output)) > DEMO_LIMITS.checkpoint_bytes * 2) refused();
      if (!cached) this.completed.set(key, { preview, output: structuredClone(output) });
      step.output = structuredClone(output);
    }
    return hydrated;
  }
}
