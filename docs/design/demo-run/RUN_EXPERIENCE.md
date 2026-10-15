# Run experience, storyboard, and copy

Proposed design. Static illustrations are explicitly labeled; no new runtime behavior is implied.

## 1. The workbench

Use one stable operational page. Its title is **“From competing proposals to a tested Release.”** Under it, keep three independent pieces of status visible: source mode, run phase, and connection freshness. A compact five-object strip teaches the vocabulary: **Blocks · Layers · Composition · Resolution · Release**. This strip is an explanation, not a percentage-progress meter: real workflow phases do not map one-to-one to these objects.

Desktop, 1280–1600px: 64px header; 24px gutters; a flexible main stage and a 360–420px right review panel. Main stage minimum 580px. Header contains the brand, “Run demo,” source-mode badge, and “Run setup / evidence.” Below it, one sentence explains the current change. At 1280×800, show the current phase, meaningful diagram, and next action without scrolling past startup checks. Detail drawers may scroll. Avoid nested scrolling in the decision comparison.

The stage changes content at meaningful boundaries while preserving the same object positions:

- **Owned work:** A and C in peer lanes; B below them with its dependency context. A small shared intent map remains central. Each lane carries a Layer card rather than a chat bubble or terminal feed.
- **Choice:** shrink the work lanes into a compact context rail. Use the main stage for an equal-weight comparison and the side panel for the current packet, reason, and submission.
- **Evidence:** show the accepted Composition, implementation profile, and result rows. An observation graphic appears only with appropriate evidence and a clear simulated-time label.
- **Receipt:** the Release becomes the main card. Show inherited behavior and cleanup beside it; preserve a “Review this run” route through its earlier stages.

“Follow current stage” is on by default. A deliberate inspection opens “Viewing earlier evidence · Return to current stage.” Do not yank focus or scroll when new events arrive. A new human decision gets a quiet in-page notice and a “Review decision” link. Stop remains accessible while the run accepts it.

## 2. Visual language

Reuse marketing values, with operational density:

| Token | Value / use |
| --- | --- |
| Canvas / surface | `#f5f2eb` / `#fffdf8` |
| Text / secondary | `#201d18` / `#62594d` |
| Divider | `#d8d0c3` |
| Accent / accent fill | `#a94f13` / `#fbf3e5` |
| Warm graphic highlights | `#d58a33`, `#f0c47a`; decorative fills, not small text on paper |
| Verified / blocked | Proposed `#42654d` / `#9b4835`, always with an explicit word and icon/shape |
| Typography | Georgia for the short main heading and prominent outcome values; Segoe UI/system sans for controls and body; Consolas/monospace for exact references |
| Type sizes | H1 32–40px; phase heading 24–28px; body 16px/1.5; reference/metadata 13–14px; never shrink semantic diagram labels below 13px |
| Spacing / geometry | 4/8/12/16/24/32 rhythm; 8px card corners; 1px outline; no large glossy gradients or atmospheric background art |

Use the existing brand asset, not a new logo. Keep serif sentences and generous main-stage breathing room, but omit the marketing hero, navigation, slogans, and tall promotional sections. Graphics are interactive views of semantic data; decorative drifting agents, particles, typing bubbles, or progress rings have no place in the operational page.

### A diagram grammar with no hidden precedence

| Mark | Meaning | Exact basis |
| --- | --- | --- |
| Nested labeled scope / thin neutral branch | Block parent relation | `blocks[id].parent`; show `app → booking → {booking.hold, booking.reminder}` |
| Solid labeled relationship line | A Block consumes another Block’s contract | `booking.reminder.relationships.hold.target` and its statement |
| Amber connector from Layer to an item | This proposal changes this item | `Layer.changes[].block/path`; endpoint names `requirements.expiry` or `requirements.timing` |
| Dashed blue connector labeled “Requires exact revision” | Layer dependency | `requires_layers`; show `L-reminder@1 → L-hold@1`, then `@2 → L-alternative@1` |
| Dotted neutral connector labeled “Read” | Recorded informational read | Actual `read_set` or observed successful inspect; do not infer reads from lane placement |
| Framed group labeled “Selected in Composition” | Whole-Layer selection | Exact selected set and matching candidate |
| Retained outline card labeled “Not selected” | Considered alternative remains in the record | Exact rejected set; no delete animation |

