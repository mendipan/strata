# Persistent hosted workspace

This opt-in development mode preserves a complete existing v0.1 project and adds named draft authoring with durable Artifacts storage. It supports ordinary Layer create, revise, restore and publish, Composition, conflict reporting and context selection. It does not authenticate historical fixture reviews or complete the review → Release → materialize → measured behavior loop. Hosted approval, evidence, validation, new Blocks, Release and application Git remain unavailable for this model.

The existing CLI's local fixture workflows and separate named-account v0.3 host remain separate paths. Workspace owner cookies are not exported into CLI credentials. Choosing a different project/model, assigning release roles or migrating history is an explicit design and owner decision.

## Configuration and custody

`scripts/studio-host.ts` accepts an explicit `workspace` object only with an already sealed `browser_owner`. It is mutually exclusive with shared reader keys, managed sources and the legacy connection/budget triplet. Required fields are `grant_file`, `actor_accounts_file`, `actor_policy_file`, `import_file`, `broker_state_directory`, `budget_directory` and `control_directory`. Optional `provider_identity_file` is required for writes and write-token tests. It holds either the stronger identity proof or the explicitly selected development acknowledgment described below. Paths must be canonical, distinct and disjoint from owner, key and credential paths.

Root-controlled files bind one installation owner, one fresh stable person account/principal, exact project/model/repository ID, exact Block/operation scope, complete writer import and finite cumulative allowance. `strata-host-accounts/2` and `strata-host-policy/2` are additive formats; existing /1 formats retain their expiry requirements. Repository lifetime is explicitly `until-revoked` with `expires_at:null`, or a finite `until` deadline. Sign-in sessions remain finite.

Only a complete quiescent authoritative writer export is accepted. It includes exact immutable bytes/locators, publication flags, private heads, contexts, retained request results and asset closure. A published read export cannot fabricate private writer state. The service never initializes a missing import, ledger, control, cache, owner or account. Initial state must be prepared once by a separately reviewed operator adapter with an approved single-writer cutover and protected consistent backup.

`prepareWorkspaceCutover` and `checkWorkspaceCutover` in `src/explorer/workspace-cutover.ts` are pure functions. They bind source custody hashes and carried spending, preview initial state, and refuse any changed packet. They perform no activation or filesystem/provider mutation. A concrete external operator action remains required.

## User flow and authority

Owner sign-in → explicit Connect repository → explicit Use authoring access → Open project → choose an exact Release. Owner and actor use separate protected cookies and CSRF values. Parent owner logout, password/recovery, credential changes, account/policy changes and session deadlines invalidate actor access. Cached private reads check current grant/control/session authority.

Settings metadata performs no provider request or credential value retrieval. The saved token is managed through the existing protected owner form. Saving it assigns neither a project grant nor authoring authority. Connect resumes the same approved grant; Pause retains it; Revoke access permanently tombstones it. These actions never reset spending.

Explicit Test read access checks exact repository metadata. Explicit Test write access issues and revokes one short-lived owned repository token without pushing dummy content. Only the latter qualifies the current encrypted credential generation for draft writes. A passed test is not end-to-end publication evidence. Lost test/control responses require checking the same retained request, with no automatic mutation retry.

## Accounting and provider boundary

The new `strata-studio-io-budget/2` ledger carries prior spending and counts every REST/Git HTTP attempt, including cleanup. Transfer accounting is outgoing body bytes plus the reserved maximum incoming body, excluding HTTP/TLS framing. Failures and unused cleanup reservations remain counted. There is no refund, restart reset, refill or automatic lease reclamation.

Configured ceilings are finite: one admitted mutation, four queued requests, at most 4 MiB of new payload, 16 MiB operation transfer, 50 work requests and two separately reserved cleanup attempts. Exact batch request/transfer bounds are checked before mint. Exhaustion, corrupt established state, stale leases or full journals fail closed.

The Node port uses only exact repository metadata/file reads, short-lived repository token issue, immutable smart-HTTP Git batches and deletion of its own known tokens. No repository listing, creation, deletion, fork, import, default-branch update, force push or native Git is exposed. Secrets remain server-side and are excluded from URLs, persisted journals, errors and browser storage.

Public Artifacts documentation does not establish a conditional immutable-ID mint/push contract across same-name repository replacement. The default remains the stronger prerequisite: root-bound provider clarification or a separately approved disposable test must establish immutable token binding. Synthetic tests do not prove that guarantee. The separate [development provider contract](DEVELOPMENT_PROVIDER_CONTRACT.md) permits an exact owner-approved development repository to use the standard name-addressed connection with an explicit no-delete/recreate/rebind rule. This contract does not claim immutable token binding. Missing, mismatched or wrong-mode evidence blocks writes before credential/provider access. Broader upstream token resource scope requires a separate owner decision.

## Commit and recovery

The canonical private index contains the result, scoped request key and `strata-studio-write-commit/1` provenance in one replacement. Its payload digest excludes provenance and audit fields, avoiding recursion. Provenance binds actor/grant/policy/control/credential generations, created/published refs, verified artifact-stage hash and retained I/O receipt.

Dry runs use current actor/control/read authority but never stage or publish a mutation, require write-token qualification, retain a mutation intent, or consume a request key. With a complete verified cache they leave the index, journal, allowance and provider counts unchanged. A subsequent explicit real write may use that same key or a new key, including after a cold restart. Studio transmits generation/policy preconditions only in the broker headers; its strict operation body contains supported envelope options only.

After staging/read-back/owned-token cleanup, the broker fsyncs the pending index, refreshes authority, then synchronously guards, renames and fsyncs the directory. A renamed index whose directory fsync fails retains its receipt and returns uncertain durability; it blocks fresh writes. Secondary journal failure after commit reports a persistence warning and does not repeat the mutation. Current-authority replay returns the committed result with no new provider work.

Explicit trusted `WorkspaceRuntime.reconcileCommitted` can validate and fsync an already canonical committed index, then repair its lagging journal without provider calls. It cannot publish from a journal alone. Lost mint/push responses or unindexed stages remain blocked for authenticated external operator reconciliation. This candidate deliberately provides no automatic staged resume, guessed token cleanup, unknown-response retry or payload rollback. The retained operation status reports uncertainty rather than `not_found`.

Rollback after a provider stage or index commit must retain index, journal, accounting and control lineage. An older binary that cannot read them must serve maintenance rather than restore an old snapshot or counters.

## Qualification and full-loop gap

Synthetic native/HTTP/browser checks establish local mechanisms only. Independent immutable review, Linux custody/lease/fsync/crash/resource tests under the existing service limit, the selected real provider contract and permission qualification, full authoritative export and action-time owner cutover approval remain rollout gates. No candidate build authorizes a live account, grant, deployment or repository mutation.

For the user's complete Strata goal, the next design decision is authentic review/evidence/Release support for the existing legacy project, or an explicitly chosen versioned continuation that preserves its provenance. The subsequent implementation must exercise real create/distill → owned Layer change → independent review → approved Release → materialize → measured behavior, through truthful CLI and Studio paths. Storage success or a scripted example cannot substitute for those missing capabilities.
