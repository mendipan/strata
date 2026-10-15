# Content, assets and mediation: bounded implementation plan

Design rationale for structured JSON intent, separately versioned assets, policy-scoped selection mediation and separate Release approval. [Content/assets](CONTENT_ASSETS_SLICE1.md), [regression hardening](DRIFT_REGRESSION_HARDENING.md) and [mediation](MEDIATION_SLICE2.md) document the implemented subset. Proposed capabilities below are not installed policies, identities or grants. [BLOCK_CONTRACT.md](BLOCK_CONTRACT.md) remains the authoritative Block contract.

## 1. Two sequential slices and one explicit new model

Use one opt-in next model identifier: **`strata/0.2-content-mediation-experimental`**. Keep protocol envelope version `1`; advertise independently implemented `content/1`, `assets/1` and `mediation/1` capabilities. Freeze the complete v0.2 schema bundle before the first slice lands, including the mediated decision and approval forms below. Do not add fields later under an unchanged schema identity. A necessary incompatible change after that freeze requires another model/schema version.

| Slice | Concrete outcome | Boundary and suggested time box |
| --- | --- | --- |
| **S1: content and retained assets** | Explicit version dispatch, current-versus-v0.2 schemas, readable descriptions and authoring gates, exact asset references, bounded offline Node import/inspection, reference closure and backup format 2; migration preview; one asset-bearing fixture. | Content/assets slice. Existing v0.1 workflows remain available. New v0.2 Release/Resolution endpoints stay disabled until S2 supplies their complete gates. No media rendering or automatic code generation. |
| **S2: deterministic mediation and exact human handoff** | One installed fixture policy/executor grant, immutable basis/decision packet/response/approval, report carry-forward, atomic use receipts, direct-API enforcement and the existing separate realization/Release flow. Enable v0.2 Release only after its acceptance checks pass. | Mediation slice after S1. No LLM mediator, hosted grant service or new profile domain. |

Implement these slices independently. Keep an incomplete capability disabled and report its missing gate; preserve integrity, migration clarity and report survival. Remote/cloud/model integration remains independent.

### Version dispatch and backward compatibility

1. Retain the existing `strata/0.1-facets-experimental` parser, normalizer, hashes, seven-field Blocks, profiles and stored records byte-for-byte in meaning. No new defaults are injected while reading/hashing them. Old executables reject v0.2 records; the new executable selects a strict parser by the stored model version, never by guessing which keys happen to occur.
2. The v0.2 bundle defines the content additions, a tagged `selection/2` decision payload and `approval/2` records. Supporting descriptors/bases/packets/reports also carry their own format version. A field valid only in v0.2 remains invalid in v0.1. S1 can install all schemas while refusing unimplemented v0.2 mediation/Release operations with an advertised unsupported-capability result. There is no fallback to legacy approvals for a v0.2 candidate.
3. Existing v0.1 project operation remains explicitly legacy. New prototype fixtures opt in to v0.2 with a fresh bootstrap. Changing a config string cannot relabel persisted state, convert evidence or install authority. Mixed-version baselines, Layers, Compositions, Resolutions and executable evidence are refused.
4. Add a **read-only migration preview**, taking an exact v0.1 Release, its trusted digest and an explicit destination model. Produce a bounded migration proposal with source/target digests, field mapping, preserved identity/authority/provenance, validation findings and manual actions. No state mutation, baseline switch or approval results from preview. It supplies empty explanatory descriptions and empty asset-reference maps; it does not infer descriptions, convert URLs to assets or rewrite prose/code automatically.
5. Preserve every existing semantic item and obligation. Flag empty requirement acceptance, dotted item keys, unsupported parameters or code-bearing text for explicit author correction before conversion. Never silently drop them to satisfy the new grammar. Existing evidence and approvals remain historical and cannot certify the new candidate/model/profile.
6. **Applying migration to an existing active project is deferred** from these two slices. It needs a reviewed exact conversion, a new immutable baseline with source lineage, fresh v0.2 realization/evidence and separate required approvals; it cannot change an existing Layer's baseline. Do not invent an automatic governance or bootstrap bypass. Fresh isolated v0.2 fixtures exercise the new path while real v0.1 history remains intact. Operational rollback selects the old project/baseline explicitly; there is no lossy v0.2-to-v0.1 downgrade.

