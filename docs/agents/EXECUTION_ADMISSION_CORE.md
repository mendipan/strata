# Offline execution admission and recovery core

Implements the bounded host responsibilities in [execution/1 sections 3–4](EXECUTION_CONTRACT.md) and the [paired host/adapter guide](EXECUTION_AUTHORING.md), starting from published `c722c7a5d5feaedb8488008a1c3f10d5514d1251`. This is reusable injected code with synthetic, file-backed verification. No production Studio composition, execution consent persistence, service authentication, credentials, provider execution or platform qualification is configured.

## Ports and composition

[ExecutionAdmissionJournal and ExecutionAdmissionCore](../../src/agent-execution-admission.ts) reuse the accepted [transactional journal](../../src/agent-adapters/cloudflare-execution-journal.ts): permanent task index, strict original request and grant, atomic reservation, active/rate/capacity budgets, transition rules and immutable result expiry. A small host supplement in the **same transaction** records the protected owner, original ref, permitted operations and admitted limits. It is internal host metadata, not a new public policy or consent format. Use separate storage instances for the host and service; never reuse a service's native mapping as host state.

The wrapper is intentionally coupled to the accepted `/1` journal record layout for successful status-only observations and first result attachment. Those host operations differ from the service's native observation envelope, which includes result bytes on success. The wrapper stores a private `host-observation/<original UUID>` marker in the existing opaque handle field to distinguish an accepted host observation from an uncertain reservation; this marker is never a native task handle. No public schema, discovery, Studio, CF reference or KIT file changes.

[ExecutionAccess](../../src/agent-execution-access.ts) implements `AgentExecutionAccess.current` over injected **trusted local** metadata. Its caller must resolve authenticated owner, separate execution consent, enabled intent, exact selected project/model/repository and verified immutable revision, exact approved target/declaration, live session and credential generation. It checks the retained operation-specific admission before returning the existing finite `ExecutionGrant`. Returned data is cloned; browser/provider JSON and discovery consent supply no authority. `revision_verified` is an assertion by that trusted host port, not a Git-membership check implemented here.

```ts
const journal = new ExecutionAdmissionJournal(storage, protectedOwnerId, connectionId);
// journal.initializeEmpty() is an explicit provisioning action, never startup.
const access = new ExecutionAccess(trustedMetadata, journal, clock);
const client = new AgentExecutionClient(reviewedAdapter, access, clock);
const core = new ExecutionAdmissionCore(journal, access, client, clock);
// Explicit caller actions only:
await core.submit(strictTask);
await core.status(originalRef);
await core.result(originalRef);
// await core.cancel(originalRef); // Requires current cancel permission/capability.
```

These variables are trusted constructor ports, not configuration parsed from browser input. Compose the client with this same access port and clock. The storage transaction port must provide atomic rollback, serialize competing reservations and run only storage/validation in retryable closures. Native calls remain outside transactions. Metadata `subscribe` must invalidate **synchronously** for logout, pause/disconnect/revoke, source/selection, target/approval, session or credential changes. The core cancels each local wait, checks a sealed metadata snapshot even if a notification was missed, and rechecks authority around persistence. Waits have a ten-second ceiling; the accepted client independently bounds control calls and finite sessions.

## Defined behavior

- Admission retains the complete strict task, canonical request digest/ref, host-supplied grant and permission before `AgentExecutionClient.submit`. Concurrent duplicates reserve once. Reordered object keys reuse identity; changed input conflicts permanently, including after completion and output expiry.
- A reservation with no accepted observation is uncertain. Repeated submit refuses without adapter contact. Explicit `status(originalRef)` is the only recovery path; missing remote state never permits another start or UUID replacement. Startup performs no provider calls, credential loading or automatic repair.
- Status, submit and cancel retain exact snapshots under current authority, including synchronous completion. Successful status does **not** imply permission to retrieve output. `result` is separately authorized and first uses the guarded client to verify original ref, immutable terminal digest, output budget and `agent-output` trust; subsequent reads use the retained journal under a fresh current grant.
- First output attachment and its expiry commit atomically. Expiry removes bytes while retaining the original task, terminal digest and permanent ID. Repeated polling never replenishes output or extends access. New approval/selection generations cannot replay old tasks; an explicit authenticated session/credential reconnection can inspect the same admitted scope.
- Invalidation or a substituted/late response cannot become a host observation or retained result. Local abort only stops waiting. Already started synthetic native work may remain. Task/admission tombstones and historical metadata are retained; the code exposes no historical-output bypass and issues no revoke-time remote cleanup.
- Missing/corrupt state refuses without initialization or reset. Capacity, active/uncertain tasks and admission rate reuse the journal's bounded defaults and survive reconstruction. Failures contain finite codes and static text; raw provider/metadata exceptions are neither persisted nor returned.

## Focused evidence

