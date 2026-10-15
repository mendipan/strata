# Namespace migration operator contract

New installations use [self-hosting](SELF_HOSTING.md). The Python migration/conformance tools under deploy/studio are archival **installation templates**, not a generic installer. Public values are synthetic. They require a separately supplied protected hosting helper and exact reviewed source/helper/package/manifest/origin/ledger pins before use. No private helper or live action packet is distributed.

The operator preserves root-owned, non-writable, regular-file and ancestor checks; helper bytes are authenticated before import. Exact package membership, sizes/hashes, host boundary, release pointer, service envelope, owner seal and accounting bindings remain required. Do not replace exact checks with wildcards or accept a new host merely because its config parses. Public synthetic pins authorize no real installation.

Migration changes only host configuration plus a separate approved namespace lineage. It retains owner/key/credential custody, repository history, predecessor catalogs, grants and every ledger. Credential trees are checked by metadata, not opened. Durable intent and custody anchors precede service stop. Recheck approval/custody after stop, install only approved disjoint paths, then verify readiness. Startup grants no namespace consent or provider authority.

Allowance must deduct every predecessor and conformance reservation. Rollback restores only original host bytes while retaining namespace records, spending, projects, login limits and tombstones. There is no refund, ledger reset, historical-writer impersonation or automatic token renewal. Ordinary post-stop failure attempts configuration rollback; power/process loss retains partial files for exact reconciliation.

A stale lease can be reconciled only against its exact package/intent/digest and a dead PID/start/boot identity. Time alone is insufficient. Reapply of a consumed transition and a new UUID beside a retained lineage are refused. Changed custody or unverified stop requires reconciliation, never deletion to make retry work.

The migration packet schema and pure validator remain in [studio-namespace-mode.ts](../../scripts/studio-namespace-mode.ts). [Namespace workflow](NAMESPACE_WORKFLOW.md) documents the reusable service contract. Linux/root operator tests additionally require an external reviewed helper and matching synthetic baseline; Windows packaging checks do not qualify migration or supply that missing dependency.
