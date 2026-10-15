# SDK measured-execution contract proposal

Status: **proposal draft, unexecuted, for parent review.** Base `fad38e6a5ca1446874b573564d33d18b637f442e`, branch `pilot/zcode-sdk1-contract-20261011`. This file defines a candidate contract for the existing Later item SDK1 ("SDK measured execution"), whose recorded next action is to settle the SDK runner/evidence/authority contract before any implementation or qualification. Nothing here is implemented, measured, independently reviewed, qualified or production-ready, and SDK1 remains open. All `path:line` references are observations of the base commit; later commits may move them.

## 1. Actual SDK entry points and current execution/evidence limits

"SDK" here means the Cloudflare Agents SDK runtime path in `src/worker.ts` (local workerd dev, Durable Object agents), as exercised by `tests/mediation-sdk.test.ts` and `tests/onboarding-sdk.test.ts`. This section restates only what exists at `fad38e6`.

### 1.1 Entry points

| Entry point | Behavior at fad38e6 |
| --- | --- |
| HTTP `POST /v1/operation` | Only operation route; requires `LOCAL_FIXTURES=true` and a loopback host, refuses browser origins, 404/403 otherwise (`src/worker.ts:188-190`). |
| HTTP `GET /health` | Loopback liveness projection only (`src/worker.ts:189`). |
| Session header `x-strata-session` | Resolved by the code-only `FixtureIssuer`; known local fixture handles are public and impersonable by any local process, not hosted authentication (`src/worker.ts:193`, `src/security.ts:38-50`; [IMPLEMENTED_CONTRACT.md](../IMPLEMENTED_CONTRACT.md) "CLI and identity"). |
| Envelope guards | One JSON object, 1 MiB / 32 nesting / 20,000 node limits, 64-operation ingress guard (`src/worker.ts:194-202`, `src/security.ts`; [IMPLEMENTED_CONTRACT.md](../IMPLEMENTED_CONTRACT.md) "CLI and identity"). |
| `ProjectAgent` / `LayerAgent.operation` | Serialized (`blockConcurrencyWhile`) mutations with audit ledger, idempotency keys and post-stage re-authorization (`src/worker.ts:63-152`, `src/worker.ts:156-183`). |
| Engine construction | Both agents build `new Engine(..., { checkerBackend: 'none' })` — the SDK engine has no measured checker backend (`src/worker.ts:131`, `src/worker.ts:169`). |
| Command dispatch | `executeAuthorized` / `execute` in `src/service.ts:10-76`; `evidence.run` reaches the base dispatcher only as a stub returning `{ execution_ready: false }` (`src/service.ts:30`). |

### 1.2 What the SDK cannot do today

- **No measured execution.** No SDK fixture grant includes `evidence.run`; the fixture runner's grant is read plus `validate` (`src/security.ts:47`), and `FixtureIssuer.authorize` fails `UNSUPPORTED_CAPABILITY` for it (`src/security.ts:111`). The `commands/contract.ts:7` input shape `{ target, slot, profile }` exists, but the routing that satisfies it is Node-host-only (`src/local-broker.ts:109`).
- **No checker-bound profiles.** `Engine.realize` and `checkValidation` refuse checker-bound profiles and `strata-realization/2` records with `UNSUPPORTED_CHECKER_BACKEND` when `checkerBackend === 'none'` (`src/core.ts:308`, `src/core.ts:329`). Compiled support metadata repeats "SDK checker execution is unsupported" (`src/profile-capabilities.ts:61`), and [PROFILE_SEPARATION.md](../PROFILE_SEPARATION.md) "Remaining limits" records SDK checker-bound execution as unavailable.
- **Evidence is imported, not produced.** SDK `validate` parses supplied evidence and requires exact candidate/profile/output-tree binding plus one passing result per active criterion, with review results carrying the `fixture-reviewer` label (`src/core.ts:330-342`). In local-fixture trust the importer must be the assigned `fixture-runner` principal with its configured executor label `strata-local-fixture-runner/1` (`src/security.ts:137-139`). Imported results are an explicit local trust boundary, not proof any caller ran tests ([IMPLEMENTED_CONTRACT.md](../IMPLEMENTED_CONTRACT.md) "Realization, evidence, and publication"). `validate` responses label the producer attestation `fixture-import-only` outside host-authenticated trust (`src/service.ts:21`).
- **Runtime backend is absent on this SDK path.** The implemented Node lane uses `node:worker_threads` with V8 heap limits and a wall-clock timer, filesystem slot verification (`safePath`/`verifyOutput`, `src/commands/node.ts:7-31`), and imports verified application entrypoint bytes as a `data:` URL inside the worker (`src/auth/runner.ts:14-17`, `src/auth/runner-worker.ts:8`). This SDK path wires none of those mechanisms. The Node worker is not proof of a security sandbox, no-egress enforcement or a hard total-memory limit; the stronger isolation requirements below are proposed obligations.

