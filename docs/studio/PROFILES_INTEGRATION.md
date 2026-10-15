# Profiles page integration

This slice composes the reviewed S4 UI (`15196bfbb8628b45b0ab61a6695cd6eaba00eaac`) with the published S3 Local repository APIs (`2809340db655bb46927cbdd2551a171178c69bef`). The [S4 handoff](PROFILES_UI_HANDOFF.md) describes the original mocked module and its original evidence; this document describes the subsequent integration.

Profiles is now a Studio section at `#/profiles`. A host with an already configured Local Profiles adapter can list, inspect, validate, create and revise immutable profiles. Unconfigured hosts retain their explicit refusal. This adds no backend activation, contract approval, policy grant, credential, build execution or deployment.

## Transport and lifecycle

The [adapter](../../explorer/profile-api.js) uses the shell's authenticated `workRead` and `command` helpers. It preserves exact inputs and omits absent optional query fields.

| UI method | Existing Studio route |
| --- | --- |
| compatibility | GET `/studio/v1/repository/compatibility` |
| listProfiles | GET `/studio/v1/profiles` |
| inspectProfile | GET `/studio/v1/profiles/record` |
| validateProfile | POST `/studio/v1/profiles/validate` |
| createProfile / reviseProfile | POST `/studio/v1/operation`, `profile.create` / `profile.revise` |

The shell supplies a current project/repository snapshot, generation check and abort signal. Hash navigation, browser history, Refresh and the repository chooser honor the page's dirty-draft decision. Unmount disposes the view; late reads cannot restore old drafts. Browser reload/unload has the native unsaved-input guard.

Reads during Save keep the editing generation and policy CAS pins. A stale generation/policy refusal retains the name and requires an explicit repository/latest-revision reload. List/reload refreshes the shell's read binding. Confirmed Local mutations refresh the actual Explorer reader, so subsequent navigation uses a coherent registry generation. A projection-refresh failure preserves the already confirmed save and its immutable ref.

Save confirmations must match the project, repository, exact normalized input, previous revision and expected normalized digest before clearing the original operation key. The complete returned record, including server-authored fields, is hashed with the engine's canonical JSON/UTF-8 SHA-256 convention; its digest must match the returned immutable sha/ref. Missing/malformed/cross-scope confirmations and lost responses remain unknown. Review inspects the original receipt without replay, independently of proposal-inbox support. Pending metadata survives reload and blocks another mutation. Draft content remains in memory and is never stored for recovery.

Expired sessions keep the draft during both reads and saves. The page asks the shell to refresh its protected session and binding, then retries missing materializer options or revalidates the retained name. Workspace recovery retains the captured principal; named-actor recovery requires the same principal. Local launch capabilities require a new local session when expired. No credential form is introduced in Profiles.

Within a mount, a detail reload belongs to its captured detail and latest request. Replies after Back to list, another detail or an editor transition are ignored. Replacing an existing editor uses the same dirty-draft decision as shell navigation. After Reload latest revision, the intro, heading, advanced predecessor and next save all use the reloaded record; the name input node remains intact.

The existing Studio classes and stylesheet remain in use. Exact pins wrap at narrow widths through a stylesheet rule compatible with the existing CSP. Fixed materializer choices compare by field value, avoiding false change claims caused by JSON property order.

## Verification

Use existing dependencies and Node >=22; no installation is needed:

```powershell
node node_modules/typescript/bin/tsc --noEmit false --outDir dist --rootDir .
node node_modules/typescript/bin/tsc --noEmit
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/studio-profiles-integration.test.js dist/tests/build-adapter-review-regressions.test.js dist/tests/operation-replay-effects.test.js dist/tests/profile-persistence.test.js dist/tests/studio-workflow.test.js dist/tests/studio-draft-recovery.test.js
node --import ./tests/no-external-fetch.mjs tests/studio-profiles-persistence-browser.mjs
node tests/studio-profiles-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/studio-draft-recovery-browser.mjs
git diff --check
```

Browser scripts require `STRATA_EXPLORER_PLAYWRIGHT_MODULE` pointing to an existing Playwright core module. Set evidence directories outside the checkout: `STRATA_PROFILES_PERSISTENCE_OUTPUT`, `STRATA_PROFILES_UI_OUTPUT` and `STRATA_NAMESPACE_EVIDENCE`, respectively. They launch fresh headless Edge contexts. The new combined suite restricts browser requests to its exact fixture origin and forwards actual API calls only to disposable loopback repositories. Windows fixture realpath and browser launch may require the established test sandbox exception.

The HTTP regression verifies real generation refresh, immutable bytes, receipt replay, disk reopen and stale CAS. The combined browser suite covers actual create/edit/list validation, repeated submission, browser navigation, cancelled/discarded drafts, two repository scopes, late reads, session recovery, lost committed responses, mismatched confirmations, original-key Review, disk reopen, strict repository rules, unconfigured refusal and 1280px/320px rendering. Namespace chooser/session orchestration and response faults in that suite are synthetic; profile/contract/validation/write records and disk persistence use the real Local repository implementation.

## Review and remaining boundaries

The candidate needs independent integration review before publication. The S3 review's installed-host custody, complete exclusion inventory, attended rehearsal, power-loss and stale-lease qualification limits still apply. No remote namespace persistence backend, provider interoperation, live account, installed host or deployment is exercised. Build UI, archive/duplicate actions, Release-target validation and the higher-priority hybrid demonstration remain separate work.
