# Namespace Build launcher and inactive preparation

The launcher can pass the reviewed namespace Local Build hook a strict installation
configuration. This change supplies no current actor grants, approved Release,
contract review, adoption or saved profile. Existing create/import defaults remain
policy /2. A repository with only an empty genesis cannot produce an eligible packet.

The optional `namespace_local_build` section in `strata-studio-host/1` is:

```json
{
  "format": "strata-namespace-local-build-host/1",
  "repository_ids": ["synthetic-repository"],
  "output": {
    "id": "private-local-output",
    "label": "Studio host output",
    "root": "/srv/synthetic-studio-output",
    "excluded_roots": ["/srv/synthetic-studio-installation", "/srv/synthetic-studio-state"]
  }
}
```

These are synthetic paths, not a deployable inventory. Supply canonical absolute
paths for the complete installation: host config, installed code, served assets,
namespace policy/catalog/projects/import catalog, owner control/state/keys/credentials,
agent storage and every additional source/document/credential location. The launcher
and namespace mount independently require their protected paths to be covered.
Output preflight resolves exclusions and refuses overlap, aliases, links, unsafe
ownership/permissions and missing roots. Configuration loading and Prepare never
create the root. The private root must be separately qualified inside the service's
actual mount namespace using its current identity; do not pin a DynamicUser UID.

Only Linux launcher custody is implemented. It uses `unixOutputProtection()` with
the process UID and observes the process's Node/runtime environment. There is no
configurable executable, shell, UID, inspector callback, recovery account or runner
module. Use the separately reviewed absolute Node invocation for the service;
the fixed `collection-host/1` runner requires Node >=22, Linux/Windows x64/arm64 at
the underlying Build layer. This launcher does not add Windows service custody,
arbitrary application execution/serving, Workers, dependency installation or fresh
semantic validation. The compiled archive and exact profile choices are rechecked.

## Generate a review packet offline

`namespaceBuildPreparationSchema` in
[namespace-build-preparation.ts](../../src/explorer/namespace-build-preparation.ts)
defines the strict input. Supply:

- `source_genesis_sha256`, `source_catalog_sha256`, the unchanged `source_grant`,
  and the exact existing `catalog_project` whose genesis hash matches the source.
- A separately proposed `proposed_manifest` containing a complete indexed immutable
  owner snapshot, exact cache bytes, policy /4 and `profiles.authority_ref`. The tool
  validates its import and actor seals; it does not edit or upgrade the active manifest.
- `launcher` with exactly this one repository and the installation output inventory.
- Exact `{ref, sha256}` pins for `release`, `contract`, reviewed `adoption`, and
  logically unarchived `profile` (archiving any revision archives its logical ID).
  The Release must have its complete approved publication
  closure; `ProjectBaseline@1` or an arbitrary review label is insufficient.
- Explicit `actor_grant_id` and `reviewer_grant_id`. HostIssuer must accept unique
  stable account/grant bindings and exactly one active person mapped to this owner.
  Both grants must resolve to that mapping with an active grant lifetime, the
  assigned profile/build operations and only this repository/profile scope.
  The reviewer requires the retained Profiles Release authority and policy Release
  approval. The same principal is accepted only when that authority already exists.
- `acknowledge_grant_lifetimes: true`, an operator run bound `max_build_starts`
  (1–10), and `recovery: "authenticated-existing-actor"`. The packet displays grant
  lifetimes exactly. An owner session expiry does not expire an until-revoked grant.
  The start count is an operator/session bound, not a new backend quota; the existing
  provider limits remain enforced. Outputs and receipts persist beyond sessions.

The test in [namespace-build.test.ts](../../tests/namespace-build.test.ts) constructs
these inputs from fully labelled synthetic history. It is a reproducible example,
not approval evidence for any real repository. Preparation refuses provider-grant
changes, cross-repository history, missing authority, stale pins, unsupported profiles,
unattended recovery and expanded revalidation scope.

After compiling, write to a new explicit scratch file:

```text
node dist/scripts/prepare-namespace-build.js --input ABSOLUTE_OFFLINE_JSON --output ABSOLUTE_NEW_INACTIVE_PACKET
```

The command reads only that offline input and writes one exclusive mode-0600 file.
It creates no directories and cannot overwrite an existing file. The returned packet
contains the proposed genesis/catalog binding, exact tuple, scoped launcher section,
actor/reviewer lifetimes, provider bounds and a canonical SHA-256. It always says
`inactive: true` and `activation_authorized: false`; the hash proves content identity,
not operator approval, live filesystem custody or successful provider qualification.
No credential configuration, provider access or installation follows this command.

## Smallest remaining activation decisions

Approve one immutable code commit and complete packet; explicitly assign actual
Release/review authority and approved Release/contract/adoption/profile pins; decide
actor rights and lifetimes, including any time-limited trial revocation. Separately
approve the exact host invocation, output-root inventory/current service custody,
existing provider limits and operator run count. Stopped-writer installation must
compare source genesis/catalog hashes and provision a separately sealed lineage
with its complete verified cache and control/budget state. Editing the live genesis
and catalog hash in place is not that procedure. This tool implements no installer
or stopped-host takeover. Unattended recovery needs a separately approved identity
and is deliberately absent from the launcher and packet.
If interrupted attempts already exist, the operator must separately approve the
authenticated actor's recovery-operation scope before any stopped-host reconciliation.
The packet does not add that right and reports startup recovery as unconfigured.

The first real qualification still requires the owner to sign in and authorize the
exact tuple within a current session. Mechanical compilation, offline tests and
checks need no continuous human attendance. Native Linux tests use disposable
storage when Linux is available; a Windows run skips those tests and establishes
no Debian service-custody result.
