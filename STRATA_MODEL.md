# Strata semantic model

Status: Proposed v0.1 prototype specification  
Date: 2026-10-03  
Design basis: Mendi's Strata discussion of October 2–3, 2026, and the request to make that discussion concrete enough to prototype.

Strata versions distilled application intent and logic. Its durable source is a structured semantic model; generated implementation code is a disposable realization of that model. Agents collaborate through owned Layers. A Composition selects compatible proposals, authorized Resolutions settle their interactions, and validated flattening publishes a Release that can serve as the next baseline.

This document specifies semantic behavior, not storage, hosting, agent orchestration, implementation templates, deployment, or Git import. YAML examples illustrate records using an existing data format; they do not introduce a programming language.

## 1. Status and design commitments

The discussion established these directions:

- Durable source control is for distilled intent and logic. Generated code is not an independently authoritative source.
- Agents can read across published Layers within their authorized project and write semantic changes only in their own Layer.
- Parallel work is represented by Layers, with explicit selection of competing proposals and possible A/B alternatives.
- Hierarchy and proximity to the affected intent guide conflict resolution.
- Composition evaluates a candidate; validated flattening publishes a new baseline and preserves provenance.
- People must be able to evaluate an actual working realization during development. Semantic compatibility cannot be guaranteed from descriptions alone.

The earlier discussion proposed the five core definitions below. The exact record fields, fingerprints, atomicity rules, authority checks, and conservative restrictions in this document are **proposed v0.1 defaults**, not claims of prior user approval. `MUST`, `MUST NOT`, and `MAY` describe conformance to this proposed model.

| Term | Precise role |
| --- | --- |
| **Block** | An identified, bounded unit of intended behavior, with a contract, requirements, relationships, and acceptance criteria. |
| **Layer** | One actor's immutable, revisioned proposal for semantic changes relative to a pinned baseline. |
| **Composition** | An immutable candidate that pins a baseline, proposed and selected Layer revisions, scenario, and Resolution records. |
| **Resolution** | An authorized, revision-bound decision that settles a specific interaction among proposals or requirements. |
| **Release** | An immutable, approved semantic snapshot with its provenance and validation evidence, produced by flattening a validated Composition. |

## 2. Identity, snapshots, and authority

### 2.1 Identity and revision

A Block, Layer, Composition, or Resolution has a stable logical `id`; each immutable revision has a `revision` and a content fingerprint. Editing a draft creates a new revision. A Release ID identifies one immutable Release directly. References in a Composition, Resolution, or Release MUST identify exact immutable values; `latest` is invalid.

A **snapshot** is a complete effective set of Blocks and semantic relationships. A **baseline** is an immutable snapshot from an earlier Release, or the explicitly initialized bootstrap snapshot, together with its authority manifest and identity/provenance metadata. This metadata includes reserved deleted IDs. Reading a Layer does not make it part of a snapshot.

IDs survive renaming and reparenting. Deleted IDs remain reserved and MUST NOT silently acquire a new meaning. Reintroducing deleted behavior in v0.1 uses a new ID, recorded lineage, and fresh validation; restoring a deleted ID is deferred. Revision history and lineage remain available even though Layer composition, rather than a timeline of code edits, is the primary collaboration model.

The prototype MUST compare structured values deterministically: map key order is insignificant; list order is significant; strings compare exactly; numeric values use declared units. It MUST NOT infer equality from similar prose. Fingerprints include the model version and all normative content. The precise serialization and digest mechanism is outside this semantic specification, but one prototype MUST use a single documented convention.

### 2.2 Scope and authority

Blocks form one rooted intent tree. Every non-root Block has exactly one parent; the tree is acyclic. Other relationships may cross the tree and do not grant authority. Hierarchy describes responsibility, not which proposal wins.

The baseline pins an **authority manifest** containing:

- the project root and its responsible authority;
- delegated authorities for narrower Block subtrees;
- any additional guardians for protected requirements, such as access-control obligations;
- the actors permitted to select Compositions and approve Releases.

The smallest responsible scope is the deepest common ancestor of **all affected Blocks**, including affected consumers and constraints, for which an authority is assigned. If no authority is assigned there, responsibility moves upward to the nearest assigned ancestor. Additional guardians retain their approval rights regardless of tree placement.

