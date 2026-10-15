# Synthetic normalized Claude Agent SDK execution transcripts

Five synthetic scenarios accompany the [ADAPTER-P proposal](../../../../docs/agents/platforms/CLAUDE_EXECUTION_MAPPING.md). These are hand-authored projections illustrating Strata execution/1 DTOs, not wire captures, a functioning mapper or qualified integration. No live runtime, account or credential is represented.

- [transcripts.json](transcripts.json) records synthetic native projections and proposed adapter decisions. The exact SDK version, interface mirror, immutable tag/commit, binary provenance and documentation inventory are pinned in `pinned`.
- [validate.mjs](validate.mjs) checks shared schemas, identities/digests, transitions, conservative dispatch certainty, reviewed interface literals and the claimed source pins, and rejects deliberate result/ref/sequence/artifact/pin substitution, string-as-stream input, plain-interrupt cancelled lists, history-only success and retained-completion request substitution in memory. It neither validates full native schemas nor executes a mapper.

## Source and normalization

`@anthropic-ai/claude-agent-sdk` `0.3.296` (registry `dist.shasum` `255c4d284de2262fa8447a94a06d2541c0f5d20c`) is the interface pin; `sdk.d.ts` of that exact version was read through a versioned unpkg mirror on 2026-10-12. The SDK declares bundled Claude Code `2.1.296` via its manifest and platform binary optional dependencies. GitHub tag `v0.3.296` resolves to commit `85d8f8e0772199ec7965a0c2e874ac88343f2a01`, whose tree ships no SDK source, so the interface pin rests on registry package metadata plus the mirror; the complete mirror text has SHA-256 `fc2866dfe2c01468edb19b1d94f26156bfacecdf1e7f1452b276ed2f8cc0b08f`. This fingerprint is not publisher attestation, tarball-content verification or installed-interface proof. Keys marked `$synthetic` (`AsyncIterable<SDKUserMessage>`, `SandboxSettings`, the `canUseTool` callback, the `SessionStore` object) represent non-serializable input or unqualified configuration. The success final-text field `result: string` was verified in the exact mirror. A string prompt is not streaming input.

All identifiers, text, paths and timestamps are synthetic. Responses and events omit fields and are **not complete native messages**. `artifact_contents` supplies fixture bytes for digest checks, not native data. Journal steps describe intended decisions, not implemented durable storage. The secret-pattern check is not a general secret scrubber.

Every scenario represents an already-invoked adapter operation, so errors have dispatch `unknown`, including journal conflict and unresolvable identity lookup. Only a guard refusal before invocation could be `not_dispatched`; none is illustrated here.

The known-session scenario assumes a bound native identity and a separately retained, uniquely attributable completion from the original query stream after the stream was lost. Recovery without that identity remains unsupported: the unknown-session scenario keeps the admission uncertain and blocks every second start rather than resubmitting. Session metadata/history alone cannot establish terminal success; the retained-completion step is an explicit synthetic assumption. An absent bound ID refuses locally without a native helper call. The cancel scenario illustrates the cooperative interrupt/completion race; `query.interrupt()` can return undefined and does not request queued-message cancellation; its receipt is a method return with `still_queued`, not an SDKMessage with a `cancelled` list. A receipt is not proof that the task stopped, and no hard runtime limit is established.

## Validation

```sh
# Requires the accepted precompiled shared DTOs and their pinned local dependency.
node --import ./tests/no-external-fetch.mjs tests/fixtures/agent-platforms/claude/validate.mjs
```

Refs, result digests and artifact bytes/digests are re-derived with the [shared helpers](../../../../src/agent-execution.ts). Passing confirms DTO examples, not that native inputs produce them. No runtime launch or provider call is authorized by these checks.
