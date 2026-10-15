# Local verification

Run from the repository root after the lockfile install. No model calls or remote provider experiments are needed.

```powershell
npm run build
npm run typecheck
npm test
npm run verify:local
npm run check:links
npm run test:agents
```

The aggregate exercises the engine, CLI, profiles, mediation, ownership/approval gates, storage mocks, failure recovery, supplied-proposal translation and Explorer contracts. Some tests run local workerd or installed browsers; missing native dependencies must be reported. `verify:local` checks offline doctor, the complete local fixture demo, replay integrity and refusal of replay mutation endpoints. Its receipt stays in `.strata/local-acceptance/`. `test:agents` checks the real local Workers/Agents SDK runtime, with no remote bindings.

`node dist/scripts/onboarding.js --agents` runs the same fixed onboarding packet against the local SDK. Each run retains a fresh SDK database directory under the OS temporary directory and reports its `runtime_directory`; this avoids checkout-dependent Windows SQLite path limits. CLI receipts remain in the checkout's ignored `.strata/` directory. The harness does not reuse or erase earlier runtime state. Bootstrap or acceptance failures still fail the command after the local listener closes.

Explorer and demo browser suites use an existing Playwright installation and installed Chrome/Edge. The viewer suite has a standalone CDP driver. They never install a browser implicitly. Set `STRATA_EXPLORER_PLAYWRIGHT_MODULE`, `STRATA_DEMO_PLAYWRIGHT_MODULE` to the installed module path as needed (`zcode-viewer-browser.mjs` uses its own CDP driver and `STRATA_VIEWER_BROWSER` executable override), then run:

```powershell
node tests/explorer-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/explorer-visual-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/explorer-connections-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/explorer-integration-browser.mjs
node tests/demo-run-browser.mjs
node tests/zcode-viewer-browser.mjs
```

Use loopback sources, deny external page requests and preserve existing sessions. Marketing checks live in [strata-site](https://github.com/mendipan/strata-site); its browser suite covers desktop/mobile, keyboard, no-JavaScript and reduced-motion behavior. Reports belong in ignored output directories or the OS temporary directory. Do not commit screenshots or one-off receipts as product documentation.

The combined Explorer regression switches between two host readers of one synthetic project, checks that connection changes discard drafts and old Layer overlays, races a delayed graph response against the new connection, and verifies read-only and agent-handoff boundaries. The separate visual and settings suites cover their full interaction and failure flows.

The opt-in [namespace workflow](studio/NAMESPACE_WORKFLOW.md) adds `studio-namespace.test.ts` and `studio-namespace-browser.mjs`: actual owner/actor HTTP, per-project brokers and immutable Git packs against a synthetic provider, including repository creation, switching, private draft persistence and restart. Local success does not qualify live Artifacts behavior or authorize activation.

For onboarding changes, export the tracked source to a fresh temporary directory, install from the lockfile, build, run offline doctor and `verify:local`. Do not depend on existing `dist/`, `.strata/` or provider authentication. Inspect actual GitHub checks/status for the pushed commit separately: no configured CI is not a passing CI run.