The implementation addendum should record these deltas separately from the canonical file. Update `BLOCK_CONTRACT.md`, help, skill, manifest and examples only as each capability becomes available, showing both versions while both are supported.

## 2. v0.2 Block content and enforceable authoring boundaries

Retain the seven semantic fields and their meanings. Add exactly two required Block fields:

| Field | Proposed v0.2 contract |
| --- | --- |
| `description` | `{ "format": "plain-text/1", "text": "..." }`; UTF-8 text, 0–4 KiB encoded. It explains purpose/context but cannot introduce an obligation, exception, policy or authority. Empty is valid. No HTML or Markdown renderer/importer in S1. |
| `asset_refs` | Map of stable, nondotted local keys to strict typed references, maximum 8 per Block. Each pins an immutable project asset descriptor and its content hash, declares a role and names the local requirement/criterion subjects where applicable. Empty is valid. |

No Block `owner`, revision, provenance, code, executable command, template body or binary field is added. Blocks remain versioned inside exact snapshots; Layer ownership and provenance remain separate. Every normative v0.2 requirement must name at least one resolvable acceptance criterion, closing the known v0.1 minimum gap through the new schema/semantic validator rather than changing old records.

For the first v0.2 booking vocabulary, requirement `parameters` accepts finite numbers and booleans only, with the profile's exact key/type/range rules: `seconds`, `exclusive`, `enabled`, `lead_seconds`, or an empty object where allowed. Reject extra keys, strings containing programs, nested configuration, arrays and arbitrary objects at the v0.2 boundary. Later legitimate string/structured data needs an explicitly versioned vocabulary extension, not an escape hatch. Existing v0.1 arbitrary-JSON parameters retain their old interpretation.

Authoring rules:

- Purpose, normative statements and acceptance describe observable behavior, constraints and checks. Explanation belongs in `description`; a description that contradicts normative items must be corrected. Changing explanatory text still changes the immutable content/fingerprint conservatively; this MVP does not reuse evidence by proving prose equivalence.
- Implementation source, executable configuration, scripts and templates live in pinned profile/realization artifacts. They are unavailable as Block fields or asset roles. JSON data examples belong in documentation/fixtures, not a hidden program parameter. Do not add an execution escape through “example,” “rationale,” an asset filename or a code-bearing URL.
- Mechanically reject code fences, inline backtick code spans, raw HTML elements, script/data URL schemes, disallowed control characters and fields outside the strict content grammar. Keep statements/descriptions plain text; escape them in human/HTML output. Ordinary inert URLs may appear as text but are never expanded, fetched or treated as asset identity.
- A lexical check cannot prove that arbitrary natural language contains no implementation code. Add a bounded **exact-content authoring review receipt**, issued through a separately assigned local review role, before v0.2 publication of changed Block prose. It binds the complete draft/content digest and the `intent-authoring/1` checklist: no embedded implementation, no hidden obligation in explanatory fields and no claimed permission from content. A changed draft stales it. Fixture attestations demonstrate the gate, not independent proof or model understanding. No LLM classifier or broad code detector is introduced.
- Schema checks, authoring review and profile capability checks are distinct. A reviewer cannot waive an invalid schema; a syntactically valid Block cannot claim an unsupported materialization; a policy executor cannot supply the authoring review or arbitrary evidence. Asset/source instructions remain untrusted data and never change tools, identity, policy or execution budgets.

S1 may stage/create v0.2 records for isolated testing, but publishing a draft must pass its content gate. V0.2 semantic Release remains disabled until S2's decision/report gates are complete. All checks run through shared service/core paths, including direct API access, restoration and any later migration application.

