import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../src/core.js";
import { writePrivate } from "../src/explorer/owner-files.js";
import { digest, MODEL } from "../src/model.js";
import { AgentHubState } from "../src/studio-agents/state.js";
import { AgentVault } from "../src/studio-agents/vault.js";
import {
  StudioAgentHub,
  type AgentAuthority,
  type AgentRuntime,
  type AgentProjectPort,
} from "../src/studio-agents/hub.js";
import { default as assert } from "node:assert/strict";
import type { AgentContext } from "../src/studio-agents/protocol.js";
export const fixtureLimits = {
  turns_per_day: 20,
  runtime_ms: 120000,
  output_bytes: 65536,
  max_output_tokens: 2048,
};
/** Synthetic custody/native ports only. Uses real private files and transactions. */
export async function studioAgentHubFixture(
  runtime?: AgentRuntime,
  dispatchFence?: (context: AgentContext, generation: number) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "strata-agent-hub-")),
    owner_id = randomUUID(),
    installation_id = randomUUID();
  let live = true,
    now = Date.now();
  const authority: AgentAuthority = {
    owner_id,
    installation_id,
    authentication_generation: 1,
    assertLive() {
      assert.ok(live, "synthetic owner live");
    },
    async refresh() {
      this.assertLive();
    },
  };
  const state = new AgentHubState(
      path.join(directory, "agents"),
      installation_id,
      owner_id,
      { assertWindowsCustody: async () => {} },
    ),
    vault = new AgentVault(
      path.join(directory, "agents", "vault"),
      path.join(directory, "agents", "key.bin"),
    );
  const context: AgentContext = {
    binding: {
      project_id: "p",
      model_version: MODEL,
      repository_id: "immutable-repository-1",
    },
    baseline: "R0@1",
    baseline_sha256: digest("baseline"),
    generation: digest("generation"),
    policy: "policy-1",
    principal_id: "owner",
    selection_epoch: 1,
    snapshot_metadata: {
      id: "R0",
      revision: 1,
      root: "root",
      authorities: { scopes: [], release: [], guardians: [] },
      deleted_ids: [],
    },
    blocks: {
      root: {
        id: "root",
        parent: null,
        purpose: "Before",
        requirements: {},
        acceptance: {},
        relationships: {},
        contract: { inputs: {}, outputs: {}, failures: {} },
      },
    },
  };
  const engine = new Engine({}, {}, { projectId: "p", modelVersion: MODEL });
  engine.init(
    {
      ...context.snapshot_metadata,
      model_version: MODEL,
      blocks: context.blocks,
    },
    "bootstrap",
  );
  context.baseline_sha256 = digest(engine.records[context.baseline].data);
  const saves: unknown[] = [];
  const project: AgentProjectPort = {
    async context(baseline) {
      assert.equal(baseline, context.baseline);
      return structuredClone(context);
    },
    async inspectSave(id) {
      const saved = saves.find((s: any) => s.id === id) as any;
      if (!saved) return { committed: false, result: null, draft_sha256: null };
      return {
        committed: true,
        draft_sha256: digest(saved.draft),
        result: { ref: saved.draft.id + "@1" },
      };
    },
    async save(draft, id, c) {
      const saved = engine.layer(draft, c.principal_id);
      saves.push({ draft, id, c });
      await writePrivate(path.join(directory, "saved-" + id + ".json"), {
        result: saved,
        record: engine.records[saved.ref],
      });
      return saved;
    },
  };
  const calls = { start: 0, inspect: 0, cancel: 0 },
    fake: AgentRuntime = runtime ?? {
      async start() {
        calls.start++;
      },
      async inspect() {
        calls.inspect++;
        return {};
      },
      async cancel() {
        calls.cancel++;
      },
    };
  const hub = new StudioAgentHub(
    state,
    vault,
    fake,
    undefined,
    () => now,
    dispatchFence,
  );
  const action = (body: Record<string, unknown>) =>
    hub.action(authority, project, { request_id: randomUUID(), ...body });
  async function connect(explicitConsent = true) {
    await action({ action: "initialize" });
    const pair: any = (await action({ action: "pair", runtime: "codex" }))
      .result;
    const runner = await hub.pair({
      pairing_id: pair.pairing_id,
      code: pair.code,
      label: "Synthetic Codex",
      runtime: "codex",
      version: "synthetic",
    });
    await hub.poll(runner.runner_id, runner.token, true, false, ["fixture-model"]);
    const added: any = (
      await action({
        action: "add-runner",
        runner_id: runner.runner_id,
        label: "Synthetic agent",
        model: "fixture-model",
        limits: fixtureLimits,
      })
    ).result;
    if (explicitConsent) await action({
      action: "consent",
      connection_id: added.id,
      generation: 1,
      baseline: context.baseline,
      context: "selected-intent",
      retention: "until-removed",
      limits: fixtureLimits,
    });
    const conversation: any = (
      await action({
        action: "conversation",
        connection_id: added.id,
        baseline: context.baseline,
        title: "Synthetic conversation",
      })
    ).result;
    return { runner, connection: added, conversation };
  }
  return {
    directory,
    authority,
    state,
    vault,
    context,
    project,
    hub,
    calls,
    saves,
    action,
    connect,
    setLive: (value: boolean) => (live = value),
    advance: (ms: number) => (now += ms),
  };
}
