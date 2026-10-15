import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { studioAgentHttpFixture } from "./studio-agent-http-fixture.js";
import { namespaceFixture } from "./namespace-fixture.js";
test("agent HTTP requires current owner, exact Origin, CSRF and strict bodies", async (t) => {
  const f = await studioAgentHttpFixture();
  t.after(() => f.server.close());
  const route = "/studio/v1/owner/agent-connections";
  assert.equal((await f.send(route)).status, 401);
  const session = await f.login();
  assert.equal((await f.send(route)).data.initialized, false);
  assert.equal(
    (
      await f.send(
        route,
        "POST",
        { action: "initialize", request_id: randomUUID() },
        "wrong",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.send(
        route,
        "POST",
        { action: "initialize", request_id: randomUUID() },
        session.csrf,
        { origin: "https://foreign.example.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.send(
        route,
        "POST",
        { action: "initialize", request_id: randomUUID(), extra: true },
        session.csrf,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.send(
        route,
        "POST",
        { action: "initialize", request_id: randomUUID() },
        session.csrf,
      )
    ).status,
    200,
  );
  assert.equal((await f.send(route)).data.initialized, true);
  assert.equal(
    (
      await f.send(route, "GET", undefined, undefined, {
        authorization: "Bearer guessed",
      })
    ).status,
    403,
  );
});
test("runner pairing endpoint rejects owner cookies and wrong methods", async (t) => {
  const f = await studioAgentHttpFixture();
  t.after(() => f.server.close());
  await f.login();
  assert.equal(
    (
      await f.send("/studio/v1/agent-runners/pair", "POST", {
        pairing_id: randomUUID(),
        code: "x".repeat(32),
        label: "fixture",
        runtime: "codex",
        version: "fixture",
      })
    ).status,
    403,
  );
  assert.equal((await f.send("/studio/v1/agent-runners/pair")).status, 403);
});

test("namespace hosts expose agent setup metadata by default without initialization or provider reads", async (t) => {
  const f = await namespaceFixture();
  t.after(() => f.server.close());
  await f.login();
  const result = await f.b.send("/studio/v1/owner/agent-connections");
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.initialized, false);
  assert.equal(f.calls.length, 0);
  const next = await f.b.send("/studio/v1/owner/agent-connections");
  assert.deepEqual(
    next.data.reconciliation_scope,
    result.data.reconciliation_scope,
  );
  assert.equal(f.calls.length, 0);
});
