# Synthetic recovery test fixtures

Inputs in this directory are hand-written synthetic bytes for
`tests/zcode-recovery.test.ts`. They contain no real project state, identities,
credentials, session data or private application data.

- `truncated-layer-draft.json` — deliberately invalid (truncated mid-string) JSON
  used as CLI stdin (`--file -`) for the malformed-input boundary case. It is a
  fixture *file* rather than an inline string so the exact malformed bytes are
  reviewable as written.
