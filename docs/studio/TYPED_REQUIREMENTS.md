# Typed requirements on proposed Blocks

The existing **New change** form already edits requirements on baseline Blocks. The remaining requirement-input gap was a Block created inside an owned private Layer: its requirements required **Owned next revision** JSON. This slice adds **Edit new Block requirements** to that exact saved draft's Review page. It uses existing model fields and operations; advanced JSON stays available.

## Attended edit

1. Open an owned, unpublished v0.3 Layer containing a proposed new Block. Select **Edit new Block requirements**, then the Block and an existing requirement or **Add a requirement**.
2. Enter a plain-text statement, choose facets, and explicitly select existing acceptance criteria. Existing requirement keys cannot be renamed here. Each criterion's definition and declared subjects are readable. A requirement link does not modify a check or its subjects; confirm the criterion actually covers the intended requirement.
3. Add, edit or remove finite number and boolean parameters. Parameter names remain exact, including surrounding spaces and tabs; they are not trimmed. Blank/reserved, duplicate or over-bound names refuse. If a saved name cannot round-trip through the single-line control, typed editing refuses and directs you to advanced JSON. These are form limits, not new model restrictions. No strings, enums, objects or arrays are introduced. The form permits at most 32 parameters; a larger existing requirement refuses typed editing without discarding its values, and remains editable through advanced JSON.
4. Select **Review requirement revision**. Existing `layer.preview` returns the normalized full Layer and digest without saving. Inspect the readable saved/proposed requirement and exact normalized JSON. Editing any field invalidates readiness.
5. Explicitly select **Save requirement revision**. Existing `layer.revise` saves the exact inspected next revision after current owner, head, generation and policy checks. Open the returned immutable reference and obtain a new exact authoring review for changed content before publication.

**Rule** is the supported kind for a new Block. The model schema also names `invariant`, but the current creation normalizer refuses it with `GUARDIAN_ASSIGNMENT_REQUIRED`: no explicit guardian-assignment creation contract exists. The form disables that option and explains the actual restriction. It grants no guardian authority or alternate bypass.

## Shared contract and limits

| Studio step | Existing operation / CLI parity | Result |
| --- | --- | --- |
| Preview typed fields | `layer.preview`; `strata layer preview --file PATH` | Full normalized content and digest; no persistence, selection or validation |
| Save inspected revision | `layer.revise` with exact `previous` and `record`; `strata layer revise PREVIOUS_REF --file PATH` | One owned immutable Layer revision; existing audit and request receipts |
| Review changed content | Existing [explicit authoring handoff](AUTHORING_HANDOFF.md), `content.review` | Separate exact supplied-content attestation |

The form changes one selected requirement and the Layer revision. It retains all other proposed Blocks, requirements, purpose, relationships, contracts, criterion definitions/subjects, source bindings, assumptions and Layer content. Local bounds and error messages improve entry; server normalization and authorization remain authoritative.

A model-valid edit can still be unsupported by a finite realization profile. In particular, `collection-host/1` requires its defined meanings and may refuse edited statements, facets or parameters with `UNSUPPORTED_OBLIGATION`. Preview and save do not implement checks, run them, produce evidence, approve scope or publish a Release.

Cancel/Escape before dispatch writes nothing and restores focus. Repeated save clicks dispatch once. Stale revision/generation or revoked authority refuses and requires refreshed inspection. An uncertain dispatched outcome locks resubmission and directs the user to the original request receipt; no draft content is stored in browser storage. Existing view/connection lifecycle cancellation applies.

## Implementation ownership and qualification

Runtime edits are confined to existing UI assets `explorer/draft-model.js` (bounded immutable transformation) and `explorer/workflow.js` (existing dialog/forms/command integration). The stylesheet and static-asset list are unchanged. New focused unit and real contributor-browser tests accompany this slice. Engine, schema, profile, CLI, authority, host, launcher and persistent configuration remain unchanged.

Independent review blocked the original `8865663` checkpoint on a parameter-name fidelity defect: trimming a valid saved key silently changed content, and an unchanged form could create a revision. The correction preserves exact keys while retaining safe-name and exact-duplicate checks. Names the single-line control sanitizes refuse typed editing; advanced JSON retains the existing model-supported content. The two new regressions failed against the original helper, and that negative evidence is preserved separately.

Corrected focused qualification passes 13 tests, including exact independent normalized-content/digest parity, whitespace-key and unchanged-form regressions, unrelated-content retention, input refusals and actual guardian/profile refusals. The actual Edge contributor browser passes 34 checks: validation, typed controls, preview invalidation, keyboard/focus/cancel, mobile layout, one-dispatch persistence, stale generation, revoked role, hidden private draft, unchanged bootstrap and exact restart readback. New ordinary CLI/browser checks establish statement-only whitespace-key fidelity, no-op refusal, explicit multiline-name refusal and unchanged advanced JSON support. Existing authoring handoff and named-actor browser regressions pass 36 and 11 checks respectively. Build/typecheck, syntax and 351 links across 82 documents pass; every corrected qualification process exits 0. Receipts and viewport screenshots stay outside Git. These checks use synthetic local roles and ordinary CLI/HTTP operations; they do not establish a new hosted-write capability or a complete browser-only accepted-Release loop. The repository aggregate is reserved for final combined integration qualification.

Typed authoring of complete contracts, relationships and criterion definitions remains separate UI work. New invariant/guardian creation requires a separately designed domain contract. Independent immutable review and the parent's final combined integration qualification remain gates; this isolated slice does not mutate main or deploy.
