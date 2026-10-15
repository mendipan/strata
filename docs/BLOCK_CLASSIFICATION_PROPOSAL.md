# Block classification and materialization proposal

Status: Design proposal for integration review; not an amendment to the canonical model.  
Date: 2026-10-03.  
Scope: Block classification, design intent, semantic targeting, and the contracts needed by core, CLI, and GUI work.

## 1. Recommendation

**Keep one kind of Block. Give its requirements a small, nonexclusive set of semantic facets, and make every realization account for how it implements and validates the active intent.**

A Block is a bounded unit of application intent with a contract, requirements, relationships, and acceptance criteria. That intent may describe behavior, an experience, information, or a constraint. A visual composition and a state transition can therefore both be Blocks. A checkout Block can include both. Split a Block when its parts need independent contracts, selection, or responsible scopes, as the existing model already recommends.

Use **Behavior, Design, Data, and Safety** as an initial vocabulary of overlapping facets. These are useful views of requirements, not four incompatible Block classes. Their machine-visible job is to help select relevant implementation capabilities and checks. Their presence does not prove fulfillment, and their absence must never exclude an active obligation from materialization.

The missing link is an explicit, inspectable chain:

`requirement -> semantic subjects/dependencies -> profile implementation targets -> produced artifacts -> acceptance evidence`

Color visualizes that chain; it does not supply its meaning. This adds a small classification field and a materialization coverage contract, not a programming language or a new inheritance system.

## 2. Basis, established intent, and proposal boundaries

The design basis is the repository’s [semantic model](../STRATA_MODEL.md). This proposal adds classification and coverage vocabulary without replacing ownership, authority or Release rules.

The [CLI plan](CLI_PLAN.md) supplies the complementary materialization/distillation interface. Unsupported intent must fail explicitly; classification inferred from an implementation remains a reviewed, owned proposal.

| Commitment level | What belongs here |
| --- | --- |
| Established direction in model §1 | Durable distilled intent; disposable generated implementation; owned Layers with shared reads; explicit proposal selection; responsibility based on affected intent; validated flattening with provenance; actual working realizations. |
| Explicit direction for this task | Resolve how types, design, semantic tags, and translucent GUI colors fit together. Tags must guide relevant implementation work. Preserve platform-neutral intent where possible. Explain tradeoffs and review gates. Author only this proposal. |
| Existing proposed model defaults | Stable semantic items; rule versus invariant; whole-Layer selection; common baseline; exact fingerprints; fixed authority manifest and guardians; conservative evidence invalidation. These remain proposed defaults, not retrospective claims of user approval. |
| New recommendations in this document | Four initial facets on requirements; derived Block summaries; a complete realization coverage manifest; classification review in distillation; GUI conventions; explicit versioning of any adopted schema change. |

The Cloudflare Agents/Artifacts direction and the local-only, no-cost boundary remain inputs from the core plan. This proposal makes no new claim about Cloudflare APIs, pricing, or provisioning. It calls for no deployment, service setup, package installation, or remote model invocation.

All worked business rules below are **illustrative proposed intent**, not additional user requirements. The hold/reminder timings are drawn from the prototype plan; the visual, retention, and privacy policies illustrate the refinement.

## 3. Separate classification from contracts and targeting

| Concept | Question it answers | Where it belongs | What it cannot do |
| --- | --- | --- | --- |
| Block identity and boundary | What coherent intent are we discussing? | Existing Block ID, purpose, parent, contract. | Become a file, framework component, database table, or task assignment merely because of its name. |
| Contract types | What information and observable outcomes are valid? | Existing named inputs, outputs, failures, conditions, and bounded parameter schemas. | Classify the entire Block as exclusively UI or logic. |
| Requirement kind | Is this a rule or an invariant? | Existing `kind: rule\|invariant`. | Be replaced by a domain label such as Safety. |
| Semantic facets | Which concerns must implementation planning and review consider? | Proposed `facets` on each requirement; derived Block summary. | Generate unstated obligations, waive stated ones, establish authority, or prove correctness. |
| Semantic relationships | Which intent does this depend on, consume, or constrain? | Existing explicit Block/requirement relationships. | Select a Layer, grant authority, or identify a source file implicitly. |
| Implementation binding | Which concrete parts realize this obligation under this profile? | Pinned profile plus per-realization coverage manifest. | Rewrite intent or narrow it to the profile's convenient subset. |
| Informal labels | How would someone like to find or organize this? | Non-normative UI/project annotation, outside the semantic candidate. | Affect composition, coverage, approvals, or release status. |
| Color and layout | How can a person scan the above? | GUI presentation configuration. | Create semantic precedence or substitute for readable labels. |

