# Component and data contracts

Planning only. Existing fields below were checked at `61b5ceb47da9aacf12737106217509b61e5a0741`. Proposed presentation fields are not implemented schemas or backend guarantees.

## 1. Three evidence channels already exist

### Browser state

`createDemoDashboard` in `src/integrated-demo-dashboard.ts` serves capability-protected `GET /state`:

`{ run_id, finished, last_event_at, events, packet, review_html, lab? }`.

- `events` contains at most 160 in-memory host observations. `emit` adds `observed_at`; it removes `outcome` and `packet` from each summary, and reduces cleanup data to cleanup/counters.
- `packet` is the current actionable `OperatorPromptPacket`; `review_html` is the existing canonical selection comparison. They disappear when the local controller settles the response.
- `finished` is a controller lifecycle flag. It is **not** proof of success, a validated Release, or cleanup. The lab also calls `finish()` while preparing readiness.
- `last_event_at` is last emitted host-observation time, not last successful browser poll, provider heartbeat, or application progress percentage.
- `lab` exposes `status`, `message`, `checks[{label,passed,at}]`, `busy`, `running`, `evidence`, `reminder_repair_enabled`, `can_begin`, `can_fresh`, and `review` with exact target/limits/infrastructure/source/review hashes. There is no machine-readable readiness expiry timestamp in current state; `can_begin` handles the five-minute TTL server-side.

Current source protection is part of the contract: loopback binding, capability fragment/sessionStorage then Authorization header, exact Host/Origin, JSON content type, body limit, no filesystem serving, no-store, strict CSP, and a sandboxed comparison iframe. Styling changes must preserve these checks. CSP also means remote fonts, CDNs, injected script, inline script-based SVG, and unreviewed icon loaders are poor fits.

### Host observations, persisted viewer log, and actor evidence

`runAttendedDemo` in `src/integrated-demo-operator.ts` emits:

| Type | Relevant emitted fields | Truthful UI use |
| --- | --- | --- |
| `provisioning-started` | message | Start acknowledged; no inference launch implied |
| `actor-launching` | actor, assigned_revision, model, reasoning_effort | Host launch observed; pair identity `(run_id, actor, assigned_revision)` in this finite demo |
| `actor-finished` | actor, assigned_revision, model, reasoning_effort, prompt_sha256, turn_starts, tool_calls, execution | Successful invocation finished; publish status remains separate |
| `workflow-event` | sequence, kind, source, phase, checkpoint_digest, outcome | Semantic advancement/refusal; outcome exists here but is currently removed from browser summary |
| `operator-pause` | packet | Current review becomes available; persisted log includes packet; summary strips it |
| `release-verified` | released, inherited, evidence, inherited_observations_equal | Validated result plus completed inherited measurement; available in browser events |
| `cleanup-started`, `cleanup-waiting` | message; observed_status where supplied | Cleanup in progress or waiting for terminal accounting |
| `startup-reconciliation-required` | reconciliation context | Unknown exact resource effects; operator attention |
| `cleanup-blocked` | code, message, diagnostic where supplied | Cleanup unverified; safe details only |
| `cleanup-verified` | cleanup result including cleanup booleans/counters | Verified resource/accounting outcomes; retained resources are intentional |
| `run-failed` | safe code, message, startup_failed, optional diagnostic | Failure axis; may arrive after cleanup, so “last event wins” is wrong |

`scripts/integrated-demo-operator.ts` writes `canonical(record)` to `viewer-events.jsonl` **before** the dashboard adds `observed_at`. The inspected successful log has **no timestamp on these records**. It retains semantic outcomes that the browser summaries omit. Do not conflate persisted log shape with browser state shape.

`DemoActorTurnEvidence` includes actor/revision/thread/model/effort, prompt and its digest, CLI stream/stderr, turn count, `tool_calls[{actor,command,input,result,at}]`, exit code, and `label` (`real-codex-subscription-cli` or `mock-codex-process`). Tool timestamps do not define the complete invocation start/end interval. Raw prompts, streams and stderr are not safe UI feeds. `DemoHost.intervals` has model/synthetic turn windows in memory; it is not part of the current saved viewer log or `/state` contract. Do not claim these intervals are already replayable.

