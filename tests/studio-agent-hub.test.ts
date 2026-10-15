import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { digest } from "../src/model.js";
import {
  AgentHubError,
  proposalSchema,
  contextDigest,
} from "../src/studio-agents/protocol.js";
import { StudioAgentHub } from "../src/studio-agents/hub.js";
import { studioAgentHubFixture } from "./studio-agent-hub-fixture.js";
const refused = (code: string) => (e: unknown) =>
  e instanceof AgentHubError && e.code === code;

async function readyProposal(f: Awaited<ReturnType<typeof studioAgentHubFixture>>, retain = true) {
  const connection = await f.connect();
  await f.action({ action: "turn", conversation_id: connection.conversation.id, kind: "proposal", text: "Clarify purpose" });
  const packet = await f.hub.poll(connection.runner.runner_id, connection.runner.token, true);
  const proposal = {
    format: "strata-agent-draft-proposal/1", baseline: f.context.baseline,
    context_sha256: packet.task!.context_sha256, intent: "Clarify purpose",
    changes: [{ op: "set_item", block: "root", path: "purpose", expected: { kind: "value", value: "Before" }, value: "After" }], questions: [],
  };
  const output = { format: "strata-agent-chat-output/1", task_id: packet.task!.task_id,
    request_sha256: packet.request_sha256, state: "succeeded", text: "Clarify purpose", proposal, code: null };
  if (retain) await f.hub.output(connection.runner.runner_id, connection.runner.token, output);
  return { ...connection, packet, proposal, output };
}

test("completed revocation, disconnect/reconnect or consent renewal fences reserved Save before dispatch", async t => {
  for (const invalidation of ["revoke", "disconnect-reconnect", "consent"]) await t.test(invalidation, async () => {
    const f = await studioAgentHubFixture(), c = await readyProposal(f);
    let entered!: () => void, resume!: () => void, refreshes = 0;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const refresh = f.authority.refresh.bind(f.authority);
    f.authority.refresh = async () => { await refresh(); if (++refreshes === 2) { entered(); await gate; } };
    const input = { action: "save", request_id: randomUUID(), turn_id: c.packet.task!.task_id,
      proposal_sha256: digest(c.proposal), layer_id: "RefusedDraft" };
    const pending = f.hub.action(f.authority, f.project, input);
    const rejected = assert.rejects(pending, refused("AGENT_STALE"));
    await ready;
    if (invalidation === "consent") {
      await f.action({ action: "consent", connection_id: c.connection.id, generation: 1,
        baseline: f.context.baseline, context: "selected-intent", retention: "until-removed", limits: c.connection.limits });
    } else {
      await f.action({ action: invalidation === "revoke" ? "revoke" : "disconnect", connection_id: c.connection.id, generation: 1 });
      if (invalidation === "disconnect-reconnect") await f.action({ action: "reconnect", connection_id: c.connection.id, generation: 2 });
    }
    assert.equal(f.saves.length, 0);
    resume(); await rejected;
    assert.equal(f.saves.length, 0);
    const reservation: any = await f.state.transaction(tx => tx.get("save-reservation/" + input.turn_id));
    assert.equal(reservation.request_id, input.request_id);
    assert.equal((await f.hub.outcome(f.authority, input.request_id)).state, "uncertain");
    await assert.rejects(f.hub.action(f.authority, f.project, input), refused("AGENT_RECOVERY_REQUIRED"));
    assert.equal(f.saves.length, 0);
  });
});

test("revocation after draft dispatch refuses late provenance and preserves original-operation recovery", async () => {
  const f = await studioAgentHubFixture(), c = await readyProposal(f);
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const save = f.project.save.bind(f.project);
  f.project.save = async (...args) => { const result = await save(...args); entered(); await gate; return result; };
  const input = { action: "save", request_id: randomUUID(), turn_id: c.packet.task!.task_id,
    proposal_sha256: digest(c.proposal), layer_id: "OriginalCommittedDraft" };
  const rejected = assert.rejects(f.hub.action(f.authority, f.project, input), refused("AGENT_STALE"));
  await ready; assert.equal(f.saves.length, 1);
  await f.action({ action: "revoke", connection_id: c.connection.id, generation: 1 });
  resume(); await rejected;
  assert.equal(await f.state.transaction(tx => tx.get("saved/" + input.turn_id)), undefined);
  assert.equal((await f.hub.outcome(f.authority, input.request_id)).state, "uncertain");
  const recovered: any = await f.action({ action: "inspect-save", source_request_id: input.request_id });
  assert.equal(recovered.result.draft_result.ref, "OriginalCommittedDraft@1");
  assert.equal((await f.hub.outcome(f.authority, input.request_id)).state, "completed");
  assert.equal(f.saves.length, 1);
});

