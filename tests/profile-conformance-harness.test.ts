import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { canonical, digest, type Snapshot, StrataError } from '../src/model.js';
import type { Evaluation } from '../src/core.js';
import type { FixtureOracle, ProfileAdapter, Realization } from '../src/profile-types.js';
import { treeDigest } from '../src/profile-types.js';
import { describeProfileSupport, inspectProfileSupport } from '../src/profile-capabilities.js';

export type ConformanceCase = { target: string; evaluation: Evaluation; oracle: FixtureOracle };
/** A third compiled adapter supplies literal semantic cases and its own unsupported mutations.
 * No domain-specific runtime exports, fixture generation or oracle inference lives here. */
export type CompiledConformanceFixture = {
  name: string; adapter: ProfileAdapter; baseline: ConformanceCase; changed: ConformanceCase;
  unsupported: { name: string; evaluation: Evaluation }[];
  golden?: { profile: string; baseline_output: string; changed_output: string };
  evidenceTrust?: 'synthetic-local-fixture' | 'authenticated-host';
  externalReview?: boolean;
};

export async function loadCompiledOutput(realization: Realization, use: (module: any, directory: string) => Promise<void> | void, entrypoint = Object.keys(realization.files).find(name => name.endsWith('.mjs'))!) {
  const directory = await mkdtemp(path.join(tmpdir(), 'strata-conformance-'));
  try {
    for (const [name, body] of Object.entries(realization.files)) {
      assert.match(name, /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/);
      await writeFile(path.join(directory, name), body);
    }
    assert.match(entrypoint, /^[A-Za-z0-9_-]+\.mjs$/); assert(Object.hasOwn(realization.files, entrypoint));
    const module = await import(pathToFileURL(path.join(directory, entrypoint)).href);
    await use(module, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function runCompiledConformance(fixture: CompiledConformanceFixture) {
  const { adapter } = fixture;
  test(`${fixture.name}: exact baseline and changed intent realize deterministically with conserved links`, () => {
    for (const c of [fixture.baseline, fixture.changed]) {
      const realized = adapter.materialize(c.target, c.evaluation);
      assert.equal(canonical(realized), canonical(adapter.materialize(c.target, structuredClone(c.evaluation))));
      assert.equal(realized.profile, digest(adapter.archive())); assert.equal(realized.output_tree, treeDigest(realized.files));
      assert.equal(realized.candidate, c.evaluation.fingerprint); assert.equal(realized.target, c.target);
      assert.deepEqual(realized.coverage.map(row => row.item).sort(), c.evaluation.obligations.map(o => o.item).sort());
      for (const obligation of c.evaluation.obligations) {
        const row = realized.coverage.filter(row => row.item === obligation.item); assert.equal(row.length, 1);
        assert.deepEqual(row[0].facets, obligation.facets);
        assert.deepEqual(row[0].subjects, obligation.item.includes('/acceptance.') ? obligation.value.subjects : [obligation.item]);
        assert.deepEqual(row[0].checks, obligation.criteria.map(ref => { const [block, key] = ref.split('/acceptance.'); const criterion = cValue(c.evaluation.snapshot, block, key); return { check: criterion.check, version: criterion.version, fixture: criterion.fixture, method: criterion.method }; }));
        assert.deepEqual(Object.keys(row[0].facet_handling).sort(), [...obligation.facets].sort());
        assert.equal(row[0].status, 'implemented_validation_pending');
      }
      for (const name of Object.keys(realized.files)) assert.deepEqual(realized.reverse_links[name].sort(), realized.coverage.map(row => row.item).sort());
      if (adapter.boundEvidence) {
        assert.equal(canonical(realized.oracle), canonical(c.oracle)); assert.equal(realized.oracle_sha256, digest(c.oracle));
        assert.equal(realized.checker_sha256, adapter.checker.digest()); assert.equal(realized.fixture_sha256, adapter.checker.fixtureDigest(c.oracle));
      }
    }
    const before = adapter.materialize(fixture.baseline.target, fixture.baseline.evaluation), after = adapter.materialize(fixture.changed.target, fixture.changed.evaluation);
    assert.notEqual(before.candidate, after.candidate); assert.notEqual(before.output_tree, after.output_tree);
    if (adapter.boundEvidence) {
      assert.notEqual(before.oracle_sha256, after.oracle_sha256);
      // Input expectations belong to oracle pins; unchanged fixed cases retain their fixture pin.
      assert.equal(before.fixture_sha256, after.fixture_sha256); assert.equal(before.checker_sha256, after.checker_sha256);
      const changedCases = structuredClone(fixture.baseline.oracle); changedCases.criteria[0].fixture += '-changed';
      assert.notEqual(adapter.checker.fixtureDigest(changedCases), before.fixture_sha256);
    }
    if (fixture.golden) {
      assert.equal(before.profile, fixture.golden.profile); assert.equal(before.output_tree, fixture.golden.baseline_output); assert.equal(after.output_tree, fixture.golden.changed_output);
    }
  });
  test(`${fixture.name}: independent literal oracle measures intended runtime behavior`, async () => {
    for (const c of [fixture.baseline, fixture.changed]) {
      const realization = adapter.materialize(c.target, c.evaluation);
      await loadCompiledOutput(realization, module => {
        const measured = adapter.checker.run(module, structuredClone(c.oracle));
        for (const criterion of c.oracle.criteria) {
          if (fixture.externalReview && criterion.method === 'review') assert.equal(measured.checks[criterion.check], undefined, 'Mechanical checker must not manufacture external review.');
          else assert.equal(measured.checks[criterion.check]?.passed, true, canonical(measured.checks[criterion.check]));
        }
        const wrong = structuredClone(c.oracle); wrong.expected = { ...wrong.expected, unsupported: true };
        const failed = adapter.checker.run(module, wrong);
        assert(Object.values(failed.checks).some(row => !row.passed), 'Checker must not accept unrecognized host expectations.');
      }, adapter.checker.entrypoint);
    }
  });
  test(`${fixture.name}: exact unsupported mutations and support reports agree with adapter refusal`, () => {
    for (const c of [fixture.baseline, fixture.changed]) {
      const report = inspectProfileSupport(adapter, () => adapter.materialize(c.target, c.evaluation)); assert.equal(report.materialization.supported, true);
      assert.equal(report.profile.archive_sha256, digest(adapter.archive()));
      assert.equal(report.profile.evidence.trust, fixture.evidenceTrust ?? 'synthetic-local-fixture'); assert.equal(report.profile.evidence.approvals, 'separate-required');
    }
    for (const c of fixture.unsupported) {
      let failure: StrataError | undefined;
      try { adapter.materialize(fixture.baseline.target, c.evaluation); } catch (error) { assert(error instanceof StrataError); failure = error; }
      assert(failure, c.name);
      const report = inspectProfileSupport(adapter, () => adapter.materialize(fixture.baseline.target, c.evaluation)); assert.equal(report.materialization.supported, false);
      if (!report.materialization.supported) assert.deepEqual(report.materialization.first_blocker, { code: failure.code, exit: failure.exit, message: failure.message, details: failure.details });
    }
    const detail = describeProfileSupport(adapter); assert(detail.source.length); assert(detail.limitations.some(s => s.includes('SDK checker')));
  });
}
function cValue(snapshot: Snapshot, block: string, key: string) { return snapshot.blocks[block].acceptance[key]; }
