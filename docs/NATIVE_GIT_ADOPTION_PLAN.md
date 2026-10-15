# Native incremental Git adoption: bounded implementation plan

Status: architecture decision implemented in the bounded local Node slice. See [NATIVE_GIT_ADOPTION.md](NATIVE_GIT_ADOPTION.md) for actual commands and limits; this document retains the audited design rationale. Audited source: `d08075834cdeb505c79dfb528bbe1b4d3febbee5`.

## Decision and verified gap

Add a Node-only, explicitly configured **supplied Git patch adoption** workflow. Git remains implementation authority; immutable Strata Releases remain intent authority. A separate immutable implementation association connects them. Stage an externally prepared patch against an exact Git commit, review its measured result and acceptance, explicitly apply file changes, and finalize only after the owner commits the exact result. No automatic commit, push, merge, inference, or universal materializer.

Audit of the actual implementation confirms these boundaries:

| Existing code | Finding and design consequence |
| --- | --- |
| `src/cli.ts`, `distill` branch; `src/core.ts`, `publish` | Distillation checks supplied paths/hashes and imports a supplied Layer. Its source schema only permits root/files. Publication checks stored source/draft review, not current Git history or source bytes. Keep that legacy contract; add a new source binding instead of smuggling Git fields into it. |
| `src/model.ts`, Layer/change schemas; `src/core.ts`, `normalizeLayer` | A Layer changes semantic items on existing Blocks. It is not a file patch. Keep file content out of Layers and snapshots. |
| `src/core.ts`, `registerRealization`, `validate`, `release`; `src/profile.ts` | Registration requires equality with compiled profile output; validation and Release recheck that exact realization and all active criteria. Arbitrary application patches cannot masquerade as generated realizations. Leave this pipeline unchanged. |
| `src/runner.ts`; `src/profiles/counter-fixture.ts` | The runner measures a complete generated folder and imports its module. It cannot accept an arbitrary populated repository as a realization. Reuse the bounded counter check assertions through a separate explicit application checker, not the existing output manifest. |
| `src/security.ts`; `src/service.ts` | Operation grants, principal ownership, Block scope, evidence producers, baseline scope/release/guardian authorities and live issuer checks already exist. New Git operations require new explicit grants; semantic approval alone is never filesystem permission. |
| `src/local-broker.ts` | The serialized broker commits content-addressed records and a registry with idempotency and late authorization. Its record rollback cannot undo filesystem writes. Add a durable filesystem transaction journal before original-tree writes. |
| `src/backup.ts`; `src/recovery.ts` | Backup has a strict record-type allowlist and historical closure verification; audit references have a separate helper. Both need deliberate updates. A working-tree transaction journal is recovery state, not a portable semantic backup. |
| `src/artifacts-git.ts` | This is Strata artifact storage, not application Git integration. Do not extend or repurpose it. |

The earlier entry-workflow review's gap is confirmed at the audited revision. No product claim relies on its external test results as new execution evidence.

## Smallest useful vertical slice

Use v0.1 intent, an existing manually accepted baseline association, ordinary Git repositories, explicit selected files and a supplied textual patch. Prove the full cycle on a disposable synthetic application containing `counter.mjs`, unchanged unrelated code/tests, and a separate Strata state directory. Existing intent workflow changes the counter ceiling from 6 to 12 and produces a validated Release through the unchanged finite profile. Independently test the patched application, approve its exact code change, apply it, manually commit in the synthetic test harness, then finalize the association.

Production API does not contain the test harness's commit operation. Unsupported semantic profiles may stage a proposal and review code, but cannot bypass existing Release validation to become adopted intent. This slice therefore closes bounded patch delivery, not arbitrary application intent validation.

Externally supplied and agent-produced patches use the same untrusted input contract. A supported agent may be handed exact source/intent refs and a patch packet specification by an already authorized host; Strata launches no model and accepts no agent-supplied command, working directory, executable, URL or Git option.

## Shared source contract and ownership

The paired drift implementation owns the authoritative strict `src/source-binding.ts`, its generated schemas and `docs/SOURCE_BINDING_CONTRACT.md`. This document specifies the agreed boundary, not a second schema implementation.