The latest completion audit/report supports the historical overlap claim and total runtime. The already-open dashboard also has host observation timestamps. Neither should be reconstructed from synthetic fixture intervals or event sequence spacing. A legacy recorded replay can use **ordinal events** and label the reported overlap, without a duration-scale graphic.

### Durable application state

`DemoEvent` is `strata-integrated-demo-event/1` with `run_id, project_id, sequence, request_id, previous_digest, phase, kind, source, input, input_digest`. `phase` in this event is the **before** phase.

`DemoCheckpoint` is `strata-integrated-demo-checkpoint/1` with `mode, started_at, expires_at, phase, sequence, registry, heads, previous_digest, management_cleanup, counters, refs, pending, receipts, requests, trace`. Its `phase` is the accepted current phase. `trace` has `{sequence,kind,source,outcome,phase}`; it lacks command-specific details and timestamps. `requests` retains exact outcomes; `registry` contains locations, not a safe browser record graph. A locator is not record bytes and is not permission to fetch a deleted repository.

Actual phase union: `new | authors | selection | repair | runner | endorsement | complete | aborted | failed`. Kind union: `bootstrap | actor | prepare | selection | realize | evidence | endorse | stop`. Sources: host, operator, runner, actor:a/b/c. Keep these separate from presentation chapter names and provider Workflow status.

`refs` may include composition, basis, packet, candidate, realization, validation, released, inherited, reminder, case_revision, chosen. `pending` identifies selection/endorsement with digest/expiry. `receipts` bind an explicit action and response to the exact packet; capture method and attribution distinguish real local browser input from synthetic rehearsal. Self-declared identity is not hosted authentication.

Decode provider output through `authoritativeDemoWorkflowOutput` in `src/integrated-demo-workflow-description.ts`. It validates known step names, completed output, identity, sequence and prior-checkpoint chain, accepts a known pending next step, and refuses ambiguous/incomplete output. Do not substitute “latest-looking JSON” or provider `status:complete`. Provider complete, application `ok`, checkpoint phase, Release evidence, and cleanup are independent facts.

## 2. Component/source map

| Proposed component | Existing source | Availability / gap / fallback |
| --- | --- | --- |
| SourceModeBanner | checkpoint.mode; actor execution label; replay/snapshot formats | Live, recorded replay, synthetic fixture, unverified import are distinct. Recorded-attended replay adapter is new work. Never infer mode from URL or colors. |
| RunStatusHeader | `/state`, lab.can_begin/can_fresh, accepted checkpoint projection | Existing summaries can show phases; add last successful poll locally. Show unknown when semantic source unavailable. |
| RunApprovalPanel | lab.review, limits, readiness checks; existing `/lab/begin` | Preserve exact request and stale-source checks. Display known process repair allowance. No new permissions implied. |
| ActorLayerLane | actor-launching/finished; semantic successful results | Invocation state available now; command/publish/change detail during authoring requires sanitized projection. Assignment is separately labeled. |
| IntentMap / FacetChips | baseline source and `Layer.changes`; `blockFacets` | Current live `/state` first carries full canonical baseline/Layer source in pending packet. Before that: assignment illustration or explicitly supplied baseline; do not prefill “observed changes.” |
| LayerDiffCard | packet.decision.packet.packet.sources[ref]; typed changes/assumptions/acceptance | Exact compare is already supported by selection renderer. During authoring new projector can capture accepted source-bound data without provider I/O. |
| CompositionPanel | exact candidate outcome, selected recipe, packet options | Full considered/selected/rejected sets available in packet. Candidate outcome has snapshot/provenance/ref/state, but not the complete immutable recipe; expose recipe summary only from actual record. |
| ResolutionReceipt | receipt; `resolve` result inside integrated demo selection handling | Current selection calls `resolve`, but does not return its exact Resolution ref in normal selected outcome. Show recorded selection now; add allowlisted Resolution ref/inputs from the existing in-memory result for full provenance. Do not invent a ref. |
| DecisionPanel | current OperatorPromptPacket + canonical review | Fully source-backed now. Maintain packet digest, expiry, allowed_actions, reason and capture method. Never render an import as actionable. |
| RealizationCard | realize outcome: realization.target/candidate/profile_id/profile/output_tree/files/coverage | Current summary strips outcome. Project safe manifest/coverage/reference fields, not executable file contents or generated HTML. No app launch URL exists. |
| CheckResults | measured evidence and pending endorsement validation | Endorsement presently supplies aggregate validation flags/digests, not individual result rows. Actual result rows appear later in release-verified. Project measured evidence before endorsement for useful pre-approval review. |
| BehaviorEvidenceRail | actual Node observations plus digest | Raw observations are not present in the saved viewer log: realization event has output/config; evidence event has evidence + observation digest. Add sanitized measured observations at measurement time. Legacy replay can show report-derived outcomes with attribution; do not invent a trace from config. |
| ReleaseReceipt | release-verified.released `{candidate,ref,reused,state}`, evidence, inherited and equality flag | Existing browser event is sufficient for bounded completion summary. More provenance needs explicit projection. `refs.released` alone is a reference, not inherited runtime verification. |
| CleanupReceipt | cleanup-verified.cleanup.cleanup and counters; lab lifecycle result | Map each field. Full completion gating uses server helper `demoLabCleanupVerified`, including no in-flight/reconciliation state. UI does not recompute permission from a subset of green checks. |
| EvidenceDrawer | allowlisted details + original existing canonical packet disclosure | Local logs/technical refs secondary. No arbitrary filesystem browser, credential display, raw AI stream, or untrusted HTML execution. |

