# Versioned experimental Block contracts

Checked 2026-10-04. The default `strata/0.1-facets-experimental` contract remains unchanged. The explicit opt-in `strata/0.2-content-mediation-experimental` contract adds `content/1` and bounded Node `assets/1`. Protocol envelopes remain version 1. [Slice 2](MEDIATION_SLICE2.md) adds supporting selection control without changing Block fields or introducing a sixth semantic object. The [canonical model](../STRATA_MODEL.md) is unchanged; [slice 1](CONTENT_ASSETS_SLICE1.md) records the implementation boundary and evidence.

## Opt-in v0.2 content and assets

A v0.2 Block has **nine required fields**: the original seven plus `description` and `asset_refs`. It has no standalone revision, owner or provenance field. Snapshots, Layers and Compositions declare their model explicitly. Cross-version composition, automatic relabeling and active-project migration are unsupported. The [v0.2 Block schema](../schemas/content-block-v2.schema.json) describes structural JSON; runtime validators add text-byte, tree, role, obligation and retained-byte closure checks.

| Field or rule | v0.2 enforcement |
| --- | --- |
| `description` | Exactly `{ "format": "plain-text/1", "text": "..." }`; explanatory background, possibly empty. It never substitutes for requirements or acceptance. |
| `asset_refs` | Map of at most eight nondotted local keys to exact `asset_ref`, `content_sha256`, `role`, `subjects` pins. Empty `{}` is valid. Only `background` with empty subjects is enabled; acceptance cannot promote background pins or descriptions into normative subjects. |
| Intent prose | At most 4,096 UTF-8 bytes per description, purpose or statement. Backticks, raw HTML forms, script/data URL schemes and control characters are rejected. No rendering, fetching or execution occurs. |
| Local item keys | Nondotted `[A-Za-z0-9_-]+`; dotted Block IDs remain supported. |
| Requirements | At least one resolvable local acceptance reference. Parameter values are finite numbers or booleans. The common shape is independent of domain parameter names; finite compiled profiles enforce their exact supported keys and meanings before materialization. No string, nested object, list or arbitrary parameter grammar. See [profile separation](PROFILE_SEPARATION.md). |
| Inherited obligations | `set_item` cannot drop inherited acceptance references on requirements, contracts or relationships; inherited criteria cannot be replaced in this slice. Unsupported amendments return `OBLIGATION_REMOVAL_UNSUPPORTED`, rather than silently weakening acceptance. |
| Authoring review | A Block-changing Layer needs an accepted `intent-authoring/1` review bound to the exact normalized draft digest and project. An assigned reviewer receives explicitly supplied draft bytes through `content review --file F`; this grants no new peer-private draft read access. `layer publish REF --authoring-review EXACT_REF` verifies the pin. Supplied-proposal source review remains separately required when applicable. |

Structural checks cannot prove arbitrary prose contains no implementation code. Reviewers must check that descriptions explain intent, normative requirements retain acceptance, examples do not introduce executable implementations, and background assets do not carry hidden normative obligations. A copied review cannot justify changed content. Reviews are local fixture attestations, not production-authenticated independent decisions.

An asset is a supporting retained record, not a sixth semantic object. Its descriptor pins project, logical ID/revision/predecessor, exact bytes/hash/length, byte-derived MIME and dimensions, validation marker, project-private visibility, provenance/rights and server-resolved importer. Binary bytes live in a separate ByteStore. No base64 bytes occur in Blocks or RPC records. Background references are retained and included in `booking-node/2`'s manifest; they do not enter executable application resources. Application resources, normative references and evidence fixtures return `UNSUPPORTED_ASSET_ROLE`.

