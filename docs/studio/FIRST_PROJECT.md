# Fresh finite Studio project

An independent installation can provision a v0.3 `collection-host/1` project through the namespace host. This is a finite in-memory collection API with three required Blocks (`collection`, `items`, `policy`) and an optional supported `audit` child. It does not interpret arbitrary application prose or execute caller-supplied code. The installation uses the customer's own Cloudflare Artifacts account and existing namespace. The coding-agent runner has separate setup and consent.

## Explicit provisioning input

For a **new namespace lineage**, a trusted operator may add this object to the root-controlled `strata-studio-namespace-policy/1` policy before preparing `initialNamespaceFiles(policy)`:

```json
{
  "first_project": {
    "format": "strata-studio-first-project/1",
    "template": "collection-host/1",
    "authority": "single-human-author-reviewer-validator-release",
    "lifetime": { "mode": "until", "expires_at": "2026-10-17T07:00:00.000Z" },
    "max_items": 3,
    "max_title_length": 20
  }
}
```

Choose an actual reviewed expiry; the date above is an example, never a standing grant. Counts must be 1–1000; title lengths 1–200. There is no default role assignment or expiry. Omission preserves draft-only initialization and the empty root baseline. Do not edit an approved policy or retained genesis to enable this feature: its policy digest, catalog and accounting bindings fail closed. Provisioning/migration of an existing lineage needs a separately reviewed protocol.

Settings displays the named `principal_id`/`account_id`, the finite template and role expiry. Namespace approval additionally requires `project_authority_sha256 = digest(policy.first_project)` in the existing `approve` request. The ordinary scope digest still binds the entire namespace policy. The authenticated human must explicitly confirm these displayed roles; older clients cannot silently approve them. Fresh confirmation, CSRF, owner binding and namespace controls remain enforced.

The same named installation owner is the author, content/criterion reviewer, validator, scope selector, guardian and Release approver. This is a single-person workflow and offers no independent reviewer separation. `strata-host-policy/2` authorizes only the finite operation list, writes to `collection`, `items`, `policy`, `audit`, creation under `collection`, scope/guardian/Release approval kinds, and `collection-host/1`. The role expires at the chosen time; namespace consent does not extend it. The immutable baseline assigns that same principal the collection scope and Release role and guardianship of `policy/requirements.atomic`. The backend still rechecks every operation and endorsement.

## Initialization and ordinary workflow

1. Complete the existing protected browser-owner setup, sign in over HTTPS, save the customer's own Artifacts token, and confirm the displayed namespace and first-project authority. Installation and live provider actions require action-time owner approval.
2. Create a project using the normal repository switcher. Studio initializes only a new empty repository. The product template supplies recognized intent and acceptance criteria; the entered purpose becomes the collection description, since the finite semantic purpose is fixed. Expired first-project authority is rejected before repository creation. Genesis remains `ProjectBaseline@1`, labelled **no validation evidence**. Initialization creates no accepted review, measured run, validation or Release approval.
3. Compose an initial candidate with `baseline: "ProjectBaseline@1"`, empty proposals/selected/resolutions/alternative_groups and scenario `{ "id": "bounded-collection", "checks": [{ "id": "collection.compatibility", "version": "1" }] }`.
4. In candidate actions, choose `collection-host/1` and output slot `baseline`. Materialize, run finite checks, inspect the realization and measured run, and attest each exact `intent.review` criterion with your rationale. Assemble evidence from those refs and validate it. Mechanical observations come from the real bounded Node checker worker; missing human reviews fail the evidence gate.
5. Submit the exact scope and Release approvals for the candidate and validation evidence digest, using the displayed baseline authority digest and mediation generation. Protected amendments additionally require their guardian endorsement. Publish Release. Studio rechecks retained evidence, authority, approval bindings and the materialized output bytes before the engine gate accepts it.
6. Base an owned Layer on the accepted Release. A supported change sets `policy/requirements.count` to `collectionCountRequirement(5)` with the exact current precondition. Save, review the normalized draft, publish with that review ref, compose with the whole Layer selected, then repeat measurement, criterion review, validation, approvals and Release using slot `change`. Old evidence cannot validate this changed candidate; old Releases remain immutable.

