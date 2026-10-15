import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  studioAgentHubFixture,
  fixtureLimits,
} from "./studio-agent-hub-fixture.js";
import { CodexChatBridge, CodexProcess, CODEX_PROCESS_OVERRIDES, type CodexRpc } from "../src/studio-agents/codex.js";
import { codexThreadReply } from "./fixtures/studio-codex-permissions.js";
import {
  CloudflareChatRuntime,
  CloudflareAgentProvisioner,
} from "../src/studio-agents/cloudflare.js";
import {
  AgentHubError,
  type TurnRequest,
  type AgentConnection,
} from "../src/studio-agents/protocol.js";
import { digest } from "../src/model.js";
import { applyRunnerControls } from "../scripts/studio-agent-runner.js";
const refused = (code: string) => (e: unknown) =>
  e instanceof AgentHubError && e.code === code;
async function nativeFixture() {
  const f = await studioAgentHubFixture();
  await f.action({ action: "initialize" });
  const snapshots = path.join(f.directory, "snapshots");
  await mkdir(snapshots);
  const request: TurnRequest = {
    format: "strata-agent-chat/1",
    task_id: randomUUID(),
    conversation_id: randomUUID(),
    connection_id: randomUUID(),
    connection_generation: 1,
    kind: "chat",
    context: f.context,
    context_sha256: digest(f.context),
    model: "fixture-model",
    limits: fixtureLimits,
    messages: [{ role: "user", text: "Explain intent" }],
  };
  return { ...f, snapshots, request };
}

test("token-sized native deltas stay within the hub event budget and retain the final remainder", async () => {
  const f = await nativeFixture(), text = "a".repeat(60003);
  let listener: (method: string, params: unknown) => void = () => {};
  const rpc: CodexRpc = {
    async call(method, params: any) {
      if (method === "thread/start") return codexThreadReply(params);
      assert.equal(method, "turn/start");
      setTimeout(() => {
        for (const delta of text) listener("item/agentMessage/delta", { threadId: "original-thread", turnId: "original-turn", delta });
        listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed", items: [] } });
      }, 10);
      return { turn: { id: "original-turn" } };
    }, onEvent(fn) { listener = fn; return () => {}; }, close() {},
  };
  const chunks: string[] = [];
  const output = await new CodexChatBridge(rpc, f.state, f.snapshots).run(f.request, async delta => {
    chunks.push(delta);
    await new Promise(resolve => setTimeout(resolve, 1));
  }, AbortSignal.timeout(10000));
  assert.equal(output.state, "succeeded");
  assert.equal(output.text, text);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks.length, 59);
  assert.ok(2 + chunks.reduce((count, chunk) => count + Math.ceil(chunk.length / 4096), 0) <= 255);
});