Do not introduce `Block.type = design | logic | data | safety`. A single discriminator encourages false choices: a deadline display consumes data, presents information, changes interaction behavior, and may prevent an unsafe action. It also makes changing a boundary look like changing an object's class.

“Design Block” remains useful conversational shorthand for a Block whose requirements largely concern experience. “Logic Block” means a predominantly behavioral Block. Neither phrase creates a different storage schema or composition algorithm.

## 4. Minimal facet semantics

### 4.1 Initial vocabulary

| Facet ID / displayed label | Meaning | Typical planning and validation attention |
| --- | --- | --- |
| `behavior` / Behavior | Observable responses, decisions, state transitions, sequencing, timing, and failure outcomes. | Decision paths, interaction handlers, clocks/scheduling, boundary and scenario checks. |
| `design` / Design | Intended perception and interaction: layout, hierarchy, content, visual identity, motion, navigation, and accessible use. | Relevant views and states, rendering/content assets, keyboard/assistive interaction, visual and usability review. |
| `data` / Data | Information meaning and shape, identity, integrity, lifetime, retention, and exchange. | Representations, persistence, serializers, lifecycle jobs, compatibility and integrity checks. |
| `safety` / Safety | Explicit protection against unacceptable outcomes, including access, privacy, misuse, or harmful failures. | All relevant enforcement and disclosure paths, negative cases, redaction, impact review, and any already designated guardians. |

This deliberately mixes concern domains that overlap. It is a small routing vocabulary, not a claim that software has four fundamental categories. Accessibility can be expressed with Design and, when protection is material, Safety. Performance can be a behavioral or data requirement with units and criteria. Do not add a facet for every adjective before a real routing need appears.

Facets have defined planning consequences but no hidden product policy. A Safety facet does not imply encryption, authentication, a particular guardian, or `kind: invariant`; those must be explicit. A Design facet does not imply a browser, React, a design system, or a screenshot test. Data does not mandate a database.

### 4.2 Where facets live

For an adopted classification-enabled model version, add one field to a requirement record:

```yaml
# Illustrative complete requirement value, not a complete Block or Layer.
kind: rule
statement: A hold expires 900 seconds after its creation.
parameters: {duration_seconds: 900}
facets: [behavior, data]
acceptance: [expires_at_deadline]
```

The requirement remains the atomic editable item. Its statement, parameters, facets, and acceptance references change together through the existing `set_item` operation. Do not add a separate facet edit operation or allow independent field merges.

Proposed representation rules:

- Each requirement in the new version has a nonempty set of recognized facet IDs. Canonicalize input order to a sorted array before comparison and fingerprinting, and reject duplicates; set semantics are explicitly limited to this field.
- The vocabulary and its definitions are pinned by the model version. Unknown facet IDs are unsupported semantic input, not silently accepted custom tags.
- Derive a Block's facets as the union of its own requirements' facets. Do not store a second authoritative Block classification that can disagree.
- A collapsed tree may show a separately labeled “subtree facets” summary. Descendant facets do not become the parent's own requirements.
- An unclassified legacy item is displayed as **Unclassified**, not silently assigned Behavior. No inference is represented as an accepted classification.
- Contract entries, relationships, and standalone acceptance items still require coverage even though this minimal extension does not add facets to their record shapes.

Recognized semantic facets participate in requirement fingerprints and normal review. A facet change can change routing and evidence needs, so it is not a cosmetic edit. Conversely, removing Safety from a requirement cannot remove its actual protection, existing guardian, or acceptance criteria.

Keep free labels such as `checkout-redesign`, `team-alpha`, and `idea` visibly non-normative. If someone expects a label to change implementation, promote that expectation into an explicit requirement, classification, or binding and review it. Do not execute arbitrary label text as an instruction.

### 4.3 Machine-checkable meaning without a language

The machine can check recognized facets, parameter schemas and units, reference validity, profile support, complete mappings, and declared acceptance results. It cannot establish that a prose requirement is implemented simply because a target carries the same tag.

