# Strata CLI plan

The implemented `studio connections` owner client shares the persistent source API, CAS revisions and receipts with Settings; see [connection management](studio/CONNECTION_MANAGEMENT.md). It does not extend ordinary agent assignment or engine grants. The historical semantic command plan below remains separate.

[IMPLEMENTED_CONTRACT.md](IMPLEMENTED_CONTRACT.md), built CLI help and [BLOCK_CONTRACT.md](BLOCK_CONTRACT.md) describe the implemented subset. The proposed commands below are design directions, not capability claims.

Status: Planning only; proposed public command contract.
Date: 2026-10-03.

## 1. Basis and scope

The CLI should let a person or agent inspect intent, author an owned proposal, compose pinned proposals, evaluate a working realization, and publish a validated semantic Release. It should expose the same rules as the core and Cloudflare agents.

The repository’s [semantic model](../STRATA_MODEL.md) is the design basis. The [implemented contract](IMPLEMENTED_CONTRACT.md) identifies the current subset; commands marked proposed below remain design directions.

Keep three levels of commitment distinct:

| Level | Basis |
| --- | --- |
| Established direction | Durable intent/logic; disposable generated code; shared published reads and owned Layer writes; explicit proposal selection; responsibility follows affected intent; working realizations and evidence before flattening; retained provenance. Model section 1. |
| Interface goals | Human and agent Layer tooling, `mat`/`dist` aliases, shared core checks, explicit local/remote boundaries and bounded provider adapters. |
| Proposed defaults | The model's exact records, authority rules, whole-Layer selection, conservative invalidation, and realization release gate; all command spellings, envelopes, flags, and workflow conventions below. These need coordinated adoption, not an assumption of prior approval. |

The implementation uses TypeScript, a shared engine, local Agents SDK instances and finite example profiles. The CLI should expose those capabilities without treating a particular example as the project identity.

## 2. Small command surface

Prefer semantic nouns for authoring and a few lifecycle verbs. Every command accepts `--help`; `strata --version` reports CLI, protocol, supported model versions, and implemented capabilities. Long names are canonical in documentation and JSON output. Required short names are exact aliases:

- `mat` = `materialize`.
- `dist` = `distill`.
- `flatten` = `release`, preserving the model's vocabulary.

Aliases have identical inputs, effects, and exit codes. No abbreviated-prefix matching, singular/plural aliases, shell-specific shortcuts, or Git-like merge/rebase/push semantics in the MVP.

The following is the proposed contract. File arguments carry versioned JSON records; accept `--file -` for one JSON object on stdin. Human-authored YAML can follow after the JSON contract stabilizes.

| Command | Purpose and effect |
| --- | --- |
| `init --file bootstrap.json` | Initialize local project identity, bootstrap snapshot, and fixed authority manifest atomically. Explicit initialization exception to ordinary owned changes; never overwrite an existing project. No Cloudflare provisioning. |
| `status [--candidate C]` | Read local project, authenticated actor, owned drafts, pending checks/approvals, candidate state, and last known remote state. No refresh, account discovery, or provider calls. |
| `inspect TYPE [REF] [--at SNAPSHOT]` | Inspect a record, or list that type when REF is absent. Types: block, layer, composition, resolution, release, realization, validation, approval. A Block needs an exact snapshot context. Include provenance, ownership, fingerprints, and explicit selected/considered distinctions. |
| `diff LEFT RIGHT` | Structured semantic differences between compatible snapshots or revisions of the same record type. Show changed items and obligations; never infer equivalence from similar prose. Reject unsupported comparisons. |
| `layer create --file proposal.json` | Create an owned draft revision against an exact baseline. Derive owner from the authenticated actor; reject a contradictory supplied owner. Return its immutable draft reference. |
| `layer revise L@r --file proposal.json` | Create a new draft revision of the caller's Layer. L@r is an optimistic concurrency precondition; a newer draft head causes a stale-write error. No implicit rebase. |
| `layer publish L@r [--review review.json]` | Freeze and expose that exact owned revision to authorized project readers. Validate supported operation shapes and authorship; no implicit selection. Distillation drafts require their review record. |
| `compose --file recipe.json` | Pin a new immutable Composition and evaluate it. A recipe contains exact baseline, proposed/selected revisions, scenario, groups, and Resolutions. A well-formed blocked candidate may be retained for inspection, with a nonzero exit. |
| `conflicts C [--report report.json]` | Inspect derived conflicts/unknowns; optionally append an attributed semantic-interaction report. Reports cannot edit intent or waive conflicts. Report changes require fresh evaluation and can invalidate release readiness. |
| `resolve --file request.json [--approval A]` | Seal a Resolution from a frozen decision-only Layer, exact proposal context, and required endorsements. Repeat `--approval` for multiple authorities. Never generate replacement intent inside this command. |
| `materialize TARGET --profile P --out DIR` | Realize an eligible Composition or existing Release with a pinned implementation profile; return a new realization manifest. MVP uses the bounded, local booking profile. |
| `distill --source MANIFEST --against TARGET --layer ID --proposal FILE` | Record supplied distilled intent as a new owned draft, with source traceability and review obligations. MVP accepts a human/agent-prepared proposal; no built-in model call. |
| `validate TARGET --realization M --evidence FILE` | Verify a realization's evidence against all active obligations and semantic checks. Store a validation report. Missing, failed, unknown, or mismatched required evidence fails. No automatic test installation or execution. |
| `approve --file request.json` | Record the caller's authorized endorsement of exact Resolution content or candidate/evidence content. An attestation/control operation; no semantic edits. |
| `release C --validation V --approval A` | Re-evaluate the exact candidate and evidence/endorsements, then atomically flatten a validated candidate to a Release. Repeat approvals as needed. No deployment, remote upload, or automatic baseline switching. |
| `config show` | Explain effective local configuration and its source, with secrets redacted. Configuration mutations can use ordinary file editing initially. |

