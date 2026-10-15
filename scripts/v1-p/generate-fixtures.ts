import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Engine, obligations, snapshotFromRelease } from '../../src/core.js';
import { MODEL, bytesDigest, canonical, digest, normalizeSnapshot } from '../../src/model.js';
import { FixtureIssuer } from '../../src/security.js';
import { createSourceHostProof, executeSourceBinding, type SourceSnapshot } from '../../src/source-binding.js';
import { createGitPlan, createGitReview, gitStore, registerGitAcceptance, verifyGitAdoptionHistory } from '../../src/git-adoption.js';
import { verifySourceBindingHistory } from '../../src/source-binding.js';
import { applicationCheckerPins, APPLICATION_CHECKER } from '../../src/git-application-checker.js';
import { V1_P_FORMAT, inspectNativeGitHistory, nativeGitHistoryContractSchema, type NativeGitHistoryContract } from '../../src/v1-p/native-git-contract.js';

/** Deterministic structural fixtures only. No Git process, app execution, broker,
 * identity store, source mutation or owner commit occurs. OIDs and pass results
 * below are synthetic assertions and never native qualification evidence. */
export function buildLegacyHistory(root = process.cwd(), objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const fixture = (name: string) => JSON.parse(readFileSync(path.join(root, 'tests/fixtures/counter', name + '.json'), 'utf8'));
  const project = 'v1-p-synthetic-history', repo = 'v1-p-synthetic-repo';
  const engine = new Engine({}, {}, { projectId: project });
  const baseline = normalizeSnapshot(fixture('bootstrap'));
  engine.init(baseline, 'bootstrap');
  const before = engine.realize('CounterBaseline@1', 'counter-fixture/1').files['counter.mjs'];
  const layer = fixture('extend'); engine.layer(layer, 'author-a'); engine.publish('CounterExtension@1', 'author-a');
  const candidate = engine.compose(fixture('composition'));
  const realization = engine.realize(candidate.ref, 'counter-fixture/1');
  const registered = engine.registerRealization(realization);
  const results = Object.values(candidate.snapshot.blocks.counter.acceptance).map(c => ({
    check: c.check, version: c.version, fixture: c.fixture, method: c.method,
    passed: true, reviewer: c.method === 'review' ? 'fixture-reviewer' : null
  }));
  const validation = engine.validate(candidate.ref, registered.ref, {
    format: 'strata-fixture-evidence/2', checker_sha256: realization.checker_sha256,
    fixture_sha256: realization.fixture_sha256, oracle_sha256: realization.oracle_sha256,
    candidate: candidate.fingerprint, profile: realization.profile, output_tree: realization.output_tree,
    executor: 'strata-local-fixture-runner/1', results
  });
  const approvals = [
    engine.approve({ kind: 'scope', target: candidate.fingerprint, scope: 'counter', evidence_digest: validation.evidence_digest }, 'scope-selector').ref,
    engine.approve({ kind: 'release', target: candidate.fingerprint, scope: null, evidence_digest: validation.evidence_digest }, 'release-manager').ref
  ];
  const released = engine.release(candidate.ref, validation.ref, approvals);
  const selectorHandle = 'v1-p-synthetic-selector', preparerHandle = 'v1-p-synthetic-preparer', producerHandle = 'v1-p-synthetic-producer';
  const operations = ['source.capture', 'source.bind', 'git.plan', 'git.evidence', 'git.review'];
  const assignment = { operations, repositories: [repo], git_paths: ['counter.mjs'], git_checkers: [APPLICATION_CHECKER] };
  const issuer = new FixtureIssuer({ project_id: project, assignments: {
    [selectorHandle]: { ...assignment, principal: 'scope-selector', approvals: ['scope'] },
    [preparerHandle]: { ...assignment, principal: 'preparer' },
    [producerHandle]: { ...assignment, principal: 'fixture-runner', executor: 'strata-local-fixture-runner/1', reviewers: ['fixture-reviewer'] }
  } });
  const selector = issuer.resolve(selectorHandle), preparer = issuer.resolve(preparerHandle), producer = issuer.resolve(producerHandle);
  const selected = obligations(baseline);
  const scope = {
    format: 'source-scope/1' as const, coverage: 'selected-scope' as const,
    paths: ['counter.mjs'], watch_roots: [], exclusions: [], items: selected.map(o => o.item).sort(),
    mapping: selected.map(o => ({ item: o.item, paths: ['counter.mjs'], criteria: [...o.criteria].sort() })).sort((a, b) => a.item.localeCompare(b.item)),
    limitations: ['Synthetic selected counter scope only.']
  };
  const oid = (letter: string) => letter.repeat(objectFormat === 'sha1' ? 40 : 64);
  const entry = (content: string) => ({ path: 'counter.mjs', presence: 'present' as const, kind: 'regular' as const,
    mode: '100644' as const, byte_length: Buffer.byteLength(content), sha256: bytesDigest(content) });
  const source: SourceSnapshot = {
    format: 'source-snapshot/1', project_id: project, repo_id: repo, object_format: objectFormat,
    head_commit: oid('a'), head_tree: oid('b'), scope, scope_sha256: digest(scope), entries: [entry(before)], manifest_sha256: digest([entry(before)])
  };
  const proof = (s: SourceSnapshot) => createSourceHostProof(s, {
    format: 'git-observation/1', project_id: project, repo_id: repo, object_format: objectFormat,
    head_commit: s.head_commit, head_tree: s.head_tree, index_sha256: digest('synthetic-index'),
    scope_sha256: s.scope_sha256, entries: structuredClone(s.entries), manifest_sha256: s.manifest_sha256,
    status: [], outside_scope_dirty: false, ignored_count: 0, excluded_count: 0, unsupported: [], coherence: 'stable', trust: 'local-measurement'
  });
  const captured = executeSourceBinding(engine, 'source.capture', { repo_id: repo, scope }, selector, issuer, proof(source));
  const initialPayload = {
    format: 'source-binding-payload/1' as const, project_id: project, repo_id: repo,
    intent: { release_ref: 'CounterBaseline@1', release_sha256: digest(engine.read('CounterBaseline@1')), snapshot_sha256: digest(baseline), model_version: MODEL as typeof MODEL },
    source_ref: captured.ref, source_sha256: digest(source), previous_binding_ref: null, completion_ref: null,
    basis: 'owner-accepted-bootstrap-association' as const, acceptance_evidence_refs: [], limitations: ['unvalidated-bootstrap: synthetic history assertion.']
  };
  const bootstrap = executeSourceBinding(engine, 'source.bind', {
    payload: initialPayload, expected_payload_sha256: digest(initialPayload), rationale: 'Synthetic original fixture association.', review_refs: []
  }, selector, issuer, proof(source));
  const oracle = { format: 'counter-oracle/1', snapshot_sha256: digest(candidate.snapshot), expected: { maximum: 12 },
    criteria: results.map(({ passed, reviewer, ...r }) => r).sort((a, b) => canonical(a).localeCompare(canonical(b))) };
  const planned = createGitPlan(engine, { binding_ref: bootstrap.ref, target_ref: candidate.ref, write_paths: ['counter.mjs'],
    checker: applicationCheckerPins(oracle as any), oracle, regressions: ['unrelated-byte-preservation'] }, preparer, issuer) as any;
  const plan = planned.record, after = realization.files['counter.mjs'];
  const oldLines = before.trimEnd().split('\n'), newLines = after.trimEnd().split('\n');
  const patch = 'diff --git a/counter.mjs b/counter.mjs\n--- a/counter.mjs\n+++ b/counter.mjs\n@@ -1,' + oldLines.length + ' +1,' + newLines.length + ' @@\n' +
    oldLines.map((line, i) => line === newLines[i] ? ' ' + line : '-' + line + '\n+' + newLines[i]).join('\n') + '\n';
  const stage = gitStore(engine, 'git-patch-stage', {
    format: 'git-patch-stage/1', project_id: project, repo_id: repo, plan_ref: planned.ref, patch, patch_sha256: bytesDigest(patch),
    operations: [{ path: 'counter.mjs', before: { content: before, sha256: bytesDigest(before), mode: '100644' }, after: { content: after, sha256: bytesDigest(after), mode: '100644' } }],
    result_tree_oid: oid('d'), result_manifest_sha256: digest([entry(after)]), unchanged_outside_write_set: true, base_index_digest: digest('synthetic-index'), owner: 'preparer'
  });
  const acceptance = registerGitAcceptance(engine, {
    format: 'git-acceptance/1', project_id: project, repo_id: repo, plan_ref: planned.ref, stage_ref: stage.ref,
    target: plan.target, base_source_ref: captured.ref, result_tree_oid: oid('d'), result_manifest_sha256: stage.record.result_manifest_sha256,
    acceptance_contract_sha256: plan.acceptance_contract_sha256, checker: plan.checker,
    results: plan.criteria.map((c: any) => ({ ...c, passed: true, reviewer: c.method === 'review' ? 'fixture-reviewer' : null })),
    regressions: [{ id: 'unrelated-byte-preservation', passed: true }], observations_sha256: digest('synthetic-not-executed'),
    limitations: ['Structural fixture pass assertions only; no application execution or authenticated producer measurement.']
  }, producer, issuer);
  const reviewInput = { stage: stage.ref, acceptance: acceptance.ref, release: released.ref, expected_target_sha256: null as string | null,
    accepted: true, rationale: 'Synthetic exact fixture code review assertion.' };
  const preview = createGitReview(engine, reviewInput, selector, issuer, true) as any;
  reviewInput.expected_target_sha256 = preview.target_sha256;
  const review = createGitReview(engine, reviewInput, selector, issuer, false) as any;
  const receipt = gitStore(engine, 'git-apply-receipt', {
    format: 'git-apply-receipt/1', project_id: project, repo_id: repo, transaction_id: digest('synthetic-transaction'),
    plan_ref: planned.ref, stage_ref: stage.ref, review_ref: review.ref, binding_ref: bootstrap.ref,
    base_commit: source.head_commit, base_tree: source.head_tree, result_tree_oid: oid('d'), paths: ['counter.mjs'],
    state: 'applied-awaiting-owner-commit', principal: 'scope-selector'
  });
  const release = engine.read(released.ref, 'release');
  const completion = gitStore(engine, 'git-finalization', {
    format: 'git-finalization/1', project_id: project, repo_id: repo, receipt_ref: receipt.ref, binding_ref: bootstrap.ref,
    stage_ref: stage.ref, review_ref: review.ref, acceptance_ref: acceptance.ref, release_ref: released.ref,
    release_sha256: digest(release), snapshot_sha256: digest(snapshotFromRelease(release)), candidate: candidate.fingerprint,
    head_commit: oid('c'), head_tree: oid('d'), base_commit: source.head_commit, principal: 'scope-selector'
  });
  const nextSource = { ...structuredClone(source), head_commit: oid('c'), head_tree: oid('d'), entries: [entry(after)], manifest_sha256: digest([entry(after)]) };
  const nextCapture = executeSourceBinding(engine, 'source.capture', { repo_id: repo, scope }, selector, issuer, proof(nextSource));
  const payload = { ...initialPayload, intent: { release_ref: released.ref, release_sha256: digest(release), snapshot_sha256: digest(snapshotFromRelease(release)), model_version: MODEL as typeof MODEL },
    source_ref: nextCapture.ref, source_sha256: digest(nextSource), previous_binding_ref: bootstrap.ref, completion_ref: completion.ref,
    basis: 'validated-release-association', acceptance_evidence_refs: [acceptance.ref], limitations: ['Synthetic OIDs and structural acceptance; no Git or runtime qualification.'] };
  const successor = executeSourceBinding(engine, 'source.bind', { payload, expected_payload_sha256: digest(payload),
    rationale: 'Synthetic finalized successor fixture.', review_refs: [review.ref] }, selector, issuer, proof(nextSource));
  verifySourceBindingHistory(engine.records, project); verifyGitAdoptionHistory(engine.records, project);
  const pin = (ref: string) => ({ ref, sha256: digest(engine.read(ref)) });
  const contract = (bindingRef: string): NativeGitHistoryContract => {
    const binding = engine.read(bindingRef, 'source-binding'), p = binding.payload, intent = engine.read(p.intent.release_ref);
    return {
      format: V1_P_FORMAT, model_version: MODEL, target_model_version: MODEL, purpose: 'historical-inspection', project_id: project, repo_id: repo,
      history_sha256: digest(engine.records), binding: pin(bindingRef), source: pin(p.source_ref),
      intent: { ...pin(p.intent.release_ref), snapshot_sha256: p.intent.snapshot_sha256, model_version: MODEL },
      authority: { trust: 'local-fixture', principal: binding.acceptance.principal, responsible_scope: binding.acceptance.responsible_scope, authority_sha256: digest(intent.authorities) },
      evidence: p.acceptance_evidence_refs.map((ref: string) => { const data = engine.read(ref); return { ...pin(ref), format: data.format,
        principal: data.producer.principal, trust: data.producer.trust, execution_authenticated: data.producer.execution_authenticated }; }),
      finalization: p.completion_ref ? pin(p.completion_ref) : null
    };
  };
  const contracts = { bootstrap: contract(bootstrap.ref), successor: contract(successor.ref) };
  inspectNativeGitHistory(contracts.bootstrap, engine.records); inspectNativeGitHistory(contracts.successor, engine.records);
  return { format: 'v1-p-synthetic-legacy-history/1', project_id: project, model_version: MODEL, object_format: objectFormat,
    limitations: ['All Git OIDs, owner commit and passing outcomes are synthetic. No processes or application tests ran to generate this pack.'],
    records: engine.records, heads: engine.ownerHeads, contracts,
    artifact_sha256: Object.fromEntries(Object.entries(engine.records).map(([ref, record]) => [ref, bytesDigest(canonical(record.data))])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.join(process.cwd(), 'tests/fixtures/v1-p');
  await mkdir(directory, { recursive: true });
  for (const objectFormat of ['sha1', 'sha256'] as const)
    await writeFile(path.join(directory, 'legacy-' + objectFormat + '.json'), canonical(buildLegacyHistory(process.cwd(), objectFormat)) + '\n');
  const schemas = path.join(process.cwd(), 'schemas/v1-p');
  await mkdir(schemas, { recursive: true });
  await writeFile(path.join(schemas, 'native-git-history-contract.schema.json'), JSON.stringify({
    ...z.toJSONSchema(nativeGitHistoryContractSchema), title: V1_P_FORMAT,
    description: 'Preparation-only history pins. Shape validity grants no authority; inspectNativeGitHistory enforces version, trust and retained closure. No native dispatch or migration.'
  }, null, 2) + '\n');
}
