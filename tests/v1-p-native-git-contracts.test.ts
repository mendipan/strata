import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BLOCK_MODEL, CONTENT_MODEL, MODEL, bytesDigest, canonical, digest, type Records } from '../src/model.js';
import { Engine } from '../src/core.js';
import { FixtureIssuer } from '../src/security.js';
import { GIT_ADOPTION_SCHEMAS } from '../src/git-record-schemas.js';
import { createGitPlan } from '../src/git-adoption.js';
import { SOURCE_BINDING_SCHEMAS } from '../src/source-binding.js';
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.js';
import { bindNodeState } from '../src/node-state.js';
import { buildLegacyHistory } from '../scripts/v1-p/generate-fixtures.js';
import { g2BridgeFixture } from './g2-bridge-fixture.js';
import { sourceFixture, proposalFixture } from './source-fixture.js';
import { inspectNativeGitHistory, nativeGitVersionContract, V1_P_LEGACY_SCHEMAS } from '../src/v1-p/native-git-contract.js';

const directory = path.join(process.cwd(), 'tests/fixtures/v1-p');
const load = async (format: 'sha1' | 'sha256') => JSON.parse(await readFile(path.join(directory, 'legacy-' + format + '.json'), 'utf8')) as ReturnType<typeof buildLegacyHistory>;
const expectedBytes = {
  sha1: 'c3e6d6c46b7661bf6b852b838a59703ab6cab78cecdb237e29f2d1ed5462cfd4',
  sha256: '201e184520b31a985a5fd8bcb1dd615d19b761290b41494627c85a6a54f634ad'
};
const errorCode = (code: string) => (error: any) => { assert.equal(error.code, code); return true; };

for (const format of ['sha1', 'sha256'] as const) {
  test(`V1-P ${format} golden legacy bytes, refs, trust and generator remain exact`, async () => {
    const bytes = await readFile(path.join(directory, 'legacy-' + format + '.json'));
    assert.equal(bytesDigest(bytes), expectedBytes[format]);
    const f = await load(format), before = canonical(f);
    assert.equal(canonical(buildLegacyHistory(process.cwd(), format)), canonical(f));
    for (const [ref, stored] of Object.entries(f.records)) {
      assert.equal(bytesDigest(canonical(stored.data)), f.artifact_sha256[ref]);
      if (Object.hasOwn(V1_P_LEGACY_SCHEMAS, stored.type)) assert.equal(ref, stored.type + '@' + digest(stored.data));
    }
    for (const request of Object.values(f.contracts)) {
      const result = inspectNativeGitHistory(request, f.records);
      assert.equal(result.historical_compatibility, true);
      assert.equal(result.execution_ready, false); assert.equal(result.authority_granted, false); assert.equal(result.migrated, false);
    }
    assert.equal(f.contracts.bootstrap.finalization, null);
    assert.equal(f.contracts.bootstrap.evidence.length, 0);
    assert(f.contracts.successor.finalization);
    assert.equal(f.contracts.successor.evidence[0].execution_authenticated, false);
    assert.equal(canonical(f), before);
    assert.deepEqual(await readFile(path.join(directory, 'legacy-' + format + '.json')), bytes);
  });

  test(`V1-P ${format} existing inactive backup preserves every historical artifact byte`, async () => {
    const f = await load(format), root = await mkdtemp(path.join(os.tmpdir(), 'strata-v1-p-archive-'));
    const state = path.join(root, 'state'), bundle = path.join(root, 'bundle'), restored = path.join(root, 'inactive');
    await mkdir(path.join(state, 'artifacts'), { recursive: true });
    const closeSyntheticState = await bindNodeState(state, f.project_id, MODEL);
    await closeSyntheticState();
    const entries: Record<string, unknown> = {};
    for (const [ref, record] of Object.entries(f.records)) {
      const bytes = canonical(record.data), hash = bytesDigest(bytes);
      await writeFile(path.join(state, 'artifacts', hash + '.json'), bytes);
      entries[ref] = { hash, type: record.type, published: record.published };
    }
    await writeFile(path.join(state, 'registry.json'), canonical({ entries, heads: f.heads, requests: {}, commit_audit: [] }));
    const backup = await createBackup({ state, out: bundle, project: f.project_id, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 });
    const verified = await verifyBackup({ bundle, project: f.project_id, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256 });
    assert.equal(verified.verified, true); assert.equal(verified.inactive, true); assert.equal(verified.authors_authenticated, false);
    assert.deepEqual(verified.roots, Object.keys(f.records).sort());
    const recovery = await restoreBackup({ bundle, project: f.project_id, selector: 'fixture-backup', expectedDigest: backup.manifest_sha256, out: restored });
    assert.equal(recovery.identities_active, false); assert.equal(recovery.requests_active, false);
    for (const hash of Object.values(f.artifact_sha256)) {
      const file = path.join('artifacts', hash + '.json');
      assert.deepEqual(await readFile(path.join(bundle, file)), await readFile(path.join(state, file)));
      assert.deepEqual(await readFile(path.join(restored, file)), await readFile(path.join(state, file)));
    }
    const reviewRef = f.records[f.contracts.successor.finalization!.ref].data.review_ref;
    // Keep retained hashes intact while removing an indexed predecessor: archive
    // integrity cannot be inferred merely from the remaining valid JSON records.
    const broken = { ...entries }; delete broken[reviewRef];
    await writeFile(path.join(state, 'registry.json'), canonical({ entries: broken, heads: f.heads, requests: {}, commit_audit: [] }));
    await assert.rejects(createBackup({ state, out: path.join(root, 'missing-review'), project: f.project_id, selector: 'fixture-backup', maxBytes: 4 * 1024 * 1024 }),
      errorCode('BACKUP_MISSING_REFERENCE'));
  });
}