Slots `baseline`, `change`, and `run01`–`run14` are fixed server-owned paths under the individual broker's `.strata/releases/`. Materialization refuses an occupied slot. Never clear an occupied slot or retained private history to reset state; exhausted or interrupted output needs operator reconciliation. Project selection, credential changes, pause/revoke, logout and role expiry continue to invalidate authority. Restart retains consent, records, output bytes and spending but creates no session or provider call.

## Packaging and integration ports

Build with Node 22+ and `npm run build`. A complete compiled release preserves `dist/src/auth/runner-worker.js` alongside the compiled runner. For the standalone bundle layout, run `node scripts/bundle-studio-host.mjs`; deliver **both** `dist/scripts/studio-host.js` and `dist/scripts/runner-worker.js`, the entire `dist/scripts/studio-runtime/` shared-module directory, `package.json` with `type: module`, and allowlisted Explorer assets. One split build graph keeps profile/checker definitions and their archive pins identical between host and worker. The worker's location is relative to the bundled host module. Preserve the separate coding-agent worker/runner package required by its own setup. Copying just the old host bundle cannot provide finite measurement. Choose and qualify one build layout before creation; changing compilation layouts may change source-based profile archive identities and needs separate compatibility review for retained projects. No service activation or deployment is performed by this packaging script.

`provisionFirstProject(namespacePolicy, project_id, purpose, now?)` is the pure initialization interface in `src/explorer/first-project.ts`. It returns `{ accounts, policy, baseline, first_project, output_slots, authority_sha256 }`. It performs no I/O, session creation, provider request, review, validation or approval. `namespace-host.ts` seals this output into the repository grant and immutable genesis and invokes the existing authenticated `init` operation. A `first_project` manifest marker mounts fixed output slots and `hostRunner`; an old genesis gains nothing merely because the binary changes.

Later Profile/LocalBuild provisioning must explicitly propose `strata-host-policy/4` with only this repository in `build_repository_ids`, the requested finite operations and profile, and `manifest.profiles.authority_ref` pinned to a genuine approved Release. The first-project helper returns policy /2 and does not grant Profile, LocalBuild, revalidation or recovery operations. Reuse its named person, supported baseline and accepted Release closure; use the existing separate-lineage/immutable-genesis preparation path rather than mutating grants at startup. The current `prepareNamespaceBuild` snapshot requirements remain unchanged.

The namespace source interface remains `selectedSource.current()` with exact project/model/repository and selection epoch. S2 can use the supported baseline Blocks in coding-agent context and save owned drafts through the ordinary `layer.create` command port. Namespace first-project consent never grants coding-agent provider or runner authority.

## Verification and remaining acceptance

Run `node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/studio-first-project.test.js`. On Windows, set `STRATA_TEST_TMP` to an approved native temporary directory. Tests use synthetic credentials/providers and real owner/actor HTTP, broker persistence, Git pack transport, materialization and checker execution. They cover exact role consent, scope, expiry before dispatch, baseline and changed approved Release, missing reviews/approvals, stale evidence, tampered bytes, restart without provider calls and pause.

To qualify the standalone package, build it after `npm run build`, set `STRATA_TEST_STUDIO_HOST_BUNDLE=dist/scripts/studio-host.js`, and run the same focused test. It uses the actual bundled namespace factory and checker worker; it activates no service and injects the same synthetic provider.

The normal [release packager](CODE_RELEASE.md) uses that same guarded host/checker graph and inventories its exact shared chunks. Focused packaging and temporal regressions run without launching a host: `node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/first-project-expiry.test.js tests/studio-packaging.test.mjs`. They inspect CLI suppression in memory, measure with the packaged checker, verify worker/chunk manifest hashes, and expire authority during admission, dispatch staging and initialization. Creation/recovery leases recheck expiry after asynchronous work, and the provider checks it synchronously immediately before the create POST; already spent reservations and uncertain outcomes remain retained.

Before public sharing, separately qualify Linux Node 22+ protected custody and HTTPS, the packaged worker, browser candidate/review/approval interactions, the customer's Artifacts permissions and provider contracts, creation-token expiry and lost-response recovery, and the native Windows coding-agent integration. Review/approve an exact commit, policy digest, expiry and live actions before activation. Synthetic success proves no live provider conformance or installation acceptance.
