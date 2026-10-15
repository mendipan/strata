# Immutable Artifacts registry

The adapter batches immutable trees, preserves semantic-hash/Git-commit/path locators, verifies complete read-back before index publication and supports cold reads without local fallback. The Node broker accepts it through trusted in-process host controls. There is no default remote binding or credential configuration.

## Implemented path

`ArtifactRegistryStore` is injected as `startLocalBroker(..., { artifacts: store })` by the trusted host. It wraps `CloudflareArtifactsAdapter`; capabilities and transport are also explicitly injected, with no default global fetch or credential loader. The standard CLI continues to require local-persistent-fake configuration and now sends that storage expectation. A mismatched Node broker refuses it before storage access. A caller-supplied header cannot configure a store or create a spending grant. The host API is a code integration surface, not a new public onboarding option.

The durable registry has a `strata-artifacts-registry/1` binding to project, account, namespace, repository and real-versus-mock mode. Each record retains its original canonical JSON SHA-256, type, visibility and exact commit/path/hash/size locator. SHA-1 Git OIDs remain distinct from semantic SHA-256 hashes. Locators cannot use branch names. The whole locator envelope is checked before provider dispatch. A foreign binding, missing locator, invalid size or unexpected path fails closed. Existing local history is not automatically migrated.

New records are batched into deterministic immutable Git branches; existing record bytes and visibility-only publication reuse their locators. New binary assets use exact original bytes at SHA-256-qualified `.bin` paths, alongside strict descriptor `.json` records. Binary batches use a version-2 Git manifest; JSON-only batches preserve the existing version-1 manifest and deterministic commit format. Complete batch read-back verifies raw bytes, size and SHA-256 before any locator is returned. Existing image, project, revision, descriptor, per-image and retained-closure bounds remain enforced. This is retention, not image interpretation or executable asset generation.

Only after staging/read-back and token/capability cleanup does the broker append a bounded local `artifact-stages.jsonl` receipt and publish its registry through the existing serialized atomic rename. It rechecks the current issuer and host run grant/budget before publication. A pre-index failure leaves an identifiable unpublished immutable stage; cleanup is not automatically dispatched. Lost push responses require explicit deterministic retry/discovery. Lost committed responses reuse the existing principal/project/input-bound idempotency result after current authorization checks and fresh storage reads.

On every operation and cold restart, the remote-configured Node broker reads indexed records and binary assets from their pinned provider commits. It never falls back to local files, an adapter cache, branch discovery or a fake. Starting that registry with the ordinary local-file broker refuses access. Offline local asset import and local-file backup explicitly refuse a remotely indexed state rather than dropping locators or producing an incomplete archive. **Remote import/export/migration remain unsupported.** Fixture initialization in tests is host preparation, not a shipped migration tool.

Remote adapter construction requires the exact account/namespace/repository, a project/repository-scoped unexpired host run approval, an injected transport and the existing shared RunBudget. The returned Git remote must exactly match that identity before token issuance and every cold read. A temporary write token is requested at 60 seconds; token/capability issuance that crosses the run deadline gets one bounded cleanup reconciliation, then revocation/disposal. Pending issuance beyond that window or cleanup failure stops the run and returns failure; timeouts do not prove provider cancellation. Budgets are in-process application guards, not durable distributed accounting or invoice caps. A restart requires a newly valid host run authorization; it does not silently replenish an approved budget.


## Validation and limits

The strict mock parses actual Git packets, decompresses pack objects, verifies Git identities and reads exact JSON/binary bytes. Tests cover owned publication and private visibility; Release/idempotency/inheritance; cold restart; peer/author refusal; post-stage revocation; corrupt/missing records/assets; failed push/read-back/cleanup; deadline reconciliation; lost replies/index writes; account/namespace pins; foreign/branch/size/hash locators; and pre-dispatch budget/approval refusal. Reviews and semantic approvals are synthetic fixture attestations.

Run after building:

```powershell
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/artifacts.test.js dist/tests/artifact-registry.test.js dist/tests/artifacts-rest-smoke.test.js dist/tests/artifacts-test-worker.test.js
```

Worker ProjectAgent/LayerAgent publication uses local Durable Object storage. The optional private Workflow harness exercises the native binding contract; its local tests do not establish deployed interoperability. Remote identity, production attestation, durable distributed spending controls and remote import/export remain separate concerns.

`scripts/artifacts-worker-prepare.ts` bundles a disabled local plan for an explicit run ID and account ID; it does not select an account, assume billing state or deploy. Generated configurations belong under ignored `.strata/` or outside this checkout. Recheck current provider pricing and obtain a fresh host grant before any separately authorized remote use.
