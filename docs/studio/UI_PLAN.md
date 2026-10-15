# Studio UI plan

The architecture phase is complete. See [implemented scope and integration status](STATUS.md) for the subsequent authorized coding milestone; this document preserves the original design and acceptance targets.

Proposed screens and behavior, not implemented UI. Contract: [architecture](ARCHITECTURE.md). Keep the existing application map as the home view; extend its controls and detail views rather than introduce a second dashboard or a new visual system.

## Visual ownership

Reuse `explorer/style.css` tokens: paper `#f5f2eb`, surface `#fffdf9`, ink `#201d18`, muted `#62594d`, line `#d8d0c3`, accent `#a94f13`, rail `#eee9df`, rust `#a33c22`, green `#3b6044`. Retain the stack brand, Georgia application headings, Segoe UI/system body and Consolas refs. Use the existing 64px header, 232px desktop rail, 8–10px bordered cards, warm map canvas and readable item renderers. The marketing design is a reference, not an imported asset/runtime dependency.

Purple with a text label marks proposals; green requires the specific completed fact next to it. Do not make an entire candidate green when only checks pass. Use status words/icons as well as color. Preserve solid declared relationships and separately labeled derived containment/acceptance connections; absence means **None declared**, never inferred edges from prose or source proximity.

New long forms use a normal page, not nested dialogs. Retain the existing short proposal/export dialog for read-only sessions. Primary operational type is 15–16px; status/ref metadata at least 13px in new review screens. Reuse existing cards and comparison values before inventing widgets. No charts, agent bubbles, animated progress or marketing hero are needed.

## Navigation and context

Rail: **Application**, **Changes**, **Review**, **Releases**; keep **Blocks**, **Compare**, and exact record inspection reachable within those areas and through existing routes. Connection settings stay in the header. Add a role/capability label: **Read-only**, **Local author**, or the actual permitted role. A role label is server-supplied, not a role-switch control.

Every working page shows project, model, exact baseline/subject ref, content mode and freshness. Navigation does not silently change baseline or select a Layer. Explicit **Continue from this Release** changes personal context only and shows its result. Preserve back/forward and existing copyable hash links. New draft/review routes include exact refs, never credentials or raw draft JSON.

## Screen A: Application with readable proposed intent

```text
Strata Studio       Project / current connection          Read-only  Settings
Application | ...   Application intent                    Create / New change
                    Baseline R-start@1   [Baseline | Proposal preview | Candidate]
                    Draft L-change@2 • not published • 3 unresolved questions
                    [Map | Cards | Outline]  Search / facets
                    +-------------------------------+  +----------------------+
                    | Existing Block map/cards      |  | Selected Block       |
                    | Proposed purpose first in     |  | Proposed purpose     |
                    | Proposal preview mode         |  | Requirements         |
                    | + Draft badge on every change |  | Review criteria      |
                    +-------------------------------+  | Before / after       |
                    Read proposal / review questions   +----------------------+
```

Baseline mode always renders baseline text. Proposal preview applies one exact Layer's supported normalized changes for reading only; its banner says **Proposed intent — not selected or validated**. Show meaningful purpose, requirement facets, statements and acceptance before trace hashes. Changed cards show proposed purpose in this mode, with a one-click prior-value comparison. Unchanged cards keep their baseline text. Never silently classify purpose text as scaffold or hide requirements by keyword; an explicit **Changed Blocks only** filter can reduce noise, with a visible count and hierarchy context.

Candidate mode binds an exact Composition and selected set. If evaluation is blocked or current policy unavailable, replace the effective map with the existing baseline and equal-weight competing proposal cards, labeled **No effective candidate available**. Do not compute an application-order winner in JavaScript. No declared interfaces/relationships displays as such; graph layout cannot invent them.

Map, cards, detail panel and CLI preview use the same normalized projection. A preview does not create a Composition or claim profile compatibility. All omitted/collapsed trace details remain reachable and countable.

