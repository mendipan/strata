# Discovery connection lifecycle

This is the original **discovery library** contract. Its discovery-only status and unavailable ports below apply to that library, not to the separate current Studio native runner. See [Studio status](../studio/STATUS.md), [execution contract](EXECUTION_CONTRACT.md) and [native qualification](STUDIO_CODEX_WINDOWS_STARTUP.md) for bounded proposal, explicit draft Save, original-ID recovery and Stop scope. Instrumented runtime evidence is distinct from packaged identity.

The [persistent consent extension](PERSISTENT_CONNECTIONS.md) adds Retry/Revoke, saved until-revoked consent and enabled intent, durable-policy metadata and a terminal revocation slot. Runtime discovery remains short lived and actual service session renewal remains unavailable. This document describes the original discovery core plus the extension below.

This slice implements a server library for one connection's `configure`, `test`, `connect`, `disconnect` and `remove` actions. It reuses the [discovery contract and reference adapter](ADAPTER_AUTHORING.md). Evidence is synthetic only. The subsequent [Settings integration](SETTINGS_INTEGRATION.md) adds authenticated owner routes, CLI and UI; production target/auth configuration, credential slots, engine principal and execution bridge remain unavailable. Ordinary launcher configuration leaves discovery unconfigured.

## Actual library contract

`AgentConnections` in `src/explorer/agent-connection.ts` exposes:

| Method | Behavior |
| --- | --- |
| `status(authority)` | Current owner-authenticated metadata; no authentication-secret loading or probe |
| `outcome(authority, requestId)` | Inspect a retained completed/failed/pending/interrupted receipt under current owner identity |
| `action(authority, input, signal?)` | Strict action, CAS revision and original UUID; optional signal cancels local test/connect waiting |
| `changed()` | Synchronously invalidate runtime and cancel in-flight local waiting; no remote rollback claim |

Every action has `action`, nonnegative integer `revision` and UUID `request_id`. Only `configure` additionally accepts `target_profile_id`. Unknown fields, paths, URLs, secrets, subject overrides and policy fields are refused. Input is at most 1 KiB. Replies use `strata-studio-owner-agents/1` metadata plus `replayed` and an explicit `outcome`. The Settings wrapper uses this same contract; production manager provisioning is a separate gate.

| Action | Result |
| --- | --- |
| configure | Fresh owner plus exact selected source and approved server target; persist configured/disconnected, zero secret/transport calls |
| test | Explicit one bounded discovery exchange; persist sanitized result/historical metadata; stay disconnected |
| connect | Explicit bounded exchange; expose connected-discovery only after durable completion and current authority/state checks |
| retry | New bounded health exchange under saved consent; does not repeat setup |
| disconnect | Persist new epoch; clear runtime and cancel local waiting; retain configuration/history |
| revoke | Fresh owner; persist revocation tombstone, disable intent and prevent further probe/replay |
| remove | Fresh owner; remove visible configuration, retaining receipts and durable rate reservations |

Fresh owner confirmation is required for configure/revoke/remove, including replay. Current owner/session identity is required for every method; completed replay additionally checks the original owner authentication generation and current source/target/auth proof for the original action. An exact completed replay makes zero secret/transport calls and never restores runtime after restart. Changed payload conflicts. A pending retry refuses dispatch and points to outcome inspection; there is no automatic retry or fresh UUID substitution.

## Injected authority and authentication

All ports are trusted server adapters supplied by the eventual host integration. They cannot be constructed from browser JSON or service advertisements.

- `AgentOwnerAuthority.current(fresh?)` must resolve an authenticated sealed owner at the current authentication generation; it is not an owner identity assertion from the client.
- `AgentSelectedSource.current()` returns current exact project/model/immutable repository binding, selection identity/epoch and expiry. Its metadata comes from authoritative selected-source state. No source grant or credential is read/created by this core.
- `AgentTargetApprovals.current(profileId, owner, source)` resolves one explicitly approved server profile, approval generation and the existing strict `ApprovedAgentTarget`. No URL selection, DNS fallback or target-policy format is invented here.
- `AgentProbeAccess.current(approval)` returns current secret-free authentication generation/expiry. `context(approval, metadata)` loads the actual authentication/transport adapter only after durable explicit probe admission. Default access denies. Current authentication mechanism and credential storage remain unselected.