const refusals = JSON.parse(await readFile(path.join(directory, 'refusals.json'), 'utf8')) as {
  id: string; patches: { path: (string | number)[]; value: unknown }[]; code: string
}[];
for (const refusal of refusals) test('V1-P refusal fixture: ' + refusal.id, async () => {
  const f = await load('sha1'), request = structuredClone(f.contracts.successor), before = canonical(f.records);
  for (const patch of refusal.patches) {
    let value: any = request;
    for (const key of patch.path.slice(0, -1)) value = value[key];
    value[patch.path.at(-1)!] = patch.value;
  }
  assert.throws(() => inspectNativeGitHistory(request, f.records), errorCode(refusal.code));
  assert.equal(canonical(f.records), before);
});

test('V1-P named actor with the same principal cannot reinterpret fixture acceptance', async () => {
  const f = await load('sha1'), request: any = structuredClone(f.contracts.successor), before = canonical(f);
  request.authority = { ...request.authority, trust: 'host-authenticated', auth_receipt: {
    ref: 'auth-receipt@' + 'e'.repeat(64), sha256: 'e'.repeat(64)
  } };
  assert.throws(() => inspectNativeGitHistory(request, f.records), errorCode('V1_P_AUTHORITY_MISMATCH'));
  assert.equal(canonical(f), before);
});

test('V1-P existing v0.1 bridged /2 plan retains private adoption history and original binding', async () => {
  const f = await g2BridgeFixture(), records = f.engine.records, binding = f.engine.read(f.binding.ref), p = binding.payload;
  const pin = (ref: string) => ({ ref, sha256: digest(f.engine.read(ref, undefined, false)) });
  const before = canonical(records);
  const result = inspectNativeGitHistory({
    ...((await load('sha1')).contracts.bootstrap), project_id: f.project, repo_id: f.repo, history_sha256: digest(records),
    binding: pin(f.binding.ref), source: pin(p.source_ref),
    intent: { ...pin(p.intent.release_ref), snapshot_sha256: p.intent.snapshot_sha256, model_version: MODEL },
    authority: { trust: 'local-fixture', principal: binding.acceptance.principal, responsible_scope: binding.acceptance.responsible_scope,
      authority_sha256: digest(f.engine.read(p.intent.release_ref).authorities) }
  }, records);
  assert.equal(result.historical_compatibility, true); assert.equal(result.execution_ready, false);
  assert.equal(f.engine.read(f.result.ref).format, 'git-change-plan/2');
  assert.equal(records[f.publicationRef].published, false);
  assert.equal(canonical(records), before);
});

