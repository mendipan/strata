# Local original-versus-reconstruction acceptance

This implements the smallest **IMPLEMENTATION_PLAN E1 acceptance-harness** slice. That ID is distinct from the later gap list's E1 cached CLI presentation enhancement. The accepted base is `3948da31792e75b66cf80f45cf19bcb8ece76c1f`, including A2+B and browser bootstrap. No architecture decision is required for this fixed synthetic slice.

The [standalone Node script](../scripts/collection-acceptance.ts) compares an independently authored, fixed Array-based original with separate exact [collection-node/1](../src/profiles/collection.ts) modules at baseline 3 items / 20 title code points and changed 5 items / 20 code points. The original has no generated config and is not copied from the Map-based template. The [acceptance suite](../src/acceptance/collection-suite.ts) uses independent literal expectations, not generated config or the existing profile checker. Equal wrong behavior cannot pass.

This is local synthetic observation, not arbitrary-app execution, universal equivalence, authenticated evidence or an accepted Release. It creates no Engine records, adoption/output association, approval or reconciliation completion. Actual user apps, credentials, owner activation, deployment and hosted agent execution are outside this slice.

## Supported command and evidence

Prerequisites: Node >=22, Git supporting `init --initial-branch`, and an existing dependency-equipped checkout. Run from the checkout root. No new dependencies, package installation, account access or network execution are required. Replace `NEW_DIRECTORY` with a new absolute directory whose parent exists; it must not already exist. PowerShell example creates only a synthetic folder under the tester's temporary directory:

```powershell
npm run build
node dist/scripts/collection-acceptance.js --help
$trial = Join-Path ([System.IO.Path]::GetTempPath()) ('strata-collection-acceptance-' + [guid]::NewGuid().ToString('N'))
node --import ./tests/no-external-fetch.mjs dist/scripts/collection-acceptance.js demo --output $trial
Get-Content -LiteralPath (Join-Path $trial 'evidence/receipt.json')
```

`demo` creates a new one-file synthetic Git repository and commits only its fixed original module using command-local fixture identity. It authors the existing literal baseline/Layer/Composition through an in-memory Engine, then independently exports baseline and changed modules. It does not publish a semantic Release. The Git repository, two exports and evidence are sibling directories; the original remains usable and unchanged.

Expected process exit is **0**, status `passed_declared_scope`, **14/14** checks passed, three worker exits 0, `inputs_unchanged:true`, and all seven required coverage rows `covered`. `approval`, `release` and `reconciliation_complete` remain false; `equivalence` remains `not-established`. The one intentional-delta row is `changed/capacity`, with `equal:null`; equality is deliberately not expected there. The other six changed surfaces must equal original observations and match their literal expectations.

Retain the whole trial folder. `evidence/receipt.json` records full original commit/tree/index/branch and module pins, both reconstruction manifest/candidate/profile/output/oracle/file pins, fixed suite/worker/harness/fixture/expectation hashes, Node version/platform/architecture/executable hash, time/output/memory bounds, actual process exits/signals/times, log hashes, observable traces, case results and declared coverage. Each evidence lane retains confined copied modules plus `stdout.log` and `stderr.log`. Labels supplied in realization manifests are not authenticated by the retained Engine store; the receipt states this limitation.

To repeat checks on the retained synthetic inputs, use a **new** evidence directory:

```powershell
$originalHead = (git -C (Join-Path $trial 'original') rev-parse HEAD).Trim()
node --import ./tests/no-external-fetch.mjs dist/scripts/collection-acceptance.js check --original (Join-Path $trial 'original') --original-head $originalHead --baseline (Join-Path $trial 'baseline') --changed (Join-Path $trial 'changed') --output (Join-Path $trial 'evidence-repeat')
```

POSIX shells use the same Node command and named flags with quoted absolute paths. Only Windows was qualified in this checkpoint; no cross-platform result is implied.

## Declared matrix and honest stop conditions

