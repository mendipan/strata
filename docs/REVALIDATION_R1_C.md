# Authoritative local revalidation (R1-C)

`drift revalidate --file REQUEST --idempotency-key KEY` is protocol-1 `drift.revalidate`. It completes an **existing exact approved v0.1 revalidate plan** for its full declared selected scope. It retains an authenticated execution run, explicit criterion assertions and a separate completion in one local Node registry transition. The accepted Release, source binding, owner files, index and HEAD remain unchanged. Historical R1 receipt validation still returns `completion:false`.

## Request and authority

The strict request contains `review:{ref,sha256}`, `basis_evidence:{ref,sha256}`, `expected_observation_sha256`, and `criterion_reviews:[{criterion_ref,accepted:true,rationale}]`. Every selected review criterion needs exactly one explicit assertion. Mechanical criteria cannot appear in that array. Client actor/trust/results/commands/paths/proof flags are rejected. Use exact inspection or review to read the pinned inputs before submitting assertions.

The local Node broker must already have a configured `HostIssuer` named session, local Git repositories and an enabled trusted producer. `strata-host-policy/3` retains policy /2 lifetimes and adds optional explicit grant scope:

```json
{
  "repository_ids": ["EXACT_REPOSITORY_ID"],
  "read_roots": ["EXACT_RELATIVE_ROOT"],
  "inventory_roots": ["."],
  "checker_ids": ["counter-application/1"],
  "block_ids": ["EXACT_SELECTED_BLOCK_ID"],
  "review_criterion_refs": ["EXACT_BLOCK/acceptance.EXACT_CRITERION"]
}
```

This is the shape of the optional `revalidation` field, not an access provisioning command. No field means deny. Repository inventory permission includes `.` because the existing coherent Git observation enumerates repository metadata and verifies outside-scope dirtiness. Every physical path read, including preserved and outside-scope regular files, still needs its read-root grant. Scopes reject duplicates. Existing /1 and /2 policies do not accept new operation names or fields.

The same named principal must be the historical approved reviewer and a current selector of the accepted baseline's responsible scope. Require `drift.revalidate`, internal `revalidation.run`, and, when needed, internal `revalidation.criterion-review`, plus all selected Block/repository/read/inventory/checker/criterion scopes. Internal actions are not public endpoints or advertised command capabilities. Expiry includes session and grant bounds. Parent session liveness, credential epoch, account/policy generations and repository/checker configuration are rechecked; a change after admission invalidates the attempt. Fixture selectors, unbound owner sessions and imported labels cannot authenticate execution.

No setup, account enrollment, live grant changes, Studio workspace activation, external provider or deployment is included. Use of an already configured named session through the local CLI transport remains host supplied. Remote artifact stores, SDK execution, v0.2/v0.3 and adoption plan /2 remain unavailable.

## Execution and transaction

The reusable context, records, authority, worker lifecycle and transaction machinery live in `revalidation.ts`, `revalidation-node.ts` and `revalidation-worker.ts`. The trusted producer registry is separate. Its only initial producer is `strata-node-git-revalidator/1` in `revalidators/counter.ts`, wrapping the existing compiled `counter-application/1` checker and `counter-fixture/1` recognizer. Other applications require a separately reviewed trusted producer; generic engine code contains no counter semantics.

The producer requires exact recognized accepted module bytes and the retained reviewed oracle. It imports only copied immutable in-memory bytes in a new fixed worker. It runs no repository script, package hook or repository import. Limits are 5 seconds, 64/16 MiB V8 generations and 256 KiB IPC. Success, error, crash, interruption and timeout paths terminate and await the worker. This is a finite recognized-code lane, not a general security sandbox.

The whole Git observation is compared before execution, after execution and late in publication: HEAD/tree, raw index, selected bytes/modes/presence, manifest, status, inventory/counts, scope, coherence and limitations. Stage manifest must match; dirty HEAD tree may differ from stage tree. The only initial regression is `unrelated-byte-preservation`, derived from retained verified base/stage and measured preserved entries. Unknown regressions refuse. Review acceptance uses current explicit assertions; the counter fixture's `intent.review` label is discarded.

All new records have strict literal v0.1 formats and full digest refs:

