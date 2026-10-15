# S4 Profiles UI handoff

Status: independent, mount-only Profiles page delivered as one bounded module plus fixture-driven browser checks. It is explicitly NOT wired into the Studio app: no route, host, persistence, provider or session integration is performed here, and nothing about the existing hybrid demonstration is claimed or completed by this slice.

## The five files

- `explorer/profiles.js` — the module. Exports `profilesView(ctx)`, returns a mountable DOM node. No imports beyond the existing public helpers `explorer/dom.js` and `explorer/operation-recovery.js`.
- `tests/fixtures/studio-profiles.mjs` — Node-only synthetic in-memory fake authority mirroring the published S0 `profile-service.ts` dispatch semantics (same commands, shapes and error codes) over records that parse the exact S0 schemas via the dispatcher-supplied `dist/src/model.js` and `dist/src/build-contracts.js` (canonical digests, `buildProfileInputSchema`, `repositoryContractRecordSchema`, `buildProfileRecordSchema`, `normalizeBuildProfile`). Clearly labeled synthetic; no filesystem, network or provider I/O.
- `tests/fixtures/studio-profiles.html` — disposable harness page. Stands in for the shell: builds a ctx with signal/check/state/announce/sessionRecovery, injects the fixture `profileApi` adapter (fetch to loopback `/fixture-api`), and offers a repository selector that honors the view's dirty-navigation contract before switching.
- `tests/studio-profiles-browser.mjs` — focused Playwright suite. Serves only the harness page, the new module and the allowed existing public explorer files on an ephemeral 127.0.0.1 port; launches a fresh disposable headless Microsoft Edge (channel `msedge`) via `STRATA_EXPLORER_PLAYWRIGHT_MODULE`; route-blocks every request outside its exact fixture origin; writes screenshots and receipts only under `STRATA_PROFILES_UI_OUTPUT`.
- `docs/studio/PROFILES_UI_HANDOFF.md` — this document.

## Mount contract

`profilesView(ctx)` returns a `section` DOM node with:

- `start()` — async initial read (compatibility lookup + first list page). Safe to call once after mounting.
- `dispose()` — aborts in-flight work, clears debounce timers and drops all draft/option state so a later mount cannot inherit old drafts. Late responses after dispose write nothing (guarded by an alive flag plus `ctx.check()` and the ctx signal).
- `hasUnsavedChanges()` — true while an editor holds unsaved input (create: a typed name; revise: a name differing from the loaded record) or while a save is in flight.
- `beforeLeave(reason)` — returns a Promise of boolean. If dirty, shows an in-page dialog with explicit `Discard draft and leave` / `Keep editing (cancel)`; the shell may proceed only on `true`.

The module renders with the current stylesheet classes only (`section`, `card`, `notice`, `toolbar`, `fields`, `pill`, `table-wrap`, `approved-source-form`, `form-error`, `raw`, `json`) and reuses `sessionRequired` / `unconfirmedOperation` from `explorer/operation-recovery.js` unchanged. It never reads `navigator` for host evidence, never touches web storage, and contains no credential, token, password, connection, command or path inputs.

## The injected profileApi seam (the only new integration surface)

`ctx.profileApi` is optional. Absent, the view renders an explicit unwired state ("no profile API adapter is connected"), disables New profile and saves, and dispatches nothing. Present, it must implement these methods with the exact S0/S1 command shapes; each accepts `(input, {signal})` and rejects with an `Error` carrying `.code` (and `.status`, `.outcome_unknown` where applicable):

- `compatibility({release_ref?})` — `repository.compatibility`. Returns `{contract_binding, context, binding}`; `context` is `{project_id, repository_id, contract: {ref, sha256, record}}` or null.
- `listProfiles({cursor?})` — `profile.list`. Returns `{profiles: [{ref, sha256, record, archived, report}], cursor}`; the harness adapter adds `limit: 2` to exercise truthful cursor pagination.
- `inspectProfile({ref})` — `profile.inspect`, same item shape.
- `validateProfile({record, target_ref?})` — `profile.validate`. Returns `{report, options, support}`; `report` includes `normalized_profile`, `normalized_sha256`, independent `repository_valid` / `materialization_supported` / `runnable_here` fields.
- `createProfile({record, expected_normalized_sha256})` — `profile.create`. Returns `{ref, sha256, record, report}`.
- `reviseProfile({previous, record, expected_normalized_sha256})` — `profile.revise`. Same return shape.

