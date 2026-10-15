# Deterministic drift/regression hardening

This contract covers D1–D6 from the [drift test plan](DRIFT_REGRESSION_TEST_PLAN.md): obligation conservation, independent runtime expectations and evidence bound to checker bytes.

## Reproduced gaps and resulting gates

The regression fixtures exercise these gaps and their resulting refusal gates:

- G1: exclusivity and occupied-resource obligations materialized with an unrelated lifecycle check. This was a coverage hole; the existing application still enforced exclusivity.
- G2: a freshly generated, registered 600-second output passed all runtime evidence checks and validation while its intent required 900 seconds. Both output/config were internally consistent; this was not an old-manifest byte-tamper refusal.
- G3: removing an exclusivity assertion changed the checker body hash but left the profile and evidence digests unchanged.

Current booking materialization rejects linked criteria that do not name their actual obligation or omit its required check family, with `OBLIGATION_CHECK_MISMATCH`. It also cross-checks the complete raw snapshot item/value map against obligation derivation, requires the bounded booking core items, and checks flattened snapshot/acceptance/provenance against separately captured candidate copies. Known omissions return `OBLIGATION_CONSERVATION`. No general guardian inheritance rule or deletion API was added.

The host runner now requires an explicit `booking-oracle/1` argument sourced from independently reviewed semantic intent, rather than generated configuration. `fixtureOracle(snapshot)` reads recognized intent and active criteria without reading generated output. The regression tests also retain a separate literal item/value map and fixed 900/840 and 1,200/1,140 behavior traces. The runner compares actual generated configuration with the supplied expectation and records failed checks; fresh hashes cannot convert a failed active criterion into passing evidence.

## Explicit version and compatibility boundary

| Profile | Model and evidence |
| --- | --- |
| `booking-node/1` | Existing v0.1 profile fingerprint, output and legacy evidence shape preserved. |
| `booking-node/2` | Existing v0.2 retain-only profile and legacy evidence shape preserved. |
| `booking-node/3` | Opt-in v0.1 Node profile; realization format 2 and `strata-fixture-evidence/2` bind checker implementation, fixture inputs/active aliases and the semantic oracle. |
| `booking-node/4` | Opt-in v0.2 Node profile with the same bindings plus existing retained background asset closure. v0.2 Release remains unavailable. |

All models remain explicit v0.1/v0.2 and protocol envelopes remain version 1. The existing frozen evidence schema is unchanged; [evidence format 2](../schemas/fixture-evidence-v2.schema.json) is a separate strict schema. Legacy evidence is never relabeled as checker-bound. Current booking coverage checks are stricter for new materialization; they do not rewrite historical immutable records. The legacy booking-node/1 fingerprint remains `082c69b5420253378ae65ba450aa26be9e791921c50a9f7acca2a9c8345e13e5`.

For the hardened path use `materialize TARGET --profile booking-node/3` (or `/4` for v0.2), then the trusted host calls `runFixtureEvidence(output, realization, fixtureOracle(reviewedSnapshot))`. The independently supplied oracle must match the retained oracle pin. Evidence/checker/fixture/oracle substitutions return `STALE_CHECKER_EVIDENCE`; changed candidates/profiles/output produce their existing stale/integrity errors. Fresh evidence still requires separate exact responsible-scope and Release approval. Changing a check while keeping its label changes the actual checker/profile hash and requires fresh evidence. Future reviewed checker/template revisions need explicit new profile versions; hashes identify bytes and do not prove their correctness.

The new checker-bound profiles are Node-only. Their retained checker artifact includes the actual compiled function source and fixed fixture input definition; all assertion helpers live in that function. The SDK explicitly returns `UNSUPPORTED_CHECKER_BACKEND` for this new path and retains its existing legacy workflow. No public arbitrary-profile/checker loader, new credentials, live grants or hosted identity was introduced. The host oracle is now required even when running a legacy profile; legacy callers were updated to supply their pinned candidate snapshot. Missing oracle returns `ORACLE_REQUIRED` after existing output measurement.

Node backup retains the new checker/profile archive, realization/oracle and evidence bindings. Existing v0.1 backup1 and v0.2 backup2 remain selected by semantic model; readers must support the new supporting-record versions or fail closed. A measured checker-bound CLI Release passes export, offline verification and isolated inactive restore. Recovery still activates no identities or grants.

## Demonstrated finite cases

