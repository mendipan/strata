# Development repository provider contract

The standard Artifacts write connection addresses a repository by account, namespace and name. Metadata supplies an immutable repository ID, but the documented write-token mint request has no expected-ID precondition. Checking metadata before and after a write cannot exclude a concurrent deletion and recreation under the same name. This optional contract accepts that limitation only for an explicitly approved development repository.

## Explicit selection

An omitted `provider_contract` in `strata-studio-repository-grant/1`, or the value `immutable-id`, keeps the existing strong identity-proof prerequisite. No hostname, bind address, environment variable, browser action or saved token selects the development contract.

The separately approved root-controlled grant must contain `"provider_contract":"development-name-addressed"`. That field changes `repositoryGrantDigest`, including its ledger, control and receipt binding. Changing an existing grant in place does not migrate its established state: the budget refuses a different binding. A separately reviewed cutover must preserve its complete retained lineage and carried spending. Never delete, recreate, reset or zero a ledger to make the new binding pass.

The same protected `workspace.provider_identity_file` must contain a strict acknowledgment with these fields:

```json
{
  "format": "strata-studio-development-provider-contract/1",
  "grant_sha256": "<64 lowercase hex: exact repositoryGrantDigest>",
  "expected_repository_id": "<exact granted immutable ID>",
  "environment": "development",
  "contract": "repository-addressed-by-name",
  "operator_rule": "no-delete-recreate-or-rebind-during-write-or-reconciliation",
  "evidence_kind": "owner-acknowledgment",
  "evidence_sha256": "<64 lowercase hex: protected exact owner decision receipt>"
}
```

This illustrative JSON is not an activation file. The operator must use actual fresh nonsecret hashes and the exact granted repository, not placeholders or a synthetic evidence hash. The acknowledgment binds the full grant: installation, owner, project/model, immutable ID, exact remote/name, import, actor policy, grant generation, lifetime and finite budgets. Another grant or a changed scope requires a fresh approved packet. A development acknowledgment cannot satisfy the strong default; a strong identity proof cannot substitute for the selected development acknowledgment. Root custody checks remain unchanged. The service does not create either file.

## Owner and operator rule

All owners, administrators, automation and other tools with upstream repository-management access must keep that account/namespace/name bound to the same repository. **Do not delete, recreate, rename or rebind it while Studio can write, or while an operation or provider effect remains unresolved.** Keep this exclusion from admission and token mint through Git dispatch, read-back, owned-token cleanup and durable local publication. A failed or timed-out request may still have a late provider effect; process exit, a local lease or a displayed error does not end the exclusion.

Before an intentional repository change, pause admission, quiesce the sole writer and confirm all admitted operations, transports, token cleanup and uncertain effects are reconciled. If certainty is unavailable, keep the repository unchanged and seek explicit operator reconciliation. Do not mint a replacement token, blindly retry a mutation or delete a repository as cleanup. The application has no repository deletion/recreation API, and its cooperative local lease cannot enforce this rule against upstream administrators.

Exact metadata checks still compare ID, name, remote and writable state before mint, after mint, before receive-pack and after dispatch/read-back. An observed replacement fails closed and cleans only a known owned token; it does not retarget or publish local state. These checks detect observed changes and do not provide an atomic provider guarantee.

Settings reports `provider_write_contract:"development-name-addressed"` and `provider_write_contract_accepted:true`, while `provider_identity_verified` remains **false**. It displays the operator rule. Existing immutable-ID metadata remains compatible. Write readiness also requires a live named actor, current owner/session/policy/control/credential generations, an explicit issue/revoke permission test for the saved token, remaining allowance and no unresolved operation. Connection metadata does not fetch the token or contact the provider.

## Remaining activation packet

Approval of this provider choice does not activate persistent access or authorize deployment. A concrete action-time packet must still include:

1. The independently reviewed exact source/build identity and Linux boundary qualification for the changed runtime, plus resource/service constraints.
2. Fresh owner, actor, scope, grant/lifetime and import bindings; a complete quiescent authoritative writer export, protected custody backup and exact single-writer lease recovery decision if needed.
3. The selected development grant and protected acknowledgment digests, proof that the operator controls the no-replacement exclusion, and the exact current name/ID/remote metadata. No claim of immutable-ID token guarantees.
4. The saved credential reference and current encrypted generation/resource-scope verification through the approved protected path; explicit bounded real issue/revoke permission qualification and owned cleanup, without exposing or reentering its value.
5. Carried ledger requests/bytes, immutable lineage, control/journal state, exact proposed protected destinations and a reviewed transition that retains history, tombstones, spending and uncertainty on rollback.
6. Separate owner approval for the exact access/grant/custody/cutover/deployment actions. No fixture receipt, new account/grant, automatic state initialization, ledger reset or stale-lease recovery is implied by this contract.

Full authenticated review, evidence, Release, materialization and the measured behavior loop remain outside this legacy draft workspace, as described in [Persistent hosted workspace](PERSISTENT_WORKSPACE.md).

Provider references: [authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) and [repository concepts](https://developers.cloudflare.com/artifacts/concepts/repositories/).
