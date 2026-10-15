import { Engine, obligations } from '../src/core.js';
import { bootstrap } from '../src/fixtures.js';
import { bytesDigest, digest, fail } from '../src/model.js';
import { FixtureIssuer, type SecurityContext } from '../src/security.js';
import { createSourceHostProof, executeSourceBinding, type BindingPayload, type GitObservation, type SourceSnapshot } from '../src/source-binding.js';
import { createDriftHostProof } from '../src/source-drift.js';
import { executeDrift } from '../src/reconciliation.js';

// In-process unit issuer models the explicit repo grant; broker tests use the real issuer.
export class SourceTestIssuer extends FixtureIssuer {
  denyRepository = false;
  assertRepository(context: SecurityContext, command: string, repoId: string, paths: string[]) {
    this.assertLive(context);
    if (this.denyRepository || repoId !== 'synthetic-repo' || paths.some(p => !p.startsWith('src/')) || !context.allowed_operations.includes(command)) fail('REPOSITORY_FORBIDDEN', 4, 'Test repository grant denied.');
  }
}
export function sourceFixture(selectedItem = 'app/purpose') {
  const projectId = 'strata-local-demo', engine = new Engine({}, {}, { projectId }), initial = bootstrap(); engine.init(initial, 'bootstrap');
  const issuer = new SourceTestIssuer({ assignments: {
    'fixture-source-selector': { principal: 'scope-selector', operations: ['source.capture', 'source.bind', 'drift.check', 'drift.propose', 'drift.review'] },
    'fixture-source-author': { principal: 'author-a', operations: ['drift.check', 'drift.propose', 'drift.review'] },
    'fixture-source-reader': { principal: 'reader', operations: ['inspect'] },
    'fixture-source-narrow': { principal: 'scope-selector', operations: ['drift.check', 'drift.propose', 'drift.review'], write_block_ids: [] }
  } });
  const selector = issuer.resolve('fixture-source-selector'), author = issuer.resolve('fixture-source-author');
  const entries: SourceSnapshot['entries'] = [{ path: 'src/app.txt', presence: 'present', kind: 'regular', mode: '100644', byte_length: 6, sha256: bytesDigest('hello\n') }];
  const criteria = obligations(engine.target('R0@1').snapshot).find(o => o.item === selectedItem)!.criteria.sort();
  const scope: SourceSnapshot['scope'] = { format: 'source-scope/1', coverage: 'selected-scope', paths: ['src/app.txt'], watch_roots: ['src'], exclusions: [], items: [selectedItem], mapping: [{ item: selectedItem, paths: ['src/app.txt'], criteria }], limitations: ['Only the declared selected item is mapped.'] };
  const source: SourceSnapshot = { format: 'source-snapshot/1', project_id: projectId, repo_id: 'synthetic-repo', object_format: 'sha1', head_commit: 'a'.repeat(40), head_tree: 'b'.repeat(40), scope, scope_sha256: digest(scope), entries, manifest_sha256: digest(entries) };
  const observation: GitObservation = { format: 'git-observation/1', project_id: projectId, repo_id: 'synthetic-repo', object_format: 'sha1', head_commit: source.head_commit, head_tree: source.head_tree, index_sha256: digest('index'), scope_sha256: source.scope_sha256, entries: structuredClone(entries), manifest_sha256: digest(entries), status: [], outside_scope_dirty: false, ignored_count: 0, excluded_count: 0, unsupported: [], coherence: 'stable', trust: 'local-measurement' };
  const sourceRef = executeSourceBinding(engine, 'source.capture', { repo_id: source.repo_id, scope }, selector, issuer, createSourceHostProof(source, observation)).ref;
  const payload: BindingPayload = { format: 'source-binding-payload/1', project_id: projectId, repo_id: source.repo_id, intent: { release_ref: 'R0@1', release_sha256: digest(engine.read('R0@1')), snapshot_sha256: digest(engine.target('R0@1').snapshot), model_version: initial.model_version as any }, source_ref: sourceRef, source_sha256: digest(source), previous_binding_ref: null, completion_ref: null, basis: 'owner-accepted-bootstrap-association', acceptance_evidence_refs: [], limitations: ['unvalidated-bootstrap association; no observed application acceptance.'] };
  const bindInput = { payload, expected_payload_sha256: digest(payload), rationale: 'Accept this exact selected source association.', review_refs: [] };
  const bindingRef = executeSourceBinding(engine, 'source.bind', bindInput, selector, issuer, createSourceHostProof(source, observation)).ref;
  return { engine, issuer, selector, author, source, observation, payload, bindInput, bindingRef, sourceRef };
}
export function changedObservation(f: ReturnType<typeof sourceFixture>, bytes: string | Uint8Array = 'changed\n') {
  const o = structuredClone(f.observation); o.entries[0].sha256 = bytesDigest(bytes); o.entries[0].byte_length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length; o.manifest_sha256 = digest(o.entries); o.status = [{ path: 'src/app.txt', staged: false, unstaged: true, untracked: false }]; return o;
}
export function proposalFixture(f: ReturnType<typeof sourceFixture>, observation = changedObservation(f)) {
  const reportResult = executeDrift(f.engine, 'drift.check', { binding_ref: f.bindingRef }, f.author, f.issuer, createDriftHostProof(observation)), report = f.engine.read(reportResult.ref, 'drift-report');
  const input = { report_ref: reportResult.ref, expected_report_sha256: digest(report), action: 'revalidate', rationale: 'Request fresh evidence for changed source.', paths: ['src/app.txt'], items: ['app/purpose'], layer_refs: [], patch_refs: [], evidence_refs: [], questions: [], supersedes: null };
  const result = executeDrift(f.engine, 'drift.propose', input, f.author, f.issuer), proposal = f.engine.read(result.ref, 'reconciliation-proposal');
  const reviewInput = { proposal_ref: result.ref, expected_proposal_sha256: digest(proposal), decision: 'approve_plan', rationale: 'Accept the revalidation plan.', questions: [] };
  return { observation, report, reportRef: reportResult.ref, input, proposal, proposalRef: result.ref, reviewInput };
}