Authority is checked against the pinned baseline manifest. A proposal cannot authorize itself by changing its owner, parent, scope, or guardian. For v0.1, authority-manifest changes are outside ordinary Layer operations; bootstrap establishes the manifest. A future governance-change mechanism is an open question.

For existing Blocks, authority routing uses their baseline positions. A new Block inherits authority from its nearest enclosing baseline ancestor. A reparenting decision must cover both its old scope and its proposed destination; the new position cannot reduce the approvals needed for that decision.

### 2.3 Model invariants

1. Every semantic change has an owning Layer; no actor edits another actor's Layer.
2. Published revisions, baselines, and Releases are immutable.
3. Every selected dependency resolves to its exact pinned revision.
4. Selection order never supplies semantic precedence.
5. Every effective item has traceable provenance, and every active obligation survives flattening.
6. No Resolution can introduce behavior absent from a semantic proposal or authorize itself.
7. Evidence and approvals apply only to the exact candidate they identify.
8. An unresolved conflict or missing required validation prevents Release publication.

## 3. Block

A Block describes **what must hold for a bounded behavior**, independently of how an implementation realizes it. It is neither a source file nor necessarily a service, UI component, or agent task. A Block should be split when its parts need independent contracts, selection, or responsible scopes.

### 3.1 Required content

| Field | Meaning |
| --- | --- |
| `id`, `revision`, `parent` | Stable identity, immutable revision, and position in the intent tree. |
| `purpose` | A short explanation of the behavior and its boundary. |
| `contract` | Named inputs, observable outputs, failure outcomes, and relevant behavioral conditions. Collections use stable keys. |
| `requirements` | Map of stable requirement IDs to normative statements, structured parameters where applicable, and acceptance references. |
| `relationships` | Typed references to other Blocks or requirements, such as `requires`, `consumes`, or `constrains`. |
| `acceptance` | Map of stable criterion IDs to checks of observable behavior and their validation method. |
| `provenance` | Origins of the Block and its effective semantic items. Derived when composing or flattening. |

A requirement contains `statement`, `kind`, `acceptance`, and optionally `parameters`. `kind` is `rule` or `invariant`. Both are normative; an invariant additionally cannot be displaced merely because a more specific or newer rule exists. All active invariants apply together.

Acceptance criteria identify their subject and specify observable conditions and expected outcomes. A criterion declares `method: mechanical` or `method: review`. A prose criterion is allowed, but cannot be counted as mechanically proven. Every normative requirement MUST reference at least one criterion; each referenced criterion and each criterion's subject MUST exist. Every active acceptance item is an obligation, including criteria shared across requirements. Non-normative rationale is explicitly marked and cannot overrule a requirement.

Example Block, with illustrative revisions and evidence-independent criteria:

```yaml
id: booking.hold
revision: b1
parent: booking
purpose: Reserve a seat temporarily while its customer completes payment.
contract:
  inputs:
    request: {customer: customer_id, seat: seat_id, now: instant}
  outputs:
    held: {hold: hold_id, expires_at: instant}
  failures:
    unavailable: Seat is already held or sold.
requirements:
  expiry:
    kind: rule
    statement: A hold expires 600 seconds after its creation.
    parameters: {duration_seconds: 600}
    acceptance: [expires_at_deadline]
  exclusive:
    kind: invariant
    statement: A seat has at most one active hold at a time.
    acceptance: [concurrent_requests]
relationships: {}
acceptance:
  expires_at_deadline:
    subject: booking.hold/expiry
    method: mechanical
    given: A hold created at time t.
    when: Time reaches t plus duration_seconds.
    then: The hold is no longer active.
  concurrent_requests:
    subject: booking.hold/exclusive
    method: mechanical
    given: An available seat and two simultaneous customer requests.
    when: Both requests are evaluated.
    then: Exactly one hold succeeds and the other request is unavailable.
provenance: {origin: bootstrap}
```

Structured parameters and prose MUST agree. Parameter edits that leave contradictory statements or acceptance criteria are invalid. The prototype need not understand arbitrary language; such inconsistencies require a recorded review when they cannot be checked mechanically.

### 3.2 Semantic items and relationships