test("Stop during completed output drain does not interrupt a finished native turn", async () => {
  const f = await nativeFixture();
  let listener: (method: string, params: unknown) => void = () => {}, interrupts = 0;
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const rpc: CodexRpc = {
    async call(method, params: any) {
      if (method === "thread/start") return codexThreadReply(params);
      if (method === "turn/interrupt") { interrupts++; throw new AgentHubError("AGENT_INVALID"); }
      assert.equal(method, "turn/start");
      setTimeout(() => {
        listener("item/agentMessage/delta", { threadId: "original-thread", turnId: "original-turn", delta: "Finished" });
        listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed", items: [] } });
      }, 10);
      return { turn: { id: "original-turn" } };
    }, onEvent(fn) { listener = fn; return () => {}; }, close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
  const run = bridge.run(f.request, async () => { entered(); await gate; }, AbortSignal.timeout(10000));
  await ready;
  await bridge.cancel(f.request.task_id);
  assert.equal(interrupts, 0);
  resume();
  assert.equal((await run).state, "succeeded", "normal completion must not be relabeled cancelled");
  const saved: any = await f.state.transaction(tx => tx.get("codex/" + f.request.task_id));
  assert.equal(saved.state, "completed");
});

test("invalid interrupt is ignored only after matching native completion, never unrelated events or transport errors", async t => {
  for (const scenario of ["matching", "other-turn", "transport-error"]) await t.test(scenario, async () => {
    const f = await nativeFixture();
    let listener: (method: string, params: unknown) => void = () => {};
    let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const rpc: CodexRpc = {
      async call(method, params: any) {
        if (method === "thread/start") return codexThreadReply(params);
        if (method === "turn/start") {
          setTimeout(() => listener("item/agentMessage/delta", { threadId: "original-thread", turnId: "original-turn", delta: "a".repeat(1024) }), 10);
          return { turn: { id: "original-turn" } };
        }
        assert.equal(method, "turn/interrupt");
        listener("turn/completed", { threadId: "original-thread", turn: {
          id: scenario === "other-turn" ? "unrelated-turn" : "original-turn", status: "completed", items: [],
        } });
        throw new AgentHubError(scenario === "transport-error" ? "AGENT_RUNTIME_OFFLINE" : "AGENT_INVALID");
      }, onEvent(fn) { listener = fn; return () => {}; }, close() {},
    };
    const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
    const run = bridge.run(f.request, async () => { entered(); await gate; }, AbortSignal.timeout(10000));
    await ready;
    if (scenario === "matching") await bridge.cancel(f.request.task_id);
    else await assert.rejects(bridge.cancel(f.request.task_id), refused(scenario === "transport-error" ? "AGENT_RUNTIME_OFFLINE" : "AGENT_INVALID"));
    if (scenario === "other-turn") listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed", items: [] } });
    resume();
    assert.equal((await run).state, "succeeded");
  });
});
test("Codex expiry during reservation or thread setup retains the original ID without starting a turn", async t => {
  for (const phase of ["reservation", "thread"]) await t.test(phase, async () => {
    const f = await nativeFixture(), controller = new AbortController(), calls: string[] = [];
    if (phase === "reservation") {
      const transaction = f.state.transaction.bind(f.state);
      let first = true;
      f.state.transaction = async work => {
        const result = await transaction(work);
        if (first) { first = false; controller.abort(); }
        return result;
      };
    }
    const rpc: CodexRpc = {
      async call(method, params: any) {
        calls.push(method);
        if (method === "thread/start") {
          controller.abort();
          return codexThreadReply(params);
        }
        throw Error("No turn may start after expiry");
      },
      onEvent() { return () => {}; }, close() {},
    };
    const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
    await assert.rejects(bridge.run(f.request, async () => {}, controller.signal), refused("AGENT_RECOVERY_REQUIRED"));
    const retained: any = await f.state.transaction(tx => tx.get("codex/" + f.request.task_id));
    assert.equal(retained.state, "uncertain");
    assert.equal(retained.turn_id, null);
    assert.equal(retained.request_sha256, digest(f.request));
    assert.deepEqual(calls, phase === "thread" ? ["thread/start"] : []);
    await assert.rejects(bridge.run(f.request, async () => {}, new AbortController().signal), refused("AGENT_RECOVERY_REQUIRED"));
    assert.deepEqual(calls, phase === "thread" ? ["thread/start"] : []);
  });
});

test("Codex abort during delayed native admission interrupts and recovers only the original turn", async () => {
  const f = await nativeFixture(), controller = new AbortController(), calls: { method: string; params: any }[] = [];
  const rpc: CodexRpc = {
    async call(method, params: any) {
      calls.push({ method, params });
      if (method === "thread/start") return codexThreadReply(params);
      if (method === "turn/start") {
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 20));
        return { turn: { id: "original-turn" } };
      }
      if (method === "thread/read") return { thread: { id: "original-thread", turns: [
        { id: "original-turn", status: "interrupted", items: [] },
      ] } };
      assert.equal(method, "turn/interrupt");
      assert.deepEqual(params, { threadId: "original-thread", turnId: "original-turn" });
      return {};
    },
    onEvent() { return () => {}; }, close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
  await assert.rejects(bridge.run(f.request, async () => {}, controller.signal), refused("AGENT_RECOVERY_REQUIRED"));
  const retained: any = await f.state.transaction(tx => tx.get("codex/" + f.request.task_id));
  assert.equal(retained.state, "uncertain");
  assert.equal(retained.thread_id, "original-thread");
  assert.equal(retained.turn_id, "original-turn");
  assert.equal(retained.output, null);
  assert.equal(calls.filter(call => call.method === "turn/interrupt").length, 1);
  await assert.rejects(bridge.run(f.request, async () => {}, new AbortController().signal), refused("AGENT_RECOVERY_REQUIRED"));
  assert.equal((await bridge.inspect(f.request))?.state, "cancelled");
  assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
});

