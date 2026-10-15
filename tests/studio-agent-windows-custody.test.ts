import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWindowsCustodyFixture } from "./fixtures/windows-execution-custody.js";
import { assertAgentWindowsCustody } from "../src/studio-agents/windows-custody.js";
import { AgentHubState } from "../src/studio-agents/state.js";
import { AgentVault } from "../src/studio-agents/vault.js";
import { randomUUID } from "node:crypto";

test(
  "native Windows: agent journal and nested vault retain owner-only custody across batches",
  { skip: process.platform !== "win32" },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "strata-agent-custody-")),
      root = path.join(temp, "private");
    createWindowsCustodyFixture(temp, root);
    const state = new AgentHubState(root, randomUUID(), randomUUID(), {
      assertWindowsCustody: assertAgentWindowsCustody,
    });
    await state.provision();
    const vault = new AgentVault(
      path.join(root, "vault"),
      path.join(root, "key.bin"),
      () => assertAgentWindowsCustody(root),
    );
    await vault.provision();
    const id = randomUUID();
    await vault.save(id, "synthetic secret");
    assert.equal(await vault.use(id, async (v) => v), "synthetic secret");
    await mkdir(path.join(root, "snapshots"));
    await writeFile(path.join(root, "snapshots", "context.json"), "{}");
    await assertAgentWindowsCustody(root);
    assert.equal(await state.initialized(), true);
    await link(
      path.join(root, "snapshots", "context.json"),
      path.join(temp, "alias"),
    );
    await assert.rejects(assertAgentWindowsCustody(root));
  },
);

test(
  "native Windows: broad inherited access refuses before agent secret use",
  { skip: process.platform !== "win32" },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "strata-agent-custody-")),
      root = path.join(temp, "unsafe");
    createWindowsCustodyFixture(temp, root, "directory", true);
    await assert.rejects(assertAgentWindowsCustody(root));
  },
);
