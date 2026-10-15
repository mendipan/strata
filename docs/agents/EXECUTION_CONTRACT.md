# Agent execution contract v1 (ADAPTER-C)

Status: bounded shared implementation with synthetic execution fixtures. This is the contract of record for ADAPTER-KIT and the first ADAPTER-CF implementation. No platform has execution qualification, no production execution host is wired, and no task has run against a provider. Discovery-v1 and its existing declarations, projections and tests are unchanged.

The implementation is [agent-execution.ts](../../src/agent-execution.ts) and [agent-execution-client.ts](../../src/agent-execution-client.ts). Types are inferred from strict Zod schemas. Registration is by compile-time import; no plugin loader, vendor registry, automatic provider selection or orchestration framework is introduced.

## 1. Three distinct contracts

| Surface | What it establishes | What it cannot establish |
| --- | --- | --- |
| `AgentDiscoveryAdapterV1`, `strata-agent-discovery/1` | Bounded non-executing metadata about an approved service | Task permission, execution capability, model turns or engine authority |
| `AgentExecutionAdapterV1`, `strata-agent-execution/1` | A separately approved agent task's submission, status, result and optional remote cancellation | Trusted measurement, repository publication, engine validation, independent review or Release |
| SDK1 measured-execution proposal | Proposed compiled checker/runtime/evidence lane | General coding-agent integration or delivered SDK measurement |

Discovery features never upgrade a connection to execution. A model completion/chat API alone is ineligible: an execution adapter must control a real agent runtime with task lifecycle, recoverable identity, bounded output and a declared cancellation limitation. The declaration is a claim to qualify, not proof that such a runtime exists. Merely declaring `runtime.kind=agent-runtime` earns no compatibility status.

SDK1 remains open under [its proposal](../sdk/MEASURED_EXECUTION_CONTRACT_PROPOSAL.md). This contract deliberately does not decide its isolation primitive, evidence schema or grants. `ExecutionResult.trust` is always `agent-output`; a digest binds returned content but does not prove execution, correctness, sandboxing or measured evidence. No adapter receives a Strata engine principal. Any future tool bridge requires separately authenticated, narrowly granted engine commands and existing review/Release gates.

## 2. Capability and version decisions

Every declaration contains exact adapter/runtime versions, supported **Strata model versions**, protocol, task and call limits, and task-only authority. Required capabilities are submit/status/result plus durable task identity and lookup by the original ID. Cancellation is explicitly `cooperative` or `unsupported`. Unsupported cancellation refuses before dispatch; it must not silently fall back to process killing or deleting a vendor resource.

Protocol, declaration, request, status, result and grant formats have separate `/1` markers. This reader rejects unknown versions and fields; it neither downconverts nor treats a greater version as compatible. An incompatible shape/semantic change needs `/2` and explicit reader/host support. Optional future capabilities are not accepted as unbounded extension maps. A compatible implementation patch may change the adapter's version but changes the canonical declaration SHA-256 and therefore requires reviewed target approval again. Pin real dependencies/schema versions in the implementation; `latest` is not a qualification pin. Discovery declaration digests are never execution declaration digests.

No wire transport is imposed on every platform. The port is TypeScript; a Cloudflare HTTP service, a supervised Codex process or a Claude SDK bridge can implement the same operations. Vendor-native task handles stay in the adapter's private journal. No arbitrary URL, header, command, model name, RPC method, module, credential or provider-options bag is accepted in a task.

## 3. Connection lifecycle and authority

Reuse the persistent connection host's existing owner authentication, encrypted credential custody, exact selected-source binding, generations and invalidation hooks described in [PERSISTENT_CONNECTIONS](PERSISTENT_CONNECTIONS.md). This slice adds no fields to that store and no Studio routes. Existing discovery consent is **not** execution consent and must never be migrated into it automatically.

The execution host must retain a separate explicit execution approval: owner, connection ID, target service/instance/verified subject, execution declaration digest, exact project/Strata-model/immutable repository binding and allowed operations/limits. Repository revision is a separate immutable 40- or 64-hex Git commit ID; the host proves membership in the approved repository. A branch name is not a revision. Approval persists until revoke; enabled intent and finite authenticated session health are separate facts.