This is the complete first public surface, not a requirement to implement each command simultaneously. Common inspection and file input avoid five separate CRUD APIs. A Block is read through a snapshot and changed through its author's Layer; there is intentionally no `block set` that mutates a baseline.

References in stored records are exact. Proposed display syntax is `id@revision` for revisioned objects; Releases use immutable IDs. CLI JSON also supplies structured `{type,id,revision,fingerprint}` references, with inapplicable revision fields omitted. An ambiguous bare Layer ID, `latest`, moving branch, or abbreviated fingerprint cannot enter a Composition, Resolution, approval, or Release. Friendly labels are display metadata.

## 3. Ownership, drafts, and deterministic composition

### Identity and writes

Ownership is enforced in the shared application service, not just command parsing. A supplied `--actor`, owner field, agent instance name, filesystem path, or identity in JSON is not authentication. Local MVP fixture identities come from the core plan's trusted broker and are clearly marked `trust_mode: local_fixture`; production credentials and tenant identity remain later work.

The local demonstration proves service-level ownership, not security against another process with write access to its filesystem. Agents receive project read access and their own Layer write capability. They do not receive a general project-store writer or broad Artifacts credentials. A scope authority proposes behavioral changes and decisions in its own Layer too.

A draft handle points to immutable draft revisions. Each accepted create/revise operation makes a revision; editing a proposal file alone has no semantic effect. Publication freezes a selected draft revision without changing its content. A collaborator copies relevant intent into a new owned Layer with `derived_from` and declared dependencies. Publication permission does not imply composition-selection, scope, guardian, or release authority.

Selection and endorsements are checked against the baseline's pinned authority manifest. Reparenting cannot reduce required approvals. The MVP has no ownership-transfer or governance-edit command.

### Composition contract

Implement the model's evaluation sequence, using the core's single canonicalization convention:

1. Pin exact inputs and the model version; check owner, manifest, common baseline, and fingerprints.
2. Check whole-Layer selection, group cardinality, dependency closure, cycles, and Resolution outcomes.
3. Check operations against the pinned baseline, including required peer reads.
4. Normalize Layer acceptance before collisions; derive changes as a set, retaining all coalesced origins and obligations.
5. Check the full tree, references, declared constraints, invariants, final-state assumptions, and reported interactions.
6. Expose missing behavioral evidence and approvals. Derive `blocked`, `eligible_for_validation`, or `validated`; never accept a user-set state.

Reordering selected/proposed sets cannot change their effective result. Ordinary list values remain ordered. Map keys do not supply precedence; strings remain exact. The core plan proposes domain-separated SHA-256 over documented canonical JSON, sorting schema-declared sets and retaining ordinary list order. The CLI must consume that implementation and its test vectors, not invent a second hash algorithm.

Same-target differing writes conflict. Identical eligible writes can coalesce with all provenance and obligations; two creations with the same Block ID still conflict. Unknown prose interactions need recorded review. Locality routes responsibility, not semantic precedence.

The first core milestone supports `set_item` and Layer-acceptance normalization. Other operations, including create/delete/remove/reparent, must return `UNSUPPORTED_CAPABILITY` until implemented. Baseline initialization supplies the complete demo tree. Advertise this subset in help and version output; do not label the MVP full v0.1 conformance.

## 4. Conflict inspection and decisions

A conflict report should include stable kind/code, exact contributors, semantic item targets, the relevant baseline values, proposed values, affected consumers/constraints, responsible scope, guardians, and missing decision/evidence. Use typed target fields rather than requiring agents to parse a slash-delimited display label. Large values may use content references retrievable through `inspect`.

Conflict identities bind the input context and normalized conflict descriptor; they must not depend on discovery order or display text. The engine owns this convention. Explicit interaction reports retain reporter identity and source references. A new report cannot be silently ignored by a previously generated validation report.

Resolution workflow:

1. Inspect the blocked candidate and its complete considered proposal set.
2. An actor authors and publishes a decision-only Layer with outcome and rationale. It cannot also carry behavioral edits or new acceptance definitions.
3. `resolve --dry-run` calculates the exact endorsement payload, affected scope, and required authorities without persisting anything. A request identifies the frozen decision Layer and pinned proposal context.
4. Each required authority uses `approve` on that payload. The endorsement binds the proposed Resolution content and the model's input fingerprint, before an endorsed Resolution exists; it does not require a circular reference to its final fingerprint.
5. `resolve` verifies those endorsements and seals the record. A new `compose` recipe pins it and makes a compliant selection.

