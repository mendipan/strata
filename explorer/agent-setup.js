import { el, pill, fields } from "./dom.js";
export const defaultAgentLimits = {
  turns_per_day: 20,
  runtime_ms: 120000,
  output_bytes: 65536,
  max_output_tokens: 2048,
};
export function agentClient(ctx, status) {
  const scope = status.reconciliation_scope,
    key = scope
      ? "strata-studio-agent-action/1:" + scope.owner + ":" + scope.state
      : null;
  let pending = null;
  try {
    const saved = key && JSON.parse(sessionStorage.getItem(key) || "null");
    if (
      saved &&
      /^[a-f0-9-]{36}$/i.test(saved.id) &&
      Number.isSafeInteger(saved.generation)
    )
      pending = saved;
  } catch {}
  return {
    get pending() {
      return pending;
    },
    keepUnresolved() {
      if (key) sessionStorage.removeItem(key);
      pending = null;
    },
    track(id, generation) {
      if (pending)
        throw new Error("Inspect the current original operation first.");
      pending = { id, generation };
      if (key) sessionStorage.setItem(key, JSON.stringify(pending));
    },
    async inspect() {
      if (!pending) return null;
      let receipt;
      try {
        receipt = await ctx.agentRequest("operations/" + pending.id);
      } catch (e) {
        if (e.code !== "AGENT_NOT_FOUND") throw e;
        if (key) sessionStorage.removeItem(key);
        pending = null;
        return { state: "failed", result: { code: "AGENT_NOT_FOUND" } };
      }
      if (["completed", "failed"].includes(receipt.state)) {
        if (key) sessionStorage.removeItem(key);
        pending = null;
      }
      return receipt;
    },
    async action(body) {
      if (pending) {
        if (
          ![
            "inspect",
            "inspect-save",
            "inspect-deployment",
            "cancel",
            "disconnect",
            "revoke",
          ].includes(body.action)
        )
          throw new Error(
            "Inspect the original agent operation before starting another.",
          );
        const response = await ctx.agentRequest("connections", {
          method: "POST",
          body: { ...body, request_id: crypto.randomUUID() },
        });
        return response.result ?? response;
      }
      const request_id = crypto.randomUUID();
      pending = {
        id: request_id,
        generation: scope?.authentication_generation,
      };
      if (!key)
        throw new Error(
          "Verified owner state is required. Refresh agent status.",
        );
      try {
        sessionStorage.setItem(key, JSON.stringify(pending));
      } catch {
        pending = null;
        throw new Error(
          "Session storage is needed to retain this action identity.",
        );
      }
      try {
        const response = await ctx.agentRequest("connections", {
          method: "POST",
          body: { ...body, request_id },
        });
        sessionStorage.removeItem(key);
        pending = null;
        return response.result ?? response;
      } catch (e) {
        if (e.before_admission === true) {
          sessionStorage.removeItem(key);
          pending = null;
        }
        throw e;
      }
    },
  };
}
function input(label, type = "text", value = "") {
  const field = el("input", { type, value, required: true });
  return { field, node: el("label", {}, label, field) };
}
export async function agentSetup(ctx) {
  const root = el("section", { class: "section agent-setup" }),
    pane = el("div"),
    notice = el("p", {
      class: "notice",
      role: "status",
      "aria-live": "polite",
    });
  let status = await ctx.agentRequest("connections"),
    client = agentClient(ctx, status),
    busy = false,
    pair = null,
    preview = null,
    localRuntime = "codex";
  async function reload() {
    status = await ctx.agentRequest("connections");
    ctx.check();
    client = agentClient(ctx, status);
    paint();
  }
  async function run(body) {
    if (busy) return;
    busy = true;
    paint();
    try {
      const result = await client.action(body);
      ctx.check();
      notice.textContent = "Agent action saved.";
      if (body.action === "pair") pair = result;
      if (body.action === "deployment-preview") preview = result;
      await reload();
    } catch (e) {
      notice.textContent = e.message;
      if (e.code === "OWNER_REAUTH_REQUIRED" && ctx.reauth)
        notice.append(
          el(
            "button",
            {
              onclick: async () => {
                await ctx.reauth();
                await reload();
              },
            },
            "Confirm password",
          ),
        );
    } finally {
      busy = false;
      paint();
    }
  }
  function paint() {
    const disabled = busy || !!client.pending;
    pane.replaceChildren(
      el(
        "article",
        { class: "card" },
        el("h2", {}, "Agents"),
        el(
          "p",
          {},
          "Connect an agent, approve the selected project context, then open Agent to chat and prepare drafts.",
        ),
        el(
          "button",
          {
            disabled: busy,
            onclick: () =>
              reload().catch((e) => (notice.textContent = e.message)),
          },
          "Refresh agent status",
        ),
      ),
    );
    if (client.pending)
      pane.append(
        el(
          "article",
          { class: "card" },
          el(
            "p",
            {},
            "The previous action needs inspection: " + client.pending.id,
          ),
          el(
            "button",
            {
              disabled: busy,
              onclick: async () => {
                try {
                  const r = await client.inspect();
                  notice.textContent =
                    r?.state === "completed"
                      ? "Original operation confirmed."
                      : "The original operation remains " +
                        r?.state +
                        ". It was not replayed.";
                  if (
                    r?.state !== "completed" &&
                    r?.request_metadata?.action === "deploy"
                  ) {
                    const meta = r.request_metadata;
                    notice.append(
                      el(
                        "button",
                        {
                          onclick: () =>
                            run({
                              action: "inspect-deployment",
                              source_request_id: r.id,
                              preview_id: meta.preview_id,
                              expected_sha256: meta.expected_sha256,
                            }),
                        },
                        "Inspect deployed service identity",
                      ),
                    );
                  }
                  await reload();
                } catch (e) {
                  notice.textContent = e.message;
                }
              },
            },
            "Inspect original agent operation",
          ),
          el(
            "button",
            {
              disabled: busy,
              onclick: () => {
                if (
                  confirm(
                    "Keep this original action unresolved and allow independent new work? It remains recorded on the server and will not be replayed.",
                  )
                ) {
                  client.keepUnresolved();
                  paint();
                }
              },
            },
            "Keep unresolved and continue",
          ),
        ),
      );
    if (status.unresolved_operations?.length && !client.pending)
      pane.append(
        el(
          "article",
          { class: "card" },
          el("h3", {}, "Unresolved original operations"),
          ...status.unresolved_operations.map((r) =>
            el(
              "button",
              {
                disabled: busy,
                onclick: () => {
                  client.track(r.id, r.authentication_generation);
                  paint();
                },
              },
              r.request_metadata?.action + " · " + r.id + " · " + r.state,
            ),
          ),
        ),
      );
    if (!status.initialized) {
      pane.append(
        el(
          "article",
          { class: "card" },
          el("h3", {}, "Set up agent storage"),
          el(
            "p",
            {},
            "Initialize private agent configuration and conversation storage for this installation.",
          ),
          el(
            "button",
            { disabled: busy, onclick: () => run({ action: "initialize" }) },
            "Initialize agent storage",
          ),
        ),
      );
      return;
    }
    for (const c of status.connections)
      pane.append(
        el(
          "article",
          { class: "card" },
          el(
            "div",
            { class: "card-head" },
            el("h3", {}, c.label),
            pill(c.revoked ? "Revoked" : c.enabled ? "Enabled" : "Paused"),
          ),
          fields([
            ["Provider", c.provider],
            ["Model", c.model],
            ["Daily turn limit", String(c.limits.turns_per_day)],
          ]),
          el(
            "button",
            {
              disabled: disabled || c.revoked,
              onclick: () =>
                run({
                  action: c.enabled ? "disconnect" : "reconnect",
                  connection_id: c.id,
                  generation: c.generation,
                }),
            },
            c.enabled ? "Disconnect" : "Reconnect",
          ),
          el(
            "button",
            {
              disabled: busy || c.revoked,
              onclick: () => {
                if (
                  confirm(
                    "Revoke this agent integration? Saved conversations and drafts remain.",
                  )
                )
                  void run({
                    action: "revoke",
                    connection_id: c.id,
                    generation: c.generation,
                  });
              },
            },
            "Revoke",
          ),
        ),
      );
    const local = el(
      "article",
      { class: "card" },
      el(
        "h3",
        {},
        localRuntime === "codex" ? "Add local Codex" : "Add local Claude",
      ),
      el(
        "label",
        {},
        "Local runtime",
        el(
          "select",
          {
            "aria-label": "Local runtime",
            onchange: (e) => {
              localRuntime = e.target.value;
              pair = null;
              paint();
            },
          },
          ...[
            ["codex", "Codex"],
            ["claude", "Claude"],
          ].map(([value, label]) =>
            el("option", { value, selected: value === localRuntime }, label),
          ),
        ),
      ),
      el(
        "p",
        {},
        "Install the runner on your chosen machine. It connects outward to this Studio installation; no inbound port is required.",
      ),
      localRuntime === "codex" ? el("p", {}, "Run the package's offline Codex preflight and complete its Windows host checks before creating a pairing code. See the package README for the exact supported runtime.") : null,
      el(
        "a",
        { href: "/studio/v1/owner/agent-runner-download" },
        "Download runner package",
      ),
      el(
        "button",
        {
          disabled,
          onclick: () => run({ action: "pair", runtime: localRuntime }),
        },
        "Create pairing code",
      ),
    );
    if (pair)
      local.append(
        fields([
          ["Pairing ID", pair.pairing_id],
          [
            "Code",
            pair.code ?? "Create a new code if the original response was lost.",
          ],
          ["Expires", pair.expires_at],
        ]),
        el(
          "p",
          {},
          "Use the package’s attended pairing installer on the agent machine. Enter this Studio URL and code there. The code is valid once.",
        ),
      );
    for (const r of status.runners) {
      const model = input(
        r.runtime === "claude" ? "Exact Claude model" : "Exact Codex model",
      );
      if (r.runtime === "codex") {
        const select = el("select", { required: true, "aria-label": "Exact Codex model" },
          el("option", { value: "" }, "Choose an available model"),
          ...(r.models ?? []).map(value => el("option", { value }, value)));
        model.field.replaceWith(select);
        model.field = select;
      }
      model.field.placeholder =
        "Choose the model available to your local account";
      const label = input("Agent name", "text", r.label);
      const daily = input("Maximum turns per day", "number", "20");
      local.append(
        el(
          "form",
          {
            onsubmit: (e) => {
              e.preventDefault();
              void run({
                action: "add-runner",
                runner_id: r.id,
                label: label.field.value,
                model: model.field.value,
                limits: {
                  ...defaultAgentLimits,
                  turns_per_day: Number(daily.field.value),
                },
              });
            },
          },
          el("h4", {}, r.label),
          pill(
            r.online
              ? r.ready
                ? "Ready"
                : r.runtime === "claude"
                  ? "API key required"
                  : "Sign-in required"
              : "Offline",
          ),
          fields([["Runtime version", r.version]]),
          el("p", {}, "Once connected, this paired agent can use the project you select until disconnected or revoked. Routine use does not require another project permission or password confirmation."),
          r.runtime === "codex" && !r.models?.length
            ? el("p", {}, "Sign in on the private runner, then refresh status to load available models.") : null,
          r.runtime === "codex"
            ? el(
                "button",
                {
                  type: "button",
                  disabled: disabled || !r.online,
                  onclick: () =>
                    run({ action: "runner-login", runner_id: r.id }),
                },
                "Sign in to Codex",
              )
            : el(
                "p",
                {},
                "Save the Claude API key through the attended installer on the agent machine. It stays there.",
              ),
          r.login
            ? el(
                "p",
                {},
                el(
                  "a",
                  {
                    href: r.login.verification_url,
                    target: "_blank",
                    rel: "noopener",
                  },
                  "Open Codex sign-in",
                ),
                ": " + r.login.user_code,
              )
            : null,
          label.node,
          model.node,
          daily.node,
          el("button", { type: "submit", disabled: disabled || !r.online || !r.ready ||
            (r.runtime === "codex" && !r.models?.length) }, "Add paired agent"),
        ),
      );
    }
    pane.append(local);
    const account = input("Cloudflare account ID"),
      name = input("Agent name", "text", "Cloudflare agent"),
      daily = input("Maximum turns per day", "number", "20"),
      token = input("Cloudflare deployment API token", "password");
    token.field.autocomplete = "off";
    const model = el(
      "select",
      { "aria-label": "Workers AI model" },
      el(
        "option",
        { value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
        "Llama 3.3 70B",
      ),
      el("option", { value: "@cf/meta/llama-3.1-8b-instruct" }, "Llama 3.1 8B"),
    );
    const credential = el(
      "select",
      { "aria-label": "Saved agent deployment credential" },
      el("option", { value: "" }, "Select saved deployment token"),
      ...status.credentials.map((c) => el("option", { value: c.id }, c.id)),
    );
    pane.append(
      el(
        "article",
        { class: "card" },
        el("h3", {}, "Create a Cloudflare agent"),
        el(
          "p",
          {},
          "Use a separate account-scoped token with Workers Scripts Write and Account Settings Read. This does not use your Artifacts token.",
        ),
        el(
          "form",
          {
            onsubmit: (e) => {
              e.preventDefault();
              const value = token.field.value;
              token.field.value = "";
              void run({ action: "credential", value });
            },
          },
          token.node,
          el("button", { type: "submit", disabled }, "Save deployment token"),
        ),
        el(
          "form",
          {
            onsubmit: (e) => {
              e.preventDefault();
              void run({
                action: "deployment-preview",
                account_id: account.field.value,
                credential_id: credential.value,
                label: name.field.value,
                model: model.value,
                limits: {
                  ...defaultAgentLimits,
                  turns_per_day: Number(daily.field.value),
                },
              });
            },
          },
          account.node,
          name.node,
          el("label", {}, "Workers AI model", model),
          el("label", {}, "Saved deployment token", credential),
          daily.node,
          el("button", { type: "submit", disabled }, "Review deployment"),
        ),
      ),
    );
    if (preview)
      pane.append(
        el(
          "article",
          { class: "card" },
          el("h3", {}, "Review exact Cloudflare deployment"),
          fields([
            ["Account", preview.account_id],
            ["Agent", preview.label],
            ["Model", preview.model],
            ["Turn limit", String(preview.limits.turns_per_day)],
            ["Resources", preview.resources.join("; ")],
            ["Permissions", preview.permissions.join("; ")],
          ]),
          el(
            "p",
            {},
            "Deploying creates the listed resources. Inference runs only when you explicitly send a message after approving project context. Cloudflare usage may incur charges.",
          ),
          el(
            "button",
            {
              disabled,
              onclick: () =>
                run({
                  action: "deploy",
                  preview_id: preview.id,
                  expected_sha256: preview.sha256,
                }),
            },
            "Deploy this agent service",
          ),
        ),
      );
  }
  root.append(pane, notice);
  paint();
  return root;
}
