# Creation effects on an operation replay

The local and hosted command clients now present no new creation refs when the broker returns a successful cached operation with `reused:true`. CLI protocol-1 output has `effects.created:[]` and reports the primary result ref in `effects.reused` when that result has a `ref`. The exact result data and operation ID remain the retained original values. Result-level `data.reused` alone does not establish an operation-cache replay.

This corrects the presentation required by [the CLI effects contract](CLI_PLAN.md): the retry reused a committed result rather than creating its historical refs again. It does not change the broker's stored receipt, schema, replay authorization, source freshness, idempotency conflict or approval gates. `operation inspect KEY` retains the original response and its historical `created` list. That list is not a list of new writes performed by inspection or replay.

Only creation-ref presentation changes. `effects.paths` retains its existing command-specific meaning; an artifact or apply path in that list is not proof that a cached call rewrote it. `effects.reused` is the primary result ref, not an enumeration of every historical dependency. Materialization into an existing nonempty directory remains refused. These limits are not changed by retry effect normalization.

## Reproduce in a disposable local project

After build, initialize a supported fixture project using its assigned bootstrap role. Save a valid owned Layer as `LAYER.json`, then use the assigned author role for both calls:

```powershell
node dist/src/cli.js layer create --file LAYER.json --idempotency-key sample-layer --project INTENT_PROJECT --json --non-interactive --offline
node dist/src/cli.js layer create --file LAYER.json --idempotency-key sample-layer --project INTENT_PROJECT --json --non-interactive --offline
node dist/src/cli.js operation inspect sample-layer --project INTENT_PROJECT --json --non-interactive --offline
```

`LAYER.json` and `INTENT_PROJECT` are placeholders for a prepared synthetic fixture. The first response reports its actual new refs. The second has the same result/ref and operation ID, no new creation refs, and the reused primary ref. Inspection retains the first response's historical creation list. Changed input with the same key still refuses; current grant revocation or stale source can still refuse before reuse. An empty creation list neither proves acceptance nor grants a new operation.

Run bounded engineering verification without live host credentials or external fetches:

```powershell
npm run build
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/operation-replay-effects.test.js
```

Tests use new disposable local state and a synthetic hosted account behind a loopback proxy. They prove retained receipts, actual CLI effects, restart, exact-key conflicts and current grant denial. They do not contact a live host, activate grants, execute app code, or establish G2 adoption/output binding, R1 reconciliation completion or V1 Git/model parity.
