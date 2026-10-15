# Offline local execution storage

[LocalExecutionStorage](../../src/agent-adapters/local-execution-storage.ts) implements the accepted [CloudflareExecutionStorage](../../src/agent-adapters/cloudflare-execution-journal.ts) transaction/get/put/list port for the [admission core](EXECUTION_ADMISSION_CORE.md) and the separately instantiated [reference service](CLOUDFLARE_EXECUTION_REFERENCE.md). This is a bounded local implementation of [execution/1](EXECUTION_CONTRACT.md), not Studio integration or Cloudflare runtime qualification. Existing journal, request, grant, result and permission formats remain unchanged.

## Trusted construction and custody

Construct from trusted local code with an absolute pre-created private directory and exact `{role, owner_id, connection_id}` binding. Use different directories and storage instances for `host` and `service`. The internal snapshot envelope pins that binding; using a host directory as service state, or changing its owner/connection, refuses. These identifiers bind storage to constructor configuration; they do not authenticate a user or grant execution permission.

```ts
const hostStorage = new LocalExecutionStorage(hostDirectory,
  { role: 'host', owner_id: protectedOwnerId, connection_id: connectionId }, custody);
const serviceStorage = new LocalExecutionStorage(serviceDirectory,
  { role: 'service', owner_id: protectedOwnerId, connection_id: connectionId }, custody);
// Explicit provisioning ONLY, never on startup or as a request/recovery route:
await hostStorage.provisionEmpty();
await serviceStorage.provisionEmpty();
const host = new ExecutionAdmissionJournal(hostStorage, protectedOwnerId, connectionId);
const service = new CloudflareExecutionJournal(serviceStorage, connectionId);
await host.initializeEmpty();
await service.initializeEmpty();
```

Reuse the repository's `privateDir`, `readPrivate`, `withLease` and `noLinks` primitives. POSIX directory/file checks require current process ownership, private mode bits, ordinary files and one file link. Paths reject symlinks/junctions. No ACL, ownership or existing security settings are changed. Private task/output JSON is stored without new encryption or credential access; confidentiality depends on verified directory custody. The checksum detects accidental envelope changes, not hostile administrator modification, authenticated integrity or rollback to a previous valid snapshot.

**Windows requires** a trusted constructor-injected `custody.assertWindowsCustody(directory)` function. Its promise must reject unless the host has independently verified directory ownership/ACLs and inherited file custody. Missing verification refuses construction; it runs before use and after staging. Node mode bits alone do not establish Windows privacy. No Windows verifier is delivered or configured by this slice. The test verifier is explicitly synthetic and checks no ACL; passing those tests establishes no real owner/file confidentiality. On POSIX, included checks also cannot exclude a hostile same-user process, administrator, path replacement race, network filesystem or independently provisioned untrusted ancestor.

## Atomicity and recovery

Each transaction loads and validates the complete authoritative envelope, clones reads/writes/results, bounds JSON and keys, and stages all journal/index/permission/result changes together. The file is capped at 32 MiB, 1,024 keys, 32 JSON nesting levels and 200,000 nodes. Non-JSON/lossy values refuse. Lists sort keys and apply the requested prefix and finite limit. Read-only transactions do not rewrite state; transaction handles close when their closure settles. A failed closure publishes nothing. An aggregate storage bound refuses rather than discards permanent task IDs.

The repository's exclusive `.owner.lock` lease excludes independent cooperating processes. In-process requests queue with a 16-request cap. Another instance/process holding the lease causes a finite `EXECUTION_UNAVAILABLE` refusal; there is no cross-process wait/retry, callback replay, stale-lock stealing or native start inside a transaction. A caller may explicitly reconcile/retry an operation under the existing contract; an uncertain task ID still cannot start again. This is cooperative local exclusion, not a distributed/adversarial lock.

The sole publication point replaces `execution.json` with a complete same-directory stage using synchronous rename after the stage file has been flushed. The optional transaction `beforeCommit(guard)` hook registers the **existing** journal authority guard. Every guarded journal mutation registers it, including the host's status-only observation and first result attachment. Local storage invokes those guards after asynchronous staging, immediately before rename with no event-loop yield. This closes the closure-to-publication gap without inventing a new policy or returning a new grant. Existing structural storage ports may omit the hook; their authority/commit ordering remains separately unqualified.

Invalidation before publication leaves exact committed history unchanged. Invalidation after publication retains the valid committed state and can refuse the caller's response; it does not undo an admission or already started work. A rename followed by directory-sync or lease-release failure can likewise report unavailable after a commit. Original-ID inspection and explicit reconciliation remain necessary; never infer rollback from that error.

Startup reads only explicitly provisioned state. Missing files/headers, corrupt envelopes or incompatible bindings refuse without creating/resetting them. A process crash while holding the lease leaves it in place. Orphan staged files are quarantined by refusing unexpected directory entries, even if someone removes the lease. An interrupted directory requires explicit offline operator reconciliation of the known committed file, stage and terminated process; no repair API is introduced. Tests remove only a synthetic lease after observing child exit to demonstrate these boundaries. They never clear actual owner/service state.

Stage-file `sync()` is used on both platforms; POSIX also synchronously flushes the directory after publication. Windows directory flush is not supplied. These calls and process-exit checks do **not** establish power-loss durability, hardware/filesystem flush guarantees, rollback-resistant history, or crash recovery without operator intervention. No Cloudflare replication/storage eviction guarantee is inferred from local files.

## Focused verification

[The synthetic fixture](../../tests/fixtures/local-execution-storage.ts) composes separate local host/service stores with the published core/client/adapter/service and synthetic native runtime. [Focused tests](../../tests/local-execution-storage.test.ts) cover transaction rollback and clone isolation; atomic host permission/request/index rollback; closure-to-publication and post-publication invalidation; every service mutation's final fence; independent instances and child-process reservation competition with one synthetic native start; restart after admission/native/result commits; crashes before/after rename; stale-lease/orphan refusal; missing/truncated/oversized/checksum and semantic corruption; role/owner/connection substitution; hardlinks and custody-verifier refusal; permanent retention tombstones; and reconstructed admission budgets.

```sh
npm run build
npm run typecheck
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/local-execution-storage.test.js
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/execution-admission.test.js dist/tests/execution-admission-review.test.js dist/tests/cloudflare-execution.test.js
npm run check:links
git diff --check
```

Evidence is offline on Windows/Node 24 with process-local test TEMP/TMP inside the isolated checkout's ignored `.strata/` directory. External fetch is blocked, and children execute only synthetic drivers. The sandbox denied synthetic hardlink creation; that case passed in a focused unsandboxed rerun. POSIX mode/UID and directory-flush paths are included but were not exercised on this Windows host. No production state, credential, provider SDK, cloud identity, service configuration, Studio wiring, native agent runtime, security setting or activation is used or changed. Independent review of the immutable candidate precedes any push or integration.