Parenthood describes responsibility, not which proposal wins. Layer height, lane order, color, actor model, start order, and graph proximity give no authority. Keep A and C visually equal. Use an expandable scope tree, not an invented multi-level agent command hierarchy. Put the reminder relation and its Layer dependency on separate labeled tracks; they are different records.

The chip label is **“Facets”**, with tooltip “Overlapping concerns on requirements.” Derive Block chips from the union of `requirements.*.facets`, using `blockFacets`. Actual hold facets are Behavior, Data, Safety; reminder timing is Behavior. Do not add Design to this scenario merely because the UI looks designed. Facets neither prove coverage nor grant authority. Freeform tags and tag editing are outside this run design.

### Agent lanes and publication

Each lane has actor A/B/C, “Owns L-hold / L-reminder / L-alternative,” assignment, observed invocation state, and latest observed revision state. Model/effort and actual tools/turn totals live in a details disclosure. Distinguish:

- **Assignment:** “Propose 15 minutes.” A task input, visible before execution and explicitly labeled Assigned.
- **Invocation:** “Launch observed,” “Invocation finished,” “Interrupted,” or “No completion observed.” Launch does not prove active reasoning at that instant.
- **Proposal:** “No publication observed,” “Draft observed,” “Published @1,” “Revision @2 published,” or “Publication status unavailable.” Derive from successful semantic results.

A and C can carry simultaneous “Launch observed · completion pending” outlines when their observed invocation intervals overlap. Say **“A and C invocation windows overlap”**, with “Host observation” nearby. Never display “2 agents thinking,” made-up token streams, percentages, estimated completion, or tool stages inferred from elapsed time. Invocation finished is not equivalent to proposal published.

At B’s second invocation, keep @1 in the same lane as a prior immutable card, then show @2. Caption: **“Same owner. New revision. New review.”** Never rename B’s second invocation “Agent D,” and never show A/C restarting. If the UI only has sparse records, use static last-observed states rather than an animated live inference story.


## 4. Screen copy and human choices

### Ready to begin

**Heading:** “Review and begin one demo.”

**Summary:** “Three assigned actors propose changes to a booking hold and its reminder. You choose the duration and separately approve the measured Release.”

Show the actual grant’s actor count, process allowance (3 or 4), maximum concurrency, 30-minute window including cleanup, subscription-only path, usage-stop target caveat, and resource retention/removal policy. Keep these readable in structured rows, with exact technical details in a disclosure. No digest transcription.

For four processes: “This run allows one further reminder invocation if you choose 20 minutes. You will review the new revision before a separate Release decision.” For three: “This run cannot complete the 20-minute repair. That choice stops at the repair gate.” Do not advertise repair based only on the scenario’s existence.

Name field: **“Your name (self-declared)”**. Consent: **“I approve this one run, its limits, and its cleanup.”** Primary: **“Begin this demo.”** Secondary: **“Review exact setup.”** Scope note: “Your browser response is recorded locally. This demo does not authenticate your identity.” Match the exact reviewed source/target/review hash invisibly in the existing submission.

After completion, readiness is historical: “Run setup · checked before this run.” Replace the unspecific “model execution remains untested” headline with dated preflight context and independent actual actor evidence. A prior success does not guarantee the next run’s availability.

### First selection packet

**Heading:** “Choose the hold duration.”

**Context:** “Both authors change `booking.hold / requirements.expiry`. The reminder currently requires `L-hold@1` and assumes 900 seconds.”

| Comparison | 15 minutes | 20 minutes |
| --- | --- | --- |
| Expiry change | 600 → 900 seconds | 600 → 1200 seconds |
| This packet selects | `L-hold@1`, `L-reminder@1` | `L-alternative@1` |
| This packet sets aside | `L-alternative@1` | `L-hold@1`, `L-reminder@1` |
| Current reminder effect | Once at second 840 (minute 14) | Disabled in this initial candidate |
| Next step under four-process grant | Materialize and measure | Ask B to publish a compatible reminder revision, then review a new packet |
| Evidence status | Not yet measured | Not yet measured |

