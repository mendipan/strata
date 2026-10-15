# Studio agent enablement: isolated implementation ledger

Historical implementation/review packet. For current native acceptance, packaged identity limits and post-launch Profile → Build scope, see [Studio status](../studio/STATUS.md) and [roadmap](../ROADMAP.md). Counts and rollout prerequisites below describe their original slice.

Owner authorization: implement the agreed plan in an isolated worktree, then review and merge later. Build and local qualification only. No push, merge, deployment, paid/provider calls, live credential reads or live access changes.

Base: `a9d7186`, the reviewed Windows custody integration tip. Main at kickoff: `c722c7a`. Base dependencies include the reviewed admission core, local execution storage, Windows custody verifier and platform mapping documents. Their commits must be identified separately in the review packet. Preserve all other worktrees and active Studio testing, checklist hosting/archive and source-capture work.

## Intended browser workflow

Settings -> Add agent -> Cloudflare Workers AI or pair a portable local Codex runner -> approve exact project context and usage -> chat with one agent per conversation -> Prepare draft -> inspect the exact proposal -> Save as draft -> reopen the owner draft. Agents cannot publish, accept intent, approve or create Releases. Saved drafts belong to the authenticated user with agent provenance.

Cloudflare setup creates a dedicated service from Settings after a concrete deployment preview. The local runner pairs outward with a short-lived one-use code and launches a dedicated app-server over stdio, never controlling existing Codex chats. Claude uses the same runner seam afterward.

## Implementation phases and ownership

1. Shared strict schemas, provider registry, protected connection/consent/conversation state, independent encrypted agent credentials, durable original-ID receipts and bounded output retrieval. Preserve legacy discovery and credential formats.
2. Owner APIs and namespace host composition. Resolve current owner/source/repository binding; synchronously invalidate on source/auth/consent changes. Explicit setup provisions state; startup never resets it.
3. Cloudflare service and browser provisioning adapter. Dedicated Agent Durable Object, Workers AI binding, independently verified service identity, exact packaged deployment and partial-outcome receipts. No provider request runs during this task.
4. Portable runner pairing, authenticated outward transport, supervised Codex stdio bridge and separate local authentication. Pin protocol/runtime capabilities; retain uncertain IDs and refuse resubmission. Restrict tools to supplied project context/proposals. Claude follow-on adapter uses the same boundaries.
5. Settings and Agent workspace with history, progress, Stop, receipt inspection and structured proposal preview/save. Keep state server-side; browser storage only retains unresolved nonsecret IDs. Save uses existing owner draft operations and a server-verified preview/context digest.
6. Focused qualification, regression/browser checks and review handoff. Real provider/runtime/platform verification remains separately labeled and requires later authorized activation.

Files: new modules under `src/studio-agents/`, runner/build scripts, dedicated Worker config, matching tests, `explorer/agent-workspace.js` and agent setup module. Shared integration changes are limited to `scripts/studio-host.ts`, namespace/owner/host composition and existing browser navigation/settings. No semantic engine/schema changes without a concrete necessity recorded here.

## Acceptance

- Owner-only configuration and fresh confirmation for credential, pairing, consent and deployment actions. Credentials never appear in metadata/logs/browser storage.
- Two providers follow the same connection/conversation/proposal flow; no hardcoded machine, automatic provider fallback or multi-agent orchestration.
- One original ID per action/turn, persisted before dispatch. Duplicate, lost response, navigation, restart and reconnect cannot trigger duplicate work. Interrupted/uncertain outcomes remain inspectable.
- Context and transcripts bind exact owner, installation, repository, model, immutable source revision and baseline. Source switches/revocation discard late results and prevent cross-project access.
- Malformed/stale/altered proposals refuse; explicit Save creates an owner draft with agent provenance and ordinary review/Release gates.
- Cloudflare provisioning preview identifies resources, account, model, limits, code digest and permissions; deployment and inference are separate confirmations.
- Build/typecheck, focused auth/state/provider/runner/proposal tests, existing Settings/namespace/draft regressions, browser keyboard/mobile/reload and no-external-fetch checks pass. Worker dry-run packaging passes.
- Report synthetic, local process, native protocol, deployed identity, live inference and billing evidence independently. Never label unqualified runtime guarantees as ready.

## Ledger

- [x] Refreshed main/worktree/active-chat state; no owner changes.
- [x] Created managed isolated worktree from reviewed `a9d7186`.
- [x] Saved agreed plan before implementation.
- [x] Shared state/protocol and auth
- [x] Host/namespace integration
- [x] Cloudflare service/provisioning
- [x] Portable Codex runner
- [x] Browser setup/chat/proposal delivery
- [x] Claude follow-on adapter
- [x] Focused and browser verification
- [x] Review packet and dependency manifest

Rollback: roll back the added code/routes; the namespace seam is enabled by default and removing an optional override does not disable it. preserve all agent state, receipts, credentials and consent. Code rollback must retain a reader compatible with any saved new state. Cloud resources are not removed by disconnect/revoke.

## Candidate completion

Implementation is complete for isolated review. See [review packet](STUDIO_ENABLEMENT_REVIEW.md) for dependencies, deployment artifact requirements, overlapping Studio fixes and qualification evidence. This is an intent chat/proposal contract, not an execution/1 Git-pin implementation. Legacy readiness remains unchanged.

Final local evidence: 32 focused tests, 113 existing backend regressions, 11 Edge agent workflow checks, 27 legacy Settings browser checks, 25 legacy recovery browser checks, and 5 local Worker checks passed. One older Settings-loading assertion failed identically against the unchanged base assets (47 other checks passed). Root and Worker typechecks, build and dry-run packaging passed. Provider/runtime/billing activation remains unqualified and is outside this authorized local candidate.

Native Windows custody was exercised against disposable owner-only nested files and broad-access/hardlink refusals. Dedicated native agent authentication, tool confinement, model availability and provider cancellation are not established by synthetic ports. No real credential, native model, deployment, live source write, commit, push or merge was performed.