test("consent renewal after the Save reservation but before wait registration cannot replace the admitted generation", async () => {
  const f = await studioAgentHubFixture(), c = await readyProposal(f);
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const transaction = f.state.transaction.bind(f.state);
  f.state.transaction = async work => {
    let reserved = false;
    const result = await transaction(tx => work({ ...tx, put: async (key, value) => {
      await tx.put(key, value);
      if (key === "save-reservation/" + c.packet.task!.task_id) reserved = true;
    } }));
    if (reserved) { entered(); await gate; }
    return result;
  };
  const input = { action: "save", request_id: randomUUID(), turn_id: c.packet.task!.task_id,
    proposal_sha256: digest(c.proposal), layer_id: "RefusedRenewedConsent" };
  const rejected = assert.rejects(f.hub.action(f.authority, f.project, input), refused("AGENT_STALE"));
  await ready;
  await f.action({ action: "consent", connection_id: c.connection.id, generation: 1,
    baseline: f.context.baseline, context: "selected-intent", retention: "until-removed", limits: c.connection.limits });
  assert.equal(f.saves.length, 0);
  resume(); await rejected;
  assert.equal(f.saves.length, 0);
  assert.equal(await f.state.transaction(tx => tx.get("saved/" + input.turn_id)), undefined);
  assert.equal((await f.hub.outcome(f.authority, input.request_id)).state, "uncertain");
});

test("cloud dispatch uses the conversation's consent generation across reservation and wait registration", async () => {
  const f = await studioAgentHubFixture(), c = await f.connect();
  await f.state.transaction(tx => tx.put("connection/" + c.connection.id, { ...c.connection, provider: "cloudflare", runner_id: null }));
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const transaction = f.state.transaction.bind(f.state);
  f.state.transaction = async work => {
    let admitted = false;
    const result = await transaction(tx => work({ ...tx, put: async (key, value) => {
      await tx.put(key, value);
      if (key.startsWith("turn/")) admitted = true;
    } }));
    if (admitted) { entered(); await gate; }
    return result;
  };
  const input = { action: "turn", request_id: randomUUID(), conversation_id: c.conversation.id, kind: "chat", text: "Explain" };
  const rejected = assert.rejects(f.hub.action(f.authority, f.project, input), refused("AGENT_STALE"));
  await ready;
  await f.action({ action: "consent", connection_id: c.connection.id, generation: 1,
    baseline: f.context.baseline, context: "selected-intent", retention: "until-removed", limits: c.connection.limits });
  resume(); await rejected;
  assert.equal(f.calls.start, 0);
  assert.equal((await f.hub.outcome(f.authority, input.request_id)).state, "uncertain");
});

test("new malformed expected envelopes refuse before output retention; canonical forms remain accepted", async () => {
  const f = await studioAgentHubFixture(), c = await readyProposal(f, false);
  const invalid = [null, false, [], "Before", {}, { kind: "value" },
    { kind: "absent", value: "extra" }, { kind: "fingerprint", fingerprint: null },
    { kind: "fingerprint", fingerprint: "short" }, { kind: "value", value: "Before", extra: true }];
  const original = await f.state.transaction(tx => tx.get("turn/" + c.packet.task!.task_id));
  for (const expected of invalid) {
    const proposal = { ...c.proposal, changes: [{ ...c.proposal.changes[0], expected }] };
    assert.equal(proposalSchema.safeParse(proposal).success, false, JSON.stringify(expected));
    await assert.rejects(f.hub.output(c.runner.runner_id, c.runner.token, { ...c.output, proposal }), refused("AGENT_INVALID"));
    assert.deepEqual(await f.state.transaction(tx => tx.get("turn/" + c.packet.task!.task_id)), original);
  }
  for (const expected of [{ kind: "absent" }, { kind: "value", value: "Before" },
    { kind: "value", value: null }, { kind: "fingerprint", fingerprint: digest("Before") }]) {
    assert.equal(proposalSchema.safeParse({ ...c.proposal, changes: [{ ...c.proposal.changes[0], expected }] }).success, true);
  }
  assert.equal((await f.hub.output(c.runner.runner_id, c.runner.token, c.output)).accepted, true);
});