[tests/drift-regression.test.ts](../tests/drift-regression.test.ts) and [tests/drift-cli.test.ts](../tests/drift-cli.test.ts) exercise exact baseline/candidate/profile/checker/fixture/oracle/output hashes, independent expected values, observed runtime behavior and publication deltas. Run the commands below for fresh results.

| Case | Attempted / detected / inconclusive | Positive control and precise scope |
| --- | --- | --- |
| D1 behavioral defects | 3 / 3 / 0 | The seeded `>` expiry defect fails at R1 and when reintroduced after R2. A fresh 600-second configuration for retained 900-second intent fails `ORACLE_CONFIGURATION`. Both reach measured runtime checks and `VALIDATION_INCOMPLETE`; literal boundary assertions also fail. Correct R1 and R2 outputs pass and publish. |
| D2 conservation omissions | 3 / 3 / 0 | Combined requirement/Layer-criterion omission is caught by the independent literal map; an isolated obligation-derivation mutant and a flattening mutant reach `OBLIGATION_CONSERVATION`. No new Release appears. Correct R1 has 21 obligations/10 criteria; R2 has 22/11. Empty-selection inheritance and complete item/value/link/provenance checks pass. |
| D3 weakened correspondence | 2 / 2 / 0 | On actual R2 intent, criterion-only exclusivity remapping and a 900-to-600 change paired with lifecycle instead of expiry checking reach `OBLIGATION_CHECK_MISMATCH`. No general decision about desirable requirement changes is inferred. |
| D4 checker/fixture/oracle pins | 4 / 4 / 0 | Three label-preserving digest substitutions and an actual checker-body build change reject at `STALE_CHECKER_EVIDENCE`. Fresh bound evidence passes; legacy and format-2 receipts remain distinct. |
| D4 semantic/fixture/template/output | 4 / 4 / 0 | Valid changed semantic/fixture records, a fresh harmless template build variant, and changed on-disk bytes reject old evidence at the appropriate stale/measurement gate. Fresh supported records pass. A new criterion check version is separately unsupported, not counted as a meaningful executed upgrade. |
| D4 assets | 2 / 2 / 0 | A valid revised PNG background pin preserves executable bytes but changes candidate/closure and rejects old bound evidence. Corrupt retained bytes reject at `ASSET_INTEGRITY`. Fresh v0.2 evidence validates; cross-release success remains deferred until mediation. |
| D5 dependency substitution | 1 / 1 / 0 | A real published @2 with identical changes cannot replace the reminder's required @1; `MISSING_DEPENDENCY` blocks it. Still-available pinned @1 remains eligible after @2 is published. |
| D6 intentional evolution | Valid control passes | R3 retains unaffected obligations, moves reminder/expiry to 1,140/1,200, and publishes with actual fresh evidence plus exact fixture scope/Release approvals. Old evidence/approvals, author endorsement, missing scope and missing Release approval are refused. R1/R2 immutable bytes remain unchanged. |

These counts distinguish internal fault assertions, runtime behavioral detection and binding checks. They are not reliability estimates. No enumerated unsafe case produced a new Release; legitimate controls reach successful materialization, measured validation and, where v0.1 permits it, Release. The matrix is not a claim about all possible substitutions or unmodeled behavior. The test-seeded expiry defect is not repository bug history.

Run `node --test dist/tests/drift-regression.test.js dist/tests/drift-cli.test.js` after building for fresh results. Failed or skipped cases must not be counted as detection.

## Claims and limits

Suitable claim: **For the named booking fixtures, deterministic checks detected the seeded regressions and stale substitutions, preserved specified inherited obligations, and accepted explicitly authorized evolution with fresh measured evidence.** Cite this finite scope and distinguish synthetic role attestations from actual human consent.

The trusted host can modify code, fixtures and submitted results. Local fixture identities are public/impersonable; these receipts are not cryptographically independent attestations. The host-owned checker and reviewed oracle can still be wrong. An approved but mistaken product requirement can be implemented faithfully. New checker hashing does not repair the evidence limitations of legacy profiles. General prose equivalence, arbitrary-app correctness, undeclared interactions, production identity, comparative drift/productivity/RAG outcomes and zero-bug claims remain unproven.

The [mediation contract](MEDIATION_SLICE2.md) covers v0.2 evolution and report lifecycle. Active migration and SDK checker-bound execution remain unsupported.