The minimal review surface is `content review --file -` / `content.review`, granted only by the trusted fixture setup to the review principal. The owner explicitly supplies the exact proposed Layer JSON to the host reviewer; this does not add a peer-private-draft listing/read capability. The review request contains that supplied draft, its expected digest, accept/reject and rationale. The server validates the supplied shape and issues immutable `authoring-review/1` with project/model, draft identity/digest, checklist version, result/rationale and server-resolved reviewer/time. It does not create or publish the supplied Layer. At v0.2 publication, an explicit `--authoring-review EXACT_REF` must match the actual stored draft and current review policy. A caller-supplied reviewer name grants nothing. Existing supplied-proposal source/draft review remains an additional gate; its receipt is not silently reinterpreted. Decision-only Layers with no Block-content change use the separate mediation/rationale contract and do not need a fabricated Block-content review.

## 3. Minimal project assets: retained references first

Assets are supporting project artifacts, not a sixth semantic source object. Keep raw bytes outside Block JSON, ordinary JSON RPC bodies and model packets. Do not Base64-wrap a binary to bypass this boundary. The existing string-oriented `ArtifactStore` needs an explicit bounded byte-storage port; never round-trip binary through UTF-8 conversion.

### Identity, metadata and reference integrity

Proposed immutable descriptor format: `strata-asset/1`. Required fields are `project_id`, logical `id`, positive `revision`, exact `previous` descriptor ref or null, `content_sha256`, `byte_length`, verified `media_type`, a bounded `title`, `access: "project-private"`, and source/rights provenance. The provenance records source kind (`local-created` or `local-provided`), creator/provider, attribution and declared permitted uses; optional original URL is inert metadata. The server binds the importing fixture principal and receipt. A declared rights label does not establish ownership or grant access/egress.

The descriptor is stored canonically under an exact content-derived reference, for example `asset@<descriptor-sha256>`. The project registry indexes logical ID/revision and exact descriptor ref; each revision is immutable. Duplicate identical import is reusable; replacing bytes or metadata requires a new version. Human filenames and the registry's current head are conveniences, never semantic pins. Byte deduplication is project-local and conveys no cross-project read permission.

Illustrative Block reference; angle-bracket hashes are placeholders, not executable fixtures:

```json
{
  "reference-picture": {
    "asset_ref": "asset@<descriptor-sha256>",
    "content_sha256": "<blob-sha256>",
    "role": "background",
    "subjects": []
  }
}
```

The frozen v0.2 reference schema recognizes `background`, `application_resource`, `normative_reference` and `evidence_fixture`. Non-background roles require nonempty resolvable local subject paths and explicit criteria/profile coverage. **S1 enables background retention only**; other roles return a precise unsupported-role/capability result before publication/materialization success. Do not accept a “background” image as an unstated required visual design. This keeps the first asset milestone useful without claiming that the booking CLI app implements multimedia behavior.

For every reference, check project binding, exact descriptor identity/version, content hash, actual byte length/type, current read entitlement and required bytes before accepting complete closure. Missing/wrong/cross-project bytes fail. The service derives closure from canonical references rather than trusting a client-provided inventory. Asset metadata, role and pins participate in snapshot/candidate/decision fingerprints; changed pins invalidate their applicable evidence and pending choices. Reading a private descriptor does not grant permission to publish its bytes elsewhere.

### Import, allowed media and finite bounds

Use an **offline Node operator import**, reusing descriptor-bound state, quiescence leases, staged immutable writes and atomic index/audit publication. This keeps binary import within the bounded local operator interface. The operator supplies one explicit authorized local file and metadata record; the importer reads only that file, rejects links/junctions/traversal and refuses a live/foreign/unbound state. New asset operations are denied by default. Test assignments are installed only through trusted fixture setup; ordinary author/reader/bootstrap access does not imply import permission.

Imported assets become project-private resources available to the project's authorized readers through inspection. The import must explicitly acknowledge this visibility; S1 supplies no peer-private asset draft or permission editor. Block/Layer draft privacy stays independent. A draft can reference a preapproved asset without publishing that draft.