Allowed outcomes remain whole-proposal select/reject, evidence-backed coexistence, selection of an already-authored replacement, or defer. Defer leaves the candidate blocked. Coexistence cannot legalize a structural collision or waive a failed assumption/invariant.

For a 900-versus-1200-second expiry disagreement, choosing 1050 requires a separately owned behavioral Layer with consistent requirements and criteria. Include that frozen replacement in the proposal set before endorsing its Resolution. The original decision-only Layer need not be behaviorally selected.

The Resolution input fingerprint includes baseline, model version, scenario, groups, and the complete considered proposal set; it excludes selection and Resolution references. Adding even an unrelated considered Layer invalidates the old decision under proposed v0.1. Changing selection creates a new candidate fingerprint and invalidates candidate evidence/approvals. Never repair stale references automatically.

## 5. Materialization and distillation

### `strata mat`: intent to an inspectable realization

Input is an exact eligible Composition or immutable Release, plus a pinned implementation-profile reference. A profile identifies the materializer/template version, supported semantic vocabulary, toolchain/lockfiles, configuration, output manifest format, and validation methods. It is an implementation recipe, not application intent and not a source of extra authority.

MVP behavior:

- Read and verify all candidate inputs locally. A blocked candidate cannot produce a purported complete realization; partial diagnostic exports, if later supported, need a distinct status.
- Use the core plan's fixed `booking-v1` profile to generate the executable hold/reminder application. Unsupported intent fails explicitly; do not drop unsupported requirements or reinterpret prose.
- Require a new or empty output directory and refuse overwriting unrelated files. A matching cached realization may be returned only when its complete inputs and output digests verify.
- Record candidate/Release fingerprint, profile fingerprint, exact output-tree digest, generator/tool versions, fixtures, origin, and execution conditions. Do not auto-start a preview server or open a browser.
- The generated application exposes hold/advance/inspect for actual human evaluation. Acceptance checks run against its output, and their observations feed `validate`.

The profile may be deterministic within its declared supported vocabulary and pinned environment. This does not imply deterministic arbitrary AI generation. A later Cloudflare model-backed materializer must record provider/model identifiers as available, prompts and tool context by protected reference, parameters, budgets, output artifacts, and limitations. Seeds and temperature settings are not proof of reproducibility. Every distinct output needs its own evidence.

Re-materializing a Release with another profile does not rewrite the Release or inherit evidence for the old output. New realization attestations reference the immutable Release. Human edits to generated code create a different realization digest and invalidate affected evidence. They can motivate distillation but do not silently alter durable intent.

### `strata dist`: observations to a proposed Layer

Distillation interprets source material and records a proposed change to intent. Source may be a named code tree, a tested realization plus modifications, requirements documents, or observations. The source manifest explicitly enumerates authorized inputs and digests; do not crawl the entire workstation, credentials, or unrelated repositories.

MVP `--proposal` accepts an already prepared semantic proposal from a person or external agent. The CLI checks record shape, provenance, baseline compatibility, and owned destinations; it does not pretend to have inferred intent merely by accepting a file. Output names the producer and `method: supplied_proposal`, and remains an unpublished draft.

The distillation result carries:

- Exact source fingerprints and applicable earlier candidate/realization/profile references.
- Proposed Blocks/items, requirements, criteria, relationships, declared required peer reads, assumptions, and extraction lineage.
- Traceability from each proposed semantic change to source locations or explicit human decisions.
- Separately labeled observed behavior, inferred intent, proposed correction, uncovered behavior, contradictions, and unresolved questions.
- A review checklist covering intent versus incidental implementation choices, accidental bugs, missing dependencies, interactions, and acceptance adequacy.

No model confidence score grants authority or resolves an unknown. Publication requires review bound to the exact draft/source fingerprints; unresolved questions material to intent block publication in this proposed workflow. Publication still does not confer compatibility or release readiness.

When `--against` is a Composition, its baseline anchors the new Layer and operations still expect baseline values. Required peer behavior must be declared explicitly. A proposal cannot patch a Block introduced only in another unreleased Layer; request a replacement creation proposal or a new baseline workflow. In the initial subset, unsupported cases fail explicitly.

There is no round-trip claim that distill(materialize(intent)) equals the original intent, nor that materialize(distill(code)) reproduces the original code. Review plus bounded behavioral evidence is the bridge. A richer agent-driven distiller is deferred behind model/data/budget approval; it must keep this same owned-draft output contract.

## 6. Validation, approval, and Release boundaries

Validation reports distinguish individual results (`pass`, `fail`, `unknown`, `missing`) from overall candidate state. A passing collection of tests alone does not mean `validated`.

Each result binds the exact candidate, profile, realization digest, criterion/check version, fixture/input references, observed outcome, and executor/reviewer identity. Every active Block criterion and normalized Layer obligation must be accounted for. Prose consistency, undeclared-interaction risk, and criteria marked `review` require recorded review; a comment saying "looks good" cannot replace a mechanical criterion's missing execution.

