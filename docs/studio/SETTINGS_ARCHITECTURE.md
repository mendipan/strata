# Strata Studio Settings and agent adapters: implementation contract

Design review dated 2026-10-10. Selected architecture for staged Sol implementation, subject to normal immutable implementation review; this document grants no live access or deployment permission. It supersedes the proposals in SETTINGS_DESIGN_HANDOFF.md. Owner authorized this Astra High review and a vendor-agnostic adapter roadmap; no XHigh follow-up is needed for these bounded decisions.

Evidence base: clean main caf5ee31957e2b4e7bb83a0cc5cc96d9464db4ab; independently reviewed budget dc061af09dd4804cec4f924d5d36398773caf8ba (publication pending when reviewed). Hosting confirmed the management seam below, including the requirement that distinct tickets cannot duplicate an existing grant binding. No product code, credentials, source grants, live configuration, provider probes or agent runs were changed/performed during this review. All proposed formats/routes below are NEW contracts, not claims about existing endpoints.

## 1. Outcome and scope

Complete owner Settings for persistent approved repository connections: create, test, select, connect, disconnect, renew and remove. Keep current Studio cards, typography, colors, fields and mobile navigation. First catalog remains at most eight entries sharing the same project/model/repository identity, matching ExplorerConnections. Different-project catalogs and v0.3 remote source admission are separate work.

Add a small platform-neutral agent connection/discovery interface, one Cloudflare reference adapter, a synthetic starter and conformance tests. No chat, goal, model turn, tool execution, repository write or automatic agent run in this phase. Cloudflare SDK availability is not a connected service. Other platforms enter the roadmap as evaluated candidates, not compatibility claims.

| Identity or fact | What it establishes | What it does not establish |
| --- | --- | --- |
| Current sealed owner session | Installation owner authenticated at current generation | Source-management delegation or named engine principal |
| Saved Artifacts token | Server possesses one provider credential | Trusted registry, repository identity, read grant or usable budget |
| Explicit source-management policy | Owner may consume listed exact read-grant tickets | General grant issuance, renewal without limits, authoring or approval |
| Successful source test | Exact approved snapshot and repository verified at a time | Future reachability, new authority or accepted Release |
| Agent authentication/reachability | Approved service identity responded to discovery | Strata engine operation grants or approval evidence |
| Engine capability projection | Current authoritative principal/project/policy operation support | Permission to skip per-operation authorization or release gates |

## 2. Source authority: finite preapproved tickets

Use a separate root-protected `strata-studio-source-policy/1` file. Browser owner cannot write it. Missing policy means source management unavailable; existing read/credential behavior remains usable. Do not reinterpret owner login, the legacy manager key or provider token as this authority.

Policy binds installation_id, owner_id, catalog_id, immutable catalog genesis digest, policy_id/generation, valid_until, and one exact project/model/repository catalog scope. It contains at most eight approved source profiles and 64 grant tickets across the catalog lineage. A profile pins its authoritative registry path/kind, storage account/namespace/repository, immutable repository ID, model and optional initial Release. Fixed snapshots pin the admitted canonical index digest; atomic publication indexes retain the existing protected descriptor and exact publication binding. Registry replacement cannot be authorized by provider content alone.

Each ticket pins ticket_id, stable grant_id, profile_id, activation not-before/expiry, and a COMPLETE strictly parsed connection config plus immutable repository ID. Its read_authorization includes exact principal, operations, expiry, requests, bytes and timeout. Its policy_generation is unique and bound to grant_id (for example `grant-<UUID>`, respecting the existing key grammar). The browser can choose a ticket ID; it cannot submit paths, identity, principal, policy, credentials, larger limits or later expiry. Labels are catalog metadata, never edits to an established connection config.

