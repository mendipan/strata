# Qualify the two existing local Git app routes

This Q1 slice reuses existing local v0.1 commands with the recognized `counter-fixture/1` template and `counter-application/1` checker. It accepts no user app directory or supplied executable. Every trial creates a new synthetic Git app, explicit fixture host/roles, independent intent store and retained command/evidence files. It does not add an engine endpoint, source interpreter, output bridge, arbitrary app harness or completion contract.

## Fresh checkout recipe

Use Node >=22, Git and a dependency-equipped checkout containing this slice. Obtain the source and dependencies using your approved provisioning; this qualification does not install packages or demonstrate a clean dependency download. `QUALIFIED_Q1_SHA` below is a placeholder for the reviewed checkpoint. Do not switch/reset an existing app checkout.

The retained qualification platform is Windows with PowerShell, Node 24.16.0 and Git 2.54.0.windows.1. Other platforms are not claimed qualified by these receipts.

```powershell
# In a new disposable Strata checkout:
git rev-parse HEAD # compare with QUALIFIED_Q1_SHA from the handoff
npm run build
node dist/scripts/qualify-existing-routes.js --help
$trial = Join-Path ([System.IO.Path]::GetTempPath()) ('strata-q1-selected-' + [guid]::NewGuid().ToString('N'))
node --import ./tests/no-external-fetch.mjs dist/scripts/qualify-existing-routes.js demo --route incremental --output $trial
Get-Content -LiteralPath (Join-Path $trial 'report.json')

$reconstruction = Join-Path ([System.IO.Path]::GetTempPath()) ('strata-q1-reconstruction-' + [guid]::NewGuid().ToString('N'))
node --import ./tests/no-external-fetch.mjs dist/scripts/qualify-existing-routes.js demo --route reconstruct_declared_scope --output $reconstruction
Get-Content -LiteralPath (Join-Path $reconstruction 'report.json')
```

The output parent must exist; the trial directory must be new and outside every existing Git repository. Existing output is refused without overwrite. No root is deleted by the demo. Preserve the entire trial for review; remove it later only after verifying it is the minted trial you intended. The qualification tests clean up only their own verified temporary test root.

Expected exits are **0**, report status `qualified_fixture_lane`, `host_closed:true`, two distinct validated Releases and `backup.inactive:true`, `backup.verified:true`. Source SHA, Node/platform, compiled qualifier hash, command arrays, assigned roles, raw stdin packets/stdout/stderr and their hashes, actual exits and durations are retained. Temporary paths, ports, Git OIDs and source-dependent semantic refs vary; the invariants below are deterministic.

## Selected delivery sequence and gates

The coordinator creates a recognized ceiling-six counter module, independent preserved positive/invalid tests, a text report, binary bytes, a baseline Git commit and an untouched history branch. These owner actions occur only in the synthetic app. App Git stores original/generated code, tests, assets, branches and commits. The separate Strata store retains intent, proposals, validations, approvals, source associations and native delivery history.

Through real CLI subprocesses it initializes intent; composes/measures/validates a no-change baseline; obtains separate scope and Release approvals; captures exact Git source; prepares and reviews a declared inventory and owned Layer; publishes with current-source checking; composes/measures/approves the ceiling-twelve change; associates the no-change accepted intent with the original app; and independently rematerializes both Releases. Interpretation remains `behavior_verified:false` and is separate from fixture execution/approvals.

The inventory capture includes test, binary and report preservation entries. The separate binding capture includes only the module and tests mapped to counter obligations; unrelated content remains outside the intent association. Current `source bind` refuses present captured entries that have no intent mapping. Both captures are retained as distinct refs; adding unrelated files to intent mappings merely to bypass that gate would misstate scope.

The selected lane then executes `git plan`, `git stage`, `git check`, exact `git review`, `git apply`, a separate fixture owner Git add/commit, `git finalize` and successor `source bind`. The owner commit must be the actual direct child with the exact reviewed result tree. The engine never implicitly stages, commits, checks out or pushes an app branch. The supplied patch changes only `counter.mjs`; test/text/binary/attribute bytes and the untouched branch are preserved. Original HEAD/index remain unchanged until the fixture owner commit.

