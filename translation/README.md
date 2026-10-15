# Bidirectional intent and implementation

Strata's return path accepts a person- or agent-prepared proposal. It does not infer intent from arbitrary code, translate between programming languages or guarantee semantic equivalence.

1. Pin the exact Release/Composition, supported profile and explicit source-file manifest.
2. Materialize supported intent. Each realization binds its candidate, profile/template, coverage and output-tree digest.
3. Prepare a proposal mapping every change to explicit source traces, rationale and unresolved questions. Classify traces as observed, inferred, correction or uncovered.
4. `distill` reads only manifest-listed, hash-matching source files and creates an owned draft. It never executes source instructions. Against a Composition, its baseline remains that Composition's baseline.
5. Review the exact draft/source set. Publication requires complete review and no unresolved questions; it does not select the draft or approve a Release.
6. Compose with explicit dependencies/assumptions and required decisions. Rematerialize, collect fresh evidence and obtain separate approvals before Release. Previous evidence cannot validate a changed realization.

See the [implemented contract](../docs/IMPLEMENTED_CONTRACT.md), [CLI plan](../docs/CLI_PLAN.md), [source manifest](../examples/source-manifest.json) and [prepared proposal](../examples/distill-proposal.json).

## Regression coverage and lessons

The booking example provides the finite return-path fixture in `tests/zcode-translation.test.ts` and `tests/fixtures/zcode-translation/`. It exercises a 600-to-900 duration change with reminders disabled in the baseline. A reminder at 840 requires a separately owned, selected companion proposal. Unsupported vocabulary, changed source bytes, wrong baseline/profile, stale or missing review, omitted traces and reused evidence must fail at their actual gates. The core/profile separation tests add a distinct counter vocabulary; application-specific rules stay inside profiles.

The read-only Explorer supports repository identity pinning, exact immutable locators and one hash-bound unpublished draft review grant. `tests/explorer-task-env.test.ts`, `tests/explorer-task-draft.test.ts` and `tests/explorer-launch.test.ts` use generic synthetic records to check environment auth, expiry, identity mismatch, draft visibility and default denial. Reading a draft never changes publication, selection or approval state.

Run `npm run build`, then `node --test dist/tests/zcode-translation.test.js dist/tests/profile-separation.test.js dist/tests/explorer-task-draft.test.js dist/tests/explorer-task-env.test.js dist/tests/explorer-launch.test.js`. Keep external application payloads and operational history in their own workspace; add only reusable fixes and synthetic regressions here.