### 1.3 Tests actually run versus imported observations

- `tests/mediation-sdk.test.ts` starts a loopback wrangler dev runtime and drives the full v0.2 human path (blocked compose, mediation prepare/respond, Resolution, approvals, Release, stale-packet refusal). Its measurement step calls `runFixtureEvidence` **in the Node test process** (`tests/mediation-sdk.test.ts:34`), then the SDK broker only imports that evidence via `validate` as `fixture-runner` (`tests/mediation-sdk.test.ts:34`). The SDK runtime executes no application check. This matches [IMPLEMENTED_CONTRACT.md](../IMPLEMENTED_CONTRACT.md) "Versioned mediation": "SDK tests cover asset-free human mediation and measured legacy profile 2" — the legacy `booking-node/2` evidence is produced outside the SDK and imported.
- `tests/onboarding-sdk.test.ts` verifies the fixed CLI packet from a deep checkout against a separate retained workerd runtime: exit 0, 34 CLI calls, zero model and cloud calls, loopback-only, clean shutdown, retained runtime state (`tests/onboarding-sdk.test.ts:38-56`), plus a bootstrap-refusal close-out path (`tests/onboarding-sdk.test.ts:58-69`). It is CLI/tool-contract verification, not application measurement.
- For contrast, the **Node host** measured lane that does exist: `evidence.run` is authorized first, then requires a configured runner (`RUNNER_NOT_CONFIGURED`, exit 8) and calls the operator-configured `hostRunner(root, slots, profiles)` (`src/local-broker.ts:109`), which verifies slot/output bytes, re-derives the exact realization, executes the pinned entrypoint in a bounded worker thread (5 s timeout, 64 MiB old / 16 MiB young generation heap caps), re-verifies all bytes after measurement, retains only mechanical results, and stores a `strata-host-run/1` receipt with `review_pending: true` (`src/auth/runner.ts:10-22`). Host profiles are `counter-host/1` and `collection-host/1` on model `strata/0.3-block-lifecycle-experimental` (`src/profile-capabilities.ts:27-48`, `src/profiles/counter-host.ts:8`, `src/profiles/collection-host.ts:30`).

### 1.4 Relationship to current persistent connections and the adapter roadmap

Integration observation at `9a94e0c` (after the reserved base; these are separate current features): [persistent namespace workflow](../studio/NAMESPACE_WORKFLOW.md) retains owner consent, exact per-repository writer state and discover/create/read/draft permissions. It initializes authenticated v0.3 projects but does not grant independent review, validation, Release or application checks. [Persistent agent connections](../agents/PERSISTENT_CONNECTIONS.md) retain exact service/repository consent and enabled intent; runtime health and finite service sessions remain separate. Repository switching invalidates readiness and requires the separately bound consent store; consent must not be retargeted. Neither feature supplies SDK measured execution.

