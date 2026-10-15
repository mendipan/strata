# Local recovery milestone, 2026-10-04

The prototype now supports personal context navigation and restoring an older owned Layer into a new private revision. These commands work through the Node development broker and the real SDK broker in local mode. The canonical semantic model is unchanged.

Use the existing configured project, build and authorized fixture session. Commands never start a broker, choose another identity, refresh cloud state or grant permissions.

```powershell
node dist/src/cli.js context show --project PROJECT_ROOT --json
node dist/src/cli.js context use EXACT_RELEASE_OR_COMPOSITION --expect-generation 0 --project PROJECT_ROOT --json
node dist/src/cli.js layer restore CURRENT_LAYER_REVISION --from OLDER_SAME_LAYER_REVISION --project PROJECT_ROOT --idempotency-key UNIQUE_KEY --json
```

The references and generation above are placeholders; take exact values from returned records and `context show`. The first context selection requires generation zero. Further changes require the returned current generation. `--dry-run` checks a proposed operation without saving context, revisions or artifacts; `--human` explains the selection/restoration. Context commands are granted to local project readers; Layer restoration requires the author's operation grant and current Layer/Block assignment.

Context is broker metadata scoped to the configured project, the canonical local workspace and the server-resolved principal. It stores an exact target and content fingerprint; baseline and selections are derived on every read. Selecting a Release displays that Release as the baseline for new work, not its historical parent. A blocked Composition may be selected for inspection. An unset context is explicit. Different workspaces/principals are independent; processes sharing both intentionally share the context generation.

`context use` compares the expected generation at publication and returns `STALE_CONTEXT` when another update wins. It changes no semantic record, Layer head, approval, realization or deployment. Mutation commands retain their explicit input requirements; selected context cannot silently supply a missing `materialize` target or alter a recipe. Existing LayerAgent publication preserves this metadata.

For example, `layer restore L@7 --from L@3` creates the next draft `L@8`, provided 7 is the current owned head and 3 is an earlier revision of the same Layer on the same baseline/model. Both previous revisions remain unchanged, including their publication states. The command validates the complete source proposal using existing rules; it never restores the head to 3, rebases, extracts part of a peer Layer or repairs unsupported intent.

Restoration validates through the dual-model Layer schema. Same-model v0.2 restoration appends a private revision with all prior records unchanged. Publishing it requires a fresh exact authoring review; a prior revision’s review is refused with `STALE_AUTHORING_REVIEW`. The regression remains in [the recovery tests](../tests/zcode-recovery.test.ts).

The new draft receives no copied publication, approval, validation or accepted review status. A restored supplied-proposal Layer still needs its new exact source/draft review. Publishing it and selecting it in a new candidate remain separate operations; changed candidate references require matching evidence and authority endorsements. Result metadata and the atomic commit audit bind the previous head, source reference/fingerprint and new revision without adding unsupported canonical Layer fields.

Restoration compares the current head at commit. Concurrent requests produce one new revision and one stale-head failure rather than overwriting work. An exact authorized idempotency-key retry after response loss returns the same revision. Current ownership, operation permission and source Block assignments are checked before cached restoration results and again before publication. Revocation or a narrowed assignment cannot be bypassed with an old key. Failed staging may leave unindexed orphan bytes, as in existing publication; it does not change the committed history.

Known older Releases can already be inspected, compared, used explicitly in a new Composition or materialized with the supported pinned profile into an empty output directory. Choosing an older Release does not erase newer history. A correction to accepted intent remains a new authored Layer through ordinary compose/validate/approve/release gates.

This personal/Layer recovery milestone does not implement draft abandonment/cancellation, a shared current Release, arbitrary inverse changes, mirroring, deployment or data rollback. The later separate [Node backup/inactive-restore milestone](LOCAL_BACKUP.md) implements bounded quiesced bundles; it does not activate a recovered project or restore customer application data. Local fixture identities and audits remain the existing trust boundary. See [the recovery workflow plan](RECOVERY_WORKFLOWS_PLAN.md) for those separate scopes and [the implementation contract](IMPLEMENTED_CONTRACT.md) for current capabilities.

Run `node --test dist/tests/recovery.test.js dist/tests/zcode-recovery.test.js` after building. Tests use isolated temporary state and verify semantic history, private visibility, lost-response retries and local SDK behavior.
