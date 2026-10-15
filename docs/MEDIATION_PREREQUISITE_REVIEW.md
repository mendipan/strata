# Mediation compatibility requirements

Validating a v0.2 realization does not by itself implement v0.2 selection, approval or Release. These operations require their own versioned authority/binding checks, publication behavior and retained backup closure. The [mediation implementation](MEDIATION_SLICE2.md) supplies the bounded local path.

Maintain these invariants across changes:

- Schema acceptance never grants permission. An unconfigured engine and an inactive restored archive refuse mediation publication.
- Decision payloads, bases, packets and responses bind the complete exact context. A stale policy, report, expiry, case revision or consumed grant cannot mint an endorsement.
- Public/private visibility and author ownership survive loading and backup. Restoring records does not activate identities, grants or old responses.
- Every v0.2 Release rechecks content/asset closure, evidence and separate scope/guardian/Release approvals. Do not pass it through a legacy approval parser.
- Node persistence handles consumption and publication atomically under its local contract. Lost replies cannot consume a grant twice; uncertain provider work is not silently retried.

Use `tests/mediation.test.ts`, `tests/mediation-publication.test.ts`, `tests/mediation-sdk.test.ts` and `tests/backup.test.ts` for current regression coverage. See the [trust contract](SECURITY_TRUST_PLAN.md) for fixture versus hosted authority and [verification](VERIFICATION.md) for commands. Generalized policy programs, hosted identity, active migration and SDK binary/checker parity remain outside this slice.
