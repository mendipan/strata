# Local adoption preparation, review and publication

This path persists a human/agent-prepared interpretation and freezes its owned Layer only after current source is measured by the configured local Node Git host. It supports v0.1 intent and local fixture assignments. It does not execute an agent, infer arbitrary application behavior, verify semantic equivalence, materialize an arbitrary app, or provide hosted v0.3 Git authority. Studio browser bootstrap and hosting are separate work.

## Prerequisites and trust

Use Node >=22, Git, installed repository tooling and a checkout containing A2. Run the broker through the trusted `startLocalBroker` API with its `git` option: repository root/project/repository ID, a separate Git-state directory, and an explicit fixture issuer assignment. Intent state and Git-state must be outside the application repository. The ordinary `npm run broker:node` does not configure these grants or a Git host; it cannot complete this workflow.

The assigned owner needs `source.capture`, `adoption.prepare`, `adoption.review`, `layer.publish`, relevant read operations, the exact Layer/Block scope and explicit repository/path grants. `init` remains the separate bootstrap operation. No default adoption/source grants are added. Public fixture selectors are impersonable by a local process and do not establish production identity.

Interpretation review is an explicitly granted owner assertion. It is separate from independent behavior acceptance, responsible scope approval and Release. Changes to the fixture authority binding conservatively invalidate pending interpretation reviews, including changes to other fixture assignments. No authority is supplied by an inventory's author field or a client freshness flag.

## Starting artifacts and source of truth

Start with a clean, committed Git checkout, an existing exact Strata baseline, a native `source-snapshot/1` captured by that host, an inventory and a normal owned Layer. The owner selects the declared scope. A person or separately authorized agent prepares semantic units against the captured file hashes; the owner reviews observations, inference, dependencies, outside units, exclusions and questions. Preparation is a proposal, never validated behavior.

Git remains authoritative for the existing implementation, tests, branch and commits. Strata retains the baseline, proposed intent, private interpretation records and measured publication history. They coexist. A published Layer remains a proposal for selection; it does not replace the Git application or claim that code conforms. Strata does not commit, branch, push, modify the original application, or change its index in these operations.

Generated code remains a separate realization, requiring an explicitly supporting finite profile and its independent evidence/approval/Release gates. A2 does not preserve arbitrary original code by rematerialization and does not automatically connect its inventory to the existing accepted `source.bind`/Git patch delivery contract.

## Exact command sequence

Set `PROJECT` to the caller's configured intent workspace; `CLI` is the built `dist/src/cli.js` from the tested checkout. JSON filenames below are placeholders the owner supplies. The trusted host sets the already assigned session; do not choose a new identity after denial.

```powershell
node $CLI status --project $PROJECT --json --offline
node $CLI source capture --file capture.json --project $PROJECT --json --offline --idempotency-key capture-1
node $CLI adoption prepare --file prepare.json --project $PROJECT --json --offline --idempotency-key prepare-1
node $CLI inspect adoption-proposal PROPOSAL_REF --project $PROJECT --json --offline
node $CLI inspect adoption-inventory INVENTORY_REF --project $PROJECT --json --offline
node $CLI inspect layer DRAFT_REF --project $PROJECT --json --offline
node $CLI adoption review --file review.json --project $PROJECT --json --offline --idempotency-key interpretation-1
node $CLI layer publish DRAFT_REF --adoption-review REVIEW_REF --project $PROJECT --json --offline --idempotency-key publish-1
node $CLI inspect adoption-publication PUBLICATION_REF --project $PROJECT --json --offline
```

Replace uppercase refs with exact returned values. `capture.json` uses the existing native shape `{repo_id,scope,expected_head?}`; scope is `source-scope/1`, with selected paths, watch roots, exclusions, item mappings, criteria and limitations. Clean bytes must equal raw committed bytes; checkout transforms, links, submodules, dirty/untracked content and unsupported paths are refused. Native inventory/path/byte budgets apply. Protected and dependency paths must be captured ordinary files.

`prepare.json` is `{inventory,layer,previous?,previous_proposal?}`. Inventory uses the A1 `adoption-inventory/1` schema; the Layer uses the normal v0.1 contract and exact next owned revision. Preparation creates the private Layer plus private inventory/proposal envelopes in one registry commit. Coverage must report `scope_accounted:true` before an accepted review. `source_fresh`, `behavior_verified` and `publication_ready` remain false on preparation/review.

`review.json` is `{proposal_ref,expected_proposal_sha256,accepted,rationale}`. Use the exact returned proposal envelope digest. A false decision is retained but cannot authorize publication. A true decision requires complete adopted mapping, no adopted/global questions, current owned head, Layer/Block/repository grants and the exact project. A review record accepts interpretation only; cited evidence refs remain unverified.

Publication requires the ordinary `layer publish` command with the exact retained interpretation review. Its automatic server gate reads the retained lineage and exact proposal; callers cannot omit adoption by using the raw broker, a plain revision, a restoration, an SDK call, or a request-supplied host proof. The host measures repository identity, HEAD/tree, clean index, selected raw and physical bytes, watched inventory, protected/dependency paths and outside dirty state. It repeats measurement immediately before registry publication and requires the same observation/index/authority pins. Source can change after this bounded check; the receipt records freshness at publication time, not continuous synchronization or equivalence.