## Screen B: Create initial intent / edit a Layer

An uninitialized configured project offers **Create initial intent** only with the actual bootstrap capability. Steps: describe root purpose; define initial complete Blocks and parent tree; add requirements/criteria/contracts/relationships; review explicit host-approved authority and model; preview complete snapshot; **Initialize baseline**. Label the result **Bootstrap baseline — no validation evidence**. No pre-created scaffold is persisted. An unavailable capability shows its exact reason and CLI/setup handoff.

For an existing baseline, **New change** opens a Layer page:

1. Intent and server-resolved owner, exact baseline; Layer ID with validation. Ownership is not editable.
2. Block/item editor using complete atomic requirements, criteria, relationships, interfaces and supported v0.2 description fields. Preserve existing parameters, facets and inherited acceptance. Unsupported removal/reparent operations have no active controls.
3. Readable change list and live structural preview; errors link to the item. A structural check is not execution evidence.
4. **Save draft** produces an exact ref/digest and returns to the page. **Publish revision** is a distinct action after applicable review.

In read-only mode, use **Prepare draft / Export Layer** with explicit **Not saved** status. In write mode, unsaved text has **Unsaved changes**; success says **Saved L-change@2**, not **Accepted**. A stale-head refusal keeps the entered text, shows the actual owned head, and offers inspect/compare/export. No automatic merge or overwrite.

The later `block-create/1` form exposes full new Block content and an existing permitted parent; it saves in `created_blocks` of an owned Layer. Unsupported models show **Adding Blocks requires block-create/1**. Do not render nonexistent saved Blocks based on form state.

## Screen C: Review inbox and proposal detail

```text
Review                         Current principal: author-a / permitted actions
[Needs action | Owned drafts | Published proposals | Candidates | History]
L-change@2  Draft        Source questions (3)          Open review
C-choice@1  Blocked      Two writes to one item        Inspect choices
C-ready@2   Candidate    Validation missing            View gates
```

Rows derive from visible immutable records; refresh does not mark work done. A badge count covers the bounded loaded result with pagination/total semantics, not an unbounded hidden scan. Show exact revision and age; older revisions remain in history. Read-only sessions can inspect published records and only explicitly authorized drafts. A shared review link grants no access.

Proposal detail has a readable header followed by **Intent**, **Changes**, **Source & questions**, **Review**, **History**. Source panel lists exact manifest/digest, trace classifications, bounded file references and rationale. `observed` remains **Author-reported observation**. No browser source file opening without an explicit supported read capability.

Unresolved questions appear before the publish action, with **Revise proposal** for the owner. Review submission shows the exact normalized draft digest and a clear attestation statement. Source/draft review and v0.2 authoring review are distinct rows; neither establishes runtime correctness. Viewers lacking a grant get readable handoff text, not a disabled button with an unexplained lock.

## Screen D: Composition, conflicts, and decisions

Keep the current baseline selector and map. A composition tray lists the full considered set, selected whole Layers, exact dependencies, alternative groups and supported scenario checks. **Compose candidate** persists an inspectable Composition, including a blocked result. Show its ref immediately even when the CLI equivalent exits 5.

Conflict review reuses before/after cards: each competing value, contributor and downstream assumption is visible at equal weight. Choice controls make the complete select/reject partition explicit. No dragging order to resolve conflicts, silently dropping considered Layers or free-value repair inside a decision.

**Prepare decision** creates or hands off the supported decision-only Layer and exact unsigned payload. **Record selection endorsement** and **Seal Resolution** are separate authorized steps. In v0.2, show the mediation basis, packet and response status with exact expiry/current policy. A repair creates a new behavior Layer/revision and requires recomposition/review. Action results may lead to another principal; do not impersonate one automatically.

## Screen E: Candidate gates and Release

