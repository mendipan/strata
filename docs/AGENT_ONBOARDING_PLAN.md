# Agent onboarding contract

## Studio Settings and adapter roadmap

[Settings architecture](studio/SETTINGS_ARCHITECTURE.md) adds owner-managed approved sources and a platform-neutral discovery adapter plan. [Connection management](studio/CONNECTION_MANAGEMENT.md) describes the synthetic implementation and its separate launcher/review gates. Existing owner, actor, provider and engine authorities remain distinct.

Cloudflare is the first reference adapter; it is not a connected service. The owner shortlist for later evaluated adapters is Codex, Claude, Cursor, zcode, Grok and optional Google, toward roughly five adapters with a flexible count. Candidates need exact runtime/API/auth, non-executing discovery, conformance evidence and a separate authorized deployment. Protocol similarity or SDK installation establishes no compatibility. Agent execution/chat is a later explicitly scoped lifecycle.

| Milestone | State | Next gate |
| --- | --- | --- |
| Durable source budget | Published dc061af | Preserve grant lineage through manager integration |
| Approved source manager, Studio/CLI parity | Synthetic implementation | Immutable review, launcher integration and full regression |
| Platform-neutral discovery/reference/toolkit | Staged synthetic work | Auth/binding/bounds conformance; no inference |
| Real Cloudflare service | Unconfigured | Exact existing service/class/instance and supported auth |
| Additional candidate adapters | Roadmap | One supported surface and evidence-backed adapter at a time |

## Existing assigned-agent workflow

The portable [agent skill](../agent/strata/SKILL.md) and [CLI session](../examples/agent-session.json) teach an existing agent framework to read Strata intent and prepare owned proposals. The host supplies the assignment, principal, exact baseline/references and granted scope. Strata does not launch agents as part of ordinary CLI commands.

1. Inspect CLI version/capabilities, status and the assigned pinned baseline. Distinguish discovery from permission.
2. Read relevant Blocks, acceptance criteria, authorities, published peer revisions and supported profiles. Bound reads to the task; record missing or unsupported context.
3. Author only the assigned Layer with exact dependencies, preconditions, assumptions and source traces. Publish only when the current owner and review gates allow it.
4. Compose explicit revisions. Explain conflicts and propose a decision-only Layer; hand off exact payloads to the host's authorized selector when endorsements are absent.
5. Materialize a supported candidate, execute the owned fixture checks and import exact candidate/profile/output-bound evidence. Missing, failed and stale evidence remain distinct.
6. Obtain separate scope, guardian and Release endorsements. Inspect the resulting immutable Release and verify inheritance in a fresh Composition.

Fixture handles simulate principals; they are not production authentication. Code-configured task scope and operation permissions are enforced by the shared issuer. The skill grants no account access, deployment permission, model budget or approval role. Hosted identity and independent execution attestation remain unsupported. See [trust design](SECURITY_TRUST_PLAN.md) and [implemented contract](IMPLEMENTED_CONTRACT.md).

Run `npm run test:onboarding` after building for deterministic CLI/API acceptance. It exercises owner refusal, decisions, measured output, Release and inheritance; it does not establish fresh-model comprehension or token usage. The agent acceptance and onboarding tests retain positive, refusal and failure-recovery coverage. Keep run transcripts and environment-specific manifests under ignored local state or outside the checkout.
