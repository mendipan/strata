import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { namespaceFixture } from "./namespace-fixture.js";
import { createWindowsCustodyFixture } from "./fixtures/windows-execution-custody.js";
import { digest } from "../src/model.js";
import { fixtureLimits } from "./studio-agent-hub-fixture.js";

test(
  "real namespace composition saves an explicit agent proposal through the owner draft operation",
  { skip: process.platform !== "win32" && process.getuid?.() !== 0 },
  async (t) => {
    const f = await namespaceFixture();
    t.after(() => f.server.close());
    await f.prepare();
    const created = await f.action("create", {
      name: "agent-project",
      purpose: "Before",
    });
    assert.equal(created.status, 200, created.text);
    const headers = { "x-strata-repository": created.data.projects[0].id };
    const actor = await f.b.send("/studio/actor/session", "POST", {}, f.csrf);
    assert.equal(actor.status, 200, actor.text);
    (headers as Record<string, string>)["x-studio-actor-csrf"] =
      actor.data.csrf;
    const root = path.join(
      path.dirname(f.base.state.config.state_directory),
      "studio-agents-" +
        digest({
          installation: f.policy.installation_id,
          owner: f.policy.owner_id,
        }).slice(0, 24),
    );
    if (process.platform === "win32")
      createWindowsCustodyFixture(f.base.root, root);
    const ownerAction = async (body: Record<string, unknown>) => {
      const r = await f.b.send(
        "/studio/v1/owner/agent-connections",
        "POST",
        { request_id: randomUUID(), ...body },
        f.csrf,
        headers,
      );
      assert.equal(r.status, 200, r.text);
      return r.data.result ?? r.data;
    };
    await ownerAction({ action: "initialize" });
    const pair = await ownerAction({ action: "pair", runtime: "codex" });
    const runnerAction = (route: string, body: unknown, token?: string) =>
      new Promise<any>((resolve, reject) => {
        const req = request(
          f.server.origin + "/studio/v1/agent-runners/" + route,
          {
            method: "POST",
            headers: {
              host: "studio.example.test",
              "x-forwarded-proto": "https",
              "content-type": "application/json",
              ...(token ? { authorization: "Bearer " + token } : {}),
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (text += c));
            res.on("end", () => {
              assert.equal(res.statusCode, 200, text);
              resolve(JSON.parse(text));
            });
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    const runner = await runnerAction("pair", {
      pairing_id: pair.pairing_id,
      code: pair.code,
      label: "Synthetic namespace runner",
      runtime: "codex",
      version: "synthetic",
    });
    await runnerAction(
      runner.runner_id + "/poll",
      { ready: true, models: ["fixture-model"] },
      runner.token,
    );
    const connection = await ownerAction({
      action: "add-runner",
      runner_id: runner.runner_id,
      label: "Synthetic namespace agent",
      model: "fixture-model",
      limits: fixtureLimits,
    });
    await ownerAction({
      action: "consent",
      connection_id: connection.id,
      generation: 1,
      baseline: "ProjectBaseline@1",
      context: "selected-intent",
      retention: "until-removed",
      limits: fixtureLimits,
    });
    const conversation = await ownerAction({
      action: "conversation",
      connection_id: connection.id,
      baseline: "ProjectBaseline@1",
      title: "Namespace proposal",
    });
    await ownerAction({
      action: "turn",
      conversation_id: conversation.id,
      kind: "proposal",
      text: "Clarify purpose",
    });
    const packet = await runnerAction(
      runner.runner_id + "/poll",
      { ready: true },
      runner.token,
    );
    assert.ok(packet.task);
    const proposal = {
      format: "strata-agent-draft-proposal/1",
      baseline: "ProjectBaseline@1",
      context_sha256: packet.task.context_sha256,
      intent: "Clarify purpose",
      changes: [
        {
          op: "set_item",
          block: "root",
          path: "purpose",
          expected: { kind: "value", value: "Before" },
          value: "After",
        },
      ],
      questions: [],
    };
    await runnerAction(
      runner.runner_id + "/output",
      {
        format: "strata-agent-chat-output/1",
        task_id: packet.task.task_id,
        request_sha256: packet.request_sha256,
        state: "succeeded",
        text: "Clarify purpose",
        proposal,
        code: null,
      },
      runner.token,
    );
    const saveId = randomUUID();
    const saved = await ownerAction({
      request_id: saveId,
      action: "save",
      turn_id: packet.task.task_id,
      proposal_sha256: digest(proposal),
      layer_id: "AgentDraft",
    });
    assert.equal(saved.draft_result.data.ref, "AgentDraft@1");
    const recovered = await ownerAction({
      action: "inspect-save",
      source_request_id: saveId,
    });
    assert.deepEqual(recovered, saved);
    const current = await f.b.send(
      "/studio/v1/connection",
      "GET",
      undefined,
      undefined,
      headers,
    );
    assert.equal(current.status, 200, current.text);
    const record = await f.b.send(
      "/studio/v1/record?type=layer&ref=AgentDraft@1&generation=" +
        current.data.data.source.registry_generation,
      "GET",
      undefined,
      undefined,
      headers,
    );
    assert.equal(record.status, 200, record.text);
    assert.match(record.text, /namespace-author/);
    assert.match(record.text, /After/);
    const history = await ownerAction({
      action: "inspect",
      conversation_id: conversation.id,
    });
    assert.equal(history.turns[0].saved, true);
    const stale = await f.b.send(
      "/studio/v1/owner/agent-connections",
      "POST",
      {
        action: "save",
        request_id: randomUUID(),
        turn_id: packet.task.task_id,
        proposal_sha256: digest(proposal),
        layer_id: "Duplicate",
      },
      f.csrf,
      headers,
    );
    assert.equal(stale.status, 409);
  },
);