| Local lifecycle state | Required behavior |
| --- | --- |
| Unconfigured / discovery-only | No execution access port or grant; submit unavailable |
| Approved, disconnected | Keep consent; startup/status display performs zero provider calls or credential loading |
| Ready | Current owner, exact source/selection, execution approval, session and credential generation verified before each operation |
| Paused / disconnected / logged out / session expired | Disable new dispatch and cancel local waits; keep saved approval and task journal; explicit authenticated reconnect can restore readiness |
| Revoked | Persist a tombstone and increment approval generation before reporting success; abort local waits and deny old task/result replay; no automatic reconnect |

Changing target identity, repository binding or execution declaration requires new explicit approval. Revoke does not claim to stop already admitted remote work, revoke a provider credential, erase outputs or refund charges. Cancelling remote tasks is a separately authorized action while access is valid. After revoke, do not issue cleanup/cancel requests under the revoked grant. A host may retain authorized owner-visible historical metadata, clearly labelled historical; it must not expose cached task output as current authorized output.

`AgentExecutionAccess.current(ref, operation, signal)` is a **trusted local metadata port**, not authentication from request JSON. It must check the operation-specific durable admission/journal, current owner, saved consent/intent, source and repository revision, target identity, current session and credential generations. It returns a strict `ExecutionGrant` with a finite `valid_until`, or refuses. The host must seal these facts; schema validation is not authentication. It must wire synchronous invalidation to every in-flight caller AbortController and recheck authority when persisting returned results.

The client compares task binding and declaration digest, checks expiry, and reads current authority before and after each operation. Changed generations or identity discard late responses. A dispatch uses a signal bounded by both the call deadline and session expiry. The adapter must independently authenticate its exact approved service/process and bind every native run/result to the grant; provider JSON's `subject` alone is insufficient. Adapters resolve credentials only after admission, inside the trusted host. No credentials occur in these DTOs. Preserve provider/target domain separation; never reuse Artifacts tokens, owner passwords or public FixtureIssuer handles.

## 4. Task identity and durable admission

`ExecutionTask` carries an original UUID, connection ID, project/model/repository binding, exact commit, bounded instruction and limits. `executionTaskRef()` hashes the complete strict task using canonical JSON (sorted object keys, unchanged array order, UTF-8 SHA-256). Every operation returns the exact ref, including request digest. JSON serialization order does not change identity. Instructions are untrusted task data, never host policy or executable transport configuration.

The `(connection_id, task_id)` key is permanent within the retained journal. Same ID and same complete request are one task. Same ID with a changed digest/binding is `EXECUTION_CONFLICT`, even after a terminal state. Retain a tombstone after output expiry; do not reuse the ID. The host durably saves the exact request and authorization admission **before** calling submit. The adapter must durably reserve the key and native-handle mapping before any native start. Concurrent duplicates must serialize at this key.

If the native API supports idempotency, use the original stable key. If it does not, a write-ahead reservation whose native dispatch outcome is uncertain stays uncertain and blocks any second start until native lookup/reconciliation proves the mapping. Never claim exactly-once native execution from a local Map. Never automatically resubmit, replace the UUID, retry, redirect or fall back to another provider after an ambiguous response. Following a lost response or restart, explicitly inspect `status(originalRef)` under current authorization. `EXECUTION_NOT_FOUND` by itself is not permission to submit again: a retention gap or interrupted admission may still exist.

The common client intentionally has no persistent journal or background loop. Its caller supplies the last accepted snapshot to status/cancel for transition checking. Omit it only for an initial authorized lookup with no observed status. A production host must atomically retain accepted snapshots and sequence numbers, enforce per-connection concurrency/rate/storage budgets, refuse at capacity, and keep pending/uncertain admissions across restart. Missing/corrupt state fails closed. These are ADAPTER-CF/host obligations, not guarantees supplied by the in-memory fixture.

## 5. Operations, status and results

| Method | Required semantics |
| --- | --- |
| `describe()` | Pure declaration, zero credential/provider calls |
| `submit(task, context)` | One explicit task admission; return current queued/running/terminal snapshot; synchronous completion is allowed |
| `status(ref, context)` | One explicit bounded observation by original task identity; no implicit submit or blocking until task completion |
| `result(ref, context)` | Retrieve the immutable terminal result; no recomputation or task restart; unavailable/expired output is an explicit error |
| `cancel(ref, context)` | If supported, idempotently request remote cancellation; return cancel_requested or an already terminal snapshot |

The guarded client's `result(task, completedSnapshot)` additionally requires a succeeded snapshot for that exact request and verifies the canonical result digest and original output budget. Adapters only see the ref for retrieval; the host retains the original request and last accepted status. Status metadata is not a live subscription.