The minimum editable unit is a **semantic item**: a requirement record, an acceptance record, a named contract entry, a relationship record, `purpose`, or `parent`. A target identifies the Block, collection, and stable item key. A requirement is replaced as a whole record; concurrent edits to separate words or subfields inside it are not automatically combined.

Create and delete operate on whole Blocks. Deleting a Block conflicts with edits anywhere inside it. A Block deletion is not recursive: every child must be explicitly reparented or deleted, and every inbound reference must be removed or repaired in the same candidate. Deleting a requirement similarly requires repairing its references. There is no implicit cascade.

Relationships carry explicit target IDs and, where useful, required parameter or contract conditions. An `observes` note records a read; it does not create a behavioral dependency. A normative `requires` or `consumes` relationship does. Block relationships may be cyclic when the behavior requires it; the ownership tree and Layer dependency graph may not be cyclic.

## 4. Layer

A Layer is an owned proposal, anchored to one baseline. It contains changes and the assumptions under which those changes were authored. It never mutates that baseline or another Layer.

| Field | Meaning |
| --- | --- |
| `id`, `revision`, `owner` | Layer identity, immutable revision, and sole semantic writer. |
| `baseline` | Exact baseline snapshot reference. |
| `intent` | The intended result of this proposal. |
| `changes` | Stable change IDs with target, operation, expected prior value, and proposed value. |
| `requires_layers` | Exact peer Layer revisions whose inclusion this proposal requires. |
| `read_set` | Exact baseline items or peer Layer revisions read, marked `informational` or `required`. |
| `assumptions` | Conditions over the effective candidate that must hold for the Layer to remain valid. |
| `acceptance` | Additional criteria applying whenever this Layer is selected. |
| `resolution_proposals` | Optional proposed decisions, authored under the same ownership boundary. |
| `derived_from` | Optional exact source revisions and change IDs for extracted or combined proposals. |

The operations are `create_block`, `delete_block`, `set_item`, and `remove_item`. For an item absent from the baseline, the expected value is explicitly `absent`; otherwise it is the exact prior value or its fingerprint. Missing and null are different values. Invalid operation shapes are rejected before composition.

Encode `expected` as exactly one tagged form: `{kind: absent}`, `{kind: value, value: <prior-value>}`, or `{kind: fingerprint, fingerprint: <prior-fingerprint>}`. This keeps an absent item distinct from a literal value such as null or the string `absent`.

A change record is `{id, op, target, expected, value}`; `value` is omitted for deletion/removal. A Block target is `{block: <id>}`. An item target is `{block: <id>, collection: <name>, key: <stable-key>}`. Allowed item collections are `requirements`, `acceptance`, `relationships`, `contract.inputs`, `contract.outputs`, `contract.failures`, and `metadata`. Metadata keys are limited to `purpose` and `parent`; identity, revision, authority, and derived provenance cannot be directly edited.

| Operation | Preconditions and effect |
| --- | --- |
| `create_block` | Block ID is new and absent; value is the complete Block definition, excluding derived revision/provenance. |
| `delete_block` | Expected complete baseline Block matches; remove the Block subject to reference and child checks. |
| `set_item` | Expected baseline item or explicit absence matches; add or replace the complete item value. |
| `remove_item` | Expected existing baseline item matches; remove it subject to reference and required-field checks. |

All operation preconditions are checked against the pinned baseline, not whichever Layer happens to be applied first. Within one Layer, a target MUST have one final proposed value or deletion; repeated sequential assignments are invalid. A newly created Block carries its complete initial contents.

Layer-level acceptance criteria declare stable IDs and subject Blocks. During composition, before validation, they become acceptance items on those Blocks: additions to existing Blocks require an absent baseline item; criteria for a Block created by the same Layer become part of its creation. Revising an inherited criterion uses an explicit `set_item` or `remove_item`. These normalized additions participate in ordinary collision checks. Flattening therefore adds no previously untested obligations or semantic items.

For v0.1, a Layer containing `resolution_proposals` has no behavioral changes or new acceptance definitions. It is a decision-only Layer. Its owner writes the outcome and rationale; the separate Resolution record later binds that frozen proposal to exact inputs and endorsements. This avoids a Layer needing to contain its own revision fingerprint.

**Prototype restriction:** Layers in one Composition share the same baseline. They may depend on and reference entities introduced by peers, but cannot patch a Block that exists only in another unreleased Layer. Such a change requires a replacement creation proposal or a new Layer after flattening. This avoids inventing an implicit order of patch execution.

