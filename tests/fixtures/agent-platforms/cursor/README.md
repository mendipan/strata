# Synthetic normalized Cursor Cloud Agents API v1 execution transcripts

Five synthetic scenarios accompany the [ADAPTER-P proposal](../../../../docs/agents/platforms/CURSOR_EXECUTION_MAPPING.md). These are hand-authored projections illustrating Strata execution/1 DTOs, not wire captures, full native schema conformance, a functioning mapper or a qualified integration. No live API, account or credential is represented, and no `api.cursor.com` request is authorized by these files.

- [transcripts.json](transcripts.json) records synthetic native projections and proposed adapter decisions. The official OpenAPI snapshot, exact reviewed subset, access timestamp, ETag, checksums, selected paths and the documentation inventory are pinned in `pinned`.
- [validate.mjs](validate.mjs) checks shared schemas, identities/digests, transitions, conservative dispatch certainty, the reviewed native vocabulary, normalization fidelity and the claimed source pins (recomputed offline from the retained snapshot), and rejects deliberate result/ref/sequence/artifact/pin/identity substitutions, a mutable branch `startingRef`, a second native create, undocumented native statuses, dispatch downgrades, repository `prUrl` overrides, stale observations, premature or changed result replay, cancellation-target/HTTP-status substitutions, missing recovery assumptions and native/common error-metadata leaks in memory. It neither validates full native messages nor executes a mapper.

## Source and normalization

The interface pin is the official [cloud-agents-openapi.yaml](https://cursor.com/docs-static/cloud-agents-openapi.yaml) read 2026-10-12T10:41:59Z (114,037 bytes, SHA-256 `f61a5671e572d53086360958f9a9f1329548ff0ffc9b0ea3a32c66d6fd3b23ee`, ETag `W/"f2410ec850fd418d9b908666fd079a45"`, OpenAPI 3.0.3, `info.version` 1.0.0). The reviewed working subset is the mechanical path/method selection in [schema text embedded in transcripts.json](transcripts.json) (SHA-256 `f870ccc208c16223c12488fad28d1f7577d5eb79c867ae363ca7187a091fbfc9`), whose facts are recorded in [embedded schema receipt](transcripts.json). These fingerprints are read-time documentation metadata, **not** publisher attestation, a deployed-service version, schema-equivalence proof or tested native behavior. Three official explanatory pages (endpoints reference, API overview, security/networking) were read on 2026-10-12; they are mutable prose, not pins.

All identifiers, text, paths, branches and timestamps are synthetic. Native bodies omit fields and carry explicit `$projection`/`$omitted` markers; they are **not complete native messages** and prove no wire conformance. The pinned `POST /v1/agents` description says creation immediately enqueues the initial run, so the success scenario treats the create reply's `agent`/`run` pair as the single native start. The result summary is normalized from the observed terminal `Run.result` of the exact retained run; the single `branch-diff-001` artifact is an **explicitly assumed retained byte source** for digest illustration, because reviewed native artifact metadata is per-agent, digest-less and not attributable per run. Journal steps describe intended durable decisions, not implemented storage. The secret-pattern check is not a general secret scrubber.

Every scenario represents an already-invoked adapter operation, so errors have dispatch `unknown`, including journal conflict and unresolvable identity lookup. Only a guard refusal before invocation could be `not_dispatched`; none is illustrated here.

The known-identity scenario records `recovery_assumptions`: a dedicated, exclusively controlled agent, no foreign follow-up runs, and initial-run attribution assumed for this synthetic example. With a client-supplied `agentId` reserved before dispatch, it illustrates conditional read-only reconciliation through `GET /v1/agents/{id}` and `latestRunId`; it never re-POSTs. Those markers are assumptions, not native proof. A retained agent ID, `agent_id_conflict` or latest run ID alone cannot establish original-request attribution; without independent attribution proof the admission stays uncertain. The unknown-identity scenario keeps the admission uncertain and blocks every second start rather than guessing a lookup or list matching. The cancel scenario illustrates the documented cooperative race: the cancel POST returns `409 run_not_cancellable` because the run already finished, and completion wins. A cancel receipt is not stop or cleanup proof, and no hard runtime limit is established anywhere.

## Validation

```sh
# Requires the accepted precompiled shared DTOs and their pinned local dependency.
node --import ./tests/no-external-fetch.mjs tests/fixtures/agent-platforms/cursor/validate.mjs
```

Refs, result digests and artifact bytes/digests are re-derived with the [shared helpers](../../../../src/agent-execution.ts). Passing confirms DTO examples, transitions and pin agreement, not that native inputs produce them. No runtime launch, provider call or live API access is authorized by these checks.

The exact public schema subset text and preparation receipt are embedded in `transcripts.json` (`pinned.schema_subset_json` and `pinned.schema_receipt`). The validator needs no preparation-only `reference/` directory or network access. Source path labels in the receipt describe provenance, not files to load.

The reviewed subset repairs four incorrectly decoded em dash descriptions against the retained full official schema JSON. The schema shapes and selected methods are unchanged; the corrected embedded subset has the checksum above. The original preparation subset SHA-256 `5a60d9fd6d2335658a85cafe10637c48fff7c40dc909e6551cbdfeb008237c91` remains in `pinned.schema_receipt.preparationSubsetSha256` for traceability.