| Bound | S1 default and behavior |
| --- | --- |
| Allowed bytes | PNG and JPEG only, maximum **4 MiB each**. Use bounded structural type/header validation; maximum 4,096 pixels on either axis and 16 million pixels. Reject truncated/malformed structures, MIME/suffix mismatch and unsupported variants such as animated PNG. Do not describe header/structure checks as exhaustive malware or decoder certification. |
| Explicitly unsupported | PDF, video/audio, SVG, HTML, scripts, executables, archives, remote URLs as imports and arbitrary project-file bundles. Return unsupported-media before retention. No hidden opaque fallback. |
| Registry/project bound | At most 32 retained asset versions and **16 MiB total retained binary bytes**, counting history rather than only current references; 8 KiB per descriptor. A new version counts against both bounds unless it reuses identical bytes; bound the number of descriptors independently. |
| Input/processing | One explicit local file per operation; stream/hash with a byte cap and a 10-second cooperative deadline. No OCR, thumbnails, decoding/rendering into a canvas, transcoding, metadata-driven URL loads, macros or template execution. Ordinary JSON ingress bounds still apply to metadata. |
| Recovery ceiling | Keep the existing explicit **64 MiB total / 8 MiB per file** Node backup ceilings and 60-second cooperative deadline. All record/profile/audit/asset bytes count; an asset budget is not a guarantee that the complete project fits a backup. Oversize fails rather than omitting data. |

No new package purchase or hosted storage is required. If a vetted, bounded PNG/JPEG structural check cannot be implemented within the slice, leave `assets/1` disabled and deliver the contract/content part with an explicit blocker; do not call MIME sniffing full validation. PDF/video retention can be a later format-specific slice with its own parser, active-content limits, size/page/duration bounds and processing contract. Nothing here authorizes their model upload.

### Materialization, export and lifecycle

- Introduce a distinct pinned **`booking-node/2` profile**, declaring the v0.2 model and `background: retain-only` handling. It verifies authorized asset closure and records exact background refs/hashes in its versioned realization manifest. It does not feed images into generated code, copy unrequested media into a deployable app or claim visual conformance. Its executable output remains the same bounded booking domain. Unsupported resource/normative/evidence roles block until a profile with explicit coverage is added.
- Do not reuse `booking-node/1` evidence for the new profile/version. Bind candidate, profile/template, generated output and retained-asset closure to fresh validation. Changing a referenced image produces a new candidate/manifest even if generated source happens to be identical. An asset hash is evidence of bytes, not proof of intent compliance.
- Add **`strata-local-backup/2`** for v0.2 closure: canonical descriptors plus raw `assets/blobs/<sha256>` bytes, byte lengths/types and every reference in private/history records, authoring-review receipts and all mediated support records when present, and pinned profile/realization data. Version the inventory and completeness rules explicitly. Preserve the v1 reader/verification rules; a v1 bundle cannot be presented as an asset-complete v2 export.
- Full export refuses an inaccessible/missing/oversize asset or inconsistent reference. It never silently drops private references, follows source URLs or reconstructs bytes from a path. Restore remains an isolated **inactive** archive, with expected project and trusted digest, no current identities/grants, executable policy configuration or live cache. Retained policy/grant/proof descriptors are historical metadata only; used-grant receipts do not reactivate authority.
- Define `assets inspect EXACT_REF` as metadata/closure inspection, not browser rendering. Backup 2 is the first complete export path; separate asset-sharing packages and executable media embedding are deferred. SDK binary persistence/import/export is also deferred: SDK capability discovery rejects asset-bearing v0.2 operations until its byte backend exists, while S2 may use asset-free v0.2 fixtures on both existing local brokers.
- Keep every historically referenced version. No automatic retention purge, delete/replace-in-place, deduplication across projects or garbage collector. Failed staging may leave bounded unindexed bytes for operator inspection; no complete index/backup marker is published. Revoking source-use permission must block future export/use as required without falsifying historical records; a complete erasure workflow is a separate operational decision.

## 4. Selection mediation with explicit local authority

Mediation is an engine contract used by the existing host. S2 implements one deterministic evaluator, `booking-reminder-selection/1`, and context-rich human selection. It adds no resident mediator, scheduler, policy script language, remote identity service or LLM call. All alternatives are already authored/published by their owners. New compromise authoring and general peer-lineage support are deferred; requests for new behavior return planning direction to the existing author workflow.

