# Shared source binding v1 — implementation contract

Architecture baseline: `d08075834cdeb505c79dfb528bbe1b4d3febbee5`, 2026-10-09. Implemented schemas/types are in `src/source-binding.ts`, and Git capture consumes those exports. This document records the shared design; [the workflow guide](SOURCE_DRIFT.md) describes the implemented slice and its limits. Legacy `derived_from`, `Evidence`, `Realization` and Release schemas remain unchanged.

## Canonical definitions

Use existing `canonical`, `digest`, `bytesDigest`, strict Zod schemas and immutable `Engine.store`. SHA-256 means lowercase 64 hex; Git OID length follows `object_format` (`sha1`: 40, `sha256`: 64), and never substitutes for a raw-byte SHA-256. Sort declared sets and reject duplicates; paths sort by deterministic code-unit order. Reject unknown fields. References use full digest suffixes: `<record-type>@<digest(data)>`; no embedded self-ref in data.

The following TypeScript is a schema blueprint, not a second implementation. `Ref` is an existing exact record reference, `Hash` is SHA-256, `Path` is a validated relative POSIX path, `GitOid` is an object-format-checked string. Nullable fields are required. Store source snapshots separately so both workflows reference one object.

```ts
type SourceScope = {
  format: 'source-scope/1';
  coverage: 'selected-scope';
  paths: Path[];                 // exact tracked paths; absent destinations allowed
  watch_roots: Path[];           // directory inventory; "." explicitly means repo root
  exclusions: { path: Path; kind: 'file'|'directory'; reason: string }[];
  items: string[];               // exact Block/item identifiers in accepted Release
  mapping: { item: string; paths: Path[]; criteria: string[] }[];
  limitations: string[];
};
type SourceEntry = {
  path: Path;
  presence: 'present'|'absent';
  kind: 'regular'|'symlink'|'gitlink'|null;
  mode: '100644'|'100755'|'120000'|'160000'|null;
  byte_length: number|null;
  sha256: Hash|null;
};
type SourceSnapshot = {
  format: 'source-snapshot/1'; project_id: string; repo_id: string;
  object_format: 'sha1'|'sha256'; head_commit: GitOid; head_tree: GitOid;
  scope: SourceScope; scope_sha256: Hash;
  entries: SourceEntry[]; manifest_sha256: Hash;
};
type IntentPin = {
  release_ref: Ref; release_sha256: Hash; snapshot_sha256: Hash;
  model_version: 'strata/0.1-facets-experimental';
};
type BindingPayload = {
  format: 'source-binding-payload/1'; project_id: string; repo_id: string;
  intent: IntentPin;
  source_ref: Ref; source_sha256: Hash;
  previous_binding_ref: Ref|null;
  completion_ref: Ref|null;       // git-finalization for every v1 successor
  basis: 'owner-accepted-bootstrap-association'|'validated-release-association';
  acceptance_evidence_refs: Ref[];
  limitations: string[];
};
type SourceBinding = {
  format: 'source-binding/1'; payload: BindingPayload;
  payload_sha256: Hash;
  acceptance: {
    principal: string; trust: 'local-fixture'; responsible_scope: string;
    rationale: string; accepted: true;
    review_refs: Ref[];          // optional supporting exact review records; may be []
  };
};
```

`scope_sha256 = digest(scope)`; `manifest_sha256 = digest(entries)`; `source_sha256 = digest(sourceSnapshot)`; `payload_sha256 = digest(payload)`. `release_sha256` hashes the complete stored Release; `snapshot_sha256` hashes `snapshotFromRelease(record)`. Metadata/provenance changes therefore cannot masquerade as the same accepted Release. The binding's digest covers its acceptance and all reference lists. No timestamps, absolute roots, branch aliases, credentials or remote URLs serve as identity or freshness checks.

Absent entries require all other entry fields null. A regular file's length/hash describe **raw committed blob bytes**. For a symlink, length/hash may describe the raw Git link blob, never the referent. For a gitlink, length/hash are null: commit identity is already pinned by the containing tree, and the report must mark content uninspected. Kind/mode combinations are strict. Baseline acceptance in v1 refuses symlink/gitlink entries; observations can describe them. No content bytes enter this schema.

`paths` and watched roots are a read/inventory scope, not permission to write. Patch plans separately enumerate exact write paths, including both sides of additions/deletions. Every declared item must exist, have exactly one mapping, and carry its complete criteria set derived from `obligations(snapshot)`; purpose without an applicable review criterion is uncovered. Mapped paths must be in scope and not excluded. Acceptance criteria and their subjects must resolve. Inventory all nonexcluded tracked paths under roots plus exact paths; newly encountered paths remain unmapped findings until explicitly reviewed. Exclusions and undeclared app areas are always disclosed; selected-scope completeness is never whole-app coverage. Scope changes require a new proposal/binding; do not mutate the old scope to make a warning disappear.

## Capture and observation boundary

Git task owns these Node-only exports from `src/git-workspace.ts`:

```ts
type GitHost = { projectId: string; repoId: string; root: string; identity?: string }; // trusted host config
captureGitSource(host: GitHost, scope: SourceScope, options: {
  expectedHead?: GitOid; mode: 'baseline'|'observation'; authorizePath?: (path: Path) => void
}): Promise<{ snapshot: SourceSnapshot; observation: GitObservation }>;
verifyGitSource(host: GitHost, expected: SourceSnapshot, options: {
  requireClean: boolean
}): Promise<Verification>;
```

