# Content/assets slice 1 — local milestone

The bounded content/assets implementation follows the [design plan](CONTENT_MEDIATION_IMPLEMENTATION_PLAN.md). [Mediation](MEDIATION_SLICE2.md) supplies the separate versioned selection, approval and Release path.

The value under test is reducing unnoticed intent drift and regressions: inherited obligations remain visible, changed exact content invalidates reviews/evidence, and changed asset bytes invalidate pins. These deterministic checks do not demonstrate general bug prevention, model comprehension or superiority over RAG. The independent [drift/regression plan](DRIFT_REGRESSION_TEST_PLAN.md) contains broader checker/coverage/runner issues for the next separately scoped pass.

## Available behavior

| Path | Implemented boundary |
| --- | --- |
| Explicit v0.2 content/1 | Nine required Block fields; plain-text/1 descriptions; structural code-form/byte checks; nondotted item keys; finite scalar booking parameters; requirement acceptance minimum; inherited acceptance cannot silently disappear. |
| Authoring | Supplied exact normalized Layer bytes, assigned review operation, immutable project/digest/checklist-bound review, exact review ref required for Block-changing publication. No new private-draft browsing rights. |
| Node assets/1 | Offline one-file PNG/baseline-JPEG import, acknowledgement/provenance/rights, server-bound importer, exact descriptor/blob hashes, retained logical history, bounded binary ByteStore and atomic index/audit commit under cooperative lease. Default import denied. |
| booking-node/2 | Exact candidate/profile/output binding plus a background retention manifest. Background bytes remain outside executable resources. Unknown normative intent still fails the bounded profile. |
| Recovery | Versioned backup2 verifies all retained public/private descriptor/blob/review closure; strict inventory/hashes, limits and inactive restore remain. Backup1 continues for v0.1. |
| Migration | Exact source Release/digest preview, preserved obligations, empty description/asset additions, explicit blockers and `applied:false`. No active-project apply or authority/policy changes. |

The [Block contract](BLOCK_CONTRACT.md) lists precise limits and honest validation restrictions. Asset structure checks are not full decoder or malware certification. Text screening cannot prove arbitrary prose contains no code; explicit human/assigned-agent review remains necessary. All review/evidence identities are local fixtures. No new hosted identity, credential or persistent end-user operation grant was created.

## Opt-in host and CLI example

Keep existing projects on their explicit model. For a **new isolated local fixture** the trusted host calls `startLocalBroker(newStatePath, port, {model_version: CONTENT_MODEL, issuer})`. The issuer may receive constructor-only assignments for `content.review` and `assets.import` when separately approved for that fixture. No CLI/RPC grant endpoint exists, and default fixtures deny those operations. No actual user project was migrated or restored in this milestone.

The standalone broker accepts explicit `STRATA_MODEL_VERSION=strata/0.2-content-mediation-experimental` and `STRATA_STATE_DIR` for a new state; its default issuer still supplies no review/import grant. Its project must match the host's configuration. A trusted host can instead run the constructor API with its exact project ID and assignments. Build first; configuration and task packets must pin v0.2 and `booking-node/2` explicitly.

Process argument examples, appended with `--project PROJECT_ROOT --json --non-interactive --offline`:

```text
node CLI init --file examples/bootstrap-content-v2.json
node CLI layer create --file examples/L-content-v2.json
node CLI content review --file examples/content-review-v2.json
node CLI layer publish L-content-v2@1 --authoring-review EXACT_REVIEW_REF
node CLI assets import --file EXPLICIT_LOCAL_SYNTHETIC.png --metadata examples/asset-import-v1.json --state-dir .strata/new-v2-state
node CLI assets inspect EXACT_ASSET_REF
node CLI materialize EXACT_ELIGIBLE_COMPOSITION --profile booking-node/2 --out .strata/new-v2-output
node CLI migration preview EXACT_V1_RELEASE --source-digest TRUSTED_SOURCE_RECORD_SHA256
```

The host supplies each command's assigned selector; an author must not switch identities to recover a denial. The asset command is offline, requires its state broker to be stopped, and imports only the one explicit local source. Review input must use the exact normalized draft digest returned by inspection/host sharing; the checked-in review input pins its checked-in example, not future edits. Add `--dry-run` for observed-only import preview. Copy the accepted descriptor/hash into a new owned Layer's `asset_refs.KEY`; retain `role:background` and `subjects:[]`. The migration example runs against a v0.1 project and returns a proposal only.

This content/assets slice alone does not implement mediation. The [mediation contract](MEDIATION_SLICE2.md) supplies the v0.2 Resolution/Approval/Release gates. PDF/video processing, remote download, asset deletion and SDK binary retention remain unsupported. `UNSUPPORTED_ASSET_BACKEND` identifies the missing binary store; `UNSUPPORTED_ASSET_ROLE` identifies later asset roles; v0.2 semantic sealing returns `UNSUPPORTED_CAPABILITY` until mediation/1 exists.

## Deterministic evidence

`tests/content-assets.test.ts` and `tests/content-cli.test.ts` use isolated temporary state and synthetic PNG/JPEG bytes. Sixteen new cases cover version separation, prohibited structures/limits, inherited-obligation retention, assigned exact authoring reviews and stale reviews, descriptive-content fingerprint changes and stale evidence, disabled mediation, bounded image validation, operator denial/lease/dry run/version history, wrong asset hashes/projects/backends/roles, non-executable retention manifest, backup2/inactive restore closure, pure migration preview, background/normative separation, quota/descriptor bounds and actual CLI routes. Run these tests for current results.

See [local verification](VERIFICATION.md) for build, typecheck and aggregate commands.
