# Author a finite compiled profile

A profile is reviewed TypeScript product source implementing `ProfileAdapter` in [profile-types.ts](../src/profile-types.ts). It realizes a finite declared surface. It does not load plugins, execute supplied source, infer arbitrary prose, grant capabilities, or establish equivalence with an original application.

The registry in [profiles.ts](../src/profiles.ts), [materialization verifier](../src/profile.ts), [Engine](../src/core.ts), and [measured fixture runner](../src/runner.ts) remain authoritative. Preserve historical IDs and archive fingerprints. Use a new ID for a new adapter or incompatible trust/model contract. Support descriptions are not persisted metadata and require no schema migration.

The generic obligation projection lives in the pure [obligations.ts](../src/obligations.ts) module and remains publicly re-exported by `core.ts`. Its implementation is unchanged. Compiled adapters use this shared projection without importing the runtime Engine, so registry-first and Engine-first module entry both work without circular initialization.

## Existing support provider

[profile-capabilities.ts](../src/profile-capabilities.ts) describes only reviewed finite profile IDs. `describeProfileSupport(adapter)` returns the exact archive digest, models, Node backend, scenario/version, output constraints, topology, semantic limits, check families, evidence trust, limitations, and source links. Descriptions do not modify archives.

`inspectProfileSupport(adapter, () => engine.realize(target, adapter.id))` lets the shared capability projection retain the real Engine predicates and its first exact `StrataError` (code, exit, message, details). The callback is compiled caller code, never a callback or path accepted from a model record or public request. Unexpected implementation errors propagate. A returned realization must belong to the described profile/model. A successful probe means only that the exact attempted materialization succeeded. It supplies no check result, review, permission, approval, or accepted Release. Static limits do not claim an exhaustive list of candidate failures.

The existing `capabilities` command exposes additive `profile_details` and `target_support` fields in `strata-capabilities/1`. Existing profile IDs, scenarios, operation grants and trust fields retain their meaning. Without `--target`, `target_support` is null. With an exact visible target, it contains one actual Engine materialization report per model-compatible compiled profile. Reads create no realization or evidence records. Private and absent refs refuse before probing. No persisted record schema, command input, credential or backup format changes are required. `counter-host/1` and `collection-host/1` describe measured host evidence and separate authenticated criterion review; `collection-node/1` retains synthetic local fixture evidence.

The provider describes all eight compiled registry entries: four historical booking profiles, `counter-fixture/1`, `counter-host/1`, `collection-node/1`, and `collection-host/1`. The new hosted collection uses the accepted v0.3 Studio contracts and has a distinct compiled archive. All seven previous archive fingerprints remain unchanged.

## Adapter checklist

1. Declare explicit model/backend and scenario/version support. Reject unknown semantic keys, prose, parameters, criteria, interface/failure meanings, and topology. Normalize declared sets using the existing model. Share recognition with scenario evaluation; avoid separate descriptions that decide supportedness.
2. Conserve every core-derived obligation exactly once, including purpose, relationships, interfaces, failures, and acceptance. Preserve values, facets, subject links, criterion links, output digests, and reverse links. A facet grants no authority. A missing check family or unrelated subject is a refusal.
3. Generate deterministic flat text files with ordinary safe filenames. No record supplies code, executable parameters, imports, network calls, package commands, or module paths. Use existing export/verification rules.
4. Archive relevant template, semantic recognizer, oracle, checker, and fixture implementation. Checker implementation, fixed input/criterion definitions, semantic expectations, candidate and output bytes have distinct pins. A count change alters output/oracle/candidate pins while unchanged checker/fixture implementations retain theirs.
5. Keep host expectations independent of generated config. Check in literal baseline/changed expectations and fixed acceptance cases. Compare actual behavior, including failures and boundaries; config matching alone is not a behavioral oracle.
6. Measure files before import through the existing configured runner after registry integration. Modified, extra and missing files cannot register as the expected realization or reuse evidence. Keep mechanical observations, criterion review, scope/guardian approval and Release approval distinct.
7. Extend the finite registry, source-linked provider notes and configured host runner only on the accepted integration base. Do not weaken unknown-profile refusal, change core schemas or turn local fixture review into hosted authentication. SDK checker execution remains unsupported.