`assets import` accepts one explicitly provided local PNG or baseline JPEG file with a project-visibility acknowledgement and both internal-retention and backup rights. The separate operator assignment is denied by default; trusted in-process host/test provisioning is the only current assignment mechanism. Imports require a stopped descriptor-bound v0.2 Node state and use an exclusive cooperative lease for writes. Dry runs only observe quiescence. Hash-addressed staging precedes an atomic registry/audit commit. Revisions retain every predecessor; there is no deletion or garbage collection.

Bounds are 4 MiB per file, 4,096 pixels per axis, 16 million pixels, 8 KiB per descriptor, 32 retained versions and 16 MiB of unique retained blobs per project. PNG validates signature/chunks/CRC, supported 8-bit noninterlaced color forms and bounded decompressed scanlines; APNG/palette and unknown critical variants are rejected. JPEG validates bounded baseline marker/table/scan structure; it does **not** fully decode entropy or certify decoder/malware safety. PDF, video, SVG, HTML, archives, remote imports, extraction, OCR, thumbnails, transcodes and model uploads are unavailable.

Full Node backup uses `strata-local-backup/2` for v0.2 and verifies descriptor/blob closure across public and private history. Backup1 stays the v0.1 reader/writer. Restore remains an isolated inactive archive with no active identities, grants or request cache. The SDK has no binary ByteStore; asset-bearing operations fail with `UNSUPPORTED_ASSET_BACKEND`. [Slice 2](MEDIATION_SLICE2.md) enables versioned Resolution, approval/2 and Release for explicitly activated local fixtures, preserving exact evidence/assets, report gates and separate semantic approvals. Descriptors alone grant no authority. Unconfigured engines and inactive restored copies remain unable to publish.

See [v0.2 snapshot](../examples/bootstrap-content-v2.json), [Layer](../examples/L-content-v2.json), [review input](../examples/content-review-v2.json), [asset metadata](../examples/asset-import-v1.json), and [host/onboarding instructions](CONTENT_ASSETS_SLICE1.md). `migration preview RELEASE --source-digest HASH` preserves exact v0.1 source/obligations and emits a v0.2 proposal plus blockers. It adds empty descriptions/assets without inferring intent or importing URLs; it never applies a migration or switches the baseline.

## Unchanged v0.1 contract

The remaining sections apply specifically to v0.1. Its existing records, seven-field interpretation, parameter grammar and booking-node/1 behavior remain intact.

## Machine authority and validation stages

[src/model.ts](../src/model.ts) defines `blockSchema`, nested item schemas, `write`, `normalizeSnapshot` and `checkTree`. The generated [snapshot schema](../schemas/snapshot.schema.json) includes that Block shape. [src/core.ts](../src/core.ts) adds baseline, ownership, exact-reference and composition checks; [src/profile.ts](../src/profile.ts) limits materialization to the supported booking vocabulary. These shared validators are the machine authority. No independently maintained validator or standalone `block validate` command exists.

Passing the JSON shape is only the first stage. A Block must also fit its snapshot tree, acceptance subjects and relationship references. Layer authoring must satisfy current permissions, exact baseline/preconditions and dependency rules. An eligible candidate still needs a supporting profile, complete bound evidence and endorsements before Release. A shape-valid Block does not promise materializability.

## Required fields and nested content

All **seven** top-level fields are required; no extra top-level field is optional. Collections may be empty where shown. IDs match `[A-Za-z0-9_-][A-Za-z0-9_.-]*`. Prefer simple item keys such as `expiry`: editable item paths split on dots, so a dotted collection key is not a supported single-item path. Dotted Block IDs such as `booking.hold` are supported.