- `revalidation-auth` / `strata-revalidation-auth/1` binds the exact canonical action input and outer request, unique server attempt, current authority and bounded expiry.
- `git-revalidation-run` / `git-revalidation-run/1` retains exact source/contract/checker inputs, observations, mechanical results, regressions, timestamps and runner assets.
- `revalidation-criterion-review` / `revalidation-criterion-review/1` retains the full explicit assertion array and its own action receipt; absent for zero review criteria.
- `reconciliation-completion` / `reconciliation-completion/1` binds all predecessors, final observation, unchanged Release/scope, conservative outcome and inherited limitations.

The derived nested `revalidation-bridge/1` records historical fixture review/basis provenance separately from current named authority. Historical basis is contract only. A private single-use in-process execution proof is required by the final publication guard; serialized labels or a copied nonce cannot manufacture it.

The broker stages/syncs artifacts and registry temp before the final awaited source capture, refreshes authority, then guards and synchronously renames without an intervening await. It additionally synchronously checks root/Git directory identities, selected physical bytes and the raw index at that boundary. Registry index, original-key result and commit audit publish together. Unindexed artifacts are not completion. No additional job ledger or automatic orphan/lease repair exists.

Durability follows existing local platform limits: artifact and registry files are synced, and directory sync is attempted on supported non-Windows platforms. Windows registry rename does not establish power-loss durability. Renamed-but-durability-uncertain results direct the operator to inspect the original key. Cooperative measurements cannot prevent hostile external writes after the last read; completion certifies the measured source at publication, not future state or whole-app correctness.

## Replay, history and portability

Same committed key with the same normalized request returns the same receipt after current authority and source checks, with no new worker. Changed input conflicts; changed source or revoked authority blocks replay. New keys perform new execution and may yield identical deterministic observation digests. The standalone historical R1 validator's differing-digest rule is unchanged.

Replay also requires the committed account/principal/credential epoch, account and policy generations/digests, scoped grant, responsible scope and repository configuration identity to remain exact. A new session and its refreshed expiry are allowed after restart. The runtime repeats its synchronous live/interrupt guard after the last awaited replay work and the broker refreshes authority and guards again immediately before returning the cached result.

`operation inspect KEY`, exact completion inspection, `review reconciliation-completion REF` and `review state REF` can show historical completion under current read permission. These projections use `live_source_checked:false`. A broker restart needs a fresh configured session; original-key replay recovers a committed lost response. Before commit there is no indexed completion. A process crash may leave an existing cooperative state lease or staged orphans requiring separate explicit operator handling; this command does not steal leases or repair them.

Projects containing R1-C records export `strata-local-backup/3`, with the explicit `authoritative-revalidation-v0.1/1` discriminator, typed historical closure and archived runner/checker/fixture/recognizer/oracle descriptor data. Projects without R1-C retain /1 or /2 output. Offline verification checks digests, complete joins, exact actions/attempts/authority correspondence, mechanical observations and explicit assertions without executing archived source or checking live accounts/Git. It reports historical completion verified and both live authority/source unchecked. A trusted checksum manifest supplies archive integrity, not independent execution proof against a malicious host.

The counter producer's pure verifier checks exact passing measurement fields and values against the accepted oracle and fixed fixture, including total 2 for two unit additions, the accepted ceiling and the exact invalid-input inventory. Generic history verification requires run authorization expiry to cover execution start/finish and all required action receipts to remain valid through the recorded completion time. Run receipt issuance can follow worker execution, as it does in this implementation; it is not required to precede worker start.

Restore remains isolated and inactive, excluding credentials, protected configuration, root paths, active keys and sessions. Historical request results confer no active request cache or rights. No restore activation is performed.

## Validation

The focused `revalidation`, `revalidation-gates` and `revalidation-worker` suites use disposable Git repositories, synthetic named accounts and actual fixed-worker execution. They cover deterministic equality, repeated requests, authority/read scopes, stale HEAD/index/inventory, worker failure/interruption, source and final-boundary races, single-use proof, staged failure, committed response loss, fresh-session restart, history substitutions, generated schemas and inactive backup /3. Run built tests with the no-external-fetch guard and concurrency 1. Existing source/Git, historical R1, named workflow/gateway, broker/recovery and backup suites remain compatibility gates.