test('V1-P preexisting drift context retains its original history without reconciliation', async () => {
  const f = sourceFixture(), prior = proposalFixture(f), binding = f.engine.read(f.bindingRef), p = binding.payload;
  const pin = (ref: string) => ({ ref, sha256: digest(f.engine.read(ref)) });
  const records = f.engine.records, before = canonical(records);
  const request = {
    ...((await load('sha1')).contracts.bootstrap), project_id: f.selector.project_id, repo_id: p.repo_id, history_sha256: digest(records),
    binding: pin(f.bindingRef), source: pin(p.source_ref),
    intent: { ...pin(p.intent.release_ref), snapshot_sha256: p.intent.snapshot_sha256, model_version: MODEL },
    authority: { trust: 'local-fixture', principal: binding.acceptance.principal, responsible_scope: binding.acceptance.responsible_scope,
      authority_sha256: digest(f.engine.read(p.intent.release_ref).authorities) }
  };
  const result = inspectNativeGitHistory(request, records);
  assert.equal(result.execution_ready, false); assert.equal(canonical(records), before);
  const incomplete = structuredClone(records); delete incomplete[prior.reportRef];
  assert.throws(() => inspectNativeGitHistory({ ...request, history_sha256: digest(incomplete) }, incomplete), errorCode('REF_NOT_FOUND'));
});

test('V1-P exact source versions and digest domains cannot substitute for one another', async () => {
  const f = await load('sha256');
  const request = structuredClone(f.contracts.successor);
  request.source = f.contracts.bootstrap.source;
  assert.throws(() => inspectNativeGitHistory(request, f.records), errorCode('V1_P_PIN_MISMATCH'));
  request.source = structuredClone(f.contracts.successor.source);
  request.source.sha256 = f.records[request.source.ref].data.head_tree; // Valid 64-hex Git OID; wrong hash domain.
  assert.throws(() => inspectNativeGitHistory(request, f.records), errorCode('V1_P_PIN_MISMATCH'));
  const alias = 'source-snapshot@main';
  const records: Records = { ...f.records, [alias]: f.records[f.contracts.successor.source.ref] };
  request.source = { ...f.contracts.successor.source, ref: alias }; request.history_sha256 = digest(records);
  assert.throws(() => inspectNativeGitHistory(request, records), errorCode('V1_P_PIN_MISMATCH'));
});

test('V1-P duplicate evidence and wrong-type finalization pins cannot stand in for closure', async () => {
  const f = await load('sha1'), request = structuredClone(f.contracts.successor);
  request.evidence.push(request.evidence[0]);
  assert.throws(() => inspectNativeGitHistory(request, f.records), errorCode('V1_P_EVIDENCE_MISMATCH'));
  request.evidence.pop(); request.finalization = { ref: request.evidence[0].ref, sha256: request.evidence[0].sha256 };
  assert.throws(() => inspectNativeGitHistory(request, f.records), errorCode('V1_P_FINALIZATION_MISMATCH'));
});

const missing = [
  ['source', 'V1_P_MISSING_HISTORY'], ['binding', 'V1_P_MISSING_HISTORY'], ['acceptance', 'V1_P_MISSING_HISTORY'],
  ['finalization', 'V1_P_MISSING_HISTORY'], ['predecessor', 'REF_NOT_FOUND'], ['receipt', 'SOURCE_COMPLETION_REQUIRED'],
  ['stage', 'SOURCE_COMPLETION_REQUIRED'], ['review', 'SOURCE_COMPLETION_REQUIRED'],
  ['validation', 'V1_P_SEMANTIC_HISTORY_INVALID'], ['approval', 'V1_P_SEMANTIC_HISTORY_INVALID'], ['realization', 'V1_P_SEMANTIC_HISTORY_INVALID']
] as const;
for (const [name, code] of missing) test('V1-P rehashed history still refuses missing ' + name, async () => {
  const f = await load('sha1'), request = structuredClone(f.contracts.successor), records = structuredClone(f.records);
  const finalization = records[request.finalization!.ref].data, binding = records[request.binding.ref].data, release = records[request.intent.ref].data;
  const refs: Record<string, string> = {
    source: request.source.ref, binding: request.binding.ref, acceptance: request.evidence[0].ref, finalization: request.finalization!.ref,
    predecessor: binding.payload.previous_binding_ref, receipt: finalization.receipt_ref, stage: finalization.stage_ref, review: finalization.review_ref,
    validation: release.validation, approval: release.approvals[0], realization: records[release.validation].data.realization
  };
  delete records[refs[name]]; request.history_sha256 = digest(records);
  const before = canonical(records);
  assert.throws(() => inspectNativeGitHistory(request, records), errorCode(code));
  assert.equal(canonical(records), before);
});