test("previous malformed retained output stays inspectable while Save remains refused", async () => {
  const f = await studioAgentHubFixture(), c = await readyProposal(f);
  const proposal = { ...c.proposal, changes: [{ ...c.proposal.changes[0], expected: null }] };
  await f.state.transaction(async tx => {
    const turn: any = await tx.get("turn/" + c.packet.task!.task_id);
    await tx.put("turn/" + turn.id, { ...turn, output: { ...turn.output, proposal } });
  });
  const view = await f.hub.inspect(f.authority, f.project, c.conversation.id, false);
  assert.equal(view.turns[0].output!.proposal!.changes[0].expected, null);
  await assert.rejects(f.action({ action: "save", turn_id: c.packet.task!.task_id,
    proposal_sha256: digest(proposal), layer_id: "MalformedDraft" }), refused("AGENT_INVALID"));
  assert.equal(f.saves.length, 0);
});
test("metadata does not provision agent state or dispatch", async () => {
  const f = await studioAgentHubFixture();
  const status = await f.hub.status(f.authority);
  assert.equal(status.initialized, false);
  assert.equal(f.calls.start, 0);
  assert.deepEqual(await readdir(f.directory), []);
});
test("pairing is one-use and runner secrets are absent from metadata", async () => {
  const f = await studioAgentHubFixture();
  await f.action({ action: "initialize" });
  const pair: any = (await f.action({ action: "pair", runtime: "codex" }))
    .result;
  const runner = await f.hub.pair({
    pairing_id: pair.pairing_id,
    code: pair.code,
    label: "fixture",
    runtime: "codex",
    version: "fixture",
  });
  await assert.rejects(
    f.hub.pair({
      pairing_id: pair.pairing_id,
      code: pair.code,
      label: "fixture",
      runtime: "codex",
      version: "fixture",
    }),
    refused("AGENT_PAIR_EXPIRED"),
  );
  assert.ok(
    !JSON.stringify(await f.hub.status(f.authority)).includes(runner.token),
  );
  assert.ok(
    !JSON.stringify(await f.hub.status(f.authority)).includes(pair.code),
  );
});
test("expired or wrong-runtime pairing refuses without registering", async () => {
  const f = await studioAgentHubFixture();
  await f.action({ action: "initialize" });
  const pair: any = (await f.action({ action: "pair", runtime: "codex" }))
    .result;
  await assert.rejects(
    f.hub.pair({
      pairing_id: pair.pairing_id,
      code: pair.code,
      label: "fixture",
      runtime: "claude",
      version: "fixture",
    }),
    refused("AGENT_PAIR_EXPIRED"),
  );
  f.advance(601000);
  await assert.rejects(
    f.hub.pair({
      pairing_id: pair.pairing_id,
      code: pair.code,
      label: "fixture",
      runtime: "codex",
      version: "fixture",
    }),
    refused("AGENT_PAIR_EXPIRED"),
  );
});
test("durable reservation is claimed once and exact replay never dispatches twice", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect(),
    id = randomUUID(),
    body = {
      action: "turn",
      request_id: id,
      conversation_id: c.conversation.id,
      kind: "chat",
      text: "Explain this intent.",
    };
  await f.hub.action(f.authority, f.project, body);
  const first = await f.hub.poll(c.runner.runner_id, c.runner.token, true),
    second = await f.hub.poll(c.runner.runner_id, c.runner.token, true);
  assert.equal(first.task?.task_id, id);
  assert.equal(second.task, null);
  const replay = await f.hub.action(f.authority, f.project, body);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    f.hub.action(f.authority, f.project, { ...body, text: "Different" }),
    refused("AGENT_STALE"),
  );
});
test("restart preserves reservation and requires explicit reconciliation before claiming", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  await f.action({
    action: "turn",
    conversation_id: c.conversation.id,
    kind: "chat",
    text: "Explain.",
  });
  const restarted = new StudioAgentHub(f.state, f.vault, {
    async start() {
      throw Error("no restart dispatch");
    },
    async inspect() {
      return {};
    },
    async cancel() {},
  });
  assert.equal((await restarted.status(f.authority)).initialized, true);
  assert.equal(
    (await restarted.poll(c.runner.runner_id, c.runner.token, true)).task,
    null,
  );
});
test("source selection changes reject late outputs and old conversation dispatch", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  await f.action({
    action: "turn",
    conversation_id: c.conversation.id,
    kind: "chat",
    text: "Explain.",
  });
  const task = await f.hub.poll(c.runner.runner_id, c.runner.token, true);
  f.hub.changed();
  f.context.selection_epoch++;
  f.context.binding.repository_id = "immutable-repository-2";
  await assert.rejects(
    f.hub.output(c.runner.runner_id, c.runner.token, {
      format: "strata-agent-chat-output/1",
      task_id: task.task!.task_id,
      request_sha256: task.request_sha256,
      state: "succeeded",
      text: "late",
      proposal: null,
      code: null,
    }),
    refused("AGENT_STALE"),
  );
  await assert.rejects(
    f.action({ action: "inspect", conversation_id: c.conversation.id }),
    refused("AGENT_STALE"),
  );
});
test("explicit proposal preview saves an owner draft with provenance and immutable receipt", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  await f.action({
    action: "turn",
    conversation_id: c.conversation.id,
    kind: "proposal",
    text: "Change the purpose.",
  });
  const packet = await f.hub.poll(c.runner.runner_id, c.runner.token, true),
    request = packet.task!,
    proposal = {
      format: "strata-agent-draft-proposal/1",
      baseline: f.context.baseline,
      context_sha256: request.context_sha256,
      intent: "Change purpose",
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
  await f.hub.output(c.runner.runner_id, c.runner.token, {
    format: "strata-agent-chat-output/1",
    task_id: request.task_id,
    request_sha256: packet.request_sha256,
    state: "succeeded",
    text: "Change purpose",
    proposal,
    code: null,
  });
  const saved: any = await f.action({
    action: "save",
    turn_id: request.task_id,
    proposal_sha256: digest(proposal),
    layer_id: "L-saved",
  });
  assert.equal(f.saves.length, 1);
  assert.equal((f.saves[0] as any).draft.owner, "owner");
  assert.equal(saved.result.provider, "codex");
  assert.equal(saved.result.proposal_sha256, digest(proposal));
  await assert.rejects(
    f.action({
      action: "save",
      turn_id: request.task_id,
      proposal_sha256: digest(proposal),
      layer_id: "L-other",
    }),
    refused("AGENT_STALE"),
  );
});
test("revocation rejects current dispatch and provider results without deleting history", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  const turn: any = (
    await f.action({
      action: "turn",
      conversation_id: c.conversation.id,
      kind: "chat",
      text: "Explain.",
    })
  ).result;
  const task = await f.hub.poll(c.runner.runner_id, c.runner.token, true);
  await f.action({
    action: "revoke",
    connection_id: c.connection.id,
    generation: 1,
  });
  await assert.rejects(
    f.hub.output(c.runner.runner_id, c.runner.token, {
      format: "strata-agent-chat-output/1",
      task_id: turn.id,
      request_sha256: task.request_sha256,
      state: "succeeded",
      text: "late",
      proposal: null,
      code: null,
    }),
    refused("AGENT_STALE"),
  );
  const state = await readFile(
    path.join(f.directory, "agents", "control", "execution.json"),
    "utf8",
  );
  assert.ok(state.includes(turn.id));
});
test("agent credential is encrypted and never copied into receipts", async () => {
  const f = await studioAgentHubFixture();
  await f.action({ action: "initialize" });
  const token = "public-synthetic-token-not-real";
  const saved: any = await f.action({ action: "credential", value: token });
  assert.ok(
    !(
      await readFile(
        path.join(f.directory, "agents", "control", "execution.json"),
        "utf8",
      )
    ).includes(token),
  );
  assert.ok(
    !(
      await readFile(
        path.join(
          f.directory,
          "agents",
          "vault",
          saved.result.credential_id + ".json",
        ),
        "utf8",
      )
    ).includes(token),
  );
  assert.equal(
    await f.vault.use(saved.result.credential_id, async (value) => value),
    token,
  );
});

