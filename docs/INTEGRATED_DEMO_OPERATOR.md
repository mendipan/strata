# Optional attended integration example

The booking integration example demonstrates explicit owned proposals, exact decisions, dependent repair, measured realization, separate Release approval and bounded cleanup. Its host tooling is separate from the core and ordinary offline onboarding.

## Host configuration

There is no built-in cloud account or retained namespace. For terminal preparation, set nonsecret `STRATA_DEMO_ACCOUNT_ID` and `STRATA_DEMO_NAMESPACE` in the host environment before invoking `scripts/start-attended-demo.ps1`. The namespace must be explicitly authorized; configuration alone grants no execution permission.

The browser host reads ignored `.strata/demo-lab-profile.json`. Its `target` has exactly `account_id`, `worker_name`, `workflow_name` and `namespace_id`. It also requires format `strata.browser-demo-lab/1`, exact `source_sha256`, verified diagnostic flags, an evidence locator, `recorded_at`, and `infrastructure` containing retention policy and exact Worker/Workflow version IDs. Old profiles lacking the target refuse. Deployment setup and its evidence belong outside this repository.

`demoLabWorkerConfig(root, sourceSha256, target)` creates a configuration with disabled public URLs and an exact serialized `STRATA_LAB_TARGET` binding. Readiness verifies that binding and deployed source/version; the Worker independently compares it with every grant before entering the runtime. Editing a local profile cannot authorize a different deployed target.

After separately authorized host setup, `scripts/start-demo-browser.ps1` opens the loopback controller; `-NoBrowser` prints its link.

Leave that terminal open. Chrome opens the private local link; `-NoBrowser`
prints the link instead. The top console performs read-only readiness checks.
It verifies installed CLI versions, ChatGPT subscription authentication, both
Cloudflare account permissions, the exact deployed source and Worker/Workflow
versions, absence of previous instances/repositories, and full-step read access.
It creates a disabled review, never a grant or model invocation. Each controller
allows at most eight explicit readiness passes (eight Cloudflare CLI reads per
successful pass), separately recorded from each run's 180-call/160-read limits.
Readiness expires after five minutes; the browser can explicitly check again.

Enter a self-declared name, check the one-run approval box, and click **Begin
demo**. This creates a format-3 grant recording the actual local-browser action,
exact source, version identities, resources, limits and retention policy. No
digest or START text must be entered. Identity is not cryptographically
authenticated. The 30-minute clock starts on Begin. Sign-in recovery buttons
open the supported provider flows; any device code remains in the terminal.
Then explicitly recheck readiness. No API billing fallback is allowed.

The stable Worker accepts a grant only through its account-authorized Workflow
parameters. Its deployed source digest and version metadata must match that
grant before the real demo runtime is activated. Each run has a fresh instance
and repository, one consumed grant claim, the original three Luna actor limits,
and separate conflict and Release gates. **900 seconds can complete the demo**;
1200 seconds stops at the repair gate under the default three-process grant.
For a separately approved reminder-repair run, start the browser controller with
`node dist/scripts/integrated-demo-browser.js --allow-reminder-repair`. Its review
explicitly allows four CLI processes, still three distinct Luna actors: B gets
one additional High-effort invocation only after a 1200 choice. B retains its
cumulative four-turn/20-tool allowance; every other guard is unchanged. The
repaired proposal requires a fresh selection and then separate Release approval.
Prior three-process grants cannot authorize this continuation. The $1 target is not a billing cap; provider dollars are
unverified. The browser displays local records and checkpoint observations,
not a continuous provider feed.

Normal cleanup verifies terminal accounting, all scoped token revocations,
settled dispatches and disposed handles before deleting the run instance and
repository. It verifies their absence and the retained namespace is empty, and
checks that the same Worker/Workflow versions remain. Their retention is
recorded explicitly; absence is never fabricated. The format-3 admission ledger
and provider adapter both refuse Worker/Workflow deletion or deployment.

**Prepare a fresh demo** becomes available only after cleanup (or verified
absence of any mutation). It prepares a new review and requires another Begin
approval. Duplicate clicks, stale reviews/source, uncertain calls and consumed
grants cannot start another attempt. Closing the page does not stop the runner;
use **Stop safely and clean up** or Ctrl+C, then wait. A lost controller retains
the active marker and evidence for owner reconciliation.