Negative gates retain real command envelopes: the wrong actor is denied; dirty protected source refuses apply without selected writes; a fixed test-only write fault rolls back original bytes and Git pins; exact cached apply reuses its receipt; finalization before an owner commit refuses. The fault hook is hardcoded inside the synthetic coordinator and is not configurable from app data or operation packets. Retry the demo with a **new** trial directory; do not repair a failed retained fixture silently.

Expected recorded refusals are `wrong-actor: OPERATION_FORBIDDEN / 4`, `dirty-protected-source: UNSUPPORTED_CHECKOUT_TRANSFORM / 5`, `fixed-write-failure: STORE_UNAVAILABLE / 9`, and `no-owner-commit: UNSUPPORTED_CHECKOUT_TRANSFORM / 5`. The last case stops at the current raw checkout/clean-source precondition before inspecting commit parentage. The successful owner finalization separately checks the exact result tree and direct parent; do not describe the earlier refusal as a measured parentage failure.

Successful selected stop is `delivery.state:"owner-committed-and-natively-finalized"`, with actual application acceptance, owner commit, finalization and successor binding refs. This is the existing native local association contract. The report is a walkthrough trace; it does **not** introduce or attest a first-class reviewed adoption-publication-to-output bridge. `adoption_delivery_bridge_established:false` and `reconciliation_complete:false` remain explicit.

## Separate reconstruction lane

The same inventory/proposal path uses `reconstruct_declared_scope` and a declared boundary of only the fixed counter feature. It obtains a no-change accepted baseline and changed Release, measures independent exports with literal ceiling-six/twelve expectations and runs the preserved original tests. Original module bytes match the recognized baseline template; this is finite template qualification, not independent semantic extraction or arbitrary implementation equivalence.

Successful reconstruction stop is `delivery.state:"independent-reconstruction-qualified"`. Original app bytes, HEAD, index, branch and refs remain unchanged; no native apply, owner change commit, successor association or cutover is performed. Both lanes verify exact accepted Release/binding persistence after broker restart and a separate inactive backup. Backup verification restores no active identities or grants.

The distinction is tangible: selected delivery modifies one reviewed app path and reaches actual owner finalization; reconstruction creates separate output trees and preserves the original. Extraction/review contracts are shared. Whole-app completion, persistence/data/UI migration, general original-code testing and observed-commit acceptance remain unsupported.

## Roles, failures and external review

Fixture identities are public synthetic labels, not authenticated humans or agents. The fixed coordinator owns explicit assignments; each CLI call records its preassigned role. The deliberate wrong-actor negative case grants that actor no escalation. An external agent must use only its supplied role and stop on denial. No live credential, provider, owner activation or deployment is needed. Reports retain `execution_authenticated:false`, `automatic_extraction:false`, `universal_equivalence:"not-established"` and no reconciliation completion.

On nonzero exit, preserve `report.json`, the last command's raw stdout/stderr, original app and state directories. A failed draft/measurement or inactive archive is not validated behavior. No app path outside the newly minted trial is accepted. Missing Node/Git/dependencies, unsupported raw checkout behavior, engine refusal or bounded subprocess failure is an honest stop.

Run engineering verification with:

```powershell
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/existing-route-qualification.test.js
```

External tester prompt:

> Follow one named recipe from a new approved checkout. Record its source SHA, command exits, exact refs, retained files and failure gates. Compare original and final Git/byte pins. Explain which actor performed the app commit and where the workflow stopped. Do not infer a bridge, authenticated execution, migration or completion from this walkthrough; do not contact providers or use a real app to compensate for an unsupported step.

File-only proposal author prompt:

> Given the exact source capture, accepted no-change baseline and supported counter contract, prepare a declared inventory and owned Layer for ceiling six to twelve. Preserve positive integer/atomic rejection semantics and untouched tests/text/binary paths; label observed/inferred/excluded/unknown behavior. Return reviewable JSON only. No source execution, identity switch, publication, approval, app writes or arbitrary app/profile claim.

Owner review prompt:

> Review exact source/inventory/proposal/draft and lane. Keep interpretation approval, fixture measurement, semantic Release, patch review, app owner commit and association distinct. Require fresh Git/app pins and actual preserved/new observations. Stop at the recorded gate. Source/output bridge, R1 completion and V1 hosted/native parity require their separate approved contracts.

No B2-H or Studio/settings implementation is duplicated: all qualification source files are new; Core/profile/runner/service/CLI/backup/auth/UI schemas and settings remain unchanged. Parent arranges independent review and publication after a frozen candidate is qualified.
