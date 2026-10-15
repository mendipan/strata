# Offline verification command map

Use this map to select a local check and interpret its result. It supports the documentation preparation portion of existing-route qualification (Q1-P); it does not close that qualification lane. [Local verification](VERIFICATION.md) remains the command reference, [getting started](GETTING_STARTED.md) covers setup, and the [implemented contract](IMPLEMENTED_CONTRACT.md) defines supported behavior and remaining gaps.

## Prepare the checkout

Use Node.js 22 or newer and the pinned lockfile. Run from the repository root. For onboarding verification, use a fresh temporary source export and install from the lockfile with `npm ci --ignore-scripts`, then build. That installation can require registry access; it is a prerequisite to local checks, not evidence that every command is network-free. Do not rely on an older checkout's `dist/`, private state or provider authentication.

```powershell
npm run build
npm run typecheck
npm test
npm run verify:local
npm run check:links
npm run test:agents
```

The first five are the validation commands in [contributing](../CONTRIBUTING.md). The verification guide adds the local SDK check. Choose focused checks appropriate to a change, and retain the required broader qualification separately. This documentation assignment does not run any runtime command above.

## Choose and interpret a check

| Command | Prerequisites and coverage | Observable output and limits |
| --- | --- | --- |
| `npm run build` | Installed dependencies; TypeScript compilation emits `dist/`. | Compiler exit and diagnostics. Compilation does not demonstrate application behavior. |
| `npm run typecheck` | Installed dependencies; TypeScript checks with `--noEmit`. | Compiler exit and diagnostics; no compiled output is produced. |
| `npm test` | Current build; runs `dist/tests/*.test.js` serially. The documented aggregate covers engine, CLI, profiles, mediation, authority, storage mocks, recovery, supplied translation and Explorer contracts. | Preserve test totals, failures and skips. Some tests need local workerd or installed browsers; aggregate success has the scope of the actual executed checks. |
| `npm run verify:local` | Current build and the files checked by the acceptance runner. Exercises offline doctor, the fixture demo and recorded read-only replay. | Writes `.strata/local-acceptance/receipt.json`, with environment and individual checks; a failure is recorded with a nonzero process exit. |
| `npm run check:links` | Node; runs the source script without a build or provider connection. Checks local documentation/UI targets and fragments. | JSON file/link/failure counts. Missing targets or fragments fail the command; external URL availability is not tested. |
| `npm run test:agents` | Current build and working local Workers/Agents SDK native tooling. | Local workerd/SQLite runtime behavior; retains `.strata/agents-check-*/result.json` when reporting an outcome. Reported blocked or failed runtime checks exit 9; missing native dependencies must be reported. This is separate from the Node fixture demo. |

See the exact script definitions in [package.json](../package.json). Output files, compiler diagnostics and test summaries serve different purposes: a link check cannot substitute for a runtime test, and a build cannot substitute for evidence assertions.

## What the local acceptance runner checks

The [acceptance runner](../scripts/verify-local.mjs) imports the [fetch guard](../tests/no-external-fetch.mjs) and preloads it in each child. That guard rejects non-loopback global `fetch` calls. It is a JavaScript fetch boundary, not a network sandbox for arbitrary subprocesses or libraries. The `npm test` and `test:agents` script definitions do not preload this guard; aggregate success does not prove universal offline enforcement. The runner disables named Cloudflare/Wrangler fetch and reporting settings and removes specified provider/session/config environment variables before spawning its children. Those controls do not prove that all possible credential sources are absent.

Doctor runs with `--offline --json`: the runner asserts healthy configuration, no recorded network effects and a broker-health state of `not_checked`. The demo is explicitly `local-fixture` trust and does not exercise Cloudflare Agents. The runner checks concrete observations, repeated-operation behavior and expected conflict refusal; exit 5 inside that demo trace is expected only where the runner asserts it.

Replay starts a temporary loopback listener. The runner checks the recorded synthetic bundle, verifies five mutation routes return 409, stops the child and asserts the endpoint is closed. It also checks that project configuration bytes are preserved. A saved replay is recorded evidence, not a fresh application execution.

The runner checks for missing prerequisites and records their failure. It does not independently detect every stale compiled file, so rebuild after source changes. Preserve a failed receipt for diagnosis before another run writes to the same receipt path.

## Report results without broadening their meaning

Record the exact source revision, operating system, Node version, command, exit code and relevant totals or receipt digest. Preserve failures and environment skips explicitly; an unavailable native dependency or browser is not a passing check. Explorer and demo browser suites need an existing Playwright installation and installed Chrome/Edge as described in the verification guide. The viewer suite uses a standalone CDP driver with the `STRATA_VIEWER_BROWSER` executable override. None installs a browser implicitly. Keep generated receipts and browser artifacts in ignored output locations or a task directory, not product documentation.

The supported native Git operations in the implemented contract are the bounded v0.1 route. Local or Windows success does not establish other-platform qualification, final R1 reconciliation completion, V1 native v0.3 parity, hosted conformance or human acceptance. Report those gates separately. Fixture identities and a successful receipt also grant no authority to access a provider, activate a host or deploy a change.
