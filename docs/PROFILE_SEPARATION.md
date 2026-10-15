# Domain-neutral core and finite profiles

Booking is an explicit example. Strata's source-control mechanism does not require booking Blocks, parameter names, timing rules, statements, checker families or a booking selector.

## Boundary

| Module | Responsibility |
| --- | --- |
| `src/model.ts`, `src/core.ts` | Structural records, exact baselines/refs, atomic writes, ownership, dependencies/assumptions, conflicts, provenance/impact, endorsed selection, bound evidence and Release gates. |
| `src/profile-types.ts` | Narrow compiled contracts for scenario checks, realization coverage, fixture checkers/oracles and finite selection evaluators. Records supply no callbacks, module paths or executable expressions. |
| `src/profiles.ts` | Finite compiled inventory and capability dispatch. Unknown versions/checks/profiles/evaluators fail closed. Adding a profile requires reviewed source and tests. |
| `src/profile.ts` | Common obligation conservation, model/profile identity, output/checker/oracle hashes and safe-file verification. Historical booking exports are compatibility imports. |
| `src/runner.ts` | Measures the complete pinned output before importing the compiled profile's entrypoint; requires host semantic expectations and returns bound fixture evidence. |
| `src/mediation.ts` | Frozen bases/packets, partitions, grants, reports, freshness, receipts and endorsements; calls compiled selection/effect adapters. |
| `src/profiles/booking*.ts` | Booking vocabulary, examples, template, compatibility rule, checker, fixture, observed traces and exact S2 selection evaluator. |
| `src/profiles/counter-fixture.ts` | Node test profile with one root Block, positive integer additions and atomic ceiling rejection. No resources, reminders or clock. |

Composition runs the exact scenario capabilities declared in its record. Empty/unknown declarations block eligibility. Materializing a Composition also requires the selected profile's compatibility capability. Valid record shape can represent unsupported intent; the finite profile must recognize every active obligation and its check links before materializing. Validation and Release recheck that same profile and bytes. There is no arbitrary prose inference or automatic synthesis.

The root configuration, original example JSON, scripts and integrated demo continue to select booking explicitly. The CLI requires `--profile PROFILE_ID` and advertises the finite inventory. Example choices are not core defaults. `src/fixtures.ts` and `src/booking-checker.ts` retain their old import paths through compatibility exports.

## What moved and changed

Booking generation, statement/check-edge recognition, purpose/contract vocabulary and program bytes moved to `src/profiles/booking.ts`. The compatibility rule moved from `Engine.evaluate` to that adapter. Checker source moved to `booking-checker.ts`; runner traces to `booking-runner.ts`; fixture builders to `booking-example.ts`. The exact 900/1200/reminder policy moved from mediation to `booking-selection.ts`, with effects text in the profile. Drift mutation tests target the moved implementation and still require every mutation to reach its seam. The integrated demo's source-pin inventory includes all new dependencies.

Core now dispatches declared capabilities. Backup admission uses the compiled profile inventory. Common materialization independently rebuilds the snapshot item set and requires exactly one coverage row per item.

The v0.2 structural validator still permits only finite numeric/boolean parameter values and retains text, authoring review, inherited acceptance and asset gates. The four booking parameter **names** are now enforced by the booking profile. This additive representability change rewrites no existing records and makes no new meanings executable. A schema-valid unknown booking parameter still fails materialization and cannot reach Release. Policy/grant shapes similarly use generic evaluator/scope strings; installation admits only the compiled evaluator's supported model/scope, requires grant scope to equal policy scope, and retains all authority, pin, expiry and use checks. The only automatic evaluator remains the finite booking example.

## Evolution of the boundary

The first finite profile placed domain recognition in the engine. The compiled adapter boundary now isolates that recognition while keeping exact capability and evidence checks in the shared engine. Adding another profile requires explicit registration and regression coverage; it never loads executable behavior from semantic records.

## Compatibility and proof

All four historical booking profile/template/checker fingerprints are regression vectors from `61b5ceb`. Supported booking program bytes, coverage, evidence formats and record identities are preserved. No baseline relabel, authority update or stored-data migration is required. Unsupported arbitrary meanings remain unsupported.

`tests/profile-separation.test.ts` uses literal JSON under `tests/fixtures/counter/`, literal host expectations and an independent executable trace (0 -> 5 -> 12; overflow/invalid additions leave 12 unchanged). The same Engine, Node broker and CLI perform composition, coverage, measured format-2 evidence, separate scope/Release approvals, immutable Release, empty-selection inheritance and backup closure. Another counter case routes a collision through the declared root selector and rejects a stale decision.

Negative cases cover missing/unknown/versioned capabilities, false assumptions, extra requirements/parameters/prose, unknown criteria, weakened subject/check links, coverage omission, wrong profile capability, substituted oracle, missing/failed/stale evidence, output edits and unknown/out-of-scope evaluators. Existing booking core, drift mutation, CLI, content, mediation, publication and local SDK regressions remain applicable. Run the focused suite with `node --test dist/tests/profile-separation.test.js`.

## Remaining limits

- Booking profiles 1/2 retain legacy evidence and 3/4 retain checker-bound evidence. Their vocabulary/template remain finite booking implementations.
- `counter-fixture/1` is a Node-only v0.1 architecture fixture: one existing root Block, ceiling 2–1000, positive safe integer additions and fixed check families. No v0.2 content/assets or full second application is claimed.
- The sole automatic selection evaluator is `booking-reminder-selection/1`. Other selections use owned decision Layers and baseline authority. Arbitrary policy programs are unsupported.
- Profiles do not create/remove/reparent Blocks or synthesize arbitrary applications. Production authentication and independent human attestation remain pending; fixture review is synthetic. SDK checker-bound execution remains unavailable.
