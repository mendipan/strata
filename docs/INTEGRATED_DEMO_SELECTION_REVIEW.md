# Local selection review view

The operator CLI can render the pending integrated-demo selection packet as a read-only HTML comparison:

```powershell
npm run build
node ./dist/scripts/integrated-demo-operator-reply.js review <workflow-description.json> <new-review.html>
```

The input must contain the latest successful Workflow `apply` output with a pending selection. The command refuses a stale or incomplete apply, a mismatched packet digest, a mediation packet whose bytes/ref/hash disagree, or an output path that already exists. It does not support the later endorsement packet; that remains on the separate existing reply and approval path.

The synthetic fixture preview (run the local verification commands for a fresh result) was rendered from the existing `preparedFixture()` test helper. It is illustrative only and contains no live run or real operator decision.

The view renders the exact option partitions and source Layer revisions from the packet. It shows affected Block IDs, each selected Layer's expected and proposed values, excluded competing Layer changes, exact dependencies and assumptions, retained baseline acceptance, Layer-added acceptance, packet effects, and remaining validation/Release gates. The page does not use an agent-written summary as proposal data.

This initial version is read-only and does not implement inline comments. It is a local static page with no scripts or remote resources. It creates no reply artifact and cannot approve a selection or Release. Selection eligibility and packet effects are not measured validation evidence. Any proposal edit requires a new case revision, packet digest, and reply. A locally supplied operator label does not authenticate identity or consent.