* Accepted association: project ID; exact Release ref and record digest; snapshot digest and model; source snapshot ref/digest; reviewed scope/mapping; exact acceptance evidence and review refs; previous association/completion ref when superseding. A bootstrap association is explicitly `owner_accepted_association` with unvalidated-bootstrap status, never behavioral validation. A candidate is a proposal target, not an accepted baseline.
* Source snapshot: version, opaque host-assigned repo ID, Git object format, full HEAD commit and tree OIDs, scope digest, sorted entries, manifest digest. Entries pin path, presence, kind, Git/index mode, byte length and raw-byte SHA-256. Absent entries have null kind/mode/length/hash. Git OIDs and byte SHA-256 are distinct typed fields; object format determines OID length.
* Scope: explicit tracked paths, watched directory roots for newly appearing paths, reviewed exclusions, item-to-path and criterion coverage mappings, and selected-scope limitations. Patch writes additionally require an exact path allowlist including absent addition destinations. Neither mapping nor a source hash proves semantic extraction.
* Observation is separate: HEAD/tree, index digest, staged/unstaged/untracked statuses, actual scoped byte observations, excluded/ignored inventory counts, and coherence. Dirty observations never silently replace the committed snapshot. Ignored contents are not read; already-bound tracked files are still checked.
* Source entry manifest digest excludes evidence. The outer association digest binds review/evidence references. Absolute checkout/state paths and remote URLs do not enter portable records. Host configuration maps project/repo ID to a canonical root and verified Git directory identity; copying an ID into a request cannot authorize another repository.

Git worker exports in `src/git-workspace.ts`:

```ts
captureGitSource(host, scope, {
  expectedHead?: GitOid, mode: 'baseline' | 'observation'
}): Promise<{ snapshot: SourceSnapshot; observation: GitObservation }>;
verifyGitSource(host, expectedSnapshot, {
  requireClean: boolean
}): Promise<Verification>;
```

Baseline capture requires coherent clean source. Snapshot hashes come from raw committed Git blobs; actual scoped checkout bytes must agree or capture refuses `UNSUPPORTED_CHECKOUT_TRANSFORM`. Observation can describe differences without following symlinks. Mode comes from Git/index metadata, not Windows executable-bit guesses. Read HEAD/index/metadata before and after capture; changing inputs produce an incoherent/refused result, not an accepted mixed-time snapshot.

## Immutable records and binding rules

Use strict versioned Zod schemas, existing canonical JSON hashing, full digest refs (`type@sha256`) and the existing `Engine.store` immutability rule. No mutable latest association is authoritative.

| Record | Required binding |
| --- | --- |
| `git-change-plan` | Project/repo; accepted baseline binding; exact target Composition or Release ref, record digest, candidate fingerprint and snapshot digest; source snapshot; exact write paths; preimage presence/mode/hashes; item/path mapping; preserved scope; required inherited and new criterion IDs; explicit regression obligations; fixed checker/oracle pins; exclusions; patch producer principal and patch digest. |
| `git-patch-stage` | Exact plan; retained supplied patch bytes/digest; canonical file operations with pre/post content and hashes; full expected result tree OID; result scoped manifest; unchanged-outside-write-set proof; checker input tree. A sandbox path is local host state, not part of this record. |
| `git-acceptance` | Exact plan/stage/target/base source, full result tree and manifest, acceptance-contract digest, checker ID/version/source/fixture/oracle hashes, one result per required criterion, explicit regression results, producer/trust, observation digest and limitations. |
| `git-apply-review` | Exact plan/stage/acceptance and validated Release refs/digests; responsible scope, expected original HEAD/tree/index/preimages; repository grant/policy generation; server-derived reviewer; accepted/rejected and rationale. Review target digest covers all these inputs. |
| `git-apply-receipt` | Transaction ID, exact approved inputs, original base, measured postimage tree, paths changed, preimage/postimage digests, outcome and recovery status. An apply receipt is not a committed source association. |
| `git-finalization` | Successful apply receipt, matching validated Release and candidate/snapshot, acceptance/review refs, owner-created clean commit/tree, parent/base relationship, and exact expected result tree comparison. Provides the completion ref for successor `source.bind`. |

