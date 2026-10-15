# Strata Studio: read-only default

For a persistent development service behind an owner-configured HTTPS proxy, see [Studio self-hosting](SELF_HOSTING.md). The explicit hosted-read-only mode preserves the local preview contract below.

For explicitly configured creation, changes, review and named hosted access, see the [implemented Studio workflow](../studio/STATUS.md). This page describes the compatible read-only default; reading alone grants no write authority.

Browse one Strata project at exact semantic references: Releases, Blocks, Layers, existing Compositions, atomic comparisons and retained evidence. The frontend is under `explorer/`, the read host under `src/explorer/`, and the launcher is `scripts/explorer.ts`. The writer broker and finite domain profiles remain separate.

The [visual Studio](VISUAL_EXPLORER.md) opens an application map of authored intent and relationships, with readable Layer overlays and temporary human proposal drafts. [Connection settings](CONNECTIONS.md) show the configured repository, supported read capabilities and agent integration limits, and provide bounded read tests and session disconnect/reconnect. Preparing a Layer or agent handoff does not write to the repository or run an agent.

To browse the synthetic example:

```powershell
npm run build
node dist/scripts/studio.js --sample --port 4173
```

Open the private local launch link printed by the launcher. Keep its terminal open; Ctrl+C closes the host. Port `0` selects an available loopback port. The session capability is removed from the address bar and kept only in browser memory. Reload requires the launch link again. Copied semantic routes carry no access capability.

Sample mode reads a committed synthetic booking fixture. Its recorded validation and reviewer attestations are fixture claims. Read-only Studio does not execute checks, generated programs, arbitrary URLs or local file traces. Launching without a source serves the unconfigured shell.

## Existing-auth remote reads

```powershell
node dist/scripts/studio.js --config ABSOLUTE_CONFIG_PATH --check-config
node dist/scripts/studio.js --config ABSOLUTE_CONFIG_PATH --allow-remote-read --expect-repository-id REPOSITORY_ID --port 4173
```

The first command checks configuration shape and project binding without reading credentials or contacting the provider. Live reads need an explicitly authorized, unexpired source grant. The launcher uses only the configured existing process environment variable: `STRATA_EXPLORER_...` or `CLOUDFLARE_API_TOKEN`. It does not load credential files or create/refresh tokens. Repository ID pinning supplements account, namespace, name, remote URL and exact immutable file locators.

An owner can add `--review-draft EXACT_REF --review-sha256 SHA256` to a repository-pinned live session. This exposes one exact unpublished Layer alongside published records, expires with the source grant, and labels the Layer **Draft - review required**. Other private records stay unavailable. These host arguments are unavailable to browser queries. Viewing a draft does not publish it, select a Composition or approve a Release.

## Reading boundaries

The host validates the complete configured registry integrity closure, then projects permitted records into an immutable in-memory generation. Auth, hash, binding and schema failures clear the view. A transient network failure may retain the last authorized generation with a stale label. Registry snapshots stay labelled fixed snapshots even after refresh.

Blocked Compositions have no effective comparison. Model v0.2 evaluation is structural-only; current mediation policy, expiry/revocation and effective comparison eligibility are unavailable. Retained approvals are historical, and storage integrity does not expand the model's **Local fixture trust**. Asset descriptors are text/metadata; binary closure is verified without a rendering endpoint.

See [API/security contract](API_SECURITY.md) and [local verification](../VERIFICATION.md).
