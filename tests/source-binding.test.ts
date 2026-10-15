import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, canonical } from '../src/model.js';
import { sourceFixture, changedObservation } from './source-fixture.js';
import { createSourceHostProof, executeSourceBinding, sourcePath, validateSourceScope, validateSourceSnapshot, validateGitObservation, verifySourceBindingHistory } from '../src/source-binding.js';
const code = (value: string) => (error: any) => error.code === value;

test('source binding pins one exact Release and raw source with honest bootstrap acceptance', () => {
  const f = sourceFixture(), release = canonical(f.engine.read('R0@1')), bound = f.engine.read(f.bindingRef);
  assert.equal(bound.payload.source_sha256, digest(f.source)); assert.equal(bound.payload.intent.release_sha256, digest(f.engine.read('R0@1'))); assert.equal(bound.acceptance.principal, 'scope-selector');
  const retry = executeSourceBinding(f.engine, 'source.bind', f.bindInput, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)); assert.equal(retry.ref, f.bindingRef); assert.equal(retry.behavior_verified, false); assert.equal(canonical(f.engine.read('R0@1')), release);
  verifySourceBindingHistory(f.engine.records, f.selector.project_id);
});
test('source accepts no client proof, dirty baseline or mismatched current bytes', () => {
  const f = sourceFixture(); assert.throws(() => executeSourceBinding(f.engine, 'source.bind', f.bindInput, f.selector, f.issuer), code('UNSUPPORTED_SOURCE_BACKEND'));
  assert.throws(() => executeSourceBinding(f.engine, 'source.bind', { ...f.bindInput, verified: true }, f.selector, f.issuer), code('INVALID_RECORD'));
  assert.throws(() => executeSourceBinding(f.engine, 'source.bind', f.bindInput, f.selector, f.issuer, createSourceHostProof(f.source, changedObservation(f))), code('SOURCE_SNAPSHOT_STALE'));
  const untracked = structuredClone(f.observation); untracked.status = [{ path: 'src/new.txt', staged: false, unstaged: false, untracked: true }]; assert.throws(() => executeSourceBinding(f.engine, 'source.bind', f.bindInput, f.selector, f.issuer, createSourceHostProof(f.source, untracked)), code('SOURCE_SNAPSHOT_STALE'));
});
test('source fingerprint domains cannot exchange raw SHA256, tree OID and scope digest', () => {
  const f = sourceFixture(), altered = structuredClone(f.source); altered.entries[0].sha256 = 'b'.repeat(40); assert.throws(() => validateSourceSnapshot(altered), code('INVALID_RECORD'));
  altered.entries[0].sha256 = 'b'.repeat(64); assert.throws(() => validateSourceSnapshot(altered), code('SOURCE_INTEGRITY'));
  const sha256 = structuredClone(f.source); sha256.object_format = 'sha256'; assert.throws(() => validateSourceSnapshot(sha256), code('INVALID_RECORD')); sha256.head_commit = 'a'.repeat(64); sha256.head_tree = 'b'.repeat(64); validateSourceSnapshot(sha256);
  f.engine.store('source-snapshot@alias', 'source-snapshot', f.source); const payload = { ...f.payload, source_ref: 'source-snapshot@alias' };
  assert.throws(() => executeSourceBinding(f.engine, 'source.bind', { ...f.bindInput, payload, expected_payload_sha256: digest(payload) }, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)), code('SOURCE_INTEGRITY'));
});
test('unsafe source paths and alias sets fail before any filesystem operation', () => {
  for (const p of ['../a', '/a', 'C:/a', '//server/a', 'a:ads', '.git/config', '.strata/state', 'src/CON.txt', 'src/a.', 'src/é.txt', 'src\\a', 'src/a\0']) assert.throws(() => sourcePath(p), code('INVALID_PATH'));
  const f = sourceFixture(), scope = structuredClone(f.source.scope); scope.paths.push('src/APP.txt'); scope.paths.sort(); assert.throws(() => validateSourceScope(scope), code('INVALID_RECORD'));
});
test('incomplete item and criterion mapping cannot be accepted by baseline review', () => {
  const f = sourceFixture(); for (const mutate of [(s: any) => s.mapping[0].criteria = [], (s: any) => s.items.push('app/requirements.unknown'), (s: any) => s.mapping[0].paths = ['elsewhere/a']]) { const scope = structuredClone(f.source.scope); mutate(scope); assert.throws(() => validateSourceScope(scope, f.engine.target('R0@1').snapshot)); }
});
test('selected source byte budget and unsafe prefix identities fail explicitly', () => {
  const f = sourceFixture(), source = structuredClone(f.source);
  source.entries = Array.from({ length: 5 }, (_, i) => ({ ...source.entries[0], path: 'src/file' + i, byte_length: 4 * 1024 * 1024 })); source.scope.paths = source.entries.map(e => e.path); source.scope.mapping[0].paths = source.scope.paths; source.scope_sha256 = digest(source.scope); source.manifest_sha256 = digest(source.entries);
  assert.throws(() => validateSourceSnapshot(source), code('SOURCE_LIMIT'));
  const scope = structuredClone(f.source.scope); scope.paths = ['src/app.txt', 'src/app.txt/child']; assert.throws(() => validateSourceScope(scope), code('INVALID_PATH'));
});
test('absent, nontext and gitlink entries retain precise metadata boundaries', () => {
  const f = sourceFixture(), s = structuredClone(f.source); s.entries[0] = { path: 'src/app.txt', presence: 'absent', kind: null, mode: null, byte_length: null, sha256: null }; s.manifest_sha256 = digest(s.entries); validateSourceSnapshot(s);
  s.entries[0].sha256 = 'c'.repeat(64); s.manifest_sha256 = digest(s.entries); assert.throws(() => validateSourceSnapshot(s), code('INVALID_RECORD'));
  const o = structuredClone(f.observation); o.entries[0] = { path: 'src/app.txt', presence: 'present', kind: 'gitlink', mode: '160000', byte_length: null, sha256: null }; o.manifest_sha256 = digest(o.entries); validateGitObservation(o); o.entries[0].sha256 = 'c'.repeat(64); o.manifest_sha256 = digest(o.entries); assert.throws(() => validateGitObservation(o), code('INVALID_RECORD'));
});
test('binding checks current principal, repo and baseline authority', () => {
  const f = sourceFixture(); assert.throws(() => executeSourceBinding(f.engine, 'source.bind', f.bindInput, f.author, f.issuer, createSourceHostProof(f.source, f.observation)), code('OPERATION_FORBIDDEN'));
  f.issuer.denyRepository = true; assert.throws(() => executeSourceBinding(f.engine, 'source.bind', f.bindInput, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)), code('REPOSITORY_FORBIDDEN')); f.issuer.denyRepository = false;
  f.issuer.suspendForTest('scope-selector'); assert.throws(() => executeSourceBinding(f.engine, 'source.bind', f.bindInput, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)), code('ACCESS_REVOKED'));
});
test('bootstrap validation label and missing successor completion cannot be forged', () => {
  const f = sourceFixture(), input = structuredClone(f.bindInput); input.payload.basis = 'validated-release-association'; input.expected_payload_sha256 = digest(input.payload); assert.throws(() => executeSourceBinding(f.engine, 'source.bind', input, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)), code('SOURCE_BASELINE_ACCEPTANCE_REQUIRED'));
  input.payload = structuredClone(f.payload); input.payload.previous_binding_ref = f.bindingRef; input.expected_payload_sha256 = digest(input.payload); assert.throws(() => executeSourceBinding(f.engine, 'source.bind', input, f.selector, f.issuer, createSourceHostProof(f.source, f.observation)), code('SOURCE_COMPLETION_REQUIRED'));
});
test('history rejects re-signed accepted identity, provenance and missing source closure', () => {
  const f = sourceFixture(), records = structuredClone(f.engine.records); delete records[f.sourceRef]; assert.throws(() => verifySourceBindingHistory(records, f.selector.project_id), code('REF_NOT_FOUND'));
  const forged = structuredClone(f.engine.records); forged[f.bindingRef].data.acceptance.principal = 'author-a'; assert.throws(() => verifySourceBindingHistory(forged, f.selector.project_id), code('SOURCE_INTEGRITY'));
});
