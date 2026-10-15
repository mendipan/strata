# Git and Strata in one development workflow

Git retains application source and its commit history. Strata retains reviewed application intent, owned proposals, decisions and evidence in its configured broker's registry and artifact store. A Git commit and a Strata Release identify different records; neither automatically backs up or publishes the other.

This guide describes the implemented local setup. See the [implemented contract](IMPLEMENTED_CONTRACT.md) for model/profile limits, [getting started](GETTING_STARTED.md) for tooling, and [native Git adoption](NATIVE_GIT_ADOPTION.md) for exact host configuration and patch-delivery gates.

## Start a new intent project

For a new application source repository, the owner can use Git's `git init APP_ROOT`; reuse the existing repository when one is already present. Strata does not initialize Git. An intent project can also run without application Git history; native adoption of existing source requires Git today.

Use Node.js 22+ and the pinned Strata checkout. The supported disposable learning setup also requires PowerShell 7:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
$project = Join-Path ([IO.Path]::GetTempPath()) ('strata-contributor-' + [guid]::NewGuid().ToString('N'))
node dist/scripts/contributor-starter.js prepare $project
node dist/scripts/contributor-starter.js start $project
```

`prepare` requires a new canonical absolute directory whose parent exists. It writes synthetic local accounts, private development keys and supplied intent inputs. `start` writes local configuration/session files and launches the persistent broker plus role-specific Studio views. Keep that terminal open and keep session files and launch links private. The [contributor starter](CONTRIBUTOR_STARTER.md) supplies the complete attended bootstrap, review, evidence, approval, Release and restart recipe. Preparation alone creates no baseline or approvals. The starter creates no Git repository or `.gitignore`. This is a finite v0.3 collection example, not a general application initializer or a native Git adoption host.

For the ordinary v0.1 development harness, [getting started](GETTING_STARTED.md) uses the checked-in `strata.config.json`, `npm run broker:node` and nonsecret fixture selectors. The Node executable defaults to `.strata/node-state` relative to the **broker's working directory**; `STRATA_STATE_DIR` selects its state directory. The CLI's `--project PATH` selects a folder containing `strata.config.json`; it does not start a broker, select its disk state or create that configuration. Implicit discovery searches the working directory and its ancestors. Prefer an explicit project path when using several checkouts.

`node dist/src/cli.js init --file BOOTSTRAP.json --project PROJECT_ROOT --json --non-interactive` is implemented. It submits a complete model-valid initial Release record through the configured broker with an assigned initialization grant. That record is an **unvalidated bootstrap**, not an accepted behavioral baseline. It creates no directory/configuration, discovers no code, and runs no application tests. Use the exact [synthetic session inputs](../examples/agent-session.json) or starter inputs for their declared model; do not relabel an existing state to switch models. Acceptance still requires the applicable materialization, measured evidence, validation and separate approvals before `release`.

## Add intent to an existing Git workspace

Keep the application's source checkout and owner-controlled Git history. Use a separate intent project and an explicitly configured **local Node v0.1 Git host**. The ordinary Node broker and the SDK broker have no application filesystem grants by default; the v0.3 contributor starter does not provide this adapter.

An example layout is:

```text
C:/work/application/          application source, tests, .git, .gitignore
C:/work/intent/               strata.config.json and prepared intent inputs
  .strata/node-state/         durable Node registry, artifacts and audit
  git-state/                 private staging checkouts and recovery journals