The MVP imports evidence from the bounded profile's actual test runner and manual review records. Check provenance and the trusted executor/reviewer against the local trust policy. Arbitrary JSON claiming a pass is not independently verified execution; label imported/fixture trust accurately. Later execution adapters may collect evidence directly, but importing a result must never run commands embedded in that result.

`validate` succeeds when its semantic and behavioral checks pass. It may return `candidate_state: eligible_for_validation` and outstanding authority approvals. This is explicit in both text and JSON: `checks_passed` is not a new model state. `release` rechecks all evidence plus supplied endorsements and requires the derived state `validated`.

Approval request kinds:

- **Resolution:** exact frozen decision proposal, input fingerprint, impact set, outcome, and rationale. Authorities endorse the unsigned payload; the final record incorporates these endorsements.
- **Candidate/release:** exact Composition fingerprint and evidence-set digest, specifying the scope, guardian, and/or release role exercised. The authority manifest determines which roles are required. Binding the evidence set avoids approval of a subsequently changed test report.

Approval records are append-only attestations, not self-declared booleans. Reject unauthorized, malformed, wrong-context, or stale approvals. Fixture approvals must be labeled as demo records, never represented as the user's real endorsement.

Release is a transaction over complete semantic content, provenance, all inherited obligations, decisions, evidence, and approvals. Follow the core plan's stage/verify/index-publication boundary. A failed stage creates no discoverable Release. An interrupted response after a successful publication is recovered by querying/retrying the same idempotency key, not by minting another semantic result.

The same pinned candidate, evidence, and approvals identify the same Release. A repeated operation returns the existing result. A Release neither deploys a program nor moves an environment pointer. Choosing a newer baseline is explicit in the next Layer/Composition. Removing a previously flattened Layer from selection does not revert its inherited intent.

## 7. Machine contract and noninteractive behavior

### Common options and I/O

Proposed MVP common options: `--project PATH`, `--json`, `--non-interactive`, `--offline`, `--dry-run`, and `--idempotency-key KEY` for mutations. In this MVP, offline is the default: local files and the explicitly configured loopback Agent broker are allowed, external services are not.

All commands are noninteractive by default, including on a terminal. Missing required inputs return actionable errors. Never open an editor, browser login, pager, fuzzy selector, or confirmation prompt implicitly. `--non-interactive` makes that expectation explicit for automation; `--json` also enforces it. There is no `--yes` that bypasses semantic authority, spending, or network controls.

Human output is concise: result/reference first, candidate state, affected items, remaining blockers, and suggested next commands. Honor disabled color; do not encode meaning only in color. Machine output uses UTF-8, one JSON envelope on stdout, and newline termination. Diagnostics/progress go to stderr; secrets, provider tokens, and source contents are redacted by default. Command results must not mix banners or test logs into JSON stdout.

Every envelope has:

| Field | Contract |
| --- | --- |
| `protocol_version` | CLI wire-schema version, distinct from model version and executable version. Initial proposal: `"1"`. |
| `command` | Canonical command name, even when invoked through an alias. |
| `ok`, `exit_code` | Success of this requested operation and matching process code. |
| `mode` | `apply` or `dry_run`. |
| `operation_id` | Stable operation identity when applicable; null for unpersisted inspection/dry-run. Not part of semantic fingerprints. |
| `data` | Command-specific typed result, including exact references and derived state when relevant. |
| `errors`, `warnings` | Arrays of stable typed diagnostics. Empty arrays remain present. |
| `effects` | Created/reused references, local paths affected, network actions, and known usage; disclose partial operational effects even when evaluation fails. |
| `next_actions` | Structured suggestions with command/arguments and reason. Suggestions are never executed automatically. |

Illustrative failure shape; the references below are explanatory placeholders, not fixture hashes:

```json
{
  "protocol_version": "1",
  "command": "compose",
  "ok": false,
  "exit_code": 5,
  "mode": "apply",
  "operation_id": "op-example",
  "data": {
    "composition": {"id": "C-conflict", "revision": "1"},
    "candidate_state": "blocked"
  },
  "errors": [{
    "code": "ITEM_WRITE_CONFLICT",
    "message": "Two selected Layers propose different expiry requirements.",
    "retryable": false,
    "target": {
      "block": "booking.hold",
      "collection": "requirements",
      "key": "expiry"
    },
    "contributors": ["L-hold@1", "L-alternative@1"],
    "details": {"conflict_id": "conflict-example"}
  }],
  "warnings": [],
  "effects": {
    "created": ["C-conflict@1"],
    "reused": [],
    "paths": [],
    "network": [],
    "usage": []
  },
  "next_actions": [{
    "command": "conflicts",
    "arguments": ["C-conflict@1"],
    "reason": "Inspect the affected scope and contributors."
  }]
}
```

Messages are for people; agents branch on codes and typed fields. Error details include field paths, expected/observed fingerprints, required capability, missing evidence, or approval scope as appropriate. Do not include secret values. Deterministically sort set-like diagnostic collections; timestamps and operational IDs are outside semantic equality.

Protocol v1 permits additive optional fields; consumers ignore unknown fields. Renaming fields, changing types/meaning, or removing enum values requires a new protocol version. Unknown normative input fields fail schema validation; do not silently discard semantics. A named `extensions` container may be reserved for explicitly non-normative metadata. Publish JSON schemas and CLI examples with implementation.

