# Visual Explorer

The Blocks route opens a semantic application map for an exact Release. It uses
the existing authenticated, generation-bound `record`, `blocks`, and `block`
reader operations. There is no separate project store or inferred latest Release.
`Outline & full details` retains the original inspector and filters.

## Reading a map

- Cards show a display label derived from the Block ID, the actual ID, purpose,
  rule and criterion counts, direct facets, and declared parent. Full statements,
  contracts, criteria, provenance and authority are available in the focused card.
- Solid directed arrows are authored Block relationships. Their authored key and
  statement remain available in the focused neighborhood. A relationship is not
  automatically called a dependency: its recorded statement supplies the meaning.
- Dotted arrows show explicit parent containment. Dashed purple links, off by
  default, are cross-references derived from acceptance subjects. They are not
  declared dependencies. Layer dependencies remain exact Layer references in the
  Layers view.
- Layout groups connected authored relationships. Position and proximity do not
  assert meaning. Selecting a Block centres its immediate neighborhood, highlights
  connected cards, and exposes links for cross-navigation. Browser back and close
  retain exact references. The neighborhood toggle restores the broader map.
- Search uses the reader's real purpose, rule and criterion search. A selected
  Block outside a filter is explicitly marked as context.
- Maps page at 48 cards and cap drawn lines at 160. The focused relationship list
  remains complete. Scroll, touch pan, background drag, keyboard arrows, zoom,
  fit and an unscaled card-list mode support different screen sizes. Empty and
  missing data are described explicitly. The reader continues to reject corrupt
  parent trees and dangling references; relationship cycles are supported.

## Layer review

Choose a Layer on the selected baseline to mark the Blocks it proposes to change.
Baseline cards are never rewritten by an overlay. Open a marked Block for readable
before/after items, or open the Layer for its complete proposal, exact dependencies,
reads, assumptions, provenance and recorded preconditions. An overlay is not a
Composition, selection, validation, approval or publication. JSON is an optional
advanced view.

## Human proposals and agent handoff

`Prepare a proposal` builds a temporary, human-authored Layer draft using the
existing `set_item` contract. It supports purpose changes, complete requirement
edits, new requirements, and linked acceptance criteria. Parameters and inherited
criteria are retained unless explicitly edited within supported rules. New criteria
need real check/version/fixture identifiers; the form does not implement checks.

The human supplies a new Layer ID, requested owner and intent, adds items, and
reviews before/after values before copying the complete Layer JSON. The expected
baseline values are captured from the exact Release. The authenticated agent/CLI
must import through `layer.create` (or an appropriate owned revision workflow),
which performs authoritative normalization, ownership and baseline validation.
UI input checks are not a substitute for that validation. Tests run exported
drafts through the shared core's `normalizeLayer` in both supported models.

There is no authorized Explorer write adapter in this version. Repository save is
disabled even if an arbitrary capability flag appears. Drafts are held only in
the open dialog, with no local-storage persistence, and cancel discards them.
Changing metadata invalidates reviewed exports. Refresh, navigation and the
`strata:connection-change` event close drafts; stale view epochs refuse export.

`Describe a feature` prepares a plain-text agent handoff containing project,
model, exact Release and human-selected context Blocks. It explicitly says no
agent has run and no affected-item plan has been predicted. The user copies it to
their existing authorized agent. No keyword matcher, token entry, provider call,
new grant or paid service is involved. Agents must propose affected items and
owned Layers for review before writes. The current Layer contract cannot create
new Blocks; new-Block ideas are requests, not fabricated importable operations.

## Integration boundary

New static modules: `application-map.js`, `semantic-model.js`, `readable.js`,
`proposals.js`, `draft-model.js`. The host only adds those exact filenames to its
positive static allowlist. No data route, credential handling, CSP, permission or
write boundary changes are needed for these views. [Connection settings](CONNECTIONS.md)
use the existing reader adapters, abort active renders and dispatch
`strata:connection-change` on connection changes. A changed connection or registry
generation clears the selected Layer overlay and closes temporary draft dialogs.

Map view state (`view`, selected `layer`, Block and Release) is in the hash route.
View contexts snapshot route state so late asynchronous reads cannot change the
meaning of an in-flight render. Existing collapsed-outline preferences are still
saved explicitly.

## Local verification

Build/typecheck use the repository scripts. Unit tests in
`tests/explorer-visual.test.ts` cover graph projections, 1,000-card pagination,
cycles, missing references, filter context, draft preconditions, authoritative
Layer normalization, and unchanged repository records. The existing Explorer
reader/host/security tests remain applicable.

Run `tests/explorer-visual-browser.mjs` with the existing Playwright installation
selected by `STRATA_EXPLORER_PLAYWRIGHT_MODULE`; it uses Edge and loopback synthetic
project data. It checks map/card/Layer interactions, keyboard navigation, browser
back, repeated selection races, pan/zoom, mobile reflow, real Layer exports,
cancellation and invalidation. `tests/explorer-browser.mjs` exercises retained
outline/comparison/evidence workflows. Screenshots and receipts go to the OS
temporary directory, outside Git. Use `tests/no-external-fetch.mjs` for offline
verification. No live credential or deployment is needed.

The map currently reads the full allowed Release record, so the reader's existing
2 MiB response bound still applies. Larger records fail closed with the existing
view-limit error; they are not silently truncated. Screen-reader speech and real
operating-system zoom require separate manual verification.
