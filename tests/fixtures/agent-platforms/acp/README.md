# ACP-P1 synthetic fixture slice

Offline evidence for the [ACP execution mapping proposal](../../../../docs/agents/platforms/ACP_EXECUTION_MAPPING.md). This directory is a proposal artifact only: it contains no adapter, transport, journal, mapper, credentials or runtime, and passing its checks establishes shared DTO consistency for the proposal, never a qualified ACP integration. The proposed profile (SDK `1.5.0`, `codex-acp` `2.2.2` resolving Codex `0.160.1` in that exact source lockfile) has not been installed or executed.

## Files

| File | Role |
| --- | --- |
| [sources.json](sources.json) | Copy of the pinned public source snapshot (UTF-8 LF SHA-256 `868c0567…7455`): SDK/adapter metadata pins, the 116-definition mechanical schema subset (SHA-256 `8d98a3af…3344`) and the pinned v1 document list. The outer file's checkout CRLF is normalized to LF for hashing; embedded upstream fingerprints are unchanged. It is the only source input; nothing here depends on preparation-time `reference/` material. |
| [transcripts.json](transcripts.json) | Eleven hand-authored synthetic scenarios: partial native JSON-RPC projections annotated with task/session/request attribution kept outside the wire objects, plus proposed normalized common DTOs and journal/admission/refusal decisions. |
| [validate.mjs](validate.mjs) | Offline validator: Node builtins plus the shared `dist/src/agent-execution.js` module. No network, installs or native processes. |

## Scenario IDs (exact, in order)

1. `success`
2. `concurrent-duplicate-admission`
3. `changed-digest`
4. `lost-session-new-response`
5. `lost-prompt-completion`
6. `restart-with-and-without-native-identity` (variants `with-native-identity`, `without-native-identity`)
7. `cancellation-completion-race` (variants `completion-wins`, `abort-confirmed`)
8. `denied-permission`
9. `revocation-late-output`
10. `output-overflow`
11. `unsupported-version-capability` (variants `unsupported-protocol-version`, `unsupported-capability`)

## Assumptions (labeled, not proven)

- A host-durable **atomic journal** reserves `(connection_id, task_id)` with the complete digest before any native call, retains observed native session/prompt handles, freezes immutable attributable completions and applies generation flips atomically. These in-memory shapes cannot prove crash durability.
- A bounded **private collector** receives native notifications and the eventual `session/prompt` response after `submit` has returned within the ten-second control bound. The native prompt RPC may remain pending in that collector; this does not bound native work or widen authority.
- All identifiers are invented public synthetic values; no real repository, account, session or capture exists here. Native vocabulary comes from the pinned schema subset and pinned v1 documents; fixture annotations stay outside native wire objects.
- Uncertainty is represented in journal/error decisions outside the common status DTO; no unknown terminal state is invented.

## Run

```sh
node --import ./tests/no-external-fetch.mjs tests/fixtures/agent-platforms/acp/validate.mjs
```

The validator recomputes task/ref/result/artifact digests with the shared helpers, re-derives pinned enum vocabulary from `sources.json`, checks attribution, monotonic sequences, terminal immutability, no-second-start counts, conservative dispatch certainty and per-scenario semantic expectations, and then replays in-memory negative mutations (pin co-substitution, digest/ref tampering, sequence reversal, cross-task/session/request substitution, lost-response resubmission, fabricated history success, permission widening, revoked success, unsupported version/capability) expecting each to be rejected. Live updates must attribute the original prompt; replay updates attribute their load request. Retained completions and frozen results must bind the exact prompt and session, including cancellation. Mutations never write back to disk.

Reservation annotations carry a structured connection key and full request digest. Synthetic success assumes a future qualified completion policy plus retained original-prompt attribution. The diff artifact retains canonical UTF-8 JSON bytes with matching `application/json`, byte count and digest. Cancellation timing is an explicit synthetic assumption. Version/capability errors after adapter invocation remain `unknown`; finite persisted messages use the shared static error message.
