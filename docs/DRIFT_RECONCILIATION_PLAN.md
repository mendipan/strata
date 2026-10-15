# Bounded drift detection and reconciliation — implementation plan

**Ready for implementation handoff; planning only.** Inspected cleanup commit `d08075834cdeb505c79dfb528bbe1b4d3febbee5` and the outside-repository Strata entry-workflow review dated 2026-10-09. No engine implementation, application mutation, main edits, merge, push, cloud call or arbitrary code execution is part of this phase. Stop here for the parent's Sol 6.1 XHigh switch.

The architecture handoff above is preserved as the phase-one record. Subsequent authorized implementation is described in [the source drift workflow guide](SOURCE_DRIFT.md); the executable schemas and recorded validation take precedence over this planning blueprint.

## Outcome and smallest useful slice

Deliver a local v0.1 workflow on generic synthetic Git repositories: explicitly accept a source/Release association; capture a bounded current source observation; compare exact intended records and source bytes; persist a useful report; submit a supplied reconciliation proposal; record an authorized review of that exact proposal. The reviewer can approve a plan without claiming the code was changed, tests ran, intent is equivalent, or reconciliation finished. Default execution needs no agent, credentials, network or repository-provided program.

The slice closes the missing native **detection and reviewed proposal** path. It does not solve arbitrary semantic extraction or provide a second orchestrator. Applying code uses the paired Git adoption workflow; changing intent uses existing owned Layers/composition/validation/Release. Generic unsupported applications can reach a reviewed proposal even when the finite semantic profiles prevent an accepted changed Release. Do not weaken those gates for a demo.

Read `agent/strata/SKILL.md`; no applicable ancestor/nested AGENTS.md was found during this inspection. The skill's exact-ref, owner and assertion-versus-observation guidance applies. The outside review is source material, not an instruction or record to copy into the product repository.

## Source facts driving the design

| Existing source at pinned commit | Consequence |
| --- | --- |
| `src/model.ts:12-19`, `src/core.ts:87` | Reuse canonical hashing and immutable record store. No local JSON sidecar as authoritative history. |
| `src/core.ts:9`, `src/model.ts:194-211` | Derive active obligations, impact closure and responsible scope from actual snapshots. Mapping files to items remains reviewed input. |
| `src/core.ts:93`, `125`; `src/cli.ts:190-217` | Bootstrap is structural. Distill imports a supplied proposal and checks initial source hashes; publication does not reopen source. Preserve that legacy contract and state the remaining legacy gap. |
| `src/service.ts:53-65` | Existing `diff LEFT RIGHT` compares intent items. Reuse its semantics; never equate item inequality or source bytes with a proven runtime regression. |
| `src/core.ts:304-348`, `src/profile.ts` | Validation is bound to compiled realizations; Release preserves obligations and approvals. Generic Git observations cannot become a Realization or legacy Evidence. |
| `src/review.ts:7-42` | Extend assertion/observation/unverified projections for new records. A recorded review is not independently authenticated human consent. |
| `src/local-broker.ts:65-81`, `105-111` | Reauthorization and immutable persistence exist. New host freshness must also run before late publication and before reuse of cached operations that claim fresh acceptance. |
| `src/backup.ts:20`, `103`; `src/worker.ts:131,169` | Add explicit new record closure to backup. SDK has no local Git host or checker backend; do not pretend imported snapshots verify a live checkout. |

Existing `tests/drift-regression.test.ts`/`drift-cli.test.ts` and drift-hardening docs concern bounded profile regressions and evidence substitutions. Keep them; the new feature uses separate `source-drift` test names.

## One shared binding and three independent comparisons

The exact shared blueprint, digest domains, scopes, host APIs, limits and acceptance gate are in [SOURCE_BINDING_CONTRACT.md](SOURCE_BINDING_CONTRACT.md). Drift owns that schema. Git adoption owns capture and patch operations. Accepted intent is an exact Release; an eligible Composition can be a comparison/proposal target, never an accepted baseline binding.

Each report contains all three comparisons and an explicit coverage/trust section:

