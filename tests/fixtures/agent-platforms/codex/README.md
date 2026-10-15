# Synthetic normalized Codex execution transcripts

Nine synthetic scenarios accompany the [ADAPTER-P proposal](../../../../docs/agents/platforms/CODEX_EXECUTION_MAPPING.md). These are hand-authored projections illustrating Strata execution/1 DTOs, not wire captures, a functioning mapper or qualified integration. No live runtime, account or credential is represented.

- [transcripts.json](transcripts.json) records synthetic native projections and proposed adapter decisions. Exact upstream commit, schema paths and Git blob IDs are in `pinned.schema_sources`.
- [validate.mjs](validate.mjs) checks shared schemas, identities/digests, transitions, conservative dispatch certainty and selected reviewed fields. It neither validates full native schemas nor executes a mapper.

## Source and normalization

`rust-v0.162.1` resolves to `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. Checked-in generated schemas resolve the original placeholders: `thread/start.sandbox` is `"workspace-write"`, approval policy is `"never"`, interrupt requires both handles, and simple error variants are camel-case strings. Binary-generated schema equivalence remains unverified.

All identifiers, text, paths and timestamps are synthetic. Responses/notifications omit fields and are **not complete native messages**. `artifact_contents` supplies fixture bytes for digest checks, not native data. Journal steps describe intended decisions, not implemented durable storage. The secret-pattern check is not a general secret scrubber.

Every scenario represents an already-invoked adapter operation, so errors have dispatch `unknown`, including read rejection and journal conflict. Only a guard refusal before invocation can be `not_dispatched`; none is illustrated here.

The known-thread scenario assumes retained exclusive thread identity and complete, uniquely attributable history after a lost turn-start reply. Recovery without that handle remains unsupported. Deadline-triggered interruption proves neither hard deadlines nor interrupt reliability. Approval suppression and stopping guarantees remain unqualified.

## Validation

```sh
npm run build
node --import ./tests/no-external-fetch.mjs tests/fixtures/agent-platforms/codex/validate.mjs
```

Refs, result digests and artifact bytes/digests are re-derived with [shared helpers](../../../../src/agent-execution.ts). Passing confirms DTO examples, not that native inputs produce them. No runtime launch/provider call is authorized by these checks.
