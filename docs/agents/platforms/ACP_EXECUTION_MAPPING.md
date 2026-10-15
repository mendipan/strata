# ACP execution mapping proposal (ACP-P1)

Status: offline compatibility proposal for stable Agent Client Protocol (ACP) v1 with synthetic normalized fixtures. **No functioning or qualified ACP execution integration is delivered.** There is no adapter implementation, durable journal, runtime test, installed profile or host wiring; neither compatible Windows behavior nor native isolation/recovery is established. Strata consuming an ACP agent over stdio is the proposed direction. ACP clients and agents are distinct roles: Devin Desktop is an ACP client like the proposed Strata side, Devin CLI `devin acp` is only a later separate candidate runtime, and Devin Cloud REST is a different profile. No ZCode ACP contract was established by the accepted assessment. ACP remains an unqualified proposal; the [existing compatibility inventory](../COMPATIBILITY.md) is unchanged; Cloudflare remains first and accepting this document activates nothing.

The normative authority is [execution/1](../EXECUTION_CONTRACT.md). This mapping changes no shared execution semantics, discovery or host activation.

## 1. Selected surface and immutable sources

The proposed surface is an operator-supervised ACP agent subprocess speaking newline-delimited JSON-RPC 2.0 over stdio, negotiated at `protocolVersion` 1. Evidence is pinned in [sources.json](../../../tests/fixtures/agent-platforms/acp/sources.json), copied from the preparation snapshot (SHA-256 of its UTF-8 LF bytes `868c0567…7455`). The validator normalizes Git checkout CRLF line endings to LF for this outer text file's fingerprint; the embedded source/schema fingerprints still bind the exact upstream bytes.

| Pin | Evidence |
| --- | --- |
| Schema authority | TypeScript SDK `@agentclientprotocol/sdk` `1.5.0`, commit `f1ba3a935df42efb4455be9b62c76b06610aaf50`; schema 373,903 bytes, SHA-256 `2a920d3c…ce41`; reviewed 116-definition mechanical subset, 105,888 bytes, SHA-256 `8d98a3af…3344` |
| Wrapper candidate | `@agentclientprotocol/codex-acp` `2.2.2`, commit `202e66e63343ec4f5a5e35ab590251d813d129ca`; its exact source lockfile resolves SDK `1.5.0` and `@openai/codex` `0.160.1` |
| Vocabulary | Ten pinned v1 document snapshots (overview, initialization, session setup, prompt turn, cancellation, tool calls, transports, session list, authentication, Devin ACP) with per-file hashes |

The schema tree contains **unstable optional features** even inside its v1 branch (`PromptResponse.usage`, notices, compaction, providers/NES, fork/resume/close are marked UNSTABLE in the reviewed subset). They are excluded from this profile; no v2 draft or unstable extension becomes an implied v1 guarantee. Elicitation is also excluded, but the pinned schema does not mark `ClientCapabilities.elicitation` or `ElicitationCapabilities` UNSTABLE. Pins attest documented bytes only — not runtime identity, attestation, signature verification or deployed behavior — and this profile has never been installed or executed.

**Codex version mismatch, stated rather than hidden:** the native [Codex mapping](CODEX_EXECUTION_MAPPING.md) pins `@openai/codex` `0.162.1` with reviewed generated schemas, while the wrapper's lockfile resolves `0.160.1`. They are **not equivalent**. The wrapper buys reviewed ACP vocabulary and lockfile reproducibility for `0.160.1` but adds an unaudited translation layer and lags native releases; the native app-server surface offers pinned reviewed schemas at its own commit but requires full protocol work. Published adapter dependency **ranges** (`^`) do not guarantee that subsequent installs resolve to the lock versions; either choice needs provenance verification at implementation time.

## 2. Operation mapping

`describe()` stays a pure compiled declaration; `initialize` belongs to explicit supervised startup and is never Strata discovery identity — pure describe is compiled/operator metadata. Every row describes a future adapter.

| Operation | Proposed native calls and requirements |
| --- | --- |
| `submit(task)` | Durably reserve the original `(connection_id, task_id)` and complete digest **before** any native call; serialize concurrent duplicates at that key. Then supervised `initialize`, `session/new` with an operator-approved isolated `cwd` and operator-configured `mcpServers`, and **one serialized `session/prompt`** whose prompt is the task instruction. Return a snapshot within the ten-second control bound; the native prompt RPC may remain pending in the bounded private collector, which collects its completion later. This does not establish a native work bound. |
| `status(ref)` | ACP has **no universal poll by original Strata task ID**. Proposed status reads bounded private collector/journal snapshots. `session/list`, history replay via `session/load`, session titles and `updatedAt` matching are observations, never terminal task receipts. |
| `result(ref)` | Only from the **immutable attributable completion retained before success is emitted**: the exact prompt RPC's response bytes plus retained message/diff content, digest-bound. `end_turn` alone is not native work-stop proof, measured testing or Release. |
| `cancel(ref)` | The `session/cancel` notification yields `cancel_requested` only. The original attributable `session/prompt` reply with stop reason `cancelled` (after pending permission requests are answered `cancelled`) confirms a successful abort per v1. Completion may already have won; a terminal success cannot be restarted. Generic `$/cancel_request`, `-32800` on other requests, EOF/stdin close, process exit, UI tool status and local `AbortSignal` prove nothing. Missing supported cancellation or bounds blocks qualification; permission to kill processes is never granted or widened. |

`max_tokens` and `max_turn_requests` map to `failed`/`TASK_LIMIT`, `refusal` to `failed`/`TASK_POLICY` — deliberate finite outcomes with no fabricated success.

