# Synthetic translation test fixtures

Inputs in this directory are hand-written synthetic records for
`tests/zcode-translation.test.ts`. They contain no real project state,
identities, credentials, session data, customer/provider data or private
application data.

- `expiry-proposal.json` — the author-prepared supplied proposal for the M1
  positive exchange. It was authored for this assignment (not generated or
  inferred by Strata) against the known booking fixture baseline `R0@1`
  (v0.1, expiry 600, reminders disabled). Its single Layer change expects the
  complete exact 600-second expiry requirement and proposes the consistent
  900-second replacement; its traceability names the two files the test derives
  from a fresh `booking-node/3` materialization of `R0@1` after changing only
  the explicit expiry configuration (`booking.mjs`, `intent.json`), and its
  `questions` are empty.

Digest-dependent inputs (the source manifest, per-file byte digests and the
experiment tree itself) are deliberately **not** checked in: the suite
generates them from fresh test outputs on every run so the recorded digests
always describe bytes that actually exist in that run.