C:/work/recovery/             protected, separately retained backup bundles
```

Configure the host using the strict `strata-git-host/1` example in [native Git adoption](NATIVE_GIT_ADOPTION.md#configure-the-local-host), with `state_directory` and `git_directory` matching the intended layout. Both directories **must be outside every bound application checkout**; the adapter refuses an in-checkout state directory even if Git ignores it. Match the CLI configuration's project/model and loopback broker URL. Host assignments explicitly bind principals, repository IDs, paths and operations; a client config or environment variable grants no authority.

Launch the configured host from the Strata tooling checkout:

```powershell
node dist/scripts/git-broker.js --file C:/work/intent/OWNER_CONFIG.json
```

The [source workflow](SOURCE_DRIFT.md) captures an explicit clean committed scope with `source capture --file CAPTURE.json` and records an exact accepted association with `source bind --file BIND.json`. Supplied JSON must include the contract's scope, item/path/criterion mappings, exact refs and digests. A bootstrap association must state `owner-accepted-bootstrap-association` and its `unvalidated-bootstrap` limitation. It does not validate the existing application's behavior.

To prepare intent from existing code, use the [persistent adoption workflow](ADOPTION_PUBLICATION.md): a person or assigned agent supplies the inventory and normal Layer; `adoption prepare --file F` retains preparation, `adoption review --file F` records exact interpretation review, and `layer publish REF --adoption-review EXACT_REF` checks current source freshness. There is no automatic whole-repository semantic extraction. The separate `distill --source MANIFEST --against TARGET --layer ID --proposal F` path also requires an explicit hash-pinned source manifest and supplied proposal.

Reviewed code delivery uses `git plan`, `git stage`, bound application evidence, `git review` and explicit `git apply`. Apply leaves HEAD and index untouched. The owner makes the Git commit separately; `git finalize RECEIPT_REF --commit FULL_OID` then checks the exact reviewed tree and its single direct parent. A successor `source bind` requires the matching validated Release and completion/evidence/review closure. Follow the full linked workflow rather than treating these command names as an executable shortcut.

## Where metadata can coexist

| Location | Supported meaning and boundary |
| --- | --- |
| `.git/` or a worktree's `.git` file | Git-owned metadata. Put no Strata configuration, registry, sessions or generated output inside it. |
| `strata.config.json` beside application files | A sanitized, nonsecret client configuration may be tracked with Git. It points to a broker; it is not the intent history. Host paths and per-user connection details may instead need a local template/override. The ordinary local CLI reads `strata.config.json`; it does not automatically merge `strata.local.json`. |
| `.strata/node-state/` beside `.git` | Ordinary local Node intent storage can physically coexist with Git. It includes durable registry/artifact/history data. Git does not track it automatically. This layout is **refused for native Git adoption** when that directory is inside a bound application checkout. |
| `.strata/state/` / `.wrangler/` | Local SDK persistence, or a launcher's explicitly chosen Node state path. The path name alone does not identify the format or make it disposable. Consult the launcher/configuration. |
| A separate intent directory | Recommended for existing-Git adoption; state and transaction storage stay outside the application. Select the client project with `--project`. Keep the exact state/project/model binding across restarts. |

Multiple Git worktrees do not automatically share Strata state. Starting a default Node broker from each working directory can create separate registries; copying only source/configuration does not transfer intent history. Configure one intended broker/state binding deliberately and use explicit project paths. Never copy, edit or reset a live registry to simulate a branch or resolve a refusal.

## Git command analogies

These are conceptual comparisons, not format conversion or one-to-one substitutes. The package declares no standalone `strata` executable. Invoke every Strata entry below as `node dist/src/cli.js COMMAND`, or `npm run strata -- COMMAND` from the tooling checkout. For local broker operations, first verify that the selected `strata.config.json` uses `local-persistent-fake`, `loopback-only` and a plain loopback HTTP broker URL. That configuration's admission checks establish local transport. Append `--project PROJECT_ROOT --json --non-interactive`, and use the assigned session and exact returned refs. Files and uppercase arguments are placeholders for prepared, valid inputs and returned values.

`--offline` skips [doctor's optional health probe](CLI_REVIEW_DOCTOR.md); it does not disable network access for operational commands. With a verified local configuration, operations contact the configured loopback broker. A separately provisioned hosted CLI configuration can use configured HTTPS even when `--offline` is present. Help/version and `config show` read no broker; the inspection recipe below uses `--offline` only on `doctor`.

| Familiar Git action | Implemented Strata syntax | Difference |
| --- | --- | --- |
| `git init` | `init --file BOOTSTRAP.json` | Records unvalidated intent through an already configured broker; no workspace initializer. |
| `git status` | `status` or `status --candidate C` | Shows intent/security/candidate state; Git status still measures source/index changes. |
| `git log` / `git show` | `inspect release` / `inspect release EXACT_REF` | Lists with pagination or reads an exact retained record; no `log` convenience command. |
| `git diff` | `diff LEFT RIGHT` | Compares exact intent snapshots; it is not a source patch. |
| `git branch` / edit a proposal | `layer create --file F`; `layer revise REF --file F` | Owned baseline-pinned revisions, not a branch checkout or automatic rebase. |
| Share a proposal | `layer publish REF [--authoring-review EXACT_REF] [--adoption-review EXACT_REF]` | Publishes into the configured project registry; required review depends on the model/workflow. It does not push a Git remote. |
| `git merge` and resolve | `compose --file F`; `resolve --file F [--approval A]` | Retains the considered Layers and explicit selection/decision; conflicts require applicable endorsements. |
| `git restore` | `layer restore CURRENT --from PRIOR` | Appends a private revision of the same owned Layer/baseline; does not overwrite published history or source files. |
| `git switch` | `context use TARGET --expect-generation N` | Changes personal navigation context; it does not check out code or change other records' baselines. |
| Generate an implementation | `materialize TARGET --profile PROFILE_ID --out DIR` | Uses a finite supported local profile into a new/empty project-contained output directory; it cannot realize arbitrary existing apps. |
| Accept a reviewed intent baseline | `release C --validation V --approval A` | Uses exact validation and applicable approvals (repeat `--approval` as needed); it creates a semantic Release, not a Git commit or deployment. |
| Complete reviewed Git delivery | `git finalize RECEIPT_REF --commit FULL_OID` | Observes the owner's separate Git commit; Strata does not create it. |
| `git push` / `git pull` / `git clone` | No equivalent convenience command | No Strata `commit`, `push`, `pull`, `clone`, branch checkout or automatic repository migration command is implemented. |

Automatic extraction, arbitrary regeneration, automatic rebase, remote synchronization and a Git-like clone-and-resume workflow are **conceptual future workflows**, not instructions supported by these commands.

## Reading, adopting and publishing source

There is no `.strataignore` file or Strata `ignore` command. Native Git capture/drift uses Git's standard ignore rules for **untracked** inventory. Ignored untracked contents are not measured; explicitly requesting such a path fails `IGNORED_SOURCE_PATH` before its contents are read. Already tracked files remain visible even when an ignore rule matches them. Nonignored untracked files can appear under watched roots; accepted baseline capture requires clean committed source.

Generic `source-scope/1` supports exact `paths`, `watch_roots` and `exclusions` with explicit `path`, `kind` (`file` or `directory`) and `reason`. File matches and directory prefixes are supported; glob exclusions are not. Scope exclusions constrain the captured manifest and mapped intent, but clean-source, freshness and preservation checks can still read/hash ordinary **tracked files outside that scope**, including excluded paths. Selected paths need explicit host grants. Those checks do not implement a universal secret filter or a do-not-read confidentiality boundary. The [selected delivery bridge](ADOPTION_SELECTED_GIT_BRIDGE.md) further refuses capture inputs with watch roots or source exclusions; its inventory exclusions are a separate concept.

The distinctions matter:

| Intended restriction | Current boundary |
| --- | --- |
| **Do not read** | Keep sensitive content outside the authorized source repository/manifest. `.gitignore` protects ignored untracked content from native capture measurement, but cannot hide tracked content or constrain every workflow. `--dry-run` can still measure source; no unified zero-read ingestion preview is implemented. |
| **Do not adopt/index** | Declare scope exclusions and adoption inventory dispositions/reasons. These bound the semantic adoption claim; they do not erase previously captured context or prevent every preservation read. Protected paths constrain delivery writes, not all reading. |
| **Do not publish** | Respect the project/draft visibility and explicit publication/review gates. Private drafts can already be durably stored before `layer publish`; local exclusion or unpublished status is not proof that content was never stored in the configured backend. |

Legacy `distill` reads each explicit `{path,digest}` under its source manifest's root to verify bytes. It neither enumerates the workspace nor consults `.gitignore`, and its manifest has no exclusion field. A listed ignored file is not automatically filtered out. Inspect the supplied manifest/proposal before submission and keep secrets out of both. An enforceable general do-not-read policy and a unified ingestion preview remain **future safety gaps**, not features supplied by today's source exclusions. See the [source contract](SOURCE_BINDING_CONTRACT.md) and [`src/git-workspace.ts`](../src/git-workspace.ts).

## Safe ignore defaults

Choose ignores by content and recovery needs. An ignore rule excludes files from ordinary Git addition; it supplies no backup and does not remove files already tracked. Inspect `git status --short` and `git check-ignore -v -- PATH` before accepting a rule.

| Content | Git guidance |
| --- | --- |
| Secrets, sessions and browser launch capabilities | Keep out of Git: `.env` values, keys, tokens, `sessions.json`, private connection/grant files and capability-bearing URLs. Use environment variables or protected local files. No credential belongs in a Block, Layer or evidence payload either. |
| Host authority and runtime control | Keep real accounts/policy, grants, local roots, leases and transaction journals local. Preserve recovery-required state; exclusion does not make a journal safe to delete. Clearly labelled synthetic policy examples can be shared. |
| Regenerable build/output files | Ignore dependencies, build output and explicitly designated generated realization/browser directories. Preserve any independently authored application files/tests and evidence needed for review or recovery. |
| Shareable configuration, specification and tests | Track sanitized config/templates, schemas, prepared intent specifications, acceptance/checker code, synthetic fixtures, docs and lockfiles. Avoid blanket `*.json`, `*.yaml`, `tests/`, `examples/` or specification ignores. |
| Durable local-only intent | Registry, immutable artifacts/assets, drafts, Releases, decisions and audits may be confidential and unsuitable for source Git. Preserve them in the intended state directory and arrange supported, verified backup where available **before adopting a blanket state ignore**. Input specs/config alone cannot reconstruct their history. |

A narrow example for an application that deliberately uses `.strata/generated/` for generated output is:

```gitignore
/node_modules/
/dist/
/.strata/generated/
/output/playwright/

