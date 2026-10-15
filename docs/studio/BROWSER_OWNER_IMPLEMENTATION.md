# Browser owner implementation contract

This implements the [accepted design](BROWSER_BOOTSTRAP.md) on the isolated browser-bootstrap branch. Deployment, root control changes, real pairing/account/key creation and project grants remain separate exact owner actions. All acceptance fixtures use synthetic state. Production browser-owner hosting requires Linux; Windows fixtures simulate the two filesystem authorities, while the production launcher and operator CLI refuse Windows. Existing local preview, shared-reader, per-action-key credentials and named-actor modes retain their contracts.

## Fixed deployment contract

Root host configuration remains `strata-studio-host/1`. Its optional `browser_owner` object has exactly `control_file`, `state_directory`, `key_directory`, `credential_directory`: four distinct absolute, canonical paths. No path is inside another; no symlinks. Browser-owner mode rejects `access_key_hash_file` and legacy `credential_store`. The existing public origin, proxy addresses and separately authorized connection/repository pin stay outside this object. Missing control means setup disabled; missing application state after an independent seal means blocked recovery.

The control file and every ancestor are root owned and not group/other writable; the nonsecret control file is at most 4 KiB. Service state/key/credential directories are separate private 0700 siblings under an already approved private parent. The launcher may create those empty directories. It generates no account or key at startup. Secret files use 0600 and exclusive creation. Service code cannot write the independent control file. The operator wrapper must pin its host/config/paths; HTTP has no management command/path selector or shell helper.

The deployment adapter must include these static modules in addition to existing assets: `setup.js`, `owner-session.js`, `owner-credentials.js`. Preserve the 1 KiB body limit, existing timeouts and service resource caps. Setup passwords accept 15–128 normalized Unicode code points and at most 512 UTF-8 bytes; password confirmation is client-side only. Token values remain 1–512 printable nonspace ASCII characters, subject to the same serialized 1 KiB request bound. No provider call occurs during startup, setup, sign-in, status or token saving.

## Exact protected record

`src/explorer/bootstrap-control.ts` exports strict `controlSchema` (`strata-studio-bootstrap-control/1`). Required fields are `installation_id`, `enrollment_epoch` (UUIDs), `control_generation` and `expected_owner_generation` (nonnegative safe integers), exact HTTPS `origin`, `purpose` (`enroll-owner|resume-owner-enrollment|recover-owner-password`), ISO `issued_at` / `expires_at` and `state` (`armed|approved|closed`). Arming lasts at most 30 minutes.

An approved record requires exactly:

```json
{"approval_id":"UUID","pending_id":"UUID","browser_cookie_sha256":"64 lowercase hex","reservation_sha256":"64 lowercase hex","scope":"installation-owner","expires_at":"ISO time"}
```

Approval matches an immutable reservation and consumes the arm. Approval lasts at most 10 minutes and never exceeds request/root expiry. Anonymous pending requests last at most 15 minutes; maximum eight requests and five creations/minute. The browser request cookie is 256 random bits; its digest is persisted, and its independent public code is 128 random bits. The public code grants no lookup, cancellation or claim authority. A repeated creation ID cannot create a second pending reservation; an exact retry with the delivered original cookie returns its own request. An uncertain response requires outcome lookup, not automatic commit retry.

An independently retained `owner_binding` has exactly:

```json
{"installation_id":"UUID","initialization_id":"UUID","owner_id":"UUID","key_id":"UUID","initial_manifest_sha256":"64 lowercase hex"}
```

This binds the immutable initial manifest, never current ciphertext or current password pointer. Only a matching seal permits normal owner access. It survives later recovery epochs. `resume` has `initialization_id` / `initial_manifest_sha256`; `recovery` has `owner_id` / `authentication_generation`. Those fields appear only with the corresponding purpose. `close` refuses an approved, unsealed enrollment even after expiry; it cannot erase the consumed anchor and allow a fresh claim. Expired/interrupted approval requires exact reconciliation or prepared resumption.

## Operator utility and external wrapper

The generic CLI is `dist/scripts/studio-owner-control.js`. It is Linux/root-only and accepts pairs of explicit arguments, rejecting unknown/duplicate/missing fields. Every operation needs `--host-config ABSOLUTE_FIXED_CONFIG --operation OPERATION`. Mutations additionally need `--installation-id UUID --expected-generation N` (zero only for absent initial control). The utility takes a root-controlled exclusive lease, rechecks control, atomically writes/fsyncs the record and returns sanitized metadata. An interrupted root lease requires authenticated inspection/reconciliation; time alone never deletes it.