| Field | Current required value and checks |
| --- | --- |
| `id` | Safe ID, equal to its key in `snapshot.blocks`; it cannot reuse a deleted/reserved identity. |
| `parent` | Existing Block ID, or `null` for the declared root. The snapshot has one rooted, acyclic responsibility tree. Ordinary reparent mutation is unsupported. |
| `purpose` | Nonempty string. |
| `requirements` | Map, possibly `{}`. Each value has exactly `statement` (nonempty), `kind` (`rule` or `invariant`), `facets` (nonempty unique subset of `behavior`, `design`, `data`, `safety`), `acceptance` (local criterion IDs), and `parameters` (required arbitrary JSON object, possibly `{}`). |
| `acceptance` | Map, possibly `{}`. Each value has exactly `statement` (nonempty), `method` (`mechanical` or `review`), `check` (safe ID), `version` and `fixture` (nonempty strings), and `subjects` (semantic item references). Tree validation requires nonempty, resolvable subjects. |
| `relationships` | Map, possibly `{}`. Each value has exactly `target` (existing Block ID), `statement` (nonempty), and `acceptance` (local criterion IDs). This is not a typed asset or consumes/requires registry. |
| `contract` | Object containing all three maps `inputs`, `outputs`, `failures`, each possibly `{}`. Each entry has exactly `statement` (nonempty) and `acceptance` (local criterion IDs). |

Nested record objects are strict too. Normalization rejects duplicate declared-set members and sorts sets; arbitrary parameter-array order remains meaningful. References in requirement/contract/relationship acceptance arrays must resolve inside that Block. Criterion subjects use `BlockID/path`, for example `booking.hold/requirements.expiry`.

The model's semantic Block description includes revision/provenance and requires every normative requirement to have at least one acceptance criterion. Today's JSON Block has no `revision` or `provenance` fields: it is versioned inside an exact snapshot/Release/Composition, with derived provenance outside its input shape. Today's generic requirement schema allows `acceptance: []`; tree validation checks supplied references rather than enforcing that minimum. The booking profile later refuses uncovered obligations. Do not claim generic write-time enforcement of the model's minimum. Typed model relationships and general Block creation are also beyond the implemented subset.

`owner`, `model_version`, `revision`, `provenance`, `description`, `rationale`, `code` and `assets` are not accepted top-level Block fields. Layer ownership does not confer exclusive ownership of a Block.

## Physical format, Markdown, code and assets

CLI input is JSON regardless of filename suffix; `.block`, `.md` and YAML have no dedicated importer or authoring grammar. Physical content-addressed JSON records contain snapshots and their Blocks. Inspect a Block with `inspect block ID --at EXACT_RELEASE_OR_COMPOSITION`; there is no implicit latest Block revision. Initialization takes a complete snapshot, not a bare Block.

Markdown, URLs, code-looking text and data examples can currently occur as opaque strings or JSON parameter values. The schema does not render, execute or fetch them and does not enforce a no-code rule. Keeping implementation in profiles/realizations reflects the model's intent/implementation distinction; this pass introduces no new Markdown or code policy. Profile capability checks reject unsupported obligations, rather than acting as a general code detector.

There is no typed image/video/PDF/project asset registry, binary retention contract, media validation or extraction. A textual path/URL/digest is not retained asset bytes or a lifecycle guarantee. Distillation hashes explicitly declared local files and records traceability; it does not preserve those external files. [Node backup](LOCAL_BACKUP.md) recovers indexed history, evidence, profiles and realization bodies, not arbitrary external files referenced in prose. Core/CLI operations make no hidden model upload. These fields remain invalid in v0.1. The explicitly versioned v0.2 subset above implements the accepted bounded content/assets decision; it does not reinterpret v0.1.

## Valid examples

This complete Block is exactly the `app` Block in [bootstrap.json](../examples/bootstrap.json), also available as [block.json](../examples/block.json). It is valid in that existing snapshot context; a bare file is not an `init` payload.

```json
{
  "id": "app",
  "parent": null,
  "purpose": "A command-driven booking demonstration.",
  "requirements": {},
  "acceptance": {
    "review": {
      "statement": "Verify intent.review for app.",
      "method": "review",
      "check": "intent.review",
      "version": "1",
      "fixture": "app",
      "subjects": [
        "app/purpose"
      ]
    }
  },
  "relationships": {},
  "contract": {
    "inputs": {},
    "outputs": {},
    "failures": {}
  }
}
```