For the first profile, bind known requirement shapes and acceptance criteria to named, versioned validators and implementation capabilities. For example, the booking profile recognizes the declared expiry parameter and tests its boundary. It must reject an unfamiliar normative parameter or report that its interpretation needs review; recognizing `behavior` is insufficient.

Retain the model's distinction between mechanical checks and review. “Clear visual hierarchy” may need recorded review on an actual view; an integer duration can have an executable boundary test. Do not count a prose check as mechanically proven or downgrade a declared mechanical criterion to review because a profile lacks the checker.

No general predicate syntax, inheritance declarations, tag expressions, automatic theorem proving, or extensible type hierarchy is needed initially. Later vocabulary extensions should be versioned, documented, and supported explicitly before they can influence materialization.

## 5. Design belongs in durable intent

Design is part of what an application promises people. A Block can specify that a person sees the current status before acting, that an error explains how to recover, that a brand asset is used, or that a layout preserves a reading order. Those requirements are as durable as a retry rule.

A design contract describes observable inputs and outputs: application states and user actions in; presented information, available actions, navigation, and failure experiences out. A data contract can similarly describe information and lifecycle conditions. Neither needs fake function calls to fit the existing contract envelope.

Separate three things:

1. **Required experience:** hierarchy, content, interaction, accessibility, necessary brand details, and observable behavior. Keep these in semantic requirements and acceptance criteria.
2. **Reference material:** mockups, screenshots, assets, and design tokens. Pin their identity when normative, describe what must match, and declare whether interpretation is mechanical or reviewed. An inspiration image is explicitly rationale; it does not silently become a pixel-exact obligation.
3. **Realization choices:** CSS layout, native controls, component libraries, state-management mechanisms, rendering technology, and file locations. Put these in the implementation profile and its binding/output records unless the user specifically requires them.

Platform-neutral does not mean visually vague. Exact copy, a required logo, reading order, supported states, and a declared contrast or spacing requirement can be intent. If the requirement deliberately names a browser affordance or native interaction, preserve it as a platform-specific promise; do not claim every profile can realize it.

Use shared design Blocks when intent deserves an independent contract or selection boundary: application navigation, a brand system, or accessible status feedback. Relate feature Blocks explicitly to those contracts. Avoid splitting every visual property into its own Block or creating a parallel design tree that hides feature-level dependencies.

## 6. Materialization must account for the whole candidate

### 6.1 Planning and implementation binding

The existing model already requires a pinned implementation profile and evidence for the actual realization (§7). Refine that boundary with a **coverage manifest** produced for every materialization. Make it a section of the existing realization manifest, not a sixth core semantic object or a separate approval workflow.

A profile advertises its supported model version, facet vocabulary, bounded semantic shapes, implementation capabilities, and validation methods. Capability names are profile-local and versioned: for example, `hold-engine`, `checkout-view`, `receipt-store`, and `diagnostic-redaction`. They are neither new Block types nor normative file paths.

Given a candidate, the materializer must:

1. Enumerate all effective obligations, including unchanged baseline requirements, active invariants, normative contract entries and relationships, and every acceptance criterion. Include normalized Layer-level criteria and criteria not referenced by a requirement.
2. Determine applicable semantic subjects from the actual requirement, scenario, and relationships. Facets are an index into relevant capabilities; they are not an eligibility filter that can discard other requirements.
3. Bind each obligation to all necessary implementation targets, supporting artifacts, and checks. Explain the mapping, including external dependencies used to satisfy it.
4. Check for unsupported or missing coverage before claiming complete materialization. Unknown prose applicability produces a review obligation, not an assumed omission.
5. Generate the realization, finalize exact artifact identities, and validate behavior against the complete acceptance manifest.

For every declared facet, record the capability/target and validation method that handles that concern; several facets may share one target or check. If an existing binding already handles the concern, record that explicit rationale instead of creating redundant implementation. An unhandled facet is a reported support gap, even when the profile recognizes the requirement's name. Conversely, a missing facet must never hide an obligation expressed by the requirement or its relationships.

A requirement can affect many implementation parts. One part can implement many requirements. For a protected confirmation action, relevant parts may include the view, authoritative command handler, persisted state, error serialization, and telemetry. A route based only on “Safety -> security module” would be incorrect.

This contract does not prescribe file organization. The profile can emit one file or many. Its resulting manifest identifies concrete files, modules, configurations, assets, or external capability references within a pinned realization so reviewers can find what was actually built.

### 6.2 Minimum coverage-manifest content