Application evidence results retain `{criterion_ref, check, version, fixture, method, passed, reviewer}`. Producer is server-derived with `local-fixture-import` or `local-fixed-fixture`, always `execution_authenticated:false`. Imports are assertions by an assigned producer. Fixed fixture observations are local measurements, not independent attestation. Missing, duplicate, unknown, wrong-version, failed or wrong-tree results block acceptance. Review criteria require an explicitly assigned reviewer assertion; do not manufacture human review. A regression claim only covers its named suite. Hash-preserved unrelated files establish byte preservation, not whole-app behavior equivalence.

The acceptance contract is frozen before patch evaluation. Agent-modified tests/oracles cannot certify their own change: checker/fixture/oracle inputs live outside the patch write set, are independently pinned, and any revision requires a new plan and reviews. No existing `Evidence` record is widened or relabeled to accept these records.

## Operations and transitions

Proposed CLI forms below all use exact refs and existing machine envelopes; `--file -` accepts one bounded JSON packet. All Git commands are Node-host capabilities, disabled without explicit host repository configuration; SDK returns unsupported rather than accepting a simulated filesystem result.

1. `git plan --file F`: bind accepted baseline, eligible intended target, source and frozen scope/acceptance. No source mutation. The supplied plan is normalized and inspected before code approval.
2. `git stage PLAN --patch FILE`: verify source, retain patch, build a private detached checkout, apply only there, measure actual change set/result tree, retain the immutable stage. This does not run application code or grant write access to the original checkout.
3. `git check STAGE --checker ID --oracle FILE`: opt-in fixed host checker only. Initial automatic checker is the synthetic counter application fixture; it receives a measured read-only input packet and writes logs outside the input tree. Rehash before/after; timeout, exit failure, changed inputs, extra outputs or unknown checker fail. A subprocess is not a security sandbox: do not expose arbitrary application execution as safe merely because its command is fixed. Outside the explicitly enabled synthetic fixture use separately host-run checks and `git evidence --file F` through a configured producer grant. Neither command runs package scripts supplied by the patch.
4. `git review --file F`: after a validated semantic Release is available, record acceptance of this exact implementation/stage/evidence/Release. A staged Composition must match the Release's candidate and full snapshot; unchanged snapshot alone is insufficient to substitute provenance. Resolve current responsible authority from the original pinned semantic baseline. Reuse scope/guardian authority calculations and current issuer/grant checks; require applicable guardians for protected intent changes as well as the Release's existing approvals. Use a new code-review record, not a forged legacy approval kind.
5. `git apply STAGE --review REVIEW [--dry-run]`: explicitly authorized original-worktree transaction. Revalidate everything below at execution. Dry run reports exact planned effects and blockers and creates neither checkout changes nor accepted records.
6. Owner performs normal Git review and commit. Strata does not stage the original index, commit, create branches, move HEAD, reset, stash, merge, run hooks or push.
7. `git finalize RECEIPT --commit OID`: require owner commit to be a direct child of the pinned base in v1, clean current HEAD equal to that commit, full tree equal to reviewed result, and unchanged approved association predecessor. Record finalization then call the shared `source.bind` gate with the exact successor payload. Response-loss retries reuse the same finalization/binding, never duplicate history. No acceptance is inferred merely from presence of a commit.

Corresponding broker operations are `git.plan`, `git.stage`, `git.check`, `git.evidence`, `git.review`, `git.apply`, `git.finalize`, plus `git.transaction.inspect` and `git.transaction.recover`. `review`/`inspect` expose the new records as assertions, measured bindings and unverified scope. Status/help declare `git-patch/1`, actual runtime availability, v0.1/profile bounds and separate stage/applied/committed-associated outcomes.

## Git and filesystem implementation rules

Use fixed `spawn`/`execFile` argument arrays without shell evaluation, finite time/output/byte bounds, validated full OIDs, NUL-delimited Git path output and a sanitized environment. Disable optional original-repository locks, fsmonitor, hooks, external diff/textconv, pager, lazy object fetching and user/global config for adapter operations. Never execute filters, credential helpers or repository scripts. Do not call checkout/reset/stash/add/fetch/commit on the original repository. Missing objects, shallow-history gaps needed by the operation, sparse indexes/checkouts, unresolved index entries or unsupported index flags refuse explicitly.