### 4.1 Reads and writes

| Action | Rule |
| --- | --- |
| Read a baseline or published Layer | Any actor with project read access may inspect it, including proposals not selected in the current Composition. |
| Edit a Layer draft | Only its owner. A collaborator creates a separate Layer. |
| Publish a Layer revision | Freeze that revision; further edits create a new revision. |
| Use another Layer's behavior | Declare the exact dependency and relevant assumptions. Seeing it is not sufficient. |
| Propose a correction or resolution | Write the proposal into the actor's own Layer; never patch the other actor's Layer. |
| Approve a decision | An authorized actor endorses exact proposal content. Endorsement does not grant editing rights. |
| Select or flatten | A permitted control action over pinned records; it cannot introduce new semantic content. |

An agent acting as a scope authority still authors every semantic change in its own Layer. Composition selection, approval attestations, and deterministic snapshot production are control or derivation operations, not permission to write another Layer.

A required peer read MUST have a matching `requires_layers` entry. Its exact revision must be selected; substitution by a newer revision is not allowed. Informational reads remain provenance only. A read dependency cannot reliably be inferred from natural language, so authors MUST declare relevant dependencies; review must challenge missing ones.

Required assumptions are evaluated against the final effective candidate. If their checks are unavailable or their truth is unknown, the Composition is blocked. A Resolution cannot simply label a stale assumption as satisfied. The owner must publish a corrected revision, or a new replacement Layer must take explicit responsibility for the changed intent.

## 5. Composition

A Composition is an immutable selection recipe and evaluation context, not an edit to the source objects.

| Field | Meaning |
| --- | --- |
| `id`, `revision`, `model_version` | Candidate identity and semantic rules in force. |
| `baseline` | Exact starting snapshot, including its authority manifest. |
| `proposals` | Finite set of exact Layer revisions under consideration, including alternatives. |
| `selected` | Subset of `proposals` whose changes and obligations are active. |
| `alternative_groups` | Named groups with explicit minimum/maximum selections and member Layer revisions. |
| `scenario` | Fixed semantic context for this candidate, such as a named experiment variant; no hidden environment-dependent overrides. |
| `resolutions` | Exact authorized Resolution records relevant to the proposal set. |

Evaluation derives the effective snapshot, provenance, required approvals, acceptance obligations, and conflicts. Evaluation reports and evidence bind to the immutable Composition fingerprint. They do not mutate the Composition.

Selection is whole-Layer in v0.1. A composer may cherry-pick complete Layers, provided all dependencies and group constraints remain satisfied. For a partial cherry-pick, an actor authors a new Layer containing the extracted intent, declares its dependencies, records `derived_from`, and obtains fresh validation. Extraction is a new proposal, not a partial application switch.

Every selected Layer's normative changes and acceptance obligations remain active. A Resolution MUST NOT retain half of a selected Layer while silently discarding the other half. To combine selected parts of competing proposals, create a replacement Layer and deselect the originals. Required dependencies must be explicitly carried over or replaced; deselecting a dependency without repairing its consumers blocks composition.

Layer order, timestamps, visual height, agent seniority, and incidental traversal order carry **no precedence**. Reordering the same pinned selection MUST produce the same effective snapshot or the same conflict set.

### 5.1 Evaluation results

- `blocked`: malformed input, conflict, failed/unknown assumption, missing dependency, missing required decision, or failed/unknown structural validation.
- `eligible_for_validation`: a complete semantic candidate with no known unresolved conflict; behavioral acceptance and release approvals may still be pending.
- `validated`: all required semantic checks and acceptance evidence pass for the exact candidate, and required approvals are present.

These are derived results, not user-set flags. A structurally composable candidate is not proof of correct application behavior. Failed behavioral validation prevents `validated` even if it produces no new structural conflict.

## 6. Resolution and conflict rules

A conflict is a recorded incompatibility or unresolved interaction that prevents treating selected intent as one coherent candidate. A conflict record identifies its kind, affected items, contributing baseline/Layer revisions, impact set, and responsible authority. An agent's suggested answer is only a proposal until authorized.

### 6.1 Detection and precedence

