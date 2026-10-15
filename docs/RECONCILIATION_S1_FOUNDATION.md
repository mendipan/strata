# Three-action reconciliation: S1 candidate

Base: remote main `497a7c6efa5967465b1bd18616ea390e44227ab8`, verified on 2026-10-12.
This slice implements the shared pure foundation in the approved three-action design.
It does not enable reconciliation operations or establish application execution or current authority.
The integration owner must review this candidate and freeze its interfaces before S2/S3 begin.

## Interfaces and digest domains

`src/reconciliation-records.ts` exports the strict Zod schemas, their inferred types, four request schemas,
action-specific auth inputs, `normalizePlanBody`, `deriveApprovalSubject`, `requiredRoleKeys`,
`normalizeRoleKeys`, `exactRoleCoverage`, `exactCriterionCoverage`, `contractDigest`, `recordPin`, and
`parseReconciliationRecord`. Unknown fields, duplicate sets and unsorted sets refuse. Nullable fields
are required explicitly. JSON Schema captures structural constraints; callers must also use the pure
validators for digest, scope, timing and relationship constraints.

New refs are `TYPE@SHA256(canonical(record))`, using the existing canonical JSON implementation.
The deterministic `reconciliation-plan-body/2` digest excludes the author's auth envelope.
`reconciliation-application-contract/1` pins target, criteria definitions, checker, descriptor and oracle.
Desired source content is `digest(desired_entries)`, including the exact selected blob pins.
An approval subject includes the exact proposed envelope/evidence pins and successor template, excluding
future commit, final observation and final run identity. It explicitly permits only fresh checks of
the same contract and source. Patch digests hash UTF-8 bytes; raw Git SHA-256 hashes raw bytes; Git OIDs
hash `kind + ' ' + raw_length + NUL + raw_bytes` using the declared Git algorithm.

The generic `reconciliation-producer-descriptor/1` archives sorted, individually hashed assets and
the fixed bounded-worker limits. Its schema is not registration or execution authority. S3 must bind
actual adapter assets and perform recognition/contract verification before execution. Descriptor
asset roles are adapter-defined; generic modules contain no application names, filenames or values.

The historical bridge uses **typed** semantic pins, including legacy named Release/Layer/Composition
refs. Prepare auth separately pins the exact supplied Layers; no type is inferred from a Layer name.
S4 must verify the full considered/selected semantic history, ownership, baseline, topology, inherited
acceptance, target obligations, impact-derived scopes and fixed guardians through existing gates.
The bridge's `validated` and trust literals alone prove none of these facts.

## Retained source proof

`src/reconciliation-source-proof.ts` exports `verifyRawGitObject`, `verifyPlannedSourceProof`,
`verifyCommittedSourceProof` and `applyExactPatchSection`. These execute no Git, archived code, worker,
filesystem operation or current authority lookup. A `TypedRecordReader` must read indexed records of
the requested type; each pin is rehashed before use.

The planned proof reconstructs B/H/T0/T1 from bounded raw commit/tree objects and selected blobs.
It checks the exact predecessor source snapshot and /2 report observation, complete scoped inventory,
raw single-parent ancestry, H plus physical selected entries, full B-to-T1 mapped/association delta,
and exact restoration patch pre/postimages. It refuses missing, duplicate, wrong-kind or unused objects,
unsafe/aliased names, unsupported kinds, mode changes, merges and empty nested tree directories.
Unchanged executable modes are retained. Selected binary bytes may be preserved; changed/patch images
must be exact UTF-8 without NUL. Additions require explicit 100644 modes for exactly the absent destinations.
Known absences can be retained; desired coverage still needs an artifact for every selected obligation.

The committed proof reuses the prepared object pool and binds the exact proposed construction. C is
either the already-clean reviewed H with T1, or one single-parent child of H with T1. The final selected
snapshot/observation must match those bytes and the derived successor mapping. The result explicitly
says no live source or live authority was checked. S2 supplies coherent runtime capture and identity/index
guards; S4 authenticates that capture and publication. Pure historical checks do not recreate disk state.

Independent bounds: 512 KiB/raw object; 8,192 distinct objects and 16 MiB raw bytes across prepared/final
proofs; 5,000 entries including directories per endpoint; 256 ancestry edges; 64 patch paths, 256 KiB patch,
512 KiB combined patch images. Existing host read bounds remain S2 requirements. Limits refuse without truncation.

## History scaffold and acyclic publication

`src/reconciliation-history.ts` exports explicit `reconciliationReferences`,
`completionBindingConsumers`, `verifyCompletionBindingEdge` and `collectReconciliationClosure`.
The new collector has its own 16,384-record/64 MiB encoded-closure bound and preserves the 768 KiB
individual-record limit. Reverse-index input also respects the existing 20,000-record project limit.
Legacy traversal is an explicit integration callback and retains its original versioned validation.
Malformed new formats cannot fall through to a legacy parser.

Payload /2 contains no completion ref; completion /2 contains no successor binding ref; binding /2
references completion. A completion-rooted reader adds exactly one verified reverse edge from the
published indexed bindings and uses a visited set. It cross-checks payload, source approval subject,
finalizer and the matching retained result/commit-audit projections. `AtomicPublication` is the typed
projection S4/S5 must derive from their actual committed registry/result/audit data; it is not a client
consumer lookup or a fabricated proof. Unindexed staged artifacts cannot supply the binding consumer.