Create the sandbox in a host-selected, new private directory outside the application. Prefer a standalone disposable Git directory to `git worktree add`: the latter mutates the original `.git/worktrees`. Populate required raw objects through bounded `cat-file` reads and private `hash-object` writes, verify returned OIDs, then construct the raw-byte checkout and private index. Do not copy `.git/config`, hooks, alternates, refs or user credentials. No network fetch, hardlink sharing or symlink-following archive extraction. Test the object-import helper with both supported object formats; otherwise advertise only the tested format and refuse the other.

For v1 patches accept regular UTF-8 file edits/additions/deletions only, with supported Git unified diff headers and positive context for edits. Reject binary payloads, rename/copy metadata, combined diffs, mode changes, symlink/gitlink changes, duplicate destinations, malformed counts/headers, zero-context edits and NUL/invalid UTF-8. A reviewed rename can be expressed as deletion plus addition, with both paths allowed; no automatic rename inference. Use native Git's private-index `apply --cached --check` followed by private-index apply with no three-way/fuzzy conflict-repair/reject-file options. Then independently enumerate the entire resulting tree and compare actual changed paths/modes/preimages against the plan. Git's parser is not the authorization boundary.

Path policy rejects absolute/drive/UNC paths, backslashes, `.`/`..`/empty segments, control bytes, `.git` components (case-insensitive), Windows reserved names/ADS/trailing-dot-space aliases, case-fold/normalization collisions and file/directory prefix collisions. Safest v1 is a documented portable ASCII path subset; reject unrepresentable repository paths before creating a sandbox. Verify real path identities and each existing ancestor with `lstat`; refuse links/junctions/reparse paths. Reject hardlinked target files where identifiable. Do not silently rewrite a path into scope. Apply cannot modify `.git*`, `.gitattributes`, `.gitmodules`, host state or independently pinned acceptance inputs. Binary files may be copied unchanged outside the write set; symlinks/submodules required in a complete sandbox tree are unsupported in v1, including nested repositories. Never initialize submodules.

Default source bounds follow the shared schema: 256 selected entries, 64 watched roots, 4 MiB/file, 16 MiB scoped reads. Additional patch bounds: 64 changed paths, 512 KiB combined retained pre/post content, 256 KiB supplied patch, entire request under existing 1 MiB envelope. Private whole-tree checkout bound: 5,000 regular files/64 MiB, including preserved binary files. Limits are capability refusals, never silent truncation. Keep Strata state and transaction files outside the target application.

## Original checkout mutation, rollback and restart

Before apply, require the exact configured repository identity, base HEAD/tree, raw index digest, no staged/unstaged/untracked changes anywhere, no merge/rebase/cherry-pick state, and complete raw tracked-byte agreement with the base. Ignored paths remain untouched but collisions with prospective writes refuse. CRLF or filter-transformed working bytes refuse rather than being normalized. Check all path preimages, absence claims, grant/policy liveness, exact review and evidence. Even unrelated dirty changes or a changed HEAD with identical scoped files refuse v1; replan explicitly. Never auto-stash or rebase.

Acquire a repository-keyed cooperative Strata apply lease. Prepare and durably write a bounded journal containing expected identity, operation/idempotency IDs, approved refs, index/HEAD pins, every preimage/postimage and per-path progress **before** any original write. Stage file replacements on the same filesystem, recheck preconditions immediately before replacement, create additions exclusively and record created directories. Do not write the original index. After all writes, verify all postimages plus unchanged outside-write-set tracked bytes, index and HEAD, then commit the apply receipt through the broker. Recheck live permissions at the normal late-commit gate.

Ordinary failure triggers conditional rollback of this transaction's paths only. Restore/delete a path only if its current bytes/mode/presence still match the transaction's own expected written state. Never overwrite a third-party edit during rollback; mark `recovery_required`, retain journal/preimages and refuse further apply. Remove only empty directories created by this transaction. Surface partial outcomes and exact paths; no success receipt or accepted source binding on failure.