| Situation | Required result |
| --- | --- |
| Disjoint writes, valid references, compatible obligations | Compose together; validate their combined behavior. Disjointness alone does not establish compatibility. |
| Identical writes to the same semantic item, with the same precondition | Coalesce the value and retain all contributing provenance and acceptance obligations. |
| Different writes to the same item | Conflict; no last-writer-wins rule. |
| Delete versus edit, or two creations reusing one Block ID | Conflict, even if the two creations look similar. |
| Missing dependency, wrong revision, or failed precondition | Block; repair the proposal or selection. |
| Distinct items with incompatible behavior | Semantic conflict, even though there is no shared write target. |
| Rule violates an active invariant | Block; a narrow/local rule cannot override the invariant. |
| Competing proposals in an exclusive alternative group | Select within the declared cardinality; never blend alternatives implicitly. |
| Compatibility remains unknown | Record the uncertainty and require targeted checks or review before release. |

Two removals of the same existing item coalesce. Whole-Block deletion may coalesce only when it is the same deletion and there are no conflicting edits or unresolved references. Unchanged baseline intent remains active unless explicitly changed or removed by selected intent.

The prototype is responsible for exact-target conflicts, structural validity, declared dependency/assumption checks, and declared constraint checks. It must also accept explicit semantic-conflict reports from people or agents. It is not required to discover every contradiction hidden in prose. A review must explicitly cover interactions that have no mechanical check; silence is not positive evidence of compatibility.

### 6.2 Intent proximity routes decisions

Compute the affected set from changed Blocks, referenced contracts, impacted consumers, and applicable invariants. Use the smallest responsible scope from section 2.2. Undeclared or uncertain impact requires widening the scope or obtaining a recorded impact review; an author cannot obtain narrower authority simply by omitting a consumer.

For example, hold-expiry and cancellation behavior may be resolved within `booking`. A disagreement between `booking` and `payment` goes to their common application scope. A protected access-control invariant also requires its designated guardian. None of these authorities wins by placing a Layer higher in a stack.

### 6.3 Resolution record and allowed outcomes

A Resolution contains:

- `id`, immutable `revision`, and the originating resolution proposal's Layer revision;
- `input_fingerprint`: baseline, model version, scenario, alternative-group definitions, and the complete proposed Layer set;
- the exact conflict IDs, affected items, and impact set being decided;
- an outcome, rationale, responsible scope, and required authority endorsements;
- acceptance obligations or review evidence supporting the decision.

The originating decision-only Layer is pinned through the Resolution; it need not be included in the behavioral proposal set or selected. Its baseline must still match. The Resolution's fingerprint and endorsements are added after that source Layer is frozen, not written back into it. Acceptance obligations mentioned by a Resolution reference criteria already defined in the semantic candidate; new criteria require a behavioral Layer.

The input fingerprint excludes `selected` and Resolution references to avoid circularity: the decision prescribes selection, and the Composition must match it. Any change to the listed fingerprint inputs invalidates the Resolution in v0.1, even an apparently unrelated added Layer. A coexistence decision requires its named participants to remain selected. Selection changes also create a new Composition fingerprint and invalidate candidate-level evidence and approvals. This conservative rule is intentionally simpler than impact-based reuse.

Allowed outcomes are:

1. **Select/reject whole proposals.** Name accepted and rejected Layer revisions. The candidate selection must comply, and retained consumers must still have their dependencies.
2. **Accept coexistence.** Establish that a reported interaction is compatible, with evidence. This cannot waive a structural collision, failed assumption, or violated invariant.
3. **Select a replacement proposal.** Name a separately authored Layer carrying the reconciled intent and reject superseded Layers. New behavior must already exist in that replacement Layer.
4. **Defer.** Leave the conflict unresolved. A deferred decision does not permit flattening.

For a replacement, first include its exact revision in the proposal set; then authorize the Resolution against that set. Decisions that disagree with each other block the candidate. There is no implicit priority among Resolution records.

Normative changes require approval from the smallest responsible authority before release even when they do not cause a collision. Changes to or removal of a protected invariant also require its baseline-designated guardian. An invariant can be deliberately revised through explicit changed intent and those approvals; a Resolution cannot waive an unchanged invariant. Reparenting never evades the old authority check, and requires approval covering both old and new scopes.

## 7. Validated flattening and Release

