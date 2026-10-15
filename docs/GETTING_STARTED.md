# Getting started

Strata versions application intent through Blocks, owned Layers, Compositions, authorized Resolutions and validated Releases. The local runtime uses synthetic identities and finite example profiles.

For an attended create/change/review loop with concrete generic inputs, separate local roles, measured output and restart readback, use the [local contributor starter](CONTRIBUTOR_STARTER.md). It needs no private lab or provider credentials and uses the ordinary CLI/broker/Studio contracts.

For new intent projects, existing Git workspaces, metadata placement and safe ignore/backup rules, read [Git and Strata coexistence](GIT_COEXISTENCE.md). Git source history and Strata's durable intent store have separate recovery boundaries.

For your own Linux HTTPS installation, follow [self-hosting](studio/SELF_HOSTING.md): complete packages, protected state, browser enrollment, your own Artifacts namespace and the attended Windows runner. The static public website does not host Studio.

Install Node.js 22 or later, then run from the repository root:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/src/cli.js doctor --offline --json
npm run demo
npm run verify:local
```

Installation uses the lockfile. For a cached offline install, add `--offline` to `npm ci`; a missing cached package must be resolved before building. The demo and local verification need no provider credentials or models. Verification writes to `.strata/local-acceptance/`; each demo uses its own `.strata/demo-*/` output directory. [Example details](../examples/README.md) explain the fixture and observed behavior.

Browse an explicitly synthetic project:

```powershell
node dist/scripts/explorer.js --sample --port 0
```

Open the complete loopback launch link printed by the host. Keep the terminal open; Ctrl+C closes it. Browser memory holds the session capability; reload needs the launch link again. The [Explorer guide](explorer/README.md) explains exact references and read boundaries.

`npm run demo:replay` opens a saved synthetic example, marked read-only with its provenance. It does not launch actors, submit decisions or approve anything.

For individual commands, start `npm run broker:node` in another terminal and use `node dist/src/cli.js --help`. The checked-in local configuration and nonsecret fixture handles are examples; use the [agent session](../examples/agent-session.json) for a complete command sequence. `npm run broker` uses local Wrangler/Agents SDK instead; `npm run test:agents` verifies that runtime when native dependencies can execute.

If doctor reports a missing build, run `npm run build`. If a broker port is in use, inspect the existing process or choose a separate local configuration and port; do not terminate another project's service. Native tooling failures are blockers to the affected runtime test, not a pass. Keep external application registries and source/output directories outside this checkout.