Node record transaction rollback cannot be treated as filesystem rollback. On startup, unfinished journals block that repository. `git.transaction.inspect` is read-only; explicit `git.transaction.recover` reconciles measured paths against journal and durable broker receipts, then either finishes receipt publication for a fully written exact result or conditionally restores preimages. A journal records its intended disposition so a pending rollback cannot be converted into success after restart. Unknown/intermediate bytes require owner reconciliation. A lost response after durable receipt returns that receipt on retry only after appropriate current-state reconciliation; never reapplies a cached filesystem mutation blindly. Revoked apply authority prevents completing a new successful publication, while narrowly granted recovery can undo only the journaled operation.

There is no atomic multi-file filesystem transaction or protection against a hostile local process swapping files after checks. Locks coordinate Strata operations only. State the trusted local, quiescent-checkout requirement, measure before/after and fail on observed interference. Do not claim perfect race freedom. Post-success rollback is a new reviewed reverse patch against the current committed base, with fresh evidence; historical Releases/bindings stay immutable. Returning code to an older state does not rewrite semantic history.

## Implementation ownership and ordered work

| Owner | Files/boundary |
| --- | --- |
| Git adoption worker | New `src/git-workspace.ts`, `src/git-adoption.ts` (schemas/pure gates), `src/git-adoption-node.ts` (async host execution/journal), `src/git-application-checker.ts`; corresponding unit/CLI/synthetic acceptance tests; this plan and later product usage guide. |
| Drift worker | `src/source-binding.ts`, drift classification/reconciliation modules and tests; `docs/SOURCE_BINDING_CONTRACT.md`, `docs/DRIFT_RECONCILIATION_PLAN.md`; shared `src/backup.ts` integration and first `scripts/schemas.ts` integration. |
| Git integration single writer | `src/cli.ts`, `src/service.ts`, `src/security.ts`, `src/local-broker.ts`, `src/recovery.ts`, `src/review.ts`; consume drift exports and requested command/grant additions. Final schema registration pass coordinated with drift worker. No concurrent edits to these files. |

Shared exports: `SOURCE_BINDING_SCHEMAS`, `DRIFT_SCHEMAS`, `sourceBindingArchiveReferences`, `driftArchiveReferences`, `verifySourceBindingHistory`, `verifyDriftHistory`, `executeSourceBinding`, `executeDrift`. Git exports `GIT_ADOPTION_SCHEMAS`, `gitAdoptionArchiveReferences(type,data)` and `verifyGitAdoptionHistory(records,projectId)`. Historical verifiers inspect record structure, exact refs/digests/closure and original trust labels; never run commands, require live checkout paths or reauthorize history with present-day grants.

1. Land shared source schemas and raw Git capture/verification with golden digest/path/object-format fixtures; settle exact export types before downstream edits. No new defaults in `FIXTURES` that grant filesystem access. Explicit host repository grants bind principal/project/repo, operation, path set, Block scope and configured checker; issuer operation recognition must include new operations even when no default fixture grants them.
2. Implement plan/stage schemas, private checkout and patch parser/application proof. All retained code bytes reside in implementation artifacts, never snapshots. Assert original repository/index/refs are unchanged by preparation.
3. Add application evidence import and explicitly enabled fixed synthetic checker. Produce one supported end-to-end stage/acceptance packet before original writes exist.
4. Add exact code review and Release matching gates; factor existing authority calculations where needed without loosening `approve`/`release`. Test stale/revoked/foreign-scope requests. Shared service remains synchronous for pure record transitions; Node broker routes asynchronous Git operations inside its serialized transaction. No Node filesystem module imported into SDK execution.
5. Implement journaled explicit apply, restart recovery and exact commit finalization. Rework broker idempotency dispatch so cached external-effect operations consult their durable transaction state. Pure registry before/after snapshots alone are insufficient. `source.bind` successor acceptance invokes shared gate, not direct unchecked record storage.
6. Integrate CLI/review/help/capabilities/audit and backup closure. Backups include portable Git records and retained bounded patch/preimage code; exclude sandbox/config/live grants/journals. Refuse backup while an unfinished apply exists unless journal recovery has completed. Restored archives remain inactive and cannot authorize repository writes. Disclose retained source bytes in usage documentation.
7. Run targeted tests, existing core/profile/CLI/security/recovery/backup regression tests and build/typecheck. Inspect product docs for accurate capability claims. Parent coordinates integration into the advanced main; no merge or push in this task.

