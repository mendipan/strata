# Codex execution mapping proposal (ADAPTER-P)

Status: source-pinned mapping proposal with synthetic normalized DTO fixtures. **No functioning or qualified Codex execution integration is delivered.** There is no adapter implementation, durable journal, runtime test or host wiring. Passing the fixtures establishes shared DTO consistency only. The Codex row in [COMPATIBILITY.md](../COMPATIBILITY.md) stays a candidate; accepting this document does not advance execution qualification. Cloudflare remains first. KIT, CF and Settings retain their existing ownership.

The normative authority is [execution/1](../EXECUTION_CONTRACT.md), especially its [independent assignments](../EXECUTION_CONTRACT.md#8-independent-next-assignments). The original draft used published ADAPTER-C base `f9dff73`; this review preserves that contract. No runtime launch, account access, credentials, provider calls, UI automation, publication or deployment are authorized by this mapping.

## 1. Selected surface and immutable sources

The proposed surface is an operator-supervised `codex app-server` process using newline-delimited JSON RPC over stdio. Downstream account authentication and host process identity are separate. No network listener is selected.

| Pin | Evidence |
| --- | --- |
| Intended CLI | `@openai/codex` `0.162.1`; [official release `rust-v0.162.1`](https://github.com/openai/codex/releases/tag/rust-v0.162.1) |
| Tag object | `7a078f6bb4ce0dc2a81408b334ce52979d92c603`, resolving to commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; [tag resolution](https://api.github.com/repos/openai/codex/git/tags/7a078f6bb4ce0dc2a81408b334ce52979d92c603) |
| Shape authority | Checked-in generated [JSON schemas at that commit](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json); schema tree Git object `3613a5054c1c9af876fccba53c995f0ac8425b85` |
| Explanatory guide | [Current official app-server documentation](https://learn.chatgpt.com/docs/app-server), accessed 2026-10-12; mutable prose, not a version pin |

The fixture lists exact schema paths and Git blob IDs. Checked-in snapshots resolve the original field placeholders without launching Codex. They do not prove that an installed binary emits these shapes: package/binary provenance and matching generated-schema comparison remain implementation gates. `latest` is not a qualification pin. A changed runtime/adapter version changes the declaration digest and needs reviewed target approval ([contract section 2](../EXECUTION_CONTRACT.md#2-capability-and-version-decisions)). Alternative SDKs, transports and MCP surfaces are outside this selection; no compatibility or removal claim about them is made.

## 2. Operation mapping

All rows describe a future adapter. `initialize` followed by `initialized` belongs to explicit supervised startup, never `describe()` or disconnected Settings display.

| Operation | Proposed native calls and requirements |
| --- | --- |
| `describe()` | Pure compiled declaration; zero native/credential calls. Do not advertise qualified capabilities until the gates below pass. |
| `submit(task)` | Serialize/reserve the original key and complete digest with pending handles before native work. `thread/start` uses approved `cwd`, `approvalPolicy: "never"`, `sandbox: "workspace-write"`, `ephemeral: false` and metrics-only `serviceName`. Durably bind the returned thread ID before `turn/start`. Send one `{type: "text", text: task.instruction}` input. Persist the returned turn ID before reporting a bound snapshot. One task owns one dedicated thread and one turn; no resume, steer or additional turn is selected. |
| `status(ref)` | Resolve the original ref through the retained journal, then one bounded `thread/read` with `includeTurns: true`. Match the exact retained turn ID. Thread status alone is not task status. Require complete, unambiguous history; absent/partial history is an observation error. Notifications may update the journal subject to the same binding/transition rules. |
| `result(ref)` | Read the retained completed turn; refuse incomplete items/history. Deterministically normalize retained `agentMessage.text` into a bounded summary and completed `fileChange.changes[].diff` into opaque artifact descriptors. Freeze the normalized result/digest before emitting `succeeded`; later retrieval uses that immutable result. Artifact contents/retrieval remain deferred by the contract. |
| `cancel(ref)` | Return a retained terminal snapshot when available. Otherwise `turn/interrupt` requires **both `threadId` and `turnId`**. An empty response acknowledges a request, not confirmed stopping. Emit `cancel_requested`; a bound observed `completed`, `failed` or `interrupted` turn decides the terminal state. Repeat/race behavior and stopping guarantees remain unqualified. |

Shape references: [ThreadStartParams](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json/v2/ThreadStartParams.json), [TurnStartParams](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json/v2/TurnStartParams.json), [ThreadReadParams](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json/v2/ThreadReadParams.json), [TurnInterruptParams](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json/v2/TurnInterruptParams.json).

`thread/start.sandbox` is a mode string; `turn/start.sandboxPolicy` is a different structured override. Text input `text_elements` defaults to an empty array. Synthetic responses/notifications are projections, not complete native messages or native schema-conformance evidence.

## 3. Authentication and authority

The host retains separate execution approval and supplies current authenticated `ExecutionGrant` metadata before and after operations ([contract section 3](../EXECUTION_CONTRACT.md#3-connection-lifecycle-and-authority)). Process custody must independently authenticate the approved runtime/instance and bind runs/results to the grant. stdio, initialization, a downstream model account and schema-valid metadata do not establish owner consent or verified bridge identity.

Operator-managed downstream authentication is resolved only after authorized admission inside the trusted host. This review reads no credentials and specifies no login/store changes. Native `unauthorized` never renews consent. Revoke/expiry/invalidation discard late output and deny further access; no cleanup interrupt is issued under a revoked grant. Saved consent, enabled intent, health and readiness remain distinct. Disconnected display performs zero runtime/account calls.

Outputs retain `trust: "agent-output"`. Digests bind content only. No engine principal, measured-execution authority, repository adoption, publication, independent review or Release permission is granted.

## 4. Identity, recovery and repository binding

| Binding | Gap and required handling |
| --- | --- |
| Original task ID/digest | The selected schemas establish no native exactly-once dispatch guarantee. `turn/start.clientUserMessageId` exists but supplies no reviewed deduplication guarantee. Durable reservation serializes local duplicates; it cannot remove the crash window between native start and handle persistence. Conflicts/tombstones follow [contract section 4](../EXECUTION_CONTRACT.md#4-task-identity-and-durable-admission). |
| Native handles | Reserve pending mappings, then durably bind returned handles. With a retained thread ID, `thread/read` may support explicit reconciliation under current authority if a unique turn can be proved. The synthetic example assumes complete history and exclusive thread use. If the thread-start reply/handle was lost, no lookup by original Strata ID is established here. Keep admission uncertain and block another start. |
| Immutable revision | `cwd` and native Git metadata do not enforce immutable binding. The host must prove repository membership and preserve the approved checkout/isolation binding throughout work. A one-time HEAD check does not exclude concurrent checkout changes. |
| Project/repository/Strata model | Trusted-host/journal bindings, never native request-selected authority. Native LLM choice is operator configuration, not `binding.model_version`. |

Never automatically retry, resubmit, replace the UUID, redirect or fall back. `EXECUTION_NOT_FOUND` cannot prove native work never ran. Missing/corrupt state fails closed. Durable retention, atomic sequences, capacity and restart handling remain implementation obligations.

## 5. Limits and cancellation gaps

| Bound | Evidence and qualification requirement |
| --- | --- |
| Control call at most 10 seconds | A wait timer bounds caller waiting only. After invocation timeout/abort is dispatch `unknown`; native work may continue. |
| Requested runtime at most one hour | The reviewed turn-start schema has no task wall-clock deadline field. A timer plus cooperative interrupt is a proposed expiry response, **not proof of enforcement**. Only an observed interruption attributable to the timer supports the illustrated `TASK_DEADLINE`. Failed/unresponsive interrupt and completion races require evidence. No process-kill fallback is selected. |
| Result at most original budget/64 KiB; at most 16 artifacts | DTO checks cover normalized results. A future adapter must cap raw bytes before parsing and enforce native work/output/storage limits. Dropping a stream or rejecting a result does not establish native output, memory, storage or billing limits. Unsupported bounds block qualification. |
| Task/status at most 32 KiB; instruction at most 16,384 JS string units | Reuse [schemas](../../../src/agent-execution.ts) and [guarded client](../../../src/agent-execution-client.ts); apply raw transport bounds independently. |
| Non-interactive execution | `approvalPolicy: "never"` is a reviewed literal, not proof that every approval, elicitation or user-input path is disabled. Qualify effective policy/tools; never synthesize approval, widen grants or claim tasks cannot block. |

The adapter owns monotonic sequences and content/result/artifact digests; native shapes supply no equivalent execution/1 guarantee. Terminal snapshots stay immutable. `cancel_requested` confirms neither stopping nor cleanup of side effects. `cancelled` requires runtime evidence for this exact task.

## 6. Errors

The [shared rule](../EXECUTION_CONTRACT.md#6-errors-and-recovery) applies at **adapter method invocation**, not native wire write. Every failure after invocation is conservatively dispatch `unknown`, including reads, native pre-initialization rejection, validation and journal conflict. Only a refusal before adapter invocation may be `not_dispatched`.

| Condition | Proposed outcome |
| --- | --- |
| Not initialized, malformed shape or protocol refusal | `EXECUTION_PROTOCOL`, dispatch `unknown` after invocation |
| Overload `-32001`, loss, timeout or abort | `EXECUTION_UNAVAILABLE`, `EXECUTION_TIMEOUT` or `EXECUTION_ABORTED`; retain uncertainty, explicitly inspect the original ref; no retries |
| Observed failed turn: `usageLimitExceeded` or `contextWindowExceeded` | `failed` / `TASK_LIMIT` |
| Observed failed turn: `sandboxError` | `failed` / `TASK_POLICY`; other native refusal representations need qualification |
| Other failed-turn variants including `unauthorized`, `badRequest`, `internalServerError` or unknown values | `failed` / `TASK_FAILED`; no diagnostics copied or implicit consent renewal |
| Observed interruption attributable to owner cancel | Proposed `cancelled`, subject to stopping qualification |
| Observed interruption attributable to deadline action | Illustrated `failed` / `TASK_DEADLINE`, without hard-deadline guarantee |
| Retrieval budget refusal | `EXECUTION_LIMIT`, dispatch `unknown` after invocation; no success result. `TASK_LIMIT` requires a qualified adapter/runtime outcome, not merely a failed read. |

The pinned [TurnCompletedNotification schema](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json/v2/TurnCompletedNotification.json) encodes simple error variants as camel-case strings, not `{type: "UsageLimitExceeded"}`. Other variants have structured payloads; unknown variants must fail safely without copying their content. Native messages, additional details, headers and stacks never enter persisted error records. An observation failure is not an invented terminal task state.

## 7. Synthetic examples and review gates

[transcripts.json](../../../tests/fixtures/agent-platforms/codex/transcripts.json), [README](../../../tests/fixtures/agent-platforms/codex/README.md) and [validate.mjs](../../../tests/fixtures/agent-platforms/codex/validate.mjs) supply nine synthetic examples. The validator checks shared DTO schemas, identities/digests, transitions, conservative dispatch certainty and selected reviewed fields. It neither executes a mapper nor validates complete native messages against upstream schemas. Projected responses/notifications omit unrelated required fields.

Scenarios illustrate success/results, both cancellation races, deadline-triggered interruption, usage-limit failure, known-thread uncertain-dispatch reconciliation, changed-digest conflict, sandbox failure and an uninitialized read. The reconciliation example models a lost reply; it does not assert that an overload response proves a turn began.

Before implementation/qualification:

1. Verify exact binary/package provenance and compare generated schemas to source snapshots. Exercise full native messages and bounded parsing; projections are insufficient.
2. Establish original-ID lookup after thread-start and turn-start reply/persistence loss, concurrent duplicates and restart. If native identity cannot be proved, report unsupported recovery and leave the candidate unqualified. No new architecture or exactly-once claim is supplied here.
3. Establish interrupt-after-terminal/repeated-interrupt behavior, exact-task stopping, cancellation/deadline/completion races, unresponsive runtime and enforceable runtime/output/storage bounds. Cooperative timers alone do not satisfy this gate.
4. Establish complete retained turn/item history, deterministic frozen results, raw caps, immutable repository isolation, effective non-interactive policy and independently authenticated process/current grant checks.
5. Implement/review in a separately authorized slice, preserving Cloudflare-first sequencing and KIT/CF/Settings ownership. Accepting this proposal causes no compatibility upgrade or activation.
