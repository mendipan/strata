# Bounded namespace conformance contract

The executor exercises real owner/actor HTTP, repository creation, authenticated bootstrap, draft revisions, restart and immutable readback under an exact supplied provider binding. Public constants are synthetic, not an account or saved credential. It is not a general setup command. See [migration operator](NAMESPACE_MODE_OPERATOR.md).

Exact account/namespace/repository/credential-generation fences, fixed origins, redirect refusal and original-operation journals remain enforced. Bounds are one project, at most 160 requests / 50 MiB total, 50 requests / 16 MiB per operation and 4 MiB payloads. There is no refund, reset, implicit replay, namespace creation, guessed token ownership or unknown-token deletion.

The namespace must exist before creation. Automatic creation-token secrets remain transient and are discarded, not revoked; expiry must satisfy the accepted bound before bootstrap. Lost/malformed creation outcomes remain uncertain. Only known owned token IDs may be cleaned up using prepaid allowance. Reports retain hashes/counts/expiry, never passwords, headers or tokens.

Passed replay returns retained hash-bound evidence without provider/credential access. Running/failed/uncertain replay refuses and preserves writer, ledger, limiter history and outcomes. A new UUID cannot buy another zero allowance. Actual provider conformance requires attended approval and installation-specific repinning; no production conformance is implied by local synthetic tests.

The [builder](../../scripts/build-namespace-conformance.mjs) produces an archival code packet with authenticated dependency bytes. It still needs the private root-owned helper and matched synthetic baseline; public source alone cannot run the Linux wrapper tests. Do not use this packet for fresh-host bootstrap. Use [self-hosting](SELF_HOSTING.md) and independently qualify your account permissions and provider behavior.