| Surface | Fixed observations | Changed candidate requirement |
| --- | --- | --- |
| lifecycle | Empty start, add/get, ASCII order, repeat completion, removal | Preserve |
| detached | Returned add/get/list/complete objects cannot mutate instance state | Preserve |
| identifiers | Selected invalid IDs, line terminators and maximum valid length | Preserve |
| titles | Nonblank, 20/21 astral code-point boundary, original whitespace retained | Preserve |
| atomic | Selected duplicate/invalid/length/missing failures and final unchanged state | Preserve |
| capacity | Six attempts, explicit failures, sorted state, removal and reused capacity | Intentional 3-to-5 count delta; rejection after five |
| instance-reset | Independent second and new instances start empty | Preserve |

These are finite vectors, not exhaustive input-space coverage. Complete declared accounting is not automatic semantic extraction. No persistence, UI, networking, build system, data migration or live cutover is established.

An optional `--declaration JSON_FILE` supplies an array of strict `{id, disposition, rationale}` objects; disposition is `in_scope`, `unknown` or `excluded`. All seven fixed surfaces must remain declared in scope. Missing or excluded required surfaces are uncovered. Extra in-scope IDs are uncovered; unknown IDs remain unknown. Extra out-of-scope exclusions require a rationale and stay visible. Duplicate IDs or an empty declaration refuse. A passing fixed suite with any unknown/uncovered row returns **`incomplete`, exit 5**, never success.

The [focused tests](../tests/collection-acceptance.test.ts) exercise an incomplete scope with unknown persistence and uncovered UI. They also verify equal-wrong behavior, unintended deltas, unchanged Git/input pins, log retention, unsafe worker bytes, caller loader stripping, output non-reuse, overlapping directories and tampered reconstruction refusal.

Unknown original code, another collection configuration/profile, extra/missing files, links/hardlinks, dirty/stale Git or mismatched measured bytes stop before worker execution when discovered at preflight. A source change detected by the final reread leaves a refused receipt and no current-freshness assertion. Failed/malformed/nonzero/bounded-out worker runs produce failed observations, exit 6. Refused supported checks return exit 8; invocation/path setup failures return exit 2. Existing evidence is never overwritten. Inputs and their Git state are never repaired automatically: restore only the tester's deliberate synthetic edit, or recapture a new explicitly accepted source; then choose a new evidence folder. Prior receipts remain historical.

The subprocess uses fixed executable/argument arrays, vetted compiled source, sanitized environment, 5-second execution timeout, 64-KiB combined process output bound and 64-MiB old-generation limit. No source-provided command, import, package script, executable parameter or callback is accepted. Copied input bytes are executed from a rechecked in-memory data URL, so a changed cwd file cannot replace the measured module. This is not a security sandbox for untrusted code. The original and both reconstruction directories are reread after execution; it is a bounded observation, not a filesystem lock or continuous drift watch.

## Ownership and next gates

Owned files are new `src/acceptance/collection*.ts`, `scripts/collection-acceptance.ts`, `tests/collection-acceptance.test.ts` and this document. Core, adoption persistence/records, schema, CLI, profile registry/archive, auth/runner, Studio, browser-owner security and hosting remain unchanged. No shared seam is needed for this checkpoint.

Remaining E1 work: a separately reviewed allowlisted original-app boundary and fixed owner-configured tests for another supported layout; exact linkage to accepted adoption/publication and Release pins; stronger application coverage chosen by its owner. G2's adoption/output bridge and R1 reconciliation-completion remain separate dependent contracts. No general source runner or hosted evidence integration is introduced to close them implicitly.

Checkpoint gate: build/typecheck; new acceptance tests plus existing collection/conformance/module-entry regressions; standalone synthetic demo and incomplete/refusal recipes; links; exact new-only diff and source SHA. Full aggregate regression belongs to the parent after candidate freeze/integration and is not duplicated here.
