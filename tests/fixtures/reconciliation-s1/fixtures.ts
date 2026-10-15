import { createHash } from 'node:crypto';
import { MODEL, bytesDigest, digest, type Records } from '../../../src/model.js';
import { recordPin, contractDigest, deriveApprovalSubject, type GitObject, type Pin, type PlanBody,
  type PlannedProof, type CommittedProof, type Plan, type Evidence, type TypedRecordReader } from '../../../src/reconciliation-records.js';

export function rawObject(kind: GitObject['kind'], bytes: Buffer | string, object_format: 'sha1' | 'sha256' = 'sha1'): GitObject {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { format: 'reconciliation-git-object/1', object_format, kind,
    oid: createHash(object_format).update(`${kind} ${raw.length}\0`).update(raw).digest('hex'),
    byte_length: raw.length, raw_sha256: bytesDigest(raw), bytes_base64: raw.toString('base64') };
}
export function rawTree(rows: { name: string; mode: string; oid: string }[], format: 'sha1' | 'sha256' = 'sha1') {
  return rawObject('tree', Buffer.concat(rows.map(r => Buffer.concat([Buffer.from(`${r.mode} ${r.name}\0`), Buffer.from(r.oid, 'hex')]))), format);
}
export function rawCommit(tree: string, parents: string[], format: 'sha1' | 'sha256' = 'sha1', message = 'synthetic') {
  return rawObject('commit', `tree ${tree}\n${parents.map(p => 'parent ' + p + '\n').join('')}author Synthetic <test@example.invalid> 1 +0000\ncommitter Synthetic <test@example.invalid> 1 +0000\n\n${message}\n`, format);
}
export type FixtureOptions = { format?: 'sha1' | 'sha256'; action?: PlanBody['action']; clean?: boolean; edges?: number;
  headParents?: string[]; outsideChange?: boolean; changedTarget?: boolean; normative?: boolean; bootstrap?: boolean;
  finalParents?: string[]; sameHead?: boolean; reviewCriterion?: boolean };
