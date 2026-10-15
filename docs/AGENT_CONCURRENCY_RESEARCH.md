# Agent concurrency and intent coordination

Git supports parallel development through immutable objects, separate worktrees and explicit merges. Strata explores coordination above the code history: exact owned proposals, declared dependencies, semantic conflicts and reviewed intent that survives a Release. Storage throughput and semantic correctness are different questions.

## Boundaries to measure

| Problem | Strata mechanism | Limit |
| --- | --- | --- |
| Concurrent actors overwrite shared state | Private owned drafts and immutable published revisions | Fixture principals do not authenticate hostile callers. |
| Related changes appear independent at file level | Declared dependencies, requirements, assumptions and scenario checks | Undeclared interactions and arbitrary prose compatibility are not discovered automatically. |
| A decision loses its context | Exact considered set, baseline, scenario and authorized Resolution | Hashes preserve captured context; they cannot make a mistaken requirement correct. |
| Tests pass for different output | Candidate/profile/output-bound evidence and fresh Release gates | Fixture reviews are not independent execution attestation. |
| Later work loses rationale | Durable intent, source traces, decisions and Release provenance | Preservation does not prove a fresh reader understands it. |
| High write volume stalls publication | Immutable staging outside a short publication transaction | Registry updates and some operations remain serialized; this is not lock-free storage. |

Read the [implemented contract](IMPLEMENTED_CONTRACT.md), [profile boundary](PROFILE_SEPARATION.md), [trust plan](SECURITY_TRUST_PLAN.md) and [agent onboarding contract](AGENT_ONBOARDING_PLAN.md) before treating a model property as an implemented guarantee.

## Evaluation design

Compare matched task sets, models, context budgets, acceptance tests and review authority. Measure accepted coherent outcomes, repair/review effort, source-context retrieval, stale-dependency mistakes and rationale recovery. Report cost, latency and failed/abandoned attempts; record infrastructure throughput separately.

Include a peer changing revision after a dependent read, a new baseline, a late conflicting proposal, stale evidence and a fresh-session handoff. Test whether the reader can explain accepted/rejected alternatives and remaining uncertainty, not just reproduce hashes. A useful negative result is unchanged quality with more modeling/review effort.

Run deterministic core/CLI and local SDK checks using [verification](VERIFICATION.md). The stress harness submits scripted storage jobs; it does not run autonomous model teams or prove a productivity advantage over Git. Runtime spans cannot alone establish CPU parallelism or reasoning quality.

## Primary background sources

- [Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects), [worktrees](https://git-scm.com/docs/git-worktree), [merge](https://git-scm.com/docs/git-merge), [reference updates](https://git-scm.com/docs/git-update-ref) and [lockfile API](https://git-scm.com/docs/api-lockfile).
- [Partial clone](https://git-scm.com/docs/partial-clone) and [protocol v2](https://git-scm.com/docs/protocol-v2) address transport/storage concerns separately from semantic review.
- [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) and [state API](https://developers.cloudflare.com/durable-objects/api/state/) describe the runtime substrate; Strata's own publication contract still requires testing.
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) studies position-sensitive retrieval in the evaluated language models; it is not a verdict on current models or proof of a Strata advantage.
