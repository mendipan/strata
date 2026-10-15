# Execution adapter authoring

This guide starts an adapter for the separately approved [execution/1 contract](EXECUTION_CONTRACT.md). It adds no architecture: the schemas, guarded client, synthetic fixture and lifecycle rules are already accepted there and in [agent-execution.ts](../../src/agent-execution.ts). Discovery authoring stays in [ADAPTER_AUTHORING](ADAPTER_AUTHORING.md); discovery declarations, consent or feature advertisements never qualify an execution adapter, and a model completion API alone is ineligible.

## The two ports

An adapter implements `AgentExecutionAdapterV1` (`describe`, `submit`, `status`, `result`, `cancel`) exactly as [EXECUTION_CONTRACT](EXECUTION_CONTRACT.md) requires: `describe()` is a pure declaration with zero provider calls, one explicit admission per `submit`, one bounded observation per `status`, immutable digest-bound results and cooperative cancellation. The declaration is a claim to qualify, not proof; declaring `runtime.kind=agent-runtime` earns no compatibility status, and a compatible patch that changes the canonical declaration digest requires reviewed target approval again.

The host side implements `AgentExecutionAccess.current()`, the trusted local metadata port of contract §3. It is never authentication from request JSON: a real port checks the operation's durable admission, current owner, saved execution consent, exact selected source and repository revision, target identity, and the current session and credential generations, then returns a strict grant or refuses. Never deserialize a grant from browser or provider JSON, and never migrate discovery consent into execution consent.

Always drive adapters through [AgentExecutionClient](../../src/agent-execution-client.ts). The guarded client validates strict shapes, bounds each call, reads authority before and after every operation and sanitizes failures; adapters called directly bypass those guards.

## Starter

[execution-starter.ts](../../examples/agents/execution-starter.ts) is a compile-time template. It declares a schema-valid declaration, registers by import in a plain record (no plugin loader, dynamic import or vendor registry) and deliberately refuses every operation with `EXECUTION_UNCONFIGURED` because no native runtime, journal or consent store is wired. The host port is equally explicit: `unconfiguredExecutionAccess` returns no grant, so the guarded client refuses with `EXECUTION_AUTH` before any dispatch. Replace the refusal bodies and the access port together; never ship half of this pairing and never fake a grant to make the demonstration pass. After `npm run build`:

```text
node dist/examples/agents/execution-starter.js
```

## Offline conformance kit

[agent-execution-kit.ts](../../tests/fixtures/agent-execution-kit.ts) wraps any adapter in a scriptable failure driver (`ScriptedKitAdapter`) and drives the accepted offline lifecycle through a controlled access fixture and clock. [agent-execution-conformance.ts](../../scripts/agent-execution-conformance.ts) replays the scenarios and returns a receipt with static failure text, never raw fixture exceptions:

```text
node dist/scripts/agent-execution-conformance.js
node --import ./tests/no-external-fetch.mjs --test dist/tests/agent-execution-kit.test.js
```

A second adapter supplies a subject and reuses the whole kit; `create` returns `{adapter, advance}`, keeping the `advance(ref, state)` test controller separate from the production adapter port that drives the real runtime fixture to each lifecycle state, mirroring the [synthetic fixture](../../tests/fixtures/agent-execution.ts):

```ts
import { checkAgentExecutionKit } from '../../scripts/agent-execution-conformance.js';
const receipt = await checkAgentExecutionKit({
  name: 'my-agent', task, shared: () => myJournal, starts: j => j.starts,
  create: j => ({ adapter: new MyAdapter(j), advance: (ref, state) => myFixture.advance(j, ref, state) }),
});
if (receipt.failures) throw new Error(receipt.checks.filter(c => !c.ok).map(c => c.name).join(', '));
```

| Scenario | Contract section |
| --- | --- |
| lifecycle-status-result-digest | §5 operations, snapshots, digest-bound result |
| idempotent-resubmit-and-payload-conflict | §4 durable admission and conflict |
| adapter-reconstruction-preserves-identity | §4 journal retention across adapter restart |
| lost-submit-response-recovers-by-status | §4 and §6 uncertain dispatch, recovery lookup |
| pre-dispatch-refusals | §2 and §3 capability, version, binding, expiry, consent |
| authority-generation-flips-reject-late-success | §3 generation invalidation of late responses |
| abort-discipline | §5 local abort stops waiting only |
| call-deadline | §5 bounded control call |
| cooperative-cancellation-race | §5 cooperative cancel, terminal immutability |
| transition-and-binding-discipline | §5 snapshot transitions and task binding |
| fail-closed-results | §5 and §6 substitution, trust and output refusal |
| grant-tamper-isolation | §3 sealed grant facts |

## What the kit does not establish

The kit is synthetic and offline: no credentials, network, provider SDK, model call or child process, and the in-memory journal cannot prove process-crash durability, real runtime limits, verified remote identity, transport or host admission (contract §9 and [the fixture](../../tests/fixtures/agent-execution.ts)). Passing it establishes compatibility with the offline contract shape only. A real adapter must additionally reserve `(connection_id, task_id)` durably before any native start (§4), cap raw bytes before parsing and enforce native work, output and storage limits (§5), and keep raw exceptions, bodies, headers, URLs, prompts and credentials out of persisted errors (§6). Runtime qualification, target activation and independent review remain separate approved stages.
