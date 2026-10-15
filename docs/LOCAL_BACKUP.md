# Bounded local Node backup and inactive restore

Current reporting correction, 2026-10-04: backup errors remain `ok: false` with their original nonzero exit and `errors` under `--dry-run`. Successful verify/inspect has `data.verified: true`; a successful restore dry-run has `data.restored: false` and no output writes. Human output exposes digests, verification and inactive-state flags, plus the retained record for exact inspection; use JSON for automation. [Current status and dated evidence](IMPLEMENTED_CONTRACT.md).

Implemented 2026-10-04 from the independent local recovery slice in [RECOVERY_WORKFLOWS_PLAN.md](RECOVERY_WORKFLOWS_PLAN.md). This backs up Strata's indexed intent history. Source-code Git history and customer application data have separate recovery scopes.

The supported exporter requires a quiesced, updated Node broker and the explicit `fixture-backup` operator entitlement. This public nonsecret selector is a trusted local fixture, with only backup operations. Reader, author and bootstrap fixtures do not inherit export rights. A full export includes every indexed private draft, so select a destination authorized to receive that project's confidential intent. No real source state was exported by this milestone's tests.

## Commands

Build the current source with `npm run build`. Start the updated `npm run broker:node` once for the intended Node state, then close it gracefully with Ctrl+C. Startup creates a versioned project/model descriptor and holds a cooperative exclusive lease; shutdown drains pending writes/audits before releasing it. Export refuses a live or stale lease and never stops another broker or purges its lock. A legacy state without the descriptor, an SDK SQLite state or an unbound foreign project cannot be exported as Node recovery data.

From a configured project, with its Node broker stopped:

```powershell
$env:STRATA_SESSION = 'fixture-backup'
node dist/src/cli.js backup create --out .strata/backups/recovery-2026-10-04 --max-bytes 16777216 --json
```

The default source is `.strata/node-state`. `--state-dir REL_PATH` explicitly selects another descriptor-bound Node directory inside the configured project. Output must be new or empty and cannot overlap that state. `--max-bytes` is required. Save the returned `manifest_sha256` through an independently trusted channel; a digest copied only from an untrusted bundle does not authenticate it. This command creates no credentials or provider resources.

Verification, inspection and restore work without the original project's configuration or broker. Replace the paths, project ID, manifest digest and exact reference below with the actual export results:

```powershell
$manifestDigest = 'COPY_THE_TRUSTED_MANIFEST_SHA256_HERE'
node dist/src/cli.js backup verify C:\Recovery\bundle --expect-project strata-local-demo --expect-digest $manifestDigest --json
node dist/src/cli.js backup inspect C:\Recovery\bundle --expect-project strata-local-demo --expect-digest $manifestDigest --ref L-hold@1 --json
node dist/src/cli.js backup restore C:\Recovery\bundle --out C:\Recovery\isolated-copy --expect-project strata-local-demo --expect-digest $manifestDigest --dry-run --json
node dist/src/cli.js backup restore C:\Recovery\bundle --out C:\Recovery\isolated-copy --expect-project strata-local-demo --expect-digest $manifestDigest --json
```

`--expect-project` is required for these offline commands. Restore additionally requires `--expect-digest`; verify/inspect without it establish internal consistency only. `backup inspect` without `--ref` shows the verified checkpoint summary; an exact ref returns retained historical record data under the separate full-export operator entitlement. It does not impersonate the recorded owner. All commands support `--dry-run`; create observes quiescence without writing a lease/output, restore verifies and checks the destination without writing, and verify/inspect are always read-only. Create's dry-run result is not a completed backup or an exclusive snapshot guarantee.

## Retained state and verification

The directory format `strata-local-backup/1` includes:

- `manifest.json`: project/model/Node storage format, full indexed scope, checkpoint fingerprint, every root reference, hash/byte inventory, exact profile fingerprints, exclusion list and count of unindexed staging orphans.
- `source.json`: the nonsecret Node project/model descriptor.
- `checkpoint.json`: exact publication entries, historical Layer heads, commit/recovery audits and inert semantic-operation result receipts. No active `requests` field, idempotency keys or personal `contexts` are exported.
- `artifacts/<sha256>.json`: canonical bytes for every indexed record, including private revisions, all considered/rejected/superseded proposals, snapshots/provenance, decisions, approvals, validation evidence, realizations and interaction reports.
- `profiles/<sha256>.json`: the exact supported implementation-profile metadata and template. Realization records themselves retain generated file bodies and output manifests; copying a live generated workspace or executing its template is unnecessary.
- `audit.jsonl`: canonical historical operation audits, excluding personal navigation events.
- `COMPLETE.json`: the manifest digest, written last after copied bytes and closure pass verification.
- `RECOVERY_INACTIVE.json`: a small inert project/digest binding, written before copied history in both export and restore so a partial archive cannot be started as a Node state.

