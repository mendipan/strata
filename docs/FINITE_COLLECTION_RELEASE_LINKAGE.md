# Finite comparison linked to local accepted Releases

This continues IMPLEMENTATION_PLAN E1 at accepted base `01bfef4fd781f8c96d00b4ac852fecd6411adde8`. It is a read-only prerequisite for later reconciliation, using the existing Engine/profile/validation/approval contracts. It introduces no service operation, grant, persisted schema, hosted authentication, source binding, acceptance importer or completion record.

The [compiled local module](../src/acceptance/collection-release-linkage.ts) accepts an active in-process v0.1 Node fixture Engine and exact project/baseline/changed Release refs plus full digests. It rejects serialized Engines, inactive histories, SDK backends, other models and bootstrap records. Ordinary Core validation and Release gates are replayed on a disposable copy, including exact evidence, approvals, obligations/provenance and accepted record identities. The live Engine is read only and must remain quiescent; concurrent semantic writes refuse linkage. Paths, pins and declared scope are copied before asynchronous work so caller mutation cannot erase unknown coverage. The changed Release must directly descend from the named accepted baseline.

Each file export must be a separately registered rematerialization of its exact Release, not merely a manifest with matching labels or hashes. The module verifies the manifest against retained records before reading declared output files. It pins the actual manifest bytes and expected target, candidate, profile, tree, oracle and file hashes/lengths. It then runs the existing [fixed original-versus-reconstruction harness](FINITE_COLLECTION_ACCEPTANCE.md) freshly, requires the returned measured input pins to match those exact verified exports, and rereads semantic state and exports afterward. A manifest changed for measurement and then restored cannot establish linkage, including changes only to formatting. It accepts no saved comparison receipt as proof.

## Run without browser pairing

Use Node >=22, Git and an existing dependency-equipped checkout. Run from its root. The parent of the new trial directory must exist. No install, network, credentials, owner setup or live grants are required:

```powershell
npm run build
node dist/scripts/collection-release-linkage.js --help
$trial = Join-Path ([System.IO.Path]::GetTempPath()) ('strata-release-linkage-' + [guid]::NewGuid().ToString('N'))
node --import ./tests/no-external-fetch.mjs dist/scripts/collection-release-linkage.js demo --output $trial
Get-Content -LiteralPath (Join-Path $trial 'linked-evidence/release-linkage.json')
```

The [demo](../scripts/collection-release-linkage.ts) creates only a new synthetic original Git fixture and provisional intent outputs. A separate in-memory local Engine performs two ordinary semantic workflows: no-change baseline Composition, measured fixture validation, separate scope/Release approvals, accepted baseline; then owned count-change Layer, publication/Composition, new measured validation, new separate approvals and accepted descendant Release. Both Releases are independently rematerialized and registered before the fresh comparison. Fixture role names are public synthetic labels, not human or hosted authority.

Expected exit is **0**, status `passed_declared_scope`, `records_verified:true`, `store_unchanged:true`; the separate comparison has **14/14** checks passed. `acceptance_elevated`, `approval`, `release_created`, `reconciliation_complete` and `execution_authenticated` remain false. Existing fixture Releases were accepted through their ordinary gates before linkage; the linkage creates none.

Retain the whole trial directory. Original Git, provisional outputs, two separate fixture-measurement files, accepted independent exports, exact Release pins and the inactive `historical-semantic-store.json` remain separate artifacts. That saved store is evidence only; the module has no archive-loader/activation path. `linked-evidence/receipt.json` retains original Git/runtime/log/vector measurements. `release-linkage.json` pins its digest and the accepted baseline/change Composition, selected Layers, validations, measured fixture evidence, approvals and registered exports. The local Engine trust boundary remains explicit; these are not independently authenticated records.

## Failures and residual gates

Unknown or uncovered application scope remains **incomplete**, even if semantic records verify and every fixed comparison passes. Failed/refused comparisons keep their status. A changed semantic store or export during execution produces a refused linkage sidecar; the separate comparison receipt remains historical evidence of what it measured. Nothing creates approval or completion. Preflight failure throws before creating comparison evidence. Retry requires a new empty evidence directory and exact freshly checked inputs; no automatic app repair, Git commit or semantic rewrite occurs in linkage.

The supported boundary remains the independently authored fixed Array original and exact `collection-node/1` 3/20 baseline versus 5/20 changed module. Finite vectors do not establish arbitrary equivalence, exhaustive behavior coverage, persistence, UI or migration. Original source-to-intent association and adoption-publication linkage are explicitly `not-established`.

G2 adoption-to-delivery still requires the reviewed binding contract specified in GAP_PLAN. The current automatic native Git application checker is counter-only; this slice does not extend it to collection or arbitrary source. R1 completion still needs the action-specific source/acceptance/final-state linkage and current authority/freshness contract. Those dependencies must not be replaced with this read-only sidecar. No substantial unresolved decision was needed for the present prerequisite.

Ownership is new-only: `src/acceptance/collection-release-linkage.ts`, `scripts/collection-release-linkage.ts`, `tests/collection-release-linkage.test.ts` and this document. Core, CLI/service/schema/backup, profiles, browser owner, hosting and security configuration are unchanged. Parent review and integrated aggregate testing remain required before main publication.
