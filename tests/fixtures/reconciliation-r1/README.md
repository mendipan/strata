# Synthetic R1 completion fixtures

[fixtures.ts](fixtures.ts) generates deterministic in-memory source-binding, Git plan/stage/application-observation, drift proposal/review and candidate completion packets. The named criteria are literal test data. All identities, SHA/OID inputs, source bytes, checker labels and observations are synthetic; the generator never runs an application, Git operation, runner or provider.

The positive control retains a failed named application observation in an approved revalidation plan and supplies a distinct passing packet with the same source and acceptance contract. Separate controls preserve imported trust, explicit review labels and a synthetic validated Release created through the existing imported fixture seams. The standalone lifecycle criterion is explicitly selected as its own obligation alongside the expiry requirement. [The focused test](../../reconciliation-completion-r1.test.ts) consumes the named negative mutations, re-signing changed evidence when needed so stale hashes do not mask semantic refusals.

These fixtures establish contract validation only. Their observations are not independent proof that a new test execution occurred. They grant no source write, current authority, owner-commit acceptance, successor binding or runtime reconciliation completion.

The semantic predecessor mutations reproduce the independent review finding with receipt and expectation bytes unchanged. Paired controls retain a validated Release and published synthetic Layer; mutations cover changed bootstrap/Layer behavior and frozen scenarios, cross-model substitutions, unknown fields and changed record identities. The generator remains entirely in-memory.
