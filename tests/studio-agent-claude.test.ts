import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ClaudeChatBridge,
  CLAUDE_SDK_VERSION,
  type ClaudeSdkPort,
} from "../src/studio-agents/claude.js";
import {
  AgentHubError,
  type TurnRequest,
} from "../src/studio-agents/protocol.js";
import {
  studioAgentHubFixture,
  fixtureLimits,
} from "./studio-agent-hub-fixture.js";
import { digest } from "../src/model.js";
test("synthetic Claude bridge disables all tools and freezes original-ID output", async () => {
  const f = await studioAgentHubFixture();
  await f.action({ action: "initialize" });
  const snapshots = path.join(f.directory, "snapshots");
  await mkdir(snapshots);
  let calls = 0,
    options: Record<string, unknown> = {};
  const sdk: ClaudeSdkPort = {
    version: CLAUDE_SDK_VERSION,
    query(input) {
      calls++;
      options = input.options;
      const messages = async function* () {
        yield { type: "system", session_id: "synthetic-session" };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Intent retained." }] },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "synthetic-session",
          result: "Intent retained.",
        };
      };
      return Object.assign(messages(), { async interrupt() {} });
    },
  };
  const request: TurnRequest = {
      format: "strata-agent-chat/1",
      task_id: randomUUID(),
      conversation_id: randomUUID(),
      connection_id: randomUUID(),
      connection_generation: 1,
      kind: "chat",
      context: f.context,
      context_sha256: digest(f.context),
      model: "fixture-claude",
      limits: fixtureLimits,
      messages: [{ role: "user", text: "Explain" }],
    },
    bridge = new ClaudeChatBridge(
      sdk,
      f.state,
      snapshots,
      async () => "public-synthetic-anthropic-key",
    );
  assert.equal(
    (await bridge.run(request, async () => {}, AbortSignal.timeout(5000))).text,
    "Intent retained.",
  );
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(
    (await bridge.run(request, async () => {}, AbortSignal.timeout(5000)))
      .state,
    "succeeded",
  );
  assert.equal(calls, 1);
});
test("Claude version mismatch refuses before credential access or native query", async () => {
  const f = await studioAgentHubFixture();
  assert.throws(
    () =>
      new ClaudeChatBridge(
        {
          version: "unqualified",
          query() {
            throw Error("must not query");
          },
        },
        f.state,
        f.directory,
        async () => {
          throw Error("must not load credential");
        },
      ),
    (e) => e instanceof AgentHubError && e.code === "AGENT_UNCONFIGURED",
  );
});