Successful publication returns `published:true` and `adoption_publication_ref`. Inventory, proposal, review and publication records remain private to the owner even after the Layer becomes public. The Layer can then enter the existing compose/resolve/materialize/validate/approve/release path only within supported model/profile contracts. No behavior or Release readiness follows from this receipt.

## Revision, recapture, legacy and route boundaries

For an adopted revision, include `previous` (the current owned Layer head) and `previous_proposal` (latest retained proposal in that lineage). Retain all declared unit IDs with explicit disposition. Same route/scope may explicitly recapture source and update file hashes under a new inventory/proposal/review. Changing route or declared scope requires a new named Layer. A2 does not silently rebase an existing Layer's baseline; use a new Layer for a new baseline.

A normal `layer revise` or `layer restore` remains available, but its new adopted revision cannot publish until an explicit next adoption preparation and exact review exist. The last accepted adopted proposal can be the predecessor when intervening ordinary drafts exist. An old review cannot authorize a new revision. Already published pre-adoption revisions retain historical validity and their existing read contract. There is no reinterpretation of older `derived_from` records and no automatic migration.

Incremental and full declared-scope reconstruction use the same persisted preparation/review/publication implementation. Their inventory modes and output lanes differ: selected Git patch versus independent reconstruction. Incremental adoption can select features without full upfront distillation; outside units remain explicit. Reconstruction completeness is limited to declared adopted scope, never universal equivalence. A2 itself does not deliver either output lane; Git patch delivery still requires the existing accepted binding, exact staged patch, application evidence, review, apply and owner commit/finalization contract. Independent reconstruction still requires a supporting finite profile. Preserve original tests and untouched implementation in Git, and measure preservation through that delivery path rather than assuming rematerialization does so.

## Failure, retry and rollback

- Before registry commit, source/schema/authority/staging failures retain the prior registry, private Layer state and owned head. No application/index/commit mutation occurs. Immutable staged orphan blobs may remain unindexed; backup excludes those orphans.
- Inspect exact returned error codes. Resolve source drift/cleanliness explicitly and prepare a new captured proposal/review where necessary; never supply `source_fresh`, `bypass_adoption`, credentials or a new identity to bypass refusal.
- On response loss, run `operation inspect publish-1` first. A committed result is historical evidence. A cached publication retry still needs the configured host, current owner/head/grants and a fresh source measurement matching the original publication pins; it can refuse after drift while operation inspection still returns the retained commit.
- Restart reuses private records and links. A broker restarted without its Git host refuses adoption mutations/publication retries. Backup/restore preserves structural private history in an inactive archive; no repository root, live issuer grants, request keys or present-day freshness is restored.

## Portable synthetic acceptance

No private application is required. Run from the A2 checkout:

```powershell
npm run typecheck
npm run build
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/adoption-persistent.test.js dist/tests/adoption-publication-unit.test.js dist/tests/adoption-module-entry.test.js dist/tests/adoption-contracts.test.js dist/tests/source-binding.test.js dist/tests/git-adoption.test.js dist/tests/backup.test.js
```

Tests create only disposable synthetic Git repositories, local issuer assignments and loopback brokers. They configure synthetic Git author fields only in those disposable repositories. Directory links use a Windows junction or a POSIX symlink; external HTTP fetches are disabled. Capture the checkout SHA, Node/Git versions, full test output, publication/source refs, exact hashes, negative error codes and unchanged app/index/HEAD evidence. Test randomness affects temporary paths and Git OIDs; invariants and content-addressed record bindings are deterministic for the exact captured inputs.

The A2 suite covers omitted/rejected/stale reviews, malformed bypass flags, unavailable/serialized host proof, current permissions, protected/selected byte drift, deletion, watched additions, index/HEAD change, path links, precommit source/authority changes, lineage stripping, response loss, restart/retry and inactive backup closure/corruption. Existing native source/Git suites cover bounded coherent reading, repository identity and patch delivery. None is a fresh external agent run or a proof of application equivalence.

Suggested external agent prompt (provide authorized source access separately):

> Against the exact supplied baseline and native source capture, propose an adoption inventory and one assigned owned Layer. Account for behavior, interface, error, state and test units. Distinguish observed source statements from inference; retain outside units, protected paths, exclusions, dependencies, uncertainty and all acceptance mappings. Return `prepare.json` only. Do not execute source, call providers, modify an app, change Git, publish or claim semantic equivalence. Report unsupported model/profile requirements and missing context.

Owner review prompt:

> Review the exact retained inventory/proposal and current owned draft. Check the declared boundary, source hashes, inference, dependencies, all five accounting sections, mappings, criteria and unresolved questions. Record an exact interpretation decision only within your assigned local scope. Separate this decision from behavior evidence and Release approval. If accepted, use the normal publication command; a source freshness refusal requires explicit reconciliation, never a bypass flag.