| Content | Purpose |
| --- | --- |
| Exact semantic candidate/Release and model version; exact profile and materializer reference | Fix the interpretation and input being realized. |
| Complete obligation inventory by stable semantic item reference | Make omission visible, including inherited and crosscutting intent. |
| Per-obligation facets, applicable subjects, mapping rationale, and profile capability targets | Explain why relevant parts were selected. |
| Concrete output artifact references and digests; pinned external dependencies and configuration | Identify what implements the promise. Do not copy secrets into the manifest. |
| Acceptance/check references and versions, fixtures, observed outcomes, and review references | Distinguish planned handling, implementation, and demonstrated satisfaction. |
| Explicit unresolved, unsupported, or unvalidated entries | Prevent an incomplete build from looking complete. |
| Exact tested output-tree identity and implementation-to-intent reverse links | Support inspection and invalidate evidence when output changes. |

Use readable per-obligation handling states such as **unmapped**, **unsupported**, **implemented / validation pending**, and **verified**. These are coverage details, not replacements for the model's candidate states. A successful generator or a populated mapping is not verification.

No active obligation may disappear through a whole-requirement “not applicable” switch. A genuinely conditional requirement can have an explicitly evaluated condition and evidence under the pinned semantic scenario; the criterion still needs its declared result. Unsupported profiles, absent UI targets, and missing checkers are not such conditions. If applicability cannot be established, it remains unresolved.

An implementation target can be an existing pinned component or external dependency; it need not always be newly generated code. Evidence must establish its role in the tested realization. A test file alone is not an implementation of a production requirement.

### 6.3 Success, partial output, and release gates

- **Semantic composition:** Design and Data requirements compose under the same rules as Behavior. Semantic eligibility does not mean every profile supports the candidate.
- **Complete materialization:** All active intent is accounted for with actual implementation coverage. Acceptance may still be pending; the result must say so.
- **Validation and flattening:** All required mechanical and review criteria pass for the same pinned candidate/profile/output, with the existing required approvals.
- **Diagnostic partial output:** If later supported, report it explicitly as incomplete and non-releaseable. Do not return the normal complete-materialization success or reuse it to satisfy the missing obligations.

Keep partial exports out of the first CLI unless needed; the current CLI proposal correctly fails on unsupported intent. Unsupported materialization should name the exact obligation, reason, profile capability gap, and affected targets.

A command-only profile cannot realize an explicit visual-layout promise. It may satisfy a requirement to explain an error if the specified observable experience allows terminal output. Decide from intent and criteria, not from the Design facet alone.

A composite profile may contain multiple adapters, such as frontend plus state service. Pin the composite profile, the whole realization bundle, their interfaces, and combined interaction evidence. Adding individually passing adapter reports does not establish end-to-end fulfillment.

## 7. Composition, scope, and evolution

### 7.1 No new precedence rules

Classification preserves model §§4–7:

- Facets do not affect Layer ownership, selection order, authority, or precedence. Selecting a “design Layer” never means selecting only its design-tagged items.
- Different edits to the same requirement still conflict, including two independent facet edits. Coalesce only identical complete records with the same precondition; keep all provenance and obligations.
- Disjoint semantic items can conflict even when their facets differ. A layout change that removes a required warning can conflict with a protection requirement without editing it.
- An invariant stays active regardless of the facets, locality, profile, or color of a competing rule. Changing a protected invariant still needs its baseline guardian.
- A Resolution cannot relabel a requirement to waive it, invent an implementation exception, or retain half a selected Layer. Repairs belong in explicit owned proposals.
- An implementation collision, such as two bindings needing incompatible control of one output surface, must be diagnosed. Fix an incidental profile choice in a new pinned profile; fix conflicting intended behavior through a Layer. Do not silently reinterpret intent to make generation work.

Required review must cover interactions across facets. A clean tag partition is not a proof of independence.

### 7.2 Relationships and dependencies

Continue using explicit `requires`, `consumes`, and `constrains` references to Blocks or requirements. Use `observes` only for informational reads. A shared facet means related attention, not an implicit dependency or constraint.

A countdown view consumes the hold contract. A privacy rule constrains receipt storage, display, export, and diagnostics. These relationships make the affected set broader than the changed Block and route decisions through the existing common-scope and guardian rules.