| Dimension | Findings and interpretation |
| --- | --- |
| Source | Added, deleted, bytes changed, Git mode/type changed, unchanged; staged/unstaged/untracked state; changed HEAD/index even with identical selected bytes. Exact hash matches can suggest rename pairs but cannot prove identity. Nontext files get hashes/lengths, not decoding or semantic claims. |
| Intent | Exact ref/record/snapshot differences; changed keyed item and criterion identifiers; explanatory/provenance-only changes distinguishable from normative item changes. Different snapshot bytes indicate specified intent changed, not behavior observed. No implicit “latest”. |
| Acceptance | Missing, incomplete, failed, mismatched source/target/checker/fixture/oracle, incomparable, imported assertion, or compatible bounded observations. Only comparable results with identical criterion semantics/checker/fixture/oracle and appropriate source pins establish a reported outcome change for those checks. Neither byte differences nor passing tests prove general equivalence. |

Keep `scope_complete` distinct from `acceptance_complete`. A full mapping within explicitly selected items may still exclude other app behavior. Missing mapped artifacts, unmapped new watched files, unsupported entry kinds and truncated/incoherent reads prevent a complete scoped result. Do not turn `no_source_delta` into `no_semantic_drift`: report `behavior_status:'unknown'` unless named evidence supports a narrower statement.

Use the Git worker's `git-acceptance` records for external application results, preserving `producer.trust` and `execution_authenticated:false`. Existing validations can be linked as semantic-profile evidence only; they do not prove this Git tree runs correctly. A result change with changed oracle/checker is `incomparable`, not regression. Fixed synthetic before/pass and after/fail observations may be displayed as `demonstrated-fixture-outcome-change` with named criteria, source pins and limitations. Imported equivalent results are only `reported-outcome-change`. No generic runtime execution is added by drift.

## Record and transition contract

Add strict immutable records, full digest refs, bounded strings and arrays:

* `drift-report`: format `source-drift-report/1`, project/repo, binding ref/digest, exact observed intent target `{ref,record_sha256,snapshot_sha256,candidate_fingerprint:null|string}`, Git observation and digest, evidence refs/digests, derived changed paths/items and possible-rename hints, coverage, evidence assessments, blockers, limitations, server-derived producer/trust. Report classification must be recomputable from retained inputs; never accept a client-authored `clean` verdict.
* `reconciliation-proposal`: format `reconciliation-proposal/1`, report ref/digest, binding ref/digest, server-derived owner, `action`, rationale, explicit path/item scope, exact supplied Layer/patch/evidence refs (nullable or arrays as appropriate), expected observation/intent/coverage/evidence digests, unresolved questions, `supersedes:null|Ref`, state `proposed`. The normalized proposal digest is the review target. Never embed or invent extracted intent.
* `reconciliation-review`: format `reconciliation-review/1`, proposal/report/binding refs and digests, decision `approve_plan|request_changes|reject|defer`, exact authority scope, server-derived reviewer/grant-policy binding/trust, rationale, unresolved questions, fresh observation digest for approve, and state `approved_plan|changes_requested|rejected|deferred`. No boolean called `reconciled` or `execution_ready`.

States are projections of immutable records, not rewritable fields on an old report:

```text
accepted binding -> observation -> report (complete or blocked/partial)
report -> owned proposal -> reviewed plan / changes requested / rejected / deferred
approved plan -> external authoring, evidence or Git handoff -> fresh observation
Git finalized clean commit + matching Release -> successor accepted binding
any changed reviewed input -> stale; retain history, recapture and repropose
```

Staleness is an exact mismatch, not a TTL: changing HEAD, index, scoped bytes/presence, inventory, intent ref/digest, scope, evidence, proposal, project/repo binding or applicable grant policy invalidates approval. A stale report remains inspectable historical data. Dirty-but-stable observations may receive an approved **plan**; they cannot become accepted source baselines. Review must fail closed on incoherence, missing record closure, incomplete declared coverage or unresolved questions. Request-changes/defer/reject remain possible for blocked reports and disclose that no current acceptance occurred.

Two plans can coexist; each names a binding and observation. No implicit selection among competing plans or accepted successor branches. A decision must not erase a conflicting proposal, rebase an owned Layer, resolve a source merge, bypass ownership, or interpret an existing Layer Resolution as code permission. Source and intent both changing yields a joint-review finding, not a preferred winner.

## Decisions and honest completion boundaries