This is a traversal scaffold, not the complete portable history verifier. S5 must verify semantic
closure, action/request/attempt joins, all endorser/producer issuance and completion-time rules, exact
producer measurements and finalization constraints. S4 must recheck each pending endorser's current
account/epoch/generation/grant/role/policy/configuration and durable expiry; ordinary session closure
does not invalidate a bounded durable endorsement. Completed predecessors require historical verification,
not current reauthorization. An authenticated string or producer ID never grants authority.

## Fixtures and focused review

`tests/fixtures/reconciliation-s1/sha1.json`, `sha256.json`, and `review-only.json` contain deterministic,
canonical, full-digest fixture records with planned/committed roots and publication projections.
They use synthetic semantic-history placeholders and synthetic named receipt fields, with no actual
worker execution or grants. They are contract/source-proof examples, not accepted end-to-end completions.
`legacy-r1.json` freezes old /1 parser examples. The generator is `scripts/schemas-reconciliation-s1.ts`;
new JSON Schemas live exclusively in `schemas/reconciliation-s1/`.

Review raw parser bounds/order/name checks; exact object usage; B/H/T0/T1 reconstruction; deterministic
patch coordinates/newline handling; outside-scope preservation; clean H/direct-child transitions;
digest/approval/template joins; role/criterion exact coverage; and completion-root reverse traversal.
Confirm all existing runtime schema maps, broker/CLI/source/R1-C entrypoints remain unchanged.
The first candidate received independent review with four findings. The corrected candidate needs
the same reviewer's verification before interface freeze or S2/S3 work.

Verification on Windows, Node v24.16.0: the TypeScript build passed using the already installed matching
compiler (`node node_modules/typescript/bin/tsc --noEmit false --outDir dist --rootDir .`).
The guarded schema/fixture generator passed. The following corrected focused run passed **104/104** tests:

```text
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1
  dist/tests/reconciliation-records.test.js
  dist/tests/reconciliation-source-proof.test.js
  dist/tests/reconciliation-history.test.js
  dist/tests/reconciliation-checkout.test.js
  dist/tests/reconciliation-completion-r1.test.js
```

No broad unrelated test suites ran. Development dependencies were copied from the existing install into
this isolated worktree; there was no package fetch or source-side install. The owner checkout remained
at `c722c7a5d5feaedb8488008a1c3f10d5514d1251` with only its original untracked `.local/` entry.

The review corrections preserve all exported and serialized shapes:

* Raw tree modes match exact canonical ASCII byte strings before any decoding. High-bit substitutions
  refuse at both raw-object and complete rehashed-proof levels for SHA-1 and SHA-256.
* Committed verification first validates preparation with its own object pool and exact-use invariant.
  It then validates the bounded prepared/final union and final additional-object usage. A final object
  cannot consume an unused prepared object or supply a missing prepared object.
* New /2 completion/binding records require published state in the indexed boundary reader. Published
  binding reverse indexing also checks its indexed /2 completion. Private auth and explicitly permitted
  legacy visibility remain separate; a standalone edge verifier requires that publication-aware reader.
* A narrow `.gitattributes` rule preserves the canonical JSON fixture LF bytes through Windows checkout.
  The checkout regression recreates all four committed fixtures under `core.autocrlf=true`, verifies their
  exact bytes, and verifies an ordinary control file becomes CRLF. Fixtures are not regenerated to pass
  this checkout test.

The original reviewer's ten probes passed against the corrected build after relocating only their module
imports into isolated evidence scratch. This is author verification of the reported probes, not a claim
that the independent reviewer has accepted the corrected candidate. S2/S3 remain paused.

## Remaining dependency map

The approved handoff defines **seven total slices**; after S1 there are six implementation slices.

| Slice | Dependency | Ownership and parallel boundary |
| --- | --- | --- |
| S1 contracts/pure proof | remote main | Candidate in this change; freeze after review. |
| S2 local source/commit capture | reviewed S1 | New source-node module/disposable Git tests. Can run with S3. |
| S3 execution/counter adapter | reviewed S1 | New generic execution module/adapter/tests. Can run with S2. |
| S4 authority/workflow/atomic successor | S1 + S2 + S3 | Sole shared integration writer for broker, auth, source readers and registration. |
| S5 portable history/backup /4 | S4 | Fixtures may be prepared during S4; shared integration waits for its actual records. |
| S6 CLI/review/docs | S5 | Same shared writer as S4; do not overlap shared entrypoint edits. |
| S7 integrated acceptance/review | S1–S6 | Scenarios may be prepared early; final verification uses integrated code. |

Only S2 and S3 are independent implementation lanes immediately after S1 is reviewed and frozen.
Interface changes go through the integration owner; no concurrent edits to shared entrypoints/schema maps.

## Explicit limits

Completion still requires an **existing fully validated v0.1 target Release** verified through the existing
semantic pipeline. Changed-target accept_code can use a semantically equal direct validated successor;
update_intent alone requires a normative delta. An unvalidated bootstrap can advance only to such a
validated changed target; unchanged accept/restore is unsupported. Historical target trust remains
local-fixture. Current source approval is always required; changed targets additionally need current
scope/release/applicable fixed guardians.

The sole planned production producer is the exact recognized counter adapter, with its fixed checker,
fixture/oracle, 5 seconds, 64/16 MiB generations, 256 KiB IPC and termination/await requirements. Arbitrary
applications/commands remain unsupported. S1 registers no producer or live operation. Cooperative source
measurement and existing Windows durability limits remain. There is no owner checkout/index/HEAD/ref
write, provider execution, host activation, credentials/live grants, Studio Settings work, publication or deployment.
