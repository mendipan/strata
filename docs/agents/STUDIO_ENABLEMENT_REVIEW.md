# Studio agent configuration candidate

Historical implementation/review packet. For current native acceptance, packaged identity limits and post-launch Profile → Build scope, see [Studio status](../studio/STATUS.md) and [roadmap](../ROADMAP.md). Counts and rollout prerequisites below describe their original slice.

Review branch: `codex/studio-agent-enablement`, in the attached isolated worktree. The implementation is staged for review without a commit, push, merge or deployment. Existing credentials and ongoing worktrees are untouched.

The missing pieces were the protected connection store, explicit context consent, a consumer for configured agents, and a path from agent output to an ordinary owned draft. The legacy Settings adapter describes discovery readiness and cannot provide that workflow. This candidate adds a separate owner chat API and browser workspace while preserving that adapter's contracts.

## What is implemented

- Namespace hosts expose agent setup metadata by default. Opening Settings does not provision storage or contact a model. **Initialize agent storage** is explicit. The private directory is a disjoint sibling of owner state, named from sealed installation/owner identity; an optional `studio_agents` host configuration overrides its directory and bundle path.
- Cloudflare setup stores a separate encrypted deployment token, previews the exact packaged Worker, account, model, resources and limits, then requires **Deploy this agent service**. The dedicated Agent Durable Object supports chat progress and structured proposals. Signed service identity is pinned independently before use. Partial deployment inspection does not upload again or revive revoked connections.
- A portable local runner pairs outward with a one-use code. Codex uses a dedicated stdio app-server and private home; Claude uses a pinned SDK and a separate encrypted local API key. The existing desktop CLI/home/chats are not used.
- Agent offers one agent per conversation, explicit project consent, history, bounded progress reads, Stop, proposal preparation, readable Before/After previews and explicit **Save as draft**. The existing namespace draft operation resolves the current author and retains agent provenance separately.
- Owner and project request tokens are independently checked. Output never supplies identity, grants, approval, publication or Release authority. Proposals change existing purpose/requirements only; they may return questions without changes. Questions block Save.
- Original IDs are reserved before dispatch. Navigation, lost replies, restart, cancellation and source switches never trigger a new inference under that ID. Recovery reads original native/service/draft receipts. **Keep unresolved and continue** releases the browser wait for independent work while retaining the original server receipt; it never retries that action. Settings lists these unresolved originals for later inspection. An unclaimed local turn interrupted by restart is confirmed as never started. Already dispatched uncertain work stays unresolved when original evidence is unavailable.

## Contract decision

The reviewed `strata-agent-execution/1` contract requires a verified Git commit. Studio's namespace port exposes immutable intent records, not a verified Git pin. This candidate therefore uses **`strata-agent-chat/1`** with an exact intent snapshot, baseline digest and untrusted proposal output. It does not turn an intent digest into a Git SHA or advertise legacy execution readiness. Ordinary review and Release gates remain in force.

Bounds are deliberate: 32 connections/runners, 64 conversations, 256 retained turns, 1,024 operation receipts, 64 KiB request/output budgets, one unresolved turn per conversation and four unresolved turns per connection. Admissions count toward the rolling daily limit even when work fails. Full journals fail closed; they are never reset to replenish IDs. A future retention/removal workflow must preserve original-ID safety. Workers AI receives its token cap; native hard token/billing limits remain unqualified.

## Dependencies and overlap

Base: `a9d71868f6e771473ead7b9c28469106abb139a8`. Main at kickoff was `c722c7a5d5feaedb8488008a1c3f10d5514d1251`. The seven base dependency commits are:

| Commit | Existing dependency |
| --- | --- |
| `1e68627` | Admission and recovery core |
| `cf719db` | Authority seals and observations |
| `7285ffb` | Missing-marker corruption refusal |
| `5dc0143` | Reviewed Claude mapping |
| `6a90589` | Protected local journal storage |
| `0538b01` | Reviewed Cursor mapping documentation |
| `a9d7186` | Native Windows journal custody verifier |

Those dependencies are distinct from this feature. New code reuses local storage and the read-only Windows metadata query; it adds a bounded custody inventory for nested agent files without changing the existing verifier.

During implementation, the other Studio fixes chat reported its code merged and deployed as `7ab7bf29a3c76adb2be698acb9df49df00c66864`. The local main SHA was independently read at that revision; its live deployment was not inspected here. Main had an unrelated untracked `.local/` directory, which was preserved. Later integration must retain **operation-recovery** imports/context in `explorer/app.js`, its module in the host allowlist, and the confirmed fixes in the shared nginx example. This branch's shared changes are additive; do not replace these files wholesale with the candidate copies.

## Qualification evidence

Commands run from the isolated worktree:

```powershell
npm ci --offline --ignore-scripts
npm run typecheck
npm run build
node node_modules/typescript/bin/tsc --project tsconfig.studio-agent.json --noEmit
node scripts/package-studio-agent-runner.mjs
node scripts/build-studio-agent.mjs
node --import ./tests/no-external-fetch.mjs tests/studio-agent-worker-local.mjs
```

Final results: **32 focused tests**, **113 existing backend regressions**, **11 Edge agent workflow checks**, and **5 local Worker checks** passed; both typechecks, the build and dry-run packaging passed. Full local logs are in the ignored `.strata/agent-enablement-evidence/` directory. Synthetic credentials, private fixture state and temporary browser profiles are excluded from Git.

| Check | Evidence boundary |
| --- | --- |
| Focused agent suites | 32 passed. Real files, owner HTTP, namespace draft operation and native Windows custody; synthetic model/provider/native agent ports |
| Existing regression suites | 113 passed. Settings, namespace/control/import/mode, draft recovery, local execution storage and Windows custody |
| Edge agent workflow | 11 passed. Real owner sessions, proposal save/readback, progress, reload and 320 px layout; intercepted HTTPS and synthetic runner output |
| Legacy agent Settings browser | 27 checks passed |
| Legacy recovery browser | 25 checks passed |
| Settings loading browser | 47 checks passed; one existing assertion mismatch reproduced with untouched `a9d7186` assets |
| Worker local runtime | Five checks: auth before SDK routing, blocked RPC/websocket surfaces, metadata without initialization, explicit idempotent genesis and independently verified signature; outbound transport denied |
| Worker and runner packages | Local build/dry run; no deployment |

The existing Settings assertion expects no project reads on direct Settings entry. The reviewed base hydrates a selected project there. The same assertion failed with the untouched base assets; it is recorded rather than changing another task's behavior or weakening its test.

No real provider credentials were read, no model turn was executed, and no Cloudflare deployment or live repository write occurred. Native Codex 0.162.1 and Claude SDK/CLI authentication, confinement, cancellation and original-session recovery require attended qualification. The installed Codex version inspected during planning was 0.160.1 and was preserved. Windows custody has native fixture evidence; Linux deployment/runtime behavior is not qualified by the Windows tests. A signature and bundle digest establish identity/content binding, not execution efficacy or billing guarantees.

## Review and activation sequence

1. Review this staged diff and dependency stack, then integrate in an isolated candidate based on current main while preserving the overlapping Studio fixes. Re-run the focused/browser checks on that combined candidate.
2. Package the compiled server modules, two new browser modules/style rules, `dist/studio-agent-worker/worker.mjs`, and `dist/studio-agent-runner.zip`. Existing deployment tools use fixed file inventories and must be updated to include these artifacts. The nginx example adds bounded agent bodies and longer deployment-response waits; apply reviewed ingress changes separately.
3. Qualify protected state on the target Linux host and the fixed native runtimes on a disposable agent machine, including tool refusal, Unicode/large output, cancellation and lost-reply original-ID recovery. Do not borrow existing credentials or chats.
4. After review and authorization, deploy the application candidate. In the website: **Settings → Agent service → Initialize storage → preview and confirm Cloudflare deployment**, or **choose local runtime → download runner → one-time attended pairing → refresh status → add paired agent**. Then **Agent → approve project context → start conversation → chat → Prepare draft → inspect preview → Save as draft**.
5. Treat live service identity, inference, draft receipt, provider cleanup and billing as separate activation evidence. Stop remains a request until the provider confirms an outcome. Disconnect/revoke blocks future Studio work and rejects late results; it does not delete cloud resources or prove running provider work stopped.

Rollback is a code/route rollback with all private agent files and original-ID receipts retained. Removing the optional host override alone does not disable the default namespace seam. No cleanup, ACL rewrite, journal reset or provider retry belongs to rollback without a separate reviewed action.

## Local build artifacts

Worker SHA-256: `1b32761ed81a05d8a222c5772721f8bbc5c83713c0219032fe5b12576a951a85`. Runner ZIP SHA-256: `4d9c3beec6a8f8f3cdea9054975ad23f442239d98f5b3c6f333b1f70722f0dd1`. The ZIP contains the bundled runner, attended installer, README, exact SDK manifest and lockfile. The archive was read independently with the Windows ZIP implementation. These hashes identify local artifacts, not a deployed service or qualified native execution.

Historical browser receipts and integration coordination remain private. For current scope, see [Studio status](../studio/STATUS.md).

Conversation views project the last user message per turn and keep the immutable context once, avoiding repeated context/transcript expansion. The view is bounded to 3 MiB. Saved draft references link to ordinary Review and confirmed save generations update the browser connection. Runner dispatch and late output additionally check the protected owner/namespace selection and policy before proceeding.
