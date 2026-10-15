import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertUnpaired, studioOrigin, checkCodexBinary, assertCodexPermissionSchemas } from "../scripts/studio-agent-runner.js";
import { codexExperimentalSchemas } from "./fixtures/studio-codex-permissions.js";
import { runnerPacketSchema, AgentHubError } from "../src/studio-agents/protocol.js";
import { CodexChatBridge, type CodexRpc } from "../src/studio-agents/codex.js";
import { studioAgentHubFixture, fixtureLimits } from "./studio-agent-hub-fixture.js";
const refused = (code: string) => (e: unknown) => e instanceof AgentHubError && e.code === code;

test("0.162.1 generated nullable type arrays qualify without the obsolete legacy access field", () => {
  assert.doesNotThrow(() => assertCodexPermissionSchemas(codexExperimentalSchemas()));
  for (const name of ["ThreadStartParams", "TurnStartParams"]) {
    const schemas = codexExperimentalSchemas();
    delete schemas[name].properties.permissions;
    assert.throws(() => assertCodexPermissionSchemas(schemas), /--experimental/);
    const missingRoots = codexExperimentalSchemas();
    delete missingRoots[name].properties.runtimeWorkspaceRoots;
    assert.throws(() => assertCodexPermissionSchemas(missingRoots), /runtime workspace roots/);
  }
  const missingReadback = codexExperimentalSchemas();
  delete missingReadback.ThreadStartResponse.properties.activePermissionProfile;
  assert.throws(() => assertCodexPermissionSchemas(missingReadback), /named-profile readback/);
});

test("schema preflight supports nullable alternatives and refuses a non-string profile type", () => {
  const schemas = codexExperimentalSchemas();
  for (const name of ["ThreadStartParams", "TurnStartParams"]) {
    schemas[name].properties.permissions = { anyOf: [{ type: "string" }, { type: "null" }] };
    schemas[name].properties.runtimeWorkspaceRoots = { anyOf: [
      { type: "array", items: { $ref: "#/definitions/AbsolutePathBuf" } }, { type: "null" },
    ] };
  }
  assert.doesNotThrow(() => assertCodexPermissionSchemas(schemas));
  schemas.TurnStartParams.properties.permissions = { type: ["object", "null"] };
  assert.throws(() => assertCodexPermissionSchemas(schemas), /named permissions/);
});

test("pairing preflight refuses existing and uncertain installations before transport", async () => {
  for (const name of ["runner.json", "pairing-pending.json"]) {
    const directory = await mkdtemp(path.join(tmpdir(), "strata-runner-preflight-"));
    await assertUnpaired(directory);
    await writeFile(path.join(directory, name), "synthetic original receipt");
    await assert.rejects(assertUnpaired(directory), /Existing or unresolved pairing/);
  }
  await assert.rejects(checkCodexBinary(process.execPath), /0.162.1 is required/);
  await assert.rejects(checkCodexBinary("codex.cmd"), /absolute native/);
});

test("offline preflight generates experimental schemas in an isolated directory and pins the whole used subset", async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const schemas = codexExperimentalSchemas();
  const probe = async (_binary: string, args: string[], cwd: string) => {
    calls.push({ args, cwd });
    if (args[0] === "--version") return "codex-cli 0.162.1";
    assert.deepEqual(args.slice(0, 4), ["app-server", "generate-json-schema", "--experimental", "--out"]);
    const out = args[4];
    assert.equal(path.dirname(out), cwd);
    await mkdir(path.join(out, "v2"), { recursive: true });
    for (const [name, value] of Object.entries(schemas))
      await writeFile(path.join(out, "v2", name + ".json"), JSON.stringify(value));
    return "";
  };
  const first = await checkCodexBinary(process.execPath, probe);
  assert.equal(first.version, "0.162.1");
  assert.match(first.binary_schema_sha256, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cwd, calls[1].cwd);
  schemas.ThreadStartResponse.description = "changed native schema";
  const changed = await checkCodexBinary(process.execPath, probe);
  assert.notEqual(changed.binary_schema_sha256, first.binary_schema_sha256);
  assert.equal(changed.binary_sha256, first.binary_sha256);
});

test("outward runner accepts only the canonical HTTPS Studio origin and original packet digest", () => {
  assert.equal(studioOrigin("https://studio.example.test/"), "https://studio.example.test");
  for (const url of ["http://studio.example.test", "https://user:pass@studio.example.test", "https://studio.example.test/path", "https://studio.example.test/?token=x", "https://studio.example.test/#x"])
    assert.throws(() => studioOrigin(url));
  assert.equal(runnerPacketSchema.safeParse({ task: null, cancel: [], login_id: null }).success, true);
  assert.equal(runnerPacketSchema.safeParse({ task: {}, cancel: [], login_id: null }).success, false);
  assert.equal(runnerPacketSchema.safeParse({ task: null, cancel: ["wrong"], login_id: null }).success, false);
});

test("native model discovery paginates exact text models and refuses looping catalogs", async () => {
  const f = await studioAgentHubFixture();
  const calls: any[] = [];
  const rpc: CodexRpc = {
    async call(method, params: any) {
      assert.equal(method, "model/list"); calls.push(params);
      return params.cursor ? { data: [{ model: "available-b", inputModalities: ["text"] }], nextCursor: null } : {
        data: [{ model: "available-a" }, { model: "hidden", hidden: true }, { model: "image-only", inputModalities: ["image"] }], nextCursor: "next-page",
      };
    }, onEvent() { return () => {}; }, close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.directory);
  assert.deepEqual(await bridge.models(), ["available-a", "available-b"]);
  assert.equal(calls[1].cursor, "next-page");
  rpc.call = async () => ({ data: [], nextCursor: "same" });
  await assert.rejects(bridge.models(), refused("AGENT_LIMIT"));
});

test("Codex connection and dispatch require a current available model without spending a native turn", async () => {
  const f = await studioAgentHubFixture(), c = await f.connect();
  await assert.rejects(f.action({ action: "add-runner", runner_id: c.runner.runner_id,
    label: "Unavailable", model: "invented", limits: fixtureLimits }), refused("AGENT_MODEL_UNSUPPORTED"));
  await f.hub.poll(c.runner.runner_id, c.runner.token, true, false, ["another-model"]);
  await assert.rejects(f.action({ action: "turn", conversation_id: c.conversation.id, kind: "chat", text: "Explain" }), refused("AGENT_MODEL_UNSUPPORTED"));
  const status: any = await f.hub.status(f.authority);
  assert.deepEqual(status.runners[0].models, ["another-model"]);
  await f.hub.poll(c.runner.runner_id, c.runner.token, false, false, []);
  await assert.rejects(f.action({ action: "add-runner", runner_id: c.runner.runner_id,
    label: "Offline", model: "another-model", limits: fixtureLimits }), refused("AGENT_RUNTIME_OFFLINE"));
  assert.equal(f.calls.start, 0);
});
