# Approved source management

Studio and the CLI now share persistent owner-managed source operations. Deployment must explicitly opt into managed mode. Existing `connection_config`, `expected_repository_id` and `read_budget_file` configurations retain their legacy behavior: no automatic import, replacement, renewal or budget reset.

## Authority and provisioning

Sign-in and a saved Artifacts token do not grant source-management authority. A host operator approves a root-protected `strata-studio-source-policy/1` file binding the sealed installation/owner, immutable catalog genesis, policy expiry/actions, at most eight profiles and 64 finite tickets. Each ticket pins the complete connection, immutable repository ID and unique `grant-<UUID>` policy generation. A ticket ID or new filename cannot duplicate an existing full budget binding.

`prepareSourcePolicy` and `initialConnectionState` are pure operator preparation helpers. Matching private `genesis.json` and `state.json` must be explicitly provisioned before activation. Startup initializes neither files nor grants. Canonical policy/catalog/accounting paths are distinct, disjoint and separate from owner/control/key/ciphertext state. Linux policy ancestors must be root-owned and not group/other writable. Catalog/accounting use existing service-owned 0700/0600 primitives. Windows synthetic tests do not establish production ACL protection.

`sourceManagementConfigSchema` and `createManagedOwner` provide the launcher seam: `{policy_file,catalog_directory,accounting_directory}` and the existing sealed browser owner. Launcher wiring must reject managed mode alongside any legacy source triplet; it is coordinated separately with the launcher owner. The module alone does not enable a live manager.

Activation durably commits a prepared ticket/receipt, creates its exclusive manifest and unchanged `FileReadBudget` ledger, then commits the active pointer. Missing state, partial activation and stale leases fail closed for operator reconciliation. There is no reset, refund, automatic reclaim or initialization-on-read. Renew/remove retain spent ledgers and tombstones. Policy replacement requires explicit reconciliation and cannot reset history.

## API and CLI parity

Owner-only GET/POST `/studio/v1/owner/connections` returns bare `strata-studio-owner-connections/1` metadata. GET `/studio/v1/owner/connections/operations/<UUID>` inspects a durable outcome. Exact HTTPS Host/Origin/proxy checks, owner generation, JSON/CSRF, strict 1 KiB bodies, CAS revision and UUID apply. Create/renew/remove require fresh authentication. Reader, actor and agent credentials grant no management privilege.

Additive `reconciliation_scope` metadata contains opaque `owner` and `catalog` hashes. The owner hash binds the installation and owner; it remains stable through password/authentication rotation. The catalog hash binds the exact catalog lineage and is null when delegation is unavailable. These are browser storage namespaces, not authentication or management authority. Every outcome lookup/retry still requires current server authorization.

| Action | Additional fields | Effect |
| --- | --- | --- |
| create | profile_id, ticket_id, label | Activate one ticket; persist disconnected entry; no provider read |
| select | connection_id | Persist selection, invalidate previous view; no read |
| test | connection_id | Explicit bounded verification on the same ledger; preserve connection intent |
| connect | connection_id | Verify then enable only the unchanged selected source |
| disconnect | connection_id | Persist disconnected intent, abort wait, invalidate views; no refund |
| renew | connection_id, ticket_id | Retire old grant, activate approved new grant, stay disconnected; no read |
| remove | connection_id | Remove visible entry, retain spending/history; no read |

Every action also has `action`, `revision`, `request_id`. Replay reauthorizes and never redispatches; changed payloads conflict. At 1,024 receipts, new actions refuse instead of evicting identities. Uncertain/pending outcomes need explicit inspection; no automatic retry. Restart retains selection/spending but requires reconnection. Cached reads recheck owner/policy/grant expiry/catalog epoch/ledger before and after returning data.

```text
strata studio connections status --origin https://studio.example.test --username owner
strata studio connections create --origin https://studio.example.test --username owner --file action.json
strata studio connections outcome --origin https://studio.example.test --username owner --request-id UUID
```

The file contains the same nonsecret action JSON used by Studio. Each CLI invocation prompts for a password without echo and keeps cookies/CSRF in memory only. `--password-stdin` is an explicit protected-input alternative. No password arguments/environment variables, redirects, protected-state file access or unattended agent authority.

## Settings and evidence limits

The [guided Settings workflow](SETTINGS_WORKFLOW.md) presents **Connect repository** as the next step for a saved token and disconnected source, then **Open project** after actual verification. Test read alone leaves intent unchanged. Token editing, source tools and optional agent diagnostics use progressive disclosure. Metadata loading is independent, bounded and explicitly retryable.

Settings retains the existing cards, visual tokens and credential form. It exposes approved profiles/tickets, project/model/repository scope, expiry/caps, exact verified snapshot hashes and disconnected/verified/blocked/interrupted states. A successful test retains its snapshot hash across restart; earlier receipts lacking that field show an unknown snapshot rather than an inferred one. Startup, status, create/select/renew/remove and token save do not fetch. Credentials, read grants and accepted Release evidence stay separate.

Failed read codes render durable sanitized explanations and next actions across reconstruction/reload. Binding/corrupt-data failures require operator correction followed by an explicit Test read before Reconnect is enabled. Metadata refresh and stale-CAS recovery invalidate the shared global source view. An unresolved action's original UUID and strict nonsecret payload are retained in bounded, owner/installation/catalog-scoped session storage before dispatch; reload/navigation/refresh restore explicit outcome inspection without automatic lookup or replay. Confirmed terminal outcomes or definite action refusals clear the record. Exact retry requires an explicit missing-receipt lookup and the same catalog context. Storage denial refuses dispatch. No password, cookie, CSRF value, session key or provider credential is retained there.

Counters are **unknown**: the frozen ledger exposes `ready/reserve`, not a reviewed public snapshot. UI/CLI do not duplicate its parser or infer zero usage. A successful read grants neither authoring nor validation/approval. Agent service/auth remains unconfigured pending its exact protected discovery contract.

Synthetic tests cover real owner HTTP authentication, fixed-registry REST verification, durable spending, CAS/replay/capacity, revocation/expiry, interrupted activation and restart. Real Edge uses intercepted synthetic HTTPS for forms, lost-response outcome inspection, keyboard cancellation and responsive layouts. This does not establish live provider success or Linux deployment acceptance. Independent immutable boundary review and shared regression remain publication gates.