```text
Candidate C-change@2       Baseline R-start@1       Selected L-change@2
Readable effective intent / complete change summary

Gate                              State         Action / required capability
Published proposals               Complete      Inspect inputs
Selection and dependencies        Complete      Inspect Resolution
Implementation profile            Unsupported   No configured profile for these claims
Bound validation evidence         Unavailable   Requires supported realization
Responsible scope approval        Missing       scope-selector
Release approval                  Missing       release-manager

Evidence | Authority | Exact references | History
```

When supported, **Materialize** chooses a configured output slot/profile. **Import validation evidence** previews actual check results and bindings; it does not run or manufacture them. A future **Run supported checks** requires a genuine configured runner and displays observed job state only. Keep unsupported-profile reasons readable even if all other approvals are present.

Show criterion-level result, check/version/fixture/method, candidate/profile/output hashes and applicable checker/fixture/oracle hashes. Fixture attestations say so. Historical records remain **Recorded**, with current disk/policy verification separately stated. Failed/duplicate/missing/stale results cannot be clicked through.

**Approve scope**, **Approve protected change**, **Approve Release**, and **Publish Release** have separate exact review summaries and authority requirements. No single **Approve all** action. The final submission binds current candidate and evidence, recomputes gates, and returns an immutable receipt. A confirmed Release offers **Inspect Release** and **Continue from this Release**, never deployment. If another principal must act, preserve the task and give an exact handoff.

## Screen F: Connections, hosting, and agent handoff

Connection settings distinguish supported/configured/authenticated/readable/writable. Show server-side repository binding, model, freshness and expiry with redacted configuration; keep existing disconnect/reconnect and bounded read test. No browser credential entry for Artifacts and no write-enable toggle. Persistent hosted sessions expose login/logout and expiry; startup key provisioning and proxy settings are operator work outside this UI.

**Describe a feature** remains a handoff composer. Its status is **Handoff prepared — no agent has run** with copy/export. If no bridge exists, do not show an active chat input, typing state or predicted affected Blocks. Existing CLI/SDK capabilities are not a chat connection.

## Interaction and accessibility rules

- Reuse 44px minimum touch targets and visible focus; disabled actions have an adjacent reason and reachable details. Keyboard completes create/edit, inbox, composition, review and context changes without graph gestures. Map navigation retains the existing list/outline alternative.
- At desktop widths, main content plus a 350–380px review/detail panel fits the existing rail. At 1000px and below stack the panel; at 600px forms and comparisons become one column. At 360px no page-wide horizontal overflow; long refs wrap. Sticky action controls must not obscure errors or keyboard focus.
- Dialogs have a named heading, focus trap, Escape for unsent close and focus restoration. Dirty close/navigation offers keep editing, explicit discard, or export/save where authorized. Do not trap navigation after a confirmed save. A dispatched write gets outcome-reconciliation controls, not a false undo.
- Use a polite live region for saved/refreshed states and alert for actionable failures. Avoid focus jumps or automatic navigation as fresh records arrive. Preserve selected record and scroll; show **Newer revision available**.
- Changing project/connection/model/baseline invalidates previews and reviewed action payloads. Abort stale reads and discard their late responses by epoch. Keep unsaved content only within its original binding for explicit export/discard; never carry it into another project.
- Repeat clicks reuse one in-flight request/key. Unknown outcome, denied, expired, stale and partial-export states have different copy/actions. Reauthentication/reconnect never silently resubmits a mutation.
- Reduced motion and forced-colors retain meaning. Contrast targets: normal text 4.5:1, large text and controls 3:1. Verify 200% zoom, keyboard-only flow and screen-reader announcements; automated checks do not substitute for the manual reading test.

Visual acceptance is comparison against existing Application/map/detail/connection screenshots at 1440×900 and 390×844, plus new workflow screenshots at those sizes and 360px. Existing typography, colors and card grammar should remain recognizable. Ask Astra High to resolve a substantive mismatch before expanding the component system.
