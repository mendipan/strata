# ADAPTER-CF synthetic execution reference

Implements the bounded Cloudflare assignment in [execution/1](EXECUTION_CONTRACT.md), from published base `f9dff73c32ad1236a24e279538f4a9769cb5f92b`. This is an application-owned task-service protocol tested with injected synthetic transport, authorization, storage and native-runtime ports. No platform execution qualification, provider execution, durable Cloudflare deployment or Studio readiness is claimed. Discovery-v1 is unchanged.

The actual project ledger at implementation start identified ADAPTER-CF as independent of ADAPTER-KIT and manual Studio recovery. This implementation imports the published common DTOs/client and existing synthetic task data; it does not depend on unfinished KIT files or change KIT/P-owned files, shared guides, Settings, the fixture Worker or deployment settings.

## Delivered behavior

[CloudflareExecutionAdapter](../../src/agent-adapters/cloudflare-execution.ts) has pure `describe`, strict task/ref handling and one explicit control request per operation. The protected target fixes the execution base, connection, service/instance/independently verified subject, binding and execution declaration digest. It accepts injected server-side headers/response verification only, with no global fetch, credential default or identity inferred from response JSON. Calls are bounded by the declaration, session expiry and caller signal. There are no redirects, retries, implicit reconnects or provider fallbacks.

[The service](../../src/agent-adapters/cloudflare-execution-service.ts) mounts only `POST /tasks`, `GET /tasks/{task_id}`, `GET /tasks/{task_id}/result`, and payload-free `POST /tasks/{task_id}/cancel` below that separately approved execution base. UUIDs are lowercase canonical values. Query-selected scope, arbitrary Agent class/instance routing, extra task options and unrecognized routes refuse. Every operation uses an injected protected authorizer that resolves the original task ref from trusted admission metadata. Grants are never deserialized from request JSON.

The authorizer must check current owner/admission/approval/session/credential state and return a synchronous invalidation signal. Authority is rechecked after native observations, immediately before journal changes and before replies. Journal writes also check invalidation/expiry within their transaction. This service does not create the host's execution consent, durable revocation tombstone, credential custody or independent identity integration.

[The journal](../../src/agent-adapters/cloudflare-execution-journal.ts) uses the installed `DurableObjectStorage.transaction` interface through a structural port. A protected connection owns one journal. `initializeEmpty` is explicit trusted provisioning, with no public route and no automatic initialization on missing state. Transactions contain storage/validation only; native calls happen after the reservation transaction returns. A permanent ID index, exact request/admission and uncertain queued reservation commit before the sole native start. Concurrent duplicates either return the retained mapped snapshot or refuse as uncertain; changed payloads conflict permanently. A reservation without a handle never permits another start, including after absent native lookup. Explicit status may recover its native mapping by the original ref. Lost responses never allocate another UUID or resubmit.

Snapshots and successful results commit together. Original refs, native handles, monotonic sequence/transition rules, result digest and original output budget are checked. Concurrent older observations return the newer retained snapshot; equal-sequence mutations refuse. Terminal snapshots and result content are immutable. Result access expires after the configured retention interval; expired output is removed on result access, while the request, terminal digest and permanent ID remain. There is no background deletion job, and no poll replenishes expired output. Revocation/reapproval generations cannot replay old output. A valid explicit reconnection may change finite session/credential generations while retaining the same approved admission scope.

Cancellation persists intent before calling the injected idempotent native cancel operation, then accepts only `cancel_requested` or a terminal native observation. It does not invent a native sequence or report cancelled from a local abort. Successful completion may win a cancellation race. An uncertain admission needs explicit status reconciliation to recover its native handle before cancellation. Already terminal tasks require no native cancel. A local timeout/abort retains uncertain admission and reports unknown dispatch; it does not stop remote work.

