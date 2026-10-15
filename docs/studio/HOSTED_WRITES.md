# Persistent Studio authoring: actor and authority contract

The architecture phase is complete. See [implemented scope and integration status](STATUS.md) for the subsequent authorized coding milestone; this document preserves the original design and acceptance targets.

Design decision, not implemented behavior. This extends [persistent hosting](ARCHITECTURE.md#8-persistent-customer-hosted-mode) to the intended complete self-hosted Studio workflow. The first read-only deployment is a safe intermediate milestone. Customers must ultimately be able to create, change, review and release supported intent from persistent Studio or CLI, with the same exact references and authority.

## 1. Authenticated named actors, no fixture promotion

Use a real `HostIssuer` behind an `AuthorityIssuer` interface. Refactor `FixtureIssuer` into the test/local implementation of that interface; do not make it accept hosted requests. The shared interface resolves a trusted authenticated session to a security context and implements authorize, live-policy recheck, approval-kind permission, producer permission and mediation binding. Remove fixture-named clock/access-binding methods from shared mediation plumbing. Caller-supplied principal/owner fields never establish identity.

For the first customer-hosted implementation choose named high-entropy access keys, provisioned by an operator on the server, rather than introducing an unconfigured external identity provider. Each account has a stable opaque account ID, immutable principal ID, principal kind (`person` or `agent` as configured), active state and credential epoch. Require random keys of at least 256 bits, store only their hashes in a protected account store, compare in constant time, and never support short passwords under this scheme. Keys are individual credentials, not the H1 shared reader key. Knowing a public fixture selector confers no hosted access.

An HTTPS login validates an account/key and establishes the bounded opaque session from the hosting contract. Store principal/account identity, credential epoch, expiry and auth method server-side. The user cannot select a role with a browser field. A person/agent label is a host assignment, not proof that a human personally reviewed a statement. Automated agents use separately provisioned accounts and the same CLI/service operations; no model bridge is implied.

Default install has zero writer accounts and zero grants. Existing H1 reader-key sessions have no `principal_id` usable by `HostIssuer` and stay read-only. Provisioning a named account is not a grant; assigning an operation is not semantic baseline authority. A missing link yields an exact capability blocker.

## 2. Explicit owner setup and grant store

Build generic console-only administration functions and config templates, without running them against live state. Proposed administration surface: `strata studio admin account add|rotate|disable`, `grant check|install|revoke`, and `config check`. Secrets enter only through a protected file/stdin/interactive no-echo input; never command arguments, stdout logs or URLs. The initial operator must use their own secure credential-delivery mechanism. No browser grant-management endpoint in this slice.

Persist separate account and policy stores outside immutable semantic artifacts, owned by the dedicated service account with restrictive permissions. Policy installation validates an entire bounded config and atomically advances a monotonic generation. Reject invalid/rollback generations. Include a digest of the active policy in request/commit audit. Session/account revocation and policy reload affect queued operations and cached responses; broker dispatch and commit both recheck them.

Grant fields are explicit: grant ID, principal, project/storage binding, allowed operations, Layer assignment/owned-Layer namespace, writable Block IDs, permitted creation-parent IDs, approval kinds, allowed producer/checker/reviewer IDs, expiry and policy generation. No wildcard all-project admin default, self-grant, owner-label escalation, browser-supplied grant or role-switch fallback. `null` versus an empty scope must have documented distinct semantics, consistent with existing local assignment behavior.

Bootstrap is an explicit grant for initializing an empty project from operator-reviewed initial authority. Refactor `Engine.init`'s current `principal === 'bootstrap'` check into a verified initialization capability passed only by the authorized service boundary; retain legacy fixture behavior in its adapter. Do not rename a real account to `bootstrap` to bypass the check. Mediation installation has the same explicit host capability and generation gate. Existing immutable authority is not editable through account administration.

Scope/guardian/Release approval requires both an active operation/kind grant and membership in the pinned baseline authority. A configured account absent from baseline selectors remains unable to approve. Key rotation invalidates sessions but does not rewrite historical records; account/grant revocation blocks pending use of its endorsements according to current-policy checks. Historical Releases remain inspectable, not retroactively rewritten.

## 3. Transport and CLI parity

`hosted-authoring` is a separately configured mode that enables only the intersection of the HostIssuer, backend and per-target capabilities. Reuse Studio's command adapter, shared Node orchestration and domain broker operations. The authenticated gateway must supply a verified internal security context; it must not translate every user into a common `STRATA_SESSION` fixture. Isolate the internal broker on loopback/in-process transport and reject browser Origin and untrusted identity headers there.

Add an explicit hosted CLI connection profile containing the exact HTTPS origin, project/model/storage identity and permitted authentication method. Default `--offline` and local CLI behavior remain unchanged. Proposed CLI: `strata auth login --connection FILE --key-stdin` and operational `--connection FILE --allow-hosted`. `--offline` with a hosted connection fails before access. No automatic remote fallback, redirects, credential discovery, certificate verification bypass or cloud account activation. The connection is an operator-selected self-hosted service, not arbitrary provider access.

Browser sessions use cookies/CSRF; CLI sessions use separately issued short-lived bearer tokens through the same authenticator/issuer. A CLI session cannot be obtained by adding a client-controlled principal header. Token storage is explicit protected local configuration or memory, never repository files or default stdout. Logout/revocation/expiry apply equally. Copy CLI action produces exact args plus JSON input without cookies, tokens or credentials.

All domain requests share input normalization, stale checks, policy recheck, idempotency and correlated audit. Principal IDs in semantic owner/authority records are stable across browser/CLI sessions. Configuration generations and credentials are operational state and never silently change a Layer's owner or baseline. Same-principal cross-client retries use the same request key; different principals cannot inspect/reuse each other's receipts.

## 4. Versioned authenticated review and evidence

Actual code hardcodes fixture trust in approval, Resolution, authoring review and Release records; `evidenceSchema` accepts a fixture executor literal and review checks accept `fixture-reviewer`. Authenticating a browser does not repair those semantics. Do not replace those labels in old records or call fixture attestations production evidence.

Use the already proposed fresh opt-in v0.3 model as the complete hosted-authority contract boundary, with independent capability `hosted-authority/1`. The Block-creation capability is separately granted; choosing authenticated authority does not grant Block creation. No in-place migration of existing v0.1/v0.2 projects. Old records remain byte-identical and historical. H2 can expose ordinary legacy Layer authoring and composition under a real identity, but trust-bearing publication/review/evidence/approval operations remain capability-blocked until their explicit model/receipt support exists; do not stop delivery at H2.

Define strict new v0.3 records rather than widening old fixture forms:

| Record | Binding and trust |
| --- | --- |
| `authoring-review/2` | Existing exact project/model/draft ref+digest/checklist/accepted/rationale fields plus server-authenticated reviewer and auth receipt ref. No forged reviewer string. |
| `approval/3` | v0.2 target/baseline/authority/evidence/scope/kind/generation/expiry/selection binding semantics plus authenticated principal and auth receipt. Scope, guardian, Release and resolution remain distinct. |
| `mediation-receipt/2` | Exact basis/packet/partition/case, server actor, policy generation and authenticated response origin; no `human-fixture` or policy-fixture impersonation. Reuse finite selection semantics. |
| `criterion-review/1` | Explicit review attestation bound to candidate, realization/profile/output digest and criterion identity; authenticated authorized reviewer and rationale. It is an attestation, not proof of execution. |
| `strata-host-evidence/1` | Candidate/profile/output plus checker/fixture/oracle digests, result identities and actual producer. Mechanical outcomes reference a retained supported host-run receipt; review outcomes reference exact criterion reviews. |
| Auth / run receipts | Content-addressed immutable records, atomically retained with dependent records; auth receipt binds actor, project, action/input digest, policy/grant generation and authenticated request ID, without credential/session token. Run receipt binds exact finite runner/checker/oracle, input/output digests and observed result. |

Version the stored Resolution/validation/Release forms to bind this closure and label trust `host-authenticated` / `host-measured` as appropriate. Those labels mean the named host authenticated the submitter or measured the run, not independent verification or administrator-resistant attestation. Explicit new record schemas, normalization, reference hashes, reader projections and backup closure are prerequisites to enabling this capability. Legacy engines/clients must fail unsupported, never down-convert.

The first hosted evidence producer is an explicitly configured finite Node runner adapter calling the existing supported runner/profile mechanism with independent expectations. It runs only allowlisted checker implementations against host-controlled output slots, with bounded time/output and explicit execution grant. No uploaded command, shell string, arbitrary project test execution, model call or inferred checker. Unconfigured runner/profile makes mechanical evidence unavailable. Existing externally imported fixture evidence can be inspected but does not satisfy the new hosted gate by relabeling it. More general imported execution attestation is a later separately specified capability.

The engine remains responsible for complete criterion coverage, exact candidate/evidence binding, current authority, guardian rules and immutable Release flattening. Host receipts add authenticated provenance; they do not waive semantic or evidence gates. Extract current gate logic into version-aware shared predicates and dispatch on the explicit model/record format, not on string replacement of `fixture`.

## 5. Bounded build milestones versus live activation

| Milestone | Code that can be implemented/tested now | Separate operator action required for live use |
| --- | --- | --- |
| H1 persistent reader | Host/proxy/session/read config and secure unconfigured shell | Review proxy/TLS exposure; provision reader credential and existing bounded source read configuration |
| H2 authenticated actors | AuthorityIssuer/HostIssuer, named-account store/admin CLI, protected hosted CLI transport, grants/revocation/audit, saved draft/compose path | Provision actual named accounts and explicit minimal grants; select exact local storage/project; keep unsupported trust operations disabled |
| H3 full hosted workflow | Explicit v0.3 authenticated records, finite measured runner, source/content review, selection, validation and separate approvals/Release; browser/CLI parity tests | Authorize fresh project initialization with real baseline authority; configure allowed runner/output scopes and named reviewer/selector/release grants; explicitly enable hosted-authority/1 |

H2/H3 are required implementation milestones for the persistent end goal, not permission to alter the user's existing authority or credentials. Implement with synthetic named accounts in isolated tests, no live credential generation or provisioning. Customer installation templates must expose each missing setup gate clearly. No actual container details or account payloads belong in product Git.

Required hosted acceptance beyond H1: unauthorized account cannot write; reader key cannot acquire a writer role; body/header actor spoofing fails; disabled/expired/rotated accounts lose sessions; revoked scope/grant rejects queued and cached mutations; browser/CLI same-actor results and different-actor isolation match; startup fails closed on corrupt/rollback policy; bootstrap and mediation setup require capability, not a magic principal name; old fixture evidence/approvals cannot satisfy v0.3; tampered/missing run/auth/review closure blocks Release; distinct authenticated scope and Release approval complete the measured fixture flow; restart preserves semantic records and invalidates or safely restores bounded sessions; no secrets in responses, redirects, command previews, audit or logs.
