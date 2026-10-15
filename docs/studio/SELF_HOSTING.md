# Self-hosting Studio developer preview

Studio is an attended developer preview. The static public website is documentation and a simulation; it is not hosted Studio. This guide describes a new installation using your own Linux host, HTTPS origin, Cloudflare Artifacts namespace and optional Windows runner. It is not a one-click installer or an unattended deployment promise. Existing installations need exact preservation/migration review, not fresh initialization over retained state.

## Build a complete code package

Use Linux Node **22+** on the host. Building the pinned toolchain requires Node **22.18+ or 24.11+** because of the direct Babel parser dependency. Use the lockfile and preserve the selected compilation layout: source-based profile archive identity can differ across layouts.

From a clean source checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
node node_modules/typescript/bin/tsc --project tsconfig.studio-agent.json --noEmit
node scripts/build-studio-agent.mjs
node scripts/generate-distribution-notices.mjs
node scripts/package-studio-agent-runner.mjs
```

The Worker command is a local Wrangler dry run, not upload or activation. Review generated notice changes and commit any source changes before the release packager, which requires a clean committed tree:

```sh
node scripts/package-studio-release.mjs --output /absolute/new/studio-code
```

The authoritative [inventory](../../deploy/studio/release-files.json) and generated manifest define the complete package. Keep all of:

| Package path | Purpose |
| --- | --- |
| `package.json` | Node ESM package boundary |
| `dist/scripts/studio-host.js` | Loopback HTTPS-proxied application host |
| `dist/scripts/studio-owner-control.js` | Independent Linux/root enrollment/seal management |
| `dist/scripts/runner-worker.js` and every `dist/scripts/studio-runtime/chunk-*.js` | Same-graph finite measurement and shared profile/model identity |
| `dist/src/studio-agents/*.js` as positively listed | Compiled integration artifacts; not independent entrypoints |
| `dist/studio-agent-worker/worker.mjs` | Optional Cloudflare agent code; inclusion does not deploy it |
| `dist/studio-agent-runner.zip` | Attended Windows package; copying does not install or pair it |
| Every listed `explorer/*` file | Browser import closure, including Profile and Build UI assets |
| `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, listed `licenses/*` | Project, bundled and optional-dependency notices |
| `manifest.json` | Exact source/tree, file sizes/SHA-256 and bundle input lists |

Compare every manifest entry, reject missing/extra files or symlinks, and verify hashes before staging. Copying only studio-host.js or omitting the checker/chunks can break measurement. Do not combine generated chunks from another build. Keep old code and matching manifests for compatible rollback. Manifests establish byte identity, not runtime acceptance. See [code release](CODE_RELEASE.md).

## Linux, HTTPS and protected state

Install immutable code under an operator-controlled release directory; run only the loopback listener behind your HTTPS reverse proxy. Use a real certificate for the exact configured public origin and explicitly trusted proxy addresses. Validate the complete installed nginx configuration, Host/Origin/forwarded-header checks, request bounds and readiness. The [nginx example](../../deploy/studio/nginx.conf.example) has 1 MiB operation/preview limits and a separate 128 KiB agent ceiling with longer waits; other routes retain the small default. The [service example](../../deploy/studio/strata-studio.service) is a reader-oriented resource envelope, not qualification of named execution or larger workloads. Do not expose the Node listener directly.

The [host example](../../deploy/studio/host.example.json) deliberately starts unconfigured. For browser ownership, root controls a canonical absolute host.json plus four **distinct, mutually disjoint** paths:

```json
{
  "format": "strata-studio-host/1",
  "public_origin": "https://studio.example.test",
  "trusted_proxy_addresses": ["127.0.0.1"],
  "port": 4174,
  "browser_owner": {
    "control_file": "/etc/strata-studio/owner-control.json",
    "state_directory": "/var/lib/private/strata-studio/owner",
    "key_directory": "/var/lib/private/strata-studio/security",
    "credential_directory": "/var/lib/private/strata-studio/credentials"
  }
}
```

These are example paths/origin, not a live target. Root-controlled configuration/control and ancestors must not be group/other writable. The service cannot write independent control. Private state/key/credential directories are 0700, files 0600, owned by the service identity. Reject links and overlapping paths. On DynamicUser hosts use the canonical private paths, not symlink aliases. Keep namespace catalog/projects and agent state separate from all of these and from code/configuration/accounting. Do not initialize missing established state or rewrite ACLs to force startup.

Launch from the complete release directory:

```sh
node dist/scripts/studio-host.js --host-config /etc/strata-studio/host.json
```

Operator setup runs separately as root with the same protected config. Startup creates no account/key/provider request. Missing control disables enrollment; an independent seal with missing application state blocks recovery.

## Bootstrap the human owner

Use the [browser-owner contract](BROWSER_OWNER_IMPLEMENTATION.md) for exact schemas and arguments. A new installation follows this finite sequence:

1. Operator chooses a fresh installation UUID and runs `studio-owner-control.js --host-config ABSOLUTE_CONFIG --operation arm --installation-id UUID --expected-generation 0` as root. Existing control requires its exact current generation; never reuse zero to erase history.
2. Human opens the exact HTTPS page and requests setup. Confirm its public pairing code over a trusted channel. Keep that browser request open; do not transmit passwords to the operator.
3. Operator inspects current metadata, approves **that exact human-supplied code** using `--operation approve --code HEX32` with current installation/generation, and waits only within the original approval window. Never choose the first/latest logged request automatically. The human then completes the browser prompts with owner name, strong password and host-bound backup acknowledgement.
4. Read `--operation completion`, match installation/approval/epoch and immutable initialization/owner/key/manifest binding, then run `--operation seal` with those exact values and current generation. The browser remains Finishing setup until the independent seal is retained.
5. Sign in normally. Restart invalidates sessions but retains enrollment, ciphertext, keys and semantic records.

Expired/interrupted enrollment retains its original preparation and needs exact `resume-arm` or `reconcile-seal` as appropriate. A stale lease needs a verified stopped process and exact receipt; time alone is insufficient. Password recovery rotates authentication while retaining initialization/key/ciphertext lineage. Do not delete state or initialize another owner over an existing seal.

## Your own Artifacts namespace

Create/select your own existing Artifacts account/namespace through the provider's supported tools. There is no shared public namespace or bundled token. Independently verify actual provider Read/Edit permissions, account scope and automatic creation-token expiry behavior before real writes. Studio enforces namespace scope itself; the account token is not asserted to be provider-restricted to one namespace. See [provider contract](DEVELOPMENT_PROVIDER_CONTRACT.md) and [browser setup](SELF_SERVICE_SETUP.md).

After owner sealing, stop the service for an exact new-lineage preparation. An operator prepares a strict `strata-studio-namespace-policy/1` using [namespace-policy.ts](../../src/explorer/namespace-policy.ts): sealed installation/owner UUIDs, your account/namespace, fresh lineage UUID, named principal/account IDs, explicit lifetime/permissions, finite request/byte/operation/payload/journal limits, max_projects and accepted development provider/token rules. Choose actual bounds; the schema has no implicit account, allowance or token-expiry decision. Validate the complete object with namespacePolicySchema.

For a **new empty catalog only**, `initialNamespaceFiles(policy)` returns initial unapproved `state` and `usage`. Install these as `namespace.json` and `usage.json` in the separate private catalog directory using exclusive creation and protected-file procedures. Install the matching policy as root-controlled JSON, create a separate private projects directory, and add host configuration:

```json
{
  "namespace": {
    "policy_file": "/etc/strata-studio/namespace-policy.json",
    "catalog_directory": "/var/lib/private/strata-studio/namespace-catalog",
    "projects_directory": "/var/lib/private/strata-studio/namespace-projects"
  }
}
```

This fragment augments browser-owner configuration; it cannot mix workspace, managed-source or legacy-reader modes. Startup does not call the initializer or recreate missing ledgers. Do not mutate a bound policy/genesis to grant new authority or initialize over an existing lineage. The historical Python migration/conformance templates require separate reviewed pins and an external helper; they are not new-install commands.

Restart, sign in over HTTPS, save your Artifacts token in Settings, inspect masked metadata and explicitly approve the displayed namespace scope before Connect/discovery. Token saving alone creates no source grant or engine roles. Pause preserves consent/spending; revoke retains the terminal tombstone. Lost creation replies may have spent allowance and created remote objects: inspect the original operation, never blindly repeat create/delete/adopt.

New repository initialization is draft-only unless the operator explicitly provisions the optional [first-project contract](FIRST_PROJECT.md) before creating the lineage, with finite template, single-human roles and actual expiry, separately confirmed by the human. It supplies no independent reviewer separation. Existing repositories need their exact Strata index; [import](BROWSER_IMPORT_DELIVERY.md) preserves historical authors and uses a fresh writer. Arbitrary Git objects cannot reconstruct missing private writer history.

## Optional Windows Codex runner

Use Node 22+ and the reviewed native Codex **0.162.1** executable on a chosen Windows host. Preserve desktop credentials/chats and existing installations. Offline preflight pins binary/experimental schemas, but reports native_qualified false. Qualify exact MXC confinement and private custody on synthetic data; no broad root/extra workspace grants, fallback backend or ACL weakening is implied. See [native setup](../agents/STUDIO_CODEX_S2_HANDOFF.md) and [qualification](../agents/STUDIO_CODEX_WINDOWS_STARTUP.md).

Configure optional host agent storage only through its reviewed namespace contract: `studio_agents` has format `strata-studio-agent-host/1`, canonical disjoint `directory` and immutable `bundle_file`. Omitting it uses the namespace's default setup seam; neither presence nor omission is an execution kill switch. Explicit owner setup initializes agent storage; packaging alone does not. Cloudflare agent deployment is a separate optional action and is not needed to pair local Codex.

1. In Settings choose the local Codex runtime and download the owner-authenticated runner ZIP. Verify its manifest and retain all notices. Extract into a new code directory and run Install.ps1 interactively. The installer selects private local state and does not install a service/autostart.
2. Enter exact HTTPS origin, pairing ID and short-lived one-use code through attended stdin. Existing or pending pairing refuses. Lost pairing replies require reconciliation; never delete the pending marker or rerun pairing blindly.
3. Choose **Sign in to Codex**, complete the official device-code flow in the private runner home, refresh status and choose an actually returned text model. Native account tokens stay on Windows. Artifacts credentials are unrelated.
4. Add the paired connection with explicit limits. Select the project/context in Agent. For an already paired local connection, Start conversation retains the selected-project scope without a repeated Allow/password gate; review that scope deliberately. Other providers retain separate consent. Each turn rechecks owner/project/generation/limits/model.
5. Choose Prepare draft, inspect Before/After and questions, then explicitly **Save as draft**. Verify ordinary draft identity/author/provenance via Review. Generation alone creates no draft and Save grants no publication, candidate selection, validation or Release authority.
6. On lost result/Save delivery use original-operation inspection. Recovery reads retained native identifiers without another inference/save. Stop requests interruption of the original turn; verify terminal outcome and delivery. Completed-before-Stop remains succeeded. Timeout/abort does not establish provider/billing stop.

Keep the console open. Subsequent starts use `node studio-agent-runner.js --state-dir ABSOLUTE_PRIVATE_DIRECTORY`; do not pair again. The exclusive lease, pairing, journals and native home survive code updates. Unknown admission without attributable native identity stays unresolved. Claude installs its own locked SDK and has separate terms/confinement/acceptance; Codex evidence does not qualify Claude.

## Backups, recovery and limitations

Take consistent offline backups with the service/runner stopped under your operating procedure. Back up independent root configuration/control/seal and all associated private owner, encryption-key, credential, namespace catalog/projects, accounting, writer registry, actor policy, output and agent pairing/journal/native-home state as one matching set. Keep encrypted backups private; keys and native authentication must not enter source or public packages. Git/Artifacts history alone does not contain every private writer or idempotency record.

Test restoration on an isolated host with provider access disabled before resuming work. Preserve ownership/modes, exact policy/manifest bindings, revoked tombstones, original receipts and monotonic spending. A code rollback is not a state rollback; older schemas may not understand reserved revocation history. Missing keys, inconsistent seals, unknown outcomes and stale leases require reconciliation, not ledger resets, receipt deletion or automatic retries. Native credentials may require attended reauthentication after recovery.

The current evidence includes a real Codex proposal saved privately, bounded original-result recovery and fresh Stop. The Stop run used instrumented compiled modules; packaged identity was checked separately. Requalify the complete package, HTTPS/Linux custody, account behavior and native machine before your use. Complete integrated **Profile → Build is post-launch work** even though its components ship. Finite profiles, prepared distillation proposals and immutable indices do not promise general application reconstruction, unattended operation or production multi-tenant hosting. A Release is not deployment.