The documented lifecycle and cancellation rules are captured from [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn); creation/load behavior from [v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup). [Devin CLI ACP](https://docs.devin.ai/cli/acp/zed) identifies a later runtime direction. The synthetic completion race assumes the agent committed its reply before receiving cancel, while the client reads that delayed reply after sending cancel. It does not permit an active agent to ignore cancellation.

## 3. Custody, authentication and authority

Host custody is separate from provider login: ACP `authMethods`, `authenticate`, terminal login and `agentInfo` authenticate the agent to its provider and describe the implementation — they never establish owner consent, bridge identity or Strata authority. The host supplies the current `ExecutionGrant` before and after each operation with separate approval/selection/session/credential generations. Revocation or a generation flip rejects late output without claiming rollback, cleanup or refund; no cleanup cancel is issued under a revoked grant. Outputs stay `trust: "agent-output"`.

## 4. Identity, binding and recovery

| Binding | Gap and required handling |
| --- | --- |
| Original key/digest | Retain `(connection_id, task_id)` plus full digest before any `session/new` dispatch. A changed digest conflicts **even after a terminal state**; no replacement UUID, retry, redirect or fallback. |
| Native handles | Retain the observed `sessionId` and the exact prompt request id when obtained. A lost `session/new` response without retained identity stays uncertain and blocks a second `session/new`/`session/prompt`. Even a retained `sessionId` does not prove the original prompt completed after restart: history replay, `session/list`, titles, timestamps and assistant text are not receipts. Restart may retrieve an already committed immutable result; a missing completion remains result-unavailable/uncertain. |
| Task/binding/commit/model | One task owns one session in one isolated checkout at the approved immutable revision. Task-controlled surfaces (`session/set_mode`, config options, `mcpServers`, additional directories) come from operator configuration, never task data; tasks carry no endpoint, options or credential bags. The configured executable, launch arguments and `cwd` are operator custody fixed at supervised startup, distinct from anything a task may influence. `binding.model_version` is a Strata model, not the agent's native LLM choice. |

Account and process sharing is a real risk: one ACP subprocess and its provider login can serve many sessions unless the host enforces per-task processes and checkouts.

## 5. Limits, permissions and fail-closed callbacks

ACP establishes no hard runtime, raw-output, storage or cost limits; the adapter must cap raw bytes before parsing and enforce work/output/storage bounds, and unsupported bounds block qualification. The ten-second control call bound never bounds the native turn; one hour remains the requested-task maximum. Client `fs.readTextFile`, `fs.writeTextFile`, `terminal` and `auth.terminal` are false in this profile; elicitation and optional client session extensions are omitted. MCP transport support is advertised by the **agent** through `agentCapabilities.mcpCapabilities`, not by a client false flag; the fixtures configure `mcpServers: []`, without claiming this disables native tools. Permission callbacks fail closed: a denial selects an **actually offered reject option** (`reject_once`/`reject_always`), never `allow_always`/`allow_once`, never widening client permissions or falling back from deny to native unrestricted behavior. Advertising client capabilities as false only removes protocol callbacks — it does not stop the agent's own native filesystem, terminal or network access, whose effective isolation must be qualified natively. A tool denial alone does not infer total task failure or stop; local failure policy and any later prompt refusal are explicit finite outcomes. Output overflow refuses success and records unknown ongoing work rather than claiming a native hard stop; no `unknown` terminal status is invented — uncertainty stays in the journal. Retention gates follow the shared contract: expired or unavailable output is an explicit `EXECUTION_RESULT_UNAVAILABLE`, per-connection concurrency/rate/storage budgets refuse at capacity, and terminal snapshots plus the frozen result digest stay immutable for the retention window.

Advertising false client capabilities and rejecting callback requests does not sandbox the agent's own filesystem, terminal or MCP tools. Native-side bypass and descendant-process behavior require per-runtime qualification.

## 6. Errors

Failures are finite static messages with dispatch certainty. Pre-invocation unsupported/version/binding refusals may be `not_dispatched`; the illustrated version-negotiation and recovery-capability errors occur after adapter invocation and therefore remain `unknown`; everything after adapter invocation is conservatively `unknown`, including a dispatched `session/new` whose reply was lost. Post-invocation failures never fabricate a terminal task state.

## 7. Synthetic examples and review gates

[transcripts.json](../../../tests/fixtures/agent-platforms/acp/transcripts.json), the [fixture README](../../../tests/fixtures/agent-platforms/acp/README.md) and [validate.mjs](../../../tests/fixtures/agent-platforms/acp/validate.mjs) supply eleven named scenarios and fourteen variants (restart, cancellation and unsupported each carry both variants): success; concurrent-duplicate-admission; changed-digest; lost-session-new-response; lost-prompt-completion; restart-with-and-without-native-identity; cancellation-completion-race; denied-permission; revocation-late-output; output-overflow; unsupported-version-capability. Each entry is hand-authored partial native JSON-RPC plus proposed normalized common DTOs and journal/admission/refusal decisions — not wire captures, full schema conformance, a functioning mapper or native enforcement. They assume a host-durable atomic journal and bounded private collector rules; annotations stay outside native wire objects, and session/prompt request attribution is preserved in every relevant event.

Before any implementation: verify package/binary provenance against the pins (ranges can drift); establish original-ID recovery, isolation, enforceable limits and cancellation behavior on the real runtime; and compare the codex-acp wrapper against a direct native app-server mapping — reusable protocol parsing cannot supply native durability or authority.

Synthetic success additionally assumes a future qualified profile makes the exact retained prompt completion eligible; these fixtures do not establish that qualification. Synthetic cancellation assumes the runtime honors v1's abort requirements; a returned `cancelled` field alone cannot establish native stopping on an unqualified runtime. The example artifact is the exact retained canonical UTF-8 JSON diff record (`application/json`); its digest and byte count cover those same bytes.
