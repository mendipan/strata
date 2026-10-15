# Contributing to Strata

Use Node.js 22+, the pinned lockfile and the [getting started guide](docs/GETTING_STARTED.md). Read the [implemented contract](docs/IMPLEMENTED_CONTRACT.md) and relevant design docs before changing semantics. Apache 2.0 applies; preserve the license, notices and third-party attribution.

## Repository boundary

Track Strata engine/runtime code, reusable APIs and development documentation, schemas, the customer-deployable Studio/Explorer structure and clearly labelled synthetic examples/regression fixtures. The marketing website, its illustrations and site-only checks live in [strata-site](https://github.com/mendipan/strata-site). Keep reusable self-hosting instructions here; specific host addresses, service settings and operational receipts belong outside both repositories. Keep external applications, their source snapshots, real project registries, generated outputs, connection files, deployment receipts, personal environment records and private promotional/event planning outside the repository. Application usage belongs in the application's own workspace. Bring back only the reusable defect, contract or synthetic regression needed to improve Strata.

Booking is a finite example profile. The core dispatches declared capabilities; avoid application names, Block IDs or parameter knowledge in core composition/publication/validation. New domain support needs an explicit profile and meaningful acceptance checks. The website checkout interaction is a simulation, with no engine profile implied.

Local outputs belong in ignored `.strata/` or a task directory outside the checkout. Browser artifacts belong in ignored `output/playwright/`. Use explicit input/output paths for external usage. Never move execution logs into docs or replace test fixtures with live records. Commit fixtures under `tests/fixtures/` or `examples/` only when synthetic, bounded, documented and required by a test or example; include their generator when practical. Do not broadly ignore JSON, fixtures or evidence code.

## Validation

```powershell
npm run build
npm run typecheck
npm test
npm run verify:local
npm run check:links
```

Run affected browser suites and local SDK tests described in [verification](docs/VERIFICATION.md). Keep semantic refusal, authorization, exact-reference, source-binding, evidence and failure-recovery assertions. Test successful behavior and the boundary the change protects. Check the staged diff for personal IDs/paths and generated records; inspect `git status` after testing. Passing local checks does not establish hosted identity, provider interoperability, CI or deployment success.

Remote adapters and optional attended examples require fresh explicit host targets, source/version pins and per-run authorization. Local tests use injected synthetic seams. A saved config, historical result or documented command is not authority to run a cloud experiment. Marketing source and deployment checks belong in its separate repository.