### Frozen policy and executor fixture

A supporting `selection-policy/1` record pins project, v0.2 baseline, authority digest, scenario/check versions, rule/evaluator version, allowed item/proposal shapes, preserved invariants/criteria/contracts, maximum impact and one unique complete outcome derivation. Include human-readable goal/rationale and issuing-authority provenance. Free prose is explanatory; the finite evaluator derives the result from actual records. No arbitrary expressions, URLs, confidence thresholds or recency/Layer-order tie-breakers.

For the first fixture, the rule applies only to the existing 900/1200-second booking alternatives and the published reminder proposal that requires the exact 900-second Layer and assumes its complete requirement. Require the expected dependency/acceptance forms, unchanged exclusivity and no extra writes/criteria/relationships/assets or unreviewed side effects. Retain all three considered proposals. The sole permitted partition selects the 900-second proposal and reminder and rejects the 1200-second alternative. A duration range alone is insufficient authority to pick a value. Unknown, multiple matches, extra consumers/impact, uncovered reports or another policy conflict stops automatic endorsement.

Fixture setup may explicitly supply a **fresh v0.2 baseline** whose `booking` selectors include a dedicated `policy-executor`, plus a trusted constructor assignment for that principal. Do not add it to the current default fixtures or rewrite an existing baseline's authority. An existing baseline lacking that selector uses the human route. The model author never receives or selects the executor handle.

Proposed `selection-grant/1` descriptor and its server-owned live binding:

| Constraint | Test-fixture value |
| --- | --- |
| Project/model/baseline/policy | One exact project, v0.2 baseline and policy ref/digest; one named evaluator version. |
| Authority and action | Baseline-authorized `booking` selector; resolution endorsement/sealing path only. No scope, guardian or Release approval, evidence import, behavioral authoring, policy installation or redelegation. |
| Scope/content | Exact booking expiry/reminder items and permitted proposal shapes; complete impact must fit the grant. Protected amendments, acceptance removal, asset changes and unknown impact are excluded. |
| Validity/use | One case, one successful endorsement, expiry within one hour; explicit server generation and revocation status. Test time is injected; no new scheduler is needed. |
| Principal/assignment | Trusted fixture configuration plus immutable descriptor; current operation/Layer/Block restrictions still apply. No account credential or hosted access grant is created by the plan or by fixture declarations. |

A separately assigned author prepares the decision-only Layer. The executor recomputes policy eligibility and exact output before issuing a bound endorsement. Do not broaden an author's role to shortcut that step. A preparer may coordinate the operations but gains no endorsement authority.

Live assignment, baseline authority, policy proof and content limits are checked in the shared service for **direct `approve`, `resolve`, mediation responses, cached mutations and pending Release**, not only in CLI wrappers. An executor cannot evade its narrow rule by calling a lower-level endpoint. A policy does not waive an invariant, required check or guardian. Policy generation/revocation is trusted fixture configuration plus server state, never client-supplied permission.

Persist policy/access generation and grant-consumption history with the project publication state, binding the installed configuration digest. Reloading/restarting cannot roll a generation backward or reset a consumed grant. Missing or incompatible ledger state blocks the executor until explicit fixture reconfiguration; it never silently defaults to a fresh balance. Live assignment activation is distinct from loading an immutable historical descriptor or inactive backup.

Persist grant-use debit, immutable endorsement/response receipt and correlated audit atomically with the publication index. Durable uniqueness is keyed by grant/case/exact target; clearing a retry cache or restarting a broker cannot replenish a used grant. Concurrent requests consume at most one use; an identical authorized retry returns the committed receipt without another debit. A zero remaining balance does not invalidate that same receipt, but revocation/expiry or a changed target does. A changed input requires fresh authority, not a new idempotency key to evade the limit. No database lock is held during human/runner work.

## 5. Exact-context packets and versioned approvals

