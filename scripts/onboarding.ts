import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import {fixtureOracle} from '../src/booking-checker.js';
import { runFixtureEvidence } from '../src/runner.js';
import { RunBudget } from '../src/budget.js';
import { canonical, bytesDigest } from '../src/model.js';
import { localRuntime, sdkRuntimeDirectory } from './local-runtime.js';

// These are trusted TEST DRIVER identities, never identities selected by an agent.
// The portable packet contains role labels; it supplies no security grant.
const roles: Record<string, string> = {
  reader: 'fixture-reader', bootstrap: 'fixture-bootstrap', 'hold-author': 'fixture-a',
  'reminder-author': 'fixture-b', 'alternative-author': 'fixture-c', preparer: 'fixture-preparer',
  'evidence-producer': 'fixture-runner', 'scope-operator': 'fixture-selector', 'release-operator': 'fixture-release'
};
const sequence = [
  'version', 'help', 'config', 'status', 'bootstrap', 'hold-draft', 'hold-publish', 'alternative-draft',
  'alternative-publish', 'baseline-read', 'block-read', 'peer-read', 'reminder-draft', 'reminder-publish',
  'peer-write-refusal', 'peer-integrity', 'blocked-compose', 'conflicts', 'blocked-read', 'decision-draft',
  'decision-publish', 'unsigned-decision', 'decision-endorsement', 'seal-decision', 'eligible-compose',
  'materialize', 'execute-fixture', 'validate', 'scope-endorsement', 'release-endorsement',
  'missing-endorsements', 'release', 'release-retry', 'release-read', 'inherit'
];
type Step = { id: string; kind: string; role: string; operator_only: boolean; argv?: string[]; stdin?: any; expected_exit?: number; captures?: Record<string, string> };
type Runtime = 'node-development-harness' | 'local-workerd-cloudflare-agents-sdk';