Metadata ports must be local, bounded and have no provider/secret dispatch. Generations must change on replacement or revocation, including selected-source transitions and authentication credential rotation. The future integration must call `changed()` synchronously on local invalidation so an in-progress final write cannot install old readiness. Each probe and cached status also rechecks current ports. The supplied authentication verifier must independently establish the approved service identity; a manifest's subject is insufficient. Never inject Artifacts credentials, owner passwords, FixtureIssuer authority or remote feature advertisements as agent authority.

With omitted ports, management is explicitly unconfigured and probe capabilities are disabled. Configure is unavailable without current source and target adapters. Missing authentication prevents test/connect, even when configuration exists. An injected port is an implementation seam, not evidence of live compatibility. This milestone supplies only public synthetic ports and replaced transport in tests.

## Persistence, races and bounds

`AgentConnectionStore` uses a separate canonical absolute private directory, a strictly parsed `genesis.json` and `state.json`, and existing private-file/fsync/atomic-rename/exclusive-lease primitives. The immutable genesis template binds installation, owner, unique state ID and exact project/model/repository. `initialAgentState(scope)` is a pure preparation helper; service startup never calls an initializer. Future host configuration must keep this directory disjoint from owner/control/security/credential/source/catalog/accounting paths. Files are 0600 and directory 0700 on POSIX, without links; Windows tests do not establish POSIX permission protection.

Reads and writes serialize through the same lease. Missing/malformed/mismatched state or an interrupted lease fails closed with sanitized `AGENT_STATE_UNAVAILABLE`; no file, lock or history is recreated/reclaimed. An interrupted exchange remains an inspectable pending identity (reported interrupted on a new boot), and blocks fresh probes/configuration until explicit operator reconciliation. Local disconnect/remove may still invalidate visible configuration. No recovery/reset/archive command is implemented in this slice.

Before an exchange, CAS admission durably records the original operation/proof, new revision/epoch and one rate reservation. Network waiting releases the state lease, allowing disconnect/remove. Preparation failure dispatches nothing. Final-write failure leaves a pending receipt and no runtime. Finalization retains cancellation registration through fsync/rename, rechecks owner/source/target/auth/state and installs readiness only after successful durable save. Lost client response can be inspected/replayed using the original request, without duplicate dispatch. Historical `last_test.discovery` never represents current readiness: only `current_discovery` plus `runtime_ready` does. Restart always starts disconnected, even with a completed connect receipt.

At most one exchange may be in flight; the durable state retains at most five reserved probe starts within a rolling minute. Reservations survive failed/cancelled exchanges, remove and restart, without refund. Normal receipts are capped at 256, with one additional terminal revoke/remove slot preserving all old receipts. State JSON is capped at 2 MiB. There is no automatic pruning of receipts, polling, reconnect, background subscription or scheduler. Consent and enabled intent remain saved until explicit revocation/removal even when runtime starts disconnected.

The existing adapter performs one exact approved HTTPS GET, with no body/query/redirect/retry, strict 32 KiB response/binding/version/subject/declaration checks and at most ten seconds of local exchange waiting, including authentication loading. Source/auth metadata can further shorten accepted discovery validity. Valid discovery lasts at most five minutes and cannot outlive approved target/auth/source expiry. Durable preparation/finalization remains separately subject to storage failure; a deadline never manufactures a saved receipt. Transport and identity-verifier failures are reduced to finite static codes/messages, with no raw headers, values, URLs, stack or provider errors in state/replies.

Service feature identifiers are finite discovery metadata. Every status reports engine authority unconfigured, operations empty and authoring/execution/chat false. No model turn, task, tool, arbitrary RPC or Agent-instance creation port exists. This slice does not establish a real Cloudflare deployment or any other vendor compatibility.

## Verification and integration gate

Build and run the focused synthetic suite after installing the repository's pinned dependencies:

```sh
npm run build
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/studio-agent-connection.test.js dist/tests/agent-adapter-conformance.test.js
```

Fixtures use public `.example.test` targets and replaced transport. Real owned child processes measure connect/restart/replay, interruption while a probe waits, and a crash under the exclusive lease; they read only fixture state. The timeout test retains a heartbeat and measures a real ten-second uncooperative exchange. POSIX permission/link checks run only on Linux. The corrected synthetic core was independently qualified and integrated at d9f8e870. The later HTTP/CLI/UI slice has its own review gate in [Settings integration](SETTINGS_INTEGRATION.md); actual owner-approved target/authentication evidence remains separate. This core makes no live changes.