Do not summarize the first 20m option as already including a minute-19 reminder. Its canonical packet has `executable:true` for the reminder-disabled candidate; the attended workflow separately intercepts this choice for repair to satisfy the request. Present both facts: **“This packet leaves the reminder off. Continuing this demo requires a revised reminder and another review.”** Do not invent a backend `executable:false` value to explain the repair gate.

The first 20m response records a repair direction and receipt; it does not yet create the selected candidate’s Resolution. Show that Resolution only after the repaired packet is accepted and the backend actually creates it.

Use equal-weight option cards with native radio inputs, nothing preselected. Selecting a radio only previews the choice; it creates no consent. Reason label: **“Why this choice?”** Blank placeholder: “Explain the tradeoff you are accepting.” No auto-filled persuasive rationale. Primary button names the selected action: **“Choose 15 minutes”** or **“Choose 20 minutes and repair reminder.”** With the three-process grant use **“Choose 20 minutes — stop at repair gate.”** Separate secondary action: **“Defer and clean up.”** A reason is required for every decision, including defer. Full considered set, retained acceptance, scoped authority, and exact packet stay inspectable without JSON literacy.

### Repair review

**Heading:** “Review the reminder revision.”

**Summary:** “The reminder now requires `L-alternative@1` and assumes a 20-minute hold. Its rule remains one reminder 60 seconds before expiry.”

Show @1 → @2 beside each changed dependency and assumption; the reminder rule is **unchanged**. Acceptance inherited/added remains visible. Display the newly considered set: `L-hold@1`, `L-alternative@1`, `L-reminder@2`; keep @1 in prior history, not in this packet’s considered set. Predicted reminder at 1140s is marked **“Expected, not yet measured.”** Choices: **“Confirm 20 minutes with revised reminder”** and **“Defer and clean up.”** Clear previous radio state and reason when the packet digest changes. Do not carry over the prior approval or silently select 20m.

### Measured candidate and separate Release gate

**Heading:** “Approve this measured Release?”

**Summary:** “The selected candidate has passed its required checks. This is separate from your duration choice.”

Show accepted duration/reminder, exact selected revisions, candidate and realization references, `booking-node/2`, output-tree/evidence details, and required endorsement scopes. Present **mechanical checks** and **scripted purpose reviews** as separate lists. In this finite demo one human supplies the isolated scope and Release endorsements; do not depict multiple independent human reviewers or guardian approvals that were not required/performed. Actors cannot approve.

Primary **“Approve this Release”**; secondary **“Defer and clean up.”** Reason label **“Why approve or defer this Release?”** Leave it empty. Do not call a candidate “released” because validation checks passed, or infer approval from a finished actor, transport acknowledgement, or provider status.

### Completion

**Heading:** “A tested Release. A reusable baseline.”

Three distinct panels:

1. **Release validated:** exact Release ref; selected duration and reminder; mechanical result count; scripted-review count; distinct recorded decision steps.
2. **Inherited behavior verified:** matching measured behavior for the inherited realization only when `inherited_observations_equal:true` is present; describe provenance/obligation carry-forward separately from runtime measurements.
3. **Cleanup verified:** instance absent, repository absent, scoped tokens settled, handles disposed, namespace empty; private Worker/Workflow and local evidence retained. Display a verification timestamp if actually available.

The measurement graphic is an **evidence visualization**, not a newly generated booking website. The current profile creates a command-driven Node app; no deployed booking UI or public app URL exists. Label a time rail **“Fixture time · seconds since hold”**. Show observed markers only when measurements are available; an expectation rail may show 0, 1140, 1200 labeled Expected. Do not animate a 20-minute wait as if it is real elapsed runtime.

Next actions: **“Review this run”**, **“View evidence”**, and **“Prepare a fresh demo”** only when backend `can_fresh` allows it. The latter prepares review; it never begins a run. Evidence means retained local proof, not a still-existing remote repository.

## 5. Recovery and uncertainty copy