Evidence is `.strata/browser-<run-id>/`; the verified persistent infrastructure
profile is `.strata/demo-lab-profile.json`. A source change disables Begin until
an operator separately reviews/deploys the new code and verifies its inert
diagnostic. Browser controls never redeploy, register a new Workflow version or
automatically retry provisioning. Verify the linked Worker and Workflow versions
independently; a successful deployment response alone does not prove their binding.


## Runtime and failure contracts

An actor invocation is not evidence of publication. Preserve tool outcomes and exact Workflow checkpoints; refuse gaps, duplicate identity conflicts and stale responses. Read complete step output through a bounded provider seam when an observation is truncated. Never replay an event to repair an uncertain read. Keep in-flight accounting until dispatch settles; timeout is not cancellation.

The management journal binds run-owned resources, source, versions, grants and counters. Unknown provider work, unclean tokens or unresolved handles preserve the repository for reconciliation. Persistent Worker/Workflow resources cannot be deleted by a per-run grant. A failed cleanup prevents a new run. Source changes require a new deployment review and grant.

The 900-second fixture path uses three actor processes. The 1200-second path needs an explicitly reviewed fourth process for the original reminder owner's revision and a second selection review. Neither choice removes scope, guardian, evidence or Release gates.

Before a successful endorsement output is exposed, the runtime stages the final
records and opens a fresh `ArtifactRegistryStore` over the same run-scoped adapter
and budget. It re-reads four exact commit/path/hash/size locators: Release,
inherited Composition, registered realization and validation. A new Engine
reconstructs the inherited app from those stored records. The check binds the
Release snapshot, obligations and provenance to the measured candidate, and the
stored realization/validation to its exact evidence. The candidate and earlier
history were read at immutable locators earlier in the same apply; this is not a
fresh read of every retained record or a new independent approval. The read-back
receipt records that boundary, registry digest, exact locators, refs and digests.
The operator checks the receipt against its measured evidence, then measures the
freshly reconstructed inherited app before emitting `release-verified`.

Endorsement reserves 13 stage dispatches and 12 read-back dispatches; its stage
adds at most four records. The existing per-apply ceiling remains 100, and the
2000-dispatch/64MiB run limits, original deadline and token ceiling are unchanged.
A missing, corrupt, mismatched or expired final read refuses success with charged
work retained. The final staged objects can be orphans; failure does not undo
their remote write or certify a Release. Existing terminal accounting and safe
disposable cleanup still apply. A successful receipt is retained locally after
the run repository is deleted; it does not attest a retained hosted repository.

Actor evidence is saved once on subprocess failure as well as success. It includes
bounded stdout/stderr (including malformed partial JSONL), nullable exit status,
termination reason, child-close observation, command/args, wall timestamps,
monotonic duration and environment **names only**. Bridge values and truncated
bridge suffixes are masked. Unknown injected runner failures have empty output
and unknown exit status; raw exception text is not copied into the receipt.
`viewer-events.jsonl` retains `execution-observed` with host actor and serialized
operation spans on success and failure; `result.json` also records failed runs.
Actor/result files and events are synced before close. Host spans include setup,
tool waiting and cancellation; they do not prove simultaneous model inference or
measured token usage. All local children settle before any remote deletion; an
unobserved spawned-child exit blocks deletion for exact operator reconciliation.

These source changes require rebuilding the activation source manifest and a
separately qualified exact deployed Worker/Workflow version and fresh grant.
Old source-qualified lab profiles or grants cannot authorize this runtime.

## Local verification

The activation source manifest pins an explicit inventory of local compiled
dependencies and their TypeScript sources. The offline source-closure regression
parses static imports, including literal dynamic imports, from the reviewed
entrypoints and refuses an omitted dependency. A changed or missing pinned file
requires a new exact review; rehashing an incomplete manifest cannot restore an
old approval. External packages and tools remain separately qualified through
the pinned lockfile and fresh runtime checks. Computed imports are outside this
static closure check. Expanding the inventory grants no execution or deployment
authority.

Run the aggregate plus `node tests/demo-run-browser.mjs`. Injected synthetic actor/management seams exercise the actual controller, packets, activation, journals and viewer without cloud/model calls. `npm run demo:replay` uses a reproducible synthetic example, not an operational receipt. The generic replay exporter accepts a caller-supplied external directory and a new output path. Keep real run records outside Git.
