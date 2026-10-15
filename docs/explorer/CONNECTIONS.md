# Explorer connections

The local connection/session contract below accepts no secrets. The separate hosted [secure credential API](CREDENTIAL_STORAGE.md) supports encrypted provider storage and distinct owner management authorization; its Settings UI integration is independent of this local preview contract.

Open **Settings** in the header or project navigation. Settings show the host-configured repository, model and project binding; authentication availability; verified registry status; provider support; and available operations. The synthetic sample is explicitly labelled. Artifacts reads use the existing `RegistrySource` and `RestArtifactsReader`, exact immutable locators and the existing read grant. There is no alternate repository or browser-side domain engine.

The UI can select an existing host connection, test its read access, disconnect this session, and reconnect. Selecting a connection clears the old generation and leaves it disconnected until a successful reconnect. Testing a disconnected connection verifies it without retaining a browsable generation or reconnecting. Disconnect clears cached records and invalidates pending reads. It does not revoke credentials or change the repository. Settings are held in server memory and reset with the host process; browser storage contains only the existing display preferences.

Each test runs the reader's complete integrity and visibility verification. It has a ten-second whole-operation deadline, passes cancellation through the REST transport, and respects the existing cumulative request/byte/expiry grant. Reconnect cannot reset the adapter's budget. There are no writes, token creation, login, automatic provider retries or fallback to sample. **Cancel waiting** stops the browser wait; a dispatched host read may finish within its bound. Refresh status to observe the result. Navigation cancels obsolete UI requests and late responses cannot replace the current page.

States are `unverified`, `read-only`, `disconnected`, `unavailable`, `denied`, `error`, and `stale`. Stale means the last authorized verified generation remains available after a transient network failure; it does not establish current provider reachability. Authentication availability reports only `available`, `missing`, `unknown`, or `not-required`, never the environment reference or credential. Successful read access grants no proposal, publication, validation, execution, approval or chat capability. Existing exact draft-review grants stay unchanged.

## Owner setup

Use the existing launch contract in [README.md](README.md) with a trusted connection config, exact project/repository binding, an existing process-environment credential reference and an explicitly authorized bounded read session. The settings UI accepts no credentials, endpoints, paths, grants or operation allowlists. A custom endpoint is unavailable. A host can supply up to eight `ConfiguredConnection` readers, all bound to the same repository, project and model, through `startExplorer(..., { connections })`; the ordinary launcher provides only its explicitly chosen source. It never discovers repositories or adds another source automatically.

Cloudflare's Agents SDK integration exists in `src/worker.ts` (`ProjectAgent`). Repository operations use the existing CLI/broker workflow and Strata's ownership, revision, proposal, authority and validation rules. Explorer has no authenticated agent bridge, agent protocol or chat service. The owner must supply such a bridge with the exact same repository/project/model binding and server-resolved principal policy before agent interaction can be enabled. An installed SDK or a reachable repository is insufficient. Settings return `agent_chat: false`, `service_state: unavailable`, and `protocol: null`. No task data is sent to an external agent. The handoff is descriptive; it does not start another agent or grant access.

## Server contract

`GET /explorer/v1/settings` returns the standard Explorer envelope, with `data.format: strata-explorer-settings/1`, a numeric CAS `revision`, `selected_connection_id`, `busy`, `connections[]`, `providers[]`, and `agent`. Settings remain available when repository access is denied or disconnected, but still require the existing ephemeral local session capability.

`POST /explorer/v1/settings` accepts exactly:

```json
{"action":"test","connection_id":"sample-booking","revision":0}
```

Actions are `select`, `connect`, `disconnect`, and `test`. Only a current revision and host-known ID are accepted. Unknown fields (including tokens, endpoint URLs, filesystem paths, principal selectors and grants), duplicate query keys, query parameters, foreign origins and unsupported methods fail before source access. POST requires the exact local Origin, JSON content type and bounded body. The existing host/header/fetch-site/session protections, no-store headers, CSP and response limits apply. Settings return only projected metadata and safe error messages. Source errors, provider bodies, registry paths and authentication references are excluded.

`ExplorerReader.invalidate()` clears generations/cursors and increments a lifecycle counter. `refresh({ signal })` refuses a completed read if that counter changed. `ExplorerSource.load(signal?)` and `ArtifactsReadPort` methods accept optional cancellation for the existing transport. Original read routes refuse while the selected connection is disconnected. The ordinary refresh route also has a ten-second deadline.

## Frontend integration

`explorer/connections.js` exports `async settingsView(ctx)`. Supply `ctx.request('settings', { method, body, signal })`, `ctx.signal`, `ctx.check()`, `ctx.announce(text)`, and `ctx.onConnectionChange(settings)`. The view requests server truth; it does not store a config or credential. The app adds `#/settings` and the header Settings button. Its callback aborts active renders, closes open dialogs, reloads connection/releases, clears unavailable exact references and renders the active route.

The callback dispatches `window` event `strata:connection-change` with `{ revision, connection_id }`. Visual render contexts snapshot the route state and connection; each refresh/render emits `strata:view-change`. Proposal and agent-handoff dialogs listen to both events and require a current render epoch before export. A changed connection or registry generation also clears the selected Layer overlay. Settings actions do not change repository records. The host allows the exact visual module filenames alongside `connections.js`.

## Verification

After build, run the focused suites and offline browser checks with the existing Playwright module:

```powershell
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/explorer-*.test.js
$env:STRATA_EXPLORER_PLAYWRIGHT_MODULE = 'ABSOLUTE_EXISTING_PLAYWRIGHT_MODULE'
node --import ./tests/no-external-fetch.mjs tests/explorer-connections-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/explorer-visual-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/explorer-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/explorer-integration-browser.mjs
```

Fixtures and screenshots are synthetic; browser evidence is written outside the checkout in a temporary directory. Tests cover malformed actions and configuration admission, denial/redaction, read-only capabilities, source selection, disconnect/reconnect, cumulative budget, deadlines, stale revisions/responses, cancellation/navigation, browser storage and existing Explorer behavior. Live provider connectivity, credentials, agent protocols and screen-reader speech are not exercised.