Reject duplicate grant_id, ticket_id, full connection/repository budget binding, or canonical ledger path anywhere in the retained lineage. A new filename or ticket ID alone is NOT a new authorization. The frozen ledger hashes full config plus repository pin, not ticket ID. Ticket caps are the exact finite delegation; their total requests/bytes and remaining ticket count are shown in policy review. There is no unbounded automatic renewal. Existing schema ceilings remain 5,000 requests, 40 MiB and 10 seconds per request, but those ceilings are not default grants.

Root activation explicitly provisions the empty catalog once and pins its genesis in the policy. Service startup NEVER initializes missing policy/catalog/ledger. Policy replacement retains the same lineage, spent tickets, tombstones and genesis; it cannot restart a zero catalog. Later ticket batches require explicit host-operator approval and a reviewed append/reconciliation operation. They are not an owner Settings API. Initial implementation may refuse policy-generation changes until operator reconciliation; that is preferable to silently adopting them.

Files use existing canonical-path/no-link/ownership/durable-write primitives. Root policy is outside the service-writable tree; catalog is private service-owned state; every grant ledger has its own private 0700 directory and 0600 file, disjoint from policy, catalog, owner, key, credential and connection paths. No symlink, computed traversal, inherited cached UID or environment override. Policy revocation/removal and malformed state fail closed. Whole-host privileged rollback is not protected by these files; restoring backups requires disabling/reconciling old grants, never assuming remaining allowance.

This is bounded delegation to manage ALREADY approved sources. Arbitrary repository discovery/approval from a token is intentionally not a feature of the first version. Settings says exactly when another approved source or ticket must be supplied by the host operator.

## 3. Manager API, persistence and authority checks

New owner-only GET/POST `/studio/v1/owner/connections`; bare `strata-studio-owner-connections/1` JSON. New GET `/studio/v1/owner/connections/operations/<UUID>` returns sanitized durable outcome for this installation/owner. No queries, arbitrary path suffixes or Authorization fallback. Preserve existing exact HTTPS Host/Origin/proxy checks, cookie, CSRF, JSON content type, strict schemas and 1 KiB action body. Metadata responses capped at 64 KiB; paginate historical diagnostics separately if later needed.

Every POST has `{action, revision, request_id}`; request_id is UUID and revision is a nonnegative safe integer. Strict alternatives add only:

| Action | Additional fields | Effect and provider behavior |
| --- | --- | --- |
| create | profile_id, ticket_id, label | Consume exact unused ticket, persist disconnected entry; ZERO provider calls |
| test | connection_id | Explicit bounded full source refresh/verification; consumes budget; stays disconnected unless already connected |
| select | connection_id | Persist selection, disconnect/invalidate previous view; ZERO provider calls |
| connect | connection_id | Explicit bounded verification then connect only the still-selected, unchanged entry |
| disconnect | connection_id | Persist disconnected intent, abort local wait/invalidate generation/cursors; no grant refund or provider revocation |
| renew | connection_id, ticket_id | Consume a different authorized grant, retire old one, stay disconnected; ZERO provider calls |
| remove | connection_id | Remove visible entry, clear selection if needed, retain immutable grant spending/tombstone; ZERO provider calls |

Create/renew/remove require owner reauthentication within five minutes plus current management delegation. All other actions require current owner session and explicit allowed action in that delegation. Recheck current owner authentication generation, policy identity, catalog revision and action scope under serialization and before commit/dispatch. A read-only/shared-reader/actor session cannot call this API. An agent service credential is never accepted here.

GET returns revision, selected_connection_id, management state, bounded approved profiles/unused tickets, entries, and pending outcomes. Each entry has stable connection_id, profile_id, grant_id, display label, selected flag, desired_connection state, runtime readiness, exact grant expiry, reserved request/byte counters or null when unavailable, current local error/missing gates, last test time/outcome, and per-action `{allowed,reason_code}`. Unknown counters stay null; zero is never inferred from unreadable state. GET reads protected local metadata only; it does not test a credential, refresh a source or infer reachability.

