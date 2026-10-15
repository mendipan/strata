# Checklist Cloud and Studio integration

The preview includes reviewed checklist Cloud configuration, bootstrap, model-policy diagnostics, retained accounting, private cleanup and bounded post-delete inspection alongside Studio. [Model policy](CHECKLIST_CLOUD_MODEL_POLICY.md) defines execution boundaries; historical Cloud execution is distinct from local fixture validation.

Post-delete inspection is capped at three physical GET exchanges across retries/polling. Exactly one DELETE is retained. Final transient errors or exhausted allowance preserve evidence and cleanup blockers instead of spending another request. Fixed backoff and request/byte caps remain enforced.

Focused management/bootstrap/contract/cleanup/version/settings tests use in-memory responses with external fetch blocked. They verify success within allowance, final-error refusal, exhausted visibility inspection, exact DELETE counts and retained obligations. Native workerd/static-import and provider execution need separate qualification; synthetic passes imply no new Cloud run.

Integration does not activate a host binding, release budget holds, inspect credentials, delete live resources, grant access, approve drafts/Releases or deploy Studio. Private handoff paths, task identifiers and operational receipts are omitted.