export async function onboardingAt(root: string, brokerUrl: string, runtime: Runtime) {
  const packetBytes = await readFile(path.join(root, 'examples/agent-session.json'), 'utf8');
  const packet = JSON.parse(packetBytes);
  const steps: Step[] = packet.steps;
  // A bounded, fixed demonstration, not an interpreter for arbitrary workflows.
  assert.deepEqual(steps.map(s => s.id), sequence);
  assert.equal(packet.manifest.session.trust_mode, 'local_fixture');
  const directory = path.join(root, '.strata/onboarding-' + Date.now()); await mkdir(directory, { recursive: true });
  const config = { ...JSON.parse(await readFile(path.join(root, 'strata.config.json'), 'utf8')), broker: brokerUrl };
  await writeFile(path.join(directory, 'strata.config.json'), JSON.stringify(config, null, 2));
  const budget = new RunBudget({ operations: 50, attempts: 50, bytes: 4 * 1024 * 1024, input_tokens: 0, output_tokens: 0, duration_ms: 600000 });
  const outputs: Record<string, any> = {}, captured: Record<string, any> = {}, trace: any[] = [];
  let runner: Awaited<ReturnType<typeof runFixtureEvidence>> | undefined;
  for (const step of steps) {
    budget.check(); assert.ok(Object.hasOwn(roles, step.role));
    if (step.id === 'execute-fixture') {
      assert.equal(step.kind, 'host-runner'); assert.equal(step.role, 'evidence-producer'); assert.equal(step.operator_only, true);
      const manifest = JSON.parse(await readFile(captured.manifest, 'utf8'));
      runner = await budget.bounded(() => runFixtureEvidence(path.dirname(captured.manifest), manifest.record,fixtureOracle(Object.values(outputs).map((o:any)=>o?.data ?? o).find((o:any)=>o?.ref===manifest.record.target && o.snapshot).snapshot)));
      captured.evidence = path.join(directory, 'evidence.json');
      await writeFile(captured.evidence, JSON.stringify(runner.evidence, null, 2));
      trace.push({ id: step.id, role: step.role, operator_only: true, component: 'measured-generated-booking-module', evidence: runner.evidence, observations: runner.observations });
      continue;
    }
    assert.equal(step.kind, 'cli'); assert.ok(step.argv);
    const tokens: Record<string, string> = {
      '$BLOCKED': captured.blocked, '$CANDIDATE': captured.candidate, '$MANIFEST': captured.manifest,
      '$EVIDENCE': captured.evidence, '$VALIDATION': captured.validation, '$SCOPE_APPROVAL': captured.scope_approval,
      '$RELEASE_APPROVAL': captured.release_approval, '$RELEASE': captured.release
    };
    const args = step.argv!.map(a => { if (!a.startsWith('$')) return a; assert.ok(tokens[a], 'Missing captured binding ' + a); return tokens[a]; });
    const input = step.stdin === undefined ? undefined : structuredClone(step.stdin);
    // The exact fixed bindings listed in the example are applied explicitly.
    switch (step.id) {
      case 'decision-draft': Object.assign(input.resolution_proposals[0], { input_fingerprint: outputs['blocked-compose'].input_fingerprint, scope: outputs['blocked-compose'].scope, impact: outputs['blocked-compose'].impact }); break;
      case 'decision-endorsement': Object.assign(input, { target: outputs['unsigned-decision'].target, scope: outputs['unsigned-decision'].scope }); break;
      case 'seal-decision': input.composition = captured.blocked; input.approvals = [captured.decision_approval]; break;
      case 'eligible-compose': input.resolutions = [captured.resolution]; break;
      case 'scope-endorsement': Object.assign(input, { target: captured.candidate_fingerprint, scope: captured.candidate_scope, evidence_digest: captured.evidence_digest }); break;
      case 'release-endorsement': Object.assign(input, { target: captured.candidate_fingerprint, evidence_digest: captured.evidence_digest }); break;
      case 'inherit': input.baseline = captured.release; break;
    }
    const argv = [...args, '--project', directory, '--json', '--non-interactive', '--offline'];
    const stdin = input === undefined ? undefined : JSON.stringify(input);
    budget.reserve({ operations: 1, attempts: 1, bytes: Buffer.byteLength(JSON.stringify(argv)) + Buffer.byteLength(stdin ?? '') });
    const envelope = await budget.bounded(() => runCli(argv, stdin, { ...process.env, STRATA_SESSION: roles[step.role] }));
    budget.reserve({ bytes: Buffer.byteLength(JSON.stringify(envelope)) });
    trace.push({ id: step.id, role: step.role, operator_only: step.operator_only, argv, ...(input === undefined ? {} : { stdin: input }), envelope });
    assert.equal(envelope.protocol_version, '1'); assert.equal(envelope.exit_code, step.expected_exit, step.id + ': ' + JSON.stringify(envelope.errors));
    outputs[step.id] = envelope.data;
    for (const [name, location] of Object.entries(step.captures ?? {})) {
      let value: any = envelope; for (const segment of location.split('.')) value = value?.[segment];
      assert.notEqual(value, undefined, step.id + ' capture ' + name); captured[name] = value;
    }
  }
  assert.ok(runner); assert.deepEqual(outputs['peer-read'], outputs['peer-integrity']);
  assert.ok(outputs['blocked-compose'].diagnostics.some((d: any) => d.code === 'ITEM_COLLISION'));
  assert.deepEqual(outputs['blocked-read'].proposals, ['L-alternative@1', 'L-hold@1', 'L-reminder@1']);
  assert.equal(outputs['unsigned-decision'].execution_ready, false);
  assert.equal(outputs['missing-endorsements'].execution_ready, false);
  assert.equal(outputs['release-retry'].ref, captured.release);
  assert.ok(outputs['status'].security_context.allowed_operations.includes('layer.create'));
  assert.ok(!outputs['status'].security_context.allowed_operations.includes('approve'));
  assert.equal(outputs['validate'].evidence_producer.principal_id, 'fixture-runner');
  const snapshot = outputs.inherit.snapshot;
  assert.equal(snapshot.blocks['booking.hold'].requirements.expiry.parameters.seconds, 900);
  assert.equal(snapshot.blocks['booking.reminder'].requirements.timing.parameters.enabled, true);
  assert.ok(snapshot.blocks['booking.reminder'].acceptance['layer-reminder']);
  assert.equal(runner.observations.competing_hold.accepted, false);
  assert.equal(runner.observations.before_reminder.reminders.length, 0);
  assert.equal(runner.observations.reminder.reminders[0].at, 840);
  assert.equal(runner.observations.repeat_tick.reminders.length, 1);
  assert.equal(Object.keys(runner.observations.before_expiry.holds).length, 1);
  assert.equal(Object.keys(runner.observations.expired.holds).length, 0);
  assert.equal(runner.observations.next_hold.accepted, true);
  const negatives: any[] = [];
  async function direct(id: string, role: string, body: any, expectedCode: string | null, project = config.project_id) {
    const bytes = JSON.stringify(body); budget.reserve({ operations: 1, attempts: 1, bytes: Buffer.byteLength(bytes) });
    const response = await budget.bounded(() => fetch(brokerUrl + '/v1/operation', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'x-strata-session': roles[role] ?? 'unknown-local-selector', 'x-strata-project': project }, body: bytes }));
    const result = await response.json() as any; budget.reserve({ bytes: Buffer.byteLength(JSON.stringify(result)) });
    if (expectedCode === null) assert.equal(result.ok, true, id); else assert.equal(result.error?.code, expectedCode, id);
    negatives.push({ id, role, expected_code: expectedCode, result }); return result;
  }
  const own = structuredClone(steps.find(s => s.id === 'reminder-draft')!.stdin); own.id = 'L-dry-onboarding';
  await direct('reader-write', 'reader', { command: 'layer.create', input: { record: own } }, 'OPERATION_FORBIDDEN');
  await direct('reader-dry-write', 'reader', { command: 'layer.create', input: { record: own }, options: { dry_run: true } }, 'OPERATION_FORBIDDEN');
  await direct('author-evidence-label-copy', 'reminder-author', { command: 'validate', input: { target: captured.candidate, realization: {}, evidence: runner.evidence } }, 'OPERATION_FORBIDDEN');
  await direct('cross-project-read', 'reader', { command: 'inspect', input: { type: 'release', ref: captured.release } }, 'PROJECT_FORBIDDEN', 'other-project');
  await direct('unknown-identity', 'unknown', { command: 'status', input: {} }, 'AUTHENTICATION_REQUIRED');
  await direct('client-fault-role', 'release-operator', { command: 'release', input: { target: captured.candidate, validation: captured.validation, approvals: [captured.scope_approval, captured.release_approval] }, options: { fault: 'after-stage' } }, 'OWNER_FORBIDDEN');
  await direct('unknown-envelope-field', 'reader', { command: 'status', input: {}, principal: 'release-manager' }, 'INVALID_ARGUMENT');
  const dry = await direct('authorized-dry-layer', 'reminder-author', { command: 'layer.create', input: { record: own }, options: { dry_run: true } }, null);
  assert.equal(dry.dry_run, true); assert.deepEqual(dry.created, []); assert.deepEqual(dry.trace ?? [], []);
  await direct('dry-layer-not-published-or-stored', 'reminder-author', { command: 'inspect', input: { type: 'layer', ref: 'L-dry-onboarding@1' } }, 'REF_NOT_FOUND');
  const result = {
    status: 'passed', runtime, scripted_cli_calls: trace.filter(t => t.envelope).length, host_runner_calls: 1,
    model_calls: 0, cloud_calls: 0, credential_creation: 0, fresh_model_acceptance: 'pending-separate-authorization',
    example_sha256: bytesDigest(packetBytes), release: captured.release,
    assertions: { peer_write_denied_exit: 4, peer_unchanged: true, complete_considered_set: true, unsigned_operator_handoff: true, missing_approvals_not_ready: true, exact_producer_fixture_import: true, release_retry_same_ref: true, inherited_duration: 900, inherited_reminder: true, inherited_layer_acceptance: true },
    substitutions: { operators: 'trusted scripted fixture driver; no real user approval', identity: 'public local-only fixture selectors; no production identity', reviews: 'fixture attestations; no independent review', storage: 'persistent local fake Artifacts', model: 'none; deterministic replay cannot demonstrate fresh-agent comprehension' },
    observations: runner.observations, evidence: runner.evidence, trace, direct_api_checks: negatives, budget: budget.snapshot()
  };
  // Evidence includes complete actual requests/envelopes with machine paths/session selectors removed.
  const sanitize = (key: string, value: any) => {
    if (key === 'grant_id') return 'local-fixture-grant';
    if (typeof value === 'string') return value.replaceAll(directory, '$PROJECT_ROOT').replaceAll(brokerUrl, '$LOOPBACK_BROKER');
    return value;
  };
  const safe = JSON.parse(JSON.stringify(result, sanitize));
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(safe, null, 2) + '\n');
  return { ...safe, folder: directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd(); const sdk = process.argv.includes('--agents');
  assert.ok(process.argv.slice(2).every(a => a === '--agents'), 'Only --agents is supported.');
  const state = sdk ? await sdkRuntimeDirectory() : path.join(root, '.strata/onboarding-runtime-' + Date.now());
  const broker = sdk ? await localRuntime(root, state) : await startLocalBroker(state, 0);
  try {
    const result = await onboardingAt(root, broker.url, sdk ? 'local-workerd-cloudflare-agents-sdk' : 'node-development-harness');
    process.stdout.write(JSON.stringify({ status: result.status, runtime: result.runtime, cli_calls: result.scripted_cli_calls, model_calls: 0, cloud_calls: 0, release: result.release, result_file: path.join(result.folder, 'result.json'), runtime_directory: state }, null, 2) + '\n');
  } catch (error) {
    // Preserve failure status while allowing the local child and its I/O to close
    // before Node exits, rather than throwing from the top-level await.
    console.error(error);
    console.error(JSON.stringify({ status: 'failed', runtime_directory: state }));
    process.exitCode = 1;
  } finally { await broker.close(); }
}
