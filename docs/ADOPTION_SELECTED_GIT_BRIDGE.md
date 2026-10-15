# Finite local adoption to selected Git delivery

G2 links one reviewed and published v0.1 adopted Layer to one existing-module Git change. It is an explicit `git plan` opt-in. The recognized profile is `counter-fixture/1`, the checker is `counter-application/1`, and the only writable path is `counter.mjs`. This fixture demonstrates a reusable workflow boundary; it does not provide an arbitrary application interpreter, runner or profile.

## Source and storage

An existing application remains in its Git repository: original code, tests, assets, branches and owner commits. Strata intent, exact proposal/publication lineage, validated Releases, source snapshots, acceptance and delivery records reside in a separate local intent store. Private inventory descriptions and rationale stay private. Owner-approved public linkage discloses exact refs, hashes, unit/item/path/criterion mappings and original grant provenance. Disclosure does not authenticate fixture identities.

The baseline association pins one separately validated no-change Release and the original clean commit/tree. A broad source capture A inventories preservation files; a narrow source capture B binds exactly the union of adopted files/dependencies/items/criteria. Their manifest digests can differ. Repository/project/object format/commit/tree must agree, and B must be the exact derived subset of A. Untouched broad files retain their original bytes. Adopted files/dependencies are present ordinary UTF-8 text files; preserved outside files may be binary. Explicit paths only, at most 256; watch roots, additions, deletions and mode changes are unavailable in G2.

Before apply, original Git and its owner-approved baseline remain the implementation source. The selected Composition becomes the proposed semantic source; its exact validation-target Release and staged implementation need separate acceptance and review. Apply changes only the reviewed module in the working tree and retains HEAD/index. The owner then makes one direct-child commit with the exact reviewed full tree. Finalization and an optional successor association record that relationship. Drift is checked at every active delivery/replay/publication gate; these checks are not reconciliation completion or whole-application equivalence.

## Fresh-checkout synthetic recipe

Obtain a new checkout pinned to the candidate SHA from the review handoff, with Node >=22, npm lockfile dependencies and native Git. Dependency installation follows the tester's approved provisioning; offline runs require dependencies already present. Never use an existing external application as this fixture's output.

Windows PowerShell:

```powershell
git rev-parse HEAD # compare with the review handoff's exact candidate SHA
npm run build
npm run typecheck
$trial = Join-Path ([System.IO.Path]::GetTempPath()) ('strata-g2-' + [guid]::NewGuid().ToString('N'))
node --import ./tests/no-external-fetch.mjs dist/scripts/qualify-adoption-selected-git.js --out $trial
Get-Content -LiteralPath (Join-Path $trial 'report.json')
```

Linux (qualification remains required if the handoff has no Linux receipt):

```sh
git rev-parse HEAD
npm run build
npm run typecheck
trial="$(mktemp -d)/strata-g2"
node --import ./tests/no-external-fetch.mjs dist/scripts/qualify-adoption-selected-git.js --out "$trial"
cat "$trial/report.json"
```

The parent directory must exist and the final trial directory must be new, outside any existing Git repository. Existing output is refused. The script creates only a disposable app, separate intent/Git state, synthetic fixture assignments and loopback broker. It performs its demonstrated owner commits only in that new app. It accepts no supplied executable, app path, credentials or live service. The external owner should preserve the trial and inspect the retained command packets; reruns use new directories.

Expected exit: 0. Deterministic report invariants:

- `status: qualified_fixture_lane`, `host_closed:true`, `adoption_delivery_bridge_established:true`.
- `bridge-plan.json` contains `git-change-plan/2` with the exact acknowledged disclosure hash; application acceptance is `git-acceptance/2`, review is `git-apply-review/2`.
- `delivery.state: owner-committed-and-natively-finalized`; owner commit, finalization and successor binding are exact retained refs.
- Module behavior changes the recognized ceiling from 6 to 12. Existing tests, text, binary and attributes remain byte-identical. The untouched history branch still pins the original commit.
- HEAD/index remain original until the synthetic owner commit. Apply retry reuses its exact receipt; a test-only post-write fault restores original bytes/pins.
- Restart preserves accepted Release and exact binding. Inactive backup verifies and restores no identities/grants/host paths.
- `execution_authenticated:false`, `automatic_extraction:false`, `reconciliation_complete:false`, `whole_application_equivalence:false`, `universal_equivalence:not-established`.

Ports, temporary paths, Git OIDs and semantic refs vary. Capture the exact source SHA, Node/Git/platform, command arrays/exits, raw stdin/stdout/stderr and hashes, private/public lineage refs, preview hash, original/final Git pins and file hashes, acceptance/review/receipt/finalization chain, restart and backup receipt. A stored draft or schema parse alone does not satisfy these invariants.