The [vendor-neutral adapter roadmap](../studio/SETTINGS_ARCHITECTURE.md#7-vendor-agnostic-roadmap-and-candidate-compatibility-matrix) and [compatibility matrix](../agents/COMPATIBILITY.md) currently cover versioned, authenticated, bounded **discovery**. `AgentDiscoveryAdapterV1` is distinct from compiled realization `ProfileAdapter` and from a future measurement runtime port. Remote advertised features do not establish Strata engine authority; effective execution remains false. Codex/Claude/Cursor/ZCode/Grok/Google task, inference, tool and chat integrations remain proposed/deferred rather than delivered by discovery consent or this lane. The ZCode process that authored this document is external preparation evidence, not a registered Strata runtime adapter or SDK application measurement.

Any later composition with persistent connections must preserve exact project/model/immutable repository and service identity, recheck source consent/selection/session/credential generations at dispatch and completion, and abort/refuse stale work on switch, pause or revoke. This is a follow-on integration obligation, not an expansion of namespace grants, discovery features or SDK1 scope. The finite lane remains explicit compiled measurement with zero model calls.

## 2. Proposed minimal finite SDK measurement lane

**Proposal, unexecuted.** One lane, no others. It reuses the existing binding vocabulary instead of inventing parallel semantics; every element marked *[decision]* is unsettled and listed in section 5.

- **Supported model (exactly one):** `strata/0.3-block-lifecycle-experimental` (`src/model.ts:6`). Host-measured records, receipt schemas and criterion-review machinery exist only for this model (`src/auth/records.ts:4-15`, `src/core.ts:344-360`). Requests naming any other model version refuse with an unsupported-capability error (exit 8), mirroring `UNSUPPORTED_HOSTED_AUTHORITY` (`src/auth/host-issuer.ts:70`).
- **Supported profile (exactly one):** `counter-host/1` — the smallest compiled checker-bound profile: one root Block, positive safe-integer additions, ceiling 2–1000, check families `counter.add`, `counter.limit`, `counter.invalid`, `intent.review` (`src/profile-capabilities.ts:23-26`). *[decision]* The parent may substitute `collection-host/1`; the lane must still admit exactly one profile.
- **Trusted runtime/checker identity:** the compiled `ProfileAdapter.checker` supplies the entrypoint name and checker implementation; the realization pins `checker_sha256`, `fixture_sha256`, and `oracle_sha256` (`src/profile-types.ts:8-32`, `src/auth/runner-worker.ts:4-12`). The runtime executes the exact profile-produced application entrypoint bytes with that compiled checker, never caller-selected code, paths or module specifiers. *[decision]* How to bind the runtime identity to retained evidence. The current `hostRunSchema` has no executor field (`src/auth/records.ts:11`); a provisional name such as `strata-sdk-measured-runner/1` is descriptive only. Persisting it would require an explicitly versioned schema and consumer change, not verbatim schema reuse.
- **Runtime isolation requirement (vendor-neutral):** any candidate runtime must (a) execute the verified flat-text ESM application entrypoint and compiled checker in a context that cannot read broker storage, sessions, secrets or network; (b) enforce the section 4 resource bounds; (c) be terminated and discarded after one measurement; (d) use an immutable snapshot of the verified retained realization bytes obtained **before** execution, then re-read and re-verify the retained bytes/bindings **after** execution and before receipt retention. The current SDK path (local workerd) is the reference candidate; no isolation primitive on it is implemented or selected here. *[decision]*
- **Exact bindings:** every receipt binds `candidate` (composition fingerprint), `realization` ref, `profile` archive digest, `output_tree`, and the checker/fixture/oracle SHA-256 triple — the same field set as `hostRunSchema` and the `checkHostValidation` equality checks (`src/auth/records.ts:9-11`, `src/core.ts:355`).
- **Invocation:** `evidence.run` with the existing strict `{ target, slot, profile }` shape (`src/commands/contract.ts:7`). Slots and the profile allowlist are operator-owned server configuration, never caller-resolved paths (`src/auth/runner.ts:9`). On the SDK the "slot" denotes an operator-configured retained realization location, not a caller filesystem path.
- **Result receipt:** one stored run record per completed invocation containing the binding set, producer principal, mechanical-only results (each check/version/fixture/passed), an observations digest, the authenticated `evidence.run` receipt, and `host-measured` trust only when the existing authenticated closure is satisfied (`src/auth/records.ts:4-11`, `src/core.ts:82-83,351-359`). The Node producer is the authenticated invoking principal; the trusted runtime supplies the observations (`src/auth/runner.ts:19-21`). `review_pending: true` is response metadata, not a stored `hostRunSchema` field. Completed negative checks may be retained with `checks_passed: false`; execution failure/timeout must not create a completed receipt. *[decision]* Reuse `strata-host-run/1` and its exact `host-run@` ref/store semantics, or version SDK records plus their assembly/validation consumers. Fixture imports cannot acquire measured trust by relabeling.
- **Assembly and review:** mechanical results alone never satisfy review criteria; review requires separate authenticated criterion attestations bound to the same realization triple, assembled via the `evidence.assemble` workflow shape (`src/workflow.ts:84-90`, `src/core.ts:358`).
- **Cleanup:** retain the run receipt and required authentication/audit closure against the already retained realization; discard the executed module, in-memory state and any scratch location after completion or failure. No application output files are written by measurement itself. Verify cleanup before accepting a completed receipt.
- **Explicitly not proposed:** automatic profile inference, arbitrary-app or arbitrary-prose support, executable behavior loaded from semantic records (`src/profiles.ts:10`), new Blocks, or any second lane.

## 3. Current authority checks and responsibility boundaries

- **Current SDK authority is fixture-label authority.** `FixtureIssuer` resolves public impersonable handles; hosted construction fails closed with no JWT/OIDC verifier, membership, durable revocation or authenticated evidence attestation ([IMPLEMENTED_CONTRACT.md](../IMPLEMENTED_CONTRACT.md) "CLI and identity"). Baseline authority for approvals comes from semantic records: scope selectors, guardians and release managers (`src/core.ts:302-303`).
- **Caller versus trusted producer.** A preparer may materialize/register the exact realization within its grants. An authenticated principal separately granted `evidence.run` invokes the configured runner; the Node receipt binds that invoker as `producer` and the runtime supplies the observations. Callers cannot substitute supplied results for this measurement. Existing fixture `validate` imports remain a separate label-based path (`src/security.ts:137-139`). Copying runner/reviewer labels grants no authenticated authority. Profile grants are checked separately (`PROFILE_FORBIDDEN`, `src/auth/host-issuer.ts:70`). Assembly is a workflow read for authorized readers (`src/service.ts:13`, `src/workflow.ts:84-90`); its authority derives from the exact retained run and review attestations, not an assigned producer-only assembly role.
- **Fresh evidence.** Validation and Release rebind the exact candidate fingerprint, realization, profile and output tree; changed candidates, edited outputs or stale realizations refuse with the `STALE_EVIDENCE` / `STALE_REALIZATION` / `OUTPUT_TAMPERED` family (`src/core.ts:321`, `src/core.ts:331-332`, `src/core.ts:354-355`, `src/core.ts:371-373`; `src/auth/runner.ts:13`). Changed considered inputs or policy require inspection and fresh case records ([agent/strata/SKILL.md](../../agent/strata/SKILL.md) "Exact v0.2 mediation workflow").
- **Separate review/approval boundaries.** A measured run returns `review_pending: true` (`src/auth/runner.ts:21`); validation returns `approvals_pending: true` (`src/core.ts:364`); scope/guardian/release endorsements are separate records rechecked at Release, and revoked producer or reviewer grants fail `ENDORSEMENT_REVOKED` / `ACCESS_REVOKED` (`src/core.ts:353`, `src/core.ts:358`; `src/auth/host-issuer.ts:50`, `src/auth/host-issuer.ts:61`, `src/auth/host-issuer.ts:70`). Local review results remain attestations, not independent or human approval.
- **Secrets.** The host issuer retains credential digests/epochs; audits retain operation/policy/principal/ref metadata (`src/auth/host-issuer.ts:42`, `src/auth/records.ts:4`, `src/security.ts:155`). The lane must not copy credentials or session handles into stored receipts, observations or audits; transport authentication remains server-resolved. *[decision]* Select an SDK-compatible authenticated authority port supplying the existing action receipts, live grant/profile checks and retained revocation/epoch checks. Public fixture handles cannot satisfy that closure (`src/service.ts:15`, `src/core.ts:82-83,353-358`). A fixture-only isolation spike must remain synthetic and ineligible for authenticated validation/Release.

## 4. Bounded runtime requirements and negative acceptance cases

**Proposed runtime bounds (unexecuted).** Mirroring the implemented Node lane (`src/auth/runner.ts:14-18`): one wall-clock timeout (proposed 5,000 ms) that terminates and discards the execution context; bounded memory (Node lane uses 64 MiB old / 16 MiB young generation); single-use execution context terminated after the first result; full re-verification of the realization binding after measurement and before receipt retention; no network egress; no ambient broker state; cleanup asserted even on timeout or error paths. Cancellation maps to the same terminate-and-fail path; no cancellation exit code exists yet (exit 130 remains deferred, [IMPLEMENTED_CONTRACT.md](../IMPLEMENTED_CONTRACT.md) "CLI and identity").

**Negative acceptance cases — each is a proposed, unexecuted test obligation, not a passed test.** Each case must drive the real execution/binding path and observe the recorded refusal, not merely assert schema rejection of a malformed payload:

| # | Case | Expected refusal (proposed mapping to existing codes) |
| --- | --- | --- |
| N1 | No runtime configured / runtime unavailable at dispatch | `RUNNER_NOT_CONFIGURED`, exit 8 (`src/local-broker.ts:109`); never a silent `execution_ready: false` success. |
| N2 | Target resolves to a wrong or unsupported model version (the strict input has no model field) | Unsupported capability, exit 8; resolve and inspect the actual target before dispatch. Precedent `UNSUPPORTED_HOSTED_AUTHORITY` (`src/auth/host-issuer.ts:70`). |
| N3 | Wrong profile: not the one lane profile, or not in the session grant | `UNSUPPORTED_PROFILE` / `PROFILE_SCENARIO_MISMATCH`, exit 8 (`src/core.ts:310`, `src/core.ts:314`); `PROFILE_FORBIDDEN`, exit 4 (`src/auth/host-issuer.ts:70`). |
| N4 | Receipt checker/fixture/oracle triple disagrees with the realization | For reused v0.3 host evidence, `STALE_EVIDENCE`, exit 6 (`src/core.ts:355`). `STALE_CHECKER_EVIDENCE` is the separate legacy bound-evidence precedent (`src/core.ts:332`); do not promise it for the host schema. |
| N5 | Execution aborts, a completed check fails, or required results are absent/unknown | Execution failure: `RUNNER_FAILED`, exit 6 (`src/auth/runner.ts:15-16`). Completed negative checks: retained run with `checks_passed: false`; assembly/validation refuses `VALIDATION_INCOMPLETE`, exit 6 (`src/core.ts:357-358`). Absent/unknown results cannot satisfy exact criterion coverage. |
| N6 | Stale or tampered candidate: target re-derived fingerprint differs, or edited/unmanifested output bytes | `STALE_REALIZATION` / `OUTPUT_TAMPERED`, exit 6 (`src/auth/runner.ts:13`, `src/commands/node.ts:30`, `src/core.ts:321`, `src/core.ts:373`). |
| N7 | Stale or tampered evidence at assembly/validation: run ref recompute mismatch or binding-field disagreement | `STALE_EVIDENCE`, exit 6 (`src/core.ts:354-355`). |
| N8 | Revoked authority: producer/reviewer grant inactive or credential epoch rotated before validation/Release | `ENDORSEMENT_REVOKED` / `ACCESS_REVOKED`, exit 6/4 (`src/core.ts:353`, `src/core.ts:358`, `src/auth/host-issuer.ts:61`). |
| N9 | Timeout or resource-limit breach during measurement | Terminate, `RUNNER_FAILED`, exit 6; no partial receipt retained (`src/auth/runner.ts:15`). |
| N10 | Incomplete cleanup: binding re-verification fails after measurement, or scratch/execution state survives failure | Refuse before receipt retention, exit 6 (`src/auth/runner.ts:17-18`); post-condition checked by the test, not trusted. |
| N11 | Caller attempts to substitute supplied results for a trusted measured run | Refuse without an authenticated `evidence.run` action closure and exact retained run (`src/core.ts:82-83,353-355`): `AUTHENTICATION_REQUIRED`, exit 4, or `STALE_EVIDENCE`, exit 6; unauthorized dispatch fails `OPERATION_FORBIDDEN`, exit 4. Fixture imports remain import-only; `EVIDENCE_PRODUCER_FORBIDDEN` is their separate importer/label check (`src/security.ts:137-139`). |
| N12 | Review criterion satisfied only by a mechanical result, or attestation bound to another realization | `VALIDATION_INCOMPLETE` / `STALE_EVIDENCE`, exit 6 (`src/core.ts:358`). |

## 5. Parent decisions, reusable contracts, dependencies, integration prerequisites

**Decisions the parent must settle (all open; nothing below is chosen):**

1. Isolation mechanism satisfying section 2's vendor-neutral requirement on the SDK runtime, given no `node:worker_threads`/`node:fs` primitives exist there.
2. Receipt/ref identity: reuse `strata-host-run/1`, `host-run@` storage and the authenticated consumers verbatim, or specify versioned SDK schemas and assembly/validation changes. Do not promise unchanged consumers with a distinct format marker.
3. Runtime identity: keep it in trusted configuration with no schema change, or explicitly version its receipt binding. Current host receipts contain producer/authentication fields, no executor field.
4. The single lane profile: `counter-host/1` (proposed) or `collection-host/1`.
5. SDK-compatible authenticated authority integration for the proposed v0.3 lane. Reuse of host receipts/validation requires its exact authenticated action, grant/profile and retained revocation closure; fixture handles cannot replace it. A synthetic isolation spike may precede this dependency but cannot close SDK1 or validate/Release. No issuer, credentials or live grants are selected or changed by this proposal.
6. Where exact authenticated criterion review and assembly live, and how their records/authenticated closure reach the validating engine. If review remains Node-host-only, explicitly specify that transfer/trust boundary or keep the SDK slice measurement-only and ineligible for validation/Release.
7. Sequencing relative to the parent's P0-07/R8 and other roadmap gates; this proposal changes no gate, scope or dependency of SDK1 or any other item.

**Reusable current contracts (candidate reuse, no implementation changes in this document):** strict `evidence.run` input (`src/commands/contract.ts:7`); binding vocabulary and host run/evidence/validation schemas (`src/auth/records.ts:9-14`); exact equality/uniqueness/authentication checks (`src/core.ts:351-359`); compiled profile dispatch (`src/profiles.ts:10-18`, `src/profile-types.ts:21-32`); `evidence.assemble` (`src/workflow.ts:84-90`); approval/Release and revocation gates (`src/core.ts:298-305,353-358`). Verbatim reuse requires the current format, ref/store and authenticated closure. A new SDK format/runtime field requires explicit consumer changes; refusal-code precedents are not automatic mappings for every path.

**Technical dependencies:** isolated single-use runtime with verified timeout/memory bounds; retained-realization location abstraction replacing filesystem slots; authenticated SDK authority port and exact retained action/revocation closure; audit/ingress bounds (`src/worker.ts:63-67,194-202`). Request ingress limits do not bound generated observations or receipts: bound results/count/string fields using `hostRunSchema` (at most 100 results), and select explicit observation-byte and retained-storage limits before implementation. *[decision]*

**Final integration prerequisites (before SDK1 could close, separately approved):** implementation slice with tests covering N1–N12 against the real runtime; independent parent review of implementation and qualification distinct from this proposal; fresh measured evidence produced by the lane itself; all existing SDK1 scope/dependencies and roadmap gates unchanged; no claim of measured SDK execution until then.

## 6. Synthetic examples, follow-on plan, exit gates

### 6.1 Synthetic example shapes

**Synthetic proposal example — not a real request, not an implemented endpoint, values are illustrative only:**

```json
{
  "command": "evidence.run",
  "input": {
    "target": "composition@<exact-registered-ref>",
    "slot": "<operator-configured-slot-name>",
    "profile": "counter-host/1"
  }
}
```

**Synthetic proposal example — not a real receipt, not a stored record:**

```json
{
  "format": "strata-host-run/1",
  "project_id": "<configured-project>",
  "model_version": "strata/0.3-block-lifecycle-experimental",
  "candidate": "<64-hex composition fingerprint>",
  "realization": "realization@<exact-ref>",
  "profile": "<64-hex profile archive digest>",
  "profile_id": "counter-host/1",
  "output_tree": "<64-hex output tree digest>",
  "checker_sha256": "<64-hex>",
  "fixture_sha256": "<64-hex>",
  "oracle_sha256": "<64-hex>",
  "producer": "<measuring principal>",
  "results": [
    { "check": "counter.add", "version": "1", "fixture": "<fixture id>", "passed": true }
  ],
  "observations_sha256": "<64-hex digest of observations, contents never retained in line>",
  "auth_receipt": "auth-receipt@<exact-ref>",
  "trust": "host-measured"
}
```

No secrets, tokens or credential material ever appear in either shape; observation contents are referenced only by digest.

### 6.2 Bounded follow-on implementation plan (proposal; no executable runtime adapter in this slice)

1. Parent settles section 5 decisions; this proposal is revised or accepted as the contract of record.
2. Isolation spike on the chosen runtime: pinned-bytes execution, hard timeout/memory bounds, single-use context, post-measurement binding re-verification — demonstrated out-of-tree before any broker integration.
3. Lane implementation behind the existing `evidence.run` shape and refusal codes; server-side slot/profile allowlist; receipt storage; audit events without secret material.
4. Negative-case suite N1–N12 plus one positive lane run on the real runtime; existing mediation/onboarding SDK suites unchanged and still passing.
5. Separate qualification and independent parent review; only then consider SDK1 exit criteria.

### 6.3 Measurable exit gates (proposed)

- Exactly one model/profile pair admitted; every other combination refused with recorded codes.
- Every distinct active mechanical check/version/fixture has exactly one passing lane-produced result bound to the exact candidate/realization/profile/output-tree/checker triple. Reused assembly/validation/Release also require exact authenticated review attestations for every distinct review criterion and the retained action/revocation closure; a measurement-only spike cannot satisfy those gates.
- N1–N12 exercised through the real dispatcher, authority, binding and retention paths; deliberately fault execution where relevant. Predispatch refusals such as no runtime, wrong model or missing grant must prove zero execution. Record each observed refusal/negative-check outcome and exit code.
- Timeout and cleanup post-conditions verified by the suite on both success and forced-failure paths.
- Zero model calls, zero network egress, zero secret material in records, receipts, observations digests or audits.
- Existing SDK tests (`tests/mediation-sdk.test.ts`, `tests/onboarding-sdk.test.ts`) unchanged and passing.