## Reusable conformance test interface

[profile-conformance-harness.test.ts](../tests/profile-conformance-harness.test.ts) exports `CompiledConformanceFixture` and `runCompiledConformance`. Supply a compiled adapter, baseline/changed evaluations with literal independent oracles, and unsupported evaluation mutations. Optional literal golden profile/output pins protect historical vectors. The harness checks deterministic output, exact complete coverage and facet/subject/criterion/reverse links, checker/fixture/oracle pins, measured behavior, and parity between actual refusals and support reports. It already runs for counter, bound booking and collection adapters. Adapter-specific tests supply adversarial runtime mutations and real registry/runner/Release boundary tests; the harness is not a replacement for those gates.

From an existing dependency-equipped checkout, the verified commands are:

```powershell
npm run build
npm run typecheck
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/profile-conformance.test.js dist/tests/profile-conformance-workflow.test.js dist/tests/collection-profile.test.js dist/tests/collection-profile-workflow.test.js
```

No new dependency or installation is required. Use Node >=22.

## Synthetic local collection contract

[collection-node/1](../src/profiles/collection.ts) recognizes exactly root `collection` and its `items`/`policy` children. Purposes, relationships, interfaces, failures and acceptance claims are exact; [literal fixtures](../tests/fixtures/collection/bootstrap.json) define the baseline. `max_items` is an integer 1-1000 and `max_title_length` an integer 1-200. Baseline is 3/20; the [owned Layer](../tests/fixtures/collection/extend.json) changes count to 5. [Host expectations](../tests/fixtures/collection/expectations.json) are literal checked-in inputs, separate from generated config and the adapter's oracle builder.

The flat `collection.mjs` exports immutable `config` and `createCollection()`. State is a fresh in-memory Map per instance. All returned item values are detached. `list()` returns ascending ASCII ID order; it returns an array rather than a result wrapper. IDs match `[A-Za-z0-9][A-Za-z0-9_-]{0,31}` exactly. Titles must be strings with nonblank `trim()` and at most the configured number of JavaScript string-iteration Unicode code points. Combining marks count individually; astral characters count once. Text is preserved without trimming or normalization.

| Operation | Success | Failure |
| --- | --- | --- |
| `add(id, title)` | `{accepted:true,item:{id,title,completed:false}}` | `invalid`, `title_too_long`, `duplicate`, `limit` |
| `get(id)` | `{accepted:true,item}` | `invalid`, `missing` |
| `complete(id)` | `{accepted:true,item}` with `completed:true`; repeating succeeds with unchanged state | `invalid`, `missing` |
| `remove(id)` | `{accepted:true,item}` containing the removed value; capacity is available again | `invalid`, `missing` |
| `list()` | Detached item array in ASCII ID order | None |

Failures are `{accepted:false,reason}` and preserve all state. Add validates ID/title, then title length, duplicate ID, and capacity in that order. Restart begins empty. There is no persistence, clock, randomness, network, package dependency, configurable executable value or source-code importer.

The collection suite retains generated baseline/changed files beneath ignored `.strata/collection-local/` and a measured receipt at `.strata/collection-local-evidence.json`. After running it, this ordinary Node example uses the generated baseline module:

```powershell
Push-Location .strata/collection-local/baseline
node --input-type=module -e "import {createCollection} from './collection.mjs'; const app=createCollection(); console.log(JSON.stringify({initial:app.list(),added:app.add('a','title'),final:app.list()}));"
Pop-Location
```

The direct adapter receipts establish compiled behavior with the historical synthetic local fixture-review label. [collection-profile-workflow.test.ts](../tests/collection-profile-workflow.test.ts) separately traverses the public CLI and persistent Node broker: owned Layer publication, real Composition, registered output, independently supplied literal oracle, file measurement, validation, separate scope and Release approvals, accepted Release, broker restart, empty-considered-set reuse, independent rematerialization and revalidation, exact profile asset backup, and isolated inactive restore. It writes `.strata/collection-workflow-evidence.json`. Negative cases exercise unsupported semantics/topology, normal whole-Layer collisions and endorsed selection, missing/false/substituted evidence, wrong checker/fixture/oracle/candidate/output pins, modified output after validation, missing approvals, operation grants and unknown backup profile IDs even after container hashes are recomputed.