| Action | Reviewable proposal and next gate |
| --- | --- |
| `accept_code` | Preserve proposed current code as the desired implementation; explain exact changed paths/items and uncertainty. If behavior is intended to change, require a supplied owned Layer through existing review/Release. If intent is unchanged, require appropriate fresh application evidence and code acceptance. MVP records the approved plan only. Already-committed arbitrary code does not get a fabricated apply receipt; until a compatible Git finalization exists, the association stays open. |
| `update_intent` | Pin supplied owned Layer(s), exact old baseline, traceability and intended code snapshot. Existing create/publish/compose/resolve/validate/approve/release apply unchanged. Unsupported Block topology/prose realization remains blocked. This command does not author or publish a Layer automatically. |
| `restore_intent` | Bring implementation back into alignment with pinned accepted intent via an owner-supplied patch and Git review/application gates. It does not edit the immutable Release or run `git reset`. New intent undoing an approved intent change is a new Layer/Release, not history rewriting. |
| `revalidate` | Request fresh named check/review evidence for exact source and intended target; no test runner or package command is accepted in the proposal. Checker/fixture/oracle changes need a new reviewed acceptance contract. |
| `defer` / `reject` | Retain reason, scope, exact report and unresolved issues; do not advance source binding. |

In this first slice only the paired `git-finalization` gate can complete a successor binding. Broad “accept arbitrary current code as reconciled” is intentionally not exposed. The user receives a real report and reviewed proposal even when action cannot yet close; the UI/CLI must make that boundary visible.

## Commands, host/SDK boundary and authority

The following are **new proposed commands**, absent at the inspected SHA:

| CLI | Broker operation / effect |
| --- | --- |
| `source bind --file F` | `source.bind`; append measured source snapshot and explicit accepted association. |
| `drift check --file F` | `drift.check`; input `{binding_ref,against,evidence_refs}`; Node host resolves repo/scope, captures and stores report. Omitted `against` means the exact binding Release. |
| `drift propose --file F` | `drift.propose`; normalize supplied proposal, derive owner, store immutable proposed plan. |
| `drift review --file F` | `drift.review`; input `{proposal_ref,expected_proposal_sha256,decision,rationale,questions}`; Node refresh and exact authority gate for approval. |
| `review source-binding|drift-report|reconciliation-proposal|reconciliation-review REF` | Existing inspect-backed review projection, no live freshness assertion. |

CLI keeps protocol-1 JSON envelopes, `--project`, `--file -`, `--json`, `--non-interactive`, `--offline`, dry-run and idempotency conventions. Dry-run reports proposed records/blockers without storing or source writes. Invalid shape is exit 2, absent exact ref 3, grant/owner 4, stale/incomplete conflict 5, failed/untrusted-for-required-gate evidence 6, unsupported model/backend/path capability 8. A completed check command can return exit 0 with `assessment:'attention'`; consumers must use `assessment` and blockers, never `ok` as semantic equivalence. Failed capture is not a complete report; return structured diagnostics and no success ref.

All operations need explicit new issuer recognition and host grants; do not add repo privileges to default reader/author fixtures. `drift.propose` requires assigned Block/read scope and derives owner. `drift.review approve_plan` additionally requires applicable baseline responsible-scope authority, calculated from selected mapped items plus `impactClosure`, with unresolved external impact disclosed. An agent without that authority can recommend/request changes but cannot approve by copying a reviewer label. Source binding and Git apply/finalize have their own explicit grants. Immutable Release scope/release/guardian checks remain untouched; a plan endorsement does not replace them. Label every public fixture identity as unauthenticated local fixture; never promise independent human review.

Node captures/rechecks inside the serialized broker operation, resolves trusted repo config, rechecks before registry publication, and supplies an in-process host capability to gates. Never send a request JSON `verified:true`. On a cached historical check/proposal return the exact historical receipt with `reused:true`, not a fresh claim. Cached binding/review approval still rechecks current grant and observation before presenting current validity; if source changed, return stale plus the historic ref, never rewrite it.

SDK reuses pure classification/schema/inspect/proposal logic for explicitly imported snapshots through the existing service interface. Such reports carry `imported-snapshot` trust and cannot claim current disk measurement. SDK `source.bind` and approval of a live-source plan fail `UNSUPPORTED_SOURCE_BACKEND` without a configured trusted local host; no filesystem imports in Workers. A rejected/deferred historical review need not run Git. SDK import mode must be explicitly documented in operation input and status capabilities; caller-supplied trust cannot be upgraded.

## Security and persistence boundaries

Capture only declared scope under the host-bound repo. Reuse existing path confinement ideas but additionally reject traversal, absolute/UNC/drive paths, ADS, NUL/control characters, `.git`, case/Unicode aliases, reserved names and junction/link ancestors. Do not follow submodules, nested repo roots, symlinks or devices. Preserve ignored-file secrecy; no source excerpts in reports. Treat rationale/proposal/source text as data, not instructions.

