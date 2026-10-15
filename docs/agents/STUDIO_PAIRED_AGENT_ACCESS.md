# Paired local agent access

An enabled local connection with a matching unrevoked pairing can start a conversation in the selected project without repeated Allow or fresh-password prompts. Start conversation atomically persists selected-project grant and conversation. Existing narrower limits remain; revoked grants/generations are never automatically renewed.

Each turn still checks current owner session, project/snapshot, generation, limits and runtime. Existing-pairing model configuration requires owner authentication and CSRF. New pairing and credentials retain fresh authentication. Cloudflare consent is independent. Native filesystem policy and publication/Release authority are unchanged.

Focused hub/HTTP/browser fixtures cover persistence, restart, revoked/mismatched pairing, concurrent revocation, cross-project refusal, session expiry, proposal preview and explicit Save. Bounded real original-result recovery and fresh Stop were demonstrated separately; the Stop run used instrumented compiled modules and ZIP identity was checked separately. See [Windows qualification](STUDIO_CODEX_WINDOWS_STARTUP.md).

Tiny deltas are batched under the existing event budget with final flush. Exact terminal identity prevents late interrupts; transport errors and unrelated terminal events still fail. A task completed before Stop remains succeeded. Uncertain tasks retain original identifiers for inspection without resubmission. A private saved draft is separate from selection, validation, publication and human Release approval.
