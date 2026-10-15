import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/core.js';
import { canonical, digest } from '../src/model.js';
import { runFixtureEvidence } from '../src/runner.js';
import { runLinkedCollectionAcceptance, type CollectionReleasePins } from '../src/acceptance/collection-release-linkage.js';
import { prepareCollectionAcceptanceDemo } from './collection-acceptance.js';

/** New synthetic original/provisional exports, then separately measured/approved
 * no-change baseline and descendant change; no real app or broker configuration. */
export async function prepareCollectionReleaseLinkageDemo(root: string) {
  const provisional = await prepareCollectionAcceptanceDemo(root);
  const engine = new Engine({}, {}, { projectId: 'collection-release-linkage-fixture', checkerBackend: 'node' });
  const fixture = async (name: string) => JSON.parse(await readFile(new URL('../../tests/fixtures/collection/' + name + '.json', import.meta.url), 'utf8'));
  const snapshot = await fixture('bootstrap'), recipe = await fixture('composition'), expectations = await fixture('expectations');
  engine.init(snapshot, 'bootstrap');
  async function accept(id: string, baseline: string, selected: string[], changed: boolean) {
    const candidate = engine.compose({ ...recipe, id, baseline, proposals: selected, selected });
    const record = engine.realize(candidate.ref, 'collection-node/1'), registered = engine.registerRealization(record), directory = path.join(root, id);
    await mkdir(directory); for (const [name, body] of Object.entries(record.files)) await writeFile(path.join(directory, name), body, { flag: 'wx' });
    await writeFile(path.join(directory, 'realization.json'), JSON.stringify({ realization_ref: registered.ref, record }), { flag: 'wx' });
    const oracle = { format: expectations.format, snapshot_sha256: digest(candidate.snapshot), expected: structuredClone(changed ? expectations.changed : expectations.baseline), criteria: structuredClone(expectations.criteria).sort((a: unknown, b: unknown) => canonical(a).localeCompare(canonical(b))) };
    const measured = await runFixtureEvidence(directory, record, oracle);
    await writeFile(path.join(root, id + '-fixture-measurement.json'), JSON.stringify(measured, null, 2) + '\n', { flag: 'wx' });
    const validation = engine.validate(candidate.ref, registered.ref, measured.evidence);
    const scope = engine.approve({ kind: 'scope', target: candidate.fingerprint, scope: candidate.scope, evidence_digest: validation.evidence_digest }, 'scope-selector');
    const release = engine.approve({ kind: 'release', target: candidate.fingerprint, scope: null, evidence_digest: validation.evidence_digest }, 'release-manager');
    return engine.release(candidate.ref, validation.ref, [scope.ref, release.ref]).ref;
  }
  const baselineRef = await accept('AcceptedCollectionBaseline', snapshot.id + '@' + snapshot.revision, [], false);
  const layer = await fixture('extend'); layer.baseline = baselineRef;
  const draft = engine.layer(layer, 'author-a'); engine.publish(draft.ref, 'author-a');
  const changedRef = await accept('AcceptedCollectionChange', baselineRef, [draft.ref], true);
  const directories: Record<string, string> = {};
  for (const [lane, target] of [['baseline', baselineRef], ['changed', changedRef]]) {
    const directory = path.join(root, 'accepted-' + lane); await mkdir(directory); directories[lane] = directory;
    const record = engine.realize(target, 'collection-node/1'), registered = engine.registerRealization(record);
    for (const [name, body] of Object.entries(record.files)) await writeFile(path.join(directory, name), body, { flag: 'wx' });
    await writeFile(path.join(directory, 'realization.json'), JSON.stringify({ realization_ref: registered.ref, record }), { flag: 'wx' });
  }
  const pins: CollectionReleasePins = { project_id: engine.options.projectId!, baseline: { ref: baselineRef, sha256: digest(engine.read(baselineRef, 'release')) }, changed: { ref: changedRef, sha256: digest(engine.read(changedRef, 'release')) } };
  await writeFile(path.join(root, 'release-pins.json'), JSON.stringify(pins, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(root, 'historical-semantic-store.json'), JSON.stringify({ format: 'collection-release-linkage-demo-state/1', inactive: true, trust: 'synthetic-local-fixture', records: engine.records, ownerHeads: engine.ownerHeads }, null, 2) + '\n', { flag: 'wx' });
  return { engine, pins, input: { ...provisional, baseline: directories.baseline, changed: directories.changed, output: path.join(root, 'linked-evidence') } };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') { console.log('Local collection Release-linkage demo: demo --output NEW_DIRECTORY\nCreates only synthetic data and ordinary separate fixture validations/approvals. No imported Engine/receipt, hosted authentication, source binding or completion.'); return; }
  if (args.length !== 3 || args[0] !== 'demo' || args[1] !== '--output') throw new Error('Use --help.');
  const { engine, pins, input } = await prepareCollectionReleaseLinkageDemo(path.resolve(args[2]));
  const report = await runLinkedCollectionAcceptance(engine, pins, input);
  console.log(JSON.stringify({ status: report.status, records_verified: report.records_verified, store_unchanged: report.store_unchanged, baseline: pins.baseline.ref, changed: pins.changed.ref, report: path.join(input.output, 'release-linkage.json'), approval: report.approval, reconciliation_complete: report.reconciliation_complete }));
  process.exitCode = report.status === 'passed_declared_scope' ? 0 : report.status === 'incomplete' ? 5 : 6;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
