# Adapter compatibility

The table below records the **original discovery adapter interface**, not the full current Studio runner. The separate [execution contract](EXECUTION_CONTRACT.md) and [Studio status](../studio/STATUS.md) describe bounded execution components. Native Codex 0.162.1 has demonstrated a real proposal saved privately and bounded recovery/Stop; its instrumented runtime and packaged identity were checked separately. The pinned Claude bridge has synthetic coverage and separate native/provider qualification. Cloudflare execution examples have their own explicit plans, budgets and evidence; discovery conformance alone qualifies none of them.

Status is evidence-based: candidate → synthetic-conformant → deployment-verified. Shared protocols, SDK presence and HTTP success do not advance a row. Versions below describe the tested declaration, not a live connected service.

| Adapter | Status | Version/auth scope | Unsupported / remaining gate |
| --- | --- | --- | --- |
| Cloudflare discovery reference | Synthetic conformance implementation | Adapter 1; discovery/1; declared Agents 0.26.0; injected verified auth only | Owner routes/CLI/UI are a separately reviewed integration slice; no live target/auth or production manager provisioning, inference/chat/tasks/tools or engine authority |
| Codex discovery adapter | Candidate in this interface | Separate native app-server runner targets 0.162.1 | See current Studio execution/qualification scope; this discovery row is not its status |
| Claude discovery adapter | Candidate in this interface | Separate pinned SDK runner exists | Native confinement and attended provider acceptance remain separate |
| Cursor | Candidate | Surface not selected | Supported cloud/local API, binding/auth and discovery evidence |
| zcode | Candidate; product confirmation needed | External control surface unestablished | Confirm intended product and supported API |
| Grok | Candidate; agent/model decision needed | Agent runtime unselected | Choose actual control surface; model endpoint alone is insufficient |
| Google | Optional candidate | Product unselected | Choose CLI/ADK/service; prove distinct auth and lifecycle |

The owner targets roughly five adapters over time, with a flexible count. Each addition needs supported transport, exact verified identity/auth, immutable binding, bounds, cancellation, redaction, conformance and separately authorized deployment evidence. No universal orchestrator or compatibility claim is implied.