Lists use explicit `--limit` and `--cursor`, a stable ordering, and `next_cursor`; never silently truncate. `inspect` returns full normative records or explicit retrievable content references, not a lossy summary presented as a record. Diff distinguishes additions, removals, changes, and provenance-only changes.

### Exit codes

| Code | Meaning | Example stable error |
| --- | --- | --- |
| 0 | Requested operation succeeded | An inspection can succeed while describing a blocked candidate. |
| 1 | Unexpected internal failure | `INTERNAL_ERROR`; safe diagnostic identifier, no raw secrets. |
| 2 | Invalid invocation or record shape | `INVALID_ARGUMENT`, `INVALID_RECORD`. |
| 3 | Referenced object/project is absent | `REFERENCE_NOT_FOUND`; no automatic fetch. |
| 4 | Authentication or authorization failure | `AUTHENTICATION_REQUIRED`, `NOT_LAYER_OWNER`, `AUTHORITY_DENIED`. |
| 5 | Conflict, stale write/reference, or semantic composition blockage | `ITEM_WRITE_CONFLICT`, `STALE_REVISION`, `REQUIRED_LAYER_MISMATCH`. |
| 6 | Required validation or release endorsement incomplete/failed | `EVIDENCE_MISSING`, `EVIDENCE_MISMATCH`, `RELEASE_APPROVAL_MISSING`. |
| 7 | Execution/network/cost authorization or budget required | `NETWORK_APPROVAL_REQUIRED`, `COST_APPROVAL_REQUIRED`, `BUDGET_EXCEEDED`. |
| 8 | Feature/model/profile outside implemented capabilities | `UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_MODEL_VERSION`. |
| 9 | Storage, transport, or executor failure | `STORE_UNAVAILABLE`, `EXECUTOR_FAILED`, `TIMEOUT`; retryability explicit. |
| 130 | User cancellation/interruption | `CANCELLED`; report whether work had already committed when possible. |

For a completed diagnostic collection containing multiple categories, proposed primary-code precedence is 4, 2, 8, 3, 7, 5, 6, then 9; retain all authorized diagnostics. Internal failure (1) or interruption (130) overrides that result. Short-circuiting returns the first failed prerequisite phase. Adopt this rule with the core schema before coding clients. Do not retry authorization, semantic, or evidence failures blindly. A timeout does not prove that publication or a future remote job did not happen.

Mutations support request-digest-bound idempotency keys. Reusing a key with changed input is a conflict. Repeated Layer publication and Release flattening return the existing exact object. Retrying materialization reuses a verified result of the same operation; deliberately asking for a fresh nondeterministic generation must use a new operation identity.

## 8. Dry-run, network, and cost controls

Every mutating command accepts `--dry-run`. Pure inspection accepts it as a no-op and reports dry-run mode. Dry-run reads local inputs, checks known prerequisites, and reports the exact intended record changes, paths, execution steps, missing approvals, and unresolved cost assumptions. It does not create drafts, update caches, obtain tokens, call models, provision resources, start previews, or probe account APIs.

A valid plan may return `ok: true` with `execution_ready: false` and explicit approval blockers. This is planning success, not permission or execution success. Malformed/unauthorized inputs still fail. Snapshotting source inputs for real execution rechecks their digests against the reviewed plan; changed inputs require another plan.

Local MVP commands must not trigger implicit installs, remote bindings, telemetry, package update checks, fallback model calls, or deployment hooks. Only the reviewed built-in local materializer is supported; arbitrary profile scripts are deferred. Test execution happens through the separately reviewed core runner, with no untrusted commands taken from evidence.

For later remote operations, reserve a reviewed execution-plan/grant contract:

1. Generate a local plan identifying the actor, project, exact inputs, data leaving the device, destination/account, actions, resources, model/profile, retry limits, and continuing storage/runtime obligations.
2. Mark cost estimates as known/unknown, with currency, pricing date, quantities, per-run ceiling, and storage/retention assumptions. An included allocation or billing alert is not a spending cap.
3. Require separate explicit network and cost approval bound to that plan, principal, limits, and expiry. Reuse a valid scoped grant rather than asking again for every already-authorized step. Semantic `approve` endorsements cannot substitute for an execution grant.
4. At execution, revalidate the plan and grants. Atomically reserve the permitted operation/token/time budget across retries and parallel jobs before dispatch. A caller-supplied flag cannot create authorization.
5. Refuse unknown or unenforceable exposure under a zero-charge policy. A future `--max-cost` is a request ceiling, not a guarantee that the provider enforces account billing limits. Check usage and stop before another action can exceed the approved bounded plan.
6. Cancellation stops subsequent actions and attempts to cancel active work; already-incurred charges or retained storage do not disappear. Report remaining resources and approved retention explicitly.

Concrete future spellings such as `--apply-plan`, `--network-approval`, and `--cost-approval` are reserved proposals, not implemented flags. They should consume one shared policy contract rather than grow ad hoc booleans per command. Provision/deploy commands are outside this CLI MVP. Existing Wrangler login stays untouched; login is neither identity for Strata nor permission to spend.