Default service/journal bounds are 32 KiB raw task/status, 32 KiB declared result maximum (also limited by the original task), a 10-second control deadline, 60-second requested native runtime, 64 retained task IDs, four active/uncertain admissions, 16 new admissions per rolling minute, and five-minute result access. Configuration caps the journal at 256 retained IDs and one-hour retention. Admission rate and active-task counts are transactional and survive reconstruction; uncertainty consumes capacity. Full journals refuse rather than discard tombstones. Native observations have a separate bounded raw envelope, and result DTO bytes are checked independently. Runtime limits must be enforced by the actual runtime; control-call timeouts do not provide that guarantee. No token, spend or artifact-download limits are implied.

Errors expose only a finite contract code and the static common message; HTTP errors carry only `{error:{code}}`. Provider text, headers, URLs, prompts and stacks are never copied into these responses. Agent result prose remains private user output rather than a secret-scrubbed audit record.

## Exact mappings and evidence limits

| Pin or capability | Reference mapping | Qualification limit |
| --- | --- | --- |
| Adapter/protocol | `cloudflare-execution-reference` version `1`; `strata-agent-execution/1` | New application protocol, not an SDK endpoint |
| Tested runtime | `synthetic-cloudflare-task-service` version `1` | DTO-driven local fixture; no actual agent execution |
| Strata model | `strata/0.3-block-lifecycle-experimental` | Strata contract version, not an LLM name |
| Project dependencies | Installed/locked `agents@0.26.0`, Workers types `5.20261003.1` | No Agents runtime imported, instantiated or qualified |
| Atomic journal | `DurableObjectStorage.transaction` structural compatibility checked by TypeScript | Synthetic file-backed transaction port exercises behavior; no Cloudflare runtime test |
| Recovery/idempotency | Permanent reservation plus original-ref lookup, private native handle | At most one reference start invocation per retained ID; no universal exactly-once provider claim |
| Cancellation | Cooperative, idempotent native operation | Only a runtime observation confirms task stop; no cleanup/refund guarantee |
| Output | Strict digest-bound result with `trust=agent-output` | No SDK measurement, engine validation, publication or Release authority |

The [Cloudflare Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/) describes Agent lifecycle and storage, while [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) provides transactional storage. Neither supplies this task-service protocol, task authorization or native cancellation/limit guarantees. Current docs were checked alongside installed types; current SDK feature listings are not assumed to exist in the pinned package.

## Focused conformance and handoff

```sh
npm run build
npm run typecheck
node --import ./tests/no-external-fetch.mjs --test dist/tests/cloudflare-execution.test.js dist/tests/agent-execution.test.js
npm run check:links
git diff --check
```

[Reference tests](../../tests/cloudflare-execution.test.ts) and [generated synthetic fixture](../../tests/fixtures/cloudflare-execution.ts) cover lifecycle/results, concurrent duplicates/conflicts, process exits after reservation/before native start, after native start and after mapping commit, lost reply, cooperative cancellation/completion race, all approval/selection/session/credential races, explicit session reconnection, expiry/revocation, binding/identity/version refusals, canonical routing, raw bytes, UTF-8, result substitution/sequence failures, retention/tombstones, capacity/rate/active budgets, missing/corrupt storage, unavailable native, deadline/abort and redaction. Combined with the accepted core suite, 32 focused checks passed with external fetch blocked. Build/typecheck and link/diff checks are recorded at handoff.

The file-backed fixture uses serialized transactions and atomic file replacement plus actual child-process exits. It proves the reference survives those synthetic process failures, beyond reusing a Map. It does not prove Cloudflare replication, power-loss durability, cross-process locking, production runtime behavior or live service identity. Synthetic deadline failure represents a controlled runtime observation, not measured work termination. No hosted/discovery conformance, full-suite repeat, vendor SDK process, provider/model call or paid run is needed for these checks.

Remaining live prerequisites: a reviewed Agents runtime implementation with native workspace/tool isolation, task runtime/output enforcement, durable original-ID lookup and idempotent cooperative cancellation; a protected Cloudflare journal instance and runtime-specific eviction/transaction tests; exact independent service identity/auth and separate credential slot; the separately scoped durable host admission/execution-consent/revocation/result integration; then explicit target activation and execution authorization. Existing discovery consent cannot supply any of these. These are separate future scopes; this commit is suitable for offline review/cherry-pick only and remains unpushed.
