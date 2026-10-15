// Headless Edge, real owner sessions/private files, synthetic runner/model output.
// Intercepted HTTPS only; no provider, native agent, real credential or deployment.
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { studioAgentHttpFixture } from "../dist/tests/studio-agent-http-fixture.js";
import { digest } from "../dist/src/model.js";
const { chromium } = await import(
  pathToFileURL(process.env.STRATA_EXPLORER_PLAYWRIGHT_MODULE).href
);
let ownerNow = Date.now();
const f = await studioAgentHttpFixture(() => ownerNow),
  browser = await chromium.launch({ channel: "msedge", headless: true }),
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  }),
  errors = [],
  checks = [],
  blocked = [],
  refusals = [];
const output = await mkdtemp(
  path.join(tmpdir(), "strata-agent-workflow-browser-"),
);
context.setDefaultTimeout(8000);
await context.route("**/*", async (route) => {
  const original = route.request(),
    url = new URL(original.url());
  if (url.origin !== f.origin) {
    blocked.push(url.origin);
    return route.abort();
  }
  const headers = await original.allHeaders();
  headers.host = "studio.example.test";
  headers["x-forwarded-proto"] = "https";
  const response = await new Promise((resolve, reject) => {
    const req = request(
      f.server.origin + url.pathname + url.search,
      { method: original.method(), headers },
      (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join("\n") : String(v),
              ]),
            ),
            body: Buffer.concat(parts),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(original.postData() ?? undefined);
  });
  if (response.status >= 400)
    refusals.push({ path: url.pathname, status: response.status });
  await route.fulfill(response);
});
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().startsWith("Failed to load resource:"))
    errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(f.origin + "/#/settings");
  await page.getByLabel("Sign-in name", { exact: true }).fill("manager.owner");
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await page.getByText("Agent service (optional)", { exact: true }).click();
  await page
    .getByRole("button", { name: "Initialize agent storage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create pairing code", exact: true })
    .waitFor();
  checks.push("explicit storage setup");
  await page
    .getByRole("button", { name: "Create pairing code", exact: true })
    .click();
  await page.getByText("Pairing ID", { exact: true }).waitFor();
  const fields = await page
    .locator(".agent-setup .field")
    .evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((n) => [
          n.querySelector("dt")?.textContent,
          n.querySelector("dd")?.textContent,
        ]),
      ),
    );
  const paired = await f.hub.pair({
    pairing_id: fields["Pairing ID"],
    code: fields.Code,
    label: "Synthetic Codex",
    runtime: "codex",
    version: "synthetic",
  });
  await f.hub.poll(paired.runner_id, paired.token, true, false, ["fixture-model"]);
  await page
    .getByRole("button", { name: "Refresh agent status", exact: true })
    .click();
  await page.getByLabel("Exact Codex model").selectOption("fixture-model");
  ownerNow += 6 * 60_000;
  await page
    .getByRole("button", { name: "Add paired agent", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Synthetic Codex", exact: true })
    .waitFor();
  checks.push("configure existing pairing after password freshness expires");
  await page.getByRole("link", { name: "Agent", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Start conversation",
      exact: true,
    })
    .waitFor();
  if (
    await page
      .getByRole("button", {
        name: "Inspect original agent operation",
        exact: true,
      })
      .count()
  ) {
    await page
      .getByRole("button", {
        name: "Inspect original agent operation",
        exact: true,
      })
      .click();
    await page
      .getByText("Original outcome: completed", { exact: true })
      .waitFor();
    checks.push("navigation reconciles original setup receipt");
  }
  assert.equal(await page.getByRole("button", {
    name: "Allow this agent to read project context", exact: true,
  }).count(), 0);
  checks.push("paired local agent needs no separate project Allow");
  await page
    .getByRole("button", { name: "Start conversation", exact: true })
    .click();
  await page.getByLabel("Message to agent").fill("Propose a purpose update.");
  await page
    .getByRole("button", { name: "Prepare draft", exact: true })
    .click();
  await page
    .getByText(
      "Message submitted once. Refresh this conversation to inspect its progress.",
      { exact: true },
    )
    .waitFor();
  const packet = await f.hub.poll(paired.runner_id, paired.token, true);
  assert.ok(packet.task);
  const receiptsBefore = await f.hub.state.transaction(
    async (tx) => (await tx.list({ prefix: "receipt/", limit: 1024 })).size,
  );
  await f.hub.progress(paired.runner_id, paired.token, {
    task_id: packet.task.task_id,
    request_sha256: packet.request_sha256,
    text: "Preparing a purpose update.",
  });
  await page
    .getByText("Preparing a purpose update.", { exact: true })
    .waitFor();
  assert.equal(
    await f.hub.state.transaction(
      async (tx) => (await tx.list({ prefix: "receipt/", limit: 1024 })).size,
    ),
    receiptsBefore,
  );
  assert.equal(
    await f.hub.state.transaction((tx) =>
      tx.get("runner-inspect/" + packet.task.task_id),
    ),
    undefined,
  );
  checks.push(
    "automatic scoped progress without dispatch or recovery receipts",
  );
  const p = {
    format: "strata-agent-draft-proposal/1",
    baseline: packet.task.context.baseline,
    context_sha256: packet.task.context_sha256,
    intent: "Purpose update",
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
  await f.hub.output(paired.runner_id, paired.token, {
    format: "strata-agent-chat-output/1",
    task_id: packet.task.task_id,
    request_sha256: packet.request_sha256,
    state: "succeeded",
    text: "Purpose update",
    proposal: p,
    code: null,
  });
  await page
    .getByRole("button", { name: "Refresh conversation", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Proposed draft", exact: true })
    .waitFor();
  checks.push("verified proposal preview");
  await page
    .getByRole("button", { name: "Save as draft", exact: true })
    .click();
  await page
    .getByText(
      "Draft saved. Open Changes or Review to inspect its immutable revision.",
    )
    .waitFor();
  assert.equal(f.saves.length, 1);
  checks.push("explicit owner draft save");
  assert.ok(
    (
      await page
        .getByRole("link", { name: "Open saved draft", exact: true })
        .first()
        .getAttribute("href")
    ).includes(encodeURIComponent(f.saves[0].draft.id + "@1")),
  );
  checks.push("exact saved draft review link");
  await page.reload();
  await page
    .getByRole("button", { name: "Open saved conversations", exact: true })
    .click();
  await page.getByRole("button", { name: /Project conversation ·/ }).click();
  await page
    .getByRole("heading", { name: "Proposed draft", exact: true })
    .waitFor();
  checks.push("conversation readback after reload");
  await page.getByLabel("Message to agent").fill("Inspect a retained legacy proposal.");
  await page.getByRole("button", { name: "Prepare draft", exact: true }).click();
  await page.getByText("Message submitted once. Refresh this conversation to inspect its progress.", { exact: true }).waitFor();
  const legacy = await f.hub.poll(paired.runner_id, paired.token, true);
  assert.ok(legacy.task);
  // Simulate old stored envelopes; current admission must reject these values.
  for (const expected of [null, [], { kind: "unsupported" }]) {
    await f.hub.state.transaction(async tx => {
      const turn = await tx.get("turn/" + legacy.task.task_id);
      await tx.put("turn/" + turn.id, { ...turn, state: "succeeded", output: {
        format: "strata-agent-chat-output/1", trust: "agent-output", task_id: turn.id,
        request_sha256: turn.request_sha256, state: "succeeded", text: "Legacy proposal",
        proposal: { ...p, changes: [{ ...p.changes[0], expected }] }, code: null,
      } });
    });
    await page.getByRole("button", { name: "Refresh conversation", exact: true }).click();
    await page.getByText("This retained proposal has an unsupported expected value and cannot be saved. You can continue the conversation.", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Send message" && !button.disabled));
    assert.ok(await page.getByRole("button", { name: "Save as draft", exact: true }).last().isDisabled());
    assert.ok(await page.getByRole("button", { name: "Send message", exact: true }).isEnabled());
    assert.equal(f.saves.length, 1);
  }
  checks.push("legacy null, array and unsupported expected previews remain readable with Save disabled");
  await page.reload();
  await page.getByRole("button", { name: "Open saved conversations", exact: true }).click();
  await page.getByRole("button", { name: /Project conversation/ }).click();
  await page.getByText("This retained proposal has an unsupported expected value and cannot be saved. You can continue the conversation.", { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Send message" && !button.disabled));
  assert.ok(await page.getByRole("button", { name: "Send message", exact: true }).isEnabled());
  checks.push("reopening a retained malformed proposal preserves message controls");
  for (const expected of [{ kind: "absent" }, { kind: "fingerprint", fingerprint: digest("Before") }, { kind: "value", value: null }]) {
    await f.hub.state.transaction(async tx => {
      const turn = await tx.get("turn/" + legacy.task.task_id);
      await tx.put("turn/" + turn.id, { ...turn, output: { ...turn.output,
        proposal: { ...turn.output.proposal, changes: [{ ...p.changes[0], expected }] },
      } });
    });
    await page.getByRole("button", { name: "Refresh conversation", exact: true }).click();
    const preview = expected.kind === "absent" ? "Before: Item absent"
      : expected.kind === "fingerprint" ? "Before: Fingerprint: " + expected.fingerprint : "Before: null";
    await page.getByText(preview, { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Save as draft", exact: true }).last().isEnabled());
  }
  checks.push("canonical absent, fingerprint and structured null previews remain supported");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({
    path: path.join(output, "agent-mobile.png"),
    fullPage: true,
  });
  const width = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.ok(width.body <= width.viewport + 2, JSON.stringify(width));
  checks.push("320px layout");
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: localStorage, session: sessionStorage }),
  );
  assert.ok(!storage.includes(paired.token));
  assert.ok(!storage.includes(fields.Code));
  assert.ok(!storage.includes(f.password));
  checks.push("no credential/pairing secret persistence");
  f.owner.clear();
  await page.getByLabel("Message to agent").fill("After session expiry");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh sign-in", exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .isDisabled(),
  );
  assert.equal(f.saves.length, 1);
  checks.push(
    "session expiry disables agent actions and exposes sign-in recovery",
  );
  const header = await page.locator("#header").innerText();
  assert.ok(header.includes("Sign-in required"), header);
  assert.ok(!header.includes("Connected project"), header);
  assert.ok(!header.includes("Draft editing enabled"), header);
  assert.equal(await page.getByLabel("Message to agent").inputValue(), "After session expiry");
  checks.push("agent session refusal updates shared header and preserves unsent text");
  assert.deepEqual(errors, []);
  assert.ok(
    refusals.every(
      (r) =>
        (r.path === "/studio/v1/capabilities" && r.status === 403) ||
        (r.path === "/studio/v1/owner/agent-connections" && r.status === 401),
    ),
    JSON.stringify(refusals),
  );
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "checks.json"),
    JSON.stringify(
      {
        checks,
        errors,
        blocked,
        output_trust: "synthetic-agent-output",
        proposals: f.saves.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, output }));
} catch (e) {
  console.log(
    JSON.stringify({ errors, text: await page.locator("main").innerText() }),
  );
  throw e;
} finally {
  await browser.close();
  await f.server.close();
}
