# Secure server-side credential settings

The hosted backend stores one Artifacts API token in a small encrypted file. No database/server dependency is needed. It uses Node AES-256-GCM, a fresh random 12-byte nonce and a 16-byte authentication tag on every atomic write; see the [Node cipher API](https://nodejs.org/docs/latest-v22.x/api/crypto.html#class-cipheriv). Encryption protects ciphertext only while the unlock key stays protected. It does not protect against an administrator controlling the running host.

## Separate owner bootstrap

Three independent bootstrap values have distinct purposes:

1. The existing Studio **reader sign-in key**, exchanged for an expiring secure cookie. The host stores only its SHA-256 digest.
2. A different **credential-manager key**, 32 random bytes encoded as 43 base64url characters. Provision only its SHA-256 digest to the host. The owner enters this key for every Settings action; the shared reader key cannot manage credentials.
3. A different **encryption unlock key**, 32 random bytes encoded as 43 base64url characters. Deliver it from a separately managed location to the process through a protected OS credential file. The application never generates or saves it automatically.

The authoritative unlock/recovery key belongs in an owner-controlled password manager, separate key host or equivalent protected mechanism, outside the encrypted data directory. For unattended boot, explicitly choose how that source releases it. Systemd `LoadCredential` can deliver a protected key; `LoadCredentialEncrypted` needs a separately understood host/TPM key policy. A colocated unprotected plaintext key provides no meaningful extra protection. Path separation does not itself prove independent media or a sound backup policy. No master-key provisioning or permission broadening is implicit in application installation.

After those approved bootstrap steps, the owner manually enters the **provider API token** in Settings. That is a fourth value. Agents must not copy an existing development-machine token. The UI must clear both password fields on dispatch and keep secrets out of URLs, browser storage, analytics, logs, errors and exports. HTTPS must be verified before entry. Responses never return a saved token, token suffix, key or hash.

## Generic host configuration

The strict hosted config optionally accepts:

```json
{
  "credential_store": {
    "directory": "/var/lib/private/strata-studio/credentials",
    "unlock_key_file": "/run/credentials/strata-studio.service/store-unlock",
    "manager_key_hash_file": "/run/credentials/strata-studio.service/manager-key.sha256"
  }
}
```

Paths are distinct, absolute and host-supplied. The unlock file must be outside the encrypted store. Links/junctions are refused. On POSIX, the existing state parent/store directories require mode0700 and ciphertext/key/hash files mode0600 or stricter; keys must be owned by the service identity or root. DynamicUser uses private StateDirectory and protected credential delivery; do not broaden permissions. With systemd's DynamicUser layout, the usual `/var/lib/strata-studio` path can be a symlink: verify the process mount namespace and use the canonical private directory shown above when appropriate. Windows needs an equivalent owner-managed ACL because POSIX mode checks are unavailable.

Missing configuration reports `unconfigured`; missing unlock reports `locked`, with token presence unknown. Wrong keys, tampering, unsupported formats or unsafe paths/permissions produce sanitized `error` and refuse writes. There is no plaintext/default-key/environment-copy fallback. A configured encrypted store becomes the launcher's provider source; a locked/empty store never falls back to environment. Existing source grants are checked before credential access/provider dispatch. Save/remove disconnects and invalidates cached/in-flight reads. Storage does not supply project permission: the trusted registry index/export, exact repository/account/project binding, immutable ID pin and explicitly approved bounded expiring read grant remain necessary. No provider read runs at startup.

## API contract for Settings integration

GET and POST `/studio/v1/credentials` require the hosted reader cookie, exact proxy/Host/Origin/fetch checks and no query parameters. POST also requires JSON and session-bound `X-Studio-CSRF`. The local preview exposes no credential route. Responses are `no-store`, **bare JSON**; the 1KiB body bound remains unchanged.

GET returns `format: strata-studio-credentials/1`, `state` (`unconfigured|locked|ready|error`), `revision` (integer|null), `credentials: [{id: artifacts-api-token, configured: boolean|null, updated_at: string|null}]`, `management: {state: unconfigured|required, authorization: owner-key-per-action}`, `capabilities: {save,remove,test}`, `last_test: null|{outcome,verified_at}` and optional sanitized `{code,message}` error. Missing manager setup disables actions independently of store readiness. Configured status is not provider verification.

POST accepts exactly `action` (`save|remove|test`), `credential_id: artifacts-api-token`, current integer `revision`, UUID `request_id`, 43-character base64url `owner_authorization`, and `value` **only for save** (1–512 printable non-whitespace ASCII characters). Unknown endpoints, paths, identities, policy/grant fields or extra values fail before key access. Separate manager authorization is rechecked for every action and replay, before decryption, mutation or provider dispatch; the owner-key adapter allows at most ten attempts per minute per process. The injected `CredentialAuthorization` hook can later verify a distinct named manager's account/principal/project/authentication/policy generations using a server-only context. Reader/authoring grants alone cannot satisfy it.

Save replaces the single token; remove clears it. Test needs a saved token and injected trusted source tester, reuses existing project grants/budgets, has a ten-second deadline and no automatic retry. It returns only `passed|denied|unavailable|error` and observation time, never provider bodies. A test is not semantic validation/evidence. All successful actions increment the CAS revision, including test metadata. POST returns the current masked GET shape plus `replayed` and optional `test` metadata.

The last32 request IDs/digests persist encrypted across restarts. Exact replay repeats neither mutation nor provider test; conflicting reuse returns `REQUEST_CONFLICT`409. Stale revision returns `CREDENTIAL_CHANGED`409. Authorization remains required for replay. The UI should refresh status after uncertain results, retain only action/request ID, avoid automatic mutation retries and retain no secret payload. This finite receipt window is not a lifetime journal.

Other errors: `INVALID_INPUT`400; `CREDENTIAL_MANAGEMENT_REQUIRED`403/429; `CREDENTIAL_STORE_LOCKED`503; `CREDENTIAL_STORE_UNAVAILABLE`503; `CREDENTIAL_TEST_UNAVAILABLE`503; `CREDENTIAL_BUSY`409; and existing session/origin/body errors. Paths, hashes, keys and underlying exceptions are excluded.

## Durability and limits

The store is bounded to64KiB, one token and32 receipts. An exclusive cooperative lease prevents concurrent writers; actions reread disk under it before CAS. Writes create mode0600 ciphertext, fsync, atomically rename, then fsync the directory on POSIX. Interrupted temporary files contain ciphertext only. A crash leaving a lease fails closed until explicit owner reconciliation; no automatic lease deletion occurs. Normal restarts preserve values/revisions/receipts and clear browser sessions.

External rollback of a valid encrypted file is not detected by independent hardware. Removal does not erase backups/snapshots; revoke obsolete provider tokens and apply an owner-controlled encrypted backup/key policy. Losing the only unlock key loses saved credentials. Byte buffers are cleared, but plaintext JavaScript strings can remain until garbage collection; privileged memory inspection is outside this boundary. No automatic key rotation or paid key service is introduced.

Tests use synthetic keys, private temporary stores and mock providers. They cover encryption/tampering/wrong key, masked responses, restart/CAS/idempotency, concurrent writers, stale lease refusal, manager/reader separation, locked setup, sanitized tests, cookie/CSRF/origin/body gates and no provider dispatch before admission. Deployment/tests provision no actual keys or accounts.
