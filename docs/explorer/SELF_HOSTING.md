# Development Studio hosting

For the complete current browser-owner/namespace/Windows-runner installation, see [Studio self-hosting](../studio/SELF_HOSTING.md). This page retains the original reader-host contract.

For a fresh installation with authenticated project creation and the finite Release workflow, use the opt-in [namespace host](../studio/NAMESPACE_WORKFLOW.md) and [first-project provisioning](../studio/FIRST_PROJECT.md). That mode has a separate sealed browser owner and explicit named-human authority. The reader-only mode below retains its existing boundary. Linux Node 22+ and HTTPS are the initial Studio target; the Windows coding-agent runner is a separate installation.

Studio has an explicit **hosted-read-only** entry point, separate from the existing loopback preview. This prototype offers retained-record browsing and bounded connection tests. It cannot write repositories, publish proposals, validate candidates, approve Releases, or run agents. Authentication is a single owner access key, not multi-user hosted identity or domain authority. The host still validates existing read grants, immutable references, integrity, visibility and cumulative budgets.

The shared reader key has no account/principal or policy-generation claims and must never acquire writer authority. `HostedReadAccess` isolates this reader session boundary. Future hosted authoring requires a separate named-actor adapter, protected account/grant store and commit-time reauthorization shared with CLI; this deployment does not provision that authority.

## Requirements and safe preparation

Use Node >=22, a trusted HTTPS reverse proxy, and a supervised service. Build on the development machine; avoid running TypeScript/npm/build tools on a small website host. Keep the Studio release, configuration and service separate from the marketing document root. Do not run the CLI writer/broker as the hosted backend.

```sh
npm run build
npm run typecheck
node dist/scripts/studio-host.js --host-config /absolute/path/host.json
```

The strict host configuration shape is illustrated by [host.example.json](../../deploy/studio/host.example.json). This explicit mode always binds **127.0.0.1**. Missing sign-in configuration serves only a static setup shell and sanitized session status; all settings/data routes fail closed. No preview token is generated or printed. Unknown settings, credentials in JSON, arbitrary endpoints and partial project bindings are refused. No project/provider read runs at startup. Invalid files/configuration prevent startup; there is no fallback to sample data.

For a small standalone deployment, run `node scripts/bundle-studio-host.mjs` with the existing esbuild dev dependency. Place `package.json` with `type: module`, the host and finite-checker worker bundles plus their entire `dist/scripts/studio-runtime/` shared-module directory under `dist/scripts/`, and the allowlisted `explorer/` assets in the same release layout; the script resolves assets relative to `dist/scripts/`. Build host and worker together: independent bundling can change checker archive pins. Namespace coding-agent hosting also needs its separately built agent assets. The synthetic sample JSON need not be installed and has no served route.

[strata-studio.service](../../deploy/studio/strata-studio.service) is a generic systemd example using an isolated runtime, DynamicUser, a read-only filesystem, resource limits and restart on failure. Adapt and validate paths and sandbox directives against the installed systemd/container. StateDirectory reserves a private directory; current settings, sessions and read generations remain in memory. A restart invalidates browser sessions and resets the adapter's in-process cumulative counters, but preserves the configured expiry and limits. Restart must not be used to claim lifetime quota enforcement. Each explicit read still needs the owner's valid project grant. Avoid uncontrolled automatic restart on configuration errors.

## Exact proxy boundary

Set one exact HTTPS `public_origin` and exact IPs in `trusted_proxy_addresses` for the **last hop connecting to Node**. No CIDR, wildcard, arbitrary forwarded host or forwarded client chain is accepted. The proxy must overwrite Host with the configured hostname and X-Forwarded-Proto with `https` only after enforcing HTTPS at ingress. It must clear X-Forwarded-Host, X-Forwarded-For, X-Real-IP and Forwarded. Incoming Origin, when supplied, must equal the configured HTTPS origin; null/cross-origin fetches fail. No CORS is enabled. Direct loopback requests with ordinary Host/headers are denied too.