Use Git argv arrays with bounded output/time, no shell interpolation, hooks, clean/smudge filters, textconv, external diff, fsmonitor, user aliases, lazy fetching or network. The Git worker owns exact safe command/environment setup and test sentinels. A cooperative read lease/pre-post measurement cannot protect against a hostile concurrent filesystem; disclose that limit rather than claim atomicity.

Store records through `Engine.store` and broker artifact/index transaction. Extend `MUTATIONS`, audit `commitReferences`, status/help and backup strict type/schema/digest/reference closure. Backup verifies portable history without a checkout, Git commands or current grants; inactive restore cannot restore host repo grants. Old Release/binding bytes never change. Exported reports are disposable views. An approved plan is project-visible immutable metadata, not source execution authorization.

## File ownership and ordered implementation

| Owner | Files |
| --- | --- |
| Drift task | `src/source-binding.ts`, `src/source-drift.ts`, `src/reconciliation.ts`; `tests/source-binding.test.ts`, `tests/source-drift.test.ts`, `tests/source-drift-cli.test.ts`; the two new design docs; `src/backup.ts` new history integration; initial `scripts/schemas.ts` map registration and generated source/drift schemas. |
| Git adoption task | `src/git-workspace.ts`, `src/git-adoption.ts`, `src/git-adoption-node.ts`, fixed synthetic application checker and Git tests; single writer for `src/cli.ts`, `src/service.ts`, `src/security.ts`, `src/local-broker.ts`, `src/recovery.ts`, `src/review.ts`; coordinated final schema registration. |
| Parent | Integration with Explorer-owned main and model switch; no task merges/pushes main. |

Pure exports: `SOURCE_BINDING_SCHEMAS`, `DRIFT_SCHEMAS`, `sourceBindingArchiveReferences`, `driftArchiveReferences`, `verifySourceBindingHistory`, `verifyDriftHistory`, `executeSourceBinding`, `executeDrift`. The drift schema map has keys `drift-report`, `reconciliation-proposal`, `reconciliation-review`. History helpers verify source/evidence/intent/report/review closure and recomputed outcomes. Git provides `GIT_ADOPTION_SCHEMAS`, `gitAdoptionArchiveReferences`, `verifyGitAdoptionHistory`. All dispatch functions use existing engine/security objects; Node async host checks are an explicit nonserializable dependency supplied before record transitions.

1. Implement shared strict schema/canonical functions and golden digest tests first; send concrete exports to Git worker before either implements dependent gates. Agree final `GitHost.projectId` and observation-verification helper signature once, without parallel duplicate schemas.
2. Implement pure report classifier and coverage/evidence assessment over captured/imported packets. Use one shared intent diff helper if extraction from service is needed; Git single writer performs shared-file change. No source execution.
3. Implement owned proposal and exact review gates; include source binding acceptance and immutable history helpers. Keep approved-plan separate from completion. Unit-test gates before exposing writes.
4. Git single writer connects Node capture/freshness/late-commit and SDK capability refusal, CLI inputs/help, fixture grants/audit/review projections. Share desired operation additions above; no concurrent entrypoint edits.
5. Drift integrates backup closure for both schemas, generated schema exports and a generic synthetic CLI fixture. Git worker supplies finalized record refs/functions first. Existing backup must not regress on projects containing the new records.
6. Run focused new acceptance cases and existing core/CLI/security/backup/recovery/profile/drift regressions, build/typecheck, inspect actual help/output and documentation. Parent integrates independently; no main merge here.

## Acceptance gates (required, not yet run)

Use temporary synthetic Git repos, separate broker state, disabled external fetch and sentinel executables for hostile configuration. No private app payloads, competition examples or TLS-specific records. Tests may manually edit/commit synthetic source; the drift product must never do so.

