# Read API and owner connection contract

This page describes the local preview. The separate [hosted-read-only mode](SELF_HOSTING.md) uses protected owner sign-in, exact trusted proxy configuration, expiring secure cookies and CSRF. Its source/read validation remains the contract below; it introduces no hosted write or approval authority.

The host binds only `127.0.0.1`. Its source is one trusted host configuration; the browser cannot choose account, namespace, repository, filesystem path, transport URL, identity or arbitrary command. This is a trusted local-process boundary, not protection against an OS administrator controlling the process/filesystem.

The [connection settings contract](CONNECTIONS.md) adds authenticated GET/POST `/explorer/v1/settings` for projected status and ephemeral session actions. Browser selection is limited to host-supplied connection IDs sharing that same repository/project/model. Tests use existing bounded read adapters; disconnect invalidates cached and pending reads. These routes accept no credentials, endpoints or grants and introduce no repository writes or agent/chat protocol.

## Supported provider transport

`RestArtifactsReader` implements only repository identity GET and exact file GET on the fixed Cloudflare API origin. The documented REST file endpoint returns raw bytes, accepts commit references and uses an API token; Git repository tokens serve a different transport. See [Cloudflare REST contract](https://developers.cloudflare.com/artifacts/api/rest-api/), checked 2026-10-08. Repository `name` and returned `remote` must match configured storage before file reads. The launcher's optional `--expect-repository-id ID` also checks the returned immutable repository identity, and is required for CLI draft review. Redirects are refused. There is no repository listing/discovery, branch fallback, provision, token creation, push, delete, Worker or Durable Object storage.

The `ArtifactsReadPort` also accepts the existing adapter's narrowed `getManyAt` / `getBytesAt` interface when an authorized native host already provides it with `max_repo_tokens=0`; the Node launcher uses the independent documented REST implementation. Both are exact locator reads. A synthetic injected transport proves protocol/integrity behavior, not provider access.

## Secret-free configuration

The schema is `connectionSchema` in `src/explorer/contract.ts`; unknown fields are rejected. Owner-supplied configuration contains:

| Field | Required meaning |
| --- | --- |
| `format` | `strata-explorer-connection/1` |
| `connection_id`, `project_id`, `display_name`, `model_version` | One explicit supported project/model |
| `registry_path` | Absolute, owner-approved local publication registry path |
| `registry_kind` | `fixed-snapshot` approved export or `atomic-publication-index` explicitly known atomic producer |
| `storage` | Existing `strata-artifacts-registry/1` project/account/namespace/repository binding, `mode: remote` |
| `auth_provider` | `{kind: "existing-environment", variable: "STRATA_EXPLORER_..."}` or variable `CLOUDFLARE_API_TOKEN`; reference only, no credential value |
| `reader_policy` | `published-project-reader` |
| `initial_release_ref` | Optional exact reference; no latest inference |
| `read_authorization` | Project, reader principal, policy generation, ISO expiry, `full_registry_read: true`, operations exactly `["repository.info", "file.read"]`, request/byte/deadline limits |

The grant is an explicit trusted owner configuration, not a signed hosted identity or credentials policy discovery. Existing provider authentication must cover the complete configured integrity read, including private retained records. Published-only provider authority is insufficient for this loader. Each project requires its own explicit host binding and read authorization. No credential value is persisted in configuration, documentation or browser state.

By default only published records become browser data. An optional local `ReviewDraftGrant` binds one Layer reference, canonical-data SHA-256, project and expiry. The launcher creates it only from explicit `--review-draft REF --review-sha256 SHA256 --expect-repository-id ID` arguments and the source grant's expiry. Its exact hash, unpublished Layer type and project are checked before visibility. Invalid or expired grants clear cached data. This grants read visibility only; it does not change publication, approval, composition or hosted authority. No recursive visibility to other private records is added.

Config and registry paths reject links/junction traversal. The loader rejects adjacent `RECOVERY_INACTIVE.json`. An atomic index requires an existing matching `node-state.json`; a fixed export may use its trusted config binding without a descriptor, but any present descriptor must match. It never calls `bindNodeState`, acquires leases, migrates state, exports a writer registry or creates credentials. A producer's atomicity and fixed export trust are owner assertions, not inferred from a timestamp.

## Admission and verification

Before provider dispatch, the entire registry must match storage and supported types, with exact 40-hex commit, hash-derived JSON/binary path, SHA-256 and declared size for every locator. Limits: 1,000 entries, 16 MiB declared JSON, 8 MiB registry/record ceiling, 1,000 Blocks per snapshot, existing asset quotas (32 versions, 16 MiB retained, 4 MiB per image), 2 MiB response. Host authorization is rechecked before cached projections, before credentials and after reads. Read requests/bytes are reserved before dispatch and accumulate over refresh; no automatic provider retry occurs. Each dispatch has a bounded deadline. An expired or malformed operation grant prevents credential access.

Record bytes must have exact size/hash, UTF-8, canonical JSON, bounded depth/nodes and no prototype-sensitive keys. Dedicated read validators check existing type schemas, semantic identity, tree integrity, typed closure, generated Release/Resolution/validation bindings, realization profile/output/coverage and exact asset descriptor/binary closure. Writer methods are not called for validation. Published records and any one explicitly authorized exact review draft form the frozen browser generation. Other private records never become summaries or counts. `heads`, audit, cached requests and other principals' navigation state are excluded.

`registry_generation` hashes narrowed storage/entries/asset locators, including visibility. It is a version, not authenticity proof or time. `verified_at` is the host's retrieval observation only. A refreshed fixed export remains labelled fixed. Payloads/cursors remain in process memory. One refresh runs at once; cursors bind generation, project instance, sort and filters. Auth/integrity/binding failures clear data. A transient network failure may retain only currently authorized last-good data with an explicit stale label.

## Browser API

All responses use `explorer-read/1` with connection/project/model/source metadata or a sanitized error and random request ID. Browser data requires a random 256-bit local capability, sent as a Bearer header, with an eight-hour session limit, shortened to the source grant expiry by the CLI. Initial fragment access is stripped immediately; no credential/capability enters copied routes or localStorage. Only harmless navigation preferences persist. Static assets contain no project bytes; arbitrary files and the sample JSON are not served.

| Route under `/explorer/v1/` | Accepted operation |
| --- | --- |
| `connection` GET | Sanitized availability/binding/generation state |
| `records` GET | Permitted type list with explicit publication/review status, optional exact baseline/target, bounded cursor |
| `record` GET | One permitted exact typed record projection |
| `blocks` GET | Exact target tree, text/facet/direct-subtree/selector filters |
| `block` GET | Full Block obligations/provenance/authority at exact target |
| `relations` GET | Typed authored relationship list at exact target |
| `evaluation` GET | Existing Composition diagnostics, selections and retained coverage; no raw effective snapshot |
| `diff` GET | Eligible exact before/after atomic values; blocked and v0.2 effective comparisons refused |
| `refresh` POST | Same-origin, JSON body exactly `{}`; re-read the configured source only |

Exact `generation` is required for record projections. Queries have a positive field/method/route allowlist, duplicate/length bounds and explicit stale cursor errors. No generic broker operation, context mutation, dry-run, options or writer route exists. Host/Origin/fetch metadata reject foreign or null origins and forwarding; there is no CORS. `no-store`, `nosniff`, `no-referrer` and self-only script/style/connect CSP apply. Record prose uses DOM text nodes, never HTML parsing, commands, arbitrary linkification or URL/media loading.
