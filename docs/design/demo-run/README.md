# Integration example presentation

Show who owns each proposal, which Blocks it touches, why dependent Layers pin a revision, which exact choice is pending and what survives as a Release. Runtime status must distinguish observed, missing and unverified information.

- [Experience and copy](RUN_EXPERIENCE.md): layout, graphic language, decision screens and exceptional states.
- [Component/data contract](DATA_CONTRACT.md): read-only presentation projection and exact evidence sources.
- Static design illustrations: [owned Layers](01-owned-layers.svg), [decision](02-human-choice.svg), [Release](03-release-receipt.svg) and [phone](04-phone-choice.svg). These synthetic illustrations contain no working controls or live records.

The presentation is implemented under `src/demo-run-*.ts` and exercised by `tests/demo-run-presentation.test.ts` and `tests/demo-run-browser.mjs`. The local Explorer remains a separate reader of retained project records. Both surfaces distinguish exact references, fixture trust and current versus historical evidence.