The imported `workflowSnapshot` contract in `src/integrated-demo-visualization.ts` explicitly identifies operator-supplied JSON as unverified and completeness as checkpoint/status-only. Preserve those semantics. `OrderedSyntheticFeed` validates synthetic-replay events only; use its design for ordering tests, not a cast that passes live data through a synthetic contract.

## 3. Proposed minimal presentation projection

Prefer one pure allowlist projector shared by the live view and later replay renderer. Keep it beside demo code; do not add a second engine, scheduler, decision mechanism, or generic record explorer. It consumes already available authoritative outputs and host observations. Additional provider reads or model calls are unnecessary to obtain the missing display fields.

Suggested logical shape (design notation, **not executable TypeScript or an existing API**):

| Group | Proposed fields and rule |
| --- | --- |
| Envelope | `view_format`, `run_id`, `project_id`, `source_mode`, monotonic `view_revision`, `captured_at` if known, source manifest reference, checkpoint identity if available |
| Provenance | `source_kind`, `verification` (local-validated / report-derived / imported-unverified / synthetic), and `source_ref` for each claim. Local validation does not mean independently authenticated. |
| Freshness | last successful controller read; last host observation; last accepted semantic checkpoint; nullable original timestamps; gaps/inconsistent source flags |
| Invocation | actor/revision, assignment ref, launch-observed/completion-observed state, nullable start/end host timestamps, actual model/effort/execution label; no progress percentage |
| Semantic proposal | exact ref, owner, pinned baseline, publication state, accepted typed changes, requires_layers/read_set/assumptions/acceptance; source checkpoint sequence; missing fields stay unavailable |
| Candidate | exact Composition/evaluation identity, considered/selected/rejected sets, state, snapshot summary, required scope, Resolution ref(s) only if actually supplied |
| Review | active authoritative packet identity and kind/expiry/actions; display summary derived from exact bytes; historical receipts separate; no new endpoint or client-side authority |
| Realization/evidence | candidate/profile/output-tree refs; allowlisted coverage; result rows `{check,version,fixture,method,passed}`; sanitized observations and their source digest if provided |
| Outcome | Release ref/state, inherited ref/equality, provider outcome, application outcome as separate fields |
| Cleanup | exact booleans and counters plus authoritative aggregate permission flags; retained vs absent distinct; verification time only if observed |

Prefer a small additive `view` field in `/state` (versioned) while preserving `packet`, `review_html`, original guards and logs. Alternative module/file names are Sol’s choice. Do not fabricate `view` from unchecked labels or parse human message strings to determine success.

Capture command identity at the host dispatch boundary with accepted `DemoEvent` and result, not from prose or a guessed response shape. `layer.create` and `layer.publish` both return a ref/publication flag, so command identity matters. `outcome.ok:false` never creates a published card. Only accepted `layer.publish` with the corresponding ref changes published status. Fetching a known Layer for inspect shows its contents; visibility does not by itself select it.