These local measurements use fixture identities and fixture review labels, and establish no hosted authentication, live grants, persistent application state, arbitrary application generation or original-application equivalence. Backup restore retains an inactive historical archive with no live identities or requests. Existing registry-driven CLI and backup behavior is reused without collection-specific command or backup dispatch.

The local `collection-node/1` contract still refuses v0.2, v0.3 and optional `audit`. SDK collection execution remains unsupported. Hosted collection support is the separate contract below; structural `intent-structure@1` eligibility alone does not establish realizability.

## Synthetic authenticated hosted collection contract

[collection-host/1](../src/profiles/collection-host.ts) supports only v0.3 and the existing Node checker backend. Its mandatory three-Block semantics, item operations, bounds, failure ordering and detached per-instance state are exactly the local contract above. Explanatory descriptions do not change those semantics. Background assets, arbitrary semantic additions and other application shapes refuse. [Literal v0.3 fixtures](../tests/fixtures/collection-host/bootstrap.json) and [independent expectations](../tests/fixtures/collection-host/expectations.json) establish the 3/20 baseline, actual owned 3-to-5 count change and optional audit behavior.

An optional fourth `audit` child has the exact [compiled meaning](../src/profiles/collection-host-semantics.ts) and [literal Block fixture](../tests/fixtures/collection-host/audit-block.json). The root must contain the declared audit relationship, output contract and linked audit criterion. An owned [v0.3 Layer](../tests/fixtures/collection-host/audit-layer.json), populated with that literal Block, creates it through the existing `created_blocks` contract. Its requirements are rules; creating new invariants still requires the existing guardian assignment contract. Duplicate created IDs block normal Composition and require authenticated whole-Layer mediation. The adapter can evaluate hypothetical selections for that existing mediation contract; Core still refuses registration and release of blocked actual candidates.

With audit, `createCollection().audit()` returns detached `{sequence,operation,item}` events in consecutive order starting at 1. Successful add, first completion and remove each append one event containing the detached resulting item. Reads, rejected mutations and repeated completion append none. Each instance starts with empty history. Generated `config` retains only the historical count/title fields; the separate `auditEnabled` export describes this compiled variant. No application runtime persistence is added.

The existing configured host runner measures actual files and supplies mechanical observations. It never supplies `intent.review`. Each review criterion requires a separate authenticated attestation tied to the exact realization. Evidence assembly does not validate or approve. Validation, scope/guardian approvals and Release approval remain separate operations by explicitly granted principals. The finite `runner_profiles` author-host configuration accepts `counter-host/1` and `collection-host/1`; operators must explicitly supply output slots, accounts and profile/operation grants. No configuration, identity or live grant is synthesized by registry registration.

Run the synthetic checks in an existing dependency-equipped checkout:

```powershell
npm run build
npm run typecheck
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/collection-host-profile.test.js dist/tests/collection-host-workflow.test.js dist/tests/collection-host-persistence.test.js
```

The tests traverse actual owned publication, measured authenticated runs, separate reviews/approvals, accepted Releases, audit creation/collision/selection, public CLI and persistent Node broker restart, historical Release reuse and independent rematerialization. Receipts are saved under ignored `.strata/collection-host-workflow-evidence.json` and `.strata/collection-host-persistence-evidence.json`. Refusals cover unsupported meanings and models, boundary failures, audit mutants, fixture laundering, wrong actors, revoked reviews, runner allowlisting, stale pins and changed output bytes. Only disposable synthetic credentials and loopback services are exercised; no live TLS/hosting proof or behavioral equivalence with an original application is claimed.

Offline backup recognizes the new compiled realization and its exact profile asset. Tests verify an unvalidated template-only historical archive, inactive restore and unknown-profile refusal even after container hashes are recomputed. The existing backup format does not accept authenticated host record types or `release/3`; the authenticated history backup test explicitly refuses with `BACKUP_INVALID`. Hosted CLI backup operators remain unconfigured. Extending authenticated history backup or executing the checker on SDK is a separate contract decision.