### 7.1 Compose versus flatten

`compose(C)` evaluates pinned intent without publishing a new baseline. It may produce a blocked report or an eligible snapshot for building and testing a preview.

`flatten(C, evidence, approvals)` is allowed only when the exact Composition is validated. It publishes a new immutable Release whose effective snapshot can be used directly as a baseline. It does not concatenate code, replay text patches, erase Layers, or ask a model to invent missing conflict decisions.

Flattening is one indivisible semantic operation: either a complete Release is published, or no Release is created. A partially flattened Release is invalid. Calling it again with the same pinned candidate, evidence, and approvals identifies the same result; it must not create a new semantic state through ordering or randomness.

### 7.2 Required evaluation sequence

1. **Pin and validate inputs.** Resolve exact revisions; check model version, ownership, authority manifest, common baseline, and input fingerprints.
2. **Validate selection.** Enforce alternative-group cardinality, dependency closure, and Resolution outcomes. Reject Layer dependency cycles.
3. **Check proposals.** Check operation preconditions against the baseline; validate declared read dependencies and ownership of semantic proposals.
4. **Derive effective intent.** Coalesce identical eligible writes; report structural conflicts; apply the conflict-free semantic changes as a set.
5. **Validate the full snapshot.** Check intent-tree integrity, references, contract conditions, active invariants, final-state assumptions, and all reported semantic interactions. No unresolved conflict or unknown required check may remain.
6. **Validate a realization and approvals.** Obtain all acceptance evidence and required authority endorsements for this exact candidate and at least one pinned implementation-profile reference.
7. **Freeze the Release.** Publish the effective snapshot, obligations, lineage, evidence, and approvals together.

Steps 4–6 may expose additional interactions. That returns the candidate to blocked or failed validation; it does not authorize an automatic repair. Any semantic repair creates a new Layer revision and Composition and requires fresh applicable decisions and evidence.

### 7.3 Release contents

| Field | Required content |
| --- | --- |
| `id`, `model_version` | Immutable Release identity and semantic rules. |
| `baseline` | Exact parent baseline; v0.1 has one semantic parent per Release. |
| `composition` | Exact Composition and its full selected/considered proposal and Resolution references. |
| `snapshot` | Complete effective Blocks, relationships, and pinned authority manifest; usable without replaying Layers. |
| `provenance` | Per-item origins, superseded/deleted-item records, contributing decisions, and extraction lineage. |
| `acceptance_manifest` | All active Block criteria and surviving selected-Layer obligations, with stable IDs and owners/scopes. |
| `validation` | Complete check results and at least one completed realization-validation record. |
| `approvals` | Scope, guardian, and release-authority endorsements bound to the exact validated candidate. |

A selected Layer's acceptance obligations survive flattening even when they were initially authored at Layer level. As normalized during composition, they are already acceptance items on their declared subject Blocks in the validated snapshot. The Release carries them into the next baseline's obligation set. They cannot disappear when the original Layer is no longer selected. Revising or removing a carried obligation requires an explicit semantic proposal and approval by its responsible scope.

Realization evidence includes the candidate fingerprint, a pinned implementation-profile reference, an exact tested-realization identifier, check IDs and versions, input/fixture references, observed results, and reviewer identity where applicable. A realization identifier binds evidence to the artifact actually tested; it does not make generated code a separately versioned source of intent. Profile contents, build mechanics, artifact retention, and test execution are outside this document.

**Proposed release gate:** a semantic-only candidate may be previewed, but is not a Release until a realization passes the required acceptance criteria. Manual behavioral review is allowed where explicitly declared; missing, unknown, or failed results block release. Approving a missing test is not equivalent to passing it.

The same semantic Release may be realized with another implementation profile. That realization needs its own evidence; the earlier evidence does not prove the new realization correct or byte-identical. Additional realization attestations reference the existing immutable Release rather than rewriting it.

### 7.4 What flattening preserves

Flattening removes the need to replay selected proposals to discover current intent. It preserves enough provenance to explain why an item exists and which alternatives were considered or rejected. Rejected proposal content remains historical material and never leaks into the effective snapshot.

A Release is not a deployment, a mutable environment pointer, or proof that natural-language intent was exhaustively captured. Its guarantee is bounded: the recorded checks and approvals passed for the recorded semantic candidate and tested realization.

