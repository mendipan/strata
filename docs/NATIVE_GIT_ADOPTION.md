# Native Git patch adoption

Strata can capture selected source, bind it to an exact accepted v0.1 Release, stage a supplied Git patch, retain application evidence, review the measured change, and explicitly apply it. Finalization follows an owner-created commit containing exactly the reviewed result tree. This is a bounded local Node capability. The ordinary broker and SDK have no application filesystem backend.

Git implementation records are separate from semantic Layers, generated realizations, validation and immutable Releases. Existing semantic validation remains mandatory for the target Release. A bootstrap association records the owner's accepted mapping; it does not claim the existing application passed behavioral validation.

## Configure the local host

Build with `npm run build`. Start `node dist/scripts/git-broker.js --file OWNER_CONFIG.json`. The launcher reads this host-owned configuration once; operation packets cannot set repository roots, executables, Git options or grants.

```json
{
  "format": "strata-git-host/1",
  "project_id": "strata-local-demo",
  "state_directory": "C:/work/intent/state",
  "git_directory": "C:/work/intent/git-state",
  "port": 8787,
  "repositories": [{"projectId":"strata-local-demo","repoId":"app-local-1","root":"C:/work/application"}],
  "assignments": {
    "owner-source": {
      "principal": "scope-selector",
      "operations": ["inspect","source.capture","source.bind","git.plan","git.stage","git.review","git.apply","git.finalize","git.transaction.inspect","git.transaction.recover"],
      "repositories": ["app-local-1"],
      "git_paths": ["counter.mjs"],
      "git_checkers": ["counter-application/1"]
    },
    "application-evidence": {
      "principal": "application-checker",
      "operations": ["git.check","git.evidence"],
      "repositories": ["app-local-1"],
      "git_paths": ["counter.mjs"],
      "git_checkers": ["counter-application/1"],
      "executor": "local-application-fixture",
      "reviewers": ["fixture-reviewer"]
    }
  },
  "enabled_checkers": ["counter-application/1"]
}
```

Match the project ID and model in the CLI's existing `strata.config.json` and set its broker URL to the configured loopback address. Select the host assignment with `STRATA_SESSION`. The example uses fixture identities: the principal approving source/code must actually be a responsible selector in the accepted baseline's authority table. It does not grant semantic Layer, validation or Release operations; configure those existing grants separately when needed. Default assignments gain no new permissions. Checker IDs on assignments authorize named evidence; only the compiled IDs in `enabled_checkers` can execute automatically.

Both state directories must be outside every bound application checkout. Absolute roots and local repository identity checks stay in host configuration; portable source digests contain the opaque repo ID. This local fixture identity model is not remote authentication or proof of human consent.

`capabilities` and Node `status` include `native_support`: current model/trust, adapter presence, configured repository count, enabled compiled checker IDs and per-operation support with explicit `unsupported_reason`. A granted operation may still be unsupported. Status feature flags describe configured support, not adapter presence alone. Neither response measures source, runs a checker or writes a Git transaction journal. They always report `execution_ready:false`; repository/path/checker grants, exact refs, current bytes, evidence, approvals and transaction state remain operation-time gates. Refresh diagnostics after authority/configuration changes; a retained response grants nothing.

Each row's `authorized` field reflects only the current operation allowlist. It does not establish repository, path, checker or baseline authority.

| Runtime/configuration | Diagnostic result |
|---|---|
| v0.3 local fixture with a Node adapter | `git.plan` and v0.1 binding/delivery unsupported: `UNSUPPORTED_MODEL_VERSION`. Model-neutral source capture can remain supported when a repository is configured. |
| v0.1 local fixture without a source backend | Native capture/delivery unsupported: `UNSUPPORTED_SOURCE_BACKEND`. |
| v0.1 local fixture with an empty repository configuration | Native capture/delivery unsupported: `REPOSITORY_FORBIDDEN`. Adapter presence remains visible separately. |
| v0.1 local fixture with repositories but no compiled checker enabled | Planning/staging/imported evidence remain supported; automatic `git.check` is unsupported: `UNSUPPORTED_CHECKER`. |
| Authenticated host | Native repository authority remains unsupported. Host operation grants and repository/evidence refusals are unchanged. |

Drift's imported observations, historical proposals and nonapproval dispositions remain distinct from fresh local measurement or plan approval (`local_source`); none completes reconciliation. This diagnostic projection changes no operation dispatch, schema, Release, Git record or permission.