When the HTTPS proxy lives on another host, use a separate restricted Nginx listener on the Studio host to relay to Node's loopback port. Restrict that listener to the verified gateway source address and exact hostname, with an explicit default rejection for other hosts. Configure Node to trust only its local relay. The owner must separately approve and configure any network listener, access restriction, firewall or gateway changes. The [Nginx example](../../deploy/studio/nginx.conf.example) contains the forwarding rules; its loopback listener is preparation only. NPM's TLS feature does not authenticate Studio users. Disable proxy caching. This read-only API uses HTTP requests, with no websocket requirement. Preserve existing website configuration and verify it after activation. [Nginx proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) describes the forwarding directives.

## Owner sign-in setup

Provision a **new independent Studio access key** consisting of 32 random bytes encoded as 43 base64url characters, using an approved password manager or a private attended terminal. Keep the value out of chat, source, URLs, command arguments and logs. This is not an Artifacts API token. Write only its SHA-256 hex digest to a protected file (POSIX mode 0600) and set `access_key_hash_file` to its absolute path. With DynamicUser, use systemd `LoadCredential` to deliver that file privately to the service; point configuration at the service's credential directory. Never broaden file permissions just to make sign-in work. Changing the key and restarting revokes all in-memory sessions.

The owner enters this Studio key in the HTTPS sign-in form. POST `/studio/login` accepts only `{access_key}` and requires exact HTTPS Origin and JSON; at most ten attempts per minute across the process are accepted. The host returns an opaque `__Host-strata_studio` cookie with Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain. Sessions expire absolutely in eight hours and after thirty minutes idle. Login replaces the requesting browser's old session; sign-out invalidates it. The process retains at most 32 sessions. Restart clears all sessions. Every authenticated POST needs the current session-bound `X-Studio-CSRF` value plus exact Origin/JSON. Bearer preview capabilities are refused. The key is never returned; only CSRF stays in browser memory. Clear request-body logging in every proxy before sign-in is activated.

## Owner project connection setup

The [secure credential backend](CREDENTIAL_STORAGE.md) supports manual provider entry once its Settings UI is integrated and the owner has separately provisioned sign-in, manager authorization and an encryption unlock key. The original local Settings route still accepts no credentials. Supply the existing [connection contract](CONNECTIONS.md) on the host through `connection_config` and an exact `expected_repository_id`. It needs the trusted publication registry export, account/namespace/repository/project binding and an explicitly authorized bounded, expiring read grant. Repository residency in Artifacts alone is insufficient: the existing loader needs a local trusted registry index with exact locators. It does not discover one from Git branches or regenerate a writer registry.

An existing authorized provider credential may be supplied to the service through the connection contract's environment reference using an owner-approved protected service credential path. The launcher does not read credentials from the browser, create tokens, extend grants, silently renew expiry or acquire writer authority. Provisioning the credential and the read grant are separate owner actions; no existing local key should be copied by a deployment task. Missing/expired provider access fails closed at read time, while authenticated sanitized settings still explain availability. The first provider read is an explicit authenticated Refresh or Settings test/connect action. Nothing automatically reconnects on restart.

## Verification and updates

Test missing auth/source, incorrect Host/Origin/proxy/forwarding headers, login failures/limits, cookie flags/rotation/logout/absolute and idle expiry, CSRF, route/method/query/body allowlists, source grant expiry, restart, no-secret responses/logs and the unchanged website. Use synthetic fixtures for implementation tests; live connectivity requires separate owner authorization. Check keyboard/mobile sign-in and settings, static modules, and a denied write route. Do not bypass certificate warnings.

Deploy later approved commits as immutable release directories, verify checksums, switch the current pointer and restart only Studio. Keep one preceding verified release for rollback; restart discards sessions. Record actual addresses, owner configuration, versions, checksums and rollback receipts **outside the product repository**. This document is reusable hosting guidance, not standing authority to change a host, credentials, grants or access policy.