test("a native admission ID arriving after the RPC timeout is retained and interrupted without resubmission", { timeout: 20000 }, async t => {
  const f = await nativeFixture(), controller = new AbortController();
  // The fixed launcher arguments make Node execute this synthetic app-server
  // program. It never runs Codex, reads credentials or contacts a provider.
  await writeFile(path.join(f.directory, "app-server"), `
const lines = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
lines.on('line', line => {
  const message=JSON.parse(line);
  send({method:'fixture/call',params:{method:message.method,params:message.params,argv:process.argv.slice(2),home:process.env.HOME,userprofile:process.env.USERPROFILE,codexhome:process.env.CODEX_HOME,localappdata:process.env.LOCALAPPDATA}});
  if(message.method==='thread/start') send({id:message.id,result:{thread:{id:'original-thread'},model:message.params.model,cwd:message.params.cwd,approvalPolicy:'never',runtimeWorkspaceRoots:message.params.runtimeWorkspaceRoots,activePermissionProfile:{id:message.params.permissions,extends:null}}});
  else if(message.method==='turn/start') setTimeout(()=>send({id:message.id,result:{turn:{id:'late-original-turn'}}}),10500);
  else send({id:message.id,result:{}});
});
`, { flag: "wx" });
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(f.directory, "synthetic-outside-appdata");
  let rpc: CodexProcess;
  try {
    rpc = new CodexProcess(process.execPath, path.join(f.directory, "synthetic-home"), f.directory);
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
  t.after(() => rpc.close());
  const calls: { method: string; params: any }[] = [];
  let interrupted!: () => void;
  const lateInterrupt = new Promise<void>(resolve => { interrupted = resolve; });
  rpc.onEvent((method, raw: any) => {
    if (method !== "fixture/call") return;
    assert.equal(raw.home, path.join(f.directory, "synthetic-home"));
    assert.equal(raw.userprofile, raw.home);
    assert.equal(raw.codexhome, raw.home);
    assert.equal(raw.localappdata, path.join(raw.home, "AppData", "Local"));
    assert.ok(raw.argv.includes('windows.sandbox="mxc"'));
    assert.equal(raw.argv.some((arg: string) => arg.includes("prefer_mxc")), false);
    calls.push(raw);
    if (raw.method === "turn/start") controller.abort();
    if (raw.method === "turn/interrupt") interrupted();
  });
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
  await assert.rejects(bridge.run(f.request, async () => {}, controller.signal), refused("AGENT_RECOVERY_REQUIRED"));
  await lateInterrupt;
  const retained: any = await f.state.transaction(tx => tx.get("codex/" + f.request.task_id));
  assert.equal(retained.request_sha256, digest(f.request));
  assert.equal(retained.thread_id, "original-thread");
  assert.equal(retained.turn_id, "late-original-turn");
  assert.equal(retained.state, "uncertain");
  assert.equal(retained.output, null);
  assert.deepEqual(calls.find(call => call.method === "turn/interrupt")!.params,
    { threadId: "original-thread", turnId: "late-original-turn" });
  await assert.rejects(bridge.run(f.request, async () => {}, new AbortController().signal), refused("AGENT_RECOVERY_REQUIRED"));
  assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
});

test("runner Stop during native setup or pending admission remains latched until its exact ID is known", async t => {
  for (const phase of ["thread", "turn"]) await t.test(phase, async () => {
    const f = await nativeFixture(), calls: { method: string; params: any }[] = [];
    let listener: (method: string, params: unknown) => void = () => {};
    const rpc: CodexRpc = {
      async call(method, params: any) {
        calls.push({ method, params });
        if (method === "thread/start") {
          if (phase === "thread") await bridge.cancel(f.request.task_id);
          return codexThreadReply(params);
        }
        if (method === "turn/start") {
          await bridge.cancel(f.request.task_id);
          return { turn: { id: "original-turn" } };
        }
        assert.equal(method, "turn/interrupt");
        assert.deepEqual(params, { threadId: "original-thread", turnId: "original-turn" });
        listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "interrupted", items: [] } });
        return {};
      },
      onEvent(fn) { listener = fn; return () => {}; }, close() {},
    };
    const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
    const run = bridge.run(f.request, async () => {}, new AbortController().signal);
    if (phase === "thread") {
      await assert.rejects(run, refused("AGENT_RECOVERY_REQUIRED"));
      assert.deepEqual(calls.map(call => call.method), ["thread/start"]);
    } else {
      assert.equal((await run).state, "cancelled");
      assert.equal(calls.filter(call => call.method === "turn/interrupt").length, 1);
    }
  });
});