Reading a design proposal does not select it. If a Layer depends on a peer's new design or behavior, it must pin that peer revision, declare the required read, and express relevant final-candidate assumptions. Cyclic behavioral relationships can be legitimate; cyclic Layer dependencies and the parent tree remain invalid.

For the first refinement, keep constraint targets explicit. Do not add “all Blocks tagged Data” selectors whose meaning changes when someone edits a tag. A broad project policy can state its full intended reach and maintain an explicit affected-target inventory, with an impact review for completeness. Adding a new consumer, export, or diagnostic path must revisit that inventory. Missing edges cannot narrow a clearly stated policy; uncertain impact widens review scope and blocks required unchecked coverage.

### 7.3 Inheritance means retained intent, not classes

Distinguish four mechanisms:

| Mechanism | Proposed treatment |
| --- | --- |
| Baseline inheritance after flattening | Requirements, facets, criteria, and relationships survive in the effective snapshot. Removing the old Layer from selection cannot remove them. |
| Parent/child responsibility | Tree placement routes authority under the existing rules. It does not copy facets, generate implementation, or automatically apply every parent requirement to every descendant. |
| Shared design/policy reuse | Use explicit requirements and relationships. All applicable obligations coexist; there is no CSS-like “more specific wins” cascade. |
| Implementation-profile reuse | Profiles may reuse templates or adapters internally. Reuse cannot change normative intent, and a changed profile needs new realization evidence. |

Splitting a multi-domain Block is an explicit model change, not a type cast. Allocate new identities as required by the existing model, record lineage, repair every inbound reference and criterion subject, preserve all obligations, and review old and new responsibility scopes. Combining Blocks has the same obligations. No automatic movement of requirements based on color or classification.

A facet or target change creates new revision/evidence requirements. Pin all versions used for interpretation. A later materialization of the same semantic Release under another profile receives new evidence without rewriting the Release.

### 7.4 Versioning and legacy records

These fields are not legal additions to the present schema merely because they are useful. Model §4 currently limits editable collections and metadata keys; facet data belongs inside a versioned requirement record, not an unapproved `metadata.tags` escape hatch.

Adoption requires a coordinated model-version/schema decision. Specify the four IDs, their meanings, requiredness, canonical set representation, and unknown-value behavior together. Update hashing vectors, validation, examples, and capability reporting in that adopted version.

Old Releases retain their old model version and identity. A reader can display them as unclassified; it cannot retroactively add fingerprints or infer accepted facets. A transition to the new version requires an explicit reviewed migration with lineage, or a newly initialized prototype baseline, according to the core's agreed version-transition contract. Do not invent automatic cross-version composition in this proposal.

For the prototype, a freshly initialized fixture with reviewed classification is simpler than pretending there is already a migration engine. If classification is deferred, keep the original core subset explicit and reject unsupported classified inputs. Complete obligation coverage is still valuable for the original schema.

## 8. Worked examples

These are design sketches, not executable fixture files. Short IDs below are readable references; runtime manifests use structured, exact references and fingerprints.

### 8.1 Behavior and state: the hold/reminder flow

The existing prototype selects `L-hold@1` (expiry 900 seconds) and `L-reminder@1` (remind 60 seconds before expiry), and considers/rejects the 1200-second alternative.

| Requirement | Facets | Semantic relationship or condition | Relevant implementation and evidence |
| --- | --- | --- | --- |
| `booking.hold/expiry` | Behavior, Data | Hold lifetime is 900 seconds. | Authoritative hold state/clock handling; active at 899 and expired at 900. |
| `booking.hold/exclusive` | Behavior, Data, Safety | At most one active hold for a seat; invariant. | Atomic decision/state path; two simultaneous requests yield one success. The Safety facet does not create an extra guardian. |
| `booking.reminder/timing` | Behavior | Consumes the effective expiry; reminder occurs once at expiry minus 60 seconds. | Scheduling and event output; no event at 839, one at 840, none duplicated on repeated advancement. |

The reminder Layer retains its exact dependency on `L-hold@1` and its 900-second assumption. Tagging both requirements Behavior cannot substitute for those declarations. A changed expiry also affects any view consuming remaining time, even if no Design requirement was edited.

A materializer that emits a timer but ignores exclusive state updates has not fulfilled the candidate. The coverage manifest must show both obligations and their actual checks.

### 8.2 Design with behavior: checkout status and action

Suppose `booking.checkout` has this contract: hold status, expiry, and a customer's attempted confirmation are inputs; a presented status, explanation, and available confirmation action are observable outputs. It consumes `booking.hold`.