States are `queued`, `running`, `cancel_requested`, `succeeded`, `failed`, `cancelled`. Snapshots carry a monotonically increasing safe-integer sequence. The same sequence must have identical content. A poll may skip intermediate states; running cannot return to queued, cancellation cannot return to running, and terminal snapshots never change, even with a higher sequence. `assertExecutionTransition` is shared code for host retention and adapter tests.

Remote cancellation is cooperative. `cancel_requested` is not cancelled; a task may finish successfully or fail while cancellation races. `cancelled` requires the runtime to confirm that this task has stopped. It does not prove cleanup of every external side effect. Local AbortSignal or a call timeout stops waiting only and reports unknown remote outcome after dispatch. Task runtime bounds must be enforced by the actual adapter/runtime, separately from the ten-second maximum control call. Unsupported hard deadlines or output limits block execution qualification rather than disappearing behind a capability claim.

Failed tasks have a finite failure code (`TASK_FAILED`, `TASK_DEADLINE`, `TASK_LIMIT`, `TASK_POLICY`) and no success result. Succeeded snapshots bind an immutable result digest. Results contain a bounded summary and at most 16 artifact descriptors (opaque ID, digest, bytes, media type); never arbitrary downloadable URLs or paths. Artifact contents and retrieval are deferred. A provider branch/PR/file is only a proposed output, never automatic repository adoption, engine evidence or permission to fetch remote bytes. Text output may contain sensitive user material; the host protects it as private output and never logs it indiscriminately. Static error redaction is not a general secret scrubber for agent-generated prose.

Bounds: task JSON at most 32 KiB UTF-8; instruction at most 16,384 JS string code units; status at most 32 KiB; result JSON at most the smaller original output budget and declared output limit (maximum 64 KiB); at most 16 artifacts; one control call at most 10 seconds; task runtime requested at most one hour and no larger than the adapter's declared limit. The adapter must cap raw bytes before parsing and enforce native work/output/storage limits. Shared DTO checks after deserialization cannot bound a provider stream, heap or bill. No model-token/cost guarantee is implied.

## 6. Errors and recovery

`AgentExecutionError` exposes only a finite code, static message and dispatch certainty: `not_dispatched` or `unknown`. Once the adapter method is invoked, any failure is conservatively unknown, including auth/result-validation failures. No raw exception, response body, headers, URL, prompt, stack or credentials may enter persisted error records. Whitelist code/message/dispatch when serializing errors; do not serialize Error stacks.

| Codes | Caller action; never automatic |
| --- | --- |
| UNCONFIGURED, INVALID, VERSION, UNSUPPORTED (all prefixed `EXECUTION_`) | Configure a supported implementation or correct the request; no provider fallback |
| AUTH, EXPIRED, STALE, BINDING | Inspect current approval, identity/session/source generations; reject result; do not renew consent implicitly |
| CONFLICT | Retain original task identity and reconcile changed payload; do not allocate a replacement task automatically |
| NOT_FOUND, RESULT_UNAVAILABLE | Inspect retained journal/provider state or result retention; do not infer that execution never occurred |
| PROTOCOL, LIMIT | Reject output and qualify/fix the adapter; no success/measurement claim |
| ABORTED, TIMEOUT, UNAVAILABLE | If dispatch is unknown, retain uncertain admission and inspect the original task under current approval |

A task's `failed` state is an observed execution outcome, distinct from an error obtaining an observation. This core does not invent an `unknown` terminal status when transport fails.

## 7. Cloudflare first and platform seams

The [platform research](PLATFORM_RESEARCH_PROPOSAL.md) remains evidence about candidate surfaces, not compatibility. The following are implementation directions, not newly verified vendor guarantees:

| Candidate | Selected direction / independent work |
| --- | --- |
| Cloudflare (first) | Application-owned agent task service with durable task journal/native mapping. Implement a new execution adapter/service; leave `cloudflare.ts` discovery and local fixture Worker untouched. Start with injected synthetic service/auth ports; qualify real runtime and identity separately. |
| Codex | Operator-owned SDK or supervised app-server bridge; pin one supported surface and its schemas before implementation. Map native thread/turn to the Strata task ID in private storage. Model API alone does not qualify. |
| Claude | Operator-owned Agent SDK/binary bridge; pin both, isolate workspace/tools and map lifecycle/results/cancellation. Downstream model authentication is distinct from bridge identity. |
| Cursor | API bridge to an actual cloud agent/run; durable native mapping, explicit create-as-execution, cancellation and repository binding. Pin API/schema and prove missing guarantees or report unsupported. |
| Google / other runtimes | Implement the same port after choosing an actual runtime and demonstrating identity, lifecycle, limits and journal semantics. No core vendor switch is needed. |
| ZCode / Grok | Product/control surface remains unresolved in the existing inventory. Do not use UI automation or a raw model endpoint to fill the contract. |

