# Platform research proposal: Codex, Claude, Cursor, Google

Subsequent ADAPTER-C decision: [execution/1](EXECUTION_CONTRACT.md) now defines the shared task contract and follow-on assignments separately from discovery-v1. The research and its historical unsettled-dependency statements below are retained as evidence of the earlier review; they no longer mean the common execution port is undecided. Candidate-specific identity, native guarantees and qualification remain open.

**Status: research proposal, unexecuted adapter qualification, for parent review.** Original research used frozen base `9a94e0cca11d8cf303880efa0e0fcd5aefe276f0`; documentation review checked the same discovery contract at `52ed675fb119b6fd8224d4131e7c911714d285ac`. This supports ADAPTER-P candidate research, without selection, ranking, implementation or qualification. Cloudflare remains the designated first platform. ADAPTER-C remains an unsettled dependency; this proposal does not complete either item. The separate SDK1 proposal was not an input.

## Existing Strata contract

- [AgentDiscoveryAdapterV1](../../src/agent-discovery.ts) has pure `describe()` and bounded `probe(context, signal)` methods (lines 44-48). Its strict declaration supports only `strata-agent-discovery/1`, injected verified service authentication, three binding fields and one request / 32,768 bytes / 10,000 ms; inference, chat, tasks, tools and engine authority are unsupported (lines 5-13).
- [Approved targets and authentication](../../src/agent-discovery.ts) require an exact HTTPS destination without query, credentials or fragment, and a host-supplied `headers`/`verify` integration. Unconfigured authentication refuses before transport (lines 21-55). Client login or an API key authenticating a caller does not independently verify the approved server subject.
- The [Cloudflare reference](../../src/agent-adapters/cloudflare.ts) checks the target, declaration digest, independent subject/expiry, service/instance and every binding value. It issues one GET with manual redirects and no cache, accepts only 200 JSON, caps body bytes, applies abort/deadline handling, limits validity to five minutes and the target/identity expiry, and has no retry/fallback (lines 21-61).
- `model_version` is a Strata binding, not automatically a vendor LLM identifier: the [synthetic harness](../../scripts/agent-adapter-conformance.ts) uses `strata/0.1-facets-experimental`. Binding schemas accept constrained strings; immutable repository provenance must be established by the trusted host, not inferred from a branch name or vendor response.
- The [authoring guide](ADAPTER_AUTHORING.md) and [starter](../../examples/agents/cloudflare-discovery-starter.ts) describe a custom application discovery protocol, not a built-in Agents SDK endpoint. The reference and [tests](../../tests/agent-adapter-conformance.test.ts) exist; this review did not rerun conformance. Their evidence is synthetic, with actual target/auth provisioning separate.
- Studio's [lifecycle](CONNECTION_LIFECYCLE.md), [Settings routes/CLI/UI](SETTINGS_INTEGRATION.md) and [persistent consent factory](PERSISTENT_CONNECTIONS.md) already exist. Consent/intent persistence does not supply live authentication, automatic session renewal or a perpetual connection; ordinary hosted startup remains unconfigured.
- [Discovery projection](../../src/agent-discovery.ts) leaves engine authority unconfigured and authoring/execution/chat false (lines 68-71). Existing [candidate inventory](COMPATIBILITY.md) and engine authority remain unchanged.

## Official evidence reviewed

The following seven public primary pages were read during review on **2026-10-12 (UTC)**. They replace unsupported wording from the original research. Version-family or API-version labels are not installable dependency pins.