Manager store format `strata-studio-connections-state/1` pins catalog genesis/policy/owner, monotonically increasing revision, immutable consumed tickets and grant bindings, entries, selection, operation intents/receipts and audit metadata. Bound it to 64 lifetime grant records and 1,024 operation receipts, with a strict file-size bound (2 MiB). At capacity, refuse further actions requiring receipts and require explicit operator archival/reconciliation; never evict a receipt and then silently execute an old request ID anew. New phase can revise bounded retention after evidence. Audit contains actor ID/generation, request/payload digest, action, before/after revision, grant IDs, timestamp and sanitized outcome, never passwords/tokens/records.

Idempotency is installation + owner + request_id + canonical payload digest. Authenticate/authorize BEFORE replay. Same ID and same payload returns the stored outcome without dispatch; different payload yields REQUEST_CONFLICT 409. Completed replays may refer to older revisions; non-replays require current revision or CONNECTION_CHANGED 409. Browser retains only nonsensitive action ID/payload until outcome is known; no automatic retry. An uncertain network result offers “Check outcome”; absence of an outcome does not justify automatically changing the request ID.

Grant activation transaction: acquire catalog lease; validate fresh authority/CAS/unused unique ticket; durably record prepared intent and irreversibly reserve the ticket; create immutable grant config/manifest and exclusive unique ledger using the frozen pure initialReadBudget helper; fsync files/directories; commit catalog pointer/receipt; only then expose the entry. Prepared ticket reservations are never refunded. Any crash/ambiguous fsync/rename/lease leaves the grant unavailable until bounded operator reconciliation of the same IDs. Missing established files are not fresh setup. Do not automatically delete an orphan or create a replacement ledger. Root policy and retained manifest identify the same grant even if activation never reached the UI.

Ordinary selection/removal/renewal commits use the same durable CAS store. Tests use a durable pending operation and captured connection/owner/policy epochs, then release the catalog lease DURING network I/O so disconnect can succeed. Before every external dispatch and before accepting the result, recheck authority and epochs; late results cannot reconnect or replace a newer selection. Restart never redispatches a pending test: it is interrupted/unknown, spending retained, explicit outcome handling required. No catalog lock held through a provider timeout. A stale exclusive filesystem lease still requires quiesced operator reconciliation.

Selection persists across restart. Verified reader/cache state does not; runtime is “Selected — reconnect required.” Startup/login/save/status/select do not fetch. Credential replacement/removal invalidates all dependent readers and increments their authority epoch; saving a token does not test it or reconnect. Source test and existing credential “test” must use ONE shared manager test path/receipt/budget, not bypass it through the old in-memory catalog.

## 4. Reuse and compatibility

Reuse ExplorerReader, RegistrySource, admitRegistry, RestArtifactsReader and FileReadBudget. Do not modify the cleared budget algorithm. Each reader reconstruction, selection and restart receives the SAME canonical ledger for the SAME immutable grant. Reserve before credential/provider, keep all reservations after denial/failure/cancellation, recheck expiry, and never reset/refund/reclaim. Exhaustion blocks further provider dispatch; it does not by itself manufacture revocation of an otherwise authorized cached snapshot. Expiry or policy revocation does deny cached reads.

The frozen FileReadBudget exposes ready/reserve, not counters. Do not duplicate its private ledger parser in Settings. Coordinate a separate, additive, reviewed read-only snapshot method with hosting after integration, using the same protected read/binding checks and returning only reserved counters. Until that method exists, counters are explicitly unavailable, not inferred from memory. It must neither reserve nor initialize nor change spending; status cannot reclaim a lease.