test("metadata inspection after restart never dispatches an unclaimed local turn", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  const turn: any = (
    await f.action({
      action: "turn",
      conversation_id: c.conversation.id,
      kind: "chat",
      text: "Explain.",
    })
  ).result;
  const restarted = new StudioAgentHub(f.state, f.vault, {
    async start() {
      throw Error("unexpected dispatch");
    },
    async inspect() {
      return {};
    },
    async cancel() {},
  });
  const observed = await restarted.inspect(
    f.authority,
    f.project,
    c.conversation.id,
  );
  assert.equal(observed.turns[0].state, "failed");
  assert.equal(observed.turns[0].output?.code, "AGENT_NOT_STARTED");
  assert.equal(
    (await restarted.poll(c.runner.runner_id, c.runner.token, true)).task,
    null,
  );
  assert.equal(observed.turns[0].id, turn.id);
});

test("Stop before a local claim is confirmed without a native cancellation call", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  const turn: any = (
    await f.action({
      action: "turn",
      conversation_id: c.conversation.id,
      kind: "chat",
      text: "Explain.",
    })
  ).result;
  const result: any = await f.action({ action: "cancel", turn_id: turn.id });
  assert.equal(result.result.state, "cancelled");
  assert.equal(f.calls.cancel, 0);
  assert.equal(
    (await f.hub.poll(c.runner.runner_id, c.runner.token, true)).task,
    null,
  );
});

