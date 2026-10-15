# ADAPTER-C bounded execution slice

The existing project ledger's ADAPTER-C precedes ADAPTER-KIT, ADAPTER-CF and ADAPTER-P. This implementation follows that order and reuses ADAPTER_AUTHORING, COMPATIBILITY, PLATFORM_RESEARCH_PROPOSAL and the SDK measured-execution proposal. Discovery-v1 remains byte-for-byte unchanged. No Studio, deployment, engine or credential-store changes.

## Files and acceptance

- `src/agent-execution.ts`: strict execution/1 schemas and compile-time port, exact capabilities, task identity, lifecycle, cancellation, errors and compatibility.
- `src/agent-execution-client.ts`: bounded calls, current authorization checks, sanitized failures, request/result binding and transition validation. Default unavailable without trusted host ports.
- `tests/fixtures/agent-execution.ts`, `tests/agent-execution.test.ts`: reusable synthetic agent and focused positive/negative lifecycle cases; no provider, process or model execution.
- `docs/agents/EXECUTION_CONTRACT.md`: normative host/adapter responsibilities, Cloudflare-first mapping, independent assignments and deferred features.
- Narrow authoring/compatibility/research cross-links; preserve historical evidence.

Build once, run only the new execution suite with external fetch blocked, check links and diff. Do not restart hosted conformance or expand discovery tests. Review the final diff for boundary failures before committing. Recheck main publication ownership and queued reconciliation/Git work; if unavailable retain an immutable integration commit instead of publishing over another owner.

## Progress

- Inputs and project-ledger dependencies read; isolated current-main base selected.
- Shared schemas/client, synthetic fixture and normative execution contract implemented. Independent ADAPTER-KIT, ADAPTER-CF, ADAPTER-P and later host-integration assignments are in EXECUTION_CONTRACT.md.
- Final code built on the subsequent Studio main checkpoint without touching Studio files. Focused execution suite: 14/14 passed with external fetch blocked. Link check: 427 links, zero failures. No discovery tests, hosted conformance, provider calls or deployments run.
- Final diff reviewed for authority, binding, revocation, uncertainty, redaction and output limits. Review corrected declaration-exception redaction and malformed completion handling; focused regression cases passed. Production durability/transport/identity/activation and SDK measurement remain explicitly open.
- Publication must preserve the separate queued reconciliation/Git/offline-doc stack. Its files do not overlap this slice; normal fast-forward publication is allowed only after current owner/main checks. No queued commits are incorporated or rewritten by this slice.