New manager errors are stable sanitized codes: SOURCE_MANAGEMENT_REQUIRED 403, CONNECTION_CHANGED 409, REQUEST_CONFLICT 409, CONNECTION_BUSY 409, CONNECTION_RECOVERY_REQUIRED 503 and MANAGEMENT_CAPACITY 409. Reuse existing SOURCE_AUTH, SOURCE_BINDING, READ_SESSION_LIMIT and READ_BUDGET_UNAVAILABLE meanings; add the latter to the UI mapping instead of reporting corrupt project data. Do not mark recovery/capacity errors automatically retryable.

New managed mode is mutually exclusive with legacy connection_config + expected_repository_id + read_budget_file startup mode. Keep legacy config and routes valid. In managed mode, legacy `/studio/v1/settings` and `/explorer/v1/settings` GET project the selected managed reader; legacy POST actions must be explicitly refused with a migration reason or routed through the SAME authorized durable manager semantics. Do not let legacy in-memory actions bypass receipts or persistent selection. Prefer refusal with an actionable supported-route message for old POST clients, since their bodies lack request IDs. Read-only default and local preview compatibility remain unchanged.

Keep domain authoring/review/approval/validation/Release routes and their authority untouched. Source owner management does not merge owner mode with studio-author.ts named-actor mode. Public/private record visibility, immutable references, evidence and separate scope/Release approvals retain current semantics.

Cached reads must reauthorize too: perform awaited protected policy/catalog/owner checks before query and before returning data; bind a short-lived internal read context to the current epochs and grant. Invalidate on denial/change. ExplorerSource.assertAuthorized is synchronous, so do not pretend it can alone load current root policy asynchronously. Use a small manager boundary around host reads and injected credential/transport callbacks, with source-load completion checks; preserve existing lifecycle invalidation. Transport callback rechecks before dispatch, and completed loads recheck before installing/returning a generation. No asynchronous check is a substitute for commit-time checks. Explicit regression: owner remains active while only source permission is revoked; exact cached-generation and cursor queries must return denial and no retained content.

CLI parity: stage `strata studio connections status/create/test/select/connect/disconnect/renew/remove/outcome` as thin clients of these same routes/contracts, not a second file mutator. Reuse owner pre-session/login/reauth cookie+CSRF over exact approved HTTPS origin; passwords are attended no-echo input or explicitly protected stdin, never arguments/environment/URLs/logs. Sessions stay process-memory-only and expire normally. Pin requested revision/request ID and support explicit outcome lookup. Do not reuse named-actor CLI authority or store owner passwords for agents. Unattended management is unsupported until separately authorized. Schema/store services are callable in synthetic tests without inventing a production bypass.

## 5. Agent connection contract: discovery first

Browser talks only to same-origin Studio. Studio loads a compile-time adapter and an operator-approved target profile; no arbitrary browser URL, command, module import, class name, instance name, header or RPC method. HTTPS destination, exact service/instance, permitted path, expected project/model/repository, authentication scheme and bounded discovery permission are server policy. No redirects or endpoint fallback. Private/local destinations require exact operator-approved network target; no user-controlled DNS/URL escape. Browser CSP stays `connect-src 'self'`.

Minimal internal interface (new product contract):

```ts
interface AgentDiscoveryAdapterV1 {
  readonly id: string;
  describe(): AdapterDeclarationV1; // pure local data, no network
  probe(context: ApprovedAgentProbeContext, signal: AbortSignal): Promise<AgentDiscoveryV1>;
}
```

The server-only context carries approved target, expected binding, authentication callback and bounded transport; browser input is just target_profile_id. Declaration version `strata-agent-adapter/1` includes adapter ID/version, pinned dependency/runtime versions, supported discovery protocol versions, authentication kind/credential requirements, supported binding fields, bounds and unsupported features. Discovery version `strata-agent-discovery/1` includes exact service/instance identity, project/model/repository binding, authenticated service subject, protocol/version, discovered_at, valid_until, declaration digest and finite advertised feature identifiers (max 32). No arbitrary descriptions become prompts or executable methods. Strict unknown-field/version refusal, bounded strings and 32 KiB response.

