# App-only usage-model diagnostic

This mode collects one private app Worker's public model observations. It is debugging preparation, not a full demo, proof of billing treatment or permission to run a paid attempt. It never invokes the app, creates a second Worker, Workflow, repository token or instance, or writes a run grant. Deployment uses the existing private version upload; the uploaded module may undergo provider startup/validation, but the diagnostic sends no request to app logic.

The mode uses the existing bootstrap and finally cleanup. There is no separate runner or recovery path. Historical activations, journals, spending holds and quarantines are never reset.

## Purpose and approval

The disabled-package preparer accepts `--app-model-diagnostic` as its final argument (or `buildChecklistBundle(prepared, output, checkout, false, 'app-model-diagnostic')`). It hashes the diagnostic purpose into the source manifest. Its `approval-package.json` declares one Worker, zero Workflows/instances/repositories/service bindings, diagnostic-only owner decisions and unresolved billing. Both disabled bundles still build for the existing source freeze, but only the app can be uploaded.

```text
node dist/scripts/checklist-cloud-prepare.js <published-snapshot.json> <producer-pins.json> <fresh-target.json> <new-external-package> <successor-checkout> --app-model-diagnostic
```

Generate the reviewed plan with `checklistBootstrapPlan(prepared, sourceSha256, 'app-model-diagnostic')`. It explicitly declares the purpose, one app Worker, no Workflow operation, unresolved billing, no retries, and limits of 13 work plus two cleanup exchanges. Its digest differs from a full-demo plan. The package's frozen purpose must also match the CLI and activation before credentials or HTTP.

A separately approved activation must contain `purpose:"app-model-diagnostic"` and bind that exact plan hash. The existing preparation/source/target/config hashes, owner attestations, common gross budget path, $1 attempt/$20 combined spending limits, expiry and retention fields remain mandatory. The CLI purpose must agree with the activation and plan before credentials or HTTP. A full-demo activation cannot authorize this mode, or vice versa.

After independent source/package review and separate exact approval, the existing entry point accepts:

```text
node dist/scripts/checklist-cloud-bootstrap.js <reviewed-package> <fresh-owner-activation.json> <new-empty-evidence-directory> <successor-checkout> --app-model-diagnostic
```

This document supplies no activation or execution authority. `--preflight` retains its existing full-demo purpose; it is not an alias for diagnostic execution. Unknown flags and extra arguments refuse.

## What one round does

The six existing readiness/collision GETs run once. Account default is retained as bounded context and must pass the existing Standard readiness gate. Only the new private app Worker is created and exact-ID read back. Its exact approved module is uploaded once with the checked top-level `usage_model:standard` JSON field.

The journal then records public model observations from the version-create acknowledgement, exact acknowledged-version GET (`?include=modules`) and named `/workers/scripts/{name}/settings` GET. Version/module identity, exact bytes, compatibility, bindings, CPU/subrequest limits, empty public URLs, deployment at 100%, disabled subdomain flags and observability checks remain mandatory. Any non-model mismatch stops immediately. Only model refusal is deferred long enough to collect both readbacks, and no further mutation is permitted during that collection.

Each observation is appended and fsynced with its response sequence/hash, validated Worker/version identifiers and the approved Worker name. It records presence, type, a public enum only for exact `standard`, `bundled` or `unbound`, and a fixed predicate. Unknown strings and non-string values are `[redacted]`. Missing is distinguished from present-but-invalid. The named settings response is correlated through its exact request name and the just-verified deployment; that endpoint is not itself version-pinned or an atomic snapshot with the version GET.

A paired `strata-app-model-diagnostic/1` journal record is fsynced before entering existing cleanup. It includes source/preparation/target/config/plan/activation pins, all three observations, account-default context and `billing_state:"unresolved"`. The required model check is `match` only when all three explicitly report Standard; otherwise it is `refused`. Neither outcome accepts the configuration or enables a demo. The diagnostic returns `diagnostic_only:true`, `diagnostic_complete:true`, `prepared:false` and `completed:false`, even when all enums agree. An early safety/transport failure returns `diagnostic_complete:false`; any already captured observations remain retained.

After that stop, the existing cleanup deletes only the acknowledged app Worker and reads its exact ID. Ownership, DELETE/GET shape and absence qualification are unchanged; the diagnostic's no-retry bound also applies here. A DELETE acknowledgement/private-entity 404 still does not establish qualified absence or release a hold. Cleanup blockers remain visible in the returned result.

## Bounds

The no-retry request sequence is six preflight GETs, private create, private GET, version POST, exact version GET, deployment GET, subdomain GET and settings GET: 13 work exchanges. Existing cleanup has at most its DELETE and exact-ID GET: two exchanges. This mode bypasses GET retries as well as mutation retries, including during preflight and cleanup. A transient response stops that request rather than triggering another attempt.

The existing spending, per-exchange reservation, 2 MiB version JSON/response, 256 KiB other response, 64 MiB aggregate transfer, CPU/subrequest and runtime ceilings remain in effect. Conservative package/run byte allowances are retained; this mode does not widen or release them.

## Minimal fresh-target preparation requirements

1. Independently review and pin the exact diagnostic successor commit/tree, clean source and compiled/tool dependency graph. Build/typecheck from the unchanged lockfile. Use the existing published Node history as input; do not create another history or run app logic to prepare this diagnostic.
2. Use the existing preparer with its diagnostic flag and a fresh disjoint target in a new external disabled package directory. Retain `account_id`, `namespace` and published-history `project_id`; supply fresh/disjoint `run_id`, `repository`, `app_worker`, `workflow_worker`, `workflow` and `instance_id`. All names checked by the six preflight reads must be unused, although only the app Worker will be created. Do not discover credentials or expand permissions. Both disabled bundles/configs remain locally frozen; the Workflow bundle/config is never uploaded or activated in this mode.
3. Recompute the preparation, source-manifest, target, config and purpose-specific plan hashes. The plan must show one app Worker, no Workflow, 13+2 limits, no retries and unresolved billing. Do not reuse an old full-demo plan, consumed activation, target name or evidence directory.
4. Present that concrete disabled package and exact pins for independent review. Only a later explicit owner approval may create the fresh purpose-bound activation with new timestamps, a new empty external evidence directory and the same owner-bound reconciled shared gross ledger. Existing holds and the consumed historical activations remain intact. Preparation alone must not read a token, reserve money, clear state or dispatch HTTP.

The observations settle what the endpoints reported during that one round. They do not establish pricing equivalence or independently verify invoicing. [Wrangler's deprecated config property](https://developers.cloudflare.com/workers/wrangler/deprecations/#the-usage_model-config-file-property) is not a universal direct REST normalization contract. The [beta create](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/), [version GET](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/) and [settings GET](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/) expose model enums, while [pricing](https://developers.cloudflare.com/workers/platform/pricing/#how-to-switch-usage-models) retains legacy cases. Billing remains unresolved until authoritative interpretation is available.