test("renewed consent cannot dispatch turns admitted under the previous consent", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  await f.action({
    action: "turn",
    conversation_id: c.conversation.id,
    kind: "chat",
    text: "Explain.",
  });
  await f.action({
    action: "consent",
    connection_id: c.connection.id,
    generation: 1,
    baseline: f.context.baseline,
    context: "selected-intent",
    retention: "until-removed",
    limits: c.connection.limits,
  });
  assert.equal(
    (await f.hub.poll(c.runner.runner_id, c.runner.token, true)).task,
    null,
  );
  assert.equal(
    (await f.hub.inspect(f.authority, f.project, c.conversation.id)).archived,
    true,
  );
});

test("operation receipts expose identifiers, never historical context or transcripts", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect(),
    id = randomUUID();
  await f.hub.action(f.authority, f.project, {
    action: "turn",
    request_id: id,
    conversation_id: c.conversation.id,
    kind: "chat",
    text: "private fixture transcript",
  });
  await f.action({
    action: "revoke",
    connection_id: c.connection.id,
    generation: 1,
  });
  const receipt = await f.hub.outcome(f.authority, id);
  assert.equal(receipt.state, "completed");
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /private fixture transcript|immutable-repository-1|snapshot_metadata/,
  );
});

test("disconnect aborts an in-flight service wait and retains its original uncertain admission", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const f = await studioAgentHubFixture({
      async start(_c, _r, control) {
        entered();
        await new Promise((_, reject) =>
          control.signal.addEventListener(
            "abort",
            () => reject(new AgentHubError("AGENT_STALE")),
            { once: true },
          ),
        );
      },
      async inspect() {
        return {};
      },
      async cancel() {},
    }),
    c = await f.connect();
  await f.state.transaction((tx) =>
    tx.put("connection/" + c.connection.id, {
      ...c.connection,
      provider: "cloudflare",
      runner_id: null,
    }),
  );
  const id = randomUUID(),
    pending = f.hub.action(f.authority, f.project, {
      action: "turn",
      request_id: id,
      conversation_id: c.conversation.id,
      kind: "chat",
      text: "Explain.",
    });
  const refusedTurn = assert.rejects(pending, refused("AGENT_STALE"));
  await ready;
  await f.action({
    action: "disconnect",
    connection_id: c.connection.id,
    generation: 1,
  });
  await refusedTurn;
  assert.equal((await f.hub.outcome(f.authority, id)).state, "uncertain");
});