Keep service advertisement separate from verified Strata engine capabilities. Effective authoring/execution remains false in this phase. If an explicitly configured trusted engine identity provider exists, its real `capabilities` operation can be projected separately with principal/project/policy generation and trust; never synthesize these from remote service claims. If absent, `engine_authority.state='unconfigured'`, operations empty. Installed SDK/version, HTTP 200, successful auth, reported model and MCP support do not prove Strata compatibility.

New owner GET/POST `/studio/v1/owner/agents`, bare `strata-studio-owner-agents/1`, same session/Origin/CSRF/CAS/UUID/outcome principles. Actions configure(target_profile_id), test, connect, disconnect, remove. Configure is local only; test makes a single explicit bounded discovery exchange and remains disconnected; connect explicitly probes then commits connected-discovery state; disconnect invalidates epoch/aborts wait, remove retains outcome audit. First slice one agent connection for the selected project binding. Whole probe <=10 seconds, one in flight, no redirect/retry/poll/reconnect, no SDK background state subscription. Rate limit explicit probes locally (at most five/minute) without creating a scheduler. Restart is configured/disconnected. Discovery validity is no more than five minutes and never beyond policy/auth expiry. No automatic refresh on viewing Settings.

Cloudflare is the first adapter: use a designated authenticated HTTP discovery handler in the approved existing Agent service, not chat/RPC inference or state enumeration. For the new reference handler, discovery is one GET to the fixed configured path with JSON Accept; no body/query, no side effects and no instance creation. Authentication headers are supplied only by the selected server-side auth adapter. Derive service subject from the verified auth integration and compare exact pinned identity; do not accept a self-asserted subject as authentication. Handler must authenticate and authorize before returning bounded metadata. It can use the installed Agents runtime/instance mapping, but Strata discovery is an application contract that must be implemented; the SDK does not supply it. Export a pure handler factory with injected verified service identity and capability provider, exercised in synthetic Worker tests. DO NOT expose or convert the current local-fixture ProjectAgent/LayerAgent worker or FixtureIssuer into hosted authority.

No actual service URL, Agent class/instance or authentication scheme is established by the repository. The host adapter stays unconfigured until the owner/operator identifies the intended existing service and its documented auth contract. Do not select Bearer vs Cloudflare Access vs another mechanism by guess. If no non-inference discovery surface can be implemented there, report that exact blocker rather than “connected.” Model selection/payment is not needed to develop or test the synthetic discovery protocol.

Credential decision: preserve existing artifacts-api-token store/API unchanged. Introduce a server-only AgentAuthentication port in the adapter context; default denies, test fixtures inject synthetic auth. Once the actual service auth is selected, implement the smallest explicit credential slot(s) it requires, with provider/target domain separation in encrypted AAD, separate masked metadata and independent revisions. Do not silently reuse/copy the Artifacts token, hardcoded ciphertext format or owner password. No general vault or DB now. A store-version migration must preserve existing ciphertext readability and receipts, fail closed on partial migration and pass cross-slot substitution tests before release. Auth mechanisms needing two values cannot be squeezed into a guessed one-token schema.

## 6. UI decisions and actionable states

Keep Settings as the existing page, with sections in this order: current source and readiness; approved repository connections; credentials; agent connection. Reuse current cards/fields/status pills/toolbar; do not add a separate dashboard, new component framework or dense workflow canvas. Use a compact connection list and selected detail panel; on mobile stack them. New-source form is approved-profile selector, approved-grant selector and optional label. Summary shows exact scope/expiry/request+reserved-byte limits before Create/Renew. Root-only paths stay off the page.

Use one primary next action per blocked state, with details progressively disclosed. Avoid one green “Connected” pill representing every layer of authority.