test("expiry after native completion cannot retain success during progress or final journal staging", async t => {
  for (const phase of ["progress", "journal"]) await t.test(phase, async () => {
    const f = await nativeFixture(), controller = new AbortController();
    let listener: (method: string, params: unknown) => void = () => {};
    let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    if (phase === "journal") {
      const transaction = f.state.transaction.bind(f.state);
      f.state.transaction = work => transaction(tx => work({ ...tx, put: async (key, value: any) => {
        await tx.put(key, value);
        if (key === "codex/" + f.request.task_id && value.state === "completed") controller.abort();
      } }));
    }
    const rpc: CodexRpc = {
      async call(method, params: any) {
        if (method === "thread/start") return codexThreadReply(params);
        if (method === "turn/start") {
          setTimeout(() => {
            if (phase === "progress") listener("item/agentMessage/delta", { threadId: "original-thread", turnId: "original-turn", delta: "Completed before expiry" });
            listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed", items: [{ type: "agentMessage", text: "Completed before expiry" }] } });
          }, 10);
          return { turn: { id: "original-turn" } };
        }
        assert.equal(method, "turn/interrupt");
        return {};
      },
      onEvent(fn) { listener = fn; return () => {}; }, close() {},
    };
    const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
    const failed = assert.rejects(bridge.run(f.request, async () => { entered(); await gate; }, controller.signal), refused("AGENT_RECOVERY_REQUIRED"));
    if (phase === "progress") { await ready; controller.abort(); resume(); }
    await failed;
    const retained: any = await f.state.transaction(tx => tx.get("codex/" + f.request.task_id));
    assert.equal(retained.state, "uncertain");
    assert.equal(retained.output, null);
    assert.equal(retained.turn_id, "original-turn");
  });
});
test("synthetic Codex conversation uses dedicated thread, restricted reads and no start on replay", async () => {
  const f = await nativeFixture();
  let listener: (method: string, params: unknown) => void = () => {};
  const calls: { method: string; params: any }[] = [];
  const rpc: CodexRpc = {
    async call(method, params: any) {
      calls.push({ method, params });
      if (method === "thread/start")
        return codexThreadReply(params, "synthetic-thread");
      if (method === "turn/start") {
        setTimeout(() => {
          listener("item/agentMessage/delta", {
            threadId: "synthetic-thread",
            turnId: "synthetic-turn",
            delta: "Retained intent.",
          });
          listener("turn/completed", {
            threadId: "synthetic-thread",
            turn: { id: "synthetic-turn", status: "completed", items: [] },
          });
        }, 30);
        return { turn: { id: "synthetic-turn" } };
      }
      return {};
    },
    onEvent(fn) {
      listener = fn;
      return () => {};
    },
    close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots),
    output = await bridge.run(
      f.request,
      async () => {},
      AbortSignal.timeout(5000),
    );
  assert.equal(output.state, "succeeded");
  assert.equal(output.text, "Retained intent.");
  const turn = calls.find((c) => c.method === "turn/start")!;
  assert.equal(turn.params.sandboxPolicy, undefined);
  assert.match(turn.params.permissions, /^strata_proposal_[a-f0-9]{32}$/);
  const start = calls.find(c => c.method === "thread/start")!.params;
  const directory = path.join(f.snapshots, f.request.task_id);
  assert.equal(start.sandbox, undefined);
  assert.equal(start.config["windows.sandbox"], "mxc");
  assert.deepEqual(start.config.permissions, { [turn.params.permissions]: {
    filesystem: { ":root": "deny", [directory]: "read" }, network: { enabled: false },
  } });
  assert.deepEqual(start.runtimeWorkspaceRoots, [directory]);
  assert.deepEqual(turn.params.runtimeWorkspaceRoots, [directory]);
  assert.equal(
    (await bridge.run(f.request, async () => {}, AbortSignal.timeout(5000)))
      .state,
    "succeeded",
  );
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
});
test("lost native start reply keeps original ID uncertain and refuses another start", async () => {
  const f = await nativeFixture();
  let starts = 0;
  const rpc: CodexRpc = {
    async call(method, params: any) {
      if (method === "thread/start")
        return codexThreadReply(params, "synthetic-thread");
      starts++;
      throw Error("public synthetic transport loss");
    },
    onEvent() {
      return () => {};
    },
    close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
  await assert.rejects(
    bridge.run(f.request, async () => {}, AbortSignal.timeout(5000)),
    refused("AGENT_RECOVERY_REQUIRED"),
  );
  await assert.rejects(
    bridge.run(f.request, async () => {}, AbortSignal.timeout(5000)),
    refused("AGENT_RECOVERY_REQUIRED"),
  );
  assert.equal(starts, 1);
});

test("native recovery reads only the original retained thread and turn", async () => {
  const f = await nativeFixture(),
    calls: string[] = [];
  await f.state.transaction((tx) =>
    tx.put("codex/" + f.request.task_id, {
      request_sha256: digest(f.request),
      thread_id: "original-thread",
      turn_id: "original-turn",
      state: "uncertain",
      output: null,
    }),
  );
  const rpc: CodexRpc = {
    async call(method, params: any) {
      calls.push(method);
      assert.equal(method, "thread/read");
      assert.equal(params.threadId, "original-thread");
      return {
        thread: {
          id: "original-thread",
          turns: [
            {
              id: "unrelated",
              status: "completed",
              items: [{ type: "agentMessage", text: "wrong" }],
            },
            {
              id: "original-turn",
              status: "completed",
              items: [{ type: "agentMessage", text: "Retained result" }],
            },
          ],
        },
      };
    },
    onEvent() {
      return () => {};
    },
    close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
  assert.equal((await bridge.inspect(f.request))?.text, "Retained result");
  assert.equal((await bridge.inspect(f.request))?.text, "Retained result");
  await bridge.cancel(f.request.task_id);
  assert.deepEqual(calls, ["thread/read"]);
});

test("runner reconciles an original terminal turn before cancellation after restart", async () => {
  const f = await nativeFixture(), calls: string[] = [];
  await f.state.transaction(tx => tx.put("codex/" + f.request.task_id, {
    request_sha256: digest(f.request), thread_id: "original-thread", turn_id: "original-turn",
    state: "uncertain", output: null,
  }));
  const rpc: CodexRpc = {
    async call(method, params: any) {
      calls.push(method);
      assert.equal(method, "thread/read", "an unloaded terminal turn must not be interrupted again");
      assert.equal(params.threadId, "original-thread");
      return {thread:{id:"original-thread",turns:[{id:"original-turn",status:"interrupted",items:[]}]}};
    },
    onEvent() { return () => {}; }, close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
  await applyRunnerControls(bridge, {inspect:f.request,cancel:[f.request.task_id],login_id:null}, async output => {
    calls.push("deliver"); assert.equal(output.state,"cancelled"); assert.equal(output.task_id,f.request.task_id);
  });
  assert.deepEqual(calls,["thread/read","deliver"]);
});

test("runner preserves cancellation when inspection is unresolved and refuses failed recovery delivery", async () => {
  const f = await nativeFixture(), calls: string[] = [];
  const packet = {inspect:f.request,cancel:[f.request.task_id],login_id:null};
  await applyRunnerControls({inspect:async()=>{calls.push("inspect");return null;},cancel:async id=>{
    assert.equal(id,f.request.task_id);calls.push("cancel");
  }},packet,async()=>{throw Error("no result may be delivered");});
  assert.deepEqual(calls,["inspect","cancel"]);
  calls.length=0;
  await assert.rejects(applyRunnerControls({inspect:async()=>({format:"strata-agent-chat-output/1",
    trust:"agent-output",task_id:f.request.task_id,request_sha256:digest(f.request),state:"cancelled",text:"",proposal:null,code:null}),
    cancel:async()=>{calls.push("cancel");}},packet,async()=>{throw Error("delivery lost");}),/delivery lost/);
  assert.deepEqual(calls,[]);
});
test("native initialize opts into profiles and process flags require MXC without fallback", async () => {
  const f = await nativeFixture();
  const rpc: CodexRpc = {
    async call(method, params: any) {
      assert.equal(method, "initialize");
      assert.equal(params.capabilities.experimentalApi, true);
      return {};
    }, onEvent() { return () => {}; }, close() {},
  };
  await new CodexChatBridge(rpc, f.state, f.snapshots).initialize();
  assert.deepEqual([...CODEX_PROCESS_OVERRIDES], ['cli_auth_credentials_store="file"', 'windows.sandbox="mxc"']);
});

test("changed native profile, parent, model or workspace roots refuse before turn admission", async t => {
  for (const change of ["profile", "parent", "roots", "cwd", "model"]) await t.test(change, async () => {
    const f = await nativeFixture();
    const calls: string[] = [];
    const rpc: CodexRpc = {
      async call(method, params: any) {
        calls.push(method); assert.equal(method, "thread/start");
        const reply: any = codexThreadReply(params);
        if (change === "profile") reply.activePermissionProfile.id = ":read-only";
        if (change === "parent") reply.activePermissionProfile.extends = ":workspace";
        if (change === "roots") reply.runtimeWorkspaceRoots = [f.snapshots];
        if (change === "cwd") reply.cwd = f.snapshots;
        if (change === "model") reply.model = "substituted-model";
        return reply;
      }, onEvent() { return () => {}; }, close() {},
    };
    const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
    await assert.rejects(bridge.run(f.request, async () => {}, AbortSignal.timeout(5000)), refused("AGENT_RECOVERY_REQUIRED"));
    await assert.rejects(bridge.run(f.request, async () => {}, AbortSignal.timeout(5000)), refused("AGENT_RECOVERY_REQUIRED"));
    assert.deepEqual(calls, ["thread/start"]);
  });
});

test("ordinary native userMessage is passive during streaming, completion and original-ID recovery", async () => {
  const f = await nativeFixture();
  let listener: (method: string, params: unknown) => void = () => {};
  let starts = 0, interrupts = 0, reads = 0;
  const input = { type: "userMessage", id: "native-input", content: [{ type: "text", text: "Explain intent", textElements: [] }] };
  const items = [input, { type: "agentMessage", id: "native-answer", phase: "final_answer", text: "Only the answer" }];
  const rpc: CodexRpc = {
    async call(method, params: any) {
      if (method === "thread/start") return codexThreadReply(params);
      if (method === "turn/interrupt") { interrupts++; return {}; }
      if (method === "thread/read") {
        reads++;
        assert.equal(params.threadId, "original-thread");
        return { thread: { id: "original-thread", turns: [{ id: "original-turn", status: "completed", items }] } };
      }
      assert.equal(method, "turn/start"); starts++;
      listener("item/started", { threadId: "original-thread", turnId: "original-turn", item: input });
      listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed", items } });
      return { turn: { id: "original-turn" } };
    }, onEvent(fn) { listener = fn; return () => {}; }, close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
  const result = await bridge.run(f.request, async () => {}, AbortSignal.timeout(5000));
  assert.equal(result.state, "succeeded");
  assert.equal(result.text, "Only the answer");
  // Simulate a lost local completion receipt while retaining the exact native IDs.
  await f.state.transaction(tx => tx.put("codex/" + f.request.task_id, {
    request_sha256: digest(f.request), thread_id: "original-thread", turn_id: "original-turn", state: "uncertain", output: null,
  }));
  assert.deepEqual(await bridge.inspect(f.request), result);
  assert.equal(reads, 1); assert.equal(starts, 1); assert.equal(interrupts, 0);
});
test("early native events bind to the returned original turn and final items are authoritative", async () => {
  const f = await nativeFixture();
  let listener: (method: string, params: unknown) => void = () => {};
  const rpc: CodexRpc = {
    async call(method, params: any) {
      if (method === "thread/start") return codexThreadReply(params);
      assert.equal(method, "turn/start");
      listener("item/agentMessage/delta", { threadId: "original-thread", turnId: "wrong-turn", delta: "Wrong result" });
      listener("turn/completed", { threadId: "original-thread", turn: { id: "wrong-turn", status: "completed", items: [] } });
      listener("item/agentMessage/delta", { threadId: "original-thread", turnId: "original-turn", delta: "Partial text" });
      listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed", items: [
        { type: "agentMessage", phase: "commentary", text: "Thinking" },
        { type: "agentMessage", phase: "final_answer", text: "Original final text" },
      ] } });
      return { turn: { id: "original-turn" } };
    }, onEvent(fn) { listener = fn; return () => {}; }, close() {},
  };
  const progress: string[] = [];
  const output = await new CodexChatBridge(rpc, f.state, f.snapshots).run(f.request,
    async text => { progress.push(text); }, AbortSignal.timeout(5000));
  assert.equal(output.text, "Original final text");
  assert.deepEqual(progress, ["Partial text"]);
});

