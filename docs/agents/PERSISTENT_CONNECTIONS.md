# Persistent agent connection consent

Configure now saves installation-owner consent for the exact existing approved service profile and repository until the owner revokes or removes it. The server persists consent, its approval time, target identity hash, enabled intent, revocation time, action receipts and rate reservations. Browser storage retains only unresolved nonsecret action identities. It is not the authority for a connection.

The existing Cloudflare adapter remains **discovery only**. No deployed service, service authentication scheme, token issuer, credential slot, inference, tasks, tools, chat bridge or engine authority is added. Ordinary hosted startup remains unconfigured. The reference endpoint is an application protocol, not an endpoint automatically supplied by the Agents SDK.

## Consent, sessions and health

| Field/action | Meaning |
| --- | --- |
| `integration.state=approved`, `consent=until-revoked` | Persistent owner consent; no expiry from browser/session/server restart |
| `integration.enabled` | Persisted intent to connect; connect/retry enables it, disconnect pauses it |
| `health.state` | Current connected/disconnected/unavailable/error/revoked/interrupted observation |
| `service_session` | Separately observed authentication-session state; renewal is `unsupported` for this adapter |
| Configure | Fresh owner confirmation saves exact service/repository consent; no network request |
| Test | One bounded verified discovery exchange; historical test evidence, no runtime connection |
| Connect / Retry | One new bounded exchange under existing consent; no repeated setup or fresh consent required |
| Disconnect | Pause and cancel local waiting; keep persistent consent and receipts |
| Revoke | Fresh owner confirmation saves a revocation tombstone, disables intent and cancels local waiting |
| Remove | Fresh owner confirmation removes configuration and consent; preserve receipts and rate accounting |

All controls use the existing owner session, exact Origin/Host checks, current CSRF, strict 1 KiB action, CAS revision and original UUID. Retry is distinct from replay: retry creates a new explicit health probe; exact replay of an original receipt never redispatches. A response lost after dispatch must first be reconciled through its original outcome. Revoked connections refuse new connect/test/retry and old successful probe replay. Outcome inspection still returns historical receipts.

Logout, password rotation, idle expiry and server restart invalidate runtime readiness without deleting consent or enabled intent. A browser/server restart does not run a provider request or load a secret. Health starts disconnected until an explicit retry verifies the existing adapter. Short-lived discovery expires normally. `AGENT_SESSION_EXPIRED` means the service authentication session expired, with consent retained. The current adapter cannot renew that session or maintain a WebSocket. This delivery therefore persists **setup/authorization and intent**, not a perpetual healthy socket or unattended remote service session.

Cloudflare's [cross-domain authentication documentation](https://developers.cloudflare.com/agents/runtime/operations/cross-domain-authentication/) describes resolving fresh application credentials when reconnecting. That requires an application's actual token-issuing capability; SDK presence does not provide one. No refresh credential, issuer, provider session or renewal request is invented here. Service-side credential revocation remains a separate provider capability; local Revoke immediately blocks Studio dispatch, but cannot undo a request already received by a service.

## Trusted source and target policy

`AgentSelectedSource.current(): Promise<SelectedAgentSource | undefined>` returns secret-free local metadata:

```ts
type SelectedAgentSource = {
  selection_id: string;
  epoch: number;
  binding: { project_id: string; model_version: string; repository_id: string };
  valid_until: string | null;
};
```

Null is an explicit trusted durable source authorization. A finite existing source authorization stays finite. The core never rewrites an expired policy, issues a grant, changes accounting or recovers writer state. Namespace adapters recheck their persisted approval, revocation, selected repository and credential generation on every metadata read, and call `changed()` synchronously on selection/pause/revoke/credential changes.

`AgentTargetApprovals` likewise accepts an explicitly until-revoked policy with `target.valid_until=null`, while retaining the existing exact HTTPS URL and service/instance/subject/binding/declaration checks. Consent saves the hash of this exact target identity, excluding its renewable lease expiry. Changing endpoint, service, instance, subject, declaration or repository requires fresh Configure consent. Approval generations and session generations continue to invalidate cached proof. A finite target policy never becomes durable implicitly. Before a provider request, the core derives a maximum five-minute **local probe deadline** from durable policy and current source/session bounds; this neither renews a provider session nor creates authority.

Agent state remains bound to one exact project/model/immutable repository. Switching to another repository invalidates its runtime and refuses that other binding. A namespace host must select the appropriate separately consented agent store for each repository; it must not retarget an existing scope or reuse another repository's consent. Engine principals and operation grants remain absent.