test("a lost draft reply is recovered by inspecting its original operation, never another save", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  await f.action({
    action: "turn",
    conversation_id: c.conversation.id,
    kind: "proposal",
    text: "Clarify purpose",
  });
  const packet = await f.hub.poll(c.runner.runner_id, c.runner.token, true),
    proposal = {
      format: "strata-agent-draft-proposal/1",
      baseline: f.context.baseline,
      context_sha256: packet.task!.context_sha256,
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
  await f.hub.output(c.runner.runner_id, c.runner.token, {
    format: "strata-agent-chat-output/1",
    task_id: packet.task!.task_id,
    request_sha256: packet.request_sha256,
    state: "succeeded",
    text: "Clarify purpose",
    proposal,
    code: null,
  });
  const save = f.project.save.bind(f.project);
  f.project.save = async (...args) => {
    await save(...args);
    throw Error("synthetic lost reply");
  };
  const id = randomUUID(),
    input = {
      action: "save",
      request_id: id,
      turn_id: packet.task!.task_id,
      proposal_sha256: digest(proposal),
      layer_id: "RecoveredDraft",
    };
  await assert.rejects(
    f.hub.action(f.authority, f.project, input),
    refused("AGENT_RECOVERY_REQUIRED"),
  );
  assert.equal(f.saves.length, 1);
  const recovered: any = await f.action({
    action: "inspect-save",
    source_request_id: id,
  });
  assert.equal(recovered.result.turn_id, packet.task!.task_id);
  assert.equal((await f.hub.outcome(f.authority, id)).state, "completed");
  assert.equal(f.saves.length, 1);
  const altered = { ...input, layer_id: "AnotherDraft" };
  await assert.rejects(
    f.hub.action(f.authority, f.project, altered),
    refused("AGENT_STALE"),
  );
  assert.equal(f.saves.length, 1);
});

test("automatic metadata reads create no receipts, recovery jobs or restart dispatch", async () => {
  const f = await studioAgentHubFixture(),
    c = await f.connect();
  await f.action({
    action: "turn",
    conversation_id: c.conversation.id,
    kind: "chat",
    text: "Explain.",
  });
  const before = await f.state.transaction(
    async (tx) => (await tx.list({ prefix: "receipt/", limit: 1024 })).size,
  );
  for (let i = 0; i < 3; i++)
    await f.hub.inspect(f.authority, f.project, c.conversation.id, false);
  assert.equal(
    await f.state.transaction(
      async (tx) => (await tx.list({ prefix: "receipt/", limit: 1024 })).size,
    ),
    before,
  );
  assert.equal(
    await f.state.transaction(
      async (tx) =>
        (await tx.list({ prefix: "runner-inspect/", limit: 1024 })).size,
    ),
    0,
  );
  const restarted = new StudioAgentHub(f.state, f.vault, {
    async start() {
      throw Error("no dispatch");
    },
    async inspect() {
      return {};
    },
    async cancel() {},
  });
  const view = await restarted.inspect(
    f.authority,
    f.project,
    c.conversation.id,
    false,
  );
  assert.equal(view.turns[0].state, "queued");
  assert.equal(
    (await restarted.poll(c.runner.runner_id, c.runner.token, true)).task,
    null,
  );
});
test("questions without changes are valid proposals, while empty invented proposals refuse", async () => {
  const f = await studioAgentHubFixture(),
    base = {
      format: "strata-agent-draft-proposal/1",
      baseline: f.context.baseline,
      context_sha256: contextDigest(f.context),
      intent: "Clarification needed",
      changes: [],
      questions: ["Which outcome is intended?"],
    };
  assert.ok(proposalSchema.safeParse(base).success);
  assert.equal(
    proposalSchema.safeParse({ ...base, questions: [] }).success,
    false,
  );
});

test("a changed protected source fence refuses a runner claim before dispatch", async () => {
  let allowed = true;
  const f = await studioAgentHubFixture(undefined, async () => {
      if (!allowed) throw new AgentHubError("AGENT_SOURCE_UNAVAILABLE");
    }),
    c = await f.connect();
  const turn: any = (
    await f.action({
      action: "turn",
      conversation_id: c.conversation.id,
      kind: "chat",
      text: "Explain.",
    })
  ).result;
  allowed = false;
  await assert.rejects(
    f.hub.poll(c.runner.runner_id, c.runner.token, true),
    refused("AGENT_SOURCE_UNAVAILABLE"),
  );
  assert.equal(
    (await f.hub.inspect(f.authority, f.project, c.conversation.id, false))
      .turns[0].claimed_by,
    null,
  );
  assert.equal((await f.hub.outcome(f.authority, turn.id)).state, "completed");
});