Optional `profileApi.fixtureNote` (string) is rendered verbatim as the mock-preview notice. S3 should adapt these six methods onto `workRead` (reads) and `command` (mutations) with the shared binding and operation recovery; the view itself never constructs transport, endpoints or operation keys.

## Data baseline

Everything is the exact published source at 0bdea8d781d24ccfa67cf5fd129f5e56c38de312: `PROFILE_OPERATION_SCHEMAS` and dispatch semantics from `src/profile-service.ts`, schemas and normalization from `src/build-contracts.ts`, fixed materializer metadata shaped after `src/build-options.ts` (collection-host/1; choices `javascript / none / node`; `options: []`; requirements Node major 22 or later for build/verify on the Studio host and run on the application target; destinations `['local']`; `run_application: false`; `serve_application: false`). The client authors only real `BuildProfileInput` fields (`id`, `revision`, `name`, `contract_ref`, `contract_sha256`, `choices`, `materializer`); record/receipt/actor fields are server-resolved and never typed by the user.

## UI semantics

- Header "Profiles", New profile, repository/contract context card (project, repository, exact contract pin + revision, Release binding truth: authoring head is labeled "Not checked against a Release"; an adoption binding, if a host ever returns one, is labeled with its Release pin).
- Saved profiles list: named logical profiles at their current immutable revision with status pills derived only from each `profile.inspect` report (Valid / Needs update / Unsupported by current tooling / Not validated), pinned choices, revision, exact ref. Truthful cursor pagination with Load more.
- Repository requirements keep hard rules (with allowed values, recorded rationale, provenance ref) separate from finite materializer support; advisory preferences render collapsed and are labeled as never widening rules; fields without rules read "Unspecified is not a claim that every … is implemented."
- Editor: name plus the actual fixed tuple displayed as readable fixed values from the materializer options (never a language picker); options and archive digest are discovered from the server's own validate response (probe with a zero archive; the module invents no policy engine). Advanced details panel exposes exact contract ref/sha, materializer id/archive, normalized sha256, derived id/revision and the previous CAS pin, plus the exact draft JSON.
- Save flow: fresh `compatibility` scope check (repository and contract head must still match the draft's pins; contract/head/repository drift blocks the save and invalidates the preview rather than silently retargeting), fresh `validate` of the exact captured draft, explicit re-confirmation when the normalized digest changed since the reviewed report, then `create` / `revise` with `expected_normalized_sha256` and, for revise, the exact previous head ref. Double clicks and form re-submission are prevented; typing and focus are never lost to a full re-render (only dependent regions repaint); name validation debounces and aborts stale reads.
- Missing contract: honest authoring/import handoff describing `repository.contract.import` and its retained review; no silent contract creation, no permissive fallback, New profile disabled.
- Old-contract profiles show Needs update, keep their old pins immutable, and an edit explicitly adopts the current contract with both refs named.
- Prerequisites distinguish build/verify on the Studio host from run on the application target ("not this browser"); current host readiness is shown as not evaluated; local destination is described as build output export, Cloudflare Workers as a future unavailable destination, connections and credentials as staying in Settings.
- Session expiry (`sessionRequired`) keeps input in memory, shows the shell recovery handoff (button calls `ctx.sessionRecovery`, then unblocks; no credentials form), and blocks mutations until refreshed. Unknown save outcome (`unconfirmedOperation`) blocks all further writes from the page and hands off to Review; nothing is auto-replayed and no second mutation key is created. Server errors preserve unsaved input. Cross-repository records/responses are rejected with a notice, and the previously loaded truthful list is kept.

## Fixture authority labeling

The fixture proves no live grant: every record is synthetic and in-memory, the page carries a persistent fixture notice, the fake service never contacts a provider, and the browser suite asserts zero non-loopback traffic. The fixture implements the no-target validate path only (a `target_ref` returns UNSUPPORTED_CAPABILITY), and its compatibility lookup always reports the authoring head or missing — no synthetic Release bindings are seeded, so adoption-binding rendering is unexercised beyond code review.

## Verification receipts

Commands run from the workspace root (all allowed checks, nothing else):

- `node --check explorer/profiles.js` — exit 0.
- `node --check tests/fixtures/studio-profiles.mjs` — exit 0.
- `node tests/studio-profiles-browser.mjs` — exit 0, 23 focused checks in the final dispatcher-reviewed suite (fresh disposable headless Edge; `msedge` channel; no existing browser profile, public site, live Studio host or provider call).
- `node scripts/task-docs-check.mjs` — exit 0 against this document.
- `git diff --check` — clean.

Check coverage (19): unwired default; contract context/rules/statuses; truthful pagination; keyboard New/name/Tab/Enter save with server-verified digest CAS; host/target requirements, Worker-future, Settings separation, false run/serve, save allowed while readiness unevaluated, no secret inputs; reload/edit/immutable revision 2 with revision-1 digest unchanged; required/length name gates with zero dispatches; delayed validation with stale report dropped and focus retained; missing-contract handoff; strict repository rule blocking save; open-repo unspecified honesty; old-contract Needs update with explicit adoption; stale-head refusal retaining input then explicit reload-latest and revision 3; cross-repository list rejection; session-expiry retention, recovery and second save; unknown save with single dispatch and blocked Enter path; dirty switch cancel/discard with late response writing nothing and no draft leakage; 320px viewport with no horizontal overflow and visible keyboard focus; aggregate clean run (all requests loopback, zero unexpected console/page errors — 4 resource-error lines expected from the intentionally injected 401/400/502 fixture responses — and empty local/session storage).

Artifacts written under `STRATA_PROFILES_UI_OUTPUT`: screenshots `01-unwired.png` … `11-narrow-320.png`, `checks.json` (per-check verdicts), `network-summary.json` (request counts by path, non-loopback zero), `console.json` (console/page errors, expected resource errors). No screenshots, caches, logs or helper files were created inside the workspace, and the five outputs are ready for isolated immutable review.

## What the integrator (S3) must provide

- App route/nav wiring: mount `profilesView(ctx)` into the existing shell page for the Profiles section and call `start()`; call `dispose()` on unmount, and `hasUnsavedChanges()` / `beforeLeave()` before navigation or repository switches (the shell owns the actual leave).
- The real `profileApi` adapter: map the six seam methods onto `workRead` (compatibility, list, inspect, validate) and `command` with shared operation recovery (create, revise), passing current binding/repository/session identity and generation checks. Reads must surface the exact S0 shapes above; mutations must let `OPERATION_UNKNOWN`-style errors propagate so this view's write-block and Review handoff engage.
- Host allowlist entries for serving the module file alongside the existing explorer modules.
- Minimal CSS only if desired (the module is styled entirely with existing classes; nothing is required).

## Honest limits

- Release-target validation (`target_ref`) and post-publication adoption bindings are not surfaced as flows; the UI labels Release checks honestly as not performed.
- Archive and duplicate actions are intentionally omitted to keep the core new/edit/save/reload path tight; the seam's `profile.archive` remains available to a future slice.
- No claim is made that S4 host wiring, native persistence, an end-to-end build demonstration, or provider interop is complete — those belong to S3 and later work with their own authorization.
- No missing source, approval or scope exception was encountered for this bounded slice.

## Dispatcher review corrections

The header exposes New profile in the first viewport. Empty panes render no literal null text. Escape cancels and resolves dirty navigation, restores focus, and disposal closes its dialog; navigation refuses while a save is in flight. An unknown save outcome takes precedence over session errors, and a retained shell pending operation blocks new saves across mounts. S3 must adapt mutations through the existing command/operation-recovery helpers, never bare production fetches. Current project/repository context and the exact normalized draft/contract are checked before dispatch. The narrow test explicitly sets and asserts 320px; the fresh browser permits only its exact fixture origin. All views remain mocked/unwired until S3 connects them.

Final review coverage additionally checks malformed cross-repository save confirmations: the outcome stays unknown even when the fixture committed its first save, and no second mutation is sent. The final page uses existing workflow form styles, not the unrelated fixed-column source form. Exact refs wrap on narrow screens. Mobile evidence is from an explicitly asserted 320px viewport; host wiring and real persistence remain outside this evidence.

The integrator must supply the current `ctx.state.project_id` and `ctx.state.repository_id` with `ctx.check()` and its abort signal, and retain the shell pending-operation guard. They are scope snapshots, not browser-supplied authority. Final focused QA: 23/23 in fresh headless Edge at 1280px and an asserted 320px, no horizontal overflow, no unexpected console/page errors, four intentional fixture-response resource errors, zero requests outside the fixture origin, and empty web storage.