test('V1-P legacy schemas retain exact identity and refuse new named fields or versions', async () => {
  const f = await load('sha1');
  for (const [type, schema] of Object.entries({ ...SOURCE_BINDING_SCHEMAS, ...GIT_ADOPTION_SCHEMAS }))
    assert.equal(V1_P_LEGACY_SCHEMAS[type as keyof typeof V1_P_LEGACY_SCHEMAS], schema);
  const binding = structuredClone(f.records[f.contracts.successor.binding.ref].data);
  binding.payload.intent.model_version = BLOCK_MODEL;
  assert.equal(SOURCE_BINDING_SCHEMAS['source-binding'].safeParse(binding).success, false);
  const acceptance = structuredClone(f.records[f.contracts.successor.evidence[0].ref].data);
  acceptance.producer.trust = 'host-measured'; acceptance.producer.execution_authenticated = true;
  assert.equal(GIT_ADOPTION_SCHEMAS['git-acceptance'].safeParse(acceptance).success, false);
  const finalization = structuredClone(f.records[f.contracts.successor.finalization!.ref].data);
  finalization.format = 'git-finalization/3'; finalization.auth_receipt = 'auth-receipt@' + 'e'.repeat(64);
  assert.equal(GIT_ADOPTION_SCHEMAS['git-finalization'].safeParse(finalization).success, false);
  const review = structuredClone(f.records[f.records[f.contracts.successor.finalization!.ref].data.review_ref].data);
  review.trust = 'host-authenticated';
  assert.equal(GIT_ADOPTION_SCHEMAS['git-apply-review'].safeParse(review).success, false);
});

test('V1-P rehashed retained semantic history cannot be relabelled v0.3', async () => {
  const f = await load('sha1'), records = structuredClone(f.records), request = structuredClone(f.contracts.successor);
  records[request.intent.ref].data.model_version = BLOCK_MODEL; request.history_sha256 = digest(records);
  assert.throws(() => inspectNativeGitHistory(request, records), errorCode('V1_P_VERSION_MISMATCH'));
});

test('V1-P v0.3 requirements preserve accepted S0 boundaries and native runtime refusal', () => {
  const named = nativeGitVersionContract(BLOCK_MODEL);
  assert.equal(named.dispatch, 'unsupported');
  assert.equal('native_record_formats' in named && named.native_record_formats, 'unassigned-pending-design-review');
  assert.equal('existing_auth_receipt' in named && named.existing_auth_receipt, 'strata-host-auth/1');
  assert.equal('existing_semantic_evidence' in named && named.existing_semantic_evidence, 'strata-host-evidence/1');
  assert.equal(nativeGitVersionContract(CONTENT_MODEL).dispatch, 'unsupported');
  assert.throws(() => nativeGitVersionContract('strata/future'), errorCode('UNSUPPORTED_MODEL_VERSION'));
  const issuer = new FixtureIssuer(), engine = new Engine({}, {}, { modelVersion: BLOCK_MODEL });
  assert.throws(() => createGitPlan(engine, {}, issuer.resolve('fixture-preparer'), issuer), errorCode('UNSUPPORTED_MODEL_VERSION'));
  assert.deepEqual(engine.records, {});
});