## Capture and associate source

Use `source capture --file capture.json` with `{repo_id,scope,expected_head?}`. The strict scope declares exact paths, watched directory roots, reviewed exclusions, semantic items, and each item's paths and criterion refs. Capture requires clean committed raw bytes. It records full Git commit/tree IDs and raw SHA-256 source hashes, never silently normalizes CRLF or follows a link target.

The scope format is documented in [SOURCE_BINDING_CONTRACT.md](SOURCE_BINDING_CONTRACT.md). It covers only the selected scope. Every present selected file needs a mapping, and every mapped item needs a present artifact. An explicitly mapped absent destination can accompany existing artifacts to prepare an addition. Watched new paths need their own exact host path grants before contents are measured. Ignored contents are not read; only inventory counts are reported. Explicit untracked ignored paths are refused before measurement. A previously bound tracked file remains measured if later ignored.

Use `source bind --file binding.json` with `{payload,expected_payload_sha256,rationale,review_refs}`. The payload names the exact accepted Release and its normalized snapshot digest, the captured source ref/digest, basis, evidence refs and limitations. Initial association uses `previous_binding_ref:null`, `completion_ref:null`, `basis:"owner-accepted-bootstrap-association"` and an explicit `unvalidated-bootstrap` limitation. Review the exact payload digest and mapping before accepting it. The server derives the accepting principal and obtains fresh host measurements; there is no caller-supplied verified flag.

## Plan, stage and review a patch

Create a plan with `git plan --file plan.json`:

```json
{
  "binding_ref": "source-binding@EXACT_DIGEST",
  "target_ref": "Composition@1",
  "write_paths": ["counter.mjs"],
  "checker": {"id":"counter-application/1","version":"1","sha256":"CHECKER_SHA256","fixture_sha256":"FIXTURE_SHA256","oracle_sha256":"ORACLE_SHA256"},
  "oracle": {"independently_reviewed":"checker-specific payload"},
  "regressions": ["unrelated-byte-preservation"]
}
```

Replace illustrative refs/digests with actual values. The target must descend from the exact binding's accepted intent, and every changed semantic item needs a reviewed mapping. The plan freezes all active selected criteria, including inherited criteria, explicit regressions, checker/fixture/oracle pins, exact source and exact write paths. Arbitrary checker pins are data assertions, not permission to run a command.

Run `git stage PLAN_REF --patch change.patch`. Supply an ordinary LF Git unified diff. The adapter validates paths, headers and hunk counts, then applies the patch to a private standalone repository containing copied raw Git objects. It measures the complete result tree and pre/postimages. Staging changes no original files, index, objects, refs, hooks or worktree registrations. No three-way merge, reject files or context repair is attempted. Supported additions and deletions pin absence/preimages. Represent a rename as separately reviewed delete/add paths.

Run `review git-patch-stage STAGE_REF` to inspect exact retained patch and file operations. The stage's `result_tree_oid` pins the full implementation tree. Its `result_manifest_sha256` hashes resulting sorted source-scope entries, in the same domain as the source snapshot manifest; it is not the full-tree Git OID.

Application acceptance is a separate record. `git check STAGE_REF --checker counter-application/1 --oracle oracle.json` runs only the compiled counter fixture, only when actual staged `counter.mjs` bytes exactly match its recognized template. It runs no package script, shell command, arbitrary import or application-defined hook. Other implementations require separately prepared evidence through `git evidence --file evidence.json`.

The strict evidence packet uses `format:"git-acceptance/1"` and names `project_id`, `repo_id`, `plan_ref`, `stage_ref`, the plan's exact `target`, `base_source_ref`, staged result tree/manifest, acceptance-contract digest, checker pins, criterion results, regression results, `observations_sha256` and limitations. Each result names the frozen criterion/check/version/fixture/method and its pass/reviewer outcome. The server adds producer provenance. Import requires an assigned producer and reviewer labels. Imported evidence remains a local fixture assertion; hashes bind the assertion and do not authenticate execution. A complete acceptance requires every frozen result to pass.

Add `observation_only:true` to retain known incomplete or failed outcomes as `git-application-observation/1`. Such a record can inform drift; it cannot stand in for passing `git-acceptance`, semantic validation or code approval. Review-method outcomes remain attestations.