Provider pricing and account prerequisites are external to this contract. Consult [Cloudflare Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) before an authorized remote run; included allocations never grant provisioning or spending authority.

## 9. Example workflows

These examples describe the proposed interface, not commands available today. Names/revisions are illustrative; callers must take actual immutable references from each preceding result. All input JSON files contain complete records conforming to the core model and authority manifest.

### A. Local hold/reminder lifecycle

```text
strata init --file fixtures/booking/bootstrap.json --offline
strata layer create --file fixtures/booking/hold.json
strata layer publish L-hold@1
strata inspect layer L-hold@1 --json
strata layer create --file fixtures/booking/reminder.json
strata layer publish L-reminder@1
strata compose --file recipes/hold-reminder.json --json
strata mat C-ready@1 --profile booking-v1@1 --out .strata/realizations/hold-reminder --dry-run
strata mat C-ready@1 --profile booking-v1@1 --out .strata/realizations/hold-reminder
strata validate C-ready@1 --realization M1 --evidence evidence/hold-reminder.json --json
strata approve --file approvals/booking-scope-request.json
strata approve --file approvals/release-request.json
strata release C-ready@1 --validation V1 --approval A-scope --approval A-release --dry-run
strata release C-ready@1 --validation V1 --approval A-scope --approval A-release --json
strata inspect release R1
```

Run authoring as A and B through their separate broker-authenticated sessions; run selection and approvals as the baseline-authorized principals. These identities are not flags on the commands. The reminder proposal pins the exact hold revision and its 900-second assumption.

Between materialization and validation, a person must run the emitted application and the profile's actual checks: competing holds, no reminder at 839 seconds, reminder once at 840, active hold at 899, expiry at 900. The evidence file includes these observations and required manual interaction review; it is not fabricated by the example. Before endorsements, validation can report passing checks with release approvals still pending.

The next recipe explicitly names R1 and selects no Layers. Its snapshot retains the flattened 900-second hold policy, reminder behavior, and obligations.

### B. Competing intent

```text
strata layer create --file fixtures/booking/alternative.json
strata layer publish L-alternative@1
strata compose --file recipes/conflicting-expiry.json --json
strata conflicts C-conflict@1 --json
strata layer create --file decisions/select-hold-reminder.json
strata layer publish L-decision@1
strata resolve --file decisions/resolution-request.json --dry-run --json
strata approve --file decisions/endorsement-request.json
strata resolve --file decisions/resolution-request.json --approval A-decision --json
strata compose --file recipes/resolved-expiry.json --json
```

The initial compose returns exit 5 and retains its inspectable candidate. The considered set contains hold, reminder, and alternative; the final selection retains hold/reminder and rejects alternative. The decision request and endorsement request describe the identical frozen payload calculated by dry-run. The resolved recipe pins the resulting Resolution. Run materialization and validation for this new candidate before release; evidence from a different recipe is stale.

To choose 1050 seconds instead, author a replacement behavioral Layer first, repair dependent reminder intent/assumptions, extend the proposal set, and obtain fresh decision endorsements. Layer order cannot make 1050 appear.

### C. Distill a reviewed code experiment

```text
strata dist --source experiments/changed-preview.manifest.json --against R1 --layer L-correction --proposal proposals/correction.json --dry-run --json
strata dist --source experiments/changed-preview.manifest.json --against R1 --layer L-correction --proposal proposals/correction.json --json
strata inspect layer L-correction@1 --json
strata layer publish L-correction@1 --review reviews/correction.json
strata compose --file recipes/correction.json --json
```

The prepared proposal and review separate intended correction from accidental output behavior. Continue through a fresh realization, validation, approvals, and Release. Neither distillation nor code edits rewrite R1. If an experiment is merely an implementation fix for unchanged intent, record and validate a new realization instead of inventing a semantic change.

For A/B exploration, create two recipes with the same explicitly considered alternatives and distinct pinned scenarios/selections. Each gets its own realization/evidence. Selecting a winner is an authorized decision; runtime traffic splitting is not implied.

## 10. Configuration and storage

Proposed tracked configuration: `strata.config.json`, containing schema/model version, project identifier, local broker endpoint, artifact adapter selection, and named pinned profiles. Coordinate the filename/layout with the core owner before implementation. No identity secrets, provider tokens, spending grants, or mutable "current baseline" inside semantic records.

Ordinary presentation/path preferences use explicit flag > allowlisted environment variable > project config > user config > default. Security policies combine restrictively: project/child-process input cannot relax a user's network denial or raise a grant's budget. `config show` reports effective values and origins without exposing secrets.

| Concern | Proposed default |
| --- | --- |
| Project discovery | Nearest enclosing explicit project config, or `--project`; ambiguity fails. Never silently operate on a neighboring repository. |
| Input references | Exact references in the operation, not a hidden current Layer/candidate. No background latest-resolution. |
| Network | Offline; configured loopback broker only. Remote origin and project must be explicit in future operations. |
| Profiles | Named pinned local profile definitions; all behavior-affecting configuration enters the pinned profile/scenario before evaluation. |
| Identity | Broker-authenticated actor; local demo principals labeled as fixtures. Production credential provider deferred. |
| Secrets | User credential store or scoped environment references; never a committed config, JSON result, shell argument, or artifact tree. |
| Runtime paths | Core plan's ignored `.strata/` for local Agent state, local artifact store, realization outputs, and evidence. Treat the semantic store as durable local data, not disposable cache. |
| Publication | Local project index by default. Local `layer publish` means available to local authorized project readers, not uploaded publicly or to Cloudflare. |
| Cleanup | No automatic deletion of semantic history, evidence, or realizations needed by a Release. Retention/GC policy deferred. |