Keep the existing semantic `contextFingerprint` meaning for baseline, complete considered set, scenario and alternative groups. Add an independent immutable `mediation-basis/1` with a digest over:

- project/model, exact semantic input and authority digest;
- sorted conflict/detector/version identities, complete conflicting item values and contributors;
- full considered/selected alternatives, declared dependencies, assumptions and impact/guardian closure;
- current relevant report refs plus server report generation;
- exact policy/evaluator/grant refs/digests and access/policy generation;
- choice-supporting evidence, authoring/impact review refs and explicit unknowns.

Do not construct a cycle: basis excludes the eventual decision Layer, packet, approvals and resulting Composition; the v0.2 `selection/2` decision payload then binds that basis, complete selected/rejected partition, scope/impact and nonempty rationale; the unsigned decision target binds the frozen Layer/proposal; the packet binds that target. Behavioral evidence is generated for the later recomposed candidate, not invented while choosing it.

`decision-packet/1` records an immutable exact-context request. Show a short lead question and recommendation, then up to three executable options plus defer, with expandable exact source material. Required packet content:

| Reader need | Contract |
| --- | --- |
| Understand the goal/disagreement | Goal, why a choice is needed, baseline and complete requirement/parameter alternatives, authors/provenance, relevant invariants and affected consumers. Distinguish facts from inferred interactions. |
| Compare outcomes | Exact whole-Layer partitions and prepared decision targets; observable behavior, security/privacy/data/rights effects, dependencies, reversibility and follow-up work. No option may smuggle an unauthored compromise. |
| Judge the recommendation | Policy match/failure/unknown details; exact supporting results, missing tests/unknowns and what would change the recommendation. Costs/time are bounded estimates or explicitly unknown, not execution permission. |
| Know what is approved | Packet/basis digests, expected case revision, option/target, requested selection scope, responsible authorities, expiry and all remaining review/guardian/scope/Release gates. |

The first human fixture can use two already-authored hold durations in the supported booking vocabulary with reminders unchanged. Without a matching policy or an authorized unique tie-breaker, show both effects and defer. It does not need the future payment domain in MEDIATION_PLAN's illustrative case. Every executable choice still needs the supported realization and fresh checks afterward.

Proposed `approval/2` includes explicit format, project/model/baseline/authority binding, kind, exact target, scope and evidence digest as applicable, server-resolved principal/trust, creation/expiry and current generation bindings. Resolution endorsements additionally pin basis, packet, case revision, option/partition and either a verified policy/grant/use receipt or an authorized human/operator response. The server derives that origin; the client cannot assert `source: human/policy` to gain permission. v0.1 approvals cannot authorize v0.2 records.

Reuse the proposed `mediation prepare` and `mediation respond` operations and existing `resolve`/`compose` flow. `prepare` stores a packet without authoring behavior or granting approval. `respond` accepts an exact packet/digest/revision and one of `approve_selection`, `defer`, `request_context`, `planning_direction`; only the first may mint a selection endorsement after complete authorization. A free-text request for another duration returns authoring work, not approval. A recipient without selector authority can supply permitted context, not endorse. Silence/timeout never approves.

Selection approval remains distinct from post-validation scope/guardian/Release approvals. The executor has none of those latter roles. A sealed decision may produce an eligible candidate; it cannot mark an unsupported profile or failed check passed. Release rechecks the live policy/grant/endorsement and report state for pending publication, while historical Releases remain immutable after later revocation.

## 6. Reports, staleness and bounded failure behavior

Replace revision-local blocking only for v0.2 with `interaction-report/2`: immutable attributed report ID, originating basis/Composition, exact evidence refs, affected items/contributors and a stable interaction signature. It is indexed at the **project** level with a monotonically increasing report generation. Names, array order and a new Composition ID cannot erase it. No client chooses its own report generation or claims a report resolved.

Start conservatively: every open project report is included in v0.2 analysis until it has an authorized evidence-bound disposition for the exact proposed selection context. Do not attempt a general semantic relevance classifier in this bounded implementation. A typed `report-disposition/1` may establish correction or nonapplicability with explicit rationale/evidence and the responsible review authority; uncertainty remains open. An executor cannot dispose of reports. A disposition does not globally close the report for unrelated/future candidates or waive invariants/criteria. This may create extra review work; measure it before relaxing carry-forward.