## Persistence and host composition

The strict `strata-studio-agent-state/1` schema adds an optional `connection.authorization` record. Old records parse as `integration.state=legacy`; startup, old successful receipts and status reads never upgrade them. Legacy probes retain their existing finite-policy behavior, but refuse a newly durable source or target policy until fresh Configure saves explicit consent. An explicit fresh Configure creates durable consent. Missing/corrupt/genesis-mismatched/leased state fails closed; no startup initialization, reset or stale-lock recovery exists. New records require the extended reader; rolling back to an old executable after consent has been saved requires planned state compatibility handling, never deleting consent/history files.

Normal history retains 256 operations. One additional terminal revoke/remove slot lets an owner revoke at normal capacity without discarding receipts or rate reservations. After terminal capacity is exhausted, further setup needs separately reviewed archival. An interrupted exclusive filesystem lease still requires operator reconciliation; this change does not bypass that boundary.

[`createPersistentAgentHost`](../../src/explorer/persistent-agent-host.ts) validates the existing sealed installation/owner, immutable scope/genesis/state, canonical private directory and disjoint owner/control/key/credential/policy/catalog/accounting paths. It accepts trusted `source`, optional `targets` and `access`, finite `profileIds`, `protectedPaths` and an optional clock. It returns `settings` for the existing `OwnerAccess` `agents` option, plus synchronous `changed()`/`dispose()` hooks. Missing target/auth ports stay unavailable. No JSON-based module loading or ambient credential fallback is introduced. Callers must include every policy/auth/source/accounting path in `protectedPaths` and wire invalidation hooks before serving requests.

The namespace task owns its factory and repository switcher. This task owns the agent lifecycle/panel and the agent-only retry tracking hunk in `OwnerAccess`. It changes neither `scripts/studio-host.ts` nor the namespace/source Settings module. Existing hosted configuration cannot activate the factory alone because actual verified service ports remain unconfigured.

## Local evidence and remaining activation prerequisites

`studio-persistent-agent.test.ts` verifies actual child-process restart, saved intent, expired sessions with zero secret/dispatch calls, sanitized provider errors/retry, target substitution refusal, revocation during headers/network waiting, replay refusal, legacy-state handling, terminal history capacity, real owner HTTP login/logout/CSRF and host scope/path validation. Existing adapter/lifecycle/HTTP/CLI tests remain applicable.

`studio-persistent-agent-browser.mjs` uses real Edge with intercepted loopback HTTPS and synthetic service ports. It exercises browser reload, two actual server close/start cycles, retry without Configure, revoke confirmation/cancel/focus and mobile layout. Existing Settings/recovery browser scripts cover original UUID retention and rejected status refresh. Synthetic transport replaces every service call. Windows evidence does not establish Linux ownership/permission/fsync behavior or deployment compatibility.

The parent owns independent review, publication and deployment. No live credentials, grants, source reads/mutations, provider requests, deployments, TLS recovery or unrelated T01 review occurred. Before real activation, identify the actual existing service, its fixed discovery URL, service/instance IDs, independently verified subject, exact project/model/repository, supported authentication scheme, protected credential custody and session lifetime/renewal behavior. Qualify that specific adapter and Linux state handling, then fill the activation confirmation below with actual reviewed values. Unfilled placeholders are **not an activation packet**.

> I approve deployment of reviewed commit **[full SHA]** on **[Studio installation/host]** and activation of persistent Cloudflare discovery profile **[profile]** for existing service **[service ID]**, existing instance **[instance ID]**, exact HTTPS discovery URL **[URL]**, verified subject **[subject]**, and project/model/immutable repository **[binding]**. Use only the separately reviewed server-side authentication adapter **[scheme/version]** and protected credential custody **[slot/path reference; no secret value]**. Save integration consent and enabled intent until I revoke/remove it; retain finite service-session expiry and source policies. Permit explicit bounded discovery health probes only: one GET, at most 32 KiB, ten seconds, five starts per minute, no inference/tasks/tools/chat/engine authority. Approved provider session renewal is **[unsupported, or separately verified bounded capability]**. I approve only this activation and any explicitly listed initial private-state provisioning **[paths/scope digest]**, with existing source accounting and grants preserved.

There is no ready real-service activation command until those values and provider authentication are supplied and reviewed. Approval of code alone does not authorize persistent live access.