| Case | Exact expected result |
| --- | --- |
| Generic end-to-end | Seed one source file plus unrelated binary, accepted v0.1 Release and selected mapping; explicit source bind; edit file manually; real CLI drift check reports changed raw hash and unknown behavior; propose revalidate; authorized review returns approved_plan, no source/index/HEAD mutation or successor binding. Reopen broker and inspect exact records. |
| Unchanged and byte-only | Identical observation => no source delta, behavior unknown without evidence. Comment-only/whitespace change => bytes changed, no semantic regression claim. Out-of-scope untouched behavior remains unverified. |
| Intent-only / simultaneous | Against distinct exact Release/eligible Composition => precise intent item changes even with identical source; changing both retains both findings. Blocked Composition and model mismatch refuse. |
| Evidence | Missing, duplicate, wrong criterion/version/fixture/source/tree/target/checker/oracle or failed results cannot become complete passing coverage. Old validation is labeled profile-only. Imported pass/fail => reported outcome change, not authenticated execution; fixed synthetic same-check pass->fail => bounded demonstrated fixture outcome change. Changed oracle/checker => incomparable. |
| Staleness | Change bytes, HEAD with identical selected files, index, watched inventory, scope, proposal, evidence or intent after report and before approve => exit 5/no approved review. Inject source change after artifact staging and before registry publication => no accepted record/index update. Old report remains inspectable. |
| Dirty worktree | Staged, unstaged and untracked changes each appear distinctly; dirty outside scope sets flag. Stable dirty observation can support a plan only. Baseline/successor binding refuses any nonignored dirty state; no stash/reset/add/commit. |
| Incomplete coverage | Omit mapped item/inherited criterion, add unmapped watched file, remove required source, exceed inventory cap => incomplete/blocker; cannot approve complete plan or advance binding. An explicitly bounded declared scope never implies the omitted rest of app passed. |
| Delete / rename | Delete => absent. Rename => deletion+addition and possible exact-hash hint only. Two equal-hash candidates => ambiguous hint; no mapping rewrite. Delete one side of a mapped pair prevents complete coverage. |
| Binary / modes | Changed binary gets raw hash/size classification without decode; invalid UTF-8 stays nontext. Git mode-only change reports separately. Symlink/gitlink metadata classified unsupported; no target/submodule read; accepted baseline blocked for them. |
| Ignore policy | New ignored secret file content never opened or emitted; report count/exclusion. Bound tracked file newly matched by ignore still hashed. Ignored collision cannot satisfy absent-path claim; .git and Strata state inaccessible as scope. |
| Checkout transforms | Clean Git status with CRLF/filter-transformed source refuses baseline. No clean/smudge/textconv/fsmonitor/alias/hook sentinel executes. Skip-worktree/assume-unchanged cannot hide measured drift. |
| Path security | Traversal, drive/UNC/ADS, case aliases, Unicode collision, reserved names, junction/link ancestor, device, nested repo, poisoned .git indirection outside host-approved identity => fail closed, zero external contents read. |
| Races / budgets | Mutate source mid-read, replace entry kind, alter index/HEAD between scans => stale/incoherent, no complete report. Byte/path/time budget exceeded => explicit refusal with no truncation-as-complete. |
| Authority | Reader/author without new grant, another proposal owner, wrong project/repo/Block, copied reviewer label, revoked/expired reviewer after preflight => denied. Existing semantic approval never grants source/Git rights. |
| Retry / branching | Same exact idempotency input reuses immutable refs; altered input conflicts. Cached approval after source change is stale. Competing successor bindings remain explicit branches; neither silently moves a global current pointer. |
| Decision boundaries | Every decision produces correct handoff and exact refs; approve_plan never edits Release, source, mapping or evidence. Missing Git finalization, dirty postapply tree, wrong Release/tree or mismatched predecessor cannot create successor binding. |
| Storage/SDK | Backup/verify/inactive restore retains and validates all new record closure; missing/tampered referenced record fails. Historical verification needs no Git checkout. SDK imported report has asserted trust; live binding/approve fails unsupported without host. Old Release/legacy schema bytes remain unchanged. |

After implementation: `npm run build`, `npm run typecheck`, then `node --test dist/tests/source-binding.test.js dist/tests/source-drift.test.js dist/tests/source-drift-cli.test.js`, followed by relevant existing `core`, `cli`, `security`, `backup`, `recovery`, `profile-separation`, `drift-regression` and `drift-cli` test files. New filenames/commands above are planned; existing scripts were verified in package.json. Record executed/pass/fail/skipped separately. No runtime tests are claimed by this planning deliverable.

## Open limits and handoff

No byte comparator, item mapping, author trace, approved proposal or finite checker proves arbitrary prose/code equivalence, complete behavior extraction or whole-app preservation. Imported evidence can lie; fixed expectations can be wrong; public local identities are impersonable. Ignored/excluded files and unmodeled dependencies remain outside coverage. General committed-code acceptance without the paired finalization proof, autonomous reconciliation, v0.2 mediation integration and authenticated hosted reviews are later work.

Implementation is ready to start with the shared schema. The only coordination refinements are concrete TypeScript host dependency plumbing and exact generated schema filenames; behavior and ownership are agreed. This architecture phase stops without implementing the feature.