# Local secret/session files; examples contain placeholders only.
.env
.env.*
!.env.example
!.env.template
/sessions.json
/development-keys.json
/strata.local.json
```

Those paths are an example convention, not a CLI-created layout. Adapt them to the actual launcher/output paths; keep any template free of real secrets. Do not add broad key/JSON/log patterns that hide application assets, specs or durable audits. Inspect launcher-specific secret files even when their names differ.

In particular, the contributor starter writes `development-keys.json`, `sessions.json`, `accounts.json`, `policy.json`, `LANE.json`, `CONTRIBUTOR.json`, `receipts/` and `walkthrough-result.json` at the project root. Ignoring `.strata/` covers none of those root-level files. The keys/sessions are secret; accounts/policy are local authority; manifests/receipts/results are local operational records even when nonsecret. Keep the starter folder private outside source Git, or add explicit local rules for that learning workspace after classifying its files. Its `.strata/state/` history still needs preservation; the supplied `inputs/` have shareable synthetic counterparts in `examples/contributor/collection/`.

The Strata **tooling repository's** [`.gitignore`](../.gitignore) intentionally excludes `.strata/` and `.wrangler/` to keep private development state and local outputs out of product source. It is not an application recovery policy. Do not copy those blanket rules into a project whose only intent copy lives there without a supported preservation plan. For descriptor-bound local Node state, after creating and verifying a separately retained export as described below, a project may deliberately exclude its chosen state directory, for example `/.strata/node-state/`. Retain the live state; that rule is not permission to delete it. Avoid placing the sole export under another ignored/disposable output directory and calling it a backup.

## Backup boundaries and Artifacts semantics

The supported [local backup](LOCAL_BACKUP.md) exports full indexed history from a quiesced, descriptor-bound **local-file Node** store under the explicit fixture backup entitlement. It includes private drafts, record/reference closure, supported retained assets and profile metadata. It excludes source Git history, application runtime data, workspace/config files, secrets/sessions, active authority, request caches and Git transaction/checkouts. An unfinished Git apply transaction blocks export.

For a configured v0.1 fixture project whose state is `PROJECT_ROOT/.strata/node-state`, with its updated broker gracefully stopped and the backup operator explicitly assigned, the command shapes are:

```powershell
$env:STRATA_SESSION = 'fixture-backup' # Public local fixture selector, not a secret or production login.
node dist/src/cli.js backup create --project PROJECT_ROOT --state-dir .strata/node-state --out C:/work/recovery/bundle-001 --max-bytes 16777216 --json --non-interactive
$manifestDigest = 'TRUSTED_MANIFEST_SHA256_FROM_THE_EXPORT'
node dist/src/cli.js backup verify C:/work/recovery/bundle-001 --expect-project PROJECT_ID --expect-digest $manifestDigest --json
node dist/src/cli.js backup inspect C:/work/recovery/bundle-001 --expect-project PROJECT_ID --expect-digest $manifestDigest --json
```

Use actual project/path/export results and a new/empty destination. Save the manifest digest through an independently trusted channel and check `ok:true` plus `data.verified:true`; a create dry-run is not a completed export. `--state-dir` must resolve inside the configured intent project, so place the separate Git host's Node state there if this exporter is part of its preservation plan. Do not switch to a backup selector to bypass a refused role. These commands are not a backup contract for the contributor starter's authenticated accounts or a remote registry.

`backup restore BUNDLE --out NEW_DIR --expect-project ID --expect-digest HASH` creates an isolated **inactive** archive. It restores no login, live grants, client config or authoring service; the broker refuses to run that archive. Use offline inspection for the supported recovery drill. Active re-enrollment/migration is deferred. Separately protect source repositories, application data and necessary host configuration under their own recovery procedures.

Local `artifacts/<hash>.json` files in the Node store and local Durable Object artifact storage are Strata persistence; their name does not imply Cloudflare remote Artifacts. The [remote Artifacts adapter](ARTIFACTS_REGISTRY_INTEGRATION.md) is a separate trusted host integration with explicit transport, repository binding and run authorization. It stores immutable provider Git trees with exact commit/path/hash locators. Publishing an ordinary local Layer/Release does not push that provider or the application's Git remote. The standard local CLI requires `local-persistent-fake` and refuses a mismatched remote-configured broker. There is no default remote binding or CLI `push` setup.

Local-file backup refuses remote-indexed state; remote import/export/migration and SDK SQLite export are unsupported. No blanket `.wrangler/`, SDK-state or remote-registry ignore is offered here as a safe backup solution. Retain the only durable store and establish an appropriate separately supported preservation procedure; source Git alone cannot recover it.

## Minimal inspection recipe

From a built tooling checkout, select an existing **nonsecret** `strata.config.json` project directory:

```powershell
$project = 'C:/work/intent'
node dist/src/cli.js --help --json
node dist/src/cli.js --version --json
node dist/src/cli.js config show --project $project --json
node dist/src/cli.js doctor --project $project --json --offline
```

This recipe needs no session and writes no intent, starts no service and measures no source. Offline doctor checks configuration; identity/current authority remain `not_checked`. An exit 0 does not establish broker readiness, accepted intent, application correctness or backup availability.

**Validation scope:** command names, flags, input prerequisites, project discovery, state placement, native Git exclusion and backup limits were checked by inspection of [`src/cli.ts`](../src/cli.ts), [`src/cli-config.ts`](../src/cli-config.ts), [`src/local-broker.ts`](../src/local-broker.ts), [`src/git-adoption-node.ts`](../src/git-adoption-node.ts), [`src/git-workspace.ts`](../src/git-workspace.ts), [`src/source-binding.ts`](../src/source-binding.ts), [`scripts/contributor-starter.ts`](../scripts/contributor-starter.ts) and [`src/backup.ts`](../src/backup.ts) at published base `3bfc042e8165c4284580462aa9ab5ba7c48f507b`. This docs recipe claims no fresh project creation, code adoption, backup/restore, hosted acceptance or deployment run.
