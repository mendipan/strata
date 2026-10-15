import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Engine, snapshotFromRelease } from '../core.js';
import { bytesDigest, canonical, digest, fail, MODEL, parse } from '../model.js';
import { verifyOutput } from '../commands/node.js';
import { noLinks } from '../node-state.js';
import { runCollectionAcceptance, type CollectionAcceptanceInput } from './collection.js';

const releasePin = z.object({ ref: z.string().regex(/^release@[a-f0-9]{24}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const collectionReleasePinsSchema = z.object({ project_id: z.string().min(1).max(120), baseline: releasePin, changed: releasePin }).strict();
export type CollectionReleasePins = z.infer<typeof collectionReleasePinsSchema>;

// Compiled local Node caller dependency, never a serialized Engine/record archive.
// Ordinary Core checks run on a disposable copy; the supplied live store is read only.
export function verifyCollectionReleaseLinkage(engine: Engine, input: CollectionReleasePins) {
  if (!(engine instanceof Engine)) fail('UNSUPPORTED_ACCEPTANCE_LINKAGE', 8, 'A compiled local Engine dependency is required; serialized stores are not accepted.');
  const pins = parse(collectionReleasePinsSchema, input);
  if (engine.options.projectId !== pins.project_id) fail('PROJECT_FORBIDDEN', 4, 'Linkage needs the exact local Engine project.');
  if (engine.options.checkerBackend !== 'node' || engine.options.historical || engine.modelVersion() !== MODEL) fail('UNSUPPORTED_ACCEPTANCE_LINKAGE', 8, 'Only an active local v0.1 Node fixture Engine supports this linkage.');
  const replay = new Engine(structuredClone(engine.records), structuredClone(engine.ownerHeads), { ...engine.options });
  function checked(pin: z.infer<typeof releasePin>, count: 3 | 5) {
    const release = engine.read(pin.ref, 'release');
    if (digest(release) !== pin.sha256 || pin.ref !== 'release@' + pin.sha256.slice(0, 24)) fail('STALE_INTENT', 5, 'Release ref and full digest must bind the exact retained record.');
    if (release.model_version !== MODEL || release.state !== 'validated' || release.trust !== 'local-fixture' || !release.validation || !Array.isArray(release.approvals)) fail('ACCEPTED_RELEASE_REQUIRED', 6, 'Bootstrap, draft and unvalidated records are not accepted Releases.');
    const validation = engine.read(release.validation, 'validation');
    if (release.validation !== 'validation@' + digest(validation).slice(0, 24)) fail('STALE_EVIDENCE', 6, 'Release validation must retain its exact content-addressed closure.');
    if (canonical(replay.checkValidation(validation.target, validation.realization, validation.evidence)) !== canonical(validation)) fail('STALE_EVIDENCE', 6, 'Retained validation metadata differs from ordinary Core checking.');
    const acceptedRealization = engine.read(validation.realization, 'realization');
    if (validation.realization !== 'realization@' + digest(acceptedRealization).slice(0, 24)) fail('STALE_REALIZATION', 6, 'Accepted realization reference is not its registered content identity.');
    for (const ref of release.approvals) {
      const { ref: storedRef, ...body } = engine.read(ref, 'approval');
      if (storedRef !== ref || ref !== 'approval@' + digest(body).slice(0, 24)) fail('STALE_APPROVAL', 6, 'Approval reference differs from its ordinary retained identity.');
    }
    // Reuse the actual Release/validation/approval/obligation gates without writing
    // the caller's store or changing their meaning. No fixture result is invented.
    const regenerated = replay.release(validation.target, release.validation, release.approvals);
    if (regenerated.ref !== pin.ref || canonical(replay.read(regenerated.ref, 'release')) !== canonical(release)) fail('STALE_INTENT', 5, 'Ordinary Core replay does not produce this exact retained Release.');
    const realized = engine.realize(pin.ref, 'collection-node/1');
    if (canonical(realized.oracle?.expected) !== canonical({ max_items: count, max_title_length: 20 })) fail('UNSUPPORTED_ACCEPTANCE_LINKAGE', 8, 'Only accepted collection baseline 3/20 and changed 5/20 are supported.');
    const composition = engine.read(validation.target, 'composition');
    if (validation.target !== `${composition.id}@${composition.revision}` || composition.selected.some((ref: string) => { const layer = engine.read(ref, 'layer'); return ref !== `${layer.id}@${layer.revision}`; })) fail('STALE_INTENT', 5, 'Composition and selected Layer identities must match their exact refs.');
    return { release_ref: pin.ref, release_sha256: pin.sha256, snapshot_sha256: digest(snapshotFromRelease(release)), candidate: release.candidate,
      baseline_ref: release.baseline, composition_ref: validation.target, composition_sha256: digest(composition), validation_ref: release.validation, validation_sha256: digest(validation), evidence_sha256: validation.evidence_digest,
      accepted_realization_ref: validation.realization, accepted_realization_sha256: digest(acceptedRealization),
      approvals: release.approvals.map((ref: string) => ({ ref, sha256: digest(engine.read(ref, 'approval')) })),
      selected_layers: composition.selected.map((ref: string) => ({ ref, sha256: digest(engine.read(ref, 'layer')) })),
      rematerialization: realized };
  }
  const baseline = checked(pins.baseline, 3), changed = checked(pins.changed, 5);
  if (changed.baseline_ref !== baseline.release_ref) fail('MIXED_BASELINE', 5, 'Changed Release must directly descend from the exact accepted baseline Release.');
  return { project_id: pins.project_id, baseline, changed };
}

async function checkedManifest(engine: Engine, directory: string, expected: ReturnType<typeof verifyCollectionReleaseLinkage>['baseline']) {
  const manifestFile = await noLinks(path.join(path.resolve(directory), 'realization.json'));
  const stat = await lstat(manifestFile);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) fail('UNSUPPORTED_ACCEPTANCE_LINKAGE', 8, 'Linkage manifest must be a bounded ordinary file.');
  const manifestBytes = await readFile(manifestFile), manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  const stored = engine.read(manifest.realization_ref, 'realization');
  if (manifest.realization_ref !== 'realization@' + digest(stored).slice(0, 24) || canonical(manifest.record) !== canonical(stored) || canonical(stored) !== canonical(expected.rematerialization)) fail('STALE_REALIZATION', 6, 'Measured output needs the exact registered independent rematerialization of this accepted Release.');
  const verified = await verifyOutput(path.resolve(directory), manifestFile);
  if (canonical(verified) !== canonical(manifest) || bytesDigest(await readFile(manifestFile)) !== bytesDigest(manifestBytes)) fail('STALE_REALIZATION', 6, 'Manifest changed while its files were measured.');
  const measurement = { target: stored.target, candidate: stored.candidate, profile: stored.profile, output_tree: stored.output_tree, oracle_sha256: stored.oracle_sha256,
    manifest_sha256: bytesDigest(manifestBytes), files: Object.fromEntries(Object.entries(stored.files).map(([name, body]) => [name, { sha256: bytesDigest(Buffer.from(body, 'utf8')), byte_length: Buffer.byteLength(body, 'utf8') }])) };
  return { ref: manifest.realization_ref, sha256: digest(stored), measurement };
}

/** Fresh local observations plus read-only semantic linkage. No imported receipt,
 * broker operation, acceptance record, authority, Release or completion is created. */
export async function runLinkedCollectionAcceptance(engine: Engine, pins: CollectionReleasePins, input: CollectionAcceptanceInput) {
  const requestPins = parse(collectionReleasePinsSchema, pins), request = structuredClone(input);
  for (const key of ['original', 'baseline', 'changed', 'output'] as const) request[key] = path.resolve(request[key]);
  const storePin = () => digest({ records: engine.records, ownerHeads: engine.ownerHeads, project: engine.options.projectId, backend: engine.options.checkerBackend, historical: engine.options.historical ?? false });
  const before = storePin(), linkage = verifyCollectionReleaseLinkage(engine, requestPins);
  const exports = { baseline: await checkedManifest(engine, request.baseline, linkage.baseline), changed: await checkedManifest(engine, request.changed, linkage.changed) };
  const measured = await runCollectionAcceptance(request);
  const report: any = { format: 'collection-release-linkage/1', status: measured.status, trust: 'local-fixture-records-and-observations', execution_authenticated: false, acceptance_elevated: false, approval: false, release_created: false, reconciliation_complete: false, equivalence: 'not-established',
    project_id: linkage.project_id, original_source: measured.inputs?.original ?? null, original_source_intent_association: 'not-established', adoption_publication_linkage: 'not-established',
    comparison_sha256: digest(measured), comparison_status: measured.status, records_verified: false, store_unchanged: false, exports, semantic_baseline: null, semantic_change: null, failure: null };
  try {
    // Endpoint checks alone cannot detect a manifest altered for the comparison
    // and then restored. Bind what the harness actually measured to verified exports.
    for (const lane of ['baseline', 'changed'] as const) if (canonical(measured.inputs?.[lane] ?? null) !== canonical(exports[lane].measurement)) fail('STALE_REALIZATION', 6, `Measured ${lane} input pins differ from the verified registered Release export.`);
    const current = verifyCollectionReleaseLinkage(engine, requestPins);
    const currentExports = { baseline: await checkedManifest(engine, request.baseline, current.baseline), changed: await checkedManifest(engine, request.changed, current.changed) };
    if (storePin() !== before || canonical(current) !== canonical(linkage) || canonical(currentExports) !== canonical(exports)) fail('STALE_INTENT', 5, 'The local semantic store or registered exports changed during comparison.');
    const summarize = ({ rematerialization, ...closure }: typeof linkage.baseline) => ({ ...closure, output_tree: rematerialization.output_tree, profile: rematerialization.profile, oracle_sha256: rematerialization.oracle_sha256 });
    report.semantic_baseline = summarize(current.baseline); report.semantic_change = summarize(current.changed);
    report.records_verified = true; report.store_unchanged = true;
  } catch (error) { report.status = 'refused'; report.failure = { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'LINKAGE_REFUSED', message: error instanceof Error ? error.message : String(error) }; }
  report.limitations = ['Trusted in-process active local Node Engine dependency; no serialized state/receipt input or authenticated hosted provenance.', 'Core replay checks existing Releases on a disposable copy; no new approval, Release or application acceptance is created.', 'Only the finite collection original/baseline/delta vectors are measured; unknown/uncovered scope stays incomplete.', 'Original Git source association, adoption-to-delivery bridge and reconciliation completion remain unestablished.'];
  await writeFile(path.join(request.output, 'release-linkage.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}