## Adversarial acceptance criteria

All actual repository mutations in tests use newly created disposable synthetic repos. Assert original HEAD, refs, index bytes, tracked files and selected untracked/ignored sentinel bytes before/after each refusal. No application repo, cloud, credentials, model calls or deployment.

| Case | Required result |
| --- | --- |
| Happy path | Baseline 6; reviewed intended 12; supplied patch stages privately; fixed counter and unrelated regression checks pass; existing semantic Release validation remains required; exact code review permits apply; original HEAD/index unchanged and only allowlisted working bytes differ; test harness manually commits; finalization captures that exact tree/Release; inherited obligations and original Release bytes preserved. |
| Dirty or moving source | Staged, unstaged, untracked (including outside scope), changed HEAD/same scoped files, index changes, mid-capture changes, unresolved merge and in-flight rebase all refuse without original writes. New clean base needs a new plan/evidence/review. |
| Checkout transforms | LF raw blob versus clean CRLF checkout, malicious clean/smudge/external diff/fsmonitor config, skip-worktree/assume-unchanged/sparse state: either detect/refuse documented unsupported state or use raw safe observation. Sentinel programs never execute. |
| Scope/paths | Addition destination absent pin; deletion exact preimage; out-of-scope second patch entry; rename/copy metadata; deletion+addition with one side unauthorized; traversal, absolute/UNC/drive, `.git`, case aliases, reserved names, ADS, Unicode collision and prefix collision all refuse. |
| Unsupported objects | Binary changed file, mode/executable change, symlink/junction/ancestor link, submodule/gitlink, nested repo, hardlink target and malformed diff reject; unchanged binary file outside patch is byte-preserved. Nontext/symlink drift observations remain honest metadata-only results. |
| Patch conflicts | Wrong context, wrong old hash, duplicate headers, zero-context, invalid UTF-8, malformed sizes, conflict markers introduced by unsupported three-way mode, oversized files/patch/output and missing objects never trigger fallback/rebase/network or partial original apply. Literal conflict-marker text can only be ordinary reviewed content, not an auto-resolution. |
| Evidence substitution | Different plan/tree/candidate/Release/checker/oracle/criterion set, altered tests, absent inherited criteria, duplicate/unknown/failing results or stale review block. Imported passing results do not authenticate execution. Wrong expectation (6 for desired 12) demonstrably fails checker. |
| Authority | Author-only principal cannot apply; generic release approval cannot apply; cross-project/repo/Block/path requests fail; copied reviewer labels fail; expired/suspended grant after staging or after preflight blocks publication and triggers bounded rollback if necessary. |
| Concurrency/failure | Two applies serialize; same idempotency key/different input conflicts; injected failure after journal, after each write, before registry commit and after commit/lost response reconciles deterministically. Before success either exact preimage restored or explicit recovery_required with preserved third-party bytes; never false success. |
| Finalization | Dirty checkout, wrong/extra commit tree, unrelated file included, wrong parent, different Release/provenance, failed prior receipt or replaced association predecessor refuse. Successful repeated exact finalization/source.bind returns same refs. |
| History/recovery | Backup round trip verifies complete new record closure without Git execution; missing/tampered referenced patch/evidence/review fails. Inactive restore grants no Git access. Old Releases, approvals and accepted bindings remain byte-identical after adoption, rejection and reverse patch. |

Definition of done is the real CLI synthetic cycle plus refusal/fault evidence above and passing relevant existing regressions. Passing only a record-shape test or a staged diff is not native adoption completion.

## Non-goals and execution handoff

No semantic extraction, full-app rematerialization, generic agent runtime, automatic tests from patch commands, arbitrary checker plug-ins, hosted identity, v0.2 mediation adoption, automatic drift decisions, permissive merging into dirty checkouts, binary/rename/submodule implementation, implicit commit/push or remote Git access. Drift reports and approved reconciliation plans do not themselves reconcile code or intent.

The architecture is settled and its local vertical slice is implemented with the shared source contract. The product guide documents supported commands and remaining limits. Implementation may expose a concrete platform limit, but must not silently weaken the source, approval, acceptance or rollback contracts to make a fixture pass.