Verification checks canonical JSON, supported model/storage versions, inventory hashes/sizes, immutable reference identity, complete typed references, contiguous owned Layer history/heads, evidence/realization/candidate bindings, pinned profile bytes and recovery source/result fingerprints. It rejects incompatible or missing required assets, conflicting refs, duplicate/escaping inventory paths, links/junctions and unmanifested files. Candidate fingerprints are recomputed without replaying approval liveness or requiring that a historically released candidate remains unblocked today. No model, application template, evidence command or remote fetch runs during verification.

The inventory excludes credential stores, `.env` and other workspace/configuration files, cookies/private keys/tokens, sessions, executable issuer assignments/live delegation and cost grants, provider bindings, queued jobs, personal preferences, unindexed orphans and customer runtime databases. Historical owner IDs, baseline authority manifests and approval references remain unchanged inside canonical records. A retained result receipt is historical data, not a live retry cache.

Recognized repository-token, private-key and explicit secret-assignment patterns inside retained payloads fail closed with `BACKUP_SECRET_DETECTED`; the payload is never silently redacted or echoed in an error. This is a bounded pattern check, not exhaustive secret discovery. Arbitrary private business intent still requires an authorized confidential destination. Source-distillation manifests/blobs not retained in the original store cannot be reconstructed from their digest; recorded traceability/digests are preserved without claiming recovery of those external originals.

## Inactive restore and limits

Restore first verifies the expected project and trusted manifest digest, then copies only into a separate new/empty destination outside an existing configured Strata project or descriptor-bound Node state. It writes `RECOVERY_INACTIVE.json` before any history files and the completion marker last. No `registry.json`, project config, current accounts, sessions, author permissions or runnable request cache is installed. The Node broker explicitly refuses an inactive recovery directory. Historical identifiers are inert evidence; the fixture system cannot authenticate their original authors. Resuming authoring requires a separately approved local trust/configuration binding, which is deferred. Offline `backup inspect` is the supported recovery drill interface.

Bounds: an explicit create ceiling up to 64 MiB, 8 MiB per file, 20,000 records/audit events/receipts, 20,004 inventory files, bounded JSON structure and a 60-second cooperative deadline. Read/structure checks and each copy step enforce the limit; a stalled OS filesystem operation can outlast that cooperative deadline. A source registry or audit file exceeding the per-file cap is rejected even when its projected export would be smaller. Interrupted/failed copying may leave an incomplete directory for operator inspection; it has no valid completion marker and never becomes active. No automatic deletion, overwrite, stale-lock cleanup, resume or retention purge is provided.

Leases protect cooperating updated Node processes. They do not protect against an administrator, hostile same-user filesystem modifications or a legacy process that ignores leases. Hashes and the externally pinned manifest prove consistency of the selected copy, not cryptographic author identity. There is no encryption, signing, crash-durability/fsync guarantee, live/SDK snapshot exporter, remote mirror, identity migration, deployment rollback or enterprise disaster-recovery claim.

## Verification

Run `node --test dist/tests/backup.test.js dist/tests/zcode-recovery.test.js` after building. The isolated restore drill checks exact history, private drafts, evidence/output closure and inactive restored authority.

## Versioned mediation closure, 2026-10-04

[S2](MEDIATION_SLICE2.md) extends backup2 to strict v0.2 flattened Releases, approval/2 (including fixed guardian item scopes), selection basis/packet/response/use, immutable fixture configuration and report/disposition closure. Verification checks exact source hashes, decisions, endorsements, grant/use relationships and asset bytes; missing refs/blobs fail. Historical descriptors remain inert: restore supplies no active assignment, debit balance reset or request-cache permission, and broker startup refuses the inactive copy even with a supplied test issuer. v0.1 backup1 and the original historical readers keep their interpretation. Synthetic asset-bearing and policy-mediated v0.2 Release round trips pass; SDK export and live-account identity migration remain unsupported.