This complete requirement value from `booking.hold/requirements.expiry` is valid with the bootstrap's existing acceptance criteria. Replace the whole atomic requirement when authoring `set_item`; a nested `parameters.seconds` path is not editable on its own.

```json
{
  "statement": "A hold expires exactly 600 seconds after it starts.",
  "kind": "rule",
  "facets": [
    "behavior",
    "data"
  ],
  "acceptance": [
    "expiry"
  ],
  "parameters": {
    "seconds": 600
  }
}
```

Data examples in prose are not an executable checker. Exact criterion check/version/fixture, subjects, profile support and observed results are still required where applicable.

## Invalid examples and current errors

The following modifications to the valid fixture fail at the stated stage; these are descriptions of mutations, not additional accepted fields:

| Modification | Expected current outcome |
| --- | --- |
| Remove `purpose`, add `code: "run()"`, or omit required `parameters` from a requirement | `INVALID_RECORD`, exit 2; schema details include the field path or unrecognized key. |
| Use `facets: ["performance"]` or duplicate a facet | `INVALID_RECORD`, exit 2; invalid enum or declared-set member. |
| Change `booking.hold.parent` to a missing Block | `INVALID_TREE`, exit 2 during snapshot/tree validation. |
| Add a relationship with `target: "missing"` | `DANGLING_REFERENCE`, exit 2 during tree validation. |
| Set an existing criterion's `subjects` to `[]` | `INVALID_RECORD`, exit 2 during tree validation. |
| Refer to absent local acceptance criterion `missing` | `DANGLING_REFERENCE`, exit 2. |
| Edit `requirements.expiry.parameters.seconds` directly | `UNSUPPORTED_CAPABILITY`, exit 8: atomic keyed items are the supported paths. |
| Supply an incorrect expected baseline value | `BASELINE_PRECONDITION`, exit 5 when evaluating that proposal/candidate. |
| Revise an existing Layer onto a different baseline | `UNSUPPORTED_CAPABILITY`, exit 8; use a new owned Layer identity for work on another baseline. |

For example, adding an extra Block field produces a CLI error envelope shaped like this (command depends on the attempted operation):

```json
{
  "ok": false,
  "exit_code": 2,
  "errors": [{
    "code": "INVALID_RECORD",
    "message": "Record does not match the experimental schema.",
    "retryable": false,
    "details": [{"code": "unrecognized_keys", "keys": ["code"], "path": ["blocks", "app"], "message": "Unrecognized key: \"code\""}]
  }]
}
```

This is an excerpt of the protocol-1 envelope, not a complete response. Schema issues have structured paths; semantic failures do not uniformly carry one. Read the returned code, exit and details rather than assuming every error has the same path layout. Permission and owner failures are separate exit-4 checks. Unsupported profile intent is an exit-8 capability/obligation failure; passing the Block schema does not bypass it.

## Shared discovery and operation boundaries

Agents read this contract through [the skill](../agent/strata/SKILL.md) and [the initial manifest within the full replay](../examples/agent-session.json). CLI help supplies this document's path; [the implementation contract](IMPLEMENTED_CONTRACT.md) and [current status](IMPLEMENTED_CONTRACT.md) link it. Public FAQ copy describes the same current shape and limitations without treating proposed additions as implementation.

Personal context is navigation metadata, not an implicit input or authority. `layer restore CURRENT --from PRIOR` appends a new private revision of the same owned Layer on the same baseline/model; it neither migrates a baseline nor copies evidence/review/approvals. Backup has a separate operator entitlement. Integrity failures remain errors even with `--dry-run`; successful verification requires `data.verified: true`, while a successful restore dry-run still has `data.restored: false` and writes nothing. Ordinary semantic readiness previews can return `ok: true` with `execution_ready: false`; those are not Release permission.