| Condition | What stays visible | Message and action |
| --- | --- | --- |
| Initial loading | Shell and source mode; no success placeholders | “Loading the current run.” |
| Missing capability / expired browser access | Last read-only context, if any; disabled decision controls | “This page cannot access the local runner. Open its private link from the existing terminal.” Never expose/copy the capability into a visible field. |
| Disconnected | Freeze last-known diagram; prominent timestamp | “Connection lost. Showing the last observed state. The run may continue.” “Reconnect” reads state only; no automatic POST retry. |
| Connected, no new semantic event | Last-known phase, last checkpoint and last successful poll separately | “Runner connected. Last checkpoint observed [time].” Silence alone is not failure or lack of actor activity. |
| Packet changed or expired | Old comparison marked no longer actionable | “This review changed or expired. Review the current packet before responding.” Clear selection/reason for a changed digest. Never manufacture a new packet client-side. |
| Decision POST acknowledgement | Packet-specific pending feedback | “Response received by the local controller. Waiting for the Workflow to record it.” Ack is not semantic approval. |
| POST timeout / lost response | Pending choice shown as uncertain; submit disabled | “Response status is unknown. Reconnecting before any further action.” Confirm from authoritative state; do not resend automatically. |
| Checkpoint outcome refused | Last valid content and safe code | “The Workflow refused this step. No successful change was recorded for it.” Show refusal separately from actor-process status. |
| Startup failure | Approval receipt distinct from execution state | “The demo did not start. Your Begin response was recorded.” Cleanup unknown until verified; do not claim zero effects from an absent event list. |
| Actor failure | Last publication remains visible if observed | “An actor invocation stopped. Review the last recorded proposal and cleanup status.” No inferred rollback of published immutable records. |
| Stop / defer | Current evidence and specific requested action | “Stopping work and checking cleanup.” Stop is not instant cancellation or verified absence. |
| Cleanup waiting / blocked | Release result remains if it exists | “Release validated. Cleanup still needs attention.” Or “Run stopped. Cleanup is not verified.” Show exact blocked checks and operator reconciliation instructions; fresh-run stays unavailable. |
| Provider complete; app unsuccessful or unknown | Separate provider/app panels | “Provider finished; application result needs review.” No global green badge. |
| Incomplete or inconsistent export | Last accepted prefix or status-only card | “This export cannot establish the next state.” No fabricated proposals, result, timestamps, or enabled gates. |
| Old checkpoint after newer one | Current state retained; diagnostic in evidence drawer | “An older update was ignored.” Same identity/sequence with conflicting content halts projection and requests resynchronization. |
| Source changed after readiness | Old review unavailable | “Source changed. A new exact review is required.” No silent redeployment or fresh grant. |

## 6. Accessibility and responsive behavior

At 960px, stack stage then review panel. At 600px and below, use a single column: mode/freshness, phase/context, current decision, expandable Layers/Blocks, evidence. At 320–430px, change the graph into named object rows and a relationship list (“Reminder requires Hold revision 1”), not a shrunken desktop canvas. Radios and all exact selected/rejected references remain readable. Keep primary action at least 44px tall; do not let a sticky footer cover reason errors or the focused control. No page-level horizontal scroll. Long references wrap; full digests live in disclosures.

Graph selection also works via an ordinary list of buttons. SVG is supplementary and has title/description; the list contains the full relationships and states. Native fieldset/legend/radios, explicit labels, keyboard-accessible disclosures, visible focus, correct heading order, and text status labels are required. A polite live region announces meaningful phase changes once, not each poll or counter. Errors have associated inline text; do not use an alert region for ordinary success feedback.

Use motion only to connect an observed transition, 150–220ms crossfade/outline change. No looping pulse, spinning agents, auto-pan, parallax, or force-directed graph. Reduced motion removes transitions and preserves the final state. Replay autoplay is user-started and pausable; keyboard and screen-reader users can step through the same content. Verify contrast (text 4.5:1, large text/non-text UI 3:1), 200% zoom, 400% reflow, forced colors, and the phone layout during implementation; palette reuse is not a compliance claim.