test("native completion and original-ID recovery both refuse unapproved tool items", async t => {
  for (const kind of ["commandExecution", "dynamicToolCall", "collabAgentToolCall", "futureTool"]) await t.test(kind, async () => {
    const f = await nativeFixture();
    let listener: (method: string, params: unknown) => void = () => {};
    const items = [{ type: "agentMessage", text: "claim" }, { type: kind }];
    const rpc: CodexRpc = {
      async call(method, params: any) {
        if (method === "thread/start") return codexThreadReply(params);
        if (method === "thread/read") return { thread: { id: "original-thread", turns: [
          { id: "original-turn", status: "completed", items },
        ] } };
        assert.equal(method, "turn/start");
        listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed", items } });
        return { turn: { id: "original-turn" } };
      }, onEvent(fn) { listener = fn; return () => {}; }, close() {},
    };
    const bridge = new CodexChatBridge(rpc, f.state, f.snapshots);
    await assert.rejects(bridge.run(f.request, async () => {}, AbortSignal.timeout(5000)), refused("AGENT_RECOVERY_REQUIRED"));
    await assert.rejects(bridge.inspect(f.request), refused("AGENT_AUTH"));
  });
});

test("native proposal reaches explicit owned draft Save with provenance; recovery starts no second turn", async () => {
  const f = await studioAgentHubFixture(), c = await f.connect(), snapshots = path.join(f.directory, "snapshots");
  await mkdir(snapshots);
  await f.action({ action: "turn", conversation_id: c.conversation.id, kind: "proposal", text: "Clarify the purpose" });
  const packet = await f.hub.poll(c.runner.runner_id, c.runner.token, true);
  assert.ok(packet.task);
  const request = packet.task;
  const proposal = { format: "strata-agent-draft-proposal/1", baseline: request.context.baseline,
    context_sha256: request.context_sha256, intent: "Clarify purpose", questions: [], changes: [
      { op: "set_item", block: "root", path: "purpose", expected: { kind: "value", value: "Before" }, value: "Clearer purpose" },
    ] };
  const wireProposal = { ...proposal, format: "strata-codex-draft-proposal/1", changes: proposal.changes.map(
    ({ value, expected, ...change }) => ({ ...change, value_json: JSON.stringify(value),
      expected: { kind: "value", value_json: JSON.stringify(expected.value) } }),
  ) };
  const nativeItems = [{ type: "agentMessage", phase: "final_answer", text: JSON.stringify(wireProposal) }];
  let listener: (method: string, params: unknown) => void = () => {}, starts = 0;
  const rpc: CodexRpc = {
    async call(method, params: any) {
      if (method === "thread/start") {
        assert.equal(params.approvalPolicy, "never");
        assert.equal(params.config["features.shell_tool"], false);
        return codexThreadReply(params);
      }
      if (method === "thread/read") {
        assert.equal(params.threadId, "original-thread");
        return { thread: { id: "original-thread", turns: [{ id: "original-turn", status: "completed", items: nativeItems }] } };
      }
      assert.equal(method, "turn/start"); starts++;
      assert.ok(params.outputSchema);
      assert.equal(params.outputSchema.properties.format.const, "strata-codex-draft-proposal/1");
      assert.deepEqual(JSON.parse(params.input[0].text).proposal_format, params.outputSchema);
      listener("turn/completed", { threadId: "original-thread", turn: { id: "original-turn", status: "completed",
        items: nativeItems } });
      return { turn: { id: "original-turn" } };
    }, onEvent(fn) { listener = fn; return () => {}; }, close() {},
  };
  const bridge = new CodexChatBridge(rpc, f.state, snapshots);
  const output = await bridge.run(request, async () => {}, AbortSignal.timeout(5000));
  await f.hub.output(c.runner.runner_id, c.runner.token, output);
  assert.equal(f.saves.length, 0);
  const id = randomUUID();
  const saved: any = await f.action({ action: "save", request_id: id, turn_id: request.task_id,
    proposal_sha256: digest(output.proposal), layer_id: "NativeProposal" });
  assert.equal(saved.result.provider, "codex");
  assert.equal(saved.result.turn_id, request.task_id);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(await bridge.inspect(request), output);
  await f.state.transaction(async tx => {
    const key = "codex/" + request.task_id, original: any = await tx.get(key);
    await tx.put(key, { ...original, state: "uncertain", output: null });
  });
  assert.deepEqual(await bridge.inspect(request), output);
  assert.equal(starts, 1);
  assert.equal((await f.action({ action: "save", request_id: id, turn_id: request.task_id,
    proposal_sha256: digest(output.proposal), layer_id: "NativeProposal" })).replayed, true);
  assert.equal(f.saves.length, 1);
});
test("Cloudflare verifies independently pinned response signer and exact task identity", async () => {
  const f = await nativeFixture(),
    keys = generateKeyPairSync("ed25519"),
    id = randomUUID();
  await f.vault.save(id, "public-synthetic-runtime-token");
  const connection: AgentConnection = {
    id: f.request.connection_id,
    provider: "cloudflare",
    label: "fixture",
    model: f.request.model,
    runner_id: null,
    service_url: "https://fixture.example.test/",
    service_public_key: Buffer.from(
      keys.publicKey.export({ type: "spki", format: "der" }),
    ).toString("base64url"),
    credential_id: id,
    generation: 1,
    enabled: true,
    revoked: false,
    created_at: new Date().toISOString(),
    limits: fixtureLimits,
  };
  let requests = 0;
  const runtime = new CloudflareChatRuntime(f.vault, (async (url, options) => {
    requests++;
    assert.equal(url, "https://fixture.example.test/turns");
    assert.equal(options?.redirect, "error");
    const payload = {
        task_id: f.request.task_id,
        request_sha256: digest(f.request),
        state: "queued",
      },
      signature = Buffer.from(
        sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey),
      ).toString("base64url");
    return Response.json({ payload, signature });
  }) as typeof fetch);
  await runtime.start(connection, f.request, {
    signal: new AbortController().signal,
    assertLive() {},
    async refresh() {},
  });
  assert.equal(requests, 1);
  const substituted = {
    ...connection,
    service_public_key: Buffer.from(
      generateKeyPairSync("ed25519").publicKey.export({
        type: "spki",
        format: "der",
      }),
    ).toString("base64url"),
  };
  await assert.rejects(
    runtime.start(substituted, f.request, {
      signal: new AbortController().signal,
      assertLive() {},
      async refresh() {},
    }),
    refused("AGENT_AUTH"),
  );
});
test("Cloudflare deployment preview runs no transport and pins packaged code/resources", async () => {
  const f = await nativeFixture();
  const provisioner = new CloudflareAgentProvisioner(
    f.vault,
    path.resolve("dist/studio-agent-worker/worker.mjs"),
    (async () => {
      throw Error("no transport in preview");
    }) as typeof fetch,
  );
  const preview = await provisioner.preview({
    id: randomUUID(),
    account_id: "a".repeat(32),
    credential_id: randomUUID(),
    label: "fixture",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    limits: fixtureLimits,
    script_name: "strata-agent-fixture",
  });
  assert.equal(preview.resources.length, 3);
  assert.ok(preview.bundle_sha256);
  await assert.rejects(
    provisioner.preview({ ...preview, model: "unsupported-model" }),
    refused("AGENT_MODEL_UNSUPPORTED"),
  );
});