Normalize paths and reject path traversal or links escaping explicitly authorized input/output roots. Agent input must never cause evaluation of shell snippets. Source scans use manifests with explicit includes; exclusions alone are not a reliable data boundary. Concurrent draft writes and output-path collisions fail rather than overwrite.

Runtime config cannot change canonical comparison, active acceptance obligations, authority, or selection precedence. A future "fast" mode may reduce output detail, never skip required release checks.

## 11. Cloudflare and shared-code integration

Cloudflare is required in the intended system. The first milestone already uses the real Agents SDK locally, while the Artifacts adapter uses the core plan's persistent local fake. A local fake is a test boundary, not a replacement of the required Artifacts product.

| Boundary | CLI responsibility | Core/Cloudflare responsibility |
| --- | --- | --- |
| Semantic engine | Parse/validate inputs and render typed results. | One pure implementation of records, hashes, composition, conflicts, authority, evidence gates, and flattening. |
| Owned proposal service | Send authenticated create/revise/publish requests; never write around ownership checks. | Local `LayerAgent` owns each Layer; `ProjectAgent` handles registration, shared published reads, selection, and Release publication. |
| Artifact storage | Resolve exact semantic references and show backend/origin. | `ArtifactStore` persists immutable records and realization trees; later Cloudflare Artifacts implementation verifies both semantic digests and storage references. |
| Realization/distillation | Use profile/proposal contracts and expose source/output evidence. | Bounded local profile now; approved Cloudflare agent executor later, producing the same owned proposals and realization manifests. |
| Long-running work | Reserve operation identities and status/error shapes. | Future resumable jobs with bounded retries, grants, cancellation, and evidence; job state never becomes semantic authority. |

