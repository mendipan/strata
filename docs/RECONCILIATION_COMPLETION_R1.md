# R1 revalidation completion contract preparation

This is the bounded first R1 slice: a standalone strict receipt schema, historical validator and deterministic synthetic refusal fixtures. It supports only `revalidate` under the existing local v0.1 record formats. It does not enable runtime reconciliation completion. Existing [DRIFT1 approved plans](SOURCE_DRIFT.md) continue to return `completion:false`.

The separate [R1-C named local revalidation operation](REVALIDATION_R1_C.md) adds authenticated finite execution and durable completion under explicit current policy /3 grants. It preserves this historical validator's schema, differing-digest rule and `completion:false` result; its new runtime records do not upgrade historical fixture evidence.

The accepted [drift plan](DRIFT_RECONCILIATION_PLAN.md) separates plan approval, fresh named evidence, Git delivery and successor association. [Source binding](SOURCE_BINDING_CONTRACT.md) still requires the existing exact `git-finalization/1` gate for successors. Accepted S0 named authentication, current permissions and shared command contracts are retained; this historical seam issues no S0 authority and accepts no v0.3 reinterpretation.

## Contract and reviewable boundary

[The module](../src/reconciliation-completion-r1.ts) exports `r1CompletionReceiptSchema`, `r1CompletionExpectationSchema` and `validateR1CompletionReceipt(receipt, records, expected)`. Invalid contracts throw existing `StrataError` refusals. A valid result contains `valid:true`, `validation_only:true`, `completion:false`, `source_binding_advanced:false`, `behavior_verified:false`, the receipt digest and the unchanged recorded evidence producer/trust.

The caller supplies the selected project/repository, approved review pin, named basis-evidence pin and observed-source digest separately from the receipt. These inputs must come from the caller's review context. Copying them from an untrusted receipt establishes no independent selection or authority. Historical integrity cannot prove today's grant, revocation state or physical checkout freshness.

The candidate receipt uses `reconciliation-completion-receipt/1`, a literal v0.1 model and a single `revalidate` action. It pins the exact proposal, approved review, report, accepted source binding and unchanged accepted Release (ref, record hash, snapshot hash and candidate fingerprint). It includes the exact recorded source observation; HEAD, tree, index, bytes, inventory, status and trust changes invalidate the reviewed input. It requires the full declared selected item/path/criterion scope in this first slice. Scope limitations and unvalidated bootstrap association remain in retained history; revalidation does not upgrade them.

The named basis application evidence must already occur in both the approved proposal and its report. This fixes the acceptance contract, checker/version/bytes, fixture, independent oracle and recorded producer/trust before revalidation. A plan without those pins needs a new exact proposal/review; the validator does not invent a contract after approval. Checker or oracle changes cannot reuse the old approval.

Fresh evidence is an existing exact `git-application-observation/1` or `git-acceptance/1` packet with retained published legacy `git-change-plan/1`, stage, base source and target closure. Versioned adoption bridge contracts and private bridge lineage remain unsupported by this first receipt seam. It must have a distinct ref and observations digest, the same reviewed plan/stage/tree/manifest/acceptance contract/checker/producer, and exactly one passing result for each active selected criterion plus every frozen regression. Review rows require recorded labels; mechanical rows cannot invent one. Both `local-fixed-fixture` and `local-fixture-import` remain `execution_authenticated:false`. Different bytes establish a distinct retained observation packet; they cannot authenticate that a new execution occurred.

The stage tree names the reviewed staged implementation. On dirty source it need not equal the observed HEAD tree; the exact selected raw-byte manifest and complete observation are retained separately. No owner commit is inferred from either. `git_finalization_ref` and `successor_binding_ref` must be null. Owner-commit, completion/authority claims and unknown fields are refused.

The validator copies and bounds the selected transitive closure, verifies published content-addressed source/drift/Git records and recomputes the existing historical source, drift and Git acceptance gates. It reads the original records without modifying them. It invokes no source host, disk measurement, runner, command dispatcher, broker, provider or Engine publication. The receipt is a candidate contract document, absent from the Engine/service/backup runtime record maps.

Retained semantic predecessors also require their strict legacy schemas, explicit v0.1 model, normalized records and exact named/digest identities. Pure Engine evaluation recomputes candidate fingerprints for historical realizations/validations, checks their retained profile/evidence bindings, and verifies that a validated Release preserves its candidate's snapshot, provenance, obligations, lineage and endorsements. Mutating a bootstrap, Composition scenario or Layer cannot pass under unchanged receipt/expectation pins. This verifies retained history without re-running application tests or granting current authority.

## Reproduce the focused checks

Use installed locked dependencies and Node 22+ in an isolated checkout:

```powershell
npm run build
node dist/scripts/schemas-r1.js
npm run typecheck
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/reconciliation-completion-r1.test.js dist/tests/source-binding.test.js dist/tests/source-drift.test.js
npm run check:links
```

[The standalone JSON schema](../schemas/reconciliation-completion-r1.schema.json) is reproducible with [the separate generator](../scripts/schemas-r1.ts), without changing the runtime schema map. [Synthetic fixtures](../tests/fixtures/reconciliation-r1/README.md) cover positive mechanical/review/imported controls, plan-only reuse, exact-pin substitution, missing/unpublished closure, stale source, checker/fixture/oracle/trust substitutions, missing/duplicate/unknown/failed criteria or regressions, copied reviewer labels and fabricated finalization/commit associations.

## Remaining R1 gates and review handoff

Independent contract review and integration remain required. Runtime completion persistence/dispatch, current authority and late source freshness, authenticated fresh execution, action-specific `accept_code`/`restore_intent`/`update_intent` contracts, subset-scope semantics, already-committed owner-code association, portable completion backup registration and v0.3/native parity remain open. Defer/reject are dispositions, not completion actions. This slice adds no dependency on B2-H, Studio activation, finite E1 or an owner manual run.

Any later design that accepts arbitrary owner commits or adds new authority/dispatch needs its own owner/architecture decision. This preparation deliberately keeps those questions open. Review this module, schema and fixtures as one immutable patch before runtime integration or push; passing these tests does not close broad R1.
