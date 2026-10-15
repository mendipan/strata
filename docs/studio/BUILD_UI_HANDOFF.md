# Build page

Build is a Studio section at `#/build`. It selects a historically approved flattened Release, an exact valid saved Profile revision in the current repository, and Local (Studio host) or Cloudflare Worker. Worker is visibly planned and unavailable. No arbitrary server, filesystem path, script, secret or connection field is accepted.

The [page](../../explorer/build.js) mounts through the existing Studio shell. The [adapter](../../explorer/build-api.js) uses authenticated shell reads, the existing generation/policy binding and original-key operation recovery. It introduces no backend endpoint or storage engine.

| Page action | Existing Studio API |
| --- | --- |
| Reload choices | GET `build/context` |
| Prepare; fresh pre-admission check | POST `build/preview` |
| Start | `build.start` through POST `operation` |
| Refresh retained status | GET `build/status` |
| Inspect verified files | GET `build/outputs` |
| Download opaque file ID | GET `build/output` |

All routes are beneath `/studio/v1/`. Explicit context reload refreshes the shell's CAS binding; prepare/start never silently rebind it. Release pagination follows the backend cursor with a bounded twenty-page limit. The context currently supplies only the first saved-profile page; the UI states that limitation and links to Profiles for additional revisions. It does not claim a complete profile inventory.

Only authoritative `approved` publication reports with retained historical approval enter the Release picker. Bootstrap is excluded by the backend's shared publication predicate. Profiles must have current repository validity, matching repository/contract pins and matching canonical record bytes. Materializer support for the selected Release comes from backend preparation.

Preparation verifies the canonical plan digest, exact selection, repository, materializer and independent compatibility gates. Start prepares the captured selection again and refuses any changed plan. The shell confirms the returned plan, scope, original request key, request digest and derived build ID before clearing recovery metadata. A lost or malformed confirmation retains the original operation key for Review and blocks another build. No request is replayed. Session expiry retains selections and offers the shell's protected-session recovery; a local capability may require a new local session. Navigation disposes the page and aborts reads, while admitted effects retain shell recovery. The page stores no draft, credentials or build authority in browser storage.

Status and files come from retained backend results. Completion means exact bytes and finite mechanical checks passed; fresh semantic validation, application execution and serving remain explicitly unavailable. Verified downloads use authenticated transport and recheck their byte count and SHA-256 against the returned opaque inventory. Nonterminal reconciliation-required attempts block new admission. Status refresh never reruns effects or invokes installation reconciliation.

## Validation

The [browser suite](../../tests/studio-build-browser.mjs) runs the real Studio shell, HTTP routes and Local repository against disposable synthetic retained publication history. It performs actual export, a new finite host measurement, exact download verification, independent literal generated-module behavior checks and disk reopen. It also exercises Worker refusal, stale readiness, malformed/cross-repository replies, original-key confirmation, session expiry, late-read navigation, unconfigured refusal and desktop/320px rendering. Response faults and host custody are explicit test seams. This proves a local synthetic workflow, not installed host qualification or live persistence.

Compile the affected Local repository/Studio fixture with the existing TypeScript toolchain, then run:

```powershell
node --check explorer/build.js
node --check explorer/build-api.js
node --check explorer/app.js
node --check tests/studio-build-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/studio-build-browser.mjs
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/build-adapter-review-regressions.test.js dist/tests/studio-profiles-integration.test.js
git diff --check
```

Set `STRATA_BUILD_UI_OUTPUT` outside the checkout and `STRATA_EXPLORER_PLAYWRIGHT_MODULE` to an existing Playwright core module. The suite launches a fresh headless Edge context, permits only its exact disposable loopback origin and records checks, network/page errors and desktop/mobile screenshots. Windows realpath and browser launch require the established disposable-test sandbox exception. No dependency installation, account, provider or installed host is used.

## Remaining boundaries

The existing Local adapter must already be configured and authorized before the page can prepare or start a build. Namespace persistence, installed host custody/output-root qualification, build activation and broader operational readiness remain unsupported or unqualified. This change does not initialize custody, provision grants, configure a runner, call a provider, deploy a Worker or activate a live host. Read [Profiles integration](PROFILES_INTEGRATION.md) for the existing persistence and session boundaries. The page displays the current retained attempt; recent-attempt browsing and reopening after page reload remain follow-up work because Build context exposes no attempt-list projection. Original-key Review and backend status/restart inspection remain available. Independent candidate review and combined integration verification remain required before publication.