Artifacts supports versioned file trees with Workers, REST, and Git-compatible access. Store serialized semantic records and tested realization bundles behind this port; Git trees/commits are transport, not the Strata conflict algorithm or Release identity. Do not implement semantic composition by Git merge. [Artifacts overview](https://developers.cloudflare.com/artifacts/)

The documented Workers interface and authentication paths differ from a generic blob store. The remote adapter must use supported APIs/transports and verify publication/consistency behavior before enabling it; this plan does not invent `putRelease` as a Cloudflare API. Scope write access through the application service. Wrangler authentication, runtime bindings, API tokens, and repo tokens have different purposes; keep the existing Wrangler login unchanged. [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)

The Agents SDK supplies durable agent identity/state and execution facilities. Use it for the user-required Cloudflare agent implementation, while retaining Strata's own checks for actor ownership, authority, and evidence. Framework state or a callable method is not by itself an authorization system. [Cloudflare Agents](https://developers.cloudflare.com/agents/)

The SDK documents human approval patterns, but Strata's approval payloads must bind exact semantic or execution-plan content. A tool approval is not an endorsement that intent is correct, and a scope endorsement is not permission to incur costs. [Human-in-the-loop patterns](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/)

**Small shared library, not a mandatory SDK product:** expose internal typed functions/results for core records, canonicalization, evaluation, evidence verification, and publication requests. The CLI and local/hosted Agent services should reuse them. Keep filesystem, process execution, terminal formatting, and provider calls behind adapters. This is especially useful with the core plan's TypeScript direction and avoids a CLI-only rule engine drifting from the Worker implementation.

Do not require a public npm SDK, Python package, REST API generator, MCP server, plugin framework, or second client transport to demonstrate the MVP. A versioned JSON CLI is sufficient for external agents initially. Extract a public SDK only when another consumer needs direct in-process operations; retain the same validation and authority checks at service boundaries.

Future remote fetch/publication and agent-job commands must be explicit, honor execution grants, and preserve exact refs. They are deferred interfaces, not hidden network behavior added to `status`, `compose`, `layer publish`, or `release`. A remote transport failure cannot silently switch identity or publish into another backend.

## 12. Delivery slices and acceptance

Adopt one command contract/schema with the core planner before implementation. The small end-to-end milestone is the booking scenario, not a general natural-language application compiler.

| Slice | Deliverable | Exit condition |
| --- | --- | --- |
| A. Record and inspection shell | Shared CLI envelope/errors; help/version/capability report; init, config show, status, inspect, diff. | Bootstrap/records render identically for humans and JSON callers; no external network. |
| B. Owned proposals and composition | Layer create/revise/publish; compose/conflicts; decision-only Layer, approve, resolve. | A/B shared reads and owner denial work through actual local Agents SDK instances; order-independent conflicts, stale dependencies, and authorized decisions match core results. |
| C. Realize, review, release | `mat` with one local booking profile; `dist` supplied-proposal mode; validation import; approval; atomic release. | An actual generated application passes its declared checks and review; a complete Release retains provenance/obligations as the next baseline. |
| D. Contract hardening | Dry-run, noninteractive behavior, idempotency, concurrency checks, JSON schemas and examples. | One scripted lifecycle exercises the same paths as a human, including expected failures; no hidden prompts, partial Releases, or cloud calls. |

Implement dry-run/error/ownership plumbing from slice A; slice D verifies it end to end rather than retrofitting safety after side effects exist. Core semantic fixtures and tests are reused, not duplicated with different assumptions.

Focused CLI acceptance checks:

1. Alias parity: `mat/materialize`, `dist/distill`, and `flatten/release` yield the same canonical operation, data, and codes for pinned inputs.
2. Wire contract: one parseable stdout envelope on success, invalid JSON, ownership denial, semantic conflict, missing evidence, and unsupported operations; progress cannot corrupt it.
3. Authorization: changing owner fields or claimed actor labels cannot edit a peer Layer, select as an unauthorized actor, or forge approvals.
4. Determinism and staleness: reverse proposal/selection order without changing results; preserve ordered list semantics; reject changed proposal-set Resolutions and changed-candidate evidence.
5. Dry-run: compare semantic store, draft/index state, output directories, and mocked external call counts before/after; no mutation or remote calls.
6. Evidence: real output modification breaks its digest; imported results cannot bypass review, active Layer obligations, profile identity, or required authority.
7. Publication: failure/crash around index commit and repeated keys cannot expose partial/duplicate Releases; JSON reports known effects even if response delivery failed.
8. No-cost local run: actual local Agent SDK workflow with Artifacts fake, outbound service calls denied, no AI binding, deployment hooks, credentials minted, package installation, or account plan changes.
9. Source intent loop: a supplied distillation proposal remains an owned unpublished draft until its source-bound review; code-only experiments do not rewrite the baseline.

These are future implementation acceptance criteria. This planning pass validates the document against the read model/core plan; it does not claim runtime tests passed.

Deferred scope: general AI materialization/distillation, Cloudflare provisioning/deployment/model calls, authenticated production multi-tenancy, broader semantic operations outside the core subset, automatic rebase, partial-Layer selection, governance transitions, semantic equivalence proofs, automatic A/B winner selection or traffic routing, Git import, watch mode, global cleanup/GC, plugin systems, and public multi-language SDKs. Cloudflare-backed storage and agents remain required intended capabilities, with remote activation gated on the user's cost policy.

## 13. Open design decisions

Do not resolve the model's section 10 questions by choosing a convenient CLI flag. Preserve explicit unknowns and conservative blocking until the semantic contract changes.

| Decision or dependency | Proposed integration treatment |
| --- | --- |
| Provisional model adoption | Core and CLI must agree on one model version, schemas, canonicalization, supported subset, and error taxonomy before code. Proposed defaults remain labeled as such. |
| Block types/facets/tags and design-versus-logic intent | A separate user-commissioned `docs/BLOCK_CLASSIFICATION_PROPOSAL.md` owns this analysis. Use the current Block model meanwhile; do not freeze a CLI taxonomy. |
| Materialization applicability by classification | Integrate the separate proposal through explicit versioned model/profile rules. Do not silently skip design intent or acceptance obligations based on a display category. Until adopted, unsupported content is explicit and release gates stay intact. |
| Accessible translucent category colors | Owned by the classification/site work. CLI text/JSON uses stable semantic labels when adopted; color is optional presentation and never the only signal. No color taxonomy or numeric palette is chosen here. |
| Identity/approval authentication | Fixture broker now; production credential/trust/revocation design later. Pin endorsement payload format before exposing a hosted writer. |
| Conflict-report revisions and evidence invalidation | Core must define a pinned report/evidence-set manifest. New interaction reports must block a pending release until evaluated; neither ignore them nor mutate immutable Compositions. |
| Profile determinism and evidence adequacy | Demonstrate only the bounded booking profile. Materializer compatibility, broader contracts, cross-profile equivalence, and portable evidence remain open. |
| Remote publication/retention | Keep the core staged-artifact plus atomic-index model; verify the real adapter's consistency/failure behavior later. No untested cross-service transaction claim. |
| Packaging and invocation | TypeScript follows the core proposal; choose binary packaging, runtime support, and exact generated-app invocation jointly. Do not add a package/dependency just to settle the plan. |

Integration recommendations:

- Keep `compose`, `mat`, `validate`, and `release` separate; generation is not semantic approval and flattening is not deployment.
- Route every proposed semantic change, including distillation and reconciliations, through an owned Layer. Reuse the same pure semantic engine and local Agent services.
- Have the bounded local booking profile provide both an independently usable application and a runner that emits the evidence schema consumed by the CLI.
- Publish one protocol/error/canonicalization contract. Use exact references, conservative invalidation, and atomic idempotent publication everywhere.
- Preserve the explicit Cloudflare requirements while keeping remote/paid work behind reviewable network and cost plans. Leave Wrangler authentication and `site/` untouched.
- Incorporate the forthcoming Block-classification proposal without letting presentation tags silently alter materialization or release obligations.