[File-backed harness](../../tests/fixtures/execution-admission.ts) pairs the core/access/client with the published CF synthetic adapter/service/runtime and existing scripted KIT ports. The KIT bridge translates **test-controlled** grants into synthetic trusted metadata because the KIT accepts an adapter subject, not a host-access override. That conversion exists only in fixtures; its outer authority scenarios are complemented by direct core/access races in [the focused tests](../../tests/execution-admission.test.ts).

```sh
npm run build
npm run typecheck
node --import ./tests/no-external-fetch.mjs --test dist/tests/execution-admission.test.js dist/tests/agent-execution.test.js dist/tests/cloudflare-execution.test.js dist/tests/agent-execution-kit.test.js
npm run check:links
git diff --check
```

The new suite runs all twelve published KIT scenarios against that pair, positive and negative admission/access/output cases, concurrent duplicate/conflict checks, missing/corrupt journal cases, invalidation during persistence, independent status/output permissions and real child-process exits after host admission, native start, host observation, lost reply and host result commit. External fetch is blocked. The children execute only this synthetic fixture; no provider SDK or real agent process is launched.

Initial commit validation: build and typecheck passed; the four focused suites passed 67/67 tests, including 21 new admission tests and the full twelve-scenario KIT pairing; link check passed 497 links with zero failures. This evidence is offline and local only. No full product/discovery suite, hosted conformance, credentials, provider access or deployment was run.

Independent review of `28e2d5d0f9412e6119ccf4261529537c26b67d1c` found two corrected boundaries. Operation authority seals now follow the exact canonical task ref and operation through the guarded client's derived deadline/session signals; an unreported metadata change after reservation refuses **before** adapter dispatch. Concurrent scopes for that same operation must all remain current, and disposal removes each seal. The unmarked `queued/0` reservation is now distinguished from a remotely accepted snapshot: an initial `running/0` or `succeeded/0` is legal on submit or explicit recovery; after the host observation marker is committed, ordinary same-sequence/transition/terminal checks remain mandatory. Neither correction permits resubmission of an uncertain ID or changes public DTOs, the shared client, CF service or KIT.

Follow-up validation: build passed; [four targeted regressions](../../tests/execution-admission-review.test.ts) plus the three supplied independent-review probes passed 7/7, and five selected existing duplicate/restart/invalidation/synchronous-success tests passed 5/5. The missed-session probe reports zero adapter calls, zero transports and zero native starts. Both sequence-zero probes accept submit and status with one start. No broad suite was rerun for this follow-up.

Re-review of `eb90302c9e4efbaf40019679a43bb7f51d6f5f41` identified a missing corruption check on unmarked retained records. Retained reads now permit an absent marker only for `queued/0` with no cancellation intent, result bytes or result-expiry timestamp; a present marker must match the original task's exact host-observation marker. Removing a marker from a retained success therefore refuses with `EXECUTION_PROTOCOL/not_dispatched` before adapter contact and preserves immutable history. The build and seven targeted checks passed: the five review regressions (including the new corruption regression and existing legal first-observation/recovery controls) and two supplied re-review probes. No broader suite, public format or production integration changed.

On Windows sandboxes that deny atomic renames in the default temporary directory, set process-local `TEMP` and `TMP` to an existing ignored `.strata/` test directory before running these commands. This changes test-file placement only.

These checks demonstrate survival of the named local process failures. They do not prove power-loss/fsync durability, cross-process locking, Cloudflare replication, production transaction/invalidation ordering, hostile filesystem isolation, verified service identity or native runtime enforcement. The injected storage must qualify its commit/rollback and authority invalidation ordering before production use; a post-write abort never claims remote rollback. Result prose remains private output, not sanitized audit material or measured evidence.

## Remaining host prerequisites

Production integration still requires the section 8 CF runtime/service/identity qualification; protected host and service storage with crash/concurrency/commit-order tests; separate durable execution consent and revocation generation/tombstone integration with existing owner stores; exact source membership verification and synchronous lifecycle hooks; separate credential custody/authentication; explicit target activation and real execution authorization. Owner Settings and existing stores remain untouched. SDK measurement, native v0.3 dispatch, authoritative R1 completion, engine grants, artifact downloads, publication and Release remain outside this slice.

No architecture decision was needed for this offline implementation. Exact live authentication, runtime guarantees and production host-store wiring remain the existing separate gates. A next bounded reusable task is to qualify a protected local storage implementation against these same crash/concurrency/invalidation cases, without Studio routing, live consent or provider access. Independent review of this commit precedes integration; passing these checks is not permission to edit main, push or deploy.

The separately scoped [local storage slice](LOCAL_EXECUTION_STORAGE.md) now supplies the accepted storage port with cooperative process exclusion, atomic local snapshots and a final synchronous authority fence. Its Windows custody verifier, interrupted-lease reconciliation, POSIX platform checks and power-loss guarantees retain the explicit qualification limits documented there; it adds no production host composition or activation.