Avoid a report/decision hash cycle too. A disposition pins the report ID and a `selection_context_digest` derived from project/model, baseline, full considered set, scenario/groups, the proposed complete partition, effective content and asset closure. That digest excludes dispositions, decision Layers, packets, approvals, Resolution refs and the future Composition ID. Deriving it is a hypothetical selection check, not acceptance of that selection. The authorized review disposition is frozen first; the mediation basis then includes its ref plus the current report-set generation. A new report requires additional coverage and a fresh basis. An identical renamed selection may reuse a still-valid exact disposition, but cannot lose an unresolved report. Changed inputs/effective values cannot reuse it by claiming semantic equivalence.

Recheck report generation and disposition coverage at packet response, endorsement, sealing, validation readiness and Release publication. A report arriving after analysis/approval blocks the pending action even when candidate bytes have not changed. Renamed/cloned candidates inherit the unresolved project reports. New baselines in that project do not silently clear them. A future migration application must retain unresolved source reports as open v0.2 references requiring disposition; old historical Releases themselves are not retroactively invalidated.

Changing considered inputs, scenario/groups, effective content or asset pins, impact, required evidence, policy/grant/access generation, relevant report state or expiry makes pending decisions stale. An unselected peer's newer head alone does not replace its pinned revision. Store supersession links rather than updating frozen packets. Recheck after slow work and before cached mutation reuse/publication; unavailable authorization/audit/storage fails closed. Same-input retries reconcile the committed prefix before completing missing steps.

| Bound | Initial behavior |
| --- | --- |
| Analysis | At most 20 considered Layers, 50 conflict items, 100 impacted Blocks/open reports, three executable options, 128 KiB packet and 10 seconds cooperative work; also honor existing JSON byte/depth/node caps. Bound exhaustion returns missing context, never truncates obligations into success. |
| Reanalysis/retry | At most two automatic reanalyses per case and two transient retries within 30 seconds, same exact input/key after inspection. Refusal/staleness/unsupported outcomes do not trigger identity or provider fallback. |
| Human wait | Earlier of 24 hours or evidence/grant expiry. Read/resume checks time; no engine timer process. Defer/cancel/context requests leave the choice unresolved and release any request lock. |
| Models/execution | Zero model/provider calls or spend in both slices. Existing authorized local fixture runners provide evidence; selection permission never authorizes another runner, cloud call or budget. |

Use structured errors with stable code/exit and field paths where available. Proposed families: `CONTENT_POLICY_REQUIRED`/6, `ASSET_REFERENCE_INVALID`/2 or missing-ref/3, `UNSUPPORTED_MEDIA`/8, `ASSET_LIMIT`/2, `MEDIATION_STALE`/5, `POLICY_UNRESOLVED`/5, `SELECTION_GRANT_FORBIDDEN`/4 and `INTERACTION_REVIEW_REQUIRED`/5. Final spellings must be fixed with the schema/CLI capability bundle and tested; these are not existing commands/codes. Backup integrity failures retain nonzero errors in dry-run mode.

## 7. Acceptance contracts for the two slices

The following are required **future checks**, not results from this plan. Use isolated synthetic projects, existing local tools and no new model/provider calls. Reuse shared fixtures/helpers and run only the targeted regressions justified by the changed paths.

### S1 exit criteria