For ADAPTER-CF's first application protocol, reserve a **separate** exact approved execution base, with `POST /tasks` (strict task), `GET /tasks/{task_id}` (snapshot), `GET /tasks/{task_id}/result` (result), `POST /tasks/{task_id}/cancel` (no payload). Connection/service/repository scope comes from protected host configuration and verified authorization, not URL-selected tenancy. The bridge verifies the ref against its retained record on all reads/cancel. JSON replies carry the common strict DTOs; redacted failures carry the finite code. Route IDs must be canonical UUIDs. No redirects, retries, arbitrary paths/query/header forwarding or dynamic Agent creation from client-supplied class/instance IDs. This is a new application protocol, not a built-in Cloudflare Agents endpoint. Exact identity/auth integration and credential slot selection remain target-specific gates before any live contact.

## 8. Independent next assignments

No paid or remote work is authorized by these assignments; they are ready scopes for a separately launched worker. Each starts from the published ADAPTER-C commit (or cherry-picks that immutable commit in isolation), keeps discovery and Studio unchanged, and records its own focused evidence.

| Item / suggested worker | Exclusive files and concrete deliverable | Acceptance / dependency |
| --- | --- | --- |
| ADAPTER-KIT / Sol or ZCode | New `examples/agents/execution-starter.ts`, `scripts/agent-execution-conformance.ts`, starter tests and a new execution authoring guide. Reuse schemas/client/fixture; scaffold compile-time registration and explicit missing host ports. | Offline lifecycle plus failure fixture driver usable by a second adapter; no fake readiness, credentials or broad discovery suite. Can proceed immediately; reference this contract rather than redesign it. |
| ADAPTER-CF / Sol | New `src/agent-adapters/cloudflare-execution.ts`, separate execution-service module and focused synthetic tests. Implement the routes above with injected verified auth, durable atomic task reservation/native mapping, result retention and remote cancellation mapping. Do not change `src/worker.ts`, discovery, Studio or deployment files. | Crash between reservation/native start/reply never creates a duplicate; concurrent duplicate/ref conflict, expiry/revoke race, bounded raw body/task/output, immutable result, cancellation race and unavailable-native fixtures. Real Agents runtime qualification and target activation are a separate approved stage. |
| ADAPTER-P / ZCode or Sol | New per-platform execution mapping documents/fixtures under `docs/agents/platforms/` and `tests/fixtures/agent-platforms/`; Codex, Claude and Cursor mapping can be independent. | Pin exact supported surface/version from official sources; map every method/auth/binding/limit/error; identify native idempotency gaps and synthetic normalized transcripts. No runtime launch, UI automation or credentials. Implement only after the candidate's mapping is reviewed; Cloudflare stays first. |
| Execution host integration / Sol, after Studio owner handoff | Separately scoped persistent admission/result journal, execution-consent store extension and host composition; exact source/session/credential invalidation. | Reuse current encrypted stores without credential migration; restart, revocation, current owner, rate/capacity, uncertainty and safe credential-slot tests. No automatic conversion of discovery approval. Integrate only after ADAPTER-CF's service/identity contract is qualified. |

Deferred: chat/streaming subscriptions, tool RPC, multistep orchestration, agent delegation, dynamic adapter loading, automatic retries/reconnect, general vaults, provider switching, automatic publish/merge, artifact download, task migration, automatic SDK evidence/Release conversion, billing/token ceilings, and SDK1 measurement implementation. None is necessary to implement this port.

## 9. Focused verification and limits

```sh
npm run build
node --import ./tests/no-external-fetch.mjs --test dist/tests/agent-execution.test.js
npm run check:links
```

The [public synthetic fixture](../../tests/fixtures/agent-execution.ts) and [execution tests](../../tests/agent-execution.test.ts) use no credentials, network, provider SDK, model calls or child processes. Reconstructing a fixture adapter against the same Map tests identity behavior, **not process-crash durability**. The shared guard is usable today; production host admission, platform transport, secure remote identity, durable journals, real runtime limits and deployment qualification remain unimplemented. Do not restart the separate hosted conformance workflow or expand discovery tests to validate this slice.
