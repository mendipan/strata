# Review and local diagnostics

Strata is source control for intent used by existing orchestration platforms. These commands present current contracts; they do not manage agents or change semantic records.

```powershell
node dist/src/cli.js doctor --project PROJECT --offline --json
node dist/src/cli.js doctor --project PROJECT --human
node dist/src/cli.js review layer L-hold@1 --project PROJECT --json
node dist/src/cli.js review validation VALIDATION_REF --project PROJECT --human
node dist/src/cli.js review authoring-review EXACT_REF --project PROJECT --json
```

## Review

`review TYPE EXACT_REF` supports `layer`, `validation` and `authoring-review`, using the existing authorized inspector. Private drafts remain owner-only. There is no new broker operation or permission. Raw `inspect` responses and stored records retain their existing shapes and digests.

The `strata-review/1` view separates:

- `assertions`: proposed intent/changes/acceptance, author-supplied traceability, and fixture review or authoring attestations. A supplied `observed` traceability label remains an assertion.
- `observations`: structural facts read from the record and **imported** mechanical check outcomes. Validation entries pin the exact target, candidate, realization reference, profile, output tree and evidence digest; checker/fixture/oracle pins are included when present.
- `unverified`: execution authenticity, independent or human review, current disk bytes and behavior outside the named checks, as applicable. The command does not run checks or reassess current Release readiness.

The subject pins the exact inspected record and its digest. A digest identifies content; it does not prove a test ran. `execution_checked` is false. Existing validation and Release operations retain their exact-content checks and required approvals. No language blacklist or prose-policing gate is added.

## Doctor

`doctor` needs no session. It reads project configuration, reuses the CLI's local admission and model/profile compatibility checks, checks declared local identity-label support, and reuses help's advertised CLI capabilities. Runtime capabilities remain `not_checked`; advertised support and configured profiles are not proof that the selected broker can execute them.

The ordinary local CLI permits an omitted `identity_policy`: its loopback broker resolves the supplied session using the configured issuer, including an explicitly configured `HostIssuer` for named accounts. Doctor reports that identity check as **`not_checked`**, rather than requiring a fixture label or claiming named authority was verified. The explicit legacy `trusted-local-fixture-sessions` label passes only the bounded declared-label check; other declared labels fail for this local transport. Doctor never reads keys, sessions, issuer files, grants or the starter lane manifest to authenticate an account. `hosted_identity` verification remains `not_checked`. A successful configuration report cannot repair an expired/revoked account or authorize an operation; use a separate permitted `capabilities`/`status` read for current runtime facts. Hosted HTTPS CLI has its existing separate admission/authentication contract; this local doctor does not contact it or infer hosted access.

Without `--offline`, doctor makes one loopback `GET /health` request with a two-second deadline, a 4 KiB response limit and redirects refused. It calls no operation API, runs no implementation, writes no configuration or state, starts no agents/services, installs nothing and makes no provider calls. `--offline` skips the probe. JSON effects contain no created records, paths or usage; a probe records only `loopback-health` network activity.

Diagnostic states are explicit:

| State | Meaning |
| --- | --- |
| `passed` | The named, bounded check succeeded. |
| `failed` | Configuration or a received health response failed its named check. |
| `unavailable` | A probe could not be read, or the implementation cannot establish that kind of verification. |
| `not_checked` | The check was skipped or not performed by this command. |

Bad configuration returns the existing refusal exit/code where available; unsupported declared profiles/identity or a failed health response return exit 2. Unavailable health and skipped checks retain exit 0 with their explicit partial report. Exit 0 does not mean every capability or artifact was verified. `configuration_healthy` describes configuration only. Local fixture identity and imported evidence cannot authenticate independent execution or human approval.