| Requirement | Facets | Acceptance and implementation consequences |
| --- | --- | --- |
| Show hold status and its deadline before the confirmation action in visual and reading order. | Design | Review the rendered active, expired, and unavailable states; verify reading order using the profile's supported checks. Route to view, content, and accessibility representation. |
| When expired, present a textual explanation and an unavailable confirmation action; do not communicate expiry by hue alone. | Design, Behavior | Exercise the expiry transition and inspect both action state and explanation. Route to view state, interaction handling, and checks. |
| Confirmation succeeds only while the hold is active. | Behavior, Safety | Enforce and test the authoritative command path, including a direct request at expiry. A disabled button is insufficient. |

This is a legitimate multi-domain Block. The first two requirements can be selected and refined in a visual-design proposal against existing Blocks, while the third retains its own responsibility and acceptance obligations. If they need independently reusable contracts, split the status presentation into a child/shared Block and preserve explicit relationships.

For a visual alternative, one Layer might use a compact status panel and another a larger summary. Both must preserve the same status and action promises. Select alternatives explicitly and validate the actual chosen experience; neither visual height nor aesthetic preference overrides an invariant.

A separate Layer that hides all text when space is tight conflicts with the explicit expiry explanation even if its write target is a different layout requirement. Report the interaction and select or author a compatible replacement.

### 8.3 Data with privacy: receipts

Suppose `booking.receipt` promises a stable receipt identity, a hold reference, and an issue time. It also requires retrieval after an application restart and deletion after an illustrative 30-day retention period.

| Intent | Facets | Platform-neutral content | Profile-specific work and evidence |
| --- | --- | --- | --- |
| Stable receipt identity and required fields. | Data | Meaning, identity, required fields, and declared value types. | In-memory/domain representation, serialization, and store schema; round-trip and reference-integrity checks. |
| Retrieval after restart. | Data, Behavior | Persisted availability across the declared restart boundary. | Durable local storage capability and restart test; a memory-only profile reports unsupported. |
| Delete receipt payload after 30 days in the declared retention scope. | Data, Safety | Retention duration, what is deleted, and explicit treatment of copies/backups/exports. | Store lifecycle, caches, export/copy handling as applicable; boundary checks and review of all retained copies. |

The semantic contract does not say SQL, D1, a table name, or a generated filename. A profile chooses the representation. If retention scope is unclear, distillation must propose that open question for review; materialization cannot choose a convenient interpretation silently.

Now an audit Block requires retaining the same payload for at least 90 days. The writes may be disjoint, but the resulting requirements conflict. Resolve at the common affected scope, including any designated privacy guardian. A replacement might explicitly define a different minimal audit record and its retention policy, with new criteria. A profile cannot make that policy change on its own.

### 8.4 Crosscutting safety: sensitive payment tokens

Suppose `app.privacy/no_token_disclosure` is a protected invariant: raw provider payment tokens must not appear in customer-visible output, ordinary receipt storage, exports, or diagnostic events. Its facets are Safety and Data.

Explicit `constrains` relationships name the relevant receipt, checkout, export, and diagnostics intent. This policy has one responsible home in the intent tree and multiple cross-tree targets; it is not copied into four unrelated requirements.

A profile's coverage needs at least:

| Relevant path | Required handling |
| --- | --- |
| Receipt representation and persistence | Store only the approved receipt fields; reject or strip token material according to the explicit contract. |
| View and response serialization | Present approved data without raw tokens, including failure responses. |
| Export | Use the same explicit disclosure boundary; test an export containing a sensitive fixture. |
| Diagnostics | Apply the defined redaction behavior to normal and exceptional paths; inspect captured diagnostic output. |

A serializer-only fix cannot satisfy the diagnostics requirement. “All Safety Blocks handled” is not evidence that every affected path was covered. Use mechanical fixtures for declared paths and a recorded completeness review for unmechanized paths.

Adding a new diagnostic sink forces applicability and relationship review, regardless of its facets. Removing the Safety facet cannot remove the invariant or its guardian. A proposed exception needs explicit changed intent and the existing authorization process.

### 8.5 The profile mismatch must be visible

Consider a candidate containing the hold/reminder requirements plus the checkout visual requirements above. The current bounded `booking-v1` command profile supports the first group but has no rendered checkout capability.

The materialization report should show:

| Obligation | Result |
| --- | --- |
| Hold expiry/exclusivity | Mapped to supported runtime targets; validation pending until actual checks run. |
| Reminder timing | Mapped to supported scheduling/event targets; validation pending. |
| Checkout visual and reading order | Unsupported: this profile has no applicable rendered-view capability. |
| Checkout expiry explanation/action | Uncovered visual interaction targets; command behavior alone does not satisfy the stated experience. |

Materialization returns an explicit failure for a complete realization. The semantic Composition can remain eligible for validation while its realization requirement is unmet. It cannot be flattened.

Valid next choices are to supply a suitable pinned profile, or author/select a genuinely different semantic candidate through the ordinary Layer rules. If the visual intent is already in the baseline, deselecting the Layer that originally introduced it does nothing; an explicit approved change is necessary. There is no automatic “headless mode” waiver.

## 9. Distillation proposes classification; review establishes it

Distillation must distinguish source observations from intended promises. CSS is evidence of a current implementation, not proof that exact pixels are required; a database column is not automatically a domain requirement; repeated credential handling is a reason to investigate a protection boundary, not proof that the system is safe.

A useful classification proposal contains:

- Proposed requirement facets and the source locations/observations supporting each.
- A proposed Block boundary and any shared design/data/policy contracts.
- Relevant dependencies, consumers, constraint targets, and implementation areas observed in the source.
- The proposed normative statement, bounded parameters, and acceptance criteria; unsupported or ambiguous interpretation stays explicit.
- Alternatives where classification or scope is uncertain, with concise rationale. Confidence may aid triage but confers no authority.

Example: a countdown component, backend expiry check, stored deadline, and diagnostic output are observed. A distiller can propose Behavior + Data for expiry, Design + Behavior for status presentation, and a separately reviewed Safety + Data disclosure rule. It must not turn incidental diagnostic behavior into an approved privacy policy or assert an absent backend protection.

Proposed classifications live in the producer's owned Layer draft. Review addresses boundary, meaning, facet choices, missing consumers, accidental bugs, and criteria adequacy. Bind the review to the exact draft and source fingerprints. Accepting a suggested badge in a GUI must show the underlying requirement change; a bulk acceptance should still enumerate it.

The current CLI plan's supplied-proposal distillation is sufficient for the first milestone. Record `method: supplied_proposal` accurately. A later model-backed distiller can propose classifications under the same review contract, but this task introduces no remote inference or autonomous publication.

## 10. GUI: translucent colors with readable meaning

Use a neutral Block card with facet badges and an optional subtle tint. A possible palette is blue for Behavior, violet for Design, teal for Data, and amber for Safety. These are proposed UI choices, not semantic constants or assertions of accessibility.

Translucent fills can work at a low opacity over a known surface. Keep text and essential boundaries sufficiently solid; measure the final composited contrast in each supported theme and high-contrast mode. Do not stack translucent colors and ask people to interpret the resulting mixture.

For a multi-domain Block:

- Show separate labeled badges, such as **Design · Behavior · Safety**, rather than forcing one dominant type.
- Permit filtering or emphasis by facet without hiding active requirements from composition or materialization.
- Show a selected facet's tint as a viewing aid; keep the complete facet list available without hover.
- Pair each badge with a consistent icon or short label and an accessible name. Meaning must survive grayscale, color-vision differences, keyboard-only navigation, and text export.
- Display candidate/coverage state separately using words and symbols: **Conflict**, **Unsupported**, **Review needed**, **Validated**. Amber Safety must not mean warning or failure.
- Make the implementation mapping inspectable from a requirement: affected intent, mapped targets, evidence, and gaps.

Do not recolor generated code and call that semantic targeting. The GUI should explain why a Block affects both a view and a state service, and why a missing target blocks complete realization.

## 11. Alternatives and tradeoffs