| Operation | Additional exact arguments | Meaning |
| --- | --- | --- |
| `inspect` | None | Nonsecret control and current bounded pending metadata. Malformed/inconsistent state refuses; it is never silently treated as empty. |
| `arm` | None | Explicit first/pre-approval enrollment epoch; refuses a seal or approved transaction. |
| `approve` | `--code HEX32` | Approve only the public code supplied by the human from their own HTTPS page. Never auto-select first/latest/logged code. |
| `completion` | None | Read only the fixed activation pointer and immutable preparation manifest; return the durable receipt below. |
| `seal` | `--initialization-id UUID --owner-id UUID --key-id UUID --manifest-sha256 HEX64` | Within original approval expiry, match the exact completion and atomically retain the independent owner binding. |
| `reconcile-seal` | Same as `seal` | Deliberately reconcile that exact durable receipt after interruption/expiry. Requires a new explicit operator decision; never an automatic expired fallback. |
| `close` | None | Close an unused arm or sealed recovery window, preserving the seal; refuses approved unsealed enrollment. |
| `resume-arm` | `--initialization-id UUID --manifest-sha256 HEX64` | New cookie-bound epoch for an exactly prepared interrupted enrollment; preserves verifier/key/store. Expired unused or approved resume epochs can be renewed only for the same independent initialization/manifest pin. Incomplete preparation, changed installation/pin, outstanding lease or existing activation refuses. |
| `recover-arm` | `--owner-id UUID --authentication-generation N` | New password-recovery epoch bound to the independently sealed owner and exact current auth generation. |
| `reconcile-lease` | `--lease-pid N --lease-sha256 HEX64`; optional `--initialization-id UUID` | Only after the external adapter stops the fixed service, remove its exact stale owner lease if the recorded process is absent. The optional initialization selects only the independently sealed credential-store lease. PID existence or mismatch refuses; no timeout-based deletion. |

`inspect` returns `{format:'strata-owner-inspection/1',control:object|null,pending:[{code,reservation,reservation_sha256}],leases:[{kind,pid,sha256,initialization_id?}]}`. Reservations contain only format, installation/epoch/pending/initialization UUIDs, browser-cookie digest, purpose, expected owner generation and created/expiry times. Lease entries include only the fixed owner lease and independently sealed credential-store lease. No pending CSRF, raw cookie, key or verifier is returned.

`completion` returns `{format:'strata-owner-completion/1',binding:owner_binding,approval_id,enrollment_epoch,authentication_generation}`. The authentication generation is current metadata useful for explicit recovery; the binding stays immutable. The operator never reads actual password verifier files, key bytes or mutable credential ciphertext. Mutation output is `{format:'strata-owner-control-result/1',installation_id,control_generation,state,owner_binding:object|null}`. Errors use one sanitized refusal message and exit 1; success exits 0.

The external authenticated host wrapper should perform **approve**, then wait only until that exact approval's original expiry for **completion**. It compares the installation/approval/epoch and immutable binding, then invokes **seal** with those exact identifiers and the still-current control generation. This is a finite approved operation, not a daemon/recurring task. If interrupted/expired, stop; a later exact human-approved reconciliation can use `reconcile-seal`. The page remains “Finishing setup” until sealing, then ordinary password sign-in. GET outcome polling never creates an owner session. The owner performs no terminal commands and shares only the public pairing code through the established trusted conversation.

For prepared enrollment without activation, the external adapter stops the fixed service before `resume-arm`, reconciles any exact stale lease separately, and restarts after the protected record is committed. This avoids a concurrent activation during reconciliation. Renewal retains the original immutable manifest and its approval identifiers; it replaces only the bounded enrollment epoch/approval. A resumed completion therefore matches the protected `resume` initialization/manifest pin rather than rewriting the original manifest to the new approval ID. An existing durable activation goes through exact seal reconciliation instead.

## Application persistence / session contract

Fixed state files are `pending.json`, `initial-UUID.json`, `auth-UUID.json`, `active.json`, `login-limit.json`, plus an exclusive `.owner.lock`. Keys are `key_directory/UUID.json`; ciphertext is `credential_directory/initialization-UUID/credentials.enc`. Preparation first records `preparing`, then writes verifier, random independent 32-byte key and empty encrypted store; after fsync it becomes `prepared`. Publishing `active.json` is the application commit point; a root seal remains separately required. No fast password/payload digest is persisted. Exact prepared retry verifies the reentered password with the slow verifier and retains all original artifacts. Partial preparation, unexplained files, missing established ciphertext/key or lost activation after sealing refuse initialization. Sanitized outcome exposes the operation UUID only to the original cookie-bound browser so a refreshed page can deliberately resume.

Password change/recovery rotates only the authentication pointer, retaining initialization/key/live ciphertext references. Installation lease precedes credential-store lease. Each credential replay/action rechecks current owner generation and freshness inside serialization and before commit/dispatch. Root seal is not rewritten for password changes. Owner sessions are opaque Secure/HttpOnly/Strict cookies, one-hour absolute / 15-minute idle, maximum four; restart clears sessions. Current generation is checked on every read/action. Freshness is five minutes for credentials and 60 seconds for password rotation after explicit reauthentication. Reader/actor cookies cannot manage owner credentials; owner cookies cannot authorize project writes or grants.

Positive API paths are `/studio/setup`, `/studio/setup/outcome`, `/studio/setup/request`, `/studio/setup/cancel`, `/studio/setup/complete`, separate `/studio/setup/recover`, `/studio/owner/session|login|reauth|logout|password`, and `/studio/v1/owner/credentials`. GET accepts no body/query; POST requires exact Origin, JSON, bound CSRF and 1 KiB. Credential bodies have no manager key or client identity claims. The separately versioned owner projection is `strata-studio-owner-credentials/1`, with `management.authorization:'owner-session'`, masked metadata and `reauth_required`. Shared-reader credential format/routes remain unchanged.

## Verification gate

Build/typecheck, synthetic HTTP transaction/crash/recovery/security regressions, real Edge desktop/mobile tests through synthetic HTTPS interception, existing hosted/credential/actor/read/CLI regressions and an independent immutable boundary review must pass before integration. Synthetic browser tests establish UI/transport behavior, not live TLS/host configuration. Linux host resource and filesystem checks must also run against the frozen bundle. No design/build approval is permission for actual browser pairing, a real owner/key, provider access or persistent grants.