test("lost deployment reply is inspected using escrowed identity without another upload", async () => {
  const f = await nativeFixture(),
    credential = randomUUID();
  await f.vault.save(credential, "synthetic-api-token");
  let preview: any,
    uploads = 0,
    lost = true;
  const provisioner = new CloudflareAgentProvisioner(
    f.vault,
    path.resolve("dist/studio-agent-worker/worker.mjs"),
    (async (url, init: any) => {
      const target = new URL(String(url));
      if (target.origin === "https://api.cloudflare.com") {
        assert.equal(init.headers.authorization, "Bearer synthetic-api-token");
        if (target.pathname.endsWith("/workers/subdomain"))
          return Response.json({
            success: true,
            result: { subdomain: "fixture" },
          });
        if (init.method === "PUT") {
          uploads++;
          const meta = JSON.parse(init.body.get("metadata"));
          assert.equal(meta.compatibility_date, "2026-10-08");
          assert.deepEqual(meta.migrations, {
            new_tag: "v1",
            steps: [{ new_sqlite_classes: ["StudioAgent"] }],
          });
          assert.ok(meta.bindings.some((b: any) => b.type === "ai"));
          return Response.json({ success: true, result: {} });
        }
        return Response.json({ success: true, result: {} });
      }
      if (lost && target.pathname === "/initialize") {
        lost = false;
        throw Error("synthetic lost deployment reply");
      }
      assert.equal(target.pathname, "/identity");
      const payload = {
        service_id: preview.id,
        model: preview.model,
        bundle_sha256: preview.bundle_sha256,
        initialized: true,
      };
      const signature = await f.vault.use(
        preview.identity_secret_id,
        async (value) => {
          const { createPrivateKey } = await import("node:crypto");
          return Buffer.from(
            sign(
              null,
              Buffer.from(JSON.stringify(payload)),
              createPrivateKey({
                key: Buffer.from(value, "base64url"),
                type: "pkcs8",
                format: "der",
              }),
            ),
          ).toString("base64url");
        },
      );
      return Response.json({ payload, signature });
    }) as typeof fetch,
  );
  preview = await provisioner.preview({
    id: randomUUID(),
    account_id: "a".repeat(32),
    credential_id: credential,
    label: "fixture",
    model: "@cf/meta/llama-3.1-8b-instruct",
    limits: fixtureLimits,
    script_name: "strata-agent-fixture",
  });
  await assert.rejects(provisioner.deploy(preview, f.authority));
  assert.equal(uploads, 1);
  const observed = await provisioner.inspect(preview, f.authority);
  assert.equal(observed.initialized, true);
  assert.equal(uploads, 1);
  assert.equal(observed.target.service_public_key, preview.service_public_key);
});
