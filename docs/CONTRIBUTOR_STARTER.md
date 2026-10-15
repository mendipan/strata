# Local contributor starter

This is an opt-in, disposable v0.3 project over the existing Node broker, CLI and Studio. It works without a private lab, account, provider token or remote source. It demonstrates the ordinary core loop: accept a measured baseline, propose a new Block and a capacity change, review exact content, publish/select Layers, measure output, attest criteria, validate, obtain separate approvals and record a Release. Restart then reads the same immutable Release and materializes it without replaying Layers.

All eight accounts are **synthetic local development roles controlled by one local user**. Their separate operation grants exercise real `HostIssuer` checks. `host-authenticated` on retained records identifies that configured issuer; it does not establish independent humans or a production identity. This launcher provisions only new local development files. It grants no access to an existing Studio or project.

## Prepare and start

Use Node 22 or later and PowerShell 7. From a clean repository checkout:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
$project = Join-Path ([IO.Path]::GetTempPath()) ('strata-contributor-' + [guid]::NewGuid().ToString('N'))
node dist/scripts/contributor-starter.js prepare $project
node dist/scripts/contributor-starter.js start $project
```

Installation uses the checked-in lockfile; cached installation can add `--offline`, and absent dependencies must be obtained before building. The project path must be canonical and absolute, its parent must exist, and its final directory must be new. Preparation refuses an existing directory and never resets it. Keep this terminal open. The launcher binds only loopback, starts one persistent broker and eight existing local Studio views, and prints labelled launch links. It starts no daemon, cloud service or model.

Preparation copies [concrete generic inputs](../examples/contributor/collection/README.md), writes private development keys plus hash-only accounts/policy, and creates the marker. It creates no baseline, evidence or approvals. Startup writes `strata.config.json`, private `sessions.json` and a nonsecret **`LANE.json`** manifest. Files are mode 0600 and the new folder mode 0700 on POSIX; Windows uses the current user's directory permissions. Do not place the folder in a shared location or commit keys/session files. The links contain temporary loopback capabilities; keep them local.

`LANE.json` pins the actual project/model, persistent state/registry paths and descriptor hash, loopback backend/Studio origins, role grants, runner/profile allowlist, output slots and exact canonical configuration/accounts/policy hashes. It contains no keys, tokens or capability fragments. Its lane ID remains stable across an orderly restart of unchanged state/authority; endpoint/config hashes change when ephemeral ports change. Retain this manifest with the acceptance receipt and compare CLI/Studio refs only within this lane. The transport is the existing local broker session plus local preview capability bound server-side to a role; **hosted HTTPS/cookie authentication is not claimed** and no private certificate/proxy is required.

## Preflight and ordinary commands

In a second terminal, from the same checkout, set `$project` to the exact printed folder and run:

```powershell
node dist/scripts/contributor-starter.js --help
node dist/src/cli.js --version --json
node dist/src/cli.js config show --project $project --json --offline
node dist/src/cli.js doctor --project $project --json --offline
```

Configuration must show model `strata/0.3-block-lifecycle-experimental`, project `contributor-collection`, `local-persistent-fake`, `loopback-only` and `collection-host/1`. This named-issuer lane correctly omits a client identity-policy label: the existing local broker resolves role sessions using its configured `HostIssuer`. `doctor` returns configuration success with identity/current authority **`not_checked`**. **Do not change the identity label to manufacture readiness.** Unknown declared labels, invalid model/profile combinations and remote transports remain failures. Offline doctor does not probe the broker, authenticate a role, inspect records or run checks. Runtime capability/authorization and the measured loop below establish their own narrower results; even a revoked account's structurally valid configuration can pass doctor while actual operations refuse.

The starter explicitly assigns the local user all eight learning roles. Select a role deliberately for its documented task; changing identity after a refusal is not a recovery procedure:

```powershell
$sessions = Get-Content -LiteralPath (Join-Path $project 'sessions.json') -Raw | ConvertFrom-Json
$env:STRATA_SESSION = $sessions.sessions.reader
node dist/src/cli.js capabilities --project $project --json --offline --non-interactive
node dist/src/cli.js status --project $project --json --offline --non-interactive
```

An empty project before `init` is expected. A refusal, unavailable profile, expired role or missing broker is a blocker, not permission to create evidence or alter policy. Capability discovery is not approval. Use the exact returned model/profile/principal and supported operations, and later `capabilities --target EXACT_REF` for a particular candidate. Git/parser/capability corrections remain owned by their separate implementation lane.

| Synthetic role | Explicit task |
| --- | --- |
| `author-a` | Initialize this new project, propose the audit and chosen capacity, publish after exact review, compose and seal the endorsed whole-Layer decision |
| `author-b` | Author and publish the competing policy-capacity proposal; cannot create Blocks or approve |
| `reviewer` | Receive complete normalized content from the author; attest authoring and exact realization criteria |
| `runner` | Materialize into the three configured slots, measure the finite compiled output, validate assembled evidence |
| `scope-selector` | Explicitly select the exact prepared whole-Layer partition, then separately approve the resolved collection candidate and evidence |
| `release-manager` | Separately approve Release and publish with validation plus approval refs |
| `safety-guardian` | Protected `policy/requirements.atomic` approval, if that protected item changes; these examples do not change it |
| `reader` | Read published records and review state; no writes or approvals |

## Run the attended loop

```powershell
./examples/contributor/collection/walkthrough.ps1 -Project $project -Capacity 7 -ChangeLayerId MySeven -AlternateCapacity 4 -AlternateLayerId OtherFour
```

The [readable PowerShell recipe](../examples/contributor/collection/walkthrough.ps1) invokes only ordinary CLI commands, with JSON files/argument arrays. It never imports the engine or a test helper, and adds no special workflow endpoint. Choose your own distinct limits from 2 through 32, different from baseline three, and fresh Layer IDs; defaults are five/four. Author identities remain server-resolved. Authors may choose their own Layer IDs but are confined to assigned Block/parent scopes. The chosen numeric expectation is supplied literally to the observer, never read from generated configuration or an engine oracle. An ordinary assigned-author task can use the same source inputs, supplied role session and [Strata skill](../agent/strata/SKILL.md); no model/agent run is provisioned by this starter.

The recipe prints exact content/criteria, packet and review state and pauses before every review, whole-Layer selection, scope approval and Release approval. Read the intent, output and evidence; type `ACCEPT` only for the synthetic decision you intend to record. Anything else stops before submission. Raw command envelopes and exact submitted inputs remain in `receipts/`; the final result pins all returned refs. The script restores the previous `STRATA_SESSION` on exit.

1. `init` records `StarterCollection@1`: an **unvalidated bootstrap** with collection/items/policy Blocks, explicit scope/Release authorities and capacity three. A zero-Layer Composition is separately materialized and accepted through measured evidence, criterion review, validation and both approvals. The accepted baseline ref comes from `release`, not from guessing a name.
2. `StarterAudit` proposes a new audit Block under the assigned collection parent, complete relationships/contracts and inherited acceptance links. The chosen capacity Layer raises the supported limit from three to the contributor-selected value. Each input is pinned to that **returned accepted baseline**. `layer preview` supplies the normalized content digest; `layer create` saves a private owned draft. The author supplies normalized JSON to the separate reviewer. `content review` records that exact digest; `layer publish --authoring-review REF` publishes only that reviewed revision. Publication does not select it.
3. The second owner publishes a reviewed conflicting capacity Layer. `compose` retains **all three** exact proposals and returns a blocked candidate. `mediation prepare` pins the complete whole-Layer selected/rejected partition; an owned decision-only Layer records its exact returned payload. Packet preparation binds that published decision. The responsible selector explicitly responds `approve_selection`, then `resolve` seals the exact endorsed decision. A new immutable Composition revision retains all considered refs, selects the audit plus chosen capacity Layer and retains the losing proposal as rejected. It remains separate from the accepted baseline.
4. Only this resolved candidate is materialized using `collection-host/1` and slot `changed`. The [independent literal observer](../examples/contributor/collection/observe.mjs) checks actual generated behavior against the contributor's chosen capacity, Unicode bounds, atomic rejection, detached reads and successful-mutation-only audit history. Blocked candidates cannot be materialized; selection itself supplies no execution evidence.
5. `evidence run` executes the existing configured finite host runner against pinned current output. Passing mechanical checks leave `review_pending:true`. The reviewer attests each exact review criterion from the retained realization; `evidence assemble` combines the run and criterion refs. `validate` checks bindings and current disk bytes; validation does not run the tests itself.
6. `review state` supplies the candidate, baseline authority hash and remaining gates. Approval requests use `approval/3`, exact project/model/baseline/candidate/evidence digest/current generation, scope `collection` for the selector and null scope for the separate Release approval. `release` consumes exact validation and both refs and checks output again. It does not deploy anything.

The bootstrap and original accepted baseline remain unchanged. The final Release includes the four-Block snapshot, selected Layer provenance, resolved selection, acceptance, validation and authentic local issuer receipts. `walkthrough-result.json` retains the original blocked considered set, losing proposal, basis/packet/decision/selection/Resolution refs as well as accepted outputs. The recipe does not infer readiness from a `ready` boolean: the existing pure review projection cannot recheck current output bytes; the ordinary Node materialization/validation/publication boundary performs those checks.

## Stop, restart and read back

Use Ctrl+C in the starter terminal, then restart that **same prepared folder**:

```powershell
node dist/scripts/contributor-starter.js start $project
```

The broker rereads its retained records; new session tokens/ports/launch links replace the old ones. Reload `sessions.json`; old CLI tokens and old view links cannot authorize the new process. In the second terminal:

```powershell
./examples/contributor/collection/walkthrough.ps1 -Project $project -Readback
```

This compares the exact saved Release record with a fresh CLI read, independently materializes that Release into the new `.strata/independent` slot, compares its output tree with the changed realization and reruns literal observations. It replays no Layers or approvals. `receipts/readback-result.json` retains the result. Readback is a one-time fresh-slot exercise; rerunning into a populated output directory is refused, not silently reused or deleted.

The generated collection's **application state is in memory**: a new instance is empty. Restart persistence here refers to Strata's immutable intent/evidence/history, not collection items or audit events across processes. The fixed development policy expires eight hours after preparation; sessions expire after 30 minutes. Restart can remint local sessions within that same policy window and cannot renew the policy. After expiry, create a different disposable learning project or report the refusal. Do not edit retained authority, reset state or delete a lease to force progress. Interrupted preparation/start or uncertain writes require inspection; there is no automatic retry, reset, stale-lock reclaim or production recovery mechanism in this launcher.

## Studio alongside the CLI

Open the labelled local links. Each view binds to its named synthetic role on the server and the same persisted broker, records, slots and authorization rules. There is no role switch in the browser. The `reader` view can browse published Releases, Block maps, Layer comparisons and the review inbox; use the refresh action after CLI writes. Reloading a page needs its still-valid full launch link because the capability is held in browser memory.

| Existing Studio surface | Starter use and current boundary |
| --- | --- |
| Changes | Use the named author view and the accepted baseline. The simple initial root form does not build the collection's complete profile meaning, so initialize with the supplied CLI recipe. For browser audit creation use **Add a Block through an owned Layer**, then **Owned next revision** to supply the complete `create-audit.json` content with returned baseline/owner/revision before exact review/publication. The initial simple form alone does not supply the compiled profile's complete requirements/contracts. |
| Review inbox / candidate | Inspect proposed/effective intent separately from the accepted baseline; runner uses profile `collection-host/1` and slot `baseline` or `changed`. |
| Private new-Block requirements | **Edit new Block requirements** edits or adds a rule with typed statement/facets/existing criterion links and number/boolean parameters, then previews and saves the exact next owned revision. Complete contract/criterion authoring remains advanced JSON; finite profile meaning and guardian-assignment refusal still apply. See [typed requirements](studio/TYPED_REQUIREMENTS.md). |
| Candidate actions | Configured measured run, criterion attestation, assembled evidence, validation and separate approvals use the same backend as CLI; disabled actions reflect the role grant. |
| Resolve competing whole Layers | Keep both owners' capacity Layers in the considered set. Existing advanced basis/decision/packet/response/Resolution/next-candidate forms use the exact same mediation operations as the recipe. The losing Layer stays considered after sealing. |
| Private authoring review | The reviewer cannot browse another owner's private draft. The author can **Prepare reviewer handoff** on an owned unpublished revision; the reviewer uses **Review supplied draft**, then returns the exact immutable authoring-review reference for publication. This is explicit supplied-content transfer under existing grants; the normalized-JSON CLI route remains available. See [exact handoff](studio/AUTHORING_HANDOFF.md). |
| Settings / agents | No provider/source connection, production owner enrollment, agent chat or task bridge is provisioned. These are separate supported/unsupported capabilities, not prerequisites for this local loop. |

The qualification checks exact Studio HTTP readback and refusal through the existing API. It does not claim a fresh human completed every step using browser forms. The full tested attended recipe is the CLI route; the UI handoffs above remain explicit.

## Finite support and qualification

This example is a recognized compiled in-memory collection, not arbitrary application generation or inference from a repository. Native Git adoption, Python applications, automatic code understanding, Block deletion/reparenting, uploaded execution commands, hosted authoring setup and live credentials/grants are outside this starter. A shape-valid generic Block can still be unsupported by the finite profile. Existing offline backup does not activate authenticated host identities or provide this lane's recovery contract; an orderly broker restart is the demonstrated persistence boundary.

Run the focused qualification after building:

```powershell
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/contributor-starter.test.js
```

It uses new disposable generic folders and actual CLI/PowerShell subprocesses. It checks Block creation, exact review/publish/selection, both accepted Releases, observed three-to-five/audit behavior, a fresh seven-item Layer and completed competing-owner mediation, tampered-output refusal, missing-review refusal, separate approval enforcement, private-draft hiding, exact-generation Studio readback, new-session restart, unchanged old baseline, independent rematerialization and spent-policy/partial-start refusal. Nonsecret receipts are `.strata/contributor-starter-evidence.json` and `.strata/contributor-walkthrough-evidence.json`. Provider access is neither configured nor required. Full browser creation/mediation, an actual assigned-agent completion, independent human usability and combined final-SHA contributor acceptance remain separate gates; this checkpoint supplies their tracked startup/input/operation contract.
