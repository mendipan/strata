import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { bootstrap, demoLayers, proposal, recipe } from '../src/fixtures.js';
import {fixtureOracle} from '../src/booking-checker.js';
import { runFixtureEvidence } from '../src/runner.js';
import { digest } from '../src/model.js';

export async function demoAt(root: string, brokerUrl: string, runtime: 'node-development-harness' | 'cloudflare-agents') {
const configPath = path.join(root, 'strata.config.json');
const originalConfig = await readFile(configPath, 'utf8');
const directory = path.join(root, '.strata/demo-' + Date.now()); await mkdir(directory, { recursive: true });
const config = { ...JSON.parse(originalConfig), broker: brokerUrl };
// A separate project directory avoids modifying the checked-in project configuration or an active broker's state.
await writeFile(path.join(directory, 'strata.config.json'), JSON.stringify(config, null, 2));
const trace: any[] = [];
async function cli(session: string, args: string[], record?: unknown, expected = 0) {
  const result = await runCli([...args, '--project', directory, '--json', '--non-interactive'], record === undefined ? undefined : JSON.stringify(record), { ...process.env, STRATA_SESSION: session });
  trace.push({ command: result.command, ok: result.ok, exit_code: result.exit_code, ref: result.data?.ref, errors: result.errors });
  if (result.exit_code !== expected) throw new Error(JSON.stringify(result)); return result.data;
}
  await cli('fixture-bootstrap', ['init', '--file', '-'], bootstrap());
  const { a, b, c } = demoLayers();
  for (const [session, layer] of [['fixture-a', a], ['fixture-b', b], ['fixture-c', c]] as const) { const draft = await cli(session, ['layer', 'create', '--file', '-'], layer); await cli(session, ['layer', 'publish', draft.ref]); }
  const blocked = await cli('fixture-preparer', ['compose', '--file', '-'], recipe(), 5);
  const decision = proposal('L-decision', 'scope-selector'); decision.resolution_proposals = [{ input_fingerprint: blocked.input_fingerprint, scope: blocked.scope, impact: blocked.impact, outcome: { kind: 'select', selected: ['L-hold@1', 'L-reminder@1'], rejected: ['L-alternative@1'] } }];
  const draft = await cli('fixture-selector', ['layer', 'create', '--file', '-'], decision); await cli('fixture-selector', ['layer', 'publish', draft.ref]);
  const request = { layer: draft.ref, proposal_index: 0, composition: blocked.ref, approvals: [] };
  const unsigned = await cli('fixture-selector', ['resolve', '--file', '-', '--dry-run'], request);
  const decisionApproval = await cli('fixture-selector', ['approve', '--file', '-'], { kind: 'resolution', target: unsigned.target, scope: unsigned.scope, evidence_digest: null });
  const resolution = await cli('fixture-selector', ['resolve', '--file', '-', '--approval', decisionApproval.ref], request);
  const selected = recipe(); selected.revision = 2; selected.selected = ['L-hold@1', 'L-reminder@1']; selected.resolutions = [resolution.ref];
  const eligible = await cli('fixture-preparer', ['compose', '--file', '-'], selected);
  const output = path.join(directory, '.strata', 'realization');
  const realization = await cli('fixture-preparer', ['mat', eligible.ref, '--profile', 'booking-node/1', '--out', output]);
  const manifest = JSON.parse(await readFile(realization.manifest, 'utf8'));
  const { evidence, observations } = await runFixtureEvidence(output, manifest.record,fixtureOracle(eligible.snapshot));
  const evidenceFile = path.join(directory, 'evidence.json'); await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  const validation = await cli('fixture-runner', ['validate', eligible.ref, '--realization', realization.manifest, '--evidence', evidenceFile]);
  const scopeApproval = await cli('fixture-selector', ['approve', '--file', '-'], { kind: 'scope', target: eligible.fingerprint, scope: eligible.scope, evidence_digest: validation.evidence_digest });
  const releaseApproval = await cli('fixture-release', ['approve', '--file', '-'], { kind: 'release', target: eligible.fingerprint, scope: null, evidence_digest: validation.evidence_digest });
  const args = ['flatten', eligible.ref, '--validation', validation.ref, '--approval', scopeApproval.ref, '--approval', releaseApproval.ref, '--idempotency-key', 'demo-release'];
  const release = await cli('fixture-release', args); const retry = await cli('fixture-release', args);
  const inherited = recipe('C-inherited', release.ref); inherited.proposals = []; inherited.selected = []; inherited.resolutions = []; inherited.alternative_groups = [];
  const next = await cli('fixture-preparer', ['compose', '--file', '-'], inherited);
  if (next.snapshot.blocks['booking.hold'].requirements.expiry.parameters.seconds !== 900 || !next.snapshot.blocks['booking.reminder'].acceptance['layer-reminder']) throw new Error('Inherited Release lost intent or acceptance.');
  const result = { runtime, cloudflare_agents_exercised: runtime === 'cloudflare-agents', trust: 'local-fixture', release: release.ref, retry_same_release: retry.ref === release.ref, inherited_duration: 900, inherited_reminders: true, inherited_layer_acceptance: true, observations, evidence, trace, output, folder: directory };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd(); const broker = await startLocalBroker(path.join(root, '.strata/demo-node-state-' + Date.now()), 0);
  try { const result = await demoAt(root, broker.url, 'node-development-harness'); process.stdout.write(JSON.stringify({ runtime: result.runtime, cloudflare_agents_exercised: result.cloudflare_agents_exercised, release: result.release, retry_same_release: result.retry_same_release, inherited_duration: result.inherited_duration, result_file: path.join(result.folder, 'result.json') }, null, 2) + '\n'); }
  finally { await broker.close(); }
}
