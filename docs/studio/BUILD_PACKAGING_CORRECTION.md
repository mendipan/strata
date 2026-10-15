# Build static package correction

Studio imports `build.js` and `build-api.js` eagerly from its application module. Omitting either from the fixed [release inventory](../../deploy/studio/release-files.json) prevents the packaged shell from mounting every section, even when the development host serves both modules.

The inventory now includes both files. The seven reviewed Build UI/API/handoff blobs remain unchanged. The [focused regression](../../tests/studio-release-browser.mjs) copies only the inventory's static Explorer assets, checks exact copied bytes and the complete browser import closure, verifies that removing either Build module fails, then mounts the real shell and Build page from that copy with a synthetic read-only source. The disabled build actions are expected in this unconfigured fixture.

Use the existing compiled Explorer host and fixture modules, installed esbuild and an existing Playwright core module:

```powershell
node --check tests/studio-release-browser.mjs
node --import ./tests/no-external-fetch.mjs tests/studio-release-browser.mjs
git diff --check
```

Set `STRATA_STUDIO_PACKAGE_OUTPUT` to an external evidence directory and `STRATA_EXPLORER_PLAYWRIGHT_MODULE` to the existing Playwright module. Checks, exact copied-file hashes, network evidence and a packaged-page screenshot are retained there. This is an inventory-faithful static package fixture, not a full production package build, deployment, provider call or installed-host activation.

The fixture navigates its browser to `about:blank` before disposable host shutdown. Independent review observed a stall in the original Profiles persistence suite during HTTP shutdown for restart; a quiesced diagnostic harness passed its product assertions. This packaging correction does not alter or claim to fix that existing harness stall. The earlier [Build handoff](BUILD_UI_HANDOFF.md) remains applicable, including its backend, activation and history limitations.