1. Existing v0.1 records retain exact normalization/hashes/read behavior; old model rejects new fields. A v0.2 declaration cannot accept legacy approvals or mix baselines/Layers. Disabled mediation/Release and SDK binary operations return explicit unsupported capability.
2. Valid v0.2 Blocks accept empty explanatory text and supported background references; missing required fields, empty normative acceptance, invalid parameter keys/types, program fields/markup/fences, binary content and dangling subjects fail at the correct stage. Text changes invalidate exact authoring review; direct API and restore cannot bypass it. A plain-text disguise is not claimed mechanically provable; the required review gate is exercised with a deliberately rejected fixture.
3. Import verifies descriptor/project/hash/length/type; duplicate exact input reuses the result. Changed metadata/bytes produces a new version. Wrong project, unreadable/missing bytes, linked paths, malformed PNG/JPEG, unsupported SVG/PDF/video/archive, oversized dimensions/bytes and exhausted retained-version budgets fail before indexed success.
4. A permitted background image is retained and exactly inspectable; the new profile records its hash/role without claiming UI use. Replacing its reference changes the candidate/realization binding. Unsupported normative/resource/evidence use fails; it is not silently treated as background.
5. Backup 2 retains every descriptor/blob needed by private and historical references; exact hashes survive an isolated inactive restore. Missing/altered/foreign/oversize blobs and incompatible formats fail with no complete archive success. No authority or active broker state is restored. The v1 backup reader and dry-run integrity behavior remain valid.
6. Migration preview preserves source bytes, IDs, authority and obligations and emits explicit manual blockers; it neither installs assets/grants nor creates an approved baseline. No automatic active-project migration endpoint is exposed.

### S2 exit criteria

1. The explicit booking fixture policy produces exactly one partition and one executor endorsement/use receipt, with zero prompts/model calls. Identical input ordering yields identical basis/result. Missing scope/release approval or evidence still blocks Release.
2. Without the new baseline selector or trusted test assignment, policy records alone grant nothing. Author/reader/preparer calls, spoofed origin fields, direct `approve`/`resolve`, wider impact, extra writes/assets, protected amendments and unknown checks cannot bypass the content-restricted grant.
3. Two matches, no match, missing context, contradictory policies or an uncovered report produce a truthful unresolved packet. Exact authorized response may approve only its prepared target; defer, silence, context and planning direction never do. A requested compromise requires new owned authored work.
4. Changing every bound dimension individually stales pending packet/approval/sealing. A new report between prepare and commit is caught; cloning a Composition/new baseline does not remove it. Dispositions are exact/evidence-bound and cannot be supplied by the executor or inferred from “resolved” prose.
5. Concurrent responses, commit failure, lost response, process restart and retry-cache eviction produce at most one grant debit and recoverable receipt. Revocation/expiry is rechecked before cached success and commit. A used receipt remains reusable only for the same still-authorized case/target; changing an idempotency key cannot replenish authority.
6. Exercise both local brokers for asset-free v0.2 mediation using their existing publication boundaries. Node additionally covers retained assets. S2 enables v0.2 Release only after fresh profile/output/asset closure/evidence, report checks and separate human/operator scope/guardian/release approvals pass. Historical Releases remain unchanged by later events.
7. Inspection/help, current Block contract, skill and manifest advertise the implemented capabilities and explain current versus legacy behavior. Captured traces stay sanitized; records retain full authorized source/rationale refs. No fresh-model comprehension or comparative productivity claim is made.

## 8. Change map and explicit deferrals

Future implementation touchpoints: versioned schema/model dispatch in `src/model.ts` and generated schemas; content/reference checks and decision/report binding in `src/core.ts`; byte port and Node state/publication/backup integration; profile versioning in `src/profile.ts`; content-scoped fixture authorization in `src/security.ts` and `src/service.ts`; bounded API/CLI envelopes and both local broker publication paths; focused fixtures/tests and authoritative current docs. Keep schema generation sourced from one definition and the new model addendum separate from the saved canonical file.

The two slices defer general Block creation/reparent/removal, automatic rebase, active-project migration application, arbitrary code detection, Markdown rendering/authoring import, PDF/video and active-content processing, runtime resource embedding/visual conformance, per-asset ACL editors, deletion/erasure/GC, SDK/remote binary storage, hosted identity/grant administration, arbitrary policy languages/override hierarchies, behavioral compromise synthesis/peer-lineage expansion, autonomous scope/guardian/Release approval, model recommendations, a graphical mediation UI and comparative agent benchmarks.

Exact record shapes and limits must be versioned and validated before enabling new capabilities. Fixture examples create no hosted access grants or provider resources.