| Candidate | Precise documented surface | Class and version status | Native authentication evidence |
| --- | --- | --- | --- |
| Codex | [`codex app-server`](https://learn.chatgpt.com/docs/app-server) | Operator-run JSON-RPC control process; stdio default; schemas generated for the running Codex version. App-server command/WebSocket transport carry experimental, unsupported-production warnings. No concrete CLI pin selected. | Configurable WebSocket capability or signed-bearer tokens; account authentication is separate. |
| Claude | [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), with [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) | Operator-run Python/TypeScript library driving the Claude Code binary; no exact dependency versions selected. | API-key setup and third-party provider methods documented; these authenticate downstream model access. |
| Cursor | [Cloud Agents API v1](https://cursor.com/docs/cloud-agent/api/endpoints), with [API overview](https://cursor.com/docs/api) | Vendor-hosted agent/run service; public beta, subject to change. `v1` is an API version, not a package pin. | Basic or Bearer auth using a user or service-account API key. The overview's `admin:*` scope belongs to Admin/AI Code Tracking APIs. |
| Google | [Python ADK](https://adk.dev/get-started/python/), with [ADK overview](https://adk.dev/) | Operator-run agent framework; `google-adk` package and `adk` CLI. Overview identifies ADK 2.0; no exact package pin or GA claim established here. | Quickstart configures a Gemini API key for model access; deployed service authentication remains unverified. |

These are agent control surfaces or frameworks, with native execution capabilities beyond Strata discovery. They are not interchangeable with raw model endpoints. None of the reviewed pages establishes Strata interoperability, server identity, deployment readiness or engine authority. A local bridge or hosted wrapper would be a future implementation proposal.

## Capability assessment

**N** = documented native capability; **A** = Strata adapter/host implementation required; **U** = mapping or guarantee unverified. Native support does not remove an A/U requirement. The [Strata contract](ADAPTER_AUTHORING.md) applies to every candidate.

| Dimension | Codex | Claude | Cursor | Google |
| --- | --- | --- | --- | --- |
| Agent control surface | N: app-server | N: SDK/binary | N: agent/run API | N: ADK runtime |
| Non-executing metadata | N: config/model reads; A/U: discovery | U; A: discovery | N: key-info GET; A/U: discovery | U; A: discovery |
| Caller/native auth | N: transport/account auth | N: provider auth | N: user/service-account key | N: model API key |
| Independently verified service/instance subject | A/U | A/U | A/U | A/U |
| Exact project/Strata-model/immutable-repository/declaration binding | A/U | A/U | A/U | A/U |
| Single approved HTTPS GET, strict manifest | A/U | A/U | A/U | A/U |
| 32 KiB / 10 s / five-minute validity | A; native guarantee U | A; native guarantee U | A; native guarantee U | A; native guarantee U |
| Discovery cancellation | A/U; N: turn interrupt | A/U | A/U; N: run cancellation | A/U |
| No redirect/retry/fallback; secret redaction | A; native guarantee U | A; native guarantee U | A; native guarantee U | A; native guarantee U |
| Synthetic Strata conformance receipt | A; absent | A; absent | A; absent | A; absent |

### Codex

The [app-server protocol](https://learn.chatgpt.com/docs/app-server) documents `config/read`, `model/list`, `turn/interrupt` and HTTP health probes on its WebSocket listener. The JSON-RPC wire omits the `jsonrpc` header. Read methods and health checks do not produce a bound discovery manifest. Turn interruption is not discovery-probe cancellation. Transport tokens authorize clients; their mapping to an independently verified service subject is unverified. Non-loopback listeners require explicit auth configuration.

**Smallest next check:** inspect the documented read-method response schemas and decide whether an operator-owned bridge can supply trusted identity and immutable binding. Pin the CLI and generated schema together before implementation. The [same page](https://learn.chatgpt.com/docs/app-server) recommends the Codex SDK for jobs/CI; that alternative has not been qualified here. No live process is required for this decision.

### Claude

The [overview](https://code.claude.com/docs/en/agent-sdk/overview) describes a library running the Claude Code binary, rather than an agent loop executing wholly inside the caller's process. The [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) identifies `@anthropic-ai/claude-agent-sdk` and `claude-agent-sdk`; supported installs generally bundle the binary. Package and runtime pins both remain needed. MCP client support does not establish a protected discovery server. Managed Agents is a separate hosted product, whose integration details were not reviewed.

**Smallest next check:** decide SDK versus direct headless CLI, then inspect the chosen package/runtime version and lifecycle reference. Design host identity separately from downstream API authentication. Do not assume a consumer Claude login is an authorized third-party integration; use the authentication methods in the [official overview](https://code.claude.com/docs/en/agent-sdk/overview).

### Cursor

The [overview](https://cursor.com/docs/api) explicitly distinguishes agent workflows from a standalone model/chat API. Its default rate limit does not prove single-GET compatibility. The [endpoint reference](https://cursor.com/docs/cloud-agent/api/endpoints) documents metadata GETs, including `/v1/me`, agent/run reads, and a separate run-cancellation POST. Creating an agent enqueues its initial run, so creation is execution, not discovery. Key-owner metadata does not prove the Strata service subject; run cancellation does not satisfy probe cancellation.

**Smallest next check:** map only an existing resource's read response to proposed binding fields, then decide whether a protected wrapper is viable. Pin API/schema status and key scope before implementation. Repository URLs, branches and model identifiers alone do not establish immutable repository or Strata-model binding. No key, account or agent creation is needed to inspect the public schemas.

### Google

The [ADK overview](https://adk.dev/) lists multiple languages and local/deployment surfaces. This proposal uses Python ADK as the concrete evidence surface, without selecting it for delivery. The [Python guide](https://adk.dev/get-started/python/) documents the runtime and CLI, a Gemini API key and local web UI, and explicitly limits ADK Web to development. Model credentials do not authenticate an ADK service to Strata. Language versions, Agents CLI, managed deployment and service identity must not be collapsed into one runtime/version claim.

**Smallest next check:** choose the runtime/service corresponding to the inventory's CLI/ADK/service choice, then review that surface's lifecycle and server-auth documentation and pin its actual package. Hosted IAM, stable identity and a non-executing manifest remain unverified; installation or starting the sample would not resolve them.

## Reusable selection checklist and open decisions

1. Record the primary page actually read, final URL, access date and exact version/status; recheck mutable docs before implementation.
2. Name one agent control surface, its operator and runtime dependencies. Separate raw model APIs, SDKs and managed services.
3. Map native caller/model auth separately from trusted server identity and the approved target's `expected_subject`.
4. Explain service/instance, project, Strata-model, immutable repository and declaration-digest provenance; mark absent guarantees U.
5. Define a non-executing strict manifest endpoint; account reads, health probes and agent creation are insufficient.
6. Preserve one approved GET, byte/deadline/validity limits, abort handling, refusal without redirect/retry/fallback and redacted failures.
7. Identify credential-free synthetic fixtures and conformance evidence, then separately authorized deployment/auth verification.

Parent choices remain the precise surface per candidate, independently verified identity for local bridges, ordering/count after Cloudflare and the ADAPTER-C contract decisions. ZCode and Grok remain unresolved exactly as [recorded](COMPATIBILITY.md). No platform-blocked T01/TLS work, connection redesign or implementation is assigned. Future remote adapter work requires the explicit host targets, source/version pins and per-run authorization in [CONTRIBUTING.md](../../CONTRIBUTING.md).
