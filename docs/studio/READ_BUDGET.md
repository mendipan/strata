# Persistent hosted read accounting

The H1 hosted reader reserves total requests and declared maximum response bytes
against one explicitly approved source grant. Restarting the process must not
renew these totals. This adapter adds accounting, without changing source,
credential, session, account, authoring, or grant authority.

`ReadBudgetReservations` exposes only
`reserve(maximumBytes: number): Promise<void>`. `RestArtifactsReader` accepts it
as its optional fifth constructor argument for compatibility with local readers.
The persistent `scripts/studio-host.ts` launcher requires `read_budget_file`
whenever `connection_config` and `expected_repository_id` are configured. No
source configuration requires no ledger and retains the unconfigured shell.

Reservation occurs after scope and in-memory admission, before accessing a
credential or issuing a provider request. Scope and cancellation are checked
again after the asynchronous reservation. Each reservation charges one request
and the entire declared response bound, including repository identity responses.
Authentication failures, provider errors, cancellation, short responses and
failed identity checks retain their charges. There is no refund or automatic
retry that restores spending.

## Binding and activation

`FileReadBudget(filename, fullConnectionConfig, expectedRepositoryId)` computes
the canonical model SHA-256 of
`{ connection: parsedConnectionConfig, expected_repository_id: exactId }`.
This includes every connection, storage, registry path, policy, principal,
expiry, request limit, byte limit and timeout field. Changing any field or the
immutable repository ID cannot reuse the old ledger.

The strict file format is:

```json
{
  "format": "strata-studio-read-budget/1",
  "binding_sha256": "<64 lower-case hex digits>",
  "reserved_requests": 0,
  "reserved_bytes": 0
}
```

`initialReadBudget(config, repositoryId)` is a pure preparation function. Only
the authenticated operator performing an explicitly approved **new grant
activation** may provision its initial file. The running service never calls
this function to create a file. Settings cannot issue, renew, initialize, zero,
remove or reset a ledger. Missing accounting refuses source startup/access.
An already active grant must retain its existing counts and expiry through
deployment, service restart and credential replacement.

Use a dedicated canonical absolute file path in a private service-owned
directory (0700), with a service-owned regular file (0600), and no symlinks or
junctions in its path. The directory must be disjoint from the connection file,
owner control/state, encryption keys and encrypted credential directories. The
host loader rejects overlap and noncanonical paths. The files contain no token,
password, cookie, provider response or record payload.

## Durability and failure

`ready()` verifies the existing binding and accounting under the exclusive
directory lease. `reserve()` reads the existing counts under that same lease,
checks both approved caps, writes a private replacement, fsyncs its file, renames
it atomically, then fsyncs the parent directory. Only successful completion may
allow credential access. Normal restart reads the committed totals. Multiple
cooperative processes cannot spend the same remaining reservation: a concurrent
or stale lease refuses instead of bypassing exclusion.

An interrupted critical section can leave `.owner.lock`. It is never reclaimed
automatically. The authenticated operator must stop the fixed Studio service,
verify there is no live reservation process, check the exact ledger binding and
retained counts, and reconcile only that exact interrupted lease. Uncertain
spending is retained conservatively; reconciliation cannot lower the counts,
extend expiry or issue a replacement grant without separate approval. The
existing owner lease CLI must not be applied to this directory: it manages a
different protected state contract.

Missing, malformed, oversized, insecure or mismatched state, an interrupted
lease, or failed durable writes return sanitized `READ_BUDGET_UNAVAILABLE` (503).
Exhaustion returns `READ_SESSION_LIMIT` (403); source expiry returns `SOURCE_AUTH`
(403). No underlying path, provider response or secret is exposed. A broken or
leased ledger can prevent source-enabled service startup; removing only the
source connection/pin/ledger configuration under authenticated operator control
can restore owner-only mode while retaining the ledger and all owner state.

The ledger assumes the existing trusted host/operator and cooperative service
process boundary. It does not protect against a malicious host administrator,
compromised service, or a whole-host backup rollback. Restoring older accounting
requires disabling its old grant and exact operator reconciliation; restart is
not a reset path. There is no new privileged helper, network service, database,
write-enabled connector or recurring job.