Host configuration additionally resolves canonical root/Git directory identity, grants and limits. The broker supplies `authorizePath` to check every selected/watched/new path before measuring its contents. `project_id` in capture output comes from that resolved host context; never trust an unverified request label.

`GitObservation` is a strict portable object with `format:'git-observation/1'`, project/repo identity, object format, current HEAD/tree, raw `index_sha256`, `scope_sha256`, sorted `entries` using `SourceEntry` for physical regular bytes/link metadata, `manifest_sha256`, and sorted `status:[{path,staged,unstaged,untracked}]` (booleans). It also contains `outside_scope_dirty:boolean`, `ignored_count`, `excluded_count`, `unsupported:[{path,reason}]`, `coherence:'stable'|'changed-during-read'`, and `trust:'local-measurement'|'imported-snapshot'`. For unavailable/special-file byte observations, return a structured unsupported diagnostic and no fabricated regular hash. Never follow links or read devices. The Node host assigns trust; SDK callers cannot claim local measurement.

For untracked regular files only, observation `mode` is null because there is no Git/index mode; do not guess an executable bit from Windows permissions. `SourceSnapshot` validation still requires a regular committed entry's mode to be 100644 or 100755. Git mode/type changes and physical entry kind changes are separate report findings.

`Verification` contains `{matches:boolean, clean:boolean, observation:GitObservation, blockers:{code:string,path?:Path}[]}`. Verification must compare fresh HEAD/tree/index/inventory/raw bytes, not only Git status. For reviewing a dirty observation, compare `digest(freshObservation)` with the exact original observation digest, not with a committed snapshot. Add `verifyGitObservation(host, expectedObservation, scope): Promise<Verification>` to the Git helper exports for this case. The same finite pre/post capture routine underlies both comparisons.

Baseline capture requires a clean whole repository (staged, unstaged and nonignored untracked), complete selected inventory, coherent reads, and raw selected checkout bytes equal to Git blob bytes. Refuse clean CRLF/filter-transformed checkout bytes as `UNSUPPORTED_CHECKOUT_TRANSFORM`; never normalize or invoke filters. Observation mode still reports dirty source without blessing it. Pre/post reads compare HEAD, index and source inventory plus rehash selected bytes; races fail `SOURCE_SNAPSHOT_STALE`. This is a bounded observation under a cooperative local filesystem, not an atomic snapshot against a hostile writer. Report and review receipts describe a past measured observation; apply/finalize must recheck again.

Ignored file contents are not read. Report ignored/excluded inventory counts and declared exclusions; tracked bound paths remain measured if ignore rules later match them. Ignored destinations may not satisfy absence claims or authorize overwrite. A new ignored file cannot silently become a covered source artifact. Detect renames as deletion/addition; equal raw hashes yield only an optional `possible_rename` hint, never semantic identity or an automatic mapping update. Submodules, inaccessible/missing objects and unsupported path representations have explicit blockers; no fetch or recursive checkout.

Limits: 256 selected entries, 64 watched roots, 4 MiB per measured file, 16 MiB total selected reads, request JSON strictly within existing 1 MiB transport; inventory capped at 5,000 paths. Exceeding any bound fails explicitly, never truncates a complete claim. Git adoption imposes tighter patch limits separately.

## Acceptance and persistence

`source.bind` input is `{payload, expected_payload_sha256, rationale, review_refs}`. `source.capture` first retains the clean committed snapshot with input `{repo_id, scope, expected_head?}`. Node orchestration captures/reopens the referenced source, verifies payload/Release/scope/evidence and current authority, and records the binding with a server-derived principal. Initial bootstrap acceptance requires an explicit `source.bind` grant plus the responsible baseline scope authority, exact payload review and disclosed unvalidated bootstrap status. It does not convert `init` into behavioral validation. A validated Release association preserves the distinction between profile validation and actual application evidence.

Every successor requires `previous_binding_ref` and a valid `git-finalization` completion ref whose base binding, clean owner commit/tree, semantic Release, exact stage, application acceptance and code review agree. A patch apply receipt alone is insufficient. The reviewer must still have current operation/repository/Block scope grants and baseline authority; existing Release approvals are not filesystem grants. Recheck at late commit. No mutable global “latest binding” is introduced: callers choose exact refs. Independent successors remain branches of accepted history; never silently pick one or rebase an open proposal.

Store `source-snapshot`, `source-binding`, drift and Git records in the existing engine registry/content-addressed artifacts. Reports/JSON exports are projections, not a second ledger. Portable records may be published immutable records even when a proposal is unapproved; their explicit state is not a Layer publication or Release. Existing read visibility is project-wide for published records, so keep reports to relative paths, hashes and bounded review rationale; no automatic source excerpts. Host configuration, leases and transaction journals remain local nonportable state.

Required exports: `SOURCE_BINDING_SCHEMAS` (keys `source-snapshot`, `source-binding`), `sourceScopeSchema`, `sourceEntrySchema`, `gitObservationSchema`, the types above, `sourceBindingArchiveReferences(type,data)`, `verifySourceBindingHistory(records,projectId)`, and `executeSourceBinding(engine,command,input,context,issuer)`. Async host verification is a trusted Node precondition outside request JSON; absence of that capability prevents binding. The pure service must not accept a client `verified:true`. Historical verification checks retained hashes, schema, reference type/project and closure, never current disk, present-day grants or program execution.

Use [the drift plan](DRIFT_RECONCILIATION_PLAN.md) for decisions and tests. The Git task owns its `git-acceptance` evidence schema and `git-finalization`; drift references them and never creates a duplicate application-evidence type.