| State | Exact useful next action |
| --- | --- |
| Owner session absent/stale | Sign in / confirm password |
| Source management not delegated | Explain host must approve exact sources/tickets; keep credential/read status visible |
| No unused ticket / grant expired or exhausted | Renew only if an eligible approved ticket exists; otherwise request further approval; show retained usage |
| Token missing/locked | Open credentials / report protected-store recovery; never imply a new grant |
| Registry missing or identity/hash/model mismatch | Explain trusted source must be corrected by operator; no “retry approval” shortcut |
| Budget missing/locked/malformed | READ_BUDGET_UNAVAILABLE: operator reconciliation; counters unknown, no reset button |
| Configured/disconnected or restart | Explicit Test read or Reconnect; selection survives |
| Test succeeded | Show verified time/snapshot; separate Use selected and Reconnect actions |
| Agent target/auth absent | Configure approved service / save appropriate credential after protocol is known |
| Agent reachable/authenticated, protocol or binding wrong | Show which gate failed; execution remains unavailable |
| Discovery verified, engine unconfigured | Show service capabilities and “Engine authority not configured”; no chat box |
| Timeout/uncertain action | Check outcome; Cancel waiting text never claims rollback |

Keyboard: real buttons/labels, sequential tab order, Enter submits only focused form, Escape closes/cancels local dialog, focus restored to trigger. Screen-reader live status announces completion/errors once; disabled action has visible reason. 320px layout has no horizontal action overflow, 200% zoom remains usable, errors are not color-only. Navigation/selection closes stale dialogs; logout/cancel/dispatch clears secret fields. No secrets in browser storage, URLs, response text or logs. No raw provider error rendering or clickable provider-supplied markup.

## 7. Vendor-agnostic roadmap and candidate compatibility matrix

Owner shortlist is Codex, Claude, Cursor, zcode, Grok and possibly Google. Roughly five prebuilt adapters is a roadmap target, not a popularity ranking or exact count. Cloudflare is the first reference even though it is a runtime rather than a model provider. Preserve the user's shortlist; do not replace it with a framework list. Official-source checks below establish available surfaces, NOT tested Strata compatibility. All non-Cloudflare adapter implementations are deferred.