| Approach | Advantage | Cost or failure mode | Recommendation |
| --- | --- | --- | --- |
| One exclusive Block type: logic/design/data/etc. | Simple iconography; specialized editors and schemas are easy to dispatch. | Cross-domain intent requires arbitrary primary types or premature splits; subtype growth; false independence. | Do not adopt now. Keep contract-specific editors as views. |
| Free-form tags only | Fast to add, easy to search and color. | No shared semantics, reliable routing, coverage guarantee, or typo detection. | Keep only as non-normative labels. |
| Separate Block for every concern | Fine-grained independent ownership and reuse. | Excessive graph size, duplicated context, fragmented acceptance, and awkward coordinated changes. | Split only where contracts, selection, or responsibility justify it. |
| Nonexclusive requirement facets plus explicit coverage | Fits existing atomic requirements; handles mixed intent and multiple targets; makes omission inspectable. | Requires disciplined vocabulary, versioning, complete mapping, and real review of unknowns. | Adopt as the smallest useful refinement. |
| Full nominal/structural type system with inheritance and a policy language | More formal compatibility checks in supported domains. | Large semantic surface, migration burden, and pressure to mistake formal coverage for understood intent. | Defer. Add bounded validators only when demonstrated needs justify them. |

The recommended choice costs one small semantic field and a more explicit realization record. Its real burden is making incompleteness visible. That burden already exists in the model's requirement to validate all active obligations.

## 12. Integration contract

Adoption requires an explicit versioned schema and materialization contract. A design proposal alone does not advertise an implemented capability.

| Task / boundary | Consequence if adopted |
| --- | --- |
| Canonical model integration | Broaden Block wording from bounded behavior to bounded application intent; add versioned requirement facets; preserve all existing ownership, atomicity, authority, and Release rules. Keep profile/file targeting outside Blocks. |
| Core task | Define the new requirement field, canonical set rules, derived summaries, unsupported-input behavior, and exact capability/coverage records in the common contract. Enumerate all obligations from the effective snapshot. Retain original candidate states and conservative evidence invalidation. |
| Core materialization/validation | Check support before complete generation; preserve exact semantic-to-artifact-to-evidence links; diagnose all missing/unsupported targets. At least one full realization must satisfy every active criterion before flattening. Profile-only changes need fresh realization evidence. |
| CLI task | Extend existing inspect/diff/materialize/validate output with facets, capability gaps, coverage, and mappings. Keep `mat/materialize` failure explicit and `dist/distill` classification proposals reviewable. No extra command family or tag-setting shortcut is required. Reuse the CLI's common error envelope rather than define competing exit codes here. |
| GUI / site task | Explain multi-domain Blocks with labeled translucent facets and traceable targeting. A marketing mockup must distinguish proposed behavior from a working capability. This proposal requests no change to `site/` and does not require a product GUI for the first local milestone. |
| Cloudflare boundary | The same semantic/profile/coverage artifacts can use the planned immutable ArtifactStore port. Classification adds no infrastructure, model provider, paid service, provisioning, or deployment requirement. |

Recommended first adoption slice: classify the existing hold/reminder fixture by reviewed edits during baseline setup; derive Block badges; add complete coverage reporting for the bounded booking profile; demonstrate explicit rejection of a candidate with an unsupported Design obligation. A real visual materializer and a larger vocabulary can follow as separate work. Do not silently expand the first milestone into a GUI implementation.

Useful conformance cases for implementation after integration:

| Case | Required observation |
| --- | --- |
| One requirement has Behavior, Design, and Safety facets. | All facets survive composition and flattening; relevant targets and criteria remain visible. |
| Unknown facet or unsorted/duplicate set input under the adopted schema. | Unknown/duplicate values fail explicitly; different input orders normalize to the same sorted facet set. |
| Two Layers change different facets inside one requirement. | Whole-item conflict unless the complete resulting values and preconditions are identical. |
| A Design requirement and a Safety invariant contradict on different items. | Semantic interaction blocks validation until resolved with the existing authority rules. |
| A profile lacks a required rendered-view capability. | Explicit unsupported obligation; no complete materialization success or Release. |
| A protection requirement reaches storage, view, export, and logs. | Omitting one applicable target or its required evidence leaves coverage incomplete. |
| A new consumer appears or a facet is removed. | Constraint applicability and impact remain checked from actual intent; obligations and guardians cannot disappear through tagging. |
| A Release is the next baseline with empty selected Layers. | Classification, criteria, relationships, and all previously flattened intent remain active. |
| A profile or generated output changes. | Previous realization evidence cannot validate the changed output/profile. |
| Color is disabled. | Classification, dependencies, conflicts, and coverage are still understandable from text and structure. |

The proposed adoption decision is narrow: **one Block model, four overlapping requirement facets, explicit implementation coverage, and reviewed inference**. Field spellings and manifest layout should be frozen once in the shared core contract; they should not diverge between CLI, GUI, and materializers.