Old baselines remain valid historical inputs. Moving work to a newer baseline requires a new Layer revision with reviewed preconditions and assumptions; there is no automatic rebase. Removing a Layer from a future Composition cannot undo intent already flattened into its baseline. A revert is a new explicit Layer, or selection of an older Release as a baseline for separate work.

## 8. Minimal worked examples

All IDs and revision strings below are illustrative. Ellipses are avoided; table rows describe only the changes relevant to each example. Full Layer records must still include the fields in section 4.

### 8.1 Independent work composes; stale cross-layer reads do not

Baseline `R0` contains `booking.hold/expiry = 600 seconds` and `booking.receipt/channel = email`.

| Layer | Owner | Proposed intent | Required peer read |
| --- | --- | --- | --- |
| `L-hold@1` | Agent A | Replace the complete expiry requirement with 900 seconds and matching prose. | None |
| `L-receipt@1` | Agent B | Replace receipt channel with email plus an in-app receipt, with matching criteria. | None |

`C1` selects both Layers at `R0`. Their write targets differ. After checking their combined behavior and obtaining approval, flattening produces `R1` with both changes. Neither agent edited the other's Layer.

Now `L-reminder@1`, also anchored to `R0`, proposes a reminder 60 seconds before expiry. It declares `requires_layers: [L-hold@1]`, a required read of that revision, and an assumption that effective expiry is 900 seconds. Selecting `L-reminder@1` with `L-hold@2`, which proposes 1200 seconds, is blocked by the revision mismatch. Selecting `L-hold@1` while another proposal changes effective expiry also fails the assumption or creates a write conflict. Reading the newer Layer does not repair either problem; a new reminder revision must acknowledge it.

### 8.2 Conflicting values require a decision or a replacement

At `R0`, `L-A@1` proposes expiry of 900 seconds and `L-B@1` proposes 1200 seconds, each replacing `booking.hold/expiry`. Selecting both yields a conflict on one semantic item.

The `booking` authority may endorse selection of `L-A@1` and rejection of `L-B@1`. The resulting Composition still records both as considered proposals but selects only A. Its Resolution binds to the pinned proposal set. Reversing visual Layer order changes nothing.

If the desired answer is 1050 seconds, an actor first authors `L-C@1` with that requirement and consistent acceptance criteria, recording `derived_from: [L-A@1, L-B@1]`. A new proposal set includes A, B, and C. A Resolution against that set selects C and rejects A and B. The value 1050 cannot exist only in a Resolution's explanatory text.

If the baseline also contains a protected maximum hold duration of 1000 seconds, the 1050-second candidate remains blocked. It needs an explicit amendment of the cap and its guardian's approval, or a different proposal that respects the unchanged cap.

### 8.3 Different targets can still contradict

Baseline intent permits finalizing payment only while the associated hold is active.

| Layer | Changed item | Proposed intent |
| --- | --- | --- |
| `L-expiry@1` | `booking.hold/expiry` | Expire and release an unpaid hold after 600 seconds. |
| `L-payment@1` | `payment.authorization/finalize_window` | Permit finalizing that hold's payment through 900 seconds without renewing the hold. |

The writes are disjoint, but the payment promise is incompatible with the active-hold rule after 600 seconds. A declared contract condition or a boundary acceptance scenario must expose this interaction; otherwise a semantic review must report it.

The affected set includes both booking and payment, so resolution goes to their common application scope. A replacement may introduce an explicit renewal contract, or the authority may select compatible proposals instead. Passing each Layer's isolated test does not resolve the combined contradiction. A candidate must demonstrate the agreed behavior across the expiry boundary before flattening.

### 8.4 Alternatives produce separate candidates

An alternative group `hold-policy` contains `L-short@1` and `L-long@1`, with `min_selected: 1` and `max_selected: 1`.

- `C-short` selects short and has scenario `hold-experiment/short`.
- `C-long` selects long and has scenario `hold-experiment/long`.
- Selecting both in one candidate violates the group's cardinality.

Each candidate is validated independently and can produce its own Release. The model does not imply runtime traffic splitting. One application containing both behaviors would need explicit routing intent and acceptance criteria in its own selected Blocks. A budget for evaluating alternatives limits which candidates are attempted; it never relaxes release gates or gives a cheaper candidate semantic precedence.

