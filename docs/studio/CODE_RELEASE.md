# Studio code package

The fixed [release inventory](../../deploy/studio/release-files.json) extends the
existing namespace code package with the two agent browser modules, compiled
`dist/src/studio-agents` modules, the Worker bundle and the portable runner ZIP.
The bundled host contains its server dependencies; the accompanying compiled
agent modules are build artifacts, not standalone Node entrypoints.

Build and package locally from a clean committed checkout using the pinned
dependencies. Choose a new absolute output directory:

```sh
npm run typecheck
npm run build
node node_modules/typescript/bin/tsc --project tsconfig.studio-agent.json --noEmit
node scripts/build-studio-agent.mjs
node scripts/generate-distribution-notices.mjs
node scripts/package-studio-agent-runner.mjs
node scripts/package-studio-release.mjs --output /absolute/new/code-package
```

Regenerate bundled notices after the local Worker build; review/commit any generated source notice changes before running the clean-tree release packager. Keep LICENSE, NOTICE, THIRD_PARTY_NOTICES.md and every listed licenses file in both distributions. The runner ZIP contains its own per-file manifest, the bundled Zod notice and the complete optional SDK lock inventory; it does not contain the Claude SDK binaries. [Self-hosting](SELF_HOSTING.md) describes the full layout and activation boundary.

The Worker command uses Wrangler `deploy --dry-run`; it packages code locally.
The release packager rebuilds the host and finite checker worker together as one
split graph and builds the owner-control entrypoint separately. Both builds use
the same explicit suppression of imported CLI entrypoints as the earlier deployment
builder; the bundled host cannot start the development fixture broker. The fixed
inventory requires `dist/scripts/runner-worker.js` and declares only
`dist/scripts/studio-runtime/` as a generated directory. Its exact chunk files come
from current esbuild outputs, never an arbitrary scan of preexisting `dist`.
It emits exact source/tree pins, file sizes and SHA-256 hashes for every worker,
entrypoint and shared runtime chunk, plus bundle input lists. An existing destination,
dirty source or missing artifact is refused. The fixed inventory excludes private
state, host configuration, credentials, grants, receipts and installers running
on the host. Copying the ZIP does not install or pair a runner.

The default namespace agent seam exposes setup metadata. Including it in an
application package does not initialize private storage, provision Cloudflare,
pair a native runner, grant project consent or qualify live agent execution.
The existing checklist bridge remains governed by its separate explicit host
binding and activation contract; bundling its code does not configure it.

Review application rollout and the [nginx example](../../deploy/studio/nginx.conf.example)
separately. Preserve the exact 1 MiB preview/operation locations and the default
1 KiB body limit. Agent routes, including owner service setup, have a 128 KiB
ingress ceiling and longer response waits while inheriting all proxy restrictions.
Validate actual nginx syntax on the target before any approved ingress action.

Windows fixture results do not establish Linux protected-state custody. Dedicated
Codex 0.162.1 and the pinned Claude SDK need attended authentication, confinement,
cancellation and original-session recovery qualification. Real provider turns,
billing bounds, signed deployed identity and cleanup remain separate evidence.
See the [author review packet](../agents/STUDIO_ENABLEMENT_REVIEW.md) for those gates.