To show proposal contents before the first decision, project the accepted draft input/outcome after server validation. Otherwise keep the card as “Assigned change / no publication observed” until the exact packet includes sources. For Resolution linkage, carry the existing `resolve` result and selected recipe from the operation that already owns them; do not reconstruct a Resolution from the human’s text. For evidence, attach the already produced `measured.evidence` and sanitized `measured.observations` before the endorsement packet; leave the packet and its digest unchanged unless the backend contract is intentionally versioned and all tests updated.

For future retained replay, persist the sanitized projection in a separate versioned file with monotonic observation IDs and real host timestamps; bind it to the same run/source manifest. Do not rewrite the existing successful log to appear timestamped. The legacy import path should label absent fields and use an ordered chapter replay. Private raw evidence stays local; any shareable bundle requires a deliberate sanitized export with known provenance.

## 4. State flow and consistency

Conceptual flow:

`unprepared → checking → review ready → explicit Begin → new/authors → selection(1)`

`selection(1) + 900 → runner → endorsement → complete → inheritance verification → cleanup`

`selection(1) + 1200 + repair allowance → repair(B revision 2) → selection(2) → runner → endorsement → complete → inheritance verification → cleanup`

`selection + defer / endorsement + defer / stop / expiry / failure → stop or failure handling → cleanup pending → verified or blocked`

The three-process 1200 branch stops at the repair gate. Readiness/review-ready/cleanup are controller states; they are not extra `DemoPhase` values. The backend reaches `complete` when Release/inherited semantic records exist, before the host finishes measuring the inherited realization. Therefore the UI waits for `release-verified` before saying inherited behavior matched.

Maintain independent axes: **connection**, **application phase/outcome**, **pending input**, **invocation observation**, and **cleanup**. Do not build a single severity-sorted status from the most recent event. A valid Release and blocked cleanup can coexist. A failed application and verified cleanup can coexist. A completed provider and failed application can coexist.

Projection rules:

1. Key all cached state and in-flight requests by run ID. A fresh preparation resets the view; delayed prior-run responses cannot resurrect old packets.
2. Match semantic transitions by sequence and checkpoint digest. Duplicate identical observations are idempotent; older states cannot roll back a newer accepted state. Conflicting content at the same identity halts semantic updates.
3. Do not require every transient browser event to reconstruct state. A reconnect obtains the current full projected snapshot and authoritative current packet. Include current invocation/publication summary so truncating the 160-event list cannot leave actors falsely active.
4. One serialized polling loop or request-generation guard prevents out-of-order HTTP completion. Connection recovery performs GET only. The old 1.5s local polling cadence does not authorize new cloud polling.
5. Known in-flight provider apply means “awaiting checkpoint,” not a failed step, event resend, or synthetic success. Reuse strict decoder behavior.
6. A decision has UI states idle → locally selected → submitting → controller received → Workflow recorded/refused/unknown. Keep the submitted packet identity until a matching receipt/authoritative transition resolves it. Packet disappearance alone does not prove the Workflow accepted it.
7. On replacement/expiry, clear local selection/reason. On disconnect, freeze and disable dependent actions; after reconnect, re-enable only against fresh authoritative state. Never auto-submit a draft response.
8. Validation evidence binds candidate/profile/output tree. Stale or absent evidence displays “Unavailable for this candidate,” not a recycled green count. Imported records never expose live mutation controls.
9. Mode is immutable within a source session. Opening a replay creates a read-only view, never a mutation-capable clone of a live run. Review navigation is local and cannot affect execution.
10. Facets, edge layout, animation, chapter indices, and collapsed panels are presentation state only; they cannot change selection, scope, approvals, or cleanup permission.

## 5. Cleanup contract

The lab helper requires: no `journal.in_flight`, no `reconciliation_required`, terminal instance verified, local dispatches settled, repository tokens clean, handles disposed, instance/repository absent, namespace empty, retained Worker and Workflow verified, and no Worker/Workflow deletion requested. Keep this server-side decision authoritative.

The successful current browser event includes booleans under `event.cleanup.cleanup` and management counters under `event.cleanup.counters`. A zero token count is different from a missing token count. `worker_absent:false` plus `worker_retained_verified:true` is successful retention, not failed cleanup. The Release proof remains local after the temporary repository is deleted. Do not promise general durable hosted browsing from this lab’s disposable storage lifecycle.