First obtain the matching validated semantic Release using the existing Layer/composition/realization/validation/approval pipeline. Then use `git review --file review.json --dry-run` with `{stage,acceptance,release,expected_target_sha256:null,accepted:true,rationale}` to inspect the frozen review target. Submit the same input with the returned exact `expected_target_sha256`. Only a responsible baseline selector with an explicit `git.review` repository/path grant can approve. Semantic Release approval alone grants no filesystem write permission.

## Explicit apply and completion

`git apply STAGE_REF --review REVIEW_REF --dry-run` checks the current exact base, full index, all ordinary tracked bytes, absence claims, no nonignored untracked work and live approval/evidence authority. `git apply STAGE_REF --review REVIEW_REF --idempotency-key KEY` explicitly changes only the reviewed files. It leaves HEAD and index untouched, and does not commit, push, stash, reset, add or merge.

A write-ahead journal lives outside the application, with exact pre/postimages and a cooperative repository lease. Each replacement is a same-directory temporary file followed by rename; multi-file application is not atomic. A failed operation rolls back only files still equal to its own postimages. Concurrent changes are preserved and produce `GIT_RECOVERY_REQUIRED`. A durable receipt is `applied-awaiting-owner-commit`, not an accepted source binding. Retrying its idempotency key rechecks current permissions and exact applied bytes, then returns the existing receipt.

Inspect with `git transaction inspect --file repo.json` and explicitly recover with `git transaction recover --file repo.json`, where `repo.json` contains `{repo_id}`. Recovery verifies the immutable stage and journal, refuses a live prior process, and either reconciles a durable receipt or conditionally restores preimages. Corrupt or externally changed journals/files require operator reconciliation. If the process died, the existing generic Node-state lease also requires explicit operator reconciliation before restarting the broker; the Git adapter does not silently remove that lease. Partially written temporary files are preserved when their exact ownership/postimage cannot be established.

The owner creates a commit separately. `git finalize RECEIPT_REF --commit FULL_OID` requires a clean HEAD with exactly the full reviewed result tree and a single direct parent equal to the original base. It records completion without making a commit. Capture the new clean source, then explicitly `source bind` a successor naming the matching Release, previous binding, completion, acceptance and review refs with `basis:"validated-release-association"`. Fresh clean proof and full cross-record closure are required. Existing Releases are unchanged.

Portable backups retain immutable source/Git/drift records and historical reference closure. Close the broker before export. An unfinished Git transaction marker blocks export. Backups omit application repositories, local roots, active grants, leases, private checkouts and journals; restore is inactive recovery data and cannot resume apply. See [LOCAL_BACKUP.md](LOCAL_BACKUP.md).

## Bounds and remaining scope

This slice supports v0.1 intent, portable ASCII paths, ordinary UTF-8 regular-file edits/additions/deletions, SHA-1 or SHA-256 repositories, selected source mappings, and local fixture identity. Bounds are 256 selected entries, 64 watched roots, 4 MiB per file, 16 MiB scoped read budget and index bound, 5,000 full-tree files/64 MiB bytes, 64 patch paths, 256 KiB patch input and 512 KiB retained pre/postimage bytes. Encoded Git records are further limited to 768 KiB within the 1 MiB request protocol. Index flags, sparse/unmerged/pending Git operations, checkout transforms, binary changes, mode changes, symlink/submodule adoption, nested repositories, link/junction traversal, hardlinked targets and case aliases are refused. Unchanged ordinary binary files can be preserved outside the write set.

This provides explicit incremental patch delivery and scoped provenance. It does not extract arbitrary application semantics, establish general behavioral equivalence, rematerialize an existing application, validate unsupported semantic profiles, run arbitrary application tests, generate patches with an LLM, or reconcile hostile concurrent filesystem writers. Raw-byte checks establish source identity and bounded preservation; they do not establish runtime behavior beyond named evidence. For detection and reviewed reconciliation plans, see [SOURCE_BINDING_CONTRACT.md](SOURCE_BINDING_CONTRACT.md) and [DRIFT_RECONCILIATION_PLAN.md](DRIFT_RECONCILIATION_PLAN.md).

The executable acceptance coverage is in `tests/git-workspace.test.ts`, `tests/git-adoption.test.ts` and the source/drift/backup suites. All Git writes in these tests target newly created disposable synthetic repositories; owner commits occur only in the test harness.
