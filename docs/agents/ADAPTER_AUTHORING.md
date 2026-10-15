# Discovery adapter authoring

For agent task execution, use the separate [execution/1 contract](EXECUTION_CONTRACT.md). This guide and discovery-v1 remain discovery-only; execution has its own declaration, approval, port and fixtures. Model APIs and feature advertisements cannot qualify an execution adapter.

The versioned port in [agent-discovery.ts](../../src/agent-discovery.ts) separates pure adapter declarations, an operator-approved exact target, server-only authentication and one bounded discovery probe. [Cloudflare reference](../../src/agent-adapters/cloudflare.ts) implements a new application protocol, not a built-in Agents SDK discovery endpoint. It imports no model/task/tool or fixture engine.

Implement `AgentDiscoveryAdapterV1`: `describe()` is pure; `probe(context, signal)` makes exactly one approved GET. Use the strict schemas, independent verified identity, exact service/instance/project/model/repository/declaration binding, 32 KiB response, ten-second total deadline, five-minute maximum manifest lifetime and no redirect/retry/fallback. Authentication must come from the actual supported service integration. A self-asserted response subject, HTTPS 200 or SDK installation is insufficient. No Artifacts token or owner password reuse.

The [starter](../../examples/agents/cloudflare-discovery-starter.ts) accepts an injected verified authorization integration and mounts only a positive discovery route in an already approved service. It does not deploy a Worker or instantiate an Agent. Auth runs before feature projection. The existing local `FixtureIssuer` Worker remains unchanged and cannot serve as hosted authority.

Run the synthetic conformance harness after building:

```text
node dist/scripts/agent-adapter-conformance.js
node --test dist/tests/agent-adapter-conformance.test.js
```

Contributors can call `checkAgentAdapter(adapter)` with their compile-time adapter. All transports/auth responses are synthetic. The runner checks exact one-GET dispatch, hostile feature advertisements, binding/version/shape/time/auth refusal, routing, redirects, bounds and cancellation. It establishes synthetic discovery compatibility only. Discovery projections keep engine authority unconfigured and authoring/execution/chat false; real engine capabilities require a separately trusted authoritative port and do not arise from advertisements.

Declarations must state exact adapter/runtime/protocol versions, authentication requirements, binding support, bounds and unsupported features. Submit source, synthetic fixtures, conformance receipt and a [compatibility](COMPATIBILITY.md) update. Independently reviewed deployment/auth evidence is required before advancing to deployment-verified. Do not download executable adapters, expose arbitrary browser URLs/RPC/header fields or add task APIs to this protocol.

## Current implementation boundary

The toolkit, pure reference handler and [connection lifecycle](CONNECTION_LIFECYCLE.md) are implemented, including rate/CAS/receipt controls. [Settings integration](SETTINGS_INTEGRATION.md) exposes owner routes, CLI and UI through an optional trusted manager; [persistent consent](PERSISTENT_CONNECTIONS.md) adds saved consent/intent, Retry/Revoke and a host factory. Their evidence is synthetic. Ordinary hosted startup leaves the manager and actual protected target/auth unconfigured, with actions disabled. Real service provisioning, independently verified authentication and adapter deployment qualification remain separate prerequisites. Persistent consent does not establish a perpetual healthy connection or service-session renewal. No inference or credential migration is part of this discovery integration.
