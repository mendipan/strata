import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "../src/model.js";
import { StudioAgentHub } from "../src/studio-agents/hub.js";
import { AgentHubError } from "../src/studio-agents/protocol.js";
import { studioAgentHubFixture, fixtureLimits } from "./studio-agent-hub-fixture.js";
import { studioAgentHttpFixture } from "./studio-agent-http-fixture.js";

const refused = (code: string) => (e: unknown) => e instanceof AgentHubError && e.code === code;
const conversation = (connection_id: string) => ({
  action: "conversation", connection_id, baseline: "R0@1", title: "Selected project",
});

test("local pairing starts conversations without Allow and preserves grants across restart", async () => {
  const f = await studioAgentHubFixture(), c = await f.connect(false);
  const key = "consent/" + c.connection.id + "/" + digest(f.context.binding);
  const original: any = await f.state.transaction(tx => tx.get(key));
  assert.deepEqual(original.binding, f.context.binding);
  assert.deepEqual(original.limits, fixtureLimits);
  assert.equal(c.conversation.consent_generation, 1);
  assert.equal(f.calls.start, 0);
  // A retained narrower grant must never be widened by opening a conversation.
  const retained = { ...original, generation: 3, limits: { ...fixtureLimits, turns_per_day: 2 } };
  await f.state.transaction(tx => tx.put(key, retained));
  const restarted = new StudioAgentHub(f.state, f.vault, {
    async start() { throw Error("Unexpected provider dispatch"); },
    async inspect() { return {}; }, async cancel() {},
  });
  const next: any = (await restarted.action(f.authority, f.project, {
    ...conversation(c.connection.id), request_id: randomUUID(),
  })).result;
  assert.equal(next.consent_generation, 3);
  assert.deepEqual(await f.state.transaction(tx => tx.get(key)), retained);
  await restarted.action(f.authority, f.project, {
    action: "turn", request_id: randomUUID(), conversation_id: next.id, kind: "chat", text: "Explain the selected intent",
  });
  const packet = await restarted.poll(c.runner.runner_id, c.runner.token, true);
  assert.deepEqual(packet.task!.context, f.context);
  assert.deepEqual(packet.task!.limits, retained.limits);
});

test("local auto grants cannot restore disconnected, revoked or mismatched pairings and grants", async t => {
  for (const condition of ["disconnect", "revoke", "runner-revoked", "runner-mismatch", "grant-revoked"]) {
    await t.test(condition, async () => {
      const f = await studioAgentHubFixture(), c = await f.connect(false);
      const key = "consent/" + c.connection.id + "/" + digest(f.context.binding);
      if (condition === "disconnect" || condition === "revoke") {
        await f.action({ action: condition, connection_id: c.connection.id, generation: 1 });
      } else await f.state.transaction(async tx => {
        const target = condition === "grant-revoked" ? key : "runner/" + c.runner.runner_id;
        const old: any = await tx.get(target);
        await tx.put(target, { ...old, ...(condition === "grant-revoked" ? { revoked_at: new Date().toISOString() }
          : condition === "runner-revoked" ? { revoked: true } : { runtime: "claude" }) });
      });
      const before = await f.state.transaction(tx => tx.get(key));
      await assert.rejects(f.action(conversation(c.connection.id)), refused("AGENT_AUTH"));
      assert.deepEqual(await f.state.transaction(tx => tx.get(key)), before);
      assert.equal((await f.state.transaction(tx => tx.list({ prefix: "conversation/", limit: 64 }))).size, 1);
    });
  }
});

test("revocation while resolving selected context cannot admit a conversation or grant", async () => {
  const f = await studioAgentHubFixture(), c = await f.connect(false);
  f.context.binding = { ...f.context.binding, project_id: "other-selected-project" };
  const source = f.project.context;
  f.project.context = async baseline => {
    await f.action({ action: "revoke", connection_id: c.connection.id, generation: 1 });
    return source(baseline);
  };
  await assert.rejects(f.action(conversation(c.connection.id)), refused("AGENT_AUTH"));
  assert.equal(await f.state.transaction(tx => tx.get("consent/" + c.connection.id + "/" + digest(f.context.binding))), undefined);
});

test("each selected project gets its own grant and old conversations cannot cross projects", async () => {
  const f = await studioAgentHubFixture(), c = await f.connect(false);
  const original = structuredClone(f.context);
  f.context.binding = { ...f.context.binding, project_id: "second", repository_id: "second-repository" };
  const second: any = (await f.action(conversation(c.connection.id))).result;
  assert.deepEqual(second.context.binding, f.context.binding);
  const grants = await f.state.transaction(tx => tx.list({ prefix: "consent/" + c.connection.id + "/", limit: 64 }));
  assert.equal(grants.size, 2);
  assert.notEqual(digest(original.binding), digest(second.context.binding));
  await assert.rejects(f.action({ action: "turn", conversation_id: c.conversation.id, kind: "chat", text: "Wrong project" }), refused("AGENT_STALE"));
  assert.equal(f.calls.start, 0);
});

test("paired local access does not create Cloudflare consent", async () => {
  const f = await studioAgentHubFixture(), c = await f.connect(false), id = randomUUID();
  await f.state.transaction(tx => tx.put("connection/" + id, {
    ...c.connection, id, provider: "cloudflare", runner_id: null,
  }));
  await assert.rejects(f.action(conversation(id)), refused("AGENT_AUTH"));
  assert.equal(await f.state.transaction(tx => tx.get("consent/" + id + "/" + digest(f.context.binding))), undefined);
  assert.equal(f.calls.start, 0);
});

test("existing pairing works after password freshness expires, but owner session and setup gates remain", async t => {
  let now = Date.now();
  const f = await studioAgentHttpFixture(() => now);
  t.after(() => f.server.close());
  const session = await f.login(), route = "/studio/v1/owner/agent-connections";
  const post = (body: Record<string, unknown>, csrf = session.csrf) => f.send(route, "POST", { request_id: randomUUID(), ...body }, csrf);
  assert.equal((await post({ action: "initialize" })).status, 200);
  const pair = (await post({ action: "pair", runtime: "codex" })).data.result;
  const runner = await f.hub.pair({ pairing_id: pair.pairing_id, code: pair.code, label: "Synthetic", runtime: "codex", version: "synthetic" });
  await f.hub.poll(runner.runner_id, runner.token, true, false, ["fixture-model"]);
  now += 6 * 60_000;
  const config = { action: "add-runner", runner_id: runner.runner_id, label: "Paired", model: "fixture-model", limits: fixtureLimits };
  assert.equal((await post(config, "wrong-csrf")).status, 403);
  const added = await post(config);
  assert.equal(added.status, 200, added.text);
  const started = await post(conversation(added.data.result.id));
  assert.equal(started.status, 200, started.text);
  const turn = await post({ action: "turn", conversation_id: started.data.result.id, kind: "chat", text: "Selected project only" });
  assert.equal(turn.status, 200, turn.text);
  for (const body of [{ action: "pair", runtime: "codex" }, { action: "credential", value: "synthetic-not-a-secret" }]) {
    const response = await post(body);
    assert.equal(response.status, 403);
    assert.equal(response.data.error.code, "OWNER_REAUTH_REQUIRED");
  }
  now += 61 * 60_000;
  assert.equal((await post(config)).status, 401);
  assert.equal((await post(conversation(added.data.result.id))).status, 401);
});