| Candidate | Official surface established in this review | Concrete work before claiming compatibility |
| --- | --- | --- |
| Cloudflare Agents, first | Agent routing/HTTP and callable/client SDK surfaces; pinned repo dependency 0.26.0. [Routing](https://developers.cloudflare.com/agents/runtime/communication/routing/), [client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) | Exact deployed instance/auth; non-inference discovery handler; verified project/identity binding; synthetic then authorized live conformance. No current connected-service claim |
| Codex | Local coding agent, SDK/app-server integration described by OpenAI. [Codex repository](https://github.com/openai/codex), [SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) | Choose supported local app-server/SDK vs hosted service, pin version/auth/approval lifecycle, define protected bridge. Existing demo CLI is only a fixture. No assumption that Codex subscription, app messaging tools or MCP grant production access |
| Claude | Agent SDK exposes agent loop/tools in Python/TypeScript. [Official SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | Select deployed SDK service/runtime and documented auth; isolate tool/filesystem permissions, cancellation and resumable state; supply non-inference discovery. Claude model API compatibility alone is insufficient |
| Cursor | Documented Cloud Agents API launches/manages repository agents; currently labeled public beta. [Official endpoints](https://cursor.com/docs/cloud-agent/api/endpoints) | Choose cloud API vs another supported surface, pin API version and auth scope, map immutable repository/project identity, prove discovery has no launch side effect. API credentials and cloud execution permission separate |
| zcode | Z.ai publishes ZCode agent/product docs. [Official agent docs](https://zcode.z.ai/en/docs/agents) | Confirm this is the owner's intended product. This bounded review has NOT established a supported external control/discovery API. Do not infer API from desktop/bot features or automate its UI as an adapter |
| Grok | Official API documents model Responses and tool calling. [Responses](https://docs.x.ai/developers/model-capabilities/text/generate-text), [tools](https://docs.x.ai/developers/tools/overview) | Choose actual agent runtime/control surface; determine whether this is a model-provider integration requiring an owned harness. No equivalence between model endpoint and repository agent; no promised Grok agent adapter yet |
| Google, optional | Gemini CLI has headless structured output; Google ADK is an agent framework. [Gemini CLI](https://geminicli.com/docs/cli/headless/), [Google ADK](https://github.com/google/adk-python) | Owner/product task must select CLI vs ADK/deployed service (or another Google product). Auth, lifecycle, permissions and bridge differ; “Google” is not one protocol |

Each second provider must supply: a supported transport and version; explicit service identity/auth implementation; non-executing discovery; exact project/model/repository/principal mapping; cancellation/time/byte limits; redaction; error semantics; test fixture; actual authorized integration evidence; declared unsupported features. Shared MCP/A2A/HTTP syntax may reduce transport work but proves neither authentication equivalence nor Strata authority. No universal orchestrator, provider switching fallback, plugin download/execute registry or common lowest-denominator task runner.

Contributor tooling milestone: versioned TypeScript schemas/port, synthetic `reference-discovery` adapter, fixture service, conformance runner and example test; `docs/agents/ADAPTER_AUTHORING.md` with auth/capability declaration template, threat boundaries, compatibility evidence checklist and contribution path. Register adapters explicitly at build time. A compatibility matrix records adapter/runtime/protocol versions, OS/deployment, auth modes, binding support, discovery vs execution support, evidence SHA/date and status (`candidate`, `synthetic-conformant`, `deployment-verified`, `unsupported`). Never label an untested vendor “supported.” Reserve later major/optional execution extension only after actual lifecycle needs are known; do not stub fake task APIs into v1.

## 8. Sol implementation slices, ownership and release gates

| Slice | Concrete delivery | Completion gate |
| --- | --- | --- |
| S0 — integrate budget | Parent integrates/publishes cleared dc061af after its aggregate gate; preserve source/launcher ownership | Verified immutable published SHA; no live grant implied |
| S1 — source manager backend | New policy/schema/store/manager modules, owner authority seam, positive routes, synthetic activation/restart tests; legacy managed-mode isolation | Crash/CAS/revocation/no-reset negative tests plus independent boundary review |
| S2 — source Settings and CLI | Existing page controls/readiness, exact missing gates, same API CLI, browser/mobile tests and generic docs | API/UI/CLI operation parity; no hidden provider calls; persistence and accessibility checks |
| S3 — discovery contract/reference | New adapter port, Cloudflare handler/bridge, synthetic reference, conformance suite, Settings controls; default unconfigured auth | Zero model/tool/task calls, exact binding/auth negatives; no fixture promotion |
| S4 — real Cloudflare connection | Owner supplies exact existing target/auth; narrow reviewed credential slot if needed, operator config and explicit discovery test | Authorized endpoint-specific auth/discovery evidence; separate deployment/activation permission |
| S5 — contributor toolkit and candidate feasibility | Publish adapter guide/starter/matrix; bounded official-source feasibility tasks in owner shortlist order, then select next adapter | No compatibility promise until conformance and approved real integration pass |
| S6 — further prebuilt adapters / execution | One independently reviewed adapter at a time toward roughly five; later execution contract only under explicit scope | Provider-specific auth and lifecycle tests, unchanged Strata command/evidence authority |

Settings implementer owns proposed `src/explorer/connection-policy.ts`, `connection-store.ts`, `connection-manager.ts`, `agent-adapter.ts`, `agent-connection.ts`, `agent-adapters/cloudflare.ts`, corresponding focused tests, explorer/connections.js and narrow owner-access.ts/host.ts additions. Hosting retains source.ts/read-budget.ts/studio-host.ts until its checkpoint is integrated; coordinate the later minimal launcher managed-mode wiring rather than concurrent edits. B2-H retains profiles/runner/core/workflow and collection-host evidence; use existing capability projection through an injected port, no changes there. B2-H app messaging was unavailable during this review; parent should relay this non-overlap reservation.

Parent integrates project-plan/dashboard entries for S1–S6 with status “design complete / implementation pending”, Cloudflare “first adapter, not connected”, and vendor rows “candidate”. Suggested product docs on implementation: docs/studio/CONNECTION_MANAGEMENT.md, docs/agents/ADAPTER_AUTHORING.md, docs/agents/COMPATIBILITY.md; update STATUS and historical AGENT_ONBOARDING_PLAN without rewriting completed evidence. This external review intentionally makes no competing dashboard/main edits.

## 9. Measurable acceptance and negative tests

1. Zero credential/provider calls on startup, login, status, create, select, renew, remove, rejected policy, wrong Origin/CSRF, unknown field, wrong owner or stale generation. Shared-reader/named-actor tokens cannot become source managers.
2. Duplicate ticket/full binding/directory, modified repository ID/index/model/principal/expiry/caps, unapproved source and v0.3 remote config all fail before dispatch. Replaced policy cannot reset history. Budget counters remain exact across switch/remove/recreate/restart.
3. Fault injection before/after each prepared write, exclusive ledger creation, file fsync, rename, directory fsync and pointer commit never yields two usable ledgers or new allowance. Missing/malformed/leased established state refuses. Tests cover separate processes on actual Linux, not only Windows where directory fsync differs.
4. Concurrent tabs and repeated requests: one committed action, exact replay no dispatch, changed payload conflict, stale revision conflict, no automatic replay on restart. Receipt capacity refuses safely. Uncertain test result retains spending and a inspectable terminal/pending outcome.
5. Disconnect/remove/renew/policy revocation/password change during test: no late cache install/reconnect. Active owner with only source permission revoked cannot read exact cached generation/cursors. Reauth/replay after revocation refuses. Test releases catalog lock while network waits.
6. Immutable file/hash/closure/visibility checks preserved; disconnected test stays disconnected; restart selection retained but not verified. Token save never fetches; token replacement invalidates dependent readers; credential test consumes the SAME ledger.
7. UI 320px/desktop/200% zoom, keyboard-only create/test/renew/remove/cancel, focus restoration, screen-reader statuses, no false green state, 409 reload and interrupted outcome handling. No secret in snapshots/browser storage/URLs/logs. Existing visual tokens/components retained.
8. Adapter conformance: unconfigured/denied auth, wrong destination/redirect, service/instance/project/model/repo mismatch, stale manifest, malformed/oversized/unknown protocol, timeout/cancel, late response, policy/credential revocation. Provider advertisements cannot enable engine operations.
9. Instrumented discovery asserts EXACTLY zero model generation, chat send, task/run creation, tool execution and arbitrary RPC calls, including reconnect/error paths. Cloudflare fixture stays loopback-only; positive hosted discovery handler uses its separately injected auth.
10. API/CLI/UI produce equal action payload semantics, receipts, revisions, audit and refusals. Local CLI does not read protected source files directly or inherit actor authority. Full shared regression and independent immutable boundary review precede publication; published SHA precedes any separately approved deployment.

## 10. Remaining decisions and handoff

No architecture blocker remains for S1–S3 synthetic implementation. Concrete live prerequisites remain: operator approves finite source profiles/tickets and activation; owner identifies the intended existing Cloudflare service/class/instance and supported auth mechanism. S4 cannot honestly claim a real connection before that evidence. zcode product identity and Google product selection are later feasibility questions, not blockers for Cloudflare. No need to ask the owner to choose five vendors or an execution framework now.

High review is sufficient. XHigh is warranted only if a later implementation requires a materially different trust model (remote manager issuance, cross-project/multi-owner catalogs, third-party executable adapters or unattended task authority); none is included here. Stop design here and return to Sol for bounded implementation.
