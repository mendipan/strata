# Source drift and reviewed reconciliation

Strata can record a reviewed association between an exact intent Release and a bounded Git source scope, measure source changes, and retain a reconciliation proposal with an explicit review. Source-byte changes, specified intent changes and application acceptance results remain separate observations. A hash change does not establish semantic divergence.

This version supports v0.1 intent and a configured local Node Git host. The host supplies opaque project/repository identity, canonical checkout location and explicit operation/path/Block assignments. The default broker and default fixture roles have no repository grants. Node configuration is trusted host code, not a CLI request field. Source capture and report creation do not execute repository code, hooks, package scripts or network requests.

## Local workflow

Build with `npm run build`. Invoke `node dist/src/cli.js` or `npm run strata --` and retain JSON envelopes. Examples below name prepared JSON inputs; the actual refs and digests must come from each operation. Append `--project INTENT_PROJECT --json --offline --non-interactive`.

1. `source capture --file CAPTURE.json` measures a clean committed source and stores a `source-snapshot`. Input declares `repo_id`, exact `scope` and optionally `expected_head`. The scope includes explicit source paths, watched directory roots, exclusions, exact selected intent items and a reviewed item/path/criterion mapping. See [the shared contract](SOURCE_BINDING_CONTRACT.md) for strict fields and digest domains.
2. `source bind --file BIND.json` accepts the exact prepared payload with `expected_payload_sha256`, rationale and supporting review refs. The host reopens source; the caller needs an explicit repository grant and responsible baseline scope authority. A structural bootstrap Release requires the explicit `owner-accepted-bootstrap-association` basis and an `unvalidated-bootstrap` limitation. This is an accepted association, not observed application validation.
3. `drift check --file CHECK.json` takes `{ "binding_ref": "EXACT_BINDING_REF" }`; optionally supply `against` as an exact eligible Composition/Release and `evidence_refs`. It measures the bound scope and stores an immutable report. No “latest intent” or moving branch is inferred. Dirty source is reportable even though it cannot become an accepted baseline.
4. `inspect drift-report REF` or `review drift-report REF` exposes exact changed paths/items, coverage, evidence, limitations and blockers. The review view separates recorded measurements from supplied assertions and performs no new source measurement.
5. `drift propose --file PROPOSAL.json` records an owned plan. Supply `report_ref`, `expected_report_sha256`, `action`, rationale, exact mapped `paths`/`items`, supplied `layer_refs`/`patch_refs`/`evidence_refs`, `questions` and nullable `supersedes`. No Layer or patch is inferred or authored automatically.
6. `drift review --file REVIEW.json` takes exact proposal ref/digest, `decision`, rationale and questions. Decisions are `approve_plan`, `request_changes`, `reject` or `defer`. Approval requires current responsible scope authority, complete declared coverage, no unresolved questions, and a fresh local observation matching the report. Stable dirty source can receive an approved revalidation plan. `accept_code` planning additionally requires complete bound passing application acceptance.

Every review response includes its explicit state and `completion:false`. An approved plan does not edit source or publish intent. `update_intent` hands supplied owned Layers to the existing composition/validation/approval/Release workflow; `restore_intent` and `accept_code` hand code work to reviewed Git adoption; `revalidate` requests fresh externally produced bound evidence. Deferral/rejection preserves inspectable history. The existing Release gates and immutable Releases remain in force.

An exactly approved legacy revalidate plan can use the separate [R1-C `drift revalidate` operation](REVALIDATION_R1_C.md) when a local Node host already supplies current named policy /3 authority and the trusted finite producer. That operation publishes a distinct completion for the full pinned scope and exact observation, preserving both the Release and accepted source binding. Approved plans and old fixture evidence remain historical `completion:false` records.

An accepted successor association requires a clean owner-created commit, a matching validated Release and the paired Git workflow's exact `git-finalization` record. A dirty apply receipt alone cannot become a new baseline. Arbitrary already-committed code acceptance without that completion proof remains an open reviewed plan in this slice.

## Reading a report

| Report field | Meaning |
| --- | --- |
| `source_changes` | Added/deleted raw artifacts, byte/length changes, Git mode/type changes. No source excerpts are retained. |
| `possible_renames` | Exact raw-hash deletion/addition hints, with ambiguity. No identity or mapping update is inferred. |
| `intent_changes` | Exact keyed-item fingerprint differences; `intent_record_changed` also records changes to record metadata/provenance. |
| `coverage.scope_complete` | Complete mapping/available artifacts for the explicitly selected scope. Excluded and unrelated app behavior remain unverified. |
| `coverage.acceptance_complete` | All declared active scoped criteria have compatible passing application results. It is distinct from source coverage. |
| `acceptance_changes` | Comparable bound outcome changes or an explicit `incomparable` result when source/intent/criterion/checker/fixture/oracle pins differ. |
| `behavior_status` | `unknown`, imported compatible results, bounded fixture results, reported outcome change or a demonstrated change for named mechanical fixtures. None proves whole-app equivalence. |
| `assessment` / `blockers` | Actual attention or coverage/evidence failure. Command `ok:true` means the report was created, not that code is equivalent or reconciliation completed. |

Git `git-acceptance` and `git-application-observation` share exact source/target/tree/checker/fixture/oracle bindings. To retain a failed or incomplete externally produced application packet, `git evidence --file F` accepts the existing `git-acceptance/1` packet with explicit `observation_only:true`; the host stores an observation with honest producer trust. An observation never grants code-apply eligibility. Application evidence import requires its own assigned producer and reviewers. Drift runs no arbitrary test command. Existing `validation` records are labeled compiled-profile evidence and do not measure an arbitrary Git application.

Local fixture identities and imported producer labels are not independent authentication. A fixed synthetic check can demonstrate a named observed outcome change; imported results report a claimed outcome change. Altering the oracle/checker or criterion makes old/new results incomparable. Finite passing checks cannot prove general semantic equivalence or complete extraction.

## Refusals, history and SDK

Changing any pinned bytes, HEAD, index, inventory, source/intent scope, evidence or proposal invalidates approval. Source capture rejects incoherent reads, unsupported transformed checkouts, symlink/junction traversal, gitlinks and unsafe/ambiguous paths. Ignored content is not read; tracked bound paths still get measured even if ignore rules change. New unmapped watched files, missing formerly-present artifacts and incomplete inherited criterion coverage are explicit blockers. Budgets fail with structured refusals and do not silently truncate a complete claim.

SDK service calls can classify explicitly imported observations and retain proposals, with `imported-snapshot` trust. They cannot create a locally accepted binding or approve a live-source plan without a trusted local host. Copying a `trust` field does not upgrade an import. Exact inspection and deferred/rejected review remain historical operations.

Records use the existing registry and content-addressed artifact store. JSON reports are projections. Portable backup retains source/drift/Git record closure and verifies it without a live checkout or present-day grants. An unresolved `GIT_APPLY_PENDING.json` transaction blocks backup; filesystem journals and host repository configuration are not portable authority. Restore remains inactive.

For fresh verification run the `source-binding`, `source-drift`, `source-drift-backup` and `source-drift-cli` test files after build. These use synthetic repositories and explicit fixture assignments. Architecture scope and acceptance gates are retained in [the implementation plan](DRIFT_RECONCILIATION_PLAN.md).