/** These are shape/proof fixtures. They grant no authority and do not constitute validated semantic Releases. */
export function s1Fixture(options: FixtureOptions = {}) {
  const records: Records = {}, format = options.format ?? 'sha1', action = options.action ?? 'accept_code';
  const retain = (type: string, data: any): Pin => { const pin = recordPin(type, data); records[pin.ref] = { type, data, published: true }; return pin; };
  const read: TypedRecordReader = (pin, type) => { const r = records[pin.ref]; if (!r || r.type !== type) throw Error('Missing typed fixture record'); return r.data; };
  const objectPins = new Map<string, Pin>();
  const object = (r: GitObject) => { const pin = retain('reconciliation-git-object', r); objectPins.set(r.oid, pin); return r; };
  const initial = options.clean ? 'value=0\nanchor\n' : 'value=1\nanchor\n';
  const observed = options.clean ? initial : action === 'restore_intent' ? 'value=2\nanchor\n' : 'value=0\nanchor\n';
  const desired = action === 'restore_intent' ? 'value=0\nanchor\n' : observed;
  const secondaryBase = 'separate\n', secondaryObserved = action === 'restore_intent' ? 'preserved edit\n' : secondaryBase;
  const initialBlob = object(rawObject('blob', initial, format)), observedBlob = object(rawObject('blob', observed, format)), desiredBlob = object(rawObject('blob', desired, format));
  const secondary = object(rawObject('blob', secondaryBase, format)), secondaryChanged = object(rawObject('blob', secondaryObserved, format));
  // Unselected blob bytes intentionally omitted; tree object identity is sufficient for preservation.
  const outside = rawObject('blob', Buffer.from([0, 255, 3]), format), outsideChanged = rawObject('blob', 'unapproved', format);
  const tree = (a: GitObject, b: GitObject, external = outside) => object(rawTree([
    { name: 'secondary.txt', mode: '100644', oid: b.oid }, { name: 'selected.txt', mode: '100644', oid: a.oid },
    { name: 'unselected.bin', mode: '100755', oid: external.oid }], format));
  const boundTree = tree(initialBlob, secondary), headTree = boundTree, observedTree = tree(observedBlob, secondaryChanged),
    desiredTree = tree(desiredBlob, secondaryChanged, options.outsideChange ? outsideChanged : outside);
  const base = object(rawCommit(boundTree.oid, [], format, 'B')); let head = base;
  const ancestry = [base.oid];
  for (let i = 0; i < (options.edges ?? 0); i++) {
    head = object(rawCommit(headTree.oid, i === (options.edges ?? 0) - 1 && options.headParents ? options.headParents : [head.oid], format, 'H' + i));
    ancestry.push(head.oid);
  }
  const makeEntry = (path: string, b: GitObject) => ({ path, presence: 'present' as const, mode: '100644' as const,
    byte_length: b.byte_length, sha256: b.raw_sha256, blob: objectPins.get(b.oid)! });
  const selected = {
    bound: [makeEntry('secondary.txt', secondary), makeEntry('selected.txt', initialBlob)],
    observed: [makeEntry('secondary.txt', secondaryChanged), makeEntry('selected.txt', observedBlob)],
    desired: [makeEntry('secondary.txt', secondaryChanged), makeEntry('selected.txt', desiredBlob)],
  };
  const projection = (rows: typeof selected.bound) => rows.map(({ blob: _, ...e }) => ({ ...e, kind: 'regular' as const }));
  const scope = { format: 'source-scope/1' as const, coverage: 'selected-scope' as const,
    paths: ['secondary.txt', 'selected.txt'], watch_roots: ['.'], exclusions: [{ path: 'unselected.bin', kind: 'file' as const, reason: 'Outside selected application area.' }],
    items: ['App/acceptance.rule', 'App/requirements.value'], mapping: [
      { item: 'App/acceptance.rule', paths: ['secondary.txt', 'selected.txt'], criteria: ['App/acceptance.rule'] },
      { item: 'App/requirements.value', paths: ['selected.txt'], criteria: ['App/acceptance.rule'] }],
    limitations: ['Synthetic selected application scope; excluded application behavior is unknown.'] };
  const source = { format: 'source-snapshot/1' as const, project_id: 'synthetic', repo_id: 'repo', object_format: format,
    head_commit: base.oid, head_tree: boundTree.oid, scope, scope_sha256: digest(scope), entries: projection(selected.bound), manifest_sha256: digest(projection(selected.bound)) };
  const sourcePin = retain('source-snapshot', source);
  const releasePin = retain('release', { fixture: 'semantic-history-placeholder', state: 'validated' });
  const old_intent = { release_ref: releasePin.ref, release_sha256: releasePin.sha256, snapshot_sha256: digest('synthetic snapshot'), model_version: MODEL as typeof MODEL };
  const bindingPayload = { format: 'source-binding-payload/1', project_id: 'synthetic', repo_id: 'repo', intent: old_intent,
    source_ref: sourcePin.ref, source_sha256: sourcePin.sha256, previous_binding_ref: null, completion_ref: null,
    basis: options.bootstrap ? 'owner-accepted-bootstrap-association' : 'validated-release-association', acceptance_evidence_refs: [], limitations: scope.limitations };
  const predecessor = retain('source-binding', { format: 'source-binding/1', payload: bindingPayload, payload_sha256: digest(bindingPayload),
    acceptance: { principal: 'synthetic-owner', trust: 'local-fixture', responsible_scope: 'App', rationale: 'Synthetic baseline.', accepted: true, review_refs: [] } });
  const observation = { format: 'git-observation/1' as const, project_id: 'synthetic', repo_id: 'repo', object_format: format,
    head_commit: head.oid, head_tree: headTree.oid, index_sha256: digest('raw synthetic index'), scope_sha256: digest(scope),
    entries: projection(selected.observed), manifest_sha256: digest(projection(selected.observed)),
    status: options.clean ? [] : [{ path: 'selected.txt', staged: false, unstaged: true, untracked: false }],
    outside_scope_dirty: false, ignored_count: 0, excluded_count: 1, unsupported: [], coherence: 'stable' as const, trust: 'local-measurement' as const };
  const report = retain('drift-report', { format: 'source-drift-report/2', project_id: 'synthetic', repo_id: 'repo', binding_ref: predecessor.ref,
    binding_sha256: predecessor.sha256, observation, observation_sha256: digest(observation) });
  const patch = action === 'restore_intent' ? 'diff --git a/selected.txt b/selected.txt\n--- a/selected.txt\n+++ b/selected.txt\n@@ -1,2 +1,2 @@\n-value=2\n+value=0\n anchor\n' : null;
  const proof: PlannedProof = { format: 'reconciliation-source-proof/1', phase: 'planned', project_id: 'synthetic', repo_id: 'repo', object_format: format,
    predecessor, report, bound_source: sourcePin, action, scope, association_paths: ['secondary.txt', 'selected.txt'], restore_paths: patch ? ['selected.txt'] : [], new_file_modes: [],
    observation, observation_sha256: digest(observation), base_commit_oid: base.oid, observed_head_oid: head.oid, ancestry_oids: ancestry,
    trees: { bound: boundTree.oid, head: headTree.oid, observed: observedTree.oid, desired: desiredTree.oid },
    objects: [...objectPins.values()].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0), selected,
    patch, patch_sha256: patch === null ? null : bytesDigest(patch), operations: patch ? [{ path: 'selected.txt', before: selected.observed[1], after: selected.desired[1] }] : [] };
  const proofPin = retain('reconciliation-source-proof', proof);
  const changed = options.changedTarget ?? action === 'update_intent';
  const targetPin = changed ? retain('release', { fixture: 'direct-target-history-placeholder', state: 'validated', baseline: releasePin.ref }) : releasePin;
  const target = { ...old_intent, release_ref: targetPin.ref, release_sha256: targetPin.sha256, candidate_fingerprint: digest('synthetic candidate') };
  const oracle = { format: 'synthetic-oracle/1', expected: 0 }, checker = { id: 'synthetic-checker', version: '1', sha256: digest('checker'), fixture_sha256: digest('fixture'), oracle_sha256: digest(oracle) };
  const descriptor = retain('reconciliation-producer-descriptor', { format: 'reconciliation-producer-descriptor/1', id: 'synthetic-producer', version: '1', checker, oracle,
    assets: [], bounds: { milliseconds: 5000, old_generation_mib: 64, young_generation_mib: 16, ipc_bytes: 262144 } });
  const targetRoles = changed ? ['release', 'scope:App', 'source:App'] : ['source:App'];
  const bridge = { predecessor, old_intent, target, target_release_trust: 'local-fixture' as const,
    predecessor_validation: options.bootstrap ? 'accepted-unvalidated-bootstrap' as const : 'validated' as const,
    target_validation: 'validated' as const, semantic_records: [{ type: 'release' as const, pin: targetPin }] };
  const template = { predecessor, target, scope, desired_tree_oid: desiredTree.oid, desired_manifest_sha256: digest(selected.desired), limitations: scope.limitations,
    allowed_transition: 'reviewed-clean-head-or-single-child' as const, evidence_policy: 'fresh-same-contract-and-source' as const, required_roles: targetRoles };
  const body: PlanBody = { format: 'reconciliation-plan-body/2', project_id: 'synthetic', repo_id: 'repo', action, report, predecessor, old_intent, target, layer_refs: [], historical_bridge: bridge,
    observation, observation_sha256: digest(observation), source_proof: proofPin, observed_tree_oid: observedTree.oid, desired_tree_oid: desiredTree.oid,
    desired_entries: selected.desired, binding_delta_paths: options.clean ? [] : ['secondary.txt', 'selected.txt'].filter(p => p === 'selected.txt' || action === 'restore_intent'),
    patch, patch_sha256: proof.patch_sha256, operations: proof.operations, association_paths: proof.association_paths, restore_paths: proof.restore_paths, new_file_modes: [], old_scope: scope, scope,
    scopes: { source_scope: 'App', target_scope: 'App', target_case: changed && (options.normative ?? true) ? 'normative-impact' : 'source-association', changed_target: changed,
      normative_delta: changed && (options.normative ?? true), guardians: [] },
    criteria: [{ criterion_ref: 'App/acceptance.rule', statement: 'Synthetic measured value.', subjects: ['App/requirements.value'], check: 'synthetic.value', version: '1', fixture: 'synthetic', method: options.reviewCriterion ? 'review' : 'mechanical' }],
    checker, producer_id: 'synthetic-producer', producer_descriptor: descriptor, oracle, contract_sha256: '', required_roles: targetRoles, successor_template: template, rationale: 'Synthetic foundation fixture.' };
  body.contract_sha256 = contractDigest(body);
  const at = '2026-10-12T00:00:00.000Z', expires = '2026-10-12T01:00:00.000Z', validUntil = '2026-10-12T12:00:00.000Z';
  const auth = (action_input: any, durable = false) => retain('reconciliation-auth', { format: 'reconciliation-auth/1', model_version: MODEL, project_id: 'synthetic', repo_id: 'repo',
    attempt_id: '00000000-0000-4000-8000-000000000001', request_sha256: digest('synthetic request'), action_input, action_input_sha256: digest(action_input),
    authority: { account_id: 'synthetic-account', principal_id: 'synthetic-author', principal_kind: 'person', credential_epoch: 1, account_generation: 1, accounts_sha256: digest('accounts'),
      policy_generation: 1, policy_sha256: digest('policy'), grant_id: 'synthetic-grant', grant_scope_sha256: digest('grant'), repository_configuration_sha256: digest('repository'), producer_configuration_sha256: digest('producer'), grant_expires_at: validUntil },
    issued_at: at, session: { id_sha256: digest('session'), issued_at: at, expires_at: expires, parent_id_sha256: null }, action_started_at: at, action_finished_at: at,
    endorsement_valid_until: durable ? validUntil : null });
  const prepareInput = { action: 'drift.reconcile.prepare', request: { report, action, target_release: targetPin, layer_refs: [], rationale: body.rationale,
    patch, checker, producer_id: body.producer_id, oracle, new_file_modes: [] }, layer_pins: [], plan_body_sha256: digest(body) };
  const plan: Plan = { format: 'reconciliation-proposal/2', body, body_sha256: digest(body), author: 'synthetic-author', auth: auth(prepareInput), state: 'proposed' };
  const planPin = retain('reconciliation-proposal', plan);
  const runAuth = auth({ action: 'reconciliation.run', plan: planPin, phase: 'planned-source', contract_sha256: body.contract_sha256,
    source_proof: proofPin, measured_input_sha256: digest(selected.desired), producer_descriptor: descriptor });
  const run = { format: 'reconciliation-run/1', project_id: 'synthetic', repo_id: 'repo', phase: 'planned-source', attempt_id: '00000000-0000-4000-8000-000000000001',
    plan: planPin, contract_sha256: body.contract_sha256, target, source_content_sha256: digest(selected.desired), producer_id: body.producer_id,
    producer_descriptor: descriptor, measured_input_sha256: digest(selected.desired), source_proof: proofPin,
    results: options.reviewCriterion ? [] : [{ criterion_ref: 'App/acceptance.rule', check: 'synthetic.value', version: '1', fixture: 'synthetic', method: 'mechanical', passed: true }],
    observations: { value: 0 }, started_at: at, finished_at: at, auth: runAuth, final_source: null };
  const runPin = retain('reconciliation-run', run);
  const assertionRows = [{ criterion_ref: 'App/acceptance.rule', accepted: true, rationale: 'Synthetic named review assertion.' }];
  const criterionReview = options.reviewCriterion ? retain('reconciliation-criterion-review', { format: 'reconciliation-criterion-review/1', project_id: 'synthetic', repo_id: 'repo',
    plan: planPin, desired_tree_oid: desiredTree.oid, target, criteria_sha256: digest(body.criteria), assertions: assertionRows, actor: 'synthetic-author',
    auth: auth({ action: 'reconciliation.criterion-review', plan: planPin, assertions: assertionRows }, true), valid_until: validUntil }) : null;
  const evidence: Evidence = { format: 'reconciliation-evidence/1', project_id: 'synthetic', repo_id: 'repo', plan: planPin, planned_run: runPin, criterion_review: criterionReview,
    contract_sha256: body.contract_sha256, target, desired_tree_oid: desiredTree.oid, source_content_sha256: digest(selected.desired), producer_id: body.producer_id,
    producer_descriptor: descriptor, trust: 'host-authenticated', limitations: scope.limitations };
  const evidencePin = retain('reconciliation-evidence', evidence), subject = deriveApprovalSubject(plan, evidence);
  const reviewAuth = auth({ action: 'reconciliation.role-approval', plan: planPin, evidence: evidencePin, subject_sha256: digest(subject), roles: targetRoles }, true);
  const reviewPin = retain('reconciliation-review', { format: 'reconciliation-review/2', subject, subject_sha256: digest(subject), actor: 'synthetic-author', auth: reviewAuth,
    roles: targetRoles, accepted: true, rationale: 'Synthetic scope approval; no live authority.', valid_until: validUntil });
  const finalCommit = options.sameHead ? head : rawCommit(desiredTree.oid, options.finalParents ?? [head.oid], format, 'C');
  const finalPin = retain('reconciliation-git-object', finalCommit);
  const finalSource = { ...source, head_commit: finalCommit.oid, head_tree: desiredTree.oid, entries: projection(selected.desired), manifest_sha256: digest(projection(selected.desired)) };
  const finalSourcePin = retain('source-snapshot', finalSource), finalObservation = { ...observation, head_commit: finalCommit.oid, head_tree: desiredTree.oid,
    entries: finalSource.entries, manifest_sha256: finalSource.manifest_sha256, status: [] };
  const committed: CommittedProof = { format: 'reconciliation-source-proof/1', phase: 'committed', project_id: 'synthetic', repo_id: 'repo', object_format: format, prepared: proofPin, plan: planPin,
    source_snapshot: finalSourcePin, observation: finalObservation, observation_sha256: digest(finalObservation), owner_commit_oid: finalCommit.oid, tree_oid: desiredTree.oid,
    transition: options.sameHead ? 'same-reviewed-clean-head' : 'direct-child', additional_objects: options.sameHead ? [] : [finalPin] };
  const committedPin = retain('reconciliation-source-proof', committed);
  const finalAuth = auth({ action: 'reconciliation.run', plan: planPin, phase: 'committed-source', contract_sha256: body.contract_sha256,
    source_proof: committedPin, measured_input_sha256: digest(selected.desired), producer_descriptor: descriptor });
  const finalRun = retain('reconciliation-run', { ...run, phase: 'committed-source', source_proof: committedPin, auth: finalAuth,
    final_source: { owner_commit_oid: finalCommit.oid, source_snapshot: finalSourcePin, observation_sha256: digest(finalObservation) } });
  const completeAuth = auth({ action: 'drift.reconcile.complete', request: { plan: planPin, evidence: evidencePin, approvals: [reviewPin], owner_commit: finalCommit.oid }, plan_body_sha256: digest(body) });
  const payload = { format: 'source-binding-payload/2', project_id: 'synthetic', repo_id: 'repo', intent: { ...old_intent, release_ref: target.release_ref, release_sha256: target.release_sha256 },
    source: finalSourcePin, predecessor, basis: 'authenticated-reconciliation-association', evidence: [evidencePin], limitations: scope.limitations };
  const completionPin = retain('reconciliation-completion', { format: 'reconciliation-completion/2', project_id: 'synthetic', repo_id: 'repo', action,
    plan: planPin, evidence: evidencePin, reviews: [reviewPin], auth: completeAuth, historical_bridge: bridge, owner_commit_oid: finalCommit.oid, observation: finalObservation,
    observation_sha256: digest(finalObservation), source_snapshot: finalSourcePin, source_proof: committedPin, final_run: finalRun, successor_payload: payload,
    successor_payload_sha256: digest(payload), completed_at: at, outcome: action === 'accept_code' ? 'accepted-code-selected-scope' : action === 'restore_intent' ? 'restored-intent-selected-scope' : 'updated-intent-selected-scope',
    completion: true, behavior_verified: false });
  const bindingPin = retain('source-binding', { format: 'source-binding/2', payload, payload_sha256: digest(payload),
    acceptance: { trust: 'host-authenticated', completion: completionPin, source_approval: reviewPin, finalizer_auth: completeAuth } });
  const publication = { result: { completion: completionPin, source_binding: bindingPin }, commit_audit: { completion: completionPin, source_binding: bindingPin } };
  return { records, read, retain, object, objectPins, proof, proofPin, committed, committedPin, body, plan, planPin, evidence, evidencePin, subject,
    completionPin, bindingPin, publication, base, head, finalCommit, boundTree, desiredTree, observedTree, selected, initialBlob, observedBlob, desiredBlob, source, report };
}