## Manual command contract

Use the existing `git plan --file FILE --dry-run` with an additional strict input:

```json
{
  "binding_ref": "EXACT_BINDING_REF",
  "target_ref": "EXACT_COMPOSITION_REF",
  "write_paths": ["counter.mjs"],
  "checker": "COPY_EXACT_CHECKER_OBJECT_FROM_RETAINED_PACKET",
  "oracle": "COPY_EXACT_ORACLE_OBJECT_FROM_RETAINED_PACKET",
  "regressions": ["unrelated-byte-preservation"],
  "adoption": {
    "publication_ref": "EXACT_PRIVATE_PUBLICATION_REF",
    "expected_bridge_sha256": null
  }
}
```

The strings describing checker/oracle are marked placeholders, not valid inputs. Copy the complete objects and exact refs from the synthetic trial's raw packets. The proposal owner previews the linkage; no plan is retained by the G2 preview. Set `expected_bridge_sha256` to that exact preview hash and run the same command without `--dry-run`, with an explicit idempotency key. Do not invent a `git bridge` command.

The actual trial demonstrates the remaining supported commands and role packets: `git stage PLAN --patch FILE`; `git check STAGE --checker counter-application/1 --oracle FILE`; `git review --file FILE --dry-run`, then exact digest approval; `git apply STAGE --review REVIEW --idempotency-key KEY`; owner Git diff/test/add/commit; `git finalize RECEIPT --commit COMMIT`; `source capture --file FILE`; `source bind --file FILE`; `git transaction inspect --file FILE`; and explicit `git transaction recover --file FILE` after recovery review. Fixture selectors are public local test labels. Each actor needs its configured role; selectors are not passwords.

Original owner, interpretation reviewer, acceptance producer and Git reviewer grants are retained separately and reauthorized exactly. Another grant for the same principal cannot substitute for a removed, expired or narrowed original grant. Pending review also retains native policy freshness. The Git reviewer must be responsible for both bound source and target scopes. Complete imported success evidence cannot finish G2; imported observations remain non-completing.

Current exact grants and the acting assignment are checked synchronously after native work and immediately before local index publication. A refusal before a durable apply receipt uses guarded rollback; refusal on replay preserves the already durable applied state. Completion verifies the exact typed, content-addressed receipt, plan and endorsement versions before choosing its legacy or bridged proof path. An absent plan or v1-shaped replacement does not establish legacy completion.

## Failure and repeat behavior

Stop on unsupported profile/scope, refused disclosure, missing lineage/mapping/criterion, stale source/grant/policy, failed checker, mismatched validation target, dirty source or `recovery_required`. Capture the first failing packet and app/Git pins. No endpoint creates passing evidence to skip a gate.

Use the identical idempotency key and payload only while the original phase is still valid. Response loss after durable plan/apply/finalize can reuse the original result; changed payload conflicts. Apply retry after an owner commit and old plan retry after source advances refuse. Inspection remains available. Revocation after the owner commit blocks finalization and preserves the historical applied state; there is no automatic revert of the owner's commit.

Apply uses the native write-ahead journal. A failure rolls back only safe own postimages; third-party bytes are preserved. A conflicting module requires explicit recovery. A dead broker's generic state lease requires operator reconciliation after verifying that exact process has stopped. Backup remains inactive until a separate authorized trust/configuration binding; the archive contains no active grants.

Omitting `adoption` creates the original plan/1 with derived `bridge:legacy-unbridged`; it never acquires G2 through later matching. Reconstruction uses the shared interpretation workflow but independent output trees and its existing honest stop. It is not supported by this selected bridge.

External owner prompt:

> Run the delivered G2 synthetic recipe from a fresh pinned checkout. Inspect the disclosed linkage, exact selected Layer, patch, compiled acceptance, exact validation-target Release and preserved-file hashes. Record all exits and refs through owner commit/finalization/successor binding, restart and inactive backup. Stop at the first refused or unavailable gate. Do not use a real app or live agent to compensate for a gap.

Independent reviewer prompt:

> Review the frozen candidate against the accepted G2 contract and 40-case matrix. Attempt lineage substitution, mapping loss, imported success, wrong validation target, exact-grant substitution, awaited source/authority races, safe rollback, replay after owner commit and private-edge archive laundering. Distinguish pure structural tests from native host measurements. Do not mutate the candidate or run a duplicate aggregate. Return exact locations, measured results and remaining platform limitations.