### 8.5 Flattened intent becomes inherited intent

After `C1` is flattened into `R1`, expiry is 900 seconds in the baseline itself. A Composition based on `R1` with no selected Layers still contains the 900-second rule and its acceptance obligations. Omitting `L-hold@1` does not restore 600 seconds.

To restore 600 seconds, an agent authors a new Layer against `R1`, expecting 900, with explicit replacement intent and fresh validation. `R1` and the original Layers remain unchanged. A missing or failed acceptance result prevents publication of the proposed next Release and leaves all earlier Releases intact.

## 9. Prototype conformance checklist

These are observable semantic requirements, not a prescribed implementation architecture.

| Input or action | Required observable result |
| --- | --- |
| Agent A attempts to edit Agent B's Layer | Denied; B's revision remains unchanged. |
| Reorder the same pinned selected Layers | Same effective snapshot or conflict set. |
| Two differing values for one semantic item | Conflict with both contributors named. |
| Same value proposed twice | One effective value, both provenances and obligations retained. |
| Required peer is absent or has another revision | Candidate blocked; no silent substitution. |
| Selected Layers have different baselines or cyclic Layer dependencies | Candidate blocked. |
| Delete a referenced Block, or its parent without reparenting | Candidate blocked until references/tree are repaired. |
| Resolution lacks required authority or has a stale fingerprint | Resolution cannot authorize the candidate. |
| Local rule contradicts an unchanged ancestor/guarded invariant | Candidate blocked regardless of Layer placement. |
| Extract part of a Layer without a new owned proposal | Rejected. |
| Any required evidence is missing, unknown, failed, or for another candidate | Flattening rejected; no partial Release. |
| Flatten a validated candidate | Complete immutable snapshot, inherited obligations, and traceable provenance. |
| Rebuild the same Release with another profile | New realization evidence required; semantic Release remains immutable. |
| Remove a previously flattened Layer from selection | No reversal of the baseline's effective intent. |

## 10. Unresolved design questions

The defaults above are sufficient to build a conservative prototype. These questions remain open; none permits silently weakening those defaults.

| Question | v0.1 default | Decision needed later |
| --- | --- | --- |
| How formal should contracts and requirements become? | Structured parameters and explicit criteria plus reviewed prose; no new programming language. | A minimum interoperable contract vocabulary and which behaviors must be machine-checkable. |
| How are duplicate or overlapping meanings detected across different IDs? | Review reports semantic overlap; exact ID checks only detect structural collisions. | Reliable semantic discovery without treating model guesses as authority. |
| How is the complete impact set established? | Declared relationships plus explicit interaction review; widen scope when uncertain. | Better dependency completeness and impact analysis. |
| Who may delegate, replace, or override an authority? | Bootstrap manifest is fixed for ordinary prototype work. | Explicit governance transitions, emergency changes, and competing guardian decisions. |
| Can parts of a Layer be selected directly? | No; extract a new owned Layer with provenance. | Safe sub-Layer units and preservation of coupled obligations. |
| Can stale proposals or Resolutions be reused automatically? | No automatic rebase or Resolution reuse after its input fingerprint changes. | Narrow, demonstrably safe invalidation and revalidation rules. |
| How are peers' new entities extended before flattening? | Reference them, but do not patch them across Layers. | Ordered refinement semantics without implicit precedence. |
| How complete must realization evidence be? | At least one pinned realization, all declared criteria satisfied, explicit manual review where required. | Stronger adequacy standards and portable evidence between profiles. |
| What makes two implementations equivalent? | Both may satisfy the same contract; byte identity and exhaustive equivalence are not claimed. | Cross-profile behavioral equivalence and nondeterminism boundaries. |
| How does A/B evaluation choose a winner? | Separate pinned candidates and explicit authorized selection. | Outcome metrics, evaluation budgets, and runtime experiment semantics. |
| How are carried acceptance obligations revised as Blocks evolve? | Explicit acceptance-item change with responsible-scope approval. | Richer obligation lineage across splitting and combining Blocks. |

The central limit remains explicit: deterministic composition of records is achievable; complete understanding of arbitrary human intent is not guaranteed. Strata's prototype must make uncertainty, decisions, and evidence visible while keeping the intended behavior portable.
